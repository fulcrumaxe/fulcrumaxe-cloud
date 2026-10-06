// Fallback for a path the gate approved but the router did not match to the
// proxy route (the router sees the path before Next cleans it). Answers the
// same empty 404 the gate gives, instead of Next's HTML 404 page. It reads
// nothing from the request and holds no logic.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = (): Response => new Response(null, { status: 404 });

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
