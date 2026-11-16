package b2

import (
	"errors"
	"fmt"
)

// Phase says where a call failed.
type Phase string

const (
	// PhaseBeforeWrite: no request byte can have reached the worker (dial, peer check, grant, encoding).
	PhaseBeforeWrite Phase = "before_write"
	// PhaseAfterWrite: the connection was handed to the writer; the worker may have acted.
	PhaseAfterWrite Phase = "after_write"
	// PhaseHTTP: the worker answered with a refusal; its Error body says the effect.
	PhaseHTTP Phase = "http"
)

// Effect values used by ClientFailure, matching the spec's Effect enum.
const (
	NoEffect      Effect = "no_effect"
	UnknownEffect Effect = "unknown"
)

// ClientFailure is every failed call. Effect is NoEffect only when nothing can have happened: a failure before the
// write, or a worker refusal that says no_effect. Otherwise it is UnknownEffect: read the receipt for the command_id
// and never resend blindly. A disconnect is never a cancel.
type ClientFailure struct {
	Op     string
	Phase  Phase
	Effect Effect
	// Status is the HTTP status for PhaseHTTP.
	Status int
	// Body is the worker's Error for PhaseHTTP when it sent one.
	Body *Error
	Err  error
}

func (f *ClientFailure) Error() string {
	switch {
	case f.Body != nil:
		return fmt.Sprintf("b2 %s: HTTP %d %s (%s)", f.Op, f.Status, f.Body.Error, f.Effect)
	case f.Err != nil:
		return fmt.Sprintf("b2 %s: %s %s: %v", f.Op, f.Phase, f.Effect, f.Err)
	default:
		return fmt.Sprintf("b2 %s: %s %s", f.Op, f.Phase, f.Effect)
	}
}

func (f *ClientFailure) Unwrap() error { return f.Err }

// ResyncRequired ends a Watch: the stream overflowed, disconnected or was refused. Controls stay disabled until a
// new Watch delivers a snapshot.
type ResyncRequired struct {
	Reason string
	// Status is set when the worker refused the stream with HTTP.
	Status int
}

func (r *ResyncRequired) Error() string {
	return "b2 events: " + r.Reason + "; fresh snapshot required before controls"
}

// ProtocolMismatch is returned by Hello when the worker speaks another protocol major.
type ProtocolMismatch struct{ Major int }

func (p *ProtocolMismatch) Error() string {
	return fmt.Sprintf("b2: worker speaks protocol major %d; this client speaks %d", p.Major, ProtocolMajor)
}

// ErrPeerNotOwner: the process listening on the socket is not the expected user. Nothing was sent, not even the
// bearer.
var ErrPeerNotOwner = errors.New("b2: socket peer is not the expected worker owner")
