package workerfake_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

// commands.invoke runs only an extension command pi reports; a built-in with its own method is refused use_method
// naming it, any other built-in or a skill unsupported_command, an unknown name unknown_command, all no_effect and
// before any record (PR #16 GPT 5).
func TestCommandsInvokeRefusesBuiltinsAndUnknownCommands(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	invoke := func(cmd, name string) (*b2.Receipt, error) {
		return c.CommandsInvoke(ctx, w.WorkerId, b2.Invoke{CommandId: cmd, WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Name: name})
	}
	for _, tc := range []struct{ cmd, name, refusal, detail string }{
		{"inv-new", "new", "use_method", "sessions.new"},
		{"inv-compact", "compact", "use_method", "sessions.compact"},
		{"inv-model", "model", "use_method", "session.configure"},
		{"inv-login", "login", "unsupported_command", ""},
		{"inv-quit", "quit", "unsupported_command", ""},
		{"inv-skill", "skill:review", "unsupported_command", ""},
		{"inv-absent", "no-such-extension", "unknown_command", ""},
	} {
		_, err := invoke(tc.cmd, tc.name)
		f := asFailure(t, err)
		if !isRefusal(err, http.StatusConflict, tc.refusal) || f.Effect != b2.NoEffect {
			t.Fatalf("%s: %v, want 409 %s no_effect", tc.name, err, tc.refusal)
		}
		if tc.detail != "" && (f.Body.Detail == nil || *f.Body.Detail != tc.detail) {
			t.Fatalf("%s: detail %v, want %s", tc.name, f.Body.Detail, tc.detail)
		}
		if _, err := c.ReceiptsGet(ctx, tc.cmd); err == nil {
			t.Fatalf("%s: a refused invoke left a receipt", tc.name)
		}
	}
	// The extension command the fixture pi reports runs.
	if r, err := invoke("inv-deploy", "deploy"); err != nil || r.State != "delivered" {
		t.Fatalf("deploy %+v %v", r, err)
	}
}
