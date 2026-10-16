// Child process for the signal tests: a real capture with the real headless browser against a local server that never
// signs anyone in. It prints READY once the browser is up, then waits for the test to send it a signal.
// argv: <profile root>
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromiumLauncher } from "../../fixtures/capture-browser.js";
import { captureSession } from "../../src/sessions.js";
import { makeTarget } from "../helpers.js";

const root = process.argv[2] as string;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html>waiting for a person</html>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

await captureSession({
  target: makeTarget({ origin, protected: false }),
  profileRoot: root,
  headless: true,
  pollMs: 100,
  timeoutMs: 120_000,
  launcher: async (o) => {
    const browser = await chromiumLauncher(o);
    console.log("READY");
    return browser;
  },
});
