import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { searchSubtitleCat, searchThunder } from "../server.mjs";
import { createFixtureRequest } from "./helpers/subtitle-source.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/subtitle-source.json", import.meta.url), "utf8"));

test("迅雷搜索保留真实元数据，搜索阶段不下载内容", async () => {
  const { request, calls } = createFixtureRequest(fixture);
  const results = await searchThunder(fixture.fileName, 3, request);
  assert.equal(results.length, 3);
  assert.equal(results[0].durationMs, 7200000);
  assert.equal(results[0].downloadUrl, fixture.thunder.data[0].url);
  assert.equal(new URL(calls[0]).searchParams.get("name"), fixture.fileName);
  assert.equal(calls.length, 1);
});

test("迅雷业务错误不能显示为成功或无结果", async () => {
  const failed = structuredClone(fixture);
  failed.thunder.code = 1;
  failed.thunder.result = "error";
  const { request } = createFixtureRequest(failed);
  await assert.rejects(searchThunder(fixture.fileName, 3, request), /Thunder API error/);
});

test("SubtitleCat 解析真实搜索页并在调用方指定的位置截断", async () => {
  const { request, calls } = createFixtureRequest(fixture);
  const results = await searchSubtitleCat(fixture.query, fixture.language, 5, request);
  assert.equal(results.length, 5);
  assert.equal(results[0].title, fixture.subtitlecat[0].title);
  assert.equal(results[0].detailUrl, "https://subtitlecat.com/sub/a.html");
  assert.equal(Number(results[0].downloads), 100);
  assert.equal(results[0].score, 1);
  assert.equal(calls.length, 1);
});
