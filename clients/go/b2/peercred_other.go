//go:build !linux

package b2

import (
	"errors"
	"net"
)

// peerUID is Linux-only with the standard library. The worker runs on Linux only, so elsewhere the client refuses
// to connect rather than send a bearer to an unchecked peer. The package still builds, for callers that vendor it.
func peerUID(*net.UnixConn) (int, error) {
	return -1, errors.New("b2: peer credential check is supported on Linux only")
}
