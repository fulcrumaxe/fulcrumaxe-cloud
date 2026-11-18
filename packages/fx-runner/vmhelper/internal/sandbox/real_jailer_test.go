//go:build linux

package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/hardening"
	"fx-vmhelper/internal/protocol"
)

// TestRealJailer runs the real pinned jailer and Firecracker as root. It runs only with
// FX_VMHELPER_REAL_ROOT=1, and only inside a systemd service that carries the pinned capability set, device
// policy and system call filter (.github/workflows/vmhelper-real-root.yml starts it with systemd-run from
// hardening.json), so a pass also shows that CAP_SYS_CHROOT and the other absent capabilities are not
// needed. Paths come from the environment: FX_VM_JAILER and FX_VM_FIRECRACKER (a root-owned chain),
// FX_VM_JAIL_ROOT (a root-owned 0711 directory the unit may write). It has not run on the build host (no
// root there); the workflow is where it runs.
func TestRealJailer(t *testing.T) {
	if os.Getenv("FX_VMHELPER_REAL_ROOT") != "1" || os.Geteuid() != 0 {
		t.Skip("set FX_VMHELPER_REAL_ROOT=1 and run as root inside the pinned service")
	}
	pinned := hardening.Load()
	// What the helper does first: CAP_DAC_OVERRIDE leaves the effective set (it stays permitted and inheritable).
	if err := pinned.DropJailerOnly(); err != nil {
		t.Fatal(err)
	}
	assertNoOverride(t, "right after the drop")
	status, _ := os.ReadFile("/proc/self/status")
	if err := pinned.CheckStatus(string(status)); err != nil {
		t.Fatalf("this process is not under the pinned set after the drop: %v", err) // proves the properties were applied
	}
	if !strings.Contains(string(status), "CapEff:\t"+fmt.Sprintf("%016x", pinned.EffectiveMask())) {
		t.Fatalf("the effective set still holds a jailer-only capability:\n%s", status)
	}
	self, _ := ReadSelfCgroup()
	unit, err := UnitCgroup(self)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := SetupCgroup("/sys/fs/cgroup", unit, os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	l := &JailerLauncher{Jailer: os.Getenv("FX_VM_JAILER"), Firecracker: os.Getenv("FX_VM_FIRECRACKER"), CgroupRoot: "/sys/fs/cgroup", CgroupParent: parent, AmbientCaps: pinned.JailerOnlyCaps()}
	cfg := config.Config{JailRoot: os.Getenv("FX_VM_JAIL_ROOT"), RunnerUID: 1001, RunnerGID: 1001, UIDFirst: 200000, UIDCount: 4, GIDFirst: 200000, GIDCount: 4,
		MaxSandboxes: 2, MaxVCPUs: 2, MaxMemMB: 512, FirecrackerPath: l.Firecracker}
	m, err := New(cfg, &logLauncher{t: t, inner: l})
	if err != nil {
		t.Fatal(err)
	}
	newFixtureIn(t, cfg.JailRoot).use(m) // the staged tree holds the fixture's template files
	useRealMounts(t)                     // and the vsock bind mount is real here
	defer m.Close()
	a, b := "real-a", "real-b"
	for _, id := range []string{a, b} {
		if _, c := m.Prepare(protocol.Request{Verb: protocol.Prepare, SandboxID: id, Template: "fx-agent", VCPUs: 2, MemMB: 256}); c != protocol.OK {
			t.Fatal("prepare", id, c)
		}
		if _, c := m.Start(id); c != protocol.OK {
			t.Fatal("start", id, c)
		}
	}
	pid := func(id string) int {
		b, err := os.ReadFile("/sys/fs/cgroup/" + parent + "/" + id + "/cgroup.procs")
		n, _ := strconv.Atoi(strings.TrimSpace(strings.SplitN(string(b), "\n", 2)[0]))
		if err != nil || n <= 0 {
			t.Fatalf("no process in the cgroup of %s: %v", id, err)
		}
		return n
	}
	assertNoOverride(t, "after start")
	pa, pb := pid(a), pid(b)
	for i, p := range []int{pa, pb} {
		st, _ := os.ReadFile("/proc/" + strconv.Itoa(p) + "/status")
		if ok, err := CheckDropped(string(st), 200000+uint32(i), 200000+uint32(i)); !ok || err != nil {
			t.Errorf("sandbox %d is not dropped to its own ids, with no supplementary group: %v\n%s", i, err, st)
		}
		for _, f := range []string{"memory.max", "cpu.max"} {
			got, _ := os.ReadFile("/sys/fs/cgroup/" + parent + "/real-" + string(rune('a'+i)) + "/" + f)
			want := map[string]string{"memory.max": strconv.Itoa((256 + vmmOverheadMB) << 20), "cpu.max": "200000 100000"}[f]
			if strings.TrimSpace(string(got)) != want {
				t.Errorf("%s of sandbox %d: %q, want %q", f, i, got, want)
			}
		}
	}
	assertNoOverride(t, "before asUser")
	// B's uid cannot read A's memory or enter A's jail; a symlink planted in A's jail is not followed by reaping.
	canary := filepath.Join(cfg.JailRoot, "canary-dir")
	if err := os.MkdirAll(canary, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(canary+"/keep", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	jailA := m.boxes[a].spec.JailDir
	m.mu.Unlock()
	if err := os.Symlink(canary, jailA+"/planted"); err != nil {
		t.Fatal(err)
	}
	asSandboxUID(t, 200001, "probe", strconv.Itoa(pa), jailA)
	assertNoOverride(t, "after the probe as the second sandbox uid")
	// The sandbox uid reaches its own chroot through its process's root link (the helper cannot: the directory
	// is closed to root without the override) and closes the directory; any error fails the test.
	asSandboxUID(t, 200000, "close", "/proc/"+strconv.Itoa(pa)+"/root/run")
	if _, err := os.ReadDir(jailA + "/firecracker/" + a + "/root/run"); err == nil {
		t.Error("the directory the sandbox closed can still be listed")
	}
	// A directory owned by a uid outside the sandbox range, the runner and root is refused, not taken over.
	if err := os.Mkdir(jailA+"/stranger", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(jailA+"/stranger", 0o755); err != nil { // the unit's UMask is 0077
		t.Fatal(err)
	}
	if err := os.Chown(jailA+"/stranger", 4242, 4242); err != nil {
		t.Fatal(err)
	}
	assertNoOverride(t, "destroy that must refuse")
	if c := m.Destroy(a); c == protocol.OK {
		t.Error("destroy took over a directory of an unrelated uid")
	}
	if fi, err := os.Lstat(jailA + "/stranger"); err != nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("the stranger's directory was changed: %v %v", fi, err)
	}
	if err := os.Remove(jailA + "/stranger"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{a, b} {
		assertNoOverride(t, "destroy of "+id)
		if c := m.Destroy(id); c != protocol.OK {
			t.Fatal("destroy", id, c)
		}
	}
	for _, p := range []int{pa, pb} {
		if _, err := os.Stat("/proc/" + strconv.Itoa(p)); err == nil {
			t.Errorf("process %d survived destroy", p)
		}
	}
	ents, _ := os.ReadDir("/sys/fs/cgroup/" + parent)
	for _, e := range ents {
		if e.IsDir() { // the parent's own control files are not sandbox cgroups
			t.Errorf("cgroup left under %s: %s", parent, e.Name())
		}
	}
	for _, d := range []string{"jails", "vsock"} {
		if ents, _ := os.ReadDir(filepath.Join(cfg.JailRoot, d)); len(ents) != 0 {
			t.Errorf("%s not empty after destroy: %v", d, ents)
		}
	}
	if _, err := os.Stat(canary + "/keep"); err != nil {
		t.Error("the canary outside the jail was removed through a planted symlink")
	}
}

// logLauncher shows why a launch failed: the manager answers only "internal".
type logLauncher struct {
	t     *testing.T
	inner Launcher
}

func (l *logLauncher) Launch(s Spec) (Instance, error) {
	in, err := l.inner.Launch(s)
	if err != nil {
		l.t.Logf("launch of %s failed: %v", s.ID, err)
	}
	return in, err
}

// assertNoOverride fails if any thread of this process holds CAP_DAC_OVERRIDE effective, and logs what each
// thread holds: removal runs on any of them, so the closed directory is only removed for real when none does.
func assertNoOverride(t *testing.T, when string) {
	t.Helper()
	ents, err := os.ReadDir("/proc/self/task")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for _, e := range ents {
		b, err := os.ReadFile("/proc/self/task/" + e.Name() + "/status")
		if err != nil {
			continue // the thread ended meanwhile
		}
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "CapEff:"); ok {
				v = strings.TrimSpace(v)
				seen[v]++
				n, _ := strconv.ParseUint(v, 16, 64)
				if n&(1<<1) != 0 {
					t.Errorf("%s: thread %s (pid %d) holds CAP_DAC_OVERRIDE effective (CapEff %s)", when, e.Name(), os.Getpid(), v)
					for _, o := range ents { // every thread: id, state, start time, effective set
						st, _ := os.ReadFile("/proc/self/task/" + o.Name() + "/stat")
						sb, _ := os.ReadFile("/proc/self/task/" + o.Name() + "/status")
						eff := ""
						for _, l := range strings.Split(string(sb), "\n") {
							if strings.HasPrefix(l, "CapEff:") || strings.HasPrefix(l, "Uid:") {
								eff += " " + strings.Join(strings.Fields(l), " ")
							}
						}
						f := strings.Fields(string(st))
						if len(f) > 21 {
							t.Logf("  thread %s state %s starttime %s%s", o.Name(), f[2], f[21], eff)
						}
					}
				}
			}
		}
	}
	t.Logf("%s: CapEff of every thread (value: count) %v, without CAP_DAC_OVERRIDE", when, seen)
}

// asSandboxUID runs one operation in a child process that is started with the sandbox's uid and gid and no
// supplementary group (the credential is set in the child between fork and exec). A thread of this process
// is never switched to another uid: Go's threads are shared, and one that changed ids and went back would
// have root's effective capabilities restored.
func asSandboxUID(t *testing.T, id uint32, op string, args ...string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self, "-test.run=^TestAsSandboxHelper$")
	cmd.Env = []string{"FX_VM_HELPER_OP=" + op, "FX_VM_HELPER_ARGS=" + strings.Join(args, "\x1f")}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: id, Gid: id, Groups: []uint32{}}}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Errorf("as uid %d, %s %v: %v\n%s", id, op, args, err, out)
	}
}

// TestAsSandboxHelper is the child of asSandboxUID; it does nothing otherwise.
func TestAsSandboxHelper(t *testing.T) {
	op := os.Getenv("FX_VM_HELPER_OP")
	if op == "" {
		t.Skip("child process")
	}
	args := strings.Split(os.Getenv("FX_VM_HELPER_ARGS"), "\x1f")
	switch op {
	case "close": // the sandbox closes a directory it owns
		if err := os.Chmod(args[0], 0); err != nil {
			t.Fatal(err)
		}
	case "probe": // another sandbox: no access to this one's memory or jail
		if f, err := os.Open("/proc/" + args[0] + "/mem"); err == nil {
			f.Close()
			t.Error("opened another sandbox's /proc/<pid>/mem")
		}
		if _, err := os.ReadDir(args[1]); err == nil {
			t.Error("listed another sandbox's jail")
		}
	default:
		t.Fatal("unknown operation")
	}
}
