package workerfake_test

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

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

// notEmittedByTheStatefulFake names the manifest events the stateful fake never streams, with the reason; the
// closure check below fails on any other manifest event type it does not see, and on a name outside the manifest.
var notEmittedByTheStatefulFake = map[string]string{
	"child.reported": "children.report answers from wire fixtures: the fake runs no child that reports",
}

// The event closure (P1-19): the stateful fake streams every event type in the spec's manifest (b2.EventTypes) in
// one scenario, each frame with the evidence, producer and enum values its schema allows (execution.settled is
// observed_memory, PR #16 GPT 7), and every manifest type has an events.subscribe wire fixture frame.
func TestStatefulFakeStreamsEveryManifestEventType(t *testing.T) {
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
	photo := jpeg(1000)
	if _, err := c.AttachmentsStage(ctx, "photo-1", stageParams(w, "stage-1", photo), "image/jpeg", int64(len(photo)), bytes.NewReader(photo)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, "p-1", nil)); err != nil {
		t.Fatal(err)
	}
	host.EmitToolStart("toolu-1", "read", ptr("src/login.ts"))
	host.EmitToolEnd("toolu-1", "read", false)
	host.EmitText("Done: the login form now validates the email.")
	if err := fake.AppendHistory(*w.SessionId, []byte(`{"type":"message","id":"a1","timestamp":"2026-11-17T08:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}`+"\n")); err != nil {
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
	seen := map[string]bool{"snapshot": true}
	check := func(f b2.Frame) {
		seen[f.Type] = true
		var bad []string
		enumsValid(reflect.ValueOf(f.Event), f.Type, &bad)
		if len(bad) > 0 {
			t.Errorf("%s frame outside the spec: %v", f.Type, bad)
		}
		var head struct {
			Producer string `json:"producer"`
		}
		json.Unmarshal(f.Raw, &head)
		if want := map[string]string{"assistant.delta": "pi", "tool.started": "pi", "tool.finished": "pi"}[f.Type]; f.Type != "snapshot" && head.Producer != cmp.Or(want, "supervisor") {
			t.Errorf("%s: producer %q", f.Type, head.Producer)
		}
	}
	for !seen["fence.resolved"] {
		check(events.next(t))
	}
	// The overflow frame ends the watch; every frame it read is buffered by then.
	fake.Overflow()
	var resync *b2.ResyncRequired
	if err := events.end(t); !errors.As(err, &resync) || resync.Reason != "overflow" {
		t.Fatalf("watch ended %v, want overflow", err)
	}
	for len(events.frames) > 0 {
		check(<-events.frames)
	}
	for name := range notEmittedByTheStatefulFake {
		if !slices.Contains(b2.EventTypes, name) {
			t.Errorf("%s is not a manifest event type", name)
		}
	}
	fixtureTypes := map[string]bool{}
	for _, fx := range workerfake.WireFixtures("events.subscribe") {
		for _, frame := range fx.Response.Frames {
			var head struct {
				Type string `json:"type"`
			}
			json.Unmarshal(frame, &head)
			fixtureTypes[head.Type] = true
		}
	}
	for _, typ := range b2.EventTypes {
		if _, excused := notEmittedByTheStatefulFake[typ]; !seen[typ] && !excused {
			t.Errorf("the stateful fake never streamed %s", typ)
		}
		if !fixtureTypes[typ] {
			t.Errorf("no events.subscribe wire fixture frame of type %s", typ)
		}
	}
}

// A delta storm to a subscriber that does not read keeps one assistant.delta per worker and never overflows; the
// delta it finally reads carries the latest tail (activity.ts, hub.ts).
func TestDeltaStormNeverOverflowsASlowSubscriber(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	host := fake.Host(w.WorkerId)
	gate := make(chan struct{})
	var frames []b2.Frame
	done := make(chan error, 1)
	go func() {
		done <- c.Watch(ctx, b2.WatchOptions{WorkerIDs: []string{w.WorkerId}}, func(f b2.Frame) bool {
			frames = append(frames, f)
			if f.Type == "snapshot" {
				<-gate // the reader stalls: the stream backs up
			}
			return f.Type != "tool.finished"
		})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for fake.Streams() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	text := strings.Repeat("x", 4096) // big frames: the transport fills, the fake's queue holds the rest
	for i := 0; i < 2000; i++ {
		text += fmt.Sprintf("%d ", i)
		host.EmitText(text)
	}
	host.EmitToolStart("toolu-1", "bash", nil)
	host.EmitToolEnd("toolu-1", "bash", false)
	close(gate)
	if err := <-done; err != nil {
		t.Fatalf("watch: %v (frames %d)", err, len(frames))
	}
	var last *b2.AssistantDeltaEvent
	for _, f := range frames {
		if f.Type == "overflow" {
			t.Fatal("the delta storm overflowed the subscriber")
		}
		if d, ok := f.Event.(*b2.AssistantDeltaEvent); ok {
			last = d
		}
	}
	if last == nil || last.Data.Length != len(text) || !strings.HasSuffix(text, last.Data.Tail) || len(last.Data.Tail) != 2048 {
		t.Fatalf("last delta %+v, want the tail of %d characters", last, len(text))
	}
}
