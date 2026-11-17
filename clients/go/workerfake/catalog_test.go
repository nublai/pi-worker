package workerfake_test

// The stateful fake's catalog rows are the worker's (PR #16 GPT delta): sessions.get and sessions.list replies
// satisfy the spec's response schemas (stats.models is an array, never null), and their counters and preview are
// the session file's summary, as packages/worker/src/history/session-file.ts folds it.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/nublai/pi-worker/clients/go/b2"
	"github.com/nublai/pi-worker/clients/go/workerfake"
)

// spec is api/generated/b2.json, the generated JSON form of api/b2.openapi.yaml.
func spec(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "generated", "b2.json"))
	if err != nil {
		t.Fatal(err)
	}
	var s map[string]any
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// responseSchema is the 200 JSON schema of an operation, by operationId.
func responseSchema(t *testing.T, s map[string]any, operationID string) map[string]any {
	t.Helper()
	for _, item := range s["paths"].(map[string]any) {
		for _, op := range item.(map[string]any) {
			if o, ok := op.(map[string]any); ok && o["operationId"] == operationID {
				return o["responses"].(map[string]any)["200"].(map[string]any)["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)
			}
		}
	}
	t.Fatalf("no operation %s", operationID)
	return nil
}

// conforms checks a decoded JSON value against the subset of JSON Schema the session catalog's schemas use; any
// other structural keyword is reported, never skipped.
func conforms(s map[string]any, schema map[string]any, v any, path string, bad *[]string) {
	if ref, ok := schema["$ref"].(string); ok {
		target := any(s)
		for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			target = target.(map[string]any)[part]
		}
		conforms(s, target.(map[string]any), v, path, bad)
		return
	}
	fail := func(format string, args ...any) { *bad = append(*bad, path+": "+fmt.Sprintf(format, args...)) }
	for key := range schema {
		switch key {
		case "type", "required", "additionalProperties", "properties", "items", "maxItems", "minimum", "minLength", "maxLength", "pattern", "enum", "description", "const":
		default:
			if !strings.HasPrefix(key, "x-") {
				fail("unsupported keyword %s", key)
			}
		}
	}
	if t, ok := schema["type"]; ok {
		var types []string
		if one, ok := t.(string); ok {
			types = []string{one}
		} else {
			for _, x := range t.([]any) {
				types = append(types, x.(string))
			}
		}
		is := func(name string) bool {
			switch x := v.(type) {
			case nil:
				return name == "null"
			case bool:
				return name == "boolean"
			case string:
				return name == "string"
			case float64:
				return name == "number" || name == "integer" && x == math.Trunc(x)
			case []any:
				return name == "array"
			case map[string]any:
				return name == "object"
			}
			return false
		}
		if !slices.ContainsFunc(types, is) {
			fail("%v is not %v", v, types)
			return
		}
	}
	if e, ok := schema["enum"].([]any); ok && !slices.Contains(e, v) {
		fail("%v not in %v", v, e)
	}
	if c, ok := schema["const"]; ok && c != v {
		fail("%v is not %v", v, c)
	}
	switch x := v.(type) {
	case float64:
		if m, ok := schema["minimum"].(float64); ok && x < m {
			fail("%v below %v", x, m)
		}
	case string:
		n := len(utf16.Encode([]rune(x)))
		if m, ok := schema["minLength"].(float64); ok && float64(n) < m {
			fail("shorter than %v", m)
		}
		if m, ok := schema["maxLength"].(float64); ok && float64(n) > m {
			fail("longer than %v", m)
		}
		if p, ok := schema["pattern"].(string); ok && !regexp.MustCompile(p).MatchString(x) {
			fail("%q does not match %s", x, p)
		}
	case []any:
		if m, ok := schema["maxItems"].(float64); ok && float64(len(x)) > m {
			fail("more than %v items", m)
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for i, item := range x {
				conforms(s, items, item, fmt.Sprintf("%s/%d", path, i), bad)
			}
		}
	case map[string]any:
		props, _ := schema["properties"].(map[string]any)
		for _, r := range schema["required"].([]any) {
			if _, ok := x[r.(string)]; !ok {
				fail("missing %s", r)
			}
		}
		for k, val := range x {
			if p, ok := props[k].(map[string]any); ok {
				conforms(s, p, val, path+"/"+k, bad)
			} else if schema["additionalProperties"] == false {
				fail("unexpected %s", k)
			}
		}
	}
}

// wireGet is the fake's raw 200 body for a GET, as a client receives it before decoding.
func wireGet(t *testing.T, fake *workerfake.Fake, target string) any {
	t.Helper()
	grant, err := os.ReadFile(fake.GrantFile())
	if err != nil {
		t.Fatal(err)
	}
	var g struct{ Token string }
	json.Unmarshal(grant, &g)
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", fake.SocketPath())
	}}}
	req, _ := http.NewRequest("GET", "http://worker"+target, nil)
	req.Header.Set("Authorization", "Bearer "+g.Token)
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s: %d %s", target, resp.StatusCode, body)
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCatalogRowsCarryTheSessionFilesStatsAndPreview(t *testing.T) {
	fake, err := workerfake.Start(workerfake.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	ctx := context.Background()
	c := fake.Client()
	w := newWorker(t, ctx, c, "create-1")
	sid := *w.SessionId
	s := spec(t)
	getSchema, listSchema := responseSchema(t, s, "sessions.get"), responseSchema(t, s, "sessions.list")

	// Both catalog replies satisfy the spec's response schemas, as the worker's response validation requires.
	valid := func(when string) {
		t.Helper()
		var bad []string
		conforms(s, getSchema, wireGet(t, fake, "/b2/sessions/"+url.PathEscape(sid)), "sessions.get", &bad)
		conforms(s, listSchema, wireGet(t, fake, "/b2/sessions?cwd="+url.QueryEscape(w.Cwd)), "sessions.list", &bad)
		for _, b := range bad {
			t.Errorf("%s: reply outside the spec: %s", when, b)
		}
	}
	// rows reads the session's row through sessions.get and sessions.list; both must agree.
	rows := func() b2.SessionRow {
		t.Helper()
		row, err := c.SessionsGet(ctx, sid)
		if err != nil {
			t.Fatal(err)
		}
		list, err := c.SessionsList(ctx, &b2.SessionsListParams{Cwd: &w.Cwd})
		if err != nil || len(list.Sessions) != 1 {
			t.Fatalf("sessions %+v %v", list, err)
		}
		a, _ := json.Marshal(row)
		b, _ := json.Marshal(list.Sessions[0])
		if string(a) != string(b) {
			t.Fatalf("sessions.get %s, sessions.list %s", a, b)
		}
		return *row
	}

	// A new session: an empty summary, with models an array.
	valid("a new session")
	row := rows()
	if row.Stats.Models == nil || len(row.Stats.Models) != 0 || row.Stats.UserMessages != 0 || row.Preview != nil || row.MessageCount != 0 {
		t.Errorf("a new session's row %+v", row)
	}

	// A user's text counts and is the preview, without the worker's interrupt marker.
	marker := "[The previous request was interrupted by the user before it finished.]"
	user := fmt.Sprintf(`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-11-17T05:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":%q}]}}`+"\n", marker+"\n  hello there  ")
	if err := fake.AppendHistory(sid, []byte(user)); err != nil {
		t.Fatal(err)
	}
	valid("after a user message")
	row = rows()
	if row.MessageCount != 1 || row.Stats.UserMessages != 1 || row.Stats.AssistantMessages != 0 || row.Preview == nil || *row.Preview != "hello there" {
		t.Fatalf("after a user message: %+v preview %v", row, row.Preview)
	}

	// An assistant's reply: its text is the preview, its tool calls and usage are counted per model.
	assistant := `{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","provider":"fixture","model":"fixture-1","content":[{"type":"text","text":"done"},{"type":"toolCall","id":"t1","name":"read","arguments":{}}],"usage":{"input":10,"output":5,"cacheRead":2,"cacheWrite":1,"totalTokens":18,"cost":{"total":0.5}}}}` + "\n"
	if err := fake.AppendHistory(sid, []byte(assistant)); err != nil {
		t.Fatal(err)
	}
	valid("after an assistant message")
	row = rows()
	st := row.Stats
	if row.MessageCount != 2 || st.UserMessages != 1 || st.AssistantMessages != 1 || st.ToolCalls != 1 || row.Preview == nil || *row.Preview != "done" ||
		st.Tokens != (b2.SessionTokens{Input: 10, Output: 5, CacheRead: 2, CacheWrite: 1, Total: 18}) || st.CostTotal != 0.5 ||
		len(st.Models) != 1 || st.Models[0].Provider != "fixture" || st.Models[0].Model != "fixture-1" || st.Models[0].AssistantMessages != 1 || st.Models[0].TokensTotal != 18 || st.Models[0].CostTotal != 0.5 {
		t.Fatalf("after an assistant message: %+v preview %v", row, row.Preview)
	}

	// A long preview is cut at 280 characters.
	long := strings.Repeat("x", 300)
	if err := fake.AppendHistory(sid, []byte(fmt.Sprintf(`{"type":"message","id":"u2","message":{"role":"user","content":%q}}`+"\n", long))); err != nil {
		t.Fatal(err)
	}
	valid("after a long message")
	if row = rows(); row.Preview == nil || *row.Preview != long[:280] || row.Stats.UserMessages != 2 {
		t.Fatalf("a long preview %v", row.Preview)
	}
}
