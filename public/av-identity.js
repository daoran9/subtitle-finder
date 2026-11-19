const logger = {
  info: (...args) => console.info("[SubtitleFinderAvIdentity]", ...args),
};

const STANDARD_SEPARATOR = String.raw`[-_.\s]+`;
const STANDARD_SUFFIX = String.raw`(?:[-_\s]?(?:uncensored|mp4|hhb|uc|ch|ver|[a-z]))?`;
// MIDA 文件会给三位编号补零，例如 mida00458 对应 MIDA-458。
const MIDA_NUMBER_PADDING = /^(MIDA-?)0{1,2}(?=\d{3}$)/;
const GENERIC_LONG_PREFIXES = new Set([
  "CHAPTER",
  "EPISODE",
  "FEATURE",
  "MOVIE",
  "PART",
  "SEASON",
  "SERIES",
  "TRAILER",
  "VIDEO",
]);

const AV_NUMBER_PATTERNS = [
  {
    reason: "fc2-ppv",
    pattern: /(?<![a-z0-9])fc2(?:[\s._-]*ppv)?[\s._-]*(\d{5,8})(?!\d)/i,
    format: (match) => `FC2-PPV-${match[1]}`,
  },
  {
    reason: "heyzo",
    pattern: /(?<![a-z0-9])heyzo[\s._-]*(\d{4})(?!\d)/i,
    format: (match) => `HEYZO-${match[1]}`,
  },
  {
    reason: "md-series",
    pattern: /(?<![a-z0-9])(mdx|mky|md)(?:[\s_-]*(ns))?[\s_-]*(\d{3,4})(?![a-z0-9])/i,
    format: (match) => `${match[1].toUpperCase()}${match[2] ? "-NS" : ""}-${match[3]}`,
  },
  {
    reason: "date-series",
    pattern: /(?<!\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\d{2})[\s_-]+(\d{2,3})(?!\d)/,
    format: (match) => `${match[1]}${match[2]}${match[3]}_${match[4]}`,
  },
  {
    reason: "heydouga",
    pattern: /(?<![a-z0-9])heydouga[\s_-]+(\d{4})[\s_-]+(\d{3,4})(?!\d)/i,
    format: (match) => `${match[1]}-${match[2]}`,
  },
  {
    reason: "caribbean",
    pattern: /(?<![a-z0-9])(?:carib|caribbean)[a-z]*[\s_-]*(\d{3,6})[\s_-]+(\d{3})(?!\d)/i,
    format: (match) => `CARIB-${match[1]}-${match[2]}`,
  },
  {
    reason: "tokyo-hot",
    pattern: /(?<![a-z0-9])tokyo[\s_-]*hot[\s_-]*([a-z])(\d{4})(?![a-z0-9])/i,
    format: (match) => `TOKYO-HOT-${match[1].toUpperCase()}${match[2]}`,
  },
  {
    reason: "letter-digit-prefix",
    pattern: /(?<![a-z0-9])([a-z]{1,6}\d{1,2})-(\d{3})(?![a-z0-9])/i,
    format: (match) => `${match[1].toUpperCase()}-${match[2]}`,
  },
  {
    reason: "numeric-prefix",
    pattern: new RegExp(
      String.raw`(?<![a-z0-9])(\d{3}[a-z]{2,6})${STANDARD_SEPARATOR}(\d{2,5})${STANDARD_SUFFIX}(?![a-z0-9])`,
      "i"
    ),
    format: (match) => `${match[1].toUpperCase()}-${match[2]}`,
  },
  {
    reason: "one-prefix",
    pattern: new RegExp(
      String.raw`(?<![a-z0-9])1([a-z]{2,5})${STANDARD_SEPARATOR}(\d{2,5})${STANDARD_SUFFIX}(?![a-z0-9])`,
      "i"
    ),
    format: (match) => `${match[1].toUpperCase()}-${match[2]}`,
  },
  {
    reason: "long-prefix",
    pattern: new RegExp(
      String.raw`(?<![a-z0-9])([a-z]{6,12})${STANDARD_SEPARATOR}(\d{2,5})${STANDARD_SUFFIX}(?![a-z0-9])`,
      "i"
    ),
    format: (match) => `${match[1].toUpperCase()}-${match[2]}`,
    requiresLongPrefixShape: true,
  },
  {
    reason: "standard-separated",
    pattern: new RegExp(
      String.raw`(?<![a-z0-9])([a-z]{2,5})${STANDARD_SEPARATOR}(\d{2,5})${STANDARD_SUFFIX}(?![a-z0-9])`,
      "i"
    ),
    format: (match) => `${match[1].toUpperCase()}-${match[2]}`,
    requiresCodeShape: true,
  },
  {
    reason: "standard-compact",
    pattern: new RegExp(
      String.raw`(?<![a-z0-9])([a-z]{2,5})(\d{2,5})${STANDARD_SUFFIX}(?![a-z0-9])`,
      "i"
    ),
    format: (match) => `${match[1].toUpperCase()}-${normalizeCompactDigits(match[2], match[0])}`,
    requiresCodeShape: true,
  },
];

/*
 * ================================================================================
 * 步骤1：标准化番号身份
 * ================================================================================
 * 目标：
 * 1) 用一个稳定比较键判断两个番号是否相同
 * 2) 忽略大小写、横线、下划线和空格差异
 */
export function normalizeAvIdentity(value) {
  logger.info("开始标准化番号身份...");

  // 1.1 只保留比较所需的字母和数字。
  const result = String(value || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(MIDA_NUMBER_PADDING, "$1");

  logger.info("标准化番号身份完成", result);
  return result;
}

/*
 * ================================================================================
 * 步骤2：提取番号身份
 * ================================================================================
 * 目标：
 * 1) 识别恢复文件、站点前缀和特殊系列中的真实番号
 * 2) 返回标准写法、比较键和各字幕站检索变体
 */
export function extractAvIdentity(value, options = {}) {
  logger.info("开始提取番号身份...", value);

  // 2.1 先统一兼容字符，并排除已知不属于番号的账号文件。
  const sourceText = String(value || "");
  const normalizedName = normalizeSourceText(sourceText);
  if (!normalizedName || isExcludedAccountName(normalizedName)) {
    logger.info("提取番号身份完成: 不适用");
    return null;
  }

  // 2.2 清理发布站和恢复工具噪声，再按恢复规则剥离前置序号。
  const cleanedName = cleanSourceName(normalizedName);
  const recovery = stripRecoverySequencePrefix(cleanedName, normalizedName);
  const candidate = findAvNumberMatch(recovery.value, normalizedName, options);
  if (!candidate) {
    logger.info("提取番号身份完成: 未识别");
    return null;
  }

  // 2.3 统一生成标准码、紧凑比较键和检索变体。
  const canonicalCode = candidate.format(candidate.match).replace(MIDA_NUMBER_PADDING, "$1");
  const compactCode = normalizeAvIdentity(canonicalCode);
  const result = {
    canonicalCode,
    compactCode,
    variants: buildVariantsFromCanonical(canonicalCode),
    sourceText,
    recoveryPrefixRemoved: recovery.removed,
    reason: candidate.reason,
  };

  logger.info("提取番号身份完成", result.canonicalCode);
  return result;
}

/*
 * ================================================================================
 * 步骤3：比较番号身份
 * ================================================================================
 * 目标：
 * 1) 不再用字符串包含关系判断候选字幕
 * 2) 只有完整标准码相同才视为精确命中
 */
export function sameAvIdentity(left, right) {
  logger.info("开始比较番号身份...");

  // 3.1 支持传入身份对象、标准码或原始文件名。
  const leftKey = resolveAvIdentityKey(left);
  const rightKey = resolveAvIdentityKey(right);
  const matched = Boolean(leftKey && rightKey && leftKey === rightKey);

  logger.info("比较番号身份完成", matched);
  return matched;
}

/*
 * ================================================================================
 * 步骤4：生成番号检索词
 * ================================================================================
 * 目标：
 * 1) 保留标准写法
 * 2) 兼容横线、空格和紧凑写法的站内索引
 */
export function buildAvSearchTerms(identity) {
  logger.info("开始生成番号检索词...");

  // 4.1 先解析标准码，无法识别时不生成模糊词。
  const canonicalCode = resolveCanonicalCode(identity);
  if (!canonicalCode) {
    logger.info("生成番号检索词完成: empty");
    return [];
  }

  // 4.2 去重并保持站点优先使用的标准写法在首位。
  const result = buildVariantsFromCanonical(canonicalCode);

  logger.info("生成番号检索词完成", result.join(" | "));
  return result;
}

function buildVariantsFromCanonical(canonicalCode) {
  const values = [
    canonicalCode,
    canonicalCode.replace(/[-_.\s]+/g, " "),
    normalizeAvIdentity(canonicalCode),
  ];
  return values.filter((item, index, items) => item && items.indexOf(item) === index);
}

export function getAvCandidateIdentity(value) {
  return extractAvIdentity(value, { candidate: true });
}

function resolveAvIdentityKey(value) {
  if (value && typeof value === "object" && value.compactCode) return normalizeAvIdentity(value.compactCode);
  const compactValue = String(value || "").normalize("NFKC").toUpperCase();
  if (/^[A-Z0-9_]+$/.test(compactValue) && compactValue.length >= 5) {
    return normalizeAvIdentity(compactValue);
  }
  const identity = extractAvIdentity(value);
  return identity?.compactCode || "";
}

function resolveCanonicalCode(value) {
  if (value && typeof value === "object" && value.canonicalCode) return String(value.canonicalCode).trim();
  const identity = extractAvIdentity(value);
  return identity?.canonicalCode || "";
}

function normalizeSourceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

function isExcludedAccountName(value) {
  return /myfans(?:\.jp)?|マイファン[ズス]/i.test(value)
    || /\(@?[a-z][a-z0-9.]*_[\w.-]+\)/i.test(value);
}

function cleanSourceName(value) {
  return String(value || "")
    .replace(/\[\/?url(?:=[^\]]+)?\]/gi, "")
    .replace(/^\[?(?:[a-z0-9-]+\.)+[a-z]{2,}\]?(?:@|-(?=\d{4}[a-z]))/i, "")
    .replace(/\.\w+$/, "")
    .replace(/[._-](?:re)?stored\d*(?:[._-].*)?$/i, "")
    .replace(/[\^._-]+wm(?:\d+|[._-].*)?$/i, "")
    .replace(/[\u4E00-\u9FA5]/g, " ")
    .replace(/[\u3040-\u309F\u30A0-\u30FF]/g, " ")
    .replace(/BDRIP|HDR/gi, "")
    .replace(/@\w+@/g, "")
    .replace(/share_\w{32}/gi, "")
    .replace(/^[-_.]?\d{4}(?=[a-z]{2,5}\d{2,5}(?:[^a-z0-9]|$))/i, "");
}

function stripRecoverySequencePrefix(cleanName, normalizedName) {
  const hasRecoveryMarker = /(?:^|[._\s-])(?:re)?stored(?:[._\s-]|$)/i.test(normalizedName)
    || /^\s*[【[]\s*(?:无码破解|无码流出)\s*[】\]]/.test(normalizedName);
  if (!hasRecoveryMarker) return { value: cleanName, removed: false };

  const value = cleanName.replace(
    /^([^a-z0-9]*)\d{3}(?=[a-z]{3,6}[-_.\s]+\d{2,5}(?:[-_\s]?(?:uncensored|mp4|hhb|uc|ch|ver|[a-z]))?(?:[^a-z0-9]|$))/i,
    "$1"
  );
  return { value, removed: value !== cleanName };
}

function findAvNumberMatch(cleanName, normalizedName, options) {
  let bestMatch = null;
  for (const entry of AV_NUMBER_PATTERNS) {
    const match = entry.pattern.exec(cleanName);
    if (!match || match.index == null) continue;
    if (entry.requiresCodeShape && !hasReliableStandardCodeShape(match, normalizedName, options)) continue;
    if (entry.requiresLongPrefixShape && !hasReliableLongPrefixShape(match, normalizedName, options)) continue;
    if (!bestMatch || match.index < bestMatch.index) {
      bestMatch = { ...entry, match, index: match.index };
    }
  }
  return bestMatch;
}

function hasReliableStandardCodeShape(match, normalizedName, options) {
  const matchedText = String(match[0] || "");
  const prefix = String(match[1] || "");
  const separator = matchedText.slice(prefix.length, matchedText.length - String(match[2] || "").length);
  const numericPart = Number(match[2] || 0);
  const hasRecoveryMarker = /(?:^|[._\s-])(?:re)?stored(?:[._\s-]|$)/i.test(normalizedName);
  if (String(match[2] || "").length === 4 && numericPart >= 1900 && numericPart <= 2099 && !hasRecoveryMarker) {
    return false;
  }
  if (/[-_]/.test(separator)) return true;
  if (hasRecoveryMarker) return true;
  if (/^[A-Z0-9]+$/.test(prefix)) return true;
  if (/^0\d+/.test(String(match[2] || ""))) return true;
  if (/^\[?(?:[a-z0-9-]+\.)+[a-z]{2,}\]?(?:@|-(?=\d{4}[a-z]))/i.test(normalizedName)) return true;
  return Boolean(options?.allowLooseCode && /^[a-z0-9]+$/i.test(prefix));
}

function hasReliableLongPrefixShape(match, normalizedName, options) {
  /*
   * ================================================================================
   * 步骤5：收紧长前缀番号识别
   * ================================================================================
   * 目标：
   * 1) 保留 MURIKURI-009 一类真实长前缀番号
   * 2) 阻止 Episode.01 一类普通媒体文件进入 AV 模式
   */
  logger.info("开始校验长前缀番号格式...");

  // 5.1 排除媒体文件中常见的非番号长词。
  const rawPrefix = String(match[1] || "");
  const prefix = rawPrefix.toUpperCase();
  if (GENERIC_LONG_PREFIXES.has(prefix)) {
    logger.info("校验长前缀番号格式完成: generic");
    return false;
  }

  // 5.2 横线和下划线是强分隔符，大小写不影响真实番号；点号仅在恢复文件或手动搜索时放宽。
  const hasRecoveryMarker = /(?:^|[._\s-])(?:re)?stored(?:[._\s-]|$)/i.test(normalizedName);
  const matchedText = String(match[0] || "");
  const separator = matchedText.slice(rawPrefix.length, matchedText.length - String(match[2] || "").length);
  const numericPart = Number(match[2] || 0);
  if (String(match[2] || "").length === 4 && numericPart >= 1900 && numericPart <= 2099 && !/[-_]/.test(separator)) {
    logger.info("校验长前缀番号格式完成: year");
    return false;
  }
  const matched = /[-_]/.test(separator) || hasRecoveryMarker || Boolean(options?.allowLooseCode);

  logger.info("校验长前缀番号格式完成", matched);
  return matched;
}

function normalizeCompactDigits(value, matchedText = "") {
  let result = String(value || "");
  const compactRecovery = /(?:hhb|mp4|uc|ch|ver|restored|stored)/i.test(String(matchedText || ""));
  while (compactRecovery && result.length > 3 && result.startsWith("0")) result = result.slice(1);
  return result;
}
