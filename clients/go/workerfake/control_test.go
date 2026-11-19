package workerfake_test

// executions.cancel and executions.interrupt naming an execution that already settled (pi-worker #49), as the worker
// answers them (input.ts control): refused no_running_execution before any record, nothing aborted.

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func TestControlOfASettledExecutionIsRefusedWithNoRecord(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{Methods: workerfake.AllMethods()})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId
	host := fake.Host(w.WorkerId)
	r, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "p-1", WorkerEpoch: w.WorkerEpoch, SessionId: sid, BindingRevision: w.BindingRevision, Message: "run"})
	if err != nil || r.State != "delivered" || r.ExecutionId == nil {
		t.Fatalf("p-1: state or execution missing (err %v)", err)
	}
	host.Emit("agent_settled")
	entries := len(sessionEntries(t, ctx, c, sid))
	calls := map[string]func(context.Context, string, b2.Control) (*b2.Receipt, error){
		"executions.cancel":    c.ExecutionsCancel,
		"executions.interrupt": c.ExecutionsInterrupt,
	}
	for op, call := range calls {
		cmd := "late-" + op
		_, err := call(ctx, w.WorkerId, b2.Control{CommandId: cmd, WorkerEpoch: w.WorkerEpoch, SessionId: sid, BindingRevision: w.BindingRevision, ExecutionId: r.ExecutionId})
		if !isRefusal(err, http.StatusConflict, "no_running_execution") {
			t.Errorf("%s of a settled execution: want no_running_execution, got %v", op, err)
		}
		if _, err := c.ReceiptsGet(ctx, cmd); !isRefusal(err, http.StatusConflict, "unknown_command_id_is_not_proof_of_no_effect") {
			t.Errorf("%s: a refusal records no receipt (got %v)", op, err)
		}
	}
	if got := len(sessionEntries(t, ctx, c, sid)); got != entries {
		t.Errorf("a refused Stop writes nothing to the session: %d entries, want %d", got, entries)
	}
	// Without an execution id the request keeps its old behaviour: it is accepted and reports the settled execution.
	row, err := c.WorkersGet(ctx, w.WorkerId)
	if err != nil {
		t.Fatal(err)
	}
	bare, err := c.ExecutionsInterrupt(ctx, w.WorkerId, b2.Control{CommandId: "bare", WorkerEpoch: row.WorkerEpoch, SessionId: sid, BindingRevision: row.BindingRevision})
	if err != nil || bare.State != "delivered" || bare.Result == nil || (*bare.Result)["disposition"] != "settled" {
		t.Errorf("interrupt without an execution id: want delivered and settled (err %v)", err)
	}
}
