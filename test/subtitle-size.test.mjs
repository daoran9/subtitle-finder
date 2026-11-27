import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("统一按实际保存的字幕字节数过滤，支持调节门槛和关闭", async (t) => {
  const request = globalThis.fetch;
  const boundary = 20 * 1024;
  const header = "1\n00:00:01,000 --> 00:00:02,000\n門牌";
  const subtitle = (bytes) => `${header}${"x".repeat(bytes - Buffer.byteLength(header + "\n"))}\n`;
  const fixtures = new Map([
    ["Sample.Movie.short.srt", subtitle(boundary - 1)],
    ["Sample.Movie.boundary.srt", subtitle(boundary)],
  ]);
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = new URL(url);
    if (target.hostname === "api-shoulei-ssl.xunlei.com") {
      const data = [...fixtures.keys()].map((name) => ({
        name, url: `https://subtitle.example/${name}`, ext: "srt", languages: ["繁体中文"],
      }));
      return Response.json({ code: 0, result: "ok", data });
    }
    assert.equal(target.hostname, "subtitle.example");
    const body = fixtures.get(target.pathname.slice(1));
    assert.ok(body);
    return new Response(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });
  const { startServer } = await import("../server.mjs");
  const dataDir = await mkdtemp(path.join(tmpdir(), "subtitle-size-"));
  const { server, url } = await startServer({ port: 0, dataDir });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const get = (route) => request(url + route);
  const send = (route, body, method = "POST") => request(url + route, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const setMinimum = (minSubtitleSizeKb) => send("/api/settings", {
    settings: { minSubtitleSizeKb, customDictionary: "门=門牌" },
  }, "PUT");
  assert.equal((await (await get("/api/settings")).json()).settings.minSubtitleSizeKb, 20);
  const { results } = await (await get("/api/search?q=Sample%20Movie&source=thunder")).json();
  const short = results.find(({ title }) => title === "Sample.Movie.short.srt").id;
  const exact = results.find(({ title }) => title === "Sample.Movie.boundary.srt").id;
  for (const action of ["validate", "preview", "download"]) {
    const response = await get(`/api/${action}?id=${short}`);
    assert.equal(response.status, 422);
    const error = await response.json();
    assert.match(error.detail, /低于 20 KB/);
    if (action !== "download") {
      assert.equal(error.tooSmall, true);
      assert.equal(error.invalidContent, false);
    }
  }
  const cloudSave = await send("/api/drive115/save", { resultId: short });
  assert.equal(cloudSave.status, 400);
  assert.match((await cloudSave.json()).error, /低于 20 KB/);

  const download = await get(`/api/download?id=${exact}`);
  assert.equal(download.status, 200);
  assert.equal((await download.arrayBuffer()).byteLength, boundary);

  assert.equal((await setMinimum(20)).status, 200);
  const converted = await get(`/api/validate?id=${exact}&convert=zh-CN`);
  assert.equal(converted.status, 422);
  assert.equal((await converted.json()).tooSmall, true);

  assert.equal((await setMinimum(21)).status, 200);
  const raised = await get(`/api/validate?id=${exact}`);
  assert.equal(raised.status, 422);
  assert.match((await raised.json()).detail, /低于 21 KB/);

  assert.equal((await setMinimum(0)).status, 200);
  assert.equal((await setMinimum(0.5)).status, 400);
  assert.equal((await get(`/api/download?id=${short}`)).status, 200);
});
