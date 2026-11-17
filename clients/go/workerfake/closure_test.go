package workerfake_test

// The closure test of b2-for-shep.md section 2.1 (plan P1-17), Go half: every method of the bridge grant profile
// has a route and a wire fixture, the fake answers it, and every wire fixture round-trips through the Go client's
// typed call (so the Go models decode every documented reply, refusals included). The Node half
// (tools/codegen/check-profiles.mjs, in npm run api:lint) proves the profile equals the section 2.1 table.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

// pathArgs lists the fixture's path parameters in the order the operation's path names them.
func pathArgs(op b2.Operation, fx workerfake.WireFixture) []string {
	var out []string
	for _, seg := range strings.Split(op.Path, "/") {
		if strings.HasPrefix(seg, "{") {
			out = append(out, fx.Request.Path[strings.Trim(seg, "{}")])
		}
	}
	return out
}

func qs(fx workerfake.WireFixture, name string) *string {
	if v, ok := fx.Request.Query[name]; ok {
		return &v
	}
	return nil
}

func qi(t *testing.T, fx workerfake.WireFixture, name string) *int {
	v := qs(fx, name)
	if v == nil {
		return nil
	}
	n, err := strconv.Atoi(*v)
	if err != nil {
		t.Fatalf("%s/%s: query %s: %v", fx.Op, fx.Name, name, err)
	}
	return &n
}

func qb(t *testing.T, fx workerfake.WireFixture, name string) *bool {
	v := qs(fx, name)
	if v == nil {
		return nil
	}
	b, err := strconv.ParseBool(*v)
	if err != nil {
		t.Fatalf("%s/%s: query %s: %v", fx.Op, fx.Name, name, err)
	}
	return &b
}

func reqBody[T any](t *testing.T, fx workerfake.WireFixture) T {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(fx.Request.Body, &m); err != nil {
		t.Fatalf("%s/%s: body: %v", fx.Op, fx.Name, err)
	}
	v, err := strict[T](m)
	if err != nil {
		t.Fatalf("%s/%s: the Go model does not take the fixture body: %v", fx.Op, fx.Name, err)
	}
	return v
}

// callFixture sends a fixture's request through the operation's typed Go call and returns the decoded reply.
func callFixture(t *testing.T, ctx context.Context, c *b2.Client, fx workerfake.WireFixture, live bool) (any, error) {
	t.Helper()
	op := operation(t, fx.Op)
	p := pathArgs(op, fx)
	switch fx.Op {
	case "hello":
		return c.Hello(ctx)
	case "workers.list":
		return c.WorkersList(ctx)
	case "workers.get":
		return c.WorkersGet(ctx, p[0])
	case "workers.create":
		return c.WorkersCreate(ctx, reqBody[b2.Create](t, fx))
	case "workers.stop":
		return c.WorkersStop(ctx, p[0], reqBody[b2.Binding](t, fx))
	case "workers.relaunch":
		return c.WorkersRelaunch(ctx, p[0], reqBody[b2.Binding](t, fx))
	case "session.configure":
		return c.SessionConfigure(ctx, p[0], reqBody[b2.Configure](t, fx))
	case "sessions.compact":
		return c.SessionsCompact(ctx, p[0], reqBody[b2.Compact](t, fx))
	case "resources.reload":
		return c.ResourcesReload(ctx, p[0], reqBody[b2.Binding](t, fx))
	case "commands.invoke":
		return c.CommandsInvoke(ctx, p[0], reqBody[b2.Invoke](t, fx))
	case "sessions.prompt":
		return c.SessionsPrompt(ctx, p[0], reqBody[b2.Prompt](t, fx))
	case "sessions.follow_up":
		return c.SessionsFollowUp(ctx, p[0], reqBody[b2.FollowUp](t, fx))
	case "sessions.steer":
		return c.SessionsSteer(ctx, p[0], reqBody[b2.Steer](t, fx))
	case "sessions.rebind":
		return c.SessionsRebind(ctx, p[0], reqBody[b2.Rebind](t, fx))
	case "sessions.new":
		return c.SessionsNew(ctx, p[0], reqBody[b2.Binding](t, fx))
	case "sessions.resolve_unknown":
		return c.SessionsResolveUnknown(ctx, p[0], reqBody[b2.Resolve](t, fx))
	case "executions.cancel":
		return c.ExecutionsCancel(ctx, p[0], reqBody[b2.Control](t, fx))
	case "executions.interrupt":
		return c.ExecutionsInterrupt(ctx, p[0], reqBody[b2.Control](t, fx))
	case "children.launch":
		return c.ChildrenLaunch(ctx, p[0], reqBody[b2.ChildLaunch](t, fx))
	case "children.report":
		return c.ChildrenReport(ctx, p[0], reqBody[b2.Report](t, fx))
	case "interactions.list":
		return c.InteractionsList(ctx, p[0])
	case "interactions.status":
		return c.InteractionsStatus(ctx, p[0], b2.InteractionsStatusParams{InteractionId: *qs(fx, "interaction_id")})
	case "interactions.answer_if_current":
		return c.InteractionsAnswerIfCurrent(ctx, p[0], reqBody[b2.Answer](t, fx))
	case "history.page":
		return c.HistoryPage(ctx, p[0], &b2.HistoryPageParams{Watermark: qs(fx, "watermark"), After: qs(fx, "after"), Limit: qi(t, fx, "limit")})
	case "items.read":
		return c.ItemsRead(ctx, p[0], p[1])
	case "files.read":
		return c.FilesRead(ctx, p[0], reqBody[b2.FileRead](t, fx))
	case "attachments.status":
		return c.AttachmentsStatus(ctx, p[0])
	case "attachments.release":
		return c.AttachmentsRelease(ctx, p[0], reqBody[b2.Release](t, fx))
	case "attachments.stage":
		h := fx.Request.Headers
		rev, _ := strconv.Atoi(h["Piw-Binding-Revision"])
		data, err := base64.StdEncoding.DecodeString(fx.Request.BodyBase64)
		if err != nil {
			t.Fatal(err)
		}
		params := b2.AttachmentsStageParams{PiwCommandId: h["Piw-Command-Id"], PiwWorkerId: h["Piw-Worker-Id"], PiwWorkerEpoch: h["Piw-Worker-Epoch"], PiwSessionId: h["Piw-Session-Id"], PiwBindingRevision: rev, PiwContentSha256: h["Piw-Content-Sha256"]}
		return c.AttachmentsStage(ctx, p[0], params, h["Content-Type"], int64(len(data)), bytes.NewReader(data))
	case "sessions.list":
		return c.SessionsList(ctx, &b2.SessionsListParams{Cwd: qs(fx, "cwd"), Limit: qi(t, fx, "limit")})
	case "sessions.get":
		return c.SessionsGet(ctx, p[0])
	case "sessions.history":
		params := &b2.SessionsHistoryParams{Offset: qi(t, fx, "offset"), MaxBytes: qi(t, fx, "max_bytes"), Identity: qs(fx, "identity"), Tail: qs(fx, "tail"), Prefix: qs(fx, "prefix")}
		if f := qs(fx, "format"); f != nil {
			params.Format = (*b2.SessionsHistoryParamsFormat)(f)
		}
		return c.SessionsHistory(ctx, p[0], params)
	case "models.list":
		return c.ModelsList(ctx, &b2.ModelsListParams{WorkerId: qs(fx, "worker_id"), Cwd: qs(fx, "cwd"), ProjectTrusted: qb(t, fx, "project_trusted")})
	case "commands.list":
		return c.CommandsList(ctx, &b2.CommandsListParams{WorkerId: qs(fx, "worker_id"), Cwd: qs(fx, "cwd"), ProjectTrusted: qb(t, fx, "project_trusted")})
	case "blobs.read":
		index, err := strconv.Atoi(p[2])
		if err != nil {
			t.Fatal(err)
		}
		return c.BlobsRead(ctx, p[0], p[1], index)
	case "receipts.get":
		return c.ReceiptsGet(ctx, p[0])
	case "events.subscribe":
		opts := b2.WatchOptions{}
		if v := qs(fx, "worker_id"); v != nil {
			opts.WorkerIDs = strings.Split(*v, ",")
		}
		if v := qs(fx, "types"); v != nil {
			opts.Types = strings.Split(*v, ",")
		}
		var frames []json.RawMessage
		// A fixture stream ends after its frames; a live one is read up to its snapshot.
		err := c.Watch(ctx, opts, func(f b2.Frame) bool { frames = append(frames, f.Raw); return !live })
		var resync *b2.ResyncRequired
		if errors.As(err, &resync) && resync.Reason == "disconnected" {
			// The fixture's stream ends after its frames.
			return frames, nil
		}
		return frames, err
	}
	t.Fatalf("no Go call for %s", fx.Op)
	return nil, nil
}

func operation(t *testing.T, id string) b2.Operation {
	t.Helper()
	for _, op := range b2.Operations {
		if op.ID == id {
			return op
		}
	}
	t.Fatalf("%s: no route", id)
	return b2.Operation{}
}

// dropNulls removes null members, so a null the model omits compares equal to an absent one.
func dropNulls(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			if e != nil {
				out[k] = dropNulls(e)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = dropNulls(e)
		}
		return out
	}
	return v
}

func plain(t *testing.T, raw []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return dropNulls(v)
}

// checkReply asserts that a typed reply (or failure) is exactly the fixture's response.
func checkReply(t *testing.T, fx workerfake.WireFixture, got any, err error) {
	t.Helper()
	want := fx.Response
	where := fx.Op + "/" + fx.Name
	if want.Status != http.StatusOK {
		var f *b2.ClientFailure
		if !errors.As(err, &f) || f.Body == nil {
			t.Fatalf("%s: want HTTP %d refusal, got %v %v", where, want.Status, got, err)
		}
		if f.Status != want.Status || f.Effect != f.Body.Effect || !reflect.DeepEqual(dropNulls(generic(t, f.Body)), plain(t, want.Body)) {
			t.Fatalf("%s: refusal %d %+v (effect %s), want %d %s", where, f.Status, *f.Body, f.Effect, want.Status, want.Body)
		}
		return
	}
	if err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	switch v := got.(type) {
	case *b2.HistoryBytes:
		wantHeaders := map[string]string{
			"Piw-Session-Id": v.SessionID, "Piw-File-Identity": v.FileIdentity, "Piw-Offset": strconv.FormatInt(v.Offset, 10),
			"Piw-Next-Offset": strconv.FormatInt(v.NextOffset, 10), "Piw-Watermark": strconv.FormatInt(v.Watermark, 10),
			"Piw-Reset": strconv.FormatBool(v.Reset), "Piw-Prefix-Sha256": v.PrefixSha256, "Piw-History-Line-Max": strconv.FormatInt(v.LineMax, 10),
		}
		if v.TailSha256 != "" {
			wantHeaders["Piw-Tail-Sha256"] = v.TailSha256
		}
		if !reflect.DeepEqual(wantHeaders, want.Headers) || want.BodyText == nil || string(v.Body) != *want.BodyText {
			t.Fatalf("%s: history reply %+v differs from the fixture", where, v)
		}
	case *b2.Blob:
		data, _ := base64.StdEncoding.DecodeString(*want.BodyBase64)
		h := want.Headers
		if v.ContentType != want.ContentType || !bytes.Equal(v.Body, data) || h["Piw-Session-Id"] != v.SessionID || h["Piw-Entry-Id"] != v.EntryID || h["Piw-Blob-Index"] != strconv.Itoa(v.Index) || h["Piw-Blob-Sha256"] != v.Sha256 {
			t.Fatalf("%s: blob reply differs from the fixture", where)
		}
	case []json.RawMessage:
		if len(v) != len(want.Frames) {
			t.Fatalf("%s: %d frames, want %d", where, len(v), len(want.Frames))
		}
		for i := range v {
			if !reflect.DeepEqual(plain(t, v[i]), plain(t, want.Frames[i])) {
				t.Fatalf("%s: frame %d differs", where, i)
			}
		}
	default:
		if g, w := dropNulls(generic(t, got)), plain(t, want.Body); !reflect.DeepEqual(g, w) {
			gj, _ := json.Marshal(g)
			t.Fatalf("%s: reply through the Go model\n got  %s\n want %s", where, gj, want.Body)
		}
	}
}

func TestBridgeProfileClosure(t *testing.T) {
	bridge := b2.GrantProfiles["bridge"]
	if len(bridge) == 0 {
		t.Fatal("no bridge profile in the spec")
	}
	stateful := workerfake.StatefulOps()
	for _, m := range bridge {
		operation(t, m)
		if len(workerfake.WireFixtures(m)) == 0 {
			t.Errorf("%s: no wire fixture", m)
		}
	}
	for _, m := range stateful {
		operation(t, m)
	}
	// The bridge profile excludes the agent-side and owner methods (b2-for-shep.md 2.1, "Not in the bridge profile").
	for _, m := range []string{"children.launch", "children.report", "workers.relaunch", "sessions.steer", "sessions.follow_up", "executions.cancel"} {
		if slices.Contains(bridge, m) {
			t.Errorf("%s must not be in the bridge profile", m)
		}
	}
}

// Every wire fixture of every operation, through the Go client against the replay fake: the reply decodes into
// the Go model and equals the fixture.
func TestReplayAnswersEveryWireFixtureThroughTheGoClient(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{Replay: true, Methods: workerfake.AllMethods()})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := fake.Client()
	seen := map[string]bool{}
	for _, op := range workerfake.WireOps() {
		for _, fx := range workerfake.WireFixtures(op) {
			got, err := callFixture(t, ctx, c, fx, false)
			checkReply(t, fx, got, err)
			seen[op] = true
		}
	}
	for _, op := range b2.Operations {
		if !seen[op.ID] {
			t.Errorf("%s: no wire fixture replayed", op.ID)
		}
	}
	// A request no fixture names is refused, never answered with a guess.
	if _, err := c.WorkersGet(ctx, "no-such-worker"); !isRefusal(err, http.StatusNotFound, "fixture_not_found") {
		t.Fatalf("unmatched request: %v", err)
	}
}

// Replay matches a request exactly, so two fixtures of one operation must not share a request.
func TestWireFixtureRequestsAreDistinct(t *testing.T) {
	for _, op := range workerfake.WireOps() {
		seen := map[string]string{}
		for _, fx := range workerfake.WireFixtures(op) {
			key := canonical(generic(t, fx.Request))
			if other, ok := seen[key]; ok {
				t.Errorf("%s: %s and %s have the same request; replay could answer only one", op, other, fx.Name)
			}
			seen[key] = fx.Name
		}
	}
}

func isRefusal(err error, status int, name string) bool {
	var f *b2.ClientFailure
	return errors.As(err, &f) && f.Body != nil && f.Status == status && f.Body.Error == name
}

// The stateful fake answers every bridge-profile method: from its state, or from the wire fixtures exactly as
// replay does. A bridge grant is refused any other method.
func TestStatefulFakeAnswersEveryBridgeMethod(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := fake.Client()
	stateful := workerfake.StatefulOps()
	for _, m := range b2.GrantProfiles["bridge"] {
		fx := workerfake.WireFixtures(m)[0]
		got, err := callFixture(t, ctx, c, fx, true)
		if slices.Contains(stateful, m) {
			// Answered from state: a reply or a B2 refusal, never a missing route or fixture and never a fake failure.
			var f *b2.ClientFailure
			if errors.As(err, &f) && (f.Body == nil || f.Status == http.StatusNotFound || f.Status >= 500 || f.Body.Error == "grant_method_denied") {
				t.Errorf("%s: not answered from state: %v", m, err)
			}
			continue
		}
		checkReply(t, fx, got, err)
	}
	for _, m := range []string{"sessions.steer", "sessions.follow_up", "executions.cancel", "children.launch", "children.report", "workers.relaunch"} {
		fx := workerfake.WireFixtures(m)[0]
		if _, err := callFixture(t, ctx, c, fx, true); !isRefusal(err, http.StatusConflict, "grant_method_denied") {
			t.Errorf("%s with a bridge grant: %v, want grant_method_denied", m, err)
		}
	}
}
