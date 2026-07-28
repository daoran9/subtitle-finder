const MAX_DICTIONARY_ENTRIES = 200;
const MAX_DICTIONARY_TERM_LENGTH = 80;

const logger = {
  info: (...args) => console.info("[SubtitleFinderConversionDictionary]", ...args),
};

/*
 * ================================================================================
 * 步骤1：解析自定义简繁词库
 * ================================================================================
 * 目标：
 * 1) 接收“简体=繁体”格式的双向词条
 * 2) 拒绝歧义、重复和过大的词库
 */
export function parseCustomConversionDictionary(value) {
  logger.info("开始解析自定义简繁词库...");

  // 1.1 逐行解析有效词条
  const entries = [];
  const seen = new Set();
  const lines = String(value || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex !== line.lastIndexOf("=")) {
      throw new Error(`自定义词库第 ${index + 1} 行应为“简体=繁体”`);
    }
    const simplified = line.slice(0, separatorIndex).trim();
    const traditional = line.slice(separatorIndex + 1).trim();
    if (!simplified || !traditional) {
      throw new Error(`自定义词库第 ${index + 1} 行缺少词语`);
    }
    if (simplified.length > MAX_DICTIONARY_TERM_LENGTH || traditional.length > MAX_DICTIONARY_TERM_LENGTH) {
      throw new Error(`自定义词库第 ${index + 1} 行词语不能超过 ${MAX_DICTIONARY_TERM_LENGTH} 个字符`);
    }
    const key = `${simplified}\u0000${traditional}`;
    if (seen.has(key)) continue;
    entries.push({ simplified, traditional });
    seen.add(key);
    if (entries.length > MAX_DICTIONARY_ENTRIES) {
      throw new Error(`自定义词库不能超过 ${MAX_DICTIONARY_ENTRIES} 条`);
    }
  }

  logger.info("解析自定义简繁词库完成", entries.length);
  return entries;
}
