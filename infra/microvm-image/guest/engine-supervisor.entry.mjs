// The entry of `fx-engine-supervisor` (D#845 ON-13b1), bundled by `fx-runner vm build-image` into /usr/lib/fx/fx-engine-supervisor.mjs. It is the runner's own supervisor module (EB-12a's supervisor.ts, wrapped by
// engineHost/guestSession.ts) started with the guest's environment table; engine-bridge.py starts it as the unprivileged user and sets FX_ENGINE_DIR (the writable state directory) and FX_ENGINE_SOCK.
// FX_ENGINE_CLAUDE exists for the DRY real-VM test (a stand-in for the CLI); the bridge never sets it.
import { runEngineSupervise } from "../../../packages/fx-runner/scripts/engine-supervise-host.mjs";
import { guestEnvOf } from "../../../packages/fx-runner/src/vm/sandboxd/guestEnv.ts";

const dir = process.env.FX_ENGINE_DIR;
const socket = process.env.FX_ENGINE_SOCK;
if (dir === undefined || socket === undefined) {
  process.stderr.write("fx-engine-supervisor: FX_ENGINE_DIR and FX_ENGINE_SOCK are required\n");
  process.exit(2);
}
// The program must END after a channel stop or a crash_loop: no copy of the credential may stay in its memory (the bridge kills the group and init starts a fresh supervisor). Exit explicitly, open timers or sockets or not.
process.exit(await runEngineSupervise({ dir, socket, claudePath: process.env.FX_ENGINE_CLAUDE ?? "/opt/fx/bin/claude", env: guestEnvOf({}) }));
