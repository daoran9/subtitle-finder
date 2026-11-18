import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildAvSearchTerms, extractAvIdentity } from "../../public/av-identity.js";
import { buildSearchIntent, buildSelectedSearchSources, mergeSearchResultBuckets, searchSubtitleCat, searchThunder } from "../../server.mjs";
import { createFixtureRequest } from "../helpers/subtitle-source.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)), "..");
const fusionRoot = path.resolve(process.env.FUSION_ROOT || path.join(root, "115master-fork"));
const fixtures = JSON.parse(await readFile(new URL("../fixtures/av-identity.json", import.meta.url), "utf8"));
const source = JSON.parse(await readFile(new URL("../fixtures/subtitle-source.json", import.meta.url), "utf8"));
const fusionPackage = path.join(fusionRoot, "packages/subtitle-source/package.json");
await readFile(fusionPackage).catch(() => {
  throw new Error(`找不到 Fusion 仓库：${fusionRoot}。请设置 FUSION_ROOT；普通 npm test 无需该仓库。`);
});

// 直接打包另一个仓库的当前源码，只替换日志，不复制提取或解析实现。
const bundle = await build({
  stdin: {
    contents: `export { getAvNumber } from './apps/monkey/src/utils/getNumber.ts';
      export { Thunder } from './packages/subtitle-source/src/source/thunder.ts';
      export { SubtitleCat } from './packages/subtitle-source/src/source/subtitlecat.ts';
      export { buildAvSearchTerms } from './packages/subtitle-source/src/source/av.ts';`,
    resolveDir: fusionRoot,
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "quiet-logger",
    setup(builder) {
      builder.onResolve({ filter: /^@\/utils\/logger$/ }, () => ({ path: "logger", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const appLogger = { sub: () => ({ info() {} }) };" }));
    },
  }],
});
const fusion = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const requireFusion = createRequire(fusionPackage);
const { Window } = await import(pathToFileURL(requireFusion.resolve("happy-dom")).href);
const window = new Window();
const previousParser = globalThis.DOMParser;
before(() => { globalThis.DOMParser = window.DOMParser; });
after(async () => {
  if (previousParser === undefined) delete globalThis.DOMParser;
  else globalThis.DOMParser = previousParser;
  await window.happyDOM.close();
});

function matched(results) {
  return mergeSearchResultBuckets([results], 20, { queryVariants: [source.query], catalogIdentity: extractAvIdentity(source.query) });
}

function titles(results) {
  return results.map((item) => item.title).sort();
}

test("两个仓库的样本镜像必须一致，不能各自悄悄修改", async () => {
  const mirror = JSON.parse(await readFile(path.join(fusionRoot, "apps/monkey/src/utils/__tests__/fixtures/av-identity.json"), "utf8"));
  assert.deepEqual(mirror, fixtures);
});

test("共享样本在两个真实提取器中得到相同身份和检索变体", () => {
  for (const fixture of fixtures) {
    const finder = extractAvIdentity(fixture.input, { allowLooseCode: true });
    assert.equal(finder?.canonicalCode ?? null, fixture.canonicalCode, `Finder: ${fixture.input}`);
    assert.equal(fusion.getAvNumber(fixture.input), fixture.canonicalCode, `Fusion: ${fixture.input}`);
    if (finder) assert.deepEqual(buildAvSearchTerms(finder), fusion.buildAvSearchTerms(fixture.canonicalCode));
  }
});

test("相同原文件名和迅雷响应产生相同候选及关键元数据", async () => {
  const finderRequest = createFixtureRequest(source);
  const fusionRequest = createFixtureRequest(source);
  const intent = buildSearchIntent({ query: source.query, queryVariants: [source.query], videoFileName: source.fileName, hasLocalVideo: true, catalogIdentity: extractAvIdentity(source.query) });
  const finder = await searchThunder(intent.thunderVariants[0], 20, finderRequest.request);
  const client = new fusion.Thunder({ request: { get: fusionRequest.request }, extractAvNumber: fusion.getAvNumber });
  const results = await client.fetchSubtitle(source.fileName);
  const normalize = (items) => items.map((item) => ({ title: item.title, duration: item.durationMs, score: item.score, ext: item.ext || item.format })).sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(normalize(finder), normalize(results));
  assert.equal(finderRequest.calls[0], fusionRequest.calls[0]);
  assert.deepEqual(titles(matched(finder)), titles(matched(results)));
});

test("迅雷业务错误在两边都失败，不能把错误响应当成有效候选", async () => {
  const failed = structuredClone(source);
  failed.thunder.code = 1;
  failed.thunder.result = "error";
  const { request } = createFixtureRequest(failed);
  const client = new fusion.Thunder({ request: { get: request } });
  await assert.rejects(searchThunder(source.fileName, 20, request), /Thunder API error/);
  await assert.rejects(client.fetchSubtitle(source.fileName), /Thunder API error/);
});

test("SubtitleCat 相同单次查询、前五行和下载成功时，精确候选一致", async () => {
  const finderRequest = createFixtureRequest(source);
  const fusionRequest = createFixtureRequest(source);
  const finder = matched(await searchSubtitleCat(source.query, source.language, 5, finderRequest.request));
  const client = new fusion.SubtitleCat({ request: { get: fusionRequest.request }, extractAvNumber: fusion.getAvNumber });
  const results = await client.fetchSubtitle(source.query, source.language);
  const normalize = (items) => items.map((item) => ({ title: item.title, downloads: Number(item.downloads), comment: item.comment ?? item.score })).sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(normalize(finder), normalize(results));
  assert.equal(finderRequest.calls[0], fusionRequest.calls[0]);
  assert.ok(!titles(results).includes("JAC-0890 Chinese"));
});

test("SubtitleCat 超过五行的截取差异必须显式保留", async () => {
  const { request } = createFixtureRequest(source);
  const finder = matched(await searchSubtitleCat(source.query, source.language, 20, request));
  const client = new fusion.SubtitleCat({ request: { get: request }, extractAvNumber: fusion.getAvNumber });
  const results = await client.fetchSubtitle(source.query, source.language);
  assert.deepEqual(titles(finder).filter((title) => !titles(results).includes(title)), ["JAC-089 Sixth"]);
});

test("实际来源调度保留迅雷原文件名，并显式记录 SubtitleCat 的查询扩展差异", async () => {
  const catalogIdentity = extractAvIdentity(source.query);
  const intent = buildSearchIntent({ query: source.query, queryVariants: [source.query], videoFileName: source.fileName, hasLocalVideo: true, catalogIdentity });
  const finderRequest = createFixtureRequest(source);
  for (const key of ["thunder", "subtitlecat"]) {
    const [selected] = buildSelectedSearchSources({ source: key, queryVariants: intent.generalVariants, thunderQueryVariants: intent.thunderVariants, catalogVariants: intent.catalogVariants, catalogIdentity, language: source.language, request: finderRequest.request });
    await selected.search(20);
  }
  const finderQueries = finderRequest.calls.map((url) => {
    const target = new URL(url);
    return target.searchParams.get("name") || target.searchParams.get("search");
  });
  assert.deepEqual(finderQueries, [source.fileName, "JAC-089", "JAC 089", "JAC089"]);

  const fusionRequest = createFixtureRequest(source);
  await new fusion.Thunder({ request: { get: fusionRequest.request }, extractAvNumber: fusion.getAvNumber }).fetchSubtitle(source.fileName);
  await new fusion.SubtitleCat({ request: { get: fusionRequest.request }, extractAvNumber: fusion.getAvNumber }).fetchSubtitle(source.query, source.language);
  const fusionQueries = fusionRequest.calls.map((url) => new URL(url)).filter((url) => url.search).map((url) => url.searchParams.get("name") || url.searchParams.get("search"));
  assert.deepEqual(fusionQueries, [source.fileName, "JAC-089"]);
});

test("迅雷下载失败只影响 Fusion 的下载成功集，不伪装成解析差异", async () => {
  const { request } = createFixtureRequest(source, { failedDownload: source.thunder.data[0].url });
  const finder = await searchThunder(source.fileName, 20, request);
  const client = new fusion.Thunder({ request: { get: request }, extractAvNumber: fusion.getAvNumber });
  const results = await client.fetchSubtitle(source.fileName);
  assert.equal(finder.length, 3);
  assert.equal(results.length, 2);
  assert.deepEqual(titles(finder).filter((title) => !titles(results).includes(title)), ["JAC-089.zh.srt"]);
});

test("SubtitleCat 缺目标语言下载链接时，仅 Fusion 在搜索阶段淘汰", async () => {
  const { request } = createFixtureRequest(source, { missingLanguage: true });
  const finder = matched(await searchSubtitleCat(source.query, source.language, 5, request));
  const client = new fusion.SubtitleCat({ request: { get: request }, extractAvNumber: fusion.getAvNumber });
  assert.equal(finder.length, 4);
  assert.deepEqual(await client.fetchSubtitle(source.query, source.language), []);
});

test("SubtitleCat 单条下载抛错会使 Fusion 整源失败，Finder 搜索候选仍可见", async () => {
  const { request } = createFixtureRequest(source, { failedDownload: "https://subtitlecat.com/download/a.html.srt" });
  const finder = matched(await searchSubtitleCat(source.query, source.language, 5, request));
  const client = new fusion.SubtitleCat({ request: { get: request }, extractAvNumber: fusion.getAvNumber });
  assert.equal(finder.length, 4);
  await assert.rejects(client.fetchSubtitle(source.query, source.language), /fixture download failed/);
});

test("真实解析候选进入 Finder 合并后，相邻番号不能因高分被接受", async () => {
  const { request } = createFixtureRequest(source);
  const results = await searchThunder(source.fileName, 20, request);
  const merged = mergeSearchResultBuckets([results], 20, { queryVariants: [source.query], catalogIdentity: extractAvIdentity(source.query) });
  assert.equal(merged.length, 2);
  assert.deepEqual(titles(merged), titles(matched(results)));
});
