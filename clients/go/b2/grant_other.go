//go:build !linux && !darwin

package b2

import "errors"

func readGrantFile(string) ([]byte, error) {
	return nil, errors.New("b2: grant ownership check is supported on Linux and macOS only")
}
