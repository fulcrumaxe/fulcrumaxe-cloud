// D#845 ON-19a: the Repos app's GitHub identity setting, state by state. The controller has no DOM (a fake call() stands in for the server, strict about the contract:
// one PUT with exactly { github_identity } and no Idempotency-Key, which the route refuses); the view and its confirm dialog are built by the shared h() against a small stand-in for the DOM calls.
// The Team chip says the same words as the Repos row; one test pins both strings. The vitest environment is node.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY_WORDS,
  createGithubIdentityControl,
  createGithubIdentityController,
  identityConfirmParts,
  identityScopeLines,
  identitySentence,
  identityUrl,
} from "../apps/repos/repos-runners.js";
import { IDENTITY_CHIP } from "../apps/team/team-model.js";

const REPO = "99999999-9999-4999-8999-999999999999";
const ACTING = "Acting as you on GitHub (all your repos)";
const refusal = (status, code) => Object.assign(new Error("server text that must never be shown"), { status, code });
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeServer({ identity = "app", machine = "Studio laptop", writeError = null, scopes } = {}) {
  const log = [];
  let current = identity;
  const call = vi.fn(async (method, path, body, _signal, opts) => {
    log.push([method, path, body]);
    expect(path).toBe(identityUrl(REPO));
    if (method === "PUT") {
      expect(opts).toBeUndefined();
      expect(body).toEqual({ github_identity: expect.stringMatching(/^(app|personal)$/) });
      if (writeError) throw writeError;
      current = body.github_identity;
    }
    return { github_identity: current, machine, ...(scopes ? { scopes } : {}) };
  });
  return { call, log };
}

describe("the GitHub identity setting: words and controller", () => {
  it("the Repos row and the Team chip say the same fixed words, and the url names the repo's setting", () => {
    expect(IDENTITY_WORDS.acting).toBe(ACTING);
    expect(IDENTITY_CHIP).toBe(ACTING);
    expect(identityUrl(REPO)).toBe("/api/v1/repos/" + REPO + "/github-identity");
  });

  it("the confirm text is exactly the fixed sentence with the machine and the repo named", () => {
    expect(identityConfirmParts("Studio laptop", "acme/web").join("")).toBe(
      "The engine on Studio laptop will act as you on GitHub. It can reach every repo your GitHub account can reach, not just acme/web. Its pull requests and comments will come from you. You can switch back at any time.",
    );
  });

  it("scope lines: workflow adds its line; delete_repo or admin:org adds the other; a name that is not listed adds nothing", () => {
    expect(identityScopeLines([])).toEqual([]);
    expect(identityScopeLines(["repo", "read:org", "gist"])).toEqual([]);
    expect(identityScopeLines(["repo", "workflow"])).toEqual(["This sign-in can change GitHub Actions workflows in every repo it reaches."]);
    expect(identityScopeLines(["delete_repo"])).toEqual(["This sign-in can also delete repos or change org settings."]);
    expect(identityScopeLines(["admin:org"])).toEqual(["This sign-in can also delete repos or change org settings."]);
    expect(identityScopeLines(["workflow", "delete_repo", "admin:org"])).toHaveLength(2);
  });

  it("a refusal is a sentence of this file's own, chosen by status and code, never the server's text", () => {
    expect(identitySentence(refusal(403))).toBe(IDENTITY_WORDS.adminOnly);
    expect(identitySentence(refusal(409, "personal_identity_public_repo"))).toBe(IDENTITY_WORDS.public);
    expect(identitySentence(refusal(409, "repo_visibility_unknown"))).toBe(IDENTITY_WORDS.unknown);
    for (const e of [refusal(409, "other"), refusal(500), new Error("x"), null]) expect(identitySentence(e)).toBe(IDENTITY_WORDS.failed);
  });

  it("reads the identity and the machine; an odd answer reads as unavailable, never as app", async () => {
    const ctl = createGithubIdentityController({ call: fakeServer({ identity: "personal" }).call, repoId: REPO });
    expect(ctl.state.status).toBe("loading");
    await ctl.load();
    expect(ctl.state).toMatchObject({ status: "ready", identity: "personal", machine: "Studio laptop" });
    for (const odd of [null, {}, { github_identity: "both" }, { github_identity: null }]) {
      const c = createGithubIdentityController({ call: async () => odd, repoId: REPO });
      await c.load();
      expect(c.state.status).toBe("error");
    }
  });

  it("a switch sends one PUT and tells the row; a refused one shows the sentence and keeps the value", async () => {
    const saved = [];
    const server = fakeServer();
    const ctl = createGithubIdentityController({ call: server.call, repoId: REPO, onSaved: (v) => saved.push(v) });
    await ctl.load();
    expect(await ctl.change("personal")).toBe(true);
    expect(saved).toEqual(["personal"]);
    expect(server.log.filter(([m]) => m === "PUT")).toHaveLength(1);

    const refused = createGithubIdentityController({ call: fakeServer({ writeError: refusal(409, "personal_identity_public_repo") }).call, repoId: REPO, onSaved: (v) => saved.push(v) });
    await refused.load();
    expect(await refused.change("personal")).toBe(false);
    expect(refused.state).toMatchObject({ identity: "app", phase: "error", error: IDENTITY_WORDS.public });
    expect(saved).toEqual(["personal"]);
  });
});

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.attrs = {}; this.kids = []; this.on = {}; this.className = ""; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { this.on[t] = f; }
  appendChild(c) { this.kids.push(c); return c; }
  replaceChildren(...cs) { this.kids = cs; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.removed = true; }
  focus() { if (!this.disabled && !this.hidden) globalThis.document.activeElement = this; }
  get textContent() { return this.kids.map((k) => (k instanceof FakeEl ? k.textContent : k.text)).join("") + (this._text || ""); }
  set textContent(v) { this.kids = []; this._text = v; }
}
const findAll = (el, test, out = []) => (test(el) && out.push(el), el.kids.forEach((k) => k instanceof FakeEl && findAll(k, test, out)), out);
const byId = (root, id) => findAll(root, (e) => e.getAttribute("data-testid") === id)[0];

describe("the GitHub identity setting: the view and its confirm dialog", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("document", { createElement: (t) => new FakeEl(t), createTextNode: (text) => ({ text }), activeElement: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function open({ canChange = true, ...opts } = {}) {
    const server = fakeServer(opts);
    const body = new FakeEl("body");
    const saved = [];
    const view = createGithubIdentityControl({ call: server.call, repoId: REPO, getRepoName: () => "acme/web", canChange: () => canChange, onSaved: (v) => saved.push(v), doc: { body } });
    view.load();
    await settle();
    return { view, body, saved, ...server };
  }

  it("app: the line says the app, the button opens a modal dialog that names the machine and the repo, and nothing is sent yet", async () => {
    const { view, body, log } = await open({ scopes: ["repo", "workflow"] });
    expect(byId(view.el, "repos-identity-line").textContent).toBe(IDENTITY_WORDS.app);
    byId(view.el, "repos-identity-button").on.click();
    const dlg = byId(body, "repos-identity-dialog");
    expect(dlg.open).toBe(true);
    expect(byId(dlg, "repos-identity-text").textContent).toBe(identityConfirmParts("Studio laptop", "acme/web").join(""));
    expect(findAll(dlg, (e) => e.getAttribute("data-testid") === "repos-identity-scope").map((e) => e.textContent)).toEqual(["This sign-in can change GitHub Actions workflows in every repo it reaches."]);
    expect(dlg.textContent).toContain(IDENTITY_WORDS.tick);
    expect(log.filter(([m]) => m === "PUT")).toHaveLength(0);
  });

  it("the confirm stays off until the box is ticked; ticked, one PUT, the dialog closes and the line says it acts as you", async () => {
    const { view, body, log, saved } = await open();
    byId(view.el, "repos-identity-button").on.click();
    const tick = byId(body, "repos-identity-tick");
    const yes = byId(body, "repos-identity-confirm");
    expect(yes.getAttribute("aria-disabled")).toBe("true");
    await yes.on.click();
    expect(log.filter(([m]) => m === "PUT")).toHaveLength(0);
    tick.checked = true;
    tick.on.change();
    expect(yes.getAttribute("aria-disabled")).toBe("false");
    await yes.on.click();
    await settle();
    expect(log.filter(([m]) => m === "PUT")).toEqual([["PUT", identityUrl(REPO), { github_identity: "personal" }]]);
    expect(saved).toEqual(["personal"]);
    expect(byId(view.el, "repos-identity-line").textContent).toBe(ACTING);
    expect(byId(body, "repos-identity-dialog").open).toBe(false);
    expect(byId(view.el, "repos-identity-button").textContent).toBe(IDENTITY_WORDS.back);
  });

  it("cancel sends nothing; with no machine known the sentence says your machine", async () => {
    const { view, body, log } = await open({ machine: null });
    byId(view.el, "repos-identity-button").on.click();
    expect(byId(body, "repos-identity-text").textContent).toContain("The engine on your machine will");
    byId(body, "repos-identity-cancel").on.click();
    expect(log.filter(([m]) => m === "PUT")).toHaveLength(0);
    expect(byId(body, "repos-identity-dialog").open).toBe(false);
  });

  it("personal: switching back sends at once, with no dialog; a member sees the value and a disabled button", async () => {
    const back = await open({ identity: "personal" });
    expect(byId(back.view.el, "repos-identity-line").textContent).toBe(ACTING);
    byId(back.view.el, "repos-identity-button").on.click();
    await settle();
    expect(back.log.filter(([m]) => m === "PUT")).toEqual([["PUT", identityUrl(REPO), { github_identity: "app" }]]);
    expect(back.saved).toEqual(["app"]);
    expect(byId(back.view.el, "repos-identity-line").textContent).toBe(IDENTITY_WORDS.app);

    const member = await open({ identity: "personal", canChange: false });
    expect(byId(member.view.el, "repos-identity-button").disabled).toBe(true);
    expect(member.view.el.textContent).not.toMatch(/null|undefined|NaN|\[object/);
  });

  it.each([
    ["a public repo", refusal(409, "personal_identity_public_repo"), IDENTITY_WORDS.public],
    ["unknown visibility", refusal(409, "repo_visibility_unknown"), IDENTITY_WORDS.unknown],
    ["a member", refusal(403), IDENTITY_WORDS.adminOnly],
    ["a network failure", new Error("offline"), IDENTITY_WORDS.failed],
  ])("%s: the sentence is an alert INSIDE the open dialog (the modal makes the outside inert), focused, and the line is unchanged", async (_n, writeError, sentence) => {
    const { view, body } = await open({ writeError });
    byId(view.el, "repos-identity-button").on.click();
    const dlg = byId(body, "repos-identity-dialog");
    const tick = byId(body, "repos-identity-tick");
    tick.checked = true;
    tick.on.change();
    await byId(body, "repos-identity-confirm").on.click();
    await settle();
    const alert = byId(dlg, "repos-identity-dialog-error");
    expect(alert.textContent).toBe(sentence);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(globalThis.document.activeElement).toBe(alert);
    expect(dlg.open).toBe(true);
    expect(byId(view.el, "repos-identity-error").textContent, "not shown outside while the dialog is open").toBe("");
    expect(byId(view.el, "repos-identity-line").textContent).toBe(IDENTITY_WORDS.app);
  });

  it("the dialog names its fixed sentence as its description", async () => {
    const { view, body } = await open();
    byId(view.el, "repos-identity-button").on.click();
    const dlg = byId(body, "repos-identity-dialog");
    expect(dlg.getAttribute("aria-describedby")).toBe(byId(dlg, "repos-identity-text").getAttribute("id"));
    expect(dlg.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("a refusal on the switch-back path, which has no dialog, shows in the outer alert", async () => {
    const { view } = await open({ identity: "personal", writeError: refusal(403) });
    byId(view.el, "repos-identity-button").on.click();
    await settle();
    expect(byId(view.el, "repos-identity-error").textContent).toBe(IDENTITY_WORDS.adminOnly);
  });
});

describe("the dialog's disabled look", () => {
  it("an aria-disabled button inside a Repos dialog is styled as off (the identity and remove sheets' confirm buttons)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../apps/repos/repos-app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.repos-dialog \.repos-btn\[aria-disabled="true"\]\s*\{[^}]*opacity/);
  });
});
