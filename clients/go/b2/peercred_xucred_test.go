package b2

import (
	"errors"
	"math"
	"testing"
)

func TestXucredLayout(t *testing.T) {
	if xucredSize != 76 {
		t.Fatalf("xucred size = %d, want 76 (Darwin struct xucred)", xucredSize)
	}
	cases := []struct {
		name    string
		size    uint32
		version uint32
		ok      bool
	}{
		{"exact", xucredSize, 0, true},
		{"size-zero", 0, 0, false},
		{"size-short", xucredSize - 1, 0, false},
		{"size-long", xucredSize + 1, 0, false},
		{"size-max", math.MaxUint32, 0, false},
		{"version-one", xucredSize, 1, false},
		{"version-max", xucredSize, math.MaxUint32, false},
		{"both-wrong", xucredSize - 4, 1, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cred := xucred{Version: c.version, UID: 501}
			uid, err := xucredUID(&cred, c.size)
			if c.ok {
				if err != nil || uid != 501 {
					t.Fatalf("valid xucred refused: uid %d, err %v", uid, err)
				}
				return
			}
			if !errors.Is(err, errXucredLayout) || uid != -1 {
				t.Fatalf("unsupported xucred (size %d, version %d) accepted: uid %d, err %v", c.size, c.version, uid, err)
			}
		})
	}
}
