package workerfake

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"strconv"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// Attachments as packages/worker/src/attachments serves them (P1-16, Shep's S-4): a streamed upload counted as it
// arrives and checked after the last byte (SHA-256, magic bytes), idempotent by attachment_id plus SHA-256, with
// status read-back (receiving, staged, released) and an unknown id that is never proof that nothing was staged.

const (
	attachmentsPerMessage = 4
	attachmentsTotalBytes = 8 << 20
	// Per worker: staged attachments plus uploads still streaming, and their bytes (attachments.ts).
	stagedPerWorker      = 16
	stagedBytesPerWorker = 32 << 20
)

type attachment struct {
	status b2.AttachmentStatus
	data   []byte
}

// DropNextStageReply: the next upload is staged completely, then its connection closes without a reply, as a lost
// response does. The client must read attachments.status, never upload again.
func (f *Fake) DropNextStageReply() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.st.dropStageReply = true
}

// Attachment returns the bytes the fake staged for an attachment id.
func (f *Fake) Attachment(id string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a := f.st.attachments[id]
	if a == nil {
		return nil, false
	}
	return bytes.Clone(a.data), true
}

func sniff(head []byte) string {
	switch {
	case len(head) >= 3 && head[0] == 0xff && head[1] == 0xd8 && head[2] == 0xff:
		return "image/jpeg"
	case len(head) >= 8 && bytes.Equal(head[:8], []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}):
		return "image/png"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

// stage handles attachments.stage; it takes f.mu itself so the body streams unlocked. Whatever it answers, the
// rest of the body (up to the limit) is read first, so the client gets the reply and not a broken pipe.
func stage(f *Fake, c *call) (any, error) {
	drain := func() { io.Copy(io.Discard, io.LimitReader(c.r.Body, c.op.MaxBodyBytes+1)) }
	defer drain() // registered first: runs after any deferred unlock
	id := c.path["attachment_id"]
	contentType, _, _ := mime.ParseMediaType(c.header.Get("Content-Type"))
	if !slices.Contains(c.op.MediaTypes, contentType) {
		return nil, refuse("unsupported_media_type").withStatus(http.StatusUnsupportedMediaType)
	}
	if c.r.ContentLength > c.op.MaxBodyBytes {
		return nil, refuse("request_too_large").withStatus(http.StatusRequestEntityTooLarge)
	}
	revision, err := strconv.Atoi(c.header.Get("Piw-Binding-Revision"))
	params := b2.AttachmentsStageParams{
		PiwCommandId: c.header.Get("Piw-Command-Id"), PiwWorkerId: c.header.Get("Piw-Worker-Id"),
		PiwWorkerEpoch: c.header.Get("Piw-Worker-Epoch"), PiwSessionId: c.header.Get("Piw-Session-Id"),
		PiwBindingRevision: revision, PiwContentSha256: c.header.Get("Piw-Content-Sha256"),
	}
	if err != nil || revision < 1 || params.PiwCommandId == "" || params.PiwWorkerId == "" || params.PiwWorkerEpoch == "" || params.PiwSessionId == "" || len(params.PiwContentSha256) != 64 {
		return nil, badRequest("request_schema_mismatch")
	}
	request := map[string]any{"attachment_id": id, "headers": params, "content_type": contentType}

	f.mu.Lock()
	s := f.st
	checks := func() error {
		w, err := s.require(params.PiwWorkerId)
		if err != nil {
			return err
		}
		if w.row.WorkerEpoch != params.PiwWorkerEpoch {
			return refuse("stale_binding")
		}
		if (w.row.Status != "starting" && w.row.Status != "ready") || w.exited {
			return refuse("worker_not_ready")
		}
		return nil
	}
	// A retry of a recorded command: its stored receipt.
	if prior := s.receipts[params.PiwCommandId]; prior != nil {
		defer f.mu.Unlock()
		return s.run(params.PiwWorkerId, params.PiwCommandId, "attachments.stage", request, func() error { return nil }, func(*b2.Receipt) error { return nil })
	}
	if err := checks(); err != nil {
		f.mu.Unlock()
		return nil, err
	}
	if prior := s.attachments[id]; prior != nil {
		defer f.mu.Unlock()
		if prior.status.WorkerId != params.PiwWorkerId || prior.status.Sha256 != params.PiwContentSha256 {
			return nil, refuse("attachment_id_conflict")
		}
		if prior.status.State == "released" {
			return nil, refuse("attachment_released")
		}
		// The same image again: nothing stored twice; the receipt names the original command.
		return s.run(params.PiwWorkerId, params.PiwCommandId, "attachments.stage", request, checks, func(r *b2.Receipt) error {
			deliver(r, "forwarded", map[string]any{"attachment_id": id, "state": prior.status.State, "bytes": prior.status.Bytes, "duplicate_of": prior.status.CommandId})
			return nil
		})
	}
	if s.receiving[id] != nil {
		f.mu.Unlock()
		return nil, refuse("attachment_upload_in_progress")
	}
	// This upload's slot, before its first byte.
	if err := s.quota(params.PiwWorkerId, nil); err != nil {
		f.mu.Unlock()
		return nil, err
	}
	recv := &attachment{status: b2.AttachmentStatus{
		AttachmentId: id, WorkerId: params.PiwWorkerId, State: "receiving", ContentType: b2.AttachmentStatusContentType(contentType),
		Sha256: params.PiwContentSha256, CommandId: params.PiwCommandId, Evidence: "observed_memory",
	}}
	s.receiving[id] = recv
	gen := s.gen
	f.mu.Unlock()

	// Stream: count bytes as they arrive; the byte past the limit is refused and nothing is kept.
	hash := sha256.New()
	var data bytes.Buffer
	buf := make([]byte, 64<<10)
	var readErr error
	for {
		n, err := c.r.Body.Read(buf)
		if n > 0 {
			hash.Write(buf[:n])
			data.Write(buf[:n])
			// The chunk's bytes count against the worker's bound as they arrive.
			f.mu.Lock()
			recv.status.Bytes += n
			quota := s.quota(params.PiwWorkerId, recv)
			f.mu.Unlock()
			if quota != nil {
				readErr = quota
				break
			}
			if int64(data.Len()) > c.op.MaxBodyBytes {
				readErr = refuse("request_too_large").withStatus(http.StatusRequestEntityTooLarge)
				break
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			readErr = badRequest("request_body_unreadable")
			break
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if gen != s.gen {
		return nil, refuse("supervisor_restarted").unknown()
	}
	delete(s.receiving, id)
	switch {
	case readErr != nil:
		return nil, readErr
	case data.Len() == 0:
		return nil, badRequest("attachment_empty")
	case hex.EncodeToString(hash.Sum(nil)) != params.PiwContentSha256:
		return nil, badRequest("attachment_sha256_mismatch")
	case sniff(data.Bytes()) != contentType:
		return nil, badRequest("attachment_type_mismatch")
	}
	receipt, err := s.run(params.PiwWorkerId, params.PiwCommandId, "attachments.stage", request, func() error {
		if err := checks(); err != nil {
			return err
		}
		if s.attachments[id] != nil {
			return refuse("attachment_id_conflict")
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		st := recv.status
		st.State, st.Bytes, st.StagedAt, st.Evidence = "staged", data.Len(), ptr(now()), "supervisor_journal_fsynced"
		s.attachments[id] = &attachment{status: st, data: data.Bytes()}
		s.attachmentUpdated(st)
		deliver(r, "forwarded", map[string]any{"attachment_id": id, "state": "staged", "bytes": data.Len()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.dropStageReply {
		s.dropStageReply = false
		if hj, ok := c.w.(http.Hijacker); ok {
			if conn, _, err := hj.Hijack(); err == nil {
				conn.Close()
				return written{}, nil
			}
		}
	}
	return receipt, nil
}

// quota checks a worker's staged attachments plus its uploads still streaming (with their bytes so far) against the
// per-worker bound; without self it asks room for one more upload, not yet streaming.
func (s *state) quota(workerID string, self *attachment) error {
	count, bytes := 1, 0
	if self != nil {
		count = 0
	}
	for _, a := range s.attachments {
		if a.status.WorkerId == workerID && a.status.State == "staged" {
			count++
			bytes += a.status.Bytes
		}
	}
	for id, a := range s.receiving {
		if a.status.WorkerId == workerID && s.attachments[id] == nil {
			count++
			bytes += a.status.Bytes
		}
	}
	if count > stagedPerWorker || bytes > stagedBytesPerWorker {
		return refuse("attachment_capacity")
	}
	return nil
}

func (s *state) attachmentStatus(id string) (*b2.AttachmentStatus, error) {
	if a := s.attachments[id]; a != nil {
		st := a.status
		return &st, nil
	}
	if a := s.receiving[id]; a != nil {
		st := a.status
		return &st, nil
	}
	return nil, refuse("unknown_attachment_is_not_proof_of_no_effect").unknown()
}

func (s *state) release(id string, rel b2.Release) (*b2.Receipt, error) {
	var a *attachment
	worker := ""
	if x := s.attachments[id]; x != nil {
		worker = x.status.WorkerId
	}
	return s.run(worker, rel.CommandId, "attachments.release", map[string]any{"attachment_id": id, "body": rel}, func() error {
		a = s.attachments[id]
		if a == nil {
			return refuse("unknown_attachment")
		}
		if a.status.State != "staged" {
			return refuse("attachment_not_staged")
		}
		return nil
	}, func(r *b2.Receipt) error {
		dispatch(r)
		s.releaseNow(id, rel.CommandId)
		deliver(r, "forwarded", map[string]any{"attachment_id": id, "state": "released"})
		return nil
	})
}

func (s *state) releaseNow(id, by string) {
	if a := s.attachments[id]; a != nil && a.status.State == "staged" {
		a.status.State, a.status.ReleasedAt, a.status.ReleasedBy = "released", ptr(now()), ptr(by)
		a.data = nil
		s.attachmentUpdated(a.status)
	}
}

// attachmentUpdated publishes an attachment's durable record (staged or released) as attachment.updated.
func (s *state) attachmentUpdated(st b2.AttachmentStatus) {
	s.publish("attachment.updated", st.WorkerId, nil, "supervisor_journal_fsynced", map[string]any{"attachment": st})
}

// forPrompt checks the attachments a prompt names: this worker's, staged, within the per-message limits.
func (s *state) forPrompt(workerID string, list []struct {
	AttachmentId b2.Id `json:"attachment_id"`
}) error {
	if len(list) > attachmentsPerMessage {
		return refuse("too_many_attachments")
	}
	seen := map[string]bool{}
	total := 0
	for _, x := range list {
		if seen[x.AttachmentId] {
			return refuse("duplicate_attachment")
		}
		seen[x.AttachmentId] = true
		a := s.attachments[x.AttachmentId]
		if a == nil || a.status.WorkerId != workerID {
			return refuse("unknown_attachment")
		}
		if a.status.State != "staged" {
			return refuse("attachment_not_staged")
		}
		total += a.status.Bytes
	}
	if total > attachmentsTotalBytes {
		return refuse("attachments_too_large")
	}
	return nil
}
