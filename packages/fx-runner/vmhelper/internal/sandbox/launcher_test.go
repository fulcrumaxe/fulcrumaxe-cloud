//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"fx-vmhelper/internal/protocol"
)

// These tests run a fake jailer (a shell script) that records its argv and environment and makes a cgroup
// directory the way the real one does: <parent>/<id> with cgroup.procs, cgroup.kill and the files it was
// given with --cgroup. It stays alive until cgroup.kill holds "1", like a VMM under the kernel's kill.
// Not faked faithfully (the real-root test covers it): the kernel's cgroupfs (rmdir of a directory that
// holds pseudo-files, the kill itself), the real jailer's chroot and mknod, and a real uid drop.

func init() { reapUID, reapGID = me() } // reaping hands directories to root; a non-root test hands them to itself

const fakeJailer = `#!/bin/sh
/usr/bin/env > %[1]s/env.txt
PATH=%[2]s
: > %[1]s/argv.txt
for a in "$@"; do printf '%%s\n' "$a" >> %[1]s/argv.txt; done
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id=$2; shift;;
    --parent-cgroup) parent=$2; shift;;
    --cgroup) printf '%%s' "${2#*=}" > %[1]s/cg-${2%%%%=*}; shift;;
  esac
  shift
done
cg=%[3]s/$parent/$id
mkdir -p "$cg"
: > "$cg/cgroup.kill"
echo $$ > "$cg/cgroup.procs"
for f in %[1]s/cg-*; do n=${f##*/cg-}; cp "$f" "$cg/$n"; done
touch %[1]s/ready
parent=$PPID
# also ends when the test process is gone (killed by a timeout, so t.Cleanup never ran): an orphan holds the shared test lock
while [ -e "$cg/cgroup.kill" ] && [ "$(cat "$cg/cgroup.kill")" != 1 ] && kill -0 "$parent" 2>/dev/null; do sleep 0.02; done
mkdir -p %[1]s/trash
mv "$cg" "%[1]s/trash/$id.$$" 2>/dev/null
rm -rf "%[1]s/trash/$id.$$"
`

// fakePIDs lists the processes whose command line names this test's directory (the fake jailer, which
// runs as `/bin/sh <dir>/bin/jailer ...`, and anything it started).
func fakePIDs(dir string) []int {
	var pids []int
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		if b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline"); err == nil && strings.Contains(string(b), dir+"/bin/") {
			pids = append(pids, pid)
		}
	}
	return pids
}

// reapFakes kills what is left of the fake jailer, each process and its whole group, waits until none is
// left, and fails the test if any was still alive: a leaked jailer once held the shared test lock for
// 27 minutes through the descriptor it inherited.
func reapFakes(t *testing.T, dir string) {
	t.Helper()
	left := fakePIDs(dir)
	for _, pid := range left {
		_ = syscall.Kill(-pid, syscall.SIGKILL) // the launcher starts it with Setsid: its group is its pid
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	for deadline := time.Now().Add(3 * time.Second); len(fakePIDs(dir)) > 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Errorf("fake jailer processes survive a SIGKILL: %v", fakePIDs(dir))
			return
		}
	}
	if len(left) > 0 {
		t.Errorf("the test leaked fake jailer processes %v (killed now)", left)
	}
}

type rig struct {
	dir, cgroupRoot string
	l               *JailerLauncher
	spec            Spec
	fc              *fakeFC
}

const noCaps = "CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n"

func goodStatus(uid, gid uint32, groups string) func(int) (string, error) {
	return func(int) (string, error) {
		return fmt.Sprintf("Name:\tfirecracker\nUid:\t%[1]d\t%[1]d\t%[1]d\t%[1]d\nGid:\t%[2]d\t%[2]d\t%[2]d\t%[2]d\nGroups:\t%[3]s\n%[4]s", uid, gid, groups, noCaps), nil
	}
}

func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	for _, d := range []string{"bin", "cg/fx/vms", "jail/jails/sb-1"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(dir, "jail/jails/sb-1"), 0o700); err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf(fakeJailer, dir, os.Getenv("PATH"), filepath.Join(dir, "cg"))
	if err := os.WriteFile(filepath.Join(dir, "bin/jailer"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bin/firecracker"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	u, g := me()
	r0 := &rig{dir: dir}
	l := &JailerLauncher{Jailer: filepath.Join(dir, "bin/jailer"), Firecracker: filepath.Join(dir, "bin/firecracker"),
		CgroupRoot: filepath.Join(dir, "cg"), CgroupParent: "fx/vms", OwnerUID: u, OwnerGID: g, Remap: toMe,
		chainBase: dir}
	l.Status = r0.ready(goodStatus(u, g, ""))
	fc := newFakeFC(t, dir)
	l.Dial, l.Handover = fc.dial, fc.handover
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	t.Cleanup(func() { reapFakes(t, dir) }) // runs first: no fake jailer or child may outlive the test
	go func() {                             // the kernel: a cgroup whose cgroup.kill was written is emptied and goes away
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			ents, _ := os.ReadDir(filepath.Join(dir, "cg/fx/vms"))
			for _, e := range ents {
				p := filepath.Join(dir, "cg/fx/vms", e.Name())
				if b, _ := os.ReadFile(filepath.Join(p, "cgroup.kill")); string(b) == "1" {
					// rmdir is atomic: the cgroup is gone from its path before any of its files is. Deleting it
					// in place would let cgroup.procs vanish while the directory still stands, which the kernel
					// never does.
					away := filepath.Join(dir, "trash", e.Name()+".k")
					if os.MkdirAll(filepath.Dir(away), 0o755) == nil && os.Rename(p, away) == nil {
						_ = os.RemoveAll(away)
					}
				}
			}
		}
	}()
	return &rig{dir: dir, cgroupRoot: filepath.Join(dir, "cg"), l: l, fc: fc,
		spec: Spec{ID: "sb-1", Template: "fx-agent", UID: 200001, GID: 200002, JailDir: filepath.Join(dir, "jail/jails/sb-1"),
			VsockDir: filepath.Join(dir, "jail/vsock/sb-1"), VCPUs: 2, MemMB: 512}}
}

// ready answers "not yet" (an empty status) until the fake jailer has made its cgroup, then f.
func (r *rig) ready(f func(int) (string, error)) func(int) (string, error) {
	return func(pid int) (string, error) {
		if _, err := os.Stat(filepath.Join(r.dir, "ready")); err != nil {
			return "", nil
		}
		return f(pid)
	}
}

func (r *rig) read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(r.dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The command line is exactly the fixed template with validated integers, one element per argument, and
// the child's environment is empty. The cgroup limits are the sandbox's: memory plus the VMM's overhead,
// and vcpus times the period.
func TestLaunchArgvEnvAndLimits(t *testing.T) {
	r := newRig(t)
	in, err := r.l.Launch(r.spec)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--id", "sb-1", "--exec-file", r.l.Firecracker, "--uid", "200001", "--gid", "200002", "--chroot-base-dir", r.spec.JailDir,
		"--cgroup-version", "2", "--parent-cgroup", "fx/vms", "--cgroup", "memory.max=" + strconv.Itoa((512+vmmOverheadMB)<<20),
		"--cgroup", "cpu.max=200000 100000"}
	if got := strings.Split(strings.TrimSuffix(r.read(t, "argv.txt"), "\n"), "\n"); strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv %q, want %q", got, want)
	}
	// sh adds PWD, SHLVL and _ itself; anything else would have been inherited from the helper.
	for _, kv := range strings.Fields(r.read(t, "env.txt")) {
		if k, _, _ := strings.Cut(kv, "="); k != "PWD" && k != "SHLVL" && k != "_" {
			t.Fatalf("the jailer inherited %q", kv)
		}
	}
	if got := r.read(t, "cg/fx/vms/sb-1/memory.max"); got != strconv.Itoa((512+vmmOverheadMB)<<20) {
		t.Fatalf("memory.max %q", got)
	}
	if got := r.read(t, "cg/fx/vms/sb-1/cpu.max"); got != "200000 100000" {
		t.Fatalf("cpu.max %q", got)
	}
	// No supplementary group list is passed anywhere on the command line, and no group is set in a shell.
	for _, a := range want {
		if strings.Contains(a, "groups") {
			t.Fatalf("argv names a group list: %q", a)
		}
	}
	if err := in.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(r.cgroupRoot, "fx/vms/sb-1")); err == nil {
		t.Fatal("the cgroup survived Stop")
	}
	select {
	case <-in.(*instance).done:
	default:
		t.Fatal("the process was not reaped")
	}
}

// The id, and every other element, is refused before anything is created or run: a path, a leading dash,
// an embedded NUL and a 4 KiB string; a uid or gid of 0; out-of-range sizes; an unclean path.
func TestLaunchRefusesBadValuesBeforeAnythingHappens(t *testing.T) {
	r := newRig(t)
	cases := map[string]func(*Spec){
		"path as id":    func(s *Spec) { s.ID = "../x" },
		"leading dash":  func(s *Spec) { s.ID = "-x" },
		"nul in id":     func(s *Spec) { s.ID = "a\x00b" },
		"4 KiB id":      func(s *Spec) { s.ID = strings.Repeat("a", 4096) },
		"uid 0":         func(s *Spec) { s.UID = 0 },
		"gid 0":         func(s *Spec) { s.GID = 0 },
		"no vcpus":      func(s *Spec) { s.VCPUs = 0 },
		"huge memory":   func(s *Spec) { s.MemMB = 1 << 40 },
		"relative dir":  func(s *Spec) { s.JailDir = "jails/sb-1" },
		"dotdot in dir": func(s *Spec) { s.JailDir = s.JailDir + "/../sb-1" },
	}
	for name, mut := range cases {
		s := r.spec
		mut(&s)
		if _, err := r.l.Launch(s); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := os.Stat(filepath.Join(r.dir, "argv.txt")); err == nil {
		t.Fatal("the jailer ran for a refused spec")
	}
	l := *r.l
	l.CgroupParent = "../escape"
	if _, err := l.Launch(r.spec); err == nil {
		t.Error("a parent cgroup with .. was accepted")
	}
	l.CgroupParent = "--evil"
	if _, err := l.Launch(r.spec); err == nil {
		t.Error("a parent cgroup that reads as an option was accepted")
	}
}

// A process that has not dropped to the sandbox's uid and gid, or that keeps a supplementary group, fails
// the launch and is killed through its cgroup. (The status text is faked here; the real-root test reads
// a real process's.)
func TestLaunchFailsClosedOnDropAndGroups(t *testing.T) {
	u, g := me()
	defer func(d time.Duration) { readyTimeout = d }(readyTimeout)
	readyTimeout = 400 * time.Millisecond
	for name, st := range map[string]func(int) (string, error){
		"still root":    goodStatus(0, 0, ""),
		"wrong gid":     goodStatus(u, g+1, ""),
		"keeps a group": goodStatus(u, g, "100 131"),
		"other uid only": func(int) (string, error) {
			return "Uid:\t5\t5\t5\t5\nGid:\t" + fmt.Sprint(g) + "\t" + fmt.Sprint(g) + "\t" + fmt.Sprint(g) + "\t" + fmt.Sprint(g) + "\nGroups:\t\n" + noCaps, nil
		},
	} {
		r := newRig(t)
		r.l.Status = r.ready(st)
		_, err := r.l.Launch(r.spec)
		if err == nil {
			t.Errorf("%s: launched", name)
			continue
		}
		if name == "keeps a group" && !errors.Is(err, errDrop) {
			t.Errorf("%s: %v", name, err)
		}
		if _, err := os.Stat(filepath.Join(r.cgroupRoot, "fx/vms/sb-1")); err == nil {
			t.Errorf("%s: the cgroup was left", name)
		}
	}
}

func TestCheckDropped(t *testing.T) {
	ok := "Uid:\t7\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\t\n" + noCaps
	if d, err := CheckDropped(ok, 7, 8); !d || err != nil {
		t.Fatal(d, err)
	}
	for name, st := range map[string]string{
		"real uid not dropped": "Uid:\t0\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\t\n" + noCaps,
		"saved gid not":        "Uid:\t7\t7\t7\t7\nGid:\t8\t8\t0\t8\nGroups:\t\n" + noCaps,
		"three uid fields":     "Uid:\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\t\n" + noCaps,
		"three gid fields":     "Uid:\t7\t7\t7\t7\nGid:\t8\t8\t8\nGroups:\t\n" + noCaps,
		"no status":            "",
	} {
		if d, err := CheckDropped(st, 7, 8); d || err != nil {
			t.Errorf("%s: %v %v", name, d, err)
		}
	}
	base := "Uid:\t7\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\t\n"
	for name, st := range map[string]string{
		"a supplementary group of 0": "Uid:\t7\t7\t7\t7\nGid:\t8\t8\t8\t8\nGroups:\t0\n" + noCaps,
		"CapPrm set":                 base + "CapPrm:\t0000000000000001\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\n",
		"CapEff set":                 base + "CapPrm:\t0000000000000000\nCapEff:\t0000000000200000\nCapAmb:\t0000000000000000\n",
		"CapAmb set":                 base + "CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000400\n",
		"capability fields missing":  base,
		"CapAmb missing":             base + "CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\n",
	} {
		if _, err := CheckDropped(st, 7, 8); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A launch checks both binaries again every time: a file that became group-writable after start-up is not
// run. The same for a jail directory whose mode is not 0700. Nothing is started in either case.
func TestLaunchRechecksBinariesAndTheJailDirectory(t *testing.T) {
	for name, f := range map[string]func(r *rig){
		"jailer made group-writable":      func(r *rig) { _ = os.Chmod(r.l.Jailer, 0o775) },
		"firecracker made group-writable": func(r *rig) { _ = os.Chmod(r.l.Firecracker, 0o775) },
		"firecracker replaced by a directory": func(r *rig) {
			_ = os.Remove(r.l.Firecracker)
			_ = os.Mkdir(r.l.Firecracker, 0o755)
		},
		"jail directory 0755": func(r *rig) { _ = os.Chmod(r.spec.JailDir, 0o755) },
		"jail directory 0750": func(r *rig) { _ = os.Chmod(r.spec.JailDir, 0o750) },
		"jail directory is a file": func(r *rig) {
			_ = os.Remove(r.spec.JailDir)
			_ = os.WriteFile(r.spec.JailDir, nil, 0o700)
		},
	} {
		r := newRig(t)
		f(r)
		if _, err := r.l.Launch(r.spec); err == nil {
			t.Errorf("%s: launched", name)
		}
		if _, err := os.Stat(filepath.Join(r.dir, "argv.txt")); err == nil {
			t.Errorf("%s: the jailer ran", name)
		}
	}
}

// Only a root-owned, root-writable-only, symlink-free chain to a regular executable is run.
func TestCheckBinary(t *testing.T) {
	r := newRig(t)
	if err := r.l.CheckBinary(r.l.Jailer); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func() string{
		"wrong owner": func() string { l := *r.l; l.OwnerUID++; r.l = &l; return r.l.Jailer },
		"group-writable file": func() string {
			_ = os.Chmod(r.l.Firecracker, 0o775)
			return r.l.Firecracker
		},
		"not executable": func() string { p := filepath.Join(r.dir, "bin/data"); _ = os.WriteFile(p, nil, 0o644); return p },
		"symlink leaf": func() string {
			p := filepath.Join(r.dir, "bin/link")
			_ = os.Symlink(r.l.Jailer, p)
			return p
		},
		"writable parent": func() string {
			_ = os.Chmod(filepath.Join(r.dir, "bin"), 0o777)
			return filepath.Join(r.dir, "bin/jailer")
		},
		"relative":     func() string { return "bin/jailer" },
		"outside base": func() string { return "/bin/sh" },
	}
	for name, f := range bad {
		r2 := newRig(t)
		r = r2
		if err := r.l.CheckBinary(f()); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// a directory is not a binary, even with the execute bit
	if err := r.l.CheckBinary(filepath.Join(r.dir, "bin")); err == nil {
		t.Error("a directory was accepted as the binary")
	}
	// the whole chain counts, not only the file: from "/" the directories belong to root, not to this user.
	// The leaf is an executable this user owns in the package directory; with the owner of the directories
	// not checked, only the leaf would be looked at and it would pass.
	u, g := me()
	if u != 0 {
		wd, _ := os.Getwd()
		leaf, err := os.CreateTemp(wd, "chainleaf")
		if err != nil {
			t.Fatal(err)
		}
		leaf.Close()
		defer os.Remove(leaf.Name())
		_ = os.Chmod(leaf.Name(), 0o755)
		l := &JailerLauncher{OwnerUID: u, OwnerGID: g}
		if err := l.CheckBinary(leaf.Name()); err == nil {
			t.Error("a chain whose directories belong to someone else was accepted")
		}
	}
	// a symlinked directory in the middle of the chain
	r = newRig(t)
	if err := os.Symlink(filepath.Join(r.dir, "bin"), filepath.Join(r.dir, "binlink")); err != nil {
		t.Fatal(err)
	}
	if err := r.l.CheckBinary(filepath.Join(r.dir, "binlink/jailer")); err == nil {
		t.Error("a symlinked directory was followed")
	}
}

// Start-up reaping kills and removes stale sandbox cgroups, and leaves anything not named like an id.
func TestReapStaleCgroups(t *testing.T) {
	r := newRig(t)
	parent := filepath.Join(r.cgroupRoot, "fx/vms")
	for _, d := range []string{"old-1", "old-2", "Not_An_Id"} {
		if err := os.Mkdir(filepath.Join(parent, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// "old-1" holds a procs file that goes away with the directory, as it does in the kernel: write the
	// kill file and make the fake's cleanup unnecessary by leaving only an empty procs file.
	for _, d := range []string{"old-1", "old-2"} {
		_ = os.WriteFile(filepath.Join(parent, d, "cgroup.kill"), nil, 0o644)
		_ = os.WriteFile(filepath.Join(parent, d, "cgroup.procs"), nil, 0o644)
	}
	removed, failed := r.l.ReapStale()
	if removed != 2 || failed != 0 {
		t.Fatalf("removed %d failed %d", removed, failed)
	}
	if _, err := os.Stat(filepath.Join(parent, "Not_An_Id")); err != nil {
		t.Fatal("an entry that is not named like an id was touched")
	}
}

func TestUnitCgroupAndSetup(t *testing.T) {
	good := "0::/system.slice/fx-vmhelper.service\n"
	if u, err := UnitCgroup(good); err != nil || u != "system.slice/fx-vmhelper.service" {
		t.Fatal(u, err)
	}
	for _, bad := range []string{"", "1:name=x:/a\n", "0::/\n", "0::/a/../b\n", "0::/a b/../..\n", "0::/-x\n"} {
		if _, err := UnitCgroup(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	root := t.TempDir()
	unit := filepath.Join(root, "system.slice/u.service")
	if err := os.MkdirAll(unit, 0o755); err != nil {
		t.Fatal(err)
	}
	// the files a real cgroup directory already has, and the directories mkdir would fill with them
	for _, f := range []string{"cgroup.subtree_control"} {
		_ = os.WriteFile(filepath.Join(unit, f), nil, 0o644)
	}
	for _, d := range []string{"helper", "vms"} {
		_ = os.MkdirAll(filepath.Join(unit, d), 0o755)
	}
	_ = os.WriteFile(filepath.Join(unit, "helper/cgroup.procs"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(unit, "vms/cgroup.subtree_control"), nil, 0o644)
	parent, err := SetupCgroup(root, "system.slice/u.service", 4242)
	if err != nil || parent != "system.slice/u.service/vms" {
		t.Fatal(parent, err)
	}
	for f, want := range map[string]string{"helper/cgroup.procs": "4242", "cgroup.subtree_control": "+cpu +memory", "vms/cgroup.subtree_control": "+cpu +memory"} {
		if b, _ := os.ReadFile(filepath.Join(unit, f)); string(b) != want {
			t.Errorf("%s: %q, want %q", f, b, want)
		}
	}
	if _, err := SetupCgroup(root, "system.slice/missing.service", 1); err == nil {
		t.Error("a missing unit cgroup was accepted")
	}
	// a symlink in the unit's path is not followed
	_ = os.Symlink(unit, filepath.Join(root, "system.slice/link.service"))
	if _, err := SetupCgroup(root, "system.slice/link.service", 1); err == nil {
		t.Error("a symlinked unit cgroup was followed")
	}
}

// The manager's destroy, with the real launcher, stops through the cgroup and then removes the jail
// directories, including a directory the sandbox's uid owned and closed to everyone else.
func TestManagerDestroyWithRealLauncher(t *testing.T) {
	r := newRig(t)
	root := mkroot(t)
	m, err := newManager(cfgFor(root, 2), r.l, 0, toMe)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	newFixture(t).use(m)
	_, c := m.Prepare(prep("box-a"))
	if c != protocol.OK {
		t.Fatal(c)
	}
	m.mu.Lock()
	b := m.boxes["box-a"]
	m.mu.Unlock()
	if _, c := m.Start("box-a"); c != protocol.OK { // stages <jail>/firecracker/box-a/root before the launch
		t.Fatal(c)
	}
	if err := os.MkdirAll(b.spec.JailDir+"/firecracker/box-a/root/run", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(b.spec.JailDir+"/firecracker/box-a/root", 0o700); err != nil {
		t.Fatal(err)
	}
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatal(c)
	}
	if _, err := os.Lstat(b.spec.JailDir); err == nil {
		t.Fatal("the jail directory survived")
	}
	if _, err := os.Stat(filepath.Join(r.cgroupRoot, "fx/vms/box-a")); err == nil {
		t.Fatal("the cgroup survived")
	}
}

// A symlink where a cgroup file should be is not followed: the target keeps its content and setup fails.
func TestSetupCgroupDoesNotFollowASymlink(t *testing.T) {
	for _, victim := range []string{"helper/cgroup.procs", "cgroup.subtree_control", "vms/cgroup.subtree_control"} {
		root := t.TempDir()
		unit := filepath.Join(root, "u.service")
		for _, d := range []string{"helper", "vms"} {
			_ = os.MkdirAll(filepath.Join(unit, d), 0o755)
		}
		for _, f := range []string{"helper/cgroup.procs", "cgroup.subtree_control", "vms/cgroup.subtree_control"} {
			_ = os.WriteFile(filepath.Join(unit, f), nil, 0o644)
		}
		target := filepath.Join(root, "target")
		_ = os.WriteFile(target, []byte("keep"), 0o644)
		_ = os.Remove(filepath.Join(unit, victim))
		if err := os.Symlink(target, filepath.Join(unit, victim)); err != nil {
			t.Fatal(err)
		}
		if _, err := SetupCgroup(root, "u.service", 77); err == nil {
			t.Errorf("%s as a symlink: accepted", victim)
		}
		if b, _ := os.ReadFile(target); string(b) != "keep" {
			t.Errorf("%s: the symlink target was written: %q", victim, b)
		}
	}
}
