//go:build linux

package sandbox

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"fx-vmhelper/internal/protocol"
)

// snapLauncher is a launcher whose instances can snapshot themselves: Snapshot writes the two files Firecracker
// would write into the sandbox's jail root, and a resuming Launch records what the jail root held when it was called.
type snapLauncher struct {
	fakeLauncher
	mem, state []byte                 // what a snapshot writes
	snapErr    error                  // what Snapshot answers
	tamper     func(root string)      // runs after the files are written, as a hostile VMM would
	saw        map[string][]byte      // the snapshot files in the jail root when a resume launched
	sawMode    map[string]os.FileMode // and their modes
	onLaunch   func(s Spec) error     // an error to answer a launch with, after the files were seen
}

type snapInst struct {
	l *snapLauncher
	s Spec
}

func (i snapInst) Stop() error { return fakeInst{&i.l.fakeLauncher}.Stop() }

func (i snapInst) Snapshot() error {
	root := jailRootOf(i.s)
	if i.l.snapErr != nil {
		return i.l.snapErr
	}
	for n, b := range map[string][]byte{"snap.mem": i.l.mem, "snap.state": i.l.state} {
		if err := os.WriteFile(filepath.Join(root, n), b, 0o644); err != nil {
			return err
		}
	}
	if i.l.tamper != nil {
		i.l.tamper(root)
	}
	return nil
}

func jailRootOf(s Spec) string { return s.JailDir + "/firecracker/" + s.ID + "/root" }

func (l *snapLauncher) Launch(s Spec) (Instance, error) {
	if s.Resume {
		l.saw, l.sawMode = map[string][]byte{}, map[string]os.FileMode{}
		for _, n := range []string{"snap.mem", "snap.state"} {
			p := filepath.Join(jailRootOf(s), n)
			if b, err := os.ReadFile(p); err == nil {
				l.saw[n] = b
				fi, _ := os.Lstat(p)
				l.sawMode[n] = fi.Mode().Perm()
			}
		}
		if l.onLaunch != nil {
			if err := l.onLaunch(s); err != nil {
				return nil, err
			}
		}
	}
	in, err := l.fakeLauncher.Launch(s)
	if err != nil {
		return nil, err
	}
	_ = in
	return snapInst{l, s}, nil
}

// newSnapMgr is a manager with a snapshot directory (root-owned, as the test user, 0700), a started sandbox box-a, and
// the snapshot directory's path.
func newSnapMgr(t *testing.T) (*Manager, *snapLauncher, string, *fixture) {
	t.Helper()
	l := &snapLauncher{mem: bytes.Repeat([]byte("MEM!"), 1<<18), state: []byte("device-state")}
	root := mkroot(t)
	cfg := cfgFor(root, 3)
	cfg.SnapshotDir = filepath.Join(t.TempDir(), "snaps")
	if err := os.Mkdir(cfg.SnapshotDir, 0o700); err != nil {
		t.Fatal(err)
	}
	m, err := newManager(cfg, l, 0, toMe)
	if err != nil {
		t.Fatal(err)
	}
	f := newFixture(t)
	f.use(m)
	t.Cleanup(m.Close)
	return m, l, cfg.SnapshotDir, f
}

func started(t *testing.T, m *Manager, id string) {
	t.Helper()
	if _, c := m.Prepare(snapPrep(id)); c != protocol.OK {
		t.Fatal("prepare", c)
	}
	if _, c := m.Start(id); c != protocol.OK {
		t.Fatal("start", c)
	}
}

func TestSnapshotThenResumeRoundTrip(t *testing.T) {
	m, l, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	rep, c := m.Snapshot("box-a", "snap-1")
	if c != protocol.OK || rep.SnapshotBytes != int64(len(l.mem)+len(l.state)) {
		t.Fatalf("snapshot: %v %v", rep, c)
	}
	if l.stopped != 1 {
		t.Errorf("the VM was stopped %d times, want 1", l.stopped)
	}
	// stored as 0700 directory of 0600 files, bytes intact
	if got := mode(t, dir+"/snap-1"); got != os.ModeDir|0o700 {
		t.Errorf("snapshot directory mode %v", got)
	}
	for n, want := range map[string][]byte{"mem": l.mem, "state": l.state} {
		got, err := os.ReadFile(dir + "/snap-1/" + n)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s not stored intact: %v", n, err)
		}
		if got := mode(t, dir+"/snap-1/"+n); got != 0o600 {
			t.Errorf("%s mode %v", n, got)
		}
	}
	meta, _ := os.ReadFile(dir + "/snap-1/meta.json")
	for _, want := range []string{`"template":"fx-agent"`, `"kernel":"` + sum([]byte("kernel-bytes")) + `"`, `"rootfs":"` + sum([]byte("rootfs-bytes-0123456789")) + `"`, `"vcpus":2`, `"mem_mb":1`, `"v":2`, `"fc":12`} {
		if !strings.Contains(string(meta), want) {
			t.Errorf("meta lacks %s: %s", want, meta)
		}
	}
	// the sandbox is prepared again, with nothing left staged
	if ents, _ := os.ReadDir(m.jailDir("box-a")); len(ents) != 0 {
		t.Errorf("the jail still holds %v", ents)
	}
	if es, _ := m.List(); len(es) != 1 {
		t.Fatalf("list: %v", es)
	}
	if _, c := m.Snapshot("box-a", "snap-2"); c != protocol.UnknownSandbox {
		t.Errorf("snapshot of a stopped sandbox: %s", c)
	}
	// resume: the snapshot files were in the jail root, 0400, when the launch ran; they are gone after it
	rep, c = m.Resume("box-a", "snap-1")
	if c != protocol.OK || rep.VsockDir != m.root+"/vsock/box-a" {
		t.Fatalf("resume: %v %v", rep, c)
	}
	if !bytes.Equal(l.saw["snap.mem"], l.mem) || !bytes.Equal(l.saw["snap.state"], l.state) {
		t.Errorf("the launch did not find the snapshot in the jail root: %v", l.saw)
	}
	if l.sawMode["snap.mem"] != 0o400 || l.sawMode["snap.state"] != 0o400 {
		t.Errorf("modes in the jail: %v", l.sawMode)
	}
	for _, n := range []string{"snap.mem", "snap.state"} {
		if _, err := os.Lstat(jailRootOf(l.specs[len(l.specs)-1]) + "/" + n); !errors.Is(err, syscall.ENOENT) {
			t.Errorf("%s was left in the jail after the load: %v", n, err)
		}
	}
	if !l.specs[len(l.specs)-1].Resume {
		t.Error("the launch was not a resume")
	}
	if _, c := m.Resume("box-a", "snap-1"); c != protocol.BadID {
		t.Errorf("resume of a running sandbox: %s", c)
	}
	// the snapshot is kept, and a running resumed sandbox can be snapshotted again
	if _, err := os.Stat(dir + "/snap-1/mem"); err != nil {
		t.Error("resume removed the snapshot")
	}
	if _, c := m.Snapshot("box-a", "snap-2"); c != protocol.OK {
		t.Errorf("second snapshot: %s", c)
	}
}

func TestStoredSnapshotIsUnreadableToRunnerAndSandbox(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	if _, c := m.Snapshot("box-a", "snap-1"); c != protocol.OK {
		t.Fatal(c)
	}
	// ownership is the (remapped) root's; with the real ids a stranger, the runner and a sandbox uid get the "other" class
	for _, p := range []string{dir, dir + "/snap-1", dir + "/snap-1/mem", dir + "/snap-1/state", dir + "/snap-1/meta.json"} {
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		st := fi.Sys().(*syscall.Stat_t)
		for _, who := range []struct {
			name string
			uid  uint32
			gids []uint32
		}{{"runner", 54321, []uint32{54321}}, {"sandbox", 100000, []uint32{100000}}} {
			if Permits(fi.Mode(), st.Uid, st.Gid, who.uid, who.gids, 4) || Permits(fi.Mode(), st.Uid, st.Gid, who.uid, who.gids, 1) {
				t.Errorf("%s can read or search %s (mode %v)", who.name, p, fi.Mode())
			}
		}
	}
}

func TestSnapshotRefusals(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t)
	m.Prepare(snapPrep("box-a"))
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.UnknownSandbox {
		t.Errorf("not started: %s", c)
	}
	if _, c := m.Snapshot("nope", "s1"); c != protocol.UnknownSandbox {
		t.Errorf("unknown: %s", c)
	}
	m.Start("box-a")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatal(c)
	}
	m.Start("box-a")
	before, _ := os.ReadFile(dir + "/s1/mem")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.BadID {
		t.Errorf("reusing a snapshot id: %s", c)
	}
	if after, _ := os.ReadFile(dir + "/s1/mem"); !bytes.Equal(before, after) {
		t.Error("a refused snapshot changed the stored one")
	}
	if _, c := m.Snapshot("box-a", "../x"); c != protocol.BadID {
		t.Errorf("bad id: %s", c)
	}
}

func TestFailedSnapshotLeavesNothingAndStopsTheVM(t *testing.T) {
	m, l, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	l.snapErr = errors.New("pause refused")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.Internal {
		t.Fatal(c)
	}
	if l.stopped != 1 {
		t.Errorf("stopped %d times: a failed snapshot must not leave a paused VM", l.stopped)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Errorf("the snapshot directory holds %v", ents)
	}
	if ents, _ := os.ReadDir(m.jailDir("box-a")); len(ents) != 0 {
		t.Errorf("the jail holds %v", ents)
	}
	l.snapErr = nil
	if _, c := m.Start("box-a"); c != protocol.OK {
		t.Errorf("the sandbox cannot start again: %s", c)
	}
}

func TestSnapshotFilesAreChecked(t *testing.T) {
	canary := filepath.Join(t.TempDir(), "canary")
	if err := os.WriteFile(canary, []byte("TOP-SECRET"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, tamper := range map[string]func(root string){
		"symlink":   func(root string) { _ = os.Remove(root + "/snap.mem"); _ = os.Symlink(canary, root+"/snap.mem") },
		"hard link": func(root string) { _ = os.Remove(root + "/snap.mem"); _ = os.Link(canary, root+"/snap.mem") },
		// opening a FIFO for reading would block the helper for good: only the type check stops that
		"fifo":      func(root string) { _ = os.Remove(root + "/snap.mem"); _ = syscall.Mkfifo(root+"/snap.mem", 0o600) },
		"directory": func(root string) { _ = os.Remove(root + "/snap.state"); _ = os.Mkdir(root+"/snap.state", 0o700) },
	} {
		t.Run(name, func(t *testing.T) {
			m, l, dir, _ := newSnapMgr(t)
			started(t, m, "box-a")
			l.tamper = tamper
			if _, c := m.Snapshot("box-a", "s1"); c != protocol.Internal {
				t.Fatalf("code %s", c)
			}
			if ents, _ := os.ReadDir(dir); len(ents) != 0 {
				t.Errorf("a refused snapshot left %v", ents)
			}
			if b, _ := os.ReadFile(canary); string(b) != "TOP-SECRET" {
				t.Error("the file behind the link was changed")
			}
			if fi, _ := os.Lstat(canary); fi.Mode().Perm() != 0o644 {
				t.Errorf("the file behind the link was given another mode: %v", fi.Mode())
			}
		})
	}
}

func TestResumeRefusesAChangedDisk(t *testing.T) {
	m, l, dir, f := newSnapMgr(t)
	started(t, m, "box-a")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatal(c)
	}
	launches := len(l.specs)
	// the manifest names other files than the snapshot was taken with
	newRoot := []byte("rootfs-bytes-CHANGED!!")
	mustWrite(t, f.dir+"/fx-agent/rootfs", newRoot, 0o644)
	mustWrite(t, f.manifest, manifestFor("fx-agent", f.kernel, newRoot), 0o644)
	if _, c := m.Resume("box-a", "s1"); c != protocol.SnapshotMismatch {
		t.Errorf("manifest changed: %s", c)
	}
	// a manifest that no longer lists the template, or cannot be read
	mustWrite(t, f.manifest, manifestFor("other-tpl", f.kernel, f.rootfs), 0o644)
	if _, c := m.Resume("box-a", "s1"); c != protocol.UnknownTemplate {
		t.Errorf("template dropped from the manifest: %s", c)
	}
	mustWrite(t, f.manifest, []byte("not json"), 0o644)
	if _, c := m.Resume("box-a", "s1"); c != protocol.Internal {
		t.Errorf("unreadable manifest: %s", c)
	}
	// the manifest is back, but the template file on disk is not the one it names
	mustWrite(t, f.manifest, manifestFor("fx-agent", f.kernel, f.rootfs), 0o644)
	if _, c := m.Resume("box-a", "s1"); c != protocol.SnapshotMismatch {
		t.Errorf("template file changed: %s", c)
	}
	if len(l.specs) != launches {
		t.Error("a refused resume launched a VM")
	}
	if ents, _ := os.ReadDir(m.jailDir("box-a")); len(ents) != 0 {
		t.Errorf("a refused resume left %v staged", ents)
	}
	// once the disk is the same again, it resumes
	mustWrite(t, f.dir+"/fx-agent/rootfs", f.rootfs, 0o644)
	if _, c := m.Resume("box-a", "s1"); c != protocol.OK {
		t.Errorf("same disk: %s", c)
	}
	_ = dir
}

func TestResumeRefusesOtherSizeOrTemplate(t *testing.T) {
	m, l, _, _ := newSnapMgr(t)
	started(t, m, "box-a")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatal(c)
	}
	r := snapPrep("box-b")
	r.MemMB = 1024 // not the memory the snapshot was taken with
	m.Prepare(r)
	r = snapPrep("box-c")
	r.VCPUs = 1
	m.Prepare(r)
	for _, id := range []string{"box-b", "box-c"} {
		if _, c := m.Resume(id, "s1"); c != protocol.SnapshotMismatch {
			t.Errorf("%s: %s", id, c)
		}
	}
	if len(l.specs) != 1 {
		t.Error("a mismatched resume launched a VM")
	}
}

func TestResumeRefusesMetadataOfAnotherTemplateOrDigest(t *testing.T) {
	for name, edit := range map[string]func(string) string{
		"template": func(s string) string { return strings.Replace(s, `"template":"fx-agent"`, `"template":"other"`, 1) },
		// snapshots written under Firecracker 1.16 (format 11, and a version 1 meta.json without the field) cannot be loaded by 1.17 or later
		"format 11": func(s string) string { return strings.Replace(s, `"fc":12`, `"fc":11`, 1) },
		"version 1 meta": func(s string) string {
			return strings.Replace(s, `"v":2,"fc":12,`, `"v":1,`, 1)
		},
		"kernel": func(s string) string {
			return strings.Replace(s, sum([]byte("kernel-bytes")), sum([]byte("another")), 1)
		},
	} {
		m, l, dir, _ := newSnapMgr(t)
		started(t, m, "box-a")
		if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
			t.Fatal(c)
		}
		b, _ := os.ReadFile(dir + "/s1/meta.json")
		if err := os.WriteFile(dir+"/s1/meta.json", []byte(edit(string(b))), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, c := m.Resume("box-a", "s1"); c != protocol.SnapshotMismatch {
			t.Errorf("%s: %s", name, c)
		}
		if len(l.specs) != 1 {
			t.Errorf("%s: launched", name)
		}
	}
}

func TestResumeUnknownTamperedAndLaunchFailures(t *testing.T) {
	m, l, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatal(c)
	}
	if _, c := m.Resume("box-a", "nope"); c != protocol.UnknownSnapshot {
		t.Errorf("unknown snapshot: %s", c)
	}
	if _, c := m.Resume("nobody", "s1"); c != protocol.UnknownSandbox {
		t.Errorf("unknown sandbox: %s", c)
	}
	launches := len(l.specs)
	// a stored file that was cut short, or opened up, or whose metadata is a link, is refused before anything runs
	for name, damage := range map[string]func(){
		"truncated": func() { _ = os.Truncate(dir+"/s1/mem", 10) },
		"opened up": func() { _ = os.Chmod(dir+"/s1/state", 0o644) },
		"meta link": func() { _ = os.Remove(dir + "/s1/meta.json"); _ = os.Symlink("/etc/hostname", dir+"/s1/meta.json") },
	} {
		m2, l2, dir2, _ := newSnapMgr(t)
		started(t, m2, "box-a")
		m2.Snapshot("box-a", "s1")
		dir = dir2
		damage()
		if _, c := m2.Resume("box-a", "s1"); c != protocol.Internal {
			t.Errorf("%s: %s", name, c)
		}
		if len(l2.specs) != 1 {
			t.Errorf("%s: a damaged snapshot was launched", name)
		}
		if ents, _ := os.ReadDir(m2.jailDir("box-a")); len(ents) != 0 {
			t.Errorf("%s: left %v staged", name, ents)
		}
	}
	// a failed launch leaves the sandbox resumable, and nothing staged
	l.onLaunch = func(Spec) error { return errors.New("boom") }
	if _, c := m.Resume("box-a", "s1"); c != protocol.Internal {
		t.Errorf("launch failure: %s", c)
	}
	l.onLaunch = nil
	if ents, _ := os.ReadDir(m.jailDir("box-a")); len(ents) != 0 {
		t.Errorf("a failed launch left %v", ents)
	}
	if _, c := m.Resume("box-a", "s1"); c != protocol.OK {
		t.Errorf("resume after a failed launch: %s", c)
	}
	_ = launches
}

func TestSnapshotDeleteEvicts(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatal(c)
	}
	if c := m.SnapshotDelete("s1"); c != protocol.OK {
		t.Fatal(c)
	}
	if _, err := os.Stat(dir + "/s1"); !errors.Is(err, syscall.ENOENT) {
		t.Errorf("snapshot still there: %v", err)
	}
	if c := m.SnapshotDelete("s1"); c != protocol.UnknownSnapshot {
		t.Errorf("second delete: %s", c)
	}
	if _, c := m.Resume("box-a", "s1"); c != protocol.UnknownSnapshot {
		t.Errorf("resume of an evicted snapshot: %s", c)
	}
	if c := m.SnapshotDelete("../s1"); c != protocol.BadID {
		t.Errorf("path-like id: %s", c)
	}
}

func TestSnapshotsAreOffWithoutADirectory(t *testing.T) {
	m, _ := newMgr(t, 2, &snapLauncher{})
	m.Prepare(snapPrep("box-a"))
	m.Start("box-a")
	if _, c := m.Snapshot("box-a", "s"); c != protocol.Unavailable {
		t.Error(c)
	}
	if _, c := m.Resume("box-a", "s"); c != protocol.Unavailable {
		t.Error(c)
	}
	if c := m.SnapshotDelete("s"); c != protocol.Unavailable {
		t.Error(c)
	}
}

func TestSnapshotDirectoryIsChecked(t *testing.T) {
	root := mkroot(t)
	base := t.TempDir()
	for name, mk := range map[string]func() string{
		"missing": func() string { return base + "/missing" },
		"open mode": func() string {
			_ = os.Mkdir(base+"/open", 0o755)
			_ = os.Chmod(base+"/open", 0o755)
			return base + "/open"
		},
		"symlink": func() string {
			_ = os.Mkdir(base+"/real", 0o700)
			_ = os.Symlink(base+"/real", base+"/link")
			return base + "/link"
		},
	} {
		cfg := cfgFor(root, 2)
		cfg.SnapshotDir = mk()
		if _, err := newManager(cfg, &fakeLauncher{}, 0, toMe); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// Correction 9: the only helper operations that may raise a capability are the API-socket dial and the v.sock
// handover. Snapshot and resume reach the API socket through the dial and use no capability of their own.
func TestSnapshotCodeRaisesNoCapability(t *testing.T) {
	for _, f := range []string{"snapshot.go", "snapshot_vm.go"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "WithCaps") || strings.Contains(string(b), "AmbientCaps") {
			t.Errorf("%s raises a capability", f)
		}
	}
}

// snapPrep is prep with the smallest memory (1 MiB), so a snapshot's memory file is a real, small file of exactly that size.
func snapPrep(id string) protocol.Request {
	r := prep(id)
	r.MemMB = 1
	return r
}
