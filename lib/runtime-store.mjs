import { promises as fs } from "fs";
import path from "path";
import { parseCustomConversionDictionary } from "../public/conversion-dictionary.js";
import { parseScanExclusionRules } from "../public/scan-rules.js";

const logger = {
  info: (...args) => console.info("[SubtitleFinderStore]", ...args),
  warn: (...args) => console.warn("[SubtitleFinderStore]", ...args),
};

const SEARCH_CACHE_VERSION = 1;
const BATCH_STATE_VERSION = 1;
const PREFERENCES_VERSION = 1;
const MAX_SEARCH_CACHE_ENTRIES = 100;
const MAX_BATCH_TASKS = 500;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

/*
 * ================================================================================
 * 步骤1：创建运行数据存储
 * ================================================================================
 * 目标：
 * 1) 在应用数据目录保存搜索缓存和批量任务
 * 2) 用串行原子写入避免并发覆盖和半截 JSON
 */
export function createRuntimeStore(dataDirectory) {
  logger.info("开始创建运行数据存储...", dataDirectory);

  // 1.1 计算文件路径并创建内存索引
  const directory = path.resolve(String(dataDirectory || ".subtitle-finder-data"));
  const searchCachePath = path.join(directory, "search-cache.json");
  const batchStatePath = path.join(directory, "batch-state.json");
  const preferencesPath = path.join(directory, "preferences.json");
  const searchEntries = new Map();
  let writeQueue = Promise.resolve();

  const store = {
    directory,
    async initialize() {
      /*
       * ============================================================================
       * 步骤2：初始化持久化文件
       * ============================================================================
       * 目标：
       * 1) 创建应用数据目录
       * 2) 恢复仍在有效期内且不含凭据的搜索缓存
       */
      logger.info("开始初始化运行数据存储...");

      // 2.1 创建目录并读取搜索缓存
      await fs.mkdir(directory, { recursive: true });
      const document = await readJsonFile(searchCachePath, { version: SEARCH_CACHE_VERSION, entries: [] });
      const now = Date.now();
      for (const entry of Array.isArray(document?.entries) ? document.entries : []) {
        if (!isValidSearchEntry(entry, now)) continue;
        searchEntries.set(entry.key, entry);
      }
      pruneSearchEntries(searchEntries, now);

      logger.info("初始化运行数据存储完成", searchEntries.size);
    },
    getSearch(key) {
      /*
       * ============================================================================
       * 步骤3：读取搜索缓存
       * ============================================================================
       * 目标：
       * 1) 只返回有效期内的完整搜索结果
       * 2) 命中后刷新内存访问时间，不延长实际过期时间
       */
      logger.info("开始读取搜索缓存...");

      // 3.1 校验缓存键和有效期
      const entry = searchEntries.get(String(key || ""));
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) searchEntries.delete(entry.key);
        logger.info("读取搜索缓存完成: miss");
        return null;
      }
      entry.lastAccessedAt = Date.now();
      logger.info("读取搜索缓存完成: hit");
      return structuredCloneCompat(entry);
    },
    async setSearch(key, value, options = {}) {
      /*
       * ============================================================================
       * 步骤4：写入搜索缓存
       * ============================================================================
       * 目标：
       * 1) 保存可重新注册预览和下载 ID 的内部结果
       * 2) 含 Token 等敏感字段的结果只留在内存，不写磁盘
       */
      logger.info("开始写入搜索缓存...");

      // 4.1 生成有界缓存记录
      const now = Date.now();
      const ttlMs = Math.max(1000, Math.min(Number(options.ttlMs || 0), 24 * 60 * 60 * 1000));
      const entry = {
        key: String(key || "").slice(0, 160),
        createdAt: now,
        lastAccessedAt: now,
        expiresAt: now + ttlMs,
        value: structuredCloneCompat(value),
        persistent: options.persist !== false && !containsSensitiveValue(value),
      };
      if (!entry.key || !ttlMs) {
        logger.info("写入搜索缓存完成: skipped");
        return;
      }
      searchEntries.set(entry.key, entry);
      pruneSearchEntries(searchEntries, now);

      // 4.2 串行写入不含凭据的缓存
      writeQueue = writeQueue.catch(() => {}).then(() => persistSearchEntries(searchCachePath, searchEntries));
      await writeQueue;
      logger.info("写入搜索缓存完成", searchEntries.size);
    },
    async readBatchState() {
      /*
       * ============================================================================
       * 步骤5：读取批量任务状态
       * ============================================================================
       * 目标：
       * 1) 恢复视频扫描快照和任务进度
       * 2) 将中断中的任务恢复成等待状态
       */
      logger.info("开始读取批量任务状态...");

      // 5.1 读取并整理状态文档
      const document = await readJsonFile(batchStatePath, null);
      const state = normalizeBatchState(document?.state);
      logger.info("读取批量任务状态完成", state ? state.batchTasks.length : 0);
      return state;
    },
    async writeBatchState(value) {
      /*
       * ============================================================================
       * 步骤6：写入批量任务状态
       * ============================================================================
       * 目标：
       * 1) 限制任务和视频数量，拒绝凭据字段
       * 2) 保存版本号和更新时间供后续兼容迁移
       */
      logger.info("开始写入批量任务状态...");

      // 6.1 规范并限制前端状态
      const state = normalizeBatchState(value);
      if (!state) throw new Error("批量任务状态无效");
      const document = { version: BATCH_STATE_VERSION, updatedAt: Date.now(), state };
      const serialized = JSON.stringify(document);
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("批量任务状态过大");

      // 6.2 排队写入，避免高频进度更新相互覆盖
      writeQueue = writeQueue.catch(() => {}).then(() => writeJsonAtomic(batchStatePath, document));
      await writeQueue;
      logger.info("写入批量任务状态完成", state.batchTasks.length);
      return { updatedAt: document.updatedAt };
    },
    async readPreferences() {
      /*
       * ============================================================================
       * 步骤6.5：读取通用设置
       * ============================================================================
       * 目标：
       * 1) 恢复扫描排除规则和自定义简繁词库
       * 2) 损坏或旧格式文件回退为空设置
       */
      logger.info("开始读取通用设置...");

      // 6.5.1 读取并规范设置文档
      const document = await readJsonFile(preferencesPath, null);
      let preferences;
      try {
        preferences = normalizePreferences(document?.preferences);
      } catch (error) {
        logger.warn("读取通用设置失败", error.message);
        preferences = normalizePreferences({});
      }

      logger.info("读取通用设置完成", preferences.scanExclusionRules.length);
      return preferences;
    },
    async writePreferences(value) {
      /*
       * ============================================================================
       * 步骤6.6：写入通用设置
       * ============================================================================
       * 目标：
       * 1) 校验扫描规则和双向简繁词条
       * 2) 原子写入独立设置文件
       */
      logger.info("开始写入通用设置...");

      // 6.6.1 规范设置并排队写入
      const preferences = normalizePreferences(value);
      const document = { version: PREFERENCES_VERSION, updatedAt: Date.now(), preferences };
      writeQueue = writeQueue.catch(() => {}).then(() => writeJsonAtomic(preferencesPath, document));
      await writeQueue;

      logger.info("写入通用设置完成", preferences.scanExclusionRules.length);
      return { updatedAt: document.updatedAt, preferences };
    },
  };

  logger.info("创建运行数据存储完成", directory);
  return store;
}

function normalizePreferences(value) {
  /*
   * ================================================================================
   * 步骤6.7：规范通用设置
   * ================================================================================
   * 目标：
   * 1) 只保留扫描排除和简繁词库字段
   * 2) 限制文本体积并拒绝敏感字段
   */
  logger.info("开始规范通用设置...");

  // 6.7.1 校验顶层对象和字段白名单
  if (value != null && (typeof value !== "object" || Array.isArray(value) || containsSensitiveValue(value))) {
    throw new Error("通用设置无效");
  }
  const source = value || {};
  const scanExclusionRules = parseScanExclusionRules(source.scanExclusionRules || []);
  const customDictionary = safeText(source.customDictionary, 24000);
  parseCustomConversionDictionary(customDictionary);
  const preferences = { scanExclusionRules, customDictionary };

  logger.info("规范通用设置完成", scanExclusionRules.length);
  return preferences;
}

function normalizeBatchState(value) {
  /*
   * ================================================================================
   * 步骤7：规范批量任务状态
   * ================================================================================
   * 目标：
   * 1) 只保留恢复工作流需要的白名单字段
   * 2) 搜索中和保存中的任务重启后回到等待状态
   */
  logger.info("开始规范批量任务状态...");

  // 7.1 校验顶层结构
  if (!value || typeof value !== "object" || containsSensitiveValue(value)) {
    logger.info("规范批量任务状态完成: invalid");
    return null;
  }

  // 7.2 限制扫描快照和任务数组
  const videoFiles = toSafeArray(value.videoFiles, MAX_BATCH_TASKS).map(sanitizeVideoFile).filter(Boolean);
  const validPaths = new Set(videoFiles.map((item) => item.path));
  const batchTasks = toSafeArray(value.batchTasks, MAX_BATCH_TASKS)
    .map(sanitizeBatchTask)
    .filter((item) => item && validPaths.has(item.videoPath));
  const interrupted = value.batchStatus === "running" || batchTasks.some((task) => task.status === "searching");
  const state = {
    videoDirectoryId: safeText(value.videoDirectoryId, 1200),
    videoDirectoryLabel: safeText(value.videoDirectoryLabel, 500),
    videoFiles,
    batchTasks,
    batchStatus: interrupted ? "paused" : normalizeBatchStatus(value.batchStatus),
    namingPreset: normalizeNamingPreset(value.namingPreset),
    batchConcurrency: clampInteger(value.batchConcurrency, 1, 3, 2),
    language: normalizeLanguage(value.language),
  };
  logger.info("规范批量任务状态完成", batchTasks.length);
  return state;
}

function sanitizeVideoFile(value) {
  // 7.3 复制视频扫描快照并限制递归深度和文本长度
  if (!value || typeof value !== "object") return null;
  const pathValue = safeText(value.path, 1600);
  if (!pathValue) return null;
  return sanitizeJsonValue({ ...value, path: pathValue }, 0);
}

function sanitizeBatchTask(value) {
  // 7.4 任务结果 ID 跨重启无效，因此不持久化下载结果对象
  if (!value || typeof value !== "object") return null;
  const status = value.status === "searching" ? "pending" : normalizeTaskStatus(value.status);
  return {
    id: safeText(value.id, 120),
    videoPath: safeText(value.videoPath, 1600),
    status,
    message: status === "pending" && value.status === "searching" ? "上次运行已中断，等待继续" : safeText(value.message, 500),
    savedPath: safeText(value.savedPath, 1600),
    retryCount: clampInteger(value.retryCount, 0, 99, 0),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now(),
  };
}

async function persistSearchEntries(filePath, entries) {
  // 4.3 只把允许持久化的有效缓存写入磁盘
  const now = Date.now();
  pruneSearchEntries(entries, now);
  const persistentEntries = [...entries.values()].filter((entry) => entry.persistent && entry.expiresAt > now);
  await writeJsonAtomic(filePath, { version: SEARCH_CACHE_VERSION, entries: persistentEntries });
}

function pruneSearchEntries(entries, now) {
  // 4.4 删除过期项，并按最近访问时间限制总量
  for (const [key, entry] of entries) {
    if (!isValidInMemorySearchEntry(entry, now)) entries.delete(key);
  }
  const overflow = entries.size - MAX_SEARCH_CACHE_ENTRIES;
  if (overflow <= 0) return;
  const oldest = [...entries.values()].sort((left, right) => left.lastAccessedAt - right.lastAccessedAt).slice(0, overflow);
  for (const entry of oldest) entries.delete(entry.key);
}

function isValidSearchEntry(entry, now) {
  // 4.5 校验持久化缓存结构和有效期
  return Boolean(
    entry &&
    typeof entry === "object" &&
    typeof entry.key === "string" &&
    entry.key.length <= 160 &&
    Number(entry.expiresAt) > now &&
    entry.value &&
    typeof entry.value === "object" &&
    !containsSensitiveValue(entry.value)
  );
}

function isValidInMemorySearchEntry(entry, now) {
  // 4.5.1 内存允许保存带凭据的结果，但仍校验结构和有效期
  return Boolean(
    entry &&
    typeof entry === "object" &&
    typeof entry.key === "string" &&
    entry.key.length <= 160 &&
    Number(entry.expiresAt) > now &&
    entry.value &&
    typeof entry.value === "object"
  );
}

async function readJsonFile(filePath, fallback) {
  // 2.2 文件不存在或损坏时返回空状态，不阻止应用启动
  try {
    const fileStat = await fs.stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_STATE_BYTES * 2) return fallback;
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") logger.warn("读取持久化文件失败", path.basename(filePath), error.message);
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  // 1.2 先写临时文件，再替换正式文件
  const temporaryPath = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(temporaryPath, JSON.stringify(value), "utf8");
  await fs.rename(temporaryPath, filePath).catch(async (error) => {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await fs.unlink(filePath).catch(() => {});
    await fs.rename(temporaryPath, filePath);
  });
}

function sanitizeJsonValue(value, depth) {
  // 7.5 深度和数组长度受限，避免把任意大对象写入状态文件
  if (depth > 5 || value == null) return value == null ? null : safeText(value, 500);
  if (typeof value === "string") return safeText(value, 2000);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeJsonValue(item, depth + 1));
  if (typeof value !== "object") return safeText(value, 500);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (/token|password|secret|authorization/i.test(key)) continue;
    output[key] = sanitizeJsonValue(item, depth + 1);
  }
  return output;
}

function containsSensitiveValue(value, depth = 0) {
  // 4.6 凭据字段无论大小写都禁止落盘
  if (!value || typeof value !== "object" || depth > 6) return false;
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|authorization/i.test(key) && String(item || "")) return true;
    if (item && typeof item === "object" && containsSensitiveValue(item, depth + 1)) return true;
  }
  return false;
}

function normalizeTaskStatus(value) {
  // 7.6 任务状态只接受现有状态机值
  return ["pending", "saved", "no-result", "failed", "skipped"].includes(value) ? value : "pending";
}

function normalizeBatchStatus(value) {
  // 7.7 批次状态只接受可恢复状态
  return ["idle", "paused", "completed"].includes(value) ? value : "idle";
}

function normalizeNamingPreset(value) {
  // 7.8 命名方式只接受界面已有选项
  return ["media-server", "emby", "jellyfin", "plex", "same-name"].includes(value) ? value : "media-server";
}

function normalizeLanguage(value) {
  // 7.9 语言只接受搜索界面支持值
  return ["zh-CN", "zh-TW", "en", "ja"].includes(value) ? value : "zh-CN";
}

function toSafeArray(value, limit) {
  // 7.10 统一限制外部数组长度
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function safeText(value, limit) {
  // 7.11 清理控制字符并限制持久化文本长度
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, limit);
}

function clampInteger(value, min, max, fallback) {
  // 7.12 限制整数设置范围
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function structuredCloneCompat(value) {
  // 3.2 Node 12 和现代 Node 共用的 JSON 数据克隆方式
  return JSON.parse(JSON.stringify(value));
}
