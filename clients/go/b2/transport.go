// Package b2 is the Go client for pi-worker's B2 API over its private Unix socket. Standard library only.
//
// Models (models.gen.go) come from oapi-codegen and the operation table (ops.gen.go) from tools/codegen, both
// generated from api/b2.openapi.yaml. The transport, the SSE loop and the error classification are hand-written
// here, as the contract requires:
//
//   - One attempt per call. Keep-alives are off, redirects are not followed, the body cannot be replayed.
//   - Before the bearer is sent, the socket peer's UID must be the expected worker owner (SO_PEERCRED).
//   - A failure before the connection is handed to the writer is NoEffect; after it, UnknownEffect.
//   - A worker refusal keeps the worker's effect; anything but an explicit no_effect is UnknownEffect.
package b2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// ProtocolMajor is the B2 protocol major this client speaks.
const ProtocolMajor = 0

const responseLimit = 2 << 20

// Client calls one worker. It is safe for concurrent use.
type Client struct {
	socketPath  string
	grantFile   string
	expectedUID int
	timeout     time.Duration
	http        *http.Client
}

// Option configures a Client.
type Option func(*Client)

// WithGrantFile names a 0600 JSON file {"token": "..."} written by `pi-worker grant register`. It is read on every
// call, so a rotated grant takes effect without a restart.
func WithGrantFile(path string) Option { return func(c *Client) { c.grantFile = path } }

// WithExpectedUID sets the UID the socket's listener must have. Default: this process's UID.
func WithExpectedUID(uid int) Option { return func(c *Client) { c.expectedUID = uid } }

// WithTimeout bounds each call. On expiry after the write the call fails UnknownEffect; it is never retried.
// Default 60 s; 0 disables the client-side bound (the context still applies).
func WithTimeout(d time.Duration) Option { return func(c *Client) { c.timeout = d } }

// New returns a client for the worker listening on socketPath.
func New(socketPath string, opts ...Option) *Client {
	c := &Client{socketPath: socketPath, expectedUID: os.Getuid(), timeout: 60 * time.Second}
	for _, opt := range opts {
		opt(c)
	}
	transport := &http.Transport{
		DialContext:       c.dial,
		DisableKeepAlives: true,
		Proxy:             nil,
		ForceAttemptHTTP2: false,
	}
	c.http = &http.Client{
		Transport: transport,
		// A followed redirect would send the request again.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return c
}

func (c *Client) dial(ctx context.Context, _, _ string) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", c.socketPath)
	if err != nil {
		return nil, err
	}
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		conn.Close()
		return nil, errors.New("b2: not a Unix socket connection")
	}
	uid, err := peerUID(unix)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("b2: reading peer credentials: %w", err)
	}
	if uid != c.expectedUID {
		conn.Close()
		return nil, fmt.Errorf("%w (peer uid %d, expected %d)", ErrPeerNotOwner, uid, c.expectedUID)
	}
	return conn, nil
}

func (c *Client) bearer() (string, error) {
	if c.grantFile == "" {
		return "", nil
	}
	data, err := os.ReadFile(c.grantFile)
	if err != nil {
		return "", fmt.Errorf("b2: grant file unreadable: %w", err)
	}
	var grant struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &grant); err != nil || grant.Token == "" {
		return "", errors.New("b2: grant file invalid")
	}
	return grant.Token, nil
}

// fillPath replaces each {name} in the operation's path, in order, with the escaped argument.
func fillPath(op Operation, args []string) (string, error) {
	var b strings.Builder
	rest := op.Path
	i := 0
	for {
		start := strings.IndexByte(rest, '{')
		if start < 0 {
			b.WriteString(rest)
			break
		}
		end := strings.IndexByte(rest[start:], '}')
		if end < 0 {
			return "", fmt.Errorf("b2: malformed path %q", op.Path)
		}
		if i >= len(args) {
			return "", fmt.Errorf("b2: %s needs %s", op.ID, rest[start:start+end+1])
		}
		b.WriteString(rest[:start])
		b.WriteString(url.PathEscape(args[i]))
		rest = rest[start+end+1:]
		i++
	}
	if i != len(args) {
		return "", fmt.Errorf("b2: %s takes %d path arguments, got %d", op.ID, i, len(args))
	}
	return b.String(), nil
}

// newRequest builds the request with a trace that records when the connection reaches the writer.
func (c *Client) newRequest(ctx context.Context, op Operation, path []string, query url.Values, body any, accept string, connected *atomic.Bool) (*http.Request, error) {
	target, err := fillPath(op, path)
	if err != nil {
		return nil, err
	}
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("b2: encoding body: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	token, err := c.bearer()
	if err != nil {
		return nil, err
	}
	// The boundary is the connection handoff, a conservative policy: GotConn fires after the dial and peer check,
	// just before the transport may write, and from then on every failure is unknown. WroteRequest (which Go also
	// fires, with its error, when a write fails partway) gives the same verdict. On Go 1.24 to 1.27 Do waits for
	// the write loop before returning an error, so the handoff rule only relabels a connected-but-unwritten failure
	// as unknown; it keeps that verdict if a later Go returns before the write loop reports.
	// TestClassificationBoundaryIsConnectionHandoff and TestFailureDuringPartialWriteIsUnknown pin both.
	trace := &httptrace.ClientTrace{
		GotConn:      func(httptrace.GotConnInfo) { connected.Store(true) },
		WroteRequest: func(httptrace.WroteRequestInfo) { connected.Store(true) },
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), op.Method, "http://pi-worker"+target, reader)
	if err != nil {
		return nil, err
	}
	req.GetBody = nil // the body can never be replayed
	req.Close = true
	req.Header.Set("Accept", accept)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req, nil
}

func (c *Client) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if c.timeout > 0 {
		return context.WithTimeout(ctx, c.timeout)
	}
	return context.WithCancel(ctx)
}

func transportFailure(op Operation, connected bool, err error) *ClientFailure {
	if connected {
		return &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: err}
	}
	return &ClientFailure{Op: op.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: err}
}

// refusal turns a non-200 reply into a ClientFailure that keeps the worker's effect.
func refusal(op Operation, status int, data []byte) *ClientFailure {
	f := &ClientFailure{Op: op.ID, Phase: PhaseHTTP, Effect: UnknownEffect, Status: status}
	var body Error
	if err := json.Unmarshal(data, &body); err == nil && body.Error != "" {
		f.Body = &body
		if body.Effect == NoEffect {
			f.Effect = NoEffect
		}
	} else {
		f.Err = fmt.Errorf("HTTP %d without a B2 Error body", status)
	}
	return f
}

// do sends one request once and decodes a 200 JSON reply into out.
func (c *Client) do(ctx context.Context, op Operation, path []string, query url.Values, body any, out any) error {
	ctx, cancel := c.withTimeout(ctx)
	defer cancel()
	var connected atomic.Bool
	req, err := c.newRequest(ctx, op, path, query, body, "application/json", &connected)
	if err != nil {
		return &ClientFailure{Op: op.ID, Phase: PhaseBeforeWrite, Effect: NoEffect, Err: err}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return transportFailure(op, connected.Load(), err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit+1))
	if err != nil {
		return &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: err}
	}
	if len(data) > responseLimit {
		return &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: errors.New("response too large")}
	}
	if resp.StatusCode != http.StatusOK {
		return refusal(op, resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &ClientFailure{Op: op.ID, Phase: PhaseAfterWrite, Effect: UnknownEffect, Err: fmt.Errorf("decoding reply: %w", err)}
	}
	return nil
}

// Hello negotiates the protocol: it refuses a worker whose protocol major this client does not speak.
func (c *Client) Hello(ctx context.Context) (*Hello, error) {
	var out Hello
	if err := c.do(ctx, OpHello, nil, nil, nil, &out); err != nil {
		return nil, err
	}
	if out.Protocol.Major != ProtocolMajor {
		return nil, &ProtocolMismatch{Major: out.Protocol.Major}
	}
	return &out, nil
}
