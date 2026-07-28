import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCatalogCodeSearchTerms,
  buildQueryVariants,
  buildSelectedSearchSources,
  extractCatalogCode,
  getOverallSearchTimeoutMs,
  isPublicIpv4Address,
  isRetryableSubHdSessionError,
  mergeSearchResultBuckets,
  parseAssrtWebSearchResults,
  parseSubHdSearchResults,
  runSubHdSessionWithRetry,
} from "../server.mjs";

const ORIGINAL_SOURCE_KEYS = [
  "thunder",
  "subtitlecat",
  "yify",
  "subf2m",
  "moviesubtitles",
  "tvsubtitles",
  "addic7ed",
  "avsubtitles",
  "aiyi",
];
const ADDED_SOURCE_KEYS = ["shooter", "thunder-fingerprint", "assrt", "subhd"];

const logger = {
  info: (...args) => console.info("[SourceRegressionTest]", ...args),
};

/*
 * ================================================================================
 * 步骤1：验证字幕源没有丢失
 * ================================================================================
 * 目标：
 * 1) 原有九个来源继续留在后端全部源目录
 * 2) 指纹、ASSRT 和 SubHD 同时出现在后端和界面选项
 */
logger.info("开始验证字幕源没有丢失...");

// 1.1 核对后端来源目录
test("保留原有字幕源并追加新来源", async () => {
  const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const catalogBody = serverSource.match(/const availableSources = \[([\s\S]*?)\n  \];/)?.[1] || "";
  const serverKeys = [...catalogBody.matchAll(/key:\s*"([^"]+)"/g)].map((match) => match[1]);
  for (const key of [...ORIGINAL_SOURCE_KEYS, ...ADDED_SOURCE_KEYS]) {
    assert.ok(serverKeys.includes(key), `后端缺少字幕源: ${key}`);
  }
});

// 1.2 核对手动全部搜索实际调度原有九个来源和匿名 ASSRT
test("手动全部搜索固定启动原有九源、ASSRT 和 SubHD", () => {
  const selected = buildSelectedSearchSources({
    source: "all",
    queryVariants: ["Daria S01E01"],
    language: "zh-CN",
  });
  const selectedKeys = selected.map((item) => item.key);
  assert.deepEqual(selectedKeys.filter((key) => ORIGINAL_SOURCE_KEYS.includes(key)), ORIGINAL_SOURCE_KEYS);
  assert.ok(selectedKeys.includes("assrt"));
  assert.ok(selectedKeys.includes("subhd"));
});

// 1.3 核对本地视频只追加指纹来源，Token 不改变来源集合
test("本地视频和 ASSRT Token 不会替换原有九源", () => {
  const selected = buildSelectedSearchSources({
    source: "all",
    queryVariants: ["Daria S01E01"],
    language: "zh-CN",
    shooterHash: "hash-1;hash-2;hash-3;hash-4",
    thunderCid: "0123456789ABCDEF",
    assrtToken: "test-token",
  });
  const selectedKeys = selected.map((item) => item.key);
  assert.equal(selectedKeys.length, ORIGINAL_SOURCE_KEYS.length + ADDED_SOURCE_KEYS.length);
  assert.deepEqual(selectedKeys.filter((key) => ORIGINAL_SOURCE_KEYS.includes(key)), ORIGINAL_SOURCE_KEYS);
  for (const key of ADDED_SOURCE_KEYS) assert.ok(selectedKeys.includes(key), `未追加字幕源: ${key}`);
});

// 1.4 核对前端可选择来源
test("界面保留原有字幕源并显示新来源", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const key of [...ORIGINAL_SOURCE_KEYS, ...ADDED_SOURCE_KEYS]) {
    assert.match(html, new RegExp(`<option\\s+value=["']${escapeRegExp(key)}["']`));
  }
  assert.doesNotMatch(html, /ASSRT（需 Token）/);
  assert.match(html, /ASSRT Token（可选）/);
});

// 1.5 Android 和网页端必须保持 Windows 专属设置隐藏
test("Windows 右键菜单开关遵守 hidden 属性", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.toggle-row\[hidden\]\s*\{[^}]*display:\s*none\s*;/s);
});

// 1.6 已运行的 Electron 实例必须从单实例数据接收资源管理器目标
test("Windows 右键目标通过单实例附加数据传递", async () => {
  const mainSource = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.match(mainSource, /requestSingleInstanceLock\(singleInstanceData\)/);
  assert.match(mainSource, /additionalData\?\.launchTarget/);
  assert.match(mainSource, /singleInstanceData\s*=\s*pendingLaunchTarget\s*\?\s*\{\s*launchTarget:\s*pendingLaunchTarget\s*\}/s);
});

// 1.7 便携版必须使用外层启动器，并覆盖每个支持的视频扩展名
test("Windows 右键菜单使用便携启动器并按扩展名注册", async () => {
  const mainSource = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.match(mainSource, /process\.env\.PORTABLE_EXECUTABLE_FILE/);
  assert.match(mainSource, /process\.env\.PORTABLE_EXECUTABLE_DIR/);
  assert.match(mainSource, /\[\.\.\.VIDEO_EXTENSIONS\]\.map/);
  assert.match(mainSource, /migrateContextMenuRegistration\(\)/);
  assert.match(mainSource, /LEGACY_CONTEXT_MENU_ROOT/);
});

// 1.8 SubHD 地址固定在后端，两端共用设置但右键项仍为 Windows 专属
test("SubHD 使用内置地址且设置按平台划分", async () => {
  const [serverSource, appSource, html] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(serverSource, /const SUBHD_BASE_URL = "https:\/\/subhd\.tv"/);
  assert.doesNotMatch(serverSource, /\/api\/settings\/sources|runtimeSourceBaseUrls/);
  assert.doesNotMatch(appSource, /subhdBaseUrl|\/api\/settings\/sources/);
  assert.match(appSource, /settingsButton\.hidden = !window\.subtitleFinder/);
  assert.match(appSource, /contextMenuSetting\.hidden = !window\.subtitleFinder\.getContextMenuState/);
  assert.match(html, /id="scanExclusionRulesInput"/);
  assert.match(html, /id="customDictionaryInput"/);
  assert.match(html, /id="settingsButton"[^>]*hidden/);
  assert.doesNotMatch(html, /SubHD 地址|恢复默认/);
});

logger.info("验证字幕源没有丢失完成");

/*
 * ================================================================================
 * 步骤2：验证 ASSRT 双通道
 * ================================================================================
 * 目标：
 * 1) 无 Token 时仍然调度 ASSRT
 * 2) 公开网页结果带有可下载地址和语言信息
 */
logger.info("开始验证 ASSRT 双通道...");

// 2.1 单独选择 ASSRT 时不要求 Token
test("ASSRT 无 Token 仍可调度公开网页通道", () => {
  const selected = buildSelectedSearchSources({
    source: "assrt",
    queryVariants: ["Daria"],
    language: "zh-CN",
  });
  assert.deepEqual(selected.map((item) => item.key), ["assrt"]);
});

// 2.2 解析公开网页中的详情、语言和下载地址
test("ASSRT 公开网页结果可用于预览和下载", () => {
  const html = `
    <div class="subitem">
      <a class="introtitle" title="拽妹黛薇儿 Daria" href="/xml/sub/710/710863.xml">Daria</a>
      <div id="meta_top"><span>版本：<b>Daria S01</b></span></div>
      <span>格式： SSA</span><span>语言：英&nbsp;简&nbsp;双语</span>
      <span>来源：原创翻译</span><span>日期： 2025-11-03 05:48:39</span>
      <span>下载次数：113次</span>
      <a onclick="location.href='/download/710863/Daria%20S01.zip';return false;">下载</a>
    </div>`;
  const results = parseAssrtWebSearchResults(html, "zh-CN", 15);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "拽妹黛薇儿 Daria");
  assert.equal(results[0].language, "英 简 双语");
  assert.equal(results[0].fileName, "Daria S01.zip");
  assert.equal(results[0].downloads, "113");
  assert.equal(results[0].downloadUrl, "https://assrt.net/download/710863/Daria%20S01.zip");
});

// 2.3 识别代理 Fake-IP，避免把它当成真实公网地址
test("ASSRT 文件域名回退会排除 Fake-IP 和内网地址", () => {
  assert.equal(isPublicIpv4Address("198.18.0.22"), false);
  assert.equal(isPublicIpv4Address("192.168.1.10"), false);
  assert.equal(isPublicIpv4Address("132.226.225.144"), true);
});

logger.info("验证 ASSRT 双通道完成");

/*
 * ================================================================================
 * 步骤2.5：验证 SubHD 接入
 * ================================================================================
 * 目标：
 * 1) 解析当前 SubHD 搜索卡片
 * 2) 使用程序内置站点地址
 */
logger.info("开始验证 SubHD 接入...");

// 2.5.1 解析当前站点的标题、语言、格式和下载量
test("SubHD 搜索结果可进入统一预览下载链路", () => {
  const html = `
    <div class="bg-white shadow-sm rounded-3 mb-4">
      <div class="float-start f16 fw-bold">
        <a class="link-dark align-middle" href='/a/58PdHQ'>拽妹黛薇儿 第一季</a>
      </div>
      <div class="view-text text-secondary">
        <a href='/a/58PdHQ'>Daria season 1 avi</a>
      </div>
      <div class="text-truncate py-2 f11">
        <span>原创翻译</span><span>双语</span><span>简体</span><span>英语</span><span>ASS</span>
      </div>
      <span class="align-text-top me-3">254k</span>
      <span class="align-text-top me-3">82</span>
      <span class="align-text-top me-3">2025-10-27</span>
    </div>`;
  const results = parseSubHdSearchResults(html, "https://subhd.tv", "zh-CN", 10);
  assert.equal(results.length, 1);
  assert.match(results[0].title, /拽妹黛薇儿 第一季/);
  assert.match(results[0].title, /Daria season 1 avi/);
  assert.equal(results[0].ext, "ass");
  assert.equal(results[0].downloads, "82");
  assert.equal(results[0].subHdId, "58PdHQ");
  assert.equal(results[0].detailUrl, "https://subhd.tv/a/58PdHQ");
});

// 2.5.2 单源 SubHD 允许完整完成多别名检索，不会被全量搜索的短时限截断
test("单源 SubHD 使用独立等待时间", () => {
  const selected = buildSelectedSearchSources({
    source: "subhd",
    queryVariants: ["Daria", "拽妹黛薇儿", "拽妹黛薇兒", "拽妹黛薇尔"],
    language: "zh-CN",
  });
  assert.equal(selected.length, 1);
  assert.ok(selected[0].timeoutMs >= 20000);
  assert.ok(getOverallSearchTimeoutMs(selected, "subhd") > selected[0].timeoutMs);
});

// 2.5.3 下载页临时拒绝时重建一次会话，业务错误不重复请求
test("SubHD 临时会话故障只重试一次", async () => {
  let attempts = 0;
  const payload = await runSubHdSessionWithRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("HTTP 403: https://subhd.tv/down/example");
    return { fileName: "Daria.ass" };
  }, { delayMs: 0 });
  assert.equal(attempts, 2);
  assert.equal(payload.fileName, "Daria.ass");
  assert.equal(isRetryableSubHdSessionError(new Error("请求超时(16000ms): subhd.tv")), true);
  assert.equal(isRetryableSubHdSessionError(new Error("SubHD 详情页没有可下载字幕")), false);
});

logger.info("验证 SubHD 接入完成");

/*
 * ================================================================================
 * 步骤3：验证专项编号检索策略
 * ================================================================================
 * 目标：
 * 1) 原始输入始终排在查询变体第一位
 * 2) 编号按横线、空格和连写形式查询
 * 3) 全部源调度和结果过滤不会丢掉专项编号结果
 */
logger.info("开始验证专项编号检索策略...");

// 3.1 保留原始输入并识别常见编号写法
test("编号检索保留原始输入并识别常见写法", () => {
  const originalQuery = "ABC-123 1080p";
  const variants = buildQueryVariants(originalQuery);
  assert.equal(variants[0], originalQuery);
  assert.equal(extractCatalogCode("ABC-123"), "ABC123");
  assert.equal(extractCatalogCode("ABC 123"), "ABC123");
  assert.equal(extractCatalogCode("ABC123"), "ABC123");
});

// 3.2 同时生成横线、空格和连写检索词
test("编号检索生成横线空格和连写词", () => {
  const terms = buildCatalogCodeSearchTerms("ABC-123");
  assert.deepEqual(terms, ["ABC-123", "ABC 123", "ABC123"]);
});

// 3.3 全部搜索继续调度两个专项编号源
test("编号查询的全部搜索继续调度专项来源", () => {
  const selected = buildSelectedSearchSources({
    source: "all",
    queryVariants: buildQueryVariants("ABC-123"),
    language: "zh-CN",
  });
  const selectedKeys = selected.map((item) => item.key);
  assert.ok(selectedKeys.includes("avsubtitles"));
  assert.ok(selectedKeys.includes("aiyi"));
});

// 3.4 附加版本词不会让纯编号结果在合并阶段被过滤
test("编号结果不会被影视标题过滤误删", () => {
  const results = mergeSearchResultBuckets(
    [[
      { source: "avsubtitles", title: "ABC-123 Chinese subtitles", fileName: "ABC-123.zh.srt" },
      { source: "aiyi", title: "ABC123 中文字幕", fileName: "ABC123.chs.srt" },
    ]],
    40,
    { queryVariants: buildQueryVariants("ABC-123 1080p") }
  );
  assert.deepEqual(results.map((item) => item.source).sort(), ["aiyi", "avsubtitles"]);
});

logger.info("验证专项编号检索策略完成");

function escapeRegExp(value) {
  // 3.5 转义来源键中的正则字符
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
