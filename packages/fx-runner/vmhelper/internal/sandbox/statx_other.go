//go:build linux && !amd64 && !arm64

package sandbox

// statxNum is 0 where the number is not known: the mount-id fallback then reports "cannot tell", and a
// descent that needs it is refused.
const statxNum = 0
