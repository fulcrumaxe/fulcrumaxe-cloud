package protocol

import "testing"

func TestSnapshotVerbs(t *testing.T) {
	for in, want := range map[string]Request{
		`{"verb":"snapshot","sandbox_id":"job-1","snapshot_id":"s-1"}`: {Verb: Snapshot, SandboxID: "job-1", SnapshotID: "s-1"},
		`{"verb":"resume","snapshot_id":"s-1","sandbox_id":"job-1"}`:   {Verb: Resume, SandboxID: "job-1", SnapshotID: "s-1"},
		`{"verb":"snapshot_delete","snapshot_id":"s-1"}`:               {Verb: SnapshotDelete, SnapshotID: "s-1"},
	} {
		if got, err := Parse([]byte(in), caps); err != nil || got != want {
			t.Errorf("%s: %+v, %v", in, got, err)
		}
	}
	for in, want := range map[string]Code{
		`{"verb":"snapshot","sandbox_id":"a"}`:                                     BadField, // no snapshot id
		`{"verb":"snapshot_delete","snapshot_id":"a","sandbox_id":"b"}`:            BadField,
		`{"verb":"start","sandbox_id":"a","snapshot_id":"s"}`:                      BadField,
		`{"verb":"resume","sandbox_id":"a","snapshot_id":"../x"}`:                  BadID,
		`{"verb":"resume","sandbox_id":"a","snapshot_id":"-s"}`:                    BadID,
		`{"verb":"snapshot_delete","snapshot_id":"/etc/passwd"}`:                   BadID,
		`{"verb":"snapshot","sandbox_id":"a","snapshot_id":"s","path":"/tmp/x"}`:   BadField,
		`{"verb":"snapshot","sandbox_id":"a","snapshot_id":"s","snapshot_id":"t"}`: BadFrame,
		`{"verb":"snapshot","sandbox_id":"a","snapshot_id":5}`:                     BadField,
	} {
		if _, err := Parse([]byte(in), caps); err == nil || err.Code != want {
			t.Errorf("%s: %+v, want %s", in, err, want)
		}
	}
}
