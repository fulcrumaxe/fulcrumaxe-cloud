//go:build linux

package sandbox

import (
	"os"
	"runtime"
	"syscall"
	"testing"

	"fx-vmhelper/internal/protocol"
)

// TestRealRootPermissions runs only with FX_VMHELPER_REAL_ROOT=1 as root, on a throwaway directory. It
// builds the layout with real chowns (no remap) and then, on one locked OS thread, becomes sandbox B's uid
// and gid and tries to enter and list sandbox A's vsock directory. It is skipped by default, and it has not
// been run by the author of this change (no root on the build host); the owner-opted real-root CI step in the
// next change is where it runs.
func TestRealRootPermissions(t *testing.T) {
	if os.Getenv("FX_VMHELPER_REAL_ROOT") != "1" || os.Geteuid() != 0 {
		t.Skip("set FX_VMHELPER_REAL_ROOT=1 and run as root")
	}
	root := mkroot(t)
	// a root-only path above the root must not block a sandbox: make every parent traversable
	for p := parent(root); p != "/"; p = parent(p) {
		_ = os.Chmod(p, 0o755|(modeOf(p)&os.ModePerm))
	}
	cfg := cfgFor(root, 2)
	m, err := New(cfg, &fakeLauncher{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	a, c := m.Prepare(prep("box-a"))
	if c != protocol.OK {
		t.Fatal(c)
	}
	if _, c := m.Prepare(prep("box-b")); c != protocol.OK {
		t.Fatal(c)
	}
	if err := vchk(m, a.VsockDir, "box-a", cfg.RunnerUID, a.SandboxGID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.VsockDir+"/v.sock_52", nil, 0o660); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(a.VsockDir+"/v.sock_52", int(cfg.RunnerUID), int(cfg.GIDFirst)); err != nil {
		t.Fatal(err)
	}
	asUser(t, cfg.UIDFirst+1, cfg.GIDFirst+1, func() { // sandbox B
		if _, err := os.Stat(a.VsockDir + "/v.sock_52"); err == nil {
			t.Error("B traversed A's directory")
		}
		if _, err := os.ReadDir(a.VsockDir); err == nil {
			t.Error("B listed A's directory")
		}
	})
	asUser(t, cfg.UIDFirst, cfg.GIDFirst, func() { // sandbox A
		if _, err := os.Stat(a.VsockDir + "/v.sock_52"); err != nil {
			t.Errorf("A cannot reach its own socket path: %v", err)
		}
		if _, err := os.ReadDir(a.VsockDir); err == nil {
			t.Error("A listed its own directory")
		}
	})
}

func modeOf(p string) os.FileMode { fi, _ := os.Lstat(p); return fi.Mode() }

func parent(p string) string {
	for i := len(p) - 1; i > 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "/"
}

// asUser runs f with this OS thread's effective uid, gid and supplementary groups changed, then restores them.
// Raw syscalls act on the calling thread only, which is why the thread is locked. If the restore fails the
// thread is left locked so that it dies with the goroutine instead of returning to the pool as non-root.
func asUser(t *testing.T, uid, gid uint32, f func()) {
	t.Helper()
	runtime.LockOSThread()
	none := ^uintptr(0)
	if _, _, e := syscall.RawSyscall(syscall.SYS_SETGROUPS, 0, 0, 0); e != 0 {
		t.Fatal(e)
	}
	if _, _, e := syscall.RawSyscall(syscall.SYS_SETRESGID, none, uintptr(gid), none); e != 0 {
		t.Fatal(e)
	}
	if _, _, e := syscall.RawSyscall(syscall.SYS_SETRESUID, none, uintptr(uid), none); e != 0 {
		t.Fatal(e)
	}
	f()
	if _, _, e := syscall.RawSyscall(syscall.SYS_SETRESUID, none, 0, none); e != 0 {
		t.Fatal("cannot restore euid: thread left locked", e)
	}
	if _, _, e := syscall.RawSyscall(syscall.SYS_SETRESGID, none, 0, none); e != 0 {
		t.Fatal("cannot restore egid: thread left locked", e)
	}
	runtime.UnlockOSThread()
}
