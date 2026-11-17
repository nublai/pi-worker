package workerfake

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// A later uncertainty joins the fence without restamping fenced_at, as the worker's latch does (PR #22 GPT 1).
func TestLatchKeepsFencedAtForALaterUncertainty(t *testing.T) {
	w := &worker{row: b2.Worker{}}
	latch(w, "first")
	stamp := w.row.Fence.FencedAt
	if stamp == "" {
		t.Fatal("the first latch stamps fenced_at")
	}
	latch(w, "second")
	f := w.row.Fence
	if f.FencedAt != stamp || f.FenceGeneration != 2 || len(uncertainIDs(f)) != 2 {
		t.Fatalf("later uncertainty: %+v (stamp %s)", f, stamp)
	}
	latch(w, "second")
	if w.row.Fence.FencedAt != stamp || w.row.Fence.FenceGeneration != 2 {
		t.Fatalf("a repeated uncertainty changed the fence: %+v", w.row.Fence)
	}
}

// A partial resolve_unknown copies the prior stamp into the remaining fence, and a restart keeps it (PR #22 GPT 1).
func TestPartialResolveKeepsFencedAt(t *testing.T) {
	fake, err := Start(Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	cr, err := c.WorkersCreate(ctx, b2.Create{CommandId: "create", Cwd: filepath.Join(t.TempDir(), "w"), Provider: "fixture", Model: "fixture", Thinking: "off"})
	if err != nil {
		t.Fatal(err)
	}
	id := *cr.WorkerId
	w, _ := c.WorkersGet(ctx, id)
	fake.Host(id).DropNextPromptReply()
	bind := func(cmd string) b2.Binding {
		return b2.Binding{CommandId: cmd, WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision}
	}
	if p, err := c.SessionsPrompt(ctx, id, b2.Prompt{CommandId: "lost", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision, Message: "go"}); err != nil || p.State != "outcome_unknown" {
		t.Fatalf("prompt %+v %v", p, err)
	}
	first, _ := c.WorkersGet(ctx, id)
	stamp := first.Fence.FencedAt
	// A second uncertainty joins the fence.
	fake.mu.Lock()
	latch(fake.st.workers[id], "second")
	fake.mu.Unlock()
	time.Sleep(2 * time.Millisecond)
	row, _ := c.WorkersGet(ctx, id)
	if row.Fence.FencedAt != stamp || row.Fence.FenceGeneration != 2 {
		t.Fatalf("later uncertainty: %+v", row.Fence)
	}
	b := bind("resolve-lost")
	r, err := c.SessionsResolveUnknown(ctx, id, b2.Resolve{CommandId: b.CommandId, WorkerEpoch: b.WorkerEpoch, SessionId: b.SessionId, BindingRevision: b.BindingRevision, UncertainCommandId: ptr("lost"), FenceGeneration: 2, Disposition: "abandon"})
	if err != nil || r.State != "delivered" {
		t.Fatalf("resolve %+v %v", r, err)
	}
	row, _ = c.WorkersGet(ctx, id)
	if row.Fence == nil || row.Fence.CommandId != "second" || row.Fence.FencedAt != stamp {
		t.Fatalf("remaining fence %+v, want fenced_at %s", row.Fence, stamp)
	}
	if got := (*r.Result)["fence"].(map[string]any)["fenced_at"]; got != stamp {
		t.Fatalf("resolution result fenced_at %v, want %s", got, stamp)
	}
	fake.Restart()
	row, _ = c.WorkersGet(ctx, id)
	if row.Fence == nil || row.Fence.FencedAt != stamp {
		t.Fatalf("after restart %+v, want fenced_at %s", row.Fence, stamp)
	}
}
