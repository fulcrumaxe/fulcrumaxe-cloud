// What the Virtualization framework says about this host, without booting anything.
import Virtualization

print("VZVirtualMachine.isSupported = \(VZVirtualMachine.isSupported)")
if #available(macOS 15.0, *) {
    print("VZGenericPlatformConfiguration.isNestedVirtualizationSupported = \(VZGenericPlatformConfiguration.isNestedVirtualizationSupported)")
} else {
    print("isNestedVirtualizationSupported: needs macOS 15 or later")
}
