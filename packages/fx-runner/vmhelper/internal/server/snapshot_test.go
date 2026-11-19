//go:build linux

package server

import (
	"bufio"
	"strings"
	"testing"
	"time"

	"fx-vmhelper/internal/protocol"
)

// snapBackend is a fakeBackend that also serves the snapshot verbs.
type snapBackend struct {
	*fakeBackend
	calls []string
}

func (s *snapBackend) Snapshot(id, snap string) (Reply, protocol.Code) {
	s.calls = append(s.calls, "snapshot "+id+" "+snap)
	return Reply{SnapshotBytes: 4096}, protocol.OK
}
func (s *snapBackend) Resume(id, snap string) (Reply, protocol.Code) {
	s.calls = append(s.calls, "resume "+id+" "+snap)
	if snap == "gone" {
		return Reply{}, protocol.UnknownSnapshot
	}
	return Reply{VsockDir: "/jail/vsock/" + id, SandboxGID: 100007}, protocol.OK
}
func (s *snapBackend) SnapshotDelete(snap string) protocol.Code {
	s.calls = append(s.calls, "delete "+snap)
	return protocol.OK
}

func TestSnapshotVerbsEndToEnd(t *testing.T) {
	var sb *snapBackend
	r := start(t, func(s *Server) { sb = &snapBackend{fakeBackend: newFake()}; s.Backend = sb })
	c := dial(t, r.sock)
	br := bufio.NewReader(c)
	say := func(frame string) string {
		t.Helper()
		_, _ = c.Write([]byte(frame + "\n"))
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		s, err := br.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(s)
	}
	if got := say(`{"verb":"snapshot","sandbox_id":"job-1","snapshot_id":"s-1"}`); got != `{"ok":true,"protocol":1,"snapshot_bytes":4096}` {
		t.Fatal(got)
	}
	if got := say(`{"verb":"resume","sandbox_id":"job-1","snapshot_id":"s-1"}`); got != `{"ok":true,"protocol":1,"vsock_dir":"/jail/vsock/job-1","sandbox_gid":100007}` {
		t.Fatal(got)
	}
	if got := say(`{"verb":"snapshot_delete","snapshot_id":"s-1"}`); got != `{"ok":true,"protocol":1}` {
		t.Fatal(got)
	}
	if want := "snapshot job-1 s-1,resume job-1 s-1,delete s-1"; strings.Join(sb.calls, ",") != want {
		t.Fatalf("backend saw %v", sb.calls)
	}
	if got := say(`{"verb":"resume","sandbox_id":"job-1","snapshot_id":"gone"}`); got != code(protocol.UnknownSnapshot) {
		t.Fatal(got)
	}
}

// A backend that does not serve snapshots answers "unavailable" and is never called.
func TestSnapshotVerbsWithoutASnapshotBackend(t *testing.T) {
	r := start(t, nil)
	for _, f := range []string{`{"verb":"snapshot","sandbox_id":"a","snapshot_id":"s"}`, `{"verb":"resume","sandbox_id":"a","snapshot_id":"s"}`, `{"verb":"snapshot_delete","snapshot_id":"s"}`} {
		if got := ask(t, r.sock, f); got != code(protocol.Unavailable) {
			t.Errorf("%s: %s", f, got)
		}
	}
	if r.be.count() != 0 {
		t.Error("the backend was called")
	}
}
