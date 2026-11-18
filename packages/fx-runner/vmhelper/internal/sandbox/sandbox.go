//go:build linux

// Package sandbox is the helper's registry of prepared sandboxes: it allocates each one a uid and gid from
// the configured ranges, builds its jail directory and vsock directory under the one jail root with the
// permissions the contract names, drives a Launcher to start it, and removes everything it owns on destroy
// and on start-up reaping.
//
// Layout below config jail_root (all built by the helper, never from caller input):
//
//	<jail_root>          0711 root:root   traversable, so a runner can reach its own vsock directory
//	<jail_root>/jails    0700 root:root   one directory per sandbox, 0700, owner = the sandbox uid:gid
//	<jail_root>/vsock    0711 root:root
//	<jail_root>/vsock/<id>   0710, owner = runner uid, group = the sandbox's gid
//	<jail_root>/vsock/<id>/<uds>_<port>   0660, same owner and group (made by the launcher; the
//	                                       launcher change checks it)
//
// The sandbox's own uid reaches its directory through the group's x bit; another sandbox (other gid) has
// neither x nor r, so it can neither traverse nor list. The runner (the owner) can list its own.
//
// The registry is the in-memory map; it is derived, not stamped: ids in use are whatever the map holds, and
// start-up reaping removes any on-disk directory that the (empty) map does not know.
package sandbox

import (
	"errors"
	"os"
	"sort"
	"sync"
	"syscall"
	"time"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/protocol"
	"fx-vmhelper/internal/server"
)

// Directory and file modes of the contract.
const (
	RootMode      os.FileMode = 0o711
	JailsMode     os.FileMode = 0o700
	VsockRootMode os.FileMode = 0o711
	VsockDirMode  os.FileMode = 0o710
	JailDirMode   os.FileMode = 0o700
	SocketMode    os.FileMode = 0o660
)

// Spec is what a Launcher is given. Every field is a validated value the helper built; none is caller text
// except ID and Template, which matched the id pattern.
type Spec struct {
	ID, Template      string
	UID, GID          uint32
	JailDir, VsockDir string
	VCPUs, MemMB      int64
}

// Instance is a started sandbox.
type Instance interface{ Stop() error }

// Launcher starts a sandbox. The real jailer launch is a later change; tests use a fake.
type Launcher interface {
	Launch(Spec) (Instance, error)
}

// ErrUnavailable is what a Launcher answers when this build cannot launch; start maps it to "unavailable".
var ErrUnavailable = errors.New("launch unavailable in this build")

// NoLauncher is the launcher of a build that has none.
type NoLauncher struct{}

func (NoLauncher) Launch(Spec) (Instance, error) { return nil, ErrUnavailable }

type box struct {
	spec    Spec
	created time.Time
	inst    Instance
}

// Manager implements server.Backend. It is safe for concurrent use; one lock covers the whole registry.
type Manager struct {
	Launcher Launcher
	Now      func() time.Time

	root      string
	rootUID   uint32 // owner of the root, jails and vsock directories: 0 in production
	runnerUID uint32
	uidFirst  uint32
	uidCount  uint32
	gidFirst  uint32
	gidCount  uint32
	maxBoxes  int64
	maxVCPUs  int64
	maxMemMB  int64
	jailsFd   int
	vsockFd   int
	remap     func(uid, gid uint32) (uint32, uint32) // tests only: map a nominal owner onto one the test can really chown to
	mu        sync.Mutex
	boxes     map[string]*box
}

// New opens the jail root (every component without following a symlink), requires it to be a directory
// owned by root with mode RootMode, and makes or verifies its jails and vsock directories.
func New(cfg config.Config, l Launcher) (*Manager, error) {
	return newManager(cfg, l, 0, nil)
}

func newManager(cfg config.Config, l Launcher, rootUID uint32, remap func(uint32, uint32) (uint32, uint32)) (*Manager, error) {
	m := &Manager{Launcher: l, Now: time.Now, root: cfg.JailRoot, rootUID: rootUID, runnerUID: cfg.RunnerUID,
		uidFirst: cfg.UIDFirst, uidCount: cfg.UIDCount, gidFirst: cfg.GIDFirst, gidCount: cfg.GIDCount,
		maxBoxes: cfg.MaxSandboxes, maxVCPUs: cfg.MaxVCPUs, maxMemMB: cfg.MaxMemMB, remap: remap,
		boxes: map[string]*box{}, jailsFd: -1, vsockFd: -1}
	rfd, err := openAbs(m.root)
	if err != nil {
		return nil, errors.New("sandbox: jail_root cannot be opened as a plain directory path")
	}
	defer closeFd(rfd)
	rgid := m.effGID(0)
	if err := checkDirFd(rfd, m.effUID(rootUID), rgid, RootMode); err != nil {
		return nil, errors.New("sandbox: jail_root must be a directory owned by root with mode 0711 and no ACL")
	}
	if m.jailsFd, err = m.ensureDir(rfd, "jails", JailsMode); err != nil {
		return nil, errors.New("sandbox: the jails directory is not a root-owned 0700 directory without an ACL")
	}
	if m.vsockFd, err = m.ensureDir(rfd, "vsock", VsockRootMode); err != nil {
		closeFd(m.jailsFd)
		return nil, errors.New("sandbox: the vsock directory is not a root-owned 0711 directory without an ACL")
	}
	return m, nil
}

// Close releases the directory descriptors.
func (m *Manager) Close() { closeFd(m.jailsFd); closeFd(m.vsockFd) }

func (m *Manager) effUID(u uint32) uint32 {
	if m.remap != nil {
		u, _ = m.remap(u, 0)
	}
	return u
}
func (m *Manager) effGID(g uint32) uint32 {
	if m.remap != nil {
		_, g = m.remap(0, g)
	}
	return g
}

// ensureDir opens root/name without following a symlink, creating it (mode 0700 then the final mode, owned
// by the root uid) when it does not exist, and requires the exact owner and mode.
func (m *Manager) ensureDir(parent int, name string, mode os.FileMode) (int, error) {
	fd, err := openChild(parent, name)
	if errors.Is(err, syscall.ENOENT) {
		return m.mkdirOwned(parent, name, mode, m.rootUID, 0)
	}
	if err != nil {
		return -1, err
	}
	if err := checkDirFd(fd, m.effUID(m.rootUID), m.effGID(0), mode); err != nil {
		closeFd(fd)
		return -1, err
	}
	return fd, nil
}

// mkdirOwned creates name below parent with mode 0700, opens it with O_NOFOLLOW, sets the owner, then the
// final mode (so the group never holds access to a directory it does not yet own), and verifies all of it
// on the descriptor. On any failure the directory is removed again.
func (m *Manager) mkdirOwned(parent int, name string, mode os.FileMode, uid, gid uint32) (int, error) {
	if !plainName(name) {
		return -1, errBadName
	}
	if err := syscall.Mkdirat(parent, name, 0o700); err != nil {
		return -1, err
	}
	if hookMkdir != nil {
		hookMkdir(parent, name)
	}
	fd, err := openChild(parent, name)
	if err != nil {
		_ = unlinkat(parent, name, atRemove)
		return -1, err
	}
	fail := func(err error) (int, error) {
		closeFd(fd)
		_ = unlinkat(parent, name, atRemove)
		return -1, err
	}
	eu, eg := uid, gid
	if m.remap != nil {
		eu, eg = m.remap(uid, gid)
	}
	// An ACL the new directory inherited (or was given) is removed before the owner and mode are set.
	if err := stripACL(fd); err != nil {
		return fail(err)
	}
	if err := syscall.Fchown(fd, int(eu), int(eg)); err != nil {
		return fail(err)
	}
	if err := syscall.Fchmod(fd, uint32(mode)); err != nil {
		return fail(err)
	}
	if err := checkDirFd(fd, eu, eg, mode); err != nil {
		return fail(err)
	}
	return fd, nil
}

// policy is the consumer-side view of this layout, with the owners as they really are on disk.
func (m *Manager) policy() Policy {
	u := m.runnerUID
	if m.remap != nil {
		u, _ = m.remap(m.runnerUID, 0)
	}
	return Policy{JailRoot: m.root, RootUID: m.effUID(m.rootUID), RootGID: m.effGID(0), RunnerUID: u}
}

// VsockDir is the vsock directory path for id; it never takes a path from the caller.
func (m *Manager) VsockDir(id string) (string, error) {
	if !protocol.ValidID(id) {
		return "", errBadName
	}
	return m.root + "/vsock/" + id, nil
}

func (m *Manager) jailDir(id string) string { return m.root + "/jails/" + id }

// allocate returns the lowest uid and the lowest gid of the configured ranges that no registered sandbox
// holds. The caller holds the lock.
func (m *Manager) allocate() (uid, gid uint32, ok bool) {
	usedU, usedG := map[uint32]bool{}, map[uint32]bool{}
	for _, b := range m.boxes {
		usedU[b.spec.UID], usedG[b.spec.GID] = true, true
	}
	find := func(first, count uint32, used map[uint32]bool) (uint32, bool) {
		for i := uint64(0); i < uint64(count); i++ {
			v := uint64(first) + i
			if v >= config.NoID { // never wrap, and never hand out (uid_t)-1
				break
			}
			if !used[uint32(v)] {
				return uint32(v), true
			}
		}
		return 0, false
	}
	u, ok1 := find(m.uidFirst, m.uidCount, usedU)
	g, ok2 := find(m.gidFirst, m.gidCount, usedG)
	return u, g, ok1 && ok2
}

// Prepare registers id with a fresh uid and gid and builds its two directories.
func (m *Manager) Prepare(r protocol.Request) (server.Reply, protocol.Code) {
	if r.Verb != protocol.Prepare || !protocol.ValidID(r.SandboxID) || !protocol.ValidID(r.Template) {
		return server.Reply{}, protocol.BadID
	}
	if r.VCPUs < 1 || r.MemMB < 1 || r.VCPUs > m.maxVCPUs || r.MemMB > m.maxMemMB {
		return server.Reply{}, protocol.OverCap
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, dup := m.boxes[r.SandboxID]; dup {
		return server.Reply{}, protocol.BadID // the closed code list has no "exists"; an id in use is not usable
	}
	if int64(len(m.boxes)) >= m.maxBoxes {
		return server.Reply{}, protocol.OverCap
	}
	uid, gid, ok := m.allocate()
	if !ok {
		return server.Reply{}, protocol.OverCap
	}
	vdir, _ := m.VsockDir(r.SandboxID)
	jd, err := m.mkdirOwned(m.jailsFd, r.SandboxID, JailDirMode, uid, gid)
	if err != nil {
		return server.Reply{}, protocol.Internal
	}
	closeFd(jd)
	vd, err := m.mkdirOwned(m.vsockFd, r.SandboxID, VsockDirMode, m.runnerUID, gid)
	if err != nil {
		_ = removeAt(m.jailsFd, r.SandboxID)
		return server.Reply{}, protocol.Internal
	}
	closeFd(vd)
	// The reply path is checked the way a consumer will check it, from the path, before it is handed out.
	onDiskGID := gid
	if m.remap != nil {
		_, onDiskGID = m.remap(m.runnerUID, gid)
	}
	chk, err := OpenVsockDir(m.policy(), vdir, r.SandboxID, onDiskGID)
	if err == nil {
		closeFd(chk)
	}
	if err != nil {
		_ = removeAt(m.vsockFd, r.SandboxID)
		_ = removeAt(m.jailsFd, r.SandboxID)
		return server.Reply{}, protocol.Internal
	}
	m.boxes[r.SandboxID] = &box{created: m.Now(), spec: Spec{ID: r.SandboxID, Template: r.Template, UID: uid, GID: gid,
		JailDir: m.jailDir(r.SandboxID), VsockDir: vdir, VCPUs: r.VCPUs, MemMB: r.MemMB}}
	return server.Reply{VsockDir: vdir, SandboxGID: gid}, protocol.OK
}

// Start drives the Launcher for a prepared sandbox. Starting a running one answers OK again, unchanged.
// The lock is held across the launch: the real launcher's cost is a later concern.
func (m *Manager) Start(id string) (server.Reply, protocol.Code) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.boxes[id]
	if !ok {
		return server.Reply{}, protocol.UnknownSandbox
	}
	if b.inst != nil {
		return server.Reply{VsockDir: b.spec.VsockDir, SandboxGID: b.spec.GID}, protocol.OK
	}
	inst, err := m.Launcher.Launch(b.spec)
	switch {
	case errors.Is(err, ErrUnavailable):
		return server.Reply{}, protocol.Unavailable
	case err != nil || inst == nil:
		return server.Reply{}, protocol.Internal
	}
	b.inst = inst
	return server.Reply{VsockDir: b.spec.VsockDir, SandboxGID: b.spec.GID}, protocol.OK
}

// Destroy stops the sandbox if it runs, removes both directories, and frees its ids. If any step fails the
// entry stays registered, so a retry finds it.
func (m *Manager) Destroy(id string) protocol.Code {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.boxes[id]
	if !ok {
		return protocol.UnknownSandbox
	}
	if b.inst != nil {
		if err := b.inst.Stop(); err != nil {
			return protocol.Internal
		}
		b.inst = nil
	}
	if removeAt(m.vsockFd, id) != nil || removeAt(m.jailsFd, id) != nil {
		return protocol.Internal
	}
	delete(m.boxes, id)
	return protocol.OK
}

// List reports every registered sandbox, ordered by id.
func (m *Manager) List() ([]server.Entry, protocol.Code) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]server.Entry, 0, len(m.boxes))
	for id, b := range m.boxes {
		var created int64
		if c := b.created.Unix(); c > 0 {
			created = c
		}
		out = append(out, server.Entry{SandboxID: id, Created: created, VsockDir: b.spec.VsockDir, SandboxGID: b.spec.GID})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SandboxID < out[j].SandboxID })
	return out, protocol.OK
}

// ReapResult says what start-up reaping did.
type ReapResult struct {
	Removed []string // ids whose leftover directories were removed, sorted
	Skipped int      // entries whose name is not a valid sandbox id; never touched
	Failed  int      // entries that could not be removed
}

// Reap removes every entry of the jails and vsock directories that is named like a sandbox id and that no
// registered sandbox owns. An entry named anything else is left alone and counted. Nothing is followed:
// a symlink with a valid id as its name is itself unlinked.
func (m *Manager) Reap() ReapResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	var res ReapResult
	seen := map[string]bool{}
	for _, fd := range []int{m.vsockFd, m.jailsFd} {
		names, err := list(fd)
		if err != nil {
			res.Failed++
			continue
		}
		for _, n := range names {
			if !protocol.ValidID(n) {
				res.Skipped++
				continue
			}
			if _, live := m.boxes[n]; live {
				continue
			}
			if removeAt(fd, n) != nil {
				res.Failed++
				continue
			}
			seen[n] = true
		}
	}
	for n := range seen {
		res.Removed = append(res.Removed, n)
	}
	sort.Strings(res.Removed)
	return res
}

// Permits models the kernel's permission test for a directory entry: which class (owner, group, other)
// applies to a caller, and whether that class holds every bit of want (4 read, 2 write, 1 execute).
// It ignores root and capabilities, so a test can ask what a non-root sandbox uid could do without being root.
func Permits(mode os.FileMode, ownerUID, ownerGID, uid uint32, gids []uint32, want uint32) bool {
	m := uint32(mode & 0o777)
	var class uint32
	switch {
	case uid == ownerUID:
		class = m >> 6 & 7
	default:
		class = m & 7
		for _, g := range gids {
			if g == ownerGID {
				class = m >> 3 & 7
				break
			}
		}
	}
	return class&want == want
}
