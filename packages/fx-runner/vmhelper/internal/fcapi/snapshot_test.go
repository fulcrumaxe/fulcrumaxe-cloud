package fcapi

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// snapFC records each request and answers 204, or 400 for the path in fail. Not faked: that the real
// Firecracker accepts these bodies and the files; the real-root workflow takes a snapshot and loads it.
type snapFC struct {
	mu   sync.Mutex
	seen []string
	fail string
}

func (f *snapFC) serve(t *testing.T) net.Conn {
	t.Helper()
	dir, _ := filepath.Abs(t.TempDir())
	ln, err := net.Listen("unix", filepath.Join(dir, "fc.sock"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
		f.mu.Lock()
		f.seen = append(f.seen, r.Method+" "+r.URL.Path+" "+string(compact(b)))
		fail := f.fail == r.URL.Path
		f.mu.Unlock()
		if fail {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"fault_message":"no"}`))
			return
		}
		w.WriteHeader(204)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	c, err := net.Dial("unix", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func compact(b []byte) []byte {
	var v any
	if json.Unmarshal(b, &v) != nil {
		return b
	}
	out, _ := json.Marshal(v) // map keys sorted
	return out
}

func TestSnapshotPausesThenWritesAFullSnapshotAtTheFixedPaths(t *testing.T) {
	f := &snapFC{}
	if err := Snapshot(f.serve(t)); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`PATCH /vm {"state":"Paused"}`,
		`PUT /snapshot/create {"mem_file_path":"/snap.mem","snapshot_path":"/snap.state","snapshot_type":"Full"}`,
	}
	if len(f.seen) != 2 || f.seen[0] != want[0] || f.seen[1] != want[1] {
		t.Fatalf("sent %v", f.seen)
	}
}

func TestSnapshotStopsWhenThePauseIsRefused(t *testing.T) {
	f := &snapFC{fail: "/vm"}
	if err := Snapshot(f.serve(t)); err == nil {
		t.Fatal("accepted")
	}
	if len(f.seen) != 1 {
		t.Fatalf("went on after the refusal: %v", f.seen)
	}
}

func TestLoadSendsTheFixedPathsAndResumes(t *testing.T) {
	f := &snapFC{}
	if err := Load(f.serve(t)); err != nil {
		t.Fatal(err)
	}
	want := `PUT /snapshot/load {"mem_backend":{"backend_path":"/snap.mem","backend_type":"File"},"resume_vm":true,"snapshot_path":"/snap.state"}`
	if len(f.seen) != 1 || f.seen[0] != want {
		t.Fatalf("sent %v", f.seen)
	}
	f = &snapFC{fail: "/snapshot/load"}
	if err := Load(f.serve(t)); err == nil {
		t.Fatal("a refused load was accepted")
	}
}

// The snapshot requests get their own, longer, bound: writing the guest's memory takes longer than a configuration call.
func TestSnapshotRequestsHaveALongerBound(t *testing.T) {
	if SnapshotTimeout <= RequestTimeout || SnapshotTimeout > 5*time.Minute {
		t.Fatalf("%v vs %v", SnapshotTimeout, RequestTimeout)
	}
}
