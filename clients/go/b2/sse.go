package b2

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
)

const frameLimit = 1 << 20

// Frame is one SSE record from the events stream.
type Frame struct {
	// ID is the SSE id (the transport cursor as JSON); pass it back as WatchOptions.Since on a reconnect.
	ID string
	// Type is the frame's event type ("snapshot", "overflow", "worker.updated", ...).
	Type string
	// Event is the decoded model: *SnapshotEvent, *OverflowEvent, ... or *UnknownEvent.
	Event any
	Raw   json.RawMessage
}

// WatchOptions filters the supervisor-wide stream.
type WatchOptions struct {
	WorkerIDs []string
	Types     []string
	// Since is the last cursor seen. The worker never replays: it answers with a fresh snapshot whose
	// resync_reason says why.
	Since *Cursor
	// OverflowResync asks for a snapshot labelled "overflow" after an overflow.
	OverflowResync bool
}

// Watch reads the events stream until onFrame returns false (nil), the stream overflows (*ResyncRequired
// "overflow", after onFrame saw the overflow frame), disconnects (*ResyncRequired "disconnected") or is refused
// (*ResyncRequired "HTTP <status>"). It never reconnects on its own: reconnecting is the caller's decision and the
// next Watch starts with a snapshot. The per-call timeout does not apply; use ctx to stop watching.
func (c *Client) Watch(ctx context.Context, opts WatchOptions, onFrame func(Frame) bool) error {
	query := url.Values{}
	if len(opts.WorkerIDs) > 0 {
		query.Set("worker_id", strings.Join(opts.WorkerIDs, ","))
	}
	if len(opts.Types) > 0 {
		query.Set("types", strings.Join(opts.Types, ","))
	}
	if opts.OverflowResync {
		query.Set("resync", "overflow")
	}
	var connected atomic.Bool
	req, err := c.newRequest(ctx, OpEventsSubscribe, nil, query, nil, "text/event-stream", &connected)
	if err != nil {
		return &ClientFailure{Op: OpEventsSubscribe.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: err}
	}
	if opts.Since != nil {
		since, err := json.Marshal(opts.Since)
		if err != nil {
			return &ClientFailure{Op: OpEventsSubscribe.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: err}
		}
		req.Header.Set("Last-Event-ID", string(since))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return transportFailure(OpEventsSubscribe, connected.Load(), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(resp.Body, responseLimit))
		return &ResyncRequired{Reason: fmt.Sprintf("HTTP %d", resp.StatusCode), Status: resp.StatusCode}
	}
	return readFrames(resp.Body, onFrame)
}

// readFrames parses text/event-stream records: `id:` and `data:` fields, a blank line ends a record, `:` lines are
// comments. A record over 1 MiB ends the watch.
func readFrames(body io.Reader, onFrame func(Frame) bool) error {
	reader := bufio.NewReaderSize(body, 64<<10)
	var id string
	var data bytes.Buffer
	size := 0
	for {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			// Keep reading the long line, bounded by the frame limit.
			size += len(line)
			if size > frameLimit {
				return &ResyncRequired{Reason: "frame_too_large"}
			}
			data.Write(bytes.TrimPrefix(line, []byte("data: ")))
			continue
		}
		if err != nil {
			return &ResyncRequired{Reason: "disconnected"}
		}
		size += len(line)
		if size > frameLimit {
			return &ResyncRequired{Reason: "frame_too_large"}
		}
		text := strings.TrimRight(string(line), "\r\n")
		switch {
		case text == "":
			if data.Len() > 0 {
				raw := json.RawMessage(bytes.Clone(data.Bytes()))
				event, err := DecodeEvent(raw)
				if err != nil {
					return &ResyncRequired{Reason: "invalid_frame"}
				}
				frame := Frame{ID: id, Type: eventType(event), Event: event, Raw: raw}
				keep := onFrame(frame)
				if frame.Type == "overflow" {
					return &ResyncRequired{Reason: "overflow"}
				}
				if !keep {
					return nil
				}
			}
			id, size = "", 0
			data.Reset()
		case strings.HasPrefix(text, ":"):
		case strings.HasPrefix(text, "id:"):
			id = strings.TrimPrefix(strings.TrimPrefix(text, "id:"), " ")
		case strings.HasPrefix(text, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(text, "data:"), " "))
		}
	}
}

func eventType(event any) string {
	switch e := event.(type) {
	case *SnapshotEvent:
		return string(e.Type)
	case *OverflowEvent:
		return string(e.Type)
	case *WorkerUpdatedEvent:
		return string(e.Type)
	case *SessionReboundEvent:
		return string(e.Type)
	case *ExecutionSettledEvent:
		return string(e.Type)
	case *FenceResolvedEvent:
		return string(e.Type)
	case *InteractionsChangedEvent:
		return string(e.Type)
	case *UnknownEvent:
		return e.Type
	}
	return ""
}
