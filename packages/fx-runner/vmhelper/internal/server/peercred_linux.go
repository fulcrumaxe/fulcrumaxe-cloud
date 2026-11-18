//go:build linux

package server

import (
	"errors"
	"net"
	"syscall"
)

// PeerUID returns the uid the kernel recorded for the process that connect()ed the socket (SO_PEERCRED).
// It is the only identity the helper uses. The pid in the same structure is ignored, and nothing the
// peer sends can change the answer.
func PeerUID(c net.Conn) (uint32, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, errors.New("not a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *syscall.Ucred
	var gerr error
	if err := raw.Control(func(fd uintptr) {
		cred, gerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if gerr != nil {
		return 0, gerr
	}
	return cred.Uid, nil
}
