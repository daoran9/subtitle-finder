import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRuntimeStore } from "../lib/runtime-store.mjs";

const logger = {
  info: (...args) => console.info("[RuntimeStoreTest]", ...args),
};

/*
 * ================================================================================
 * 步骤1：验证搜索缓存持久化
 * ================================================================================
 * 目标：
 * 1) 普通搜索结果在存储重建后仍可命中
 * 2) 带 Token 的结果和 Token 请求的网页回退结果都只留在内存
 */
logger.info("开始验证搜索缓存持久化...");

test("搜索缓存重启后仍可读取且 Token 请求不落盘", async () => {
  // 1.1 在项目所在磁盘创建隔离测试目录
  const directory = await mkdtemp(path.join(process.cwd(), ".test-runtime-store-"));
  try {
    const store = createRuntimeStore(directory);
    await store.initialize();
    await store.setSearch("normal", { internalResults: [{ source: "thunder", title: "Daria" }] }, { ttlMs: 60000 });
    await store.setSearch("private", { internalResults: [{ source: "assrt", assrtToken: "private-token" }] }, { ttlMs: 60000 });
    await store.setSearch("private-fallback", { internalResults: [{ source: "assrt", title: "Daria web result" }] }, { ttlMs: 60000, persist: false });
    assert.equal(store.getSearch("private").value.internalResults[0].source, "assrt");
    assert.equal(store.getSearch("private-fallback").value.internalResults[0].title, "Daria web result");

    // 1.2 新建存储实例模拟应用重启
    const restored = createRuntimeStore(directory);
    await restored.initialize();
    assert.equal(restored.getSearch("normal").value.internalResults[0].title, "Daria");
    assert.equal(restored.getSearch("private"), null);
    assert.equal(restored.getSearch("private-fallback"), null);
    const persistedCache = await readFile(path.join(directory, "search-cache.json"), "utf8");
    assert.doesNotMatch(persistedCache, /private-token|Daria web result/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

logger.info("验证搜索缓存持久化完成");

/*
 * ================================================================================
 * 步骤2：验证批量任务恢复
 * ================================================================================
 * 目标：
 * 1) 保存视频快照、失败原因和重试次数
 * 2) 把运行中任务恢复为暂停批次里的等待任务
 */
logger.info("开始验证批量任务恢复...");

test("批量任务中断后恢复为等待继续", async () => {
  // 2.1 写入运行中的任务状态
  const directory = await mkdtemp(path.join(process.cwd(), ".test-runtime-store-"));
  try {
    const store = createRuntimeStore(directory);
    await store.initialize();
    await store.writeBatchState({
      videoDirectoryId: "E:\\Media",
      videoDirectoryLabel: "Media",
      videoFiles: [{ name: "Daria.S01E01.mkv", path: "E:\\Media\\Daria.S01E01.mkv", query: "Daria S01E01" }],
      batchTasks: [{
        id: "task-1",
        videoPath: "E:\\Media\\Daria.S01E01.mkv",
        status: "searching",
        message: "正在搜索",
        automaticSavedHashes: ["a".repeat(64), "invalid"],
        retryCount: 2,
      }],
      batchStatus: "running",
      namingPreset: "jellyfin",
      batchConcurrency: 3,
      batchSaveCount: 3,
      language: "zh-CN",
    });

    // 2.2 读取并核对恢复状态
    const restored = await store.readBatchState();
    assert.equal(restored.batchStatus, "paused");
    assert.equal(restored.batchTasks[0].status, "pending");
    assert.equal(restored.batchTasks[0].retryCount, 2);
    assert.deepEqual(restored.batchTasks[0].automaticSavedHashes, ["a".repeat(64)]);
    assert.match(restored.batchTasks[0].message, /中断/);
    assert.equal(restored.namingPreset, "jellyfin");
    assert.equal(restored.batchSaveCount, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

logger.info("验证批量任务恢复完成");

test("切换目录后保留待办和已完成进度，重启后可恢复", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".test-runtime-store-"));
  const buildBatch = (label, statuses) => {
    const videoFiles = [1, 2].map((number) => ({ name: `Video-${number}.mp4`, path: `${label}/Video-${number}.mp4` }));
    return {
      videoDirectoryId: label,
      videoDirectoryLabel: label,
      videoFiles,
      batchTasks: statuses.map((status, index) => ({ id: `${label}-${index}`, videoPath: videoFiles[index].path, status })),
      batchStatus: statuses.length ? "paused" : "idle",
    };
  };
  try {
    const store = createRuntimeStore(directory);
    await store.writeBatchState(buildBatch("A", ["saved", "pending"]));
    const switched = await store.writeBatchState(buildBatch("B", []));
    assert.equal(switched.previousBatch.label, "A");
    await store.writeBatchState(buildBatch("B", ["failed"]));
    const restoredStore = createRuntimeStore(directory);
    const current = await restoredStore.readBatchWorkspace();
    assert.equal(current.state.videoDirectoryLabel, "B");
    assert.equal(current.previousBatch.label, "A");
    const recovered = await restoredStore.restorePreviousBatch();
    assert.deepEqual(recovered.state.batchTasks.map((task) => task.status), ["saved", "pending"]);
    assert.equal(recovered.previousBatch.label, "B");
    assert.equal((await restoredStore.restorePreviousBatch()).state.batchTasks[0].status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/*
 * ================================================================================
 * 步骤3：验证通用设置持久化
 * ================================================================================
 * 目标：
 * 1) 跨重启恢复扫描排除规则和自定义词库
 * 2) 拒绝格式错误词条和敏感字段
 */
logger.info("开始验证通用设置持久化...");

test("通用设置跨重启恢复并限制字段", async () => {
  // 3.1 写入规则和词库
  const directory = await mkdtemp(path.join(process.cwd(), ".test-runtime-store-"));
  try {
    const store = createRuntimeStore(directory);
    await store.initialize();
    const defaults = await store.readPreferences();
    assert.equal(defaults.matchVideoName, true);
    assert.equal(defaults.autoConvertChinese, false);
    assert.equal(defaults.preferredChinese, "zh-CN");
    assert.equal(defaults.subtitleExclusionKeywords, "");
    assert.equal(defaults.subtitleSaveFilter.enabled, false);
    assert.deepEqual(defaults.subtitleSaveFilter.keywords.split("\n"), ["色花", "色花堂", "sehua", "sehuatang", "98T", "98堂", "[括号说明]"]);
    const legacyRules = ["**/Extras/**", "*.sample.*"];
    await writeFile(path.join(directory, "preferences.json"), JSON.stringify({ version: 1, preferences: { scanExclusionRules: legacyRules } }));
    const migrated = await store.readPreferences();
    assert.deepEqual(migrated.scanVideoExclusionRules, legacyRules);
    assert.deepEqual(migrated.scanFolderExclusionRules, legacyRules);
    await store.writePreferences({
      scanVideoExclusionRules: ["*.sample.*", "*-CHS.*"],
      scanFolderExclusionRules: [],
      subtitleExclusionKeywords: "机器翻译\nBad release",
      subtitleSaveFilter: { enabled: true, keywords: "  版本标记  " },
      customDictionary: "软件=軟件\n出租车=計程車",
      matchVideoName: false,
      autoConvertChinese: true,
      preferredChinese: "zh-TW",
      ignored: "不会保存",
    });

    // 3.2 重建存储并核对字段白名单
    const restored = createRuntimeStore(directory);
    await restored.initialize();
    assert.deepEqual(await restored.readPreferences(), {
      scanVideoExclusionRules: ["*.sample.*", "*-CHS.*"],
      scanFolderExclusionRules: [],
      subtitleExclusionKeywords: "机器翻译\nBad release",
      subtitleSaveFilter: { enabled: true, keywords: "版本标记" },
      customDictionary: "软件=軟件\n出租车=計程車",
      matchVideoName: false,
      autoConvertChinese: true,
      preferredChinese: "zh-TW",
    });
    await assert.rejects(() => restored.writePreferences({ customDictionary: "错误格式" }), /第 1 行/);
    await assert.rejects(() => restored.writePreferences({ subtitleSaveFilter: { enabled: true, keywords: "\n " } }), /至少填写/);
    await assert.rejects(() => restored.writePreferences({ token: "private" }), /无效/);
    await restored.writePreferences({ subtitleSaveFilter: { enabled: false, keywords: "" } });
    assert.equal((await restored.readPreferences()).subtitleSaveFilter.keywords, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

logger.info("验证通用设置持久化完成");
