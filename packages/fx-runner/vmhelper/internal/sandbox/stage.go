//go:build linux

package sandbox

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"syscall"
	"unsafe"

	"fx-vmhelper/internal/protocol"
)

// Staging builds what the jailer finds before it runs, below the sandbox's jail directory:
//
//	<jail>/<exec name>/<id>/root/kernel   0400, sandbox uid:gid  copy of the template's kernel
//	<jail>/<exec name>/<id>/root/rootfs   0400, sandbox uid:gid  copy of the template's root disk
//	<jail>/<exec name>/<id>/root/vsock    mount point; vsock/<id> is bind-mounted on it (nosuid,nodev,noexec)
//
// The jail directory is handed to root first (as the launcher does), because the helper holds no
// CAP_DAC_OVERRIDE. Every step is an openat/mkdirat on a descriptor, O_NOFOLLOW, and the template files are
// opened through the same root-owned chain check as the binaries. Any failure removes the whole tree again.

// maxTemplateFile bounds one copied template file.
var maxTemplateFile int64 = 16 << 30

var (
	errHash   = errors.New("template file does not match the manifest digest")
	errTooBig = errors.New("template file is over the size limit")
)

// stager is the configuration of staging, taken from the root-owned config.
type stager struct {
	manifest, dir, exec string
	chainBase           string // "/" unless a test says otherwise
}

// lookup answers the manifest's digests for a template id: UnknownTemplate for an id the manifest does not
// hold, Internal when the manifest cannot be read or is malformed.
func (m *Manager) lookup(id string) (map[string]string, protocol.Code) {
	mf, err := LoadManifest(m.stg.chainBase, m.stg.manifest, m.effUID(m.rootUID))
	if err != nil {
		return nil, protocol.Internal
	}
	d, ok := mf[id]
	if !ok {
		return nil, protocol.UnknownTemplate
	}
	return d, protocol.OK
}

// copyTemplate copies dir/<id>/<kind> into the directory behind rootFd as <kind>, hashing the bytes it
// writes. A digest mismatch removes the copy and answers errHash.
func (m *Manager) copyTemplate(rootFd int, s Spec, kind, want string) (err error) {
	src, err := openRootChain(m.stg.chainBase, m.stg.dir+"/"+s.Template+"/"+kind, m.effUID(m.rootUID))
	if err != nil {
		return err
	}
	sf := os.NewFile(uintptr(src), "template")
	defer sf.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(src, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != m.effUID(m.rootUID) || st.Mode&0o022 != 0 {
		return errors.New("template file is not a root-owned regular file")
	}
	dst, err := syscall.Openat(rootFd, kind, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	df := os.NewFile(uintptr(dst), "copy")
	defer func() {
		df.Close()
		if err != nil {
			_ = unlinkat(rootFd, kind, 0)
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(df, h), io.LimitReader(sf, maxTemplateFile+1))
	if err != nil {
		return err
	}
	if n > maxTemplateFile {
		return errTooBig
	}
	if hex.EncodeToString(h.Sum(nil)) != want {
		return errHash
	}
	// mode first, then owner: after the chown the helper could no longer change the mode (no CAP_FOWNER)
	if err := syscall.Fchmod(dst, 0o400); err != nil {
		return err
	}
	u, g := s.UID, s.GID
	if m.remap != nil {
		u, g = m.remap(u, g)
	}
	return syscall.Fchown(dst, int(u), int(g))
}

// stage builds the tree above for s. On any error it has removed what it built (and unmounted), or says
// that it could not.
func (m *Manager) stage(s Spec, digests map[string]string) (err error) {
	jfd, err := takeOver(m.jailsFd, s.ID, m.mayTake) // root-owned, 0700, readable: the sandbox owned it
	if err != nil {
		return err
	}
	defer closeFd(jfd)
	defer func() {
		if err != nil {
			if uerr := m.unstage(s.ID); uerr != nil {
				err = fmt.Errorf("%w; and the cleanup failed: %v", err, uerr)
			}
		}
	}()
	dir := jfd
	for _, n := range []string{m.stg.exec, s.ID, "root"} {
		next, err := m.mkdirChild(dir, n)
		if dir != jfd {
			closeFd(dir)
		}
		if err != nil {
			return err
		}
		dir = next
	}
	defer closeFd(dir)
	for _, kind := range templateKinds {
		if err := m.copyTemplate(dir, s, kind, digests[kind]); err != nil {
			return err
		}
	}
	mp, err := m.mkdirChild(dir, "vsock")
	if err != nil {
		return err
	}
	defer closeFd(mp)
	var onDiskGID = s.GID
	if m.remap != nil {
		_, onDiskGID = m.remap(m.runnerUID, s.GID)
	}
	src, err := openVsockDirAs(m.policy(), s.VsockDir, s.ID, onDiskGID, true)
	if err != nil {
		return err
	}
	defer closeFd(src)
	return mountVsock(src, mp, dir)
}

// mountVsock binds src onto the mount point mp (a directory of dir) and then checks, with a fresh no-follow
// open, that what the mount point now reaches is the very directory that was mounted. It is a variable
// because mounting needs CAP_SYS_ADMIN: tests that are not root's replace it, and the ones that run in a
// user and mount namespace use this one. bindFn is the mount itself, a variable so that a test can make it
// mount the wrong directory.
var bindFn = bindMount

var mountVsock = func(src, mp, dir int) error {
	if err := bindFn(src, mp, dir); err != nil {
		return err
	}
	top, err := openPathChild(dir, "vsock")
	if err != nil {
		return err
	}
	defer closeFd(top)
	var a, b syscall.Stat_t
	if syscall.Fstat(src, &a) != nil || syscall.Fstat(top, &b) != nil || a.Dev != b.Dev || a.Ino != b.Ino {
		return errors.New("the vsock directory is not mounted where it should be")
	}
	// the flags are asserted on the mount that is there, whichever way it was made
	var sf syscall.Statfs_t
	if err := syscall.Fstatfs(top, &sf); err != nil {
		return err
	}
	if sf.Flags&msNosuidNodevExe != msNosuidNodevExe {
		return errors.New("the vsock mount lacks nosuid, nodev or noexec")
	}
	return nil
}

// mkdirChild makes name (mode 0700, a fresh directory: an existing one is an error) below parent and opens it.
func (m *Manager) mkdirChild(parent int, name string) (int, error) {
	if !plainName(name) {
		return -1, errBadName
	}
	if err := syscall.Mkdirat(parent, name, 0o700); err != nil {
		return -1, err
	}
	return openChild(parent, name)
}

// openPathChild opens name below parent as a directory with O_PATH and no symlink following. O_PATH needs
// no permission on the directory itself, which matters at and below the vsock mount point: it then shows
// the sandbox's 0710 directory, closed to root (the helper holds no CAP_DAC_OVERRIDE). The descriptor
// serves fstat, further O_PATH steps and the /proc/self/fd unmount.
func openPathChild(parent int, name string) (int, error) {
	if !plainName(name) {
		return -1, errBadName
	}
	return syscall.Openat(parent, name, pathDirFlags, 0)
}

// unstage unmounts the vsock mount of id and removes the staged tree. If the unmount fails nothing is
// removed.
func (m *Manager) unstage(id string) error {
	if err := m.unmountVsock(id); err != nil {
		return err
	}
	jfd, err := takeOver(m.jailsFd, id, m.mayTake)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	defer closeFd(jfd)
	return removeAtOwned(jfd, m.stg.exec, m.mayTake)
}

// unmountVsock unmounts <jail>/<exec>/<id>/root/vsock if something is mounted there. The path is walked by
// descriptor; a missing step means nothing was staged. A directory that is not a mount point answers EINVAL
// to the unmount, which is "nothing to do". The steps down to root/ are taken over (as removal does: owner
// check, no symlink, no mount crossing, owner root, mode 0700), because the sandbox owns them and may have
// closed them, and the helper cannot open a closed directory of another uid. They are about to be deleted.
func (m *Manager) unmountVsock(id string) error {
	dir, err := takeOver(m.jailsFd, id, m.mayTake)
	for _, n := range []string{m.stg.exec, id, "root"} {
		if err != nil {
			break
		}
		var next int
		next, err = takeOver(dir, n, m.mayTake)
		closeFd(dir)
		dir = next
	}
	if err == nil {
		defer closeFd(dir)
		// The mount point must be a plain directory entry here (a symlink is refused, and a missing one means
		// nothing was staged). This descriptor is closed again before the unmount: an open descriptor on the
		// mounted directory would itself make the mount busy.
		var chk int
		if chk, err = openPathChild(dir, "vsock"); err == nil {
			closeFd(chk)
		}
	}
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := umountAt(dir, "vsock"); err != nil && !errors.Is(err, syscall.EINVAL) {
		return err
	}
	return nil
}

// ---- bind mount by descriptor --------------------------------------------------------------------------

// The mount is made from descriptors, not paths: open_tree(src, "", OPEN_TREE_CLONE|AT_EMPTY_PATH) clones
// exactly the directory src refers to, and move_mount puts that clone on exactly the directory dst refers
// to, so no path component can be swapped for a symlink between the check and the mount. Where the kernel
// lacks open_tree (before 5.2: ENOSYS) or mount_setattr (before 5.12: ENOSYS; the clone is then dropped), the fallback is mount(2) with the two /proc/self/fd/N magic links as
// the paths. They too name the open directories, not a path to be resolved again, so the property is the
// same; the reason for the fallback is only the missing syscall, and nosuid,nodev,noexec are then applied
// by a remount of the bind.

const (
	sysOpenTree      = 428 // the same number on every architecture the helper supports
	sysMoveMount     = 429
	sysMountSetattr  = 442
	openTreeClone    = 1
	moveFromEmpty    = 0x4
	moveToEmpty      = 0x40
	mountAttrNosuid  = 0x2
	mountAttrNodev   = 0x4
	mountAttrNoexec  = 0x8
	msNosuidNodevExe = syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC
)

// bindMount has a test seam only in that a test may force the fallback (useOpenTree).
var useOpenTree = true

// mountSetattr sets nosuid,nodev,noexec on the detached clone tfd. A variable so that a test can answer ENOSYS.
var mountSetattr = func(tfd int) error {
	empty, _ := syscall.BytePtrFromString("")
	attr := struct{ set, clr, prop, userns uint64 }{set: mountAttrNosuid | mountAttrNodev | mountAttrNoexec}
	if _, _, e := syscall.Syscall6(sysMountSetattr, uintptr(tfd), uintptr(unsafe.Pointer(empty)), atEmptyPath, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0); e != 0 {
		return e
	}
	return nil
}

func procFdPath(fd int) string { return "/proc/self/fd/" + strconv.Itoa(fd) }

func bindMount(src, dst, parent int) error {
	if useOpenTree {
		empty, _ := syscall.BytePtrFromString("")
		t, _, e := syscall.Syscall(sysOpenTree, uintptr(src), uintptr(unsafe.Pointer(empty)), openTreeClone|syscall.O_CLOEXEC|atEmptyPath)
		if e == 0 {
			tfd := int(t)
			defer closeFd(tfd)
			if err := mountSetattr(tfd); err == nil {
				if _, _, e := syscall.Syscall6(sysMoveMount, uintptr(tfd), uintptr(unsafe.Pointer(empty)), uintptr(dst), uintptr(unsafe.Pointer(empty)), moveFromEmpty|moveToEmpty, 0); e != 0 {
					return e
				}
				return nil
			} else if err != syscall.ENOSYS {
				return err
			}
		} else if e != syscall.ENOSYS {
			return e
		}
	}
	if err := syscall.Mount(procFdPath(src), procFdPath(dst), "", syscall.MS_BIND, ""); err != nil {
		return err
	}
	// the remount names the mount by path from the parent: dst itself is the directory under the mount
	return syscall.Mount("", procFdPath(parent)+"/vsock", "", syscall.MS_REMOUNT|syscall.MS_BIND|msNosuidNodevExe, "")
}

// umountAt unmounts what is mounted on name below the directory parent (no flags but UMOUNT_NOFOLLOW: a
// busy mount stays, and a symlink in the last place is not followed). The path is the parent's
// /proc/self/fd link plus one plain name. A directory that is not a mount point answers EINVAL.
var umountAt = func(parent int, name string) error {
	return syscall.Unmount(procFdPath(parent)+"/"+name, 8)
}
