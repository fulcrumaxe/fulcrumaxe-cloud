//go:build linux

// Command fx-vmhelper is the root service behind the local runner's microVM sandboxes. This build holds
// the protocol, the server and the sandbox registry (ids, jail and vsock directories, reaping). The
// jailer launch, cgroups and uid/gid drop arrive in the next change: until then start answers "unavailable".
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
	// Fail closed on a unit that drifted from the pinned set: the process must hold exactly those
	// capabilities, no ambient ones, NoNewPrivs and a seccomp filter. One line, then exit.
	status, err := readStatus()
	if err != nil {
		return fail("cannot read the process status")
	}
	if err := pinned.CheckStatus(string(status)); err != nil {
		return fail("process differs from the pinned set: %v", err)
	}
	cfg, err := config.Load(*cfgPath, 0)
	if err != nil {
		return fail("%v", err)
	}
	mode, err := pinned.RuntimeDirMode()
	if err != nil {
		return fail("%v", err)
	}
	// A sandbox gid must not be one that reaches the socket: the socket directory's group or our own.
	dirGID, err := dirGroup(pinned.RuntimeDirPath())
	if err != nil {
		return fail("%v", err)
	}
	if err := cfg.CheckSocketGroups(dirGID, uint32(os.Getegid())); err != nil {
		return fail("%v", err)
	}
	// No sandbox gid may be a group that has members: they would hold its bits on a sandbox's directory.
	gf, err := os.Open(groupFile)
	if err != nil {
		return fail("cannot read the group file")
	}
	err = cfg.CheckGroupFile(gf)
	gf.Close()
	if err != nil {
		return fail("%v", err)
	}
	pf, err := os.Open(passwdFile)
	if err != nil {
		return fail("cannot read the passwd file")
	}
	err = cfg.CheckPasswdFile(pf)
	pf.Close()
	if err != nil {
		return fail("%v", err)
	}
	raiseNoFile()
	ln, err := server.Listen(pinned.RuntimeDirPath(), pinned.SocketName, 0, mode)
	if err != nil {
		return fail("%v", err)
	}
	log := vmlog.New(os.Stderr, nil)
	log.Event("start", "protocol", fmt.Sprint(protocol.Version), "max_sandboxes", fmt.Sprint(cfg.MaxSandboxes))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	// This build has no launcher: prepare builds the directories, start answers "unavailable".
	mgr, err := sandbox.New(cfg, sandbox.NoLauncher{})
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
