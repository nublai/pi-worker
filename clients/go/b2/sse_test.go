package b2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// Every event in the manifest decodes to its typed model, using the shared wire fixture where there is one.
func TestDecodeEventCoversManifest(t *testing.T) {
	samples := map[string]string{
		"snapshot":             snapshot("fresh"),
		"overflow":             overflow,
		"worker.updated":       `{"type":"worker.updated","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"observed_memory","worker_id":"w1","data":{"worker":` + worker + `}}`,
		"session.rebound":      `{"type":"session.rebound","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"session_id":"s2","binding_revision":2,"action":"new"}}`,
		"execution.settled":    `{"type":"execution.settled","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":"x1","evidence":"observed_memory","worker_id":"w1","data":{"disposition":"handled"}}`,
		"fence.resolved":       `{"type":"fence.resolved","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"supervisor_journal_fsynced","worker_id":"w1","data":{"command_id":"c","disposition":"keep","fence_generation":1,"external_effects_undone":false,"fence":null}}`,
		"interactions.changed": `{"type":"interactions.changed","cursor":{"transport_epoch":"t","seq":1},"event_id":"e1","producer":"supervisor","execution_id":null,"evidence":"observed_memory","worker_id":"w1","data":{"interactions":[]}}`,
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
