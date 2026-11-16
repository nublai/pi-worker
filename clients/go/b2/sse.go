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

// frameLimit caps one SSE record: the bytes of its field lines, each counted with one line-ending byte. It is the
// spec's x-piw-max-frame-bytes for events.subscribe; a longer record is refused, never truncated.
var frameLimit = OpEventsSubscribe.MaxFrameBytes

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

var errLineTooLong = errors.New("b2: SSE line over the frame limit")

// lineReader yields whole SSE lines of any length up to max bytes. Lines end in LF, CRLF or a lone CR. A longer line
// is an error: it is never cut into pieces that could be parsed as fields.
type lineReader struct {
	r         *bufio.Reader
	max       int
	line      []byte
	pendingCR bool
}

func (l *lineReader) next() ([]byte, error) {
	if l.pendingCR {
		// The previous line ended in CR; an LF right after it belongs to the same line ending.
		l.pendingCR = false
		if b, err := l.r.Peek(1); err != nil {
			return nil, err
		} else if b[0] == '\n' {
			l.r.Discard(1)
		}
	}
	l.line = l.line[:0]
	for {
		if l.r.Buffered() == 0 {
			if _, err := l.r.Peek(1); err != nil {
				return nil, err
			}
		}
		buf, _ := l.r.Peek(l.r.Buffered())
		i := bytes.IndexAny(buf, "\r\n")
		if i < 0 {
			if len(l.line)+len(buf) > l.max {
				return nil, errLineTooLong
			}
			l.line = append(l.line, buf...)
			l.r.Discard(len(buf))
			continue
		}
		if len(l.line)+i > l.max {
			return nil, errLineTooLong
		}
		l.line = append(l.line, buf[:i]...)
		l.pendingCR = buf[i] == '\r'
		l.r.Discard(i + 1)
		return l.line, nil
	}
}

// readFrames parses text/event-stream records: `id` and `data` fields (the space after the colon is optional), a
// blank line ends a record, lines starting with `:` are comments, other fields are ignored. A record over
// frameLimit ends the watch with frame_too_large.
func readFrames(body io.Reader, onFrame func(Frame) bool) error {
	lines := &lineReader{r: bufio.NewReaderSize(body, 64<<10), max: frameLimit}
	var id string
	var data bytes.Buffer
	hasData := false
	size := 0
	for {
		line, err := lines.next()
		if errors.Is(err, errLineTooLong) {
			return &ResyncRequired{Reason: "frame_too_large"}
		}
		if err != nil {
			return &ResyncRequired{Reason: "disconnected"}
		}
		if len(line) > 0 {
			size += len(line) + 1
			if size > frameLimit {
				return &ResyncRequired{Reason: "frame_too_large"}
			}
		}
		field, value := string(line), ""
		if i := strings.IndexByte(field, ':'); i >= 0 {
			field, value = field[:i], strings.TrimPrefix(field[i+1:], " ")
		}
		switch {
		case len(line) == 0:
			if hasData && data.Len() > 0 {
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
			id, size, hasData = "", 0, false
			data.Reset()
		case field == "": // a comment
		case field == "id":
			id = value
		case field == "data":
			if hasData {
				data.WriteByte('\n')
			}
			data.WriteString(value)
			hasData = true
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
	case *ChildReportedEvent:
		return string(e.Type)
	case *UnknownEvent:
		return e.Type
	}
	return ""
}
