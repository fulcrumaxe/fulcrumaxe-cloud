// Child process for the signal tests. It writes marker lines to stderr, and only then waits for the test's signal.
// In every mode captureSession has made its profile folder and installed its signal handlers before the marker is written.
// argv: <profile root> [mode] [launch grace ms]. Modes:
//   (none)      READY       the real headless browser is up, against a local server that never signs anyone in;
//                           when it closes, CLOSED exists=<whether the profile folder was still there> follows;
//   prelaunch   PRELAUNCH   the launcher has been called and returns after 3 s; each close() writes CLOSE;
//   hang        PRELAUNCH   the launcher never settles (the server keeps the event loop alive);
//   slowclose   CLOSING     the capture has timed out and its normal cleanup is closing a slow browser.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromiumLauncher } from "../../fixtures/capture-browser.js";
import { captureSession, type Launcher } from "../../src/sessions.js";
import { makeTarget } from "../helpers.js";

const root = process.argv[2] as string;
const mode = process.argv[3] ?? "ready";
const grace = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const note = (line: string): void => void process.stderr.write(`${line}\n`);
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html>waiting for a person</html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

const fake = (closeMs: number, onClose: () => void): { cookie: () => Promise<undefined>; close: () => Promise<void> } => ({
  cookie: async () => undefined,
  close: async () => {
    onClose();
    await new Promise((r) => setTimeout(r, closeMs));
  },
});

const launcher: Launcher =
  mode === "prelaunch"
    ? async () => {
        note("PRELAUNCH");
        await new Promise((r) => setTimeout(r, 3_000));
        return fake(0, () => note("CLOSE"));
      }
    : mode === "hang"
      ? async () => {
          note("PRELAUNCH");
          await new Promise<never>(() => undefined);
          throw new Error("unreachable");
        }
      : mode === "slowclose"
        ? async () => {
            note("LAUNCHED");
            return fake(3_000, () => note("CLOSING"));
          }
        : async (o) => {
            const browser = await chromiumLauncher(o);
            note("READY");
            return {
              cookie: () => browser.cookie(),
              close: async () => {
                // Seen when the close is asked for, before the browser can recreate anything in the folder.
                const there = existsSync(o.profileDir);
                await browser.close();
                note(`CLOSED exists=${there}`);
              },
            };
          };

await captureSession({
  target: makeTarget({ origin, protected: false }),
  profileRoot: root,
  headless: true,
  pollMs: 100,
  timeoutMs: mode === "slowclose" ? 300 : 120_000,
  launcher,
  ...(grace === undefined ? {} : { launchGraceMs: grace }),
});
