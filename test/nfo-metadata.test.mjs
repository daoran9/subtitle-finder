import assert from "node:assert/strict";
import test from "node:test";
import { parseNfoMetadata } from "../lib/nfo-metadata.mjs";
import { analyzeMediaFile } from "../public/media-library.js";
import { buildQueryVariants } from "../server.mjs";

const logger = {
  info: (...args) => console.info("[NfoMetadataTest]", ...args),
};

/*
 * ================================================================================
 * 步骤1：验证电影 NFO 解析
 * ================================================================================
 * 目标：
 * 1) 提取中英文标题、年份、IMDb 和 TMDB 编号
 * 2) 让 NFO 标题覆盖发布组文件名生成搜索词
 */
logger.info("开始验证电影 NFO 解析...");

// 1.1 解析 Kodi 常见 movie.nfo
test("电影 NFO 提取标题年份和外部编号", () => {
  const metadata = parseNfoMetadata(`
    <movie>
      <title>沙丘</title>
      <originaltitle>Dune</originaltitle>
      <year>2021</year>
      <uniqueid type="imdb" default="true">tt1160419</uniqueid>
      <uniqueid type="tmdb">438631</uniqueid>
    </movie>
  `);
  assert.equal(metadata.title, "沙丘");
  assert.equal(metadata.originalTitle, "Dune");
  assert.equal(metadata.year, "2021");
  assert.equal(metadata.imdbId, "tt1160419");
  assert.equal(metadata.tmdbId, "438631");
});

// 1.2 用 NFO 生成主查询和英文别名
test("电影文件使用 NFO 中英文名生成搜索词", () => {
  const media = analyzeMediaFile("Movie.1080p.WEB-DL.mkv", {
    nfoMetadata: parseNfoMetadata(`
      <movie><title>沙丘</title><originaltitle>Dune</originaltitle><year>2021</year></movie>
    `),
  });
  assert.equal(media.query, "沙丘 2021");
  assert.ok(media.searchAliases.includes("Dune 2021"));
  assert.equal(media.nfoMetadata.originalTitle, "Dune");
});

logger.info("验证电影 NFO 解析完成");

/*
 * ================================================================================
 * 步骤2：验证剧集 NFO 和查询变体
 * ================================================================================
 * 目标：
 * 1) 单集 NFO 补齐系列名和季集号
 * 2) NFO 英文别名进入原有全部字幕源检索策略
 */
logger.info("开始验证剧集 NFO 和查询变体...");

// 2.1 单集元数据生成系列搜索词
test("单集 NFO 生成系列名和季集搜索词", () => {
  const metadata = parseNfoMetadata(`
    <episodedetails>
      <title>Esteemsters</title>
      <showtitle>拽妹黛薇儿</showtitle>
      <season>1</season>
      <episode>1</episode>
    </episodedetails>
  `);
  const media = analyzeMediaFile("Episode.01.mkv", { nfoMetadata: metadata });
  assert.equal(media.title, "拽妹黛薇儿");
  assert.equal(media.query, "拽妹黛薇儿 S01E01");
  assert.ok(media.searchAliases.includes("Esteemsters S01E01"));
});

// 2.2 NFO 别名与固定别名共同参与查询
test("查询变体保留 NFO 别名和原有固定别名", () => {
  const variants = buildQueryVariants("拽妹黛薇儿 S01E01", ["Daria S01E01"]);
  assert.ok(variants.includes("Daria S01E01"));
  assert.ok(variants.includes("拽妹黛薇儿 S01E01"));
});

logger.info("验证剧集 NFO 和查询变体完成");
