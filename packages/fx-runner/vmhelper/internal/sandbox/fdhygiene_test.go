//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"testing"
)

// Descriptor hygiene: removeAt holds a descriptor per level, so every way out of it, success or refusal,
// must close what it opened. The count of /proc/self/fd is compared before and after each case.

func openFds(t *testing.T) int {
	t.Helper()
	es, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	return len(es)
}

func TestRemoveAtClosesEveryDescriptorOnEveryPath(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	outside, keep := outsideTree(t, root)
	check := func(name string, before int) {
		t.Helper()
		if after := openFds(t); after != before {
			t.Errorf("%s: descriptors %d -> %d", name, before, after)
		}
	}

	// success on a deep and wide tree: every pop closes its descriptor
	before := openFds(t)
	if err := os.MkdirAll(root+"/jails/x1/a/b/c", 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50; i++ {
		if err := os.MkdirAll(fmt.Sprintf("%s/jails/x1/a/w%02d/z", root, i), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeAt(m.jailsFd, "x1"); err != nil {
		t.Fatal(err)
	}
	check("deep and wide success", before)

	// refusal at the depth bound with frames still on the stack
	setDepth(t, 10)
	before = openFds(t)
	if err := os.Mkdir(root+"/jails/x2", 0o700); err != nil {
		t.Fatal(err)
	}
	deepChain(t, root+"/jails/x2", 30)
	if err := removeAt(m.jailsFd, "x2"); !errors.Is(err, errDeep) {
		t.Fatalf("want errDeep, got %v", err)
	}
	check("errDeep", before)
	setDepth(t, 2048)

	// a symlink swapped in for a directory mid-walk
	before = openFds(t)
	if err := os.MkdirAll(root+"/jails/x3/p/q", 0o700); err != nil {
		t.Fatal(err)
	}
	hookRemove = func(parent int, name string) {
		if name == "q" {
			_ = os.Rename(root+"/jails/x3/p/q", root+"/jails/x3/p/q2")
			_ = os.Symlink(outside, root+"/jails/x3/p/q")
		}
	}
	err := removeAt(m.jailsFd, "x3")
	hookRemove = nil
	if err == nil {
		t.Error("a swapped symlink was walked")
	}
	check("swap mid-walk", before)

	// a swap at rmdir time
	before = openFds(t)
	if err := os.MkdirAll(root+"/jails/x4/p", 0o700); err != nil {
		t.Fatal(err)
	}
	hookRmdir = func(parent int, name string) {
		if name == "p" {
			_ = os.Rename(root+"/jails/x4/p", root+"/jails/x4/p2")
			_ = os.Symlink(outside, root+"/jails/x4/p")
		}
	}
	err = removeAt(m.jailsFd, "x4")
	hookRmdir = nil
	if err == nil {
		t.Error("rmdir of a swapped symlink succeeded")
	}
	check("swap at rmdir", before)

	// a listing that fails on the third directory, with two frames open
	before = openFds(t)
	if err := os.MkdirAll(root+"/jails/x5/a/b", 0o700); err != nil {
		t.Fatal(err)
	}
	n := 0
	listFn = func(fd int) ([]string, error) {
		if n++; n == 3 {
			return nil, syscall.EIO
		}
		return list(fd)
	}
	err = removeAt(m.jailsFd, "x5")
	listFn = list
	if !errors.Is(err, syscall.EIO) {
		t.Errorf("a failed listing answered %v", err)
	}
	check("failed listing", before)

	if _, e := os.Stat(keep); e != nil {
		t.Fatal("the outside tree was touched")
	}
}
