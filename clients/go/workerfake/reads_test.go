package workerfake_test

// The session catalog and its byte reads against the stateful fake (PR #16 GPT 2, Grok 4): a live session's history
// is its own file, a continuation is EOF at the watermark (never byte zero again), appends and rewrites read as the
// worker serves them, and a read the fake does not know is refused, never answered with another request's fixture.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

func TestSessionHistoryReadsTheSessionsOwnFile(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId

	first, err := c.SessionsHistory(ctx, sid, nil)
	if err != nil {
		t.Fatal(err)
	}
	var header struct{ Type, Id, Cwd string }
	if first.SessionID != sid || first.Offset != 0 || first.Reset || json.Unmarshal(bytes.TrimSpace(first.Body), &header) != nil || header.Type != "session" || header.Id != sid || header.Cwd != w.Cwd {
		t.Fatalf("first read %+v %s", first, first.Body)
	}
	// Nothing new: EOF at the watermark, never the same bytes again.
	eof, err := c.SessionsHistory(ctx, sid, first.Next(nil))
	if err != nil || eof.Offset != first.NextOffset || eof.NextOffset != first.NextOffset || len(eof.Body) != 0 || eof.Reset {
		t.Fatalf("continuation %+v %v", eof, err)
	}
	// Appended lines read from where the reader stopped; a partial line waits for its line feed.
	entry := `{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}` + "\n"
	if err := fake.AppendHistory(sid, []byte(entry+`{"type":"mess`)); err != nil {
		t.Fatal(err)
	}
	more, err := c.SessionsHistory(ctx, sid, eof.Next(nil))
	if err != nil || string(more.Body) != entry || more.Offset != first.NextOffset || more.Reset {
		t.Fatalf("after an append %+v %v", more, err)
	}
	row, _ := c.WorkersGet(ctx, w.WorkerId)
	if row.History.LastEntryId == nil || *row.History.LastEntryId != "e1" {
		t.Fatalf("history marker %+v", row.History)
	}
	// Small pages: complete lines only.
	one := 10
	page, err := c.SessionsHistory(ctx, sid, &b2.SessionsHistoryParams{MaxBytes: &one})
	if err != nil || page.NextOffset != first.NextOffset {
		t.Fatalf("a line longer than max_bytes is returned alone: %+v %v", page, err)
	}
	// Offsets past the watermark or inside a line are typed errors, never an empty page.
	past, inside := int(more.Watermark)+5, 3
	if _, err := c.SessionsHistory(ctx, sid, &b2.SessionsHistoryParams{Offset: &past}); !isRefusal(err, http.StatusBadRequest, "history_offset_past_watermark") {
		t.Fatalf("past the watermark: %v", err)
	}
	if _, err := c.SessionsHistory(ctx, sid, &b2.SessionsHistoryParams{Offset: &inside}); !isRefusal(err, http.StatusBadRequest, "history_offset_not_line_start") {
		t.Fatalf("inside a line: %v", err)
	}
	// A rewrite in place resets a reader that names its identity, tail and prefix.
	if err := fake.ReplaceHistory(sid, append(bytes.Clone(first.Body), []byte(`{"type":"message","id":"e9"}`+"\n")...)); err != nil {
		t.Fatal(err)
	}
	again, err := c.SessionsHistory(ctx, sid, more.Next(nil))
	if err != nil || !again.Reset || again.Offset != 0 || again.FileIdentity == more.FileIdentity {
		t.Fatalf("after a rewrite %+v %v", again, err)
	}
	// Another session's bytes are never served: an unknown session is refused.
	if _, err := c.SessionsHistory(ctx, "session-1", nil); !isRefusal(err, http.StatusConflict, "unknown_session") {
		t.Fatalf("a session the catalog does not know: %v", err)
	}
}

func TestCatalogReadsAnswerFromTheFakesSessions(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId

	// A blob is an image of one of the session's entries.
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
	entry := fmt.Sprintf(`{"type":"message","id":"e2","message":{"role":"user","content":[{"type":"text","text":"see"},{"type":"image","data":%q,"mimeType":"image/png"}]}}`+"\n", base64.StdEncoding.EncodeToString(png))
	if err := fake.AppendHistory(sid, []byte(entry)); err != nil {
		t.Fatal(err)
	}
	blob, err := c.BlobsRead(ctx, sid, "e2", 0)
	if err != nil || !bytes.Equal(blob.Body, png) || blob.ContentType != "image/png" || blob.SessionID != sid {
		t.Fatalf("blob %+v %v", blob, err)
	}
	for _, tc := range []struct {
		session, entry string
		index          int
		refusal        string
	}{{sid, "e2", 1, "unknown_blob"}, {sid, "e404", 0, "unknown_entry"}, {"session-1", "e2", 0, "unknown_session"}} {
		if _, err := c.BlobsRead(ctx, tc.session, tc.entry, tc.index); !isRefusal(err, http.StatusConflict, tc.refusal) {
			t.Fatalf("blob %s/%s/%d: %v, want %s", tc.session, tc.entry, tc.index, err, tc.refusal)
		}
	}

	// The catalog row is this session's.
	row, err := c.SessionsGet(ctx, sid)
	if err != nil || row.SessionId != sid || row.Cwd != w.Cwd || row.LastWorkerId != w.WorkerId || row.HolderWorkerId == nil || *row.HolderWorkerId != w.WorkerId || row.MessageCount != 1 {
		t.Fatalf("session row %+v %v", row, err)
	}
	if _, err := c.SessionsGet(ctx, "session-1"); !isRefusal(err, http.StatusConflict, "unknown_session") {
		t.Fatalf("an unknown session row: %v", err)
	}
	list, err := c.SessionsList(ctx, &b2.SessionsListParams{Cwd: &w.Cwd})
	if err != nil || len(list.Sessions) != 1 || list.Sessions[0].SessionId != sid {
		t.Fatalf("sessions %+v %v", list, err)
	}

	// Feature catalogs answer for a ready worker or a directory, never for a worker the fake does not have.
	if m, err := c.ModelsList(ctx, &b2.ModelsListParams{WorkerId: &w.WorkerId}); err != nil || len(m.Models) == 0 || m.Evidence != "pi_worker_process" {
		t.Fatalf("models %+v %v", m, err)
	}
	if _, err := c.CommandsList(ctx, &b2.CommandsListParams{WorkerId: ptr("worker-1")}); !isRefusal(err, http.StatusConflict, "unknown_worker") {
		t.Fatalf("commands of an unknown worker: %v", err)
	}
	dir := t.TempDir()
	if m, err := c.ModelsList(ctx, &b2.ModelsListParams{Cwd: &dir}); err != nil || m.Evidence != "pi_inventory_process" {
		t.Fatalf("models for a cwd %+v %v", m, err)
	}
	if _, err := c.ModelsList(ctx, &b2.ModelsListParams{Cwd: &w.Cwd}); !isRefusal(err, http.StatusConflict, "cwd_not_directory") {
		t.Fatalf("models for a missing directory: %v", err)
	}
	// A read the fake does not model answers only its exact fixture, never another request's.
	if _, err := c.HistoryPage(ctx, w.WorkerId, nil); !isRefusal(err, http.StatusNotFound, "fixture_not_found") {
		t.Fatalf("history.page of a live worker: %v", err)
	}
}
