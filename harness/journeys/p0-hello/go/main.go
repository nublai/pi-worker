// p0-hello, Go side: hello and one unsupported mutation through the Go client (clients/go, stdlib only).
// Prints one JSON line with what the journey checks; no secrets, no request text.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/nublai/pi-worker/clients/go/b2"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . <socket>")
		os.Exit(2)
	}
	ctx := context.Background()
	c := b2.New(os.Args[1])
	hello, err := c.Hello(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hello:", err)
		os.Exit(1)
	}
	out := map[string]any{
		"client": "go", "hello": "ok", "protocol_major": hello.Protocol.Major,
		"supervisor_epoch": hello.SupervisorEpoch, "limits": hello.Limits,
	}
	_, err = c.SessionsPrompt(ctx, "w1", b2.Prompt{CommandId: "p0-hello-go", WorkerEpoch: "e1", SessionId: "s1", BindingRevision: 1, Message: "p0"})
	var f *b2.ClientFailure
	if errors.As(err, &f) {
		out["prompt_status"], out["prompt_effect"] = f.Status, string(f.Effect)
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
