//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"fx-vmhelper/internal/hardening"
)

// A process whose capabilities are right but whose unit lost NoNewPrivileges, the seccomp filter or an
// empty ambient set refuses to serve: one fatal line naming the field, exit 1, and nothing is created.
func TestDriftedStatusFailsClosedWithOneLine(t *testing.T) {
	mask := hardening.Load().Mask()
	status := func(amb uint64, nnp, seccomp int) string {
		return fmt.Sprintf("NoNewPrivs:\t%d\nSeccomp:\t%d\nCapPrm:\t%016x\nCapEff:\t%016x\nCapBnd:\t%016x\nCapAmb:\t%016x\n", nnp, seccomp, mask, mask, mask, amb)
	}
	orig := readStatus
	defer func() { readStatus = orig }()
	dir := t.TempDir()
	for name, tc := range map[string]struct{ status, want string }{
		"no_new_privs off": {status(0, 0, 2), "NoNewPrivs"},
		"seccomp off":      {status(0, 1, 0), "Seccomp"},
		"ambient set":      {status(1, 1, 2), "CapAmb"},
	} {
		readStatus = func() ([]byte, error) { return []byte(tc.status), nil }
		out, err := os.CreateTemp(dir, "stderr")
		if err != nil {
			t.Fatal(err)
		}
		realStderr := os.Stderr
		os.Stderr = out
		code := serve([]string{"-config", filepath.Join(dir, "none.json")})
		os.Stderr = realStderr
		out.Close()
		b, _ := os.ReadFile(out.Name())
		if code != 1 || !strings.HasPrefix(string(b), "event=fatal msg=") || strings.Count(string(b), "\n") != 1 ||
			!strings.Contains(string(b), "pinned set") || !strings.Contains(string(b), tc.want) {
			t.Errorf("%s: exit %d, output %q", name, code, b)
		}
	}
	// An unreadable status also stops the start.
	readStatus = func() ([]byte, error) { return nil, os.ErrNotExist }
	if code := serve([]string{"-config", filepath.Join(dir, "none.json")}); code != 1 {
		t.Errorf("unreadable status: exit %d", code)
	}
}

// The built binary, run as an ordinary user, refuses to serve: it does not hold the pinned capability
// set. It prints one fatal line, exits 1, and creates nothing. (The success path needs root: pending
// the real-root CI step.)
func TestBinaryRefusesToServeWithoutThePinnedCapabilities(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fx-vmhelper")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	cmd := exec.Command(bin, "-config", filepath.Join(dir, "none.json"))
	out, err := cmd.CombinedOutput()
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() != 1 || !strings.HasPrefix(string(out), "event=fatal msg=") || strings.Count(string(out), "\n") != 1 {
		t.Fatalf("%v: %q", err, out)
	}
	if !strings.Contains(string(out), "pinned set") {
		t.Fatalf("%q", out)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("something was created: %v", entries)
	}
	// no config flag: usage error, exit 2
	if err := exec.Command(bin).Run(); err == nil || err.(*exec.ExitError).ExitCode() != 2 {
		t.Fatalf("%v", err)
	}
}

// raiseNoFile lifts the soft descriptor limit to 8192, or to the hard limit when that is lower, and never
// lowers it.
func TestRaiseNoFile(t *testing.T) {
	var orig syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &orig); err != nil {
		t.Fatal(err)
	}
	defer syscall.Setrlimit(syscall.RLIMIT_NOFILE, &orig)
	get := func() syscall.Rlimit {
		var l syscall.Rlimit
		if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &l); err != nil {
			t.Fatal(err)
		}
		return l
	}
	low := syscall.Rlimit{Cur: 256, Max: orig.Max}
	if orig.Max < 256 {
		t.Skip("hard limit below 256")
	}
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &low); err != nil {
		t.Fatal(err)
	}
	raiseNoFile()
	want := uint64(8192)
	if orig.Max < want {
		want = orig.Max
	}
	if got := get(); got.Cur != want || got.Max != orig.Max {
		t.Fatalf("soft limit %d (hard %d), want %d (hard %d)", got.Cur, got.Max, want, orig.Max)
	}
	// a limit already above the target is left alone
	raiseNoFileTo(100)
	if got := get(); got.Cur != want {
		t.Fatalf("a lower target changed the limit to %d", got.Cur)
	}
	// a target above the hard limit is capped there
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 256, Max: 1024}); err != nil {
		t.Fatal(err)
	}
	raiseNoFileTo(1 << 20)
	if got := get(); got.Cur != 1024 {
		t.Fatalf("soft limit %d, want the hard limit 1024", got.Cur)
	}
}
