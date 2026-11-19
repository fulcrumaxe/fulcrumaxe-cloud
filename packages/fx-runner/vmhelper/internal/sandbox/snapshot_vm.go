//go:build linux

package sandbox

import "fx-vmhelper/internal/fcapi"

// Snapshot pauses the VM and has Firecracker write its state and memory into the jail root. It reaches the
// API socket by the one dial that already exists (dialAPI, the only capability-raising path besides the
// socket handover); nothing here raises a capability. The caller stops the VM afterwards.
func (i *instance) Snapshot() error {
	dial := i.l.Dial
	if dial == nil {
		dial = i.l.dialAPI
	}
	conn, err := dial(i.spec, i.pid)
	if err != nil {
		return err
	}
	defer conn.Close()
	return fcapi.Snapshot(conn)
}
