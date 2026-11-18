//go:build linux && amd64

package sandbox

// statxNum is the statx system call number (the standard library does not export it).
const statxNum = 332
