package b2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const worker = `{"worker_id":"w1","worker_epoch":"e","supervisor_epoch":"se","session_id":"s","session_identity_evidence":"pi_session_file","binding_revision":1,"leaf_id":null,"cwd":"/w","status":"ready","foreground":"idle","execution":null,"fence":null,"history":{"last_entry_id":null,"lag":false,"evidence":"pi_session_file"},"cleanup":"none","pending_interactions":[]}`

func snapshot(reason string) string {
	return fmt.Sprintf(`{"type":"snapshot","workers":[%s],"cursor":{"transport_epoch":"t","seq":3},"resync_reason":%q}`, worker, reason)
}

const overflow = `{"type":"overflow","cursor":{"transport_epoch":"t","seq":9},"event_id":"ev","producer":"supervisor","execution_id":null,"evidence":"observed_memory","data":{"resync_required":true,"reason":"subscriber_queue_overflow"}}`

func sseServer(t *testing.T, handler func(r *http.Request) []string) string {
	path := socketPath(t)
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		for i, data := range handler(r) {
			fmt.Fprintf(w, "id: {\"transport_epoch\":\"t\",\"seq\":%d}\n: comment\ndata: %s\n\n", i, data)
		}
		w.(http.Flusher).Flush()
	})
	return path
}

func TestWatchSnapshotOverflowResync(t *testing.T) {
	var queries []string
	path := sseServer(t, func(r *http.Request) []string {
		queries = append(queries, r.URL.RawQuery+"|"+r.Header.Get("Last-Event-ID"))
		switch {
		case r.URL.Query().Get("resync") == "overflow":
			return []string{snapshot("overflow")}
		case r.URL.Query().Get("worker_id") == "w1":
			return []string{snapshot("fresh"), overflow}
		default:
			return []string{snapshot("fresh")}
		}
	})
	c := New(path)
	ctx := context.Background()
	var first Frame
	if err := c.Watch(ctx, WatchOptions{}, func(f Frame) bool { first = f; return false }); err != nil {
		t.Fatal(err)
	}
	snap, ok := first.Event.(*SnapshotEvent)
	if !ok || len(snap.Workers) != 1 || snap.Workers[0].WorkerId != "w1" || first.ID == "" {
		t.Fatalf("first frame %+v", first)
	}
	var types []string
	err := c.Watch(ctx, WatchOptions{WorkerIDs: []string{"w1"}}, func(f Frame) bool { types = append(types, f.Type); return true })
	var resync *ResyncRequired
	if !errors.As(err, &resync) || resync.Reason != "overflow" || strings.Join(types, ",") != "snapshot,overflow" {
		t.Fatalf("overflow: %v %v", err, types)
	}
	since := snap.Cursor
	err = c.Watch(ctx, WatchOptions{WorkerIDs: []string{"w1"}, OverflowResync: true, Since: &since}, func(f Frame) bool {
		if s := f.Event.(*SnapshotEvent); s.ResyncReason != "overflow" {
			t.Fatalf("reason %s", s.ResyncReason)
		}
		return false
	})
	if err != nil {
		t.Fatal(err)
	}
	last := strings.SplitN(queries[len(queries)-1], "|", 2)
	var sent Cursor
	if last[0] != "resync=overflow&worker_id=w1" || json.Unmarshal([]byte(last[1]), &sent) != nil || sent != since {
		t.Fatalf("query %q", queries[len(queries)-1])
	}
}

func TestWatchEndOfStreamIsDisconnectedAndRefusalIsResync(t *testing.T) {
	path := sseServer(t, func(*http.Request) []string { return []string{snapshot("fresh")} })
	err := New(path).Watch(context.Background(), WatchOptions{}, func(Frame) bool { return true })
	var resync *ResyncRequired
	if !errors.As(err, &resync) || resync.Reason != "disconnected" {
		t.Fatalf("got %v", err)
	}
	refused := socketPath(t)
	serveHTTP(t, refused, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(501)
		w.Write([]byte(`{"error":"operation_not_implemented","effect":"no_effect"}`))
	})
	err = New(refused).Watch(context.Background(), WatchOptions{}, func(Frame) bool { return true })
	if !errors.As(err, &resync) || resync.Status != 501 {
		t.Fatalf("got %v", err)
	}
}

func TestWatchOversizedFrame(t *testing.T) {
	path := sseServer(t, func(*http.Request) []string {
		return []string{`{"type":"x","pad":"` + strings.Repeat("a", frameLimit) + `"}`}
	})
	err := New(path).Watch(context.Background(), WatchOptions{}, func(Frame) bool { return true })
	var resync *ResyncRequired
	if !errors.As(err, &resync) || resync.Reason != "frame_too_large" {
		t.Fatalf("got %v", err)
	}
}

// rawSSEServer writes body in chunks of at most chunk bytes, flushing after each, so records and lines cross reads.
func rawSSEServer(t *testing.T, body string, chunk int) string {
	path := socketPath(t)
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		for rest := body; rest != ""; {
			n := min(chunk, len(rest))
			io.WriteString(w, rest[:n])
			w.(http.Flusher).Flush()
			rest = rest[n:]
		}
	})
	return path
}

// A valid snapshot well above the reader's 64 KiB buffer and below the 1 MiB frame cap arrives whole (review F1:
// the long line used to be cut at the buffer boundary and the frame refused as invalid_frame).
func TestWatchLargeSnapshotAboveReaderBuffer(t *testing.T) {
	const n = 1500
	workers := make([]string, n)
	for i := range workers {
		workers[i] = strings.Replace(worker, `"worker_id":"w1"`, fmt.Sprintf(`"worker_id":"w%d"`, i), 1)
	}
	data := fmt.Sprintf(`{"type":"snapshot","workers":[%s],"cursor":{"transport_epoch":"t","seq":3},"resync_reason":"fresh"}`, strings.Join(workers, ","))
	if len(data) < 4*64<<10 || len(data) > frameLimit-1024 {
		t.Fatalf("sample is %d bytes; want between 256 KiB and the frame cap", len(data))
	}
	for _, chunk := range []int{len(data) + 64, 4096, 1} {
		if chunk == 1 && testing.Short() {
			continue
		}
		path := rawSSEServer(t, "id: 1\ndata: "+data+"\n\n", chunk)
		var got Frame
		if err := New(path).Watch(context.Background(), WatchOptions{}, func(f Frame) bool { got = f; return false }); err != nil {
			t.Fatalf("chunk %d: %v", chunk, err)
		}
		snap, ok := got.Event.(*SnapshotEvent)
		if !ok || len(snap.Workers) != n || snap.Workers[n-1].WorkerId != fmt.Sprintf("w%d", n-1) || string(got.Raw) != data {
			t.Fatalf("chunk %d: got %T with %d bytes", chunk, got.Event, len(got.Raw))
		}
	}
}

// A record exactly at the cap is accepted; one byte more is refused as frame_too_large, never truncated.
func TestWatchFrameCapIsExact(t *testing.T) {
	frame := func(total int) string {
		prefix, suffix := `{"type":"x.pad","pad":"`, `"}`
		// The cap counts the record's field lines with their line endings: "data: " + JSON + "\n".
		return prefix + strings.Repeat("a", total-len("data: ")-1-len(prefix)-len(suffix)) + suffix
	}
	for _, tc := range []struct {
		total int
		want  string
	}{{frameLimit, ""}, {frameLimit + 1, "frame_too_large"}} {
		data := frame(tc.total)
		path := rawSSEServer(t, "data: "+data+"\n\n", 32<<10)
		var got Frame
		err := New(path).Watch(context.Background(), WatchOptions{}, func(f Frame) bool { got = f; return false })
		var resync *ResyncRequired
		switch {
		case tc.want == "" && (err != nil || string(got.Raw) != data || got.Type != "x.pad"):
			t.Fatalf("at the cap: %v, %d bytes", err, len(got.Raw))
		case tc.want != "" && (!errors.As(err, &resync) || resync.Reason != tc.want || got.Raw != nil):
			t.Fatalf("over the cap: %v", err)
		}
	}
}

// SSE line endings are LF, CRLF or a lone CR, and the space after the field colon is optional.
func TestWatchLineEndingsAndFieldSpacing(t *testing.T) {
	snap := snapshot("fresh")
	for name, body := range map[string]string{
		"lf":       "id: 1\ndata: " + snap + "\n\n",
		"crlf":     "id: 1\r\n: c\r\ndata: " + snap + "\r\n\r\n",
		"cr":       "id: 1\r: c\rdata: " + snap + "\r\r",
		"no space": "id:1\ndata:" + snap + "\n\n",
	} {
		for _, chunk := range []int{1, 7, len(body)} {
			var got Frame
			err := New(rawSSEServer(t, body, chunk)).Watch(context.Background(), WatchOptions{}, func(f Frame) bool { got = f; return false })
			if err != nil || got.Type != "snapshot" || got.ID != "1" {
				t.Fatalf("%s, chunk %d: %v %+v", name, chunk, err, got)
			}
		}
	}
}

// Every event in the manifest decodes to its typed model, using the shared wire fixture where there is one.
func TestDecodeEventCoversManifest(t *testing.T) {
	samples := map[string]string{
		"snapshot":             snapshot("fresh"),
		"overflow":             overflow,
		"worker.updated":       `{"type":"worker.updated","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"observed_memory","worker_id":"w1","data":{"worker":` + worker + `}}`,
		"session.rebound":      `{"type":"session.rebound","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"session_id":"s2","binding_revision":2,"action":"new"}}`,
		"execution.settled":    `{"type":"execution.settled","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":"x1","evidence":"observed_memory","worker_id":"w1","data":{"command_id":"c","disposition":"handled"}}`,
		"fence.resolved":       `{"type":"fence.resolved","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"command_id":"c","disposition":"keep","fence_generation":1,"external_effects_undone":false,"fence":null}}`,
		"interactions.changed": `{"type":"interactions.changed","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"observed_memory","worker_id":"w1","data":{"interactions":[]}}`,
		"history.appended":     `{"type":"history.appended","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"observed_memory","worker_id":"w1","data":{"session_id":"s1","file_identity":"0000000000000000000000000000000000000000000000000000000000000000","watermark":512,"last_entry_id":"e9"}}`,
		"child.reported":       `{"type":"child.reported","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w2","data":{"report_command_id":"r1","task_id":"job","parent_worker_id":"w1","kind":"result","claim_not_verified":true}}`,
		"execution.admitted":   `{"type":"execution.admitted","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":"x1","evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"command_id":"c"}}`,
		"execution.started":    `{"type":"execution.started","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":"x1","evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"command_id":"c"}}`,
		"assistant.delta":      `{"type":"assistant.delta","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"pi","execution_id":"x1","evidence":"observed_memory","worker_id":"w1","data":{"tail":"Hel","length":3}}`,
		"tool.started":         `{"type":"tool.started","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"pi","execution_id":"x1","evidence":"observed_memory","worker_id":"w1","data":{"tool_call_id":"t1","name":"bash","summary":"ls"}}`,
		"tool.finished":        `{"type":"tool.finished","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"pi","execution_id":"x1","evidence":"observed_memory","worker_id":"w1","data":{"tool_call_id":"t1","name":"bash","summary":null,"is_error":false}}`,
		"receipt.updated":      `{"type":"receipt.updated","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"receipt":{"command_id":"c","operation":"sessions.prompt","request_hash":"h","state":"delivered","stage":"forwarded","effect":"observed","evidence":"supervisor_journal_fsynced","created_at":"2026-11-17T00:00:00Z","worker_id":"w1"}}}`,
		"fence.set":            `{"type":"fence.set","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":"x1","evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"command_id":"c","fence_generation":1,"fence":{"command_id":"c","fence_generation":1,"fenced_at":"2026-11-17T09:00:00Z","uncertain_command_ids":["c"]}}}`,
		"attachment.updated":   `{"type":"attachment.updated","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"attachment":{"attachment_id":"a1","worker_id":"w1","state":"staged","content_type":"image/jpeg","bytes":3,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","command_id":"st","staged_at":"2026-11-17T00:00:00Z","released_at":null,"released_by":null,"evidence":"supervisor_journal_fsynced"}}}`,
	}
	for _, typ := range EventTypes {
		sample, ok := samples[typ]
		if !ok {
			t.Fatalf("no sample for manifest event %s", typ)
		}
		event, err := DecodeEvent([]byte(sample))
		if err != nil {
			t.Fatal(err)
		}
		if _, unknown := event.(*UnknownEvent); unknown || eventType(event) != typ {
			t.Fatalf("%s decoded as %T", typ, event)
		}
	}
	event, err := DecodeEvent([]byte(`{"type":"future.event","x":1}`))
	if u, ok := event.(*UnknownEvent); err != nil || !ok || u.Type != "future.event" {
		t.Fatalf("unknown event: %v %v", event, err)
	}
	// The SSE frames of the shared wire fixture decode too.
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "fixtures", "wire", "events.subscribe", "ok.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Response struct {
			Frames []json.RawMessage `json:"frames"`
		} `json:"response"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil || len(fixture.Response.Frames) == 0 {
		t.Fatalf("fixture: %v", err)
	}
	for _, frame := range fixture.Response.Frames {
		if event, err := DecodeEvent(frame); err != nil || eventType(event) == "" {
			t.Fatalf("fixture frame: %v", err)
		} else if _, unknown := event.(*UnknownEvent); unknown {
			t.Fatalf("fixture frame decoded as unknown")
		}
	}
}

// fixtureFrames reads the SSE frames of one events.subscribe wire fixture (api/fixtures/wire).
func fixtureFrames(t *testing.T, name string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "fixtures", "wire", "events.subscribe", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Response struct {
			Frames []json.RawMessage `json:"frames"`
		} `json:"response"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil || len(fixture.Response.Frames) == 0 {
		t.Fatalf("fixture %s: %v", name, err)
	}
	frames := make([]string, len(fixture.Response.Frames))
	for i, f := range fixture.Response.Frames {
		var compact bytes.Buffer
		if err := json.Compact(&compact, f); err != nil {
			t.Fatal(err)
		}
		frames[i] = compact.String()
	}
	return frames
}

// consume is a consumer's reconnect loop as the Watch contract asks for: it reconnects only on ResyncRequired, at
// most limit times, and returns the last error.
func consume(c *Client, limit int) (int, error) {
	attempts := 0
	for {
		attempts++
		err := c.Watch(context.Background(), WatchOptions{}, func(Frame) bool { return true })
		var resync *ResyncRequired
		if !errors.As(err, &resync) || attempts >= limit {
			return attempts, err
		}
	}
}

// An authority end (overflow with resync_required false: a grant revoked, a parent channel retired) ends Watch with
// its typed refusal, so a consumer that reconnects only on ResyncRequired opens one stream; a queue overflow still
// requires a resync.
func TestWatchAuthorityEndIsTerminalRefusal(t *testing.T) {
	for _, tc := range []struct{ fixture, code string }{{"grant-revoked", "grant_revoked"}, {"parent-channel-retired", "parent_channel_retired"}} {
		frames := fixtureFrames(t, tc.fixture)
		connections := 0
		path := sseServer(t, func(*http.Request) []string { connections++; return frames })
		var seen *OverflowEvent
		err := New(path).Watch(context.Background(), WatchOptions{}, func(f Frame) bool {
			if o, ok := f.Event.(*OverflowEvent); ok {
				seen = o
			}
			return true
		})
		if seen == nil || seen.Data.ResyncRequired || seen.Data.Reason != tc.code {
			t.Fatalf("%s: the terminal frame was not delivered: %v", tc.fixture, err)
		}
		var resync *ResyncRequired
		if errors.As(err, &resync) {
			t.Fatalf("%s: an authority end is not a resync", tc.fixture)
		}
		var f *ClientFailure
		if !errors.As(err, &f) || f.Op != OpEventsSubscribe.ID || f.Phase != PhaseHTTP || f.Status != http.StatusOK || f.Effect != NoEffect || f.Body == nil || f.Body.Error != tc.code || f.Body.Effect != NoEffect {
			t.Fatalf("%s: not the typed refusal: %v", tc.fixture, err)
		}
		if code, ok := StreamRefused(err); !ok || code != tc.code {
			t.Fatalf("%s: StreamRefused = %q %v", tc.fixture, code, ok)
		}
		attempts, err := consume(New(path), 5)
		if _, ok := StreamRefused(err); !ok || attempts != 1 || connections != 2 {
			t.Fatalf("%s: a consumer reconnected after a terminal end: %d attempts, %d connections", tc.fixture, attempts, connections)
		}
	}
	frames := fixtureFrames(t, "queue-overflow")
	connections := 0
	path := sseServer(t, func(*http.Request) []string { connections++; return frames })
	attempts, err := consume(New(path), 3)
	var resync *ResyncRequired
	if !errors.As(err, &resync) || resync.Reason != "overflow" || attempts != 3 || connections != 3 {
		t.Fatalf("queue overflow: %v after %d attempts, %d connections", err, attempts, connections)
	}
	if _, ok := StreamRefused(err); ok {
		t.Fatal("a resync is not a refusal")
	}
	// A refusal of a new subscription (HTTP) is not an in-stream end.
	if _, ok := StreamRefused(&ClientFailure{Op: OpEventsSubscribe.ID, Phase: PhaseHTTP, Status: 409, Body: &Error{Error: "grant_revoked"}}); ok {
		t.Fatal("an HTTP refusal is not StreamRefused")
	}
}
