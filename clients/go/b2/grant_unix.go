//go:build linux || darwin

package b2

import (
	"errors"
	"io"
	"os"
	"syscall"
)

// readGrantFile checks the opened file, not an earlier path lookup. Every call revalidates a rotated grant.
func readGrantFile(path string) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if err := validateGrantFile(info, os.Geteuid()); err != nil {
		return nil, err
	}
	const maxGrantBytes = 64 << 10
	data, err := io.ReadAll(io.LimitReader(f, maxGrantBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxGrantBytes {
		return nil, errors.New("grant file too large")
	}
	return data, nil
}

func validateGrantFile(info os.FileInfo, bridgeUID int) error {
	// Hard links are accepted: ownership and the exact regular 0600 mode belong to the inode.
	if info.Mode() != 0o600 {
		return errors.New("grant must be a regular 0600 file")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(bridgeUID) {
		return errors.New("grant must be owned by the bridge user")
	}
	return nil
}
