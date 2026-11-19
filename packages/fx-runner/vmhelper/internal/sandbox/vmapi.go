//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path"
	"strconv"
	"syscall"
	"time"

	"fx-vmhelper/internal/fcapi"
	"fx-vmhelper/internal/hardening"
)

// apiTimeout is how long Firecracker may take to open its API socket after it dropped to the sandbox's ids
// (a variable for tests).
var apiTimeout = 10 * time.Second

// apiSocketName is where the jailer's default puts the API socket, inside the jail's root.
const apiSocketName = "firecracker.socket"

var errPeer = errors.New("launch: the API socket is not served by the sandbox process")

// boot waits (bounded) for the API socket of a launched sandbox and configures and starts the VM through
// it. Any error leaves the caller to kill the sandbox and answer "internal".
func (l *JailerLauncher) boot(in *instance, s Spec) error {
	dial := l.Dial
	if dial == nil {
		dial = l.dialAPI
	}
	var conn net.Conn
	for deadline := time.Now().Add(apiTimeout); conn == nil; time.Sleep(10 * time.Millisecond) {
		select {
		case <-in.done:
			return fmt.Errorf("launch: the sandbox process exited before its API socket answered (it printed %q)", in.out.Head())
		default:
		}
		c, err := dial(s, in.pid)
		switch {
		case err == nil:
			conn = c
		case !errors.Is(err, syscall.ENOENT) && !errors.Is(err, syscall.ECONNREFUSED) && !errors.Is(err, syscall.EAGAIN):
			return err // not "not there yet": a wrong peer, a refused permission, a symlink
		case time.Now().After(deadline):
			return errors.New("launch: timed out waiting for the API socket")
		}
	}
	defer conn.Close()
	if err := fcapi.Configure(conn, fcapi.VM{VCPUs: s.VCPUs, MemMB: s.MemMB}); err != nil {
		return err
	}
	handover := l.Handover
	if handover == nil {
		handover = l.handOverSocket
	}
	return handover(s)
}

// vsockSocket is the host-side socket Firecracker makes in the sandbox's vsock directory (the file name
// of fcapi.VsockUDS).
const vsockSocket = "v.sock"

// handOverSocket gives the vsock socket to the runner. Firecracker made it as the sandbox uid with the
// helper's umask, so only that uid could connect. The runner is the owner of the directory, so one
// chown to the runner uid (the group stays the sandbox's) lets exactly the runner connect. The socket is
// opened O_PATH without following a symlink and must be a socket of the sandbox uid before anything
// changes; the change goes through that descriptor. The directory is closed to root, hence the capability.
func (l *JailerLauncher) handOverSocket(s Spec) error {
	return hardening.WithCaps(l.AmbientCaps, func() error {
		dir, err := openAbs(s.VsockDir)
		if err != nil {
			return err
		}
		defer closeFd(dir)
		fd, err := syscall.Openat(dir, vsockSocket, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		defer closeFd(fd)
		var st syscall.Stat_t
		wu, wg := l.eff(s.UID, s.GID)
		if err := syscall.Fstat(fd, &st); err != nil {
			return err
		}
		if st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Uid != wu {
			return errors.New("launch: the vsock socket is not a socket of the sandbox process")
		}
		ru, _ := l.eff(s.RunnerUID, 0)
		return fchownEmpty(fd, ru, wg)
	})
}

// dialAPI connects to <jail>/<exec>/<id>/root/run/firecracker.socket. The directories belong to the sandbox,
// which has closed them to root, so the walk and the connect run on one thread that holds the jailer-only
// capabilities (CAP_DAC_OVERRIDE) and nowhere else. The sandbox shapes that tree, and the capability would let
// root connect to any socket a planted symlink pointed at, so no path component is followed: each directory
// is opened O_NOFOLLOW, the socket's own name is opened O_PATH|O_NOFOLLOW and must be a socket of the sandbox
// uid (fstat on that descriptor), and the connect goes through /proc/self/fd of that descriptor, never by
// name. The connection is used only if the peer is the sandbox process itself (SO_PEERCRED: pid and uid).
func (l *JailerLauncher) dialAPI(s Spec, pid int) (net.Conn, error) {
	var conn net.Conn
	err := hardening.WithCaps(l.AmbientCaps, func() (err error) {
		dir, err := openAbs(s.JailDir)
		if err != nil {
			return err
		}
		for _, n := range []string{path.Base(l.Firecracker), s.ID, "root", "run"} {
			next, err := openChild(dir, n)
			closeFd(dir)
			if err != nil {
				return err
			}
			dir = next
		}
		defer closeFd(dir)
		wu, _ := l.eff(s.UID, s.GID)
		sfd, err := syscall.Openat(dir, apiSocketName, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return err // ELOOP for a symlink; ENOENT while Firecracker has not made it yet
		}
		defer closeFd(sfd)
		var st syscall.Stat_t
		if err := syscall.Fstat(sfd, &st); err != nil {
			return err
		}
		if st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Uid != wu {
			return errPeer
		}
		fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, 0)
		if err != nil {
			return err
		}
		fail := func(err error) error { closeFd(fd); return err }
		if err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: procFdPath(sfd)}); err != nil {
			return fail(err)
		}
		cred, err := syscall.GetsockoptUcred(fd, syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if err != nil {
			return fail(err)
		}
		if int(cred.Pid) != pid || cred.Uid != wu {
			return fail(errPeer)
		}
		f := os.NewFile(uintptr(fd), "firecracker-api "+strconv.Itoa(pid))
		defer f.Close()
		conn, err = net.FileConn(f) // a duplicate: the original closes with f
		return err
	})
	return conn, err
}
