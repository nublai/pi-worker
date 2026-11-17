package workerfake

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"
	"unicode/utf16"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// Interactions as packages/worker/src/interactions/interactions.ts serves them: a dialog pi opened is a pending card
// with an absolute deadline (it closes "timeout" when that passes); an answer is checked against the binding, the
// card's revision, kind and deadline and the offered options before anything is recorded; the fixture host always
// consumes a valid answer (stage 3, status "consumed"); a duplicate answer_id returns the recorded receipt; a binding
// move, an interrupt, a compaction, a reload, a pi exit or a restart closes every live card "interrupted".

const (
	interactionCapacity = 32
	interactionMaxWait  = 30 * time.Second
	answerTextMaxBytes  = 65536
)

var optionID = regexp.MustCompile(`^\d+$`)

// answerSig is a recorded answer's value, kept in memory only (a restart forgets it), as the worker keeps it.
type answerSig struct{ command, signature string }

func answerSignature(a b2.Answer) string {
	var value any
	if a.Value != nil {
		json.Unmarshal(*a.Value, &value)
	}
	data, _ := json.Marshal(map[string]any{"outcome": a.Outcome, "value": value, "option_id": a.OptionId})
	return string(data)
}

// durableRecord is an interaction without its payload (title, message, placeholder, prefill, options): what the
// worker journals and interactions.status reads back.
func durableRecord(in b2.Interaction) b2.Interaction {
	in.Title, in.Message, in.Placeholder, in.Prefill, in.Options, in.PayloadEvidence = nil, nil, nil, nil, nil, nil
	return in
}

// pending lists the worker's live cards that are still pending (interactions.list, the row, interactions.changed).
func pending(w *worker) []b2.Interaction {
	out := []b2.Interaction{}
	for _, in := range w.interactions {
		if in.Status == "pending" {
			out = append(out, in)
		}
	}
	return out
}

// OpenInteraction opens a dialog on a worker as pi would (fixture control): it fills the worker, binding and
// bookkeeping fields, adds the interaction to the row and publishes interactions.changed. Kind, title, message,
// placeholder, prefill, approval and option labels come from in; a select's option ids are their indexes ("0", "1",
// …) as pi's are, and other kinds carry no options. A tool_approval needs its whole approval binding (ApprovalBinding:
// every string field 1 to 4096 characters, the gate token 1 to 128, a non-negative expiry), else
// "invalid_tool_approval" and no card, as the worker never shows one without it; other kinds carry none.
// InteractionId and NativeId default to new ids; Deadline defaults to 30 seconds from now, the worker's bound for a
// dialog without its own. The card closes "timeout" at its deadline. A worker holds at most 32 live interactions.
func (f *Fake) OpenInteraction(workerID string, in b2.Interaction) (b2.Interaction, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.st
	w, err := s.require(workerID)
	if err != nil {
		return b2.Interaction{}, err
	}
	if len(w.interactions) >= interactionCapacity {
		return b2.Interaction{}, errors.New("interaction_capacity")
	}
	if in.InteractionId == "" {
		in.InteractionId = s.id("int")
	}
	if in.NativeId == "" {
		in.NativeId = s.id("native")
	}
	if in.Deadline == 0 {
		in.Deadline = int(time.Now().Add(interactionMaxWait).UnixMilli())
	}
	in.Source = "pi.extension_ui"
	if in.Kind == "tool_approval" {
		in.Source = "pi.tool_gate"
		if !validApproval(in.Approval) {
			return b2.Interaction{}, errors.New("invalid_tool_approval")
		}
	} else {
		in.Approval = nil
	}
	if in.Kind == "select" && in.Options != nil {
		options := make([]b2.InteractionOption, len(*in.Options))
		for i, o := range *in.Options {
			options[i] = b2.InteractionOption{OptionId: strconv.Itoa(i), Label: o.Label}
		}
		in.Options = &options
	} else {
		in.Options = nil
	}
	in.Revision = 1
	in.WorkerId, in.WorkerEpoch, in.SessionId, in.BindingRevision = workerID, w.row.WorkerEpoch, w.row.SessionId, max(1, w.row.BindingRevision)
	in.Status, in.Evidence, in.PayloadEvidence = "pending", "supervisor_journal_fsynced", ptr(b2.InteractionPayloadEvidence("observed_memory"))
	in.AnswerId, in.AnswerCommandId, in.AnswerStage, in.Outcome, in.Actor = nil, nil, nil, nil, nil
	w.interactions = append(w.interactions, in)
	id, gen := in.InteractionId, s.gen
	w.timers[id] = time.AfterFunc(time.Until(time.UnixMilli(int64(in.Deadline))), func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.st.gen == gen && f.st.workers[workerID] == w {
			f.st.expire(w, id)
		}
	})
	s.persist(w)
	s.publishInteractions(w)
	return in, nil
}

// expire closes a card still pending at its deadline: "timeout", and pi's resolver is cancelled.
func (s *state) expire(w *worker, id string) {
	for i, in := range w.interactions {
		if in.InteractionId != id || in.Status != "pending" {
			continue
		}
		delete(w.timers, id)
		in.Status, in.Outcome = "timeout", ptr("timeout")
		w.closed[id] = durableRecord(in)
		w.interactions = append(w.interactions[:i:i], w.interactions[i+1:]...)
		s.persist(w)
		s.publishInteractions(w)
		return
	}
}

// interrupt ends every live interaction of the worker (its resolvers are cancelled or gone): "interrupted".
func (s *state) interrupt(w *worker) {
	if len(w.interactions) == 0 {
		return
	}
	for _, in := range w.interactions {
		if t := w.timers[in.InteractionId]; t != nil {
			t.Stop()
		}
		if in.Status == "pending" {
			in.Outcome = ptr("interrupted")
		}
		in.Status = "interrupted"
		w.closed[in.InteractionId] = durableRecord(in)
	}
	w.interactions, w.timers = nil, map[string]*time.Timer{}
	s.publishInteractions(w)
}

func interactionsList(s *state, c *call) (any, error) {
	w, err := s.require(c.path["worker_id"])
	if err != nil {
		return nil, err
	}
	return b2.Interactions(pending(w)), nil
}

func interactionsStatus(s *state, c *call) (any, error) {
	w, err := s.require(c.path["worker_id"])
	if err != nil {
		return nil, err
	}
	id := c.query.Get("interaction_id")
	for _, in := range w.interactions {
		if in.InteractionId == id {
			return durableRecord(in), nil
		}
	}
	if in, ok := w.closed[id]; ok {
		return in, nil
	}
	return nil, refuse("unknown_interaction")
}

// recordedAnswer is the interaction that recorded answerID, on any worker.
func (s *state) recordedAnswer(answerID string) *b2.Interaction {
	for _, wid := range s.order {
		w := s.workers[wid]
		for _, in := range w.interactions {
			if derefString(in.AnswerId) == answerID {
				return &in
			}
		}
		for _, in := range w.closed {
			if derefString(in.AnswerId) == answerID {
				return &in
			}
		}
	}
	return nil
}

func answer(s *state, c *call, a b2.Answer) (any, error) {
	id := c.path["worker_id"]
	signature := answerSignature(a)
	if known, ok := s.answerSigs[a.AnswerId]; ok && known.signature != signature {
		return nil, refuse("answer_id_conflict")
	}
	if rec := s.recordedAnswer(a.AnswerId); rec != nil {
		if rec.InteractionId != a.InteractionId || rec.WorkerId != id || rec.WorkerEpoch != a.WorkerEpoch || derefString(rec.SessionId) != a.SessionId ||
			rec.BindingRevision != a.BindingRevision || rec.Revision != a.Revision || rec.Kind != a.Kind {
			return nil, refuse("answer_id_conflict")
		}
		// The recorded outcome, without revalidating the value (it is not stored) and without redispatch.
		if prior := s.receipts[derefString(rec.AnswerCommandId)]; prior != nil {
			r := prior.Receipt
			return &r, nil
		}
	}
	// The receipt's request hash covers the answer's metadata only, never its value.
	metadata := a
	metadata.Value, metadata.OptionId, metadata.Outcome = nil, nil, ""
	var w *worker
	index := -1
	return s.run(id, a.CommandId, "interactions.answer_if_current", map[string]any{"body": metadata, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := writable(w); err != nil {
			return err
		}
		if w.host == nil || w.exited || (w.row.Status != "starting" && w.row.Status != "ready") {
			return refuse("worker_not_ready")
		}
		if err := binding(w, a.WorkerEpoch, a.SessionId, a.BindingRevision); err != nil {
			return err
		}
		for i, in := range w.interactions {
			if in.InteractionId == a.InteractionId {
				index = i
			}
		}
		if index < 0 {
			return refuse("interaction_not_pending")
		}
		in := w.interactions[index]
		var value any
		if a.Value != nil {
			json.Unmarshal(*a.Value, &value)
		}
		switch {
		case in.Status != "pending":
			return refuse("interaction_already_answered")
		case in.WorkerEpoch != a.WorkerEpoch || derefString(in.SessionId) != a.SessionId || in.BindingRevision != a.BindingRevision || in.Revision != a.Revision:
			return refuse("stale_interaction")
		case in.Kind != a.Kind:
			return refuse("wrong_interaction_kind")
		case time.Now().UnixMilli() >= int64(in.Deadline):
			return refuse("interaction_deadline_passed")
		case a.Outcome == "cancel":
			if a.Value != nil || a.OptionId != nil {
				return refuse("cancel_has_value")
			}
		case a.Kind == "select":
			n, err := strconv.Atoi(derefString(a.OptionId))
			if a.OptionId == nil || !optionID.MatchString(*a.OptionId) || err != nil || strconv.Itoa(n) != *a.OptionId || in.Options == nil || n >= len(*in.Options) || a.Value != nil {
				return refuse("invalid_option")
			}
		case a.Kind == "confirm" || a.Kind == "tool_approval":
			if _, ok := value.(bool); !ok || a.OptionId != nil {
				return refuse("invalid_boolean")
			}
		default:
			if text, ok := value.(string); !ok || len(text) > answerTextMaxBytes || a.OptionId != nil {
				return refuse("invalid_text")
			}
		}
		return nil
	}, func(r *b2.Receipt) error {
		s.dispatch(r)
		s.answerSigs[a.AnswerId] = answerSig{a.CommandId, signature}
		in := w.interactions[index]
		if t := w.timers[in.InteractionId]; t != nil {
			t.Stop()
			delete(w.timers, in.InteractionId)
		}
		outcome := "answered"
		if a.Outcome == "cancel" {
			outcome = "cancel"
		} else if a.Value != nil && string(*a.Value) == "false" {
			outcome = "no"
		}
		in.Status, in.AnswerId, in.AnswerCommandId, in.AnswerStage, in.Outcome = "consumed", &a.AnswerId, &a.CommandId, ptr(3), &outcome
		if a.Actor != nil {
			in.Actor = a.Actor
		}
		if in.Kind == "tool_approval" {
			// A consumed approval stays live (it owns pi's tool gate) until the gate ends or the worker moves.
			w.interactions[index] = in
		} else {
			w.closed[in.InteractionId] = durableRecord(in)
			w.interactions = append(w.interactions[:index:index], w.interactions[index+1:]...)
		}
		s.persist(w)
		s.publishInteractions(w)
		deliver(r, "resolver_consumed", map[string]any{"interaction_id": a.InteractionId, "answer_id": a.AnswerId, "outcome": outcome, "resolver_consumed": true})
		r.AnswerStage = ptr(3)
		return nil
	})
}

// validApproval: a tool gate's binding within the spec's bounds (interactions.ts approvalBinding).
func validApproval(a *b2.ApprovalBinding) bool {
	if a == nil || a.Expiry < 0 || !within(a.GateToken, 128) {
		return false
	}
	for _, v := range []string{a.Digest, a.PolicyRevision, a.Operation, a.Resource, a.Environment, a.OfferedScope} {
		if !within(v, 4096) {
			return false
		}
	}
	return true
}

// within: 1 to max UTF-16 code units, as JSON Schema counts a string's length.
func within(v string, max int) bool {
	n := len(utf16.Encode([]rune(v)))
	return n >= 1 && n <= max
}
