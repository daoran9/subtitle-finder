import { extractAvIdentity, sameAvIdentity } from "./av-identity.js";

export const DEFAULT_MIN_SUBTITLE_SIZE_KB = 20;

const SOURCE_QUALITY_WEIGHT = {
  shooter: 18,
  "thunder-fingerprint": 18,
  thunder: 14,
  addic7ed: 14,
  assrt: 13,
  subtitlecat: 12,
  tvsubtitles: 12,
  subf2m: 11,
  yify: 11,
  moviesubtitles: 10,
  aiyi: 9,
  avsubtitles: 8,
};

const RELEASE_TOKEN_PATTERNS = [
  ["web-dl", /\bweb[ ._-]?dl\b/i],
  ["webrip", /\bweb[ ._-]?rip\b/i],
  ["bluray", /\bblu[ ._-]?ray|\bbluray\b/i],
  ["hdtv", /\bhdtv\b/i],
  ["dvdrip", /\bdvd[ ._-]?rip\b/i],
  ["remux", /\b(?:bd)?remux\b/i],
  ["2160p", /\b2160p|\b4k\b/i],
  ["1080p", /\b1080p\b/i],
  ["720p", /\b720p\b/i],
  ["x265", /\bx265|\bh265|\bhevc\b/i],
  ["x264", /\bx264|\bh264\b/i],
];

const logger = {
  info: (...args) => console.info("[SubtitleFinderRules]", ...args),
};

/*
 * ================================================================================
 * 步骤1：分析字幕语言特征
 * ================================================================================
 * 目标：
 * 1) 从来源语言字段和文件名识别简体、繁体、英文、日文
 * 2) 识别中英双语，供质量排序和 Emby 命名复用
 */
export function analyzeSubtitleLanguage(value) {
  logger.info("开始分析字幕语言特征...");

  // 1.1 归一化语言描述
  const text = String(value || "").normalize("NFKC").toLowerCase();
  const compact = text.replace(/[\s._-]+/g, "");

  // 1.2 识别各语言和双语标记
  const simplified = /简|简体|chs|zhcn|zhhans|simplified|chinesesimplified/.test(compact);
  const traditional = /繁|繁体|cht|zhtw|zhhant|traditional|big5|chinesetraditional/.test(compact);
  const chinese = simplified || traditional || /中文|chinese|\bzh\b|\bzho\b|\bchi\b/i.test(text);
  const english = /英|英文|english|\beng\b|\ben\b/i.test(text);
  const japanese = /日|日文|japanese|\bjpn\b|\bja\b/i.test(text);
  const bilingual = chinese && english || /简英|繁英|中英|双语|雙語|bilingual|dual/.test(compact);
  const result = { simplified, traditional, chinese, english, japanese, bilingual };

  logger.info("分析字幕语言特征完成", result);
  return result;
}

/*
 * ================================================================================
 * 步骤2：计算字幕结果质量分
 * ================================================================================
 * 目标：
 * 1) 番号模式先核对身份，再综合语言、版本、格式和来源
 * 2) 输出统一的 0-100 分，避免错误番号靠来源分排在前面
 */
export function scoreSubtitleCandidate(result, context = {}) {
  logger.info("开始计算字幕结果质量分...");

  // 2.1 读取结果和检索上下文
  const text = [result?.catalogCode, result?.title, result?.fileName, result?.extra, result?.language].filter(Boolean).join(" ");
  const language = String(context.language || "zh-CN");
  const languageProfile = analyzeSubtitleLanguage(text);
  const requestedEpisode = context.requestedEpisode || extractEpisodeToken(context.query || "");
  const catalogIdentity = context.catalogIdentity || extractAvIdentity(context.catalogCode || context.query || "");
  const candidateIdentity = extractAvIdentity(text, { allowLooseCode: Boolean(catalogIdentity) });
  const resultEpisode = extractEpisodeToken(text);
  const queryReleaseTokens = extractReleaseTokens(context.releaseName || context.query || "");
  const resultReleaseTokens = extractReleaseTokens(text);
  let score = 28;
  const reasons = [];

  // 2.1.1 番号身份是 AV 模式的硬排序条件，错误号码不能被语言或下载量抵消。
  if (catalogIdentity) {
    if (result?.fingerprintMatch) {
      score += 80;
      reasons.push("指纹匹配");
    } else if (candidateIdentity && sameAvIdentity(candidateIdentity, catalogIdentity)) {
      score += 65;
      reasons.push("番号匹配");
    } else if (candidateIdentity) {
      score -= 100;
      reasons.push("番号不符");
    }
  }

  // 2.2 评价目标语言
  if (language === "zh-CN") {
    if (languageProfile.simplified) {
      score += 24;
      reasons.push("简体");
    } else if (languageProfile.traditional) {
      score += 8;
      reasons.push("繁体");
    } else if (languageProfile.chinese) {
      score += 16;
      reasons.push("中文");
    }
  } else if (language === "zh-TW") {
    if (languageProfile.traditional) {
      score += 24;
      reasons.push("繁体");
    } else if (languageProfile.simplified) {
      score += 8;
      reasons.push("简体");
    } else if (languageProfile.chinese) {
      score += 16;
      reasons.push("中文");
    }
  } else if (language === "en" && languageProfile.english) {
    score += 24;
    reasons.push("英文");
  } else if (language === "ja" && languageProfile.japanese) {
    score += 24;
    reasons.push("日文");
  }
  if (languageProfile.bilingual && language.startsWith("zh")) {
    score += 5;
    reasons.push("双语");
  }

  // 2.2.1 非番号搜索仍保留原有指纹加分。
  if (result?.fingerprintMatch && !catalogIdentity) {
    score += 24;
    reasons.push("指纹匹配");
  }

  // 2.3 评价季集号和发布版本
  if (requestedEpisode.season && requestedEpisode.episode) {
    if (resultEpisode.season === requestedEpisode.season && resultEpisode.episode === requestedEpisode.episode) {
      score += 20;
      reasons.push("集数匹配");
    } else if (resultEpisode.season || resultEpisode.episode) {
      score -= 35;
    }
  }
  const releaseMatches = queryReleaseTokens.filter((token) => resultReleaseTokens.includes(token));
  if (releaseMatches.length) {
    score += Math.min(12, releaseMatches.length * 4);
    reasons.push("版本匹配");
  }

  // 2.4 评价格式、来源和站点原始反馈
  const extension = getExtension(result?.fileName || result?.ext || "");
  if (extension === ".ass" || extension === ".ssa") score += 5;
  else if (extension === ".srt") score += 4;
  else if (extension === ".vtt") score += 2;
  score += Number(SOURCE_QUALITY_WEIGHT[result?.source] || 6);
  const upstreamScore = Number(result?.score);
  const downloadCount = parseCount(result?.downloads);
  if (Number.isFinite(upstreamScore) && upstreamScore > 0) score += Math.min(7, Math.log10(upstreamScore + 1) * 2.5);
  if (downloadCount > 0) score += Math.min(6, Math.log10(downloadCount + 1) * 1.8);
  if (/translated from|machine|自动翻译|机翻/i.test(text)) score -= 8;
  if (/sample|preview|trailer/i.test(text)) score -= 25;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  if (replacementCount) {
    score -= Math.min(32, replacementCount * 8);
    reasons.push("文件名异常");
  }

  // 2.4.1 同番号时用时长接近度辅助排序，缺失时长不扣分。
  const videoDurationMs = Number(context.videoDurationMs || 0);
  const candidateDurationMs = parseDurationMs(result?.durationMs || result?.duration);
  const durationDeltaMs = videoDurationMs > 0 && candidateDurationMs > 0
    ? Math.abs(videoDurationMs - candidateDurationMs)
    : 0;
  if (catalogIdentity && durationDeltaMs > 0) {
    score += Math.max(0, 12 - Math.round(durationDeltaMs / 60000));
  }

  // 2.5 生成稳定排序字段
  const qualityScore = clamp(Math.round(score), 0, 100);
  const resultValue = {
    qualityScore,
    qualityReasons: reasons,
    languageProfile,
    releaseMatchCount: releaseMatches.length,
    catalogCode: candidateIdentity?.canonicalCode || "",
    catalogMatch: Boolean(catalogIdentity && candidateIdentity && sameAvIdentity(candidateIdentity, catalogIdentity)),
    durationDeltaMs,
  };

  logger.info("计算字幕结果质量分完成", qualityScore);
  return resultValue;
}

/*
 * ================================================================================
 * 步骤3：计算压缩包字幕文件分
 * ================================================================================
 * 目标：
 * 1) 从 ZIP 或 RAR 的多个文件中选出目标语言和目标集数
 * 2) 番号包先排除明确错误号码，再比较语言和发布版本
 */
export function scoreArchiveSubtitle(fileName, context = {}) {
  logger.info("开始计算压缩包字幕文件分...");

  // 3.1 读取包内文件特征
  const text = String(fileName || "").normalize("NFKC");
  const lower = text.toLowerCase();
  const extension = getExtension(lower);
  const languageProfile = analyzeSubtitleLanguage(text);
  const requestedEpisode = context.requestedEpisode || extractEpisodeToken(context.query || context.releaseName || "");
  const catalogIdentity = context.catalogIdentity || extractAvIdentity(context.catalogCode || context.query || "");
  const fileIdentity = extractAvIdentity(text, { allowLooseCode: Boolean(catalogIdentity) });
  const fileEpisode = extractEpisodeToken(text);
  const requestedRelease = extractReleaseTokens(context.releaseName || context.query || "");
  const fileRelease = extractReleaseTokens(text);
  let score = 0;

  // 3.1.1 包内文件明确带有其他番号时，禁止被语言分选中。
  if (catalogIdentity && fileIdentity && !sameAvIdentity(fileIdentity, catalogIdentity)) {
    logger.info("计算压缩包字幕文件分完成: 番号不符");
    return Number.NEGATIVE_INFINITY;
  }
  if (catalogIdentity && fileIdentity && sameAvIdentity(fileIdentity, catalogIdentity)) score += 100;

  // 3.2 评价文件类型和目录噪声
  if (extension === ".ass" || extension === ".ssa") score += 14;
  else if (extension === ".srt") score += 13;
  else if (extension === ".vtt") score += 9;
  else if (extension === ".sub") score += 5;
  if (lower.includes("__macosx") || /(?:^|\/)\./.test(lower)) score -= 50;
  if (/sample|preview|trailer|说明|readme|广告/.test(lower)) score -= 45;

  // 3.3 评价语言和双语
  const language = String(context.language || "zh-CN");
  if (language === "zh-CN") {
    if (languageProfile.simplified) score += 30;
    else if (languageProfile.traditional) score += 6;
    else if (languageProfile.chinese) score += 20;
  } else if (language === "zh-TW") {
    if (languageProfile.traditional) score += 30;
    else if (languageProfile.simplified) score += 6;
    else if (languageProfile.chinese) score += 20;
  } else if (language === "en" && languageProfile.english) score += 28;
  else if (language === "ja" && languageProfile.japanese) score += 28;
  if (languageProfile.bilingual && language.startsWith("zh")) score += 6;

  // 3.4 评价集数和发布版本
  if (requestedEpisode.season && requestedEpisode.episode) {
    if (fileEpisode.season === requestedEpisode.season && fileEpisode.episode === requestedEpisode.episode) score += 55;
    else if (fileEpisode.season || fileEpisode.episode) score -= 70;
  }
  score += Math.min(24, requestedRelease.filter((token) => fileRelease.includes(token)).length * 6);

  logger.info("计算压缩包字幕文件分完成", score);
  return score;
}

/*
 * ================================================================================
 * 步骤4：生成媒体库字幕主文件名
 * ================================================================================
 * 目标：
 * 1) 支持通用媒体库、Emby 和视频同名三种预设
 * 2) 保留视频主文件名，由保存层追加字幕扩展名
 */
export function buildSubtitleBaseName(videoFileName, options = {}) {
  logger.info("开始生成媒体库字幕主文件名...");

  // 4.1 读取命名参数
  const stem = stripExtension(getFileName(videoFileName)) || "video";
  const preset = String(options.preset || "media-server");
  const language = String(options.language || "zh-CN");
  const source = sanitizeSourceName(options.source || "subtitle");
  const languageProfile = options.languageProfile || {};
  let result = stem;

  // 4.2 按预设追加语言标记
  if (preset === "same-name") {
    result = stem;
  } else if (preset === "emby" && language.startsWith("zh")) {
    const chineseLabel = language === "zh-TW"
      ? (languageProfile.bilingual ? "繁英" : "繁")
      : (languageProfile.bilingual ? "简英" : "简");
    result = `${stem}.chinese(${chineseLabel},${source})`;
  } else {
    result = `${stem}.${getLanguageTag(language)}`;
  }

  logger.info("生成媒体库字幕主文件名完成", result);
  return result;
}

export function extractEpisodeToken(value) {
  // 3.5 识别 S01E02、1x02 和中文季集号
  const text = String(value || "");
  const sxe = text.match(/\bs0*(\d{1,2})\s*e0*(\d{1,3})\b/i);
  if (sxe) return { season: Number(sxe[1]), episode: Number(sxe[2]) };
  const nxm = text.match(/\b0*(\d{1,2})\s*x\s*0*(\d{1,3})\b/i);
  if (nxm) return { season: Number(nxm[1]), episode: Number(nxm[2]) };
  const chinese = text.match(/第\s*0?(\d{1,2})\s*季\s*第?\s*0?(\d{1,3})\s*[集话話]/i);
  if (chinese) return { season: Number(chinese[1]), episode: Number(chinese[2]) };
  return { season: 0, episode: 0 };
}

function extractReleaseTokens(value) {
  // 2.6 提取可比较的发布版本标记
  const text = String(value || "");
  return RELEASE_TOKEN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([token]) => token);
}

function getLanguageTag(language) {
  // 4.3 生成媒体库通用语言代码
  if (language === "zh-CN") return "zh";
  if (language === "zh-TW") return "zh-TW";
  return language || "zh";
}

function sanitizeSourceName(value) {
  // 4.4 清理 Emby 括号内的来源名
  return String(value || "subtitle").toLowerCase().replace(/[^a-z0-9_-]+/g, "").slice(0, 24) || "subtitle";
}

function parseCount(value) {
  // 2.7 解析下载数字段
  const number = Number(String(value || "").replace(/[^0-9.]+/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function getFileName(value) {
  // 4.5 去掉目录，只保留文件名
  return String(value || "").split(/[\\/]/).pop() || "";
}

function getExtension(value) {
  // 2.8 读取最后一个扩展名
  const fileName = getFileName(value);
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index).toLowerCase() : "";
}

function parseDurationMs(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  const match = String(value || "").match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return (Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
}

function stripExtension(value) {
  // 4.6 去掉最后一个扩展名
  const extension = getExtension(value);
  return extension ? String(value).slice(0, -extension.length) : String(value || "");
}

function clamp(value, min, max) {
  // 2.9 限制质量分范围
  return Math.min(max, Math.max(min, value));
}
