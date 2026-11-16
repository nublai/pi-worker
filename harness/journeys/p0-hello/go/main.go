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
	// Every request needs a bearer grant (P1-9); the journey registers one and names its file in PIW_GRANT_FILE.
	c := b2.New(os.Args[1], b2.WithGrantFile(os.Getenv("PIW_GRANT_FILE")))
	hello, err := c.Hello(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "hello:", err)
		os.Exit(1)
	}
	out := map[string]any{
		"client": "go", "hello": "ok", "protocol_major": hello.Protocol.Major,
		"supervisor_epoch": hello.SupervisorEpoch, "limits": hello.Limits,
	}
	// files.read stays unsupported until P2-4 (sessions.prompt is served from P1-5).
	_, err = c.FilesRead(ctx, "w1", b2.FileRead{Path: "/r/file", Roots: []string{"/r"}})
	var f *b2.ClientFailure
	if errors.As(err, &f) {
		out["prompt_status"], out["prompt_effect"] = f.Status, string(f.Effect)
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
