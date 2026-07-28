import { XMLParser } from "fast-xml-parser";

const logger = {
  info: (...args) => console.info("[SubtitleFinderNfo]", ...args),
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

/*
 * ================================================================================
 * 步骤1：解析 NFO 元数据
 * ================================================================================
 * 目标：
 * 1) 用 XML 解析器读取电影、剧集和单集 NFO
 * 2) 提取检索需要的片名、年份、季集号和外部编号
 */
export function parseNfoMetadata(xmlText) {
  logger.info("开始解析 NFO 元数据...");

  // 1.1 校验并解析 XML 文本
  const source = String(xmlText || "").replace(/^\uFEFF/, "").trim();
  if (!source || !source.startsWith("<")) {
    logger.info("解析 NFO 元数据完成: empty");
    return null;
  }
  let document;
  try {
    document = parser.parse(source);
  } catch (error) {
    logger.info("解析 NFO 元数据完成: invalid xml", error.message);
    return null;
  }

  // 1.2 选择 Kodi 常见根节点
  const rootEntry = ["movie", "tvshow", "episodedetails"]
    .map((key) => [key, document?.[key]])
    .find(([, value]) => value && typeof value === "object");
  if (!rootEntry) {
    logger.info("解析 NFO 元数据完成: unsupported root");
    return null;
  }
  const [mediaType, root] = rootEntry;

  // 1.3 提取标题和季集字段
  const title = readScalar(root.title);
  const originalTitle = readScalar(root.originaltitle || root.original_title);
  const showTitle = readScalar(root.showtitle || root.show_title);
  const sortTitle = readScalar(root.sorttitle || root.sort_title);
  const year = readYear(root.year || root.premiered || root.aired || root.dateadded);
  const season = readPositiveInteger(root.season);
  const episode = readPositiveInteger(root.episode);

  // 1.4 提取 IMDb、TMDB 和其他别名
  const uniqueIds = readUniqueIds(root.uniqueid);
  const imdbId = normalizeImdbId(readScalar(root.imdbid || root.imdb_id || root.id) || uniqueIds.imdb);
  const tmdbId = normalizeNumericId(readScalar(root.tmdbid || root.tmdb_id) || uniqueIds.tmdb);
  const aliases = readAliases(root, [title, originalTitle, showTitle, sortTitle]);
  const metadata = compactObject({
    mediaType,
    title,
    originalTitle,
    showTitle,
    sortTitle,
    year,
    season,
    episode,
    imdbId,
    tmdbId,
    aliases,
  });

  const useful = Boolean(title || originalTitle || showTitle || imdbId || tmdbId);
  logger.info("解析 NFO 元数据完成", useful ? mediaType : "empty");
  return useful ? metadata : null;
}

function readUniqueIds(value) {
  // 1.5 兼容单个和多个 uniqueid 节点
  const output = {};
  for (const item of toArray(value)) {
    if (item == null) continue;
    if (typeof item !== "object") continue;
    const type = String(item["@_type"] || "").trim().toLowerCase();
    const id = readScalar(item["#text"] ?? item);
    if (type && id && !output[type]) output[type] = id;
  }
  return output;
}

function readAliases(root, primaryValues) {
  // 1.6 合并常见替代标题节点并去重
  const values = [
    ...primaryValues,
    ...toArray(root.alternativetitle || root.alternative_title),
    ...toArray(root.alias),
  ].map(readScalar).filter(Boolean);
  const seen = new Set();
  return values.filter((value) => {
    const key = value.normalize("NFKC").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readScalar(value) {
  // 1.7 将 XML 节点转换为受限长度字符串
  if (Array.isArray(value)) return readScalar(value[0]);
  if (value && typeof value === "object") return readScalar(value["#text"]);
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function readYear(value) {
  // 1.8 从年份或日期字段读取四位年份
  const match = readScalar(value).match(/(?:19|20)\d{2}/);
  return match ? match[0] : "";
}

function readPositiveInteger(value) {
  // 1.9 季集号只接受正整数
  const number = Number.parseInt(readScalar(value), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeImdbId(value) {
  // 1.10 统一 IMDb 编号格式
  const match = readScalar(value).match(/tt\d{5,12}/i);
  return match ? match[0].toLowerCase() : "";
}

function normalizeNumericId(value) {
  // 1.11 TMDB 编号只保留数字
  const match = readScalar(value).match(/\d{1,12}/);
  return match ? match[0] : "";
}

function toArray(value) {
  // 1.12 统一 XML 单值和数组结构
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function compactObject(value) {
  // 1.13 删除空字段，缩小扫描结果和持久化记录
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (Array.isArray(item)) return item.length > 0;
    return item !== "" && item !== null && item !== undefined;
  }));
}
