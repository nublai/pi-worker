package workerfake

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// The stateful supervisor. Every method here runs with f.mu held. It follows the worker's rules
// (packages/worker/src/supervisor: input.ts, fence.ts, binding.ts, lifecycle.ts, receipts/receipts.ts) closely
// enough that the frozen section 0.1 rows pass against it; it is not a second implementation of the worker.

// Receipt states, stages and effects used below.
const (
	stIntent          = "intent"
	stIntentRecovered = "intent_recovered"
	stAccepted        = "accepted"
	stDelivered       = "delivered"
	stRejected        = "rejected"
	stOutcomeUnknown  = "outcome_unknown"
	stQueued          = "queued"
	stQueueReady      = "queue_ready"
	stIntentReady     = "intent_ready"
)

// sessionDirected operations fence the session when their outcome is unknown.
var sessionDirected = map[string]bool{
	"sessions.prompt": true, "sessions.follow_up": true, "sessions.steer": true, "sessions.rebind": true,
	"sessions.new": true, "children.launch": true, "interactions.answer_if_current": true,
	"session.configure": true, "sessions.compact": true, "resources.reload": true, "commands.invoke": true,
}

// queuedItem is queued input: a follow-up (queued by sessions.follow_up or by sessions.prompt with if_busy
// follow_up) or a child launch. It dispatches later as its own operation with its original request.
type queuedItem struct {
	commandID string
	op        string // sessions.prompt, sessions.follow_up or children.launch
	prompt    *b2.Prompt
	request   any
	child     *b2.ChildLaunch
}

type worker struct {
	row          b2.Worker
	host         *Host // nil once retired (a restart never adopts a host)
	exited       bool
	observedIdle bool
	pending      []queuedItem
	interactions []b2.Interaction          // live: pending cards and consumed approvals that still own a gate
	closed       map[string]b2.Interaction // closed interactions' durable records, by id
	timers       map[string]*time.Timer    // pending cards' deadlines
}

type storedReceipt struct {
	b2.Receipt
	hash string
}

type settlement struct{ workerID, sessionID, executionID, commandID string }

type state struct {
	f               *Fake
	gen             int // bumped by Restart; effects of an older generation stop
	supervisorEpoch string
	seq             int
	counter         int
	workers         map[string]*worker
	order           []string
	disk            map[string]b2.Worker
	receipts        map[string]*storedReceipt
	receiptOrder    []string // command ids in the order their receipts were first recorded
	settlements     []settlement
	hostsLaunched   int
	firstHost       map[string]*Host
	attachments     map[string]*attachment
	receiving       map[string]*attachment
	dropStageReply  bool
	firstReply      string // "", "drop" or "hold": the next create's first prompt reply (DropFirstPromptReply)
	subs            map[*subscriber]bool
	answerSigs      map[string]answerSig    // answer_id → its recorded value (memory only)
	sessions        map[string]*sessionFile // the session catalog: every session a worker bound, with its file
}

func newState(f *Fake) *state {
	s := &state{
		f: f, workers: map[string]*worker{}, disk: map[string]b2.Worker{}, receipts: map[string]*storedReceipt{},
		firstHost: map[string]*Host{}, attachments: map[string]*attachment{}, receiving: map[string]*attachment{},
		subs: map[*subscriber]bool{}, answerSigs: map[string]answerSig{}, sessions: map[string]*sessionFile{},
	}
	s.supervisorEpoch = s.id("sup")
	return s
}

func (s *state) id(kind string) string {
	s.counter++
	return fmt.Sprintf("fake-%s-%d", kind, s.counter)
}

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func clone[T any](v T) T {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err) // the models always encode
	}
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}

// view is the worker row readers see, with its live interactions.
func (s *state) view(w *worker) b2.Worker {
	row := clone(w.row)
	// The phone's chat row from the session file, as state.ts view() does: the newest user or assistant text
	// (marker stripped) and the newest entry's time; null before pi wrote any.
	row.Preview, row.LastActivityAt, row.FirstUserLine = nil, nil, nil
	if sf := s.sessions[derefString(w.row.SessionId)]; sf != nil {
		_, _, row.Preview = summarize(sf.data[:sf.watermark()])
		row.LastActivityAt = lastEntryTime(sf.data[:sf.watermark()])
		row.FirstUserLine = firstUserLine(sf.data[:sf.watermark()])
	}
	if row.RecentSettlements == nil {
		row.RecentSettlements = &[]b2.RecentSettlement{}
	}
	row.PendingInteractions = []json.RawMessage{}
	for _, in := range pending(w) {
		data, _ := json.Marshal(in)
		row.PendingInteractions = append(row.PendingInteractions, data)
	}
	return row
}

// persist is the fake's durable worker record (Disk) and publishes the row; an uncertain command that joined the
// fence in this row is fence.set, after it (state.ts persist).
func (s *state) persist(w *worker) {
	var before []string
	if old, ok := s.disk[w.row.WorkerId]; ok && old.Fence != nil {
		before = uncertainIDs(old.Fence)
	}
	s.disk[w.row.WorkerId] = clone(w.row)
	row := s.view(w)
	s.publish("worker.updated", w.row.WorkerId, executionOf(w), "supervisor_journal_fsynced", map[string]any{"worker": row})
	if f := w.row.Fence; f != nil {
		for _, cmd := range uncertainIDs(f) {
			if slices.Contains(before, cmd) {
				continue
			}
			var execution *string
			if e := w.row.Execution; e != nil && e.CommandId == cmd {
				execution = &e.ExecutionId
			}
			s.publish("fence.set", w.row.WorkerId, execution, "supervisor_journal_fsynced", map[string]any{"command_id": cmd, "fence_generation": f.FenceGeneration, "fence": clone(*f)})
			break
		}
	}
}

// recentSettlements is the cap of a row's recent_settlements (input.ts RECENT_SETTLEMENTS).
const recentSettlements = 8

// recordSettlement puts the worker's execution first in its row's recent_settlements: one entry per execution, at
// most recentSettlements (input.ts recordSettlement). The caller persists the row.
func recordSettlement(w *worker, disposition string) {
	e := w.row.Execution
	list := deref(w.row.RecentSettlements)
	if slices.ContainsFunc(list, func(x b2.RecentSettlement) bool { return x.ExecutionId == e.ExecutionId }) {
		return
	}
	list = append([]b2.RecentSettlement{{ExecutionId: e.ExecutionId, CommandId: e.CommandId, Disposition: disposition, SettledAt: now()}}, list...)
	w.row.RecentSettlements = ptr(list[:min(len(list), recentSettlements)])
}

// receiptUpdated publishes a worker command's receipt record as receipt.updated.
func (s *state) receiptUpdated(r b2.Receipt) {
	if r.WorkerId != nil {
		s.publish("receipt.updated", *r.WorkerId, r.ExecutionId, "supervisor_journal_fsynced", map[string]any{"receipt": r})
	}
}

func executionOf(w *worker) *string {
	if w.row.Execution == nil {
		return nil
	}
	return &w.row.Execution.ExecutionId
}

func (s *state) require(id string) (*worker, error) {
	w := s.workers[id]
	if w == nil {
		return nil, refuse("unknown_worker")
	}
	return w, nil
}

func holding(status b2.WorkerStatus) bool {
	return status == "starting" || status == "ready" || status == "cleanup_pending"
}

// --- receipts ---

func requestHash(op string, request any) string {
	data, _ := json.Marshal(struct {
		Op      string `json:"operation"`
		Request any    `json:"request"`
	}{op, request})
	sum := sha256.Sum256(data)
	return "sha256-" + hex.EncodeToString(sum[:])
}

// run executes a command once, as receipts.run does: a duplicate with the same operation and request returns the
// stored receipt, another one is command_id_conflict; validate's refusal leaves no record; effect's failure is
// rejected/no_effect before dispatch and outcome_unknown after it. Only queue_ready and intent_ready run again.
func (s *state) run(workerID, commandID, op string, request any, validate func() error, effect func(r *b2.Receipt) error) (*b2.Receipt, error) {
	hash := requestHash(op, request)
	prior := s.receipts[commandID]
	if prior != nil {
		if string(prior.Operation) != op || prior.hash != hash {
			return nil, refuse("command_id_conflict")
		}
		if prior.State != stQueueReady && prior.State != stIntentReady {
			r := prior.Receipt
			return &r, nil
		}
	}
	if err := validate(); err != nil {
		return nil, err
	}
	created := now()
	if prior != nil {
		created = prior.CreatedAt
	}
	rec := &storedReceipt{hash: hash, Receipt: b2.Receipt{
		CommandId: commandID, Operation: b2.ReceiptOperation(op), RequestHash: hash, State: stIntent, Stage: "reserved",
		Effect: "no_effect", Evidence: "supervisor_journal_fsynced", CreatedAt: created,
	}}
	if workerID != "" {
		rec.WorkerId = ptr(workerID)
	}
	if prior == nil {
		s.receiptOrder = append(s.receiptOrder, commandID)
	}
	s.receipts[commandID] = rec
	gen := s.gen
	err := effect(&rec.Receipt)
	if gen != s.gen {
		// A restart recovered this command meanwhile; its recovered receipt stands.
		r := s.receipts[commandID].Receipt
		return &r, nil
	}
	if err != nil {
		if rec.State == stIntent {
			rec.State, rec.Stage, rec.Effect, rec.Admission = stRejected, "refused", "no_effect", ptr(b2.ReceiptAdmission("rejected"))
		} else {
			rec.State, rec.Stage, rec.Effect = stOutcomeUnknown, "unknown", "unknown"
		}
		rec.Error = ptr(err.Error())
	}
	s.receiptUpdated(rec.Receipt)
	r := rec.Receipt
	return &r, nil
}

// dispatch records the dispatch marker: from here a lost reply is outcome_unknown.
func dispatch(r *b2.Receipt) {
	r.State, r.Stage, r.Effect = stAccepted, "dispatch_recorded", "unknown"
}

func deliver(r *b2.Receipt, stage string, result map[string]any) {
	r.State, r.Stage, r.Effect = stDelivered, b2.ReceiptStage(stage), "observed"
	if result != nil {
		r.Result = &result
	}
}

// --- checks ---

func binding(w *worker, workerEpoch, sessionID string, revision int) error {
	session := ""
	if w.row.SessionId != nil {
		session = *w.row.SessionId
	}
	if w.row.WorkerEpoch != workerEpoch || session != sessionID || w.row.BindingRevision != revision {
		r := refuse("stale_binding")
		r.body.ExpectedBindingRevision = ptr(max(1, w.row.BindingRevision))
		r.body.ReceivedBindingRevision = ptr(revision)
		return r
	}
	return nil
}

func writable(w *worker) error {
	if w.row.Fence != nil {
		return refuse("session_fenced").uncertain(w.row.Fence.CommandId)
	}
	return nil
}

func ready(w *worker) error {
	if w.row.Status != "ready" || w.host == nil || w.exited {
		return refuse("worker_not_ready")
	}
	return nil
}

func all(checks ...func() error) error {
	for _, c := range checks {
		if err := c(); err != nil {
			return err
		}
	}
	return nil
}

// --- fence ---

func resolved(w *worker, commandID string) bool {
	for _, r := range deref(w.row.Resolutions) {
		if r.CommandId == commandID {
			return true
		}
	}
	return false
}

func deref[T any](p *[]T) []T {
	if p == nil {
		return nil
	}
	return *p
}

// latch joins commandID to the worker's fence; a new uncertainty raises the generation.
func latch(w *worker, commandID string) {
	f := w.row.Fence
	if f == nil {
		gen := 1
		if w.row.FenceGeneration != nil {
			gen = *w.row.FenceGeneration + 1
		}
		w.row.Fence = &b2.Fence{CommandId: commandID, FenceGeneration: gen, UncertainCommandIds: &[]string{commandID}}
	} else if ids := uncertainIDs(f); !slices.Contains(ids, commandID) {
		f.UncertainCommandIds = ptr(append(ids, commandID))
		f.FenceGeneration++
	}
	w.row.FenceGeneration = ptr(w.row.Fence.FenceGeneration)
	for i := range deref(w.row.Queued) {
		if q := &(*w.row.Queued)[i]; q.State == "queued" {
			q.State = "paused"
		}
	}
	if e := w.row.Execution; e != nil && e.CommandId == commandID && e.State != "settled" {
		e.State = "outcome_unknown"
	}
	w.row.Foreground = "unknown"
}

func uncertainIDs(f *b2.Fence) []string {
	if f.UncertainCommandIds != nil {
		return slices.Clone(*f.UncertainCommandIds)
	}
	return []string{f.CommandId}
}

// uncertain: a command whose outcome can no longer be observed latches the fence.
func (s *state) uncertain(w *worker, commandID string) {
	if r := s.receipts[commandID]; r != nil && r.State == stAccepted {
		r.State, r.Stage, r.Effect = stOutcomeUnknown, "unknown", "unknown"
		s.receiptUpdated(r.Receipt)
	}
	if e := w.row.Execution; e != nil && e.CommandId == commandID && e.State != "settled" {
		e.State = "outcome_unknown"
	}
	latch(w, commandID)
}

// --- host events ---

func (s *state) event(w *worker, kind string) {
	switch kind {
	case "agent_start":
		w.observedIdle = false
		w.row.Foreground = foreground(w, "running")
		if e := w.row.Execution; e != nil && e.State == "admitted" {
			e.State = "started"
			s.persist(w)
			s.publish("execution.started", w.row.WorkerId, &e.ExecutionId, "supervisor_journal_fsynced", map[string]any{"command_id": e.CommandId})
		}
	case "agent_settled":
		w.row.Foreground = foreground(w, "idle")
		w.observedIdle = true
		w.row.SettleCount = ptr(derefInt(w.row.SettleCount) + 1)
		e := w.row.Execution
		disposition := "agent_settled"
		if e != nil {
			if e.Disposition != nil {
				disposition = *e.Disposition
			}
			e.State = "settled"
			recordSettlement(w, disposition)
			s.settlements = append(s.settlements, settlement{w.row.WorkerId, derefString(w.row.SessionId), e.ExecutionId, e.CommandId})
		}
		s.persist(w)
		if e != nil {
			s.publish("execution.settled", w.row.WorkerId, &e.ExecutionId, "observed_memory", map[string]any{"command_id": e.CommandId, "disposition": disposition})
		}
		s.flush(w)
	case "exit":
		if w.exited {
			return
		}
		w.exited = true
		s.interrupt(w)
		if w.row.Status == "stopped" {
			return
		}
		if e := w.row.Execution; e != nil && e.State != "settled" {
			s.uncertain(w, e.CommandId)
		}
		s.setStatus(w, "cleanup_pending")
		w.row.Cleanup = "leader_exit_only"
		s.persist(w)
	}
}

func foreground(w *worker, v b2.WorkerForeground) b2.WorkerForeground {
	if w.row.Fence != nil {
		return "unknown"
	}
	return v
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *state) setStatus(w *worker, status b2.WorkerStatus) {
	if w.row.Status != status {
		w.row.Status = status
		w.row.StatusSince = ptr(now())
	}
}

// --- workers.create and children ---

type createOpts struct {
	parentWorkerID, parentCommandID string
}

func (s *state) create(c b2.Create, parent *createOpts) (*b2.Receipt, error) {
	var holder *worker
	return s.run("", c.CommandId, "workers.create", c, func() error {
		if !filepath.IsAbs(c.Cwd) {
			return badRequest("request_schema_mismatch")
		}
		if c.Parent != nil || c.LaunchSpec != nil {
			return refuse("typed_children_unsupported_by_fake")
		}
		for _, id := range s.order {
			if o := s.workers[id]; o.row.Cwd == c.Cwd && holding(o.row.Status) {
				r := refuse("exclusive_environment_already_bound")
				r.body.HolderWorkerId = ptr(id)
				return r
			}
		}
		if c.ResumeSessionId != nil {
			return s.resumable(*c.ResumeSessionId, "", &holder)
		}
		return nil
	}, func(r *b2.Receipt) error {
		id := s.id("w")
		dispatch(r)
		r.WorkerId = &id
		session := s.id("s")
		if c.ResumeSessionId != nil {
			session = *c.ResumeSessionId
		}
		lineage := b2.Lineage("root")
		w := &worker{closed: map[string]b2.Interaction{}, timers: map[string]*time.Timer{}, observedIdle: true, row: b2.Worker{
			WorkerId: id, WorkerEpoch: s.id("epoch"), SupervisorEpoch: s.supervisorEpoch, SessionId: &session,
			SessionIdentityEvidence: "pi_sdk_session_id", BindingRevision: 1, Cwd: c.Cwd, Status: "ready",
			Foreground: "idle", Cleanup: "none", History: b2.HistoryMarker{Evidence: "pi_session_file"},
			PendingInteractions: []json.RawMessage{}, Queued: &[]b2.QueuedInput{}, FenceGeneration: ptr(0),
			Host: ptr(b2.Host("sdk")), SettleCount: ptr(0), RecentSettlements: &[]b2.RecentSettlement{}, StatusSince: ptr(now()), RepoLabel: ptr(filepath.Base(c.Cwd)),
			Model: &b2.ModelRef{Provider: c.Provider, Id: c.Model}, Thinking: ptr(c.Thinking),
		}}
		if parent != nil {
			lineage = "child"
			w.row.ParentWorkerId = &parent.parentWorkerID
			w.row.ParentLaunchCommandId = &parent.parentCommandID
		}
		w.row.Lineage = &lineage
		w.host = &Host{f: s.f, w: w}
		if mode := s.firstReply; mode != "" && c.FirstPrompt != nil {
			s.firstReply = ""
			w.host.mode = mode
			if mode == "hold" {
				w.host.held = make(chan struct{})
			}
		}
		s.hostsLaunched++
		s.firstHost[id] = w.host
		s.workers[id] = w
		s.order = append(s.order, id)
		s.bindSession(w, session)
		s.persist(w)
		// The receipt names the binding the new worker starts at, as lifecycle.ts launch reports it.
		created := map[string]any{"worker_id": id, "worker_epoch": w.row.WorkerEpoch, "session_id": session, "binding_revision": w.row.BindingRevision}
		r.HistoryLag = ptr(false)
		if c.FirstPrompt != nil {
			return s.firstPrompt(w, r, *c.FirstPrompt, created)
		}
		deliver(r, "forwarded", created)
		return nil
	})
}

// firstPrompt is a create's first prompt on its ready worker (input.ts first): a refusal at admission (the checks of
// sessions.prompt) delivers the created worker with admission rejected and the typed error, and nothing reaches the
// host; otherwise the execution joins the create's receipt before the prompt is written, and a lost reply fences the
// new session on the create before the receipt is outcome_unknown.
func (s *state) firstPrompt(w *worker, r *b2.Receipt, fp b2.FirstPrompt, created map[string]any) error {
	id := w.row.WorkerId
	err := all(func() error { return writable(w) }, func() error { return ready(w) }, func() error {
		if strings.HasPrefix(strings.TrimLeft(fp.Message, " \t\n"), "/") {
			return refuse("slash_commands_use_typed_methods")
		}
		if fp.Attachments != nil && len(*fp.Attachments) > 0 {
			return s.forPrompt(id, *fp.Attachments)
		}
		return nil
	})
	var ref *refusal
	if errors.As(err, &ref) {
		deliver(r, "forwarded", created)
		r.Admission, r.Error = ptr(b2.ReceiptAdmission("rejected")), ptr(ref.body.Error)
		return nil
	}
	execution := &b2.Execution{ExecutionId: s.id("x"), CommandId: r.CommandId, State: "admitted"}
	w.row.Execution = execution
	w.row.Foreground = "running"
	w.observedIdle = false
	s.persist(w)
	s.publish("execution.admitted", id, &execution.ExecutionId, "supervisor_journal_fsynced", map[string]any{"command_id": r.CommandId})
	// The first prompt's dispatch record: the create's receipt names the execution before the host sees the prompt.
	r.ExecutionId = &execution.ExecutionId
	r.Result = &created
	s.receiptUpdated(*r)
	images := 0
	if fp.Attachments != nil {
		images = len(*fp.Attachments)
	}
	accepted, err := w.host.prompt(images)
	if err != nil {
		latch(w, r.CommandId)
		s.persist(w)
		return err
	}
	execution.Disposition = ptr("started")
	s.persist(w)
	result := maps.Clone(created)
	result["interrupt_marker"] = false
	if images > 0 {
		result["accepted_images"] = accepted
		for _, a := range *fp.Attachments {
			s.releaseNow(a.AttachmentId, r.CommandId)
		}
	}
	deliver(r, "forwarded", result)
	r.Admission, r.Disposition = ptr(b2.ReceiptAdmission("accepted")), ptr("started")
	r.HistoryLag = ptr(false)
	return nil
}

// resumable: a catalog session no other worker holds, whose last owner's cleanup is proven and fence resolved.
func (s *state) resumable(sessionID, except string, holder **worker) error {
	var last *worker
	for _, id := range s.order {
		o := s.workers[id]
		if derefString(o.row.SessionId) != sessionID {
			continue
		}
		last = o
		if id != except && holding(o.row.Status) && o.row.Status != "cleanup_pending" {
			r := refuse("session_already_bound")
			r.body.HolderWorkerId = ptr(id)
			return r
		}
	}
	if last == nil {
		return refuse("unknown_session")
	}
	if last.row.Status == "cleanup_pending" && last.row.WorkerId != except {
		return refuse("target_cleanup_unproven")
	}
	if last.row.Fence != nil && last.row.WorkerId != except {
		return refuse("target_session_fenced").uncertain(last.row.Fence.CommandId)
	}
	*holder = last
	return nil
}

func (s *state) dispatchChild(w *worker, item queuedItem) (*b2.Receipt, error) {
	rec := s.receipts[item.commandID]
	dispatch(&rec.Receipt)
	child, err := s.create(item.child.Launch, &createOpts{parentWorkerID: w.row.WorkerId, parentCommandID: item.commandID})
	var ref *refusal
	switch {
	case errors.As(err, &ref) && ref.body.Effect == b2.NoEffect:
		rec.State, rec.Stage, rec.Effect, rec.Error = stRejected, "refused", "no_effect", ptr(ref.body.Error)
	case err != nil || child.Effect == "unknown":
		rec.State, rec.Stage, rec.Effect = stOutcomeUnknown, "unknown", "unknown"
		latch(w, item.commandID)
	default:
		deliver(&rec.Receipt, "forwarded", map[string]any{"child_command_id": child.CommandId, "child_worker_id": derefString(child.WorkerId)})
	}
	r := rec.Receipt
	return &r, nil
}

// --- input ---

// prompt runs sessions.prompt, or a due queued follow-up (op sessions.follow_up, request its original body, so the
// receipt's request hash matches and it runs once more from queue_ready).
func (s *state) prompt(id string, p b2.Prompt, op string, request any) (*b2.Receipt, error) {
	var w *worker
	busy := ""
	receipt, err := s.run(id, p.CommandId, op, map[string]any{"body": request, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := all(func() error { return binding(w, p.WorkerEpoch, p.SessionId, p.BindingRevision) }, func() error { return writable(w) }, func() error { return ready(w) }); err != nil {
			return err
		}
		if strings.HasPrefix(strings.TrimLeft(p.Message, " \t\n"), "/") {
			return refuse("slash_commands_use_typed_methods")
		}
		if p.Attachments != nil && len(*p.Attachments) > 0 {
			if err := s.forPrompt(id, *p.Attachments); err != nil {
				return err
			}
		}
		if w.row.Foreground != "idle" {
			mode := "reject"
			if op == "sessions.prompt" && p.IfBusy != nil {
				mode = string(*p.IfBusy)
			}
			if mode == "reject" || w.row.Execution == nil {
				return refuse("worker_busy")
			}
			if mode == "steer" && p.Attachments != nil && len(*p.Attachments) > 0 {
				return refuse("attachments_need_idle_or_follow_up")
			}
			if mode == "follow_up" {
				if err := checkQueue(w); err != nil {
					return err
				}
			}
			busy = mode
		}
		return nil
	}, func(r *b2.Receipt) error {
		switch busy {
		case "follow_up":
			s.enqueue(w, r, queuedItem{commandID: p.CommandId, op: op, prompt: &p, request: request})
			return nil
		case "steer":
			dispatch(r)
			r.ExecutionId = &w.row.Execution.ExecutionId
			deliver(r, "forwarded", nil)
			r.Admission, r.Disposition = ptr(b2.ReceiptAdmission("accepted")), ptr("queued")
			return nil
		}
		execution := &b2.Execution{ExecutionId: s.id("x"), CommandId: p.CommandId, State: "admitted"}
		w.row.Execution = execution
		w.row.Foreground = "running"
		w.observedIdle = false
		s.persist(w)
		s.publish("execution.admitted", id, &execution.ExecutionId, "supervisor_journal_fsynced", map[string]any{"command_id": p.CommandId})
		dispatch(r)
		r.ExecutionId = &execution.ExecutionId
		images := 0
		if p.Attachments != nil {
			images = len(*p.Attachments)
		}
		accepted, err := w.host.prompt(images)
		if err != nil {
			return err
		}
		execution.Disposition = ptr("started")
		s.persist(w)
		result := map[string]any{"interrupt_marker": false}
		if images > 0 {
			// With attachments, the number of images pi put in the message (input.ts).
			result["accepted_images"] = accepted
		}
		deliver(r, "forwarded", result)
		r.Admission, r.Disposition = ptr(b2.ReceiptAdmission("accepted")), ptr("started")
		r.HistoryLag = ptr(false)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if w != nil && receipt.State == stOutcomeUnknown && !resolved(w, p.CommandId) {
		s.uncertain(w, p.CommandId)
		s.persist(w)
	}
	if receipt.State == stDelivered && receipt.Admission != nil && *receipt.Admission == "accepted" && p.Attachments != nil {
		for _, a := range *p.Attachments {
			s.releaseNow(a.AttachmentId, p.CommandId)
		}
	}
	return receipt, nil
}

func (s *state) followUp(id string, fu b2.FollowUp) (*b2.Receipt, error) {
	var w *worker
	return s.run(id, fu.CommandId, "sessions.follow_up", map[string]any{"body": fu, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := all(func() error { return binding(w, fu.WorkerEpoch, fu.SessionId, fu.BindingRevision) }, func() error { return writable(w) }, func() error { return ready(w) }); err != nil {
			return err
		}
		if strings.HasPrefix(strings.TrimLeft(fu.Message, " \t\n"), "/") {
			return refuse("slash_commands_use_typed_methods")
		}
		if w.row.Execution == nil || w.row.Execution.ExecutionId != fu.ExecutionId {
			return refuse("stale_execution")
		}
		return checkQueue(w)
	}, func(r *b2.Receipt) error {
		p := b2.Prompt{CommandId: fu.CommandId, WorkerEpoch: fu.WorkerEpoch, SessionId: fu.SessionId, BindingRevision: fu.BindingRevision, Message: fu.Message}
		s.enqueue(w, r, queuedItem{commandID: fu.CommandId, op: "sessions.follow_up", prompt: &p, request: fu})
		return nil
	})
}

func (s *state) launchChild(id string, c b2.ChildLaunch) (*b2.Receipt, error) {
	var w *worker
	return s.run(id, c.CommandId, "children.launch", map[string]any{"body": c, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := all(func() error { return binding(w, c.WorkerEpoch, c.SessionId, c.BindingRevision) }, func() error { return writable(w) }); err != nil {
			return err
		}
		if c.Launch.Parent != nil || c.Launch.LaunchSpec != nil {
			return refuse("typed_children_use_workers_create")
		}
		if err := ready(w); err != nil {
			return err
		}
		if w.row.Execution == nil || w.row.Execution.ExecutionId != c.ExecutionId {
			return refuse("stale_execution")
		}
		return checkQueue(w)
	}, func(r *b2.Receipt) error {
		s.enqueue(w, r, queuedItem{commandID: c.CommandId, op: "children.launch", child: &c})
		return nil
	})
}

const queueCap = 32

func checkQueue(w *worker) error {
	if len(w.pending) >= queueCap {
		return refuse("queue_capacity")
	}
	return nil
}

func (s *state) enqueue(w *worker, r *b2.Receipt, item queuedItem) {
	w.pending = append(w.pending, item)
	kind := b2.QueuedInputKind("follow_up")
	if item.op == "children.launch" {
		kind = "child"
	}
	w.row.Queued = ptr(append(deref(w.row.Queued), b2.QueuedInput{CommandId: item.commandID, Kind: kind, State: "queued"}))
	r.State, r.Stage, r.Effect, r.Admission = stQueued, "reserved", "no_effect", ptr(b2.ReceiptAdmission("queued"))
	s.persist(w)
}

func queuedRow(w *worker, commandID string) *b2.QueuedInput {
	for i := range deref(w.row.Queued) {
		if q := &(*w.row.Queued)[i]; q.CommandId == commandID {
			return q
		}
	}
	return nil
}

// flush dispatches due queued input one at a time, never under a fence or while the worker is busy.
func (s *state) flush(w *worker) {
	for {
		if w.row.Fence != nil || w.row.Status != "ready" || w.row.Foreground != "idle" || w.host == nil || w.exited {
			return
		}
		i := slices.IndexFunc(w.pending, func(q queuedItem) bool { return s.receipts[q.commandID].State == stQueued })
		if i < 0 {
			return
		}
		item := w.pending[i]
		w.pending = slices.Delete(w.pending, i, i+1)
		q := queuedRow(w, item.commandID)
		rec := s.receipts[item.commandID]
		rec.State, rec.Stage, rec.Effect = stQueueReady, "reserved", "no_effect"
		var r *b2.Receipt
		var err error
		if item.op == "children.launch" {
			if err = all(func() error {
				return binding(w, item.child.WorkerEpoch, item.child.SessionId, item.child.BindingRevision)
			}, func() error { return writable(w) }); err == nil {
				r, err = s.dispatchChild(w, item)
			}
		} else {
			r, err = s.prompt(w.row.WorkerId, *item.prompt, item.op, item.request)
		}
		if err != nil {
			if rec.State == stQueued || rec.State == stQueueReady {
				rec.State, rec.Stage, rec.Effect, rec.Error = stRejected, "refused", "no_effect", ptr(err.Error())
			}
			if q != nil {
				q.State = "dropped"
			}
		} else if q != nil {
			if r.Effect == "no_effect" {
				q.State = "dropped"
			} else {
				q.State = "dispatched"
			}
		}
		s.persist(w)
	}
}

// dropQueued drops every queued input; their intents end no_effect.
func (s *state) dropQueued(w *worker) {
	for i := range deref(w.row.Queued) {
		q := &(*w.row.Queued)[i]
		if q.State != "queued" && q.State != "paused" && q.State != "recovered" {
			continue
		}
		q.State = "dropped"
		if r := s.receipts[q.CommandId]; r != nil && slices.Contains([]b2.ReceiptState{stQueued, stQueueReady, stIntentReady, stIntentRecovered}, r.State) {
			r.State, r.Stage, r.Effect, r.Disposition = stRejected, "refused", "no_effect", ptr("abandoned_without_dispatch")
		}
	}
	w.pending = nil
}

// control is executions.cancel and executions.interrupt: allowed under a fence, never lifting it.
func (s *state) control(id string, b b2.Control, op string) (*b2.Receipt, error) {
	var w *worker
	return s.run(id, b.CommandId, op, map[string]any{"body": b, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := binding(w, b.WorkerEpoch, b.SessionId, b.BindingRevision); err != nil {
			return err
		}
		if b.ExecutionId != nil && (w.row.Execution == nil || w.row.Execution.ExecutionId != *b.ExecutionId) {
			return refuse("stale_execution")
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		r.ExecutionId = executionOf(w)
		s.dropQueued(w)
		s.interrupt(w)
		s.persist(w)
		if w.host == nil || w.exited || w.row.Status != "ready" {
			deliver(r, "requested", map[string]any{"requested": true, "disposition": "unknown", "profile": "no_live_host"})
			return nil
		}
		// The fixture host acknowledges clear_queue and abort; it never invents a settlement (Host.Emit does).
		disposition := "unknown"
		if w.row.Execution != nil && w.row.Execution.State == "settled" {
			disposition = "settled"
		}
		deliver(r, "requested", map[string]any{"requested": true, "disposition": disposition, "external_effects_stopped": "unproven"})
		return nil
	})
}

// --- fence resolution ---

func (s *state) settled(w *worker, executionID, commandID string) bool {
	for _, st := range s.settlements {
		if st.workerID == w.row.WorkerId && st.sessionID == derefString(w.row.SessionId) && st.executionID == executionID && st.commandID == commandID {
			return true
		}
	}
	return false
}

func (s *state) resolve(id string, rv b2.Resolve) (*b2.Receipt, error) {
	var w *worker
	uncertain := ""
	receipt, err := s.run(id, rv.CommandId, "sessions.resolve_unknown", map[string]any{"body": rv, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := binding(w, rv.WorkerEpoch, rv.SessionId, rv.BindingRevision); err != nil {
			return err
		}
		if (rv.UncertainCommandId != nil) == (rv.ExecutionId != nil) {
			return refuse("name_exactly_one_uncertain_command_or_execution")
		}
		if rv.UncertainCommandId != nil {
			uncertain = *rv.UncertainCommandId
		} else {
			// The first receipt of this worker naming the execution, in recording order: the command that admitted it,
			// never a steer that joined it later (fence.ts).
			for _, cmd := range s.receiptOrder {
				if r := s.receipts[cmd]; derefString(r.WorkerId) == id && derefString(r.ExecutionId) == *rv.ExecutionId {
					uncertain = cmd
					break
				}
			}
			if uncertain == "" && w.row.Execution != nil && w.row.Execution.ExecutionId == *rv.ExecutionId {
				uncertain = w.row.Execution.CommandId
			}
		}
		target := s.receipts[uncertain]
		recovered := target != nil && derefString(target.WorkerId) == id && (target.State == stIntentRecovered || target.State == stIntentReady)
		current := derefInt(w.row.FenceGeneration)
		if w.row.Fence != nil {
			current = w.row.Fence.FenceGeneration
		}
		if rv.FenceGeneration != current {
			r := refuse("wrong_fence_generation")
			if w.row.Fence != nil {
				r.uncertain(w.row.Fence.CommandId)
			}
			return r
		}
		if w.row.Fence != nil && !slices.Contains(uncertainIDs(w.row.Fence), uncertain) || w.row.Fence == nil && !recovered {
			return refuse("uncertainty_not_current")
		}
		if rv.Disposition == "observed" {
			execution := derefString(rv.ExecutionId)
			if execution == "" && target != nil {
				execution = derefString(target.ExecutionId)
			}
			if execution == "" && w.row.Execution != nil && w.row.Execution.CommandId == uncertain {
				execution = w.row.Execution.ExecutionId
			}
			if execution == "" || !s.settled(w, execution, uncertain) {
				return refuse("execution_settlement_not_in_session_file_or_fsynced_record")
			}
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		resolution := b2.Resolution{CommandId: uncertain, Disposition: b2.ResolutionDisposition(rv.Disposition), FenceGeneration: rv.FenceGeneration}
		w.row.Resolutions = ptr(append(deref(w.row.Resolutions), resolution))
		var remaining []string
		if w.row.Fence != nil {
			for _, x := range uncertainIDs(w.row.Fence) {
				if x != uncertain {
					remaining = append(remaining, x)
				}
			}
		}
		if len(remaining) > 0 {
			gen := derefInt(w.row.FenceGeneration) + 1
			w.row.Fence = &b2.Fence{CommandId: remaining[0], UncertainCommandIds: &remaining, FenceGeneration: gen}
			w.row.FenceGeneration = &gen
		} else {
			w.row.Fence = nil
			if w.host != nil && !w.observedIdle {
				w.row.Foreground = "running"
			} else {
				w.row.Foreground = "idle"
			}
			if rv.Disposition != "abandon" {
				for i := range deref(w.row.Queued) {
					if q := &(*w.row.Queued)[i]; q.State == "paused" {
						q.State = "queued"
					}
				}
			}
		}
		if rv.Disposition == "abandon" {
			s.dropQueued(w)
		}
		s.persist(w)
		var fence any = w.row.Fence
		if w.row.Fence == nil {
			fence = nil
		}
		s.publish("fence.resolved", id, executionOf(w), "supervisor_journal_fsynced", map[string]any{
			"command_id": uncertain, "disposition": rv.Disposition, "fence_generation": rv.FenceGeneration, "external_effects_undone": false, "fence": fence,
		})
		if t := s.receipts[uncertain]; t != nil && (t.State == stIntentRecovered || t.State == stIntentReady) {
			if rv.Disposition == "keep" {
				t.State, t.Stage, t.Effect = stIntentReady, "recovery_pending", "no_effect"
			} else if rv.Disposition == "abandon" {
				t.State, t.Stage, t.Effect, t.Disposition = stRejected, "refused", "no_effect", ptr("abandoned_without_dispatch")
			}
		}
		deliver(r, "resolved", map[string]any{"command_id": uncertain, "disposition": rv.Disposition, "fence_generation": rv.FenceGeneration, "external_effects_undone": false, "fence": fence})
		return nil
	})
	if err == nil && rv.Disposition != "abandon" && w != nil {
		s.flush(w)
	}
	return receipt, err
}

// --- binding moves ---

func (s *state) move(id string, b b2.Rebind, op string, request any) (*b2.Receipt, error) {
	var w *worker
	var holder *worker
	return s.run(id, b.CommandId, op, map[string]any{"body": request, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := all(func() error { return writable(w) }, func() error { return binding(w, b.WorkerEpoch, b.SessionId, b.BindingRevision) }); err != nil {
			return err
		}
		if w.row.Status != "ready" || w.host == nil || w.exited {
			return refuse("cleanup_pending_or_worker_not_ready")
		}
		if w.row.Foreground != "idle" {
			return refuse("binding_change_requires_idle")
		}
		switch b.Action {
		case "fork", "navigate":
			if b.SourceLeafId == nil || derefString(w.row.LeafId) != *b.SourceLeafId || w.row.LeafId == nil {
				return refuse("stale_source_leaf")
			}
			if b.EntryId == nil || *b.EntryId == "" {
				return refuse("unknown_fork_entry")
			}
		case "resume":
			if b.TargetSessionId == nil {
				return refuse("target_session_id_required")
			}
			return s.resumable(*b.TargetSessionId, id, &holder)
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		s.interrupt(w)
		s.dropQueued(w)
		session := derefString(w.row.SessionId)
		switch b.Action {
		case "new", "fork":
			session = s.id("s")
		case "resume":
			session = *b.TargetSessionId
		}
		w.row.SessionId = &session
		w.row.BindingRevision++
		w.row.SessionIdentityEvidence = "pi_sdk_session_id"
		s.bindSession(w, session)
		w.row.Execution = nil
		w.row.Foreground = "idle"
		w.observedIdle = true
		s.persist(w)
		s.publish("session.rebound", id, nil, "supervisor_journal_fsynced", map[string]any{"session_id": session, "binding_revision": w.row.BindingRevision, "action": b.Action})
		deliver(r, "forwarded", map[string]any{"session_id": session, "binding_revision": w.row.BindingRevision})
		return nil
	})
}

// --- stop ---

func (s *state) stop(id string, b b2.Binding) (*b2.Receipt, error) {
	var w *worker
	return s.run(id, b.CommandId, "workers.stop", map[string]any{"body": b, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		return binding(w, b.WorkerEpoch, b.SessionId, b.BindingRevision)
	}, func(r *b2.Receipt) error {
		dispatch(r)
		epoch := w.row.WorkerEpoch
		result := func(termination string) map[string]any {
			return map[string]any{"termination": termination, "stopped_worker_epoch": epoch, "current_worker_epoch": w.row.WorkerEpoch}
		}
		if w.row.Status == "stopped" || w.row.Status == "failed" {
			deliver(r, "termination_observed", result("observed_stopped"))
			return nil
		}
		if e := w.row.Execution; e != nil && e.State != "settled" {
			s.uncertain(w, e.CommandId)
		}
		s.interrupt(w)
		// A live host stops and is observed gone. Without one (lost, or never adopted after a restart) only a
		// confirmable process identity proves cleanup.
		gone := (w.host != nil && !w.exited) || s.f.opts.Profile != ProfileUnconfirmedNativeIdentity
		w.host = nil
		w.exited = true
		if !gone {
			s.setStatus(w, "cleanup_pending")
			w.row.Cleanup = "unresolved"
			s.persist(w)
			r.State, r.Stage, r.Effect = stOutcomeUnknown, "unknown", "unknown"
			res := result("unknown")
			r.Result = &res
			return nil
		}
		s.setStatus(w, "stopped")
		w.row.Cleanup = "process_group_observed_gone; escaped_descendants_unproven"
		s.persist(w)
		deliver(r, "termination_observed", result("observed_stopped"))
		return nil
	})
}

// --- session writes: configure, compact, reload, commands.invoke ---

// check, when given, runs after the binding, fence and readiness checks and before the busy check, as the worker's
// per-command checks do.
func (s *state) sessionWrite(id, op, commandID, epoch, sessionID string, revision int, request any, check func(w *worker) error, apply func(w *worker) map[string]any) (*b2.Receipt, error) {
	var w *worker
	return s.run(id, commandID, op, map[string]any{"body": request, "worker_id": id}, func() error {
		var err error
		if w, err = s.require(id); err != nil {
			return err
		}
		if err := all(func() error { return binding(w, epoch, sessionID, revision) }, func() error { return writable(w) }, func() error { return ready(w) }); err != nil {
			return err
		}
		if check != nil {
			if err := check(w); err != nil {
				return err
			}
		}
		if w.row.Foreground != "idle" {
			return refuse("worker_busy")
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		result := apply(w)
		s.persist(w)
		deliver(r, "forwarded", result)
		return nil
	})
}

// okResult is the result of an operation's "ok" wire fixture (what pi reported), for writes the fake only acknowledges.
func okResult(op string) map[string]any {
	for _, f := range WireFixtures(op) {
		if f.Response.Status == http.StatusOK {
			var body struct {
				Result map[string]any `json:"result"`
			}
			json.Unmarshal(f.Response.Body, &body)
			return body.Result
		}
	}
	return nil
}

// --- restart ---

// restart discards the supervisor's memory and recovers from its durable records (the disk rows, receipts,
// settlements and staged attachments); a new epoch; no host is adopted.
func (s *state) restart() {
	s.endStreams()
	s.gen++
	s.supervisorEpoch = s.id("sup")
	s.seq = 0
	for _, r := range s.receipts {
		switch r.State {
		case stIntent, stQueued, stQueueReady, stIntentReady:
			r.State, r.Stage, r.Effect = stIntentRecovered, "recovery_pending", "no_effect"
			r.Error = ptr("restart before dispatch; eligible once after owner resolution, never auto-replayed")
		case stAccepted:
			r.State, r.Stage, r.Effect = stOutcomeUnknown, "unknown", "unknown"
		}
	}
	s.receiving = map[string]*attachment{}
	s.answerSigs = map[string]answerSig{}
	for _, id := range s.order {
		old := s.workers[id]
		// No resolver survives a restart: every live interaction is interrupted, never re-opened.
		for _, in := range old.interactions {
			if t := old.timers[in.InteractionId]; t != nil {
				t.Stop()
			}
			in.Status = "interrupted"
			old.closed[in.InteractionId] = durableRecord(in)
		}
		w := &worker{row: clone(s.disk[id]), closed: old.closed, timers: map[string]*time.Timer{}}
		s.workers[id] = w
		w.row.SupervisorEpoch = s.supervisorEpoch
		w.row.PendingInteractions = []json.RawMessage{}
		// Fence recovery: the owner's resolutions stand; every unresolved unknown session write fences again.
		for _, cmd := range sorted(s.receipts) {
			r := s.receipts[cmd]
			// A create whose first prompt was dispatched (its receipt names the execution) wrote the session too.
			firstPrompt := r.Operation == "workers.create" && r.ExecutionId != nil
			if derefString(r.WorkerId) == id && r.State == stOutcomeUnknown && (sessionDirected[string(r.Operation)] || firstPrompt) && !resolved(w, cmd) {
				latch(w, cmd)
			}
		}
		// Input recovery: queued input is recovered; an unsettled execution's outcome is unknown.
		for i := range deref(w.row.Queued) {
			if q := &(*w.row.Queued)[i]; q.State != "dropped" && q.State != "dispatched" {
				q.State = "recovered"
			}
		}
		if e := w.row.Execution; e != nil && e.State != "settled" {
			if r := s.receipts[e.CommandId]; r != nil && r.Effect == "no_effect" && (r.State == stIntentRecovered || r.State == stRejected) {
				e.State, e.Disposition = "settled", ptr("no_effect_before_dispatch")
				recordSettlement(w, "no_effect_before_dispatch")
				w.row.Foreground = "idle"
			} else if !resolved(w, e.CommandId) || w.row.Status == "ready" || w.row.Status == "starting" {
				s.uncertain(w, e.CommandId)
			}
		}
		if holding(w.row.Status) {
			s.setStatus(w, "cleanup_pending")
			if s.f.opts.Profile == ProfileUnconfirmedNativeIdentity {
				w.row.Cleanup = "unresolved"
			} else {
				w.row.Cleanup = "process_group_killed_at_restart; escaped_descendants_unproven"
			}
		}
		s.persist(w)
	}
}
