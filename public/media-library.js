export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts"]);
export const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub"]);

const GENERIC_MEDIA_FOLDERS = new Set([
  "movie",
  "movies",
  "tv",
  "tvshow",
  "tvshows",
  "video",
  "videos",
  "电影",
  "影片",
  "电视剧",
  "剧集",
  "视频",
]);
const RELEASE_NOISE_PATTERN = /\b(4320p|2160p|1080p|720p|576p|480p|4k|8k|uhd|hdr10\+?|hdr|dolby[ .-]?vision|dv|web[ .-]?dl|web[ .-]?rip|webrip|bluray|blu[ .-]?ray|brrip|bdremux|remux|hdtv|dvdrip|xvid|av1|x264|x265|h264|h265|hevc|aac|ac3|eac3|ddp?\d?(?:\.\d)?|dts(?:[ .-]?hd)?|truehd|atmos|10bit|8bit)\b/i;
const RELEASE_FLAG_PATTERN = /\b(complete|proper|repack|rerip|internal|limited|extended|uncut|multi|dual|dubbed|subbed|chs|cht|eng|jpn)\b/gi;
const SEASON_FOLDER_PATTERN = /^(?:season|series|s)\s*0?(\d{1,2})$|^第\s*0?(\d{1,2})\s*季$/i;

const logger = {
  info: (...args) => console.info("[SubtitleFinderMedia]", ...args),
};

/*
 * ================================================================================
 * 步骤1：解析媒体文件名
 * ================================================================================
 * 目标：
 * 1) 从文件名和父目录识别片名、年份、季号、集号
 * 2) 生成适合字幕站检索的稳定搜索词
 * 3) 保留视频原始主文件名，供字幕下载时同名保存
 */
export function analyzeMediaFile(fileName, options = {}) {
  logger.info("开始解析媒体文件名...", fileName);

  // 1.1 读取文件名和父目录上下文
  const safeFileName = String(fileName || "video");
  const extension = getExtension(safeFileName);
  const rawStem = stripExtension(getFileName(safeFileName));
  const readableStem = normalizeSeparators(rawStem);
  const parentNames = Array.isArray(options.parentNames) ? options.parentNames : [];

  // 1.2 识别季集信息
  const episodeInfo = extractEpisodeInfo(readableStem, parentNames);
  const parentTitle = selectParentTitle(parentNames);
  const year = extractYear(readableStem) || extractYear(parentTitle);

  // 1.3 选择并清理标题
  const titleSource = episodeInfo
    ? readableStem.slice(0, episodeInfo.index).trim() || parentTitle
    : readableStem;
  let title = cleanTitle(titleSource, year);
  if (!title || isGenericMediaFolder(title) || /^\d{1,4}$/.test(title)) {
    const fileTitleFallback = episodeInfo ? readableStem.slice(0, episodeInfo.index) : readableStem;
    title = cleanTitle(parentTitle, year) || cleanTitle(fileTitleFallback, year) || (episodeInfo ? "" : rawStem);
  }

  // 1.4 生成统一搜索词和匹配键
  const episodeTag = episodeInfo ? formatEpisodeTag(episodeInfo.season, episodeInfo.episode, episodeInfo.episodeEnd) : "";
  const queryParts = [title];
  if (!episodeInfo && year) queryParts.push(year);
  if (episodeTag) queryParts.push(episodeTag);
  const query = queryParts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || episodeTag || rawStem;
  const mediaType = episodeInfo ? "episode" : "movie";
  const mediaKey = buildMediaKey({ title, year, ...episodeInfo, mediaType });

  const result = {
    mediaType,
    title,
    year: year || "",
    season: episodeInfo?.season || null,
    episode: episodeInfo?.episode || null,
    episodeEnd: episodeInfo?.episodeEnd || null,
    query,
    mediaKey,
    subtitleBaseName: rawStem,
  };
  const enriched = applyNfoMetadata(result, options.nfoMetadata);
  logger.info("解析媒体文件名完成", enriched.query);
  return enriched;
}

/*
 * ================================================================================
 * 步骤1.5：合并 NFO 媒体身份
 * ================================================================================
 * 目标：
 * 1) 优先使用 NFO 中的作品标题、年份和季集号
 * 2) 保留文件名解析结果，并生成中英文检索别名
 */
export function applyNfoMetadata(media, metadata) {
  logger.info("开始合并 NFO 媒体身份...");

  // 1.5.1 没有结构化 NFO 时返回原解析结果
  const nfo = metadata && typeof metadata === "object" ? metadata : null;
  if (!nfo) {
    logger.info("合并 NFO 媒体身份完成: none");
    return media;
  }

  // 1.5.2 电影使用片名，剧集优先使用系列名
  const detectedEpisode = media.mediaType === "episode" || Number(nfo.season) > 0 || Number(nfo.episode) > 0;
  const title = cleanMetadataTitle(
    detectedEpisode
      ? nfo.showTitle || (nfo.mediaType === "tvshow" ? nfo.title : "") || media.title
      : nfo.title || nfo.originalTitle || media.title
  ) || media.title;
  const year = normalizeMetadataYear(nfo.year) || media.year || "";
  const season = normalizeMetadataNumber(nfo.season) || media.season || null;
  const episode = normalizeMetadataNumber(nfo.episode) || media.episode || null;
  const episodeEnd = media.episodeEnd || null;
  const mediaType = season && episode ? "episode" : media.mediaType;

  // 1.5.3 生成主搜索词和别名搜索词
  const episodeTag = mediaType === "episode" ? formatEpisodeTag(season, episode, episodeEnd) : "";
  const query = buildMetadataQuery(title, year, episodeTag, mediaType) || media.query;
  const rawAliases = [
    title,
    ...(Array.isArray(nfo.aliases) ? nfo.aliases : []),
    nfo.originalTitle,
    nfo.sortTitle,
    nfo.showTitle,
  ];
  const searchAliases = uniqueMetadataTitles(rawAliases)
    .filter((alias) => !titlesReferToSameMedia(alias, title) || normalizeComparableText(alias) !== normalizeComparableText(title))
    .map((alias) => buildMetadataQuery(alias, year, episodeTag, mediaType))
    .filter(Boolean)
    .slice(0, 8);

  // 1.5.4 返回可持久化的紧凑元数据
  const result = {
    ...media,
    mediaType,
    title,
    year,
    season,
    episode,
    episodeEnd,
    query,
    mediaKey: buildMediaKey({ title, year, season, episode, episodeEnd, mediaType }),
    searchAliases,
    nfoMetadata: {
      mediaType: nfo.mediaType || mediaType,
      title: cleanMetadataTitle(nfo.title),
      originalTitle: cleanMetadataTitle(nfo.originalTitle),
      showTitle: cleanMetadataTitle(nfo.showTitle),
      year,
      season,
      episode,
      imdbId: String(nfo.imdbId || "").slice(0, 24),
      tmdbId: String(nfo.tmdbId || "").slice(0, 24),
      sourceFile: String(nfo.sourceFile || "").slice(0, 260),
    },
  };
  logger.info("合并 NFO 媒体身份完成", result.query);
  return result;
}

/*
 * ================================================================================
 * 步骤2：匹配已有字幕
 * ================================================================================
 * 目标：
 * 1) 识别与当前视频同名的字幕
 * 2) 兼容“视频名.语言.srt”和去掉发布参数后的常规命名
 * 3) 剧集必须核对季号和集号，避免把同一季其他集误判为已有字幕
 */
export function findExistingSubtitles(videoFileName, subtitleFileNames, options = {}) {
  logger.info("开始匹配已有字幕...", videoFileName);

  // 2.1 解析视频身份
  const video = analyzeMediaFile(videoFileName, options);
  const videoStem = stripExtension(getFileName(videoFileName));
  const normalizedVideoStem = normalizeComparableText(videoStem);

  // 2.2 逐个核对同目录字幕
  const matches = (Array.isArray(subtitleFileNames) ? subtitleFileNames : []).filter((subtitleFileName) => {
    const subtitleExtension = getExtension(subtitleFileName).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(subtitleExtension)) return false;

    const subtitleStem = stripExtension(getFileName(subtitleFileName));
    if (isDirectSubtitleNameMatch(videoStem, subtitleStem)) return true;

    const subtitle = analyzeMediaFile(subtitleFileName, options);
    if (video.mediaType === "episode") {
      if (subtitle.mediaType !== "episode") return false;
      if (video.season !== subtitle.season || video.episode !== subtitle.episode) return false;
      if (video.episodeEnd && subtitle.episodeEnd && video.episodeEnd !== subtitle.episodeEnd) return false;
      if (!video.title || !subtitle.title) return true;
      return titlesReferToSameMedia(video.title, subtitle.title);
    }

    if (subtitle.mediaType !== "movie") return false;
    if (video.year && subtitle.year && video.year !== subtitle.year) return false;
    if (titlesReferToSameMedia(video.title, subtitle.title)) return true;
    return normalizedVideoStem === normalizeComparableText(stripSubtitleQualifiers(subtitleStem));
  });

  // 2.3 返回稳定排序后的字幕名
  const result = matches.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }));
  logger.info("匹配已有字幕完成", result.length);
  return result;
}

/*
 * ================================================================================
 * 步骤3：排序扫描结果
 * ================================================================================
 * 目标：
 * 1) 缺字幕的视频排在已有字幕之前
 * 2) 同一系列按季号、集号连续排列
 * 3) 其他文件按标题和相对路径自然排序
 */
export function compareMediaEntries(left, right) {
  // 3.1 先按字幕状态排序
  const subtitleOrder = Number(Boolean(left?.hasSubtitle)) - Number(Boolean(right?.hasSubtitle));
  if (subtitleOrder) return subtitleOrder;

  // 3.2 再按标题、季号和集号排序
  const titleOrder = String(left?.title || left?.name || "").localeCompare(String(right?.title || right?.name || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
  if (titleOrder) return titleOrder;
  const seasonOrder = Number(left?.season || 0) - Number(right?.season || 0);
  if (seasonOrder) return seasonOrder;
  const episodeOrder = Number(left?.episode || 0) - Number(right?.episode || 0);
  if (episodeOrder) return episodeOrder;

  // 3.3 最后用路径保证顺序稳定
  return String(left?.relativePath || left?.path || left?.name || "").localeCompare(
    String(right?.relativePath || right?.path || right?.name || ""),
    "zh-CN",
    { numeric: true, sensitivity: "base" }
  );
}

function extractEpisodeInfo(readableStem, parentNames) {
  // 1.5 识别 S01E02、1x02 和“第1季第2集”
  const patterns = [
    /\bS(?:eason)?\s*0?(\d{1,2})\s*E(?:p(?:isode)?)?\s*0?(\d{1,3})(?:\s*(?:-|E)\s*(?:E)?0?(\d{1,3}))?\b/i,
    /\b0?(\d{1,2})\s*x\s*0?(\d{1,3})(?:\s*-\s*0?(\d{1,3}))?\b/i,
    /第\s*0?(\d{1,2})\s*季\s*第?\s*0?(\d{1,3})\s*[集话話](?:\s*(?:-|至|到)\s*第?\s*0?(\d{1,3})\s*[集话話]?)?/i,
  ];
  for (const pattern of patterns) {
    const match = readableStem.match(pattern);
    if (!match) continue;
    return {
      season: Number(match[1]),
      episode: Number(match[2]),
      episodeEnd: match[3] ? Number(match[3]) : null,
      index: match.index || 0,
    };
  }

  // 1.6 文件名只有集号时，从 Season 目录补季号
  const parentSeason = extractParentSeason(parentNames);
  const bareEpisode = readableStem.match(/^(?:E|EP|Episode)?\s*0?(\d{1,3})(?:\s*[- ]\s*.*)?$/i);
  if (parentSeason && bareEpisode) {
    return {
      season: parentSeason,
      episode: Number(bareEpisode[1]),
      episodeEnd: null,
      index: 0,
    };
  }
  return null;
}

function extractParentSeason(parentNames) {
  // 1.7 从最近的父目录读取季号
  for (const parentName of parentNames) {
    const normalized = normalizeSeparators(parentName);
    const match = normalized.match(SEASON_FOLDER_PATTERN);
    if (match) return Number(match[1] || match[2]);
  }
  return null;
}

function selectParentTitle(parentNames) {
  // 1.8 跳过 Season、Movies 等容器目录，选择最近的作品目录
  for (const parentName of parentNames) {
    const normalized = normalizeSeparators(parentName);
    if (!normalized || SEASON_FOLDER_PATTERN.test(normalized) || isGenericMediaFolder(normalized)) continue;
    return normalized;
  }
  return "";
}

function cleanTitle(value, year) {
  // 1.9 去除括号、年份、清晰度和发布参数
  let title = normalizeSeparators(value)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\(([^)]*)\)/g, (full, content) => (/^(?:19|20)\d{2}$/.test(content.trim()) ? ` ${content.trim()} ` : " "));
  const noiseMatch = title.match(RELEASE_NOISE_PATTERN);
  if (noiseMatch?.index != null) title = title.slice(0, noiseMatch.index);
  title = stripSubtitleQualifiers(title);
  if (year) title = title.replace(new RegExp(`\\b${escapeRegExp(year)}\\b`, "g"), " ");
  return title
    .replace(RELEASE_FLAG_PATTERN, " ")
    .replace(/\s+-\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(value) {
  // 1.10 读取最后一个 1900-2099 年份，避免把《1917》《2001》一类片名当成年份
  const normalized = normalizeSeparators(value);
  const matches = [...normalized.matchAll(/\b((?:19|20)\d{2})\b/g)];
  if (!matches.length) return "";
  const lastMatch = matches[matches.length - 1];
  if (matches.length === 1 && lastMatch.index === 0 && normalized !== lastMatch[0]) return "";
  if (matches.length === 1 && normalized === lastMatch[0]) return "";
  return lastMatch[1];
}

function formatEpisodeTag(season, episode, episodeEnd) {
  // 1.11 将季集号统一成 S01E02 格式
  const start = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return episodeEnd ? `${start}-E${String(episodeEnd).padStart(2, "0")}` : start;
}

function buildMetadataQuery(title, year, episodeTag, mediaType) {
  // 1.19 按电影或剧集身份组合稳定搜索词
  return [title, mediaType === "movie" ? year : "", episodeTag]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueMetadataTitles(values) {
  // 1.20 清理并去重 NFO 标题
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const title = cleanMetadataTitle(value);
    const key = normalizeComparableText(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(title);
  }
  return output;
}

function cleanMetadataTitle(value) {
  // 1.21 限制外部元数据长度并清理空白
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 300);
}

function normalizeMetadataYear(value) {
  // 1.22 只接受合理的四位年份
  const match = String(value || "").match(/(?:19|20)\d{2}/);
  return match ? match[0] : "";
}

function normalizeMetadataNumber(value) {
  // 1.23 季集号只接受正整数
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function buildMediaKey(media) {
  // 1.12 生成同作品聚合键
  const titleKey = normalizeComparableText(media.title);
  if (media.mediaType === "episode") {
    return `${titleKey}:s${String(media.season).padStart(2, "0")}e${String(media.episode).padStart(2, "0")}`;
  }
  return `${titleKey}:${media.year || ""}`;
}

function isDirectSubtitleNameMatch(videoStem, subtitleStem) {
  // 2.4 支持视频同名和“视频名.语言”格式
  const videoName = String(videoStem || "").normalize("NFKC").toLowerCase();
  const subtitleName = String(subtitleStem || "").normalize("NFKC").toLowerCase();
  return subtitleName === videoName || subtitleName.startsWith(`${videoName}.`) || subtitleName.startsWith(`${videoName} `);
}

function titlesReferToSameMedia(left, right) {
  // 2.5 标题完全相同或一个是另一个的明确长标题时视为同作品
  const leftKey = normalizeComparableText(left);
  const rightKey = normalizeComparableText(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  const shortestLength = Math.min(leftKey.length, rightKey.length);
  return shortestLength >= 6 && (leftKey.includes(rightKey) || rightKey.includes(leftKey));
}

function stripSubtitleQualifiers(value) {
  // 2.6 去掉常见语言、来源和 default 后缀
  return String(value || "")
    .replace(/[ ._-](?:zh(?:[ ._-]?(?:cn|tw))?|zho|chi|chs|cht|sc|tc|chinese(?:\([^)]*\))?|en|eng|ja|jpn|default)(?:[ ._\-()].*)?$/i, "")
    .trim();
}

function normalizeSeparators(value) {
  // 1.13 将点、下划线和连续空白统一为空格
  return String(value || "")
    .normalize("NFKC")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value) {
  // 2.7 保留字母、数字和中文，生成不受标点影响的比较值
  return (String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join("");
}

function isGenericMediaFolder(value) {
  // 1.14 判断是否为无作品含义的容器目录
  return GENERIC_MEDIA_FOLDERS.has(normalizeComparableText(value));
}

function escapeRegExp(value) {
  // 1.15 转义动态正则内容
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFileName(value) {
  // 1.16 去掉目录部分，只保留文件名
  return String(value || "").split(/[\\/]/).pop() || "";
}

function getExtension(value) {
  // 1.17 读取文件扩展名
  const fileName = getFileName(value);
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index) : "";
}

function stripExtension(value) {
  // 1.18 去掉最后一个文件扩展名
  const fileName = getFileName(value);
  const extension = getExtension(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}
