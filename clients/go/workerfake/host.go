package workerfake

import (
	"errors"
	"unicode/utf16"
)

// Host is the fixture-only stand-in for a worker's pi process: it counts native prompt submissions, can lose or
// hold the next prompt reply, and injects native events. It never produces a model effect on its own: a prompt
// starts (agent_start) and is acknowledged, and nothing settles until Emit("agent_settled").
type Host struct {
	f       *Fake
	w       *worker
	prompts int
	mode    string // "", "drop" or "hold"
	held    chan struct{}
	starts  []chan struct{}
	accept  *int               // images the next prompt with images reports accepted; nil: all of them
	tools   map[string]*string // summaries of tool calls started and not finished
}

var errDroppedReply = errors.New("fixture_dropped_reply")

// Host returns the host first launched for a worker (it keeps counting after a restart retires it), or nil.
func (f *Fake) Host(workerID string) *Host {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.st.firstHost[workerID]
}

// Hosts counts native host launches (workers.create and child launches), independently of receipts.
func (f *Fake) Hosts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.st.hostsLaunched
}

// Prompts counts native prompt submissions to this host, independently of receipts.
func (h *Host) Prompts() int {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return h.prompts
}

// DropNextPromptReply: the next prompt starts (agent_start) and its reply is lost (fixture host_reply drop).
func (h *Host) DropNextPromptReply() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.mode = "drop"
}

// HoldNextPromptReply: the next prompt starts and its reply waits until ReleaseHeldReply, which loses it
// (fixture host_reply hold, then drop_reply).
func (h *Host) HoldNextPromptReply() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.mode = "hold"
	h.held = make(chan struct{})
}

// ReleaseHeldReply loses the held reply.
func (h *Host) ReleaseHeldReply() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if h.held != nil {
		close(h.held)
		h.held = nil
	}
}

// AcceptNextImages: the next prompt with images reports n of them accepted (pi drops an image it cannot convert);
// by default pi accepts every image.
func (h *Host) AcceptNextImages(n int) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.accept = &n
}

// NextAgentStart is closed on this host's next native agent_start. Call it before the call that starts one.
func (h *Host) NextAgentStart() <-chan struct{} {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	ch := make(chan struct{})
	h.starts = append(h.starts, ch)
	return ch
}

// Emit injects a native event: "agent_start", "agent_settled" or "exit" (the host lifecycle event). An event of a
// host a restart retired is ignored, as the worker ignores a retired generation.
func (h *Host) Emit(eventType string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.emit(eventType)
}

func (h *Host) emit(eventType string) {
	if eventType == "agent_start" {
		for _, ch := range h.starts {
			close(ch)
		}
		h.starts = nil
	}
	if !h.live() {
		return
	}
	h.f.st.event(h.w, eventType)
}

// tailChars is the most assistant text one assistant.delta carries (activity.ts TAIL_CHARS), in UTF-16 code units.
const tailChars = 2048

// EmitText injects pi's text delta for the assistant message being streamed: text is the message's whole text so far
// (pi's partial message). It becomes assistant.delta with its tail and length, as activity.ts derives them.
func (h *Host) EmitText(text string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if h.live() {
		units := utf16.Encode([]rune(text))
		tail := units
		if len(units) > tailChars {
			tail = units[len(units)-tailChars:]
			if utf16.IsSurrogate(rune(tail[0])) && tail[0] >= 0xdc00 {
				tail = tail[1:]
			}
		}
		h.f.st.publish("assistant.delta", h.w.row.WorkerId, executionOf(h.w), "observed_memory", map[string]any{"tail": string(utf16.Decode(tail)), "length": len(units)})
	}
}

// EmitToolStart injects pi's tool_execution_start: tool.started with the call id, name and summary (nil for none).
func (h *Host) EmitToolStart(toolCallID, name string, summary *string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if h.live() {
		if h.tools == nil {
			h.tools = map[string]*string{}
		}
		h.tools[toolCallID] = summary
		h.f.st.publish("tool.started", h.w.row.WorkerId, executionOf(h.w), "observed_memory", map[string]any{"tool_call_id": toolCallID, "name": name, "summary": summary})
	}
}

// EmitToolEnd injects pi's tool_execution_end: tool.finished, repeating the summary its start carried.
func (h *Host) EmitToolEnd(toolCallID, name string, isError bool) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if h.live() {
		summary := h.tools[toolCallID]
		delete(h.tools, toolCallID)
		h.f.st.publish("tool.finished", h.w.row.WorkerId, executionOf(h.w), "observed_memory", map[string]any{"tool_call_id": toolCallID, "name": name, "summary": summary, "is_error": isError})
	}
}

// live: this host is its worker's current one (a retired generation's events are ignored).
func (h *Host) live() bool {
	return h.w != nil && h.f.st.workers[h.w.row.WorkerId] == h.w && h.w.host == h
}

// prompt is one native prompt submission with its images (f.mu held): it starts, then replies with the number of
// images pi put in the message, loses or holds its reply.
func (h *Host) prompt(images int) (int, error) {
	h.prompts++
	mode := h.mode
	h.mode = ""
	accepted := images
	if images > 0 && h.accept != nil {
		accepted = min(*h.accept, images)
		h.accept = nil
	}
	h.emit("agent_start")
	switch mode {
	case "drop":
		return 0, errDroppedReply
	case "hold":
		held := h.held
		h.f.mu.Unlock()
		select {
		case <-held:
		case <-h.f.closed:
		}
		h.f.mu.Lock()
		return 0, errDroppedReply
	}
	return accepted, nil
}

// Drain lets due queued input run to the next barrier. The fake dispatches due input as soon as it is due, so this
// only re-runs that check for every worker.
func (f *Fake) Drain() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range f.st.order {
		f.st.flush(f.st.workers[id])
	}
}

// Restart discards the supervisor's memory and recovers from its durable records: every stream ends, a new
// supervisor and transport epoch starts, no host is adopted (holding workers become cleanup_pending), unsettled
// executions and unknown session writes fence, and queued input is recovered.
func (f *Fake) Restart() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.st.restart()
}

// Disk returns a worker's latest durable record.
func (f *Fake) Disk(workerID string) (Worker, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.st.disk[workerID]
	return clone(row), ok
}
