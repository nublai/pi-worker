// Package workerfake is a fake pi-worker for driver tests: it serves B2 over a private Unix socket to the Go client
// (package b2) with a deterministic in-memory supervisor and fixture-only host controls, never a model.
//
// Two modes:
//
//   - Stateful (the default). Workers, bindings, executions, the follow-up queue, fences and their resolution,
//     receipts, interactions, attachments and the event stream follow the worker's rules (contract revision 8,
//     section 0.1); the Go replay of api/fixtures/transitions.json runs against it. Operations whose answer is not
//     state (models, commands, the session catalog and its history bytes, blobs, files) answer from the wire
//     fixtures: the fixture whose request matches exactly, else the operation's "ok" fixture.
//   - Replay (Options.Replay). Every operation answers only from its wire fixtures, matched exactly on path,
//     query, headers and body; anything else is 404 fixture_not_found. Use it to test that a driver handles every
//     documented reply, refusals included.
//
// The fake's grant is the "bridge" profile unless Options.Methods says otherwise, so a driver that calls a method
// outside its profile is refused grant_method_denied, as the worker would refuse it.
//
// Host controls (Host, Restart, Drain, Overflow, DropNextStageReply) are fixture controls: they stand in for pi and
// the supervisor process, never for model effects.
package workerfake

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"

	"github.com/nublai/pi-worker/clients/go/b2"
)

// Profile names for Options.Profile.
const (
	// ProfileUnconfirmedNativeIdentity: the host's process identity cannot be confirmed, so cleanup after a restart
	// or a lost host stays pending (fixture profile unconfirmed_native_identity).
	ProfileUnconfirmedNativeIdentity = "unconfirmed_native_identity"
)

// Options configures a Fake.
type Options struct {
	// Dir holds the socket and the grant file. Default: a new private temporary directory, removed by Close.
	Dir string
	// Methods the fake's grant allows. Nil means b2.GrantProfiles["bridge"]; AllMethods() allows every operation.
	Methods []string
	// Replay answers every operation only from its wire fixtures, with no state.
	Replay bool
	// Profile is a fixture host profile ("" or ProfileUnconfirmedNativeIdentity).
	Profile string
}

// AllMethods lists every operation in the spec, for Options.Methods.
func AllMethods() []string {
	out := make([]string, 0, len(b2.Operations))
	for _, op := range b2.Operations {
		out = append(out, op.ID)
	}
	return out
}

// Fake is one fake worker supervisor. Its methods are safe for concurrent use.
type Fake struct {
	opts      Options
	dir       string
	ownDir    bool
	socket    string
	grantFile string
	token     string
	methods   map[string]bool
	listener  net.Listener
	server    *http.Server
	closed    chan struct{}
	closeOnce sync.Once

	mu sync.Mutex
	st *state
}

// Start creates the socket and the grant file and serves until Close.
func Start(opts Options) (*Fake, error) {
	if _, err := loaded(); err != nil {
		return nil, err
	}
	f := &Fake{opts: opts, dir: opts.Dir, closed: make(chan struct{})}
	if f.dir == "" {
		dir, err := os.MkdirTemp("", "piw-fake-")
		if err != nil {
			return nil, err
		}
		f.dir, f.ownDir = dir, true
	}
	methods := opts.Methods
	if methods == nil {
		methods = b2.GrantProfiles["bridge"]
	}
	f.methods = map[string]bool{}
	for _, m := range methods {
		f.methods[m] = true
	}
	f.token = randomHex(32)
	f.grantFile = filepath.Join(f.dir, "grant.json")
	grant, _ := json.Marshal(map[string]string{"token": f.token})
	if err := os.WriteFile(f.grantFile, grant, 0o600); err != nil {
		f.cleanup()
		return nil, err
	}
	f.socket = filepath.Join(f.dir, "b2.sock")
	l, err := net.Listen("unix", f.socket)
	if err != nil {
		f.cleanup()
		return nil, err
	}
	if err := os.Chmod(f.socket, 0o600); err != nil {
		l.Close()
		f.cleanup()
		return nil, err
	}
	f.listener = l
	f.st = newState(f)
	f.server = &http.Server{Handler: f}
	go f.server.Serve(l)
	return f, nil
}

// SocketPath is the Unix socket the fake listens on.
func (f *Fake) SocketPath() string { return f.socket }

// GrantFile is the 0600 grant file ({"token": ...}) for b2.WithGrantFile.
func (f *Fake) GrantFile() string { return f.grantFile }

// Client returns a Go client for this fake with its grant file.
func (f *Fake) Client(opts ...b2.Option) *b2.Client {
	return b2.New(f.socket, append([]b2.Option{b2.WithGrantFile(f.grantFile)}, opts...)...)
}

// Close stops serving, ends every stream, releases held replies and removes a temporary directory it created.
func (f *Fake) Close() error {
	var err error
	f.closeOnce.Do(func() {
		close(f.closed)
		f.mu.Lock()
		f.st.endStreams()
		for _, w := range f.st.workers {
			for _, t := range w.timers {
				t.Stop()
			}
		}
		f.mu.Unlock()
		err = f.server.Close()
		f.cleanup()
	})
	return err
}

func (f *Fake) cleanup() {
	if f.ownDir {
		os.RemoveAll(f.dir)
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails on Linux; a fake without randomness is unusable
	}
	return hex.EncodeToString(b)
}

// refusal is a B2 refusal: an HTTP status and an Error body.
type refusal struct {
	status int
	body   b2.Error
}

func (r *refusal) Error() string { return r.body.Error }

// refuse is a 409 no_effect refusal.
func refuse(name string) *refusal {
	return &refusal{status: http.StatusConflict, body: b2.Error{Error: name, Effect: b2.NoEffect}}
}

func (r *refusal) withStatus(status int) *refusal { r.status = status; return r }

func (r *refusal) unknown() *refusal { r.body.Effect = b2.UnknownEffect; return r }

func (r *refusal) uncertain(commandID string) *refusal {
	if commandID != "" {
		r.body.UncertainCommandId = &commandID
	}
	return r
}

func badRequest(name string) *refusal { return refuse(name).withStatus(http.StatusBadRequest) }

// rawReply is an ndjson or binary 200.
type rawReply struct {
	header      map[string]string
	contentType string
	body        []byte
}

// written says the handler wrote the response itself (a stream, a dropped reply).
type written struct{}

// call is one request after routing.
type call struct {
	op     b2.Operation
	path   map[string]string
	query  url.Values
	header http.Header
	r      *http.Request
	w      http.ResponseWriter
	body   []byte
}

func (c *call) decode(out any) error {
	dec := json.NewDecoder(bytes.NewReader(c.body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return badRequest("request_schema_mismatch")
	}
	return nil
}

// route finds the operation and its path parameters.
func route(method, rawPath string) (b2.Operation, map[string]string, bool) {
	segments := strings.Split(strings.Trim(rawPath, "/"), "/")
	for _, op := range b2.Operations {
		if op.Method != method {
			continue
		}
		pattern := strings.Split(strings.Trim(op.Path, "/"), "/")
		if len(pattern) != len(segments) {
			continue
		}
		params := map[string]string{}
		ok := true
		for i, p := range pattern {
			if strings.HasPrefix(p, "{") && strings.HasSuffix(p, "}") {
				v, err := url.PathUnescape(segments[i])
				if err != nil || v == "" {
					ok = false
					break
				}
				params[p[1:len(p)-1]] = v
			} else if p != segments[i] {
				ok = false
				break
			}
		}
		if ok {
			return op, params, true
		}
	}
	return b2.Operation{}, nil, false
}

// ServeHTTP authenticates, routes and answers one request.
func (f *Fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	op, params, ok := route(r.Method, r.URL.EscapedPath())
	if !ok {
		writeRefusal(w, refuse("unknown_route").withStatus(http.StatusNotFound))
		return
	}
	if r.Header.Get("Authorization") == "" {
		writeRefusal(w, refuse("bearer_grant_required"))
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		writeRefusal(w, refuse("invalid_grant"))
		return
	}
	if !f.methods[op.ID] {
		writeRefusal(w, refuse("grant_method_denied"))
		return
	}
	c := &call{op: op, path: params, query: r.URL.Query(), header: r.Header, r: r, w: w}
	if op.Body == "json" {
		if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
			writeRefusal(w, refuse("content_type_must_be_json").withStatus(http.StatusUnsupportedMediaType))
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, op.MaxBodyBytes+1))
		if err != nil {
			writeRefusal(w, badRequest("request_body_unreadable"))
			return
		}
		if int64(len(body)) > op.MaxBodyBytes {
			writeRefusal(w, refuse("request_too_large").withStatus(http.StatusRequestEntityTooLarge))
			return
		}
		c.body = body
	}
	if op.Body == "binary" && f.opts.Replay {
		// Replay compares the whole body; a stateful upload streams it.
		body, err := io.ReadAll(io.LimitReader(r.Body, op.MaxBodyBytes+1))
		if err != nil || int64(len(body)) > op.MaxBodyBytes {
			writeRefusal(w, refuse("request_too_large").withStatus(http.StatusRequestEntityTooLarge))
			return
		}
		c.body = body
	}
	var out any
	var err error
	switch {
	case f.opts.Replay:
		out, err = replay(c, true)
	case statefulOps[op.ID] != nil:
		out, err = statefulOps[op.ID](f, c)
	default:
		out, err = replay(c, false)
	}
	f.reply(c, out, err)
}

func (f *Fake) reply(c *call, out any, err error) {
	w := c.w
	var ref *refusal
	switch {
	case errors.As(err, &ref):
		writeRefusal(w, ref)
	case err != nil:
		// Anything else after the handler started is unknown, as the worker reports it.
		writeRefusal(w, &refusal{status: http.StatusInternalServerError, body: b2.Error{Error: "fake_internal_error", Effect: b2.UnknownEffect, Detail: ptr(err.Error())}})
	default:
		switch v := out.(type) {
		case written:
		case *rawReply:
			for k, val := range v.header {
				w.Header().Set(k, val)
			}
			w.Header().Set("Content-Type", v.contentType)
			w.Header().Set("Content-Length", fmt.Sprint(len(v.body)))
			w.WriteHeader(http.StatusOK)
			w.Write(v.body)
		default:
			writeJSON(w, http.StatusOK, v)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		status = http.StatusInternalServerError
		data, _ = json.Marshal(b2.Error{Error: "fake_encoding_error", Effect: b2.UnknownEffect})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	w.WriteHeader(status)
	w.Write(data)
}

func writeRefusal(w http.ResponseWriter, r *refusal) { writeJSON(w, r.status, r.body) }

func ptr[T any](v T) *T { return &v }

// replay answers from the operation's wire fixtures: the one whose request matches exactly; else, unless exact,
// the "ok" fixture.
func replay(c *call, exact bool) (any, error) {
	fixtures := WireFixtures(c.op.ID)
	for _, fx := range fixtures {
		if matches(c, fx.Request) {
			return fixtureReply(c, fx.Response)
		}
	}
	if !exact && len(fixtures) > 0 && fixtures[0].Response.Status == http.StatusOK {
		return fixtureReply(c, fixtures[0].Response)
	}
	return nil, refuse("fixture_not_found").withStatus(http.StatusNotFound)
}

func matches(c *call, want WireRequest) bool {
	if !equalStrings(c.path, want.Path) {
		return false
	}
	query := map[string]string{}
	for k, v := range c.query {
		if len(v) != 1 {
			return false
		}
		query[k] = v[0]
	}
	if !equalStrings(query, want.Query) {
		return false
	}
	for k, v := range want.Headers {
		got := c.header.Get(k)
		if strings.EqualFold(k, "Content-Type") {
			got, _, _ = mime.ParseMediaType(got)
		}
		if got != v {
			return false
		}
	}
	switch c.op.Body {
	case "json":
		return sameJSON(c.body, want.Body)
	case "binary":
		data, err := base64.StdEncoding.DecodeString(want.BodyBase64)
		return err == nil && bytes.Equal(data, c.body)
	}
	return true
}

func equalStrings(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

func fixtureReply(c *call, resp WireResponse) (any, error) {
	if resp.Status != http.StatusOK {
		var body b2.Error
		if err := json.Unmarshal(resp.Body, &body); err != nil {
			return nil, err
		}
		return nil, &refusal{status: resp.Status, body: body}
	}
	switch {
	case resp.Frames != nil:
		writeFrames(c.w, resp.Frames)
		return written{}, nil
	case resp.BodyText != nil:
		return &rawReply{header: resp.Headers, contentType: resp.ContentType, body: []byte(*resp.BodyText)}, nil
	case resp.BodyBase64 != nil:
		data, err := base64.StdEncoding.DecodeString(*resp.BodyBase64)
		if err != nil {
			return nil, err
		}
		return &rawReply{header: resp.Headers, contentType: resp.ContentType, body: data}, nil
	default:
		return json.RawMessage(resp.Body), nil
	}
}

// writeFrames sends fixture frames as one finished SSE stream.
func writeFrames(w http.ResponseWriter, frames []json.RawMessage) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	for _, frame := range frames {
		var head struct {
			Type   string          `json:"type"`
			Cursor json.RawMessage `json:"cursor"`
		}
		json.Unmarshal(frame, &head)
		var compact bytes.Buffer
		json.Compact(&compact, frame)
		fmt.Fprintf(w, "id: %s\nevent: %s\ndata: %s\n\n", head.Cursor, head.Type, compact.Bytes())
	}
}

// sorted returns a map's keys in order.
func sorted[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
