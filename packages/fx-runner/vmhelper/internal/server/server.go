//go:build linux

// Package server accepts connections on the helper's socket, gates each one on the kernel's record of
// the peer's uid, reads strict frames with a deadline, and hands a validated request to a Backend.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"fx-vmhelper/internal/protocol"
	"fx-vmhelper/internal/vmlog"
)

const (
	// FrameTimeout is how long one frame may take, from the moment the helper starts waiting for it.
	// An idle connection is cut after the same time, so a silent client cannot hold a slot.
	FrameTimeout = 5 * time.Second
	// MaxConns is how many connections are served at once.
	MaxConns = 8
	// refusalWrite bounds the write of a refusal made from the accept loop.
	refusalWrite = 200 * time.Millisecond
	// A temporary accept error (EMFILE and the like) is retried after acceptBackoffStart, doubling up to acceptBackoffMax.
	acceptBackoffStart = 5 * time.Millisecond
	acceptBackoffMax   = time.Second
)

// temporary reports an accept error that a later attempt can get past: no descriptors or buffers left,
// or a connection that was reset before it was accepted.
func temporary(err error) bool {
	for _, e := range []syscall.Errno{syscall.EMFILE, syscall.ENFILE, syscall.ENOBUFS, syscall.ENOMEM, syscall.ECONNABORTED, syscall.EINTR} {
		if errors.Is(err, e) {
			return true
		}
	}
	return false
}

func errName(err error) string {
	var no syscall.Errno
	if errors.As(err, &no) {
		return fmt.Sprint(int(no))
	}
	return "-"
}

// Entry is one prepared sandbox as list() reports it. Created is Unix seconds, 0 when not known.
type Entry struct {
	SandboxID string `json:"sandbox_id"`
	Created   int64  `json:"created,omitempty"`
	// VsockDir is the absolute directory that holds the sandbox's vsock sockets. The helper builds it from
	// its root-owned config and the validated id; a caller never supplies it.
	VsockDir string `json:"vsock_dir"`
	// SandboxGID is the gid of the sandbox's group, which owns its vsock directory; a consumer checks it.
	SandboxGID uint32 `json:"sandbox_gid"`
}

// Reply is what a successful prepare or start adds to its answer.
type Reply struct {
	VsockDir   string
	SandboxGID uint32
}

// Backend is what a validated request is handed to. Each call returns protocol.OK or one refusal code.
// The sandbox package supplies the real one; the server never builds a path, a command line or an id of its own.
type Backend interface {
	Prepare(r protocol.Request) (Reply, protocol.Code)
	Start(id string) (Reply, protocol.Code)
	Destroy(id string) protocol.Code
	List() ([]Entry, protocol.Code)
}

// Server is configured by its fields; zero Timeout and Max mean the constants above.
type Server struct {
	RunnerUID uint32
	Caps      protocol.Caps
	Backend   Backend
	Log       *vmlog.Logger
	Timeout   time.Duration
	Max       int
	// Peer reads the peer uid; nil means PeerUID. Tests replace it only to stand for a different uid.
	Peer func(net.Conn) (uint32, error)
}

type response struct {
	OK        bool          `json:"ok"`
	Protocol  int           `json:"protocol"`
	Code      protocol.Code `json:"code,omitempty"`
	VsockDir  string        `json:"vsock_dir,omitempty"`
	GID       uint32        `json:"sandbox_gid,omitempty"` // never 0: a sandbox gid is at least config.MinID
	Sandboxes *[]Entry      `json:"sandboxes,omitempty"`
}

func write(c net.Conn, d time.Duration, r response) {
	b, _ := json.Marshal(r) // only fixed strings and numbers: cannot fail
	_ = c.SetWriteDeadline(time.Now().Add(d))
	_, _ = c.Write(append(b, '\n'))
}

func refusal(code protocol.Code) response { return response{Protocol: protocol.Version, Code: code} }

// Serve accepts until ctx ends, then closes the listener and waits for the open connections to finish.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	timeout, max, peer := s.Timeout, s.Max, s.Peer
	if timeout == 0 {
		timeout = FrameTimeout
	}
	if max == 0 {
		max = MaxConns
	}
	if peer == nil {
		peer = PeerUID
	}
	slots := make(chan struct{}, max)
	var wg sync.WaitGroup
	go func() { <-ctx.Done(); _ = ln.Close() }()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	go func() {
		for {
			select {
			case <-tick.C:
				s.Log.Flush(false)
			case <-ctx.Done():
				return
			}
		}
	}()
	defer func() { wg.Wait(); s.Log.Flush(true) }()
	backoff := time.Duration(0)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			if !temporary(err) {
				return err
			}
			// Out of descriptors or memory, or a connection reset before accept: wait and try again, so the
			// service (and the reaping the next change adds to it) does not end because of a passing shortage.
			if backoff == 0 {
				s.Log.Event("accept_retry", "errno", errName(err))
				backoff = acceptBackoffStart
			} else if backoff *= 2; backoff > acceptBackoffMax {
				backoff = acceptBackoffMax
			}
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil
			}
			continue
		}
		backoff = 0
		start := time.Now()
		uid, perr := peer(conn)
		if perr != nil {
			// The kernel's answer is the only one that counts; a failed read refuses too, and is not logged as a uid.
			s.refuse(conn, protocol.BadPeer, vmlog.NoUID, start)
			continue
		}
		if uid != s.RunnerUID {
			s.refuse(conn, protocol.BadPeer, uid, start)
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			s.refuse(conn, protocol.TooBusy, uid, start)
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			var once sync.Once
			release := func() { once.Do(func() { <-slots }) }
			defer release()
			s.handle(conn, uid, timeout, release)
		}()
	}
}

func (s *Server) refuse(c net.Conn, code protocol.Code, uid uint32, start time.Time) {
	// Logged before the reply is written: a client that has its answer knows its line is already in the journal.
	s.Log.Request(s.Log.NextReq(), "-", uid, "", code, time.Since(start))
	write(c, refusalWrite, refusal(code))
	_ = c.Close()
}

// handle serves one connection. release frees its connection slot (once); it is called before the reply that ends
// the connection is written, so a client that reads that reply and reconnects never finds the slot still taken.
func (s *Server) handle(c net.Conn, uid uint32, timeout time.Duration, release func()) {
	defer c.Close()
	br := bufio.NewReaderSize(c, protocol.MaxFrame)
	for {
		_ = c.SetReadDeadline(time.Now().Add(timeout))
		start := time.Now()
		line, err := br.ReadSlice('\n')
		var code protocol.Code
		var req protocol.Request
		switch {
		case err == nil:
			var perr *protocol.Error
			if req, perr = protocol.Parse(line[:len(line)-1], s.Caps); perr != nil {
				// The verb and id are those the parser validated before it refused: the log keeps them.
				code, req.Verb, req.SandboxID = perr.Code, perr.Verb, perr.SandboxID
			}
		case errors.Is(err, bufio.ErrBufferFull):
			code = protocol.FrameTooLarge
		case errors.Is(err, os.ErrDeadlineExceeded):
			code = protocol.FrameTimeout
		case len(line) == 0:
			return // the client closed between frames: nothing to answer, nothing to log
		default:
			code = protocol.BadFrame // closed or reset in the middle of a frame
		}
		reqNo := s.Log.NextReq()
		var resp response
		if code == "" {
			resp, code = s.dispatch(req)
		} else {
			resp = refusal(code)
		}
		// Journal first, then free the slot if this reply ends the connection, then reply: both are visible to
		// the client by the time it can see the answer, and request order is journal order.
		s.Log.Request(reqNo, string(req.Verb), uid, req.SandboxID, code, time.Since(start))
		if code != protocol.OK {
			release()
		}
		write(c, timeout, resp)
		if code != protocol.OK {
			return // a refused frame ends the connection: after a broken frame there is nothing to resync on
		}
	}
}

func (s *Server) dispatch(req protocol.Request) (resp response, code protocol.Code) {
	var reply Reply
	defer func() {
		if r := recover(); r != nil {
			resp, code = refusal(protocol.Internal), protocol.Internal
		}
	}()
	switch req.Verb {
	case protocol.Prepare:
		reply, code = s.Backend.Prepare(req)
	case protocol.Start:
		reply, code = s.Backend.Start(req.SandboxID)
	case protocol.Destroy:
		code = s.Backend.Destroy(req.SandboxID)
	case protocol.List:
		var entries []Entry
		if entries, code = s.Backend.List(); code == protocol.OK {
			if entries == nil {
				entries = []Entry{}
			}
			return response{OK: true, Protocol: protocol.Version, Sandboxes: &entries}, code
		}
	default:
		code = protocol.UnknownVerb
	}
	if code == protocol.OK {
		return response{OK: true, Protocol: protocol.Version, VsockDir: reply.VsockDir, GID: reply.SandboxGID}, code
	}
	return refusal(code), code
}

// Listen binds the helper's socket inside dir, which must be a real directory (not a symlink) owned by
// dirOwner (root in production) with mode exactly dirMode: systemd's RuntimeDirectory. A stale socket
// left by a crashed helper is removed; anything else at the path is refused. The socket itself is made
// 0660, but the peer-credential check, not that mode, is what keeps other users out.
func Listen(dir, name string, dirOwner uint32, dirMode os.FileMode) (net.Listener, error) {
	fd, err := syscall.Open(dir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("socket directory cannot be opened as a plain directory: %v", err)
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, errors.New("socket directory cannot be examined")
	}
	if st.Uid != dirOwner || os.FileMode(st.Mode&0o7777) != dirMode {
		return nil, fmt.Errorf("socket directory must be owned by uid %d with mode %04o", dirOwner, uint32(dirMode))
	}
	// Work through the open descriptor so that the directory cannot be swapped between check and bind.
	base := fmt.Sprintf("/proc/self/fd/%d", fd)
	switch fi, err := os.Lstat(base + "/" + name); { // lstat: a symlink at the path is itself what is examined
	case err == nil:
		ls, _ := fi.Sys().(*syscall.Stat_t)
		if ls == nil || fi.Mode()&os.ModeSocket == 0 || ls.Uid != dirOwner {
			return nil, errors.New("something that is not the helper's own socket sits at the socket path")
		}
		if err := syscall.Unlinkat(fd, name); err != nil {
			return nil, errors.New("the stale socket cannot be removed")
		}
	case !errors.Is(err, syscall.ENOENT):
		return nil, errors.New("the socket path cannot be examined")
	}
	ln, err := net.Listen("unix", base+"/"+name)
	if err != nil {
		return nil, fmt.Errorf("cannot listen: %v", err)
	}
	// Close must not unlink anything. The listener's address is "/proc/self/fd/N/<name>" and N is closed
	// when this function returns, so a later Close would unlink <name> in whatever directory then holds
	// descriptor N. The helper does not remove its socket at shutdown at all: the next start replaces a
	// stale one (checked above with lstat and owner), and under systemd the RuntimeDirectory is removed on
	// stop. That is simpler than holding the directory open for the whole run, and it keeps every unlink
	// of this process on a descriptor and a name that were checked.
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	if err := os.Chmod(base+"/"+name, 0o660); err != nil {
		_ = ln.Close()
		_ = syscall.Unlinkat(fd, name) // through the still-open descriptor, never through the path
		return nil, errors.New("cannot set the socket mode")
	}
	return ln, nil
}
