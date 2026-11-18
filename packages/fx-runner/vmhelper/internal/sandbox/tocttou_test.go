//go:build linux

package sandbox

import (
	"os"
	"path/filepath"
	"testing"

	"fx-vmhelper/internal/protocol"
)

// TOCTOU and duplicate-prepare tests (adapted from the security review of the first version).

func outsideTree(t *testing.T, root string) (string, string) {
	t.Helper()
	outside := filepath.Join(filepath.Dir(root), "precious")
	if err := os.MkdirAll(outside+"/sub", 0o700); err != nil {
		t.Fatal(err)
	}
	keep := outside + "/sub/keep.txt"
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return outside, keep
}

// TOCTOU: after unlinkat says EISDIR, the jail directory is swapped for a symlink to an outside tree
// before the O_NOFOLLOW open. Destroy must fail closed and the outside tree must survive.
func TestSwapTOCTOURemoveSwapTopLevel(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	outside, keep := outsideTree(t, root)
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	jd := root + "/jails/box-a"
	os.WriteFile(jd+"/f", []byte("y"), 0o600)
	fired := false
	hookRemove = func(parent int, name string) {
		if name == "box-a" && !fired && parent == m.jailsFd {
			fired = true
			if err := os.Rename(jd, root+"/moved"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, jd); err != nil {
				t.Fatal(err)
			}
		}
	}
	defer func() { hookRemove = nil }()
	if c := m.Destroy("box-a"); c == protocol.OK {
		t.Error("destroy answered OK through a swapped symlink")
	}
	if !fired {
		t.Fatal("hook did not fire")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("outside content removed via TOCTOU swap")
	}
	// The registry keeps the entry, so a retry is possible; a retry now unlinks the symlink (not the target).
	hookRemove = nil
	c := m.Destroy("box-a")
	t.Logf("retry destroy: %v", c)
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("outside content removed on retry")
	}
}

// TOCTOU one level down, inside the guest-writable jail directory.
func TestSwapTOCTOURemoveSwapNested(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	outside, keep := outsideTree(t, root)
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	jd := root + "/jails/box-a"
	os.MkdirAll(jd+"/d/e", 0o700)
	hookRemove = func(parent int, name string) {
		if name == "d" {
			os.Rename(jd+"/d", jd+"/d2")
			os.Symlink(outside, jd+"/d")
		}
	}
	defer func() { hookRemove = nil }()
	c := m.Destroy("box-a")
	t.Logf("destroy: %v", c)
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("outside content removed via nested swap")
	}
}

// TOCTOU between mkdirat and the O_NOFOLLOW open: the new directory is swapped for a symlink.
// No chown/chmod may land on the target.
func TestSwapTOCTOUMkdirSwap(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	outside, _ := outsideTree(t, root)
	os.Chmod(outside, 0o755)
	hookMkdir = func(parent int, name string) {
		if name == "box-a" && parent == m.jailsFd {
			os.Remove(root + "/jails/box-a")
			os.Symlink(outside, root+"/jails/box-a")
		}
	}
	defer func() { hookMkdir = nil }()
	if _, c := m.Prepare(prep("box-a")); c == protocol.OK {
		t.Fatal("prepare OK through swapped symlink")
	}
	fi, _ := os.Stat(outside)
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("outside dir mode changed to %v", fi.Mode())
	}
	// is the registry clean so the id can be prepared again?
	hookMkdir = nil
	os.Remove(root + "/jails/box-a")
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatalf("re-prepare: %v", c)
	}
}

// Duplicate prepare answers bad_id and does not touch the existing directories.
func TestSwapDuplicatePrepare(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	os.WriteFile(root+"/jails/box-a/marker", nil, 0o600)
	if _, c := m.Prepare(prep("box-a")); c != protocol.BadID {
		t.Fatalf("dup: %v", c)
	}
	if _, err := os.Stat(root + "/jails/box-a/marker"); err != nil {
		t.Fatal("dup prepare touched the existing jail")
	}
}

// A leftover on-disk directory that was not reaped: prepare must not adopt or delete it.
func TestSwapPrepareOverLeftover(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	os.Mkdir(root+"/jails/box-a", 0o700)
	os.WriteFile(root+"/jails/box-a/leftover", nil, 0o600)
	_, c := m.Prepare(prep("box-a"))
	t.Logf("prepare over leftover: %v", c)
	if c == protocol.OK {
		t.Error("adopted an existing directory")
	}
	if _, err := os.Stat(root + "/jails/box-a/leftover"); err != nil {
		t.Error("prepare removed a directory it did not create")
	}
}
