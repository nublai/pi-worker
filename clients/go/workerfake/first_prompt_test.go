package workerfake_test

// workers.create with first_prompt (input.ts first): one command and one receipt, the first execution's admission
// or its typed refusal with the worker still created, and an uncertain create reconciled through receipts.get with
// pi prompted once. Each receipt has the fields of its wire fixture.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func firstPromptCreate(t *testing.T, cmd string, fp *b2.FirstPrompt) b2.Create {
	return b2.Create{CommandId: cmd, Cwd: filepath.Join(t.TempDir(), cmd), Provider: "fixture", Model: "fixture", Thinking: "off", FirstPrompt: fp}
}

// sameFields fails unless the receipt has exactly the top-level and result fields of the named wire fixture's reply.
func sameFields(t *testing.T, r *b2.Receipt, fixture string) {
	t.Helper()
	keys := func(raw []byte) ([]string, []string) {
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		var top, result []string
		for k, v := range m {
			if v != nil {
				top = append(top, k)
			}
		}
		if res, ok := m["result"].(map[string]any); ok {
			for k := range res {
				result = append(result, k)
			}
		}
		slices.Sort(top)
		slices.Sort(result)
		return top, result
	}
	for _, fx := range workerfake.WireFixtures("workers.create") {
		if fx.Name != fixture {
			continue
		}
		got, _ := json.Marshal(r)
		gotTop, gotResult := keys(got)
		wantTop, wantResult := keys(fx.Response.Body)
		if !slices.Equal(gotTop, wantTop) || !slices.Equal(gotResult, wantResult) {
			t.Fatalf("receipt fields %v %v, the %s fixture has %v %v", gotTop, gotResult, fixture, wantTop, wantResult)
		}
		return
	}
	t.Fatalf("no workers.create wire fixture %s", fixture)
}

func TestCreateWithFirstPromptAdmitsTheFirstExecution(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	r, err := c.WorkersCreate(ctx, firstPromptCreate(t, "chat-1", &b2.FirstPrompt{Message: "hello"}))
	if err != nil || r.State != "delivered" || r.Admission == nil || *r.Admission != "accepted" || r.ExecutionId == nil || r.Disposition == nil || *r.Disposition != "started" {
		t.Fatalf("create %+v %v", r, err)
	}
	sameFields(t, r, "first-prompt")
	w, err := c.WorkersGet(ctx, *r.WorkerId)
	if err != nil || w.Execution == nil || w.Execution.ExecutionId != *r.ExecutionId || w.Execution.CommandId != "chat-1" || w.Status != "ready" {
		t.Fatalf("worker %+v %v", w, err)
	}
	if (*r.Result)["worker_epoch"] != w.WorkerEpoch || (*r.Result)["session_id"] != *w.SessionId {
		t.Fatalf("result %+v", *r.Result)
	}
	if n := fake.Host(w.WorkerId).Prompts(); n != 1 {
		t.Fatalf("prompts %d", n)
	}
	fake.Host(w.WorkerId).Emit("agent_settled")
	w, _ = c.WorkersGet(ctx, w.WorkerId)
	if s := *w.RecentSettlements; len(s) != 1 || s[0].CommandId != "chat-1" || s[0].ExecutionId != *r.ExecutionId {
		t.Fatalf("settlements %+v", s)
	}
}

func TestCreateWithFirstPromptRefusedAtAdmissionStillCreatesTheWorker(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	cases := []struct {
		cmd   string
		fp    b2.FirstPrompt
		error string
	}{
		{"slash-chat", b2.FirstPrompt{Message: "/compact"}, "slash_commands_use_typed_methods"},
	}
	for _, tc := range cases {
		r, err := c.WorkersCreate(ctx, firstPromptCreate(t, tc.cmd, &tc.fp))
		if err != nil || r.State != "delivered" || r.Effect != "observed" || r.Admission == nil || *r.Admission != "rejected" || r.Error == nil || *r.Error != tc.error || r.ExecutionId != nil {
			t.Fatalf("%s: %+v %v", tc.cmd, r, err)
		}
		sameFields(t, r, "first-prompt-refused")
		w, err := c.WorkersGet(ctx, *r.WorkerId)
		if err != nil || w.Status != "ready" || w.Foreground != "idle" || w.Execution != nil || w.Fence != nil {
			t.Fatalf("%s: worker %+v %v", tc.cmd, w, err)
		}
		if n := fake.Host(w.WorkerId).Prompts(); n != 0 {
			t.Fatalf("%s: prompts %d", tc.cmd, n)
		}
		// The caller keeps the draft and sends it as an ordinary prompt.
		p, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: tc.cmd + "-again", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Message: "look again"})
		if err != nil || p.State != "delivered" {
			t.Fatalf("%s: prompt %+v %v", tc.cmd, p, err)
		}
	}
}

func TestUncertainCreateWithFirstPromptReconcilesThroughReceiptsAndPromptsOnce(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c := fake.Client()
	create := firstPromptCreate(t, "lost-chat", &b2.FirstPrompt{Message: "hello"})
	// pi holds the first prompt's reply; the caller gives up after the write: the outcome is unknown.
	fake.HoldFirstPromptReply()
	_, err = fake.Client(b2.WithTimeout(300*time.Millisecond)).WorkersCreate(ctx, create)
	var failure *b2.ClientFailure
	if !errors.As(err, &failure) || failure.Effect != b2.UnknownEffect {
		t.Fatalf("held create: %v", err)
	}
	// The receipt names the worker and the execution before pi answered.
	r, err := c.ReceiptsGet(ctx, "lost-chat")
	if err != nil || r.State != "accepted" || r.WorkerId == nil || r.ExecutionId == nil {
		t.Fatalf("receipt while held %+v %v", r, err)
	}
	// A duplicate create returns the receipt; nothing is created or sent twice.
	if again, err := c.WorkersCreate(ctx, create); err != nil || *again.ExecutionId != *r.ExecutionId {
		t.Fatalf("duplicate while held %+v %v", again, err)
	}
	host := fake.Host(*r.WorkerId)
	host.ReleaseHeldReply()
	var final *b2.Receipt
	for final == nil || final.State == "accepted" {
		if ctx.Err() != nil {
			t.Fatal("the receipt never became final")
		}
		time.Sleep(10 * time.Millisecond)
		if final, err = c.ReceiptsGet(ctx, "lost-chat"); err != nil {
			t.Fatal(err)
		}
	}
	// The reply was lost: outcome_unknown, still naming the worker and the execution, and the session is fenced on it.
	if final.State != "outcome_unknown" || *final.WorkerId != *r.WorkerId || *final.ExecutionId != *r.ExecutionId {
		t.Fatalf("final %+v", final)
	}
	if again, err := c.WorkersCreate(ctx, create); err != nil || again.State != "outcome_unknown" {
		t.Fatalf("duplicate after %+v %v", again, err)
	}
	if fake.Hosts() != 1 || host.Prompts() != 1 {
		t.Fatalf("hosts %d prompts %d", fake.Hosts(), host.Prompts())
	}
	w, err := c.WorkersGet(ctx, *r.WorkerId)
	if err != nil || w.Fence == nil || w.Fence.CommandId != "lost-chat" {
		t.Fatalf("fence %+v %v", w, err)
	}
	// pi settles it later; a restart keeps the create's fence until the owner resolves it.
	host.Emit("agent_settled")
	fake.Restart()
	w, err = c.WorkersGet(ctx, *r.WorkerId)
	if err != nil || w.Fence == nil || w.Fence.CommandId != "lost-chat" {
		t.Fatalf("fence after restart %+v %v", w, err)
	}
}

func TestCreateWithFirstPromptWhosePiReplyIsLostIsUnknownAndFenced(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	fake.DropFirstPromptReply()
	r, err := c.WorkersCreate(ctx, firstPromptCreate(t, "drop-chat", &b2.FirstPrompt{Message: "hello"}))
	if err != nil || r.State != "outcome_unknown" || r.WorkerId == nil || r.ExecutionId == nil || r.Result == nil {
		t.Fatalf("create %+v %v", r, err)
	}
	w, err := c.WorkersGet(ctx, *r.WorkerId)
	if err != nil || w.Status != "ready" || w.Fence == nil || w.Fence.CommandId != "drop-chat" || w.Execution.State != "outcome_unknown" {
		t.Fatalf("worker %+v %v", w, err)
	}
}

// A first prompt is a prompt (b2/app.ts): a grant that may create workers or launch children but not call
// sessions.prompt is refused grant_method_denied/no_effect before any worker, host or receipt, for a direct create
// and for a child launch's create (PR #20 GPT 2).
func TestFirstPromptNeedsTheSessionsPromptGrant(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{Methods: []string{"workers.create", "workers.get", "receipts.get", "children.launch"}})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	_, err = c.WorkersCreate(ctx, firstPromptCreate(t, "creator-chat", &b2.FirstPrompt{Message: "hello"}))
	if !isRefusal(err, http.StatusConflict, "grant_method_denied") {
		t.Fatalf("create with a first prompt: %v", err)
	}
	if n := fake.Hosts(); n != 0 {
		t.Fatalf("a refused create launched %d hosts", n)
	}
	if _, err := c.ReceiptsGet(ctx, "creator-chat"); err == nil {
		t.Fatal("a refused create has a receipt")
	}
	// The same grant creates a worker without one.
	parent, err := c.WorkersCreate(ctx, firstPromptCreate(t, "creator-plain", nil))
	if err != nil || parent.State != "delivered" {
		t.Fatalf("plain create %+v %v", parent, err)
	}
	w, err := c.WorkersGet(ctx, *parent.WorkerId)
	if err != nil {
		t.Fatal(err)
	}
	// A child launch carries a create too: its first prompt needs sessions.prompt as well, checked first.
	launch := b2.ChildLaunch{CommandId: "child-chat", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision, ExecutionId: "x", Launch: firstPromptCreate(t, "child-create", &b2.FirstPrompt{Message: "hello"})}
	if _, err := c.ChildrenLaunch(ctx, w.WorkerId, launch); !isRefusal(err, http.StatusConflict, "grant_method_denied") {
		t.Fatalf("child launch with a first prompt: %v", err)
	}
	if _, err := c.ReceiptsGet(ctx, "child-chat"); err == nil {
		t.Fatal("a refused child launch has a receipt")
	}
	if n := fake.Hosts(); n != 1 {
		t.Fatalf("hosts %d, want the parent only", n)
	}
}

// A first prompt is text only (nubl decision 2026-11-17): one that names attachments is outside the schema and the
// create is refused before anything exists (P1-19 follow-up 4).
func TestFirstPromptIsTextOnly(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	grant, err := os.ReadFile(fake.GrantFile())
	if err != nil {
		t.Fatal(err)
	}
	var g struct{ Token string }
	json.Unmarshal(grant, &g)
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", fake.SocketPath())
	}}}
	body := fmt.Sprintf(`{"command_id":"photo-chat","cwd":%q,"provider":"fixture","model":"fixture","thinking":"off","first_prompt":{"message":"look","attachments":[{"attachment_id":"photo-1"}]}}`, filepath.Join(t.TempDir(), "photo-chat"))
	req, _ := http.NewRequest("POST", "http://worker/b2/workers", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reply, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(reply), `"no_effect"`) {
		t.Fatalf("create with first_prompt attachments: %d %s", resp.StatusCode, reply)
	}
	if n := fake.Hosts(); n != 0 {
		t.Fatalf("hosts %d", n)
	}
}
