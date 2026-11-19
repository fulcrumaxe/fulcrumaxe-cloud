//go:build linux

package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

// The copy itself is bounded: a file that grows after its size was checked (or whose size was never right) is cut off
// at max+1 bytes, not copied whole. The bytes written are what counts, so this looks at the copy directly.
func TestStoreFileCopiesAtMostTheLimit(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t)
	dfd, err := openAbs(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(dfd)
	f, err := os.Create(filepath.Join(t.TempDir(), "src"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Truncate(10 << 20); err != nil { // a sparse 10 MiB file
		t.Fatal(err)
	}
	if _, err := m.storeFile(f, dfd, "big", 1<<20, 1<<20); err != errSnapSize {
		t.Fatalf("an oversize file: %v", err)
	}
	if fi, err := os.Stat(dir + "/big"); err != nil || fi.Size() > 1<<20+1 {
		t.Errorf("more than the limit was written: %v %v", fi, err)
	}
	g, err := os.Create(filepath.Join(t.TempDir(), "g"))
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if err := g.Truncate(1 << 20); err != nil {
		t.Fatal(err)
	}
	if _, err := m.storeFile(g, dfd, "grown", 1<<20, 100); err != errSnapSize { // bigger than the size that was checked
		t.Fatalf("a file bigger than the size checked: %v", err)
	}
	if _, err := g.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := m.storeFile(g, dfd, "shrunk", 1<<20, 1<<20+5); err != errSnapSize { // smaller than the size that was checked
		t.Fatalf("a file smaller than the size checked: %v", err)
	}
}

// pull refuses a wrong size before it copies anything.
func TestPullRefusesAWrongSizeBeforeCopying(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t)
	dfd, err := openAbs(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(dfd)
	root := t.TempDir()
	rfd, err := openAbs(root)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(rfd)
	for name, c := range map[string]struct{ size, want, max int64 }{
		"over the limit":  {5 << 20, 0, 4 << 20},
		"over the exact":  {1<<20 + 1, 1 << 20, 1 << 20},
		"under the exact": {1<<20 - 1, 1 << 20, 1 << 20},
		"empty":           {0, 0, 4 << 20},
	} {
		if err := os.WriteFile(root+"/f", nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(root+"/f", c.size); err != nil {
			t.Fatal(err)
		}
		if _, err := m.pull(rfd, "f", Spec{}, dfd, "out", c.want, c.max); err != errSnapSize {
			t.Errorf("%s: %v", name, err)
		}
		if _, err := os.Lstat(dir + "/out"); err == nil {
			t.Errorf("%s: something was copied", name)
		}
		_ = os.Remove(root + "/f")
	}
}
