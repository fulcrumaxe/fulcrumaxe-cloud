import { afterEach, describe, expect, it } from "vitest";
import { GET, dynamic } from "../app/api/v1/openapi.json/route.js";

const saved = { env: process.env.NODE_ENV, flag: process.env.FX_API_TOKENS_ENABLED };
const setEnv = (nodeEnv: string, flag?: string) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env.FX_API_TOKENS_ENABLED;
  else process.env.FX_API_TOKENS_ENABLED = flag;
};
afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = saved.env;
  if (saved.flag === undefined) delete process.env.FX_API_TOKENS_ENABLED;
  else process.env.FX_API_TOKENS_ENABLED = saved.flag;
});

const describe_ = async (): Promise<string> => ((await (await GET()).json()) as { info: { description: string } }).info.description;

describe("GET /api/v1/openapi.json opening sentence follows the token availability the mint route uses", () => {
  it("is read per request, not built once", () => {
    expect(dynamic).toBe("force-dynamic");
  });
  it("production without the flag: tokens aren't available yet", async () => {
    setEnv("production");
    expect(await describe_()).toContain("API tokens aren't available yet.");
  });
  it("production with FX_API_TOKENS_ENABLED=1: no such sentence", async () => {
    setEnv("production", "1");
    const text = await describe_();
    expect(text).not.toContain("aren't available");
    expect(text).toContain("Create an API token");
  });
  it("keeps the cache header and the rest of the document", async () => {
    setEnv("production", "1");
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(Object.keys(((await res.json()) as { paths: object }).paths).length).toBeGreaterThan(10);
  });
});
