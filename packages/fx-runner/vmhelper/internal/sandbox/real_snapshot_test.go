//go:build linux

package sandbox

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/protocol"
)

// realSnapshotPhase is the real-root proof of D#587 B-3a, run inside TestRealJailer on the started sandbox id
// (real Firecracker, real jailer, real files). The root disk is read-only and the guest's only writable place
// is a tmpfs, so "a file written before the snapshot is there after the resume" is a tmpfs file restored from
// guest memory: the value is random, written through the guest agent, and read back from the resumed VM.
//
// It also shows what the snapshot looks like on disk (0700 directory, 0600 root-owned files that neither the
// runner's uid nor a sandbox uid can open), that a changed manifest refuses the resume, that the old VM
// process is gone, and that an evicted snapshot cannot be resumed. Not covered here (unit tests do it): a
// symlink or hard link planted by a hostile VMM in the jail, which needs a VMM that writes one.
func realSnapshotPhase(t *testing.T, m *Manager, cfg config.Config, fx *fixture, id, vdir string, pid int) {
	t.Helper()
	val := make([]byte, 16)
	if _, err := rand.Read(val); err != nil {
		t.Fatal(err)
	}
	want := hex.EncodeToString(val)
	sock := vdir + "/v.sock"
	if out, err := runAsUID(cfg.RunnerUID, cfg.RunnerGID, "gput", sock, want); err != nil {
		t.Fatalf("the guest did not take the value: %v\n%s", err, out)
	}
	assertNoOverride(t, "before snapshot")
	rep, c := m.Snapshot(id, "real-snap")
	if c != protocol.OK {
		t.Fatal("snapshot", c)
	}
	assertNoOverride(t, "after snapshot")
	if rep.SnapshotBytes < 256<<20 || rep.SnapshotBytes > 3<<30 { // the guest has 256 MB; the suite stays under 3 GB
		t.Errorf("snapshot of %d bytes", rep.SnapshotBytes)
	}
	// on disk: root-owned, 0700 directory of 0600 files
	dir := cfg.SnapshotDir + "/real-snap"
	for p, wantMode := range map[string]os.FileMode{cfg.SnapshotDir: os.ModeDir | 0o700, dir: os.ModeDir | 0o700, dir + "/mem": 0o600, dir + "/state": 0o600, dir + "/meta.json": 0o600} {
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st := fi.Sys().(*syscall.Stat_t); fi.Mode() != wantMode || st.Uid != 0 || st.Gid != 0 || (fi.Mode().IsRegular() && st.Nlink != 1) {
			t.Errorf("%s: mode %v owner %d:%d", p, fi.Mode(), st.Uid, st.Gid)
		}
	}
	for _, who := range []struct{ uid, gid uint32 }{{cfg.RunnerUID, cfg.RunnerGID}, {cfg.UIDFirst, cfg.GIDFirst}} { // the runner, and sandbox A's own ids
		for _, f := range []string{dir + "/mem", dir + "/state", dir + "/meta.json"} {
			if out, err := runAsUID(who.uid, who.gid, "noopen", f); err != nil {
				t.Errorf("uid %d opened %s: %v\n%s", who.uid, f, err, out)
			}
		}
	}
	// the VM is gone: no process in the cgroup, and the staged tree was removed
	if _, err := os.Stat("/proc/" + strconv.Itoa(pid)); err == nil {
		t.Errorf("the VM's process %d is still running after the snapshot", pid)
	}
	if _, err := os.Stat(m.jailDir(id) + "/firecracker"); !os.IsNotExist(err) {
		t.Errorf("the staged tree is still there after the snapshot: %v", err)
	}
	// the disk the snapshot was taken with is bound to it: another root disk in the manifest refuses the resume
	good := append([]byte(nil), fx.rootfs...)
	other := append(append([]byte(nil), good...), 'x')
	mustWrite(t, fx.manifest, manifestFor("fx-agent", fx.kernel, other), 0o644)
	if _, c := m.Resume(id, "real-snap"); c != protocol.SnapshotMismatch {
		t.Errorf("resume against a changed manifest: %s", c)
	}
	mustWrite(t, fx.manifest, manifestFor("fx-agent", fx.kernel, good), 0o644)
	// the runner removes the stale host-side socket of the stopped VM, then the sandbox resumes
	if out, err := runAsUID(cfg.RunnerUID, cfg.RunnerGID, "remove", sock); err != nil {
		t.Fatalf("remove the stale socket: %v\n%s", err, out)
	}
	if _, c := m.Resume(id, "real-snap"); c != protocol.OK {
		t.Fatal("resume", c)
	}
	assertNoOverride(t, "after resume")
	if err := vsockHello(t, cfg.RunnerUID, cfg.RunnerGID, sock); err != nil {
		t.Fatalf("no hello from the resumed guest: %v", err)
	}
	out, err := runAsUID(cfg.RunnerUID, cfg.RunnerGID, "gget", sock)
	if err != nil || !strings.Contains(out, `"v":"`+want+`"`) {
		t.Errorf("the value written before the snapshot is not in the resumed guest (want %s): %v\n%s", want, err, out)
	}
	// evicted: the snapshot is deleted, and a resume of it is refused
	if c := m.SnapshotDelete("real-snap"); c != protocol.OK {
		t.Error("delete", c)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("snapshot directory still there: %v", err)
	}
	if _, c := m.Snapshot(id, "real-snap-2"); c != protocol.OK { // a resumed VM can be snapshotted again
		t.Errorf("second snapshot: %s", c)
	}
	if c := m.SnapshotDelete("real-snap-2"); c != protocol.OK {
		t.Error("delete 2", c)
	}
	if _, c := m.Resume(id, "real-snap"); c != protocol.UnknownSnapshot {
		t.Errorf("resume of an evicted snapshot: %s", c)
	}
}
