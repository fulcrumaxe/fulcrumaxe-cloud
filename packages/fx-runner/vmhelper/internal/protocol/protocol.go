// Package protocol is the typed request schema of fx-vmhelper's socket API.
//
// One request is one frame: a single JSON object followed by a newline, at most MaxFrame bytes
// including the newline. The decoder is strict. It accepts only the four verbs and only the fields
// each verb names; it rejects an unknown or repeated key, a "__proto__" key, any value that is not a
// plain string or a plain non-negative integer, and trailing bytes. Every refusal is a Code from a
// fixed list. A Code never holds input bytes.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"unicode/utf8"
)

// Version is the protocol number. Doctor compares it with the runner's; any schema change bumps it.
const Version = 1

// MaxFrame is the largest accepted frame, newline included.
const MaxFrame = 4096

type Verb string

const (
	Prepare Verb = "prepare"
	Start   Verb = "start"
	Destroy Verb = "destroy"
	List    Verb = "list"
)

// Code is the result of a request. The values below are the whole closed list.
type Code string

const (
	OK              Code = "ok"
	BadPeer         Code = "bad_peer"         // the kernel peer uid is not the configured runner uid
	TooBusy         Code = "too_busy"         // all connection slots are in use
	FrameTimeout    Code = "frame_timeout"    // the frame did not complete in time
	FrameTooLarge   Code = "frame_too_large"  // more than MaxFrame bytes without a newline
	BadFrame        Code = "bad_frame"        // not one strict JSON object (syntax, duplicate or __proto__ key, trailing bytes)
	UnknownVerb     Code = "unknown_verb"     // missing, non-string or not one of the four verbs
	BadField        Code = "bad_field"        // an unknown, missing or wrongly typed field
	BadID           Code = "bad_id"           // a sandbox or template id outside the id pattern
	BadNumber       Code = "bad_number"       // not a plain integer in range
	OverCap         Code = "over_cap"         // vcpus or mem_mb above the root-config cap, or the sandbox cap
	UnknownSandbox  Code = "unknown_sandbox"  // start or destroy for an id that is not prepared
	UnknownTemplate Code = "unknown_template" // a template id that is not in the signed metadata
	Unavailable     Code = "unavailable"      // the verb is valid but this build cannot serve it yet
	Internal        Code = "internal"         // a failure inside the helper; nothing of it is sent
)

// Codes is the closed list.
var Codes = []Code{OK, BadPeer, TooBusy, FrameTimeout, FrameTooLarge, BadFrame, UnknownVerb, BadField, BadID, BadNumber, OverCap, UnknownSandbox, UnknownTemplate, Unavailable, Internal}

// idPattern starts with a letter or digit: an id that began with "-" could be read as an option by any
// program it is ever handed to.
var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// ValidID reports whether s matches the one id pattern, used for sandbox ids and template ids.
func ValidID(s string) bool { return idPattern.MatchString(s) }

// KnownVerb reports whether v is one of the four verbs.
func KnownVerb(v Verb) bool { _, ok := schema[v]; return ok }

// Request is a validated request. Only the fields its verb names are set.
type Request struct {
	Verb      Verb
	SandboxID string
	Template  string
	VCPUs     int64
	MemMB     int64
}

// Caps are the per-sandbox ceilings from the root-owned config.
type Caps struct {
	MaxVCPUs int64
	MaxMemMB int64
}

type kind int

const (
	kString kind = iota
	kInt
)

var schema = map[Verb]map[string]kind{
	Prepare: {"sandbox_id": kString, "template": kString, "vcpus": kInt, "mem_mb": kInt},
	Start:   {"sandbox_id": kString},
	Destroy: {"sandbox_id": kString},
	List:    {},
}

// Error is a refusal. It carries a Code and, once they are validated, the verb and the sandbox id for the
// log: Verb is set only when the frame named one of the four verbs, SandboxID only when it matched the pattern.
type Error struct {
	Code      Code
	Verb      Verb
	SandboxID string
}

func (e *Error) Error() string { return string(e.Code) }

func refuse(c Code, v Verb, id string) *Error { return &Error{Code: c, Verb: v, SandboxID: id} }

// Parse validates one frame (without its newline) against the schema and the caps.
func Parse(frame []byte, caps Caps) (Request, *Error) {
	if len(frame)+1 > MaxFrame {
		return Request{}, refuse(FrameTooLarge, "", "")
	}
	if !utf8.Valid(frame) {
		return Request{}, refuse(BadFrame, "", "")
	}
	fields, err := DecodeFlat(frame)
	if err != nil {
		return Request{}, refuse(BadFrame, "", "")
	}
	verb, isStr := fields["verb"].(string)
	want, known := schema[Verb(verb)]
	if !isStr || !known {
		return Request{}, refuse(UnknownVerb, "", "")
	}
	req := Request{Verb: Verb(verb)}
	// The id is read first so that every later refusal can still be logged against it.
	idOK := true
	if raw, has := fields["sandbox_id"]; has {
		if s, ok := raw.(string); ok {
			if ValidID(s) {
				req.SandboxID = s
			} else {
				idOK = false
			}
		}
	}
	for name, v := range fields {
		if name == "verb" {
			continue
		}
		k, allowed := want[name]
		_, isS := v.(string)
		if !allowed || (k == kString) != isS {
			return Request{}, refuse(BadField, req.Verb, req.SandboxID)
		}
	}
	for name := range want {
		if _, has := fields[name]; !has {
			return Request{}, refuse(BadField, req.Verb, req.SandboxID)
		}
	}
	if !idOK {
		return Request{}, refuse(BadID, req.Verb, "")
	}
	if req.Verb != Prepare {
		return req, nil
	}
	req.Template = fields["template"].(string)
	if !ValidID(req.Template) {
		return Request{}, refuse(BadID, req.Verb, req.SandboxID)
	}
	var ok bool
	if req.VCPUs, ok = number(fields["vcpus"]); !ok {
		return Request{}, refuse(BadNumber, req.Verb, req.SandboxID)
	}
	if req.MemMB, ok = number(fields["mem_mb"]); !ok {
		return Request{}, refuse(BadNumber, req.Verb, req.SandboxID)
	}
	if req.VCPUs < 1 || req.MemMB < 1 {
		return Request{}, refuse(BadNumber, req.Verb, req.SandboxID)
	}
	if req.VCPUs > caps.MaxVCPUs || req.MemMB > caps.MaxMemMB {
		return Request{}, refuse(OverCap, req.Verb, req.SandboxID)
	}
	return req, nil
}

// PlainInt reads a json.Number written as plain digits: no sign, fraction, exponent or leading zero.
func PlainInt(v any) (int64, bool) { return number(v) }

// number accepts a json.Number written as plain digits: no sign, fraction, exponent or leading zero.
func number(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	s := n.String()
	if len(s) == 0 || len(s) > 9 || (len(s) > 1 && s[0] == '0') {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	i, err := strconv.ParseInt(s, 10, 64)
	return i, err == nil
}

// DecodeFlat reads exactly one top-level object whose values are strings or numbers (json.Number). It
// walks the token stream, because encoding/json's map decoding silently keeps the last of two equal
// keys. The root config is read with it too, so both files share one strictness.
func DecodeFlat(frame []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(frame))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("not an object")
	}
	out := map[string]any{}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := kt.(string)
		if !ok || key == "__proto__" {
			return nil, errors.New("bad key")
		}
		if _, dup := out[key]; dup {
			return nil, errors.New("duplicate key")
		}
		vt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		switch v := vt.(type) {
		case string, json.Number:
			out[key] = v
		default: // null, bool, array, object
			return nil, errors.New("bad value")
		}
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return nil, errors.New("unterminated")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing bytes")
	}
	return out, nil
}
