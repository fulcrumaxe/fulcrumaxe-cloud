//go:build linux

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fx-vmhelper/internal/config"
	"fx-vmhelper/internal/hardening"
)

// The sandbox gid range of these tests is 200000..200003.
var startCfg = config.Config{GIDFirst: 200000, GIDCount: 4, JailerPath: "/opt/fx/jailer", FirecrackerPath: "/opt/fx/firecracker"}

type startRig struct {
	d      startupDeps
	raised int
	bins   []string
}

// newStartRig is a host where every check passes; a test makes exactly one of them fail.
func newStartRig(t *testing.T) *startRig {
	t.Helper()
	dir := t.TempDir()
	group := filepath.Join(dir, "group")
	passwd := filepath.Join(dir, "passwd")
	if err := os.WriteFile(group, []byte("root:x:0:\nusers:x:100:jp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(passwd, []byte("root:x:0:0::/root:/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := &startRig{}
	r.d = startupDeps{groupFile: group, passwdFile: passwd, egid: 0,
		dirGroup:    func(string) (uint32, error) { return 985, nil },
		raiseNoFile: func() { r.raised++ },
		checkBinary: func(p string) error { r.bins = append(r.bins, p); return nil }}
	return r
}

func TestStartupChecksPassOnAGoodHostAndRaiseTheLimit(t *testing.T) {
	r := newStartRig(t)
	if err := startupChecks(startCfg, "/run/x", r.d); err != nil {
		t.Fatal(err)
	}
	if r.raised != 1 {
		t.Errorf("the descriptor limit was raised %d times", r.raised)
	}
	if strings.Join(r.bins, " ") != "/opt/fx/jailer /opt/fx/firecracker" {
		t.Errorf("binaries checked: %v", r.bins)
	}
}

// Each check, on its own, stops the start: dropping any one of them from startupChecks fails a case here.
func TestEachStartupCheckStopsTheStart(t *testing.T) {
	cases := map[string]struct {
		break_ func(*startRig)
		want   string
	}{
		"socket directory group in the range": {func(r *startRig) { r.d.dirGroup = func(string) (uint32, error) { return 200001, nil } }, "socket group"},
		"socket directory unreadable":         {func(r *startRig) { r.d.dirGroup = func(string) (uint32, error) { return 0, errors.New("gone") } }, "gone"},
		"helper's own gid in the range":       {func(r *startRig) { r.d.egid = 200002 }, "socket group"},
		"group file: a group with members": {func(r *startRig) {
			_ = os.WriteFile(r.d.groupFile, []byte("sbx:x:200001:jp\n"), 0o644)
		}, "has members"},
		"group file missing":   {func(r *startRig) { r.d.groupFile += ".none" }, "group file"},
		"group file malformed": {func(r *startRig) { _ = os.WriteFile(r.d.groupFile, []byte("junk\n"), 0o644) }, "group file"},
		"passwd file: a user's primary group in the range": {func(r *startRig) {
			_ = os.WriteFile(r.d.passwdFile, []byte("u:x:1000:200003::/h:/bin/sh\n"), 0o644)
		}, "primary group"},
		"passwd file missing": {func(r *startRig) { r.d.passwdFile += ".none" }, "passwd file"},
		"jailer check fails": {func(r *startRig) {
			r.d.checkBinary = func(p string) error {
				if strings.HasSuffix(p, "jailer") {
					return errors.New("jailer refused")
				}
				return nil
			}
		}, "jailer refused"},
		"firecracker check fails": {func(r *startRig) {
			r.d.checkBinary = func(p string) error {
				if strings.HasSuffix(p, "firecracker") {
					return errors.New("firecracker refused")
				}
				return nil
			}
		}, "firecracker refused"},
	}
	for name, c := range cases {
		r := newStartRig(t)
		c.break_(r)
		err := startupChecks(startCfg, "/run/x", r.d)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want an error naming %q", name, err, c.want)
		}
	}
}

// serve runs the start-up checks, and fails closed with one fatal line when one of them fails.
func TestServeStopsWhenAStartupCheckFails(t *testing.T) {
	origS, origL, origD, origC := readStatus, loadConfig, newDeps, dropCaps
	defer func() { readStatus, loadConfig, newDeps, dropCaps = origS, origL, origD, origC }()
	p := hardening.Load()
	dropCaps = func(hardening.Pinned) error { return nil }
	readStatus = func() ([]byte, error) {
		return []byte("NoNewPrivs:\t1\nSeccomp:\t2\nCapInh:\t" + hexw(p.JailerOnlyMask()) + "\nCapPrm:\t" + hexw(p.Mask()) + "\nCapEff:\t" + hexw(p.EffectiveMask()) + "\nCapBnd:\t" + hexw(p.Mask()) + "\nCapAmb:\t0000000000000000\n"), nil
	}
	loadConfig = func(string) (config.Config, error) { return startCfg, nil }
	r := newStartRig(t)
	r.d.checkBinary = func(string) error { return errors.New("marker-binary-refused") }
	newDeps = func() startupDeps { return r.d }
	out, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	real := os.Stderr
	os.Stderr = out
	code := serve([]string{"-config", "ignored"})
	os.Stderr = real
	out.Close()
	b, _ := os.ReadFile(out.Name())
	if code != 1 || !strings.Contains(string(b), "marker-binary-refused") || strings.Count(string(b), "\n") != 1 {
		t.Fatalf("exit %d, output %q", code, b)
	}
	if r.raised != 0 {
		t.Error("the limit was raised although a check failed")
	}
}

func hexw(m uint64) string {
	const d = "0123456789abcdef"
	var b [16]byte
	for i := 15; i >= 0; i-- {
		b[i] = d[m&15]
		m >>= 4
	}
	return string(b[:])
}

// The capability drop is the first thing serve does, before the status is read and before any start-up
// check; a drop that fails stops the start with one line and nothing else has run.
func TestServeDropsFirstAndFailsClosed(t *testing.T) {
	origS, origL, origD, origC := readStatus, loadConfig, newDeps, dropCaps
	defer func() { readStatus, loadConfig, newDeps, dropCaps = origS, origL, origD, origC }()
	var order []string
	dropCaps = func(hardening.Pinned) error { order = append(order, "drop"); return errors.New("marker-drop-failed") }
	readStatus = func() ([]byte, error) { order = append(order, "status"); return nil, errors.New("x") }
	loadConfig = func(string) (config.Config, error) { order = append(order, "config"); return startCfg, nil }
	out, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	real := os.Stderr
	os.Stderr = out
	code := serve([]string{"-config", "ignored"})
	os.Stderr = real
	out.Close()
	b, _ := os.ReadFile(out.Name())
	if code != 1 || !strings.Contains(string(b), "marker-drop-failed") || strings.Count(string(b), "\n") != 1 || strings.Join(order, ",") != "drop" {
		t.Fatalf("exit %d, order %v, output %q", code, order, b)
	}
	// and with a drop that works, it still comes before the status, the config and the checks
	order = nil
	dropCaps = func(hardening.Pinned) error { order = append(order, "drop"); return nil }
	_ = serve([]string{"-config", "ignored"})
	if len(order) < 2 || order[0] != "drop" || order[1] != "status" {
		t.Fatalf("order %v", order)
	}
}

func TestMain(m *testing.M) {
	readTasks = func() ([]string, error) { return nil, nil } // the real threads of a test binary are not the helper's
	os.Exit(m.Run())
}

// Every thread is checked, not only the first: one that still holds the override stops the start.
func TestServeChecksEveryThread(t *testing.T) {
	origS, origT, origC := readStatus, readTasks, dropCaps
	defer func() { readStatus, readTasks, dropCaps = origS, origT, origC }()
	p := hardening.Load()
	st := func(eff uint64) string {
		return "NoNewPrivs:\t1\nSeccomp:\t2\nCapInh:\t" + hexw(p.JailerOnlyMask()) + "\nCapPrm:\t" + hexw(p.Mask()) + "\nCapEff:\t" + hexw(eff) + "\nCapBnd:\t" + hexw(p.Mask()) + "\nCapAmb:\t0000000000000000\n"
	}
	dropCaps = func(hardening.Pinned) error { return nil }
	readStatus = func() ([]byte, error) { return []byte(st(p.EffectiveMask())), nil }
	readTasks = func() ([]string, error) { return []string{st(p.EffectiveMask()), st(p.Mask())}, nil }
	out, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	real := os.Stderr
	os.Stderr = out
	code := serve([]string{"-config", "ignored"})
	os.Stderr = real
	out.Close()
	b, _ := os.ReadFile(out.Name())
	if code != 1 || !strings.Contains(string(b), "a thread differs from the pinned set") || !strings.Contains(string(b), "CapEff") {
		t.Fatalf("exit %d, output %q", code, b)
	}
}
