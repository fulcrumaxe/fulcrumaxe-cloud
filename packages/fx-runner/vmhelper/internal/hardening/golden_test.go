package hardening

//go:generate go test -run TestUnitGolden -update .

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// -update rewrites testdata/<case>.unit from RenderUnit. The TypeScript renderer in packages/fx-runner/src/vm/unitRender.ts is
// tested against these same files (and the Nix module against them too), so a change here that is not made there fails a build.
var update = flag.Bool("update", false, "rewrite the golden unit files from RenderUnit")

type goldenCase struct {
	Name   string `json:"name"`
	Params struct {
		HelperPath  string `json:"helperPath"`
		ConfigPath  string `json:"configPath"`
		JailRoot    string `json:"jailRoot"`
		SnapshotDir string `json:"snapshotDir"`
		Group       string `json:"group"`
	} `json:"params"`
}

func TestUnitGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "unit-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []goldenCase
	if err := json.Unmarshal(raw, &cases); err != nil || len(cases) == 0 {
		t.Fatalf("unit-cases.json: %v", err)
	}
	for _, c := range cases {
		got, err := Load().RenderUnit(UnitParams{HelperPath: c.Params.HelperPath, ConfigPath: c.Params.ConfigPath, JailRoot: c.Params.JailRoot, SnapshotDir: c.Params.SnapshotDir, Group: c.Params.Group})
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		file := filepath.Join("testdata", c.Name+".unit")
		if *update {
			if err := os.WriteFile(file, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("%s: no golden file (run go generate ./internal/hardening): %v", c.Name, err)
		}
		if string(want) != got {
			t.Errorf("%s: RenderUnit differs from %s (run go generate ./internal/hardening and review the diff)", c.Name, file)
		}
	}
}
