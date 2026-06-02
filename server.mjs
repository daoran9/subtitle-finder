import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 8765);
const REQUEST_TIMEOUT_MS = 16000;
const RESULT_CACHE = new Map();
const YIFY_BASE_URL = "https://yifysubtitles.ch";
const SUBF2M_BASE_URL = "https://subf2m.co";
const MOVIE_SUBTITLES_BASE_URL = "https://www.moviesubtitles.org";
const MOVIE_SUBTITLES_SEARCH_URL = "https://www.moviesubtitles.org/search.php";
const TV_SUBTITLES_BASE_URL = "https://www.tvsubtitles.net";
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];
let runtimePort = DEFAULT_PORT;

const logger = {
  info: (...args) => console.info("[SubtitleFinder]", ...args),
  warn: (...args) => console.warn("[SubtitleFinder]", ...args),
  error: (...args) => console.error("[SubtitleFinder]", ...args),
};

const browserHeaders = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

const yifyLanguageAliases = {
  "zh-CN": ["Chinese", "Chinese (Simplified)", "Chinese Bilingual", "Chinese BG code"],
  "zh-TW": ["Chinese", "Chinese (Traditional)", "Chinese Bilingual", "Big 5 code", "Chinese BG code"],
  en: ["English"],
  ja: ["Japanese"],
};

const subf2mLanguagePaths = {
  en: "english",
  ja: "japanese",
};

const movieSubtitlesLanguageCodes = {
  en: "en",
};

const tvSubtitlesLanguageCodes = {
  "zh-CN": "cn",
  "zh-TW": "cn",
  en: "en",
  ja: "jp",
};

const TITLE_ALIAS_GROUPS = [
  ["Daria", "拽妹黛薇儿", "拽妹黛薇兒", "拽妹黛薇尔"],
];
const MAX_QUERY_VARIANTS = 8;
const MAX_TV_SEASON_PAGES = 12;

/*
 * ================================================================================
 * 步骤1：启动本地服务
 * ================================================================================
 * 目标：
 * 1) 提供静态前端页面
 * 2) 提供字幕搜索、预览、下载接口
 */
export async function startServer(options = {}) {
  logger.info("开始启动本地字幕工具服务...");

  // 1.1 读取启动参数
  const host = options.host || HOST;
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : DEFAULT_PORT;

  // 1.2 创建 HTTP 服务
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      logger.error("请求处理失败", error);
      sendJson(res, 500, { error: "服务内部错误", detail: String(error?.message || error) });
    }
  });

  // 1.3 监听本地端口
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // 1.4 返回真实监听地址
  const address = server.address();
  runtimePort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${runtimePort}`;
  logger.info(`服务启动完成: ${url}`);
  return { server, host, port: runtimePort, url };
}

async function routeRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${runtimePort}`}`);

  /*
   * ================================================================================
   * 步骤2：分发 API 请求
   * ================================================================================
   * 目标：
   * 1) /api/search 执行多源搜索
   * 2) /api/preview 拉取字幕文本
   * 3) /api/download 下载原始字幕文件
   */
  logger.info("开始分发请求...", req.method, url.pathname);

  // 2.1 健康检查
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, port: runtimePort });
    logger.info("请求分发完成: health");
    return;
  }

  // 2.2 搜索字幕
  if (url.pathname === "/api/search") {
    await handleSearch(url, res);
    logger.info("请求分发完成: search");
    return;
  }

  // 2.3 预览字幕
  if (url.pathname === "/api/preview") {
    await handlePreview(url, res);
    logger.info("请求分发完成: preview");
    return;
  }

  // 2.4 下载字幕
  if (url.pathname === "/api/download") {
    await handleDownload(url, res);
    logger.info("请求分发完成: download");
    return;
  }

  // 2.5 返回静态文件
  await serveStatic(url, res);
  logger.info("请求分发完成: static");
}

async function handleSearch(url, res) {
  /*
   * ================================================================================
   * 步骤3：搜索字幕
   * ================================================================================
   * 目标：
   * 1) 读取关键词、字幕源、语言参数
   * 2) 并发查询多个免费字幕源
   * 3) 统一结果结构后返回前端
   */
  logger.info("开始搜索字幕...");

  // 3.1 读取搜索条件
  const query = (url.searchParams.get("q") || "").trim();
  const source = (url.searchParams.get("source") || "all").trim();
  const language = (url.searchParams.get("lang") || "zh-CN").trim();
  const limit = clamp(Number(url.searchParams.get("limit") || 40), 1, 100);
  const requestedEpisode = parseEpisodeQuery(query);

  if (!query) {
    sendJson(res, 400, { error: "请输入搜索字段或文件名" });
    logger.info("搜索字幕完成: 缺少关键词");
    return;
  }

  // 3.2 按选择组装字幕源
  const queryVariants = buildQueryVariants(query);
  const selectedSources = [];
  if (source === "all" || source === "thunder") {
    selectedSources.push((sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchThunder(variant, sourceLimit)));
  }
  if (source === "all" || source === "subtitlecat") {
    selectedSources.push((sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchSubtitleCat(variant, language, sourceLimit)));
  }
  if (source === "all" || source === "yify") {
    selectedSources.push((sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchYify(variant, language, sourceLimit)));
  }
  if (source === "all" || source === "subf2m") {
    selectedSources.push((sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchSubf2m(variant, language, sourceLimit)));
  }
  if (source === "all" || source === "moviesubtitles") {
    selectedSources.push((sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchMovieSubtitles(variant, language, sourceLimit)));
  }
  if (source === "all" || source === "tvsubtitles") {
    selectedSources.push((sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchTvSubtitles(variant, language, sourceLimit)));
  }

  // 3.3 并发查询字幕源
  const perSourceLimit = requestedEpisode.season && requestedEpisode.episode ? 100 : limit;
  const tasks = selectedSources.map((searchSource) => searchSource(perSourceLimit));

  const settled = await Promise.allSettled(tasks);
  const errors = settled
    .filter((item) => item.status === "rejected")
    .map((item) => String(item.reason?.message || item.reason));
  const resultBuckets = settled
    .filter((item) => item.status === "fulfilled")
    .map((item) => filterResultsByEpisode(item.value.filter(Boolean), requestedEpisode));
  const publicResults = mergeSearchResultBuckets(resultBuckets, limit, { queryVariants, requestedEpisode, balanced: source === "all" })
    .map(cacheResult);

  // 3.4 返回结果
  sendJson(res, 200, { query, source, language, variants: queryVariants, count: publicResults.length, results: publicResults, errors });
  logger.info(`搜索字幕完成: ${publicResults.length} 条`);
}

async function searchWithQueryVariants(queryVariants, limit, searchVariant) {
  /*
   * ================================================================================
   * 步骤4：按查询变体搜索
   * ================================================================================
   * 目标：
   * 1) 同一个字幕源尝试原词、英文名、中文名等变体
   * 2) 合并同源重复结果
   */
  logger.info("开始按查询变体搜索...");

  // 4.1 逐个变体查询
  const results = [];
  for (const variant of queryVariants) {
    const variantResults = await searchVariant(variant);
    results.push(...variantResults);
  }

  // 4.2 去重并裁剪
  const deduped = dedupeSearchResults(results).slice(0, limit);
  logger.info(`按查询变体搜索完成: ${deduped.length} 条`);
  return deduped;
}

function buildQueryVariants(query) {
  /*
   * ================================================================================
   * 步骤5：生成查询变体
   * ================================================================================
   * 目标：
   * 1) 保留用户原始输入
   * 2) 拆出中英文片名
   * 3) 用本地别名表扩展中英文标题
   */
  logger.info("开始生成查询变体...");

  // 5.1 初始化变体集合
  const normalized = String(query || "").replace(/\s+/g, " ").trim();
  const variants = [];
  const addVariant = (value) => {
    const item = String(value || "").replace(/\s+/g, " ").trim();
    if (item && !variants.some((variant) => variant.toLowerCase() === item.toLowerCase())) {
      variants.push(item);
    }
  };
  addVariant(normalized);

  // 5.2 拆出中英文关键词
  const episode = parseEpisodeQuery(normalized);
  for (const item of extractLatinTitleCandidates(normalized)) addVariant(appendEpisodeToken(item, episode));
  for (const item of extractCjkTitleCandidates(normalized)) addVariant(appendEpisodeToken(item, episode));

  // 5.3 扩展本地别名
  const lower = normalized.toLowerCase();
  for (const group of TITLE_ALIAS_GROUPS) {
    if (!group.some((alias) => lower.includes(alias.toLowerCase()))) continue;
    for (const alias of group) {
      addVariant(episode.token ? appendEpisodeToken(alias, episode) : alias);
    }
  }

  logger.info(`生成查询变体完成: ${variants.join(" | ")}`);
  return variants.slice(0, MAX_QUERY_VARIANTS);
}

function extractLatinTitleCandidates(query) {
  // 5.4 提取英文标题候选
  const withoutEpisode = String(query || "")
    .replace(/\bs0*\d{1,2}\s*e0*\d{1,3}\b/gi, " ")
    .replace(/\b0*\d{1,2}\s*x\s*0*\d{1,3}\b/gi, " ");
  return [...withoutEpisode.matchAll(/[A-Za-z][A-Za-z0-9'’:&.!? -]{1,}/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 1);
}

function extractCjkTitleCandidates(query) {
  // 5.5 提取中文标题候选
  return [...String(query || "").matchAll(/[\p{Script=Han}][\p{Script=Han}·・\s]{1,}/gu)]
    .map((match) => match[0].replace(/\s+/g, "").trim())
    .filter((item) => item.length > 1);
}

function appendEpisodeToken(title, episode) {
  // 5.6 给别名补回季集信息
  if (!episode?.token || String(title || "").toLowerCase().includes(episode.token.toLowerCase())) {
    return title;
  }
  return `${title} ${episode.token}`;
}

function dedupeSearchResults(results) {
  // 5.7 合并重复搜索结果
  const unique = new Map();
  for (const result of results) {
    const key = getSearchResultKey(result);
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()];
}

function mergeSearchResultBuckets(buckets, limit, options = {}) {
  /*
   * ================================================================================
   * 步骤6：合并多源结果
   * ================================================================================
   * 目标：
   * 1) 过滤明显不匹配片名的结果
   * 2) 同一片名或剧集按季集顺序排在一起
   * 3) 全部字幕源模式保留每个来源的展示数量
   */
  logger.info("开始合并多源结果...");

  // 6.1 去重并过滤明显无关结果
  const needles = buildTitleNeedles(options.queryVariants || []);
  const seen = new Set();
  const sourceCap = options.balanced ? Math.max(12, Math.ceil(limit / 3)) : limit;
  const candidates = [];
  for (const bucket of buckets) {
    let sourceCount = 0;
    for (const result of bucket) {
      if (!searchResultMatchesTitle(result, needles)) continue;
      const key = getSearchResultKey(result);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(result);
      sourceCount += 1;
      if (sourceCount >= sourceCap) break;
    }
  }

  // 6.2 按片名、季集、来源稳定排序
  const merged = candidates
    .sort((left, right) => compareSearchResults(left, right, needles, options.requestedEpisode))
    .slice(0, limit);

  logger.info(`合并多源结果完成: ${merged.length} 条`);
  return merged;
}

function getSearchResultKey(result) {
  // 6.3 生成搜索结果去重键
  return [
    result.source,
    normalizeComparableText(result.title || result.fileName || ""),
  ].join("|");
}

function buildTitleNeedles(queryVariants) {
  // 6.4 生成片名匹配关键词
  const needles = [];
  for (const variant of queryVariants) {
    const value = stripEpisodeTokens(variant).trim();
    if (!value) continue;
    const normalized = normalizeComparableText(value);
    if (normalized && !needles.some((item) => item.normalized === normalized)) {
      needles.push({ raw: value, normalized });
    }
  }
  return needles;
}

function stripEpisodeTokens(value) {
  // 6.5 移除查询中的季集标记
  return String(value || "")
    .replace(/\bs0*\d{1,2}\s*e0*\d{1,3}\b/gi, " ")
    .replace(/\b0*\d{1,2}\s*x\s*0*\d{1,3}\b/gi, " ")
    .replace(/\s+/g, " ");
}

function searchResultMatchesTitle(result, needles) {
  // 6.6 判断结果是否匹配片名关键词
  if (!needles.length) return true;
  const text = normalizeComparableText(getSearchResultText(result));
  return needles.some((needle) => text.includes(needle.normalized));
}

function compareSearchResults(left, right, needles, requestedEpisode) {
  // 6.7 比较搜索结果展示顺序
  const leftScore = scoreSearchResult(left, needles, requestedEpisode);
  const rightScore = scoreSearchResult(right, needles, requestedEpisode);
  if (leftScore !== rightScore) return rightScore - leftScore;

  const leftGroup = getSearchResultGroupKey(left, needles);
  const rightGroup = getSearchResultGroupKey(right, needles);
  if (leftGroup !== rightGroup) return leftGroup.localeCompare(rightGroup);

  const leftEpisode = getSearchResultEpisodeKey(left);
  const rightEpisode = getSearchResultEpisodeKey(right);
  if (leftEpisode !== rightEpisode) return leftEpisode - rightEpisode;

  const leftSource = getSourceOrder(left.source);
  const rightSource = getSourceOrder(right.source);
  if (leftSource !== rightSource) return leftSource - rightSource;

  return String(left.title || "").localeCompare(String(right.title || ""));
}

function scoreSearchResult(result, needles, requestedEpisode) {
  // 6.8 给搜索结果计算相关度
  const title = normalizeComparableText(result.title || "");
  const text = normalizeComparableText(getSearchResultText(result));
  let score = 0;
  let titleScore = 0;

  for (const [index, needle] of needles.entries()) {
    if (title.includes(needle.normalized)) titleScore = Math.max(titleScore, 80 - index);
    else if (text.includes(needle.normalized)) titleScore = Math.max(titleScore, 40 - index);
  }
  score += titleScore;

  const episodes = extractEpisodeTokens(getSearchResultText(result));
  if (requestedEpisode?.season && requestedEpisode?.episode) {
    if (episodes.some((item) => item.season === requestedEpisode.season && item.episode === requestedEpisode.episode)) {
      score += 120;
    }
  } else if (episodes.length) {
    score += 12;
  }

  return score;
}

function getSearchResultGroupKey(result, needles) {
  // 6.9 生成片名分组键
  const text = normalizeComparableText(getSearchResultText(result));
  const matched = needles.find((needle) => text.includes(needle.normalized));
  if (matched) return matched.normalized;
  return normalizeComparableText(stripEpisodeTokens(result.title || result.fileName || ""));
}

function getSearchResultEpisodeKey(result) {
  // 6.10 生成季集排序键
  const episodes = extractEpisodeTokens(getSearchResultText(result));
  if (!episodes.length) return 999999;
  return episodes[0].season * 1000 + episodes[0].episode;
}

function getSourceOrder(source) {
  // 6.11 固定字幕源排序
  const order = ["thunder", "subtitlecat", "tvsubtitles", "subf2m", "yify", "moviesubtitles"];
  const index = order.indexOf(source);
  return index >= 0 ? index : order.length;
}

function getSearchResultText(result) {
  // 6.12 拼接搜索结果可比较文本
  return [result.title, result.fileName, result.extra].filter(Boolean).join(" ");
}

function normalizeComparableText(value) {
  // 6.13 统一比较文本格式
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function filterResultsByEpisode(results, episode) {
  /*
   * ================================================================================
   * 步骤7：按季集过滤结果
   * ================================================================================
   * 目标：
   * 1) 用户输入 1x01 / S01E01 时只保留对应剧集
   * 2) 避免站点把整剧热门结果混入单集搜索
   */
  logger.info("开始按季集过滤结果...");

  // 7.1 非单集搜索直接返回原结果
  if (!episode?.season || !episode?.episode) {
    logger.info("按季集过滤结果完成: 未指定单集");
    return results;
  }

  // 7.2 匹配结果标题、文件名和补充字段中的季集号
  const filtered = results.filter((result) => searchResultMatchesEpisode(result, episode));
  logger.info(`按季集过滤结果完成: ${filtered.length} 条`);
  return filtered;
}

function searchResultMatchesEpisode(result, episode) {
  // 7.3 判断搜索结果是否匹配指定季集
  const text = [result.title, result.fileName, result.extra].filter(Boolean).join(" ");
  return extractEpisodeTokens(text).some((item) => item.season === episode.season && item.episode === episode.episode);
}

function extractEpisodeTokens(text) {
  // 7.4 提取结果中的 S01E01 / 1x01 标记
  const normalized = String(text || "");
  const tokens = [];
  for (const match of normalized.matchAll(/\bs0*(\d{1,2})\s*e0*(\d{1,3})\b/gi)) {
    tokens.push({ season: Number(match[1]), episode: Number(match[2]) });
  }
  for (const match of normalized.matchAll(/\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b/gi)) {
    tokens.push({ season: Number(match[1]), episode: Number(match[2]) });
  }
  for (const match of normalized.matchAll(/\bseason\s*0*(\d{1,2})\D{0,12}e(?:p(?:isode)?)?\s*0*(\d{1,3})\b/gi)) {
    tokens.push({ season: Number(match[1]), episode: Number(match[2]) });
  }
  return tokens;
}

async function handlePreview(url, res) {
  /*
   * ================================================================================
   * 步骤4：预览字幕
   * ================================================================================
   * 目标：
   * 1) 根据搜索结果 ID 找到字幕下载地址
   * 2) 拉取原始字幕字节
   * 3) 自动尝试常见编码并返回文本
   */
  logger.info("开始预览字幕...");

  // 4.1 查找结果
  const id = (url.searchParams.get("id") || "").trim();
  const language = (url.searchParams.get("lang") || "zh-CN").trim();
  const result = RESULT_CACHE.get(id);
  if (!result) {
    sendJson(res, 404, { error: "结果已过期，请重新搜索" });
    logger.info("预览字幕完成: 未找到结果");
    return;
  }

  // 4.2 拉取并解码字幕
  const payload = await fetchSubtitleBytes(result, language);
  const decoded = decodeSubtitle(payload.buffer, payload.contentType);

  // 4.3 返回预览内容
  sendJson(res, 200, {
    id,
    title: result.title,
    source: result.source,
    fileName: payload.fileName,
    size: payload.buffer.length,
    encoding: decoded.encoding,
    text: decoded.text,
  });
  logger.info(`预览字幕完成: ${payload.fileName}`);
}

async function handleDownload(url, res) {
  /*
   * ================================================================================
   * 步骤5：下载字幕
   * ================================================================================
   * 目标：
   * 1) 根据结果 ID 拉取原始字幕文件
   * 2) 以附件形式返回给浏览器保存
   */
  logger.info("开始下载字幕...");

  // 5.1 查找结果
  const id = (url.searchParams.get("id") || "").trim();
  const language = (url.searchParams.get("lang") || "zh-CN").trim();
  const result = RESULT_CACHE.get(id);
  if (!result) {
    sendJson(res, 404, { error: "结果已过期，请重新搜索" });
    logger.info("下载字幕完成: 未找到结果");
    return;
  }

  // 5.2 返回文件字节
  const payload = await fetchSubtitleBytes(result, language);
  res.writeHead(200, {
    "content-type": payload.contentType || "application/octet-stream",
    "content-length": payload.buffer.length,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.fileName)}`,
    "cache-control": "no-store",
  });
  res.end(payload.buffer);
  logger.info(`下载字幕完成: ${payload.fileName}`);
}

async function searchThunder(query, limit) {
  /*
   * ================================================================================
   * 步骤6：查询迅雷字幕源
   * ================================================================================
   * 目标：
   * 1) 调用 api-shoulei-ssl.xunlei.com 字幕接口
   * 2) 把返回项转换为统一结构
   */
  logger.info("开始查询迅雷字幕源...");

  // 6.1 请求接口
  const apiUrl = `https://api-shoulei-ssl.xunlei.com/oracle/subtitle?name=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(apiUrl, { headers: browserHeaders });
  const json = await response.json();

  // 6.2 转换结果
  const list = Array.isArray(json?.data) ? json.data : [];
  const results = list.slice(0, limit).map((item) => ({
    source: "thunder",
    sourceLabel: "迅雷字幕",
    title: item.name || query,
    fileName: sanitizeFileName(item.name || `${query}.${item.ext || "srt"}`),
    ext: item.ext || "srt",
    language: Array.isArray(item.languages) ? item.languages.filter(Boolean).join(", ") : "",
    score: Number(item.score || item.fingerprintf_score || 0),
    downloads: "",
    size: "",
    duration: formatDuration(Number(item.duration || 0)),
    extra: item.extra_name || "",
    downloadUrl: item.url,
    detailUrl: item.url,
  }));

  logger.info(`查询迅雷字幕源完成: ${results.length} 条`);
  return results;
}

async function searchSubtitleCat(query, language, limit) {
  /*
   * ================================================================================
   * 步骤7：查询 SubtitleCat
   * ================================================================================
   * 目标：
   * 1) 抓取搜索结果页
   * 2) 解析字幕标题、详情页、下载数和语言数
   */
  logger.info("开始查询 SubtitleCat...");

  // 7.1 请求搜索页
  const searchUrl = `https://subtitlecat.com/index.php?search=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(searchUrl, { headers: browserHeaders });
  const html = await response.text();

  // 7.2 解析搜索结果
  const table = matchFirst(html, /<table[^>]*class=["'][^"']*sub-table[^"']*["'][\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
  if (!table) {
    logger.info("查询 SubtitleCat 完成: 0 条");
    return [];
  }

  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const results = rows.slice(0, limit).map((row) => parseSubtitleCatRow(row, language)).filter(Boolean);

  logger.info(`查询 SubtitleCat 完成: ${results.length} 条`);
  return results;
}

function parseSubtitleCatRow(row, language) {
  // 7.3 解析单行数据
  const linkMatch = row.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!linkMatch) return null;

  const href = htmlDecode(linkMatch[1]);
  const title = htmlDecode(stripTags(linkMatch[2])).trim();
  const text = htmlDecode(stripTags(row)).replace(/\s+/g, " ").trim();
  const downloads = matchFirst(text, /(\d+)\s+downloads/i) || "";
  const languages = matchFirst(text, /(\d+)\s+languages/i) || "";
  const size = matchFirst(row, /sub-table__metric-value["'][^>]*>([^<]+)</i) || "";
  const originLanguage = matchFirst(text, /translated from ([^)]+?)(?:\s|$)/i) || "";
  const comment = row.includes("fa-thumbs-up") ? 1 : row.includes("fa-thumbs-down") ? -1 : 0;

  return {
    source: "subtitlecat",
    sourceLabel: "SubtitleCat",
    title,
    fileName: sanitizeFileName(`${title}-${language}.srt`),
    ext: "srt",
    language,
    score: comment,
    downloads,
    size: size.trim(),
    duration: "",
    extra: originLanguage ? `translated from ${originLanguage}` : "",
    downloadUrl: "",
    detailUrl: new URL(href, "https://subtitlecat.com/").href,
  };
}

async function searchYify(query, language, limit) {
  /*
   * ================================================================================
   * 步骤8：查询 YIFY Subtitles
   * ================================================================================
   * 目标：
   * 1) 用站内联想接口把片名转为 IMDb ID
   * 2) 抓取影片字幕表并按目标语言过滤
   */
  logger.info("开始查询 YIFY Subtitles...");

  // 8.1 获取候选影片
  const movies = await searchYifyMovies(query);
  const languageAliases = yifyLanguageAliases[language] || [];
  if (!languageAliases.length || !movies.length) {
    logger.info("查询 YIFY Subtitles 完成: 0 条");
    return [];
  }

  // 8.2 抓取每个影片的字幕表
  const rows = [];
  for (const movie of movies.slice(0, 3)) {
    const movieUrl = new URL(`/movie-imdb/${movie.imdb}`, YIFY_BASE_URL).href;
    const response = await fetchWithTimeout(movieUrl, {
      headers: { ...browserHeaders, referer: YIFY_BASE_URL },
    });
    const html = await response.text();
    rows.push(...parseYifyRows(html, movie, languageAliases));
    if (rows.length >= limit) break;
  }

  // 8.3 返回统一结果
  const results = rows
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, limit);
  logger.info(`查询 YIFY Subtitles 完成: ${results.length} 条`);
  return results;
}

async function searchYifyMovies(query) {
  // 8.4 查询 YIFY 影片联想接口
  const imdbFromQuery = matchFirst(query, /(tt\d{5,12})/i);
  if (imdbFromQuery) return [{ movie: query, imdb: imdbFromQuery }];

  const searchUrl = new URL("/ajax/search/", YIFY_BASE_URL);
  searchUrl.searchParams.set("mov", query);
  const response = await fetchWithTimeout(searchUrl.href, {
    headers: { ...browserHeaders, accept: "application/json,text/plain,*/*" },
  });
  const json = await response.json();
  return Array.isArray(json)
    ? json
        .filter((item) => item?.imdb)
        .map((item) => ({ movie: String(item.movie || query), imdb: String(item.imdb) }))
    : [];
}

function parseYifyRows(html, movie, languageAliases) {
  // 8.5 解析 YIFY 字幕表格行
  const rows = [...html.matchAll(/<tr\b[^>]*data-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tr>/gi)];
  return rows
    .map((match) => parseYifyRow(match[2], movie, languageAliases))
    .filter(Boolean);
}

function parseYifyRow(row, movie, languageAliases) {
  // 8.6 解析 YIFY 单条字幕
  const languageName = htmlDecode(matchFirst(row, /<span[^>]*class=["'][^"']*sub-lang[^"']*["'][^>]*>([^<]+)</i)).trim();
  if (!languageAliases.some((item) => item.toLowerCase() === languageName.toLowerCase())) {
    return null;
  }

  const linkMatch = row.match(/<td>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!linkMatch) return null;

  const detailUrl = new URL(htmlDecode(linkMatch[1]), YIFY_BASE_URL).href;
  const release = htmlDecode(stripTags(linkMatch[2]))
    .trim()
    .replace(/^subtitle\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const uploader = htmlDecode(stripTags(matchFirst(row, /<td[^>]*class=["'][^"']*uploader-cell[^"']*["'][^>]*>([\s\S]*?)<\/td>/i))).trim();

  return {
    source: "yify",
    sourceLabel: "YIFY Subtitles",
    title: release || movie.movie,
    fileName: sanitizeFileName(`${release || movie.movie}.srt`),
    ext: "srt",
    language: languageName,
    score: Number(matchFirst(row, /<span[^>]*class=["']label[^"']*["'][^>]*>(-?\d+)<\/span>/i) || 0),
    downloads: "",
    size: "",
    duration: "",
    extra: uploader ? `uploader: ${uploader}` : movie.movie,
    downloadUrl: "",
    detailUrl,
  };
}

async function searchSubf2m(query, language, limit) {
  /*
   * ================================================================================
   * 步骤9：查询 Subf2m
   * ================================================================================
   * 目标：
   * 1) 先按片名找影片页
   * 2) 再进入指定语言页解析字幕项
   */
  logger.info("开始查询 Subf2m...");

  // 9.1 校验语言支持
  const languagePath = subf2mLanguagePaths[language];
  if (!languagePath) {
    logger.info("查询 Subf2m 完成: 当前语言不支持");
    return [];
  }

  // 9.2 搜索影片页
  const searchUrl = new URL("/subtitles/searchbytitle", SUBF2M_BASE_URL);
  searchUrl.searchParams.set("query", query);
  searchUrl.searchParams.set("l", "");
  const response = await fetchWithTimeout(searchUrl.href, { headers: browserHeaders });
  const html = await response.text();
  const movies = parseSubf2mMovies(html).slice(0, 3);

  // 9.3 解析字幕项
  const results = [];
  for (const movie of movies) {
    const pageUrl = new URL(`${movie.path}/${languagePath}`, SUBF2M_BASE_URL).href;
    const pageResponse = await fetchWithTimeout(pageUrl, {
      headers: { ...browserHeaders, referer: searchUrl.href },
    });
    const pageHtml = await pageResponse.text();
    results.push(...parseSubf2mRows(pageHtml, movie, languagePath));
    if (results.length >= limit) break;
  }

  logger.info(`查询 Subf2m 完成: ${results.length} 条`);
  return results.slice(0, limit);
}

function parseSubf2mMovies(html) {
  // 9.4 解析 Subf2m 影片搜索结果
  const matches = [...html.matchAll(/<div[^>]*class=["']title["'][^>]*>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.map((match) => ({
    path: htmlDecode(match[1]),
    title: htmlDecode(stripTags(match[2])).replace(/\s+/g, " ").trim(),
  }));
}

function parseSubf2mRows(html, movie, languagePath) {
  // 9.5 解析 Subf2m 字幕列表
  const rows = [...html.matchAll(/<li[^>]*class=["'][^"']*item[^"']*["'][^>]*>([\s\S]*?<a\s+[^>]*class=["'][^"']*download icon-download[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>)[\s\S]*?<\/li>/gi)]
    .map((match) => ({ row: match[1], href: match[2] }));

  return rows.map(({ row, href }) => {
    const releaseLines = [...row.matchAll(/<ul[^>]*class=["'][^"']*scrolllist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi)]
      .flatMap((list) => [...list[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)])
      .map((item) => htmlDecode(stripTags(item[1])).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const release = releaseLines.join(" / ") || movie.title;
    const detailUrl = new URL(htmlDecode(href), SUBF2M_BASE_URL).href;

    return {
      source: "subf2m",
      sourceLabel: "Subf2m",
      title: release,
      fileName: sanitizeFileName(`${release}.srt`),
      ext: "srt",
      language: languagePath,
      score: "",
      downloads: "",
      size: "",
      duration: "",
      extra: movie.title,
      downloadUrl: "",
      detailUrl,
    };
  });
}

async function searchMovieSubtitles(query, language, limit) {
  /*
   * ================================================================================
   * 步骤10：查询 MovieSubtitles.org
   * ================================================================================
   * 目标：
   * 1) 搜索普通电影字幕
   * 2) 进入电影页解析指定语言字幕
   * 3) 返回可预览的 ZIP 字幕结果
   */
  logger.info("开始查询 MovieSubtitles.org...");

  // 10.1 校验语言支持
  const languageCode = movieSubtitlesLanguageCodes[language];
  if (!languageCode) {
    logger.info("查询 MovieSubtitles.org 完成: 当前语言不支持");
    return [];
  }

  // 10.2 请求电影搜索页
  const searchUrl = new URL(MOVIE_SUBTITLES_SEARCH_URL);
  searchUrl.searchParams.set("q", query);
  const response = await fetchWithTimeout(searchUrl.href, {
    headers: { ...browserHeaders, "accept-language": "en-US,en;q=0.9" },
    allowErrorStatus: true,
  });
  const html = await response.text();
  const movies = parseMovieSubtitlesMovies(html).slice(0, 3);

  // 10.3 进入电影页解析字幕条目
  const results = [];
  for (const movie of movies) {
    const pageResponse = await fetchWithTimeout(movie.detailUrl, {
      headers: { ...browserHeaders, referer: MOVIE_SUBTITLES_BASE_URL },
    });
    const pageHtml = await pageResponse.text();
    results.push(...parseMovieSubtitlesRows(pageHtml, movie, languageCode));
    if (results.length >= limit) break;
  }

  logger.info(`查询 MovieSubtitles.org 完成: ${results.length} 条`);
  return results.slice(0, limit);
}

function parseMovieSubtitlesMovies(html) {
  // 10.4 解析电影搜索结果
  const matches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']*movie-\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.map((match) => ({
    title: htmlDecode(stripTags(match[2])).replace(/\s+/g, " ").trim(),
    detailUrl: new URL(htmlDecode(match[1]), MOVIE_SUBTITLES_BASE_URL).href,
  })).filter((movie) => movie.title);
}

function parseMovieSubtitlesRows(html, movie, languageCode) {
  // 10.5 解析电影字幕列表
  const matches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']*subtitle-\d+\.html)["'][^>]*title=["']Download\s+([^"']+?)\s+subtitles["'][^>]*>/gi)];
  const unique = new Map();

  for (const match of matches) {
    const href = htmlDecode(match[1]);
    const languageName = htmlDecode(match[2]).trim();
    const detailUrl = new URL(href, MOVIE_SUBTITLES_BASE_URL).href;
    if (unique.has(detailUrl) || !movieSubtitlesLanguageMatches(languageName, languageCode)) {
      continue;
    }

    const index = match.index || 0;
    const snippet = html.slice(index, index + 1800);
    const title = htmlDecode(stripTags(matchFirst(snippet, /<b>([\s\S]*?)<\/b>/i)))
      .replace(/\s+/g, " ")
      .trim() || movie.title;
    const redScore = Number(matchFirst(snippet, /<span[^>]*color:\s*red[^>]*>(-?\d+)<\/span>/i) || 0);
    const greenScore = Number(matchFirst(snippet, /<span[^>]*color:\s*green[^>]*>(-?\d+)<\/span>/i) || 0);
    const downloads = matchFirst(snippet, /title=["']downloaded["'][\s\S]*?<td[^>]*>([^<]+)<\/td>/i).trim();
    const size = matchFirst(snippet, /title=["']size["'][\s\S]*?<td[^>]*>([^<]+)<\/td>/i).trim();
    if (/^0(?:\.0+)?\s*kb$/i.test(size)) {
      continue;
    }

    unique.set(detailUrl, {
      source: "moviesubtitles",
      sourceLabel: "MovieSubtitles",
      title,
      fileName: sanitizeFileName(`${title}.srt`),
      ext: "srt",
      language: languageName,
      score: greenScore - redScore,
      downloads,
      size,
      duration: "",
      extra: movie.title,
      downloadUrl: "",
      detailUrl,
    });
  }

  return [...unique.values()];
}

function movieSubtitlesLanguageMatches(languageName, languageCode) {
  // 10.6 判断电影源语言是否匹配
  const lower = String(languageName || "").toLowerCase();
  return languageCode === "en" ? lower === "english" : false;
}

async function searchTvSubtitles(query, language, limit) {
  /*
   * ================================================================================
   * 步骤11：查询 TVSubtitles.net
   * ================================================================================
   * 目标：
   * 1) 搜索普通剧集字幕
   * 2) 进入剧集季页解析每集字幕
   * 3) 返回可预览的 ZIP 字幕结果
   */
  logger.info("开始查询 TVSubtitles.net...");

  // 11.1 校验语言支持
  const languageCode = tvSubtitlesLanguageCodes[language];
  if (!languageCode) {
    logger.info("查询 TVSubtitles.net 完成: 当前语言不支持");
    return [];
  }

  // 11.2 请求剧集搜索页
  const response = await fetchWithTimeout(new URL("/search1.php", TV_SUBTITLES_BASE_URL).href, {
    method: "POST",
    headers: { ...browserHeaders, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ qs: query }).toString(),
  });
  const html = await response.text();
  const shows = parseTvSubtitlesShows(html).slice(0, 3);
  const episode = parseEpisodeQuery(query);

  // 11.3 进入季页解析字幕条目
  const results = [];
  for (const show of shows) {
    const firstPageUrl = episode.season ? buildTvSubtitlesSeasonUrl(show.detailUrl, episode.season) : show.detailUrl;
    const firstPageResponse = await fetchWithTimeout(firstPageUrl, {
      headers: { ...browserHeaders, referer: TV_SUBTITLES_BASE_URL },
    });
    const firstPageHtml = await firstPageResponse.text();
    const seasonUrls = episode.season
      ? [buildTvSubtitlesSeasonUrl(show.detailUrl, episode.season)]
      : collectTvSubtitlesSeasonUrls(firstPageHtml, firstPageResponse.url || firstPageUrl);
    for (const seasonUrl of seasonUrls.slice(0, MAX_TV_SEASON_PAGES)) {
      const pageHtml = seasonUrl === (firstPageResponse.url || firstPageUrl)
        ? firstPageHtml
        : await fetchTvSubtitlesSeasonHtml(seasonUrl);
      results.push(...parseTvSubtitlesRows(pageHtml, show, languageCode, episode));
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  logger.info(`查询 TVSubtitles.net 完成: ${results.length} 条`);
  return results.slice(0, limit);
}

function parseTvSubtitlesShows(html) {
  // 11.4 解析剧集搜索结果
  const matches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']*tvshow-\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  return matches.map((match) => ({
    title: htmlDecode(stripTags(match[2])).replace(/\s+/g, " ").trim(),
    detailUrl: new URL(htmlDecode(match[1]), TV_SUBTITLES_BASE_URL).href,
  })).filter((show) => show.title);
}

function buildTvSubtitlesSeasonUrl(showUrl, season) {
  // 11.5 根据搜索词中的季数构造季页
  return showUrl.replace(/tvshow-(\d+)(?:-\d+)?\.html/i, `tvshow-$1-${season}.html`);
}

function collectTvSubtitlesSeasonUrls(html, currentUrl) {
  // 11.6 收集剧集全部季页
  const seasons = new Map();
  const showId = matchFirst(currentUrl, /tvshow-(\d+)(?:-\d+)?\.html/i);
  const addUrl = (value) => {
    const resolved = new URL(htmlDecode(value), currentUrl).href;
    const resolvedShowId = matchFirst(resolved, /tvshow-(\d+)-\d+\.html/i);
    const season = parseTvSubtitlesSeasonNumber(resolved);
    if (showId && resolvedShowId === showId && season) {
      seasons.set(season, new URL(`/tvshow-${showId}-${season}.html`, TV_SUBTITLES_BASE_URL).href);
    }
  };

  addUrl(currentUrl);
  for (const match of html.matchAll(/href=["']([^"']*tvshow-\d+-\d+\.html)["']/gi)) {
    addUrl(match[1]);
  }

  return [...seasons.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((item) => item[1]);
}

function parseTvSubtitlesSeasonNumber(url) {
  // 11.7 解析 TVSubtitles 季页编号
  return Number(matchFirst(String(url || ""), /tvshow-\d+-(\d+)\.html/i) || 0);
}

function parseEpisodeQuery(query) {
  // 11.8 从 S01E02 或 1x02 形式提取季集
  const normalized = String(query || "");
  const sxe = normalized.match(/\bs0*(\d{1,2})\s*e0*(\d{1,3})\b/i);
  if (sxe) return { season: Number(sxe[1]), episode: Number(sxe[2]), token: sxe[0] };
  const nxm = normalized.match(/\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b/i);
  if (nxm) return { season: Number(nxm[1]), episode: Number(nxm[2]), token: nxm[0] };
  return { season: 0, episode: 0, token: "" };
}

async function fetchTvSubtitlesSeasonHtml(seasonUrl) {
  // 11.9 请求 TVSubtitles 季页
  const pageResponse = await fetchWithTimeout(seasonUrl, {
    headers: { ...browserHeaders, referer: TV_SUBTITLES_BASE_URL },
  });
  return pageResponse.text();
}

function parseTvSubtitlesRows(html, show, languageCode, episode = {}) {
  // 11.10 解析剧集字幕列表
  const rows = [...html.matchAll(/<tr\b[^>]*>\s*<td>(\d+x\d+)<\/td>\s*<td[^>]*>\s*<a\s+[^>]*href=["'][^"']*episode-\d+\.html["'][^>]*>\s*<b>([\s\S]*?)<\/b>\s*<\/a>\s*<\/td>\s*<td>(\d+)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi)];
  const results = [];

  for (const row of rows) {
    const episodeNumber = htmlDecode(row[1]).trim();
    if (episode.season && episode.episode && !tvEpisodeNumberMatches(episodeNumber, episode)) {
      continue;
    }

    const episodeTitle = htmlDecode(stripTags(row[2])).replace(/\s+/g, " ").trim();
    const amount = htmlDecode(row[3]).trim();
    const subtitlesCell = row[4];
    const links = [...subtitlesCell.matchAll(/<a\s+[^>]*href=["']([^"']*subtitle-\d+\.html)["'][^>]*>\s*<img[^>]*alt=["']([^"']+)["'][^>]*>/gi)];

    for (const link of links) {
      const siteLanguage = htmlDecode(link[2]).trim().toLowerCase();
      if (siteLanguage !== languageCode) continue;

      const title = `${show.title} ${episodeNumber} ${episodeTitle}`.trim();
      results.push({
        source: "tvsubtitles",
        sourceLabel: "TVSubtitles",
        title,
        fileName: sanitizeFileName(`${title}.${siteLanguage}.srt`),
        ext: "srt",
        language: siteLanguage,
        score: "",
        downloads: amount,
        size: "",
        duration: "",
        extra: show.title,
        downloadUrl: "",
        detailUrl: new URL(htmlDecode(link[1]), TV_SUBTITLES_BASE_URL).href,
      });
    }
  }

  return results;
}

function tvEpisodeNumberMatches(episodeNumber, episode) {
  // 11.11 判断 TVSubtitles 行是否匹配指定集数
  const match = String(episodeNumber || "").match(/0*(\d{1,2})\s*x\s*0*(\d{1,3})/i);
  if (!match) return false;
  return Number(match[1]) === episode.season && Number(match[2]) === episode.episode;
}

async function fetchSubtitleBytes(result, language) {
  /*
   * ================================================================================
   * 步骤10：拉取字幕字节
   * ================================================================================
   * 目标：
   * 1) 解析真实下载地址
   * 2) 请求字幕内容并返回 Buffer
   */
  logger.info("开始拉取字幕字节...");

  // 10.1 解析下载地址
  const downloadUrl = await resolveDownloadUrl(result, language);
  if (!downloadUrl) {
    throw new Error("没有找到可下载的字幕地址");
  }

  // 10.2 请求字幕文件
  const response = await fetchWithTimeout(downloadUrl, {
    headers: { ...browserHeaders, referer: result.detailUrl || "https://subtitlecat.com/" },
  });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type") || "text/plain; charset=utf-8";
  const fileName = sanitizeFileName(result.fileName || path.basename(new URL(downloadUrl).pathname) || "subtitle.srt");

  // 10.3 自动解包 ZIP 字幕
  const extracted = extractSubtitlePayload(buffer, contentType, fileName, language);
  if (extracted) {
    logger.info(`拉取字幕字节完成: ${extracted.fileName}`);
    return extracted;
  }

  logger.info(`拉取字幕字节完成: ${buffer.length} bytes`);
  return { buffer, contentType, fileName };
}

async function resolveDownloadUrl(result, language) {
  /*
   * ================================================================================
   * 步骤11：解析真实下载地址
   * ================================================================================
   * 目标：
   * 1) 迅雷结果直接使用返回地址
   * 2) 网页源需要进入详情页寻找真实下载链接
   */
  logger.info("开始解析真实下载地址...");

  // 11.1 直接使用已有下载地址
  if (result.downloadUrl) {
    logger.info("解析真实下载地址完成: direct");
    return result.downloadUrl;
  }

  // 11.2 解析 SubtitleCat 详情页
  if (result.source === "subtitlecat" && result.detailUrl) {
    const response = await fetchWithTimeout(result.detailUrl, { headers: browserHeaders });
    const html = await response.text();
    const lang = escapeRegExp(language || "zh-CN");
    const byLang =
      matchFirst(html, new RegExp(`id=["']download_${lang}["'][^>]*href=["']([^"']+)["']`, "i")) ||
      matchFirst(html, new RegExp(`href=["']([^"']+)["'][^>]*id=["']download_${lang}["']`, "i"));
    const fallback = matchFirst(html, /href=["']([^"']+\.srt(?:\?[^"']*)?)["']/i);
    const href = byLang || fallback;
    if (href) {
      const resolved = new URL(htmlDecode(href), result.detailUrl).href;
      result.downloadUrl = resolved;
      logger.info("解析真实下载地址完成: subtitlecat");
      return resolved;
    }
  }

  // 11.3 解析 YIFY 详情页
  if (result.source === "yify" && result.detailUrl) {
    const response = await fetchWithTimeout(result.detailUrl, {
      headers: { ...browserHeaders, referer: YIFY_BASE_URL },
    });
    const html = await response.text();
    const href = matchFirst(html, /<a\s+[^>]*class=["'][^"']*download-subtitle[^"']*["'][^>]*href=["']([^"']+)["']/i);
    if (href) {
      const resolved = new URL(htmlDecode(href), result.detailUrl).href;
      result.downloadUrl = resolved;
      logger.info("解析真实下载地址完成: yify");
      return resolved;
    }
  }

  // 11.4 解析 Subf2m 详情页
  if (result.source === "subf2m" && result.detailUrl) {
    const response = await fetchWithTimeout(result.detailUrl, {
      headers: { ...browserHeaders, referer: SUBF2M_BASE_URL },
    });
    const html = await response.text();
    const href =
      matchFirst(html, /id=["']downloadButton["'][^>]*href=["']([^"']+)["']/i) ||
      matchFirst(html, /href=["']([^"']+)["'][^>]*id=["']downloadButton["']/i);
    if (href) {
      const resolved = new URL(htmlDecode(href), result.detailUrl).href;
      result.downloadUrl = resolved;
      logger.info("解析真实下载地址完成: subf2m");
      return resolved;
    }
  }

  // 11.5 解析 MovieSubtitles 详情页
  if (result.source === "moviesubtitles" && result.detailUrl) {
    const response = await fetchWithTimeout(result.detailUrl, {
      headers: { ...browserHeaders, referer: MOVIE_SUBTITLES_BASE_URL },
    });
    const html = await response.text();
    const href = matchFirst(html, /href=["']([^"']*download-\d+\.html)["']/i);
    if (href) {
      const resolved = new URL(htmlDecode(href), result.detailUrl).href;
      result.downloadUrl = resolved;
      logger.info("解析真实下载地址完成: moviesubtitles");
      return resolved;
    }
  }

  // 11.6 解析 TVSubtitles 详情页和等待页
  if (result.source === "tvsubtitles" && result.detailUrl) {
    const detailResponse = await fetchWithTimeout(result.detailUrl, {
      headers: { ...browserHeaders, referer: TV_SUBTITLES_BASE_URL },
    });
    const detailHtml = await detailResponse.text();
    const href = matchFirst(detailHtml, /href=["']([^"']*download-\d+\.html)["']/i);
    if (href) {
      const downloadPageUrl = new URL(htmlDecode(href), result.detailUrl).href;
      const downloadResponse = await fetchWithTimeout(downloadPageUrl, {
        headers: { ...browserHeaders, referer: result.detailUrl },
      });
      const downloadHtml = await downloadResponse.text();
      const zipPath = parseJavaScriptLocation(downloadHtml);
      const resolved = zipPath ? new URL(zipPath, downloadPageUrl).href : downloadPageUrl;
      result.downloadUrl = resolved;
      logger.info("解析真实下载地址完成: tvsubtitles");
      return resolved;
    }
  }

  logger.info("解析真实下载地址完成: empty");
  return "";
}

function parseJavaScriptLocation(html) {
  // 11.7 解析旧站下载页的 document.location 拼接表达式
  const variables = {};
  for (const match of html.matchAll(/var\s+([a-zA-Z_$][\w$]*)\s*=\s*(['"])(.*?)\2\s*;/g)) {
    variables[match[1]] = match[3];
  }

  const expression = matchFirst(html, /document\.location\s*=\s*([^;]+);/i);
  if (!expression) return "";

  return expression
    .split("+")
    .map((part) => {
      const key = part.trim();
      const quoted = key.match(/^(['"])(.*?)\1$/);
      if (quoted) return quoted[2];
      return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
    })
    .join("");
}

function extractSubtitlePayload(buffer, contentType, fileName, language) {
  /*
   * ================================================================================
   * 步骤12：解包压缩字幕
   * ================================================================================
   * 目标：
   * 1) 识别 ZIP 压缩包
   * 2) 从包内挑选最匹配语言的字幕文件
   */
  logger.info("开始解包压缩字幕...");

  // 12.1 判断是否为 ZIP
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (contentType.includes("zip") || fileName.toLowerCase().endsWith(".zip") || buffer[2] === 0x03);
  if (!isZip) {
    logger.info("解包压缩字幕完成: 非压缩包");
    return null;
  }

  // 12.2 解析并选择字幕文件
  const entries = readZipEntries(buffer)
    .filter((entry) => SUBTITLE_EXTENSIONS.includes(path.extname(entry.fileName).toLowerCase()))
    .sort((left, right) => scoreSubtitleEntry(right.fileName, language) - scoreSubtitleEntry(left.fileName, language));
  if (!entries.length) {
    logger.info("解包压缩字幕完成: 未找到字幕");
    return null;
  }

  // 12.3 返回解包后的字幕字节
  const selected = entries[0];
  logger.info(`解包压缩字幕完成: ${selected.fileName}`);
  return {
    buffer: selected.buffer,
    contentType: "text/plain; charset=utf-8",
    fileName: sanitizeFileName(path.basename(selected.fileName)),
  };
}

function readZipEntries(buffer) {
  // 12.4 读取 ZIP 中央目录
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return [];

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount && offset < buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = decodeZipFileName(buffer.subarray(offset + 46, offset + 46 + fileNameLength));
    const content = readZipEntryContent(buffer, localHeaderOffset, compressedSize, method);

    if (content) entries.push({ fileName, buffer: content });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findZipEndOfCentralDirectory(buffer) {
  // 12.5 从尾部查找 ZIP 结束目录标记
  if (buffer.length < 22) return -1;
  const minimumOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntryContent(buffer, localHeaderOffset, compressedSize, method) {
  // 12.6 读取并解压单个文件
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null;

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return inflateRawSync(compressed);
  return null;
}

function decodeZipFileName(buffer) {
  // 12.7 解码 ZIP 文件名
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("binary");
  }
}

function scoreSubtitleEntry(fileName, language) {
  // 12.8 根据语言和扩展名给压缩包内文件打分
  const lower = fileName.toLowerCase();
  let score = 0;
  if (lower.includes("__macosx") || lower.includes("/.")) score -= 20;
  if (lower.endsWith(".srt")) score += 8;
  if (lower.endsWith(".ass") || lower.endsWith(".ssa")) score += 6;
  if (lower.endsWith(".vtt")) score += 5;

  if (language === "zh-CN") {
    if (/简|chs|gb|simplified|chinese/.test(lower)) score += 20;
    if (/繁|cht|big5|traditional/.test(lower)) score += 6;
  } else if (language === "zh-TW") {
    if (/繁|cht|big5|traditional|chinese/.test(lower)) score += 20;
    if (/简|chs|gb|simplified/.test(lower)) score += 6;
  } else if (language === "en") {
    if (/eng|english|\ben\b/.test(lower)) score += 12;
  } else if (language === "ja") {
    if (/jpn|japanese|\bja\b/.test(lower)) score += 12;
  }

  return score;
}

function cacheResult(result) {
  // 3.4 缓存结果供预览和下载接口复用
  const key = `${result.source}|${result.title}|${result.detailUrl}|${result.downloadUrl}`;
  const id = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const cached = { ...result, id };
  RESULT_CACHE.set(id, cached);
  return toPublicResult(cached);
}

function toPublicResult(result) {
  // 3.5 只返回前端展示需要的字段
  return {
    id: result.id,
    source: result.source,
    sourceLabel: result.sourceLabel,
    title: result.title,
    fileName: result.fileName,
    ext: result.ext,
    language: result.language,
    score: result.score,
    downloads: result.downloads,
    size: result.size,
    duration: result.duration,
    extra: result.extra,
  };
}

async function serveStatic(url, res) {
  /*
   * ================================================================================
   * 步骤10：返回前端静态资源
   * ================================================================================
   * 目标：
   * 1) 将根路径映射到 index.html
   * 2) 阻止目录穿越
   */
  logger.info("开始返回静态资源...");

  // 10.1 计算静态文件路径
  const requestPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    logger.info("返回静态资源完成: forbidden");
    return;
  }

  // 10.2 流式返回文件
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "content-type": getMimeType(filePath),
      "content-length": fileStat.size,
      "cache-control": "no-cache",
    });
    createReadStream(filePath).pipe(res);
    logger.info("返回静态资源完成:", path.basename(filePath));
  } catch {
    sendText(res, 404, "Not Found");
    logger.info("返回静态资源完成: not found");
  }
}

async function fetchWithTimeout(url, options = {}) {
  // 6.3 带超时请求远程资源
  const { allowErrorStatus = false, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    if (!response.ok && !allowErrorStatus) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function decodeSubtitle(buffer, contentType = "") {
  // 4.4 尝试常见字幕编码
  const charset = matchFirst(contentType, /charset=([^;]+)/i);
  const encodings = [
    charset,
    "utf-8",
    "gb18030",
    "big5",
    "shift_jis",
    "windows-1252",
    "iso-8859-1",
  ].filter(Boolean);

  let best = { text: "", encoding: "utf-8", score: Number.POSITIVE_INFINITY };
  for (const encoding of encodings) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer).replace(/\u0000/g, "");
      const score = (text.match(/\uFFFD/g) || []).length;
      if (score < best.score) best = { text, encoding, score };
      if (score === 0) break;
    } catch {
      logger.warn("字幕编码不支持", encoding);
    }
  }

  return { text: best.text, encoding: best.encoding };
}

function sendJson(res, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = Buffer.from(text);
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

function matchFirst(value, pattern) {
  const match = value.match(pattern);
  return match ? match[1] : "";
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, " ");
}

function htmlDecode(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const code = key[1] === "x" ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : _;
  });
}

function sanitizeFileName(value) {
  const safe = String(value || "subtitle.srt")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return safe || "subtitle.srt";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatDuration(milliseconds) {
  if (!milliseconds) return "";
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((item) => String(item).padStart(2, "0"))
    .join(":")
    .replace(/^00:/, "");
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    }[ext] || "application/octet-stream"
  );
}

function isMainModule() {
  // 1.5 判断是否由命令行直接启动
  return process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;
}

if (isMainModule()) {
  startServer().catch((error) => {
    logger.error("服务启动失败", error);
    process.exitCode = 1;
  });
}
