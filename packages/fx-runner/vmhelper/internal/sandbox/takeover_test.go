//go:build linux

package sandbox

import (
	"os"
	"path/filepath"
	"testing"

	"fx-vmhelper/internal/protocol"
)

// reopenTree gives the owner access back to every directory under dir (links are not followed), so the test's
// temporary directory can be removed even when the test stopped part-way with directories closed (chmod 0): a
// closed directory left behind makes t.TempDir's own removal fail, and the tree stays in the temp directory for good.
func reopenTree(dir string) {
	fi, err := os.Lstat(dir)
	if err != nil || !fi.IsDir() {
		return
	}
	_ = os.Chmod(dir, 0o700)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		reopenTree(filepath.Join(dir, e.Name()))
	}
}

// A sandbox that closes a directory it owns (chmod 0, also a directory inside one) must not make removal
// fail for good: taking a directory over sets its mode to 0700 before it is opened. A non-root owner has
// the same position as root after the take-over, so this test needs no root.
func TestDestroyRemovesDirectoriesTheSandboxClosed(t *testing.T) {
	m, root := newMgr(t, 2, &fakeLauncher{})
	t.Cleanup(func() { reopenTree(root) })
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	m.mu.Lock()
	jail := m.boxes["box-a"].spec.JailDir
	m.mu.Unlock()
	deep := filepath.Join(jail, "firecracker/box-a/root/run/inner")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "f"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{deep, filepath.Join(jail, "firecracker/box-a/root/run"), filepath.Join(jail, "firecracker/box-a/root")} {
		if err := os.Chmod(d, 0); err != nil {
			t.Fatal(err)
		}
	}
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatalf("destroy of a tree with closed directories: %v", c)
	}
	if _, err := os.Lstat(jail); err == nil {
		t.Fatal("the jail directory survived")
	}
	// start-up reaping gets through the same tree
	if _, c := m.Prepare(prep("box-b")); c != protocol.OK {
		t.Fatal(c)
	}
	m.mu.Lock()
	jb := m.boxes["box-b"].spec.JailDir
	delete(m.boxes, "box-b")
	m.mu.Unlock()
	d := filepath.Join(jb, "x/y")
	_ = os.MkdirAll(d, 0o700)
	_ = os.Chmod(d, 0)
	_ = os.Chmod(filepath.Join(jb, "x"), 0)
	if r := m.Reap(); r.Failed != 0 || len(r.Removed) != 1 {
		t.Fatalf("reap: %+v", r)
	}
}

type walkRig struct {
	base, victim, outFile, outDir string
	fd                            int
}

func newWalkRig(t *testing.T) *walkRig {
	t.Helper()
	b := t.TempDir()
	r := &walkRig{base: b, victim: filepath.Join(b, "victim"), outFile: filepath.Join(b, "outfile"), outDir: filepath.Join(b, "outdir")}
	for _, d := range []string{r.victim + "/sub", r.outDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(r.outFile, []byte("keep"), 0o644)
	_ = os.WriteFile(filepath.Join(r.outDir, "keep"), []byte("keep"), 0o600)
	fd, err := openAbs(b)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeFd(fd); hookRemove = nil })
	r.fd = fd
	return r
}

func (r *walkRig) untouched(t *testing.T, what string) {
	t.Helper()
	if fi, err := os.Stat(r.outFile); err != nil || fi.Mode().Perm() != 0o644 {
		t.Errorf("%s: the outside file was changed: %v %v", what, fi, err)
	}
	if fi, err := os.Stat(r.outDir); err != nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("%s: the outside directory was changed: %v %v", what, fi, err)
	}
	if _, err := os.Stat(filepath.Join(r.outDir, "keep")); err != nil {
		t.Errorf("%s: the outside directory lost its content", what)
	}
}

// Between "unlink said it is a directory" and the take-over, the name is swapped. Nothing outside the tree
// is changed, whatever it was swapped for: the open is O_PATH|O_NOFOLLOW|O_DIRECTORY and every decision is
// made on that descriptor.
func TestTakeOverIsNotRacedByASwappedName(t *testing.T) {
	swaps := map[string]func(r *walkRig, p string){
		"hard link to a file elsewhere": func(r *walkRig, p string) { _ = os.Remove(p); _ = os.Link(r.outFile, p) },
		"symlink to a directory elsewhere": func(r *walkRig, p string) {
			_ = os.Remove(p)
			_ = os.Symlink(r.outDir, p)
		},
		"symlink to a file elsewhere": func(r *walkRig, p string) { _ = os.Remove(p); _ = os.Symlink(r.outFile, p) },
	}
	defer func(v bool) { useOpenat2 = v }(useOpenat2)
	for _, via := range []bool{true, false} { // openat2, then the plain open with the mount-id check
		useOpenat2 = via
		for name, swap := range swaps {
			r := newWalkRig(t)
			hookRemove = func(parent int, n string) {
				if n == "sub" {
					swap(r, filepath.Join(r.victim, "sub"))
				}
			}
			if err := removeAt(r.fd, "victim"); err == nil {
				t.Errorf("%s: the walk went on", name)
			}
			hookRemove = nil
			r.untouched(t, name)
		}
	}
}

// A directory whose owner is not one the tree may hold is refused, and its mode and owner are left alone.
func TestTakeOverRefusesAStrangersDirectory(t *testing.T) {
	r := newWalkRig(t)
	me, _ := me()
	err := removeAtOwned(r.fd, "victim", func(u uint32) bool { return u != me })
	if err == nil {
		t.Fatal("a directory of an unlisted owner was taken over")
	}
	if fi, _ := os.Stat(r.victim); fi == nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("the refused directory was changed: %v", fi)
	}
	// the manager's own rule: root, the runner, or a uid of the sandbox range, and no one else
	m, _ := newMgr(t, 1, &fakeLauncher{})
	if !m.mayTake(me) {
		t.Error("the test user (every id is mapped to it) was refused")
	}
	m.remap = nil
	if m.mayTake(0) != (m.rootUID == 0) || !m.mayTake(m.runnerUID) || !m.mayTake(m.uidFirst) || m.mayTake(m.uidFirst+m.uidCount) || m.mayTake(m.uidFirst-1) || m.mayTake(12345) {
		t.Error("mayTake does not follow root, the runner and the sandbox uid range")
	}
}
