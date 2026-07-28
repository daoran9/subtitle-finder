import { createHash } from "crypto";
import { lookup as dnsLookup } from "dns";
import { createReadStream, promises as fsPromises } from "fs";
import { createServer } from "http";
import http from "http";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { TextDecoder } from "util";
import { inflateRawSync } from "zlib";
import iconv from "iconv-lite";
import SevenZip from "7z-wasm";
import unrar from "node-unrar-js";
import { createRuntimeStore } from "./lib/runtime-store.mjs";
import {
  buildConvertedSubtitleFileName,
  convertSubtitleChinese,
  validateSubtitleText,
} from "./lib/subtitle-tools.mjs";
import { scoreArchiveSubtitle, scoreSubtitleCandidate } from "./public/subtitle-rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { readFile, stat } = fsPromises;
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 8765);
const REQUEST_TIMEOUT_MS = 16000;
const SOURCE_SEARCH_TIMEOUT_MS = 6000;
const OVERALL_SEARCH_TIMEOUT_MS = 12000;
const ADDIC7ED_TIMEOUT_MS = 9000;
const SUBHD_SEARCH_TIMEOUT_MS = 24000;
const SUBHD_SESSION_RETRY_DELAY_MS = 350;
const RESULT_CACHE = new Map();
const SUBTITLE_PAYLOAD_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const SEARCH_CACHE_PARTIAL_TTL_MS = 5 * 60 * 1000;
const SUBTITLE_PAYLOAD_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULT_CACHE_ENTRIES = 2000;
const MAX_SUBTITLE_PAYLOAD_CACHE_ENTRIES = 40;
const MAX_FETCH_REDIRECTS = 5;
const YIFY_BASE_URL = "https://yifysubtitles.ch";
const SUBF2M_BASE_URL = "https://subf2m.co";
const MOVIE_SUBTITLES_BASE_URL = "https://www.moviesubtitles.org";
const MOVIE_SUBTITLES_SEARCH_URL = "https://www.moviesubtitles.org/search.php";
const TV_SUBTITLES_BASE_URL = "https://www.tvsubtitles.net";
const ADDIC7ED_BASE_URL = "https://www.addic7ed.com";
const AV_SUBTITLES_BASE_URL = "https://www.avsubtitles.com";
const AIYI_BASE_URL = "https://www.aiyi1.com";
const SUBHD_BASE_URL = "https://subhd.tv";
const ASSRT_BASE_URL = "https://assrt.net";
const ASSRT_API_URL = "https://api.assrt.net/v1";
const ASSRT_DOH_PROVIDERS = [
  { address: "223.5.5.5", serverName: "dns.alidns.com", path: "/resolve" },
  { address: "1.1.1.1", serverName: "cloudflare-dns.com", path: "/dns-query" },
];
const SHOOTER_API_URL = "https://www.shooter.cn/api/subapi.php";
const XUNLEI_FINGERPRINT_URL = "http://sub.xmp.sandai.net:8000/subxl";
const UNRAR_WASM_PATH = path.join(__dirname, "vendor", "unrar.wasm");
const SEVEN_ZIP_WASM_PATH = path.join(__dirname, "vendor", "7zz.wasm");
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];
let runtimePort = DEFAULT_PORT;
let runtimeStore = null;
let runtimePreferences = { scanExclusionRules: [], customDictionary: "" };
let unrarWasmBinaryPromise = null;
let sevenZipWasmBinaryPromise = null;
const assrtFileDnsCache = new Map();

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
  ["Friends", "老友记", "老友記", "六人行"],
  ["The Big Bang Theory", "生活大爆炸", "天才理论传"],
  ["Game of Thrones", "权力的游戏", "權力的遊戲", "冰与火之歌"],
  ["Breaking Bad", "绝命毒师", "絕命毒師", "制毒师"],
  ["Better Call Saul", "风骚律师", "絕命律師", "绝命律师"],
  ["The Simpsons", "辛普森一家", "辛普森家庭"],
  ["Futurama", "飞出个未来", "飛出個未來"],
  ["Rick and Morty", "瑞克和莫蒂", "瑞克与莫蒂"],
  ["South Park", "南方公园", "南方四贱客"],
  ["Stranger Things", "怪奇物语", "怪奇物語"],
  ["The Office", "办公室", "辦公室", "爆笑办公室"],
  ["House M.D.", "House", "豪斯医生", "怪医豪斯"],
  ["Sherlock", "神探夏洛克", "新福尔摩斯"],
  ["Doctor Who", "神秘博士", "异世奇人"],
  ["Black Mirror", "黑镜", "黑鏡"],
  ["Westworld", "西部世界"],
  ["The Last of Us", "最后生还者", "最後生還者"],
  ["The Bear", "熊家餐馆", "大熊餐厅"],
];
const TITLE_ALIAS_FAMILY_LOOKUP = buildTitleAliasFamilyLookup();
const MAX_QUERY_VARIANTS = 12;
const MAX_TV_SEASON_PAGES = 12;
const runtimeFetch = globalThis.fetch || nodeFetchCompat;

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

  // 1.2 初始化搜索缓存和批量任务存储
  const dataDir = options.dataDir || process.env.SUBTITLE_FINDER_DATA_DIR || path.join(__dirname, ".subtitle-finder-data");
  runtimeStore = createRuntimeStore(dataDir);
  await runtimeStore.initialize();
  runtimePreferences = await runtimeStore.readPreferences();

  // 1.3 创建 HTTP 服务
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      logger.error("请求处理失败", error);
      sendJson(res, 500, { error: "服务内部错误", detail: String(error?.message || error) });
    }
  });

  // 1.4 监听本地端口
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // 1.5 返回真实监听地址
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

  // 2.1 处理跨源预检
  if (req.method === "OPTIONS") {
    sendEmpty(res, 204);
    logger.info("请求分发完成: options");
    return;
  }

  // 2.2 健康检查
  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, port: runtimePort });
    logger.info("请求分发完成: health");
    return;
  }

  // 2.3 搜索字幕
  if (url.pathname === "/api/search") {
    await handleSearch(req, url, res);
    logger.info("请求分发完成: search");
    return;
  }

  // 2.4 预览字幕
  if (url.pathname === "/api/preview") {
    await handlePreview(url, res);
    logger.info("请求分发完成: preview");
    return;
  }

  // 2.5 校验字幕结构
  if (url.pathname === "/api/validate") {
    await handleValidate(url, res);
    logger.info("请求分发完成: validate");
    return;
  }

  // 2.6 下载字幕
  if (url.pathname === "/api/download") {
    await handleDownload(url, res);
    logger.info("请求分发完成: download");
    return;
  }

  // 2.6 读取或保存批量任务状态
  if (url.pathname === "/api/state/batch") {
    await handleBatchState(req, res);
    logger.info("请求分发完成: batch state");
    return;
  }

  // 2.7 读取或保存通用设置
  if (url.pathname === "/api/settings") {
    await handleAppSettings(req, res);
    logger.info("请求分发完成: settings");
    return;
  }

  // 2.8 返回静态文件
  await serveStatic(url, res);
  logger.info("请求分发完成: static");
}

async function handleSearch(req, url, res) {
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
  const shooterHash = (url.searchParams.get("shooterHash") || "").trim();
  const thunderCid = (url.searchParams.get("thunderCid") || "").trim();
  const videoFileName = sanitizeFileName((url.searchParams.get("videoFileName") || "video.mkv").trim());
  const releaseName = (url.searchParams.get("releaseName") || videoFileName || query).trim();
  const assrtToken = String(req.headers["x-assrt-token"] || "").trim().slice(0, 256);
  const metadataAliases = url.searchParams.getAll("alias").map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8);
  const requestedEpisode = parseEpisodeQuery(query);

  if (!query) {
    sendJson(res, 400, { error: "请输入搜索字段或文件名" });
    logger.info("搜索字幕完成: 缺少关键词");
    return;
  }
  if (source === "shooter" && !shooterHash) {
    sendJson(res, 400, { error: "请先从视频文件夹选择一个本地视频" });
    logger.info("搜索字幕完成: 射手网缺少视频指纹");
    return;
  }
  if (source === "thunder-fingerprint" && !thunderCid) {
    sendJson(res, 400, { error: "请先从视频文件夹选择一个本地视频" });
    logger.info("搜索字幕完成: 迅雷缺少视频指纹");
    return;
  }

  // 3.2 优先复用相同搜索条件的有效缓存
  const searchCacheKey = buildSearchCacheKey({
    query,
    source,
    language,
    limit,
    shooterHash,
    thunderCid,
    videoFileName,
    releaseName,
    metadataAliases,
    assrtToken,
  });
  const cachedSearch = runtimeStore?.getSearch(searchCacheKey);
  if (cachedSearch?.value) {
    const cachedPayload = restoreCachedSearchPayload(cachedSearch.value, cachedSearch.createdAt);
    sendJson(res, 200, cachedPayload);
    logger.info(`搜索字幕完成: 缓存 ${cachedPayload.count} 条`);
    return;
  }

  // 3.3 按选择组装字幕源
  const queryVariants = buildQueryVariants(query, metadataAliases);
  const selectedSources = buildSelectedSearchSources({
    source,
    queryVariants,
    language,
    shooterHash,
    thunderCid,
    videoFileName,
    assrtToken,
  });

  // 3.4 并发查询字幕源
  const perSourceLimit = requestedEpisode.season && requestedEpisode.episode ? 100 : limit;
  const tasks = selectedSources.map((sourceItem) =>
    searchSourceWithTimeout(sourceItem.name, () => sourceItem.search(perSourceLimit), sourceItem.timeoutMs)
  );
  const settled = await settleAllSearchSourcesWithTimeout(tasks, getOverallSearchTimeoutMs(selectedSources, source));
  const filteredBuckets = settled.map((item) =>
    item.status === "fulfilled" ? filterResultsByEpisode(item.value.results.filter(Boolean), requestedEpisode) : []
  );
  const sourceStats = mergeSourceStats(
    buildSourceStats(selectedSources, settled, filteredBuckets, queryVariants),
    buildUnavailableSourceStats({ source, shooterHash, thunderCid })
  );
  const errors = sourceStats
    .filter((item) => item.status !== "done" && item.status !== "skipped")
    .map((item) => `${item.sourceLabel}: ${item.message}`);
  const qualityContext = { query, language, requestedEpisode, releaseName };
  const resultBuckets = filteredBuckets
    .filter((bucket) => bucket.length)
    .map((bucket) => bucket.map((result) => attachQualityScore(result, qualityContext)));
  const internalResults = mergeSearchResultBuckets(resultBuckets, limit, { queryVariants, requestedEpisode, balanced: source === "all" });
  const publicResults = internalResults.map(cacheResult);

  // 3.5 只缓存至少有一个来源完成的搜索，纯超时或纯失败结果允许用户立即重试
  const searchPayload = { query, source, language, variants: queryVariants, internalResults, errors, sourceStats };
  const hasCompletedSource = sourceStats.some((item) => item.status === "done");
  const searchTtlMs = errors.length || !internalResults.length ? SEARCH_CACHE_PARTIAL_TTL_MS : SEARCH_CACHE_TTL_MS;
  if (hasCompletedSource) {
    await runtimeStore?.setSearch(searchCacheKey, searchPayload, { ttlMs: searchTtlMs, persist: !assrtToken });
  } else {
    logger.info("搜索缓存跳过: 没有完成来源");
  }

  // 3.6 返回结果
  sendJson(res, 200, { query, source, language, variants: queryVariants, count: publicResults.length, results: publicResults, errors, sourceStats, cached: false });
  logger.info(`搜索字幕完成: ${publicResults.length} 条`);
}

function buildSearchCacheKey(options) {
  /*
   * ================================================================================
   * 步骤3.7：生成搜索缓存键
   * ================================================================================
   * 目标：
   * 1) 覆盖会改变搜索结果的关键词、来源、语言、指纹和 NFO 别名
   * 2) Token 只参与摘要，不把原文写入缓存键或文件
   */
  logger.info("开始生成搜索缓存键...");

  // 3.7.1 规范搜索条件并计算 SHA-256
  const tokenDigest = options.assrtToken
    ? createHash("sha256").update(options.assrtToken).digest("hex").slice(0, 16)
    : "anonymous";
  const value = JSON.stringify({
    query: String(options.query || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
    source: options.source,
    language: options.language,
    limit: options.limit,
    shooterHash: options.shooterHash,
    thunderCid: options.thunderCid,
    videoFileName: options.videoFileName,
    releaseName: options.releaseName,
    metadataAliases: [...(options.metadataAliases || [])].map((item) => item.normalize("NFKC").toLowerCase()).sort(),
    tokenDigest,
  });
  const key = createHash("sha256").update(value).digest("hex");
  logger.info("生成搜索缓存键完成", key.slice(0, 12));
  return key;
}

function restoreCachedSearchPayload(value, createdAt) {
  /*
   * ================================================================================
   * 步骤3.8：恢复搜索缓存结果
   * ================================================================================
   * 目标：
   * 1) 把内部结果重新注册到当前进程的预览下载缓存
   * 2) 返回与实时搜索一致的公开结构和缓存标识
   */
  logger.info("开始恢复搜索缓存结果...");

  // 3.8.1 注册结果 ID 并组装公开响应
  const publicResults = (Array.isArray(value.internalResults) ? value.internalResults : []).map(cacheResult);
  const result = {
    query: value.query || "",
    source: value.source || "all",
    language: value.language || "zh-CN",
    variants: Array.isArray(value.variants) ? value.variants : [],
    count: publicResults.length,
    results: publicResults,
    errors: Array.isArray(value.errors) ? value.errors : [],
    sourceStats: Array.isArray(value.sourceStats) ? value.sourceStats : [],
    cached: true,
    cacheAgeSeconds: Math.max(0, Math.round((Date.now() - Number(createdAt || Date.now())) / 1000)),
  };
  logger.info("恢复搜索缓存结果完成", result.count);
  return result;
}

async function handleBatchState(req, res) {
  /*
   * ================================================================================
   * 步骤3.9：读写批量任务状态
   * ================================================================================
   * 目标：
   * 1) GET 返回最近一次视频扫描和任务进度
   * 2) PUT 保存白名单状态，Token 和下载结果不会落盘
   */
  logger.info("开始处理批量任务状态...", req.method);

  // 3.9.1 返回持久化状态
  if (req.method === "GET") {
    const state = await runtimeStore?.readBatchState();
    sendJson(res, 200, { state });
    logger.info("处理批量任务状态完成: read");
    return;
  }

  // 3.9.2 校验并保存前端状态
  if (req.method === "PUT") {
    try {
      const body = await readJsonRequest(req, 4 * 1024 * 1024);
      const result = await runtimeStore?.writeBatchState(body?.state);
      sendJson(res, 200, { saved: true, updatedAt: result?.updatedAt || Date.now() });
      logger.info("处理批量任务状态完成: saved");
    } catch (error) {
      sendJson(res, 400, { error: "批量任务状态无效", detail: String(error?.message || error) });
      logger.info("处理批量任务状态完成: invalid", error.message);
    }
    return;
  }

  // 3.9.3 拒绝其他请求方法
  sendJson(res, 405, { error: "请求方法不支持" });
  logger.info("处理批量任务状态完成: method not allowed");
}

async function handleAppSettings(req, res) {
  /*
   * ================================================================================
   * 步骤3.10：读写通用设置
   * ================================================================================
   * 目标：
   * 1) GET 返回本机扫描规则和简繁词库
   * 2) PUT 校验后持久化，并更新当前转换服务
   */
  logger.info("开始处理通用设置...", req.method);

  // 3.10.1 返回当前内存设置
  if (req.method === "GET") {
    sendJson(res, 200, { settings: runtimePreferences });
    logger.info("处理通用设置完成: read");
    return;
  }

  // 3.10.2 校验并保存设置
  if (req.method === "PUT") {
    try {
      const body = await readJsonRequest(req, 64 * 1024);
      const result = await runtimeStore?.writePreferences(body?.settings);
      runtimePreferences = result?.preferences || { scanExclusionRules: [], customDictionary: "" };
      sendJson(res, 200, { saved: true, settings: runtimePreferences, updatedAt: result?.updatedAt || Date.now() });
      logger.info("处理通用设置完成: saved");
    } catch (error) {
      sendJson(res, 400, { error: "通用设置无效", detail: String(error?.message || error) });
      logger.info("处理通用设置完成: invalid", error.message);
    }
    return;
  }

  // 3.10.3 拒绝其他请求方法
  sendJson(res, 405, { error: "请求方法不支持" });
  logger.info("处理通用设置完成: method not allowed");
}

async function readJsonRequest(req, maxBytes) {
  // 3.9.4 有界读取 JSON 请求体
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function buildSelectedSearchSources({
  source,
  queryVariants,
  language,
  shooterHash = "",
  thunderCid = "",
  videoFileName = "video.mkv",
  assrtToken = "",
}) {
  /*
   * ================================================================================
   * 步骤4：组装搜索源
   * ================================================================================
   * 目标：
   * 1) 按用户选择生成统一字幕源配置
   * 2) 保留 key、名称和搜索函数，供状态面板复用
   */
  logger.info("开始组装搜索源...");

  // 4.1 定义可用字幕源
  const availableSources = [
    {
      key: "shooter",
      name: "射手网指纹",
      fileOnly: true,
      search: (sourceLimit) => searchShooterFingerprint(shooterHash, videoFileName, language, sourceLimit),
    },
    {
      key: "thunder-fingerprint",
      name: "迅雷指纹",
      fileOnly: true,
      search: (sourceLimit) => searchThunderFingerprint(thunderCid, videoFileName, sourceLimit),
    },
    {
      key: "thunder",
      name: "迅雷字幕",
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchThunder(variant, sourceLimit)),
    },
    {
      key: "assrt",
      name: "ASSRT",
      timeoutMs: 10000,
      search: (sourceLimit) => searchWithQueryVariants(queryVariants.slice(0, 2), Math.min(sourceLimit, 15), (variant) => searchAssrt(variant, language, assrtToken, sourceLimit)),
    },
    {
      key: "subhd",
      name: "SubHD",
      timeoutMs: SUBHD_SEARCH_TIMEOUT_MS,
      search: (sourceLimit) => searchWithQueryVariants(queryVariants.slice(0, 4), sourceLimit, (variant) => searchSubHd(variant, language, sourceLimit)),
    },
    {
      key: "subtitlecat",
      name: "SubtitleCat",
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchSubtitleCat(variant, language, sourceLimit)),
    },
    {
      key: "yify",
      name: "YIFY Subtitles",
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchYify(variant, language, sourceLimit)),
    },
    {
      key: "subf2m",
      name: "Subf2m",
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchSubf2m(variant, language, sourceLimit)),
    },
    {
      key: "moviesubtitles",
      name: "MovieSubtitles",
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchMovieSubtitles(variant, language, sourceLimit)),
    },
    {
      key: "tvsubtitles",
      name: "TVSubtitles",
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchTvSubtitles(variant, language, sourceLimit)),
    },
    {
      key: "addic7ed",
      name: "Addic7ed",
      timeoutMs: ADDIC7ED_TIMEOUT_MS,
      search: (sourceLimit) =>
        searchWithQueryVariants(filterLatinQueryVariants(queryVariants), sourceLimit, (variant) => searchAddic7ed(variant, language, sourceLimit)),
    },
    {
      key: "avsubtitles",
      name: "AVSubtitles",
      timeoutMs: 16000,
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchAvSubtitles(variant, language, sourceLimit)),
    },
    {
      key: "aiyi",
      name: "爱译网",
      timeoutMs: 12000,
      search: (sourceLimit) => searchWithQueryVariants(queryVariants, sourceLimit, (variant) => searchAiyi(variant, language, sourceLimit)),
    },
  ];

  // 4.2 按选择过滤字幕源
  const selected = source === "all"
    ? availableSources.filter((item) =>
      !item.fileOnly || (item.key === "shooter" ? Boolean(shooterHash) : Boolean(thunderCid))
    )
    : availableSources.filter((item) =>
      item.key === source &&
      (!item.fileOnly || (item.key === "shooter" ? Boolean(shooterHash) : Boolean(thunderCid)))
    );
  logger.info(`组装搜索源完成: ${selected.map((item) => item.name).join(", ") || "empty"}`);
  return selected;
}

function buildUnavailableSourceStats({ source, shooterHash, thunderCid }) {
  /*
   * ================================================================================
   * 步骤4.3：生成未启用来源状态
   * ================================================================================
   * 目标：
   * 1) 全部源模式不静默隐藏缺少前置条件的来源
   * 2) 明确区分“未启用”和“搜索后无结果”
   */
  logger.info("开始生成未启用来源状态...");

  // 4.3.1 仅在全部源模式补充可选来源
  if (source !== "all") {
    logger.info("生成未启用来源状态完成: single source");
    return [];
  }
  const unavailable = [
    !shooterHash && { source: "shooter", sourceLabel: "射手网指纹", message: "需本地视频" },
    !thunderCid && { source: "thunder-fingerprint", sourceLabel: "迅雷指纹", message: "需本地视频" },
  ].filter(Boolean).map((item) => ({
    ...item,
    status: "skipped",
    statusLabel: "未启用",
    count: 0,
    matchedCount: 0,
    durationMs: 0,
    duration: "-",
  }));

  logger.info("生成未启用来源状态完成", unavailable.length);
  return unavailable;
}

function mergeSourceStats(activeStats, unavailableStats) {
  // 4.3.2 按固定来源顺序合并已运行和未启用状态
  return [...activeStats, ...unavailableStats]
    .sort((left, right) => getSourceOrder(left.source) - getSourceOrder(right.source));
}

function filterLatinQueryVariants(queryVariants) {
  /*
   * ================================================================================
   * 步骤6：筛选英文查询变体
   * ================================================================================
   * 目标：
   * 1) 给只支持英文标题的字幕源使用
   * 2) 避免中文别名造成无效慢请求
   */
  logger.info("开始筛选英文查询变体...");

  // 5.1 保留含拉丁字符的变体
  const variants = queryVariants.filter((item) => /[A-Za-z]/.test(stripEpisodeTokens(item)));
  const selected = variants.length ? variants : queryVariants.slice(0, 1);

  logger.info(`筛选英文查询变体完成: ${selected.join(" | ")}`);
  return selected;
}

export function getOverallSearchTimeoutMs(selectedSources, source) {
  /*
   * ================================================================================
   * 步骤6：计算整次搜索超时
   * ================================================================================
   * 目标：
   * 1) 默认全部搜索维持短超时
   * 2) 手动选择慢源时给足单源执行时间
   */
  logger.info("开始计算整次搜索超时...");

  // 6.1 默认全部搜索使用全局超时
  if (source === "all") {
    logger.info("计算整次搜索超时完成", OVERALL_SEARCH_TIMEOUT_MS);
    return OVERALL_SEARCH_TIMEOUT_MS;
  }

  // 6.2 单源搜索按源级超时上浮
  const maxSourceTimeout = Math.max(...selectedSources.map((item) => Number(item.timeoutMs || SOURCE_SEARCH_TIMEOUT_MS)), SOURCE_SEARCH_TIMEOUT_MS);
  const timeoutMs = Math.max(OVERALL_SEARCH_TIMEOUT_MS, maxSourceTimeout + 1000);
  logger.info("计算整次搜索超时完成", timeoutMs);
  return timeoutMs;
}

async function settleAllSearchSourcesWithTimeout(tasks, timeoutMs = OVERALL_SEARCH_TIMEOUT_MS) {
  /*
   * ================================================================================
   * 步骤7：限制整次搜索耗时
   * ================================================================================
   * 目标：
   * 1) 避免极端网络状态下搜索接口一直不返回
   * 2) 超时后返回已经完成的来源结果
   */
  logger.info("开始限制整次搜索耗时...");

  // 7.1 收集已经完成的来源结果
  const settled = Array.from({ length: tasks.length }, () => null);
  let completed = 0;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    tasks.forEach((task, index) => {
      Promise.resolve(task)
        .then((value) => {
          settled[index] = { status: "fulfilled", value };
        })
        .catch((reason) => {
          settled[index] = { status: "rejected", reason };
        })
        .finally(() => {
          completed += 1;
          if (completed === tasks.length) {
            clearTimeout(timer);
            resolve();
          }
        });
    });
  });

  // 7.2 未完成来源标记为整体超时
  const timeoutError = new Error("搜索整体超时");
  timeoutError.durationMs = timeoutMs;
  const results = settled.map((item) => item || { status: "rejected", reason: timeoutError });
  logger.info("限制整次搜索耗时完成");
  return results;
}

async function searchSourceWithTimeout(sourceName, searchTask, timeoutMs = SOURCE_SEARCH_TIMEOUT_MS) {
  /*
   * ================================================================================
   * 步骤6：限制单源搜索耗时
   * ================================================================================
   * 目标：
   * 1) 避免某个字幕源网络卡住拖慢整次搜索
   * 2) 记录单源耗时供前端展示
   */
  logger.info("开始限制单源搜索耗时...", sourceName);

  // 6.1 创建超时任务
  const startedAt = Date.now();
  let timer = null;
  const timeoutTask = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${sourceName} 搜索超时`)), timeoutMs);
  });

  // 6.2 执行搜索任务
  try {
    const results = await Promise.race([searchTask(), timeoutTask]);
    logger.info("限制单源搜索耗时完成", sourceName);
    return { results, durationMs: Date.now() - startedAt };
  } catch (error) {
    error.durationMs = Date.now() - startedAt;
    logger.info("限制单源搜索耗时完成: 失败", sourceName, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildSourceStats(selectedSources, settled, filteredBuckets, queryVariants) {
  /*
   * ================================================================================
   * 步骤7：生成源级状态
   * ================================================================================
   * 目标：
   * 1) 把每个字幕源的完成、超时、失败状态返回前端
   * 2) 同时展示原始数和最终命中数，避免结果卡片误导
   */
  logger.info("开始生成源级状态...");

  // 7.1 生成标题匹配关键词
  const needles = buildTitleNeedles(Array.isArray(queryVariants) ? queryVariants : []);

  // 7.1 逐源生成状态项
  const stats = selectedSources.map((sourceItem, index) => {
    const item = settled[index];
    if (item?.status === "fulfilled") {
      const durationMs = Number(item.value?.durationMs || 0);
      const bucket = Array.isArray(filteredBuckets[index]) ? filteredBuckets[index] : [];
      const count = bucket.length;
      const matchedCount = bucket.filter((result) => searchResultMatchesTitle(result, needles)).length;
      return {
        source: sourceItem.key,
        sourceLabel: sourceItem.name,
        status: "done",
        statusLabel: "完成",
        count,
        matchedCount,
        durationMs,
        duration: formatSourceStatDuration(durationMs),
        message: "",
      };
    }

    const message = String(item?.reason?.message || item?.reason || "搜索失败");
    const status = message.includes("超时") ? "timeout" : "error";
    const durationMs = Number(item?.reason?.durationMs || OVERALL_SEARCH_TIMEOUT_MS);
    return {
      source: sourceItem.key,
      sourceLabel: sourceItem.name,
      status,
      statusLabel: status === "timeout" ? "超时" : "失败",
      count: 0,
      matchedCount: 0,
      durationMs,
      duration: formatSourceStatDuration(durationMs),
      message,
    };
  });

  logger.info("生成源级状态完成");
  return stats;
}

function formatSourceStatDuration(durationMs) {
  // 7.2 格式化源级耗时
  if (!durationMs) return "-";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function searchWithQueryVariants(queryVariants, limit, searchVariant) {
  /*
   * ================================================================================
   * 步骤5：按查询变体搜索
   * ================================================================================
   * 目标：
   * 1) 同一个字幕源尝试原词、英文名、中文名等变体
   * 2) 合并同源重复结果
   */
  logger.info("开始按查询变体搜索...");

  // 5.1 逐个变体查询
  const results = [];
  for (const variant of queryVariants) {
    const variantResults = await searchVariant(variant);
    results.push(...variantResults);
  }

  // 5.2 去重并裁剪
  const deduped = dedupeSearchResults(results).slice(0, limit);
  logger.info(`按查询变体搜索完成: ${deduped.length} 条`);
  return deduped;
}

export function buildQueryVariants(query, extraAliases = []) {
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

  // 5.4 在原有规则之后追加 NFO 中英文标题和季集搜索词
  for (const alias of Array.isArray(extraAliases) ? extraAliases : []) addVariant(alias);

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
  return [...String(query || "").matchAll(/[\u3400-\u9fff][\u3400-\u9fff·・\s]{1,}/g)]
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

export function mergeSearchResultBuckets(buckets, limit, options = {}) {
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

  // 6.2 先按片名归组，再在组内按季集、来源稳定排序
  const grouped = buildGroupedSearchResults(candidates, needles, options.requestedEpisode);
  const merged = grouped.flatMap((group) => group.items).slice(0, limit);

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
  const addNeedle = (raw, family = "") => {
    const normalized = normalizeComparableText(raw);
    if (!normalized || needles.some((item) => item.normalized === normalized)) return;
    needles.push({
      raw,
      normalized,
      family: family || TITLE_ALIAS_FAMILY_LOOKUP.get(normalized) || normalized,
    });
  };

  for (const variant of queryVariants) {
    const value = stripEpisodeTokens(variant).trim();
    if (!value) continue;

    // 6.4.1 编号查询保留完整原词，同时加入带分隔符和连写形式
    const catalogCode = extractCatalogCode(value);
    const catalogFamily = catalogCode ? `catalog:${catalogCode.toLowerCase()}` : "";
    addNeedle(value, catalogFamily);
    if (catalogCode) {
      addNeedle(formatCatalogCode(catalogCode, "-"), catalogFamily);
      addNeedle(catalogCode, catalogFamily);
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
  if (result.fingerprintMatch) return true;
  if (!needles.length) return true;
  const text = normalizeComparableText(getSearchResultText(result));
  return needles.some((needle) => text.includes(needle.normalized));
}

function compareSearchResults(left, right, needles, requestedEpisode) {
  // 6.7 比较搜索结果展示顺序
  const leftQuality = Number(left.qualityScore || 0);
  const rightQuality = Number(right.qualityScore || 0);
  if (leftQuality !== rightQuality) return rightQuality - leftQuality;

  const leftScore = scoreSearchResult(left, needles, requestedEpisode);
  const rightScore = scoreSearchResult(right, needles, requestedEpisode);
  if (leftScore !== rightScore) return rightScore - leftScore;

  const leftEpisode = getSearchResultEpisodeKey(left);
  const rightEpisode = getSearchResultEpisodeKey(right);
  if (leftEpisode !== rightEpisode) return leftEpisode - rightEpisode;

  const leftSource = getSourceOrder(left.source);
  const rightSource = getSourceOrder(right.source);
  if (leftSource !== rightSource) return leftSource - rightSource;

  return String(left.title || "").localeCompare(String(right.title || ""));
}

function buildGroupedSearchResults(results, needles, requestedEpisode) {
  /*
   * ================================================================================
   * 步骤6.8：按片名归组搜索结果
   * ================================================================================
   * 目标：
   * 1) 让同一系列结果连续展示
   * 2) 组内继续按相关度、季集和来源稳定排序
   */
  logger.info("开始按片名归组搜索结果...");

  // 6.8.1 先构建带排序信息的分组条目
  const groups = new Map();
  for (const result of results) {
    const groupKey = getSearchResultGroupKey(result, needles);
    const entry = {
      result,
      groupKey,
      score: scoreSearchResult(result, needles, requestedEpisode),
      qualityScore: Number(result.qualityScore || 0),
      episodeKey: getSearchResultEpisodeKey(result),
      sourceOrder: getSourceOrder(result.source),
      title: String(result.title || ""),
    };
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entry);
  }

  // 6.8.2 排序分组和组内条目
  const orderedGroups = [...groups.entries()]
    .map(([groupKey, entries]) => {
      const items = entries
        .sort((left, right) => compareGroupedSearchEntries(left, right))
        .map((entry) => entry.result);
      const bestScore = Math.max(...entries.map((entry) => entry.score), 0);
      const bestQuality = Math.max(...entries.map((entry) => entry.qualityScore), 0);
      const bestEpisodeKey = Math.min(...entries.map((entry) => entry.episodeKey), 999999);
      return { groupKey, bestScore, bestQuality, bestEpisodeKey, items };
    })
    .sort((left, right) => compareSearchResultGroups(left, right));

  logger.info(`按片名归组搜索结果完成: ${orderedGroups.length} 组`);
  return orderedGroups;
}

function compareGroupedSearchEntries(left, right) {
  // 6.8.3 比较组内条目顺序
  if (left.qualityScore !== right.qualityScore) return right.qualityScore - left.qualityScore;
  if (left.score !== right.score) return right.score - left.score;
  if (left.episodeKey !== right.episodeKey) return left.episodeKey - right.episodeKey;
  if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
  return left.title.localeCompare(right.title);
}

function compareSearchResultGroups(left, right) {
  // 6.8.4 比较片名分组顺序
  if (left.bestScore !== right.bestScore) return right.bestScore - left.bestScore;
  if (left.bestQuality !== right.bestQuality) return right.bestQuality - left.bestQuality;
  if (left.bestEpisodeKey !== right.bestEpisodeKey) return left.bestEpisodeKey - right.bestEpisodeKey;
  return left.groupKey.localeCompare(right.groupKey);
}

function scoreSearchResult(result, needles, requestedEpisode) {
  // 6.9 给搜索结果计算相关度
  const title = normalizeComparableText(result.title || "");
  const text = normalizeComparableText(getSearchResultText(result));
  let score = 0;
  let titleScore = 0;

  if (result.fingerprintMatch) score += 240;

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
  // 6.10 生成片名分组键
  const text = normalizeComparableText(getSearchResultText(result));
  const matched = needles.find((needle) => text.includes(needle.normalized));
  if (matched) return matched.family || matched.normalized;

  const aliasFamily = findTitleAliasFamily(text);
  if (aliasFamily) return aliasFamily;

  return normalizeComparableText(stripEpisodeTokens(result.title || result.fileName || ""));
}

function getSearchResultEpisodeKey(result) {
  // 6.11 生成季集排序键
  const episodes = extractEpisodeTokens(getSearchResultText(result));
  if (!episodes.length) return 999999;
  return episodes[0].season * 1000 + episodes[0].episode;
}

function getSourceOrder(source) {
  // 6.12 固定字幕源排序
  const order = [
    "shooter",
    "thunder-fingerprint",
    "thunder",
    "assrt",
    "subhd",
    "subtitlecat",
    "tvsubtitles",
    "subf2m",
    "yify",
    "moviesubtitles",
    "addic7ed",
    "avsubtitles",
    "aiyi",
  ];
  const index = order.indexOf(source);
  return index >= 0 ? index : order.length;
}

function getSearchResultText(result) {
  // 6.13 拼接搜索结果可比较文本
  return [result.title, result.fileName, result.extra].filter(Boolean).join(" ");
}

function attachQualityScore(result, context) {
  /*
   * ================================================================================
   * 步骤6.14：补齐统一质量评分
   * ================================================================================
   * 目标：
   * 1) 将各站不可直接比较的分数转换为统一质量分
   * 2) 保存压缩包选集所需的查询上下文
   */
  logger.info("开始补齐统一质量评分...");

  // 6.14.1 计算质量分和标签
  const quality = scoreSubtitleCandidate(result, context);

  // 6.14.2 保存公开评分和内部下载上下文
  const ranked = {
    ...result,
    ...quality,
    searchQuery: context.query,
    requestedEpisode: context.requestedEpisode,
    releaseName: context.releaseName,
  };
  logger.info("补齐统一质量评分完成", ranked.qualityScore);
  return ranked;
}

function normalizeComparableText(value) {
  // 6.14 统一比较文本格式
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTitleAliasFamilyLookup() {
  // 6.15 建立片名别名归组表
  const lookup = new Map();
  for (const group of TITLE_ALIAS_GROUPS) {
    const family = normalizeComparableText(group[0]);
    if (!family) continue;
    for (const alias of group) {
      const normalized = normalizeComparableText(alias);
      if (normalized) lookup.set(normalized, family);
    }
  }
  return lookup;
}

function findTitleAliasFamily(text) {
  // 6.16 从结果文本中识别片名别名归组
  for (const [alias, family] of TITLE_ALIAS_FAMILY_LOOKUP.entries()) {
    if (text.includes(alias)) return family;
  }
  return "";
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
  if (result.fingerprintMatch) return true;
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
  const conversion = normalizeConversionTarget(url.searchParams.get("convert"));
  const cachedResult = RESULT_CACHE.get(id);
  if (!cachedResult) {
    sendJson(res, 404, { error: "结果已过期，请重新搜索" });
    logger.info("预览字幕完成: 未找到结果");
    return;
  }
  const result = { ...cachedResult };

  // 4.2 拉取、校验并按需转换字幕
  let validated;
  try {
    validated = await getValidatedSubtitlePayload(result, language, conversion);
  } catch (error) {
    sendJson(res, 422, { error: "字幕校验失败", detail: String(error?.message || error) });
    logger.info("预览字幕完成: 校验失败", error.message);
    return;
  }

  // 4.3 返回预览内容
  sendJson(res, 200, {
    id,
    title: result.title,
    source: result.source,
    fileName: validated.payload.fileName,
    size: validated.payload.buffer.length,
    encoding: validated.decoded.encoding,
    text: validated.decoded.text,
    validation: validated.validation,
    conversion: conversion || "original",
  });
  logger.info(`预览字幕完成: ${validated.payload.fileName}`);
}

async function handleValidate(url, res) {
  /*
   * ================================================================================
   * 步骤4.5：校验字幕候选
   * ================================================================================
   * 目标：
   * 1) 给批量匹配和批量下载提供轻量校验接口
   * 2) 缓存已下载字节，避免随后保存时重复访问字幕站
   */
  logger.info("开始校验字幕候选...");

  // 4.5.1 查找搜索结果
  const id = (url.searchParams.get("id") || "").trim();
  const language = (url.searchParams.get("lang") || "zh-CN").trim();
  const cachedResult = RESULT_CACHE.get(id);
  if (!cachedResult) {
    sendJson(res, 404, { error: "结果已过期，请重新搜索" });
    logger.info("校验字幕候选完成: missing");
    return;
  }

  // 4.5.2 拉取并校验实际字幕
  try {
    const validated = await getValidatedSubtitlePayload({ ...cachedResult }, language, "");
    sendJson(res, 200, { valid: true, fileName: validated.payload.fileName, validation: validated.validation });
    logger.info("校验字幕候选完成: valid");
  } catch (error) {
    sendJson(res, 422, { valid: false, error: "字幕校验失败", detail: String(error?.message || error) });
    logger.info("校验字幕候选完成: invalid", error.message);
  }
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
  const conversion = normalizeConversionTarget(url.searchParams.get("convert"));
  const cachedResult = RESULT_CACHE.get(id);
  if (!cachedResult) {
    sendJson(res, 404, { error: "结果已过期，请重新搜索" });
    logger.info("下载字幕完成: 未找到结果");
    return;
  }
  const result = { ...cachedResult };

  // 5.2 校验并返回文件字节
  let validated;
  try {
    validated = await getValidatedSubtitlePayload(result, language, conversion);
  } catch (error) {
    sendJson(res, 422, { error: "字幕校验失败", detail: String(error?.message || error) });
    logger.info("下载字幕完成: 校验失败", error.message);
    return;
  }
  const payload = validated.payload;
  res.writeHead(200, withCorsHeaders({
    "content-type": payload.contentType || "application/octet-stream",
    "content-length": payload.buffer.length,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.fileName)}`,
    "cache-control": "no-store",
  }));
  res.end(payload.buffer);
  logger.info(`下载字幕完成: ${payload.fileName}`);
}

async function getValidatedSubtitlePayload(result, language, conversion) {
  /*
   * ================================================================================
   * 步骤5.5：读取有效字幕内容
   * ================================================================================
   * 目标：
   * 1) 短期复用同一结果的下载字节、解码文本和校验摘要
   * 2) 转换简繁体时生成独立 UTF-8 字幕，不修改原始文件
   */
  logger.info("开始读取有效字幕内容...");

  // 5.5.1 读取或创建原字幕缓存
  const cacheKey = `${result.id}|${language}`;
  pruneSubtitlePayloadCache();
  let original = SUBTITLE_PAYLOAD_CACHE.get(cacheKey);
  if (!original || original.expiresAt <= Date.now()) {
    const payload = await fetchSubtitleBytes(result, language);
    const decoded = decodeSubtitle(payload.buffer, payload.contentType, language);
    const validation = validateSubtitleText(decoded.text, {
      fileName: payload.fileName,
      contentType: payload.contentType,
      language,
    });
    if (!validation.valid) throw new Error(validation.message || "字幕结构无效");
    const normalizedPayload = normalizeSubtitlePayload(payload, decoded);
    original = { payload: normalizedPayload, decoded, validation, expiresAt: Date.now() + SUBTITLE_PAYLOAD_CACHE_TTL_MS };
    SUBTITLE_PAYLOAD_CACHE.delete(cacheKey);
    SUBTITLE_PAYLOAD_CACHE.set(cacheKey, original);
    pruneSubtitlePayloadCache();
  }

  // 5.5.2 原文请求直接返回已校验内容
  if (!conversion) {
    logger.info("读取有效字幕内容完成: original");
    return original;
  }

  // 5.5.3 用 OpenCC 生成独立 UTF-8 文件并再次校验
  const convertedText = convertSubtitleChinese(original.decoded.text, conversion, {
    customDictionary: runtimePreferences.customDictionary,
  });
  const convertedFileName = buildConvertedSubtitleFileName(original.payload.fileName, conversion);
  const convertedValidation = validateSubtitleText(convertedText, {
    fileName: convertedFileName,
    contentType: "text/plain; charset=utf-8",
    language: conversion,
  });
  if (!convertedValidation.valid) throw new Error(convertedValidation.message || "转换后的字幕结构无效");
  const converted = {
    payload: {
      buffer: Buffer.from(convertedText, "utf8"),
      contentType: getSubtitleContentType(convertedFileName),
      fileName: convertedFileName,
    },
    decoded: { text: convertedText, encoding: "utf-8" },
    validation: convertedValidation,
  };
  logger.info("读取有效字幕内容完成", conversion);
  return converted;
}

export function normalizeSubtitlePayload(payload, decoded) {
  /*
   * ================================================================================
   * 步骤5.5.1：统一下载字幕编码
   * ================================================================================
   * 目标：
   * 1) 将已校验的字幕文本重新编码为 UTF-8
   * 2) 让 Android 保存后的字幕可被常见播放器直接读取
   */
  logger.info("开始统一下载字幕编码...");

  // 5.5.1.1 保留文件名，并用 UTF-8 文本替换来源原始字节
  const result = {
    ...payload,
    buffer: Buffer.from(String(decoded?.text || ""), "utf8"),
    contentType: getSubtitleContentType(payload?.fileName),
  };

  logger.info("统一下载字幕编码完成", result.buffer.length);
  return result;
}

function normalizeConversionTarget(value) {
  // 5.5.4 只接受界面支持的简繁转换目标
  return value === "zh-CN" || value === "zh-TW" ? value : "";
}

function pruneSubtitlePayloadCache() {
  // 5.5.5 删除过期字节并限制内存占用条目数
  const now = Date.now();
  for (const [key, entry] of SUBTITLE_PAYLOAD_CACHE) {
    if (!entry || entry.expiresAt <= now) SUBTITLE_PAYLOAD_CACHE.delete(key);
  }
  while (SUBTITLE_PAYLOAD_CACHE.size > MAX_SUBTITLE_PAYLOAD_CACHE_ENTRIES) {
    SUBTITLE_PAYLOAD_CACHE.delete(SUBTITLE_PAYLOAD_CACHE.keys().next().value);
  }
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
  const results = list.slice(0, limit).map((item) => {
    const title = repairMojibakeText(item.name || query);
    return {
      source: "thunder",
      sourceLabel: "迅雷字幕",
      title,
      fileName: sanitizeFileName(title || `${query}.${item.ext || "srt"}`),
      ext: item.ext || "srt",
      language: Array.isArray(item.languages) ? item.languages.filter(Boolean).map(repairMojibakeText).join(", ") : "",
      score: Number(item.score || item.fingerprintf_score || 0),
      downloads: "",
      size: "",
      duration: formatDuration(Number(item.duration || 0)),
      extra: repairMojibakeText(item.extra_name || ""),
      downloadUrl: item.url,
      detailUrl: item.url,
    };
  });

  logger.info(`查询迅雷字幕源完成: ${results.length} 条`);
  return results;
}

async function searchShooterFingerprint(fileHash, videoFileName, language, limit) {
  /*
   * ================================================================================
   * 步骤6.3：按视频指纹查询射手网
   * ================================================================================
   * 目标：
   * 1) 使用 ChineseSubFinder 同款四段 MD5 文件指纹
   * 2) 只在用户选择本地视频后调用公开接口
   */
  logger.info("开始按视频指纹查询射手网...");

  // 6.3.1 校验文件指纹
  if (!fileHash) {
    logger.info("按视频指纹查询射手网完成: 缺少指纹");
    return [];
  }

  // 6.3.2 提交表单查询
  const body = new URLSearchParams({
    filehash: fileHash,
    pathinfo: videoFileName || "video.mkv",
    format: "json",
    lang: language.startsWith("zh") ? "Chn" : language,
  }).toString();
  const response = await fetchWithTimeout(SHOOTER_API_URL, {
    method: "POST",
    headers: {
      ...browserHeaders,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await response.json();

  // 6.3.3 展开接口返回的字幕文件
  const results = [];
  for (const [groupIndex, group] of (Array.isArray(json) ? json : []).entries()) {
    for (const [fileIndex, file] of (Array.isArray(group?.Files) ? group.Files : []).entries()) {
      if (!file?.Link) continue;
      const extension = String(file.Ext || "srt").replace(/^\./, "");
      const fileName = sanitizeFileName(`${path.basename(videoFileName, path.extname(videoFileName))}.shooter-${groupIndex + 1}-${fileIndex + 1}.${extension}`);
      results.push({
        source: "shooter",
        sourceLabel: "射手网指纹",
        title: `${videoFileName} · 射手网匹配 ${groupIndex + 1}`,
        fileName,
        ext: extension,
        language: language.startsWith("zh") ? "中文" : language,
        score: 0,
        downloads: "",
        size: "",
        duration: "",
        extra: Number(group.Delay || 0) ? `时间偏移 ${group.Delay}ms` : "视频指纹精准匹配",
        fingerprintMatch: true,
        downloadUrl: file.Link,
        detailUrl: file.Link,
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  logger.info(`按视频指纹查询射手网完成: ${results.length} 条`);
  return results;
}

async function searchThunderFingerprint(cid, videoFileName, limit) {
  /*
   * ================================================================================
   * 步骤6.4：按视频 CID 查询迅雷字幕
   * ================================================================================
   * 目标：
   * 1) 使用 ChineseSubFinder 同款三段 SHA1 视频 CID
   * 2) 返回与具体视频字节匹配的迅雷字幕
   */
  logger.info("开始按视频 CID 查询迅雷字幕...");

  // 6.4.1 校验 CID 并请求公开接口
  if (!cid) {
    logger.info("按视频 CID 查询迅雷字幕完成: 缺少 CID");
    return [];
  }
  const response = await fetchWithTimeout(`${XUNLEI_FINGERPRINT_URL}/${encodeURIComponent(cid)}.json`, {
    headers: browserHeaders,
  });
  const json = await response.json();

  // 6.4.2 清洗并转换字幕结果
  const results = (Array.isArray(json?.sublist) ? json.sublist : [])
    .filter((item) => item?.surl && item?.sname)
    .slice(0, limit)
    .map((item) => ({
      source: "thunder-fingerprint",
      sourceLabel: "迅雷指纹",
      title: decodePossiblyMojibake(item.sname) || videoFileName,
      fileName: sanitizeFileName(decodePossiblyMojibake(item.sname) || `${videoFileName}.srt`),
      ext: path.extname(item.sname || item.surl).replace(".", "") || "srt",
      language: decodePossiblyMojibake(item.language) || "未知",
      score: Number(item.svote || item.rate || 0),
      downloads: "",
      size: "",
      duration: "",
      extra: "视频 CID 精准匹配",
      fingerprintMatch: true,
      downloadUrl: String(item.surl).replace(/\\\//g, "/"),
      detailUrl: String(item.surl).replace(/\\\//g, "/"),
    }));

  logger.info(`按视频 CID 查询迅雷字幕完成: ${results.length} 条`);
  return results;
}

function decodePossiblyMojibake(value) {
  // 6.4.3 修复迅雷旧接口把 UTF-8 当单字节编码解码的文本
  return repairMojibakeText(value);
}

async function searchAssrt(query, language, token, limit) {
  /*
   * ================================================================================
   * 步骤6.5：查询 ASSRT 字幕源
   * ================================================================================
   * 目标：
   * 1) 配置 Token 时优先查询官方 API
   * 2) 未配置 Token、API 失败或无结果时查询公开网页
   */
  logger.info("开始查询 ASSRT 字幕源...");

  // 6.5.1 有 Token 时优先使用官方 API
  if (token) {
    try {
      const apiResults = await searchAssrtApi(query, language, token, limit);
      if (apiResults.length) {
        logger.info(`查询 ASSRT 字幕源完成: API ${apiResults.length} 条`);
        return apiResults;
      }
      logger.info("ASSRT API 无匹配结果，切换公开网页");
    } catch (error) {
      logger.warn("ASSRT API 查询失败，切换公开网页", error.message);
    }
  }

  // 6.5.2 查询无需 Token 的公开网页
  const webResults = await searchAssrtWeb(query, language, limit);
  logger.info(`查询 ASSRT 字幕源完成: 网页 ${webResults.length} 条`);
  return webResults;
}

async function searchAssrtApi(query, language, token, limit) {
  /*
   * ================================================================================
   * 步骤6.5.3：查询 ASSRT 官方 API
   * ================================================================================
   * 目标：
   * 1) 使用用户自己的 Token 查询结构化接口
   * 2) 只缓存字幕 ID，下载时再换取临时链接
   */
  logger.info("开始查询 ASSRT 官方 API...");

  // 6.5.3.1 请求搜索接口并校验业务状态
  const searchUrl = new URL(`${ASSRT_API_URL}/sub/search`);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("cnt", String(clamp(limit, 1, 15)));
  searchUrl.searchParams.set("pos", "0");
  searchUrl.searchParams.set("token", token);
  const response = await fetchWithTimeout(searchUrl.href, { headers: browserHeaders, timeoutMs: 4000 });
  const json = await response.json();
  if (json?.status && Number(json.status) !== 0) {
    throw new Error(`ASSRT API: ${String(json.errmsg || json.status)}`);
  }
  const items = Array.isArray(json?.sub?.subs) ? json.sub.subs : [];

  // 6.5.3.2 转换搜索结果并保留字幕 ID
  const results = items
    .filter((item) => assrtLanguageMatches(item?.lang, language))
    .slice(0, limit)
    .map((item) => {
      const title = item.native_name || item.videoname || `${query}.${item.subtype || "srt"}`;
      return {
        source: "assrt",
        sourceLabel: "ASSRT",
        title,
        fileName: sanitizeFileName(item.native_name || `${title}.${item.subtype || "srt"}`),
        ext: item.subtype || path.extname(item.native_name || "").replace(".", "") || "srt",
        language: item.lang?.desc || language,
        score: Number(item.vote_score || 0),
        downloads: "",
        size: "",
        duration: "",
        extra: ["API", item.release_site, item.upload_time].filter(Boolean).join(" · "),
        downloadUrl: "",
        detailUrl: `${ASSRT_API_URL}/sub/detail?id=${encodeURIComponent(item.id)}`,
        assrtId: Number(item.id),
        assrtToken: token,
      };
    });

  logger.info(`查询 ASSRT 官方 API 完成: ${results.length} 条`);
  return results;
}

function assrtLanguageMatches(lang, requestedLanguage) {
  // 6.5.3.3 按 ASSRT API 语言布尔值筛选目标语言
  const flags = lang?.langlist || {};
  if (requestedLanguage === "zh-CN") return Boolean(flags.langchs || flags.langdou);
  if (requestedLanguage === "zh-TW") return Boolean(flags.langcht || flags.langdou);
  if (requestedLanguage === "en") return Boolean(flags.langeng);
  if (requestedLanguage === "ja") return Boolean(flags.langjpn);
  return true;
}

async function searchAssrtWeb(query, language, limit) {
  /*
   * ================================================================================
   * 步骤6.5.4：查询 ASSRT 公开网页
   * ================================================================================
   * 目标：
   * 1) 无需 Token 读取公开搜索结果
   * 2) 保留公开下载地址供预览和下载复用
   */
  logger.info("开始查询 ASSRT 公开网页...");

  // 6.5.4.1 请求公开搜索页
  const searchUrl = new URL("/sub/", ASSRT_BASE_URL);
  searchUrl.searchParams.set("searchword", query);
  const response = await fetchWithTimeout(searchUrl.href, {
    headers: { ...browserHeaders, referer: ASSRT_BASE_URL },
    timeoutMs: 4500,
  });
  const html = await response.text();

  // 6.5.4.2 解析并筛选目标语言
  const results = parseAssrtWebSearchResults(html, language, limit);
  logger.info(`查询 ASSRT 公开网页完成: ${results.length} 条`);
  return results;
}

export function parseAssrtWebSearchResults(html, language, limit = 15) {
  /*
   * ================================================================================
   * 步骤6.5.5：解析 ASSRT 公开搜索页
   * ================================================================================
   * 目标：
   * 1) 从每个搜索卡片提取标题、语言、格式和下载地址
   * 2) 过滤不符合目标语言的结果并去重
   */
  logger.info("开始解析 ASSRT 公开搜索页...");

  // 6.5.5.1 按详情标题锚点划分结果卡片
  const source = String(html || "");
  const titleMatches = [...source.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bintrotitle\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  const unique = new Map();
  for (const [index, match] of titleMatches.entries()) {
    const cardEnd = titleMatches[index + 1]?.index ?? source.length;
    const card = source.slice(match.index, cardEnd);
    const detailHref = matchFirst(match[1], /\bhref=["']([^"']+)["']/i);
    const downloadHref = matchFirst(card, /["']([^"']*\/download\/[^"']+)["']/i);
    if (!detailHref || !downloadHref) continue;

    // 6.5.5.2 读取卡片展示字段
    const titleAttribute = matchFirst(match[1], /\btitle=["']([^"']+)["']/i);
    const title = htmlDecode(titleAttribute || stripTags(match[2])).replace(/\s+/g, " ").trim();
    const cardText = htmlDecode(stripTags(card)).replace(/\s+/g, " ").trim();
    const release = matchFirst(cardText, /版本[：:]\s*(.*?)\s*(?:格式[：:]|语言[：:]|来源[：:]|日期[：:]|$)/i).trim();
    const format = matchFirst(cardText, /格式[：:]\s*([A-Za-z0-9+.-]+)/i).trim();
    const resultLanguage = matchFirst(cardText, /语言[：:]\s*(.*?)\s*(?:来源[：:]|日期[：:]|查阅次数[：:]|下载次数[：:]|$)/i).trim();
    if (!assrtWebLanguageMatches(resultLanguage, language)) continue;

    // 6.5.5.3 转换下载字段并按详情地址去重
    const detailUrl = new URL(htmlDecode(detailHref), ASSRT_BASE_URL).href;
    const downloadUrl = new URL(htmlDecode(downloadHref), ASSRT_BASE_URL).href;
    const remoteFileName = decodeUrlFileName(downloadUrl);
    const origin = matchFirst(cardText, /来源[：:]\s*(.*?)\s*(?:日期[：:]|查阅次数[：:]|下载次数[：:]|$)/i).trim();
    const uploadDate = matchFirst(cardText, /日期[：:]\s*([0-9-]+(?:\s+[0-9:]+)?)/i).trim();
    const downloads = matchFirst(cardText, /下载次数[：:]\s*(\d+)/i).trim();
    unique.set(detailUrl, {
      source: "assrt",
      sourceLabel: "ASSRT",
      title: title || release || remoteFileName,
      fileName: sanitizeFileName(remoteFileName || `${title || "subtitle"}.${format.toLowerCase() || "srt"}`),
      ext: path.extname(remoteFileName).replace(".", "") || format.toLowerCase() || "srt",
      language: resultLanguage || language,
      score: 0,
      downloads,
      size: "",
      duration: "",
      extra: ["网页", release, origin, uploadDate].filter(Boolean).join(" · "),
      downloadUrl,
      detailUrl,
      assrtChannel: "web",
    });
    if (unique.size >= limit) break;
  }

  const results = [...unique.values()];
  logger.info(`解析 ASSRT 公开搜索页完成: ${results.length} 条`);
  return results;
}

function assrtWebLanguageMatches(value, requestedLanguage) {
  // 6.5.5.4 按网页语言标签筛选目标语言
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ");
  if (!text) return true;
  if (requestedLanguage === "zh-CN") return /简|双语|chs|simplified|chinese/.test(text);
  if (requestedLanguage === "zh-TW") return /繁|双语|cht|traditional|chinese/.test(text);
  if (requestedLanguage === "en") return /英|双语|eng|english/.test(text);
  if (requestedLanguage === "ja") return /日|jpn|japanese/.test(text);
  return true;
}

function decodeUrlFileName(value) {
  // 6.5.5.5 安全解码下载地址中的文件名
  const fileName = path.basename(new URL(value).pathname);
  try {
    return repairMojibakeText(decodeURIComponent(fileName));
  } catch {
    return repairMojibakeText(fileName);
  }
}

async function searchSubHd(query, language, limit) {
  /*
   * ================================================================================
   * 步骤7：查询 SubHD
   * ================================================================================
   * 目标：
   * 1) 请求当前可配置站点的搜索页
   * 2) 解析标题、语言、格式、下载数和详情页
   */
  logger.info("开始查询 SubHD...");

  // 7.1 请求搜索页
  const baseUrl = SUBHD_BASE_URL;
  const searchUrl = new URL(`/search/${encodeURIComponent(query)}`, `${baseUrl}/`).href;
  const response = await fetchWithTimeout(searchUrl, {
    headers: { ...browserHeaders, referer: `${baseUrl}/` },
  });
  const html = await response.text();

  // 7.2 解析并按目标语言筛选
  const results = parseSubHdSearchResults(html, baseUrl, language, limit);
  logger.info(`查询 SubHD 完成: ${results.length} 条`);
  return results;
}

export function parseSubHdSearchResults(html, baseUrl = SUBHD_BASE_URL, language = "zh-CN", limit = 40) {
  /*
   * ================================================================================
   * 步骤7.3：解析 SubHD 搜索结果
   * ================================================================================
   * 目标：
   * 1) 以字幕详情链接为边界提取结果卡片
   * 2) 去重并保留搜索页公开的质量字段
   */
  logger.info("开始解析 SubHD 搜索结果...");

  // 7.3.1 定位每个唯一字幕详情链接
  const source = String(html || "");
  const links = [...source.matchAll(/<a\b([^>]*\bhref=["'](\/a\/[A-Za-z0-9_-]+)["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  const uniqueLinks = [];
  const seen = new Set();
  for (const match of links) {
    const href = htmlDecode(match[2]);
    if (seen.has(href)) continue;
    seen.add(href);
    uniqueLinks.push({ match, href });
  }

  // 7.3.2 截取卡片并转换为统一结果
  const results = [];
  for (let index = 0; index < uniqueLinks.length && results.length < limit; index += 1) {
    const current = uniqueLinks[index];
    const start = source.lastIndexOf('<div class="bg-white', current.match.index);
    const nextStart = index + 1 < uniqueLinks.length
      ? source.lastIndexOf('<div class="bg-white', uniqueLinks[index + 1].match.index)
      : source.length;
    const card = source.slice(Math.max(0, start), Math.max(current.match.index + current.match[0].length, nextStart));
    const parsed = parseSubHdResultCard(card, current.href, baseUrl, language);
    if (parsed) results.push(parsed);
  }

  logger.info(`解析 SubHD 搜索结果完成: ${results.length} 条`);
  return results;
}

function parseSubHdResultCard(card, href, baseUrl, requestedLanguage) {
  // 7.3.3 提取一张字幕卡片的展示字段
  const detailPattern = new RegExp(`<a\\b[^>]*href=["']${escapeRegExp(href)}["'][^>]*>([\\s\\S]*?)<\\/a>`, "i");
  const titles = [...String(card || "").matchAll(new RegExp(detailPattern.source, "gi"))]
    .map((match) => htmlDecode(stripTags(match[1])).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!titles.length) return null;

  const tagArea = matchFirst(card, /<div\b[^>]*class=["'][^"']*text-truncate[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const tags = [...tagArea.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => htmlDecode(stripTags(match[1])).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const languageText = tags.filter((item) => /双语|简体|繁体|英语|英文|日语|日文|中英|英中/i.test(item)).join(" ");
  if (!subHdLanguageMatches(languageText, requestedLanguage)) return null;

  const format = tags.find((item) => /^(?:SRT|ASS|SSA|VTT|SUB|ZIP|RAR|7Z)(?:\s*\/\s*(?:SRT|ASS|SSA|VTT|SUB))?$/i.test(item)) || "";
  const metrics = [...String(card || "").matchAll(/<span\b[^>]*class=["'][^"']*align-text-top[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => htmlDecode(stripTags(match[1])).replace(/\s+/g, " ").trim());
  const title = titles.join(" · ");
  const subtitleId = href.split("/").filter(Boolean).pop() || "";
  return {
    source: "subhd",
    sourceLabel: "SubHD",
    title,
    fileName: sanitizeFileName(`${title}.${format.split("/")[0].trim().toLowerCase() || "srt"}`),
    ext: format.split("/")[0].trim().toLowerCase() || "srt",
    language: languageText || requestedLanguage,
    score: "",
    downloads: metrics[1] || "",
    size: metrics[0] || "",
    duration: "",
    extra: tags.join(" · "),
    downloadUrl: "",
    detailUrl: new URL(href, `${baseUrl}/`).href,
    subHdId: subtitleId,
    subHdBaseUrl: new URL(baseUrl).origin,
  };
}

function subHdLanguageMatches(value, requestedLanguage) {
  // 7.3.4 只排除明确不匹配的语言，未知标签仍允许后续内容校验
  const text = String(value || "").toLowerCase();
  if (!text) return true;
  if (requestedLanguage === "zh-CN") return /简|双语|中英|英中|中文|chinese/.test(text);
  if (requestedLanguage === "zh-TW") return /繁|双语|中英|英中|中文|chinese/.test(text);
  if (requestedLanguage === "en") return /英|双语|english|中英|英中/.test(text);
  if (requestedLanguage === "ja") return /日|japanese/.test(text);
  return true;
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

async function searchAddic7ed(query, language, limit) {
  /*
   * ================================================================================
   * 步骤12：查询 Addic7ed 字幕源
   * ================================================================================
   * 目标：
   * 1) 搜索英文剧集字幕
   * 2) 解析季页表格中的直接下载链接
   */
  logger.info("开始查询 Addic7ed 字幕源...");

  // 12.1 Addic7ed 只作为英文字幕源
  if (language !== "en") {
    logger.info("查询 Addic7ed 字幕源完成: 语言不支持");
    return [];
  }

  // 12.2 查找剧集页面
  const episode = parseEpisodeQuery(query);
  const show = await fetchAddic7edShow(query);
  if (!show?.id) {
    logger.info("查询 Addic7ed 字幕源完成: 未找到剧集");
    return [];
  }

  // 12.3 拉取季页结果
  const seasons = episode.season ? [episode.season] : show.seasons.slice(0, Math.max(1, Math.min(show.seasons.length, 5)));
  const results = [];
  for (const season of seasons) {
    const seasonHtml = await fetchAddic7edSeasonHtml(show.id, season, show.pageUrl);
    results.push(...parseAddic7edRows(seasonHtml, show, season, episode));
    if (results.length >= limit) break;
  }

  logger.info(`查询 Addic7ed 字幕源完成: ${results.length} 条`);
  return results.slice(0, limit);
}

async function fetchAddic7edShow(query) {
  /*
   * ================================================================================
   * 步骤13：查找 Addic7ed 剧集
   * ================================================================================
   * 目标：
   * 1) 用搜索页定位 /show/{id}
   * 2) 解析剧名和可用季数
   */
  logger.info("开始查找 Addic7ed 剧集...");

  // 13.1 请求搜索页
  const searchUrl = `${ADDIC7ED_BASE_URL}/search.php?search=${encodeURIComponent(stripEpisodeTokens(query).trim() || query)}&Submit=Search`;
  const response = await fetchWithTimeout(searchUrl, {
    headers: { ...browserHeaders, referer: ADDIC7ED_BASE_URL },
    allowErrorStatus: true,
    timeoutMs: ADDIC7ED_TIMEOUT_MS,
  });
  if (!response.ok) {
    logger.info("查找 Addic7ed 剧集完成: 搜索失败", response.status);
    return null;
  }
  const html = await response.text();

  // 13.2 提取剧集 ID 和标题
  const id =
    matchFirst(response.url, /\/show\/(\d+)/i) ||
    matchFirst(html, /\/show\/(\d+)/i) ||
    matchFirst(html, /loadShow\((\d+),\s*\d+/i);
  if (!id) {
    logger.info("查找 Addic7ed 剧集完成: empty");
    return null;
  }

  const title =
    htmlDecode(stripTags(matchFirst(html, /<font[^>]*>\s*([^<]+?)\s+subtitles\s*<\/font>/i))).trim() ||
    htmlDecode(matchFirst(html, /Download\s+(.+?)\s+subtitles/i)).trim() ||
    stripEpisodeTokens(query).trim();
  const seasons = [...html.matchAll(new RegExp(`loadShow\\(${escapeRegExp(id)},\\s*(\\d+)`, "gi"))]
    .map((match) => Number(match[1]))
    .filter((item) => Number.isFinite(item) && item > 0);

  const show = {
    id,
    title,
    pageUrl: new URL(`/show/${id}`, ADDIC7ED_BASE_URL).href,
    seasons: seasons.length ? [...new Set(seasons)].sort((left, right) => left - right) : [1],
  };

  logger.info("查找 Addic7ed 剧集完成", show.title);
  return show;
}

async function fetchAddic7edSeasonHtml(showId, season, referer) {
  /*
   * ================================================================================
   * 步骤14：请求 Addic7ed 季页
   * ================================================================================
   * 目标：
   * 1) 调用站点 Ajax 季页接口
   * 2) 返回包含字幕行的 HTML 表格
   */
  logger.info("开始请求 Addic7ed 季页...", showId, season);

  // 14.1 请求 Ajax 接口
  const url = `${ADDIC7ED_BASE_URL}/ajax_loadShow.php?show=${encodeURIComponent(showId)}&season=${encodeURIComponent(season)}&langs=&hd=0&hi=0`;
  const response = await fetchWithTimeout(url, {
    headers: { ...browserHeaders, referer: referer || ADDIC7ED_BASE_URL, "x-requested-with": "XMLHttpRequest" },
    timeoutMs: ADDIC7ED_TIMEOUT_MS,
  });
  const html = await response.text();

  logger.info("请求 Addic7ed 季页完成", showId, season);
  return html;
}

function parseAddic7edRows(html, show, season, requestedEpisode) {
  /*
   * ================================================================================
   * 步骤15：解析 Addic7ed 字幕行
   * ================================================================================
   * 目标：
   * 1) 从季页表格提取英文字幕
   * 2) 转成统一搜索结果结构
   */
  logger.info("开始解析 Addic7ed 字幕行...");

  // 15.1 遍历完成状态的表格行
  const rows = [...String(html || "").matchAll(/<tr\b[^>]*class=["'][^"']*completed[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)];
  const results = [];
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 10) continue;

    // 15.2 提取字段并过滤语言、集数
    const episodeNumber = Number(htmlDecode(stripTags(cells[1])).trim());
    if (requestedEpisode?.episode && episodeNumber !== requestedEpisode.episode) continue;
    const language = htmlDecode(stripTags(cells[3])).replace(/\s+/g, " ").trim();
    if (language !== "English") continue;
    const href = matchFirst(cells[9], /href=["']([^"']+)["']/i);
    if (!href) continue;

    const title = htmlDecode(stripTags(cells[2])).replace(/\s+/g, " ").trim();
    const version = htmlDecode(stripTags(cells[4])).replace(/\s+/g, " ").trim();
    const completed = htmlDecode(stripTags(cells[5])).replace(/\s+/g, " ").trim();
    const displayTitle = `${show.title} S${String(season).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")} ${title}`.trim();

    results.push({
      source: "addic7ed",
      sourceLabel: "Addic7ed",
      title: displayTitle,
      fileName: sanitizeFileName(`${displayTitle}.${language}.srt`),
      ext: "srt",
      language,
      score: completed || "",
      downloads: "",
      size: "",
      duration: "",
      extra: version,
      downloadUrl: new URL(htmlDecode(href), ADDIC7ED_BASE_URL).href,
      detailUrl: show.pageUrl,
    });
  }

  logger.info(`解析 Addic7ed 字幕行完成: ${results.length} 条`);
  return results;
}

async function searchAvSubtitles(query, language, limit) {
  /*
   * ================================================================================
   * 步骤16：查询 AVSubtitles 字幕源
   * ================================================================================
   * 目标：
   * 1) 按编号或关键词搜索专项字幕
   * 2) 解析电影详情页中的语言字幕入口
   */
  logger.info("开始查询 AVSubtitles 字幕源...");

  // 16.1 映射语言
  const languageCode = getAvSubtitlesLanguageCode(language);
  if (!languageCode) {
    logger.info("查询 AVSubtitles 字幕源完成: 语言不支持");
    return [];
  }

  // 16.2 按编号变体请求搜索页
  const catalogCode = extractCatalogCode(query);
  const searchTerms = buildCatalogCodeSearchTerms(query);
  const movieMap = new Map();
  let lastSearchUrl = `${AV_SUBTITLES_BASE_URL}/search`;
  for (const searchTerm of searchTerms) {
    const searchUrl = `${AV_SUBTITLES_BASE_URL}/search_results.php?search=${encodeURIComponent(searchTerm)}&category=jav&language=${encodeURIComponent(languageCode)}`;
    const response = await fetchWithTimeout(searchUrl, {
      headers: { ...browserHeaders, referer: `${AV_SUBTITLES_BASE_URL}/search` },
    });
    const html = await response.text();
    const movies = parseAvSubtitlesSearchResults(html, query, limit, catalogCode);
    for (const movie of movies) {
      if (!movieMap.has(movie.detailUrl)) {
        movieMap.set(movie.detailUrl, movie);
      }
    }
    lastSearchUrl = searchUrl;
    if (movieMap.size) break;
  }
  const movies = [...movieMap.values()];

  // 16.3 拉取详情页并解析字幕入口
  const results = [];
  for (const movie of movies.slice(0, 6)) {
    const detailResponse = await fetchWithTimeout(movie.detailUrl, {
      headers: { ...browserHeaders, referer: lastSearchUrl },
    });
    const detailHtml = await detailResponse.text();
    results.push(...parseAvSubtitlesDetail(detailHtml, movie, languageCode));
    if (results.length >= limit) break;
  }

  logger.info(`查询 AVSubtitles 字幕源完成: ${results.length} 条`);
  return results.slice(0, limit);
}

function getAvSubtitlesLanguageCode(language) {
  // 16.4 映射 AVSubtitles 语言代码
  return (
    {
      "zh-CN": "zh",
      "zh-TW": "zh",
      en: "en",
      ja: "ja",
    }[language] || ""
  );
}

function parseAvSubtitlesSearchResults(html, query, limit, catalogCode = "") {
  /*
   * ================================================================================
   * 步骤17：解析 AVSubtitles 搜索结果
   * ================================================================================
   * 目标：
   * 1) 提取电影详情页链接
   * 2) 用编号做相关性过滤
   */
  logger.info("开始解析 AVSubtitles 搜索结果...");

  // 17.1 提取搜索结果链接
  const code = catalogCode || extractCatalogCode(query);
  const unique = new Map();
  for (const match of String(html || "").matchAll(/<a\b[^>]*href=["']([^"']*\/movie\d+\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = htmlDecode(match[1]);
    const title = htmlDecode(stripTags(match[2])).replace(/\s+/g, " ").trim();
    if (!title) continue;
    if (code && !normalizeCatalogCode(title).includes(code)) continue;
    const detailUrl = new URL(href, AV_SUBTITLES_BASE_URL).href;
    if (!unique.has(detailUrl)) unique.set(detailUrl, { title, detailUrl });
    if (unique.size >= limit) break;
  }

  logger.info(`解析 AVSubtitles 搜索结果完成: ${unique.size} 条`);
  return [...unique.values()];
}

function parseAvSubtitlesDetail(html, movie, languageCode) {
  /*
   * ================================================================================
   * 步骤18：解析 AVSubtitles 详情页
   * ================================================================================
   * 目标：
   * 1) 读取指定语言字幕详情入口
   * 2) 转成统一搜索结果结构
   */
  logger.info("开始解析 AVSubtitles 详情页...");

  // 18.1 提取字幕入口
  const results = [];
  const pattern = new RegExp(`href=["']([^"']*/subtitles/${escapeRegExp(languageCode)}/\\d+)["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
  for (const match of String(html || "").matchAll(pattern)) {
    const detailUrl = new URL(htmlDecode(match[1]), AV_SUBTITLES_BASE_URL).href;
    const label = htmlDecode(stripTags(match[2])).replace(/\s+/g, " ").trim();
    const title = movie.title || htmlDecode(matchFirst(html, /<title[^>]*>Subtitles for\s+([\s\S]*?)<\/title>/i)).trim();
    results.push({
      source: "avsubtitles",
      sourceLabel: "AVSubtitles",
      title,
      fileName: sanitizeFileName(`${title}.${languageCode}.srt`),
      ext: "srt",
      language: languageCode,
      score: "",
      downloads: "",
      size: "",
      duration: "",
      extra: label || "Info / Download",
      downloadUrl: "",
      detailUrl,
    });
  }

  logger.info(`解析 AVSubtitles 详情页完成: ${results.length} 条`);
  return dedupeSearchResults(results);
}

async function searchAiyi(query, language, limit) {
  /*
   * ================================================================================
   * 步骤19：查询爱译网字幕源
   * ================================================================================
   * 目标：
   * 1) 按编号搜索中文简体字幕
   * 2) 解析文章中的直链字幕文件
   */
  logger.info("开始查询爱译网字幕源...");

  // 19.1 爱译网当前主要提供中文简体字幕
  if (language !== "zh-CN" && language !== "zh-TW") {
    logger.info("查询爱译网字幕源完成: 语言不支持");
    return [];
  }

  // 19.2 搜索并严格过滤编号
  const code = extractCatalogCode(query);
  if (!code) {
    logger.info("查询爱译网字幕源完成: 缺少编号");
    return [];
  }
  const searchTerms = buildCatalogCodeSearchTerms(query);
  let searchUrl = `${AIYI_BASE_URL}/?s=${encodeURIComponent(formatCatalogCode(code, "-"))}`;
  let posts = [];
  for (const searchTerm of searchTerms) {
    const apiUrl = new URL("/wp-json/wp/v2/search", AIYI_BASE_URL);
    apiUrl.searchParams.set("search", searchTerm);
    apiUrl.searchParams.set("per_page", String(clamp(limit, 1, 10)));
    apiUrl.searchParams.set("type", "post");
    apiUrl.searchParams.set("subtype", "post");
    try {
      const response = await fetchWithTimeout(apiUrl.href, {
        headers: { ...browserHeaders, accept: "application/json,text/plain,*/*", referer: AIYI_BASE_URL },
      });
      const payload = await response.json();
      posts = parseAiyiSearchApiResults(payload, code, limit);
      searchUrl = apiUrl.href;
      if (posts.length) break;
    } catch (error) {
      logger.warn("爱译网 API 搜索失败", error?.message || error);
    }
  }

  // 19.3 接口没有命中时回退 HTML 搜索页
  if (!posts.length) {
    for (const searchTerm of searchTerms) {
      searchUrl = `${AIYI_BASE_URL}/?s=${encodeURIComponent(searchTerm)}`;
      const response = await fetchWithTimeout(searchUrl, {
        headers: { ...browserHeaders, referer: AIYI_BASE_URL },
      });
      const html = await response.text();
      posts = parseAiyiSearchResults(html, code, limit);
      if (posts.length) break;
    }
  }

  // 19.4 解析文章详情
  const results = [];
  for (const post of posts.slice(0, 8)) {
    const detailResponse = await fetchWithTimeout(post.detailUrl, {
      headers: { ...browserHeaders, referer: searchUrl },
    });
    const detailHtml = await detailResponse.text();
    const parsed = parseAiyiDetail(detailHtml, post, code);
    if (parsed) results.push(parsed);
    if (results.length >= limit) break;
  }

  logger.info(`查询爱译网字幕源完成: ${results.length} 条`);
  return results;
}

function parseAiyiSearchApiResults(items, code, limit) {
  /*
   * ================================================================================
   * 步骤20：解析爱译网接口搜索结果
   * ================================================================================
   * 目标：
   * 1) 读取 WordPress 搜索接口中的文章链接
   * 2) 只保留编号严格匹配的结果
   */
  logger.info("开始解析爱译网接口搜索结果...");

  // 20.1 转成统一文章结构并做编号过滤
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const title = htmlDecode(String(item?.title || "")).replace(/\s+/g, " ").trim();
    const detailUrl = String(item?.url || "").trim();
    const comparable = normalizeCatalogCode(`${title} ${detailUrl}`);
    if (!detailUrl || !comparable.includes(code)) continue;
    if (!unique.has(detailUrl)) unique.set(detailUrl, { title, detailUrl });
    if (unique.size >= limit) break;
  }

  logger.info(`解析爱译网接口搜索结果完成: ${unique.size} 条`);
  return [...unique.values()];
}

function parseAiyiSearchResults(html, code, limit) {
  /*
   * ================================================================================
   * 步骤20：解析爱译网搜索结果
   * ================================================================================
   * 目标：
   * 1) 提取文章链接
   * 2) 只保留标题或链接包含目标编号的结果
   */
  logger.info("开始解析爱译网搜索结果...");

  // 20.1 提取并过滤文章链接
  const unique = new Map();
  for (const match of String(html || "").matchAll(/<a\b[^>]*href=["']([^"']*\/\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const detailUrl = new URL(htmlDecode(match[1]), AIYI_BASE_URL).href;
    const title = htmlDecode(stripTags(match[2])).replace(/\s+/g, " ").trim();
    const comparable = normalizeCatalogCode(`${title} ${detailUrl}`);
    if (!comparable.includes(code)) continue;
    if (!unique.has(detailUrl)) unique.set(detailUrl, { title, detailUrl });
    if (unique.size >= limit) break;
  }

  logger.info(`解析爱译网搜索结果完成: ${unique.size} 条`);
  return [...unique.values()];
}

function parseAiyiDetail(html, post, code) {
  /*
   * ================================================================================
   * 步骤21：解析爱译网文章详情
   * ================================================================================
   * 目标：
   * 1) 从正文找到字幕文件直链
   * 2) 读取格式、语种、匹配视频和文件名
   */
  logger.info("开始解析爱译网文章详情...");

  // 21.1 查找直链字幕文件
  const downloadHref = matchFirst(String(html || ""), /href=["']([^"']+\.(?:srt|ass|ssa|vtt|sub|zip)(?:\?[^"']*)?)["'][^>]*>\s*(?:下载字幕|Download|[^<]*)/i);
  if (!downloadHref) {
    logger.info("解析爱译网文章详情完成: 未找到直链");
    return null;
  }

  // 21.2 提取展示字段
  const title =
    htmlDecode(stripTags(matchFirst(html, /<h1\b[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i))).trim() ||
    post.title ||
    code;
  const format = htmlDecode(matchFirst(html, /字幕格式[:：]\s*([^<]+)/i)).trim();
  const subtitleLanguage = htmlDecode(matchFirst(html, /字幕语种[:：]\s*([^<]+)/i)).trim() || "中文简体";
  const matchedVideo = htmlDecode(matchFirst(html, /匹配视频[:：]\s*([^<]+)/i)).trim();
  const fileName = htmlDecode(matchFirst(html, /文件名[:：]\s*([^<]+)/i)).trim() || path.basename(new URL(downloadHref, post.detailUrl).pathname);

  logger.info("解析爱译网文章详情完成", title);
  return {
    source: "aiyi",
    sourceLabel: "爱译网",
    title,
    fileName: sanitizeFileName(fileName || `${code}.srt`),
    ext: path.extname(fileName || downloadHref).replace(".", "") || "srt",
    language: subtitleLanguage,
    score: "",
    downloads: "",
    size: "",
    duration: "",
    extra: [format, matchedVideo].filter(Boolean).join(" · "),
    downloadUrl: new URL(htmlDecode(downloadHref), post.detailUrl).href,
    detailUrl: post.detailUrl,
  };
}

export function extractCatalogCode(value) {
  // 21.3 提取编号样式代码
  const match = String(value || "").match(/\b([A-Za-z]{2,8})[-_\s]?(\d{2,6})\b/);
  return match ? `${match[1].toUpperCase()}${match[2]}` : "";
}

export function buildCatalogCodeSearchTerms(query) {
  /*
   * ================================================================================
   * 步骤21：生成编号检索词
   * ================================================================================
   * 目标：
   * 1) 兼容带横线、空格和纯连写的编号输入
   * 2) 给专项字幕源优先使用更容易命中的写法
   */
  logger.info("开始生成编号检索词...");

  // 21.1 组装多个站点更容易命中的编号写法
  const normalized = String(query || "").replace(/\s+/g, " ").trim();
  const code = extractCatalogCode(normalized);
  const terms = [];
  const addTerm = (value) => {
    const item = String(value || "").replace(/\s+/g, " ").trim();
    if (!item || terms.some((term) => term.toLowerCase() === item.toLowerCase())) return;
    terms.push(item);
  };

  addTerm(formatCatalogCode(code, "-"));
  addTerm(normalized);
  addTerm(formatCatalogCode(code, " "));
  addTerm(code);
  if (!terms.length) addTerm(normalized);

  logger.info(`生成编号检索词完成: ${terms.join(" | ")}`);
  return terms;
}

function formatCatalogCode(code, separator = "-") {
  // 21.2 生成带分隔符的编号文本
  const match = String(code || "").trim().match(/^([A-Za-z]{2,8})(\d{2,6})$/);
  if (!match) return String(code || "").trim();
  return `${match[1].toUpperCase()}${separator}${match[2]}`;
}

function normalizeCatalogCode(value) {
  // 21.4 标准化编号比较文本
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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

  // 10.1 处理需要会话的特殊源
  if (result.source === "avsubtitles") {
    const payload = await fetchAvSubtitlesPayload(result, language);
    logger.info(`拉取字幕字节完成: ${payload.fileName}`);
    return payload;
  }

  // 10.1.1 SubHD 需要沿用详情页产生的会话 Cookie
  if (result.source === "subhd") {
    const payload = await fetchSubHdPayload(result, language);
    logger.info(`拉取字幕字节完成: ${payload.fileName}`);
    return payload;
  }

  // 10.2 解析下载地址
  if (result.source === "assrt") {
    const payload = await fetchAssrtPayload(result, language);
    logger.info(`拉取字幕字节完成: ${payload.fileName}`);
    return payload;
  }

  const downloadUrl = await resolveDownloadUrl(result, language);
  if (!downloadUrl) {
    throw new Error("没有找到可下载的字幕地址");
  }

  // 10.3 请求字幕文件
  const response = await fetchWithTimeout(downloadUrl, {
    headers: { ...browserHeaders, referer: result.detailUrl || "https://subtitlecat.com/" },
  });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type") || "text/plain; charset=utf-8";
  const dispositionName = parseContentDispositionFileName(response.headers.get("content-disposition") || "");
  const responsePathName = path.basename(new URL(response.url || downloadUrl).pathname);
  const fileName = sanitizeFileName(dispositionName || result.fileName || responsePathName || "subtitle.srt");

  // 10.4 自动解包 ZIP 字幕
  const extracted = await extractSubtitlePayload(buffer, contentType, fileName, language, {
    query: result.searchQuery,
    releaseName: result.releaseName || result.title,
    requestedEpisode: result.requestedEpisode,
  });
  if (extracted) {
    logger.info(`拉取字幕字节完成: ${extracted.fileName}`);
    return extracted;
  }

  logger.info(`拉取字幕字节完成: ${buffer.length} bytes`);
  return { buffer, contentType, fileName };
}

async function fetchSubHdPayload(result, language) {
  /*
   * ================================================================================
   * 步骤10.2：拉取 SubHD 字幕
   * ================================================================================
   * 目标：
   * 1) 首次遇到临时拒绝或网络故障时重建一次完整会话
   * 2) 获取真实文件后继续复用解包与字幕校验
   */
  logger.info("开始拉取 SubHD 字幕...");

  // 10.2.1 用全新 Cookie 会话执行下载，临时失败时只重试一次
  const payload = await runSubHdSessionWithRetry(() => fetchSubHdPayloadOnce(result, language));

  logger.info("拉取 SubHD 字幕完成", payload.fileName);
  return payload;
}

async function fetchSubHdPayloadOnce(result, language) {
  /*
   * ================================================================================
   * 步骤10.3：执行单次 SubHD 下载会话
   * ================================================================================
   * 目标：
   * 1) 在同一会话内访问详情页、准备页和下载接口
   * 2) 每次重试都从空 Cookie 容器开始，避免复用失效令牌
   */
  logger.info("开始执行单次 SubHD 下载会话...");

  // 10.3.1 校验详情地址和字幕 ID
  const detailUrl = new URL(result.detailUrl || "");
  const baseUrl = SUBHD_BASE_URL;
  const subtitleId = String(result.subHdId || detailUrl.pathname.split("/").filter(Boolean).pop() || "").trim();
  if (!subtitleId || detailUrl.origin !== new URL(baseUrl).origin || !/^\/a\/[A-Za-z0-9_-]+$/.test(detailUrl.pathname)) {
    throw new Error("SubHD 结果已失效，请重新搜索");
  }

  // 10.3.2 访问详情页并建立会话
  const cookies = new Map();
  const detailResponse = await fetchWithTimeout(detailUrl.href, {
    headers: { ...browserHeaders, referer: `${baseUrl}/` },
  });
  updateCookieJar(cookies, detailResponse);
  const detailHtml = await detailResponse.text();
  if (!new RegExp(`data-sid=["']${escapeRegExp(subtitleId)}["']|sid=["']${escapeRegExp(subtitleId)}["']`, "i").test(detailHtml)) {
    throw new Error("SubHD 详情页没有可下载字幕");
  }

  // 10.3.3 请求一次性下载页
  const prepareUrl = new URL("/api/sub/prepare-download", `${baseUrl}/`).href;
  const prepareResponse = await fetchWithTimeout(prepareUrl, {
    method: "POST",
    headers: buildSubHdSessionHeaders(cookies, detailUrl.href, baseUrl),
    body: JSON.stringify({ sid: subtitleId }),
  });
  updateCookieJar(cookies, prepareResponse);
  const prepared = await prepareResponse.json();
  if (prepared?.success !== true || !/^\/down\/[A-Za-z0-9_-]+$/.test(String(prepared?.url || ""))) {
    throw new Error(String(prepared?.msg || "SubHD 准备下载失败"));
  }

  // 10.3.4 访问下载页并提交最终下载请求
  const downloadPageUrl = new URL(prepared.url, `${baseUrl}/`).href;
  const downloadPageResponse = await fetchWithTimeout(downloadPageUrl, {
    headers: {
      ...browserHeaders,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      cookie: serializeCookieJar(cookies),
      referer: detailUrl.href,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "upgrade-insecure-requests": "1",
    },
  });
  updateCookieJar(cookies, downloadPageResponse);
  await downloadPageResponse.text();
  const finalApiUrl = new URL("/api/sub/down", `${baseUrl}/`).href;
  const finalApiResponse = await fetchWithTimeout(finalApiUrl, {
    method: "POST",
    headers: buildSubHdSessionHeaders(cookies, downloadPageUrl, baseUrl),
    body: JSON.stringify({ sid: subtitleId }),
  });
  updateCookieJar(cookies, finalApiResponse);
  const finalPayload = await finalApiResponse.json();
  if (finalPayload?.success !== true || finalPayload?.pass !== true || !finalPayload?.url) {
    throw new Error(String(finalPayload?.msg || "SubHD 下载验证未通过"));
  }

  // 10.3.5 下载真实字幕文件并自动解包
  const fileUrl = new URL(String(finalPayload.url), `${baseUrl}/`);
  if (fileUrl.protocol !== "https:" && fileUrl.protocol !== "http:") throw new Error("SubHD 返回了无效下载地址");
  const fileResponse = await fetchWithTimeout(fileUrl.href, {
    headers: { ...browserHeaders, referer: downloadPageUrl },
  });
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  const contentType = fileResponse.headers.get("content-type") || "application/octet-stream";
  const dispositionName = parseContentDispositionFileName(fileResponse.headers.get("content-disposition") || "");
  const responseName = decodeUrlFileName(fileResponse.url || fileUrl.href);
  const fileName = sanitizeFileName(dispositionName || responseName || result.fileName || `${subtitleId}.srt`);
  const extracted = await extractSubtitlePayload(buffer, contentType, fileName, language, {
    query: result.searchQuery,
    releaseName: result.releaseName || result.title,
    requestedEpisode: result.requestedEpisode,
  });
  const payload = extracted || { buffer, contentType, fileName };

  logger.info("执行单次 SubHD 下载会话完成", payload.fileName);
  return payload;
}

export async function runSubHdSessionWithRetry(task, options = {}) {
  /*
   * ================================================================================
   * 步骤10.4：重试 SubHD 临时会话故障
   * ================================================================================
   * 目标：
   * 1) 只重试站点限流、临时拒绝和网络故障
   * 2) 最多执行两次，避免重复请求长期阻塞预览
   */
  logger.info("开始重试 SubHD 临时会话故障...");

  // 10.4.1 规范重试次数和等待时间
  const attempts = clamp(Number(options.attempts || 2), 1, 2);
  const delayMs = clamp(Number(options.delayMs ?? SUBHD_SESSION_RETRY_DELAY_MS), 0, 2000);
  let lastError = null;

  // 10.4.2 每次调用任务时由上层创建全新 Cookie 会话
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const payload = await task();
      logger.info("重试 SubHD 临时会话故障完成", attempt);
      return payload;
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < attempts && isRetryableSubHdSessionError(error);
      logger.warn("SubHD 下载会话失败", attempt, String(error?.message || error), shouldRetry ? "准备重试" : "停止重试");
      if (!shouldRetry) {
        logger.info("重试 SubHD 临时会话故障完成: 失败");
        throw error;
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.info("重试 SubHD 临时会话故障完成: 失败");
  throw lastError || new Error("SubHD 下载会话失败");
}

export function isRetryableSubHdSessionError(error) {
  // 10.4.3 只识别瞬时 HTTP 状态和网络错误，不重试字幕业务校验错误
  const message = String(error?.message || error || "");
  return /HTTP\s+(?:403|408|429|5\d\d)\b|请求超时|连接超时|连接被重置|请求失败/i.test(message);
}

function buildSubHdSessionHeaders(cookies, referer, origin) {
  // 10.4.4 组装 SubHD JSON 会话请求头
  return {
    ...browserHeaders,
    accept: "application/json,text/plain,*/*",
    "content-type": "application/json; charset=utf-8",
    cookie: serializeCookieJar(cookies),
    origin,
    referer,
  };
}

function updateCookieJar(jar, response) {
  // 10.4.5 合并响应里的 Set-Cookie 首段
  const headers = response?.headers;
  const values = typeof headers?.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookieHeader(headers?.get?.("set-cookie") || "");
  for (const value of values || []) {
    const pair = String(value || "").split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function splitSetCookieHeader(value) {
  // 10.4.6 兼容不支持 Headers.getSetCookie 的旧 Node
  return String(value || "").split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map((item) => item.trim()).filter(Boolean);
}

function serializeCookieJar(jar) {
  // 10.4.7 生成 Cookie 请求头
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function fetchAssrtPayload(result, language) {
  /*
   * ================================================================================
   * 步骤10.5：拉取 ASSRT 字幕
   * ================================================================================
   * 目标：
   * 1) API 结果按字幕 ID 获取临时链接，网页结果使用公开下载地址
   * 2) 下载后继续复用 ZIP、RAR、7z 自动选字幕
   */
  logger.info("开始拉取 ASSRT 字幕...");

  // 10.5.1 按结果通道解析下载地址
  let downloadUrl = result.downloadUrl || "";
  let apiFileName = "";
  if (!downloadUrl) {
    if (!result.assrtToken || !result.assrtId) throw new Error("ASSRT 结果已失效，请重新搜索");
    const detailUrl = new URL(`${ASSRT_API_URL}/sub/detail`);
    detailUrl.searchParams.set("token", result.assrtToken);
    detailUrl.searchParams.set("id", String(result.assrtId));
    const detailResponse = await fetchWithTimeout(detailUrl.href, { headers: browserHeaders });
    const detail = await detailResponse.json();
    const item = Array.isArray(detail?.sub?.subs) ? detail.sub.subs[0] : null;
    if (!item?.url) throw new Error("ASSRT 没有返回可下载链接");
    downloadUrl = item.url;
    apiFileName = item.filename || "";
  }

  // 10.5.2 请求 API 临时地址或网页公开地址
  const response = await fetchWithTimeout(downloadUrl, {
    headers: { ...browserHeaders, referer: result.detailUrl || ASSRT_BASE_URL },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const dispositionName = parseContentDispositionFileName(response.headers.get("content-disposition") || "");
  const responsePathName = decodeUrlFileName(response.url || downloadUrl);
  const fileName = sanitizeFileName(dispositionName || apiFileName || result.fileName || responsePathName || "subtitle.srt");
  if (/text\/html/i.test(contentType) && /<html\b|<!doctype\s+html/i.test(buffer.subarray(0, 512).toString("utf8"))) {
    throw new Error("ASSRT 返回了网页而不是字幕文件，请稍后重试");
  }

  // 10.5.3 自动解包并返回
  const extracted = await extractSubtitlePayload(buffer, contentType, fileName, language, {
    query: result.searchQuery,
    releaseName: result.releaseName || result.title,
    requestedEpisode: result.requestedEpisode,
  });
  const payload = extracted || { buffer, contentType, fileName };
  logger.info("拉取 ASSRT 字幕完成", payload.fileName);
  return payload;
}

async function fetchAvSubtitlesPayload(result, language) {
  /*
   * ================================================================================
   * 步骤11：拉取 AVSubtitles 字幕
   * ================================================================================
   * 目标：
   * 1) 用同一会话打开详情页、下载页和最终文件
   * 2) 下载 ZIP 后自动挑选字幕文件
   */
  logger.info("开始拉取 AVSubtitles 字幕...");

  // 11.1 建立会话并读取详情页
  let cookieJar = "";
  const fetchWithSession = async (url, referer) => {
    const response = await fetchWithTimeout(url, {
      headers: { ...browserHeaders, referer: referer || AV_SUBTITLES_BASE_URL, cookie: cookieJar },
      allowErrorStatus: true,
    });
    cookieJar = mergeCookieJar(cookieJar, response);
    return response;
  };

  const detailResponse = await fetchWithSession(result.detailUrl, AV_SUBTITLES_BASE_URL);
  const detailHtml = await detailResponse.text();

  // 11.2 解析下载页参数
  const subId = matchFirst(detailHtml, /name=["']subid["']\s+value=["']([^"']+)["']/i);
  const revId = matchFirst(detailHtml, /name=["']revid["']\s+value=["']([^"']+)["']/i);
  const declaredFileName = htmlDecode(stripTags(matchFirst(detailHtml, /<span\b[^>]*class=["']text-mono["'][^>]*>([\s\S]*?)<\/span>/i))).trim();
  if (!subId || !revId) {
    throw new Error("AVSubtitles 没有找到下载参数");
  }

  // 11.3 打开下载页并解析最终链接
  const downloadPageUrl = `${AV_SUBTITLES_BASE_URL}/download_page.php?subid=${encodeURIComponent(subId)}&revid=${encodeURIComponent(revId)}`;
  const downloadPageResponse = await fetchWithSession(downloadPageUrl, result.detailUrl);
  const downloadPageHtml = await downloadPageResponse.text();
  const href = matchFirst(downloadPageHtml, /href=["']([^"']*download_sub\.php\?subid=[^"']+)["']/i);
  if (!href) {
    throw new Error("AVSubtitles 没有找到最终下载地址");
  }

  // 11.4 请求最终字幕文件
  const downloadUrl = new URL(htmlDecode(href), downloadPageUrl).href;
  const fileResponse = await fetchWithSession(downloadUrl, downloadPageUrl);
  if (!fileResponse.ok) {
    throw new Error(`AVSubtitles 下载失败: ${fileResponse.status}`);
  }
  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  const contentType = fileResponse.headers.get("content-type") || "application/octet-stream";
  const dispositionName = parseContentDispositionFileName(fileResponse.headers.get("content-disposition") || "");
  const fileName = sanitizeFileName(dispositionName || declaredFileName || result.fileName || "subtitle.zip");

  // 11.5 解包并返回字幕
  const extracted = await extractSubtitlePayload(buffer, contentType, fileName, language, {
    query: result.searchQuery,
    releaseName: result.releaseName || result.title,
    requestedEpisode: result.requestedEpisode,
  });
  logger.info("拉取 AVSubtitles 字幕完成", fileName);
  return extracted || { buffer, contentType, fileName };
}

function mergeCookieJar(cookieJar, response) {
  /*
   * ================================================================================
   * 步骤12：合并响应 Cookie
   * ================================================================================
   * 目标：
   * 1) 保存字幕源下载会话
   * 2) 后续请求复用同一 PHPSESSID
   */
  logger.info("开始合并响应 Cookie...");

  // 12.1 读取 Set-Cookie
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const pairs = new Map(
    String(cookieJar || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => [item.split("=")[0], item])
  );

  // 12.2 覆盖同名 Cookie
  for (const item of setCookies) {
    const pair = String(item || "").split(";")[0];
    if (!pair) continue;
    pairs.set(pair.split("=")[0], pair);
  }

  const merged = [...pairs.values()].join("; ");
  logger.info("合并响应 Cookie 完成");
  return merged;
}

function parseContentDispositionFileName(value) {
  // 12.3 解析下载响应文件名
  const encoded = matchFirst(value, /filename\*=UTF-8''([^;]+)/i);
  if (encoded) return decodeHeaderFileName(encoded);
  return decodeHeaderFileName(htmlDecode(matchFirst(value, /filename=["']?([^"';]+)["']?/i)));
}

function decodeHeaderFileName(value) {
  // 12.3.1 解码响应头文件名，并修复旧站点错误编码的文字
  try {
    return repairMojibakeText(decodeURIComponent(String(value || "").trim()));
  } catch {
    return repairMojibakeText(String(value || "").trim());
  }
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
    const resolved = parseSubtitleCatDirectDownloadUrl(html, result.detailUrl, language);
    if (resolved) {
      result.downloadUrl = resolved;
      const resolvedFileName = path.basename(new URL(resolved).pathname);
      if (resolvedFileName) {
        result.fileName = sanitizeFileName(resolvedFileName);
      }
      logger.info("解析真实下载地址完成: subtitlecat");
      return resolved;
    }
    if (hasSubtitleCatTranslationButton(html, language)) {
      throw new Error("SubtitleCat 该语言只有站内翻译按钮，没有可直接下载的字幕");
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

function parseSubtitleCatDirectDownloadUrl(html, detailUrl, language) {
  // 11.2.1 解析 SubtitleCat 已存在的目标语言下载链接
  const lang = escapeRegExp(language || "zh-CN");
  const href =
    matchFirst(html, new RegExp(`id=["']download_${lang}["'][^>]*href=["']([^"']+)["']`, "i")) ||
    matchFirst(html, new RegExp(`href=["']([^"']+)["'][^>]*id=["']download_${lang}["']`, "i"));
  return href ? new URL(htmlDecode(href), detailUrl).href : "";
}

function hasSubtitleCatTranslationButton(html, language) {
  // 11.2.2 判断 SubtitleCat 是否只有站内翻译按钮
  const lang = String(language || "zh-CN").trim();
  return Boolean(String(html || "").match(
    new RegExp(
      `translate_from_server_folder\\(\\s*['"]${escapeRegExp(lang)}['"]\\s*,\\s*['"]([^'"]+)['"]\\s*,\\s*['"]([^'"]+)['"]\\s*\\)`,
      "i"
    )
  ));
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

export async function extractSubtitlePayload(buffer, contentType, fileName, language, context = {}) {
  /*
   * ================================================================================
   * 步骤12：解包压缩字幕
   * ================================================================================
   * 目标：
   * 1) 识别 ZIP 和 RAR 压缩包
   * 2) 按语言、季集号和发布版本挑选正确字幕
   */
  logger.info("开始解包压缩字幕...");

  // 12.1 判断压缩包格式
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (contentType.includes("zip") || fileName.toLowerCase().endsWith(".zip") || buffer[2] === 0x03);
  const isRar =
    buffer.length >= 7 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x61 &&
    buffer[2] === 0x72 &&
    buffer[3] === 0x21 &&
    buffer[4] === 0x1a &&
    buffer[5] === 0x07;
  const isSevenZip =
    buffer.length >= 6 &&
    buffer[0] === 0x37 &&
    buffer[1] === 0x7a &&
    buffer[2] === 0xbc &&
    buffer[3] === 0xaf &&
    buffer[4] === 0x27 &&
    buffer[5] === 0x1c;
  if (!isZip && !isRar && !isSevenZip) {
    logger.info("解包压缩字幕完成: 非压缩包");
    return null;
  }

  // 12.2 解析并选择字幕文件
  const archiveContext = { ...context, language };
  const archiveEntries = isZip
    ? readZipEntries(buffer, archiveContext)
    : isRar
      ? await readRarEntries(buffer, archiveContext)
      : await readSevenZipEntries(buffer, archiveContext);
  const entries = archiveEntries
    .filter((entry) => SUBTITLE_EXTENSIONS.includes(path.extname(entry.fileName).toLowerCase()))
    .sort((left, right) => scoreArchiveSubtitle(right.fileName, archiveContext) - scoreArchiveSubtitle(left.fileName, archiveContext));
  if (!entries.length) {
    logger.info("解包压缩字幕完成: 未找到字幕");
    return null;
  }

  // 12.3 返回解包后的字幕字节
  const selected = entries[0];
  logger.info(`解包压缩字幕完成: ${selected.fileName}`);
  return {
    buffer: selected.buffer,
    contentType: getSubtitleContentType(selected.fileName),
    fileName: sanitizeFileName(path.basename(selected.fileName)),
  };
}

function readZipEntries(buffer, context = {}) {
  // 12.4 读取 ZIP 中央目录
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return [];

  const entryCount = Math.min(buffer.readUInt16LE(eocdOffset + 10), 1000);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const candidates = [];

  for (let index = 0; index < entryCount && offset < buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = decodeZipFileName(buffer.subarray(offset + 46, offset + 46 + fileNameLength), flags);
    const extension = path.extname(fileName).toLowerCase();
    const encrypted = Boolean(flags & 0x0001);
    if (
      !encrypted &&
      SUBTITLE_EXTENSIONS.includes(extension) &&
      uncompressedSize <= 20 * 1024 * 1024 &&
      (method === 0 || method === 8)
    ) {
      candidates.push({ fileName, localHeaderOffset, compressedSize, method });
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  // 12.4.1 只解压评分最高的候选字幕
  const selected = candidates
    .sort((left, right) => scoreArchiveSubtitle(right.fileName, context) - scoreArchiveSubtitle(left.fileName, context))[0];
  if (!selected) return [];
  const content = readZipEntryContent(buffer, selected.localHeaderOffset, selected.compressedSize, selected.method);
  return content ? [{ fileName: selected.fileName, buffer: content }] : [];
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
  if (localHeaderOffset < 0 || localHeaderOffset + 30 > buffer.length) return null;
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) return null;

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (dataOffset + compressedSize > buffer.length) return null;
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
    } catch (error) {
      logger.warn("ZIP 字幕解压失败", error.message);
      return null;
    }
  }
  return null;
}

function decodeZipFileName(buffer, flags = 0) {
  // 12.7 解码 UTF-8 或旧式中文 ZIP 文件名
  const encodings = flags & 0x0800 ? ["utf-8"] : ["utf-8", "gb18030", "big5"];
  let best = { value: buffer.toString("binary"), score: Number.POSITIVE_INFINITY };
  for (const encoding of encodings) {
    try {
      const value = cleanSubtitleText(decodeSubtitleBuffer(buffer, encoding));
      const replacementCount = (value.match(/\uFFFD/g) || []).length;
      const chineseSignal = (value.match(/[\u3400-\u9fff]/g) || []).length;
      const score = replacementCount * 100 - Math.min(chineseSignal, 20);
      if (score < best.score) best = { value, score };
    } catch {
      logger.info("ZIP 文件名编码不支持", encoding);
    }
  }
  return best.value;
}

async function readRarEntries(buffer, context) {
  /*
   * ================================================================================
   * 步骤12.8：读取 RAR 字幕
   * ================================================================================
   * 目标：
   * 1) 先读取文件头并评分
   * 2) 只解压评分最高的字幕，限制内存使用
   */
  logger.info("开始读取 RAR 字幕...");

  // 12.8.1 创建内存解压器并读取全部文件头
  const wasmBinary = await getUnrarWasmBinary();
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const extractor = await unrar.createExtractorFromData({ data: arrayBuffer, wasmBinary });
  const headers = [...extractor.getFileList().fileHeaders]
    .filter((header) => !header.flags?.directory && !header.flags?.encrypted && Number(header.unpSize || 0) <= 20 * 1024 * 1024)
    .filter((header) => SUBTITLE_EXTENSIONS.includes(path.extname(header.name || "").toLowerCase()))
    .sort((left, right) => scoreArchiveSubtitle(right.name, context) - scoreArchiveSubtitle(left.name, context));
  if (!headers.length) {
    logger.info("读取 RAR 字幕完成: 未找到字幕");
    return [];
  }

  // 12.8.2 只解压最高分文件并遍历迭代器释放资源
  const selectedName = headers[0].name;
  const extracted = extractor.extract({ files: [selectedName] });
  const entries = [];
  for (const file of extracted.files) {
    if (file.fileHeader?.name === selectedName && file.extraction) {
      entries.push({ fileName: selectedName, buffer: Buffer.from(file.extraction) });
    }
  }
  logger.info("读取 RAR 字幕完成", selectedName);
  return entries;
}

async function getUnrarWasmBinary() {
  // 12.8.3 缓存随应用打包的 unRAR WASM 运行文件
  if (!unrarWasmBinaryPromise) {
    unrarWasmBinaryPromise = readFile(UNRAR_WASM_PATH).then((buffer) =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );
  }
  return unrarWasmBinaryPromise;
}

async function readSevenZipEntries(buffer, context) {
  /*
   * ================================================================================
   * 步骤12.9：读取 7z 字幕
   * ================================================================================
   * 目标：
   * 1) 在 WASM 内存文件系统中展开 7z
   * 2) 只返回评分最高且体积合规的字幕文件
   */
  logger.info("开始读取 7z 字幕...");

  // 12.9.1 初始化独立 7-Zip 实例并写入压缩包
  const wasmBinary = await getSevenZipWasmBinary();
  const listing = [];
  const sevenZip = await SevenZip({
    wasmBinary,
    print: (value) => listing.push(String(value || "")),
    printErr: (value) => listing.push(String(value || "")),
  });
  const archivePath = "/archive.7z";
  const outputPath = "/out";
  sevenZip.FS.writeFile(archivePath, new Uint8Array(buffer));

  // 12.9.2 先列出目录并选出目标字幕
  try {
    sevenZip.callMain(["l", archivePath, "-slt"]);
  } catch (error) {
    if (!String(error?.message || error).includes("Program terminated with exit(0)")) throw error;
  }
  const selected = parseSevenZipListing(listing.join("\n"))
    .filter((entry) => SUBTITLE_EXTENSIONS.includes(path.extname(entry.fileName).toLowerCase()))
    .filter((entry) => !entry.encrypted && entry.size <= 20 * 1024 * 1024)
    .sort((left, right) => scoreArchiveSubtitle(right.fileName, context) - scoreArchiveSubtitle(left.fileName, context))[0];
  if (!selected) {
    logger.info("读取 7z 字幕完成: 未找到字幕");
    return [];
  }

  // 12.9.3 只解压选中的文件
  sevenZip.FS.mkdir(outputPath);
  listing.length = 0;
  try {
    sevenZip.callMain(["x", archivePath, selected.fileName, `-o${outputPath}`, "-y"]);
  } catch (error) {
    if (!String(error?.message || error).includes("Program terminated with exit(0)")) throw error;
  }
  const extractedPath = `${outputPath}/${selected.fileName}`.replace(/\/+/g, "/");
  const content = Buffer.from(sevenZip.FS.readFile(extractedPath));

  logger.info("读取 7z 字幕完成", selected.fileName);
  return [{ fileName: selected.fileName, buffer: content }];
}

function parseSevenZipListing(value) {
  /*
   * ================================================================================
   * 步骤12.9.4：解析 7-Zip 目录
   * ================================================================================
   * 目标：
   * 1) 读取 -slt 输出中的文件名、体积和加密标记
   * 2) 排除目录和不安全路径
   */
  logger.info("开始解析 7-Zip 目录...");

  // 12.9.4.1 按空行拆分属性记录
  const entries = String(value || "")
    .split(/\r?\n\s*\r?\n/)
    .map((block) => Object.fromEntries(
      block.split(/\r?\n/)
        .map((line) => line.match(/^([^=]+?)\s*=\s*(.*)$/))
        .filter(Boolean)
        .map((match) => [match[1].trim(), match[2].trim()])
    ))
    .map((record) => ({
      fileName: normalizeArchiveEntryPath(record.Path),
      size: Number(record.Size || 0),
      encrypted: record.Encrypted === "+",
      directory: /^D/i.test(record.Attributes || ""),
    }))
    .filter((entry) => entry.fileName && !entry.directory)
    .slice(0, 1000);

  logger.info("解析 7-Zip 目录完成", entries.length);
  return entries;
}

function normalizeArchiveEntryPath(value) {
  // 12.9.4.2 拒绝绝对路径和上级目录跳转
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return "";
  if (normalized.split("/").some((part) => part === "..")) return "";
  return normalized;
}

async function getSevenZipWasmBinary() {
  // 12.9.5 缓存随应用打包的 7-Zip WASM 运行文件
  if (!sevenZipWasmBinaryPromise) {
    sevenZipWasmBinaryPromise = readFile(SEVEN_ZIP_WASM_PATH).then((buffer) =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );
  }
  return sevenZipWasmBinaryPromise;
}

function getSubtitleContentType(fileName) {
  // 12.10 按字幕扩展名返回下载类型
  const extension = path.extname(fileName || "").toLowerCase();
  if (extension === ".vtt") return "text/vtt; charset=utf-8";
  if (extension === ".ass" || extension === ".ssa") return "text/x-ssa; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function cacheResult(result) {
  // 3.4 缓存结果供预览和下载接口复用
  const key = `${result.source}|${result.title}|${result.detailUrl}|${result.downloadUrl}|${result.language}|${result.fileName}`;
  const id = createHash("sha1").update(key).digest("hex").slice(0, 16);
  const cached = { ...result, id };
  if (RESULT_CACHE.has(id)) RESULT_CACHE.delete(id);
  RESULT_CACHE.set(id, cached);
  while (RESULT_CACHE.size > MAX_RESULT_CACHE_ENTRIES) {
    RESULT_CACHE.delete(RESULT_CACHE.keys().next().value);
  }
  return toPublicResult(cached);
}

function toPublicResult(result) {
  // 3.5 只返回前端展示需要的字段
  return {
    id: result.id,
    source: result.source,
    sourceLabel: result.sourceLabel,
    title: repairMojibakeText(result.title),
    fileName: sanitizeFileName(result.fileName),
    ext: result.ext,
    language: repairMojibakeText(result.language),
    score: result.score,
    qualityScore: result.qualityScore,
    languageProfile: result.languageProfile,
    downloads: result.downloads,
    size: result.size,
    duration: result.duration,
    extra: repairMojibakeText(result.extra),
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
    res.writeHead(200, withCorsHeaders({
      "content-type": getMimeType(filePath),
      "content-length": fileStat.size,
      "cache-control": "no-cache",
    }));
    createReadStream(filePath).pipe(res);
    logger.info("返回静态资源完成:", path.basename(filePath));
  } catch {
    sendText(res, 404, "Not Found");
    logger.info("返回静态资源完成: not found");
  }
}

async function fetchWithTimeout(url, options = {}) {
  /*
   * ================================================================================
   * 步骤11：请求远程资源
   * ================================================================================
   * 目标：
   * 1) 在现代 Node 和 Android 内置 Node 12 下共用请求入口
   * 2) 用超时控制慢源，避免搜索长期卡住
   */
  logger.info("开始请求远程资源...");

  // 11.1 拆分业务参数和 fetch 参数
  const { allowErrorStatus = false, timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const hasAbortController = typeof AbortController === "function";
  const controller = hasAbortController ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    // 11.2 执行带超时请求
    const response = await runtimeFetch(url, {
      ...fetchOptions,
      signal: controller ? controller.signal : fetchOptions.signal,
      timeoutMs,
    });
    if (!response.ok && !allowErrorStatus) {
      throw new Error(`HTTP ${response.status}: ${redactSensitiveUrl(url)}`);
    }
    logger.info("请求远程资源完成", response.status, redactSensitiveUrl(url));
    return response;
  } catch (error) {
    // 11.3 标准化请求错误信息
    const message = normalizeRemoteErrorMessage(error, url, timeoutMs);
    logger.info("请求远程资源完成: 失败", message);
    throw new Error(message);
  } finally {
    // 11.4 清理计时器
    if (timer) clearTimeout(timer);
  }
}

function normalizeRemoteErrorMessage(error, url, timeoutMs) {
  /*
   * ================================================================================
   * 步骤12：标准化远程请求错误
   * ================================================================================
   * 目标：
   * 1) 把 fetch failed 这类模糊报错转成可读信息
   * 2) 给源状态面板返回更具体的失败原因
   */
  logger.info("开始标准化远程请求错误...");

  // 12.1 识别超时、连接失败和其他网络错误
  const target = new URL(url);
  const code = String(error?.cause?.code || error?.code || "").trim();
  const rawMessage = String(error?.cause?.message || error?.message || "").trim();
  let message = rawMessage || `请求失败: ${target.host}`;

  if (error?.name === "AbortError") {
    message = `请求超时(${timeoutMs}ms): ${target.host}`;
  } else if (code === "UND_ERR_CONNECT_TIMEOUT") {
    message = `连接超时: ${target.host}`;
  } else if (code === "ECONNRESET") {
    message = `连接被重置: ${target.host}`;
  } else if (code === "ENOTFOUND") {
    message = `域名解析失败: ${target.host}`;
  } else if (rawMessage === "fetch failed") {
    message = `请求失败: ${target.host}`;
  }

  const safeMessage = redactSensitiveUrl(message);
  logger.info("标准化远程请求错误完成", safeMessage);
  return safeMessage;
}

function redactSensitiveUrl(value) {
  /*
   * ================================================================================
   * 步骤12.1：隐藏远程地址中的凭据
   * ================================================================================
   * 目标：
   * 1) 日志保留主机和接口路径用于排障
   * 2) 不记录 ASSRT Token 等本机凭据
   */
  logger.info("开始隐藏远程地址中的凭据...");

  // 12.1.1 替换常见敏感查询参数
  try {
    const url = new URL(value);
    for (const key of ["token", "api_key", "apikey", "authorization"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
    }
    const result = url.href;
    logger.info("隐藏远程地址中的凭据完成");
    return result;
  } catch {
    const result = String(value || "").replace(/([?&](?:token|api_key|apikey)=)[^&]+/gi, "$1[redacted]");
    logger.info("隐藏远程地址中的凭据完成: fallback");
    return result;
  }
}

async function nodeFetchCompat(url, options = {}) {
  /*
   * ================================================================================
   * 步骤12：兼容 Android 内置 Node 请求
   * ================================================================================
   * 目标：
   * 1) 用 http/https 实现 fetch 子集
   * 2) 支持文本、JSON、二进制、响应头和有限重定向
   */
  logger.info("开始执行 Node 兼容请求...");

  // 12.1 读取请求参数
  const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS);
  const redirects = Number(options.redirects || 0);
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === "https:" ? https : http;
  const headers = normalizeRequestHeaders(options.headers || {});
  const body = normalizeRequestBody(options.body);
  const requestLookup = await buildCompatRequestLookup(requestUrl.hostname);
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
    headers["content-length"] = Buffer.byteLength(body);
  }

  // 12.2 发起请求并聚合响应字节
  return new Promise((resolve, reject) => {
    const req = transport.request(
      requestUrl,
      {
        method: options.method || (body ? "POST" : "GET"),
        headers,
        lookup: requestLookup,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          const location = res.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && location && redirects < MAX_FETCH_REDIRECTS) {
            const nextUrl = new URL(location, requestUrl).href;
            logger.info("Node 兼容请求跳转", redactSensitiveUrl(nextUrl));
            resolve(nodeFetchCompat(nextUrl, { ...options, redirects: redirects + 1, method: status === 303 ? "GET" : options.method }));
            return;
          }

          const buffer = Buffer.concat(chunks);
          logger.info("Node 兼容请求完成", status, redactSensitiveUrl(requestUrl.href));
          resolve(createCompatResponse({
            status,
            url: requestUrl.href,
            headers: res.headers,
            buffer,
          }));
        });
      }
    );

    // 12.3 处理超时和写入请求体
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时: ${redactSensitiveUrl(requestUrl.href)}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function buildCompatRequestLookup(hostName) {
  /*
   * ================================================================================
   * 步骤12.4：生成 Android 兼容域名解析器
   * ================================================================================
   * 目标：
   * 1) ASSRT 文件域名遇到代理 Fake-IP 时改用真实 DNS 地址
   * 2) 其他域名继续使用系统解析，不改变原有网络链路
   */
  logger.info("开始生成 Android 兼容域名解析器...");

  // 12.4.1 非 ASSRT 文件域名保持系统解析
  if (!isAssrtFileHost(hostName)) {
    logger.info("生成 Android 兼容域名解析器完成: system");
    return dnsLookup;
  }

  // 12.4.2 系统已返回公网地址时不改写原网络链路
  const systemAddresses = await lookupSystemHostAddresses(hostName);
  if (systemAddresses.some((item) => isPublicIpv4Address(item.address))) {
    logger.info("生成 Android 兼容域名解析器完成: public system DNS");
    return dnsLookup;
  }

  // 12.4.3 系统只返回 Fake-IP 时预先解析真实地址
  const addresses = await resolveAssrtFileHostAddresses(hostName);
  if (!addresses.length) {
    logger.info("生成 Android 兼容域名解析器完成: fallback");
    return dnsLookup;
  }
  const lookup = (hostname, options, callback) => {
    const wantsAll = Boolean(options && typeof options === "object" && options.all);
    const family = Number(options && typeof options === "object" ? options.family : options) || 0;
    const selected = addresses.filter((item) => !family || item.family === family);
    const values = selected.length ? selected : addresses;
    if (wantsAll) callback(null, values);
    else callback(null, values[0].address, values[0].family);
  };
  logger.info("生成 Android 兼容域名解析器完成: ASSRT direct");
  return lookup;
}

function isAssrtFileHost(hostName) {
  // 12.4.4 只匹配 ASSRT 的文件下载子域名
  return /^file\d*\.assrt\.net$/i.test(String(hostName || ""));
}

function lookupSystemHostAddresses(hostName) {
  // 12.4.5 读取系统 DNS 的全部地址，失败时交给 DoH 尝试
  return new Promise((resolve) => {
    dnsLookup(hostName, { all: true }, (error, addresses) => {
      if (error) {
        logger.info("读取系统 DNS 完成: 失败", error.message);
        resolve([]);
        return;
      }
      logger.info(`读取系统 DNS 完成: ${addresses.length} 条`);
      resolve(addresses);
    });
  });
}

async function resolveAssrtFileHostAddresses(hostName) {
  /*
   * ================================================================================
   * 步骤12.5：解析 ASSRT 文件域名真实地址
   * ================================================================================
   * 目标：
   * 1) 直连可信 DoH 地址，绕开系统 Fake-IP 结果
   * 2) 缓存短时间结果并校验仅接受公网 IPv4
   */
  logger.info("开始解析 ASSRT 文件域名真实地址...");

  // 12.5.1 命中五分钟缓存时直接复用
  const cached = assrtFileDnsCache.get(hostName);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info("解析 ASSRT 文件域名真实地址完成: cache");
    return cached.addresses;
  }

  // 12.5.2 依次查询直连 DoH 服务
  for (const provider of ASSRT_DOH_PROVIDERS) {
    try {
      const answers = await queryDirectDnsOverHttps(provider, hostName);
      const addresses = answers
        .filter((item) => Number(item?.type) === 1 && isPublicIpv4Address(item?.data))
        .map((item) => ({ address: String(item.data), family: 4 }));
      if (!addresses.length) continue;
      assrtFileDnsCache.set(hostName, { addresses, expiresAt: Date.now() + 5 * 60 * 1000 });
      logger.info(`解析 ASSRT 文件域名真实地址完成: ${addresses.length} 条`);
      return addresses;
    } catch (error) {
      logger.warn("ASSRT 真实 DNS 查询失败", provider.serverName, error.message);
    }
  }

  logger.info("解析 ASSRT 文件域名真实地址完成: empty");
  return [];
}

function queryDirectDnsOverHttps(provider, hostName) {
  /*
   * ================================================================================
   * 步骤12.6：直连 DNS-over-HTTPS
   * ================================================================================
   * 目标：
   * 1) 用服务 IP 建立连接，避免 DoH 域名也被 Fake-IP 改写
   * 2) 保留服务域名作为 Host 和 TLS SNI
   */
  logger.info("开始直连 DNS-over-HTTPS...");

  // 12.6.1 构造只读 JSON DNS 查询
  const queryPath = `${provider.path}?name=${encodeURIComponent(hostName)}&type=A`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: provider.address,
      servername: provider.serverName,
      path: queryPath,
      method: "GET",
      headers: { host: provider.serverName, accept: "application/dns-json" },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        try {
          if (Number(res.statusCode || 0) !== 200) throw new Error(`HTTP ${res.statusCode || 0}`);
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          logger.info("直连 DNS-over-HTTPS 完成", provider.serverName);
          resolve(Array.isArray(payload?.Answer) ? payload.Answer : []);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("DoH 请求超时")));
    req.on("error", reject);
    req.end();
  });
}

export function isPublicIpv4Address(value) {
  // 12.6.2 排除无效、内网、保留和代理 Fake-IP 地址
  const parts = String(value || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function createCompatResponse({ status, url, headers, buffer }) {
  /*
   * ================================================================================
   * 步骤13：生成兼容响应对象
   * ================================================================================
   * 目标：
   * 1) 对齐业务中使用的 fetch Response 字段
   * 2) 让搜索、预览、下载都能复用同一返回结构
   */
  logger.info("开始生成兼容响应对象...");

  // 13.1 包装响应头读取方法
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  // 13.2 返回最小 Response 子集
  const response = {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        const value = normalizedHeaders[String(name || "").toLowerCase()];
        return Array.isArray(value) ? value.join(", ") : value || null;
      },
      getSetCookie() {
        const value = normalizedHeaders["set-cookie"];
        return Array.isArray(value) ? value : value ? [value] : [];
      },
    },
    async text() {
      return buffer.toString("utf8");
    },
    async json() {
      return JSON.parse(buffer.toString("utf8"));
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };

  logger.info("生成兼容响应对象完成", status);
  return response;
}

export function decodeSubtitle(buffer, contentType = "", language = "zh-CN") {
  /*
   * ================================================================================
   * 步骤13：解码字幕文本
   * ================================================================================
   * 目标：
   * 1) 识别 BOM、UTF-16 字节特征和服务端声明的编码
   * 2) 用内置编码库稳定解码 GBK、Big5、日文等字幕
   * 3) 修复双重错误解码，并选择目标语言最匹配的文本
   */
  logger.info("开始解码字幕文本...");

  // 13.1 生成编码候选
  const charset = normalizeSubtitleCharset(matchFirst(contentType, /charset=([^;]+)/i));
  const unicodeEncoding = detectSubtitleUnicodeEncoding(buffer);
  const encodings = buildSubtitleEncodingCandidates(charset, language, unicodeEncoding);
  const strictUtf8 = isStrictUtf8Buffer(buffer);

  // 13.2 逐个解码、修复常见乱码并选择最低分结果
  let best = { text: "", encoding: "utf-8", score: Number.POSITIVE_INFINITY };
  for (const encoding of encodings) {
    try {
      const rawText = decodeSubtitleBuffer(buffer, encoding);
      const repairedText = repairMojibakeText(rawText);
      const text = cleanSubtitleText(repairedText);
      let score = scoreDecodedSubtitleText(repairedText, language);
      if (strictUtf8 && !unicodeEncoding && encoding !== "utf-8") score += 220;
      if (repairedText !== rawText) score -= 12;
      if (score < best.score) best = { text, encoding: repairedText === rawText ? encoding : `${encoding}+repair`, score };
    } catch {
      logger.info("字幕编码不支持", encoding);
    }
  }

  logger.info("解码字幕文本完成", best.encoding);
  return { text: best.text, encoding: best.encoding };
}

function buildSubtitleEncodingCandidates(charset, language, unicodeEncoding = "") {
  /*
   * ================================================================================
   * 步骤14：生成字幕编码候选
   * ================================================================================
   * 目标：
   * 1) 优先处理 BOM 或 UTF-16 字节特征
   * 2) 再尊重服务端 charset，并按字幕语言补充候选
   */
  logger.info("开始生成字幕编码候选...");

  // 14.1 按语言排列候选
  const candidatesByLanguage = {
    "zh-CN": ["utf-8", "gb18030", "big5", "windows-1252", "iso-8859-1"],
    "zh-TW": ["utf-8", "big5", "gb18030", "windows-1252", "iso-8859-1"],
    ja: ["utf-8", "shift_jis", "euc-jp", "windows-1252", "iso-8859-1"],
    en: ["utf-8", "windows-1252", "iso-8859-1", "gb18030"],
  };
  const ordered = (unicodeEncoding ? [unicodeEncoding] : [charset, ...(candidatesByLanguage[language] || candidatesByLanguage["zh-CN"])])
    .filter(Boolean)
    .map((item) => String(item).trim().toLowerCase());

  // 14.2 去重后返回
  const encodings = [...new Set(ordered)];
  logger.info("生成字幕编码候选完成", encodings.join(", "));
  return encodings;
}

function normalizeSubtitleCharset(value) {
  // 14.3 统一服务端常见 charset 别名，交给 iconv-lite 识别
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  const key = raw.replace(/[\s_-]+/g, "");
  const aliases = {
    utf8: "utf-8",
    utf16: "utf-16le",
    unicode: "utf-16le",
    unicodefffe: "utf-16be",
    gbk: "gb18030",
    gb2312: "gb18030",
    gb231280: "gb18030",
    cp936: "gb18030",
    ms936: "gb18030",
    cp950: "big5",
    big5hkscs: "big5",
    sjis: "shift_jis",
    shiftjis: "shift_jis",
    eucjp: "euc-jp",
    cp1252: "windows-1252",
    latin1: "windows-1252",
    iso88591: "iso-8859-1",
  };
  return aliases[key] || raw;
}

function detectSubtitleUnicodeEncoding(buffer) {
  // 14.4 从 BOM 和连续 NUL 字节识别 UTF-16，避免 UTF-8 误读
  const value = Buffer.from(buffer || []);
  if (value.length >= 3 && value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf) return "utf-8";
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe) return "utf-16le";
  if (value.length >= 2 && value[0] === 0xfe && value[1] === 0xff) return "utf-16be";

  const sampleLength = Math.min(value.length - (value.length % 2), 512);
  if (sampleLength < 32) return "";
  let evenNul = 0;
  let oddNul = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (value[index] === 0) evenNul += 1;
    if (value[index + 1] === 0) oddNul += 1;
  }
  const pairs = sampleLength / 2;
  if (oddNul >= pairs * 0.35 && oddNul > evenNul * 2) return "utf-16le";
  if (evenNul >= pairs * 0.35 && evenNul > oddNul * 2) return "utf-16be";
  return "";
}

function isStrictUtf8Buffer(buffer) {
  // 14.5 判断原始字节是否已是有效 UTF-8，避免其他编码误判为汉字
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function decodeSubtitleBuffer(buffer, encoding) {
  // 14.6 优先使用纯 JavaScript 编码库，Android Node 运行时也能识别中文旧编码
  if (iconv.encodingExists(encoding)) return iconv.decode(Buffer.from(buffer || []), encoding);
  return new TextDecoder(encoding, { fatal: false }).decode(buffer);
}

function cleanSubtitleText(value) {
  // 14.7 移除 BOM 和 NUL，输出适合预览与 UTF-8 保存的字幕文本
  return String(value || "").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
}

function repairMojibakeText(value) {
  // 14.8 修复 UTF-8 被按 Windows-1252 显示后再次 UTF-8 编码的常见乱码
  let current = String(value || "");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentMarkers = countMojibakeMarkers(current);
    if (currentMarkers < 2) break;
    const bytes = iconv.encode(current, "windows-1252");
    if (iconv.decode(bytes, "windows-1252") !== current) break;
    try {
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (countMojibakeMarkers(repaired) >= currentMarkers) break;
      current = repaired;
    } catch {
      break;
    }
  }
  return current;
}

function countMojibakeMarkers(value) {
  // 14.9 统计 UTF-8 误按单字节编码显示时的典型片段
  return (String(value || "").match(/(?:Ã.|Â.|Ð.|Ñ.|[äåæçèé][\u0080-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2020\u2021])/g) || []).length;
}

function scoreDecodedSubtitleText(text, language) {
  /*
   * ================================================================================
   * 步骤15：给解码文本评分
   * ================================================================================
   * 目标：
   * 1) 惩罚替换符、控制字符和典型 mojibake 乱码
   * 2) 奖励目标语言字符，减少中文乱码误判
   */
  logger.info("开始给解码文本评分...");

  // 15.1 统计异常字符
  const value = String(text || "");
  const replacementCount = (value.match(/\uFFFD/g) || []).length;
  const nulCount = (value.match(/\u0000/g) || []).length;
  const controlCount = (value.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  const mojibakeCount = countMojibakeMarkers(value);

  // 15.2 统计目标语言字符
  let languageSignal = 0;
  if (language === "zh-CN" || language === "zh-TW") {
    languageSignal = Math.min(100, (value.match(/[\u3400-\u9fff]/g) || []).length);
  } else if (language === "ja") {
    languageSignal = Math.min(100, (value.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length);
  } else if (language === "en") {
    languageSignal = Math.min(60, (value.match(/[A-Za-z]/g) || []).length / 4);
  }

  const score = replacementCount * 1000 + nulCount * 200 + controlCount * 40 + mojibakeCount * 30 - languageSignal;
  logger.info("给解码文本评分完成", score);
  return score;
}

function sendJson(res, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(statusCode, withCorsHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  }));
  res.end(body);
}

function sendText(res, statusCode, text) {
  const body = Buffer.from(text);
  res.writeHead(statusCode, withCorsHeaders({
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
  }));
  res.end(body);
}

function sendEmpty(res, statusCode) {
  /*
   * ================================================================================
   * 步骤16：返回空响应
   * ================================================================================
   * 目标：
   * 1) 处理 Android WebView 跨源预检
   * 2) 保持 API 返回头一致
   */
  logger.info("开始返回空响应...");

  // 16.1 写入跨源响应头
  res.writeHead(statusCode, withCorsHeaders({
    "content-length": 0,
    "cache-control": "no-store",
  }));
  res.end();

  logger.info("返回空响应完成", statusCode);
}

function withCorsHeaders(headers = {}) {
  /*
   * ================================================================================
   * 步骤17：合并跨源响应头
   * ================================================================================
   * 目标：
   * 1) 允许 Capacitor 本地页面访问本机 HTTP 服务
   * 2) 允许下载接口暴露文件名响应头
   */
  logger.info("开始合并跨源响应头...");

  // 17.1 合并通用 CORS 头
  const merged = {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-assrt-token",
    "access-control-expose-headers": "content-disposition,content-length,content-type",
  };

  logger.info("合并跨源响应头完成");
  return merged;
}

function normalizeRequestHeaders(headers) {
  /*
   * ================================================================================
   * 步骤18：整理请求头
   * ================================================================================
   * 目标：
   * 1) 支持普通对象、Headers 和数组形式
   * 2) 输出 http/https.request 可接收的对象
   */
  logger.info("开始整理请求头...");

  // 18.1 处理 Headers 实例和数组
  const output = {};
  if (headers && typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      output[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[key] = value;
    }
  } else {
    Object.assign(output, headers || {});
  }

  logger.info("整理请求头完成");
  return output;
}

function normalizeRequestBody(body) {
  /*
   * ================================================================================
   * 步骤19：整理请求体
   * ================================================================================
   * 目标：
   * 1) 支持字符串、Buffer、URLSearchParams 和 ArrayBuffer
   * 2) 输出可写入 Node 请求的 Buffer 或字符串
   */
  logger.info("开始整理请求体...");

  // 19.1 空请求体直接返回
  if (body === undefined || body === null) {
    logger.info("整理请求体完成: empty");
    return null;
  }

  // 19.2 转换常见请求体类型
  if (Buffer.isBuffer(body) || typeof body === "string") {
    logger.info("整理请求体完成: direct");
    return body;
  }
  if (body instanceof URLSearchParams) {
    logger.info("整理请求体完成: search params");
    return body.toString();
  }
  if (body instanceof ArrayBuffer) {
    logger.info("整理请求体完成: array buffer");
    return Buffer.from(body);
  }

  logger.info("整理请求体完成: string fallback");
  return String(body);
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
  const safe = repairMojibakeText(value || "subtitle.srt")
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
