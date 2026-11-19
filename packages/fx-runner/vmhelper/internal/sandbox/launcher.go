//go:build linux

package sandbox

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/protocol"
)

const (
	// vmmOverheadMB is added to the guest's memory for memory.max: Firecracker's own memory (about 100 MB
	// resident after boot in the D#587 spike) and room for its threads and device buffers.
	vmmOverheadMB = 256
	cpuPeriodUS   = 100000
	stopTimeout   = 5 * time.Second
)

// readyTimeout is how long a launch may take to reach the dropped process (a variable for tests).
var readyTimeout = 10 * time.Second

var errDrop = errors.New("the sandbox process did not drop to the sandbox's ids")

// JailerLauncher starts a sandbox with the pinned jailer and Firecracker. The jailer builds the chroot,
// puts the process in its own cgroup (a child of CgroupParent, which lies under this unit's subtree),
// drops to the sandbox's uid and gid and execs Firecracker. There is no shell: the process is started
// from an argument list the helper builds from validated values, with an empty environment.
type JailerLauncher struct {
	Jailer, Firecracker string    // absolute paths of the pinned binaries (root-owned chain, checked at every launch)
	CgroupRoot          string    // the cgroup2 mount, /sys/fs/cgroup
	CgroupParent        string    // relative to CgroupRoot, below this unit's cgroup
	OwnerUID, OwnerGID  uint32    // who the jail directory is handed to for the jailer: root (0, 0) in production
	AmbientCaps         []uintptr // capabilities raised into the jailer child's ambient set, between fork and exec

	// Tests only.
	Remap     func(uid, gid uint32) (uint32, uint32)  // nominal sandbox ids -> the ids a non-root test can have
	Status    func(pid int) (string, error)           // the process's /proc status text
	Dial      func(s Spec, pid int) (net.Conn, error) // the Firecracker API socket (default: dialAPI)
	Handover  func(s Spec) error                      // gives the vsock socket to the runner (default: handOverSocket)
	chainBase string                                  // where the root-owned chain check starts: "/" unless a test says otherwise
}

func (l *JailerLauncher) eff(u, g uint32) (uint32, uint32) {
	if l.Remap != nil {
		return l.Remap(u, g)
	}
	return u, g
}

func (l *JailerLauncher) cgroupDir() string { return l.CgroupRoot + "/" + l.CgroupParent }

func relClean(p string) bool {
	if p == "" || len(p) > 200 || strings.HasPrefix(p, "-") || strings.ContainsRune(p, 0) {
		return false
	}
	for _, c := range strings.Split(p, "/") {
		if !plainName(c) {
			return false
		}
	}
	return true
}

// Argv is the whole command line, built only from validated values. The id is two elements (--id, <id>):
// the jailer's parser reads the value after a flag and has no --flag=value form. The value cannot be
// read as an option, because the id pattern (protocol.ValidID) forbids a leading dash.
func (l *JailerLauncher) Argv(s Spec) ([]string, error) {
	switch {
	case !protocol.ValidID(s.ID):
		return nil, errors.New("launch: bad sandbox id")
	case s.UID == 0 || s.GID == 0:
		return nil, errors.New("launch: a sandbox never runs as uid or gid 0")
	case s.VCPUs < 1 || s.VCPUs > 1024 || s.MemMB < 1 || s.MemMB > 1<<20:
		return nil, errors.New("launch: vcpus or memory out of range")
	case cleanAbs(l.Jailer) != nil || cleanAbs(l.Firecracker) != nil || cleanAbs(s.JailDir) != nil || !relClean(l.CgroupParent):
		return nil, errors.New("launch: a path is not clean")
	}
	return []string{l.Jailer,
		"--id", s.ID,
		"--exec-file", l.Firecracker,
		"--uid", strconv.FormatUint(uint64(s.UID), 10),
		"--gid", strconv.FormatUint(uint64(s.GID), 10),
		"--chroot-base-dir", s.JailDir,
		"--cgroup-version", "2",
		"--parent-cgroup", l.CgroupParent,
		"--cgroup", "memory.max=" + strconv.FormatInt((s.MemMB+vmmOverheadMB)<<20, 10),
		"--cgroup", "cpu.max=" + strconv.FormatInt(s.VCPUs*cpuPeriodUS, 10) + " " + strconv.Itoa(cpuPeriodUS),
	}, nil
}

// CheckBinary requires path to be a regular executable file that only root can change, reached through
// directories only root can change, with no symlink on the way (every component is opened O_NOFOLLOW).
func (l *JailerLauncher) CheckBinary(path string) error {
	fd, err := openRootChain(l.chainBase, path, l.OwnerUID)
	if err != nil {
		return err
	}
	defer closeFd(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != l.OwnerUID || st.Mode&0o022 != 0 || st.Mode&0o111 == 0 {
		return fmt.Errorf("launch: %s is not a root-owned executable file", config.Clean(path))
	}
	return nil
}

// openRootChain opens path (below base, "/" when empty) one component at a time with O_NOFOLLOW and returns
// the descriptor of its last component. Every directory on the way, base included, must belong to owner and
// be writable by no one else; the caller checks the last component itself. A manifest, a template and a
// binary all take this one route.
func openRootChain(base, path string, owner uint32) (int, error) {
	if base == "" {
		base = "/"
	}
	if err := cleanAbs(path); err != nil || !(base == "/" || strings.HasPrefix(path, base+"/")) {
		return -1, fmt.Errorf("launch: %s is not a clean absolute path", config.Clean(path))
	}
	fd, err := openAbs(base)
	if err != nil {
		return -1, err
	}
	comps := strings.Split(strings.TrimPrefix(strings.TrimPrefix(path, base), "/"), "/")
	for i, c := range comps {
		flags := dirFlags
		if i == len(comps)-1 {
			flags = syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
		}
		var st syscall.Stat_t
		if err := syscall.Fstat(fd, &st); err != nil || st.Uid != owner || st.Mode&0o022 != 0 {
			closeFd(fd)
			return -1, fmt.Errorf("launch: %s is not in a root-owned, root-writable-only chain (the directory above %q is owned by %d with mode %o)", config.Clean(path), config.Clean(c), st.Uid, st.Mode&0o7777)
		}
		next, err := syscall.Openat(fd, c, flags, 0)
		closeFd(fd)
		if err != nil {
			return -1, fmt.Errorf("launch: cannot open %s without following a symlink", config.Clean(path))
		}
		fd = next
	}
	return fd, nil
}

// handOver gives the jail directory to the jailer's user (root): the helper holds no CAP_DAC_OVERRIDE, so
// the jailer could not create its chroot inside a directory that belongs to another uid. The mode stays
// 0700, and the sandbox cannot reach this path from inside its chroot.
func (l *JailerLauncher) handOver(dir string) error {
	// O_PATH: the directory still belongs to the sandbox uid and is closed to root, which cannot open it for
	// reading without CAP_DAC_OVERRIDE; stat and chown (AT_EMPTY_PATH) need no read access.
	fd, err := openAbsAs(dir, pathDirFlags)
	if err != nil {
		return err
	}
	defer closeFd(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || os.FileMode(st.Mode&0o7777) != JailDirMode { // (O_DIRECTORY on the open made it a directory)
		return errors.New("launch: the jail directory is not a 0700 directory")
	}
	return fchownEmpty(fd, l.OwnerUID, l.OwnerGID)
}

type instance struct {
	l    *JailerLauncher
	id   string
	pid  int
	done chan struct{}
	out  *headBuf
	exit string // how the process ended (set before done is closed)
}

// headBuf keeps the first bytes written to it and discards the rest, so a chatty process cannot fill memory
// or block on a full pipe.
type headBuf struct {
	mu   sync.Mutex
	b    []byte // the first bytes
	tail []byte // the last bytes after those (a guest's console ends with its panic)
}

func (h *headBuf) Write(p []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := min(max(2048-len(h.b), 0), len(p))
	h.b = append(h.b, p[:n]...)
	if h.tail = append(h.tail, p[n:]...); len(h.tail) > 2048 {
		h.tail = h.tail[len(h.tail)-2048:]
	}
	return len(p), nil
}

// Head is what the process printed first, as one printable line (anything else becomes '?'); Tail is the
// last of what it printed, when that was more than Head holds.
func (h *headBuf) Head() string { return h.line(false) }
func (h *headBuf) Tail() string { return h.line(true) }

func (h *headBuf) line(tail bool) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	raw := h.b
	if tail {
		raw = h.tail
	}
	line := strings.Join(strings.Fields(string(raw)), " ")
	if len(line) > 1500 {
		if tail {
			line = line[len(line)-1500:]
		} else {
			line = line[:1500]
		}
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r >= 0x7f {
			return '?'
		}
		return r
	}, line)
}

// Launch starts the sandbox and returns once the process has dropped to the sandbox's uid and gid.
func (l *JailerLauncher) Launch(s Spec) (Instance, error) {
	argv, err := l.Argv(s)
	if err != nil {
		return nil, err
	}
	for _, b := range []string{l.Jailer, l.Firecracker} {
		if err := l.CheckBinary(b); err != nil {
			return nil, err
		}
	}
	if err := l.handOver(s.JailDir); err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = []string{} // nothing is inherited
	cmd.Dir = "/"
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, AmbientCaps: l.AmbientCaps}
	out := &headBuf{}
	cmd.Stdout, cmd.Stderr = out, out // the pipe is drained for the life of the process; only the first bytes are kept
	if err := cmd.Start(); err != nil {
		return nil, errors.New("launch: the jailer did not start")
	}
	in := &instance{l: l, id: s.ID, pid: cmd.Process.Pid, done: make(chan struct{}), out: out}
	go func() { in.exit = fmt.Sprint(cmd.Wait()); close(in.done) }() // exit is read only after done is closed
	// Dropped, then configured and started through the API socket; a failure of either kills the whole cgroup.
	err = l.waitDropped(in, s)
	if err == nil {
		err = l.boot(in, s)
	}
	if err != nil {
		ended := "it had not ended" // looked at before the kill below, which would end it
		select {
		case <-in.done:
			ended = "it ended: " + in.exit
		case <-time.After(300 * time.Millisecond): // a process that just died is reaped a moment later
		}
		_ = cmd.Process.Kill() // a jailer that has not dropped yet is still root's own child; cgroup.kill covers the rest
		if serr := in.Stop(); serr != nil {
			err = fmt.Errorf("%w; and the sandbox could not be stopped: %v", err, serr)
		}
		// After the stop the pipe is drained: this is everything the process said before it ended.
		return nil, fmt.Errorf("%w (the sandbox process printed %q; %s)", err, in.out.Head(), ended)
	}
	return in, nil
}

// waitDropped polls the process's status until its four uids and gids are the sandbox's. A process that
// keeps any supplementary group, or never drops, fails the launch.
func (l *JailerLauncher) waitDropped(in *instance, s Spec) error {
	wu, wg := l.eff(s.UID, s.GID)
	read := l.Status
	if read == nil {
		read = func(pid int) (string, error) {
			b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
			return string(b), err
		}
	}
	for deadline := time.Now().Add(readyTimeout); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		select {
		case <-in.done:
			return fmt.Errorf("launch: the jailer exited before the sandbox process was running (it printed %q)", in.out.Head())
		default:
		}
		if st, err := read(in.pid); err == nil {
			if ok, err := CheckDropped(st, wu, wg); err != nil || ok {
				return err
			}
		}
	}
	return errors.New("launch: timed out waiting for the sandbox process")
}

// CheckDropped reports true when Uid and Gid of a /proc status text are all the given ids and the process
// holds no capability (CapPrm, CapEff and CapAmb all zero); it is an error when they are but a supplementary
// group or a capability remains, or a capability field is missing. Anything else is "not yet" (the gid is
// dropped first).
func CheckDropped(status string, uid, gid uint32) (bool, error) {
	var gotU, gotG, groups bool
	caps := map[string]string{}
	for _, line := range strings.Split(status, "\n") {
		k, v, _ := strings.Cut(line, ":")
		f := strings.Fields(v)
		switch k {
		case "Uid", "Gid":
			want := uid
			if k == "Gid" {
				want = gid
			}
			ok := len(f) == 4
			for _, x := range f {
				ok = ok && x == strconv.FormatUint(uint64(want), 10)
			}
			if k == "Uid" {
				gotU = ok
			} else {
				gotG = ok
			}
		case "Groups":
			groups = len(f) != 0
		case "CapPrm", "CapEff", "CapAmb":
			caps[k] = strings.TrimSpace(v)
		}
	}
	if !gotU || !gotG {
		return false, nil
	}
	if groups {
		return false, errDrop
	}
	for _, k := range []string{"CapPrm", "CapEff", "CapAmb"} {
		if v, ok := caps[k]; !ok || strings.Trim(v, "0") != "" || v == "" {
			return false, errDrop
		}
	}
	return true, nil
}

// Stop kills every process of the sandbox's cgroup (cgroup.kill, kernel 5.14 or later: no signal or
// CAP_KILL involved), waits for the processes to be gone and removes the cgroup.
func (i *instance) Stop() error { return i.l.stopCgroup(i.id, i.done) }

func (l *JailerLauncher) stopCgroup(id string, done <-chan struct{}) error {
	pfd, err := openAbs(l.cgroupDir())
	if err != nil {
		return err
	}
	defer closeFd(pfd)
	cfd, err := syscall.Openat(pfd, id, dirFlags, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil // never made, or already removed
	}
	if err != nil {
		return err
	}
	defer closeFd(cfd)
	kfd, err := syscall.Openat(cfd, "cgroup.kill", syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	_, err = syscall.Write(kfd, []byte("1"))
	closeFd(kfd)
	if err != nil {
		return err
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(stopTimeout):
			return errors.New("stop: the sandbox process is still running")
		}
	}
	for deadline := time.Now().Add(stopTimeout); ; time.Sleep(10 * time.Millisecond) {
		if empty, err := cgroupEmpty(cfd); errors.Is(err, syscall.ENOENT) {
			return nil // removed meanwhile
		} else if err != nil {
			return err
		} else if empty {
			if err = unlinkat(pfd, id, atRemove); err == nil || errors.Is(err, syscall.ENOENT) {
				return nil
			} else if !errors.Is(err, syscall.EBUSY) && !errors.Is(err, syscall.ENOTEMPTY) { // the kernel is still tearing it down
				return err
			}
		}
		if time.Now().After(deadline) {
			return errors.New("stop: the sandbox's cgroup did not empty")
		}
	}
}

func cgroupEmpty(cfd int) (bool, error) {
	fd, err := syscall.Openat(cfd, "cgroup.procs", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return false, err
	}
	defer closeFd(fd)
	var b [1]byte
	n, err := syscall.Read(fd, b[:])
	return n == 0, err
}

// ReapStale kills and removes every sandbox cgroup under CgroupParent: at start-up the registry is empty,
// so none of them has an owner. It returns how many it removed and how many it could not.
func (l *JailerLauncher) ReapStale() (removed, failed int) {
	pfd, err := openAbs(l.cgroupDir())
	if err != nil {
		return 0, 0
	}
	defer closeFd(pfd)
	names, err := list(pfd)
	if err != nil {
		return 0, 1
	}
	for _, n := range names {
		if !protocol.ValidID(n) {
			continue
		}
		if l.stopCgroup(n, nil) != nil {
			failed++
		} else {
			removed++
		}
	}
	return removed, failed
}
