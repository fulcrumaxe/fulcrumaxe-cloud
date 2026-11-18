package hardening

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

var params = UnitParams{HelperPath: "/opt/example/fx-vmhelper", ConfigPath: "/etc/example/vmhelper.json", JailRoot: "/srv/example-jails", Group: "example-runner"}

func unitMap(t *testing.T, text string) map[string]string {
	t.Helper()
	m := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		if k, v, ok := strings.Cut(line, "="); ok && !strings.HasPrefix(line, "[") {
			if _, dup := m[k]; dup {
				t.Fatalf("directive %s written twice", k)
			}
			m[k] = v
		}
	}
	return m
}

// The unit is generated from hardening.json read off disk, not from the embedded copy: the test and the
// binary read the same file, and a stale embed would fail here.
func TestUnitCarriesEveryPinnedValue(t *testing.T) {
	data, err := os.ReadFile("hardening.json")
	if err != nil {
		t.Fatal(err)
	}
	p, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if got := Load(); fmt.Sprint(got) != fmt.Sprint(p) {
		t.Fatal("the embedded copy differs from the file on disk")
	}
	text, err := p.RenderUnit(params)
	if err != nil {
		t.Fatal(err)
	}
	u := unitMap(t, text)
	for k, v := range p.Directives {
		if u[k] != v {
			t.Errorf("%s: unit has %q, file has %q", k, u[k], v)
		}
	}
	if u["CapabilityBoundingSet"] != p.CapabilityBoundingSet() {
		t.Error("capability set differs")
	}
	if u["RuntimeDirectory"] != p.RuntimeDirectory || u["RuntimeDirectoryMode"] != p.RuntimeDirectoryMode {
		t.Error("runtime directory differs")
	}
	if u["User"] != "root" || u["Group"] != "example-runner" || u["ExecStart"] != "/opt/example/fx-vmhelper -config /etc/example/vmhelper.json" {
		t.Errorf("%v", u)
	}
	if u["ReadWritePaths"] != "/sys/fs/cgroup /srv/example-jails" {
		t.Errorf("ReadWritePaths %q", u["ReadWritePaths"])
	}
}

// The values the Spec names, stated here so that a change to the file shows up as a test failure.
func TestSpecValues(t *testing.T) {
	p := Load()
	want := map[string]string{
		"NoNewPrivileges": "yes", "ProtectSystem": "strict", "ProtectHome": "yes", "RestrictAddressFamilies": "AF_UNIX",
		"IPAddressDeny": "any", "UMask": "0077", "ProtectKernelModules": "yes",
	}
	for k, v := range want {
		if p.Directives[k] != v {
			t.Errorf("%s=%q, want %q", k, p.Directives[k], v)
		}
	}
	if p.Directives["SystemCallFilter"] == "" {
		t.Error("SystemCallFilter is not pinned")
	}
	if p.RuntimeDirectoryMode != "0750" {
		t.Errorf("RuntimeDirectoryMode %q", p.RuntimeDirectoryMode)
	}
	if p.SocketPath() != "/run/fx-vmhelper/helper.sock" {
		t.Error(p.SocketPath())
	}
}

func TestEveryCapabilityHasAReasonAndOnlyOnce(t *testing.T) {
	seen := map[string]bool{}
	nums := map[uint]bool{}
	for _, c := range Load().Capabilities {
		if !strings.HasPrefix(c.Name, "CAP_") || strings.TrimSpace(c.Reason) == "" || seen[c.Name] || nums[c.Number] || c.Number > 40 {
			t.Errorf("bad capability %+v", c)
		}
		seen[c.Name], nums[c.Number] = true, true
	}
	for _, never := range []string{"CAP_NET_ADMIN", "CAP_NET_RAW", "CAP_SYS_PTRACE", "CAP_SYS_MODULE", "CAP_SYS_RAWIO", "CAP_NET_BIND_SERVICE"} {
		if seen[never] {
			t.Errorf("%s must not be pinned: the helper creates no network object", never)
		}
	}
}

// The set is exactly the five the jailer needs. The four that were dropped each have a way round that the
// lifecycle change is built to (see "notes" in hardening.json), and CAP_SYS_CHROOT is unconfirmed until the
// real-root step runs the jailer.
func TestCapabilitySetIsTheMinimalFive(t *testing.T) {
	p := Load()
	if got := p.CapabilityBoundingSet(); got != "CAP_CHOWN CAP_SETGID CAP_SETUID CAP_SYS_ADMIN CAP_MKNOD" {
		t.Fatal(got)
	}
	for _, c := range p.Capabilities {
		if c.Name == "CAP_SYS_ADMIN" && strings.Contains(c.Reason, "cgroup") {
			t.Errorf("cgroup writes need no capability: %q", c.Reason)
		}
		for _, dropped := range []string{"CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_KILL", "CAP_SYS_CHROOT"} {
			if c.Name == dropped {
				t.Errorf("%s was dropped on purpose", dropped)
			}
		}
	}
	notes := strings.Join(p.Notes, "\n")
	for _, must := range []string{"CAP_SYS_CHROOT", "real-root", "cgroup.kill", "fchownat"} {
		if !strings.Contains(notes, must) {
			t.Errorf("notes do not mention %q", must)
		}
	}
}

func TestExtraDirectivesAndRuntimeMode(t *testing.T) {
	p := Load()
	for k, v := range map[string]string{
		"SystemCallArchitectures": "native", "LockPersonality": "yes", "RestrictSUIDSGID": "yes",
		"DevicePolicy": "closed", "DeviceAllow": "/dev/kvm rw", "SystemCallFilter": "@system-service @mount",
	} {
		if p.Directives[k] != v {
			t.Errorf("%s=%q, want %q", k, p.Directives[k], v)
		}
	}
	text, err := p.RenderUnit(params)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"SystemCallArchitectures=native", "LockPersonality=yes", "RestrictSUIDSGID=yes", "DevicePolicy=closed", "DeviceAllow=/dev/kvm rw"} {
		if !strings.Contains("\n"+text, "\n"+line+"\n") {
			t.Errorf("the unit lacks %q", line)
		}
	}
	if m, err := p.RuntimeDirMode(); err != nil || m != 0o750 {
		t.Fatalf("%v %v", m, err)
	}
	for _, bad := range []string{"", "0", "9", "0x1f", "7777", "rwx"} {
		q := p
		q.RuntimeDirectoryMode = bad
		if _, err := q.RuntimeDirMode(); err == nil {
			t.Errorf("mode %q accepted", bad)
		}
	}
}

// CapEff, CapBnd, CapAmb, NoNewPrivs and Seccomp are compared as /proc/<pid>/status prints them. The status
// text here follows the kernel's format, because a real helper cannot run in a non-root test.
func TestCheckStatus(t *testing.T) {
	p := Load()
	status := func(eff, bnd uint64, amb uint64, nnp, seccomp int) string {
		return fmt.Sprintf("Name:\tfx-vmhelper\nNoNewPrivs:\t%d\nSeccomp:\t%d\nCapInh:\t0000000000000000\nCapPrm:\t%016x\nCapEff:\t%016x\nCapBnd:\t%016x\nCapAmb:\t%016x\n", nnp, seccomp, eff, eff, bnd, amb)
	}
	good := func() string { return status(p.Mask(), p.Mask(), 0, 1, 2) }
	if err := p.CheckStatus(good()); err != nil {
		t.Fatal(err)
	}
	if p.Mask() != 0x082000c1 { // bits 0, 6, 7, 21, 27
		t.Fatalf("mask %016x", p.Mask())
	}
	for name, s := range map[string]string{
		"wider bounding set":  status(p.Mask(), p.Mask()|1<<12, 0, 1, 2),
		"narrower effective":  status(p.Mask()&^(1<<27), p.Mask(), 0, 1, 2),
		"full root":           status(0x000001ffffffffff, 0x000001ffffffffff, 0, 1, 2),
		"no caps":             status(0, 0, 0, 1, 2),
		"ambient capability":  status(p.Mask(), p.Mask(), 1<<21, 1, 2),
		"no_new_privs off":    status(p.Mask(), p.Mask(), 0, 0, 2),
		"seccomp off":         status(p.Mask(), p.Mask(), 0, 1, 0),
		"seccomp strict mode": status(p.Mask(), p.Mask(), 0, 1, 1),
		"missing line":        "Name:\tx\n",
		"junk":                "CapEff:\tzz\nCapBnd:\tzz\n",
		"missing NoNewPrivs":  strings.Replace(good(), "NoNewPrivs:\t1\n", "", 1),
		"missing Seccomp":     strings.Replace(good(), "Seccomp:\t2\n", "", 1),
		"missing CapAmb":      strings.Replace(good(), "CapAmb:\t0000000000000000\n", "", 1),
		"junk NoNewPrivs":     strings.Replace(good(), "NoNewPrivs:\t1", "NoNewPrivs:\tyes", 1),
		"hex where decimal":   strings.Replace(good(), "Seccomp:\t2", "Seccomp:\t0x2", 1),
	} {
		err := p.CheckStatus(s)
		if err == nil {
			t.Errorf("%s accepted", name)
		} else if strings.Contains(err.Error(), "\n") {
			t.Errorf("%s: the error is not one line: %q", name, err)
		}
	}
}

func TestUnitRefusesInjection(t *testing.T) {
	p := Load()
	for name, u := range map[string]UnitParams{
		"newline in config":  {HelperPath: "/a", ConfigPath: "/b\nExecStartPre=/bin/sh", JailRoot: "/c"},
		"space in helper":    {HelperPath: "/a b", ConfigPath: "/b", JailRoot: "/c"},
		"specifier in jail":  {HelperPath: "/a", ConfigPath: "/b", JailRoot: "/c%h"},
		"relative path":      {HelperPath: "a", ConfigPath: "/b", JailRoot: "/c"},
		"dotdot":             {HelperPath: "/a/../b", ConfigPath: "/b", JailRoot: "/c"},
		"root as jail":       {HelperPath: "/a", ConfigPath: "/b", JailRoot: "/"},
		"group with newline": {HelperPath: "/a", ConfigPath: "/b", JailRoot: "/c", Group: "g\nUser=x"},
		"empty":              {},
		"nul":                {HelperPath: "/a\x00", ConfigPath: "/b", JailRoot: "/c"},
		"quote":              {HelperPath: "/a\"", ConfigPath: "/b", JailRoot: "/c"},
	} {
		if _, err := p.RenderUnit(u); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

// When systemd is installed, its own table must know every syscall group the filter names.
func TestSyscallGroupsExist(t *testing.T) {
	bin, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skip("systemd-analyze is not installed")
	}
	for _, g := range strings.Fields(Load().Directives["SystemCallFilter"]) {
		if out, err := exec.Command(bin, "syscall-filter", g).CombinedOutput(); err != nil {
			t.Errorf("%s: %v: %s", g, err, out)
		}
	}
}
