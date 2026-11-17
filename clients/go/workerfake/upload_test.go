package workerfake_test

// The Go streamed upload (plan P1-17, Shep's S-4): a 1.5 MiB JPEG through the Go client is staged; after a dropped
// response the client reads attachments.status and never uploads again; the limits are refused before anything is
// sent; a prompt names the attachment and releases it.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

// jpeg returns n bytes that start with the JPEG magic and end with its end-of-image marker.
func jpeg(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i/251)
	}
	copy(b, []byte{0xff, 0xd8, 0xff, 0xe0})
	copy(b[n-2:], []byte{0xff, 0xd9})
	return b
}

func hexSHA(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// countingReader counts the bytes the client read from the caller's reader.
type countingReader struct {
	r     io.Reader
	reads int
	bytes int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.reads++
	c.bytes += n
	return n, err
}

func stageParams(w *b2.Worker, cmd string, data []byte) b2.AttachmentsStageParams {
	return b2.AttachmentsStageParams{PiwCommandId: cmd, PiwWorkerId: w.WorkerId, PiwWorkerEpoch: w.WorkerEpoch, PiwSessionId: *w.SessionId, PiwBindingRevision: w.BindingRevision, PiwContentSha256: hexSHA(data)}
}

func TestGoStreamedUploadOf1_5MiBIsStaged(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	photo := jpeg(1536 << 10)
	body := &countingReader{r: bytes.NewReader(photo)}
	r, err := c.AttachmentsStage(ctx, "photo-1", stageParams(w, "stage-1", photo), "image/jpeg", int64(len(photo)), body)
	if err != nil {
		t.Fatal(err)
	}
	if r.State != "delivered" || r.Effect != "observed" || (*r.Result)["state"] != "staged" || (*r.Result)["bytes"] != float64(len(photo)) {
		t.Fatalf("receipt %+v %v", r, *r.Result)
	}
	if body.bytes != len(photo) || body.reads < 2 {
		t.Fatalf("the body was read %d bytes in %d reads; want all of it, streamed", body.bytes, body.reads)
	}
	staged, ok := fake.Attachment("photo-1")
	if !ok || !bytes.Equal(staged, photo) {
		t.Fatal("the fake did not stage the exact bytes")
	}
	st, err := c.AttachmentsStatus(ctx, "photo-1")
	if err != nil || st.State != "staged" || st.Sha256 != hexSHA(photo) || st.CommandId != "stage-1" || st.Bytes != len(photo) {
		t.Fatalf("status %+v %v", st, err)
	}

	// The same id and hash again (a retry under a new command id) stores nothing twice and names the original.
	dup, err := c.AttachmentsStage(ctx, "photo-1", stageParams(w, "stage-2", photo), "image/jpeg", int64(len(photo)), bytes.NewReader(photo))
	if err != nil || (*dup.Result)["duplicate_of"] != "stage-1" {
		t.Fatalf("duplicate %+v %v", dup, err)
	}
	// Another image under the same id is a conflict, no_effect.
	other := jpeg(1000)
	_, err = c.AttachmentsStage(ctx, "photo-1", stageParams(w, "stage-3", other), "image/jpeg", int64(len(other)), bytes.NewReader(other))
	if !isRefusal(err, http.StatusConflict, "attachment_id_conflict") || asFailure(t, err).Effect != b2.NoEffect {
		t.Fatalf("conflict: %v", err)
	}

	// A prompt with the attachment delivers it and releases the staged copy.
	pr, err := c.SessionsPrompt(ctx, w.WorkerId, b2.Prompt{CommandId: "prompt-1", WorkerEpoch: w.WorkerEpoch, SessionId: *w.SessionId, BindingRevision: 1, Message: "look", Attachments: &[]struct {
		AttachmentId b2.Id `json:"attachment_id"`
	}{{AttachmentId: "photo-1"}}})
	if err != nil || pr.State != "delivered" || pr.Result == nil || (*pr.Result)["accepted_images"] != float64(1) {
		t.Fatalf("prompt %+v %v", pr, err)
	}
	if st, err := c.AttachmentsStatus(ctx, "photo-1"); err != nil || st.State != "released" || st.ReleasedBy == nil || *st.ReleasedBy != "prompt-1" {
		t.Fatalf("after the prompt %+v %v", st, err)
	}
}

// A prompt's receipt carries the number of images pi accepted, also when pi drops one (PR #16 GPT 8).
func TestPromptReceiptCarriesAcceptedImages(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	var ids []struct {
		AttachmentId b2.Id `json:"attachment_id"`
	}
	for i, id := range []string{"photo-a", "photo-b", "photo-c"} {
		data := jpeg(2000 + i)
		if _, err := c.AttachmentsStage(ctx, id, stageParams(w, "stage-"+id, data), "image/jpeg", int64(len(data)), bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, struct {
			AttachmentId b2.Id `json:"attachment_id"`
		}{id})
	}
	fake.Host(w.WorkerId).AcceptNextImages(2)
	p := promptOf(w, "prompt-1", nil)
	p.Attachments = &ids
	r, err := c.SessionsPrompt(ctx, w.WorkerId, p)
	if err != nil || r.Result == nil || (*r.Result)["accepted_images"] != float64(2) {
		t.Fatalf("partial acceptance %+v %v", r, err)
	}
	fake.Host(w.WorkerId).Emit("agent_settled")
	// Without attachments the result has no image count.
	r, err = c.SessionsPrompt(ctx, w.WorkerId, promptOf(w, "prompt-2", nil))
	if err != nil || r.Result == nil {
		t.Fatalf("text prompt %+v %v", r, err)
	}
	if _, ok := (*r.Result)["accepted_images"]; ok {
		t.Fatalf("a text prompt reports images: %v", *r.Result)
	}
}

func asFailure(t *testing.T, err error) *b2.ClientFailure {
	t.Helper()
	var f *b2.ClientFailure
	if !errors.As(err, &f) {
		t.Fatalf("want *b2.ClientFailure, got %T %v", err, err)
	}
	return f
}

func TestDroppedStageResponseReadsAttachmentStatusNeverReuploads(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	photo := jpeg(1536 << 10)
	fake.DropNextStageReply()
	_, err = c.AttachmentsStage(ctx, "photo-1", stageParams(w, "stage-1", photo), "image/jpeg", int64(len(photo)), bytes.NewReader(photo))
	f := asFailure(t, err)
	if f.Phase != b2.PhaseAfterWrite || f.Effect != b2.UnknownEffect {
		t.Fatalf("a lost reply is %s %s, want after_write unknown", f.Phase, f.Effect)
	}
	// Reconcile by reading, never by sending the bytes again.
	st, err := c.AttachmentsStatus(ctx, "photo-1")
	if err != nil {
		t.Fatal(err)
	}
	if st.State != "staged" || st.Sha256 != hexSHA(photo) || st.CommandId != "stage-1" || st.Bytes != len(photo) {
		t.Fatalf("status after the lost reply %+v", st)
	}
	r, err := c.ReceiptsGet(ctx, "stage-1")
	if err != nil || r.State != "delivered" {
		t.Fatalf("receipt after the lost reply %+v %v", r, err)
	}
	// An id the worker does not know is unknown, never proof that nothing was staged.
	_, err = c.AttachmentsStatus(ctx, "photo-never")
	if !isRefusal(err, http.StatusConflict, "unknown_attachment_is_not_proof_of_no_effect") || asFailure(t, err).Effect != b2.UnknownEffect {
		t.Fatalf("unknown id: %v", err)
	}
}

func TestStageLimitsAreRefusedBeforeAnythingIsSent(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	over := jpeg(int(b2.OpAttachmentsStage.MaxBodyBytes) + 1)
	body := &countingReader{r: bytes.NewReader(over)}
	_, err = c.AttachmentsStage(ctx, "photo-1", stageParams(w, "stage-1", over), "image/jpeg", int64(len(over)), body)
	if f := asFailure(t, err); f.Phase != b2.PhaseBeforeWrite || f.Effect != b2.NoEffect || body.reads != 0 {
		t.Fatalf("one byte over the limit: %v (reads %d)", err, body.reads)
	}
	exact := jpeg(int(b2.OpAttachmentsStage.MaxBodyBytes))
	if _, err := c.AttachmentsStage(ctx, "photo-max", stageParams(w, "stage-max", exact), "image/jpeg", int64(len(exact)), bytes.NewReader(exact)); err != nil {
		t.Fatalf("exactly the limit: %v", err)
	}
	small := jpeg(100)
	if _, err := c.AttachmentsStage(ctx, "photo-2", stageParams(w, "stage-2", small), "image/gif", int64(len(small)), bytes.NewReader(small)); asFailure(t, err).Phase != b2.PhaseBeforeWrite {
		t.Fatalf("a type outside the spec: %v", err)
	}
	// The worker checks the bytes after the last one: a hash or magic mismatch is 400 no_effect, nothing staged.
	params := stageParams(w, "stage-3", small)
	params.PiwContentSha256 = hexSHA([]byte("other"))
	_, err = c.AttachmentsStage(ctx, "photo-3", params, "image/jpeg", int64(len(small)), bytes.NewReader(small))
	if !isRefusal(err, http.StatusBadRequest, "attachment_sha256_mismatch") || asFailure(t, err).Effect != b2.NoEffect {
		t.Fatalf("hash mismatch: %v", err)
	}
	_, err = c.AttachmentsStage(ctx, "photo-4", stageParams(w, "stage-4", small), "image/png", int64(len(small)), bytes.NewReader(small))
	if !isRefusal(err, http.StatusBadRequest, "attachment_type_mismatch") {
		t.Fatalf("magic mismatch: %v", err)
	}
	if _, ok := fake.Attachment("photo-3"); ok {
		t.Fatal("a refused upload was staged")
	}
	// A reader shorter than the declared size fails after the write began: unknown, read the status.
	short := jpeg(5000)
	_, err = c.AttachmentsStage(ctx, "photo-5", stageParams(w, "stage-5", short), "image/jpeg", int64(len(short)+10), bytes.NewReader(short))
	if f := asFailure(t, err); f.Effect != b2.UnknownEffect {
		t.Fatalf("short body: %v", err)
	}
}

func TestHistoryBytesNextCarriesTheRewriteChecks(t *testing.T) {
	h := &b2.HistoryBytes{FileIdentity: "id", NextOffset: 471, PrefixSha256: "p", TailSha256: "t"}
	limit := 4096
	next := h.Next(&limit)
	if *next.Offset != 471 || *next.Identity != "id" || *next.Prefix != "p" || *next.Tail != "t" || *next.MaxBytes != 4096 {
		t.Fatalf("next %+v", next)
	}
	if (&b2.HistoryBytes{}).Next(nil).Tail != nil {
		t.Fatal("no tail before the first line")
	}
}
