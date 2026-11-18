//go:build linux

package hardening

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

const dacBit = 1 // CAP_DAC_OVERRIDE

func TestJailerOnlyMasks(t *testing.T) {
	p := Load()
	if p.JailerOnlyMask() != 1<<dacBit {
		t.Fatalf("jailer-only mask %x", p.JailerOnlyMask())
	}
	if p.EffectiveMask()&(1<<dacBit) != 0 || p.Mask()&(1<<dacBit) == 0 {
		t.Fatal("CAP_DAC_OVERRIDE must be in the set and not in the effective mask")
	}
	if got := p.JailerOnlyCaps(); len(got) != 1 || got[0] != dacBit {
		t.Fatalf("%v", got)
	}
}

func TestDropEffective(t *testing.T) {
	d := [2]capData{{effective: 0x082000c3, permitted: 0x082000c3}}
	if err := dropEffective(&d, []uintptr{dacBit}); err != nil {
		t.Fatal(err)
	}
	if d[0].effective != 0x082000c1 || d[0].permitted != 0x082000c3 || d[0].inheritable != 1<<dacBit {
		t.Fatalf("%+v", d[0])
	}
	// not granted by the unit: refused, nothing changed
	d = [2]capData{{effective: 0x082000c1, permitted: 0x082000c1}}
	if err := dropEffective(&d, []uintptr{dacBit}); err == nil {
		t.Error("a capability that is not permitted was accepted")
	}
	if err := dropEffective(&d, []uintptr{64}); err == nil {
		t.Error("a capability number out of range was accepted")
	}
	// the second word
	d = [2]capData{{}, {effective: 1, permitted: 1}}
	if err := dropEffective(&d, []uintptr{32}); err != nil || d[1].effective != 0 || d[1].inheritable != 1 {
		t.Errorf("%v %+v", err, d[1])
	}
}

func TestDropJailerOnlyUsesTheKernelCalls(t *testing.T) {
	og, os_ := capget, capset
	defer func() { capget, capset = og, os_ }()
	var set [2]capData
	var hdr capHeader
	sets := 0
	capget = func(h *capHeader, d *[2]capData) error {
		d[0] = capData{effective: 0x082000c3, permitted: 0x082000c3}
		return nil
	}
	capset = func(h *capHeader, d *[2]capData) error { set, hdr = *d, *h; sets++; return nil }
	if err := Load().DropJailerOnly(); err != nil {
		t.Fatal(err)
	}
	if sets != 1 || hdr.version != linuxCapabilityVersion3 || uint64(set[0].effective) != Load().EffectiveMask()&0xffffffff || set[0].inheritable != 1<<dacBit {
		t.Fatalf("%d %+v %+v", sets, hdr, set)
	}
	capget = func(*capHeader, *[2]capData) error { return errors.New("no") }
	if err := Load().DropJailerOnly(); err == nil {
		t.Error("a failed capget was ignored")
	}
	capget = func(h *capHeader, d *[2]capData) error {
		d[0] = capData{effective: 0x082000c3, permitted: 0x082000c3}
		return nil
	}
	capset = func(*capHeader, *[2]capData) error { return errors.New("no") }
	if err := Load().DropJailerOnly(); err == nil {
		t.Error("a failed capset was ignored")
	}
}

// TestDropHelperProcess is run by TestEffectiveSetAfterTheDrop inside a user namespace (it does nothing
// otherwise): it drops, then prints what the kernel reports in /proc/self/status.
func TestDropHelperProcess(t *testing.T) {
	if os.Getenv("FX_CAPS_HELPER") != "1" {
		t.Skip("helper process")
	}
	if err := Load().DropJailerOnly(); err != nil {
		t.Fatal(err)
	}
	st, _ := os.ReadFile("/proc/self/status")
	for _, f := range []string{"CapInh", "CapPrm", "CapEff", "CapAmb"} {
		for _, line := range strings.Split(string(st), "\n") {
			if v, ok := strings.CutPrefix(line, f+":"); ok {
				println("STATUS", f, strings.TrimSpace(v))
			}
		}
	}
}

// After the start-up drop, /proc/self/status shows CAP_DAC_OVERRIDE in CapPrm and CapInh and not in CapEff.
// The drop needs capabilities, so the test borrows a root of a fresh user namespace (unshare); where the
// kernel refuses that, it skips, and the real-root workflow makes the same assertion on a real root.
func TestEffectiveSetAfterTheDrop(t *testing.T) {
	bin, err := exec.LookPath("unshare")
	if err != nil {
		t.Skip("unshare is not installed")
	}
	// The drop changes every thread with AllThreadsSyscall, which a cgo binary refuses; this test binary may
	// be one (-race needs cgo), so the helper is a separate test binary built without it.
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go tool to build the helper process without cgo")
	}
	self := t.TempDir() + "/hardening.test"
	build := exec.Command(goBin, "test", "-c", "-o", self, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOFLAGS=")
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build the helper process: %v\n%s", err, out)
	}
	cmd := exec.Command(bin, "--user", "--map-root-user", self, "-test.run=^TestDropHelperProcess$", "-test.v")
	cmd.Env = append(os.Environ(), "FX_CAPS_HELPER=1")
	out, err := cmd.CombinedOutput()
	if err != nil && strings.Contains(string(out), "nshare") {
		t.Skipf("no user namespace here: %s", out)
	}
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	got := map[string]uint64{}
	for _, line := range strings.Split(string(out), "\n") {
		if f := strings.Fields(line); len(f) == 3 && f[0] == "STATUS" {
			n, err := strconv.ParseUint(f[2], 16, 64)
			if err != nil {
				t.Fatal(err)
			}
			got[f[1]] = n
		}
	}
	if len(got) != 4 {
		t.Fatalf("status lines missing: %q", out)
	}
	if got["CapEff"]&(1<<dacBit) != 0 {
		t.Errorf("CapEff %016x still holds CAP_DAC_OVERRIDE after the drop", got["CapEff"])
	}
	if got["CapPrm"]&(1<<dacBit) == 0 || got["CapInh"]&(1<<dacBit) == 0 {
		t.Errorf("CapPrm %016x or CapInh %016x lost CAP_DAC_OVERRIDE", got["CapPrm"], got["CapInh"])
	}
}
