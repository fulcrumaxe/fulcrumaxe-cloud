//go:build linux

package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"fx-vmhelper/internal/protocol"
)

// ---- the manifest ---------------------------------------------------------------------------------------------

func TestParseManifestAcceptsTheShape(t *testing.T) {
	d := sum([]byte("a"))
	m, err := ParseManifest([]byte(`{"fx-agent":{"kernel":"` + d + `","rootfs":"` + d + `"},"t2":{"rootfs":"` + d + `","kernel":"` + d + `"}}`))
	if err != nil || len(m) != 2 || m["t2"]["kernel"] != d {
		t.Fatalf("%v %v", m, err)
	}
	if m, err := ParseManifest([]byte(`{}`)); err != nil || len(m) != 0 {
		t.Fatalf("an empty manifest is well formed: %v %v", m, err)
	}
}

func TestParseManifestRefusals(t *testing.T) {
	d := sum([]byte("a"))
	good := `"kernel":"` + d + `","rootfs":"` + d + `"`
	for name, in := range map[string]string{
		"empty file":             ``,
		"not an object":          `[]`,
		"trailing object":        `{"a":{` + good + `}}{}`,
		"trailing garbage":       `{"a":{` + good + `}} x`,
		"duplicate id":           `{"a":{` + good + `},"a":{` + good + `}}`,
		"duplicate kind":         `{"a":{"kernel":"` + d + `","kernel":"` + d + `","rootfs":"` + d + `"}}`,
		"bad id":                 `{"-a":{` + good + `}}`,
		"upper-case id":          `{"A":{` + good + `}}`,
		"unknown kind":           `{"a":{` + good + `,"initrd":"` + d + `"}}`,
		"two kinds, one unknown": `{"a":{"kernel":"` + d + `","initrd":"` + d + `"}}`,
		"missing rootfs":         `{"a":{"kernel":"` + d + `"}}`,
		"missing kernel":         `{"a":{"rootfs":"` + d + `"}}`,
		"empty template":         `{"a":{}}`,
		"short digest":           `{"a":{"kernel":"abc","rootfs":"` + d + `"}}`,
		"upper-case digest":      `{"a":{"kernel":"` + strings.ToUpper(d) + `","rootfs":"` + d + `"}}`,
		"non-hex digest":         `{"a":{"kernel":"` + strings.Repeat("g", 64) + `","rootfs":"` + d + `"}}`,
		"number digest":          `{"a":{"kernel":1,"rootfs":"` + d + `"}}`,
		"string template":        `{"a":"` + d + `"}`,
		"null template":          `{"a":null}`,
		"unterminated":           `{"a":{` + good + `}`,
	} {
		if m, err := ParseManifest([]byte(in)); err == nil {
			t.Errorf("%s: accepted as %v", name, m)
		}
	}
}

func TestLoadManifestChainChecks(t *testing.T) {
	uid := uint32(os.Getuid())
	load := func(f *fixture) error { _, err := LoadManifest(f.base, f.manifest, uid); return err }
	if err := load(newFixture(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest("/", "/proc/self/../etc/x", uid); err == nil {
		t.Error("an unclean path was accepted")
	}
	cases := map[string]func(t *testing.T, f *fixture){
		"file writable by the group": func(t *testing.T, f *fixture) { _ = os.Chmod(f.manifest, 0o664) },
		"file writable by others":    func(t *testing.T, f *fixture) { _ = os.Chmod(f.manifest, 0o646) },
		"base writable by the group": func(t *testing.T, f *fixture) { _ = os.Chmod(f.base, 0o775) },
		"parent directory writable": func(t *testing.T, f *fixture) {
			sub := f.base + "/sub"
			_ = os.Mkdir(sub, 0o775)
			_ = os.Chmod(sub, 0o775)
			mustWrite(t, sub+"/m.json", manifestFor("fx-agent", f.kernel, f.rootfs), 0o644)
			f.manifest = sub + "/m.json"
		},
		"final component a symlink": func(t *testing.T, f *fixture) {
			_ = os.Rename(f.manifest, f.base+"/real.json")
			_ = os.Symlink(f.base+"/real.json", f.manifest)
		},
		"a parent a symlink": func(t *testing.T, f *fixture) {
			_ = os.Mkdir(f.base+"/real", 0o755)
			mustWrite(t, f.base+"/real/m.json", manifestFor("fx-agent", f.kernel, f.rootfs), 0o644)
			_ = os.Symlink(f.base+"/real", f.base+"/link")
			f.manifest = f.base + "/link/m.json"
		},
		"a directory": func(t *testing.T, f *fixture) {
			_ = os.Remove(f.manifest)
			_ = os.Mkdir(f.manifest, 0o755)
		},
		"over 64 KiB": func(t *testing.T, f *fixture) {
			mustWrite(t, f.manifest, []byte(`{}`+strings.Repeat(" ", maxManifest)), 0o644)
		},
		"missing": func(t *testing.T, f *fixture) { _ = os.Remove(f.manifest) },
	}
	for name, mutate := range cases {
		f := newFixture(t)
		mutate(t, f)
		if err := load(f); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	f := newFixture(t)
	if _, err := LoadManifest(f.base, f.manifest, uid+1); err == nil {
		t.Error("a manifest owned by someone other than the expected owner was accepted")
	}
}

func TestPrepareAnswersUnknownTemplateBeforeCreatingAnything(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	r := prep("box-a")
	r.Template = "no-such"
	if _, c := m.Prepare(r); c != protocol.UnknownTemplate {
		t.Fatalf("answered %s", c)
	}
	for _, p := range []string{"/jails/box-a", "/vsock/box-a"} {
		if _, err := os.Lstat(root + p); err == nil {
			t.Errorf("%s was created for an unknown template", p)
		}
	}
	if es, _ := m.List(); len(es) != 0 {
		t.Fatal("registered")
	}
}

func TestPrepareAndStartRefuseAnUnreadableManifest(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	_ = os.Chmod(m.stg.manifest, 0o666) // now writable by others
	if _, c := m.Prepare(prep("box-b")); c != protocol.Internal {
		t.Errorf("prepare answered %s", c)
	}
	if _, c := m.Start("box-a"); c != protocol.Internal {
		t.Errorf("start answered %s", c)
	}
	if _, err := os.Lstat(root + "/jails/box-b"); err == nil {
		t.Error("prepare built a directory")
	}
	if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
		t.Errorf("start staged %v", names)
	}
}

func TestStartRechecksTheManifest(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	f := newFixture(t)
	f.use(m)
	m.Prepare(prep("box-a"))
	mustWrite(t, f.manifest, manifestFor("other", f.kernel, f.rootfs), 0o644) // the template was withdrawn
	if _, c := m.Start("box-a"); c != protocol.UnknownTemplate {
		t.Fatalf("start answered %s", c)
	}
	if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
		t.Errorf("staged %v", names)
	}
}

// ---- copy and hash --------------------------------------------------------------------------------------------

func entries(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

func TestStartCopiesTheTemplateIntoTheJail(t *testing.T) {
	l := &fakeLauncher{}
	m, root := newMgr(t, 3, l)
	f := newFixture(t)
	f.use(m)
	m.Prepare(prep("box-a"))
	mounts := fakeMounts.n
	if _, c := m.Start("box-a"); c != protocol.OK {
		t.Fatal(c)
	}
	rd := root + "/jails/box-a/firecracker/box-a/root"
	for kind, want := range map[string][]byte{"kernel": f.kernel, "rootfs": f.rootfs} {
		got, err := os.ReadFile(rd + "/" + kind)
		if err != nil || string(got) != string(want) {
			t.Errorf("%s: %q %v", kind, got, err)
		}
		if md := mode(t, rd+"/"+kind); md != 0o400 {
			t.Errorf("%s: mode %v, want 0400", kind, md)
		}
	}
	if fakeMounts.n != mounts+1 {
		t.Errorf("%d mounts, want 1", fakeMounts.n-mounts)
	}
	if md := mode(t, rd+"/vsock"); md != os.ModeDir|0o700 {
		t.Errorf("mount point mode %v", md)
	}
	if len(l.specs) != 1 {
		t.Fatal("the launcher did not run after staging")
	}
}

func TestMismatchLeavesNothingBehind(t *testing.T) {
	for _, kind := range templateKinds {
		l := &fakeLauncher{}
		m, root := newMgr(t, 3, l)
		f := newFixture(t)
		f.use(m)
		m.Prepare(prep("box-a"))
		mustWrite(t, f.dir+"/fx-agent/"+kind, []byte("tampered after the manifest was written"), 0o644)
		mounts := fakeMounts.n
		if _, c := m.Start("box-a"); c != protocol.Internal {
			t.Fatalf("%s: start answered %s", kind, c)
		}
		if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
			t.Errorf("%s: left %v in the jail directory", kind, names)
		}
		if fakeMounts.n != mounts || len(l.specs) != 0 {
			t.Errorf("%s: mounted or launched after a mismatch", kind)
		}
		// the sandbox is still registered and a repaired template starts it
		mustWrite(t, f.dir+"/fx-agent/"+kind, map[string][]byte{"kernel": f.kernel, "rootfs": f.rootfs}[kind], 0o644)
		if _, c := m.Start("box-a"); c != protocol.OK {
			t.Errorf("%s: retry answered %s", kind, c)
		}
	}
}

func TestOversizeTemplateIsRefused(t *testing.T) {
	old := maxTemplateFile
	maxTemplateFile = 8
	defer func() { maxTemplateFile = old }()
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Prepare(prep("box-a"))
	if _, c := m.Start("box-a"); c != protocol.Internal {
		t.Fatal(c)
	}
	if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
		t.Errorf("left %v", names)
	}
}

func TestTemplateSourceChainIsChecked(t *testing.T) {
	cases := map[string]func(t *testing.T, f *fixture){
		"file a symlink": func(t *testing.T, f *fixture) {
			_ = os.Rename(f.dir+"/fx-agent/rootfs", f.base+"/elsewhere")
			_ = os.Symlink(f.base+"/elsewhere", f.dir+"/fx-agent/rootfs")
		},
		"directory a symlink": func(t *testing.T, f *fixture) {
			_ = os.Rename(f.dir+"/fx-agent", f.base+"/elsewhere")
			_ = os.Symlink(f.base+"/elsewhere", f.dir+"/fx-agent")
		},
		"file writable by others":     func(t *testing.T, f *fixture) { _ = os.Chmod(f.dir+"/fx-agent/kernel", 0o646) },
		"template dir group-writable": func(t *testing.T, f *fixture) { _ = os.Chmod(f.dir+"/fx-agent", 0o775) },
		"template root dir writable":  func(t *testing.T, f *fixture) { _ = os.Chmod(f.dir, 0o777) },
		"file replaced by a directory": func(t *testing.T, f *fixture) {
			_ = os.Remove(f.dir + "/fx-agent/kernel")
			_ = os.Mkdir(f.dir+"/fx-agent/kernel", 0o755)
		},
		"file missing": func(t *testing.T, f *fixture) { _ = os.Remove(f.dir + "/fx-agent/rootfs") },
	}
	for name, mutate := range cases {
		m, root := newMgr(t, 3, &fakeLauncher{})
		f := newFixture(t)
		f.use(m)
		m.Prepare(prep("box-a"))
		mutate(t, f)
		if _, c := m.Start("box-a"); c != protocol.Internal {
			t.Errorf("%s: start answered %s", name, c)
		}
		if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
			t.Errorf("%s: left %v", name, names)
		}
	}
}

func TestLaunchFailureUnstages(t *testing.T) {
	l := &fakeLauncher{err: ErrUnavailable}
	m, root := newMgr(t, 3, l)
	m.Prepare(prep("box-a"))
	if _, c := m.Start("box-a"); c != protocol.Unavailable {
		t.Fatal(c)
	}
	if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
		t.Errorf("left %v after a failed launch", names)
	}
}

// ---- unmount on destroy and on reap ------------------------------------------------------------------------------

// countUmounts replaces the unmount with one that records which directory it was asked about.
func countUmounts(t *testing.T, ret func() error) *[]string {
	t.Helper()
	var seen []string
	old := umountAt
	umountAt = func(fd int, name string) error {
		p, _ := os.Readlink(procFdPath(fd))
		seen = append(seen, p+"/"+name)
		return ret()
	}
	t.Cleanup(func() { umountAt = old })
	return &seen
}

func TestDestroyUnmountsBeforeRemovingAndKeepsEverythingWhenItCannot(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Prepare(prep("box-a"))
	m.Start("box-a")
	busy := true
	seen := countUmounts(t, func() error {
		if busy {
			return syscall.EBUSY
		}
		return syscall.EINVAL
	})
	if c := m.Destroy("box-a"); c != protocol.Internal {
		t.Fatalf("destroy with a busy mount answered %s", c)
	}
	for _, p := range []string{"/jails/box-a/firecracker/box-a/root/rootfs", "/vsock/box-a"} {
		if _, err := os.Lstat(root + p); err != nil {
			t.Errorf("%s was removed while the unmount failed", p)
		}
	}
	if es, _ := m.List(); len(es) != 1 {
		t.Fatal("the sandbox left the registry")
	}
	busy = false
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatalf("retry answered %s", c)
	}
	if len(*seen) != 2 || !strings.HasSuffix((*seen)[0], "/jails/box-a/firecracker/box-a/root/vsock") {
		t.Errorf("unmounted %v", *seen)
	}
	for _, p := range []string{"/jails/box-a", "/vsock/box-a"} {
		if _, err := os.Lstat(root + p); err == nil {
			t.Errorf("%s survived", p)
		}
	}
}

func TestReapUnmountsStaleMountsFirstAndSkipsWhenItCannot(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	for _, id := range []string{"old-1", "old-2"} {
		if err := os.MkdirAll(root+"/jails/"+id+"/firecracker/"+id+"/root/vsock", 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(root+"/vsock/"+id, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	seen := countUmounts(t, func() error { return syscall.EBUSY })
	res := m.Reap()
	if res.Failed != 2 || len(res.Removed) != 0 || len(*seen) != 2 {
		t.Fatalf("%+v unmounts %v", res, *seen)
	}
	if _, err := os.Lstat(root + "/jails/old-1/firecracker/old-1/root/vsock"); err != nil {
		t.Error("a stale jail was removed while its mount could not be removed")
	}
	umountAt = func(int, string) error { return syscall.EINVAL }
	res = m.Reap()
	if res.Failed != 0 || len(res.Removed) != 2 {
		t.Fatalf("%+v", res)
	}
}

func TestUnmountRefusesASymlinkedMountPoint(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Prepare(prep("box-a"))
	outside := filepath.Join(filepath.Dir(root), "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside+"/keep", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	rd := root + "/jails/box-a/firecracker/box-a/root"
	if err := os.MkdirAll(rd, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, rd+"/vsock"); err != nil {
		t.Fatal(err)
	}
	seen := countUmounts(t, func() error { return nil })
	if err := m.unmountVsock("box-a"); err == nil || len(*seen) != 0 {
		t.Fatalf("unmount went through a symlink: %v %v", err, *seen)
	}
	if c := m.Destroy("box-a"); c != protocol.Internal {
		t.Errorf("destroy answered %s", c)
	}
	if _, err := os.Stat(outside + "/keep"); err != nil {
		t.Error("the tree behind the symlink was touched")
	}
}

// ---- the per-id reservation ----------------------------------------------------------------------------------------

// gateLauncher blocks the launch of one id until released and counts launches.
type gateLauncher struct {
	mu      sync.Mutex
	gateID  string
	entered chan struct{}
	release chan struct{}
	launch  map[string]int
	stopped map[string]int
}

func newGate(id string) *gateLauncher {
	return &gateLauncher{gateID: id, entered: make(chan struct{}, 4), release: make(chan struct{}), launch: map[string]int{}, stopped: map[string]int{}}
}

type gateInst struct {
	g  *gateLauncher
	id string
}

func (i gateInst) Stop() error { i.g.mu.Lock(); i.g.stopped[i.id]++; i.g.mu.Unlock(); return nil }

func (g *gateLauncher) Launch(s Spec) (Instance, error) {
	g.mu.Lock()
	g.launch[s.ID]++
	g.mu.Unlock()
	if s.ID == g.gateID {
		g.entered <- struct{}{}
		<-g.release
	}
	return gateInst{g, s.ID}, nil
}

func within(t *testing.T, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { f(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not finish while a launch was in progress", what)
	}
}

// goAndWait runs f in a goroutine that the test cleanup waits for, so none outlives the test.
func goAndWait(t *testing.T, f func()) chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); f() }()
	t.Cleanup(func() {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("a goroutine of the test is still running")
		}
	})
	return done
}

func TestListAndOtherIDsNeverWaitOnALaunch(t *testing.T) {
	g := newGate("slow-1")
	m, _ := newMgr(t, 4, g)
	m.Prepare(prep("slow-1"))
	m.Prepare(prep("fast-1"))
	t.Cleanup(func() { // never leave the launch blocked, whatever failed
		select {
		case <-g.release:
		default:
			close(g.release)
		}
	})
	first := goAndWait(t, func() {
		if _, c := m.Start("slow-1"); c != protocol.OK {
			t.Errorf("start answered %s", c)
		}
	})
	<-g.entered
	within(t, "List", func() {
		if es, c := m.List(); c != protocol.OK || len(es) != 2 {
			t.Errorf("list %v %s", es, c)
		}
	})
	within(t, "Prepare of another id", func() {
		if _, c := m.Prepare(prep("new-1")); c != protocol.OK {
			t.Errorf("prepare answered %s", c)
		}
	})
	within(t, "Start of another id", func() {
		if _, c := m.Start("fast-1"); c != protocol.OK {
			t.Errorf("start of another id answered %s", c)
		}
	})
	// a second start and a destroy of the same id wait for the reservation, then see its result
	second := goAndWait(t, func() {
		// the queued destroy may win the reservation: then the id is gone, which is as good an answer
		if r, c := m.Start("slow-1"); c == protocol.OK && r.VsockDir == "" || c != protocol.OK && c != protocol.UnknownSandbox {
			t.Errorf("second start answered %+v %s", r, c)
		}
	})
	destroyed := goAndWait(t, func() {
		time.Sleep(20 * time.Millisecond)
		if c := m.Destroy("slow-1"); c != protocol.OK {
			t.Errorf("destroy answered %s", c)
		}
	})
	time.Sleep(100 * time.Millisecond)
	select {
	case <-second:
		t.Fatal("a second start of the same id did not wait for the first")
	case <-destroyed:
		t.Fatal("destroy of the same id did not wait for the launch")
	default:
	}
	close(g.release)
	for _, c := range []chan struct{}{first, second, destroyed} {
		select {
		case <-c:
		case <-time.After(5 * time.Second):
			t.Fatal("an operation never finished after the launch was released")
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.launch["slow-1"] != 1 || g.stopped["slow-1"] != 1 {
		t.Errorf("launches %v stops %v: the same id must launch once and be stopped once", g.launch, g.stopped)
	}
	if es, _ := m.List(); len(es) != 2 {
		t.Errorf("registry after destroy: %v", es)
	}
}

func TestHammerManyIDsUnderRace(t *testing.T) {
	m, _ := newMgr(t, 16, newGate(""))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		id := "h-" + string(rune('a'+i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, c := m.Prepare(prep(id)); c != protocol.OK {
				t.Errorf("prepare %s: %s", id, c)
				return
			}
			var inner sync.WaitGroup
			for j := 0; j < 3; j++ {
				inner.Add(1)
				go func() { defer inner.Done(); m.Start(id); _, _ = m.List() }()
			}
			inner.Wait()
			if c := m.Destroy(id); c != protocol.OK {
				t.Errorf("destroy %s: %s", id, c)
			}
		}()
	}
	wg.Wait()
	if es, _ := m.List(); len(es) != 0 {
		t.Errorf("left %v", es)
	}
}
