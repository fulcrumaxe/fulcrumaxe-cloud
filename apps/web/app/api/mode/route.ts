import { NextResponse } from "next/server";

/**
 * D#37 WS-C criterion 2: "GET /api/mode -> {"mode":"cloud","profile":
 * "cloud","features":{...all false}}. ... anonymous, static (`dynamic =
 * 'force-static'`, so no function invocation), and contain no version,
 * env, host or account data." The feature flags named here match WS-B's
 * `profiles/cloud.json` (`presence`, `liveEntitlements`, `crdt`,
 * `messages`, `updates`) -- WS-C1 doesn't build WS-B, but this is the
 * contract WS-B's fork code reads via `core/features.js` once it lands.
 */
export const dynamic = "force-static";

const BODY = {
  mode: "cloud",
  profile: "cloud",
  features: {
    presence: false,
    liveEntitlements: false,
    crdt: false,
    messages: false,
    updates: false,
  },
} as const;

export function GET(): NextResponse {
  return NextResponse.json(BODY);
}
