package workerfake_test

// A driver's journey over the bridge profile against the stateful fake: the operations the section 0.1 rows do not
// reach (interactions, session writes, sessions.new, interrupt, stop, receipts), through the Go client.

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func TestBridgeJourneyAgainstTheStatefulFake(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	hello, err := c.Hello(ctx)
	if err != nil || hello.Limits.AttachmentMaxBytes != int(b2.OpAttachmentsStage.MaxBodyBytes) {
		t.Fatalf("hello %+v %v", hello, err)
	}
	w := newWorker(t, ctx, c, "create-1")
	if w.Status != "ready" || w.Foreground != "idle" || w.BindingRevision != 1 || *w.Lineage != "root" {
		t.Fatalf("new worker %+v", w)
	}
	events := startWatch(t, c, b2.WatchOptions{WorkerIDs: []string{w.WorkerId}})
	if hello.SupervisorEpoch != snapshotOf(t, events.next(t)).Cursor.TransportEpoch {
		t.Fatal("the transport epoch is the supervisor epoch")
	}

	// The same cwd is exclusive while a worker holds it.
	if _, err := c.WorkersCreate(ctx, b2.Create{CommandId: "create-2", Cwd: w.Cwd, Provider: "p", Model: "m", Thinking: "off"}); !isRefusal(err, http.StatusConflict, "exclusive_environment_already_bound") {
		t.Fatalf("same cwd: %v", err)
	}

	// A prompt runs until pi settles it; a session write meanwhile is busy.
	host := fake.Host(w.WorkerId)
	r, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "p-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Message: "hi"})
	if err != nil || r.State != "delivered" || r.ExecutionId == nil {
		t.Fatalf("prompt %+v %v", r, err)
	}
	if _, err := c.SessionsCompact(ctx, w.WorkerId, b2.Compact{CommandId: "compact-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1}); !isRefusal(err, http.StatusConflict, "worker_busy") {
		t.Fatalf("compact while running: %v", err)
	}
	// A duplicate command id returns the stored receipt; another request under it is a conflict.
	again, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "p-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Message: "hi"})
	if err != nil || *again.ExecutionId != *r.ExecutionId || host.Prompts() != 1 {
		t.Fatalf("duplicate %+v %v (prompts %d)", again, err, host.Prompts())
	}
	if _, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "p-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Message: "other"}); !isRefusal(err, http.StatusConflict, "command_id_conflict") {
		t.Fatalf("conflict: %v", err)
	}
	// Interrupt is requested; the fixture host settles only when told.
	ir, err := c.ExecutionsInterrupt(ctx, w.WorkerId, b2.Control{CommandId: "stop-run", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1})
	if err != nil || (*ir.Result)["requested"] != true {
		t.Fatalf("interrupt %+v %v", ir, err)
	}
	host.Emit("agent_settled")
	settled := false
	for !settled {
		f := events.next(t)
		e, ok := f.Event.(*b2.ExecutionSettledEvent)
		settled = ok && e.ExecutionId == *r.ExecutionId
	}

	// A dialog is answered once, at its current revision.
	in, err := fake.OpenInteraction(w.WorkerId, b2.Interaction{Kind: "select", Title: ptr("Pick one"), Options: &[]b2.InteractionOption{{Label: "A"}}})
	if err != nil {
		t.Fatal(err)
	}
	list, err := c.InteractionsList(ctx, w.WorkerId)
	if err != nil || len(list) != 1 || list[0].InteractionId != in.InteractionId {
		t.Fatalf("list %+v %v", list, err)
	}
	answer := b2.Answer{CommandId: "ans-cmd-1", AnswerId: "ans-1", InteractionId: in.InteractionId, Revision: in.Revision, Kind: "select", Outcome: "answer", OptionId: ptr("0"), WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Actor: ptr("device-1")}
	stale := answer
	stale.CommandId, stale.Revision = "ans-cmd-0", in.Revision+1
	if _, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, stale); !isRefusal(err, http.StatusConflict, "stale_interaction") {
		t.Fatalf("stale revision: %v", err)
	}
	ar, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, answer)
	if err != nil || ar.AnswerStage == nil || *ar.AnswerStage != 3 {
		t.Fatalf("answer %+v %v", ar, err)
	}
	st, err := c.InteractionsStatus(ctx, w.WorkerId, b2.InteractionsStatusParams{InteractionId: in.InteractionId})
	if err != nil || st.Status != "consumed" || *st.AnswerCommandId != "ans-cmd-1" {
		t.Fatalf("status %+v %v", st, err)
	}

	// Configure changes the row; sessions.new moves the binding and stales the old one.
	if _, err := c.SessionConfigure(ctx, w.WorkerId, b2.Configure{CommandId: "cfg-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Thinking: ptr(b2.Thinking("high"))}); err != nil {
		t.Fatal(err)
	}
	nr, err := c.SessionsNew(ctx, w.WorkerId, bindingOf(w, "new-1"))
	if err != nil || (*nr.Result)["binding_revision"] != float64(2) {
		t.Fatalf("new %+v %v", nr, err)
	}
	_, err = c.ResourcesReload(ctx, w.WorkerId, bindingOf(w, "reload-1"))
	if f := asFailure(t, err); f.Body == nil || f.Body.Error != "stale_binding" || *f.Body.ExpectedBindingRevision != 2 || f.Effect != b2.NoEffect {
		t.Fatalf("stale reload: %v", err)
	}
	now, err := c.WorkersGet(ctx, w.WorkerId)
	if err != nil || *now.Thinking != "high" || now.BindingRevision != 2 || *now.SessionId == *w.SessionId {
		t.Fatalf("row %+v %v", now, err)
	}
	if _, err := c.CommandsInvoke(ctx, w.WorkerId, b2.Invoke{CommandId: "inv-1", WorkerEpoch: now.WorkerEpoch, SessionId: *now.SessionId, BindingRevision: 2, Name: "hello"}); err != nil {
		t.Fatalf("invoke: %v", err)
	}

	// Readbacks: a receipt by command id; an unknown one is never proof of no effect.
	if rc, err := c.ReceiptsGet(ctx, "new-1"); err != nil || rc.State != "delivered" {
		t.Fatalf("receipt %+v %v", rc, err)
	}
	if _, err := c.ReceiptsGet(ctx, "never"); asFailure(t, err).Effect != b2.UnknownEffect {
		t.Fatalf("unknown receipt: %v", err)
	}
	// Reads the fake does not model answer from the wire fixtures.
	models, err := c.ModelsList(ctx, &b2.ModelsListParams{WorkerId: &w.WorkerId})
	if err != nil || len(models.Models) == 0 {
		t.Fatalf("models %+v %v", models, err)
	}

	// Stop keeps the session; the row is stopped and the cwd is free again.
	sr, err := c.WorkersStop(ctx, w.WorkerId, bindingOf(now, "stop-1"))
	if err != nil || sr.Result == nil || *sr.Result.Termination != "observed_stopped" {
		t.Fatalf("stop %+v %v", sr, err)
	}
	stopped, _ := c.WorkersGet(ctx, w.WorkerId)
	raw, _ := json.Marshal(stopped)
	if stopped.Status != "stopped" {
		t.Fatalf("stopped row %s", raw)
	}
	if r, err := c.WorkersCreate(ctx, b2.Create{CommandId: "create-3", Cwd: w.Cwd, Provider: "p", Model: "m", Thinking: "off"}); err != nil || *r.WorkerId == w.WorkerId {
		t.Fatalf("create in the freed cwd: %+v %v", r, err)
	}
}
