//go:build integration

package b2

// Runs the Go client against the built worker daemon (packages/worker/dist). Build it first:
//   npm ci --ignore-scripts && npm run build
// The node binary is PIW_NODE or `node` on PATH.

import (
	"bufio"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestIntegrationHelloAndRefusals(t *testing.T) {
	dist, err := filepath.Abs(filepath.Join("..", "..", "..", "packages", "worker", "dist"))
	if err != nil {
		t.Fatal(err)
	}
	// The production entry point (src/main.js) refuses to start without a cgroup v2 delegation (P2-1), which plain CI
	// runners and developer machines lack, and on a delegated host it would create a real domain unit. This test needs
	// only a running daemon, so it starts the same daemon on test domains; the refusal itself is tested in
	// packages/worker/test/security/containment.test.ts.
	main := filepath.Join(dist, "test", "fixtures", "daemon.js")
	if _, err := os.Stat(main); err != nil {
		t.Fatalf("worker not built (%v); run `npm run build` at the repository root", err)
	}
	node := os.Getenv("PIW_NODE")
	if node == "" {
		node = "node"
	}
	dir, err := os.MkdirTemp("", "piw-go-int-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "run", "pi-worker", "b2.sock")
	env := []string{"PATH=" + os.Getenv("PATH"), "PIW_SOCKET=" + socket, "PIW_STATE_DIR=" + filepath.Join(dir, "state")}
	// Every B2 request needs a bearer (P1-9): the owner registers one by local file access with the grant command.
	grantFile := filepath.Join(dir, "grant.json")
	register := exec.Command(node, filepath.Join(dist, "src", "grant.js"), "register", "--caller", "go-integration", "--out", grantFile)
	register.Env = env
	if out, err := register.CombinedOutput(); err != nil {
		t.Fatalf("grant register: %v %s", err, out)
	}
	cmd := exec.Command(node, main)
	cmd.Env = env
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cmd.Process.Signal(syscall.SIGTERM)
		cmd.Wait()
	}()
	ready := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), `"listening"`) {
				ready <- nil
				return
			}
		}
		ready <- errors.New("worker exited before listening")
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("worker did not start")
	}

	ctx := context.Background()
	if _, err := New(socket).Hello(ctx); err == nil {
		t.Fatal("hello without a bearer was answered")
	}
	c := New(socket, WithGrantFile(grantFile))
	hello, err := c.Hello(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if hello.Protocol.Major != 0 || hello.SupervisorEpoch == "" || len(hello.NamedLimits) == 0 || hello.Limits.RequestBodyBytes != int(OpSessionsPrompt.MaxBodyBytes) ||
		hello.Limits.AttachmentMaxBytes != int(OpAttachmentsStage.MaxBodyBytes) || hello.Limits.EventFrameBytes != frameLimit {
		t.Fatalf("hello = %+v", hello)
	}
	// files.read is served from P2-4: a worker that does not exist is a typed 409 no_effect refusal.
	_, err = c.FilesRead(ctx, "w1", FileRead{Path: "/r/file", Roots: []string{"/r"}})
	var f *ClientFailure
	if !errors.As(err, &f) || f.Phase != PhaseHTTP || f.Status != 409 || f.Effect != NoEffect || f.Body == nil || f.Body.Error != "unknown_worker" {
		t.Fatalf("files.read: %v", err)
	}
	_, err = c.SessionsPrompt(ctx, "w1", Prompt{CommandId: "c1", WorkerEpoch: "e1", SessionId: "s1", BindingRevision: 0, Message: "m"})
	if !errors.As(err, &f) || f.Status != 400 || f.Effect != NoEffect || f.Body.Error != "request_schema_mismatch" {
		t.Fatalf("invalid prompt: %v", err)
	}
	// events.subscribe is served from P1-8: the first frame is a fresh snapshot.
	var first Frame
	if err := c.Watch(ctx, WatchOptions{}, func(frame Frame) bool { first = frame; return false }); err != nil || first.Type != "snapshot" {
		t.Fatalf("watch: %v %+v", err, first)
	}
}
