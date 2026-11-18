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
//
// On the thread switch it makes with asUser: Go's own Setresuid applies to every thread of the process, and the raw
// SYS_SETRESUID used here changes only the calling thread, which then stays in Go's pool of threads. A real-root run showed a
// thread of the process holding root's effective capabilities again after such a switch, so that process is
// not a place to assert the helper's capability set; TestRealJailer therefore runs other uids in child processes. No production code
// calls either one: the helper never switches a thread's uid.
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

// asUser runs f as uid and gid with no supplementary groups, on its own OS thread that ends with the goroutine
// (it is locked and never unlocked). Used by TestRealRootPermissions only. TestRealJailer does not use it: in a
// real-root run a sibling thread of the same process was seen with its capabilities back after such a call, so
// anything that asserts the helper's capability set runs the other uid in a child process (asSandboxUID).
func asUser(t *testing.T, uid, gid uint32, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runtime.LockOSThread() // no UnlockOSThread: the thread dies with this goroutine
		none := ^uintptr(0)
		if _, _, e := syscall.RawSyscall(syscall.SYS_SETGROUPS, 0, 0, 0); e != 0 {
			t.Errorf("setgroups: %v", e)
			return
		}
		if _, _, e := syscall.RawSyscall(syscall.SYS_SETRESGID, none, uintptr(gid), none); e != 0 {
			t.Errorf("setresgid: %v", e)
			return
		}
		if _, _, e := syscall.RawSyscall(syscall.SYS_SETRESUID, none, uintptr(uid), none); e != 0 {
			t.Errorf("setresuid: %v", e)
			return
		}
		f()
	}()
	<-done
}
