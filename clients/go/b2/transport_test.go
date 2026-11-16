package b2

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
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

// stallConn passes the first half of the first write to the worker, then blocks until the connection is closed, as
// a write stuck on a full socket buffer does: request bytes have reached the peer, but the write has not returned.
type stallConn struct {
	net.Conn
	closed chan struct{}
	once   sync.Once
}

func (s *stallConn) Write(p []byte) (int, error) {
	n, err := s.Conn.Write(p[:len(p)/2])
	if err != nil {
		return n, err
	}
	<-s.closed
	return n, net.ErrClosed
}

func (s *stallConn) Close() error {
	s.once.Do(func() { close(s.closed) })
	return s.Conn.Close()
}

// A timeout while the request is half written is unknown: the worker already holds request bytes.
func TestFailureDuringPartialWriteIsUnknown(t *testing.T) {
	path := socketPath(t)
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	received := make(chan []byte, 1)
	go func() {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 64<<10)
		n, _ := conn.Read(buf)
		received <- buf[:n]
		io.Copy(io.Discard, conn)
	}()
	c := New(path, WithTimeout(100*time.Millisecond))
	transport := c.http.Transport.(*http.Transport)
	dial := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := dial(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &stallConn{Conn: conn, closed: make(chan struct{})}, nil
	}
	_, err = c.SessionsPrompt(context.Background(), "w1", prompt("partial"))
	f := asFailure(t, err)
	select {
	case got := <-received:
		if !bytes.HasPrefix(got, []byte("POST /b2/workers/w1/prompt HTTP/1.1")) {
			t.Fatalf("worker received %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker received no request bytes")
	}
	if f.Phase != PhaseAfterWrite || f.Effect != UnknownEffect {
		t.Fatalf("bytes reached the worker but the failure is %s %s: %v", f.Phase, f.Effect, f.Err)
	}
}

// handoffTransport stands in for http.Transport at the classification boundary: it reports the connection handoff
// (GotConn) when handoff is set, never reports WroteRequest, and fails.
type handoffTransport struct{ handoff bool }

func (h handoffTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if trace := httptrace.ContextClientTrace(req.Context()); h.handoff && trace != nil && trace.GotConn != nil {
		trace.GotConn(httptrace.GotConnInfo{})
	}
	return nil, errors.New("connection lost")
}

// The boundary is the connection handoff, not WroteRequest (review F5). Once the transport holds a peer-checked
// connection for this request, a failure is unknown even if no write was reported; this is the conservative policy.
// Go 1.24 to 1.27 also fire WroteRequest, with its error, for a failed partial write before Do returns (the test
// above), so on those versions the handoff rule only relabels a connected-but-unwritten failure as unknown. A
// failure before the handoff (dial, peer check) is no_effect.
func TestClassificationBoundaryIsConnectionHandoff(t *testing.T) {
	for _, tc := range []struct {
		handoff bool
		phase   Phase
		effect  Effect
	}{{true, PhaseAfterWrite, UnknownEffect}, {false, PhaseBeforeWrite, NoEffect}} {
		c := New(socketPath(t))
		c.http.Transport = handoffTransport{handoff: tc.handoff}
		_, err := c.SessionsPrompt(context.Background(), "w1", prompt("handoff"))
		if f := asFailure(t, err); f.Phase != tc.phase || f.Effect != tc.effect {
			t.Fatalf("handoff=%v: got %s %s, want %s %s", tc.handoff, f.Phase, f.Effect, tc.phase, tc.effect)
		}
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
	if OpEventsSubscribe.Response != "sse" || frameLimit != 1<<20 || OpAttachmentsStage.Body != "binary" || OpAttachmentsStage.MaxBodyBytes != 2<<20 || OpHello.Body != "none" || OpSessionsPrompt.MaxBodyBytes != 256<<10 {
		t.Fatalf("modes: %+v %+v", OpEventsSubscribe, OpAttachmentsStage)
	}
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
	if len(Operations) != 25 { // 22 in P0, plus sessions.steer (P1-5), sessions.new (P1-7) and items.read (P1-8)
		t.Fatalf("operations = %d", len(Operations))
	}
}
