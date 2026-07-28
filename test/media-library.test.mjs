import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeMediaFile,
  compareMediaEntries,
  findExistingSubtitles,
} from "../public/media-library.js";

/*
 * ================================================================================
 * 步骤1：验证媒体文件名解析
 * ================================================================================
 * 目标：
 * 1) 覆盖电影年份、标准季集号和季目录补全
 * 2) 确保发布参数不会进入字幕检索词
 */
console.info("[MediaLibraryTest] 开始验证媒体文件名解析...");

// 1.1 解析电影名和年份
test("解析电影年份并移除发布参数", () => {
  const media = analyzeMediaFile("Dune.2021.2160p.BluRay.x265.mkv", { parentNames: ["Dune (2021)", "Movies"] });
  assert.equal(media.mediaType, "movie");
  assert.equal(media.title, "Dune");
  assert.equal(media.year, "2021");
  assert.equal(media.query, "Dune 2021");
});

// 1.2 解析标准季集号和多集文件
test("解析标准季集号和连续集", () => {
  const media = analyzeMediaFile("Daria.S01E02-E03.1080p.WEB-DL.mkv", { parentNames: ["Season 1", "Daria (1997)"] });
  assert.equal(media.title, "Daria");
  assert.equal(media.season, 1);
  assert.equal(media.episode, 2);
  assert.equal(media.episodeEnd, 3);
  assert.equal(media.query, "Daria S01E02-E03");
});

// 1.3 从季目录补全只有集号的文件
test("从季目录补全季号和作品名", () => {
  const media = analyzeMediaFile("03 - College Bored.mkv", { parentNames: ["Season 1", "Daria (1997)"] });
  assert.equal(media.title, "Daria");
  assert.equal(media.season, 1);
  assert.equal(media.episode, 3);
  assert.equal(media.query, "Daria S01E03");
});

// 1.4 缺少作品目录时不重复季集号
test("只有季集号时不生成重复搜索词", () => {
  const media = analyzeMediaFile("S01E01.mkv", { parentNames: ["Season 1"] });
  assert.equal(media.title, "");
  assert.equal(media.query, "S01E01");
});

/*
 * ================================================================================
 * 步骤2：验证已有字幕判断和排序
 * ================================================================================
 * 目标：
 * 1) 只匹配同一电影或同一集字幕
 * 2) 缺字幕优先，同系列按集号排列
 */
console.info("[MediaLibraryTest] 开始验证已有字幕判断和排序...");

// 2.1 排除同一季的其他集
test("已有字幕只匹配同一集", () => {
  const subtitles = findExistingSubtitles(
    "Daria.S01E02.1080p.mkv",
    ["Daria.S01E01.zh-CN.srt", "Daria.S01E02.zh-CN.srt", "Daria.S01E02.en.ass"]
  );
  assert.deepEqual(subtitles, ["Daria.S01E02.en.ass", "Daria.S01E02.zh-CN.srt"]);
});

// 2.2 只有季集号时仍能识别同目录字幕
test("无作品名时按季集号匹配字幕", () => {
  const subtitles = findExistingSubtitles(
    "S01E02.1080p.mkv",
    ["S01E01.zh.srt", "S01E02.zh.srt"],
    { parentNames: ["Season 1"] }
  );
  assert.deepEqual(subtitles, ["S01E02.zh.srt"]);
});

// 2.3 排除同名电影的其他年份
test("已有字幕核对电影年份", () => {
  const subtitles = findExistingSubtitles(
    "Dune.2021.2160p.mkv",
    ["Dune.2020.zh-CN.srt", "Dune.2021.zh-CN.srt"]
  );
  assert.deepEqual(subtitles, ["Dune.2021.zh-CN.srt"]);
});

// 2.4 缺字幕优先并保持集号顺序
test("扫描结果按缺失状态和集号排序", () => {
  const entries = [
    { title: "Daria", season: 1, episode: 3, hasSubtitle: false, path: "03.mkv" },
    { title: "Daria", season: 1, episode: 1, hasSubtitle: true, path: "01.mkv" },
    { title: "Daria", season: 1, episode: 2, hasSubtitle: false, path: "02.mkv" },
  ];
  entries.sort(compareMediaEntries);
  assert.deepEqual(entries.map((item) => item.episode), [2, 3, 1]);
});

console.info("[MediaLibraryTest] 媒体文件名、字幕判断和排序测试已注册完成");
