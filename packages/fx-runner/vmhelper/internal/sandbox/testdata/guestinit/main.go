// Command guestinit is the fixture guest of the real-root test: a static PID 1 that listens on vsock port
// 5252 and answers the agent's ping frame, so a real Firecracker boots a real kernel to a real vsock hello
// without the full image. The frame format is the agent's (infra/microvm-image/guest/agent.py): a 4-byte
// big-endian length, then JSON. Besides the ping it keeps one value in a tmpfs file: {"op":"put","v":"..."}
// writes it and {"op":"get"} reads it back, so the snapshot test can show that guest memory (the tmpfs is
// the only writable place; the root disk is read-only) comes back from a snapshot. It mounts that tmpfs on
// /dev and runs nothing else. Built by the real-root workflow with CGO_ENABLED=0; it is not part of the helper.
package main

import (
	"encoding/binary"
	"encoding/json"
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

// valuePath is the one file the guest keeps, on the tmpfs.
const valuePath = "/dev/value"

func main() {
	_ = syscall.Mount("tmpfs", "/dev", "tmpfs", 0, "mode=0755") // /dev is a directory of the read-only root disk
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
	body := make([]byte, binary.BigEndian.Uint32(n[:]))
	if _, err := io.ReadFull(c, body); err != nil {
		return
	}
	var req struct{ Op, V string }
	_ = json.Unmarshal(body, &req)
	reply := `{"ok":true,"proto":1}`
	switch req.Op {
	case "put":
		if os.WriteFile(valuePath, []byte(req.V), 0o600) != nil {
			reply = `{"ok":false,"proto":1}`
		}
	case "get":
		b, err := os.ReadFile(valuePath)
		if err != nil {
			reply = `{"ok":false,"proto":1}`
		} else {
			enc, _ := json.Marshal(string(b))
			reply = `{"ok":true,"proto":1,"v":` + string(enc) + `}`
		}
	}
	binary.BigEndian.PutUint32(n[:], uint32(len(reply)))
	if _, err := c.Write(append(n[:], reply...)); err != nil {
		return
	}
	// like the agent: end our side, then wait for the host to end its own, because a vsock close can drop queued bytes
	_ = syscall.Shutdown(int(c.Fd()), syscall.SHUT_WR)
	_, _ = io.Copy(io.Discard, c)
}
