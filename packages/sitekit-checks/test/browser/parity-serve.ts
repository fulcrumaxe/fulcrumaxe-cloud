/**
 * Used only by test/parity.sh: serves a directory with serve.ts and prints its origin, so an original
 * os-site-v2 tool can be pointed at it with BASE. Runs until killed.
 *
 *   pnpm exec tsx test/browser/parity-serve.ts <dir>
 */
import { serveStatic } from "../../src/lib/browser/serve.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: parity-serve.ts <dir>");
  process.exit(2);
}
const server = await serveStatic(dir);
console.log(server.origin);
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
