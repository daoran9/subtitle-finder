const SUBTITLE_EXTENSION_PATTERN = /\.(?:srt|ass|ssa|vtt|sub)$/i;

const logger = {
  info: (...args) => console.info("[SubtitleFinderSync]", ...args),
};

/*
 * ================================================================================
 * 步骤1：生成校时字幕文件名
 * ================================================================================
 * 目标：
 * 1) 优先沿用媒体库命名结果
 * 2) 固定输出独立的 synced SRT，不覆盖原字幕
 */
export function buildSyncedSubtitleFileName(sourceFileName, preferredBaseName = "") {
  logger.info("开始生成校时字幕文件名...");

  // 1.1 清理来源路径、扩展名和已有校时后缀
  const sourceName = String(sourceFileName || "subtitle.srt").split(/[\\/]/).pop() || "subtitle.srt";
  const preferred = String(preferredBaseName || "").trim();
  let baseName = preferred || sourceName.replace(SUBTITLE_EXTENSION_PATTERN, "");
  baseName = baseName.replace(/\.synced$/i, "").trim() || "subtitle";
  const result = `${baseName}.synced.srt`;

  logger.info("生成校时字幕文件名完成", result);
  return result;
}

/*
 * ================================================================================
 * 步骤2：解析 ffsubsync 进度
 * ================================================================================
 * 目标：
 * 1) 接受 GUI 模式输出的独立百分比行
 * 2) 拒绝日志中的分数、时间和其他数字
 */
export function parseFfsubsyncProgress(value) {
  logger.info("开始解析 ffsubsync 进度...");

  // 2.1 只解析完整的 0 到 100 数字行
  const match = String(value || "").trim().match(/^(\d{1,3})%?$/);
  const number = match ? Number(match[1]) : Number.NaN;
  const result = Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;

  logger.info("解析 ffsubsync 进度完成", result == null ? "none" : result);
  return result;
}

/*
 * ================================================================================
 * 步骤3：解析 ffsubsync 校时摘要
 * ================================================================================
 * 目标：
 * 1) 识别工具主动拒绝的低质量结果
 * 2) 提取分数、偏移和帧率比例供界面展示
 */
export function parseFfsubsyncSummary(value) {
  logger.info("开始解析 ffsubsync 校时摘要...");

  // 3.1 从完整日志读取质量标记和数值
  const log = String(value || "");
  const score = parseLoggedNumber(log, /\bscore:\s*(-?\d+(?:\.\d+)?)/i);
  const offsetSeconds = parseLoggedNumber(log, /\boffset seconds:\s*(-?\d+(?:\.\d+)?)/i);
  const framerateScale = parseLoggedNumber(log, /\bframerate scale factor:\s*(-?\d+(?:\.\d+)?)/i);
  const lowQuality = /\blow-quality\s+alignment\b/i.test(log);
  const lowQualityMatch = log.match(
    /\blow-quality\s+alignment\s*\(([\s\S]{0,1000}?)\)\s*;\s*leaving\s+subtitles\s+unmodified/i
  );
  const result = {
    lowQuality,
    lowQualityReason: lowQualityMatch ? lowQualityMatch[1].replace(/\s+/g, " ").trim() : "",
    score,
    offsetSeconds,
    framerateScale,
  };

  logger.info("解析 ffsubsync 校时摘要完成", result.lowQuality ? "low-quality" : "accepted");
  return result;
}

function parseLoggedNumber(value, pattern) {
  // 3.2 缺失或无效数值保持 null
  const match = value.match(pattern);
  const number = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
