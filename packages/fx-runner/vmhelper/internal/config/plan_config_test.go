package config

import (
	"os"
	"path/filepath"
	"testing"
)

// testdata/install-plan.json (an ordinary host) and install-plan-big-host.json (128 CPUs, 2 TiB) are what the install plan in packages/fx-runner/src/vm/installPlan.ts writes for the fixed host facts of
// its test. The helper's own parser must accept it, so a plan that drifts from the config's rules fails here.
func TestInstallPlanConfigParses(t *testing.T) {
	for _, name := range []string{"install-plan.json", "install-plan-big-host.json"} {
		parsePlan(t, name)
	}
}

func parsePlan(t *testing.T, name string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	c, err := Parse(data)
	if err != nil {
		t.Fatalf("the install plan's config %s is refused by the helper: %v", name, err)
	}
	if c.MaxSandboxes < 1 || c.UIDCount < uint32(c.MaxSandboxes) || c.GIDCount < uint32(c.MaxSandboxes) {
		t.Errorf("ranges do not cover max_sandboxes: %+v", c)
	}
}
