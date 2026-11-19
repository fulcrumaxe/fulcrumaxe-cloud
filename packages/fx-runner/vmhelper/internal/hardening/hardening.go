// Package hardening holds the one file of pinned values for the helper's systemd unit and capability
// set (hardening.json, embedded in the binary). The generated unit, the start-up capability check and
// the tests all read it; nothing else in the tree restates a value from it.
package hardening

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
)

//go:embed hardening.json
var raw []byte

type Capability struct {
	Name   string `json:"name"`
	Number uint   `json:"number"`
	Reason string `json:"reason"`
	// JailerOnly marks a capability the helper holds in its permitted and inheritable sets but never in its
	// effective set: it is raised into the ambient set of the jailer child only.
	JailerOnly bool `json:"jailer_only,omitempty"`
}

// Pinned is the parsed file.
type Pinned struct {
	RuntimeDirectory     string            `json:"runtime_directory"`
	RuntimeDirectoryMode string            `json:"runtime_directory_mode"`
	SocketName           string            `json:"socket_name"`
	StateDirectory       string            `json:"state_directory"`
	StateDirectoryMode   string            `json:"state_directory_mode"`
	ReadWritePaths       []string          `json:"read_write_paths"`
	Directives           map[string]Values `json:"directives"`
	Capabilities         []Capability      `json:"capabilities"`
	Notes                []string          `json:"notes"`
}

// Values are the values of one directive: a JSON string is one line, an array is one line per element
// (systemd takes DeviceAllow= once per device).
type Values []string

func (v *Values) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*v = Values{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil || len(many) == 0 {
		return errors.New("a directive is a string or a non-empty array of strings")
	}
	*v = many
	return nil
}

// RuntimeDirMode is RuntimeDirectoryMode as a file mode (the file writes it in octal, as systemd does).
func (p Pinned) RuntimeDirMode() (os.FileMode, error) {
	n, err := strconv.ParseUint(p.RuntimeDirectoryMode, 8, 32)
	if err != nil || n > 0o777 || n == 0 {
		return 0, errors.New("hardening.json: runtime_directory_mode is not an octal mode")
	}
	return os.FileMode(n), nil
}

// Load parses the embedded file. It panics on a malformed one: that is a build error, caught by the tests.
func Load() Pinned {
	p, err := Parse(raw)
	if err != nil {
		panic(err)
	}
	return p
}

// Parse reads a copy of the file's bytes (tests use it to read the file from disk too).
func Parse(data []byte) (Pinned, error) {
	var p Pinned
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return Pinned{}, fmt.Errorf("hardening.json: %w", err)
	}
	if p.RuntimeDirectory == "" || p.SocketName == "" || len(p.Capabilities) == 0 || len(p.Directives) == 0 {
		return Pinned{}, errors.New("hardening.json: a required value is empty")
	}
	if _, err := p.RuntimeDirMode(); err != nil {
		return Pinned{}, err
	}
	return p, nil
}

// SocketPath is where the helper listens: inside its RuntimeDirectory.
func (p Pinned) SocketPath() string { return path.Join("/run", p.RuntimeDirectory, p.SocketName) }

// RuntimeDirPath is the directory the socket sits in.
func (p Pinned) RuntimeDirPath() string { return path.Join("/run", p.RuntimeDirectory) }

// CapabilityBoundingSet is the exact set, in file order, as the unit writes it.
func (p Pinned) CapabilityBoundingSet() string {
	names := make([]string, len(p.Capabilities))
	for i, c := range p.Capabilities {
		names[i] = c.Name
	}
	return strings.Join(names, " ")
}

// Mask is the set as the hex word /proc/<pid>/status prints for CapEff and CapBnd.
func (p Pinned) Mask() uint64 {
	var m uint64
	for _, c := range p.Capabilities {
		m |= 1 << c.Number
	}
	return m
}

// EffectiveMask is the set the helper holds effective after start-up: every pinned capability except the
// jailer-only ones.
func (p Pinned) EffectiveMask() uint64 {
	var m uint64
	for _, c := range p.Capabilities {
		if !c.JailerOnly {
			m |= 1 << c.Number
		}
	}
	return m
}

// JailerOnlyMask is the set held permitted and inheritable but not effective.
func (p Pinned) JailerOnlyMask() uint64 { return p.Mask() &^ p.EffectiveMask() }

// JailerOnlyCaps lists the jailer-only capability numbers, for the child's ambient set.
func (p Pinned) JailerOnlyCaps() []uintptr {
	var out []uintptr
	for _, c := range p.Capabilities {
		if c.JailerOnly {
			out = append(out, uintptr(c.Number))
		}
	}
	return out
}

// CheckStatus compares a /proc/<pid>/status text with what the unit pins and the start-up drop leaves:
// CapEff the effective mask, CapPrm and CapBnd the whole set, CapInh the jailer-only caps, CapAmb empty, NoNewPrivs 1 (NoNewPrivileges=yes) and Seccomp 2 (a filter is installed:
// SystemCallFilter=). A unit that lost any of them still starts, so the process checks itself. The error
// is one line and names the field, never the status text.
func (p Pinned) CheckStatus(status string) error {
	for _, f := range []struct {
		name string
		want uint64
	}{{"CapEff", p.EffectiveMask()}, {"CapPrm", p.Mask()}, {"CapBnd", p.Mask()}, {"CapInh", p.JailerOnlyMask()}} {
		got, ok := statusNum(status, f.name, 16)
		if !ok {
			return fmt.Errorf("%s is missing from the process status", f.name)
		}
		if got != f.want {
			return fmt.Errorf("%s is %016x, pinned set is %016x", f.name, got, f.want)
		}
	}
	if got, ok := statusNum(status, "CapAmb", 16); !ok || got != 0 {
		return fmt.Errorf("CapAmb is %016x, it must be empty", got)
	}
	if got, ok := statusNum(status, "NoNewPrivs", 10); !ok || got != 1 {
		return errors.New("NoNewPrivs is not 1: NoNewPrivileges is not in force")
	}
	if got, ok := statusNum(status, "Seccomp", 10); !ok || got != 2 {
		return errors.New("Seccomp is not 2: the system call filter is not in force")
	}
	return nil
}

// statusNum reads the number on the line "<field>:\t<n>" of a status text, in the given base.
func statusNum(status, field string, base int) (uint64, bool) {
	for _, line := range strings.Split(status, "\n") {
		if v, ok := strings.CutPrefix(line, field+":"); ok {
			n, err := strconv.ParseUint(strings.TrimSpace(v), base, 64)
			return n, err == nil
		}
	}
	return 0, false
}

// UnitParams are the values that differ per machine.
type UnitParams struct {
	HelperPath  string // absolute path of the root-owned binary
	ConfigPath  string // absolute path of the root-owned config
	JailRoot    string // the config's jail_root; the unit may write there and in SnapshotDir, and nowhere else on disk
	SnapshotDir string // the config's snapshot_dir; under ProtectSystem=strict it is read-only unless listed here
	Group       string // optional: the group that owns the RuntimeDirectory (the runner's group)
}

func safeToken(s string) bool {
	return s != "" && !strings.ContainsAny(s, " \t\r\n\x00%\"'\\$;") && strings.TrimFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) == s
}

func safePath(s string) bool { return safeToken(s) && path.IsAbs(s) && path.Clean(s) == s && s != "/" }

// RenderUnit generates the systemd unit text. It refuses a parameter that could add a directive.
func (p Pinned) RenderUnit(u UnitParams) (string, error) {
	if !safePath(u.HelperPath) || !safePath(u.ConfigPath) || !safePath(u.JailRoot) || !safePath(u.SnapshotDir) || (u.Group != "" && !safeToken(u.Group)) {
		return "", errors.New("unit parameters must be clean absolute paths and a plain group name")
	}
	var b strings.Builder
	b.WriteString("[Unit]\nDescription=fx-vmhelper: root service for the local runner's microVM sandboxes\nAfter=local-fs.target\n\n[Service]\nType=simple\nUser=root\n")
	if u.Group != "" {
		b.WriteString("Group=" + u.Group + "\n")
	}
	b.WriteString("ExecStart=" + u.HelperPath + " -config " + u.ConfigPath + "\nRestart=on-failure\n")
	fmt.Fprintf(&b, "RuntimeDirectory=%s\nRuntimeDirectoryMode=%s\nStateDirectory=%s\nStateDirectoryMode=%s\n", p.RuntimeDirectory, p.RuntimeDirectoryMode, p.StateDirectory, p.StateDirectoryMode)
	fmt.Fprintf(&b, "ReadWritePaths=%s\n", strings.Join(append(append([]string{}, p.ReadWritePaths...), u.JailRoot, u.SnapshotDir), " "))
	b.WriteString("CapabilityBoundingSet=" + p.CapabilityBoundingSet() + "\n")
	keys := make([]string, 0, len(p.Directives))
	for k := range p.Directives {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range p.Directives[k] {
			b.WriteString(k + "=" + v + "\n")
		}
	}
	b.WriteString("\n[Install]\nWantedBy=multi-user.target\n")
	return b.String(), nil
}
