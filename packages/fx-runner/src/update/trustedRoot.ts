/**
 * The runner's first trusted TUF root, compiled into the build (D#6 R6-W).
 *
 * The text below is byte for byte `tuf/1.root.json` in this package (no trailing newline), which the release workflows also use as
 * their trusted root. It is held as a string, not read from disk, so the built runner needs no file next to it. The pinned SHA-256 is
 * checked when this module loads: a text that differs from the pin makes the import throw, so a build that carries an edited root
 * cannot start. A test compares this text with the file and with the pin, so changing either alone fails CI.
 *
 * Replacing the root means a new runner build: nothing at run time can supply or replace it.
 */
import { createHash } from "node:crypto";

/** SHA-256 of the root text, as hex. Changing the root means changing this on purpose, in the same commit. */
export const TRUSTED_ROOT_SHA256 = "1ea2b80d66d8bed8c879b3e914d023890d105a4923ebf5d5297613ebcaa1ea2b";

export const TRUSTED_ROOT_TEXT =
  '{"signatures":[{"keyid":"675d39992b1bb29115292b01063077059f2deb977793675cc72d01a99bb6f9b8","sig":"65fb76a7c8a5118cc1aa3f4d166481ceac827bc1ea244c188131956952b58c7fdf1b0e61aacb8cc632169412e7e73b1ffa0db91f3c63e7e31827d51f79e25509"}],"signed":{"_type":"root","spec_version":"1.0.31","version":1,"expires":"2027-10-10T07:16:21.237Z","keys":{"675d39992b1bb29115292b01063077059f2deb977793675cc72d01a99bb6f9b8":{"keytype":"ed25519","scheme":"ed25519","keyval":{"public":"f56653401642f4e9217b0e92eaf2047d51dfb43f647c6eafc0114f6e1d87a57e"}},"15191df72bd64b620d15993fe57fd4b869322f0e3dccef6eca17e30fb65d7d28":{"keytype":"ed25519","scheme":"ed25519","keyval":{"public":"84f37b59f8523178be5900f9f024e59f7fc160b346ac9a2dd0aa4a43b8496ed8"}},"845c1da08705cde6679b3d68000a6b9ac56e7c74399e9c363ad0d41c3d5cfef3":{"keytype":"ed25519","scheme":"ed25519","keyval":{"public":"4a1cff070d248173c8be1e37b7b933a2db4f3efe700965717bca0dc87cc5bc9d"}}},"roles":{"root":{"keyids":["675d39992b1bb29115292b01063077059f2deb977793675cc72d01a99bb6f9b8"],"threshold":1},"targets":{"keyids":["15191df72bd64b620d15993fe57fd4b869322f0e3dccef6eca17e30fb65d7d28"],"threshold":1},"snapshot":{"keyids":["845c1da08705cde6679b3d68000a6b9ac56e7c74399e9c363ad0d41c3d5cfef3"],"threshold":1},"timestamp":{"keyids":["845c1da08705cde6679b3d68000a6b9ac56e7c74399e9c363ad0d41c3d5cfef3"],"threshold":1}},"consistent_snapshot":true}}';

/** Throws when `text` is not the pinned root. Exported so a test can show the check fails on a changed text. */
export function assertPinnedRoot(text: string, pin: string = TRUSTED_ROOT_SHA256): string {
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  if (actual !== pin) throw new Error("the compiled trusted root does not match its pinned hash");
  return text;
}

assertPinnedRoot(TRUSTED_ROOT_TEXT);
