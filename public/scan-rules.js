const MAX_SCAN_RULES = 100;
const MAX_SCAN_RULE_LENGTH = 240;

const logger = {
  info: (...args) => console.info("[SubtitleFinderScanRules]", ...args),
};

/*
 * ================================================================================
 * 步骤1：解析扫描排除规则
 * ================================================================================
 * 目标：
 * 1) 接收每行一条的 glob 规则
 * 2) 忽略空行和注释并限制规则数量与长度
 */
export function parseScanExclusionRules(value) {
  logger.info("开始解析扫描排除规则...");

  // 1.1 规范换行、路径分隔符和重复规则
  const rules = [];
  const seen = new Set();
  const source = Array.isArray(value) ? value.join("\n") : String(value || "");
  for (const rawLine of source.split(/\r?\n/)) {
    const rule = normalizeRule(rawLine);
    if (!rule || rule.startsWith("#") || seen.has(rule.toLowerCase())) continue;
    if (rule.length > MAX_SCAN_RULE_LENGTH) {
      throw new Error(`排除规则不能超过 ${MAX_SCAN_RULE_LENGTH} 个字符`);
    }
    rules.push(rule);
    seen.add(rule.toLowerCase());
    if (rules.length > MAX_SCAN_RULES) {
      throw new Error(`排除规则不能超过 ${MAX_SCAN_RULES} 条`);
    }
  }

  logger.info("解析扫描排除规则完成", rules.length);
  return rules;
}

/*
 * ================================================================================
 * 步骤2：匹配扫描路径
 * ================================================================================
 * 目标：
 * 1) 带斜杠规则匹配相对路径
 * 2) 不带斜杠规则匹配任意层级的文件或目录名
 */
export function shouldExcludeScanPath(relativePath, rules) {
  logger.info("开始匹配扫描排除规则...");

  // 2.1 创建一次性匹配器并检查路径
  const excluded = createScanExclusionMatcher(rules)(relativePath);

  logger.info("匹配扫描排除规则完成", excluded);
  return excluded;
}

export function createScanExclusionMatcher(value) {
  /*
   * ================================================================================
   * 步骤2.2：创建扫描排除匹配器
   * ================================================================================
   * 目标：
   * 1) 每次扫描只编译一次规则
   * 2) 给桌面递归扫描复用轻量路径判断
   */
  logger.info("开始创建扫描排除匹配器...");

  // 2.2.1 预编译规则并返回无状态匹配函数
  const compiledRules = parseScanExclusionRules(value).map((rule) => ({
    matchPath: rule.includes("/"),
    expression: globToRegExp(rule),
  }));
  const matcher = (relativePath) => {
    const normalizedPath = normalizeScanPath(relativePath);
    if (!normalizedPath) return false;
    const baseName = normalizedPath.split("/").pop() || normalizedPath;
    return compiledRules.some((rule) => rule.expression.test(rule.matchPath ? normalizedPath : baseName));
  };

  logger.info("创建扫描排除匹配器完成", compiledRules.length);
  return matcher;
}

export function normalizeScanPath(value) {
  // 2.3 统一 Windows 和 Android 使用的相对路径格式
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

function normalizeRule(value) {
  // 1.2 保留 glob 字符，只清理路径外观
  return normalizeScanPath(String(value || "").trim());
}

function globToRegExp(rule) {
  /*
   * ================================================================================
   * 步骤3：编译 glob 规则
   * ================================================================================
   * 目标：
   * 1) 支持星号、双星号和问号
   * 2) 让目录末尾双星号同时匹配目录自身和后代
   */
  logger.info("开始编译扫描排除规则...", rule);

  // 3.1 按字符构建正则，避免把 glob 元字符当成正则
  let pattern = "^";
  for (let index = 0; index < rule.length; index += 1) {
    const character = rule[index];
    if (character === "*" && rule[index + 1] === "*") {
      const hasSlashBefore = rule[index - 1] === "/";
      const hasSlashAfter = rule[index + 2] === "/";
      const atEnd = index + 2 === rule.length;
      if (hasSlashAfter) {
        pattern += "(?:.*/)?";
        index += 2;
      } else if (hasSlashBefore && atEnd) {
        pattern = pattern.slice(0, -1) + "(?:/.*)?";
        index += 1;
      } else {
        pattern += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += escapeRegExp(character);
  }

  // 3.2 路径匹配不区分大小写
  const result = new RegExp(`${pattern}$`, "i");
  logger.info("编译扫描排除规则完成", result.source);
  return result;
}

function escapeRegExp(value) {
  // 3.3 转义单个正则字符
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}
