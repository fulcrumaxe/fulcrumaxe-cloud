//go:build linux

package sandbox

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"fx-vmhelper/internal/protocol"
)

// reexecInNS runs this test again in a user and mount namespace (mounting needs no real root there). It
// returns true in the parent, after the child has passed; false inside the namespace. The child is killed
// and reaped in the cleanup whatever happens, and the test asserts it is gone (no child outlives a test).
func reexecInNS(t *testing.T, name string) bool {
	t.Helper()
	if os.Getenv("FX_TEST_IN_NS") != "" {
		return false
	}
	cmd := exec.Command(os.Args[0], "-test.run=^"+name+"$", "-test.v")
	cmd.Env = append(os.Environ(), "FX_TEST_IN_NS=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWNS,
		UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
		GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}}}
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Skipf("user namespaces unavailable: %v", err)
	}
	pid := cmd.Process.Pid
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
		}
		if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
			t.Errorf("the namespace child %d survived the test: %v", pid, err)
		}
	})
	var err error
	select {
	case err = <-done:
		done <- err // for the cleanup
	case <-time.After(60 * time.Second):
		t.Fatal("the namespace child timed out")
	}
	if err != nil {
		t.Fatalf("in the namespace: %v\n%s", err, out.String())
	}
	if strings.Contains(out.String(), "--- SKIP") {
		t.Skipf("not possible here:\n%s", out.String())
	}
	return true
}

func TestStageMountsInNS(t *testing.T) {
	if reexecInNS(t, "TestStageMountsInNS") {
		return
	}
	if err := syscall.Mount("none", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		t.Skipf("cannot make the mount tree private: %v", err)
	}
	useRealMounts(t)
	requireMounting(t)
	realSetattr := mountSetattr
	defer func() { mountSetattr = realSetattr }()
	for _, v := range []struct {
		name     string
		openTree bool
		noAttr   bool
	}{{"open_tree and move_mount", true, false}, {"mount(2) on the fd links (fallback)", false, false},
		{"open_tree, then mount_setattr answers ENOSYS (kernel 5.2 to 5.11)", true, true}} {
		old := useOpenTree
		useOpenTree = v.openTree
		mountSetattr = realSetattr
		if v.noAttr {
			mountSetattr = func(int) error { return syscall.ENOSYS }
		}
		m, root := newMgr(t, 3, &fakeLauncher{})
		if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
			t.Fatalf("%s: prepare %s", v.name, c)
		}
		src := root + "/vsock/box-a"
		if err := os.WriteFile(src+"/v.sock_52", []byte("sock"), 0o660); err != nil {
			t.Fatal(err)
		}
		if _, c := m.Start("box-a"); c != protocol.OK {
			t.Fatalf("%s: start answered %s although mounting works here", v.name, c)
		}
		mp := root + "/jails/box-a/firecracker/box-a/root/vsock"
		if b, err := os.ReadFile(mp + "/v.sock_52"); err != nil || string(b) != "sock" {
			t.Fatalf("%s: the vsock directory is not visible in the jail: %q %v", v.name, b, err)
		}
		var sf syscall.Statfs_t
		if err := syscall.Statfs(mp, &sf); err != nil || sf.Flags&(syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC) != syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC {
			t.Errorf("%s: mount flags %#x (%v), want nosuid,nodev,noexec", v.name, sf.Flags, err)
		}
		// a file written inside the jail's view lands in the real directory: it is one directory, not a copy
		if err := os.WriteFile(mp+"/w", []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(src + "/w"); err != nil {
			t.Errorf("%s: write through the mount did not reach the source", v.name)
		}
		// never delete across it: the descent into the jail tree is refused and the source survives
		if err := removeAt(m.jailsFd, "box-a"); !errors.Is(err, errMount) {
			t.Errorf("%s: removal answered %v, want errMount", v.name, err)
		}
		if _, err := os.Stat(src + "/v.sock_52"); err != nil {
			t.Fatalf("%s: removal reached through the mount", v.name)
		}
		// a busy mount is not unmounted and nothing is deleted
		f, err := os.Open(mp + "/v.sock_52")
		if err != nil {
			t.Fatal(err)
		}
		if c := m.Destroy("box-a"); c != protocol.Internal {
			t.Errorf("%s: destroy of a busy mount answered %s", v.name, c)
		}
		if _, err := os.Stat(src + "/v.sock_52"); err != nil {
			t.Fatalf("%s: a busy mount's content was deleted", v.name)
		}
		f.Close()
		if c := m.Destroy("box-a"); c != protocol.OK {
			t.Fatalf("%s: destroy answered %s", v.name, c)
		}
		for _, p := range []string{"/jails/box-a", "/vsock/box-a"} {
			if _, err := os.Lstat(root + p); err == nil {
				t.Errorf("%s: %s survived", v.name, p)
			}
		}
		useOpenTree = old
	}
}

// A mount that lands on the wrong directory is caught, undone, and nothing behind it is deleted. The
// unmount does not follow a symlink standing where the mount point should be.
func TestStageWrongMountAndSymlinkUnmountInNS(t *testing.T) {
	if reexecInNS(t, "TestStageWrongMountAndSymlinkUnmountInNS") {
		return
	}
	if err := syscall.Mount("none", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		t.Skipf("cannot make the mount tree private: %v", err)
	}
	useRealMounts(t)
	requireMounting(t)
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Prepare(prep("box-a"))
	decoy := t.TempDir()
	if err := os.WriteFile(decoy+"/precious", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	dfd, err := openAbs(decoy)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(dfd)
	oldBind := bindFn
	bindFn = func(src, mp, dir int) error { return bindMount(dfd, mp, dir) }
	if _, c := m.Start("box-a"); c != protocol.Internal {
		bindFn = oldBind
		t.Fatalf("start with the wrong directory mounted answered %s, want internal", c)
	}
	bindFn = oldBind
	if _, err := os.Stat(decoy + "/precious"); err != nil {
		t.Error("the wrongly mounted directory lost its content")
	}
	if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
		t.Errorf("left %v", names)
	}
	// symlink in the mount point's place: a tmpfs is mounted behind it, and umountAt must not follow
	dir := t.TempDir()
	if err := os.Mkdir(dir+"/real", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mount("none", dir+"/real", "tmpfs", 0, ""); err != nil {
		t.Skipf("tmpfs mount: %v", err)
	}
	if err := os.WriteFile(dir+"/real/inmount", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir+"/real", dir+"/vsock"); err != nil {
		t.Fatal(err)
	}
	pfd, err := openAbs(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(pfd)
	if err := umountAt(pfd, "vsock"); err == nil {
		t.Error("the unmount followed a symlink")
	}
	if _, err := os.Stat(dir + "/real/inmount"); err != nil {
		t.Error("the mount behind the symlink was unmounted")
	}
	if err := umountAt(pfd, "real"); err != nil {
		t.Errorf("a plain mount point could not be unmounted: %v", err)
	}
}

// requireMounting probes once, with a plain bind mount, whether this environment can mount at all, and
// skips if not. After it, a Start that fails is a failure of the code under test, never a skip.
func requireMounting(t *testing.T) {
	t.Helper()
	a, b := t.TempDir(), t.TempDir()
	if err := syscall.Mount(a, b, "", syscall.MS_BIND, ""); err != nil {
		t.Skipf("this environment does not allow mounting: %v", err)
	}
	if err := syscall.Unmount(b, 0); err != nil {
		t.Fatalf("probe mount could not be removed: %v", err)
	}
}

// A reap finds a mount left by a previous run (the helper died) and removes it before the directories.
func TestReapUnmountsARealStaleMountInNS(t *testing.T) {
	if reexecInNS(t, "TestReapUnmountsARealStaleMountInNS") {
		return
	}
	if err := syscall.Mount("none", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		t.Skipf("cannot make the mount tree private: %v", err)
	}
	useRealMounts(t)
	m, root := newMgr(t, 3, &fakeLauncher{})
	requireMounting(t)
	m.Prepare(prep("old-1"))
	if _, c := m.Start("old-1"); c != protocol.OK {
		t.Fatalf("start answered %s although mounting works here", c)
	}
	src := root + "/vsock/old-1"
	if err := os.WriteFile(src+"/keep", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	// a new helper: same directories, empty registry
	m.mu.Lock()
	delete(m.boxes, "old-1")
	m.mu.Unlock()
	res := m.Reap()
	if res.Failed != 0 || len(res.Removed) != 1 {
		t.Fatalf("%+v", res)
	}
	for _, p := range []string{"/jails/old-1", "/vsock/old-1"} {
		if _, err := os.Lstat(root + p); err == nil {
			t.Errorf("%s survived the reap", p)
		}
	}
}

// A bind that left out nosuid, nodev or noexec is refused by mountVsock itself, undone, and nothing is left.
func TestStageRefusesMountWithoutFlagsInNS(t *testing.T) {
	if reexecInNS(t, "TestStageRefusesMountWithoutFlagsInNS") {
		return
	}
	if err := syscall.Mount("none", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		t.Skipf("cannot make the mount tree private: %v", err)
	}
	useRealMounts(t)
	requireMounting(t)
	oldBind := bindFn
	defer func() { bindFn = oldBind }()
	bindFn = func(src, mp, dir int) error {
		return syscall.Mount(procFdPath(src), procFdPath(mp), "", syscall.MS_BIND, "")
	}
	m, root := newMgr(t, 3, &fakeLauncher{})
	m.Prepare(prep("box-a"))
	if _, c := m.Start("box-a"); c != protocol.Internal {
		t.Fatalf("a mount without the flags answered %s, want internal", c)
	}
	if names := entries(t, root+"/jails/box-a"); len(names) != 0 {
		t.Errorf("left %v", names)
	}
}
