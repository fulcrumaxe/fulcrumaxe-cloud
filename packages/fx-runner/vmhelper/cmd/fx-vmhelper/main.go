//go:build linux

// Command fx-vmhelper is the root service behind the local runner's microVM sandboxes. This build holds
// the protocol and the server: the socket, the peer-uid gate, strict frames, logging and the pinned
// hardening values. The sandbox lifecycle (jail, cgroup, jailer launch) arrives in the next change, so
// until then every prepare is refused with "unavailable" and nothing is ever created.
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
	"fx-vmhelper/internal/server"
	"fx-vmhelper/internal/vmlog"
)

// noSandboxes is the backend of this build: nothing can be prepared, so nothing exists to start or destroy.
type noSandboxes struct{}

func (noSandboxes) Prepare(protocol.Request) protocol.Code { return protocol.Unavailable }
func (noSandboxes) Start(string) protocol.Code             { return protocol.UnknownSandbox }
func (noSandboxes) Destroy(string) protocol.Code           { return protocol.UnknownSandbox }
func (noSandboxes) List() ([]server.Entry, protocol.Code)  { return nil, protocol.OK }

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
	ln, err := server.Listen(pinned.RuntimeDirPath(), pinned.SocketName, 0, mode)
	if err != nil {
		return fail("%v", err)
	}
	log := vmlog.New(os.Stderr, nil)
	log.Event("start", "protocol", fmt.Sprint(protocol.Version), "max_sandboxes", fmt.Sprint(cfg.MaxSandboxes))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	s := &server.Server{RunnerUID: cfg.RunnerUID, Caps: cfg.Caps(), Backend: noSandboxes{}, Log: log}
	if err := s.Serve(ctx, ln); err != nil {
		return fail("serve: %v", err)
	}
	log.Event("stop")
	return 0
}
