//go:build linux || darwin

package b2

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestGrantFileRefusals(t *testing.T) {
	for _, kind := range []string{"fifo", "symlink", "setuid", "setgid", "sticky", "oversize"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "grant.json")
			body := []byte(`{"token":"synthetic"}`)
			if kind == "oversize" {
				// Valid JSON even at this size: refusal must be the size bound, not decoding.
				body = []byte(`{"token":"` + strings.Repeat("x", 64<<10) + `"}`)
			}
			switch kind {
			case "fifo":
				if err := syscall.Mkfifo(path, 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				target := path + ".target"
				if err := os.WriteFile(target, body, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.WriteFile(path, body, 0o600); err != nil {
					t.Fatal(err)
				}
				bits := map[string]os.FileMode{"setuid": os.ModeSetuid, "setgid": os.ModeSetgid, "sticky": os.ModeSticky}
				if bit := bits[kind]; bit != 0 {
					if err := os.Chmod(path, 0o600|bit); err != nil {
						t.Fatal(err)
					}
					info, err := os.Stat(path)
					if err != nil || info.Mode() != 0o600|bit {
						t.Fatalf("special mode was not set: %v, %v", info, err)
					}
				}
			}
			done := make(chan error, 1)
			go func() { _, err := readGrantFile(path); done <- err }()
			deadline := time.NewTimer(time.Second)
			defer deadline.Stop()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("unsafe grant accepted")
				}
				if kind == "oversize" && !strings.Contains(err.Error(), "too large") {
					t.Fatalf("not a size refusal: %v", err)
				}
			case <-deadline.C:
				t.Fatal("grant read did not return before deadline")
			}
		})
	}
}

func TestGrantFileLimitAndHardLinks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "grant.json")
	body := []byte(strings.Repeat("x", 64<<10))
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	link := path + ".link"
	if err := os.Link(path, link); err != nil {
		t.Fatal(err)
	}
	got, err := readGrantFile(link)
	if err != nil || string(got) != string(body) {
		t.Fatalf("regular 0600 hard link at limit: bytes=%d err=%v", len(got), err)
	}
	if err := os.WriteFile(path, append(body, 'x'), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readGrantFile(link); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("limit plus one byte not refused: %v", err)
	}
}

// Deterministic ownership refusal without root, chown, or access to another user's actual grant.
// readGrantFile passes this process's effective UID to the same predicate after fstat of the opened file.
func TestGrantOwnerPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "grant.json")
	if err := os.WriteFile(path, []byte(`{"token":"synthetic"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateGrantFile(info, os.Geteuid()); err != nil {
		t.Fatalf("own grant: %v", err)
	}
	if err := validateGrantFile(info, os.Geteuid()+1); err == nil || !strings.Contains(err.Error(), "owned by the bridge user") {
		t.Fatalf("foreign grant was not refused by owner policy: %v", err)
	}
}
