//go:build linux

package sandbox

import (
	"strings"
	"testing"
)

// A resume launches the jailer as a start does, but the VM is loaded from the snapshot: the one request is the
// load (the snapshot carries the machine, drives and vsock device), then the socket handover.
func TestResumeLaunchLoadsTheSnapshotAndConfiguresNothing(t *testing.T) {
	r := newRig(t)
	r.spec.Resume = true
	in, err := r.l.Launch(r.spec)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.fc.paths(); got != "/snapshot/load" {
		t.Fatalf("requests: %s", got)
	}
	if !strings.Contains(r.fc.got[0], `"resume_vm":true`) || len(r.fc.handed) != 1 {
		t.Fatalf("%q handed %d", r.fc.got, len(r.fc.handed))
	}
	if err := in.Stop(); err != nil {
		t.Fatal(err)
	}
}

// A failed load kills the sandbox like any other launch step.
func TestResumeLaunchKillsTheSandboxWhenTheLoadFails(t *testing.T) {
	r := newRig(t)
	r.spec.Resume = true
	r.fc.fail = "/snapshot/load"
	if _, err := r.l.Launch(r.spec); err == nil || !strings.Contains(err.Error(), "snapshot/load") {
		t.Fatalf("%v", err)
	}
	if len(r.fc.handed) != 0 {
		t.Error("handed the socket over after a refused load")
	}
	gone(t, r)
}

// The instance snapshots through the API socket: pause, then write, over a dial like the launch's.
func TestInstanceSnapshotPausesThenWritesThroughTheAPISocket(t *testing.T) {
	r := newRig(t)
	in, err := r.l.Launch(r.spec)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Stop()
	r.fc.got = nil
	dials := r.fc.dials
	sn, ok := in.(Snapshotter)
	if !ok {
		t.Fatal("a launched instance cannot snapshot")
	}
	if err := sn.Snapshot(); err != nil {
		t.Fatal(err)
	}
	if got := r.fc.paths(); got != "/vm /snapshot/create" || r.fc.dials != dials+1 {
		t.Fatalf("requests %q, %d dials", got, r.fc.dials-dials)
	}
	if !strings.Contains(r.fc.got[0], `"state":"Paused"`) || !strings.Contains(r.fc.got[1], `"snapshot_type":"Full"`) {
		t.Fatalf("%q", r.fc.got)
	}
	r.fc.fail = "/snapshot/create"
	if err := sn.Snapshot(); err == nil {
		t.Error("a refused snapshot was accepted")
	}
}
