//go:build linux

package sandbox

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

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
	// The helper's own config parser builds the Config, so the paths are ones it accepts: snapshot_dir lies outside jail_root
	// (the workflow makes it, root-owned 0700, and lists it in the unit's ReadWritePaths next to jail_root, as RenderUnit does).
	snapDir := os.Getenv("FX_VM_SNAPSHOT_DIR")
	if snapDir == "" {
		t.Fatal("FX_VM_SNAPSHOT_DIR is not set")
	}
	cfgJSON := fmt.Sprintf(`{"jail_root":%q,"runner_uid":1001,"runner_gid":1001,"uid_first":200000,"uid_count":4,"gid_first":200000,"gid_count":4,`+
		`"max_sandboxes":2,"max_vcpus":2,"max_mem_mb":512,"jailer_path":%q,"firecracker_path":%q,`+
		`"template_manifest_path":"/opt/example/templates/manifest.json","template_dir":"/opt/example/templates","snapshot_dir":%q}`,
		os.Getenv("FX_VM_JAIL_ROOT"), l.Jailer, l.Firecracker, snapDir)
	cfg, err := config.Parse([]byte(cfgJSON))
	if err != nil {
		t.Fatal(err)
	}
	ll := &logLauncher{t: t, inner: l}
	m, err := New(cfg, ll)
	if err != nil {
		t.Fatal(err)
	}
	fx := realFixture(t, cfg.JailRoot)
	fx.use(m)        // the staged tree holds a real kernel and a root disk that answers the agent's ping
	useRealMounts(t) // and the vsock bind mount is real here
	defer m.Close()
	a, b := "real-a", "real-b"
	// No VM may outlive the test, whatever fails below (destroy is a no-op for an id that is already gone).
	t.Cleanup(func() {
		for _, id := range []string{a, b} {
			m.Destroy(id)
		}
	})
	vdirs := map[string]string{}
	for _, id := range []string{a, b} {
		r, c := m.Prepare(protocol.Request{Verb: protocol.Prepare, SandboxID: id, Template: "fx-agent", VCPUs: 2, MemMB: 256})
		if c != protocol.OK {
			t.Fatal("prepare", id, c)
		}
		vdirs[id] = r.VsockDir
		if _, c := m.Start(id); c != protocol.OK {
			t.Fatal("start", id, c)
		}
	}
	// The VM boots and the agent port answers, reached the way the runner reaches it: as the runner's uid, through
	// <vsock_dir>/v.sock, with the proxy's CONNECT line and then a ping frame.
	for _, id := range []string{a, b} {
		if err := vsockHello(t, cfg.RunnerUID, cfg.RunnerGID, vdirs[id]+"/v.sock"); err != nil {
			t.Errorf("vsock hello with %s: %v\nconsole of %s:\n%s", id, err, id, ll.console(id))
		}
	}
	// The sticky bit: the sandbox uid can make entries in its vsock directory but cannot delete or rename a file
	// the runner owns (the runner's listener sockets live there).
	listener := vdirs[a] + "/v.sock_5253"
	if out, err := runAsUID(cfg.RunnerUID, cfg.RunnerGID, "write", listener); err != nil {
		t.Errorf("the runner cannot make a listener file: %v\n%s", err, out)
	}
	if out, err := runAsUID(200000, 200000, "sticky", listener, vdirs[a]+"/mine", vdirs[a]+"/moved"); err != nil { // sandbox A
		t.Errorf("sticky bit: %v\n%s", err, out)
	}
	// (the directory is closed to root without the override: the runner looks)
	if out, err := runAsUID(cfg.RunnerUID, cfg.RunnerGID, "stat", listener); err != nil {
		t.Errorf("the runner's file is gone: %v\n%s", err, out)
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
	realSnapshotPhase(t, m, cfg, fx, b, vdirs[b], pb) // b: the destroy that must refuse above stopped a
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

// realFixture is a manifest and template directory holding the real kernel (FX_VM_KERNEL, the pinned guest
// kernel) and root disk (FX_VM_ROOTFS) the workflow made.
func realFixture(t *testing.T, dir string) *fixture {
	t.Helper()
	f := newFixtureIn(t, dir)
	var err error
	if f.kernel, err = os.ReadFile(os.Getenv("FX_VM_KERNEL")); err != nil {
		t.Fatal(err)
	}
	if f.rootfs, err = os.ReadFile(os.Getenv("FX_VM_ROOTFS")); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, f.dir+"/fx-agent/kernel", f.kernel, 0o644)
	mustWrite(t, f.dir+"/fx-agent/rootfs", f.rootfs, 0o644)
	mustWrite(t, f.manifest, manifestFor("fx-agent", f.kernel, f.rootfs), 0o644)
	return f
}

// vsockHello connects to Firecracker's host-side socket as uid:gid, asks for the agent's port and pings it,
// retrying until the guest is up. It answers nil only for the agent's {"ok":true,"proto":1}.
func vsockHello(t *testing.T, uid, gid uint32, sock string) (err error) {
	var out string
	for deadline := time.Now().Add(60 * time.Second); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
		if out, err = runAsUID(uid, gid, "hello", sock); err == nil {
			return nil
		}
	}
	return fmt.Errorf("%v: %s", err, out)
}

// guestCall sends one request frame to the guest agent port through the host-side socket and returns the reply body.
func guestCall(sock, req string) (string, error) {
	conn, err := net.DialTimeout("unix", sock, 2*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("CONNECT 5252\n")); err != nil {
		return "", err
	}
	br := bufio.NewReader(conn)
	if line, err := br.ReadString('\n'); err != nil || !strings.HasPrefix(line, "OK ") {
		return "", fmt.Errorf("handshake: %q %v", line, err)
	}
	if _, err := conn.Write(append(binary.BigEndian.AppendUint32(nil, uint32(len(req))), req...)); err != nil {
		return "", err
	}
	var n [4]byte
	if _, err := io.ReadFull(br, n[:]); err != nil {
		return "", err
	}
	body := make([]byte, min(binary.BigEndian.Uint32(n[:]), 4096))
	if _, err := io.ReadFull(br, body); err != nil {
		return "", err
	}
	if !strings.HasPrefix(string(body), `{"ok":true`) {
		return "", fmt.Errorf("reply %q", body)
	}
	return string(body), nil
}

// pingOnce connects to sock (the caller's own uid is the one that matters), asks for the agent's port and pings it.
func pingOnce(sock string) error {
	conn, err := net.DialTimeout("unix", sock, 2*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("CONNECT 5252\n")); err != nil {
		return err
	}
	br := bufio.NewReader(conn)
	if line, err := br.ReadString('\n'); err != nil || !strings.HasPrefix(line, "OK ") {
		return fmt.Errorf("handshake: %q %v", line, err)
	}
	req := []byte(`{"op":"ping"}`)
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(req)))
	if _, err := conn.Write(append(frame, req...)); err != nil {
		return err
	}
	var n [4]byte
	if _, err := io.ReadFull(br, n[:]); err != nil {
		return err
	}
	body := make([]byte, min(binary.BigEndian.Uint32(n[:]), 4096))
	if _, err := io.ReadFull(br, body); err != nil {
		return err
	}
	if string(body) != `{"ok":true,"proto":1}` {
		return fmt.Errorf("reply %q", body)
	}
	return nil
}

// logLauncher shows why a launch failed: the manager answers only "internal".
type logLauncher struct {
	t     *testing.T
	inner Launcher
	ins   map[string]*instance
}

func (l *logLauncher) Launch(s Spec) (Instance, error) {
	in, err := l.inner.Launch(s)
	if err != nil {
		l.t.Logf("launch of %s failed: %v", s.ID, err)
	} else if i, ok := in.(*instance); ok {
		if l.ins == nil {
			l.ins = map[string]*instance{}
		}
		l.ins[s.ID] = i
	}
	return in, err
}

// console is what the VM's serial console printed (Firecracker's stdout), when a hello fails.
func (l *logLauncher) console(id string) string {
	if i := l.ins[id]; i != nil {
		return "head: " + i.out.Head() + "\ntail: " + i.out.Tail()
	}
	return "no instance"
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
	if out, err := runAsUID(id, id, op, args...); err != nil {
		t.Errorf("as uid %d, %s %v: %v\n%s", id, op, args, err, out)
	}
}

// runAsUID is asSandboxUID that returns the child's output and error instead of failing the test.
func runAsUID(uid, gid uint32, op string, args ...string) (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	cmd := exec.Command(self, "-test.run=^TestAsSandboxHelper$")
	cmd.Env = []string{"FX_VM_HELPER_OP=" + op, "FX_VM_HELPER_ARGS=" + strings.Join(args, "\x1f")}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid, Groups: []uint32{}}}
	out, err := cmd.CombinedOutput()
	return string(out), err
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
	case "hello": // the runner reaches the guest agent through the vsock socket
		if err := pingOnce(args[0]); err != nil {
			t.Fatal(err)
		}
	case "stat":
		if _, err := os.Stat(args[0]); err != nil {
			t.Fatal(err)
		}
	case "remove": // the runner removes the stale host-side socket of a stopped VM (it owns the directory)
		if err := os.Remove(args[0]); err != nil {
			t.Fatal(err)
		}
	case "noopen": // neither the runner nor a sandbox uid can open or search a snapshot
		if f, err := os.Open(args[0]); err == nil {
			f.Close()
			t.Errorf("opened %s", args[0])
		}
	case "gput": // write a value into the guest's tmpfs
		if _, err := guestCall(args[0], `{"op":"put","v":"`+args[1]+`"}`); err != nil {
			t.Fatal(err)
		}
	case "gget": // read it back
		body, err := guestCall(args[0], `{"op":"get"}`)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Printf("GUEST-REPLY=%s\n", body)
	case "write": // the runner makes a file in its vsock directory
		if err := os.WriteFile(args[0], []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	case "sticky": // the sandbox uid makes an entry, and cannot delete or rename the runner's file
		if err := os.WriteFile(args[1], nil, 0o600); err != nil {
			t.Errorf("the sandbox cannot make an entry in its vsock directory: %v", err)
		}
		if err := os.Remove(args[0]); err == nil {
			t.Error("the sandbox uid deleted the runner's file")
		}
		if err := os.Rename(args[0], args[2]); err == nil {
			t.Error("the sandbox uid renamed the runner's file")
		}
	default:
		t.Fatal("unknown operation")
	}
}
