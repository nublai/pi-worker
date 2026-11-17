package b2

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"sync/atomic"
)

// The hand-written operations whose bodies are bytes, not JSON (plan P1-17): the streamed attachment upload
// (attachments.stage) and the byte reads (sessions.history, blobs.read). Same rules as every call: one attempt, no
// replay, NoEffect only before the connection handoff or on a worker's explicit no_effect.

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// AttachmentsStage streams one image to the worker (PUT /b2/attachments/{attachment_id}): exactly size bytes read
// once from body, never buffered whole and never re-sent. contentType must be one of OpAttachmentsStage.MediaTypes
// and size at most OpAttachmentsStage.MaxBodyBytes (hello.limits.attachment_max_bytes); either refusal happens
// before anything is sent (NoEffect). params.PiwContentSha256 is the lower-case hex SHA-256 of the bytes.
//
// A mutation: a failure after the connection handoff is UnknownEffect. Then read AttachmentsStatus for the
// attachment_id (or ReceiptsGet for the command_id) and never upload again blindly: the worker stages an id once,
// and the same id with the same SHA-256 answers with a receipt naming the original command.
func (c *Client) AttachmentsStage(ctx context.Context, attachmentID string, params AttachmentsStageParams, contentType string, size int64, body io.Reader) (*Receipt, error) {
	op := OpAttachmentsStage
	before := func(err error) error {
		return &ClientFailure{Op: op.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: err}
	}
	switch {
	case !slices.Contains(op.MediaTypes, contentType):
		return nil, before(fmt.Errorf("content type %q is not one of %v", contentType, op.MediaTypes))
	case size <= 0 || size > op.MaxBodyBytes:
		return nil, before(fmt.Errorf("size %d is not in 1..%d bytes", size, op.MaxBodyBytes))
	case body == nil:
		return nil, before(errors.New("no body"))
	case !sha256Hex.MatchString(params.PiwContentSha256):
		return nil, before(errors.New("Piw-Content-Sha256 must be 64 lower-case hex digits"))
	case params.PiwBindingRevision < 1:
		return nil, before(errors.New("Piw-Binding-Revision must be at least 1"))
	}
	ctx, cancel := c.withTimeout(ctx)
	defer cancel()
	var connected atomic.Bool
	// Exactly size bytes: a reader with fewer fails the write (UnknownEffect, the worker refuses a short body), one
	// with more is cut at size, which the SHA-256 check refuses.
	req, err := c.newRawRequest(ctx, op, []string{attachmentID}, nil, io.LimitReader(body, size), contentType, size, "application/json", &connected)
	if err != nil {
		return nil, before(err)
	}
	req.Header.Set("Piw-Command-Id", params.PiwCommandId)
	req.Header.Set("Piw-Worker-Id", params.PiwWorkerId)
	req.Header.Set("Piw-Worker-Epoch", params.PiwWorkerEpoch)
	req.Header.Set("Piw-Session-Id", params.PiwSessionId)
	req.Header.Set("Piw-Binding-Revision", strconv.Itoa(params.PiwBindingRevision))
	req.Header.Set("Piw-Content-Sha256", params.PiwContentSha256)
	var out Receipt
	if err := c.send(op, req, &connected, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ByteReply is the 200 of an ndjson or binary read: its headers, media type and body.
type ByteReply struct {
	Header      http.Header
	ContentType string
	Body        []byte
}

// readBytes performs one GET of an ndjson or binary operation, refusing a 200 body over op.MaxResponseBytes.
func (c *Client) readBytes(ctx context.Context, op Operation, path []string, query url.Values) (*ByteReply, error) {
	if op.Response != "ndjson" && op.Response != "binary" {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: errors.New("not a byte read")}
	}
	ctx, cancel := c.withTimeout(ctx)
	defer cancel()
	var connected atomic.Bool
	req, err := c.newRawRequest(ctx, op, path, query, nil, "", 0, "", &connected)
	if err != nil {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: err}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, transportFailure(op, connected.Load(), err)
	}
	defer resp.Body.Close()
	limit := int64(responseLimit)
	if resp.StatusCode == http.StatusOK {
		limit = op.MaxResponseBytes
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: err}
	}
	if int64(len(data)) > limit {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: errors.New("response too large")}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, refusal(op, resp.StatusCode, data)
	}
	mediaType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: fmt.Errorf("content type: %w", err)}
	}
	return &ByteReply{Header: resp.Header, ContentType: mediaType, Body: data}, nil
}

// HistoryBytes is one sessions.history reply: complete session-file lines from Offset to NextOffset.
type HistoryBytes struct {
	SessionID    string
	FileIdentity FileIdentity
	// Offset is where Body starts: 0 after a reset.
	Offset     int64
	NextOffset int64
	// Watermark is the file's complete size, the value history.appended carries.
	Watermark int64
	// Reset says the file was replaced, shrank or was rewritten: drop what was read and parse Body from byte 0.
	Reset bool
	// TailSha256 is empty when nothing precedes NextOffset.
	TailSha256   Sha256
	PrefixSha256 Sha256
	LineMax      int64
	Body         []byte
}

// Next returns the parameters of the read that continues after this one: the next offset with the identity, tail
// and prefix the worker checks to detect a rewrite.
func (h *HistoryBytes) Next(maxBytes *int) *SessionsHistoryParams {
	offset := int(h.NextOffset)
	p := &SessionsHistoryParams{Offset: &offset, MaxBytes: maxBytes, Identity: &h.FileIdentity, Prefix: &h.PrefixSha256}
	if h.TailSha256 != "" {
		p.Tail = &h.TailSha256
	}
	return p
}

// SessionsHistory reads a session file's complete lines by byte range (GET /b2/sessions/{session_id}/history),
// with or without a worker holding the session.
func (c *Client) SessionsHistory(ctx context.Context, sessionID string, params *SessionsHistoryParams) (*HistoryBytes, error) {
	op := OpSessionsHistory
	q := url.Values{}
	if params != nil {
		if params.Format != nil {
			q.Set("format", string(*params.Format))
		}
		if params.Offset != nil {
			q.Set("offset", strconv.Itoa(*params.Offset))
		}
		if params.MaxBytes != nil {
			q.Set("max_bytes", strconv.Itoa(*params.MaxBytes))
		}
		if params.Identity != nil {
			q.Set("identity", *params.Identity)
		}
		if params.Tail != nil {
			q.Set("tail", *params.Tail)
		}
		if params.Prefix != nil {
			q.Set("prefix", *params.Prefix)
		}
	}
	reply, err := c.readBytes(ctx, op, []string{sessionID}, q)
	if err != nil {
		return nil, err
	}
	h := headerReader{op: op, header: reply.Header}
	out := &HistoryBytes{
		SessionID:    h.text("Piw-Session-Id", true),
		FileIdentity: h.text("Piw-File-Identity", true),
		Offset:       h.integer("Piw-Offset"),
		NextOffset:   h.integer("Piw-Next-Offset"),
		Watermark:    h.integer("Piw-Watermark"),
		Reset:        h.boolean("Piw-Reset"),
		TailSha256:   h.text("Piw-Tail-Sha256", false),
		PrefixSha256: h.text("Piw-Prefix-Sha256", true),
		LineMax:      h.integer("Piw-History-Line-Max"),
		Body:         reply.Body,
	}
	if h.err == nil && reply.ContentType != "application/x-ndjson" {
		h.err = fmt.Errorf("content type %q", reply.ContentType)
	}
	if h.err == nil && (out.NextOffset-out.Offset != int64(len(out.Body)) || out.NextOffset > out.Watermark) {
		h.err = errors.New("offsets do not match the body")
	}
	// The reply must be the read asked for: this session, and the requested offset unless the worker says it reset.
	requested := int64(0)
	if params != nil && params.Offset != nil {
		requested = int64(*params.Offset)
	}
	if h.err == nil && out.SessionID != sessionID {
		h.err = fmt.Errorf("reply is for session %q, not %q", out.SessionID, sessionID)
	}
	if h.err == nil && !out.Reset && out.Offset != requested {
		h.err = fmt.Errorf("reply starts at %d without a reset, not at the requested %d", out.Offset, requested)
	}
	if h.err != nil {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: h.err}
	}
	return out, nil
}

// Blob is one image of a session entry, as pi stored it.
type Blob struct {
	SessionID   string
	EntryID     string
	Index       int
	Sha256      Sha256
	ContentType string
	Body        []byte
}

// BlobsRead reads the index-th image of a session entry (GET /b2/sessions/{session_id}/entries/{entry_id}/blobs/{index}).
func (c *Client) BlobsRead(ctx context.Context, sessionID, entryID string, index int) (*Blob, error) {
	op := OpBlobsRead
	reply, err := c.readBytes(ctx, op, []string{sessionID, entryID, strconv.Itoa(index)}, nil)
	if err != nil {
		return nil, err
	}
	h := headerReader{op: op, header: reply.Header}
	out := &Blob{
		SessionID:   h.text("Piw-Session-Id", true),
		EntryID:     h.text("Piw-Entry-Id", true),
		Index:       int(h.integer("Piw-Blob-Index")),
		Sha256:      h.text("Piw-Blob-Sha256", true),
		ContentType: reply.ContentType,
		Body:        reply.Body,
	}
	// The reply must be the blob asked for, and its bytes the ones the worker hashed.
	switch {
	case h.err != nil:
	case out.SessionID != sessionID || out.EntryID != entryID || out.Index != index:
		h.err = fmt.Errorf("reply is blob %s/%s/%d, not %s/%s/%d", out.SessionID, out.EntryID, out.Index, sessionID, entryID, index)
	case !sha256Hex.MatchString(out.Sha256) || hexSum(out.Body) != out.Sha256:
		h.err = errors.New("body does not match Piw-Blob-Sha256")
	}
	if h.err != nil {
		return nil, &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: h.err}
	}
	return out, nil
}

func hexSum(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// headerReader parses response headers, keeping the first error.
type headerReader struct {
	op     Operation
	header http.Header
	err    error
}

func (h *headerReader) text(name string, required bool) string {
	v := h.header.Get(name)
	if v == "" && required && h.err == nil {
		h.err = fmt.Errorf("header %s missing", name)
	}
	return v
}

func (h *headerReader) integer(name string) int64 {
	v := h.text(name, true)
	n, err := strconv.ParseInt(v, 10, 64)
	if (err != nil || n < 0) && h.err == nil {
		h.err = fmt.Errorf("header %s: not a non-negative integer", name)
	}
	return n
}

func (h *headerReader) boolean(name string) bool {
	switch v := h.text(name, true); v {
	case "true":
		return true
	case "false":
		return false
	default:
		if h.err == nil {
			h.err = fmt.Errorf("header %s: not a boolean", name)
		}
		return false
	}
}
