package b2

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strconv"
	"testing"
)

func historyHeaders(w http.ResponseWriter, session string, offset, next int, reset bool) {
	h := w.Header()
	h.Set("Content-Type", "application/x-ndjson")
	h.Set("Piw-Session-Id", session)
	h.Set("Piw-File-Identity", "0000000000000000000000000000000000000000000000000000000000000000")
	h.Set("Piw-Offset", strconv.Itoa(offset))
	h.Set("Piw-Next-Offset", strconv.Itoa(next))
	h.Set("Piw-Watermark", strconv.Itoa(next))
	h.Set("Piw-Reset", strconv.FormatBool(reset))
	h.Set("Piw-Prefix-Sha256", "1111111111111111111111111111111111111111111111111111111111111111")
	h.Set("Piw-History-Line-Max", "67108864")
}

// A byte read whose headers name another read than the one asked for is not that read: another session, another
// start without a reset, another blob, or bytes that are not the hashed ones fail UnknownEffect (PR #16 Grok 4).
func TestByteReadsRefuseAReplyForAnotherRead(t *testing.T) {
	path := socketPath(t)
	line := "{\"type\":\"session\"}\n"
	png := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
	serveHTTP(t, path, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/b2/sessions/s-other/history":
			historyHeaders(w, "session-1", 0, len(line), false)
		case "/b2/sessions/s-1/history":
			if r.URL.Query().Get("offset") == "19" {
				historyHeaders(w, "s-1", 0, len(line), false) // byte zero again, without a reset
			} else {
				historyHeaders(w, "s-1", 0, len(line), r.URL.Query().Get("offset") == "7")
			}
		default:
			sum := sha256.Sum256(png)
			h := w.Header()
			h.Set("Content-Type", "image/png")
			h.Set("Piw-Session-Id", "s-1")
			h.Set("Piw-Entry-Id", "e2")
			h.Set("Piw-Blob-Index", "0")
			h.Set("Piw-Blob-Sha256", hex.EncodeToString(sum[:]))
			if r.URL.Path == "/b2/sessions/s-1/entries/e2/blobs/1" {
				h.Set("Piw-Blob-Sha256", "2222222222222222222222222222222222222222222222222222222222222222")
				h.Set("Piw-Blob-Index", "1")
			}
			w.Write(png)
			return
		}
		w.Write([]byte(line))
	})
	c := New(path)
	ctx := context.Background()
	unknown := func(what string, err error) {
		t.Helper()
		if f := asFailure(t, err); f.Effect != UnknownEffect || f.Phase != PhaseAfterWrite {
			t.Fatalf("%s: %v, want after_write unknown", what, err)
		}
	}
	_, err := c.SessionsHistory(ctx, "s-other", nil)
	unknown("another session's bytes", err)
	offset := 19
	_, err = c.SessionsHistory(ctx, "s-1", &SessionsHistoryParams{Offset: &offset})
	unknown("byte zero again without a reset", err)
	if h, err := c.SessionsHistory(ctx, "s-1", nil); err != nil || h.SessionID != "s-1" {
		t.Fatalf("the read asked for: %+v %v", h, err)
	}
	reset := 7
	if h, err := c.SessionsHistory(ctx, "s-1", &SessionsHistoryParams{Offset: &reset}); err != nil || !h.Reset {
		t.Fatalf("a reset from byte zero: %+v %v", h, err)
	}
	_, err = c.BlobsRead(ctx, "s-1", "e9", 0)
	unknown("another entry's blob", err)
	_, err = c.BlobsRead(ctx, "s-2", "e2", 0)
	unknown("another session's blob", err)
	_, err = c.BlobsRead(ctx, "s-1", "e2", 1)
	unknown("bytes that are not the hashed ones", err)
	if b, err := c.BlobsRead(ctx, "s-1", "e2", 0); err != nil || b.EntryID != "e2" {
		t.Fatalf("the blob asked for: %+v %v", b, err)
	}
}
