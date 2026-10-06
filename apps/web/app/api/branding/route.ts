import { NextResponse } from "next/server";

/**
 * D#37 Correction C19d, task WS-B1 criterion 1: the six keys the shell
 * actually reads (script.js's window.brandingData / boot.js's
 * fetchBranding()), not the "name"/"shortName" pair this route used to
 * return -- the technical architect (discussioncomment-18606542) found the
 * shell never reads either of those, so the jpos defaults in
 * apps/workspace/shell/script.js always won. Anonymous, static, no
 * version/env/host/account data -- see api/mode/route.ts's fuller
 * comment. Boot runs before sign-in, so this route stays anonymous; the
 * values are the owner-ruled strings (OWNER DECISION, 2026-09-25), not
 * placeholders.
 */
export const dynamic = "force-static";

const BODY = {
  page_title: "fulcrumaxe",
  product_name: "fulcrumaxe cloud",
  os_name: "fulcrumaxe cloud",
  system_tag: "fulcrumaxe cloud",
  copyright: "© fulcrumaxe",
  welcome_message: "Welcome to fulcrumaxe cloud.",
} as const;

export function GET(): NextResponse {
  return NextResponse.json(BODY);
}
