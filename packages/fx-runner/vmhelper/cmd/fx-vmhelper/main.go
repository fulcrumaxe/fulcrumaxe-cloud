//go:build linux

// Command fx-vmhelper is the root service behind the local runner's microVM sandboxes. This build holds
// the protocol, the server and the sandbox registry (ids, jail and vsock directories, reaping) and the
// jailer launcher (uid/gid drop, cgroups under the unit's subtree, cgroup.kill on destroy).
//
//	fx-vmhelper -config <file>
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/hardening"
	"fx-vmhelper/internal/protocol"
	"fx-vmhelper/internal/sandbox"
	"fx-vmhelper/internal/server"
	"fx-vmhelper/internal/vmlog"
)

const cgroupRoot = "/sys/fs/cgroup"

// groupFile is read at start-up; a test replaces it.
var groupFile, passwdFile = "/etc/group", "/etc/passwd"

// raiseNoFile lifts the soft descriptor limit to what removing a deep jail tree can need (one descriptor
// per level, up to the sandbox package's depth limit), within the hard limit.
func raiseNoFile() { raiseNoFileTo(8192) }

// raiseNoFileTo sets the soft limit to want, or to the hard limit if that is lower; it never lowers it.
func raiseNoFileTo(want uint64) {
	var l syscall.Rlimit
	if syscall.Getrlimit(syscall.RLIMIT_NOFILE, &l) != nil {
		return
	}
	if l.Max < want {
		want = l.Max
	}
	if l.Cur < want {
		l.Cur = want
		_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &l)
	}
}

// startupDeps are the readers and effects the start-up checks use; tests replace them.
type startupDeps struct {
	groupFile, passwdFile string
	dirGroup              func(dir string) (uint32, error)
	egid                  uint32
	raiseNoFile           func()
	checkBinary           func(path string) error
}

// loadConfig and newDeps are what serve uses; tests replace them to reach the start-up checks without root.
var (
	loadConfig = func(path string) (config.Config, error) { return config.Load(path, 0) }
	newDeps    = realDeps
)

func realDeps() startupDeps {
	return startupDeps{groupFile: groupFile, passwdFile: passwdFile, dirGroup: dirGroup, egid: uint32(os.Getegid()), raiseNoFile: raiseNoFile,
		checkBinary: (&sandbox.JailerLauncher{}).CheckBinary}
}

// startupChecks is everything the helper verifies about its configuration and host before it listens. It is
// the first thing serve does after reading the config, and any error stops the start.
func startupChecks(cfg config.Config, socketDir string, d startupDeps) error {
	// A sandbox gid must not be one that reaches the socket: the socket directory's group or our own.
	dirGID, err := d.dirGroup(socketDir)
	if err != nil {
		return err
	}
	if err := cfg.CheckSocketGroups(dirGID, d.egid); err != nil {
		return err
	}
	// No sandbox gid may be a group that has members: they would hold its bits on a sandbox's directory.
	gf, err := os.Open(d.groupFile)
	if err != nil {
		return fmt.Errorf("cannot read the group file")
	}
	err = cfg.CheckGroupFile(gf)
	gf.Close()
	if err != nil {
		return err
	}
	pf, err := os.Open(d.passwdFile)
	if err != nil {
		return fmt.Errorf("cannot read the passwd file")
	}
	err = cfg.CheckPasswdFile(pf)
	pf.Close()
	if err != nil {
		return err
	}
	// The two pinned binaries must be root-owned, in a root-owned chain, with no symlink on the way.
	for _, b := range []string{cfg.JailerPath, cfg.FirecrackerPath} {
		if err := d.checkBinary(b); err != nil {
			return err
		}
	}
	d.raiseNoFile()
	return nil
}

// dropCaps drops the jailer-only capabilities from the effective set; a test replaces it.
var dropCaps = func(p hardening.Pinned) error { return p.DropJailerOnly() }

// readTasks returns the status text of every thread of this process; tests replace it.
var readTasks = func() ([]string, error) {
	ents, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		b, err := os.ReadFile("/proc/self/task/" + e.Name() + "/status")
		if err != nil {
			continue // the thread ended meanwhile
		}
		out = append(out, string(b))
	}
	return out, nil
}

// readStatus returns the process's own status text; tests replace it to feed a drifted one.
var readStatus = func() ([]byte, error) { return os.ReadFile("/proc/self/status") }

// dirGroup is the gid that owns dir (not following a symlink).
func dirGroup(dir string) (uint32, error) {
	fi, err := os.Lstat(dir)
	if err != nil {
		return 0, fmt.Errorf("cannot examine the socket directory: %v", err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("cannot examine the socket directory")
	}
	return st.Gid, nil
}

func main() {
	os.Exit(serve(os.Args[1:]))
}

func fail(format string, a ...any) int {
	fmt.Fprintf(os.Stderr, "event=fatal msg=%q\n", fmt.Sprintf(format, a...))
	return 1
}

func serve(args []string) int {
	fs := flag.NewFlagSet("fx-vmhelper", flag.ContinueOnError)
	cfgPath := fs.String("config", "", "root-owned config file")
	if fs.Parse(args) != nil || fs.NArg() != 0 || *cfgPath == "" {
		return 2
	}
	pinned := hardening.Load()
	// The first thing: CAP_DAC_OVERRIDE (held for the jailer only) leaves the effective set, so none of the
	// helper's own file operations can run with it. It stays permitted and inheritable, to be raised into the
	// jailer child's ambient set.
	if err := dropCaps(pinned); err != nil {
		return fail("process differs from the pinned set: %v", err)
	}
	// Fail closed on a unit that drifted from the pinned set: the process must hold exactly those
	// capabilities, no ambient ones, NoNewPrivs and a seccomp filter. One line, then exit.
	status, err := readStatus()
	if err != nil {
		return fail("cannot read the process status")
	}
	if err := pinned.CheckStatus(string(status)); err != nil {
		return fail("process differs from the pinned set: %v", err)
	}
	// Capabilities are per thread: every thread must show the same set, so none still holds the override.
	tasks, err := readTasks()
	if err != nil {
		return fail("cannot read the thread status")
	}
	for _, ts := range tasks {
		if err := pinned.CheckStatus(ts); err != nil {
			return fail("a thread differs from the pinned set: %v", err)
		}
	}
	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		return fail("%v", err)
	}
	mode, err := pinned.RuntimeDirMode()
	if err != nil {
		return fail("%v", err)
	}
	if err := startupChecks(cfg, pinned.RuntimeDirPath(), newDeps()); err != nil {
		return fail("%v", err)
	}
	ln, err := server.Listen(pinned.RuntimeDirPath(), pinned.SocketName, 0, mode)
	if err != nil {
		return fail("%v", err)
	}
	log := vmlog.New(os.Stderr, nil)
	log.Event("start", "protocol", fmt.Sprint(protocol.Version), "max_sandboxes", fmt.Sprint(cfg.MaxSandboxes))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	// The helper's own cgroup is the unit's: sandbox cgroups go below <unit>/vms, so the unit's device
	// policy covers the VMM. Stale ones from a previous run are killed before the directories are reaped.
	self, err := sandbox.ReadSelfCgroup()
	if err != nil {
		return fail("cannot read the process's cgroup")
	}
	unit, err := sandbox.UnitCgroup(self)
	if err != nil {
		return fail("%v", err)
	}
	parent, err := sandbox.SetupCgroup(cgroupRoot, unit, os.Getpid())
	if err != nil {
		return fail("cgroup setup failed: %v", err)
	}
	launcher := &sandbox.JailerLauncher{Jailer: cfg.JailerPath, Firecracker: cfg.FirecrackerPath, CgroupRoot: cgroupRoot, CgroupParent: parent, AmbientCaps: pinned.JailerOnlyCaps()}
	killed, stuck := launcher.ReapStale()
	log.Event("reap_cgroups", "removed", fmt.Sprint(killed), "failed", fmt.Sprint(stuck))
	mgr, err := sandbox.New(cfg, launcher)
	if err != nil {
		return fail("%v", err)
	}
	defer mgr.Close()
	reaped := mgr.Reap()
	log.Event("reap", "removed", fmt.Sprint(len(reaped.Removed)), "skipped", fmt.Sprint(reaped.Skipped), "failed", fmt.Sprint(reaped.Failed))
	s := &server.Server{RunnerUID: cfg.RunnerUID, Caps: cfg.Caps(), Backend: mgr, Log: log}
	if err := s.Serve(ctx, ln); err != nil {
		return fail("serve: %v", err)
	}
	log.Event("stop")
	return 0
}
