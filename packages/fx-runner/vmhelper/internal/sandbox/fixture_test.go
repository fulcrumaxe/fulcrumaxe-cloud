//go:build linux

package sandbox

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
)

// Mounting needs CAP_SYS_ADMIN. Tests that are not run in a mount namespace see a recording stand-in for
// mountVsock (the real one is exercised by TestStageMountsInNS); it makes no mount, so the unmount that
// follows it finds nothing to do (EINVAL), as for a directory that is not a mount point.
var fakeMounts struct {
	sync.Mutex
	n int
}

var realMount, realUmount = mountVsock, umountAt

// useRealMounts switches the rest of one test to the real mount and unmount (root or a mount namespace).
func useRealMounts(t *testing.T) {
	t.Helper()
	fm, fu := mountVsock, umountAt
	mountVsock, umountAt = realMount, realUmount
	t.Cleanup(func() { mountVsock, umountAt = fm, fu })
}

func init() {
	mountVsock = func(src, mp, dir int) error {
		fakeMounts.Lock()
		fakeMounts.n++
		fakeMounts.Unlock()
		return nil
	}
	umountAt = func(int, string) error { return syscall.EINVAL }
}

// A fixture is a manifest and a template directory, both "root-owned" as the test user, below one base that
// is where the chain check starts (the stager's chainBase), plus the template bytes it was built from.
type fixture struct {
	base, manifest, dir string
	kernel, rootfs      []byte
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func manifestFor(id string, kernel, rootfs []byte) []byte {
	return []byte(`{"` + id + `":{"kernel":"` + sum(kernel) + `","rootfs":"` + sum(rootfs) + `"}}`)
}

func mustWrite(t *testing.T, p string, b []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

// newFixture writes a manifest for template "fx-agent" and its two files.
func newFixture(t *testing.T) *fixture { return newFixtureIn(t, "") }

// newFixtureIn puts the fixture in a fresh directory below dir (the test's temp directory when dir is empty).
// The real-jailer test runs in a service whose only writable place is the jail root, so it passes that; the
// name holds a dot, so it is not an id and start-up reaping would leave it alone.
func newFixtureIn(t *testing.T, dir string) *fixture {
	t.Helper()
	base := ""
	if dir == "" {
		base = t.TempDir()
	} else {
		var err error
		if base, err = os.MkdirTemp(dir, "fixture."); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(base) })
	}
	f := &fixture{base: base, kernel: []byte("kernel-bytes"), rootfs: []byte("rootfs-bytes-0123456789")}
	if err := os.Chmod(f.base, 0o755); err != nil {
		t.Fatal(err)
	}
	f.manifest, f.dir = f.base+"/templates.json", f.base+"/tpl"
	mustWrite(t, f.manifest, manifestFor("fx-agent", f.kernel, f.rootfs), 0o644)
	mustWrite(t, f.dir+"/fx-agent/kernel", f.kernel, 0o644)
	mustWrite(t, f.dir+"/fx-agent/rootfs", f.rootfs, 0o644)
	return f
}

// use points m at the fixture.
func (f *fixture) use(m *Manager) {
	m.stg.manifest, m.stg.dir, m.stg.chainBase = f.manifest, f.dir, f.base
}
