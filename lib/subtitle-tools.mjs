import OpenCC from "opencc-js";
import { parseCustomConversionDictionary } from "../public/conversion-dictionary.js";

export { parseCustomConversionDictionary } from "../public/conversion-dictionary.js";

const logger = {
  info: (...args) => console.info("[SubtitleFinderSubtitleTools]", ...args),
};

let simplifiedConverter = null;
let traditionalConverter = null;

/*
 * ================================================================================
 * 步骤1：校验字幕结构
 * ================================================================================
 * 目标：
 * 1) 拒绝网页、空文件和没有有效时间轴的伪字幕
 * 2) 将语言不符保留为提示，不阻止用户预览和手动下载
 * 3) 统计有效对白、时长和语言信号，供预览与批量下载复用
 */
export function validateSubtitleText(text, options = {}) {
  logger.info("开始校验字幕结构...");

  // 1.1 读取格式并排除明显网页或二进制文本
  const source = String(text || "").replace(/^\uFEFF/, "");
  const fileName = String(options.fileName || "subtitle.srt");
  const extension = getExtension(fileName);
  if (!source.trim()) {
    const result = invalidResult("字幕内容为空", extension);
    logger.info("校验字幕结构完成: empty");
    return result;
  }
  if (looksLikeHtml(source, options.contentType)) {
    const result = invalidResult("下载内容是网页，不是字幕文件", extension);
    logger.info("校验字幕结构完成: html");
    return result;
  }
  if (looksBinary(source)) {
    const result = invalidResult("字幕包含无法解析的二进制内容", extension);
    logger.info("校验字幕结构完成: binary");
    return result;
  }

  // 1.2 按格式提取时间轴和对白
  const parsed = parseTimedSubtitle(source, extension);
  if (!parsed.cues.length) {
    const result = invalidResult("没有找到有效字幕时间轴", parsed.format || extension);
    logger.info("校验字幕结构完成: no cues");
    return result;
  }

  // 1.3 检查时间范围和有效对白
  const validCues = parsed.cues.filter((cue) => (
    Number.isFinite(cue.start) &&
    Number.isFinite(cue.end) &&
    cue.start >= 0 &&
    cue.end > cue.start &&
    cue.end <= 172800 &&
    stripSubtitleMarkup(cue.text).length > 0
  ));
  if (!validCues.length) {
    const result = invalidResult("字幕时间轴或对白无效", parsed.format);
    logger.info("校验字幕结构完成: invalid cues");
    return result;
  }

  // 1.4 识别目标语言是否明显不匹配，但不把有效字幕当作无效文件
  const dialogueText = validCues.map((cue) => stripSubtitleMarkup(cue.text)).join("\n");
  const language = analyzeTextLanguage(dialogueText, options.language);

  // 1.5 返回可展示的校验摘要，并将语言不符作为非阻断提示
  const warnings = [];
  if (language.match === false && language.message) warnings.push(language.message);
  if (validCues.length < parsed.cues.length) warnings.push(`${parsed.cues.length - validCues.length} 条时间轴无效`);
  if (validCues.length < 3) warnings.push("字幕条目较少");
  const result = {
    valid: true,
    format: parsed.format,
    cueCount: validCues.length,
    durationSeconds: Math.max(...validCues.map((cue) => cue.end)),
    warnings,
    language,
  };
  logger.info("校验字幕结构完成", result.format, result.cueCount);
  return result;
}

/*
 * ================================================================================
 * 步骤2：转换字幕简繁体
 * ================================================================================
 * 目标：
 * 1) 用 OpenCC 词库转换字幕文本
 * 2) 保留原时间轴、样式和换行结构
 */
export function convertSubtitleChinese(text, targetLanguage, options = {}) {
  logger.info("开始转换字幕简繁体...", targetLanguage);

  // 2.1 解析自定义词库并用占位符保护指定词组
  const customEntries = parseCustomConversionDictionary(options.customDictionary || "");
  const directionEntries = customEntries
    .map((entry) => targetLanguage === "zh-TW"
      ? { source: entry.simplified, target: entry.traditional }
      : { source: entry.traditional, target: entry.simplified })
    .filter((entry) => entry.source && entry.target)
    .sort((left, right) => right.source.length - left.source.length);
  let protectedText = String(text || "");
  const placeholders = [];
  for (const entry of directionEntries) {
    const placeholder = `\uE000SUBTITLEFINDER${placeholders.length}\uE001`;
    const replaced = replaceAllLiteral(protectedText, entry.source, placeholder);
    if (replaced !== protectedText) {
      protectedText = replaced;
      placeholders.push({ placeholder, target: entry.target });
    }
  }

  // 2.2 按目标语言延迟创建转换器
  let converter;
  if (targetLanguage === "zh-CN") {
    simplifiedConverter ||= OpenCC.Converter({ from: "twp", to: "cn" });
    converter = simplifiedConverter;
  } else if (targetLanguage === "zh-TW") {
    traditionalConverter ||= OpenCC.Converter({ from: "cn", to: "twp" });
    converter = traditionalConverter;
  } else {
    throw new Error("不支持的字幕转换目标");
  }

  // 2.3 转换完整文本并恢复用户指定的目标词组
  let result = converter(protectedText);
  for (const entry of placeholders) {
    result = replaceAllLiteral(result, entry.placeholder, entry.target);
  }
  logger.info("转换字幕简繁体完成", result.length);
  return result;
}

function replaceAllLiteral(value, source, target) {
  // 3.2 按字面量替换，避免词条被当成正则表达式
  return source ? String(value).split(source).join(target) : String(value);
}

export function buildConvertedSubtitleFileName(fileName, targetLanguage) {
  // 2.3 替换已有语言后缀并保留字幕扩展名
  const safeName = String(fileName || "subtitle.srt").split(/[\\/]/).pop() || "subtitle.srt";
  const extension = getExtension(safeName) || ".srt";
  const suffix = targetLanguage === "zh-TW" ? "cht" : "chs";
  let baseName = extension ? safeName.slice(0, -extension.length) : safeName;
  baseName = baseName.replace(/[ ._-](?:chs|cht|zh(?:[ ._-]?(?:cn|tw|hans|hant))?|sc|tc)$/i, "");
  return `${baseName}.${suffix}${extension}`;
}

function parseTimedSubtitle(source, extension) {
  // 1.6 根据扩展名和内容特征选择解析器
  if (extension === ".ass" || extension === ".ssa" || /^\s*\[(?:Script Info|Events)\]/im.test(source)) {
    return { format: extension === ".ssa" ? "SSA" : "ASS", cues: parseAssCues(source) };
  }
  if (extension === ".vtt" || /^WEBVTT\b/im.test(source)) {
    return { format: "VTT", cues: parseArrowCues(source) };
  }
  if (extension === ".sub" && /\{\d+\}\{\d+\}/.test(source)) {
    return { format: "MicroDVD SUB", cues: parseMicroDvdCues(source) };
  }
  return { format: "SRT", cues: parseArrowCues(source) };
}

function parseArrowCues(source) {
  // 1.7 解析 SRT 和 WebVTT 的箭头时间轴
  const cues = [];
  const pattern = /(?:^|\n)\s*(?:\d+\s*\n)?\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?)[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  for (const match of source.replace(/\r\n?/g, "\n").matchAll(pattern)) {
    cues.push({ start: parseClock(match[1]), end: parseClock(match[2]), text: match[3] });
  }
  return cues;
}

function parseAssCues(source) {
  // 1.8 按 Events Format 字段定位 ASS/SSA 的时间和对白列
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const cues = [];
  let inEvents = false;
  let fields = [];
  for (const line of lines) {
    if (/^\s*\[Events\]\s*$/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (/^\s*\[/.test(line) && !/^\s*\[Events\]\s*$/i.test(line)) inEvents = false;
    if (!inEvents) continue;
    const formatMatch = line.match(/^\s*Format\s*:\s*(.+)$/i);
    if (formatMatch) {
      fields = formatMatch[1].split(",").map((item) => item.trim().toLowerCase());
      continue;
    }
    const dialogueMatch = line.match(/^\s*Dialogue\s*:\s*(.*)$/i);
    if (!dialogueMatch) continue;
    const startIndex = fields.indexOf("start");
    const endIndex = fields.indexOf("end");
    const textIndex = fields.indexOf("text");
    const expectedFields = Math.max(fields.length, 10);
    const parts = splitLimited(dialogueMatch[1], expectedFields);
    cues.push({
      start: parseClock(parts[startIndex >= 0 ? startIndex : 1]),
      end: parseClock(parts[endIndex >= 0 ? endIndex : 2]),
      text: parts[textIndex >= 0 ? textIndex : 9] || "",
    });
  }
  return cues;
}

function parseMicroDvdCues(source) {
  // 1.9 按默认 25fps 校验 MicroDVD 帧时间轴
  const cues = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!match) continue;
    cues.push({ start: Number(match[1]) / 25, end: Number(match[2]) / 25, text: match[3] });
  }
  return cues;
}

function splitLimited(value, count) {
  // 1.10 只切分前 N-1 个逗号，保留对白中的逗号
  const output = [];
  let remaining = String(value || "");
  for (let index = 1; index < count; index += 1) {
    const commaIndex = remaining.indexOf(",");
    if (commaIndex < 0) break;
    output.push(remaining.slice(0, commaIndex));
    remaining = remaining.slice(commaIndex + 1);
  }
  output.push(remaining);
  return output;
}

function parseClock(value) {
  // 1.11 将 SRT、VTT 和 ASS 时间统一为秒
  const parts = String(value || "").trim().replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return Number.NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function analyzeTextLanguage(text, requestedLanguage) {
  // 1.12 统计汉字、假名和拉丁字母，识别明显语言错配
  const value = String(text || "");
  const han = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const kana = (value.match(/[\u3040-\u30ff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const meaningful = han + kana + latin;
  let match = meaningful < 40 ? null : true;
  let message = "";
  if ((requestedLanguage === "zh-CN" || requestedLanguage === "zh-TW") && meaningful >= 40 && han < 4 && latin > 30) {
    match = false;
    message = "字幕内容与所选中文语言不符";
  } else if (requestedLanguage === "en" && meaningful >= 40 && latin < 8 && han > 30 && kana === 0) {
    match = false;
    message = "字幕内容与所选英文语言不符";
  } else if (requestedLanguage === "ja" && meaningful >= 40 && kana === 0 && han < 4 && latin > 30) {
    match = false;
    message = "字幕内容与所选日文语言不符";
  }
  return { match, han, kana, latin, message };
}

function stripSubtitleMarkup(value) {
  // 1.13 清理样式标记，只保留可见对白
  return String(value || "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\[Nnh]/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHtml(source, contentType) {
  // 1.14 同时检查响应类型和正文标签
  const head = source.slice(0, 2048).toLowerCase();
  return /text\/html/i.test(String(contentType || "")) || /<!doctype\s+html|<html\b|<body\b|<head\b/.test(head);
}

function looksBinary(source) {
  // 1.15 控制字符比例过高时视为二进制内容
  const sample = source.slice(0, 4096);
  const controls = (sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return controls > Math.max(4, sample.length * 0.02);
}

function invalidResult(message, format) {
  // 1.16 返回统一失败结构
  return { valid: false, format: String(format || "").replace(/^\./, "").toUpperCase(), cueCount: 0, durationSeconds: 0, warnings: [], message };
}

function getExtension(fileName) {
  // 1.17 读取字幕扩展名
  const safeName = String(fileName || "").split(/[\\/]/).pop() || "";
  const index = safeName.lastIndexOf(".");
  return index > 0 ? safeName.slice(index).toLowerCase() : "";
}
