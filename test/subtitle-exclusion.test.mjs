import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("字幕排除规则即时作用于搜索缓存、已读取正文和保存", async (t) => {
  const request = globalThis.fetch;
  const names = ["Sample.Movie.AI draft.srt", "Sample.Movie.release.srt", "Sample.Movie.manual.srt"];
  const downloads = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = new URL(url);
    if (target.hostname === "api-shoulei-ssl.xunlei.com") {
      return Response.json({
        code: 0,
        result: "ok",
        data: names.map((name, index) => ({
          name, url: `https://subtitle.example/${index}.srt`, ext: "srt", languages: ["简体中文"],
        })),
      });
    }
    assert.equal(target.hostname, "subtitle.example");
    downloads.push(target.pathname);
    const lines = ["SEHUATANG 字幕组", "本字幕由ＮＥＵＲＡＬ工具生成", "ｗｗｗ．９８Ｔ．ｌａ\n（脚步声靠近）"];
    const line = lines[Number(target.pathname.slice(1, 2))];
    return new Response(`1\n00:02:00,000 --> 00:02:04,000\n${line}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  });
  // 导入时绑定模拟的外部请求。到本地服务仍使用真实 HTTP。
  const { startServer } = await import("../server.mjs");
  const dataDir = await mkdtemp(path.join(tmpdir(), "subtitle-exclusion-"));
  const { server, url } = await startServer({ port: 0, dataDir });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const get = (route) => request(url + route);
  const post = (route, body, method = "POST") => request(url + route, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const setKeywords = (subtitleExclusionKeywords) =>
    post("/api/settings", { settings: { subtitleExclusionKeywords, minSubtitleSizeKb: 0 } }, "PUT");
  const search = () => get("/api/search?q=Sample%20Movie&source=thunder");
  const original = await (await search()).json();
  assert.equal(original.count, 3);
  const id = (name) => original.results.find((result) => result.title === name).id;
  const bodyId = id(names[1]);
  const manualId = id(names[2]);
  assert.equal((await setKeywords("")).status, 200);
  assert.equal((await get(`/api/preview?id=${bodyId}`)).status, 200);

  assert.equal((await setKeywords("  AI DRAFT\r\n\r\nNeural  ")).status, 200);
  const filtered = await (await search()).json();
  assert.equal(filtered.cached, true);
  assert.equal(filtered.excludedCount, 1);
  assert.deepEqual(new Set(filtered.results.map((result) => result.id)), new Set([bodyId, manualId]));
  for (const action of ["validate", "preview", "download"]) {
    const response = await get(`/api/${action}?id=${bodyId}&convert=zh-TW`);
    assert.equal(response.status, 422);
    const error = await response.json();
    assert.match(error.detail, /Neural/);
    if (action !== "download") assert.equal(error.excluded, true);
  }
  const cloudSave = await post("/api/drive115/save", { resultId: bodyId });
  assert.equal(cloudSave.status, 400);
  assert.match((await cloudSave.json()).error, /Neural/);
  assert.equal(downloads.filter((name) => name === "/1.srt").length, 1);

  const manual = await (await get(`/api/validate?id=${manualId}&convert=zh-TW`)).json();
  assert.equal(manual.valid, true);
  assert.equal(manual.recommendationRank, 3);
  assert.equal(manual.validation.dialogueText, undefined);
  assert.equal((await setKeywords("")).status, 200);
  assert.equal((await (await search()).json()).count, 3);
  assert.equal((await get(`/api/download?id=${bodyId}`)).status, 200);

  const setSaveFilter = (subtitleSaveFilter, subtitleExclusionKeywords = "") =>
    post("/api/settings", { settings: { subtitleSaveFilter, subtitleExclusionKeywords, minSubtitleSizeKb: 0 } }, "PUT");
  const preview = (candidate) => get(`/api/preview?id=${candidate}&convert=zh-TW`).then((response) => response.json());
  const download = (candidate) => get(`/api/download?id=${candidate}&convert=zh-TW`);
  const saveTo115 = (candidate) => post("/api/drive115/save", { resultId: candidate }).then((response) => response.json());
  assert.equal((await setSaveFilter({ enabled: true, keywords: "98t" })).status, 200);
  assert.match((await preview(bodyId)).saveRestriction, /未命中保存特征/);
  assert.match((await (await get(`/api/validate?id=${bodyId}`)).json()).saveRestriction, /未命中保存特征/);
  assert.equal((await download(bodyId)).status, 422);
  assert.match((await saveTo115(bodyId)).error, /未命中保存特征/);
  assert.equal((await preview(manualId)).saveRestriction, "");
  assert.equal((await download(manualId)).status, 200);
  assert.match((await saveTo115(manualId)).error, /请先登录 115/);
  assert.equal((await (await search()).json()).count, 3);

  await setSaveFilter({ enabled: true, keywords: "sehua" });
  assert.equal((await download(id(names[0]))).status, 422);
  await setSaveFilter({ enabled: true, keywords: "sehuatang" });
  assert.equal((await download(manualId)).status, 422);
  assert.equal((await download(id(names[0]))).status, 200);
  await setSaveFilter({ enabled: true, keywords: "\n neural \n [括号说明] \n" });
  assert.equal((await download(bodyId)).status, 200);
  assert.equal((await download(manualId)).status, 200);
  await setSaveFilter({ enabled: true, keywords: "AI DRAFT" });
  assert.equal((await download(id(names[0]))).status, 422);
  await setSaveFilter({ enabled: true, keywords: "neural" }, "neural");
  assert.match((await saveTo115(bodyId)).error, /排除关键词/);
  await setSaveFilter({ enabled: false, keywords: "neural" });
  assert.equal((await download(manualId)).status, 200);
});
