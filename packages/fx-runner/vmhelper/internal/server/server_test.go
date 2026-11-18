//go:build linux

package server

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"fx-vmhelper/internal/protocol"
	"fx-vmhelper/internal/vmlog"
)

// fakeBackend enforces what the real one must: a template that is not in the signed set, a sandbox that
// was never prepared, and the sandbox cap are each a fixed code, and nothing is created on a refusal.
type fakeBackend struct {
	mu        sync.Mutex
	calls     int
	templates map[string]bool
	max       int
	boxes     map[string]int64
}

func newFake() *fakeBackend {
	return &fakeBackend{templates: map[string]bool{"fx-agent": true}, max: 2, boxes: map[string]int64{}}
}

func (f *fakeBackend) Prepare(r protocol.Request) (Reply, protocol.Code) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	switch {
	case !f.templates[r.Template]:
		return Reply{}, protocol.UnknownTemplate
	case len(f.boxes) >= f.max:
		return Reply{}, protocol.OverCap
	}
	f.boxes[r.SandboxID] = 1700000000
	return Reply{VsockDir: "/jail/vsock/" + r.SandboxID, SandboxGID: 100007}, protocol.OK
}
func (f *fakeBackend) Start(id string) (Reply, protocol.Code) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if _, ok := f.boxes[id]; !ok {
		return Reply{}, protocol.UnknownSandbox
	}
	return Reply{VsockDir: "/jail/vsock/" + id, SandboxGID: 100007}, protocol.OK
}
func (f *fakeBackend) Destroy(id string) protocol.Code {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if _, ok := f.boxes[id]; !ok {
		return protocol.UnknownSandbox
	}
	delete(f.boxes, id)
	return protocol.OK
}
func (f *fakeBackend) List() ([]Entry, protocol.Code) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	var out []Entry
	for id, c := range f.boxes {
		out = append(out, Entry{SandboxID: id, Created: c, VsockDir: "/jail/vsock/" + id, SandboxGID: 100007})
	}
	return out, protocol.OK
}
func (f *fakeBackend) count() int { f.mu.Lock(); defer f.mu.Unlock(); return f.calls }

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

type rig struct {
	sock string
	be   *fakeBackend
	log  *lockedBuf
}

func start(t *testing.T, mut func(*Server)) rig {
	t.Helper()
	dir, err := os.MkdirTemp("", "fxvm") // short: a unix socket path is limited to 108 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	be, lb := newFake(), &lockedBuf{}
	s := &Server{RunnerUID: uint32(os.Getuid()), Caps: protocol.Caps{MaxVCPUs: 4, MaxMemMB: 4096}, Backend: be, Log: vmlog.New(lb, nil), Timeout: 300 * time.Millisecond}
	if mut != nil {
		mut(s)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = s.Serve(ctx, ln); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return rig{sock: sock, be: be, log: lb}
}

func dial(t *testing.T, sock string) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func readLine(t *testing.T, c net.Conn) string {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	s, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		t.Fatalf("no response: %v (%q)", err, s)
	}
	return strings.TrimSpace(s)
}

func ask(t *testing.T, sock, frame string) string {
	t.Helper()
	c := dial(t, sock)
	// A refusal made before any read closes the socket at once, so this write may fail; the answer is still queued.
	_, _ = c.Write([]byte(frame + "\n"))
	return readLine(t, c)
}

func code(c protocol.Code) string {
	return `{"ok":false,"protocol":1,"code":"` + string(c) + `"}`
}

// The peer uid read through a real socket pair is the process's own uid. This needs no root.
func TestPeerUIDThroughARealSocketPair(t *testing.T) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	var conns []net.Conn
	for _, fd := range fds {
		f := os.NewFile(uintptr(fd), "pair")
		c, err := net.FileConn(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		conns = append(conns, c)
	}
	for _, c := range conns {
		uid, err := PeerUID(c)
		if err != nil || uid != uint32(os.Getuid()) {
			t.Fatalf("uid %d err %v, want %d", uid, err, os.Getuid())
		}
	}
	// The same through a listening socket: the accepted side reads the dialler's uid.
	r := start(t, nil)
	got := make(chan uint32, 1)
	ln, _ := net.Listen("unix", filepath.Join(filepath.Dir(r.sock), "p.sock"))
	defer ln.Close()
	go func() { c, _ := ln.Accept(); u, _ := PeerUID(c); got <- u; c.Close() }()
	dial(t, filepath.Join(filepath.Dir(r.sock), "p.sock"))
	if u := <-got; u != uint32(os.Getuid()) {
		t.Fatalf("accepted side read %d", u)
	}
	if _, err := PeerUID(&net.TCPConn{}); err == nil {
		t.Fatal("a non-unix conn must fail")
	}
}

// File mode is not what keeps another uid out: the socket is 0666 here, and the gate is the kernel's uid.
func TestAnotherUIDIsRefusedWhateverTheSocketMode(t *testing.T) {
	r := start(t, func(s *Server) { s.RunnerUID = uint32(os.Getuid()) + 1 })
	if err := os.Chmod(r.sock, 0o666); err != nil {
		t.Fatal(err)
	}
	for _, frame := range []string{`{"verb":"list"}`, `{"verb":"prepare","sandbox_id":"a","template":"fx-agent","vcpus":1,"mem_mb":1}`} {
		if got := ask(t, r.sock, frame); got != code(protocol.BadPeer) {
			t.Fatalf("got %s", got)
		}
	}
	if r.be.count() != 0 {
		t.Fatal("the backend was reached by the wrong uid")
	}
	if !strings.Contains(r.log.String(), "result=bad_peer") {
		t.Fatal(r.log.String())
	}
}

// A body that names a uid changes nothing: the schema has no such field, and the gate never reads the body.
func TestAUidInTheBodyIsRefused(t *testing.T) {
	r := start(t, func(s *Server) { s.RunnerUID = uint32(os.Getuid()) + 1 })
	if got := ask(t, r.sock, `{"verb":"list","uid":0}`); got != code(protocol.BadPeer) {
		t.Fatal(got)
	}
	r2 := start(t, nil)
	if got := ask(t, r2.sock, `{"verb":"list","uid":0}`); got != code(protocol.BadField) {
		t.Fatal(got)
	}
}

func TestAFailedPeerReadRefuses(t *testing.T) {
	r := start(t, func(s *Server) { s.Peer = func(net.Conn) (uint32, error) { return uint32(os.Getuid()), syscall.EBADF } })
	if got := ask(t, r.sock, `{"verb":"list"}`); got != code(protocol.BadPeer) {
		t.Fatal(got)
	}
	// An unreadable credential is not uid 0: the journal says "-".
	waitLog(t, r, "uid=- id=- result=bad_peer")
	if strings.Contains(r.log.String(), "uid=0") {
		t.Fatal(r.log.String())
	}
}

// waitLog waits for the journal to hold s: a request is logged just after its answer is written.
func waitLog(t *testing.T, r rig, s string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if strings.Contains(r.log.String(), s) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%q never reached the journal:\n%s", s, r.log.String())
}

// A refused frame keeps the verb the parser had already validated, and the id when it matched.
func TestRefusedFramesKeepTheValidatedVerb(t *testing.T) {
	r := start(t, nil)
	ask(t, r.sock, `{"verb":"start","sandbox_id":"Not-Valid"}`)
	ask(t, r.sock, `{"verb":"destroy","sandbox_id":"job-3","extra":"x"}`)
	ask(t, r.sock, `{"verb":"nonsense"}`)
	for _, want := range []string{"verb=start uid=", " id=- result=bad_id", "verb=destroy uid=", " id=job-3 result=bad_field", "verb=- uid="} {
		waitLog(t, r, want)
	}
	if out := r.log.String(); strings.Contains(out, "nonsense") {
		t.Fatal("an unvalidated verb reached the journal")
	}
}

func TestVerbsEndToEnd(t *testing.T) {
	r := start(t, nil)
	c := dial(t, r.sock)
	br := bufio.NewReader(c)
	say := func(frame string) string {
		t.Helper()
		_, _ = c.Write([]byte(frame + "\n"))
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		s, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(s)
	}
	if got := say(`{"verb":"prepare","sandbox_id":"job-1","template":"fx-agent","vcpus":2,"mem_mb":1024}`); got != `{"ok":true,"protocol":1,"vsock_dir":"/jail/vsock/job-1","sandbox_gid":100007}` {
		t.Fatal(got)
	}
	if got := say(`{"verb":"list"}`); got != `{"ok":true,"protocol":1,"sandboxes":[{"sandbox_id":"job-1","created":1700000000,"vsock_dir":"/jail/vsock/job-1","sandbox_gid":100007}]}` {
		t.Fatal(got)
	}
	if got := say(`{"verb":"start","sandbox_id":"job-1"}`); got != `{"ok":true,"protocol":1,"vsock_dir":"/jail/vsock/job-1","sandbox_gid":100007}` {
		t.Fatal(got)
	}
	if got := say(`{"verb":"destroy","sandbox_id":"job-1"}`); got != `{"ok":true,"protocol":1}` {
		t.Fatal(got)
	}
	if got := say(`{"verb":"list"}`); got != `{"ok":true,"protocol":1,"sandboxes":[]}` {
		t.Fatal(got)
	}
	// A refusal ends the connection.
	if got := say(`{"verb":"start","sandbox_id":"gone"}`); got != code(protocol.UnknownSandbox) {
		t.Fatal(got)
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("the connection stayed open after a refusal")
	}
}

// Each refusal from the typed list: a fixed code, nothing echoed, and the backend never reached.
func TestEveryRefusalIsFixedAndReachesNoBackend(t *testing.T) {
	r := start(t, nil)
	cases := []struct {
		in   string
		want protocol.Code
	}{
		{`{"verb":"prepare","sandbox_id":"a","template":"fx-agent","vcpus":1,"mem_mb":1,"unknownfield":"SECRET-1"}`, protocol.BadField},
		{`{"verb":"prepare","sandbox_id":"a","template":"fx-agent","vcpus":1,"mem_mb":1,"argv":"--SECRET-2"}`, protocol.BadField},
		{`{"verb":"start","sandbox_id":"/etc/SECRET-3"}`, protocol.BadID},
		{`{"verb":"start","sandbox_id":"SECRET-4"}`, protocol.BadID},
		{`{"verb":"list","verb":"list","x":"SECRET-5"}`, protocol.BadFrame},
		{`{"verb":"list","__proto__":"SECRET-6"}`, protocol.BadFrame},
		{`{"verb":"prepare","sandbox_id":"a","template":"fx-agent","vcpus":1.5,"mem_mb":1}`, protocol.BadNumber},
		{`{"verb":"prepare","sandbox_id":"a","template":"fx-agent","vcpus":5,"mem_mb":1}`, protocol.OverCap},
		{`{"verb":"prepare","sandbox_id":"a","template":"fx-agent","vcpus":1,"mem_mb":4097}`, protocol.OverCap},
		{`{"verb":"SECRET-7"}`, protocol.UnknownVerb},
	}
	for _, c := range cases {
		got := ask(t, r.sock, c.in)
		if got != code(c.want) || strings.Contains(got, "SECRET") {
			t.Errorf("%s: got %s", c.in, got)
		}
	}
	if r.be.count() != 0 {
		t.Fatal("a schema refusal reached the backend")
	}
	if strings.Contains(r.log.String(), "SECRET") {
		t.Fatalf("request bytes reached the journal:\n%s", r.log.String())
	}
}

// What only the backend can know is still a fixed code on the wire.
func TestBackendRefusals(t *testing.T) {
	r := start(t, nil)
	if got := ask(t, r.sock, `{"verb":"prepare","sandbox_id":"a","template":"not-signed","vcpus":1,"mem_mb":1}`); got != code(protocol.UnknownTemplate) {
		t.Fatal(got)
	}
	if got := ask(t, r.sock, `{"verb":"start","sandbox_id":"never-prepared"}`); got != code(protocol.UnknownSandbox) {
		t.Fatal(got)
	}
	if got := ask(t, r.sock, `{"verb":"destroy","sandbox_id":"never-prepared"}`); got != code(protocol.UnknownSandbox) {
		t.Fatal(got)
	}
	if len(r.be.boxes) != 0 {
		t.Fatal("a refusal created something")
	}
}

func TestFrameOverFourKiBIsRefused(t *testing.T) {
	r := start(t, nil)
	c := dial(t, r.sock)
	_, _ = c.Write([]byte(`{"verb":"list","x":"` + strings.Repeat("a", 5000) + `"}` + "\n"))
	if got := readLine(t, c); got != code(protocol.FrameTooLarge) {
		t.Fatal(got)
	}
	// No newline at all, and more than the limit: the same answer, without waiting for the timeout.
	c2 := dial(t, r.sock)
	_, _ = c2.Write(bytes.Repeat([]byte("a"), 4097))
	if got := readLine(t, c2); got != code(protocol.FrameTooLarge) {
		t.Fatal(got)
	}
	if r.be.count() != 0 {
		t.Fatal("reached the backend")
	}
}

// A client that sends 3 bytes and stops is cut at the frame timeout and its slot is freed.
func TestStalledClientIsCutAndItsSlotFreed(t *testing.T) {
	r := start(t, func(s *Server) { s.Max = 1; s.Timeout = 250 * time.Millisecond })
	c := dial(t, r.sock)
	_, _ = c.Write([]byte(`{"v`))
	begin := time.Now()
	if got := readLine(t, c); got != code(protocol.FrameTimeout) {
		t.Fatal(got)
	}
	if d := time.Since(begin); d < 200*time.Millisecond || d > 2*time.Second {
		t.Fatalf("cut after %v", d)
	}
	if got := ask(t, r.sock, `{"verb":"list"}`); !strings.HasPrefix(got, `{"ok":true`) {
		t.Fatalf("the slot was not freed: %s", got)
	}
}

// A client that trickles a byte at a time cannot extend the deadline.
func TestTrickleDoesNotExtendTheDeadline(t *testing.T) {
	r := start(t, func(s *Server) { s.Timeout = 300 * time.Millisecond })
	c := dial(t, r.sock)
	go func() {
		for i := 0; i < 20; i++ {
			if _, err := c.Write([]byte(" ")); err != nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()
	begin := time.Now()
	if got := readLine(t, c); got != code(protocol.FrameTimeout) {
		t.Fatal(got)
	}
	if time.Since(begin) > time.Second {
		t.Fatal("the deadline moved")
	}
}

// Eight connections are served at once; the ninth gets the fixed code, and list() still answers on the first.
func TestNinthConnectionIsRefusedAndTheFirstEightStillWork(t *testing.T) {
	r := start(t, func(s *Server) { s.Timeout = 3 * time.Second })
	var held []net.Conn
	for i := 0; i < MaxConns; i++ {
		held = append(held, dial(t, r.sock))
	}
	time.Sleep(100 * time.Millisecond) // let the accept loop take all eight
	ninth := dial(t, r.sock)
	if got := readLine(t, ninth); got != code(protocol.TooBusy) {
		t.Fatalf("ninth: %s", got)
	}
	for i, c := range held {
		if i%3 != 0 {
			continue
		}
		_, _ = c.Write([]byte(`{"verb":"list"}` + "\n"))
		if got := readLine(t, c); !strings.HasPrefix(got, `{"ok":true`) {
			t.Fatalf("held %d: %s", i, got)
		}
	}
	held[0].Close() // a freed slot is usable at once
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := ask(t, r.sock, `{"verb":"list"}`)
		if strings.HasPrefix(got, `{"ok":true`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot not freed: %s", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestDefaultsAreTheSpecValues(t *testing.T) {
	if FrameTimeout != 5*time.Second || MaxConns != 8 || protocol.MaxFrame != 4096 {
		t.Fatal(FrameTimeout, MaxConns, protocol.MaxFrame)
	}
}

// One journal line per request, with only the named fields, and no byte of a hostile request in it.
func TestJournalHasOneCleanLinePerRequest(t *testing.T) {
	r := start(t, nil)
	ask(t, r.sock, `{"verb":"list"}`)
	ask(t, r.sock, "{\"verb\":\"start\",\"sandbox_id\":\"a\\nforged=1\\u001b[31m\\u0000\"}")
	ask(t, r.sock, "{\"verb\":\"\\u001b[2Jevil\\nforged=2\"}")
	ask(t, r.sock, `{"verb":"start","sandbox_id":"job-7"}`)
	time.Sleep(50 * time.Millisecond)
	out := r.log.String()
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("%d lines:\n%q", len(lines), out)
	}
	for _, bad := range []string{"\x1b", "\x00", "forged"} {
		if strings.Contains(out, bad) {
			t.Fatalf("found %q:\n%q", bad, out)
		}
	}
	for _, field := range []string{"ts=", "req=", "verb=", "uid=", "id=", "result=", "dur_ms="} {
		for _, l := range lines {
			if !strings.Contains(l, field) {
				t.Fatalf("%q lacks %s", l, field)
			}
		}
	}
	if !strings.Contains(lines[3], "id=job-7 result=unknown_sandbox") || !strings.Contains(lines[1], "id=- result=bad_id") {
		t.Fatalf("\n%s", out)
	}
}

func TestListenChecksTheDirectoryAndTheSocketPath(t *testing.T) {
	me := uint32(os.Getuid())
	dir, err := os.MkdirTemp("", "fxl")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	run := filepath.Join(dir, "run")
	if err := os.Mkdir(run, 0o750); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(run, 0o750)
	if _, err := Listen(run, "h.sock", me+1, 0o750); err == nil {
		t.Fatal("wrong owner accepted")
	}
	if _, err := Listen(run, "h.sock", me, 0o755); err == nil {
		t.Fatal("wrong mode accepted")
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(run, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(link, "h.sock", me, 0o750); err == nil {
		t.Fatal("a symlinked directory was followed")
	}
	// something that is not a socket at the path
	if err := os.WriteFile(filepath.Join(run, "h.sock"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(run, "h.sock", me, 0o750); err == nil {
		t.Fatal("a regular file at the socket path was replaced")
	}
	_ = os.Remove(filepath.Join(run, "h.sock"))
	// a symlink at the path is not followed or replaced either
	if err := os.Symlink("/nonexistent-target", filepath.Join(run, "h.sock")); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(run, "h.sock", me, 0o750); err == nil {
		t.Fatal("a symlink at the socket path was accepted")
	}
	_ = os.Remove(filepath.Join(run, "h.sock"))

	ln, err := Listen(run, "h.sock", me, 0o750)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(run, "h.sock"))
	if err != nil || st.Mode().Perm() != 0o660 || st.Mode()&os.ModeSocket == 0 {
		t.Fatalf("%v %v", st, err)
	}
	// a stale socket from a crashed helper is replaced
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	ln2, err := Listen(run, "h.sock", me, 0o750)
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	ln2.Close()
}

// Close must not unlink anything by the path it was bound to. The listener is bound through
// /proc/self/fd/N and N is closed when Listen returns, so an unrelated directory that is opened next
// gets the same number, and a Close that unlinked "<name>" would delete that directory's file. Here
// sixty-four unrelated directories are opened (one of them is certain to reuse N) and each holds a file
// of the same name: all of them must survive, and so must the helper's own socket (the next start
// replaces a stale one).
func TestCloseNeverUnlinksAFileInAnUnrelatedDirectory(t *testing.T) {
	me := uint32(os.Getuid())
	base, err := os.MkdirTemp("", "fxc")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	run := filepath.Join(base, "run")
	if err := os.Mkdir(run, 0o750); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(run, 0o750)
	ln, err := Listen(run, "h.sock", me, 0o750)
	if err != nil {
		t.Fatal(err)
	}
	var victims []string
	for i := 0; i < 64; i++ {
		d := filepath.Join(base, "other"+string(rune('a'+i%26))+string(rune('a'+i/26)))
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
		f := filepath.Join(d, "h.sock")
		if err := os.WriteFile(f, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
		fd, err := syscall.Open(d, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.Close(fd)
		victims = append(victims, f)
	}
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	for _, f := range victims {
		if b, err := os.ReadFile(f); err != nil || string(b) != "keep" {
			t.Fatalf("%s was removed by Close: %v", f, err)
		}
	}
	if st, err := os.Lstat(filepath.Join(run, "h.sock")); err != nil || st.Mode()&os.ModeSocket == 0 {
		t.Fatalf("the helper's own socket is expected to be left for the next start to replace: %v", err)
	}
	// ...and the next start does replace it.
	ln2, err := Listen(run, "h.sock", me, 0o750)
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	ln2.Close()
}

// flaky fails its first n Accept calls with err, then accepts for real.
type flaky struct {
	net.Listener
	n   atomic.Int32
	err error
}

func (f *flaky) Accept() (net.Conn, error) {
	if f.n.Add(-1) >= 0 {
		return nil, &net.OpError{Op: "accept", Net: "unix", Err: os.NewSyscallError("accept", f.err)}
	}
	return f.Listener.Accept()
}

func serveOn(t *testing.T, ln net.Listener) (rig, chan error) {
	t.Helper()
	lb := &lockedBuf{}
	be := newFake()
	s := &Server{RunnerUID: uint32(os.Getuid()), Caps: protocol.Caps{MaxVCPUs: 4, MaxMemMB: 4096}, Backend: be, Log: vmlog.New(lb, nil), Timeout: 300 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, ln) }()
	t.Cleanup(func() { cancel(); <-done })
	return rig{be: be, log: lb}, done
}

// EMFILE (or another passing shortage) on accept does not end the service: it backs off and carries on.
func TestTemporaryAcceptErrorIsRetried(t *testing.T) {
	dir, err := os.MkdirTemp("", "fxa")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "h.sock")
	inner, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	f := &flaky{Listener: inner, err: syscall.EMFILE}
	f.n.Store(4)
	r, done := serveOn(t, f)
	r.sock = sock
	if got := ask(t, sock, `{"verb":"list"}`); got != `{"ok":true,"protocol":1,"sandboxes":[]}` {
		t.Fatalf("the service did not survive EMFILE: %s", got)
	}
	select {
	case err := <-done:
		t.Fatalf("Serve ended: %v", err)
	default:
	}
	// One line for the whole streak, not one per attempt.
	if n := strings.Count(r.log.String(), "event=accept_retry errno=24"); n != 1 {
		t.Fatalf("%d accept_retry lines:\n%s", n, r.log.String())
	}
}

// An accept error that a retry cannot fix still ends the service, so systemd restarts it.
func TestPermanentAcceptErrorEndsTheService(t *testing.T) {
	dir, err := os.MkdirTemp("", "fxa")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	inner, err := net.Listen("unix", filepath.Join(dir, "h.sock"))
	if err != nil {
		t.Fatal(err)
	}
	f := &flaky{Listener: inner, err: syscall.EBADF}
	f.n.Store(1000)
	_, done := serveOn(t, f)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Serve returned nil")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Serve kept running on EBADF")
	}
	done <- nil // the cleanup waits for one value
}

// The frame limit at the wire: 4096 bytes with the newline are served, 4097 are not. The padding is
// whitespace inside a valid frame, so the only difference between the two is the length.
func TestFrameLimitOnTheWire(t *testing.T) {
	r := start(t, nil)
	pad := func(total int) string {
		f := `{"verb":"list"}`
		return f + strings.Repeat(" ", total-len(f)-1) + "\n"
	}
	for _, tc := range []struct {
		total int
		want  string
	}{
		{4096, `{"ok":true,"protocol":1,"sandboxes":[]}`},
		{4097, code(protocol.FrameTooLarge)},
	} {
		frame := pad(tc.total)
		if len(frame) != tc.total {
			t.Fatalf("test frame is %d bytes", len(frame))
		}
		c := dial(t, r.sock)
		if _, err := c.Write([]byte(frame)); err != nil {
			t.Fatal(err)
		}
		if got := readLine(t, c); got != tc.want {
			t.Fatalf("%d bytes: got %s", tc.total, got)
		}
	}
}
