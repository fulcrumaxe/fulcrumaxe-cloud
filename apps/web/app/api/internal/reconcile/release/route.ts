import { releaseHandler } from "./handler";

/** Not under /api/v1 and not a cron route: see handler.ts for the auth model (its own bearer secret). */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  return releaseHandler(req);
}

export async function POST(req: Request): Promise<Response> {
  return releaseHandler(req);
}
