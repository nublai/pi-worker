//go:build darwin

package b2

import (
	"errors"
	"net"
	"syscall"
	"unsafe"
)

// peerUID uses Darwin's LOCAL_PEERCRED (sys/un.h) and struct xucred (sys/ucred.h).
// This is for fake-worker tests on macOS; Shep hosts remain Linux only.
func peerUID(conn *net.UnixConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return -1, err
	}
	var cred struct {
		Version uint32
		UID     uint32
		NGroups int16
		Groups  [16]uint32
	}
	size := uint32(unsafe.Sizeof(cred))
	var errno syscall.Errno
	if err := raw.Control(func(fd uintptr) {
		// SOL_LOCAL = 0, LOCAL_PEERCRED = 1. Neither constant is exported by syscall on Darwin.
		_, _, errno = syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, 0, 1,
			uintptr(unsafe.Pointer(&cred)), uintptr(unsafe.Pointer(&size)), 0)
	}); err != nil {
		return -1, err
	}
	if errno != 0 {
		return -1, errno
	}
	if size != uint32(unsafe.Sizeof(cred)) || cred.Version != 0 {
		return -1, errors.New("b2: unsupported LOCAL_PEERCRED layout")
	}
	return int(cred.UID), nil
}
