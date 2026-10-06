// D#37 WS-F0 fixture: a first-party SDK app written in TSX. It is a test
// input for the first-party build step (build/first-party.mjs) and lives
// under test/fixtures/ precisely so it can never ship in the real dist/.
//
// Imports are spelled in DIST space: build/first-party.mjs resolves them
// against dist/, where "../../sdk/fulc-sdk.js" is shell/sdk/fulc-sdk.js and
// "../_shared/label.js" is apps/_shared/label.ts compiled to .js.
//
// Deliberately no innerHTML (or any other Trusted Types sink): every node is
// built by the shell's own JSX runtime, which creates real DOM with
// createElement / createTextNode.
import { register } from "../../sdk/fulc-sdk.js";
import { label } from "../_shared/label.js";
import { FixtureView } from "./view.js";

register({
  id: "fp-fixture",
  title: "FP Fixture",
  icon: "FX",
  defaultSize: { w: 360, h: 240 },
  onOpen({ contentEl }: { contentEl: HTMLElement }) {
    contentEl.append(<FixtureView start={0} format={label} />);
  },
});
