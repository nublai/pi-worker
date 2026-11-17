package workerfake_test

// Worker rows carry first_user_line (history/session-file.ts fold): the first line of the session's first user text,
// interrupt marker stripped, trimmed, at most 280 characters; null before a user message with text. In workers.get,
// workers.list and every snapshot and worker.updated, from the session file like preview.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func TestWorkerRowsCarryTheFirstUserLine(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId
	line := func(when string) *string {
		t.Helper()
		got, err := c.WorkersGet(ctx, w.WorkerId)
		if err != nil {
			t.Fatal(err)
		}
		list, err := c.WorkersList(ctx)
		if err != nil || len(list) != 1 || mustJSON(t, list[0].FirstUserLine) != mustJSON(t, got.FirstUserLine) {
			t.Fatalf("%s: workers.list %+v %v", when, list, err)
		}
		return got.FirstUserLine
	}
	if l := line("a new session"); l != nil {
		t.Fatalf("a new session: %q", *l)
	}
	user := func(id string, content any) {
		t.Helper()
		data := fmt.Sprintf(`{"type":"message","id":%q,"message":{"role":"user","content":%s}}`+"\n", id, mustJSON(t, content))
		if err := fake.AppendHistory(sid, []byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	// An image-only user message has no text line.
	user("u0", []any{map[string]any{"type": "image", "data": "AAAA", "mimeType": "image/jpeg"}})
	if l := line("an image only"); l != nil {
		t.Fatalf("an image only: %q", *l)
	}
	marker := "[The previous request was interrupted by the user before it finished.]"
	long := strings.Repeat("y", 300)
	user("u1", []any{map[string]any{"type": "text", "text": marker + "\n  \n  " + long + "  \nsecond line"}})
	user("u2", "a later message")
	if l := line("after user text"); l == nil || *l != long[:280] {
		t.Fatalf("after user text: %v", l)
	}
	// Every snapshot carries it.
	events := startWatch(t, c, b2.WatchOptions{WorkerIDs: []string{w.WorkerId}})
	snap := snapshotOf(t, events.next(t))
	if len(snap.Workers) != 1 || snap.Workers[0].FirstUserLine == nil || *snap.Workers[0].FirstUserLine != long[:280] {
		t.Fatalf("snapshot %+v", snap.Workers)
	}
	// And worker.updated, the next time the row is published.
	if _, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "p-1", WorkerEpoch: w.WorkerEpoch, SessionId: sid, BindingRevision: 1, Message: "go"}); err != nil {
		t.Fatal(err)
	}
	for {
		if u, ok := events.next(t).Event.(*b2.WorkerUpdatedEvent); ok {
			if l := u.Data.Worker.FirstUserLine; l == nil || *l != long[:280] {
				t.Fatalf("worker.updated %v", l)
			}
			break
		}
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
