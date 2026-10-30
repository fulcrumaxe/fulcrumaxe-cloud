/** The only reads of the two settings and the app origin. Missing either setting means the transport is OFF (no send, no stamp). */
export type NotifyOffReason = "no_resend_key" | "no_from_address" | "no_app_origin";

export type NotifyConfig = { ok: true; apiKey: string; from: string; appOrigin: string } | { ok: false; reason: NotifyOffReason };

const present = (v: string | undefined): string | null => (v === undefined || v.trim() === "" ? null : v.trim());

export function loadNotifyConfig(env: Readonly<Record<string, string | undefined>>): NotifyConfig {
  const apiKey = present(env.RESEND_API_KEY);
  if (apiKey === null) return { ok: false, reason: "no_resend_key" };
  const from = present(env.NOTIFY_FROM);
  if (from === null) return { ok: false, reason: "no_from_address" };
  const origin = present(env.FX_APP_ORIGIN);
  if (origin === null) return { ok: false, reason: "no_app_origin" };
  return { ok: true, apiKey, from, appOrigin: origin.replace(/\/+$/, "") };
}
