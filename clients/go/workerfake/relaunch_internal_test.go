package workerfake

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// refused reports whether err is the B2 refusal name with effect no_effect.
func refused(err error, name string) bool {
	var f *b2.ClientFailure
	return errors.As(err, &f) && f.Status == http.StatusConflict && f.Body != nil && f.Body.Error == name && f.Body.Effect == b2.NoEffect
}

func bindOf(w *b2.Worker, cmd string) b2.Binding {
	return b2.Binding{CommandId: cmd, WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision}
}

// workers.relaunch through the Go client, as lifecycle.ts relaunch answers it (P2-3): refused no_effect with its
// typed reason while the worker is live, the binding stale, the session fenced, or another worker holds the cwd or
// the session; after a confirmed stop a fresh host at a new epoch on the same session, without a prompt.
func TestRelaunchRefusalsAndANewEpochOnTheSameSession(t *testing.T) {
	fake, err := Start(Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	cwd := filepath.Join(t.TempDir(), "w")
	cr, err := c.WorkersCreate(ctx, b2.Create{CommandId: "create", Cwd: cwd, Provider: "fixture", Model: "fixture", Thinking: "off"})
	if err != nil {
		t.Fatal(err)
	}
	id := *cr.WorkerId
	w, _ := c.WorkersGet(ctx, id)
	if _, err := c.WorkersRelaunch(ctx, id, bindOf(w, "live")); !refused(err, "cleanup_pending_or_cleanup_unproven") {
		t.Fatalf("relaunch of a live worker: %v", err)
	}
	if _, err := c.WorkersStop(ctx, id, bindOf(w, "stop")); err != nil {
		t.Fatal(err)
	}
	stale := bindOf(w, "stale")
	stale.BindingRevision = 2
	if _, err := c.WorkersRelaunch(ctx, id, stale); !refused(err, "stale_binding") {
		t.Fatalf("stale relaunch: %v", err)
	}
	// Another worker in the same cwd holds the environment.
	other, err := c.WorkersCreate(ctx, b2.Create{CommandId: "other", Cwd: cwd, Provider: "fixture", Model: "fixture", Thinking: "off"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.WorkersRelaunch(ctx, id, bindOf(w, "cwd-held")); !refused(err, "exclusive_environment_already_bound") {
		t.Fatalf("relaunch with the cwd held: %v", err)
	}
	ow, _ := c.WorkersGet(ctx, *other.WorkerId)
	if _, err := c.WorkersStop(ctx, ow.WorkerId, bindOf(ow, "stop-other")); err != nil {
		t.Fatal(err)
	}
	// Another worker resumes the session: it holds it.
	resumer, err := c.WorkersCreate(ctx, b2.Create{CommandId: "resumer", Cwd: filepath.Join(t.TempDir(), "r"), Provider: "fixture", Model: "fixture", Thinking: "off", ResumeSessionId: w.SessionId})
	if err != nil || resumer.State != "delivered" {
		t.Fatalf("resume %+v %v", resumer, err)
	}
	if _, err := c.WorkersRelaunch(ctx, id, bindOf(w, "session-held")); !refused(err, "session_already_bound") {
		t.Fatalf("relaunch with the session held: %v", err)
	}
	rw, _ := c.WorkersGet(ctx, *resumer.WorkerId)
	if _, err := c.WorkersStop(ctx, rw.WorkerId, bindOf(rw, "stop-resumer")); err != nil {
		t.Fatal(err)
	}
	hosts := fake.Hosts()
	r, err := c.WorkersRelaunch(ctx, id, bindOf(w, "relaunch"))
	if err != nil || r.State != "delivered" {
		t.Fatalf("relaunch %+v %v", r, err)
	}
	fresh, _ := c.WorkersGet(ctx, id)
	if fresh.WorkerEpoch == w.WorkerEpoch || *fresh.SessionId != *w.SessionId || fresh.Status != "ready" || fresh.BindingRevision != w.BindingRevision {
		t.Fatalf("relaunched row %+v", fresh)
	}
	if (*r.Result)["worker_epoch"] != fresh.WorkerEpoch || fake.Hosts() != hosts+1 || fake.CurrentHost(id) == fake.Host(id) || fake.CurrentHost(id).Prompts() != 0 {
		t.Fatalf("relaunch result %+v hosts %d", *r.Result, fake.Hosts())
	}
	if _, err := c.SessionsPrompt(ctx, id, b2.Prompt{CommandId: "old-binding", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision, Message: "go"}); !refused(err, "stale_binding") {
		t.Fatalf("prompt on the old epoch: %v", err)
	}
	// A prompt whose reply is lost, then a stop: the session is fenced and no relaunch passes until it is resolved.
	fake.CurrentHost(id).DropNextPromptReply()
	if p, err := c.SessionsPrompt(ctx, id, b2.Prompt{CommandId: "lost", WorkerEpoch: fresh.WorkerEpoch, SessionId: *fresh.SessionId, BindingRevision: fresh.BindingRevision, Message: "go"}); err != nil || p.State != "outcome_unknown" {
		t.Fatalf("lost prompt %+v %v", p, err)
	}
	if _, err := c.WorkersStop(ctx, id, bindOf(fresh, "stop-fenced")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.WorkersRelaunch(ctx, id, bindOf(fresh, "fenced")); !refused(err, "session_fenced") {
		t.Fatalf("relaunch under a fence: %v", err)
	}
}

// After a restart that cannot confirm cleanup (the unconfirmed profile) the worker is cleanup_pending and relaunch
// is refused; with the default profile the restart confirms it and relaunch runs.
func TestRelaunchAfterRestartNeedsConfirmedCleanup(t *testing.T) {
	for _, profile := range []string{"", ProfileUnconfirmedNativeIdentity} {
		fake, err := Start(Options{Profile: profile})
		if err != nil {
			t.Fatal(err)
		}
		ctx := context.Background()
		c := fake.Client()
		cr, err := c.WorkersCreate(ctx, b2.Create{CommandId: "create", Cwd: filepath.Join(t.TempDir(), "w"), Provider: "fixture", Model: "fixture", Thinking: "off"})
		if err != nil {
			t.Fatal(err)
		}
		w, _ := c.WorkersGet(ctx, *cr.WorkerId)
		fake.Restart()
		r, err := c.WorkersRelaunch(ctx, w.WorkerId, bindOf(w, "relaunch"))
		if profile == "" && (err != nil || r.State != "delivered") {
			t.Fatalf("default profile: %+v %v", r, err)
		}
		if profile != "" && !refused(err, "cleanup_pending_or_cleanup_unproven") {
			t.Fatalf("unconfirmed profile: %v", err)
		}
		fake.Close()
	}
}

// An owner-kept recovered prompt intent dispatches once on the first relaunched epoch with the binding it was
// admitted with; an ordinary stale write, a move or a second relaunch refuse it (input.ts keptAcrossRelaunch).
func TestOwnerKeptPromptDispatchesOnceOnTheRelaunchedEpoch(t *testing.T) {
	for _, after := range []string{"none", "new", "second-relaunch"} {
		fake, err := Start(Options{})
		if err != nil {
			t.Fatal(err)
		}
		ctx := context.Background()
		c := fake.Client()
		cr, err := c.WorkersCreate(ctx, b2.Create{CommandId: "create", Cwd: filepath.Join(t.TempDir(), "w"), Provider: "fixture", Model: "fixture", Thinking: "off"})
		if err != nil {
			t.Fatal(err)
		}
		id := *cr.WorkerId
		w, _ := c.WorkersGet(ctx, id)
		p := b2.Prompt{CommandId: "kept", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision, Message: "ONCE"}
		// The prompt's intent is recorded, then the supervisor restarts before its dispatch record.
		fake.mu.Lock()
		s := fake.st
		s.receipts["kept"] = &storedReceipt{hash: requestHash("sessions.prompt", map[string]any{"body": p, "worker_id": id}), Receipt: b2.Receipt{
			CommandId: "kept", Operation: "sessions.prompt", RequestHash: "h", State: stIntent, Stage: "reserved", Effect: "no_effect",
			Evidence: "supervisor_journal_fsynced", CreatedAt: now(), WorkerId: ptr(id),
		}}
		s.receiptOrder = append(s.receiptOrder, "kept")
		fake.mu.Unlock()
		fake.Restart()
		w, _ = c.WorkersGet(ctx, id)
		b := bindOf(w, "keep")
		if _, err := c.SessionsResolveUnknown(ctx, id, b2.Resolve{CommandId: b.CommandId, WorkerEpoch: b.WorkerEpoch, SessionId: b.SessionId, BindingRevision: b.BindingRevision, UncertainCommandId: ptr("kept"), FenceGeneration: 0, Disposition: "keep"}); err != nil {
			t.Fatal(err)
		}
		if r, err := c.WorkersRelaunch(ctx, id, bindOf(w, "relaunch")); err != nil || r.State != "delivered" {
			t.Fatalf("relaunch %+v %v", r, err)
		}
		fresh, _ := c.WorkersGet(ctx, id)
		if _, err := c.SessionsPrompt(ctx, id, b2.Prompt{CommandId: "ordinary", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision, Message: "x"}); !refused(err, "stale_binding") {
			t.Fatalf("%s: ordinary stale prompt: %v", after, err)
		}
		switch after {
		case "new":
			nb := bindOf(fresh, "move")
			if _, err := c.SessionsNew(ctx, id, nb); err != nil {
				t.Fatal(err)
			}
		case "second-relaunch":
			if _, err := c.WorkersStop(ctx, id, bindOf(fresh, "stop")); err != nil {
				t.Fatal(err)
			}
			if r, err := c.WorkersRelaunch(ctx, id, bindOf(fresh, "relaunch-2")); err != nil || r.State != "delivered" {
				t.Fatalf("second relaunch %+v %v", r, err)
			}
		}
		got, err := c.SessionsPrompt(ctx, id, p)
		if after != "none" {
			if !refused(err, "stale_binding") || fake.CurrentHost(id).Prompts() != 0 {
				t.Fatalf("%s: kept prompt after it: %v", after, err)
			}
			fake.Close()
			continue
		}
		if err != nil || got.State != "delivered" || fake.CurrentHost(id).Prompts() != 1 || fake.Host(id).Prompts() != 0 {
			t.Fatalf("kept prompt %+v %v prompts %d", got, err, fake.CurrentHost(id).Prompts())
		}
		again, err := c.SessionsPrompt(ctx, id, p)
		if err != nil || again.State != got.State || *again.ExecutionId != *got.ExecutionId || fake.CurrentHost(id).Prompts() != 1 {
			t.Fatalf("duplicate %+v %v", again, err)
		}
		fake.Close()
	}
}
