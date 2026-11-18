//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/protocol"
)

// None of these tests needs root. Ownership that production gives to a sandbox uid, or to root, is mapped
// onto the test user's own ids (Manager.remap), because only root can chown to another uid. The checks of
// what a different uid could do go through Permits on the real mode bits instead.

var me = func() (uint32, uint32) { return uint32(os.Getuid()), uint32(os.Getgid()) }

func toMe(uint32, uint32) (uint32, uint32) { return me() }

type fakeInst struct{ l *fakeLauncher }

func (f fakeInst) Stop() error { f.l.stopped++; return f.l.stopErr }

type fakeLauncher struct {
	mu      sync.Mutex
	specs   []Spec
	err     error
	stopped int
	stopErr error
}

func (f *fakeLauncher) Launch(s Spec) (Instance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	f.specs = append(f.specs, s)
	return fakeInst{f}, nil
}

func mkroot(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "jail")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o711); err != nil {
		t.Fatal(err)
	}
	return root
}

func cfgFor(root string, max int64) config.Config {
	return config.Config{JailRoot: root, RunnerUID: 1000, RunnerGID: 1000, UIDFirst: 100000, UIDCount: 16, GIDFirst: 100000, GIDCount: 16,
		MaxSandboxes: max, MaxVCPUs: 4, MaxMemMB: 4096, FirecrackerPath: "/opt/fx/firecracker"}
}

func newMgr(t *testing.T, max int64, l Launcher) (*Manager, string) {
	t.Helper()
	root := mkroot(t)
	m, err := newManager(cfgFor(root, max), l, 0, toMe)
	if err != nil {
		t.Fatal(err)
	}
	newFixture(t).use(m)
	t.Cleanup(m.Close)
	return m, root
}

func prep(id string) protocol.Request {
	return protocol.Request{Verb: protocol.Prepare, SandboxID: id, Template: "fx-agent", VCPUs: 2, MemMB: 512}
}

func mode(t *testing.T, p string) os.FileMode {
	t.Helper()
	fi, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode() & (os.ModePerm | os.ModeSymlink | os.ModeDir)
}

func TestPrepareBuildsLayoutWithContractModes(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	reply, code := m.Prepare(prep("box-a"))
	if code != protocol.OK {
		t.Fatal(code)
	}
	if reply.VsockDir != root+"/vsock/box-a" {
		t.Fatalf("vsock_dir %q", reply.VsockDir)
	}
	for p, want := range map[string]os.FileMode{
		root:                  os.ModeDir | 0o711,
		root + "/jails":       os.ModeDir | 0o700,
		root + "/vsock":       os.ModeDir | 0o711,
		root + "/jails/box-a": os.ModeDir | 0o700,
		root + "/vsock/box-a": os.ModeDir | 0o710,
	} {
		if got := mode(t, p); got != want {
			t.Errorf("%s: mode %v, want %v", p, got, want)
		}
	}
}

func TestCheckedModesAreTheContractValues(t *testing.T) {
	if RootMode != 0o711 || JailsMode != 0o700 || VsockRootMode != 0o711 || VsockDirMode != 0o710 || JailDirMode != 0o700 || SocketMode != 0o660 {
		t.Fatal("a contract mode constant changed")
	}
}

func TestOtherSandboxCannotTraverseOrList(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	var l = m.Launcher.(*fakeLauncher)
	for _, id := range []string{"box-a", "box-b"} {
		if _, c := m.Prepare(prep(id)); c != protocol.OK {
			t.Fatal(c)
		}
		if _, c := m.Start(id); c != protocol.OK {
			t.Fatal(c)
		}
	}
	a, b := l.specs[0], l.specs[1]
	if a.GID == b.GID || a.UID == b.UID {
		t.Fatalf("two sandboxes share an id: %+v %+v", a, b)
	}
	// The real mode bits of the real directory, judged as each uid would be (no root needed).
	dirMode := mode(t, root+"/vsock/box-a") & os.ModePerm
	const runnerUID, rGID = 1000, 1000
	const r, x = 4, 1
	// a's directory is owned by the runner uid with group = a's gid.
	if !Permits(dirMode, runnerUID, a.GID, a.UID, []uint32{a.GID}, x) {
		t.Error("sandbox A cannot traverse its own directory")
	}
	if Permits(dirMode, runnerUID, a.GID, a.UID, []uint32{a.GID}, r) {
		t.Error("sandbox A can list its own directory (group must not hold r)")
	}
	if Permits(dirMode, runnerUID, a.GID, b.UID, []uint32{b.GID}, x) {
		t.Error("sandbox B can traverse A's directory")
	}
	if Permits(dirMode, runnerUID, a.GID, b.UID, []uint32{b.GID}, r) {
		t.Error("sandbox B can list A's directory")
	}
	if !Permits(dirMode, runnerUID, a.GID, runnerUID, []uint32{rGID}, r|x) {
		t.Error("the runner cannot list its own directory")
	}
	// The socket: 0660, the same owner and group. A connects (rw), B cannot.
	if !Permits(SocketMode, runnerUID, a.GID, a.UID, []uint32{a.GID}, 6) {
		t.Error("sandbox A cannot connect to its socket")
	}
	if Permits(SocketMode, runnerUID, a.GID, b.UID, []uint32{b.GID}, 6) || Permits(SocketMode, runnerUID, a.GID, b.UID, []uint32{b.GID}, 4) {
		t.Error("sandbox B can reach A's socket")
	}
	// The root of the vsock tree must not let a sandbox list its neighbours, only pass through.
	rootMode := mode(t, root+"/vsock") & os.ModePerm
	if Permits(rootMode, 0, 0, b.UID, []uint32{b.GID}, r) || !Permits(rootMode, 0, 0, b.UID, []uint32{b.GID}, x) {
		t.Error("vsock root must be traversable and not listable by a sandbox")
	}
}

func TestAllocatorTakesLowestFreeAndReuses(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newMgr(t, 3, l)
	for _, id := range []string{"a1", "a2", "a3"} {
		m.Prepare(prep(id))
		m.Start(id)
	}
	for i, s := range l.specs {
		if s.UID != uint32(100000+i) || s.GID != uint32(100000+i) {
			t.Errorf("box %d got uid %d gid %d", i, s.UID, s.GID)
		}
	}
	if _, c := m.Prepare(prep("a4")); c != protocol.OverCap {
		t.Fatalf("over the sandbox cap: %s", c)
	}
	if c := m.Destroy("a2"); c != protocol.OK {
		t.Fatal(c)
	}
	m.Prepare(prep("a5"))
	m.Start("a5")
	if got := l.specs[3]; got.UID != 100001 || got.GID != 100001 {
		t.Errorf("freed ids not reused lowest-first: %+v", got)
	}
}

func TestAllocatorExhaustedRangeIsOverCap(t *testing.T) {
	root := mkroot(t)
	cfg := cfgFor(root, 4)
	cfg.UIDCount, cfg.GIDCount = 1, 1
	m, err := newManager(cfg, &fakeLauncher{}, 0, toMe)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	newFixture(t).use(m)
	if _, c := m.Prepare(prep("a1")); c != protocol.OK {
		t.Fatal(c)
	}
	if _, c := m.Prepare(prep("a2")); c != protocol.OverCap {
		t.Fatal(c)
	}
	if _, err := os.Lstat(root + "/jails/a2"); err == nil {
		t.Fatal("a refused prepare left a directory")
	}
}

func TestPrepareRefusesBadIDsBeforeCreatingAnything(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	for _, id := range []string{"", "-a", "A", "a/b", "../x", "a b", strings.Repeat("a", 41), "a\x00b", "."} {
		if _, c := m.Prepare(prep(id)); c != protocol.BadID {
			t.Errorf("id %q: %s", id, c)
		}
	}
	bad := prep("ok-id")
	bad.Template = "-bad"
	if _, c := m.Prepare(bad); c != protocol.BadID {
		t.Errorf("template: %s", c)
	}
	if _, c := m.Prepare(prep("ok-id")); c != protocol.OK {
		t.Fatal(c)
	}
	if _, c := m.Prepare(prep("ok-id")); c != protocol.BadID {
		t.Errorf("duplicate id: %s", c)
	}
	for _, d := range []string{"jails", "vsock"} {
		es, _ := os.ReadDir(filepath.Join(root, d))
		if len(es) != 1 {
			t.Errorf("%s holds %d entries after refusals, want 1", d, len(es))
		}
	}
}

func TestPrepareChecksCaps(t *testing.T) {
	m, _ := newMgr(t, 3, &fakeLauncher{})
	r := prep("a1")
	r.VCPUs = 5
	if _, c := m.Prepare(r); c != protocol.OverCap {
		t.Fatal(c)
	}
	r = prep("a1")
	r.MemMB = 4097
	if _, c := m.Prepare(r); c != protocol.OverCap {
		t.Fatal(c)
	}
}

func TestPlainNameRefusesTraversal(t *testing.T) {
	for _, s := range []string{"", ".", "..", "a/b", "/a", "a\x00", strings.Repeat("x", 256)} {
		if plainName(s) {
			t.Errorf("%q accepted", s)
		}
	}
	if !plainName("box-a") {
		t.Fatal("a plain name was refused")
	}
	m, root := newMgr(t, 1, &fakeLauncher{})
	if _, err := m.mkdirOwned(m.jailsFd, "../escape", 0o700, 1, 1); err == nil {
		t.Fatal("mkdirOwned accepted ../")
	}
	if _, err := os.Lstat(filepath.Join(filepath.Dir(root), "escape")); err == nil {
		t.Fatal("a directory was created outside the root")
	}
	if err := removeAt(m.jailsFd, "../jail"); err == nil {
		t.Fatal("removeAt accepted ../")
	}
	if _, err := os.Lstat(root); err != nil {
		t.Fatal("the jail root is gone")
	}
}

func TestCleanAbs(t *testing.T) {
	for _, p := range []string{"", "rel/x", "/a/../b", "/a/./b", "/a//b", "/a/b/", "/a\x00b", "/" + strings.Repeat("a", 5000)} {
		if cleanAbs(p) == nil {
			t.Errorf("%q accepted", p)
		}
	}
	if cleanAbs("/a/b") != nil {
		t.Fatal("clean path refused")
	}
}

func TestValidateVsockDirBasenameAndShape(t *testing.T) {
	good := "/srv/jail/vsock/box-a"
	if err := ValidateVsockDir(good, "box-a"); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string][2]string{
		"other basename":  {"/srv/jail/vsock/box-b", "box-a"},
		"prefix basename": {"/srv/jail/vsock/box-a2", "box-a"},
		"dotdot":          {"/srv/jail/../vsock/box-a", "box-a"},
		"relative":        {"vsock/box-a", "box-a"},
		"nul":             {"/srv/jail/vsock/box-a\x00", "box-a"},
		"trailing slash":  {"/srv/jail/vsock/box-a/", "box-a"},
		"bad id":          {"/srv/jail/vsock/-a", "-a"},
		"id with slash":   {"/srv/jail/vsock/a/b", "a/b"},
		"empty":           {"", "box-a"},
	} {
		if ValidateVsockDir(c[0], c[1]) == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestCheckVsockDirRefusesSymlinksWrongModeAndOwner(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	reply, c := m.Prepare(prep("box-a"))
	if c != protocol.OK {
		t.Fatal(c)
	}
	u, g := me()
	if err := vchk(m, reply.VsockDir, "box-a", u, g); err != nil {
		t.Fatal(err)
	}
	// wrong owner and wrong group are each refused
	if vchk(m, reply.VsockDir, "box-a", u+1, g) == nil || vchk(m, reply.VsockDir, "box-a", u, g+1) == nil {
		t.Error("a wrong owner or group was accepted")
	}
	// wrong mode, in both directions
	for _, bad := range []os.FileMode{0o711, 0o750, 0o700, 0o770} {
		if err := os.Chmod(reply.VsockDir, bad); err != nil {
			t.Fatal(err)
		}
		if vchk(m, reply.VsockDir, "box-a", u, g) == nil {
			t.Errorf("mode %04o accepted", bad)
		}
	}
	if err := os.Chmod(reply.VsockDir, 0o710); err != nil {
		t.Fatal(err)
	}
	// the final component is a symlink to a good directory
	if err := os.Symlink(reply.VsockDir, root+"/vsock/link"); err != nil {
		t.Fatal(err)
	}
	if vchk(m, root+"/vsock/link", "link", u, g) == nil {
		t.Error("a symlink as the last component was accepted")
	}
	// a symlink in the middle of the path
	if err := os.Symlink(root+"/vsock", root+"/vlink"); err != nil {
		t.Fatal(err)
	}
	// a symlink in a parent component of jail_root itself
	if err := os.Symlink(root, root+"-link"); err != nil {
		t.Fatal(err)
	}
	m.root = root + "-link"
	if vchk(m, root+"-link/vsock/box-a", "box-a", u, g) == nil {
		t.Error("a jail_root reached through a symlink was accepted")
	}
	m.root = root
	// a path that is not below jail_root/vsock
	if vchk(m, root+"/vlink/box-a", "box-a", u, g) == nil {
		t.Error("a path outside jail_root/vsock was accepted")
	}
	// a regular file where the directory should be
	if err := os.WriteFile(root+"/vsock/file", nil, 0o710); err != nil {
		t.Fatal(err)
	}
	if vchk(m, root+"/vsock/file", "file", u, g) == nil {
		t.Error("a regular file was accepted")
	}
}

func TestNewRefusesSymlinkedRootAndBadModes(t *testing.T) {
	root := mkroot(t)
	link := filepath.Join(filepath.Dir(root), "linkroot")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if _, err := newManager(cfgFor(link, 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Error("a jail_root that is a symlink was accepted")
	}
	// a symlink in a parent component of jail_root
	if _, err := newManager(cfgFor(link+"/../jail", 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Error("a non-clean jail_root was accepted")
	}
	nested := filepath.Join(filepath.Dir(root), "viaLink")
	if err := os.Symlink(filepath.Dir(root), nested); err != nil {
		t.Fatal(err)
	}
	if _, err := newManager(cfgFor(nested+"/jail", 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Error("a jail_root below a symlinked parent was accepted")
	}
	// wrong mode on the root
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Error("a 0755 jail_root was accepted")
	}
	if err := os.Chmod(root, 0o711); err != nil {
		t.Fatal(err)
	}
	// jails replaced by a symlink to a directory with the right mode
	elsewhere := filepath.Join(filepath.Dir(root), "elsewhere")
	if err := os.Mkdir(elsewhere, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, root+"/jails"); err != nil {
		t.Fatal(err)
	}
	if _, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Error("a jails directory that is a symlink was accepted")
	}
	_ = os.Remove(root + "/jails")
	// jails exists with the wrong mode
	if err := os.Mkdir(root+"/jails", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root+"/jails", 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Error("a 0755 jails directory was accepted")
	}
	// the wrong owner: the owner the manager expects differs from the real one
	_ = os.Remove(root + "/jails")
	other := func(uint32, uint32) (uint32, uint32) { u, g := me(); return u + 1, g }
	if _, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, other); err == nil {
		t.Error("a root owned by another uid was accepted")
	}
}

func TestRemoveNeverFollowsSymlinks(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	outside := filepath.Join(filepath.Dir(root), "precious")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// a sandbox directory holding a symlink to the outside directory, and a nested real tree
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	jd := root + "/jails/box-a"
	if err := os.Symlink(outside, jd+"/escape"); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(jd+"/d/e", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jd+"/d/e/f", []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	// the sandbox directory itself is swapped for a symlink to the outside directory
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatal(c)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("destroy followed a symlink out of the jail")
	}
	if _, err := os.Lstat(jd); err == nil {
		t.Fatal("jail directory still there")
	}
	// removeAt on a name that is a symlink removes the link, not the target
	if err := os.Symlink(outside, root+"/jails/swapped"); err != nil {
		t.Fatal(err)
	}
	if err := removeAt(m.jailsFd, "swapped"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("removing a symlink removed its target's content")
	}
	if _, err := os.Lstat(root + "/jails/swapped"); err == nil {
		t.Fatal("the symlink is still there")
	}
}

func TestOpenChildRefusesSymlink(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	if err := os.Symlink(root, root+"/jails/sym"); err != nil {
		t.Fatal(err)
	}
	if fd, err := openChild(m.jailsFd, "sym"); err == nil {
		closeFd(fd)
		t.Fatal("openChild followed a symlink")
	}
}

func TestStartDrivesLauncherWithValidatedSpec(t *testing.T) {
	l := &fakeLauncher{}
	m, root := newMgr(t, 3, l)
	if _, c := m.Start("nope"); c != protocol.UnknownSandbox {
		t.Fatal(c)
	}
	m.Prepare(prep("box-a"))
	reply, c := m.Start("box-a")
	if c != protocol.OK || reply.VsockDir != root+"/vsock/box-a" {
		t.Fatal(reply, c)
	}
	if _, c := m.Start("box-a"); c != protocol.OK || len(l.specs) != 1 {
		t.Fatalf("second start launched again: %d launches, %s", len(l.specs), c)
	}
	s := l.specs[0]
	if s.ID != "box-a" || s.Template != "fx-agent" || s.VCPUs != 2 || s.MemMB != 512 || s.JailDir != root+"/jails/box-a" || s.VsockDir != root+"/vsock/box-a" {
		t.Fatalf("spec %+v", s)
	}
}

func TestStartLauncherFailures(t *testing.T) {
	l := &fakeLauncher{err: errors.New("boom")}
	m, _ := newMgr(t, 3, l)
	m.Prepare(prep("box-a"))
	if _, c := m.Start("box-a"); c != protocol.Internal {
		t.Fatal(c)
	}
	l.err = ErrUnavailable
	if _, c := m.Start("box-a"); c != protocol.Unavailable {
		t.Fatal(c)
	}
	l.err = nil
	if _, c := m.Start("box-a"); c != protocol.OK {
		t.Fatalf("a failed launch must leave the sandbox startable: %s", c)
	}
	m2, _ := newMgr(t, 1, NoLauncher{})
	m2.Prepare(prep("box-a"))
	if _, c := m2.Start("box-a"); c != protocol.Unavailable {
		t.Fatal(c)
	}
}

func TestDestroyStopsRemovesAndFrees(t *testing.T) {
	l := &fakeLauncher{}
	m, root := newMgr(t, 3, l)
	if c := m.Destroy("none"); c != protocol.UnknownSandbox {
		t.Fatal(c)
	}
	m.Prepare(prep("box-a"))
	m.Start("box-a")
	if err := os.WriteFile(root+"/vsock/box-a/v.sock_52", nil, 0o660); err != nil {
		t.Fatal(err)
	}
	l.stopErr = errors.New("stuck")
	if c := m.Destroy("box-a"); c != protocol.Internal {
		t.Fatal(c)
	}
	if es, _ := m.List(); len(es) != 1 {
		t.Fatal("a failed stop dropped the entry")
	}
	l.stopErr = nil
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatal(c)
	}
	for _, p := range []string{root + "/vsock/box-a", root + "/jails/box-a"} {
		if _, err := os.Lstat(p); err == nil {
			t.Errorf("%s survived destroy", p)
		}
	}
	if es, _ := m.List(); len(es) != 0 {
		t.Fatal("entry survived destroy")
	}
	if c := m.Destroy("box-a"); c != protocol.UnknownSandbox {
		t.Fatal(c)
	}
}

func TestListEntriesCarryVsockDirAndCreated(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Now = func() time.Time { return time.Unix(1700000000, 0) }
	m.Prepare(prep("b2"))
	m.Prepare(prep("b1"))
	es, c := m.List()
	if c != protocol.OK || len(es) != 2 || es[0].SandboxID != "b1" || es[1].SandboxID != "b2" {
		t.Fatal(es, c)
	}
	for _, e := range es {
		if e.Created != 1700000000 || e.VsockDir != root+"/vsock/"+e.SandboxID {
			t.Errorf("entry %+v", e)
		}
	}
	m.Now = func() time.Time { return time.Time{} }
	m.Prepare(prep("b3"))
	es, _ = m.List()
	if es[2].Created != 0 {
		t.Errorf("an unknown time is reported as %d, want 0 (omitted)", es[2].Created)
	}
}

func TestPrepareRollsBackWhenASecondStepFails(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	// something already sits where the vsock directory would go
	if err := os.Mkdir(root+"/vsock/box-a", 0o700); err != nil {
		t.Fatal(err)
	}
	if _, c := m.Prepare(prep("box-a")); c != protocol.Internal {
		t.Fatal(c)
	}
	if _, err := os.Lstat(root + "/jails/box-a"); err == nil {
		t.Fatal("the jail directory was left behind")
	}
	if es, _ := m.List(); len(es) != 0 {
		t.Fatal("a failed prepare registered a sandbox")
	}
}

func TestReapRemovesOnlyUnownedIDNamedEntries(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Prepare(prep("live-1"))
	outside := filepath.Join(filepath.Dir(root), "precious")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(root+"/vsock/old-1", 0o700))
	must(os.WriteFile(root+"/vsock/old-1/v.sock_52", nil, 0o660))
	must(os.MkdirAll(root+"/jails/old-1/sub", 0o700))
	must(os.Mkdir(root+"/jails/old-2", 0o700))
	must(os.Symlink(outside, root+"/vsock/old-3")) // a valid id as a symlink name
	must(os.WriteFile(outside+"/keep", []byte("x"), 0o600))
	must(os.Mkdir(root+"/vsock/Not Valid", 0o700)) // not an id: left alone
	must(os.WriteFile(root+"/jails/.stray", nil, 0o600))
	res := m.Reap()
	if strings.Join(res.Removed, ",") != "old-1,old-2,old-3" || res.Skipped != 2 || res.Failed != 0 {
		t.Fatalf("%+v", res)
	}
	for _, p := range []string{"/vsock/live-1", "/jails/live-1", "/vsock/Not Valid", "/jails/.stray"} {
		if _, err := os.Lstat(root + p); err != nil {
			t.Errorf("%s was removed: %v", p, err)
		}
	}
	for _, p := range []string{"/vsock/old-1", "/jails/old-1", "/jails/old-2", "/vsock/old-3"} {
		if _, err := os.Lstat(root + p); err == nil {
			t.Errorf("%s survived", p)
		}
	}
	if _, err := os.Stat(outside + "/keep"); err != nil {
		t.Fatal("reaping followed a symlink")
	}
}

func TestConcurrentPrepareGivesDistinctIDs(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newMgr(t, 8, l)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("c%d", i)
			if _, c := m.Prepare(prep(id)); c != protocol.OK {
				t.Error(id, c)
			}
		}(i)
	}
	wg.Wait()
	seen := map[uint32]bool{}
	for _, b := range m.boxes {
		if seen[b.spec.UID] || seen[b.spec.GID] {
			t.Fatal("two sandboxes share an id")
		}
		seen[b.spec.UID] = true
	}
	if len(m.boxes) != 8 {
		t.Fatal(len(m.boxes))
	}
}

func TestPermitsModel(t *testing.T) {
	cases := []struct {
		mode    os.FileMode
		uid     uint32
		gids    []uint32
		want    uint32
		allowed bool
	}{
		{0o710, 1, []uint32{9}, 7, true},  // owner rwx
		{0o710, 2, []uint32{5}, 1, true},  // group x
		{0o710, 2, []uint32{5}, 4, false}, // group has no r
		{0o710, 3, []uint32{6}, 1, false}, // other has nothing
		{0o660, 2, []uint32{5}, 6, true},  // group rw
		{0o660, 3, []uint32{6}, 2, false}, // other
		{0o711, 3, []uint32{6}, 1, true},  // other x
	}
	for i, c := range cases {
		if got := Permits(c.mode, 1, 5, c.uid, c.gids, c.want); got != c.allowed {
			t.Errorf("case %d: got %v", i, got)
		}
	}
}

func TestVsockDirBuiltOnlyFromValidID(t *testing.T) {
	m, root := newMgr(t, 1, &fakeLauncher{})
	if p, err := m.VsockDir("box-a"); err != nil || p != root+"/vsock/box-a" {
		t.Fatal(p, err)
	}
	for _, id := range []string{"", "../x", "-a", "a/b", "A"} {
		if p, err := m.VsockDir(id); err == nil {
			t.Errorf("id %q gave %q", id, p)
		}
	}
}

// vchk is the consumer-side check against m's layout, for a runner uid and sandbox gid the test names.
func vchk(m *Manager, p, id string, uid, gid uint32) error {
	pol := m.policy()
	pol.RunnerUID = uid
	fd, err := OpenVsockDir(pol, p, id, gid)
	if err == nil {
		closeFd(fd)
	}
	return err
}
