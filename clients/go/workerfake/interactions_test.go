package workerfake_test

// Answers as the worker checks them (packages/worker/src/interactions/interactions.ts): deadline, offered option,
// boolean and text values, a cancel without a value, the worker's refusal names; the consumed readback and receipt;
// a duplicate answer_id returning its recorded receipt, before and after a restart (PR #16 GPT 1 and 4).

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func raw(v any) *json.RawMessage {
	data, _ := json.Marshal(v)
	m := json.RawMessage(data)
	return &m
}

func answerFor(w *b2.Worker, in b2.Interaction, cmd, answerID string) b2.Answer {
	return b2.Answer{CommandId: cmd, AnswerId: answerID, InteractionId: in.InteractionId, Revision: in.Revision, Kind: in.Kind, Outcome: "answer", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: w.BindingRevision}
}

func open(t *testing.T, fake *workerfake.Fake, w *b2.Worker, in b2.Interaction) b2.Interaction {
	t.Helper()
	out, err := fake.OpenInteraction(w.WorkerId, in)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// refusedNothingRecorded: the answer was refused no_effect with name, its command has no receipt, and the card is
// still pending.
func refusedNothingRecorded(t *testing.T, c *b2.Client, w *b2.Worker, in b2.Interaction, a b2.Answer, name string) {
	t.Helper()
	ctx := context.Background()
	_, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, a)
	if !isRefusal(err, http.StatusConflict, name) || asFailure(t, err).Effect != b2.NoEffect {
		t.Fatalf("%s: %v, want 409 %s no_effect", a.CommandId, err, name)
	}
	if _, err := c.ReceiptsGet(ctx, a.CommandId); !isRefusal(err, http.StatusConflict, "unknown_command_id_is_not_proof_of_no_effect") {
		t.Fatalf("%s: a refused answer left a receipt: %v", a.CommandId, err)
	}
	st, err := c.InteractionsStatus(ctx, w.WorkerId, b2.InteractionsStatusParams{InteractionId: in.InteractionId})
	if err != nil || st.Status != "pending" || st.AnswerId != nil {
		t.Fatalf("%s: the card after a refused answer %+v %v", a.CommandId, st, err)
	}
}

func TestAnswersAreValidatedAsTheWorkerValidatesThem(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")

	sel := open(t, fake, w, b2.Interaction{Kind: "select", Title: ptr("Pick"), Options: &[]b2.InteractionOption{{Label: "A"}, {Label: "B"}}})
	if o := *sel.Options; o[0].OptionId != "0" || o[1].OptionId != "1" {
		t.Fatalf("option ids %+v, want pi's indexes", o)
	}
	a := answerFor(w, sel, "a-1", "ans-1")
	for i, bad := range []*string{ptr("2"), ptr("01"), ptr("a"), nil} {
		a.CommandId, a.AnswerId, a.OptionId = "a-opt-"+string(rune('0'+i)), "ans-opt-"+string(rune('0'+i)), bad
		refusedNothingRecorded(t, c, w, sel, a, "invalid_option")
	}
	a.CommandId, a.AnswerId, a.OptionId, a.Value = "a-optval", "ans-optval", ptr("0"), raw("x")
	refusedNothingRecorded(t, c, w, sel, a, "invalid_option")
	a = answerFor(w, sel, "a-cancel", "ans-cancel")
	a.Outcome, a.OptionId = "cancel", ptr("0")
	refusedNothingRecorded(t, c, w, sel, a, "cancel_has_value")
	a = answerFor(w, sel, "a-kind", "ans-kind")
	a.Kind, a.Value = "confirm", raw(true)
	refusedNothingRecorded(t, c, w, sel, a, "wrong_interaction_kind")
	a = answerFor(w, sel, "a-rev", "ans-rev")
	a.Revision, a.OptionId = sel.Revision+1, ptr("0")
	refusedNothingRecorded(t, c, w, sel, a, "stale_interaction")
	a = answerFor(w, sel, "a-missing", "ans-missing")
	a.InteractionId = "no-such-interaction"
	if _, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, a); !isRefusal(err, http.StatusConflict, "interaction_not_pending") {
		t.Fatalf("an unknown interaction: %v", err)
	}

	confirm := open(t, fake, w, b2.Interaction{Kind: "confirm", Title: ptr("Sure?")})
	for i, bad := range []*json.RawMessage{raw("yes"), raw(1), nil} {
		a = answerFor(w, confirm, "c-"+string(rune('0'+i)), "ans-c-"+string(rune('0'+i)))
		a.Value = bad
		refusedNothingRecorded(t, c, w, confirm, a, "invalid_boolean")
	}
	input := open(t, fake, w, b2.Interaction{Kind: "input", Title: ptr("Name?")})
	for i, bad := range []*json.RawMessage{raw(true), raw(strings.Repeat("x", 65537)), nil} {
		a = answerFor(w, input, "i-"+string(rune('0'+i)), "ans-i-"+string(rune('0'+i)))
		a.Value = bad
		refusedNothingRecorded(t, c, w, input, a, "invalid_text")
	}
	a = answerFor(w, input, "i-ok", "ans-i-ok")
	a.Value = raw(strings.Repeat("x", 65536))
	if r, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, a); err != nil || r.Stage != "resolver_consumed" {
		t.Fatalf("64 KiB of text: %+v %v", r, err)
	}

	// A card past its deadline closes "timeout"; an answer then finds nothing pending and records nothing.
	events := startWatch(t, c, b2.WatchOptions{WorkerIDs: []string{w.WorkerId}, Types: []string{"interactions.changed"}})
	snapshotOf(t, events.next(t))
	short := open(t, fake, w, b2.Interaction{Kind: "confirm", Deadline: int(time.Now().Add(100 * time.Millisecond).UnixMilli())})
	events.next(t) // opened
	gone := false
	for !gone {
		ev := events.next(t).Event.(*b2.InteractionsChangedEvent)
		gone = true
		for _, in := range ev.Data.Interactions {
			gone = gone && in.InteractionId != short.InteractionId
		}
	}
	st, err := c.InteractionsStatus(ctx, w.WorkerId, b2.InteractionsStatusParams{InteractionId: short.InteractionId})
	if err != nil || st.Status != "timeout" || st.Outcome == nil || *st.Outcome != "timeout" {
		t.Fatalf("expired card %+v %v", st, err)
	}
	a = answerFor(w, short, "late", "ans-late")
	a.Value = raw(true)
	if _, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, a); !isRefusal(err, http.StatusConflict, "interaction_not_pending") {
		t.Fatalf("an answer after the deadline: %v", err)
	}
	if _, err := c.ReceiptsGet(ctx, "late"); err == nil {
		t.Fatal("an answer after the deadline was recorded")
	}
	list, err := c.InteractionsList(ctx, w.WorkerId)
	if err != nil {
		t.Fatal(err)
	}
	for _, in := range list {
		if in.InteractionId == short.InteractionId {
			t.Fatal("an expired card is still listed")
		}
	}
}

func TestAnswerReadbackAndAnswerIDIdempotencyMatchTheWorker(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	in := open(t, fake, w, b2.Interaction{Kind: "select", Title: ptr("Pick"), Options: &[]b2.InteractionOption{{Label: "A"}, {Label: "B"}}})
	a := answerFor(w, in, "ans-cmd-1", "ans-1")
	a.OptionId, a.Actor = ptr("1"), ptr("device-1")
	r, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, a)
	if err != nil {
		t.Fatal(err)
	}
	if r.State != "delivered" || r.Stage != "resolver_consumed" || r.Effect != "observed" || r.AnswerStage == nil || *r.AnswerStage != 3 || r.Result == nil {
		t.Fatalf("receipt %+v", r)
	}
	res := *r.Result
	if res["interaction_id"] != in.InteractionId || res["answer_id"] != "ans-1" || res["outcome"] != "answered" || res["resolver_consumed"] != true {
		t.Fatalf("receipt result %v", res)
	}
	st, err := c.InteractionsStatus(ctx, w.WorkerId, b2.InteractionsStatusParams{InteractionId: in.InteractionId})
	if err != nil || st.Status != "consumed" || *st.Outcome != "answered" || *st.AnswerStage != 3 || *st.AnswerId != "ans-1" || *st.AnswerCommandId != "ans-cmd-1" || *st.Actor != "device-1" {
		t.Fatalf("status %+v %v", st, err)
	}
	if st.Title != nil || st.Options != nil {
		t.Fatalf("the durable readback carries the payload: %+v", st)
	}

	// The same answer_id under a new command id: the recorded receipt, nothing dispatched again.
	dup := a
	dup.CommandId = "ans-cmd-2"
	again, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, dup)
	if err != nil || again.CommandId != "ans-cmd-1" || again.Stage != "resolver_consumed" {
		t.Fatalf("duplicate answer_id %+v %v", again, err)
	}
	// Another value under the same answer_id is a conflict.
	other := dup
	other.OptionId = ptr("0")
	if _, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, other); !isRefusal(err, http.StatusConflict, "answer_id_conflict") {
		t.Fatalf("answer_id with another value: %v", err)
	}
	// A new answer to the consumed card finds nothing pending.
	late := a
	late.CommandId, late.AnswerId = "ans-cmd-3", "ans-3"
	if _, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, late); !isRefusal(err, http.StatusConflict, "interaction_not_pending") {
		t.Fatalf("second answer: %v", err)
	}
	// A confirm answered false is "no".
	confirm := open(t, fake, w, b2.Interaction{Kind: "confirm"})
	no := answerFor(w, confirm, "no-cmd", "no-1")
	no.Value = raw(false)
	if r, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, no); err != nil || (*r.Result)["outcome"] != "no" {
		t.Fatalf("confirm false %+v %v", r, err)
	}

	// After a restart the recorded receipt still answers a duplicate answer_id, without revalidating the value.
	pendingCard := open(t, fake, w, b2.Interaction{Kind: "confirm"})
	fake.Restart()
	again, err = c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, dup)
	if err != nil || again.CommandId != "ans-cmd-1" {
		t.Fatalf("duplicate answer_id after a restart %+v %v", again, err)
	}
	if again, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, other); err != nil || again.CommandId != "ans-cmd-1" {
		t.Fatalf("after a restart the value is not stored: %+v %v", again, err)
	}
	// A card open at the restart is interrupted, never re-opened.
	if st, err := c.InteractionsStatus(ctx, w.WorkerId, b2.InteractionsStatusParams{InteractionId: pendingCard.InteractionId}); err != nil || st.Status != "interrupted" {
		t.Fatalf("card across a restart %+v %v", st, err)
	}
}
