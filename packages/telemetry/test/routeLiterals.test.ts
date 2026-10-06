import { describe, expect, it } from "vitest";
import { routeTemplate } from "../src/fields.js";

describe("routeTemplate keeps the adopted routes readable and still hides anything variable", () => {
  it.each([
    ["/api/github/webhook", "/api/github/webhook"],
    ["/api/stripe/webhook", "/api/stripe/webhook"],
    ["/api/github/create-repo/callback", "/api/github/create-repo/callback"],
    ["/api/github/install/team/callback", "/api/github/install/:id/callback"],
    ["/api/cron/api-sweep", "/api/cron/api-sweep"],
    ["/api/github/octo-org/secret-repo", "/api/github/:id/:id"],
  ])("%s -> %s", (input, expected) => {
    expect(routeTemplate(input)).toBe(expected);
  });
});
