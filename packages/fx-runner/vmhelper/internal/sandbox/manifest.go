//go:build linux

package sandbox

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"syscall"

	"fx-vmhelper/internal/protocol"
)

// The template manifest is the one place the helper learns which templates exist and what their files must
// hash to. The install writes it, root-owned, from the signed release metadata; the helper only reads it.
// Nothing a runner sends is a digest or a path.
//
//	{"<template id>": {"kernel": "<64 hex>", "rootfs": "<64 hex>"}, ...}
//
// It is read afresh at every prepare and start, so a replaced manifest takes effect without a restart. Every
// template has both kinds; an id outside the id pattern, a repeated key, an unknown kind or digest shape, a
// non-object, or anything after the object refuses the whole file.

const maxManifest = 64 << 10

// templateKinds are the files a template holds, in the order they are copied.
var templateKinds = []string{"kernel", "rootfs"}

var errManifest = errors.New("template manifest is malformed")

// Manifest maps template id -> kind -> lowercase hex sha256.
type Manifest map[string]map[string]string

func validDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// walkObject reads one JSON object from dec and calls f for every key; f consumes the key's value.
func walkObject(dec *json.Decoder, f func(key string) error) error {
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return errManifest
	}
	for dec.More() {
		t, err := dec.Token()
		k, ok := t.(string)
		if err != nil || !ok {
			return errManifest
		}
		if err := f(k); err != nil {
			return err
		}
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return errManifest
	}
	return nil
}

// ParseManifest validates the manifest's bytes.
func ParseManifest(data []byte) (Manifest, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	m := Manifest{}
	err := walkObject(dec, func(id string) error {
		if _, dup := m[id]; dup || !protocol.ValidID(id) {
			return errManifest
		}
		e := map[string]string{}
		if err := walkObject(dec, func(kind string) error {
			t, err := dec.Token()
			d, ok := t.(string)
			if _, dup := e[kind]; dup || err != nil || !ok || !validDigest(d) || !(kind == templateKinds[0] || kind == templateKinds[1]) {
				return errManifest
			}
			e[kind] = d
			return nil
		}); err != nil {
			return err
		}
		if len(e) != len(templateKinds) {
			return errManifest
		}
		m[id] = e
		return nil
	})
	if _, e2 := dec.Token(); err != nil || e2 != io.EOF {
		return nil, errManifest
	}
	return m, nil
}

// LoadManifest opens path by descriptor through a chain of owner-owned directories, without following a
// symlink anywhere (the same check as the pinned binaries), requires a regular file owned by owner that no
// one else can write, and parses it. base is "/" in production.
func LoadManifest(base, path string, owner uint32) (Manifest, error) {
	fd, err := openRootChain(base, path, owner)
	if err != nil {
		return nil, errors.New("template manifest cannot be opened through a root-owned chain")
	}
	f := os.NewFile(uintptr(fd), "manifest")
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != owner || st.Mode&0o022 != 0 {
		return nil, errors.New("template manifest is not a root-owned regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	if err != nil || len(data) > maxManifest {
		return nil, errors.New("template manifest is unreadable or over 64 KiB")
	}
	return ParseManifest(data)
}
