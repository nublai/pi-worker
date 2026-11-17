package workerfake

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
)

// fixturesJSON is tools/codegen's copy of api/fixtures: every wire fixture and the frozen section 0.1 rows.
//
//go:embed fixtures.gen.json
var fixturesJSON []byte

// WireRequest is the request half of a wire fixture (api/fixtures/README.md): path and query hold the raw strings
// sent on the wire; Body is the JSON body of a json operation, BodyBase64 the bytes of a binary one.
type WireRequest struct {
	Path       map[string]string `json:"path,omitempty"`
	Query      map[string]string `json:"query,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       json.RawMessage   `json:"body,omitempty"`
	BodyBase64 string            `json:"bodyBase64,omitempty"`
}

// WireResponse is the response half: Body for JSON, Frames for an SSE stream, BodyText or BodyBase64 (with
// ContentType and Headers) for ndjson and binary replies.
type WireResponse struct {
	Status      int               `json:"status"`
	Headers     map[string]string `json:"headers,omitempty"`
	ContentType string            `json:"contentType,omitempty"`
	Body        json.RawMessage   `json:"body,omitempty"`
	BodyText    *string           `json:"bodyText,omitempty"`
	BodyBase64  *string           `json:"bodyBase64,omitempty"`
	Frames      []json.RawMessage `json:"frames,omitempty"`
}

// WireFixture is one api/fixtures/wire/<Op>/<Name>.json.
type WireFixture struct {
	Op       string
	Name     string
	Request  WireRequest  `json:"request"`
	Response WireResponse `json:"response"`
}

// Step is one step of a section 0.1 row (api/fixtures/README.md, "Step semantics").
type Step struct {
	Kind      string         `json:"kind,omitempty"`
	Macro     string         `json:"macro,omitempty"`
	Method    string         `json:"method,omitempty"`
	CommandID string         `json:"command_id,omitempty"`
	Binding   string         `json:"binding,omitempty"`
	Fields    map[string]any `json:"fields,omitempty"`
	Mode      string         `json:"mode,omitempty"`
	Event     *struct {
		Type string `json:"type"`
	} `json:"event,omitempty"`
}

// Expectation is one frozen assertion: the value at a dot path of {result, worker, disk, effects}.
type Expectation struct {
	Path   string `json:"path"`
	Equals any    `json:"equals"`
}

// Row is one frozen section 0.1 transition.
type Row struct {
	ID       string        `json:"id"`
	From     string        `json:"from"`
	Event    string        `json:"event"`
	To       string        `json:"to"`
	Profile  string        `json:"profile,omitempty"`
	Coverage string        `json:"coverage,omitempty"`
	Steps    []Step        `json:"steps"`
	Expect   []Expectation `json:"expect"`
}

// TransitionSet is api/fixtures/transitions.json.
type TransitionSet struct {
	ContractRevision int               `json:"contract_revision"`
	Macros           map[string][]Step `json:"macros"`
	Rows             []Row             `json:"rows"`
}

// Expand replaces each macro step by its steps.
func (t *TransitionSet) Expand(steps []Step) []Step {
	var out []Step
	for _, s := range steps {
		if s.Macro != "" {
			out = append(out, t.Expand(t.Macros[s.Macro])...)
		} else {
			out = append(out, s)
		}
	}
	return out
}

type bundle struct {
	Wire        map[string]map[string]WireFixture `json:"wire"`
	Transitions json.RawMessage                   `json:"transitions"`
}

var loaded = sync.OnceValues(func() (*bundle, error) {
	var b bundle
	if err := json.Unmarshal(fixturesJSON, &b); err != nil {
		return nil, fmt.Errorf("workerfake: fixtures.gen.json: %w", err)
	}
	for op, set := range b.Wire {
		for name, f := range set {
			f.Op, f.Name = op, name
			set[name] = f
		}
	}
	return &b, nil
})

// fixtures returns the bundle, or an empty one if it does not parse (Start reports that error).
func fixtures() *bundle {
	b, err := loaded()
	if err != nil {
		return &bundle{}
	}
	return b
}

// WireFixtures returns every wire fixture of an operation, sorted by name ("ok" first).
func WireFixtures(op string) []WireFixture {
	set := fixtures().Wire[op]
	out := make([]WireFixture, 0, len(set))
	for _, f := range set {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Name == "ok") != (out[j].Name == "ok") {
			return out[i].Name == "ok"
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// WireOps lists the operations that have wire fixtures.
func WireOps() []string {
	var out []string
	for op := range fixtures().Wire {
		out = append(out, op)
	}
	sort.Strings(out)
	return out
}

// Transitions returns the frozen section 0.1 rows (contract revision 8).
func Transitions() (*TransitionSet, error) {
	var t TransitionSet
	if err := json.Unmarshal(fixtures().Transitions, &t); err != nil {
		return nil, fmt.Errorf("workerfake: transitions: %w", err)
	}
	return &t, nil
}

// TransitionsJSON returns the frozen rows as JSON (the same values as api/fixtures/transitions.json), for hashing.
func TransitionsJSON() json.RawMessage {
	return append(json.RawMessage(nil), fixtures().Transitions...)
}
