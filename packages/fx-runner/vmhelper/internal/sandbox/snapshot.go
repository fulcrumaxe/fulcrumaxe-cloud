//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"syscall"

	"fx-vmhelper/internal/fcapi"
	"fx-vmhelper/internal/protocol"
	"fx-vmhelper/internal/server"
)

// Snapshots. A snapshot is guest memory, so it is secret: it lives in config snapshot_dir, a root-owned 0700
// directory, as <snapshot_dir>/<snapshot id>/{mem,state,meta.json}, a 0700 directory of 0600 root-owned files. Neither the
// runner nor a sandbox uid can open them. The helper holds no CAP_DAC_OVERRIDE for any of this (it is raised
// for the jailer, the API-socket dial and the v.sock handover only): the files Firecracker writes sit in the
// sandbox's jail, so the sandbox process is killed first and each directory down to the jail's root is then taken back to root
// with CAP_CHOWN, as destroy does. Every name is opened through its parent's descriptor with O_NOFOLLOW (O_PATH for
// anything not yet root's), checked on the descriptor, and acted on through /proc/self/fd.
//
// A snapshot is bound to the disk it was taken with: meta.json holds the template id, the vcpus and memory and
// the sha256 digests of the kernel and root disk that were staged (the verified manifest digests; nothing is hashed
// again). A resume against another template, size or manifest digest answers snapshot_mismatch, and the files it
// stages are checked against the manifest the way start's are.
//
// Only full snapshots are taken. The root disk is read-only and the guest's writable state is tmpfs, so what a
// resume brings back is the guest's memory, tmpfs files included.

const (
	snapDirMode  os.FileMode = 0o700
	snapFileMode             = 0o600
	maxMeta                  = 4096
	metaName                 = "meta.json"
	storedMem                = "mem"
	storedState              = "state"
)

// SnapshotFormat is the snapshot data version (the major number of Firecracker's SNAPSHOT_VERSION) of the pinned
// Firecracker. Firecracker refuses a state file of another major version, so meta.json records it and a resume
// of a snapshot written under another one answers snapshot_mismatch before anything is staged or launched. It
// must equal firecracker.snapshot_format in infra/microvm-image/lock.json (a test in the runner checks that):
// Firecracker 1.16 wrote 11, 1.17 and 1.18 write 12.
const SnapshotFormat = 12

// The names Firecracker writes in the jail root (the paths of fcapi without the slash).
var jailMem, jailState = fcapi.SnapMemPath[1:], fcapi.SnapStatePath[1:]

var errSnapFile = errors.New("snapshot file is not a single-link regular file of the expected owner")
var errSnapSize = errors.New("snapshot file is not of the size the sandbox's memory and Firecracker's format allow")

// maxStateBytes is the most the helper accepts for the device-state file. Firecracker's state file holds the vCPU
// registers, the KVM state and the few virtio devices (one disk, one vsock, no NIC): tens of KiB on the pinned
// version, whatever the guest's memory size. 4 MiB is two orders of magnitude above that, and small enough that a
// hostile VMM which owns the file (and may truncate it up to any sparse size) cannot make the root helper write more.
const maxStateBytes = 4 << 20

// freeSpaceMargin is what must stay free on the target filesystem after the helper's own writes: the files are
// written as root, so they would also use the blocks reserved for root, which the helper must not exhaust.
const freeSpaceMargin = 64 << 20

// roomFor reports whether the filesystem of the directory fd has need bytes plus the margin free for an
// unprivileged writer (f_bavail, not f_bfree, so the root reserve is not counted). It fails closed.
func (m *Manager) roomFor(fd int, need uint64) bool {
	var st syscall.Statfs_t
	fn := m.statfs
	if fn == nil {
		fn = syscall.Fstatfs
	}
	if fn(fd, &st) != nil || st.Bsize <= 0 {
		return false
	}
	bs := uint64(st.Bsize)
	if st.Bavail > (1<<62)/bs {
		return true // more than any file the helper writes
	}
	return st.Bavail*bs >= need+freeSpaceMargin
}

// Snapshotter is what a started Instance offers when it can snapshot itself: pause, then write jailState and
// jailMem into its jail's root. The VM stays paused; the manager stops it.
type Snapshotter interface{ Snapshot() error }

type snapMeta struct {
	template, kernel, rootfs           string
	vcpus, memMB, memBytes, stateBytes int64
	format                             int64 // SnapshotFormat when it was written; 0 for a version 1 file, which predates it
}

func (s snapMeta) bytes() []byte {
	return fmt.Appendf(nil, `{"v":2,"fc":%d,"template":%q,"kernel":%q,"rootfs":%q,"vcpus":%d,"mem_mb":%d,"mem_bytes":%d,"state_bytes":%d}`+"\n",
		s.format, s.template, s.kernel, s.rootfs, s.vcpus, s.memMB, s.memBytes, s.stateBytes)
}

func parseMeta(data []byte) (snapMeta, error) {
	f, err := protocol.DecodeFlat(data)
	// Version 1 (eight fields) was written before the format was recorded. It parses, with format 0, so a
	// resume names it a mismatch instead of an internal fault.
	if err != nil || (len(f) != 8 && len(f) != 9) {
		return snapMeta{}, errors.New("snapshot metadata is malformed")
	}
	str := func(k string) string { s, _ := f[k].(string); return s }
	num := func(k string) int64 { n, _ := protocol.PlainInt(f[k]); return n }
	m := snapMeta{str("template"), str("kernel"), str("rootfs"), num("vcpus"), num("mem_mb"), num("mem_bytes"), num("state_bytes"), num("fc")}
	if v := num("v"); (v != 1 || len(f) != 8) && (v != 2 || len(f) != 9 || m.format < 1) {
		return snapMeta{}, errors.New("snapshot metadata is malformed")
	}
	if !protocol.ValidID(m.template) || !validDigest(m.kernel) || !validDigest(m.rootfs) || m.vcpus < 1 || m.memMB < 1 || m.memBytes < 1 || m.stateBytes < 1 {
		return snapMeta{}, errors.New("snapshot metadata is malformed")
	}
	return m, nil
}

// openSnapshotDir opens snapshot_dir without following a symlink and requires a root-owned 0700 directory without an ACL.
func (m *Manager) openSnapshotDir(p string) (int, error) {
	fd, err := openAbs(p)
	if err != nil {
		return -1, err
	}
	if err := checkDirFd(fd, m.effUID(m.rootUID), m.effGID(0), snapDirMode); err != nil {
		closeFd(fd)
		return -1, err
	}
	// The directory must be writable too, not only readable: under ProtectSystem=strict a snapshot_dir that is not in
	// the unit's ReadWritePaths is a read-only mount, and would otherwise fail only at the first snapshot.
	if err := writableProbe(fd); err != nil {
		closeFd(fd)
		return -1, err
	}
	return fd, nil
}

// writableProbe is replaced by tests.
var writableProbe = probeWritable

// probeWritable makes and removes one directory in the directory fd.
func probeWritable(fd int) error {
	name := ".fx-write-probe-" + strconv.Itoa(os.Getpid())
	if err := syscall.Mkdirat(fd, name, 0o700); err != nil {
		return err
	}
	return unlinkat(fd, name, 0x200) // AT_REMOVEDIR
}

// sandboxIDs are the owner and group the sandbox's files have on disk.
func (m *Manager) sandboxIDs(s Spec) (uint32, uint32) {
	if m.remap != nil {
		return m.remap(s.UID, s.GID)
	}
	return s.UID, s.GID
}

// takeJailRoot takes every directory from the jail down to <jail>/<exec>/<id>/root back to root and opens the
// last one. Only after the sandbox process is gone, or for the short cleanup after a load.
func (m *Manager) takeJailRoot(id string) (int, error) {
	dir, err := takeOver(m.jailsFd, id, m.mayTake)
	for _, n := range []string{m.stg.exec, id, "root"} {
		if err != nil {
			return -1, err
		}
		var next int
		next, err = takeOver(dir, n, m.mayTake)
		closeFd(dir)
		dir = next
	}
	return dir, err
}

// pull moves one file the sandbox wrote in the jail root (name) into the snapshot directory dst as dstName
// and returns its size. The file is opened O_PATH without following a symlink and must be a single-link
// regular file of the sandbox uid and of an allowed size (exactly want when want > 0, otherwise 1..max bytes). The
// sandbox's VMM owns the file until it is given to root, so its size is not trusted before the check and the copy
// reads at most max bytes. The file is given to root, set to 0600 and read through /proc/self/fd.
func (m *Manager) pull(root int, name string, sp Spec, dst int, dstName string, want, max int64) (int64, error) {
	pfd, err := syscall.Openat(root, name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	defer closeFd(pfd)
	var st syscall.Stat_t
	wu, _ := m.sandboxIDs(sp)
	if err := syscall.Fstat(pfd, &st); err != nil {
		return 0, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Uid != wu {
		return 0, errSnapFile
	}
	if st.Size < 1 || st.Size > max || (want > 0 && st.Size != want) {
		return 0, errSnapSize
	}
	if err := fchownEmpty(pfd, reapUID, reapGID); err != nil {
		return 0, err
	}
	if err := syscall.Chmod(procFdPath(pfd), snapFileMode); err != nil {
		return 0, err
	}
	src, err := syscall.Open(procFdPath(pfd), syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	sf := os.NewFile(uintptr(src), "snapshot-source")
	defer sf.Close()
	var chk syscall.Stat_t
	if syscall.Fstat(src, &chk) != nil || chk.Dev != st.Dev || chk.Ino != st.Ino || chk.Uid != reapUID {
		return 0, errSnapFile
	}
	n, err := m.storeFile(sf, dst, dstName, max, st.Size)
	if err != nil {
		return 0, err
	}
	return n, unlinkat(root, name, 0)
}

// storeFile writes sf to a new 0600 file dstName below dst (exclusive, no symlink) and syncs it. It reads at most max+1
// bytes, so a file that grew after its size was checked costs one byte over the limit and no more, and it refuses
// unless exactly size bytes were copied (the size seen on the descriptor).
func (m *Manager) storeFile(sf io.Reader, dst int, dstName string, max, size int64) (int64, error) {
	fd, err := syscall.Openat(dst, dstName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, snapFileMode)
	if err != nil {
		return 0, err
	}
	df := os.NewFile(uintptr(fd), "snapshot")
	defer df.Close()
	n, err := copyPlain(df, io.LimitReader(sf, max+1))
	if err != nil {
		return 0, err
	}
	if n > max || n != size {
		return 0, errSnapSize // it grew or shrank after the size check
	}
	return n, df.Sync()
}

// copyPlain copies with read and write only. io.Copy between two files would use copy_file_range, which the
// unit's system call filter (@system-service) is not shown to allow; a denied call kills the process.
func copyPlain(dst *os.File, src io.Reader) (int64, error) {
	return io.CopyBuffer(struct{ io.Writer }{dst}, struct{ io.Reader }{src}, make([]byte, 1<<20))
}

// push copies the stored file name (which must be a root-owned single-link 0600 file of exactly size bytes)
// into the jail root as dstName, 0400 and owned by the sandbox, so that Firecracker can load it.
func (m *Manager) push(srcDir int, name string, size int64, root int, dstName string, sp Spec) error {
	fd, err := syscall.Openat(srcDir, name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	sf := os.NewFile(uintptr(fd), "snapshot-file")
	defer sf.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Uid != m.effUID(m.rootUID) || os.FileMode(st.Mode&0o7777) != snapFileMode || st.Size != size {
		return errSnapFile
	}
	dfd, err := syscall.Openat(root, dstName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, snapFileMode)
	if err != nil {
		return err
	}
	df := os.NewFile(uintptr(dfd), "snapshot-copy")
	defer df.Close()
	if _, err := copyPlain(df, sf); err != nil {
		return err
	}
	u, g := m.sandboxIDs(sp)
	if err := syscall.Fchmod(dfd, 0o400); err != nil { // mode first: after the chown the helper could not change it
		return err
	}
	return syscall.Fchown(dfd, int(u), int(g))
}

// Snapshot stops the running sandbox id into the new snapshot snap: the VM is paused and written out, then
// always stopped (nothing stays paused), the files are moved into snapshot_dir and the staged tree is
// removed. The sandbox stays prepared, so resume can start it again. A failure removes the snapshot.
func (m *Manager) Snapshot(id, snap string) (server.Reply, protocol.Code) {
	if m.snapFd < 0 {
		return server.Reply{}, protocol.Unavailable
	}
	if !protocol.ValidID(snap) {
		return server.Reply{}, protocol.BadID
	}
	b, release, code := m.reserve(id)
	if code != protocol.OK {
		return server.Reply{}, code
	}
	defer release(false)
	if b.inst == nil {
		return server.Reply{}, protocol.UnknownSandbox // prepared, but not running
	}
	sn, ok := b.inst.(Snapshotter)
	if !ok {
		return server.Reply{}, protocol.Unavailable
	}
	if !m.roomFor(m.snapFd, uint64(b.spec.MemMB)<<20+maxStateBytes) {
		return server.Reply{}, protocol.OverCap // too little free space for the two files; the VM is left as it was
	}
	sfd, err := m.mkdirOwned(m.snapFd, snap, snapDirMode, m.rootUID, 0)
	if errors.Is(err, syscall.EEXIST) {
		return server.Reply{}, protocol.BadID // as for a second prepare: an id in use is not usable
	}
	if err != nil {
		return server.Reply{}, protocol.Internal
	}
	defer closeFd(sfd)
	size, err := m.snapshotInto(b, sn, sfd)
	if err != nil {
		_ = removeAtOwned(m.snapFd, snap, m.mayTake)
		return server.Reply{}, protocol.Internal
	}
	return server.Reply{SnapshotBytes: size}, protocol.OK
}

func (m *Manager) snapshotInto(b *box, sn Snapshotter, sfd int) (int64, error) {
	werr := sn.Snapshot()
	if err := b.inst.Stop(); err != nil { // the registry still holds the instance, so destroy can retry
		return 0, fmt.Errorf("snapshot: the sandbox could not be stopped: %w", err)
	}
	b.inst = nil
	if werr != nil {
		_ = m.unstage(b.spec.ID)
		return 0, werr
	}
	size, err := m.collect(b, sfd)
	if err != nil {
		_ = m.unstage(b.spec.ID)
		return 0, err
	}
	if err := syscall.Fsync(sfd); err != nil {
		_ = m.unstage(b.spec.ID)
		return 0, err
	}
	return size, m.unstage(b.spec.ID)
}

// collect moves the two files out of the stopped sandbox's jail and writes the metadata.
func (m *Manager) collect(b *box, sfd int) (int64, error) {
	root, err := m.takeJailRoot(b.spec.ID)
	if err != nil {
		return 0, err
	}
	defer closeFd(root)
	mem, err := m.pull(root, jailMem, b.spec, sfd, storedMem, b.spec.MemMB<<20, b.spec.MemMB<<20)
	if err != nil {
		return 0, err
	}
	state, err := m.pull(root, jailState, b.spec, sfd, storedState, 0, maxStateBytes)
	if err != nil {
		return 0, err
	}
	meta := snapMeta{b.spec.Template, b.staged["kernel"], b.staged["rootfs"], b.spec.VCPUs, b.spec.MemMB, mem, state, SnapshotFormat}
	if !validDigest(meta.kernel) || !validDigest(meta.rootfs) {
		return 0, errors.New("snapshot: the sandbox has no verified template digests")
	}
	fd, err := syscall.Openat(sfd, metaName, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, snapFileMode)
	if err != nil {
		return 0, err
	}
	f := os.NewFile(uintptr(fd), "snapshot-meta")
	defer f.Close()
	if _, err := f.Write(meta.bytes()); err != nil {
		return 0, err
	}
	return mem + state, f.Sync()
}

// readMeta reads and checks the metadata of the snapshot directory sfd, and the size of its two files.
func (m *Manager) readMeta(sfd int) (snapMeta, error) {
	fd, err := syscall.Openat(sfd, metaName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return snapMeta{}, err
	}
	f := os.NewFile(uintptr(fd), "snapshot-meta")
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return snapMeta{}, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Uid != m.effUID(m.rootUID) || os.FileMode(st.Mode&0o7777) != snapFileMode || st.Size > maxMeta {
		return snapMeta{}, errSnapFile
	}
	data, err := io.ReadAll(io.LimitReader(f, maxMeta))
	if err != nil {
		return snapMeta{}, err
	}
	return parseMeta(data)
}

// Resume starts the prepared sandbox id from the stored snapshot snap: the template files are staged and
// verified as start does, the snapshot files are copied into the jail root, the pinned jailer starts
// Firecracker, and Firecracker loads and resumes the VM. The copies are removed from the jail as soon as it
// has loaded them. The snapshot stays stored; the runner decides when to delete it.
func (m *Manager) Resume(id, snap string) (server.Reply, protocol.Code) {
	if m.snapFd < 0 {
		return server.Reply{}, protocol.Unavailable
	}
	if !protocol.ValidID(snap) {
		return server.Reply{}, protocol.BadID
	}
	b, release, code := m.reserve(id)
	if code != protocol.OK {
		return server.Reply{}, code
	}
	defer release(false)
	if b.inst != nil {
		return server.Reply{}, protocol.BadID // already running: nothing to resume
	}
	sfd, err := openChild(m.snapFd, snap)
	if errors.Is(err, syscall.ENOENT) {
		return server.Reply{}, protocol.UnknownSnapshot
	}
	if err != nil {
		return server.Reply{}, protocol.Internal
	}
	defer closeFd(sfd)
	if checkDirFd(sfd, m.effUID(m.rootUID), m.effGID(0), snapDirMode) != nil {
		return server.Reply{}, protocol.Internal
	}
	meta, err := m.readMeta(sfd)
	if err != nil {
		return server.Reply{}, protocol.Internal
	}
	digests, code := m.lookup(b.spec.Template)
	if code != protocol.OK {
		return server.Reply{}, code
	}
	if meta.format != SnapshotFormat {
		return server.Reply{}, protocol.SnapshotMismatch // written under another Firecracker snapshot format: it would not load
	}
	if meta.template != b.spec.Template || meta.vcpus != b.spec.VCPUs || meta.memMB != b.spec.MemMB || meta.kernel != digests["kernel"] || meta.rootfs != digests["rootfs"] {
		return server.Reply{}, protocol.SnapshotMismatch
	}
	if !m.roomFor(m.jailsFd, uint64(meta.memBytes)+uint64(meta.stateBytes)) {
		return server.Reply{}, protocol.OverCap // the jail's filesystem cannot take the copies with room to spare
	}
	place := func(root int) error {
		if err := m.push(sfd, storedMem, meta.memBytes, root, jailMem, b.spec); err != nil {
			return err
		}
		return m.push(sfd, storedState, meta.stateBytes, root, jailState, b.spec)
	}
	if err := m.stage(b.spec, digests, place); err != nil {
		if errors.Is(err, errHash) {
			return server.Reply{}, protocol.SnapshotMismatch // the template files no longer are the ones in the manifest
		}
		return server.Reply{}, protocol.Internal
	}
	sp := b.spec
	sp.Resume = true
	inst, err := m.Launcher.Launch(sp)
	if err != nil || inst == nil {
		_ = m.unstage(id)
		if errors.Is(err, ErrUnavailable) {
			return server.Reply{}, protocol.Unavailable
		}
		return server.Reply{}, protocol.Internal
	}
	if err := m.dropSnapshotFiles(b.spec); err != nil {
		_ = inst.Stop()
		_ = m.unstage(id)
		return server.Reply{}, protocol.Internal
	}
	b.inst, b.staged = inst, digests
	return server.Reply{VsockDir: b.spec.VsockDir, SandboxGID: b.spec.GID}, protocol.OK
}

// dropSnapshotFiles removes the copies of the snapshot from a loaded sandbox's jail root (Firecracker holds
// the memory file mapped, so deleting its name is safe). The sandbox owns that directory, so it is taken to
// root for the unlink and given back at once; nothing in it is opened or followed.
func (m *Manager) dropSnapshotFiles(sp Spec) error {
	root, err := m.takeJailRoot(sp.ID)
	if err != nil {
		return err
	}
	defer closeFd(root)
	err = errors.Join(unlinkat(root, jailMem, 0), unlinkat(root, jailState, 0))
	u, g := m.sandboxIDs(sp)
	return errors.Join(err, fchownEmpty(root, u, g))
}

// SnapshotDelete removes the stored snapshot snap.
func (m *Manager) SnapshotDelete(snap string) protocol.Code {
	if m.snapFd < 0 {
		return protocol.Unavailable
	}
	if !protocol.ValidID(snap) {
		return protocol.BadID
	}
	if fd, err := openChild(m.snapFd, snap); errors.Is(err, syscall.ENOENT) {
		return protocol.UnknownSnapshot
	} else if err != nil {
		return protocol.Internal
	} else {
		closeFd(fd)
	}
	if removeAtOwned(m.snapFd, snap, m.mayTake) != nil {
		return protocol.Internal
	}
	return protocol.OK
}
