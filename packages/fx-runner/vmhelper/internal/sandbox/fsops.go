//go:build linux

package sandbox

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"fx-vmhelper/internal/protocol"
)

const (
	dirFlags = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	atRemove = 0x200 // AT_REMOVEDIR
	maxPath  = 4096
)

// depthLimit bounds how deep removeAt descends into a jail directory a guest could have shaped. The walk is
// iterative and holds one descriptor per level, so the bound is also a bound on descriptors: main raises the
// soft RLIMIT_NOFILE to cover it. A tree deeper than this is refused (Destroy answers internal and the
// sandbox stays registered) rather than followed without limit.
var depthLimit = 2048

var (
	errBadPath = errors.New("path is not absolute and clean, or holds a NUL or '..'")
	errBadName = errors.New("name is not one plain path component")
	errNotDir  = errors.New("not a real directory")
	errOwner   = errors.New("wrong owner or mode")
	errACL     = errors.New("directory carries a POSIX ACL")
	errMount   = errors.New("a directory below is a mount point")
	errNoMount = errors.New("mount identity cannot be established")
	errDeep    = errors.New("directory tree is deeper than the limit")
)

// Test seams. Each is nil or the real implementation in production.
var (
	hookRemove func(parent int, name string) // called between a failed unlink (EISDIR) and the no-follow open
	hookMkdir  func(parent int, name string) // called between mkdirat and the no-follow open
	hookRmdir  func(parent int, name string) // called before a directory is removed, after it was emptied
	listFn     = list                        // the directory listing; a test makes it fail
)

// cleanAbs refuses anything but an absolute path that path.Clean would leave unchanged: no "..", no ".",
// no doubled or trailing slash, no NUL.
func cleanAbs(p string) error {
	if p == "" || len(p) > maxPath || !path.IsAbs(p) || strings.ContainsRune(p, 0) || path.Clean(p) != p {
		return errBadPath
	}
	return nil
}

// plainName reports whether s is one path component that can be handed to openat/unlinkat.
func plainName(s string) bool {
	return s != "" && s != "." && s != ".." && len(s) <= 255 && !strings.ContainsAny(s, "/\x00")
}

func closeFd(fd int) { _ = syscall.Close(fd) }

// openAbs opens an absolute directory one component at a time, each with O_NOFOLLOW, so a symlink at any
// level (not just the last) is refused. The returned descriptor is the only handle later work uses.
func openAbs(p string) (int, error) { return openAbsAs(p, dirFlags) }

// openAbsAs is openAbs with the flags of the last component chosen by the caller: every ancestor is opened
// for search, the last one as asked (pathDirFlags needs no read access to it).
func openAbsAs(p string, last int) (int, error) {
	if err := cleanAbs(p); err != nil {
		return -1, err
	}
	fd, err := syscall.Open("/", dirFlags, 0)
	if err != nil {
		return -1, err
	}
	if p == "/" {
		return fd, nil
	}
	comps := strings.Split(p[1:], "/")
	for i, comp := range comps {
		flags := dirFlags
		if i == len(comps)-1 {
			flags = last
		}
		next, err := syscall.Openat(fd, comp, flags, 0)
		closeFd(fd)
		if err != nil {
			return -1, fmt.Errorf("open %q: %w", comp, err)
		}
		fd = next
	}
	return fd, nil
}

func openChild(parent int, name string) (int, error) {
	if !plainName(name) {
		return -1, errBadName
	}
	return syscall.Openat(parent, name, dirFlags, 0)
}

// ---- POSIX ACLs ----------------------------------------------------------------------------------------
//
// A default ACL on a parent is inherited by every directory made below it, and an access ACL grants named
// users and groups bits that the 01770 mode does not show. Either would break the isolation between
// sandboxes, so a directory that carries one is refused, and a directory the helper creates is stripped of
// both before any owner or mode is set.

var aclNames = []string{"system.posix_acl_access", "system.posix_acl_default"}

// xattrProbe reports whether the named extended attribute exists on fd; xattrRemove deletes it. Both are
// variables so a test can stand for a filesystem that holds an ACL.
var (
	xattrProbe  = realProbe
	xattrRemove = realRemove
)

func noXattr(e error) bool {
	return errors.Is(e, syscall.ENODATA) || errors.Is(e, syscall.ENOTSUP) || errors.Is(e, syscall.EOPNOTSUPP)
}

func realProbe(fd int, name string) (bool, error) {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return false, err
	}
	_, _, e := syscall.Syscall6(syscall.SYS_FGETXATTR, uintptr(fd), uintptr(unsafe.Pointer(p)), 0, 0, 0, 0)
	switch {
	case e == 0:
		return true, nil
	case noXattr(e):
		return false, nil // no such attribute, or a filesystem without extended attributes
	}
	return false, e
}

func realRemove(fd int, name string) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall(syscall.SYS_FREMOVEXATTR, uintptr(fd), uintptr(unsafe.Pointer(p)), 0)
	if e != 0 {
		return e
	}
	return nil
}

// hasACL reports whether fd carries an access or a default ACL. An error other than "none there" fails closed.
func hasACL(fd int) (bool, error) {
	for _, n := range aclNames {
		ok, err := xattrProbe(fd, n)
		if err != nil || ok {
			return true, err
		}
	}
	return false, nil
}

// stripACL removes both ACL attributes from fd; one that is not there is fine.
func stripACL(fd int) error {
	for _, n := range aclNames {
		if err := xattrRemove(fd, n); err != nil && !noXattr(err) {
			return err
		}
	}
	return nil
}

// checkDirStat requires fd (which may be an O_PATH descriptor) to be a directory with exactly this owner,
// group and permission bits.
func checkDirStat(fd int, uid, gid uint32, mode os.FileMode) error {
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		return errNotDir
	}
	if st.Uid != uid || st.Gid != gid || os.FileMode(st.Mode&0o7777) != mode {
		return errOwner
	}
	return nil
}

// checkDirFd is checkDirStat, and the directory must carry no ACL.
func checkDirFd(fd int, uid, gid uint32, mode os.FileMode) error {
	if err := checkDirStat(fd, uid, gid, mode); err != nil {
		return err
	}
	if acl, err := hasACL(fd); acl || err != nil {
		return errACL
	}
	return nil
}

func unlinkat(dir int, name string, flags uintptr) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(dir), uintptr(unsafe.Pointer(p)), flags)
	if e != 0 {
		return e
	}
	return nil
}

// reapUID and reapGID are who a directory is handed to before it is emptied: root. Tests set their own ids.
var reapUID, reapGID uint32

// fchownEmpty changes the owner of the object behind an O_PATH descriptor (AT_EMPTY_PATH): no name is
// resolved, so nothing can be swapped in between the checks made on fd and the change.
func fchownEmpty(fd int, uid, gid uint32) error {
	empty, _ := syscall.BytePtrFromString("")
	_, _, e := syscall.Syscall6(syscall.SYS_FCHOWNAT, uintptr(fd), uintptr(unsafe.Pointer(empty)), uintptr(uid), uintptr(gid), atEmptyPath, 0)
	if e != 0 {
		return e
	}
	return nil
}

// pathDirFlags opens a directory for inspection only: no read access is needed (the helper holds no
// CAP_DAC_OVERRIDE), fstat works on the descriptor, and a symlink is not followed.
const oPath = 0x200000 // O_PATH, the same on amd64 and arm64 (the syscall package does not export it)

const pathDirFlags = oPath | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC

// takeOver gives the directory name below parent to root and opens it for listing. Everything is decided on
// one descriptor: name is opened O_PATH without following a symlink and without crossing a mount, the owner
// must be one that may legitimately hold a directory in this tree (mayOwn; nil means any), then the owner is
// changed (AT_EMPTY_PATH, CAP_CHOWN only), the mode is set to 0700 through /proc/self/fd (so a sandbox that
// closed its own directory cannot make it undeletable), and the directory is reopened through the same
// descriptor. A name swapped for a link to a file, a symlink or a directory of a stranger is refused before
// anything is changed.
func takeOver(parent int, name string, mayOwn func(uint32) bool) (int, error) {
	pfd, err := openDirSameMountAs(parent, name, pathDirFlags)
	if err != nil {
		return -1, err
	}
	defer closeFd(pfd)
	var st syscall.Stat_t
	if err := syscall.Fstat(pfd, &st); err != nil {
		return -1, err
	}
	// (O_DIRECTORY on the open already made it a directory.)
	if mayOwn != nil && !mayOwn(st.Uid) {
		return -1, errOwner
	}
	if err := fchownEmpty(pfd, reapUID, reapGID); err != nil {
		return -1, err
	}
	proc := "/proc/self/fd/" + strconv.Itoa(pfd)
	if err := syscall.Chmod(proc, uint32(JailDirMode)); err != nil {
		return -1, err
	}
	return syscall.Open(proc, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
}

// ---- mount identity ------------------------------------------------------------------------------------
//
// st_dev alone does not see a bind mount of a directory from the same filesystem. A directory is treated as
// a mount point when openat2 with RESOLVE_NO_XDEV refuses it, or, where that is unavailable, when its
// statx mount id differs from its parent's; st_dev is compared as well. If none of these can tell, the
// descent is refused.

const (
	resolveNoXdev      = 0x01
	resolveNoMagiclink = 0x02
	resolveNoSymlinks  = 0x04
	statxMntID         = 0x1000
	atEmptyPath        = 0x1000
	atSymlinkNofollow  = 0x100
	sysOpenat2         = 437 // the same number on amd64 and arm64
)

// useOpenat2 and mntIDOf are test seams: a test turns the first off, or replaces the second, to exercise a
// later layer on its own.
var (
	useOpenat2 = true
	mntIDOf    = statxMountID
)

type openHow struct{ flags, mode, resolve uint64 }

// openat2Dir opens name below parent as a directory with no symlink and no mount crossing. ENOSYS or EPERM
// (an old kernel, or a seccomp filter without openat2) means "cannot tell": ok is false.
func openat2Dir(parent int, name string, flags int) (fd int, ok bool, err error) {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return -1, true, err
	}
	how := openHow{flags: uint64(flags), resolve: resolveNoXdev | resolveNoSymlinks | resolveNoMagiclink}
	r, _, e := syscall.Syscall6(sysOpenat2, uintptr(parent), uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
	switch {
	case e == 0:
		return int(r), true, nil
	case e == syscall.ENOSYS || e == syscall.EPERM || e == syscall.E2BIG:
		return -1, false, nil
	case e == syscall.EXDEV:
		return -1, true, errMount
	}
	return -1, true, e
}

// statxMountID returns the mount id of the file behind fd, or ok=false when the kernel does not report it.
func statxMountID(fd int) (id uint64, ok bool) {
	if statxNum == 0 {
		return 0, false
	}
	var buf [256]byte
	empty, _ := syscall.BytePtrFromString("")
	_, _, e := syscall.Syscall6(statxNum, uintptr(fd), uintptr(unsafe.Pointer(empty)), atEmptyPath|atSymlinkNofollow, statxMntID, uintptr(unsafe.Pointer(&buf[0])), 0)
	if e != 0 || binary.NativeEndian.Uint32(buf[0:4])&statxMntID == 0 {
		return 0, false
	}
	return binary.NativeEndian.Uint64(buf[144:152]), true
}

// openDirSameMount opens the directory name below parent without following a symlink and without crossing
// a mount point of any kind; a mount point answers errMount.
func openDirSameMount(parent int, name string) (int, error) {
	return openDirSameMountAs(parent, name, dirFlags)
}

// openDirSameMountAs is openDirSameMount with the open flags chosen by the caller (O_PATH for a look that
// needs no read access).
func openDirSameMountAs(parent int, name string, flags int) (int, error) {
	if !plainName(name) {
		return -1, errBadName
	}
	fd, viaOpenat2 := -1, false
	if useOpenat2 {
		f, ok, err := openat2Dir(parent, name, flags)
		if err != nil {
			return -1, err
		}
		fd, viaOpenat2 = f, ok
	}
	if !viaOpenat2 {
		f, err := syscall.Openat(parent, name, flags, 0)
		if err != nil {
			return -1, err
		}
		fd = f
	}
	var ps, cs syscall.Stat_t
	if err := syscall.Fstat(parent, &ps); err != nil {
		closeFd(fd)
		return -1, err
	}
	if err := syscall.Fstat(fd, &cs); err != nil {
		closeFd(fd)
		return -1, err
	}
	if cs.Dev != ps.Dev {
		closeFd(fd)
		return -1, errMount
	}
	if !viaOpenat2 {
		pid, ok1 := mntIDOf(parent)
		cid, ok2 := mntIDOf(fd)
		switch {
		case !ok1 || !ok2:
			closeFd(fd)
			return -1, errNoMount
		case pid != cid:
			closeFd(fd)
			return -1, errMount
		}
	}
	return fd, nil
}

// ---- removal -------------------------------------------------------------------------------------------

type frame struct {
	parent int // the descriptor name is removed through (the previous frame's, or the caller's)
	name   string
	fd     int
	names  []string
	next   int
}

// removeAt deletes name below parent without following a symlink anywhere and without crossing a mount
// point. A non-directory is unlinked (a symlink is removed itself, never entered). A directory is opened
// with O_NOFOLLOW and no mount crossing, emptied, then removed. The walk is iterative with a descriptor per
// level, bounded by depthLimit; anything it cannot finish is an error and leaves what remains in place.
func removeAt(parent int, name string) error { return removeAtOwned(parent, name, nil) }

// removeAtOwned is removeAt that takes over only directories whose owner mayOwn accepts (nil: any owner).
func removeAtOwned(parent int, name string, mayOwn func(uint32) bool) error {
	if !plainName(name) {
		return errBadName
	}
	isDir, err := unlinkOrDir(parent, name)
	if err != nil || !isDir {
		return err
	}
	var stack []frame
	defer func() {
		for _, f := range stack {
			closeFd(f.fd)
		}
	}()
	push := func(parentFd int, n string) error {
		if len(stack) >= depthLimit {
			return errDeep
		}
		fd, err := takeOver(parentFd, n, mayOwn)
		if err != nil {
			return err // a symlink, a file or a stranger's directory swapped in is refused here
		}
		names, err := listFn(fd)
		if err != nil {
			closeFd(fd)
			return err
		}
		stack = append(stack, frame{parent: parentFd, name: n, fd: fd, names: names})
		return nil
	}
	if hookRemove != nil {
		hookRemove(parent, name)
	}
	if err := push(parent, name); err != nil {
		return err
	}
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		if top.next < len(top.names) {
			n := top.names[top.next]
			top.next++
			if !plainName(n) {
				return errBadName
			}
			isDir, err := unlinkOrDir(top.fd, n)
			if err != nil {
				return err
			}
			if isDir {
				if hookRemove != nil {
					hookRemove(top.fd, n)
				}
				if err := push(top.fd, n); err != nil {
					return err
				}
			}
			continue
		}
		f := *top
		closeFd(f.fd)
		stack = stack[:len(stack)-1]
		if hookRmdir != nil {
			hookRmdir(f.parent, f.name)
		}
		if err := unlinkat(f.parent, f.name, atRemove); err != nil {
			return err
		}
	}
	return nil
}

// unlinkOrDir unlinks name below dir. It reports isDir when name is a directory (unlink answers EISDIR, or
// EPERM on some kernels); a name that is already gone is success.
func unlinkOrDir(dir int, name string) (isDir bool, err error) {
	err = unlinkat(dir, name, 0)
	switch {
	case err == nil || errors.Is(err, syscall.ENOENT):
		return false, nil
	case errors.Is(err, syscall.EISDIR) || errors.Is(err, syscall.EPERM):
		return true, nil
	}
	return false, err
}

// list returns the entry names of the directory behind fd (not "." and "..").
func list(fd int) ([]string, error) {
	nfd, err := syscall.Openat(fd, ".", dirFlags, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(nfd), "dir")
	defer f.Close()
	return f.Readdirnames(-1)
}

// ---- the consumer's view of a vsock directory ------------------------------------------------------------

// ValidateVsockDir is the lexical check a consumer (the daemon, the egress proxy) makes before it uses a
// vsock_dir from a helper reply: the id matches the id pattern, the path is absolute and clean (so no "..",
// no NUL), and its last component is exactly the id.
func ValidateVsockDir(p, id string) error {
	if !protocol.ValidID(id) {
		return errors.New("bad sandbox id")
	}
	if err := cleanAbs(p); err != nil {
		return err
	}
	if path.Base(p) != id {
		return errors.New("vsock_dir basename is not the sandbox id")
	}
	return nil
}

// Policy is what a consumer knows about the layout from the helper's config and a reply.
type Policy struct {
	JailRoot  string // the helper's jail_root
	RootUID   uint32 // owner of jail_root and vsock (0 in production)
	RootGID   uint32 // their group (0 in production)
	RunnerUID uint32 // owner of every vsock/<id>
}

// OpenVsockDir is the full consumer-side check, and it returns the verified directory. The path must be
// exactly <jail_root>/vsock/<id> (ValidateVsockDir first); jail_root is opened one component at a time with
// O_NOFOLLOW; jail_root and vsock must each be a real directory owned by the policy's root owner with the
// contract mode and no ACL; and vsock/<id> must be a real directory owned by the runner uid, with group
// sandboxGID, mode VsockDirMode and no ACL. The caller does every later access with openat on the returned
// descriptor and closes it; it must not reopen the path.
func OpenVsockDir(pol Policy, p, id string, sandboxGID uint32) (int, error) {
	return openVsockDirAs(pol, p, id, sandboxGID, false)
}

// openVsockDirAs is OpenVsockDir. With pathOnly the last component is opened O_PATH and checked from fstat
// alone, which needs no read access: that is how the helper checks its own directory, which (01770, the
// runner as owner, the sandbox gid) is closed to root unless CAP_DAC_OVERRIDE is raised. The ACL of that directory
// was stripped and checked by mkdirOwned on its own descriptor. A consumer running as the runner uid uses
// OpenVsockDir, which opens it for reading and checks the ACL too.
func openVsockDirAs(pol Policy, p, id string, sandboxGID uint32, pathOnly bool) (int, error) {
	if err := ValidateVsockDir(p, id); err != nil {
		return -1, err
	}
	if err := cleanAbs(pol.JailRoot); err != nil || p != pol.JailRoot+"/vsock/"+id {
		return -1, errors.New("vsock_dir is not below jail_root/vsock")
	}
	rfd, err := openAbs(pol.JailRoot)
	if err != nil {
		return -1, err
	}
	defer closeFd(rfd)
	if err := checkDirFd(rfd, pol.RootUID, pol.RootGID, RootMode); err != nil {
		return -1, fmt.Errorf("jail_root: %w", err)
	}
	vfd, err := openChild(rfd, "vsock")
	if err != nil {
		return -1, err
	}
	defer closeFd(vfd)
	if err := checkDirFd(vfd, pol.RootUID, pol.RootGID, VsockRootMode); err != nil {
		return -1, fmt.Errorf("vsock root: %w", err)
	}
	if !plainName(id) {
		return -1, errBadName
	}
	flags := dirFlags
	if pathOnly {
		flags = pathDirFlags
	}
	fd, err := syscall.Openat(vfd, id, flags, 0)
	if err != nil {
		return -1, err
	}
	check := checkDirFd
	if pathOnly {
		check = checkDirStat
	}
	if err := check(fd, pol.RunnerUID, sandboxGID, VsockDirMode); err != nil {
		closeFd(fd)
		return -1, err
	}
	return fd, nil
}
