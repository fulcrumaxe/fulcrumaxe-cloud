// Command guestinit is the fixture guest of the real-root test: a static PID 1 that listens on vsock port
// 5252 and answers the agent's ping frame, so a real Firecracker boots a real kernel to a real vsock hello
// without the full image. The frame format is the agent's (infra/microvm-image/guest/agent.py): a 4-byte
// big-endian length, then JSON. It does not mount or run anything else. Built by the real-root workflow
// with CGO_ENABLED=0; it is not part of the helper.
package main

import (
	"encoding/binary"
	"io"
	"os"
	"syscall"
	"unsafe"
)

const (
	afVsock = 40
	port    = 5252
)

type sockaddrVM struct {
	family, reserved uint16
	port, cid        uint32
	zero             [4]byte
}

func main() {
	fd, err := syscall.Socket(afVsock, syscall.SOCK_STREAM, 0)
	if err != nil {
		os.Exit(2)
	}
	sa := sockaddrVM{family: afVsock, port: port, cid: 0xffffffff} // VMADDR_CID_ANY
	if _, _, e := syscall.RawSyscall(syscall.SYS_BIND, uintptr(fd), uintptr(unsafe.Pointer(&sa)), unsafe.Sizeof(sa)); e != 0 {
		os.Exit(3)
	}
	if err := syscall.Listen(fd, 8); err != nil {
		os.Exit(4)
	}
	for {
		// raw accept4: syscall.Accept closes the new connection when it cannot decode the peer's address family (vsock)
		c, _, e := syscall.Syscall6(syscall.SYS_ACCEPT4, uintptr(fd), 0, 0, 0, 0, 0)
		if e != 0 {
			continue
		}
		serve(os.NewFile(c, "conn"))
	}
}

func serve(c *os.File) {
	defer c.Close()
	var n [4]byte
	if _, err := io.ReadFull(c, n[:]); err != nil || binary.BigEndian.Uint32(n[:]) > 1<<16 {
		return
	}
	if _, err := io.CopyN(io.Discard, c, int64(binary.BigEndian.Uint32(n[:]))); err != nil {
		return
	}
	const reply = `{"ok":true,"proto":1}`
	binary.BigEndian.PutUint32(n[:], uint32(len(reply)))
	if _, err := c.Write(append(n[:], reply...)); err != nil {
		return
	}
	// like the agent: end our side, then wait for the host to end its own, because a vsock close can drop queued bytes
	_ = syscall.Shutdown(int(c.Fd()), syscall.SHUT_WR)
	_, _ = io.Copy(io.Discard, c)
}
