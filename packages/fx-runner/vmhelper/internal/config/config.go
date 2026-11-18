// Package config reads the helper's root-owned config. Every key is required and there is no default for
// any of them: a missing, repeated, unknown or out-of-range key stops the helper before it listens.
//
// The file is one flat JSON object (the same strict reader as the socket frames; integers are plain
// digits, at most nine of them):
//
//	jail_root      absolute, clean path of the one directory every jail lives under
//	runner_uid, runner_gid
//	               the one uid whose connections are served, and that runner's primary gid (neither is 0)
//	uid_first, uid_count, gid_first, gid_count
//	               the range per-sandbox ids are taken from. Each range starts at MinID or above (so it
//	               holds no system account and no login user), never holds 65534 (nobody) and never
//	               holds runner_uid (uid range) or runner_gid (gid range); main also refuses a gid range
//	               that holds the group of the socket directory (CheckSocketGroups)
//	max_sandboxes  how many sandboxes may be prepared at once
//	max_vcpus, max_mem_mb   per-sandbox ceilings a prepare request is checked against
package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"syscall"

	"fx-vmhelper/internal/protocol"
)

type Config struct {
	JailRoot     string
	RunnerUID    uint32
	RunnerGID    uint32
	UIDFirst     uint32
	UIDCount     uint32
	GIDFirst     uint32
	GIDCount     uint32
	MaxSandboxes int64
	MaxVCPUs     int64
	MaxMemMB     int64
}

// Caps returns the per-sandbox ceilings for the request schema.
func (c Config) Caps() protocol.Caps {
	return protocol.Caps{MaxVCPUs: c.MaxVCPUs, MaxMemMB: c.MaxMemMB}
}

const maxFile = 4096

// MinID is the lowest uid or gid a per-sandbox range may start at. D#587 names no floor, so this is the
// conventional start of the subordinate-id space: below it sit system accounts and ordinary login users,
// and a sandbox id that equalled one would hand an escaped VMM that account's files and processes.
const MinID = 100000

// Nobody is the uid and gid of the overflow account. A sandbox must not share it with every other
// unmapped user.
const Nobody = 65534

// NoID is 2^32-1, which is (uid_t)-1 and (gid_t)-1: "no change" to chown and setresuid, never a real id.
const NoID = 1<<32 - 1

var keys = []string{"jail_root", "runner_uid", "runner_gid", "uid_first", "uid_count", "gid_first", "gid_count", "max_sandboxes", "max_vcpus", "max_mem_mb"}

// Load reads path, which must be a regular file owned by ownerUID (0 in production) that no one else can
// write. The open does not follow a symlink in the last component.
func Load(file string, ownerUID uint32) (Config, error) {
	fd, err := syscall.Open(file, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return Config{}, fmt.Errorf("config: cannot open %s: %v", Clean(file), err)
	}
	f := os.NewFile(uintptr(fd), "config")
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return Config{}, errors.New("config: cannot stat the file")
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return Config{}, errors.New("config: not a regular file")
	}
	if st.Uid != ownerUID || st.Mode&0o022 != 0 {
		return Config{}, fmt.Errorf("config: must be owned by uid %d and not writable by group or others", ownerUID)
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil || len(data) > maxFile {
		return Config{}, errors.New("config: unreadable or over 4 KiB")
	}
	return Parse(data)
}

// Clean keeps an operator-supplied path printable in an error.
func Clean(s string) string {
	if len(s) > 100 {
		s = s[:100]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, s)
}

// Parse validates the file's bytes.
func Parse(data []byte) (Config, error) {
	f, err := protocol.DecodeFlat(data)
	if err != nil {
		return Config{}, errors.New("config: not one strict JSON object")
	}
	for k := range f {
		if !has(k) {
			return Config{}, fmt.Errorf("config: unknown key %q", Clean(k))
		}
	}
	for _, k := range keys {
		if _, ok := f[k]; !ok {
			return Config{}, fmt.Errorf("config: required key %q is missing (there is no default)", k)
		}
	}
	root, ok := f["jail_root"].(string)
	if !ok {
		return Config{}, errors.New("config: jail_root must be a string")
	}
	if !path.IsAbs(root) || path.Clean(root) != root || root == "/" || len(root) > 200 || strings.ContainsRune(root, 0) {
		return Config{}, errors.New("config: jail_root must be an absolute, clean path below /")
	}
	n := map[string]int64{}
	for _, k := range keys[1:] {
		v, ok := protocol.PlainInt(f[k])
		if !ok {
			return Config{}, fmt.Errorf("config: %s must be a plain integer", k)
		}
		n[k] = v
	}
	c := Config{JailRoot: root, RunnerUID: uint32(n["runner_uid"]), RunnerGID: uint32(n["runner_gid"]), UIDFirst: uint32(n["uid_first"]), UIDCount: uint32(n["uid_count"]),
		GIDFirst: uint32(n["gid_first"]), GIDCount: uint32(n["gid_count"]), MaxSandboxes: n["max_sandboxes"], MaxVCPUs: n["max_vcpus"], MaxMemMB: n["max_mem_mb"]}
	switch {
	case c.RunnerUID == 0:
		return Config{}, errors.New("config: runner_uid must not be 0")
	case c.MaxSandboxes < 1 || c.MaxSandboxes > 1024, c.MaxVCPUs < 1 || c.MaxVCPUs > 64, c.MaxMemMB < 1 || c.MaxMemMB > 1<<20:
		return Config{}, errors.New("config: max_sandboxes (1..1024), max_vcpus (1..64) or max_mem_mb (1..1048576) is out of range")
	case int64(c.UIDCount) < c.MaxSandboxes:
		return Config{}, fmt.Errorf("config: uid range holds %d ids but max_sandboxes is %d", c.UIDCount, c.MaxSandboxes)
	case int64(c.GIDCount) < c.MaxSandboxes:
		return Config{}, fmt.Errorf("config: gid range holds %d ids but max_sandboxes is %d", c.GIDCount, c.MaxSandboxes)
	case c.RunnerGID == 0:
		return Config{}, errors.New("config: runner_gid must not be 0")
	}
	if err := checkRange("uid", c.UIDFirst, c.UIDCount, MinID); err != nil {
		return Config{}, err
	}
	if err := checkRange("gid", c.GIDFirst, c.GIDCount, MinID); err != nil {
		return Config{}, err
	}
	if contains(c.UIDFirst, c.UIDCount, c.RunnerUID) {
		return Config{}, errors.New("config: the uid range must not include runner_uid")
	}
	if contains(c.GIDFirst, c.GIDCount, c.RunnerGID) {
		return Config{}, errors.New("config: the gid range must not include runner_gid")
	}
	return c, nil
}

// checkRange refuses a range that starts below floor, or holds 0 or Nobody. (With floor at MinID the
// last two cannot happen; they are checked on their own so that lowering the floor cannot open them.)
func checkRange(kind string, first, count, floor uint32) error {
	switch {
	case uint64(first)+uint64(count) > NoID: // the last id, first+count-1, must stay below 2^32-1
		return fmt.Errorf("config: the %s range runs past the largest usable id", kind)
	case first < floor:
		return fmt.Errorf("config: the %s range must start at %d or above, not %d", kind, floor, first)
	case contains(first, count, 0):
		return fmt.Errorf("config: the %s range must not include 0", kind)
	case contains(first, count, Nobody):
		return fmt.Errorf("config: the %s range must not include %d (nobody)", kind, Nobody)
	}
	return nil
}

// CheckSocketGroups refuses a start where the gid range holds a group that the socket is reachable by:
// the group of the socket's directory and the helper's own gid. A sandbox with such a gid would be a
// member of the group that is allowed through to the socket's directory.
func (c Config) CheckSocketGroups(gids ...uint32) error {
	for _, g := range gids {
		if contains(c.GIDFirst, c.GIDCount, g) {
			return fmt.Errorf("config: the gid range must not include the socket group (gid %d)", g)
		}
	}
	return nil
}

func has(k string) bool {
	for _, x := range keys {
		if x == k {
			return true
		}
	}
	return false
}

func contains(first, count, v uint32) bool {
	return v >= first && uint64(v) < uint64(first)+uint64(count)
}

// CheckGroupFile refuses a gid range that overlaps a group listed in the group file (the /etc/group format)
// with any member. A member of such a group would hold that group's bits on a sandbox's directory, whose
// group is one id of the range. A line that is not four colon-separated fields with a numeric gid (other
// than a blank line, a comment or a "+" compat line) is an error: the file is read fail-closed.
func (c Config) CheckGroupFile(r io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(r, 4<<20))
	if err != nil {
		return errors.New("config: cannot read the group file")
	}
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" || line[0] == '#' || line[0] == '+' || line[0] == '-' {
			continue
		}
		f := strings.Split(line, ":")
		if len(f) != 4 || len(f[2]) == 0 || len(f[2]) > 10 {
			return errors.New("config: the group file has a line that is not name:password:gid:members")
		}
		var gid uint64
		for _, ch := range f[2] {
			if ch < '0' || ch > '9' {
				return errors.New("config: the group file has a non-numeric gid")
			}
			gid = gid*10 + uint64(ch-'0')
		}
		if gid <= NoID && contains(c.GIDFirst, c.GIDCount, uint32(gid)) && strings.TrimSpace(f[3]) != "" {
			return fmt.Errorf("config: the gid range holds group %d, which has members", gid)
		}
	}
	return nil
}

// CheckPasswdFile refuses a gid range that holds the primary group of any user in the passwd file (the
// /etc/passwd format), whether or not the group file lists that user as a member: that user would hold the
// group's bits on a sandbox's directory. Same rules as CheckGroupFile: a malformed line is an error.
//
// Only the local files are read. Users and groups from other NSS sources (LDAP, sssd, systemd-userdbd)
// are not visible to it; a host that has them must keep the sandbox id ranges out of their id space, which
// the installer is to check.
func (c Config) CheckPasswdFile(r io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(r, 4<<20))
	if err != nil {
		return errors.New("config: cannot read the passwd file")
	}
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" || line[0] == '#' || line[0] == '+' || line[0] == '-' {
			continue
		}
		f := strings.Split(line, ":")
		if len(f) != 7 || len(f[3]) == 0 || len(f[3]) > 10 {
			return errors.New("config: the passwd file has a line that is not seven colon-separated fields")
		}
		var gid uint64
		for _, ch := range f[3] {
			if ch < '0' || ch > '9' {
				return errors.New("config: the passwd file has a non-numeric gid")
			}
			gid = gid*10 + uint64(ch-'0')
		}
		if gid <= NoID && contains(c.GIDFirst, c.GIDCount, uint32(gid)) {
			return fmt.Errorf("config: the gid range holds %d, the primary group of a user", gid)
		}
	}
	return nil
}
