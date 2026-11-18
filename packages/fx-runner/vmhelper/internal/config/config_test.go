package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const good = `{"jail_root":"/srv/fx-jails","runner_uid":4242,"runner_gid":4243,"uid_first":200000,"uid_count":16,"gid_first":200000,"gid_count":16,"max_sandboxes":8,"max_vcpus":4,"max_mem_mb":8192}`

func TestGoodConfig(t *testing.T) {
	c, err := Parse([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if c.RunnerUID != 4242 || c.MaxSandboxes != 8 || c.JailRoot != "/srv/fx-jails" || c.Caps().MaxMemMB != 8192 {
		t.Fatalf("%+v", c)
	}
}

// There is no default for any key: dropping each one in turn refuses to start.
func TestEveryKeyIsRequired(t *testing.T) {
	for _, k := range keys {
		var kept []string
		for _, kv := range strings.Split(strings.Trim(good, "{}"), ",") {
			if !strings.HasPrefix(kv, `"`+k+`"`) {
				kept = append(kept, kv)
			}
		}
		_, err := Parse([]byte("{" + strings.Join(kept, ",") + "}"))
		if err == nil || !strings.Contains(err.Error(), "required key") || !strings.Contains(err.Error(), k) {
			t.Errorf("without %s: %v", k, err)
		}
	}
}

func TestRefusals(t *testing.T) {
	sub := func(from, to string) string { return strings.Replace(good, from, to, 1) }
	cases := map[string]string{
		"unknown key":         sub(`"max_vcpus":4`, `"max_vcpus":4,"shell":"sh"`),
		"duplicate key":       sub(`"max_vcpus":4`, `"max_vcpus":4,"max_vcpus":5`),
		"relative jail root":  sub("/srv/fx-jails", "jails"),
		"dotdot jail root":    sub("/srv/fx-jails", "/srv/../fx-jails"),
		"trailing slash":      sub("/srv/fx-jails", "/srv/fx-jails/"),
		"root as jail root":   sub("/srv/fx-jails", "/"),
		"runner uid 0":        sub(`"runner_uid":4242`, `"runner_uid":0`),
		"float":               sub(`"max_vcpus":4`, `"max_vcpus":4.0`),
		"uid range too small": sub(`"uid_count":16`, `"uid_count":7`),
		"gid range too small": sub(`"gid_count":16`, `"gid_count":7`),
		"range includes 0":    sub(`"uid_first":200000`, `"uid_first":0`),
		"range holds runner":  sub(`"uid_first":200000`, `"uid_first":4240`),
		"cap of 0":            sub(`"max_mem_mb":8192`, `"max_mem_mb":0`),
		"too many sandboxes":  sub(`"max_sandboxes":8`, `"max_sandboxes":5000`),
		"jail root not str":   sub(`"/srv/fx-jails"`, `7`),
		"nul in path":         sub("/srv/fx-jails", `/srv/a\u0000b`),
	}
	for name, in := range cases {
		if _, err := Parse([]byte(in)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The uid and gid ranges have a floor and exclusions, and each refusal says which rule it was.
func TestRangeFloorAndExclusions(t *testing.T) {
	sub := func(from, to string) string { return strings.Replace(good, from, to, 1) }
	cases := []struct{ name, in, want string }{
		{"uid range starts at 1", sub(`"uid_first":200000`, `"uid_first":1`), "uid range must start at 100000"},
		{"uid range just below the floor", sub(`"uid_first":200000`, `"uid_first":99999`), "uid range must start at 100000"},
		{"gid range starts at 1000", sub(`"gid_first":200000`, `"gid_first":1000`), "gid range must start at 100000"},
		{"gid range starts at 0", sub(`"gid_first":200000`, `"gid_first":0`), "gid range must start at 100000"},
		{"uid range holds the runner", sub(`"runner_uid":4242`, `"runner_uid":200003`), "must not include runner_uid"},
		{"gid range holds the runner gid", sub(`"runner_gid":4243`, `"runner_gid":200015`), "must not include runner_gid"},
		{"runner gid 0", sub(`"runner_gid":4243`, `"runner_gid":0`), "runner_gid must not be 0"},
		{"runner gid missing", sub(`"runner_gid":4243,`, ``), `"runner_gid" is missing`},
	}
	for _, c := range cases {
		if _, err := Parse([]byte(c.in)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	// The floor itself is allowed, and so is a runner uid or gid just outside the range.
	ok := sub(`"uid_first":200000`, `"uid_first":100000`)
	ok = strings.Replace(ok, `"gid_first":200000`, `"gid_first":100000`, 1)
	ok = strings.Replace(ok, `"runner_uid":4242`, `"runner_uid":100016`, 1)
	ok = strings.Replace(ok, `"runner_gid":4243`, `"runner_gid":99999`, 1)
	if _, err := Parse([]byte(ok)); err != nil {
		t.Fatal(err)
	}
}

// 65534 is refused whatever the floor is. With the floor at MinID no range can reach it, so the rule is
// exercised with a lower floor.
func TestNobodyIsNeverInARange(t *testing.T) {
	for _, tc := range []struct{ first, count uint32 }{{65534, 1}, {60000, 10000}, {1, 70000}} {
		if err := checkRange("uid", tc.first, tc.count, 1); err == nil || !strings.Contains(err.Error(), "65534") {
			t.Errorf("%d+%d: %v", tc.first, tc.count, err)
		}
	}
	if err := checkRange("uid", 65535, 100, 1); err != nil {
		t.Fatal(err)
	}
	if err := checkRange("gid", 0, 5, 0); err == nil || !strings.Contains(err.Error(), "must not include 0") {
		t.Fatalf("%v", err)
	}
}

// The socket group is only known at run time (the group of the directory the socket sits in, and the
// helper's own gid), so main checks it against the range after Parse.
func TestSocketGroupMustNotBeInTheGIDRange(t *testing.T) {
	c, err := Parse([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.CheckSocketGroups(4243, 0, 199999, 200016); err != nil {
		t.Fatal(err)
	}
	for _, g := range []uint32{200000, 200008, 200015} {
		if err := c.CheckSocketGroups(4243, g); err == nil || !strings.Contains(err.Error(), "socket group") {
			t.Errorf("gid %d: %v", g, err)
		}
	}
}

// The error for a range that is too small names both numbers.
func TestSmallRangeNamesBothNumbers(t *testing.T) {
	_, err := Parse([]byte(strings.Replace(good, `"uid_count":16`, `"uid_count":7`, 1)))
	if err == nil || !strings.Contains(err.Error(), "7") || !strings.Contains(err.Error(), "max_sandboxes is 8") {
		t.Fatal(err)
	}
}

func TestLoadChecksOwnerModeAndSymlink(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.json")
	if err := os.WriteFile(file, []byte(good), 0o600); err != nil {
		t.Fatal(err)
	}
	me := uint32(os.Getuid())
	if _, err := Load(file, me); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(file, me+1); err == nil || !strings.Contains(err.Error(), "owned by") {
		t.Fatalf("wrong owner accepted: %v", err)
	}
	if err := os.Chmod(file, 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(file, me); err == nil {
		t.Fatal("a world-writable config was accepted")
	}
	if err := os.Chmod(file, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(link, me); err == nil {
		t.Fatal("a symlink was followed")
	}
	if _, err := Load(dir, me); err == nil {
		t.Fatal("a directory was accepted")
	}
	if _, err := Load(filepath.Join(dir, "absent.json"), me); err == nil {
		t.Fatal("a missing file was accepted")
	}
}
