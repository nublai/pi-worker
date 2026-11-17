package workerfake

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// The supervisor-wide event stream, as packages/worker/src/events/hub.ts serves it: a snapshot first on every
// attach (resync_reason fresh, current, gap, epoch, ahead or overflow), then later events only, never a replay. A
// subscriber holds at most queueEvents undelivered frames; past that it gets one overflow frame and is closed.

const queueEvents = 64

type subscriber struct {
	frames    chan []byte // SSE records; capacity queueEvents+1 so the overflow record always fits
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
		if len(sub.frames) >= queueEvents {
			s.overflow(sub, "subscriber_queue_overflow")
			continue
		}
		sub.frames <- rec
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
	sub.frames <- record("overflow", s.cursor(), frame)
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

func subscribe(f *Fake, c *call) (any, error) {
	var since *b2.Cursor
	if raw := c.header.Get("Last-Event-ID"); raw != "" {
		var cur b2.Cursor
		if err := json.Unmarshal([]byte(raw), &cur); err != nil || cur.TransportEpoch == "" || cur.Seq < 0 {
			return nil, badRequest("invalid_last_event_id")
		}
		since = &cur
	}
	sub := &subscriber{frames: make(chan []byte, queueEvents+1)}
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
	sub.frames <- record("snapshot", cursor, map[string]any{"type": "snapshot", "workers": workers, "cursor": cursor, "resync_reason": reason})
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
			if _, err := w.Write(rec); err != nil {
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
