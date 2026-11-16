// Package vmlog writes the helper's journal lines. The journal (stderr under systemd) is the only log.
//
// A line is one `key=value` record. Nothing from a request is ever a value: the verb is logged only when
// it is one of the four, the sandbox id only when it matched the id pattern (else "-"), and the result is
// from the closed code list. Every value that is not one of those goes through Clean as well, so a
// newline, an ANSI escape or a NUL cannot reach a line whatever a caller passes.
package vmlog

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"fx-vmhelper/internal/protocol"
)

// RefusalsPerSecond is how many refusal lines one (uid, code) pair may write in one second; the rest are
// counted and summed up. A refusal of code "internal" is never counted against it or suppressed: a flood
// of cheap refusals must not be able to hide the one line that means the helper itself failed.
const RefusalsPerSecond = 20

// NoUID stands for a peer whose uid could not be read. It is the all-ones value, which is never a real
// uid, and it is logged as "-" so that it cannot be mistaken for root.
const NoUID = ^uint32(0)

// maxKeys bounds the pairs tracked in one second. A pair seen after that is counted under its code alone
// (uid "-"), so many distinct uids cannot grow the table, and each code still has its own budget.
const maxKeys = 64

type key struct {
	uid  uint32
	code protocol.Code
}

type bucket struct{ lines, suppressed int }

// Clean returns s with every byte outside [A-Za-z0-9._:/@-] replaced by '?', cut to 64 bytes; "" becomes "-".
func Clean(s string) string {
	if s == "" {
		return "-"
	}
	if len(s) > 64 {
		s = s[:64]
	}
	b := []byte(s)
	for i, c := range b {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '_', c == ':', c == '/', c == '@', c == '-':
		default:
			b[i] = '?'
		}
	}
	return string(b)
}

// Logger is safe for concurrent use.
type Logger struct {
	mu         sync.Mutex
	w          io.Writer
	now        func() time.Time
	req        uint64
	window     int64 // unix second of the current refusal window
	buckets    map[key]*bucket
	suppressed int
}

// New returns a Logger that writes to w. now may be nil (time.Now).
func New(w io.Writer, now func() time.Time) *Logger {
	if now == nil {
		now = time.Now
	}
	return &Logger{w: w, now: now, buckets: map[key]*bucket{}}
}

// NextReq returns the next request number, from 1.
func (l *Logger) NextReq() uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.req++
	return l.req
}

func uidText(uid uint32) string {
	if uid == NoUID {
		return "-"
	}
	return fmt.Sprint(uid)
}

// Request logs one served or refused request. verb and id are checked here, not trusted. uid is the
// kernel's peer uid, or NoUID when it could not be read.
func (l *Logger) Request(req uint64, verb string, uid uint32, id string, code protocol.Code, dur time.Duration) {
	if !protocol.KnownVerb(protocol.Verb(verb)) {
		verb = "-"
	}
	if !protocol.ValidID(id) {
		id = "-"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	if code != protocol.OK && code != protocol.Internal && !l.admit(t, key{uid, code}) {
		return
	}
	l.emit(t, fmt.Sprintf("req=%d verb=%s uid=%s id=%s result=%s dur_ms=%d", req, verb, uidText(uid), id, protocol.Code(Clean(string(code))), dur.Milliseconds()))
}

// Event logs one line about an object the helper created or removed, or a start-up fact. Fields are cleaned.
func (l *Logger) Event(name string, kv ...string) {
	var b strings.Builder
	b.WriteString("event=" + Clean(name))
	for i := 0; i+1 < len(kv); i += 2 {
		b.WriteString(" " + Clean(kv[i]) + "=" + Clean(kv[i+1]))
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.emit(l.now(), b.String())
}

// Flush writes the pending "N more refusals suppressed" line when its second has passed (or force is set).
func (l *Logger) Flush(force bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	if l.suppressed > 0 && (force || t.Unix() != l.window) {
		l.flushLocked(t)
	}
}

func (l *Logger) admit(t time.Time, k key) bool {
	if sec := t.Unix(); sec != l.window {
		l.flushLocked(t)
		l.window = sec
	}
	b := l.buckets[k]
	if b == nil {
		if len(l.buckets) >= maxKeys {
			k.uid = NoUID
			b = l.buckets[k]
		}
		if b == nil {
			b = &bucket{}
			l.buckets[k] = b
		}
	}
	if b.lines >= RefusalsPerSecond {
		b.suppressed++
		l.suppressed++
		return false
	}
	b.lines++
	return true
}

// flushLocked writes the summary of the window that is ending, with the per-(uid, code) breakdown, and
// starts a new window.
func (l *Logger) flushLocked(t time.Time) {
	if l.suppressed > 0 {
		var parts []string
		for k, b := range l.buckets {
			if b.suppressed > 0 {
				parts = append(parts, fmt.Sprintf("%s:%s=%d", uidText(k.uid), Clean(string(k.code)), b.suppressed))
			}
		}
		sort.Strings(parts)
		l.emit(t, fmt.Sprintf("event=refusals_suppressed count=%d msg=\"%d more refusals suppressed\" by=\"%s\"", l.suppressed, l.suppressed, strings.Join(parts, " ")))
		l.suppressed = 0
	}
	l.buckets = map[key]*bucket{}
}

func (l *Logger) emit(t time.Time, rest string) {
	// One Write per line, and the line is built only from the cleaned parts above.
	_, _ = fmt.Fprintf(l.w, "ts=%s %s\n", t.UTC().Format("2006-01-02T15:04:05.000Z"), rest)
}
