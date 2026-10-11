import { listTokensHandler, mintTokenHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listTokensHandler;
export const POST = mintTokenHandler;
