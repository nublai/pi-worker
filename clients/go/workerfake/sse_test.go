package workerfake_test

// SSE reconnect through the Go client (plan P1-17): the worker never replays. Every attach starts with a snapshot
// whose resync_reason says why (fresh, current, gap, epoch, ahead, overflow); a reconnect is the caller's decision
// with Since (Last-Event-ID); an overflow or a supervisor restart ends the watch with ResyncRequired.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

type watch struct {
	frames chan b2.Frame
	done   chan error
	cancel context.CancelFunc
}

// startWatch runs one Watch in the background; frames arrive on a channel.
func startWatch(t *testing.T, c *b2.Client, opts b2.WatchOptions) *watch {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	w := &watch{frames: make(chan b2.Frame, 256), done: make(chan error, 1), cancel: cancel}
	go func() { w.done <- c.Watch(ctx, opts, func(f b2.Frame) bool { w.frames <- f; return true }) }()
	t.Cleanup(cancel)
	return w
}

func (w *watch) next(t *testing.T) b2.Frame {
	t.Helper()
	select {
	case f := <-w.frames:
		return f
	case err := <-w.done:
		t.Fatalf("watch ended: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("no frame")
	}
	return b2.Frame{}
}

func (w *watch) end(t *testing.T) error {
	t.Helper()
	select {
	case err := <-w.done:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("watch did not end")
		return nil
	}
}

func snapshotOf(t *testing.T, f b2.Frame) *b2.SnapshotEvent {
	t.Helper()
	s, ok := f.Event.(*b2.SnapshotEvent)
	if !ok {
		t.Fatalf("first frame is %s, not a snapshot", f.Type)
	}
	return s
}

func newWorker(t *testing.T, ctx context.Context, c *b2.Client, cmd string) *b2.Worker {
	t.Helper()
	r, err := c.WorkersCreate(ctx, b2.Create{CommandId: cmd, Cwd: filepath.Join(t.TempDir(), cmd), Provider: "fixture", Model: "fixture", Thinking: "off"})
	if err != nil {
		t.Fatal(err)
	}
	w, err := c.WorkersGet(ctx, *r.WorkerId)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func bindingOf(w *b2.Worker, cmd string) b2.Binding {
	return b2.Binding{CommandId: cmd, WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision}
}

func TestSSEReconnectAlwaysStartsWithASnapshotAndNeverReplays(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")

	first := startWatch(t, c, b2.WatchOptions{})
	snap := snapshotOf(t, first.next(t))
	if snap.ResyncReason != "fresh" || len(snap.Workers) != 1 || snap.Workers[0].WorkerId != w.WorkerId {
		t.Fatalf("fresh snapshot %+v", snap)
	}
	// A change after the barrier arrives as an event with the next cursor.
	if _, err := c.SessionConfigure(ctx, w.WorkerId, b2.Configure{CommandId: "cfg-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Name: ptr("renamed")}); err != nil {
		t.Fatal(err)
	}
	// Each journaled receipt record is a receipt.updated: the intent and the dispatch record come first, each with
	// the next cursor.
	seq := snap.Cursor.Seq
	for _, state := range []b2.ReceiptState{"intent", "accepted"} {
		ev := first.next(t)
		r, ok := ev.Event.(*b2.ReceiptUpdatedEvent)
		if !ok || r.Data.Receipt.CommandId != "cfg-1" || r.Data.Receipt.State != state || r.Cursor.Seq != seq+1 {
			t.Fatalf("event %s %+v, want the %s record", ev.Type, ev.Event, state)
		}
		seq = r.Cursor.Seq
	}
	ev := first.next(t)
	updated, ok := ev.Event.(*b2.WorkerUpdatedEvent)
	if !ok || updated.Data.Worker.Title == nil || *updated.Data.Worker.Title != "renamed" || updated.Cursor.Seq != seq+1 {
		t.Fatalf("event %s %+v", ev.Type, ev.Event)
	}
	// The command's result record follows its row (receipt.updated); its cursor is the newest.
	ev = first.next(t)
	receipt, ok := ev.Event.(*b2.ReceiptUpdatedEvent)
	if !ok || receipt.Data.Receipt.CommandId != "cfg-1" || receipt.Cursor.Seq != updated.Cursor.Seq+1 {
		t.Fatalf("event %s %+v", ev.Type, ev.Event)
	}
	last := receipt.Cursor
	first.cancel()
	first.end(t)

	// Reconnect at the newest cursor: a snapshot labelled current, and nothing replayed after it.
	current := startWatch(t, c, b2.WatchOptions{Since: &last})
	if s := snapshotOf(t, current.next(t)); s.ResyncReason != "current" || s.Workers[0].Title == nil || *s.Workers[0].Title != "renamed" {
		t.Fatalf("current snapshot %+v", s)
	}
	select {
	case f := <-current.frames:
		t.Fatalf("replayed %s after the snapshot", f.Type)
	case <-time.After(100 * time.Millisecond):
	}
	current.cancel()
	current.end(t)

	// Events published while disconnected are a gap: the snapshot carries the state, not the missed events.
	if _, err := c.SessionConfigure(ctx, w.WorkerId, b2.Configure{CommandId: "cfg-2", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Name: ptr("again")}); err != nil {
		t.Fatal(err)
	}
	gap := startWatch(t, c, b2.WatchOptions{Since: &last})
	if s := snapshotOf(t, gap.next(t)); s.ResyncReason != "gap" || *s.Workers[0].Title != "again" {
		t.Fatalf("gap snapshot %+v", s)
	}
	gap.cancel()
	gap.end(t)

	ahead := startWatch(t, c, b2.WatchOptions{Since: &b2.Cursor{TransportEpoch: last.TransportEpoch, Seq: last.Seq + 1000}})
	if s := snapshotOf(t, ahead.next(t)); s.ResyncReason != "ahead" {
		t.Fatalf("ahead snapshot %+v", s)
	}
	ahead.cancel()
	ahead.end(t)

	// A supervisor restart ends the stream (disconnected); the reconnect sees a new epoch.
	live := startWatch(t, c, b2.WatchOptions{})
	snapshotOf(t, live.next(t))
	fake.Restart()
	var resync *b2.ResyncRequired
	if err := live.end(t); !errors.As(err, &resync) || resync.Reason != "disconnected" {
		t.Fatalf("restart: %v", err)
	}
	epoch := startWatch(t, c, b2.WatchOptions{Since: &last})
	s := snapshotOf(t, epoch.next(t))
	if s.ResyncReason != "epoch" || s.Cursor.TransportEpoch == last.TransportEpoch || s.Workers[0].Status != "cleanup_pending" {
		t.Fatalf("epoch snapshot %+v", s)
	}
}

func TestSSEOverflowEndsTheWatchAndAsksForAnOverflowSnapshot(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	c := fake.Client()
	w := startWatch(t, c, b2.WatchOptions{})
	snapshotOf(t, w.next(t))
	fake.Overflow()
	f := w.next(t)
	if o, ok := f.Event.(*b2.OverflowEvent); !ok || !bool(o.Data.ResyncRequired) {
		t.Fatalf("frame %s", f.Type)
	}
	var resync *b2.ResyncRequired
	if err := w.end(t); !errors.As(err, &resync) || resync.Reason != "overflow" {
		t.Fatalf("overflow: %v", err)
	}
	again := startWatch(t, c, b2.WatchOptions{OverflowResync: true})
	if s := snapshotOf(t, again.next(t)); s.ResyncReason != "overflow" {
		t.Fatalf("resync snapshot %+v", s)
	}
}

// A subscriber that does not read is closed with one overflow frame once its queue is full; the fake never blocks.
func TestSSESlowSubscriberOverflows(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	attached, block := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	var frames []b2.Frame
	go func() {
		done <- c.Watch(ctx, b2.WatchOptions{}, func(f b2.Frame) bool {
			if len(frames) == 0 {
				close(attached)
				<-block // the reader stalls on its snapshot
			}
			frames = append(frames, f)
			return true
		})
	}()
	<-attached
	for i := 0; fake.Streams() == 1; i++ {
		if i == 10000 {
			t.Fatal("the stalled subscriber never overflowed")
		}
		if _, err := c.SessionConfigure(ctx, w.WorkerId, b2.Configure{CommandId: fmt.Sprintf("cfg-%d", i), WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Name: ptr("x")}); err != nil {
			t.Fatal(err)
		}
	}
	close(block)
	var resync *b2.ResyncRequired
	if err := <-done; !errors.As(err, &resync) || resync.Reason != "overflow" {
		t.Fatalf("slow subscriber: %v", err)
	}
	if frames[len(frames)-1].Type != "overflow" {
		t.Fatalf("last frame %s", frames[len(frames)-1].Type)
	}
}

// The subscriber queue is bounded by bytes as well as by count: fewer than 64 large frames that a stalled reader
// does not take overflow it once they pass 256 KiB beyond what the socket holds (PR #16 Grok 6).
func TestSSEStalledSubscriberOverflowsOnQueuedBytes(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	attached, block := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	var frames []b2.Frame
	go func() {
		done <- c.Watch(ctx, b2.WatchOptions{Types: []string{"interactions.changed"}}, func(f b2.Frame) bool {
			if len(frames) == 0 {
				close(attached)
				<-block
			}
			frames = append(frames, f)
			return true
		})
	}()
	<-attached
	// 30 frames (each interactions.changed lists every open card, 8 KiB of title each): about 3.7 MB in all.
	title := strings.Repeat("t", 8<<10)
	for i := 0; i < 30 && fake.Streams() == 1; i++ {
		if _, err := fake.OpenInteraction(w.WorkerId, b2.Interaction{Kind: "confirm", Title: &title}); err != nil {
			t.Fatal(err)
		}
	}
	for deadline := time.Now().Add(5 * time.Second); fake.Streams() == 1; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			close(block)
			t.Fatal("30 large frames never overflowed the stalled subscriber")
		}
	}
	close(block)
	var resync *b2.ResyncRequired
	if err := <-done; !errors.As(err, &resync) || resync.Reason != "overflow" {
		t.Fatalf("stalled subscriber: %v", err)
	}
	if len(frames) >= 30 {
		t.Fatalf("%d frames delivered: nothing overflowed", len(frames))
	}
}

// rawSubscribe opens events.subscribe with a raw Last-Event-ID header, which the Go client never sends malformed.
func rawSubscribe(t *testing.T, fake *workerfake.Fake, lastEventID string) (int, string) {
	t.Helper()
	grant, err := os.ReadFile(fake.GrantFile())
	if err != nil {
		t.Fatal(err)
	}
	var g struct{ Token string }
	json.Unmarshal(grant, &g)
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", fake.SocketPath())
	}}}
	req, _ := http.NewRequest("GET", "http://worker/b2/events", nil)
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header["Last-Event-Id"] = []string{lastEventID}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, _ := bufio.NewReader(resp.Body).ReadString('\n')
	return resp.StatusCode, line
}

// A malformed Last-Event-ID and an unknown event type are 400 before the stream opens; a well-formed cursor of an
// unknown epoch, the empty one included, is a resync, as app.ts cursorOf takes it (PR #16 Grok 5).
func TestSSERefusesAnInvalidLastEventIDAndAnUnknownType(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	c := fake.Client()
	var resync *b2.ResyncRequired
	err = c.Watch(context.Background(), b2.WatchOptions{Types: []string{"no.such"}}, func(b2.Frame) bool { return true })
	if !errors.As(err, &resync) || resync.Status != 400 {
		t.Fatalf("unknown type: %v", err)
	}
	for _, bad := range []string{"", "not json", "null", "[]", `{"seq":1}`, `{"transport_epoch":1,"seq":1}`, `{"transport_epoch":"e"}`, `{"transport_epoch":"e","seq":-1}`, `{"transport_epoch":"e","seq":1.5}`, `{"transport_epoch":"e","seq":"1"}`} {
		if status, body := rawSubscribe(t, fake, bad); status != 400 || !strings.Contains(body, "invalid_last_event_id") {
			t.Errorf("Last-Event-ID %q: %d %s, want 400 invalid_last_event_id", bad, status, body)
		}
	}
	if status, _ := rawSubscribe(t, fake, `{"transport_epoch":"","seq":0}`); status != 200 {
		t.Fatalf("an empty epoch: %d", status)
	}
	w := startWatch(t, c, b2.WatchOptions{Since: &b2.Cursor{}})
	if s := snapshotOf(t, w.next(t)); s.ResyncReason != "epoch" {
		t.Fatalf("a zero cursor: %+v", s)
	}
}

func ptr[T any](v T) *T { return &v }
