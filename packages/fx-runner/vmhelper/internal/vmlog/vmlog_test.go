package vmlog

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"

	"fx-vmhelper/internal/protocol"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newLogger() (*Logger, *bytes.Buffer, *clock) {
	var buf bytes.Buffer
	c := &clock{t: time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)}
	return New(&buf, c.now), &buf, c
}

func TestOneLineWithTheNamedFields(t *testing.T) {
	l, buf, _ := newLogger()
	l.Request(l.NextReq(), "prepare", 1000, "job-1", protocol.OK, 12*time.Millisecond)
	want := "ts=2026-11-16T12:00:00.000Z req=1 verb=prepare uid=1000 id=job-1 result=ok dur_ms=12\n"
	if buf.String() != want {
		t.Fatalf("got %q", buf.String())
	}
}

// A request whose fields hold a newline, an ANSI escape or a NUL produces one line without them.
func TestHostileFieldsCannotReachALine(t *testing.T) {
	l, buf, _ := newLogger()
	hostile := []string{"a\nforged=1", "\x1b[31mred", "x\x00y", "\r\n", "job-1\n", "../etc", strings.Repeat("a", 5000)}
	for _, h := range hostile {
		l.Request(l.NextReq(), h, 1000, h, protocol.BadField, 0)
		l.Event(h, h, h)
	}
	out := buf.String()
	if got := strings.Count(out, "\n"); got != 2*len(hostile) {
		t.Fatalf("%d lines for %d records:\n%q", got, 2*len(hostile), out)
	}
	for _, bad := range []string{"\x1b", "\x00", "\r", "forged=1"} {
		if strings.Contains(out, bad) {
			t.Fatalf("found %q in %q", bad, out)
		}
	}
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if len(line) > 300 {
			t.Fatalf("a line of %d bytes", len(line))
		}
	}
	if !strings.Contains(out, "verb=- uid=1000 id=-") {
		t.Fatalf("unmatched verb and id must read -:\n%s", out)
	}
}

func TestRefusalsAboveTwentyPerSecondAreCoalesced(t *testing.T) {
	l, buf, c := newLogger()
	for i := 0; i < 70; i++ {
		l.Request(l.NextReq(), "-", 1000, "", protocol.BadPeer, 0)
	}
	if n := strings.Count(buf.String(), "result=bad_peer"); n != 20 {
		t.Fatalf("%d refusal lines in the first second, want 20", n)
	}
	// A request that succeeds is not a refusal and is never suppressed.
	l.Request(l.NextReq(), "list", 1000, "", protocol.OK, 0)
	if !strings.Contains(buf.String(), "verb=list") {
		t.Fatal("ok line suppressed")
	}
	c.t = c.t.Add(time.Second)
	l.Flush(false)
	if !strings.Contains(buf.String(), `msg="50 more refusals suppressed"`) {
		t.Fatalf("no summary:\n%s", buf.String())
	}
	if strings.Count(buf.String(), "suppressed") != 2 { // count=50 and the msg
		t.Fatalf("summary written twice:\n%s", buf.String())
	}
	before := buf.Len()
	l.Flush(false)
	if buf.Len() != before {
		t.Fatal("summary repeated")
	}
	l.Request(l.NextReq(), "-", 1000, "", protocol.BadPeer, 0) // a new second admits again
	if !strings.HasSuffix(strings.TrimSpace(buf.String()), "dur_ms=0") || strings.Count(buf.String(), "result=bad_peer") != 21 {
		t.Fatalf("the next second must log again:\n%s", buf.String())
	}
}

func TestSummaryIsWrittenWhenTheWindowRollsOnTheNextRefusal(t *testing.T) {
	l, buf, c := newLogger()
	for i := 0; i < 25; i++ {
		l.Request(l.NextReq(), "-", 1, "", protocol.TooBusy, 0)
	}
	c.t = c.t.Add(2 * time.Second)
	l.Request(l.NextReq(), "-", 1, "", protocol.TooBusy, 0)
	if !strings.Contains(buf.String(), `msg="5 more refusals suppressed"`) {
		t.Fatalf("%s", buf.String())
	}
}

func TestForcedFlushAtShutdown(t *testing.T) {
	l, buf, _ := newLogger()
	for i := 0; i < 21; i++ {
		l.Request(l.NextReq(), "-", 1, "", protocol.TooBusy, 0)
	}
	l.Flush(false)
	if strings.Contains(buf.String(), "suppressed") {
		t.Fatal("flushed inside the same second")
	}
	l.Flush(true)
	if !strings.Contains(buf.String(), `msg="1 more refusals suppressed"`) {
		t.Fatalf("%s", buf.String())
	}
}

// A flood of cheap refusals cannot bury an internal failure: 30 bad_id refusals use up their own budget,
// and the internal line that follows is still written.
func TestInternalIsNeverSuppressed(t *testing.T) {
	l, buf, _ := newLogger()
	for i := 0; i < 30; i++ {
		l.Request(l.NextReq(), "start", 1000, "", protocol.BadID, 0)
	}
	l.Request(l.NextReq(), "start", 1000, "job-1", protocol.Internal, 0)
	if strings.Count(buf.String(), "result=bad_id") != RefusalsPerSecond {
		t.Fatalf("%s", buf.String())
	}
	if !strings.Contains(buf.String(), "id=job-1 result=internal") {
		t.Fatalf("the internal line was suppressed:\n%s", buf.String())
	}
	// Even a flood of internal failures is all written: none is ever counted as suppressed.
	for i := 0; i < 50; i++ {
		l.Request(l.NextReq(), "start", 1000, "job-1", protocol.Internal, 0)
	}
	if n := strings.Count(buf.String(), "result=internal"); n != 51 {
		t.Fatalf("%d internal lines, want 51", n)
	}
}

// The budget is per (uid, code): one noisy pair does not use up another's, and the summary says who and what.
func TestCoalescingIsPerUIDAndCodeWithABreakdown(t *testing.T) {
	l, buf, c := newLogger()
	for i := 0; i < 30; i++ {
		l.Request(l.NextReq(), "-", 1000, "", protocol.BadPeer, 0)
	}
	for i := 0; i < 25; i++ {
		l.Request(l.NextReq(), "-", 2000, "", protocol.BadPeer, 0)
	}
	for i := 0; i < 22; i++ {
		l.Request(l.NextReq(), "-", 1000, "", protocol.TooBusy, 0)
	}
	if n := strings.Count(buf.String(), "uid=2000 id=- result=bad_peer"); n != RefusalsPerSecond {
		t.Fatalf("uid 2000 got %d lines", n)
	}
	if !strings.Contains(buf.String(), "uid=1000 id=- result=too_busy") {
		t.Fatal("too_busy was starved by bad_peer")
	}
	c.t = c.t.Add(time.Second)
	l.Flush(false)
	want := `count=17 msg="17 more refusals suppressed" by="1000:bad_peer=10 1000:too_busy=2 2000:bad_peer=5"`
	if !strings.Contains(buf.String(), want) {
		t.Fatalf("want %s in:\n%s", want, buf.String())
	}
}

// Many distinct uids cannot grow the table: past the bound they share one bucket per code, shown as uid -.
func TestManyUIDsShareABucketPerCode(t *testing.T) {
	l, buf, c := newLogger()
	for uid := uint32(0); uid < 500; uid++ {
		l.Request(l.NextReq(), "-", 100000+uid, "", protocol.BadPeer, 0)
	}
	if len(l.buckets) > maxKeys+len(protocol.Codes) {
		t.Fatalf("%d buckets", len(l.buckets))
	}
	l.Request(l.NextReq(), "-", 7, "", protocol.TooBusy, 0)
	if !strings.Contains(buf.String(), "uid=7 id=- result=too_busy") {
		t.Fatal("a new code lost its own budget")
	}
	c.t = c.t.Add(time.Second)
	l.Flush(false)
	if !strings.Contains(buf.String(), `by="-:bad_peer=416"`) {
		t.Fatalf("overflow bucket missing from the summary:\n%s", buf.String())
	}
}

// A peer whose credential could not be read is logged as uid=-, never as uid=0.
func TestUnreadableUIDIsADash(t *testing.T) {
	l, buf, _ := newLogger()
	l.Request(l.NextReq(), "-", NoUID, "", protocol.BadPeer, 0)
	if !strings.Contains(buf.String(), "uid=- id=- result=bad_peer") || strings.Contains(buf.String(), "uid=0") || strings.Contains(buf.String(), "4294967295") {
		t.Fatal(buf.String())
	}
}

func TestRequestNumbersCount(t *testing.T) {
	l, _, _ := newLogger()
	for i := uint64(1); i <= 3; i++ {
		if got := l.NextReq(); got != i {
			t.Fatal(fmt.Sprint(got))
		}
	}
}
