import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("auth middleware config", () => {
  it("exports correct matcher targeting API routes", async () => {
    const mod = await import("@/middleware");
    assert.equal(mod.config.matcher, "/api/:path*");
  });

  it("middleware function is exported", async () => {
    const mod = await import("@/middleware");
    assert.equal(typeof mod.middleware, "function");
  });
});
