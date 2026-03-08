import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePlist } from "@/app/api/_lib/plist-parser";

describe("parsePlist", () => {
  it("key/string pairs", () => {
    const plist = [
      "<key>Label</key>",
      "<string>ai.openclaw.gateway</string>",
      "<key>Comment</key>",
      "<string>OpenClaw Gateway</string>",
    ].join("\n");
    const result = parsePlist(plist);
    assert.equal(result.Label, "ai.openclaw.gateway");
    assert.equal(result.Comment, "OpenClaw Gateway");
  });

  it("boolean true/false values", () => {
    const plist = [
      "<key>KeepAlive</key>",
      "<true/>",
      "<key>RunAtLoad</key>",
      "<false/>",
    ].join("\n");
    const result = parsePlist(plist);
    assert.equal(result.KeepAlive, "true");
    assert.equal(result.RunAtLoad, "false");
  });

  it("empty plist → empty object", () => {
    assert.deepEqual(parsePlist(""), {});
  });

  it("key on last line with no next line", () => {
    const plist = "<key>Orphan</key>";
    const result = parsePlist(plist);
    // No value found — key should not be in result
    assert.equal(result.Orphan, undefined);
  });

  it("real-world gateway-style plist", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.gateway</string>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/gateway.log</string>
</dict>
</plist>`;
    const result = parsePlist(plist);
    assert.equal(result.Label, "ai.openclaw.gateway");
    assert.equal(result.KeepAlive, "true");
    assert.equal(result.StandardOutPath, "/tmp/gateway.log");
  });
});
