//go:build linux

package sandbox

import (
	"errors"
	"os"
	"path"
	"strconv"
	"strings"
	"syscall"
)

// UnitCgroup is the cgroup path of the unit from the text of /proc/self/cgroup (the cgroup2 line,
// "0::<path>"), without the leading slash. Anything that is not a plain path below the root is refused.
func UnitCgroup(procSelfCgroup string) (string, error) {
	for _, line := range strings.Split(procSelfCgroup, "\n") {
		if p, ok := strings.CutPrefix(line, "0::"); ok {
			p = strings.TrimPrefix(p, "/")
			if relClean(p) && path.Clean(p) == p {
				return p, nil
			}
			break
		}
	}
	return "", errors.New("cgroup: this process is not in a cgroup2 path below the root")
}

// SetupCgroup prepares the unit's delegated subtree and returns the parent for sandbox cgroups, relative
// to root. cgroup2 forbids enabling controllers in a cgroup that holds processes, so the helper first moves
// itself into a leaf (<unit>/helper); then cpu and memory are enabled for the unit and for <unit>/vms,
// whose children are the sandboxes. The jailer repeats those writes on every ancestor; once they are
// enabled they change nothing.
func SetupCgroup(root, unit string, pid int) (string, error) {
	rfd, err := openAbs(root)
	if err != nil {
		return "", err
	}
	defer closeFd(rfd)
	ufd, err := openRel(rfd, unit)
	if err != nil {
		return "", err
	}
	defer closeFd(ufd)
	if err := mkdirIn(ufd, "helper"); err != nil {
		return "", err
	}
	if err := mkdirIn(ufd, "vms"); err != nil {
		return "", err
	}
	if err := writeIn(ufd, "helper/cgroup.procs", strconv.Itoa(pid)); err != nil {
		return "", err
	}
	for _, f := range []string{"cgroup.subtree_control", "vms/cgroup.subtree_control"} {
		if err := writeIn(ufd, f, "+cpu +memory"); err != nil {
			return "", err
		}
	}
	return unit + "/vms", nil
}

// openRel opens a relative path below fd one component at a time without following a symlink.
func openRel(fd int, p string) (int, error) {
	cur, err := syscall.Dup(fd)
	if err != nil {
		return -1, err
	}
	for _, c := range strings.Split(p, "/") {
		next, err := syscall.Openat(cur, c, dirFlags, 0)
		closeFd(cur)
		if err != nil {
			return -1, err
		}
		cur = next
	}
	return cur, nil
}

func mkdirIn(fd int, name string) error {
	if err := syscall.Mkdirat(fd, name, 0o755); err != nil && !errors.Is(err, syscall.EEXIST) {
		return err
	}
	return nil
}

// writeIn writes val to the file at rel (one or two components) below fd, opened O_NOFOLLOW.
func writeIn(fd int, rel, val string) error {
	dir, name := path.Split(rel)
	dfd := fd
	if dir != "" {
		d, err := openRel(fd, strings.TrimSuffix(dir, "/"))
		if err != nil {
			return err
		}
		defer closeFd(d)
		dfd = d
	}
	f, err := syscall.Openat(dfd, name, syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer closeFd(f)
	_, err = syscall.Write(f, []byte(val))
	return err
}

// ReadSelfCgroup is os.ReadFile of /proc/self/cgroup, replaceable in tests.
var ReadSelfCgroup = func() (string, error) { b, err := os.ReadFile("/proc/self/cgroup"); return string(b), err }
