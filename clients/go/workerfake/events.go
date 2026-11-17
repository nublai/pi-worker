package workerfake

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// The supervisor-wide event stream, as packages/worker/src/events/hub.ts serves it: a snapshot first on every
// attach (resync_reason fresh, current, gap, epoch, ahead or overflow), then later events only, never a replay. A
// subscriber holds at most queueEvents undelivered frames and queueBytes of them (the frames its writer has not taken
// yet, while the transport is backpressured); past either it gets one overflow frame and is closed.

const (
	queueEvents = 64
	queueBytes  = 256 << 10
)

// queued is one SSE record; counted ones (events, not the snapshot or the overflow frame) hold queue room.
type queued struct {
	data    []byte
	counted bool
}

type subscriber struct {
	frames    chan queued // capacity queueEvents+2 so the snapshot and the overflow record always fit
	bytes     int         // bytes of the counted records not yet taken by the writer (f.mu)
	workerIDs map[string]bool
	types     map[string]bool
	closed    bool
}

func (sub *subscriber) wants(eventType, workerID string) bool {
	if sub.workerIDs != nil && !sub.workerIDs[workerID] {
		return false
	}
	return sub.types == nil || sub.types[eventType]
}

func record(eventType string, cursor b2.Cursor, frame any) []byte {
	id, _ := json.Marshal(cursor)
	data, _ := json.Marshal(frame)
	return []byte(fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n", id, eventType, data))
}

func (s *state) cursor() b2.Cursor { return b2.Cursor{TransportEpoch: s.supervisorEpoch, Seq: s.seq} }

// publish sends one worker event to every subscriber that wants it (f.mu held).
func (s *state) publish(eventType, workerID string, executionID *string, evidence string, data any) {
	s.seq++
	cursor := s.cursor()
	frame := map[string]any{
		"type": eventType, "cursor": cursor, "event_id": s.id("ev"), "producer": "supervisor",
		"execution_id": executionID, "evidence": evidence, "worker_id": workerID, "data": data,
	}
	rec := record(eventType, cursor, frame)
	for sub := range s.subs {
		if !sub.wants(eventType, workerID) {
			continue
		}
		// A frame alone in an empty queue goes straight to the writer, as the hub sends to a transport that is not
		// backpressured.
		if len(sub.frames) >= queueEvents || (sub.bytes > 0 && sub.bytes+len(rec) > queueBytes) {
			s.overflow(sub, "subscriber_queue_overflow")
			continue
		}
		sub.bytes += len(rec)
		sub.frames <- queued{data: rec, counted: true}
	}
}

func (s *state) publishInteractions(w *worker) {
	list := pending(w)
	s.publish("interactions.changed", w.row.WorkerId, executionOf(w), "observed_memory", map[string]any{"interactions": list})
}

// overflow sends one overflow frame and ends the subscription.
func (s *state) overflow(sub *subscriber, reason string) {
	if sub.closed {
		return
	}
	frame := map[string]any{
		"type": "overflow", "cursor": s.cursor(), "event_id": s.id("ev"), "producer": "supervisor", "execution_id": nil,
		"evidence": "observed_memory", "data": map[string]any{"resync_required": true, "reason": reason},
	}
	sub.frames <- queued{data: record("overflow", s.cursor(), frame)}
	s.end(sub)
}

func (s *state) end(sub *subscriber) {
	if sub.closed {
		return
	}
	sub.closed = true
	close(sub.frames)
	delete(s.subs, sub)
}

// endStreams closes every stream without a frame (a supervisor restart or Close): readers see a disconnect.
func (s *state) endStreams() {
	for sub := range s.subs {
		s.end(sub)
	}
}

// Overflow sends every open stream an overflow frame and closes it, as a subscriber queue overflow does.
func (f *Fake) Overflow() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for sub := range f.st.subs {
		f.st.overflow(sub, "subscriber_queue_overflow")
	}
}

// Streams counts open event streams.
func (f *Fake) Streams() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.st.subs)
}

// cursorOf parses Last-Event-ID as packages/worker/src/b2/app.ts does: a JSON object whose transport_epoch is a
// string (any string, the empty one included: an unknown epoch is a resync, not an error) and whose seq is a
// non-negative safe integer.
func cursorOf(raw string) (*b2.Cursor, bool) {
	var v struct {
		TransportEpoch *string          `json:"transport_epoch"`
		Seq            *json.RawMessage `json:"seq"`
	}
	if err := json.Unmarshal([]byte(raw), &v); err != nil || v.TransportEpoch == nil || v.Seq == nil {
		return nil, false
	}
	// A JSON number (never a string) with an integral value: JSON.parse then Number.isSafeInteger.
	var seq float64
	if first := (*v.Seq)[0]; (first != '-' && (first < '0' || first > '9')) || json.Unmarshal(*v.Seq, &seq) != nil {
		return nil, false
	}
	if seq != math.Trunc(seq) || seq < 0 || seq > 1<<53-1 {
		return nil, false
	}
	return &b2.Cursor{TransportEpoch: *v.TransportEpoch, Seq: int(seq)}, true
}

func subscribe(f *Fake, c *call) (any, error) {
	var since *b2.Cursor
	if values := c.header.Values("Last-Event-ID"); len(values) > 0 {
		cur, ok := cursorOf(values[0])
		if !ok {
			return nil, badRequest("invalid_last_event_id")
		}
		since = cur
	}
	sub := &subscriber{frames: make(chan queued, queueEvents+2)}
	if v := c.query.Get("types"); v != "" {
		sub.types = map[string]bool{}
		for _, t := range strings.Split(v, ",") {
			known := false
			for _, e := range b2.EventTypes {
				known = known || e == t
			}
			if !known {
				return nil, badRequest("unknown_event_type")
			}
			sub.types[t] = true
		}
	}
	if v := c.query.Get("worker_id"); v != "" {
		sub.workerIDs = map[string]bool{}
		for _, id := range strings.Split(v, ",") {
			sub.workerIDs[id] = true
		}
	}
	f.mu.Lock()
	s := f.st
	// The attach barrier: rows, cursor and registration in one critical section, the snapshot queued first.
	workers := []b2.Worker{}
	for _, id := range s.order {
		if sub.workerIDs == nil || sub.workerIDs[id] {
			workers = append(workers, s.view(s.workers[id]))
		}
	}
	reason := "fresh"
	switch {
	case c.query.Get("resync") == "overflow":
		reason = "overflow"
	case since == nil:
	case since.TransportEpoch != s.supervisorEpoch:
		reason = "epoch"
	case since.Seq > s.seq:
		reason = "ahead"
	case since.Seq == s.seq:
		reason = "current"
	default:
		reason = "gap"
	}
	cursor := s.cursor()
	sub.frames <- queued{data: record("snapshot", cursor, map[string]any{"type": "snapshot", "workers": workers, "cursor": cursor, "resync_reason": reason})}
	s.subs[sub] = true
	f.mu.Unlock()

	w := c.w
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	for {
		select {
		case rec, ok := <-sub.frames:
			if !ok {
				return written{}, nil
			}
			if rec.counted {
				f.mu.Lock()
				sub.bytes -= len(rec.data)
				f.mu.Unlock()
			}
			if _, err := w.Write(rec.data); err != nil {
				f.mu.Lock()
				s.end(sub)
				f.mu.Unlock()
				return written{}, nil
			}
			if flusher != nil {
				flusher.Flush()
			}
		case <-c.r.Context().Done():
			f.mu.Lock()
			s.end(sub)
			f.mu.Unlock()
			return written{}, nil
		}
	}
}
