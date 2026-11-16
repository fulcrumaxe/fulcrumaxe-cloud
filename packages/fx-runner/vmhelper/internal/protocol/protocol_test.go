package protocol

import (
	"strings"
	"testing"
)

var caps = Caps{MaxVCPUs: 4, MaxMemMB: 4096}

func TestAcceptsTheFourVerbs(t *testing.T) {
	cases := map[string]Request{
		`{"verb":"prepare","sandbox_id":"job-1","template":"fx-agent","vcpus":2,"mem_mb":2048}`: {Verb: Prepare, SandboxID: "job-1", Template: "fx-agent", VCPUs: 2, MemMB: 2048},
		`{"verb":"start","sandbox_id":"job-1"}`:                                                 {Verb: Start, SandboxID: "job-1"},
		`{"verb":"destroy","sandbox_id":"job-1"}`:                                               {Verb: Destroy, SandboxID: "job-1"},
		`{"verb":"list"}`:                     {Verb: List},
		` {"sandbox_id":"a","verb":"start"} `: {Verb: Start, SandboxID: "a"},
	}
	for in, want := range cases {
		got, err := Parse([]byte(in), caps)
		if err != nil || got != want {
			t.Errorf("%s: got %+v, %v", in, got, err)
		}
	}
}

// Each refusal has one fixed code, and the code is the same whatever the input held.
func TestRefusals(t *testing.T) {
	long := strings.Repeat("a", 41)
	cases := []struct {
		name string
		in   string
		want Code
	}{
		{"unknown verb", `{"verb":"exec"}`, UnknownVerb},
		{"missing verb", `{"sandbox_id":"a"}`, UnknownVerb},
		{"verb not a string", `{"verb":1}`, UnknownVerb},
		{"verb with different case", `{"verb":"List"}`, UnknownVerb},
		{"unknown field", `{"verb":"start","sandbox_id":"a","extra":"x"}`, BadField},
		{"argv field", `{"verb":"start","sandbox_id":"a","argv":"--x"}`, BadField},
		{"field from another verb", `{"verb":"list","sandbox_id":"a"}`, BadField},
		{"missing field", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":1}`, BadField},
		{"string where integer", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":"1","mem_mb":1}`, BadField},
		{"integer where string", `{"verb":"start","sandbox_id":5}`, BadField},
		{"path as id", `{"verb":"start","sandbox_id":"/etc/passwd"}`, BadID},
		{"dotdot as id", `{"verb":"destroy","sandbox_id":"../x"}`, BadID},
		{"upper case id", `{"verb":"start","sandbox_id":"Ab"}`, BadID},
		{"empty id", `{"verb":"start","sandbox_id":""}`, BadID},
		{"41 char id", `{"verb":"start","sandbox_id":"` + long + `"}`, BadID},
		{"newline in id", `{"verb":"start","sandbox_id":"a\nb"}`, BadID},
		{"nul in id", `{"verb":"start","sandbox_id":"a\u0000b"}`, BadID},
		{"leading dash template", `{"verb":"prepare","sandbox_id":"a","template":"-x\u0000","vcpus":1,"mem_mb":1}`, BadID},
		{"leading dash id", `{"verb":"start","sandbox_id":"--help"}`, BadID},
		{"single dash id", `{"verb":"destroy","sandbox_id":"-"}`, BadID},
		{"leading dash id on prepare", `{"verb":"prepare","sandbox_id":"-a","template":"t","vcpus":1,"mem_mb":1}`, BadID},
		{"clean leading dash template", `{"verb":"prepare","sandbox_id":"a","template":"-x","vcpus":1,"mem_mb":1}`, BadID},
		{"path as template", `{"verb":"prepare","sandbox_id":"a","template":"/bin/sh","vcpus":1,"mem_mb":1}`, BadID},
		{"duplicate key", `{"verb":"list","verb":"list"}`, BadFrame},
		{"duplicate key, different values", `{"verb":"start","sandbox_id":"a","sandbox_id":"b"}`, BadFrame},
		{"__proto__ key", `{"verb":"list","__proto__":"x"}`, BadFrame},
		{"__proto__ object", `{"verb":"list","__proto__":{"a":1}}`, BadFrame},
		{"not json", `verb=list`, BadFrame},
		{"array", `["list"]`, BadFrame},
		{"trailing bytes", `{"verb":"list"}x`, BadFrame},
		{"two objects", `{"verb":"list"}{"verb":"list"}`, BadFrame},
		{"truncated", `{"verb":"list"`, BadFrame},
		{"null value", `{"verb":"start","sandbox_id":null}`, BadFrame},
		{"nested object", `{"verb":"start","sandbox_id":{"a":"b"}}`, BadFrame},
		{"invalid utf-8", "{\"verb\":\"start\",\"sandbox_id\":\"\xff\"}", BadFrame},
		{"float", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":1.5,"mem_mb":1}`, BadNumber},
		{"float that is whole", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":2.0,"mem_mb":1}`, BadNumber},
		{"exponent", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":1,"mem_mb":1e3}`, BadNumber},
		{"negative", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":-1,"mem_mb":1}`, BadNumber},
		{"zero", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":0,"mem_mb":1}`, BadNumber},
		{"leading zero", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":01,"mem_mb":1}`, BadFrame},
		{"huge", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":1,"mem_mb":99999999999999999999}`, BadNumber},
		{"vcpus over cap", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":5,"mem_mb":1}`, OverCap},
		{"mem over cap", `{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":1,"mem_mb":4097}`, OverCap},
	}
	for _, c := range cases {
		_, err := Parse([]byte(c.in), caps)
		if err == nil || err.Code != c.want {
			t.Errorf("%s: got %v, want %s", c.name, err, c.want)
		}
	}
}

func TestAtTheCapsIsAccepted(t *testing.T) {
	if _, err := Parse([]byte(`{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":4,"mem_mb":4096}`), caps); err != nil {
		t.Fatal(err)
	}
}

func TestFrameLimit(t *testing.T) {
	pad := func(n int) []byte { // a valid frame of exactly n bytes, newline not counted
		base := `{"verb":"list","x":""}`
		return []byte(`{"verb":"list","x":"` + strings.Repeat("a", n-len(base)) + `"}`)
	}
	if _, err := Parse(pad(MaxFrame-1), caps); err == nil || err.Code != BadField {
		t.Fatalf("a frame of exactly the limit must pass the size check and fail the schema, got %v", err)
	}
	if _, err := Parse(pad(MaxFrame), caps); err == nil || err.Code != FrameTooLarge {
		t.Fatalf("one byte over: %v", err)
	}
}

func TestRefusalsEchoNothing(t *testing.T) {
	_, err := Parse([]byte(`{"verb":"start","sandbox_id":"a","SECRET-FIELD":"x"}`), caps)
	if err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("%v", err)
	}
	if err.SandboxID != "a" {
		t.Fatal("a matching id is kept for the log")
	}
	_, err = Parse([]byte(`{"verb":"start","sandbox_id":"A\nB"}`), caps)
	if err == nil || err.SandboxID != "" {
		t.Fatalf("an id outside the pattern must not be carried: %+v", err)
	}
}

// A refusal carries the verb only once the frame has named one of the four; before that it is empty.
func TestRefusalsKeepTheValidatedVerb(t *testing.T) {
	for in, want := range map[string]Verb{
		`{"verb":"start","sandbox_id":"A"}`:                                       Start,
		`{"verb":"destroy","sandbox_id":"a","x":"y"}`:                             Destroy,
		`{"verb":"prepare","sandbox_id":"a","template":"t","vcpus":9,"mem_mb":1}`: Prepare,
		`{"verb":"list","x":"y"}`:                                                 List,
		`{"verb":"exec","sandbox_id":"a"}`:                                        "",
		`{"verb":"list"`:                                                          "",
		`{"verb":"start","verb":"start"}`:                                         "",
	} {
		_, err := Parse([]byte(in), caps)
		if err == nil || err.Verb != want {
			t.Errorf("%s: %+v, want verb %q", in, err, want)
		}
	}
}

func TestCodeListIsClosedAndLowerSnake(t *testing.T) {
	seen := map[Code]bool{}
	for _, c := range Codes {
		if seen[c] || !idLike(string(c)) {
			t.Errorf("bad or repeated code %q", c)
		}
		seen[c] = true
	}
}

func idLike(s string) bool {
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r == '_') {
			return false
		}
	}
	return s != ""
}
