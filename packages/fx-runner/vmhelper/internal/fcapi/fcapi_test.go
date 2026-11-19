package fcapi

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeFC is a Firecracker API server on a Unix socket. It keeps to what the real one enforces for these
// requests: PUT only, JSON bodies with exactly the known number of fields, a 204 with no
// body on success, a JSON {"fault_message"} on failure, and InstanceStart refused until the machine, the
// boot source and the root drive are set. Not faked: the real server's validation of the values themselves
// (a missing kernel file, a vcpu count over its limit); the real-root workflow covers those.
type fakeFC struct {
	mu   sync.Mutex
	seen []string // "PUT /path" in order
	body map[string]string
	fail string // path that answers 400
}

func (f *fakeFC) serve(t *testing.T) net.Conn {
	t.Helper()
	dir, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", filepath.Join(dir, "fc.sock"))
	if err != nil {
		t.Fatal(err)
	}
	f.body = map[string]string{}
	srv := &http.Server{Handler: http.HandlerFunc(f.handle)}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	c, err := net.Dial("unix", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// the fields each request carries, and no others
var shapes = map[string]int{"/machine-config": 2, "/boot-source": 2, "/drives/rootfs": 4, "/vsock": 2, "/actions": 1}

func (f *fakeFC) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	deny := func(msg string) {
		w.WriteHeader(400)
		_ = json.NewEncoder(w).Encode(map[string]string{"fault_message": msg})
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	shape, known := shapes[r.URL.Path]
	if r.Method != "PUT" || !known || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Length") == "" {
		deny("bad request")
		return
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil || len(got) != shape {
		deny("unknown or missing field")
		return
	}
	if r.URL.Path == f.fail {
		deny("injected failure")
		return
	}
	if r.URL.Path == "/actions" {
		have := strings.Join(f.seen, " ")
		for _, need := range []string{"/machine-config", "/boot-source", "/drives/rootfs"} {
			if !strings.Contains(have, need) {
				deny("not configured: " + need)
				return
			}
		}
	}
	f.seen = append(f.seen, r.URL.Path)
	f.body[r.URL.Path] = string(b)
	w.WriteHeader(204)
}

func TestConfigureSendsExactlyTheFixedConfiguration(t *testing.T) {
	var f fakeFC
	if err := Configure(f.serve(t), VM{VCPUs: 2, MemMB: 512}); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"/machine-config": `{"mem_size_mib":512,"vcpu_count":2}`,
		"/boot-source":    `{"boot_args":"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro rootfstype=ext4 init=/usr/lib/fx/init init_on_free=1 random.trust_cpu=on","kernel_image_path":"/kernel"}`,
		"/drives/rootfs":  `{"drive_id":"rootfs","is_read_only":true,"is_root_device":true,"path_on_host":"/rootfs"}`,
		"/vsock":          `{"guest_cid":3,"uds_path":"/vsock/v.sock"}`,
		"/actions":        `{"action_type":"InstanceStart"}`,
	}
	for p, b := range want {
		if f.body[p] != b {
			t.Errorf("%s: %s, want %s", p, f.body[p], b)
		}
	}
	if got := strings.Join(f.seen, " "); got != "/machine-config /boot-source /drives/rootfs /vsock /actions" {
		t.Errorf("order: %s", got)
	}
}

func TestConfigureStopsAtTheFirstRefusal(t *testing.T) {
	for _, p := range []string{"/machine-config", "/boot-source", "/drives/rootfs", "/vsock", "/actions"} {
		f := fakeFC{fail: p}
		err := Configure(f.serve(t), VM{VCPUs: 1, MemMB: 128})
		if err == nil || !strings.Contains(err.Error(), "injected failure") || !strings.Contains(err.Error(), p) {
			t.Errorf("%s: %v", p, err)
		}
		if p != "/actions" && strings.Contains(strings.Join(f.seen, " "), "/actions") {
			t.Errorf("%s: the VM was started after a refusal", p)
		}
	}
}

func TestConfigureRefusesNonPositiveSizesWithoutSending(t *testing.T) {
	for _, vm := range []VM{{0, 128}, {1, 0}, {-1, 128}} {
		var f fakeFC
		if err := Configure(f.serve(t), vm); err == nil || len(f.seen) != 0 {
			t.Errorf("%+v: %v %v", vm, err, f.seen)
		}
	}
}

// raw answers every connection with fixed bytes after reading one request head.
func raw(t *testing.T, reply string, hold time.Duration) net.Conn {
	t.Helper()
	dir, _ := filepath.Abs(t.TempDir())
	ln, err := net.Listen("unix", filepath.Join(dir, "raw.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 4096)
		_, _ = c.Read(buf)
		time.Sleep(hold)
		_, _ = c.Write([]byte(reply))
	}()
	c, err := net.Dial("unix", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestMalformedResponsesAreRefused(t *testing.T) {
	big := strings.Repeat("x", 70<<10)
	cases := map[string]string{
		"not http":                 "garbage\r\n\r\n",
		"http 1.0":                 "HTTP/1.0 204 No Content\r\n\r\n",
		"two digit code":           "HTTP/1.1 20 OK\r\n\r\n",
		"no space after the code":  "HTTP/1.1 204x\r\n\r\n",
		"informational":            "HTTP/1.1 100 Continue\r\n\r\n",
		"200 instead of 204":       "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
		"bare newlines":            "HTTP/1.1 204 No Content\n\n",
		"header without a colon":   "HTTP/1.1 204 No Content\r\nbad\r\n\r\n",
		"space in a header name":   "HTTP/1.1 204 No Content\r\nA B: c\r\n\r\n",
		"chunked":                  "HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
		"two content-lengths":      "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
		"signed content-length":    "HTTP/1.1 204 No Content\r\nContent-Length: +0\r\n\r\n",
		"negative content-length":  "HTTP/1.1 204 No Content\r\nContent-Length: -1\r\n\r\n",
		"huge content-length":      "HTTP/1.1 400 Bad\r\nContent-Length: 99999999\r\n\r\n",
		"an error with no length":  "HTTP/1.1 400 Bad\r\n\r\n{}",
		"a body on a 204":          "HTTP/1.1 204 No Content\r\nContent-Length: 2\r\n\r\n{}",
		"body shorter than length": "HTTP/1.1 400 Bad\r\nContent-Length: 50\r\n\r\n{}",
		"head over the limit":      "HTTP/1.1 204 No Content\r\nX: " + big + "\r\n\r\n",
		"nul in a header":          "HTTP/1.1 204 No Content\r\nX: a\x00b\r\n\r\n",
		"closed before any answer": "",
	}
	for name, reply := range cases {
		c := raw(t, reply, 0)
		err := New(c).Put("/vsock", map[string]int{"a": 1})
		// these end in a status or a short read, not in a response the parser itself refused
		parsed := name == "closed before any answer" || name == "200 instead of 204" || name == "body shorter than length"
		if err == nil || (!parsed && !errors.Is(err, ErrBadResponse)) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// the accepted shapes: a bare 204, and one with the headers the real server sends
	for name, reply := range map[string]string{
		"bare":    "HTTP/1.1 204 No Content\r\n\r\n",
		"headers": "HTTP/1.1 204 No Content\r\nServer: Firecracker API\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n",
	} {
		if err := New(raw(t, reply, 0)).Put("/vsock", map[string]int{"a": 1}); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// many short lines, each within the line buffer, that together pass the head limit
func TestAHeadOverTheLimitInManyLinesIsRefused(t *testing.T) {
	head := "HTTP/1.1 204 No Content\r\n" + strings.Repeat("X-Pad: "+strings.Repeat("a", 90)+"\r\n", 120) + "\r\n"
	if len(head) < MaxHead*13/10 {
		t.Fatal("the test head is not over the limit")
	}
	if err := New(raw(t, head, 0)).Put("/vsock", map[string]int{"a": 1}); err == nil || !strings.Contains(err.Error(), "head over") {
		t.Fatalf("%v", err)
	}
}

func TestAnErrorBodyIsShownOnOneSafeLine(t *testing.T) {
	body := `{"fault_message":"bad\nline \u001b[31m` + strings.Repeat("y", 500) + `"}`
	reply := "HTTP/1.1 400 Bad Request\r\nContent-Length: " + itoa(len(body)) + "\r\n\r\n" + body
	err := New(raw(t, reply, 0)).Put("/vsock", map[string]int{"a": 1})
	if err == nil || strings.ContainsAny(err.Error(), "\n\x1b") || len(err.Error()) > 300 || !strings.Contains(err.Error(), "bad?line") {
		t.Fatalf("%q", err)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestARequestIsBoundedInTime(t *testing.T) {
	old := RequestTimeout
	RequestTimeout = 150 * time.Millisecond
	defer func() { RequestTimeout = old }()
	start := time.Now()
	err := New(raw(t, "HTTP/1.1 204 No Content\r\n\r\n", 2*time.Second)).Put("/vsock", map[string]int{"a": 1})
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("%v after %v", err, time.Since(start))
	}
}

func TestAConnectionTheServerClosesIsNotReused(t *testing.T) {
	c := New(raw(t, "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n", 0))
	if err := c.Put("/vsock", map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if err := c.Put("/vsock", map[string]int{"a": 1}); err == nil || !strings.Contains(err.Error(), "server closed the connection") {
		t.Fatal("a second request went out on a connection the server closed")
	}
}
