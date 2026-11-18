//go:build linux

package hardening

import (
	"errors"
	"syscall"
	"unsafe"
)

const linuxCapabilityVersion3 = 0x20080522

type capHeader struct {
	version uint32
	pid     int32
}

type capData struct{ effective, permitted, inheritable uint32 }

// capget and capset are seams: tests feed a state and read what would be set.
var (
	capget = func(h *capHeader, d *[2]capData) error {
		_, _, e := syscall.RawSyscall(syscall.SYS_CAPGET, uintptr(unsafe.Pointer(h)), uintptr(unsafe.Pointer(&d[0])), 0)
		if e != 0 {
			return e
		}
		return nil
	}
	// capset changes every thread: capabilities are per thread, and Go runs on many.
	capset = func(h *capHeader, d *[2]capData) error {
		_, _, e := syscall.AllThreadsSyscall(syscall.SYS_CAPSET, uintptr(unsafe.Pointer(h)), uintptr(unsafe.Pointer(&d[0])), 0)
		if e == syscall.ENOTSUP {
			return errors.New("cannot change the capabilities of every thread: build fx-vmhelper with CGO_ENABLED=0")
		}
		if e != 0 {
			return e
		}
		return nil
	}
)

// dropEffective clears the capabilities in nums from the effective set and puts them in the inheritable set
// (so that they can be raised into a child's ambient set), refusing one that is not permitted.
func dropEffective(d *[2]capData, nums []uintptr) error {
	for _, n := range nums {
		if n >= 64 {
			return errors.New("capability number out of range")
		}
		i, bit := n/32, uint32(1)<<(n%32)
		if d[i].permitted&bit == 0 {
			return errors.New("a jailer-only capability is not in the permitted set: the unit did not grant it")
		}
		d[i].effective &^= bit
		d[i].inheritable |= bit
	}
	return nil
}

// DropJailerOnly is the first thing the helper does: the jailer-only capabilities leave the effective set of
// every thread (they stay permitted, and become inheritable). From here on the helper's own file operations
// run without them.
func (p Pinned) DropJailerOnly() error {
	h := capHeader{version: linuxCapabilityVersion3}
	var d [2]capData
	if err := capget(&h, &d); err != nil {
		return err
	}
	if err := dropEffective(&d, p.JailerOnlyCaps()); err != nil {
		return err
	}
	h = capHeader{version: linuxCapabilityVersion3}
	return capset(&h, &d)
}
