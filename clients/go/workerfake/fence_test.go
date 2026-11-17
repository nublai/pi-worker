package workerfake_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func promptOf(w *b2.Worker, cmd string, ifBusy *b2.PromptIfBusy) b2.Prompt {
	return b2.Prompt{CommandId: cmd, WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision, Message: "go", IfBusy: ifBusy}
}

// Resolving by execution id names the command that admitted the execution, never a steer that joined it, as the
// worker's insertion-ordered receipts do (PR #16 GPT 3). Repeated, because a map-order choice is right by chance.
func TestResolveByExecutionNamesTheAdmittingCommandNotItsSteer(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	steer := b2.PromptIfBusy("steer")
	for i := 0; i < 40; i++ {
		w := newWorker(t, ctx, c, fmt.Sprintf("create-%d", i))
		p, err := c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, fmt.Sprintf("p-%d", i), nil))
		if err != nil {
			t.Fatal(err)
		}
		s, err := c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, fmt.Sprintf("steer-%d", i), &steer))
		if err != nil || *s.ExecutionId != *p.ExecutionId {
			t.Fatalf("steer %+v %v", s, err)
		}
		fake.Host(w.WorkerId).Emit("exit")
		row, _ := c.WorkersGet(ctx, w.WorkerId)
		if row.Fence == nil || row.Fence.CommandId != p.CommandId {
			t.Fatalf("fence %+v", row.Fence)
		}
		r, err := c.SessionsResolveUnknown(ctx, w.WorkerId, b2.Resolve{CommandId: fmt.Sprintf("resolve-%d", i), WorkerEpoch: row.WorkerEpoch, SessionId: *row.SessionId, BindingRevision: row.BindingRevision, ExecutionId: p.ExecutionId, FenceGeneration: row.Fence.FenceGeneration, Disposition: "keep"})
		if err != nil || (*r.Result)["command_id"] != p.CommandId {
			t.Fatalf("round %d: resolve by execution %+v %v", i, r, err)
		}
	}

	// observed: the settlement is attributed to the prompt that admitted the execution.
	for i := 0; i < 10; i++ {
		w := newWorker(t, ctx, c, fmt.Sprintf("create-observed-%d", i))
		host := fake.Host(w.WorkerId)
		host.HoldNextPromptReply()
		started := host.NextAgentStart()
		done := make(chan *b2.Receipt, 1)
		go func() {
			r, _ := c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, fmt.Sprintf("op-%d", i), nil))
			done <- r
		}()
		<-started
		s, err := c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, fmt.Sprintf("osteer-%d", i), &steer))
		if err != nil || s.ExecutionId == nil {
			t.Fatalf("steer %+v %v", s, err)
		}
		host.Emit("agent_settled")
		host.ReleaseHeldReply()
		if p := <-done; p == nil || p.State != "outcome_unknown" {
			t.Fatalf("held prompt %+v", p)
		}
		row, _ := c.WorkersGet(ctx, w.WorkerId)
		r, err := c.SessionsResolveUnknown(ctx, w.WorkerId, b2.Resolve{CommandId: fmt.Sprintf("oresolve-%d", i), WorkerEpoch: row.WorkerEpoch, SessionId: *row.SessionId, BindingRevision: row.BindingRevision, ExecutionId: s.ExecutionId, FenceGeneration: row.Fence.FenceGeneration, Disposition: "observed"})
		if err != nil || (*r.Result)["command_id"] != fmt.Sprintf("op-%d", i) {
			t.Fatalf("round %d: observed by execution %+v %v", i, r, err)
		}
	}
}
