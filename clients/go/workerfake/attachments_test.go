package workerfake_test

// The upload's refusals as the worker answers them (supervisor.ts stageAttachment, attachments.ts): a stale worker
// epoch is stale_binding, a worker that is not starting or ready is worker_not_ready, and a worker holds at most 16
// staged or streaming attachments (PR #16 Grok 1, 2, 3).

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func refusedNotStaged(t *testing.T, fake *workerfake.Fake, c *b2.Client, id string, err error, name string) {
	t.Helper()
	if !isRefusal(err, http.StatusConflict, name) || asFailure(t, err).Effect != b2.NoEffect {
		t.Fatalf("%s: %v, want 409 %s no_effect", id, err, name)
	}
	if _, ok := fake.Attachment(id); ok {
		t.Fatalf("%s: a refused upload was staged", id)
	}
	if _, err := c.AttachmentsStatus(context.Background(), id); !isRefusal(err, http.StatusConflict, "unknown_attachment_is_not_proof_of_no_effect") {
		t.Fatalf("%s: status after a refusal %v", id, err)
	}
}

func TestStageRefusesAStaleEpochAndAWorkerNotReady(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	photo := jpeg(1000)
	params := stageParams(w, "stage-epoch", photo)
	params.PiwWorkerEpoch = "an-old-epoch"
	_, err = c.AttachmentsStage(ctx, "photo-epoch", params, "image/jpeg", int64(len(photo)), bytes.NewReader(photo))
	refusedNotStaged(t, fake, c, "photo-epoch", err, "stale_binding")

	if _, err := c.WorkersStop(ctx, w.WorkerId, bindingOf(w, "stop-1")); err != nil {
		t.Fatal(err)
	}
	_, err = c.AttachmentsStage(ctx, "photo-stopped", stageParams(w, "stage-stopped", photo), "image/jpeg", int64(len(photo)), bytes.NewReader(photo))
	refusedNotStaged(t, fake, c, "photo-stopped", err, "worker_not_ready")

	// A worker whose host is gone after a restart (cleanup_pending) refuses too.
	other := newWorker(t, ctx, c, "create-2")
	fake.Restart()
	_, err = c.AttachmentsStage(ctx, "photo-restart", stageParams(other, "stage-restart", photo), "image/jpeg", int64(len(photo)), bytes.NewReader(photo))
	refusedNotStaged(t, fake, c, "photo-restart", err, "worker_not_ready")
}

func TestStageHoldsThePerWorkerAttachmentBound(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	stage := func(i int) error {
		data := jpeg(1000 + i)
		_, err := c.AttachmentsStage(ctx, fmt.Sprintf("photo-%d", i), stageParams(w, fmt.Sprintf("stage-%d", i), data), "image/jpeg", int64(len(data)), bytes.NewReader(data))
		return err
	}
	for i := 0; i < 15; i++ {
		if err := stage(i); err != nil {
			t.Fatalf("image %d: %v", i, err)
		}
	}
	// An upload still streaming holds the 16th slot: a 17th is refused before its first byte is kept.
	streaming := jpeg(200000)
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() {
		_, err := c.AttachmentsStage(ctx, "photo-streaming", stageParams(w, "stage-streaming", streaming), "image/jpeg", int64(len(streaming)), pr)
		done <- err
	}()
	if _, err := pw.Write(streaming[:1000]); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		if st, err := c.AttachmentsStatus(ctx, "photo-streaming"); err == nil && st.State == "receiving" && st.Bytes > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the upload never started streaming")
		}
		time.Sleep(5 * time.Millisecond)
	}
	err = stage(16)
	refusedNotStaged(t, fake, c, "photo-16", err, "attachment_capacity")
	if _, err := pw.Write(streaming[1000:]); err != nil {
		t.Fatal(err)
	}
	pw.Close()
	if err := <-done; err != nil {
		t.Fatalf("the streaming upload: %v", err)
	}
	// Sixteen staged: the 17th is refused; releasing one makes room.
	err = stage(17)
	refusedNotStaged(t, fake, c, "photo-17", err, "attachment_capacity")
	if _, err := c.AttachmentsRelease(ctx, "photo-0", b2.Release{CommandId: "release-0"}); err != nil {
		t.Fatal(err)
	}
	if err := stage(17); err != nil {
		t.Fatalf("after a release: %v", err)
	}
}
