package b2

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "piw-go-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "b2.sock")
}

func serveHTTP(t *testing.T, path string, handler http.HandlerFunc) {
	t.Helper()
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
}

func prompt(id string) Prompt {
	return Prompt{CommandId: id, WorkerEpoch: "epoch-0", SessionId: "session-0", BindingRevision: 1, Message: "do not replay"}
}

func asFailure(t *testing.T, err error) *ClientFailure {
	t.Helper()
	var f *ClientFailure
	if !errors.As(err, &f) {
		t.Fatalf("want *ClientFailure, got %T %v", err, err)
	}
	return f
}

func TestNoListenerIsBeforeWriteNoEffect(t *testing.T) {
	_, err := New(socketPath(t)).SessionsPrompt(context.Background(), "w1", prompt("c1"))
	f := asFailure(t, err)
	if f.Phase != PhaseBeforeWrite || f.Effect != NoEffect {
		t.Fatalf("got %s %s", f.Phase, f.Effect)
	}
}

// After the connection reaches the writer, a dropped connection is unknown; exactly one attempt, keep-alive off.
func TestDropAfterWriteIsUnknownOneAttempt(t *testing.T) {
	path := socketPath(t)
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	var attempts atomic.Int32
	var mu sync.Mutex
	var request string
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			attempts.Add(1)
			r := bufio.NewReader(conn)
			req, err := http.ReadRequest(r)
			if err == nil {
				body := make([]byte, req.ContentLength)
				_, _ = r.Read(body)
				mu.Lock()
				request = req.Header.Get("Connection") + "|" + string(body)
				mu.Unlock()
			}
			conn.Close()
		}
	}()
	_, err = New(path).SessionsPrompt(context.Background(), "w1", prompt("c1"))
	f := asFailure(t, err)
	if f.Phase != PhaseAfterWrite || f.Effect != UnknownEffect {
		t.Fatalf("got %s %s: %v", f.Phase, f.Effect, f.Err)
	}
	time.Sleep(50 * time.Millisecond)
	if n := attempts.Load(); n != 1 {
		t.Fatalf("attempts = %d, want 1", n)
	}
	mu.Lock()
	defer mu.Unlock()
	if !strings.HasPrefix(strings.ToLower(request), "close|") || !strings.Contains(request, "do not replay") {
		t.Fatalf("request = %q", request)
	}
}

func TestHTTPRefusalKeepsWorkerEffect(t *testing.T) {
	path := socketPath(t)
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/b2/workers/w1/prompt":
			w.WriteHeader(409)
			w.Write([]byte(`{"error":"stale_binding","effect":"no_effect","received_binding_revision":50}`))
		case "/b2/workers/w1/stop":
			w.WriteHeader(500)
			w.Write([]byte(`{"error":"internal_error_reconcile_before_retry","effect":"unknown","uncertain_command_id":"s1"}`))
		case "/b2/workers/w1/cancel":
			w.WriteHeader(502)
			w.Write([]byte(`<html>bad gateway</html>`))
		default:
			w.WriteHeader(501)
			w.Write([]byte(`{"error":"operation_not_implemented","effect":"no_effect"}`))
		}
	})
	c := New(path)
	ctx := context.Background()
	_, err := c.SessionsPrompt(ctx, "w1", prompt("c1"))
	f := asFailure(t, err)
	if f.Phase != PhaseHTTP || f.Effect != NoEffect || f.Status != 409 || f.Body == nil || *f.Body.ReceivedBindingRevision != 50 {
		t.Fatalf("prompt: %+v", f)
	}
	_, err = c.WorkersStop(ctx, "w1", Binding{CommandId: "s1", WorkerEpoch: "e", SessionId: "s", BindingRevision: 1})
	f = asFailure(t, err)
	if f.Effect != UnknownEffect || f.Body == nil || *f.Body.UncertainCommandId != "s1" {
		t.Fatalf("stop: %+v", f)
	}
	_, err = c.ExecutionsCancel(ctx, "w1", Control{CommandId: "x1", WorkerEpoch: "e", SessionId: "s", BindingRevision: 1})
	if f = asFailure(t, err); f.Effect != UnknownEffect || f.Status != 502 {
		t.Fatalf("cancel: %+v", f)
	}
	_, err = c.WorkersList(ctx)
	if f = asFailure(t, err); f.Effect != NoEffect || f.Status != 501 {
		t.Fatalf("list: %+v", f)
	}
}

func TestTimeoutAfterWriteIsUnknownNotRetried(t *testing.T) {
	path := socketPath(t)
	var requests atomic.Int32
	release := make(chan struct{})
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		<-release
	})
	defer close(release)
	_, err := New(path, WithTimeout(100*time.Millisecond)).SessionsPrompt(context.Background(), "w1", prompt("slow"))
	f := asFailure(t, err)
	if f.Phase != PhaseAfterWrite || f.Effect != UnknownEffect {
		t.Fatalf("got %s %s", f.Phase, f.Effect)
	}
	time.Sleep(50 * time.Millisecond)
	if n := requests.Load(); n != 1 {
		t.Fatalf("requests = %d", n)
	}
}

// The peer UID check runs before any byte is written, so the bearer never reaches a foreign listener.
func TestPeerNotOwnerRefusedBeforeWrite(t *testing.T) {
	path := socketPath(t)
	var requests atomic.Int32
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) { requests.Add(1) })
	grant := filepath.Join(filepath.Dir(path), "grant.json")
	os.WriteFile(grant, []byte(`{"token":"secret-for-test"}`), 0o600)
	_, err := New(path, WithExpectedUID(os.Getuid()+1), WithGrantFile(grant)).Hello(context.Background())
	f := asFailure(t, err)
	if f.Phase != PhaseBeforeWrite || f.Effect != NoEffect || !errors.Is(err, ErrPeerNotOwner) {
		t.Fatalf("got %+v", f)
	}
	if requests.Load() != 0 {
		t.Fatal("request reached a foreign peer")
	}
}

func TestGrantFileAndProtocolMajor(t *testing.T) {
	path := socketPath(t)
	var auth atomic.Value
	major := 0
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
		json.NewEncoder(w).Encode(map[string]any{"protocol": map[string]int{"major": major, "minor": 1}})
	})
	dir := filepath.Dir(path)
	_, err := New(path, WithGrantFile(filepath.Join(dir, "missing.json"))).Hello(context.Background())
	if f := asFailure(t, err); f.Phase != PhaseBeforeWrite || f.Effect != NoEffect {
		t.Fatalf("missing grant: %+v", f)
	}
	grant := filepath.Join(dir, "grant.json")
	os.WriteFile(grant, []byte(`{"token":"t0"}`), 0o600)
	if _, err := New(path, WithGrantFile(grant)).Hello(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := auth.Load(); got != "Bearer t0" {
		t.Fatalf("auth = %v", got)
	}
	major = 1
	var mismatch *ProtocolMismatch
	if _, err := New(path).Hello(context.Background()); !errors.As(err, &mismatch) || mismatch.Major != 1 {
		t.Fatalf("want ProtocolMismatch, got %v", err)
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	path := socketPath(t)
	var requests atomic.Int32
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Redirect(w, r, "/b2/workers/w2/prompt", http.StatusTemporaryRedirect)
	})
	_, err := New(path).SessionsPrompt(context.Background(), "w1", prompt("c1"))
	if f := asFailure(t, err); f.Status != 307 || f.Effect != UnknownEffect {
		t.Fatalf("got %+v", f)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
}

func TestOperationTablePaths(t *testing.T) {
	got, err := fillPath(OpReceiptsGet, []string{"a/b c"})
	if err != nil || got != "/b2/receipts/a%2Fb%20c" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := fillPath(OpWorkersGet, nil); err == nil {
		t.Fatal("missing path argument accepted")
	}
	seen := map[string]bool{}
	for _, op := range Operations {
		if seen[op.ID] || !strings.HasPrefix(op.Path, "/b2/") {
			t.Fatalf("bad operation %+v", op)
		}
		seen[op.ID] = true
	}
	if len(Operations) != 21 {
		t.Fatalf("operations = %d", len(Operations))
	}
}
