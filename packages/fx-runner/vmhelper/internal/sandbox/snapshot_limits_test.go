//go:build linux

package sandbox

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"fx-vmhelper/internal/protocol"
)

// A hostile VMM owns snap.mem and snap.state until the helper takes them, and may ftruncate them to any sparse
// size. The helper must refuse a file of the wrong size before it writes a byte as root.
func TestSnapshotRefusesFilesOfTheWrongSize(t *testing.T) {
	trunc := func(name string, size int64) func(root string) {
		return func(root string) {
			if err := os.Truncate(filepath.Join(root, name), size); err != nil {
				t.Fatal(err)
			}
		}
	}
	for name, tamper := range map[string]func(root string){
		"oversize sparse memory":  trunc("snap.mem", 600<<20),
		"memory one byte over":    trunc("snap.mem", 1<<20+1),
		"undersize memory":        trunc("snap.mem", 1<<20-1),
		"empty memory":            trunc("snap.mem", 0),
		"oversize sparse state":   trunc("snap.state", 600<<20),
		"state one byte over cap": trunc("snap.state", maxStateBytes+1),
		"empty state":             trunc("snap.state", 0),
	} {
		t.Run(name, func(t *testing.T) {
			m, l, dir, _ := newSnapMgr(t)
			started(t, m, "box-a")
			l.tamper = tamper
			if _, c := m.Snapshot("box-a", "s1"); c != protocol.Internal {
				t.Fatalf("code %s", c)
			}
			if ents, _ := os.ReadDir(dir); len(ents) != 0 {
				t.Errorf("a refused snapshot left %v", ents)
			}
			if ents, _ := os.ReadDir(m.jailDir("box-a")); len(ents) != 0 {
				t.Errorf("the jail holds %v", ents)
			}
		})
	}
}

func TestSnapshotAcceptsTheLargestStateFile(t *testing.T) {
	m, l, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	l.state = make([]byte, maxStateBytes)
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatalf("code %s", c)
	}
	if fi, err := os.Stat(dir + "/s1/state"); err != nil || fi.Size() != maxStateBytes {
		t.Errorf("state: %v %v", fi, err)
	}
}

// fixedSpace answers the free-space probe with a filesystem that has avail bytes free (4 KiB blocks).
func fixedSpace(avail uint64) func(int, *syscall.Statfs_t) error {
	return func(_ int, st *syscall.Statfs_t) error {
		st.Bsize, st.Bavail = 4096, avail/4096
		return nil
	}
}

const snapNeed = 1<<20 + maxStateBytes // what a 1 MiB sandbox's snapshot may take

func TestSnapshotNeedsFreeSpace(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t)
	started(t, m, "box-a")
	for name, probe := range map[string]func(int, *syscall.Statfs_t) error{
		"none free":                fixedSpace(0),
		"the files but no margin":  fixedSpace(snapNeed),
		"one block below the need": fixedSpace(snapNeed + freeSpaceMargin - 4096),
		"the probe fails":          func(int, *syscall.Statfs_t) error { return syscall.EIO },
		"no block size":            func(_ int, st *syscall.Statfs_t) error { st.Bavail = 1 << 40; return nil },
	} {
		m.statfs = probe
		if _, c := m.Snapshot("box-a", "s1"); c != protocol.OverCap {
			t.Errorf("%s: code %s", name, c)
		}
		if ents, _ := os.ReadDir(dir); len(ents) != 0 {
			t.Errorf("%s: a refused snapshot left %v", name, ents)
		}
	}
	// the refusals happened before the VM was touched: it is still running, and the exact need is enough
	m.statfs = fixedSpace(snapNeed + freeSpaceMargin)
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Errorf("room for the files and the margin: %s", c)
	}
}

func TestResumeNeedsFreeSpace(t *testing.T) {
	m, l, _, _ := newSnapMgr(t)
	started(t, m, "box-a")
	if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
		t.Fatal(c)
	}
	launches := len(l.specs)
	need := uint64(len(l.mem) + len(l.state))
	for name, probe := range map[string]func(int, *syscall.Statfs_t) error{
		"none free":                fixedSpace(0),
		"one block below the need": fixedSpace(need + freeSpaceMargin - 4096),
		"the probe fails":          func(int, *syscall.Statfs_t) error { return syscall.EIO },
	} {
		m.statfs = probe
		if _, c := m.Resume("box-a", "s1"); c != protocol.OverCap {
			t.Errorf("%s: code %s", name, c)
		}
		if len(l.specs) != launches {
			t.Errorf("%s: a refused resume launched a VM", name)
		}
		if ents, _ := os.ReadDir(m.jailDir("box-a")); len(ents) != 0 {
			t.Errorf("%s: a refused resume left %v staged", name, ents)
		}
	}
	m.statfs = fixedSpace((need+4095)/4096*4096 + freeSpaceMargin) // the probe counts whole blocks
	if _, c := m.Resume("box-a", "s1"); c != protocol.OK {
		t.Errorf("room for the files and the margin: %s", c)
	}
}

// snapshot_dir must be writable, not only readable.
func TestStartupRefusesAnUnwritableSnapshotDir(t *testing.T) {
	old := writableProbe
	defer func() { writableProbe = old }()
	writableProbe = func(int) error { return syscall.EROFS } // what ProtectSystem=strict answers
	root := mkroot(t)
	cfg := cfgFor(root, 3)
	cfg.SnapshotDir = filepath.Join(t.TempDir(), "snaps")
	if err := os.Mkdir(cfg.SnapshotDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if m, err := newManager(cfg, &snapLauncher{}, 0, toMe); err == nil {
		m.Close()
		t.Fatal("a read-only snapshot_dir was accepted at start-up")
	}
}

func TestStartupProbeLeavesNothingBehind(t *testing.T) {
	m, _, dir, _ := newSnapMgr(t) // new Manager ran the real probe on dir
	defer m.Close()
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Errorf("the writability probe left %v", ents)
	}
}

// Defence in depth: the stored files are checked again before anything is copied back into a jail.
func TestResumeRefusesTamperedStoredMetadataAndDirectory(t *testing.T) {
	for name, tamper := range map[string]func(dir string){
		"meta.json readable by others": func(dir string) { _ = os.Chmod(dir+"/s1/meta.json", 0o644) },
		"snapshot directory opened up": func(dir string) { _ = os.Chmod(dir+"/s1", 0o755) },
	} {
		t.Run(name, func(t *testing.T) {
			m, l, dir, _ := newSnapMgr(t)
			started(t, m, "box-a")
			if _, c := m.Snapshot("box-a", "s1"); c != protocol.OK {
				t.Fatal(c)
			}
			launches := len(l.specs)
			tamper(dir)
			if _, c := m.Resume("box-a", "s1"); c != protocol.Internal {
				t.Errorf("code %s", c)
			}
			if len(l.specs) != launches {
				t.Error("a refused resume launched a VM")
			}
		})
	}
}
