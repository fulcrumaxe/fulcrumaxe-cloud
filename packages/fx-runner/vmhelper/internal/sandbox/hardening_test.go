//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"fx-vmhelper/internal/protocol"
)

// ---- ACLs ---------------------------------------------------------------------------------------------------

// fakeACLs stands for a filesystem that holds ACLs: present maps a real directory path to the attributes it
// carries. The seam reads the path of the descriptor, so the same table answers for every open of it.
type fakeACLs struct {
	mu      sync.Mutex
	present map[string]map[string]bool
	failEIO bool
}

func fdPath(fd int) string {
	p, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", fd))
	if err != nil {
		return ""
	}
	return p
}

func installFakeACLs(t *testing.T) *fakeACLs {
	t.Helper()
	f := &fakeACLs{present: map[string]map[string]bool{}}
	oldP, oldR := xattrProbe, xattrRemove
	xattrProbe = func(fd int, name string) (bool, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.failEIO {
			return false, syscall.EIO
		}
		return f.present[fdPath(fd)][name], nil
	}
	xattrRemove = func(fd int, name string) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		p := fdPath(fd)
		if !f.present[p][name] {
			return syscall.ENODATA // the same answer the kernel gives, which the helper must accept
		}
		delete(f.present[p], name)
		return nil
	}
	t.Cleanup(func() { xattrProbe, xattrRemove = oldP, oldR })
	return f
}

func (f *fakeACLs) set(p string, names ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.present[p] = map[string]bool{}
	for _, n := range names {
		f.present[p][n] = true
	}
}

func realRoot(t *testing.T, root string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestStartupRefusesACLOnBaseDirectories(t *testing.T) {
	root := mkroot(t)
	m, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe)
	if err != nil {
		t.Fatal(err)
	}
	m.Close()
	f := installFakeACLs(t)
	rr := realRoot(t, root)
	for _, dir := range []string{rr, rr + "/jails", rr + "/vsock"} {
		for _, attr := range aclNames {
			f.set(dir, attr)
			if m, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe); err == nil {
				m.Close()
				t.Errorf("start-up accepted %s on %s", attr, dir)
			}
			delete(f.present, dir)
		}
	}
	m, err = newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe)
	if err != nil {
		t.Fatalf("a clean tree was refused: %v", err)
	}
	m.Close()
}

func TestProbeErrorFailsClosed(t *testing.T) {
	root := mkroot(t)
	f := installFakeACLs(t)
	f.failEIO = true
	if m, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe); err == nil {
		m.Close()
		t.Fatal("start-up accepted a directory whose ACL state could not be read")
	}
}

func TestPrepareStripsAnInheritedACLFromWhatItCreates(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	f := installFakeACLs(t)
	rr := realRoot(t, root)
	// the directories the helper is about to create come out of the filesystem with both attributes set
	f.set(rr+"/jails/box-a", aclNames...)
	f.set(rr+"/vsock/box-a", aclNames...)
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatalf("prepare: %s", c)
	}
	for _, d := range []string{rr + "/jails/box-a", rr + "/vsock/box-a"} {
		if len(f.present[d]) != 0 {
			t.Errorf("%s still carries %v", d, f.present[d])
		}
	}
	// a directory with only one of the two attributes: the other answers ENODATA, which is fine
	f.set(rr+"/jails/box-b", aclNames[1])
	f.set(rr+"/vsock/box-b", aclNames[0])
	if _, c := m.Prepare(prep("box-b")); c != protocol.OK {
		t.Fatalf("prepare with one attribute: %s", c)
	}
	if len(f.present[rr+"/jails/box-b"])+len(f.present[rr+"/vsock/box-b"]) != 0 {
		t.Error("an attribute survived")
	}
}

// A guest that adds a file between the listing and the removal of its directory: rmdir answers ENOTEMPTY,
// destroy fails closed and the sandbox stays registered.
func TestDestroyFailsClosedWhenTheDirectoryRefillsBeforeRmdir(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	hookRmdir = func(parent int, name string) {
		if name == "box-a" && parent == m.jailsFd {
			_ = os.WriteFile(root+"/jails/box-a/late", nil, 0o600)
		}
	}
	defer func() { hookRmdir = nil }()
	if c := m.Destroy("box-a"); c != protocol.Internal {
		t.Fatalf("destroy answered %s", c)
	}
	if es, _ := m.List(); len(es) != 1 {
		t.Fatal("the entry was dropped")
	}
	hookRmdir = nil
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatalf("retry: %s", c)
	}
}

func TestACLOnAConsumerCheckedDirectoryIsRefused(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	reply, c := m.Prepare(prep("box-a"))
	if c != protocol.OK {
		t.Fatal(c)
	}
	u, g := me()
	f := installFakeACLs(t)
	rr := realRoot(t, root)
	for _, dir := range []string{rr, rr + "/vsock", rr + "/vsock/box-a"} {
		for _, attr := range aclNames {
			f.set(dir, attr)
			if err := vchk(m, reply.VsockDir, "box-a", u, g); !errors.Is(err, errACL) {
				t.Errorf("%s on %s: %v", attr, dir, err)
			}
			delete(f.present, dir)
		}
	}
	if err := vchk(m, reply.VsockDir, "box-a", u, g); err != nil {
		t.Fatal(err)
	}
}

func TestRealACLIsStrippedAndRefused(t *testing.T) {
	if _, err := exec.LookPath("setfacl"); err != nil {
		t.Skip("no setfacl")
	}
	dir := filepath.Join(t.TempDir(), "d")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("setfacl", "-m", "u:65533:rwx", dir).CombinedOutput(); err != nil {
		t.Skipf("no ACL support here: %v %s", err, out)
	}
	if out, err := exec.Command("setfacl", "-d", "-m", "u:65533:rwx", dir).CombinedOutput(); err != nil {
		t.Skipf("no default ACL support here: %v %s", err, out)
	}
	fd, err := openAbs(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(fd)
	u, g := me()
	if err := syscall.Fchmod(fd, 0o710); err != nil {
		t.Fatal(err)
	}
	if err := checkDirFd(fd, u, g, 0o710); !errors.Is(err, errACL) {
		t.Fatalf("a directory with real ACLs passed the check: %v", err)
	}
	if err := stripACL(fd); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("getfacl", "-p", dir).CombinedOutput(); err != nil || strings.Contains(string(out), "65533") {
		t.Fatalf("an entry survived the strip (%v):\n%s", err, out)
	}
	if acl, err := hasACL(fd); acl || err != nil {
		t.Fatalf("hasACL after strip: %v %v", acl, err)
	}
}

func TestRealDefaultACLOnTheVsockRootFailsClosed(t *testing.T) {
	if _, err := exec.LookPath("setfacl"); err != nil {
		t.Skip("no setfacl")
	}
	m, root := newMgr(t, 3, &fakeLauncher{})
	if out, err := exec.Command("setfacl", "-d", "-m", "u:65533:rwx", root+"/vsock").CombinedOutput(); err != nil {
		t.Skipf("no ACL support here: %v %s", err, out)
	}
	// planted after start-up: the new directory inherits the entry, the strip removes it, and the
	// ancestor check of the reply path still refuses a vsock root that carries a default ACL
	if _, c := m.Prepare(prep("box-a")); c != protocol.Internal {
		t.Fatalf("prepare under a vsock root with a default ACL answered %s", c)
	}
	for _, p := range []string{"/jails/box-a", "/vsock/box-a"} {
		if _, err := os.Lstat(root + p); err == nil {
			t.Errorf("%s was left behind", p)
		}
	}
	m.Close()
	if _, err := newManager(cfgFor(root, 2), &fakeLauncher{}, 0, toMe); err == nil {
		t.Fatal("start-up accepted a vsock directory with a default ACL")
	}
}

// ---- failed destroy, depth ----------------------------------------------------------------------------------

// deepChain makes n nested directories below dir, holding one descriptor at a time.
func deepChain(t *testing.T, dir string, n int) {
	t.Helper()
	fd, err := openAbs(dir)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		if err := syscall.Mkdirat(fd, "d", 0o700); err != nil {
			t.Fatal(err)
		}
		next, err := openChild(fd, "d")
		closeFd(fd)
		if err != nil {
			t.Fatal(err)
		}
		fd = next
	}
	closeFd(fd)
}

func setDepth(t *testing.T, n int) {
	t.Helper()
	old := depthLimit
	depthLimit = n
	t.Cleanup(func() { depthLimit = old })
}

func TestDestroyBeyondDepthLimitFailsClosedAndKeepsTheSlot(t *testing.T) {
	setDepth(t, 40)
	l := &fakeLauncher{}
	m, root := newMgr(t, 3, l)
	if _, c := m.Prepare(prep("box-a")); c != protocol.OK {
		t.Fatal(c)
	}
	m.Start("box-a")
	deepChain(t, root+"/jails/box-a", 45)
	if c := m.Destroy("box-a"); c != protocol.Internal {
		t.Fatalf("destroy of a tree deeper than the limit answered %s", c)
	}
	es, _ := m.List()
	if len(es) != 1 || es[0].SandboxID != "box-a" {
		t.Fatalf("a failed destroy dropped the entry: %+v", es)
	}
	if l.stopped != 1 {
		t.Fatalf("stopped %d times", l.stopped)
	}
	// the uid and gid are still held: the next sandbox gets different ones
	if _, c := m.Prepare(prep("box-b")); c != protocol.OK {
		t.Fatal(c)
	}
	m.Start("box-b")
	if a, b := l.specs[0], l.specs[1]; a.UID == b.UID || a.GID == b.GID {
		t.Fatalf("the slot of a sandbox whose jail still exists was handed out again: %+v %+v", a, b)
	}
	// with room to go deeper, the retry removes everything (the walk is iterative, well past the old 16)
	setDepth(t, 100)
	if c := m.Destroy("box-a"); c != protocol.OK {
		t.Fatalf("retry: %s", c)
	}
	for _, p := range []string{"/jails/box-a", "/vsock/box-a"} {
		if _, err := os.Lstat(root + p); err == nil {
			t.Errorf("%s survived", p)
		}
	}
}

func TestDepthLimitIsTheDocumentedValue(t *testing.T) {
	if depthLimit != 2048 {
		t.Fatalf("depthLimit is %d; main raises RLIMIT_NOFILE to cover 2048 levels", depthLimit)
	}
}

func TestRemoveAtLeavesNothingBehindOnADeepButAllowedTree(t *testing.T) {
	m, root := newMgr(t, 1, &fakeLauncher{})
	if err := os.Mkdir(root+"/jails/deep", 0o700); err != nil {
		t.Fatal(err)
	}
	deepChain(t, root+"/jails/deep", 300)
	if err := removeAt(m.jailsFd, "deep"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(root + "/jails/deep"); err == nil {
		t.Fatal("survived")
	}
}

// ---- allocator range ------------------------------------------------------------------------------------------

func TestAllocatorNeverWrapsPastTheTopID(t *testing.T) {
	m := &Manager{uidFirst: 4294967294, uidCount: 5, gidFirst: 100000, gidCount: 5, boxes: map[string]*box{}}
	u, g, ok := m.allocate()
	if !ok || u != 4294967294 || g != 100000 {
		t.Fatalf("%d %d %v", u, g, ok)
	}
	m.boxes["a"] = &box{spec: Spec{UID: u, GID: g}}
	if u, _, ok := m.allocate(); ok {
		t.Fatalf("handed out %d: the range ran into 2^32-1 or wrapped", u)
	}
}

// ---- consumer check -------------------------------------------------------------------------------------------

func TestOpenVsockDirReturnsTheVerifiedDescriptor(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	reply, c := m.Prepare(prep("box-a"))
	if c != protocol.OK {
		t.Fatal(c)
	}
	_, onDiskGID := toMe(0, 0)
	fd, err := OpenVsockDir(m.policy(), reply.VsockDir, "box-a", onDiskGID)
	if err != nil {
		t.Fatal(err)
	}
	defer closeFd(fd)
	// later work goes through the descriptor, and it is the directory that was checked, even if the path moves
	if err := os.Rename(root+"/vsock/box-a", root+"/vsock/moved"); err != nil {
		t.Fatal(err)
	}
	f, err := syscall.Openat(fd, "v.sock_52", syscall.O_CREAT|syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o660)
	if err != nil {
		t.Fatal(err)
	}
	closeFd(f)
	if _, err := os.Lstat(root + "/vsock/moved/v.sock_52"); err != nil {
		t.Fatal("the descriptor does not name the checked directory")
	}
}

func TestOpenVsockDirChecksEveryAncestor(t *testing.T) {
	m, root := newMgr(t, 3, &fakeLauncher{})
	reply, c := m.Prepare(prep("box-a"))
	if c != protocol.OK {
		t.Fatal(c)
	}
	u, g := me()
	for _, dir := range []string{root, root + "/vsock"} {
		if err := os.Chmod(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if vchk(m, reply.VsockDir, "box-a", u, g) == nil {
			t.Errorf("a %s with mode 0755 was accepted", dir)
		}
		if err := os.Chmod(dir, 0o711); err != nil {
			t.Fatal(err)
		}
	}
	pol := m.policy()
	pol.RootUID++
	if fd, err := OpenVsockDir(pol, reply.VsockDir, "box-a", g); err == nil {
		closeFd(fd)
		t.Error("ancestors owned by another uid were accepted")
	}
	pol = m.policy()
	pol.RootGID++
	if fd, err := OpenVsockDir(pol, reply.VsockDir, "box-a", g); err == nil {
		closeFd(fd)
		t.Error("ancestors with another group were accepted")
	}
	if vchk(m, root+"/jails/box-a", "box-a", u, g) == nil {
		t.Error("a path outside jail_root/vsock was accepted")
	}
}

func TestRepliesCarryTheSandboxGID(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newMgr(t, 3, l)
	r1, _ := m.Prepare(prep("box-a"))
	r2, _ := m.Prepare(prep("box-b"))
	s, _ := m.Start("box-b")
	s2, _ := m.Start("box-b") // the repeated start answers the same fields
	es, _ := m.List()
	if s2 != s {
		t.Fatalf("second start answered %+v, first %+v", s2, s)
	}
	if r1.SandboxGID != 100000 || r2.SandboxGID != 100001 || s.SandboxGID != 100001 || es[0].SandboxGID != 100000 || es[1].SandboxGID != 100001 {
		t.Fatalf("%+v %+v %+v %+v", r1, r2, s, es)
	}
}

// ---- mount points ---------------------------------------------------------------------------------------------

// TestMountsInNS re-executes the test binary in a user and mount namespace, where mounting needs no real
// root, and covers a tmpfs and a same-filesystem bind mount of an outside tree below a jail, with each layer
// of the mount check on its own.
func TestMountsInNS(t *testing.T) {
	if os.Getenv("FX_TEST_IN_NS") == "" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestMountsInNS$", "-test.v")
		cmd.Env = append(os.Environ(), "FX_TEST_IN_NS=1")
		cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWNS,
			UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
			GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}}}
		out, err := cmd.CombinedOutput()
		var ee *exec.ExitError
		if err != nil && !errors.As(err, &ee) {
			t.Skipf("user namespaces unavailable: %v", err)
		}
		if err != nil {
			t.Fatalf("in the namespace: %v\n%s", err, out)
		}
		if strings.Contains(string(out), "--- SKIP") {
			t.Skipf("mounting is not possible here:\n%s", out)
		}
		return
	}
	if err := syscall.Mount("none", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		t.Skipf("cannot make the mount tree private: %v", err)
	}
	variants := []struct {
		name         string
		openat2      bool
		mntID        func(int) (uint64, bool)
		wantBindErr  error
		wantTmpfsErr error
		skipBind     bool // a layer that cannot see a same-filesystem bind mount is not asked to
		retryOK      bool // whether destroy can finish once the mounts are gone
	}{
		{"openat2", true, mntIDOf, errMount, errMount, false, true},
		{"statx mount id", false, mntIDOf, errMount, errMount, false, true},
		// mount ids that tell nothing apart: only st_dev is left, and it sees the tmpfs but not a bind mount
		{"st_dev only", false, func(int) (uint64, bool) { return 1, true }, nil, errMount, true, true},
		// no mount information at all: every descent is refused
		{"no mount information", false, func(int) (uint64, bool) { return 0, false }, errNoMount, errNoMount, false, false},
	}
	oldOpenat2, oldMnt := useOpenat2, mntIDOf
	defer func() { useOpenat2, mntIDOf = oldOpenat2, oldMnt }()
	for i, v := range variants {
		useOpenat2, mntIDOf = v.openat2, v.mntID
		m, root := newMgr(t, 3, &fakeLauncher{})
		outside, keep := outsideTree(t, root)
		id := fmt.Sprintf("box-%d", i)
		if _, c := m.Prepare(prep(id)); c != protocol.OK {
			t.Fatalf("%s: prepare %s", v.name, c)
		}
		jd := root + "/jails/" + id
		for _, kind := range []string{"tmpfs", "bind"} {
			mp := jd + "/" + kind
			if err := os.Mkdir(mp, 0o700); err != nil {
				t.Fatal(err)
			}
			if kind == "bind" && v.skipBind {
				continue
			}
			canary := keep
			want := v.wantBindErr
			if kind == "tmpfs" {
				if err := syscall.Mount("none", mp, "tmpfs", 0, ""); err != nil {
					fmt.Println("--- SKIP tmpfs mount:", err)
					return
				}
				canary = mp + "/inmount"
				if err := os.WriteFile(canary, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				want = v.wantTmpfsErr
			} else if err := syscall.Mount(outside, mp, "", syscall.MS_BIND, ""); err != nil {
				fmt.Println("--- SKIP bind mount:", err)
				return
			}
			// the layer itself, and then the whole destroy path
			if err := removeAt(m.jailsFd, id); !errors.Is(err, want) {
				t.Errorf("%s/%s: removeAt answered %v, want %v", v.name, kind, err, want)
			}
			if c := m.Destroy(id); c != protocol.Internal {
				t.Errorf("%s/%s: destroy answered %s, want internal", v.name, kind, c)
			}
			if _, err := os.Stat(canary); err != nil {
				t.Errorf("%s/%s: the content behind the mount point was removed", v.name, kind)
			}
			if es, _ := m.List(); len(es) != 1 {
				t.Errorf("%s/%s: the sandbox left the registry", v.name, kind)
			}
			if err := syscall.Unmount(mp, 0); err != nil {
				t.Fatal(err)
			}
		}
		// with the mounts gone the retry finishes, and the outside tree is intact
		if c := m.Destroy(id); (c == protocol.OK) != v.retryOK {
			t.Errorf("%s: retry after unmount: %s", v.name, c)
		}
		if _, err := os.Stat(keep); err != nil {
			t.Errorf("%s: outside tree damaged", v.name)
		}
	}
}
