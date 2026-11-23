import { fakeHetznerHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request): Promise<Response> => fakeHetznerHandler(req);
export const POST = GET;
export const PUT = GET;
export const DELETE = GET;
