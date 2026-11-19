// Package fcapi is the root helper's client for the Firecracker API socket of one sandbox. It speaks the
// small HTTP/1.1 subset Firecracker answers with, by hand, over a connection the caller made: no
// net/http, no module. The runner never reaches this socket; nothing in a configuration comes from a
// caller, only the vcpu count and memory the helper has already range-checked, plus the constants below.
//
// Every request is bounded in time (one deadline for the write and the read of a response) and every
// response in size (head and body), and anything that does not look exactly like Firecracker's answer to
// these five requests (status 204, a well-formed head, a delimited body) is refused.
package fcapi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// What the guest is booted with. Paths are inside the jail (the chroot is its root), where the helper's
// staging put them: root/kernel, root/rootfs and the vsock directory mounted at root/vsock.
const (
	KernelPath = "/kernel"
	RootfsPath = "/rootfs"
	// VsockUDS is where Firecracker makes the host-side socket: v.sock in the sandbox's vsock directory.
	VsockUDS = "/vsock/v.sock"
	// GuestCID is the vsock address of the guest; the agent listens on port 5252 of it.
	GuestCID = 3
	// BootArgs is fixed: a read-only ext4 root, the image's own init, memory wiped on free, a machine that
	// stops instead of hanging. A runner supplies none of it.
	BootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro rootfstype=ext4 init=/usr/lib/fx/init init_on_free=1 random.trust_cpu=on"
)

// Limits (variables for tests).
var (
	RequestTimeout = 5 * time.Second
	MaxHead        = 8 << 10
	MaxBody        = 64 << 10
	// SnapshotTimeout bounds one snapshot request: Firecracker writes the whole guest memory before it answers.
	SnapshotTimeout = 120 * time.Second
)

// Snapshot files, inside the jail (the chroot is its root): Firecracker writes them there as the sandbox uid,
// and the helper moves them out once the sandbox process is gone. A runner supplies none of these names.
const (
	SnapStatePath = "/snap.state"
	SnapMemPath   = "/snap.mem"
)

// ErrBadResponse is what a response that is not Firecracker's plain answer is refused with.
var ErrBadResponse = errors.New("fcapi: malformed response")

// VM is what the helper chooses; everything else of a configuration is a constant above.
type VM struct{ VCPUs, MemMB int64 }

// Client sends requests one at a time over one connection.
type Client struct {
	timeout time.Duration // 0 means RequestTimeout
	conn    net.Conn
	br      *bufio.Reader
	closed  bool // the server said it would close the connection
}

// New wraps conn. The caller keeps ownership of it and closes it.
func New(conn net.Conn) *Client { return &Client{conn: conn, br: bufio.NewReaderSize(conn, 4<<10)} }

// Configure sets the machine, boot source, root drive and vsock device of vm, then starts it.
func Configure(conn net.Conn, vm VM) error {
	if vm.VCPUs < 1 || vm.MemMB < 1 {
		return errors.New("fcapi: vcpus and memory must be positive")
	}
	c := New(conn)
	for _, r := range []struct {
		path string
		body any
	}{
		{"/machine-config", map[string]any{"vcpu_count": vm.VCPUs, "mem_size_mib": vm.MemMB}},
		{"/boot-source", map[string]any{"kernel_image_path": KernelPath, "boot_args": BootArgs}},
		// read-only: the guest's init mounts a tmpfs for everything it writes, and the template copy is not changed by a guest
		{"/drives/rootfs", map[string]any{"drive_id": "rootfs", "path_on_host": RootfsPath, "is_root_device": true, "is_read_only": true}},
		{"/vsock", map[string]any{"guest_cid": GuestCID, "uds_path": VsockUDS}},
		{"/actions", map[string]any{"action_type": "InstanceStart"}},
	} {
		if err := c.Put(r.path, r.body); err != nil {
			return fmt.Errorf("PUT %s: %w", r.path, err)
		}
	}
	return nil
}

// Snapshot pauses the VM and writes a full snapshot (state and memory) to the two paths above. The VM stays
// paused: the caller stops it. Only full snapshots are taken; no diff or compressed snapshot is requested.
func Snapshot(conn net.Conn) error {
	c := &Client{conn: conn, br: bufio.NewReaderSize(conn, 4<<10), timeout: SnapshotTimeout}
	if err := c.send("PATCH", "/vm", map[string]any{"state": "Paused"}); err != nil {
		return fmt.Errorf("PATCH /vm: %w", err)
	}
	return wrap("PUT /snapshot/create", c.send("PUT", "/snapshot/create", map[string]any{"snapshot_type": "Full", "snapshot_path": SnapStatePath, "mem_file_path": SnapMemPath}))
}

// Load restores a VM from the two files and resumes it. It must be the first thing sent to a fresh
// Firecracker: the snapshot carries the machine, drive and vsock configuration.
func Load(conn net.Conn) error {
	c := &Client{conn: conn, br: bufio.NewReaderSize(conn, 4<<10), timeout: SnapshotTimeout}
	return wrap("PUT /snapshot/load", c.send("PUT", "/snapshot/load", map[string]any{"snapshot_path": SnapStatePath,
		"mem_backend": map[string]any{"backend_path": SnapMemPath, "backend_type": "File"}, "resume_vm": true}))
}

func wrap(what string, err error) error {
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	return nil
}

// Put sends a PUT with a JSON body and requires the answer 204.
func (c *Client) Put(path string, body any) error { return c.send("PUT", path, body) }

func (c *Client) send(method, path string, body any) error {
	if c.closed {
		return errors.New("fcapi: the server closed the connection")
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	timeout := c.timeout
	if timeout == 0 {
		timeout = RequestTimeout
	}
	if err := c.conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	req := fmt.Sprintf(method+" %s HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", path, len(b))
	if _, err := c.conn.Write(append([]byte(req), b...)); err != nil {
		return err
	}
	status, resp, err := c.readResponse()
	if err != nil {
		return err
	}
	if status != 204 {
		return fmt.Errorf("fcapi: status %d: %s", status, printable(resp))
	}
	if len(resp) != 0 {
		return fmt.Errorf("%w: a body on a 204", ErrBadResponse)
	}
	return nil
}

func (c *Client) readResponse() (status int, body []byte, err error) {
	budget := MaxHead
	line := func() (string, error) {
		l, err := c.br.ReadSlice('\n')
		budget -= len(l)
		if errors.Is(err, bufio.ErrBufferFull) || budget < 0 {
			return "", fmt.Errorf("%w: head over %d bytes", ErrBadResponse, MaxHead)
		}
		if err != nil {
			return "", err
		}
		if !bytes.HasSuffix(l, []byte("\r\n")) || bytes.ContainsAny(l[:len(l)-2], "\r\n\x00") {
			return "", fmt.Errorf("%w: bad line ending", ErrBadResponse)
		}
		return string(l[:len(l)-2]), nil
	}
	first, err := line()
	if err != nil {
		return 0, nil, err
	}
	// "HTTP/1.1 204 No Content": a three-digit code after the version, then a space or the end.
	if len(first) < 12 || !strings.HasPrefix(first, "HTTP/1.1 ") || (len(first) > 12 && first[12] != ' ') {
		return 0, nil, fmt.Errorf("%w: status line", ErrBadResponse)
	}
	if status, err = strconv.Atoi(first[9:12]); err != nil || status < 200 || status > 599 {
		return 0, nil, fmt.Errorf("%w: status code", ErrBadResponse)
	}
	length := -1
	for {
		h, err := line()
		if err != nil {
			return 0, nil, err
		}
		if h == "" {
			break
		}
		name, val, ok := strings.Cut(h, ":")
		if !ok || name == "" || strings.ContainsAny(name, " \t") {
			return 0, nil, fmt.Errorf("%w: header line", ErrBadResponse)
		}
		val = strings.TrimSpace(val)
		switch strings.ToLower(name) {
		case "content-length":
			n, err := strconv.Atoi(val)
			if length != -1 || err != nil || n < 0 || n > MaxBody || val[0] == '+' {
				return 0, nil, fmt.Errorf("%w: content-length", ErrBadResponse)
			}
			length = n
		case "transfer-encoding", "content-encoding", "upgrade":
			return 0, nil, fmt.Errorf("%w: %s", ErrBadResponse, strings.ToLower(name))
		case "connection":
			c.closed = strings.EqualFold(val, "close")
		}
	}
	if length == -1 {
		if status != 204 { // nothing delimits the body of any other answer
			return 0, nil, fmt.Errorf("%w: no content-length", ErrBadResponse)
		}
		length = 0
	}
	body = make([]byte, length)
	if _, err := io.ReadFull(c.br, body); err != nil {
		return 0, nil, err
	}
	return status, body, nil
}

// printable shortens a server's error body to one safe line for a log; it is never sent to a runner.
func printable(b []byte) string {
	var m struct {
		Fault string `json:"fault_message"`
	}
	s := string(b)
	if json.Unmarshal(b, &m) == nil && m.Fault != "" {
		s = m.Fault
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r >= 0x7f {
			return '?'
		}
		return r
	}, s)
}
