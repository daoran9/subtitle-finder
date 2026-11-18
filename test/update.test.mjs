import assert from "node:assert/strict";
import test from "node:test";
import { readLatestRelease } from "../server.mjs";

test("更新检查在 GitHub API 限流时从官方发布页核对正式版和平台附件", async () => {
  const result = await readLatestRelease(async (address, options) => {
    const url = new URL(address);
    if (url.hostname === "api.github.com") {
      return new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    }
    assert.equal(url.hostname, "github.com");
    assert.equal(options.method, "HEAD");
    assert.equal(options.redirect, "manual");
    if (url.pathname.endsWith("/latest")) {
      return Response.redirect("https://github.com/daoran9/subtitle-finder/releases/tag/v1.10.0", 302);
    }
    assert.match(url.pathname, /\/releases\/download\/v1\.10\.0\/SubtitleFinder/);
    if (!url.pathname.endsWith(".exe")) return new Response(null, { status: 404 });
    return Response.redirect("https://release-assets.githubusercontent.com/test", 302);
  });
  assert.deepEqual(result, {
    version: "1.10.0", platforms: ["windows"],
    url: "https://github.com/daoran9/subtitle-finder/releases/tag/v1.10.0",
  });
});

test("更新检查拒绝草稿、预发布和无法核对的版本", async () => {
  for (const release of [
    { tag_name: "v1.8.0", draft: true, prerelease: false },
    { tag_name: "v1.8.0", draft: false, prerelease: true },
    { tag_name: "vNext", draft: false, prerelease: false },
  ]) {
    await assert.rejects(readLatestRelease(async () => Response.json(release)), /不是可用的正式版本/);
  }
});
