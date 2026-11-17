package workerfake_test

// The Go replay of contract revision 8, section 0.1 (plan P1-17): the eleven frozen rows of
// api/fixtures/transitions.json, through the Go client, against the fake. A port of the TypeScript runner
// (packages/worker/test/conformance/transitions.test.ts); every row assertion is checked, none is skipped.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

// The TypeScript runner pins the same hash over the same frozen fields.
const frozenSemanticHash = "290168fc3c49bbe536b31f575f05b1f5330bbe9c55080eeeeee3a1c2c2726b51"

var rowIDs = []string{"01-binding", "02-unknown", "03-fenced-write", "04-paused", "05-keep", "06-abandon", "07-observed", "08-generation", "09-restart", "10-cleanup-resume", "11-control"}

// canonical is sorted-key JSON, as fixture.ts canonical() writes it.
func canonical(v any) string {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = jsonString(k) + ":" + canonical(x[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = canonical(e)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case string:
		return jsonString(x)
	case json.Number:
		return x.String()
	default:
		data, _ := json.Marshal(x)
		return string(data)
	}
}

func jsonString(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}

func TestTransitionsAreRevision8ElevenRowsWithThePinnedHash(t *testing.T) {
	set, err := workerfake.Transitions()
	if err != nil {
		t.Fatal(err)
	}
	if set.ContractRevision != 8 {
		t.Fatalf("contract revision %d", set.ContractRevision)
	}
	var ids []string
	for _, r := range set.Rows {
		ids = append(ids, r.ID)
	}
	if !slices.Equal(ids, rowIDs) {
		t.Fatalf("rows %v", ids)
	}
	dec := json.NewDecoder(bytes.NewReader(workerfake.TransitionsJSON()))
	dec.UseNumber()
	var raw struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := dec.Decode(&raw); err != nil {
		t.Fatal(err)
	}
	var frozen []any
	for _, r := range raw.Rows {
		frozen = append(frozen, map[string]any{"id": r["id"], "from": r["from"], "event": r["event"], "to": r["to"], "expect": r["expect"]})
	}
	sum := sha256.Sum256([]byte(canonical(frozen)))
	if got := hex.EncodeToString(sum[:]); got != frozenSemanticHash {
		t.Fatalf("semantic hash %s, pinned %s: a frozen row changed", got, frozenSemanticHash)
	}
}

// get is the dot-path read of fixture.ts get().
func get(v any, path string) any {
	for _, key := range strings.Split(path, ".") {
		switch x := v.(type) {
		case map[string]any:
			v = x[key]
		case []any:
			i, err := strconv.Atoi(key)
			if err != nil || i < 0 || i >= len(x) {
				return nil
			}
			v = x[i]
		default:
			return nil
		}
	}
	return v
}

func substitute(v any, ctx map[string]any) any {
	switch x := v.(type) {
	case string:
		if strings.HasPrefix(x, "@") {
			return get(ctx, x[1:])
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = substitute(e, ctx)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = substitute(e, ctx)
		}
		return out
	}
	return v
}

// generic turns a model into plain JSON values for dot paths and equality.
func generic(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// strict decodes a fixture call body into the method's typed request: a field the model lacks fails.
func strict[T any](body map[string]any) (T, error) {
	var out T
	data, _ := json.Marshal(body)
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	err := dec.Decode(&out)
	return out, err
}

// invoke sends one fixture call once through the Go client's typed wrapper.
func invoke(ctx context.Context, c *b2.Client, workerID, method string, body map[string]any) (*b2.Receipt, error) {
	var (
		r   *b2.Receipt
		err error
	)
	switch method {
	case "sessions.prompt":
		var b b2.Prompt
		if b, err = strict[b2.Prompt](body); err == nil {
			r, err = c.SessionsPrompt(ctx, workerID, b)
		}
	case "sessions.follow_up":
		var b b2.FollowUp
		if b, err = strict[b2.FollowUp](body); err == nil {
			r, err = c.SessionsFollowUp(ctx, workerID, b)
		}
	case "children.launch":
		var b b2.ChildLaunch
		if b, err = strict[b2.ChildLaunch](body); err == nil {
			r, err = c.ChildrenLaunch(ctx, workerID, b)
		}
	case "sessions.rebind":
		var b b2.Rebind
		if b, err = strict[b2.Rebind](body); err == nil {
			r, err = c.SessionsRebind(ctx, workerID, b)
		}
	case "sessions.resolve_unknown":
		var b b2.Resolve
		if b, err = strict[b2.Resolve](body); err == nil {
			r, err = c.SessionsResolveUnknown(ctx, workerID, b)
		}
	case "executions.cancel":
		var b b2.Control
		if b, err = strict[b2.Control](body); err == nil {
			r, err = c.ExecutionsCancel(ctx, workerID, b)
		}
	case "executions.interrupt":
		var b b2.Control
		if b, err = strict[b2.Control](body); err == nil {
			r, err = c.ExecutionsInterrupt(ctx, workerID, b)
		}
	default:
		return nil, fmt.Errorf("fixture method %s has no Go call", method)
	}
	return r, err
}

// outcome is the runner's result: the receipt, or the labelled error ({error, effect, ...the Error body}).
func outcome(t *testing.T, r *b2.Receipt, err error) any {
	t.Helper()
	var f *b2.ClientFailure
	switch {
	case err == nil:
		return generic(t, r)
	case errors.As(err, &f) && f.Body != nil:
		out := generic(t, f.Body).(map[string]any)
		out["error"], out["effect"] = f.Body.Error, string(f.Effect)
		return out
	case errors.As(err, &f):
		return map[string]any{"error": f.Error(), "effect": string(f.Effect)}
	default:
		t.Fatalf("not a ClientFailure: %v", err)
		return nil
	}
}

func TestContract01Transitions(t *testing.T) {
	set, err := workerfake.Transitions()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range set.Rows {
		t.Run(row.ID, func(t *testing.T) {
			t.Parallel()
			replayRow(t, set, row)
		})
	}
}

func replayRow(t *testing.T, set *workerfake.TransitionSet, row workerfake.Row) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fake, err := workerfake.Start(workerfake.Options{Methods: workerfake.AllMethods(), Profile: row.Profile})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	client := fake.Client(b2.WithTimeout(20 * time.Second))
	// A fresh idle worker with an exclusive empty cwd; child_cwd is a separate available cwd.
	created, err := client.WorkersCreate(ctx, b2.Create{CommandId: "fixture-create", Cwd: filepath.Join(t.TempDir(), "cwd"), Provider: "fixture", Model: "fixture", Thinking: "off"})
	if err != nil || created.WorkerId == nil {
		t.Fatalf("create: %v", err)
	}
	workerID := *created.WorkerId
	first, err := client.WorkersGet(ctx, workerID)
	if err != nil {
		t.Fatal(err)
	}
	initial := generic(t, first).(map[string]any)
	worker := initial
	host := fake.Host(workerID)
	childCwd := filepath.Join(t.TempDir(), "child-cwd")
	var result any
	var inflight chan any

	body := func(step workerfake.Step) map[string]any {
		source := initial
		if step.Binding == "worker" {
			source = worker
		}
		out := map[string]any{
			"command_id": step.CommandID, "session_id": source["session_id"], "worker_epoch": source["worker_epoch"], "binding_revision": source["binding_revision"],
		}
		ctxValues := map[string]any{"initial": initial, "worker": worker, "child_cwd": childCwd}
		for k, v := range step.Fields {
			out[k] = substitute(v, ctxValues)
		}
		return out
	}
	for _, step := range set.Expand(row.Steps) {
		switch step.Kind {
		case "host_reply":
			if step.Mode == "drop" {
				host.DropNextPromptReply()
			} else {
				host.HoldNextPromptReply()
			}
		case "call":
			r, err := invoke(ctx, client, workerID, step.Method, body(step))
			result = outcome(t, r, err)
		case "begin":
			started := host.NextAgentStart()
			b := body(step)
			inflight = make(chan any, 1)
			go func() {
				r, err := invoke(ctx, client, workerID, step.Method, b)
				var out any
				if err == nil {
					out = r
				} else {
					out = err
				}
				inflight <- out
			}()
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal("begin: no agent_start")
			}
		case "drop_reply":
			host.ReleaseHeldReply()
			switch v := (<-inflight).(type) {
			case *b2.Receipt:
				result = outcome(t, v, nil)
			case error:
				result = outcome(t, nil, v)
			}
		case "host_event":
			host.Emit(step.Event.Type)
		case "drain":
			fake.Drain()
		case "restart":
			fake.Restart()
		default:
			t.Fatalf("unknown fixture step %q", step.Kind)
		}
		w, err := client.WorkersGet(ctx, workerID)
		if err != nil {
			t.Fatalf("workers.get after %s: %v", step.Kind, err)
		}
		worker = generic(t, w).(map[string]any)
	}
	disk, ok := fake.Disk(workerID)
	if !ok {
		t.Fatal("no durable record")
	}
	actual := map[string]any{
		"worker": worker, "disk": generic(t, disk), "result": result,
		"effects": map[string]any{"prompts": float64(host.Prompts()), "hosts": float64(fake.Hosts())},
	}
	for _, check := range row.Expect {
		want := generic(t, check.Equals)
		if got := get(actual, check.Path); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %s = %v, want %v", row.ID, check.Path, got, want)
		}
	}
}
