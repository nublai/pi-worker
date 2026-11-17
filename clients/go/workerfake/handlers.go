package workerfake

import (
	"encoding/json"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// Worker is the B2 worker row.
type Worker = b2.Worker

type handler func(f *Fake, c *call) (any, error)

// locked runs fn with f.mu held.
func locked(fn func(s *state, c *call) (any, error)) handler {
	return func(f *Fake, c *call) (any, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return fn(f.st, c)
	}
}

// body decodes the JSON body into T, then runs fn with f.mu held.
func body[T any](fn func(s *state, c *call, b T) (any, error)) handler {
	return locked(func(s *state, c *call) (any, error) {
		var b T
		if err := c.decode(&b); err != nil {
			return nil, err
		}
		return fn(s, c, b)
	})
}

// statefulOps answer from the fake's state; every other operation answers from its wire fixtures.
var statefulOps map[string]handler

func init() {
	statefulOps = map[string]handler{
		"hello":          locked(hello),
		"workers.list":   locked(workersList),
		"workers.get":    locked(workersGet),
		"workers.create": body(func(s *state, c *call, b b2.Create) (any, error) { return s.create(b, nil) }),
		"workers.stop":   body(func(s *state, c *call, b b2.Binding) (any, error) { return s.stop(c.path["worker_id"], b) }),
		"sessions.prompt": body(func(s *state, c *call, b b2.Prompt) (any, error) {
			return s.prompt(c.path["worker_id"], b, "sessions.prompt", b)
		}),
		"sessions.follow_up": body(func(s *state, c *call, b b2.FollowUp) (any, error) { return s.followUp(c.path["worker_id"], b) }),
		"sessions.steer":     body(steer),
		"children.launch":    body(func(s *state, c *call, b b2.ChildLaunch) (any, error) { return s.launchChild(c.path["worker_id"], b) }),
		"executions.cancel": body(func(s *state, c *call, b b2.Control) (any, error) {
			return s.control(c.path["worker_id"], b, "executions.cancel")
		}),
		"executions.interrupt": body(func(s *state, c *call, b b2.Control) (any, error) {
			return s.control(c.path["worker_id"], b, "executions.interrupt")
		}),
		"sessions.resolve_unknown": body(func(s *state, c *call, b b2.Resolve) (any, error) { return s.resolve(c.path["worker_id"], b) }),
		"sessions.rebind": body(func(s *state, c *call, b b2.Rebind) (any, error) {
			return s.move(c.path["worker_id"], b, "sessions.rebind", b)
		}),
		"sessions.new":                   body(sessionsNew),
		"session.configure":              body(configure),
		"sessions.compact":               body(compact),
		"resources.reload":               body(reload),
		"commands.invoke":                body(invoke),
		"interactions.list":              locked(interactionsList),
		"interactions.status":            locked(interactionsStatus),
		"interactions.answer_if_current": body(answer),
		"receipts.get":                   locked(receiptsGet),
		"attachments.stage":              stage,
		"attachments.status":             locked(func(s *state, c *call) (any, error) { return s.attachmentStatus(c.path["attachment_id"]) }),
		"attachments.release":            body(func(s *state, c *call, b b2.Release) (any, error) { return s.release(c.path["attachment_id"], b) }),
		"events.subscribe":               subscribe,
	}
}

// StatefulOps lists the operations the stateful fake answers from its state; the rest answer from wire fixtures.
func StatefulOps() []string { return sorted(statefulOps) }

// hello is the "ok" fixture's reply with this fake's supervisor epoch.
func hello(s *state, c *call) (any, error) {
	var h b2.Hello
	if err := json.Unmarshal(WireFixtures("hello")[0].Response.Body, &h); err != nil {
		return nil, err
	}
	h.SupervisorId = "fake-supervisor"
	h.SupervisorEpoch = s.supervisorEpoch
	return h, nil
}

func workersList(s *state, c *call) (any, error) {
	out := []b2.Worker{}
	for _, id := range s.order {
		out = append(out, s.view(s.workers[id]))
	}
	return out, nil
}

func workersGet(s *state, c *call) (any, error) {
	w, err := s.require(c.path["worker_id"])
	if err != nil {
		return nil, err
	}
	return s.view(w), nil
}

func steer(s *state, c *call, b b2.Steer) (any, error) {
	id := c.path["worker_id"]
	var w *worker
	return s.run(id, b.CommandId, "sessions.steer", map[string]any{"body": b, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := all(func() error { return binding(w, b.WorkerEpoch, b.SessionId, b.BindingRevision) }, func() error { return writable(w) }, func() error { return ready(w) }); err != nil {
			return err
		}
		if w.row.Execution == nil || w.row.Execution.ExecutionId != b.ExecutionId {
			return refuse("stale_execution")
		}
		if w.row.Execution.State == "settled" || w.row.Foreground != "running" {
			return refuse("no_running_execution")
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		r.ExecutionId = &b.ExecutionId
		deliver(r, "forwarded", nil)
		r.Admission, r.Disposition = ptr(b2.ReceiptAdmission("accepted")), ptr("queued")
		return nil
	})
}

func sessionsNew(s *state, c *call, b b2.Binding) (any, error) {
	return s.move(c.path["worker_id"], b2.Rebind{CommandId: b.CommandId, WorkerEpoch: b.WorkerEpoch, SessionId: b.SessionId, BindingRevision: b.BindingRevision, Action: "new"}, "sessions.new", b)
}

func configure(s *state, c *call, b b2.Configure) (any, error) {
	return s.sessionWrite(c.path["worker_id"], "session.configure", b.CommandId, b.WorkerEpoch, b.SessionId, b.BindingRevision, b, func(w *worker) map[string]any {
		result := map[string]any{}
		if b.Model != nil {
			w.row.Model = b.Model
			result["model"] = b.Model
		}
		if b.Thinking != nil {
			w.row.Thinking = b.Thinking
			result["thinking"] = *b.Thinking
		}
		if b.Name != nil {
			w.row.Title = b.Name
			result["name"] = *b.Name
		}
		return result
	})
}

// compact, like reload, cancels every live dialog at its resolver before pi compacts (session-commands.ts).
func compact(s *state, c *call, b b2.Compact) (any, error) {
	return s.sessionWrite(c.path["worker_id"], "sessions.compact", b.CommandId, b.WorkerEpoch, b.SessionId, b.BindingRevision, b, func(w *worker) map[string]any {
		s.interrupt(w)
		return okResult("sessions.compact")
	})
}

func reload(s *state, c *call, b b2.Binding) (any, error) {
	return s.sessionWrite(c.path["worker_id"], "resources.reload", b.CommandId, b.WorkerEpoch, b.SessionId, b.BindingRevision, b, func(w *worker) map[string]any {
		s.interrupt(w)
		return okResult("resources.reload")
	})
}

func invoke(s *state, c *call, b b2.Invoke) (any, error) {
	return s.sessionWrite(c.path["worker_id"], "commands.invoke", b.CommandId, b.WorkerEpoch, b.SessionId, b.BindingRevision, b, func(*worker) map[string]any { return okResult("commands.invoke") })
}

func receiptsGet(s *state, c *call) (any, error) {
	r := s.receipts[c.path["command_id"]]
	if r == nil {
		return nil, refuse("unknown_command_id_is_not_proof_of_no_effect").unknown()
	}
	return r.Receipt, nil
}
