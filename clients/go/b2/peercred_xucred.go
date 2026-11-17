package b2

import (
	"errors"
	"unsafe"
)

// xucred mirrors Darwin's struct xucred (sys/ucred.h), which LOCAL_PEERCRED fills. The layout check lives here,
// outside the darwin build tag, so its boundary tests run on every platform.
type xucred struct {
	Version uint32
	UID     uint32
	NGroups int16
	Groups  [16]uint32
}

// xucredSize is the size LOCAL_PEERCRED must report: 76 bytes on darwin/amd64 and darwin/arm64.
const xucredSize = uint32(unsafe.Sizeof(xucred{}))

var errXucredLayout = errors.New("b2: unsupported LOCAL_PEERCRED layout")

// xucredUID accepts the peer UID only from a credential of the expected size and XUCRED_VERSION (0).
func xucredUID(cred *xucred, size uint32) (int, error) {
	if size != xucredSize || cred.Version != 0 {
		return -1, errXucredLayout
	}
	return int(cred.UID), nil
}
