package workerfake_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

// enumsValid walks a decoded model and reports every enum value (a type with the generated Valid method) that is
// not a member of its spec enum or const.
func enumsValid(v reflect.Value, path string, bad *[]string) {
	if !v.IsValid() {
		return
	}
	if v.CanInterface() {
		if e, ok := v.Interface().(interface{ Valid() bool }); ok && v.Kind() != reflect.Pointer && !e.Valid() {
			*bad = append(*bad, path+"="+v.String())
		}
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			enumsValid(v.Elem(), path, bad)
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				enumsValid(v.Field(i), path+"."+v.Type().Field(i).Name, bad)
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			enumsValid(v.Index(i), path, bad)
		}
	case reflect.Map:
		for _, k := range v.MapKeys() {
			enumsValid(v.MapIndex(k), path, bad)
		}
	}
}

// Every frame the stateful fake streams carries the evidence and the enum values the spec's event schemas allow:
// execution.settled is observed_memory (PR #16 GPT 7).
func TestStatefulEventFramesKeepTheSpecEnums(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	events := startWatch(t, c, b2.WatchOptions{})
	snapshotOf(t, events.next(t))
	w := newWorker(t, ctx, c, "create-1")
	host := fake.Host(w.WorkerId)
	if _, err := c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, "p-1", nil)); err != nil {
		t.Fatal(err)
	}
	host.Emit("agent_settled")
	in := open(t, fake, w, b2.Interaction{Kind: "confirm"})
	a := answerFor(w, in, "a-1", "ans-1")
	a.Value = raw(true)
	if _, err := c.InteractionsAnswerIfCurrent(ctx, w.WorkerId, a); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SessionsNew(ctx, w.WorkerId, bindingOf(w, "new-1")); err != nil {
		t.Fatal(err)
	}
	row, _ := c.WorkersGet(ctx, w.WorkerId)
	if _, err := c.SessionsPrompt(ctx, w.WorkerId, promptOf(row, "p-2", nil)); err != nil {
		t.Fatal(err)
	}
	host.Emit("exit")
	row, _ = c.WorkersGet(ctx, w.WorkerId)
	if _, err := c.SessionsResolveUnknown(ctx, w.WorkerId, b2.Resolve{CommandId: "resolve-1", WorkerEpoch: row.WorkerEpoch, SessionId: *row.SessionId, BindingRevision: row.BindingRevision, UncertainCommandId: ptr("p-2"), FenceGeneration: row.Fence.FenceGeneration, Disposition: "abandon"}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for !seen["fence.resolved"] {
		f := events.next(t)
		seen[f.Type] = true
		var bad []string
		enumsValid(reflect.ValueOf(f.Event), f.Type, &bad)
		if len(bad) > 0 {
			t.Errorf("%s frame outside the spec: %v", f.Type, bad)
		}
	}
	for _, typ := range []string{"worker.updated", "execution.settled", "interactions.changed", "session.rebound", "fence.resolved"} {
		if !seen[typ] {
			t.Errorf("no %s frame", typ)
		}
	}
}
