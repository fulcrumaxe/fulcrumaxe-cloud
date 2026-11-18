"use client";

import { createElement as h, useState, type FormEvent, type ReactNode } from "react";

interface Found {
  facts: { hostname?: string; os: string; arch: string; kvm: boolean; ip_country?: string };
  warning: string;
}

type Step = { name: "type" } | { name: "found"; found: Found } | { name: "done"; text: string };
/** What a field's change event gives us: the text the person typed. */
type Typing = { target: { value: string } };
type Reply = { ok: true; data: Found & { runner_id?: string } } | { ok: false; code: string };

/** What a refusal says, in words. Only the code is read from a reply; a message from the server is never shown as it came. */
const REFUSALS: Record<string, string> = {
  code_not_found: "That code is not one we know. Check the code on the machine and type it again.",
  code_gone: "That code has expired or was already used. Start a new one on the machine.",
  rate_limited: "Too many wrong codes. Try again in 15 minutes.",
  forbidden: "Only an owner or admin of this account can link a machine.",
  unauthenticated: "Sign in first, then come back and type the code.",
  runner_limit: "This account has no room for another machine on its plan.",
  not_configured: "Linking by code is not available on this deployment.",
};

async function call(path: string, body: unknown): Promise<Reply> {
  const res = await fetch(`/api/v1/runners/device/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
  return res.ok ? { ok: true, data: data as Found } : { ok: false, code: String(data.error?.code ?? "unknown") };
}

const row = (label: string, value: string): ReactNode[] => [h("dt", { key: `${label}-t` }, label), h("dd", { key: `${label}-d` }, value)];

/** The field starts empty and only ever holds what the person typed. There is no prop, query value or storage that sets it. */
export function LinkForm() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>({ name: "type" });
  const [error, setError] = useState<string | null>(null);
  const fail = (c: string) => setError(REFUSALS[c] ?? "Something went wrong. Try again.");

  async function lookup() {
    setError(null);
    const r = await call("lookup", { user_code: code });
    if (r.ok) setStep({ name: "found", found: r.data });
    else fail(r.code);
  }
  async function decide(approve: boolean) {
    setError(null);
    const r = approve ? await call("approve", { user_code: code, confirm: true, ...(name ? { name } : {}) }) : await call("deny", { user_code: code });
    if (!r.ok) return fail(r.code);
    setStep({ name: "done", text: approve ? "The machine is linked. It has no projects yet; place one on it to give it work." : "Cancelled. The machine will be told the code was turned down." });
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void (step.name === "type" ? lookup() : decide(true));
  };

  if (step.name === "done") return h("p", { role: "status" }, step.text);
  const f = step.name === "found" ? step.found : null;
  return h(
    "form",
    { onSubmit: submit },
    h("label", null, "Code", h("input", { name: "code", autoComplete: "off", autoCapitalize: "characters", spellCheck: false, value: code, onChange: (e: Typing) => setCode(e.target.value), disabled: step.name !== "type" })),
    f
      ? [
          h("dl", { key: "facts" }, [
            ...(f.facts.hostname ? row("Name", f.facts.hostname) : []),
            ...row("System", `${f.facts.os} ${f.facts.arch}`),
            ...(f.facts.ip_country ? row("Country", f.facts.ip_country) : []),
            ...row("KVM", f.facts.kvm ? "yes" : "no"),
          ]),
          h("p", { key: "warning" }, f.warning),
          h("label", { key: "name" }, "Name (optional)", h("input", { name: "name", maxLength: 64, value: name, onChange: (e: Typing) => setName(e.target.value) })),
          h("button", { key: "link", type: "submit" }, "Link this machine"),
          h("button", { key: "cancel", type: "button", onClick: () => void decide(false) }, "Cancel"),
        ]
      : h("button", { type: "submit", disabled: code.trim().length === 0 }, "Look up"),
    error ? h("p", { role: "alert" }, error) : null,
  );
}
