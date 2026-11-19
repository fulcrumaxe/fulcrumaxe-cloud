//go:build linux

package sandbox

import (
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"fx-vmhelper/internal/fcapi"
)

// fakeFC is a Firecracker API server on a Unix socket: PUT only, 204 with no body, a JSON fault on a
// refusal. Its request checks are the ones in the fcapi tests; here it records what the launcher sent.
// Not faked: the real server's validation of the values and its use of the files in the jail (the
// real-root workflow boots a real VM).
type fakeFC struct {
	sock    string
	mu      sync.Mutex
	got     []string // "<path> <body>" in order
	fail    string   // path answered with 400
	dials   int
	dialErr error // what dial answers instead of a connection
	handed  []Spec
	handErr error // what the socket handover answers
}

func newFakeFC(t *testing.T, dir string) *fakeFC {
	t.Helper()
	f := &fakeFC{sock: filepath.Join(dir, "fc.sock")}
	ln, err := net.Listen("unix", f.sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		f.mu.Lock()
		defer f.mu.Unlock()
		if (r.Method != "PUT" && !(r.Method == "PATCH" && r.URL.Path == "/vm")) || r.URL.Path == f.fail {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"fault_message":"refused"}`))
			return
		}
		f.got = append(f.got, r.URL.Path+" "+string(b))
		w.WriteHeader(204)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return f
}

func (f *fakeFC) dial(Spec, int) (net.Conn, error) {
	f.mu.Lock()
	f.dials++
	err := f.dialErr
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return net.Dial("unix", f.sock)
}

func (f *fakeFC) handover(s Spec) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handed = append(f.handed, s)
	return f.handErr
}

func (f *fakeFC) paths() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var p []string
	for _, g := range f.got {
		p = append(p, strings.SplitN(g, " ", 2)[0])
	}
	return strings.Join(p, " ")
}

func gone(t *testing.T, r *rig) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(r.cgroupRoot, "fx/vms/sb-1")); err == nil {
		t.Error("the sandbox's cgroup was left")
	}
	for deadline := time.Now().Add(2 * time.Second); len(fakePIDs(r.dir)) > 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Errorf("the sandbox process was left: %v", fakePIDs(r.dir))
			return
		}
	}
}

// The launch returns after the VM is configured and started, in this order, with the spec's sizes and the
// fixed boot configuration.
func TestLaunchConfiguresAndStartsThroughTheAPISocket(t *testing.T) {
	r := newRig(t)
	in, err := r.l.Launch(r.spec)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.fc.paths(); got != "/machine-config /boot-source /drives/rootfs /vsock /actions" {
		t.Fatalf("requests: %s", got)
	}
	if !strings.Contains(r.fc.got[0], `{"mem_size_mib":512,"vcpu_count":2}`) || !strings.Contains(r.fc.got[1], fcapi.BootArgs) {
		t.Fatalf("%q", r.fc.got)
	}
	if len(r.fc.handed) != 1 || r.fc.handed[0].ID != "sb-1" {
		t.Fatalf("the vsock socket was handed over %d times", len(r.fc.handed))
	}
	if err := in.Stop(); err != nil {
		t.Fatal(err)
	}
}

// The socket is handed to the runner only after the VM was configured, and a handover that fails kills the
// sandbox like any other step.
func TestLaunchHandsOverTheSocketLastAndKillsOnFailure(t *testing.T) {
	r := newRig(t)
	r.fc.fail = "/vsock"
	if _, err := r.l.Launch(r.spec); err == nil || len(r.fc.handed) != 0 {
		t.Fatalf("handed over after a refused configuration: %v %d", err, len(r.fc.handed))
	}
	r = newRig(t)
	r.fc.handErr = errors.New("no chown")
	if _, err := r.l.Launch(r.spec); err == nil || !strings.Contains(err.Error(), "no chown") {
		t.Fatalf("%v", err)
	}
	gone(t, r)
}

// Whatever step fails, the sandbox is killed through its cgroup: no process, no cgroup, an error.
func TestLaunchKillsTheSandboxWhenAnyConfigurationStepFails(t *testing.T) {
	for _, p := range []string{"/machine-config", "/boot-source", "/drives/rootfs", "/vsock", "/actions"} {
		r := newRig(t)
		r.fc.fail = p
		if _, err := r.l.Launch(r.spec); err == nil || !strings.Contains(err.Error(), p) {
			t.Errorf("%s: %v", p, err)
		}
		gone(t, r)
	}
}

func TestLaunchGivesUpWhenTheAPISocketNeverAppears(t *testing.T) {
	defer func(d time.Duration) { apiTimeout = d }(apiTimeout)
	apiTimeout = 300 * time.Millisecond
	r := newRig(t)
	r.fc.dialErr = syscall.ENOENT
	start := time.Now()
	_, err := r.l.Launch(r.spec)
	if err == nil || !strings.Contains(err.Error(), "timed out") || time.Since(start) > 3*time.Second {
		t.Fatalf("%v after %v", err, time.Since(start))
	}
	if r.fc.dials < 2 {
		t.Errorf("only %d attempts: the wait does not retry", r.fc.dials)
	}
	gone(t, r)
}

// A socket that is not the sandbox process's, a refused permission or a symlink fails at once, not after
// the wait.
func TestLaunchFailsAtOnceOnAnythingButNotThereYet(t *testing.T) {
	defer func(d time.Duration) { apiTimeout = d }(apiTimeout)
	apiTimeout = 5 * time.Second
	for name, e := range map[string]error{"wrong peer": errPeer, "permission": syscall.EACCES, "symlink": syscall.ELOOP} {
		r := newRig(t)
		r.fc.dialErr = e
		start := time.Now()
		if _, err := r.l.Launch(r.spec); !errors.Is(err, e) || time.Since(start) > 2*time.Second {
			t.Errorf("%s: %v after %v", name, err, time.Since(start))
		}
		gone(t, r)
	}
}

// A process that dies while the helper waits ends the wait with that fact.
func TestLaunchNoticesTheProcessEndingBeforeItsAPISocket(t *testing.T) {
	r := newRig(t)
	r.l.Dial = func(Spec, int) (net.Conn, error) {
		_ = os.WriteFile(filepath.Join(r.cgroupRoot, "fx/vms/sb-1/cgroup.kill"), []byte("1"), 0o644) // the fake jailer exits
		return nil, syscall.ENOENT
	}
	if _, err := r.l.Launch(r.spec); err == nil || !strings.Contains(err.Error(), "exited before its API socket") {
		t.Fatalf("%v", err)
	}
	gone(t, r)
}

// ---- the real dial ---------------------------------------------------------------------------------

// shortDir is a fresh directory with a path short enough for a socket (sun_path holds 107 bytes).
func shortDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "fv")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	return d
}

type tree struct {
	l   *JailerLauncher
	s   Spec
	run string
}

// newTree makes <jail>/firecracker/<id>/root/run below a temp directory, the place the jailer's socket is.
func newTree(t *testing.T) tree {
	t.Helper()
	dir := shortDir(t)
	u, g := me()
	s := Spec{ID: "sb-1", UID: u, GID: g, JailDir: dir + "/jails/sb-1"}
	run := s.JailDir + "/firecracker/sb-1/root/run"
	if err := os.MkdirAll(run, 0o700); err != nil {
		t.Fatal(err)
	}
	return tree{&JailerLauncher{Firecracker: dir + "/bin/firecracker", Remap: toMe}, s, run}
}

func listen(t *testing.T, p string) net.Listener {
	t.Helper()
	ln, err := net.Listen("unix", p)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return ln
}

// The socket is reached only when its peer is the launched process: its pid and its uid.
func TestDialAPIChecksThePeer(t *testing.T) {
	tr := newTree(t)
	listen(t, tr.run+"/firecracker.socket")
	if c, err := tr.l.dialAPI(tr.s, os.Getpid()); err != nil {
		t.Fatal(err)
	} else {
		c.Close()
	}
	if _, err := tr.l.dialAPI(tr.s, os.Getpid()+1); !errors.Is(err, errPeer) {
		t.Errorf("another pid: %v", err)
	}
	tr.l.Remap = func(u, g uint32) (uint32, uint32) { return u + 1, g }
	if _, err := tr.l.dialAPI(tr.s, os.Getpid()); !errors.Is(err, errPeer) {
		t.Errorf("another uid: %v", err)
	}
}

// Every directory of the walk is opened without following a symlink, and a missing socket is "not yet".
func TestDialAPIDoesNotFollowSymlinksAndReportsNotThereYet(t *testing.T) {
	tr := newTree(t)
	if _, err := tr.l.dialAPI(tr.s, os.Getpid()); !errors.Is(err, syscall.ENOENT) {
		t.Errorf("no socket: %v", err)
	}
	other := shortDir(t) + "/run"
	if err := os.Mkdir(other, 0o700); err != nil {
		t.Fatal(err)
	}
	listen(t, other+"/firecracker.socket")
	if err := os.Remove(tr.run); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, tr.run); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.l.dialAPI(tr.s, os.Getpid()); err == nil || errors.Is(err, syscall.ENOENT) || errors.Is(err, errPeer) {
		t.Errorf("a symlinked run directory was followed or misreported: %v", err)
	}
}

// A symlink at the socket's own name is refused before any connect: the target (here a live listener that
// counts connections) is never reached, and the error is neither "not there yet" nor a peer mismatch.
func TestDialAPIRefusesASymlinkAtTheSocketName(t *testing.T) {
	tr := newTree(t)
	target := shortDir(t) + "/target.sock"
	ln, err := net.Listen("unix", target)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	conns := make(chan struct{}, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			conns <- struct{}{}
			c.Close()
		}
	}()
	if err := os.Symlink(target, tr.run+"/firecracker.socket"); err != nil {
		t.Fatal(err)
	}
	_, err = tr.l.dialAPI(tr.s, os.Getpid()) // the target's peer is this very process: only the no-follow open can refuse
	if !errors.Is(err, errPeer) {            // O_PATH|O_NOFOLLOW opens the link itself; fstat says it is no socket
		t.Fatalf("want errPeer, got %v", err)
	}
	select {
	case <-conns:
		t.Fatal("the symlink's target was connected to")
	case <-time.After(200 * time.Millisecond):
	}
}

// A regular file at the socket's name is no socket of the sandbox.
func TestDialAPIRefusesAFileThatIsNotASocket(t *testing.T) {
	tr := newTree(t)
	if err := os.WriteFile(tr.run+"/firecracker.socket", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.l.dialAPI(tr.s, os.Getpid()); !errors.Is(err, errPeer) {
		t.Fatalf("%v", err)
	}
}

// A capability the unit did not grant is refused before any connection is made.
func TestDialAPIRefusesACapabilityItDoesNotHold(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root holds it")
	}
	tr := newTree(t)
	listen(t, tr.run+"/firecracker.socket")
	tr.l.AmbientCaps = []uintptr{1}
	if _, err := tr.l.dialAPI(tr.s, os.Getpid()); err == nil {
		t.Fatal("connected with a capability that is not permitted")
	}
}

// The handover changes only a socket of the sandbox uid, reached without following a symlink.
func TestHandOverSocketOnlyTouchesASocketOfTheSandbox(t *testing.T) {
	mk := func() (*JailerLauncher, Spec) {
		dir := shortDir(t)
		u, g := me()
		return &JailerLauncher{Remap: toMe}, Spec{ID: "sb-1", UID: u, GID: g, RunnerUID: u, VsockDir: dir}
	}
	l, s := mk()
	listen(t, s.VsockDir+"/v.sock")
	if err := l.handOverSocket(s); err != nil {
		t.Fatalf("a socket of the sandbox: %v", err)
	}
	// the sandbox's uid is another than the socket's owner, and the chown itself (to this user) would succeed
	l.Remap = func(u, g uint32) (uint32, uint32) { return u, g }
	s.UID++
	if err := l.handOverSocket(s); err == nil {
		t.Error("a socket of another uid was handed over")
	}
	l, s = mk()
	if err := os.WriteFile(s.VsockDir+"/v.sock", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := l.handOverSocket(s); err == nil {
		t.Error("a regular file was handed over")
	}
	l, s = mk()
	other := listen(t, shortDir(t)+"/real.sock")
	if err := os.Symlink(other.Addr().String(), s.VsockDir+"/v.sock"); err != nil {
		t.Fatal(err)
	}
	if err := l.handOverSocket(s); err == nil {
		t.Error("a symlink was followed")
	}
	l, s = mk()
	if err := l.handOverSocket(s); err == nil {
		t.Error("a missing socket was accepted")
	}
}
