//go:build linux

package hardening

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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

// fakeThread is a fake kernel for WithCaps: one thread with an effective and a permitted word, and a log
// of every set made on it.
func fakeThread(t *testing.T, eff, perm uint32) *[]uint32 {
	t.Helper()
	og, ot := capget, threadCapset
	t.Cleanup(func() { capget, threadCapset = og, ot })
	cur := eff
	var log []uint32
	capget = func(h *capHeader, d *[2]capData) error { d[0] = capData{effective: cur, permitted: perm}; return nil }
	threadCapset = func(h *capHeader, d *[2]capData) error { cur = d[0].effective; log = append(log, cur); return nil }
	return &log
}

func TestWithCapsRaisesOnlyForTheCallAndRestores(t *testing.T) {
	sets := fakeThread(t, 0x82000c1, 0x82000c3)
	var during []uint32
	called := 0
	err := WithCaps([]uintptr{dacBit}, func() error { called++; during = append(during, *sets...); return errors.New("f") })
	if err == nil || err.Error() != "f" || called != 1 {
		t.Fatalf("%v %d", err, called)
	}
	if len(during) != 1 || during[0] != 0x82000c3 {
		t.Fatalf("raised set %x", during)
	}
	if got := *sets; len(got) != 2 || got[1] != 0x82000c1 {
		t.Fatalf("not restored: %x", got)
	}
}

func TestWithCapsRestoresAfterAPanic(t *testing.T) {
	sets := fakeThread(t, 0x1, 0x3)
	func() {
		defer func() { _ = recover() }()
		_ = WithCaps([]uintptr{dacBit}, func() error { panic("boom") })
	}()
	if got := *sets; len(got) != 2 || got[1] != 0x1 {
		t.Fatalf("not restored after a panic: %x", got)
	}
}

func TestWithCapsRefusesWhatIsNotPermittedAndReportsAFailedRestore(t *testing.T) {
	sets := fakeThread(t, 0x1, 0x1) // CAP_DAC_OVERRIDE (bit 1) is not permitted
	if err := WithCaps([]uintptr{dacBit}, func() error { t.Fatal("f ran"); return nil }); err == nil || len(*sets) != 0 {
		t.Fatalf("%v %x", err, *sets)
	}
	if err := WithCaps([]uintptr{64}, func() error { return nil }); err == nil {
		t.Fatal("a capability number out of range was accepted")
	}
	fakeThread(t, 0x1, 0x3)
	n := 0
	threadCapset = func(*capHeader, *[2]capData) error {
		if n++; n == 2 {
			return errors.New("no")
		}
		return nil
	}
	var lines []string
	og := fatal
	defer func() { fatal = og }()
	fatal = func(l string) { lines = append(lines, l) }
	_ = WithCaps([]uintptr{dacBit}, func() error { return nil })
	if len(lines) != 1 || strings.Contains(lines[0], "\n") || !strings.Contains(lines[0], "fatal") {
		t.Fatalf("a failed restore must end the process with one fatal line: %q", lines)
	}
}

// Only the API dial and the v.sock handover raise the capability: every other call of WithCaps in the helper's
// source is a failure of this test, and so is either of the two going missing.
func TestWithCapsIsCalledOnlyByTheTwoAllowedOperations(t *testing.T) {
	var found []string
	err := filepath.Walk("../..", func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		b, _ := os.ReadFile(p)
		fn := ""
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "func ") {
				fn = line
			}
			if strings.Contains(line, "WithCaps(") && !strings.HasPrefix(strings.TrimSpace(line), "//") && !strings.HasPrefix(line, "func WithCaps") {
				found = append(found, filepath.Base(p)+": "+fn)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"vmapi.go: func (l *JailerLauncher) dialAPI(s Spec, pid int) (net.Conn, error) {",
		"vmapi.go: func (l *JailerLauncher) handOverSocket(s Spec) error {",
	}
	sort.Strings(found)
	sort.Strings(want)
	if strings.Join(found, "\n") != strings.Join(want, "\n") {
		t.Fatalf("WithCaps is called from %q, want exactly %q", found, want)
	}
}
