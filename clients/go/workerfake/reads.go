package workerfake

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// The session catalog and its reads, as packages/worker/src/supervisor/features.ts and history/session-file.ts serve
// them: every session a worker of this fake has bound has a session file (its header line, then whatever
// AppendHistory adds); sessions.get and sessions.list read the catalog, sessions.history reads a file's complete
// lines by byte range with the identity, tail and prefix checks, and blobs.read an image of one of its entries. A
// session the catalog does not know is unknown_session, never another session's bytes.

const (
	historyLineMax   = 64 << 20
	historyDefault   = 1 << 20
	historyMaxBytes  = 16 << 20
	blobMaxBytes     = 16 << 20
	sessionsDefault  = 100
	sessionsMaxLimit = 1000
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

type sessionFile struct {
	id         string
	data       []byte
	generation int // bumped by ReplaceHistory: a rewrite in place changes the file identity
	cwd        string
	created    string
	lastActive string
	owner      string // the last worker that bound the session
}

func sha(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// identity is stable across appends; another first line or a rewrite in place changes it.
func (sf *sessionFile) identity() string {
	first := sf.data
	if nl := bytes.IndexByte(first, '\n'); nl >= 0 {
		first = first[:nl+1]
	} else {
		first = nil
	}
	return sha([]byte(fmt.Sprintf("fake:%s:%s:%d", sf.id, sha(first), sf.generation)))
}

// watermark is the byte after the last complete line.
func (sf *sessionFile) watermark() int { return bytes.LastIndexByte(sf.data, '\n') + 1 }

// lineStartBefore is the start of the line that ends at end (a line start).
func (sf *sessionFile) lineStartBefore(end int) int {
	return bytes.LastIndexByte(sf.data[:end-1], '\n') + 1
}

// lastEntryID is the id of the last complete entry line (not the header), or nil.
func (sf *sessionFile) lastEntryID() *string {
	lines := bytes.Split(sf.data[:sf.watermark()], []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var e struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(lines[i], &e) == nil && e.Type != "session" && e.ID != "" {
			return &e.ID
		}
	}
	return nil
}

// bindSession records that w holds sessionID: a new session gets its file (the header line pi writes).
func (s *state) bindSession(w *worker, sessionID string) {
	sf := s.sessions[sessionID]
	if sf == nil {
		created := now()
		header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": sessionID, "timestamp": created, "cwd": w.row.Cwd})
		sf = &sessionFile{id: sessionID, data: append(header, '\n'), cwd: w.row.Cwd, created: created, lastActive: created}
		s.sessions[sessionID] = sf
	}
	sf.owner = w.row.WorkerId
	s.historyMarker(w, sf)
}

// historyMarker sets the holder's row from its session file: the last entry, the leaf.
func (s *state) historyMarker(w *worker, sf *sessionFile) {
	w.row.History.LastEntryId = sf.lastEntryID()
	w.row.LeafId = sf.lastEntryID()
}

// AppendHistory appends bytes to a session's file as pi writes them (fixture control): complete lines become
// readable, a trailing partial line waits for its line feed. The worker holding the session publishes
// history.appended.
func (f *Fake) AppendHistory(sessionID string, data []byte) error {
	return f.changeHistory(sessionID, func(sf *sessionFile) { sf.data = append(sf.data, data...) })
}

// ReplaceHistory rewrites a session's file in place (fixture control): readers holding an older identity, tail or
// prefix read it again from byte 0 with Piw-Reset.
func (f *Fake) ReplaceHistory(sessionID string, data []byte) error {
	return f.changeHistory(sessionID, func(sf *sessionFile) {
		sf.data = bytes.Clone(data)
		sf.generation++
	})
}

func (f *Fake) changeHistory(sessionID string, change func(*sessionFile)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.st
	sf := s.sessions[sessionID]
	if sf == nil {
		return errors.New("unknown_session")
	}
	change(sf)
	sf.lastActive = now()
	for _, id := range s.order {
		w := s.workers[id]
		if derefString(w.row.SessionId) == sessionID && holding(w.row.Status) {
			s.historyMarker(w, sf)
			s.persist(w)
			s.publish("history.appended", id, executionOf(w), "observed_memory", map[string]any{
				"session_id": sessionID, "file_identity": sf.identity(), "watermark": sf.watermark(), "last_entry_id": sf.lastEntryID(),
			})
		}
	}
	return nil
}

func (s *state) sessionRow(sf *sessionFile) b2.SessionRow {
	owner := s.workers[sf.owner]
	var holder *string
	for _, id := range s.order {
		if w := s.workers[id]; derefString(w.row.SessionId) == sf.id && holding(w.row.Status) {
			holder = ptr(id)
		}
	}
	messages, stats, preview := summarize(sf.data[:sf.watermark()])
	lineage := b2.Lineage("root")
	if owner.row.ParentWorkerId != nil {
		lineage = "child"
	}
	var title *string
	if derefString(owner.row.SessionId) == sf.id {
		title = owner.row.Title
	}
	return b2.SessionRow{
		SessionId: sf.id, Cwd: sf.cwd, Title: title, CreatedAt: &sf.created, LastActivityAt: &sf.lastActive,
		MessageCount: messages, Preview: preview, Stats: stats, HolderWorkerId: holder, LastWorkerId: sf.owner, Fenced: owner.row.Fence != nil,
		Lineage: lineage, Evidence: "pi_session_file",
	}
}

// lastEntryTime is the timestamp of the newest entry after the header (history/session-file.ts fold: every entry with
// a string timestamp moves it), or nil when pi wrote none.
func lastEntryTime(data []byte) *string {
	var last *string
	for _, line := range bytes.Split(data, []byte("\n")) {
		var e struct {
			Type      string `json:"type"`
			Timestamp any    `json:"timestamp"`
		}
		if json.Unmarshal(line, &e) != nil || e.Type == "session" {
			continue
		}
		if ts, ok := e.Timestamp.(string); ok {
			last = ptr(ts)
		}
	}
	return last
}

// interruptMarker is the worker's interrupt marker line (history/session-file.ts INTERRUPT_MARKER).
const interruptMarker = "[The previous request was interrupted by the user before it finished.]"

// previewChars is the longest preview, in UTF-16 code units as the worker slices it.
const previewChars = 280

// summarize folds a session file's complete lines as the worker's summary does (history/session-file.ts fold): the
// message count, the stats (models always an array, never null) and the newest user or assistant text as the preview.
func summarize(data []byte) (int, b2.SessionStats, *string) {
	type model struct {
		provider, model string
		messages        int
		tokens, cost    float64
	}
	var (
		count, users, assistants, tools int
		in, out, cacheRead, cacheWrite  float64
		total, cost                     float64
		models                          []*model
		preview                         *string
	)
	setPreview := func(text string) {
		if text = strings.TrimSpace(text); text != "" {
			preview = ptr(utf16Prefix(text, previewChars))
		}
	}
	for _, line := range bytes.Split(data, []byte("\n")) {
		var e struct {
			Type    string
			Message struct {
				Role     string
				Content  any
				Provider any
				Model    any
				Usage    struct {
					Input, Output, CacheRead, CacheWrite, TotalTokens any
					Cost                                              struct{ Total any }
				}
			}
		}
		if json.Unmarshal(line, &e) != nil || (e.Type != "message" && e.Type != "custom_message") {
			continue
		}
		count++
		if e.Type != "message" {
			continue
		}
		m := e.Message
		switch m.Role {
		case "user":
			users++
			setPreview(stripMarker(textOf(m.Content)))
		case "assistant":
			assistants++
			content, _ := m.Content.([]any)
			for _, c := range content {
				if part, ok := c.(map[string]any); ok && part["type"] == "toolCall" {
					tools++
				}
			}
			setPreview(textOf(content))
			u := m.Usage
			t := num(u.TotalTokens)
			if t == 0 {
				t = num(u.Input) + num(u.Output) + num(u.CacheRead) + num(u.CacheWrite)
			}
			c := num(u.Cost.Total)
			in, out, cacheRead, cacheWrite = in+num(u.Input), out+num(u.Output), cacheRead+num(u.CacheRead), cacheWrite+num(u.CacheWrite)
			total, cost = total+t, cost+c
			provider, name := "unknown", "unknown"
			if m.Provider != nil {
				provider = utf16Prefix(jsString(m.Provider), 128)
			}
			if m.Model != nil {
				name = utf16Prefix(jsString(m.Model), 256)
			}
			i := slices.IndexFunc(models, func(r *model) bool { return r.provider == provider && r.model == name })
			if i < 0 && len(models) < 64 {
				models, i = append(models, &model{provider: provider, model: name}), len(models)
			}
			if i >= 0 {
				models[i].messages++
				models[i].tokens += t
				models[i].cost += c
			}
		}
	}
	stats := b2.SessionStats{
		UserMessages: users, AssistantMessages: assistants, ToolCalls: tools, CostTotal: float32(cost),
		Tokens: b2.SessionTokens{Input: int(in), Output: int(out), CacheRead: int(cacheRead), CacheWrite: int(cacheWrite), Total: int(total)},
	}
	stats.Models = make([]struct {
		AssistantMessages int     `json:"assistant_messages"`
		CostTotal         float32 `json:"cost_total"`
		Model             string  `json:"model"`
		Provider          string  `json:"provider"`
		TokensTotal       int     `json:"tokens_total"`
	}, len(models))
	for i, r := range models {
		stats.Models[i].Provider, stats.Models[i].Model, stats.Models[i].AssistantMessages = r.provider, r.model, r.messages
		stats.Models[i].TokensTotal, stats.Models[i].CostTotal = int(r.tokens), float32(r.cost)
	}
	return count, stats, preview
}

// firstUserLine is the first line of the first user text (history/session-file.ts fold): marker stripped, trimmed,
// at most previewChars; nil before a user message with text.
func firstUserLine(data []byte) *string {
	for _, line := range bytes.Split(data, []byte("\n")) {
		var e struct {
			Type    string
			Message struct {
				Role    string
				Content any
			}
		}
		if json.Unmarshal(line, &e) != nil || e.Type != "message" || e.Message.Role != "user" {
			continue
		}
		if text := strings.TrimSpace(stripMarker(textOf(e.Message.Content))); text != "" {
			first, _, _ := strings.Cut(text, "\n")
			return ptr(utf16Prefix(strings.TrimSpace(first), previewChars))
		}
	}
	return nil
}

// textOf is a message's text: a string content, or its text parts joined by line feeds.
func textOf(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	parts, _ := content.([]any)
	var texts []string
	for _, c := range parts {
		if part, ok := c.(map[string]any); ok && part["type"] == "text" {
			if s, ok := part["text"].(string); ok {
				texts = append(texts, s)
			}
		}
	}
	return strings.Join(texts, "\n")
}

// stripMarker is a user's text without the worker's interrupt marker line.
func stripMarker(text string) string {
	rest, ok := strings.CutPrefix(text, interruptMarker)
	if !ok {
		return text
	}
	if r, ok := strings.CutPrefix(rest, "\r\n"); ok {
		return r
	}
	return strings.TrimPrefix(rest, "\n")
}

// num is a finite, non-negative JSON number, else 0.
func num(v any) float64 {
	if n, ok := v.(float64); ok && n >= 0 {
		return n
	}
	return 0
}

// jsString is String(v) for a provider or model name (a string; other JSON values as their JSON text).
func jsString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// utf16Prefix is s cut to at most n UTF-16 code units (JavaScript's slice), never inside a character.
func utf16Prefix(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

func (s *state) catalog(id string) (*sessionFile, error) {
	sf := s.sessions[id]
	if sf == nil {
		return nil, refuse("unknown_session")
	}
	return sf, nil
}

func invalidParameters() *refusal { return badRequest("invalid_parameters") }

func sessionsGet(s *state, c *call) (any, error) {
	sf, err := s.catalog(c.path["session_id"])
	if err != nil {
		return nil, err
	}
	return s.sessionRow(sf), nil
}

func sessionsList(s *state, c *call) (any, error) {
	limit := sessionsDefault
	if v, ok := c.query["limit"]; ok {
		n, err := strconv.Atoi(v[0])
		if err != nil || n < 1 || n > sessionsMaxLimit {
			return nil, invalidParameters()
		}
		limit = n
	}
	cwd, filtered := c.query["cwd"]
	rows := []b2.SessionRow{}
	for _, sf := range s.sessions {
		if !filtered || sf.cwd == cwd[0] {
			rows = append(rows, s.sessionRow(sf))
		}
	}
	slices.SortFunc(rows, func(a, b b2.SessionRow) int {
		if c := strings.Compare(*b.LastActivityAt, *a.LastActivityAt); c != 0 {
			return c
		}
		return strings.Compare(a.SessionId, b.SessionId)
	})
	out := b2.SessionList{Sessions: rows, Truncated: len(rows) > limit}
	if out.Truncated {
		out.Sessions = rows[:limit]
	}
	return out, nil
}

// sessionsHistory is readHistory (history/session-file.ts) over the fake's session file.
func sessionsHistory(s *state, c *call) (any, error) {
	sf, err := s.catalog(c.path["session_id"])
	if err != nil {
		return nil, err
	}
	q := func(name string) *string {
		if v, ok := c.query[name]; ok {
			return &v[0]
		}
		return nil
	}
	number := func(name string, def, lo, hi int) (int, bool) {
		v := q(name)
		if v == nil {
			return def, true
		}
		n, err := strconv.Atoi(*v)
		return n, err == nil && n >= lo && n <= hi
	}
	offset, ok1 := number("offset", 0, 0, 1<<53-1)
	maxBytes, ok2 := number("max_bytes", historyDefault, 1, historyMaxBytes)
	identity, tail, prefix := q("identity"), q("tail"), q("prefix")
	if f := q("format"); !ok1 || !ok2 || (f != nil && *f != "jsonl") {
		return nil, invalidParameters()
	}
	for _, h := range []*string{identity, tail, prefix} {
		if h != nil && !hex64.MatchString(*h) {
			return nil, invalidParameters()
		}
	}
	data, watermark, id := sf.data, sf.watermark(), sf.identity()
	start := offset
	reset := identity != nil && *identity != id
	if !reset && start > 0 {
		onLine := start <= watermark && data[start-1] == '\n'
		switch {
		case tail != nil:
			if !onLine || sha(data[sf.lineStartBefore(start):start]) != *tail {
				reset = true
			}
		case prefix != nil:
			if !onLine {
				reset = true
			}
		case start > watermark:
			return nil, badRequest("history_offset_past_watermark")
		case !onLine:
			return nil, badRequest("history_offset_not_line_start")
		}
	}
	if !reset && prefix != nil && sha(data[:start]) != *prefix {
		reset = true
	}
	if reset {
		start = 0
	}
	end := min(watermark, start+maxBytes)
	if end > start {
		if nl := bytes.LastIndexByte(data[start:end], '\n'); nl >= 0 {
			end = start + nl + 1
		} else {
			// One line longer than max_bytes: that line alone, so a reader always makes progress.
			nl := bytes.IndexByte(data[end:watermark], '\n')
			if nl < 0 || end+nl+1-start > historyLineMax {
				return nil, refuse("history_line_too_large")
			}
			end += nl + 1
		}
	}
	body := data[start:end]
	headers := map[string]string{
		"Piw-Session-Id": sf.id, "Piw-File-Identity": id, "Piw-Offset": strconv.Itoa(start), "Piw-Next-Offset": strconv.Itoa(end),
		"Piw-Watermark": strconv.Itoa(watermark), "Piw-Reset": strconv.FormatBool(reset), "Piw-Prefix-Sha256": sha(data[:end]),
		"Piw-History-Line-Max": strconv.Itoa(historyLineMax),
	}
	if len(body) > 0 {
		headers["Piw-Tail-Sha256"] = sha(body[bytes.LastIndexByte(body[:len(body)-1], '\n')+1:])
	} else if start > 0 {
		headers["Piw-Tail-Sha256"] = sha(data[sf.lineStartBefore(start):start])
	}
	return &rawReply{header: headers, contentType: "application/x-ndjson", body: bytes.Clone(body)}, nil
}

type image struct {
	data     string
	mimeType any
}

// images collects an entry's image blocks in document order.
func images(raw json.RawMessage, out *[]image, depth int) {
	raw = bytes.TrimSpace(raw)
	if depth > 64 || len(raw) == 0 {
		return
	}
	switch raw[0] {
	case '[':
		var list []json.RawMessage
		json.Unmarshal(raw, &list)
		for _, v := range list {
			images(v, out, depth+1)
		}
	case '{':
		dec := json.NewDecoder(bytes.NewReader(raw))
		if _, err := dec.Token(); err != nil {
			return
		}
		var keys []string
		var values []json.RawMessage
		for dec.More() {
			k, err := dec.Token()
			if err != nil {
				return
			}
			var v json.RawMessage
			if err := dec.Decode(&v); err != nil {
				return
			}
			keys, values = append(keys, k.(string)), append(values, v)
		}
		fields := map[string]json.RawMessage{}
		for i, k := range keys {
			fields[k] = values[i]
		}
		var typ, data string
		if json.Unmarshal(fields["type"], &typ) == nil && typ == "image" && json.Unmarshal(fields["data"], &data) == nil {
			var mimeType any
			json.Unmarshal(fields["mimeType"], &mimeType)
			*out = append(*out, image{data: data, mimeType: mimeType})
			return
		}
		for _, v := range values {
			images(v, out, depth+1)
		}
	}
}

// blobsRead is features.ts blob over the fake's session file.
func blobsRead(s *state, c *call) (any, error) {
	sf, err := s.catalog(c.path["session_id"])
	if err != nil {
		return nil, err
	}
	entryID := c.path["entry_id"]
	index, err := strconv.Atoi(c.path["index"])
	if err != nil || index < 0 {
		return nil, invalidParameters()
	}
	var line []byte
	for _, l := range bytes.Split(sf.data[:sf.watermark()], []byte("\n")) {
		var e struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(l, &e) == nil && e.Type != "session" && e.ID == entryID {
			line = l
		}
	}
	if line == nil {
		return nil, refuse("unknown_entry")
	}
	if !json.Valid(line) {
		return nil, refuse("entry_unreadable")
	}
	var found []image
	images(line, &found, 0)
	if index >= len(found) {
		return nil, refuse("unknown_blob")
	}
	img := found[index]
	mimeType, _ := img.mimeType.(string)
	mimeType = strings.ToLower(mimeType)
	if !slices.Contains([]string{"image/jpeg", "image/png", "image/webp", "image/gif"}, mimeType) {
		return nil, refuse("blob_type_not_allowed")
	}
	if len(img.data) > (blobMaxBytes+2)/3*4+4 {
		return nil, refuse("blob_too_large")
	}
	data, err := base64.StdEncoding.DecodeString(img.data)
	if err != nil {
		return nil, refuse("entry_unreadable")
	}
	if len(data) > blobMaxBytes {
		return nil, refuse("blob_too_large")
	}
	magic := sniff(data) == mimeType
	if mimeType == "image/gif" {
		magic = bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a"))
	}
	if !magic {
		return nil, refuse("blob_type_mismatch")
	}
	return &rawReply{contentType: mimeType, body: data, header: map[string]string{
		"Piw-Session-Id": sf.id, "Piw-Entry-Id": entryID, "Piw-Blob-Index": strconv.Itoa(index), "Piw-Blob-Sha256": sha(data),
	}}, nil
}

// featureTarget is the target of models.list and commands.list: exactly one of a ready worker (whose pi reports
// the catalog of the operation's "ok" fixture) or an existing directory (an inventory pi, the "cwd" fixture or the
// "ok" one with inventory evidence).
func featureTarget(s *state, c *call, op string) (any, error) {
	worker, byWorker := c.query["worker_id"]
	cwd, byCwd := c.query["cwd"]
	if byWorker == byCwd {
		return nil, badRequest("name_exactly_one_of_worker_id_or_cwd")
	}
	evidence := "pi_worker_process"
	if byWorker {
		w, err := s.require(worker[0])
		if err != nil {
			return nil, err
		}
		if err := ready(w); err != nil {
			return nil, err
		}
	} else {
		if st, err := os.Stat(cwd[0]); err != nil || !st.IsDir() {
			return nil, refuse("cwd_not_directory")
		}
		evidence = "pi_inventory_process"
	}
	var body map[string]any
	for _, fx := range WireFixtures(op) {
		if fx.Response.Status != http.StatusOK {
			continue
		}
		var b map[string]any
		json.Unmarshal(fx.Response.Body, &b)
		if b["evidence"] == evidence {
			body = b
			break
		}
		if body == nil {
			body = b
		}
	}
	if body == nil {
		return nil, refuse("fixture_not_found").withStatus(http.StatusNotFound)
	}
	body["evidence"] = evidence
	return body, nil
}
