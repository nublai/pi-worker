package workerfake_test

// The worker-owned interrupt marker (S-5, sdk-child/main.ts) as the fake writes it: after an interrupted execution
// the next prompt that starts a turn gets the marker and a line feed in front of its text in pi's user message, the
// pi-worker.input stamp before it records the command, the execution, interrupt_marker and the display text, and the
// receipt's result.interrupt_marker says it applied; previews strip it. Other prompts carry none.

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

const interruptMarker = "[The previous request was interrupted by the user before it finished.]"

// sessionEntries reads a session file's entries after its header.
func sessionEntries(t *testing.T, ctx context.Context, c *b2.Client, sid string) []map[string]any {
	t.Helper()
	page, err := c.SessionsHistory(ctx, sid, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(page.Body), []byte("\n"))[1:] {
		var e map[string]any
		if err := json.Unmarshal(line, &e); err != nil {
			t.Fatal(err)
		}
		out = append(out, e)
	}
	return out
}

func TestInterruptMarkerAsTheWorkerWritesIt(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId
	host := fake.Host(w.WorkerId)
	prompt := func(cmd, text string) (*b2.Receipt, map[string]any, map[string]any) {
		t.Helper()
		row, _ := c.WorkersGet(ctx, w.WorkerId)
		r, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: cmd, WorkerEpoch: row.WorkerEpoch, SessionId: sid, BindingRevision: row.BindingRevision, Message: text})
		if err != nil || r.State != "delivered" {
			t.Fatalf("%s: %+v %v", cmd, r, err)
		}
		entries := sessionEntries(t, ctx, c, sid)
		if len(entries) < 2 {
			t.Fatalf("%s: entries %v", cmd, entries)
		}
		return r, entries[len(entries)-2], entries[len(entries)-1]
	}
	check := func(cmd string, r *b2.Receipt, stamp, user map[string]any, text string, marked bool) {
		t.Helper()
		if got := (*r.Result)["interrupt_marker"]; got != marked {
			t.Errorf("%s: result.interrupt_marker %v, want %v", cmd, got, marked)
		}
		data, _ := stamp["data"].(map[string]any)
		want := map[string]any{"command_id": cmd, "execution_id": *r.ExecutionId, "interrupt_marker": marked}
		if marked {
			want["display_text"] = text
		}
		if stamp["type"] != "custom" || stamp["customType"] != "pi-worker.input" || mustJSON(t, data) != mustJSON(t, want) {
			t.Errorf("%s: stamp %v, want data %v", cmd, stamp, want)
		}
		delivered := text
		if marked {
			delivered = interruptMarker + "\n" + text
		}
		message, _ := user["message"].(map[string]any)
		content := []any{map[string]any{"type": "text", "text": delivered}}
		if user["type"] != "message" || message["role"] != "user" || mustJSON(t, message["content"]) != mustJSON(t, content) || user["parentId"] != stamp["id"] {
			t.Errorf("%s: user message %v, want text %q after the stamp", cmd, user, delivered)
		}
	}
	r, stamp, user := prompt("p-1", "fix the login form")
	check("p-1", r, stamp, user, "fix the login form", false)
	// The phone interrupts the running execution: pi aborts the turn.
	row, _ := c.WorkersGet(ctx, w.WorkerId)
	if _, err := c.ExecutionsInterrupt(ctx, w.WorkerId, b2.Control{CommandId: "stop-1", WorkerEpoch: row.WorkerEpoch, SessionId: sid, BindingRevision: row.BindingRevision, ExecutionId: r.ExecutionId}); err != nil {
		t.Fatal(err)
	}
	host.Emit("agent_settled")
	r, stamp, user = prompt("p-2", "use the new validator")
	check("p-2", r, stamp, user, "use the new validator", true)
	row, _ = c.WorkersGet(ctx, w.WorkerId)
	if row.Preview == nil || *row.Preview != "use the new validator" || row.FirstUserLine == nil || *row.FirstUserLine != "fix the login form" {
		t.Errorf("previews strip the marker: preview %v first line %v", row.Preview, row.FirstUserLine)
	}
	// A user message since the aborted turn: the next prompt is not marked.
	host.Emit("agent_settled")
	r, stamp, user = prompt("p-3", "thanks")
	check("p-3", r, stamp, user, "thanks", false)
}

// Repeated Stop before the execution settles: pi aborts the running turn once, so the session file holds one aborted
// assistant turn however many cancel or interrupt commands arrive; the execution stays running until it settles.
func TestRepeatedStopRecordsOneAbortedTurn(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId
	row, _ := c.WorkersGet(ctx, w.WorkerId)
	r, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "p-1", WorkerEpoch: row.WorkerEpoch, SessionId: sid, BindingRevision: row.BindingRevision, Message: "fix the login form"})
	if err != nil || r.State != "delivered" {
		t.Fatalf("p-1: %+v %v", r, err)
	}
	for _, cmd := range []string{"stop-1", "stop-2"} {
		row, _ = c.WorkersGet(ctx, w.WorkerId)
		if _, err := c.ExecutionsInterrupt(ctx, w.WorkerId, b2.Control{CommandId: cmd, WorkerEpoch: row.WorkerEpoch, SessionId: sid, BindingRevision: row.BindingRevision, ExecutionId: r.ExecutionId}); err != nil {
			t.Fatalf("%s: %v", cmd, err)
		}
	}
	row, _ = c.WorkersGet(ctx, w.WorkerId)
	if row.Execution == nil || row.Execution.State == "settled" {
		t.Errorf("a Stop does not settle the execution early: %+v", row.Execution)
	}
	aborted, users := 0, 0
	for _, e := range sessionEntries(t, ctx, c, sid) {
		message, _ := e["message"].(map[string]any)
		switch {
		case e["type"] == "message" && message["role"] == "assistant" && message["stopReason"] == "aborted":
			aborted++
		case e["type"] == "message" && message["role"] == "user":
			users++
		}
	}
	if aborted != 1 || users != 1 {
		t.Errorf("two Stops for one execution: %d aborted assistant turns and %d user messages, want 1 and 1", aborted, users)
	}
}
