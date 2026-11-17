package workerfake

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
)

// What the worker's SDK child and pi write into the session file for one prompt (sdk-child/main.ts, the `prompt`
// command), so the fake's history, previews and receipts show the worker-owned interrupt marker (S-5) as the worker
// writes it:
//
//   - the rule (afterAbortedTurn): the newest message on the session's path is an assistant turn that ended
//     `aborted`, no user message since, and the text starts a turn (not empty, not a `/` or `!` command);
//   - the `pi-worker.input` custom entry right before the user message: {command_id, execution_id, interrupt_marker,
//     display_text (the text the caller sent, only when marked)};
//   - the user message pi gets: the marker and a line feed in front of the text when marked, then the images pi
//     accepted;
//   - the receipt's result.interrupt_marker.
//
// An executions.cancel or executions.interrupt of a running execution makes pi write its aborted assistant turn
// (abortTurn), so the next prompt is marked; a test may also append such a turn with AppendHistory.

// inputStamp is the SDK child's custom entry type (sdk-child/main.ts INPUT_STAMP).
const inputStamp = "pi-worker.input"

// promptInput is one prompt as the supervisor sends it to the host.
type promptInput struct {
	commandID, executionID, text string
	attachments                  []string // staged attachment ids, in order
}

// afterAbortedTurn is sdk-child/main.ts afterAbortedTurn over the fake's session file (one linear path).
func afterAbortedTurn(data []byte, text string) bool {
	t := strings.TrimLeft(text, " \t\r\n")
	if t == "" || strings.HasPrefix(t, "/") || strings.HasPrefix(t, "!") {
		return false
	}
	lines := bytes.Split(data, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var e struct {
			Type    string `json:"type"`
			Message struct {
				Role       string `json:"role"`
				StopReason string `json:"stopReason"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &e) != nil || e.Type != "message" {
			continue
		}
		switch e.Message.Role {
		case "user":
			return false
		case "assistant":
			return e.Message.StopReason == "aborted"
		}
	}
	return false
}

// appendEntry appends one pi entry to the worker's session file, its id and parent filled in, and publishes the
// change. Nothing happens for a worker without a session file.
func (s *state) appendEntry(w *worker, entry map[string]any) {
	sf := s.sessions[derefString(w.row.SessionId)]
	if sf == nil {
		return
	}
	entry["id"] = s.id("entry")
	entry["parentId"] = sf.lastEntryID()
	entry["timestamp"] = now()
	line, _ := json.Marshal(entry)
	s.changeHistory(sf.id, func(sf *sessionFile) { sf.data = append(sf.data[:sf.watermark()], append(line, '\n')...) })
}

// writeStamp applies the interrupt rule and writes the input stamp; it returns whether the input is marked.
func (s *state) writeStamp(w *worker, in promptInput) bool {
	sf := s.sessions[derefString(w.row.SessionId)]
	if sf == nil {
		return false
	}
	marked := afterAbortedTurn(sf.data[:sf.watermark()], in.text)
	data := map[string]any{"command_id": in.commandID, "execution_id": in.executionID, "interrupt_marker": marked}
	if marked {
		data["display_text"] = in.text
	}
	s.appendEntry(w, map[string]any{"type": "custom", "customType": inputStamp, "data": data})
	return marked
}

// writeUserMessage writes the user message pi received: the delivered text, then the first accepted staged images.
func (s *state) writeUserMessage(w *worker, in promptInput, marked bool, accepted int) {
	text := in.text
	if marked {
		text = interruptMarker + "\n" + text
	}
	content := []any{map[string]any{"type": "text", "text": text}}
	for _, id := range in.attachments[:min(accepted, len(in.attachments))] {
		if a := s.attachments[id]; a != nil && a.data != nil {
			content = append(content, map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(a.data), "mimeType": string(a.status.ContentType)})
		}
	}
	s.appendEntry(w, map[string]any{"type": "message", "message": map[string]any{"role": "user", "content": content, "timestamp": time.Now().UnixMilli()}})
}

// abortTurn is pi's record of an aborted run: an assistant turn that ended `aborted` (sdk-child abort). Only a running
// execution on a live host has one to end, and only once: a later Stop before it settles ends nothing new.
func (s *state) abortTurn(w *worker) {
	e := w.row.Execution
	if w.host == nil || w.exited || w.row.Status != "ready" || e == nil || e.State == "settled" || e.State == "outcome_unknown" {
		return
	}
	if w.aborted == e.ExecutionId {
		return
	}
	w.aborted = e.ExecutionId
	model := map[string]any{"provider": "fixture", "model": "fixture"}
	if m := w.row.Model; m != nil {
		model = map[string]any{"provider": m.Provider, "model": m.Id}
	}
	s.appendEntry(w, map[string]any{"type": "message", "message": map[string]any{
		"role": "assistant", "content": []any{}, "provider": model["provider"], "model": model["model"], "stopReason": "aborted", "timestamp": time.Now().UnixMilli(),
	}})
}

// attachmentIDs lists a prompt's staged attachment ids in order.
func attachmentIDs(list *[]struct {
	AttachmentId string `json:"attachment_id"`
}) []string {
	if list == nil {
		return nil
	}
	ids := make([]string, 0, len(*list))
	for _, a := range *list {
		ids = append(ids, a.AttachmentId)
	}
	return ids
}
