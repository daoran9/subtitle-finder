import { analyzeMediaFile, compareMediaEntries, findExistingSubtitles } from "./media-library.js";
import { analyzeSubtitleLanguage, buildSubtitleBaseName } from "./subtitle-rules.js";
import { parseCustomConversionDictionary } from "./conversion-dictionary.js";
import { parseScanExclusionRules } from "./scan-rules.js";

const state = {
  results: [],
  selectedId: "",
  selectedDownloadIds: new Set(),
  previewText: "",
  aboutFocusReturn: null,
  settingsFocusReturn: null,
  downloadUrl: "",
  downloadFileName: "",
  downloadDir: "",
  downloadDirLabel: "",
  videoFiles: [],
  activeVideoPath: "",
  videoDirectoryLabel: "",
  videoDirectoryId: "",
  hideMatchedVideos: true,
  namingPreset: "media-server",
  batchConcurrency: 2,
  assrtToken: "",
  batchTasks: [],
  batchStatus: "idle",
  batchRunId: 0,
  batchControllers: new Map(),
  searchController: null,
  searchRunId: 0,
  previewController: null,
  conversionTarget: "",
  scanExclusionRules: [],
  customDictionary: "",
  singleVideoMode: false,
  batchStateLoaded: false,
  batchStateSaveTimer: null,
  batchStateSavePromise: null,
  batchStateTouched: false,
  syncJobId: "",
  syncStatus: "idle",
  syncProgress: 0,
  syncMessage: "",
};
const PREVIEW_TIMEOUT_MS = 20000;
const SEARCH_TIMEOUT_MS = 48000;
const BATCH_SEARCH_TIMEOUT_MS = 52000;

const logger = {
  info: (...args) => console.info("[SubtitleFinderUI]", ...args),
  warn: (...args) => console.warn("[SubtitleFinderUI]", ...args),
  error: (...args) => console.error("[SubtitleFinderUI]", ...args),
};

const nodes = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#queryInput"),
  clearQueryButton: document.querySelector("#clearQueryButton"),
  source: document.querySelector("#sourceSelect"),
  language: document.querySelector("#languageSelect"),
  settingsButton: document.querySelector("#settingsButton"),
  aboutButton: document.querySelector("#aboutButton"),
  resultSummary: document.querySelector("#resultSummary"),
  statusBadge: document.querySelector("#statusBadge"),
  sourceStats: document.querySelector("#sourceStats"),
  resultsBody: document.querySelector("#resultsBody"),
  selectAllResults: document.querySelector("#selectAllResults"),
  previewMeta: document.querySelector("#previewMeta"),
  previewText: document.querySelector("#previewText"),
  closePreviewButton: document.querySelector("#closePreviewButton"),
  copyButton: document.querySelector("#copyButton"),
  chooseDirButton: document.querySelector("#chooseDirButton"),
  syncButton: document.querySelector("#syncButton"),
  cancelSyncButton: document.querySelector("#cancelSyncButton"),
  syncProgress: document.querySelector("#syncProgress"),
  syncStatus: document.querySelector("#syncStatus"),
  downloadButton: document.querySelector("#downloadButton"),
  conversionSelect: document.querySelector("#conversionSelect"),
  batchDownloadButton: document.querySelector("#batchDownloadButton"),
  aboutModal: document.querySelector("#aboutModal"),
  thirdPartyLicensesButton: document.querySelector("#thirdPartyLicensesButton"),
  closeAboutButton: document.querySelector("#closeAboutButton"),
  closeAboutFooterButton: document.querySelector("#closeAboutFooterButton"),
  settingsModal: document.querySelector("#settingsModal"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  contextMenuSetting: document.querySelector("#contextMenuSetting"),
  contextMenuToggle: document.querySelector("#contextMenuToggle"),
  settingsMessage: document.querySelector("#settingsMessage"),
  settingsPlatformLabel: document.querySelector("#settingsPlatformLabel"),
  scanExclusionRules: document.querySelector("#scanExclusionRulesInput"),
  customDictionary: document.querySelector("#customDictionaryInput"),
  selectVideoButton: document.querySelector("#selectVideoButton"),
  scanVideoButton: document.querySelector("#scanVideoButton"),
  batchPanel: document.querySelector("#batchPanel"),
  startBatchButton: document.querySelector("#startBatchButton"),
  pauseBatchButton: document.querySelector("#pauseBatchButton"),
  retryBatchButton: document.querySelector("#retryBatchButton"),
  batchProgress: document.querySelector("#batchProgress"),
  namingPreset: document.querySelector("#namingPresetSelect"),
  batchConcurrency: document.querySelector("#batchConcurrencySelect"),
  assrtToken: document.querySelector("#assrtTokenInput"),
  videoScanMeta: document.querySelector("#videoScanMeta"),
  videoScanSummary: document.querySelector("#videoScanSummary"),
  missingOnlyToggle: document.querySelector("#missingOnlyToggle"),
  videoList: document.querySelector("#videoList"),
  recentList: document.querySelector("#recentList"),
  clearRecentButton: document.querySelector("#clearRecentButton"),
};

/*
 * ================================================================================
 * 步骤1：初始化前端页面
 * ================================================================================
 * 目标：
 * 1) 绑定搜索、预览、复制、最近搜索事件
 * 2) 恢复最近搜索列表
 */
logger.info("开始初始化页面...");

// 1.1 绑定搜索表单
nodes.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void searchSubtitles();
});

// 1.2 绑定复制按钮
nodes.copyButton.addEventListener("click", async () => {
  await copyPreviewText();
});

// 1.3 绑定搜索框清空
nodes.clearQueryButton.addEventListener("click", () => {
  clearSearchQuery();
});

nodes.query.addEventListener("input", () => {
  const activeVideo = getActiveVideo();
  if (activeVideo && nodes.query.value.trim() !== activeVideo.query) {
    clearActiveVideoSelection();
  }
  renderClearQueryButton();
});

// 1.4 绑定设置弹窗
nodes.settingsButton.hidden = !window.subtitleFinder;
nodes.settingsButton.addEventListener("click", () => {
  void openSettingsDialog();
});

nodes.closeSettingsButton.addEventListener("click", () => {
  closeSettingsDialog();
});

nodes.closeSettingsButton.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
});

nodes.settingsModal.addEventListener("pointerup", (event) => {
  const closeButton = event.target instanceof Element ? event.target.closest("[data-settings-close]") : null;
  if (closeButton) closeSettingsDialog();
});

nodes.settingsModal.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-settings-close]")) {
    closeSettingsDialog();
    return;
  }
  if (event.target === nodes.settingsModal) closeSettingsDialog();
});

nodes.saveSettingsButton.addEventListener("click", () => {
  void saveSettings();
});

// 1.5 绑定关于弹窗
nodes.aboutButton.addEventListener("click", () => {
  openAboutDialog();
});

nodes.closeAboutButton.addEventListener("click", () => {
  closeAboutDialog();
});

nodes.closeAboutButton.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
});

nodes.closeAboutFooterButton.addEventListener("click", () => {
  closeAboutDialog();
});

nodes.thirdPartyLicensesButton.addEventListener("click", () => {
  void openThirdPartyLicenses();
});

nodes.aboutModal.addEventListener("pointerup", (event) => {
  const closeButton = event.target instanceof Element ? event.target.closest("[data-about-close]") : null;
  if (closeButton) {
    closeAboutDialog();
  }
});

nodes.aboutModal.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-about-close]")) {
    closeAboutDialog();
    return;
  }
  if (event.target === nodes.aboutModal) {
    closeAboutDialog();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !nodes.settingsModal.hidden) {
    closeSettingsDialog();
    return;
  }
  if (event.key === "Escape" && !nodes.aboutModal.hidden) {
    closeAboutDialog();
  }
});

nodes.closePreviewButton.addEventListener("click", () => {
  closeMobilePreview();
});

// 1.6 绑定字幕下载按钮
nodes.downloadButton.addEventListener("click", async () => {
  await downloadSubtitle();
});

nodes.conversionSelect.addEventListener("change", () => {
  state.conversionTarget = nodes.conversionSelect.value || "";
  if (state.selectedId) void previewSubtitle(state.selectedId, { preserveSelection: true });
});

// 1.6 绑定批量下载按钮
nodes.batchDownloadButton.addEventListener("click", async () => {
  await downloadSelectedSubtitles();
});

// 1.7 绑定结果全选
nodes.selectAllResults.addEventListener("change", () => {
  toggleSelectAllResults();
});

// 1.8 绑定保存位置选择
nodes.chooseDirButton.addEventListener("click", async () => {
  await chooseDownloadDir();
});

// 1.8.1 绑定 Windows 自动校时和取消
nodes.syncButton.addEventListener("click", () => {
  void syncCurrentSubtitle();
});

nodes.cancelSyncButton.addEventListener("click", () => {
  void cancelCurrentSubtitleSync();
});

// 1.9 绑定视频文件夹扫描
nodes.scanVideoButton.addEventListener("click", async () => {
  await scanVideoFolder();
});

nodes.selectVideoButton.addEventListener("click", async () => {
  await selectSingleVideo();
});

// 1.10 绑定文件夹批量匹配
nodes.startBatchButton.addEventListener("click", () => {
  void startOrResumeBatchMatch();
});

nodes.pauseBatchButton.addEventListener("click", () => {
  pauseBatchMatch();
});

nodes.retryBatchButton.addEventListener("click", () => {
  void retryBatchMatch();
});

nodes.namingPreset.addEventListener("change", () => {
  state.namingPreset = nodes.namingPreset.value || "media-server";
  localStorage.setItem("subtitle-finder-naming-preset", state.namingPreset);
  scheduleBatchStateSave();
});

nodes.batchConcurrency.addEventListener("change", () => {
  state.batchConcurrency = clampNumber(Number(nodes.batchConcurrency.value), 1, 3, 2);
  localStorage.setItem("subtitle-finder-batch-concurrency", String(state.batchConcurrency));
  scheduleBatchStateSave();
});

nodes.assrtToken.addEventListener("input", () => {
  state.assrtToken = nodes.assrtToken.value.trim();
});

nodes.language.addEventListener("change", () => {
  pauseBatchMatch();
  state.videoFiles = normalizeScannedVideoFiles(state.videoFiles);
  syncConversionControl();
  renderVideoFiles();
  scheduleBatchStateSave();
});

// 1.11 切换缺字幕筛选
nodes.missingOnlyToggle.addEventListener("change", () => {
  state.hideMatchedVideos = nodes.missingOnlyToggle.checked;
  localStorage.setItem("subtitle-finder-missing-only", state.hideMatchedVideos ? "true" : "false");
  renderVideoFiles();
});

// 1.12 绑定最近搜索清理
nodes.clearRecentButton.addEventListener("click", () => {
  localStorage.removeItem("subtitle-finder-recent");
  renderRecent();
});

// 1.14 恢复保存位置和批量设置
restoreDownloadDir();
restoreVideoFilter();
restoreBatchSettings();
syncConversionControl();
const settingsReadyPromise = restoreAppSettings();

// 1.14 渲染初始状态
renderClearQueryButton();
renderRecent();
renderBatchDownloadState();
renderBatchMatchState();
renderSubtitleSyncState();
logger.info("页面初始化完成");
void consumeDesktopLaunchTarget();
if (window.subtitleFinder && window.subtitleFinder.onLaunchTargetAvailable) {
  window.subtitleFinder.onLaunchTargetAvailable(() => {
    void consumeDesktopLaunchTarget();
  });
}
if (window.subtitleFinder && window.subtitleFinder.onVideoDropped) {
  window.subtitleFinder.onVideoDropped((result) => {
    void loadVideoSelectionResult(result, { singleVideo: true, startSearch: true });
  });
}
if (window.subtitleFinder && window.subtitleFinder.onSubtitleSyncEvent) {
  window.subtitleFinder.onSubtitleSyncEvent((event) => {
    handleSubtitleSyncEvent(event || {});
  });
}
void restorePersistentBatchState();

window.addEventListener("pagehide", () => {
  void savePersistentBatchState({ immediate: true });
});

async function searchSubtitles() {
  /*
   * ================================================================================
   * 步骤2：执行字幕搜索
   * ================================================================================
   * 目标：
   * 1) 读取输入字段
   * 2) 调用本地搜索接口
   * 3) 渲染结果表格
   */
  logger.info("开始搜索字幕...");

  // 2.1 建立本次搜索归属，并立即取消上一次网络等待
  const searchRunId = state.searchRunId + 1;
  state.searchRunId = searchRunId;
  if (state.searchController) {
    state.searchController.abort();
    logger.info("已取消上一轮搜索等待");
  }

  // 2.2 读取搜索条件
  const query = nodes.query.value.trim();
  const source = nodes.source.value;
  const language = nodes.language.value;
  if (!query) {
    setStatus("请输入字段", "warn");
    nodes.query.focus();
    logger.info("搜索字幕完成: 空字段");
    return;
  }

  // 2.3 选择本地视频时补齐指纹和内封字幕信息
  setStatus("搜索中", "busy");
  nodes.resultSummary.textContent = `搜索 ${query}`;
  state.results = [];
  state.selectedDownloadIds.clear();
  syncSelectAllResults();
  renderBatchDownloadState();
  renderSourceStats([{ sourceLabel: "全部源", status: "busy", statusLabel: "搜索中", count: "-", duration: "-" }]);
  nodes.resultsBody.innerHTML = `<tr class="empty-row"><td colspan="6">正在搜索...</td></tr>`;
  clearPreview();

  try {
    const activeVideo = getActiveVideo();
    if ((source === "shooter" || source === "thunder-fingerprint") && !activeVideo) {
      throw new Error("该字幕源需要先从视频文件夹选择一个本地视频");
    }
    const videoInfo = activeVideo ? await inspectVideoForSearch(activeVideo) : {};
    if (state.searchRunId !== searchRunId) {
      logger.info(`搜索字幕完成: ${query} 已被新搜索替换`);
      return;
    }
    if (source === "shooter" && !videoInfo.shooterHash) {
      throw new Error(videoInfo.error || "无法读取射手网所需的视频指纹");
    }
    if (source === "thunder-fingerprint" && !videoInfo.thunderCid) {
      throw new Error(videoInfo.error || "无法读取迅雷所需的视频指纹");
    }
    if (activeVideo && Number(videoInfo.embeddedSubtitleCount || 0) > 0) {
      updateVideoInspectionState(activeVideo, videoInfo);
    }

    // 2.4 请求搜索接口
    const request = buildSearchRequest({
      query,
      source,
      language,
      limit: 80,
      video: activeVideo,
      videoInfo,
    });
    const data = await fetchSearchData(request, SEARCH_TIMEOUT_MS);
    if (state.searchRunId !== searchRunId) {
      logger.info(`搜索字幕完成: ${query} 的返回结果已过期`);
      return;
    }

    // 2.5 只由最新搜索渲染结果
    state.results = data.results || [];
    addRecent(query);
    renderResults(state.results);
    renderSourceStats(data.sourceStats || []);
    const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
    setStatus(errorCount ? "部分完成" : "完成", errorCount ? "warn" : "ok");
    const cacheLabel = data.cached ? " · 缓存" : "";
    nodes.resultSummary.textContent = errorCount ? `${data.count} 条结果 · ${errorCount} 个源失败${cacheLabel}` : `${data.count} 条结果${cacheLabel}`;
    logger.info(`搜索字幕完成: ${data.count} 条`);
  } catch (error) {
    // 2.6 被新搜索替换的旧任务不再改写当前结果栏
    if (state.searchRunId !== searchRunId) {
      logger.info(`搜索字幕完成: ${query} 的异常已忽略`);
      return;
    }

    state.results = [];
    state.selectedDownloadIds.clear();
    renderResults([]);
    renderSourceStats([]);
    setStatus("失败", "error");
    nodes.resultSummary.textContent = String(error.message || error);
    logger.error("搜索字幕失败", error);
  }
}

function buildSearchRequest({ query, source, language, limit, video = null, videoInfo = {} }) {
  /*
   * ================================================================================
   * 步骤2.5：生成字幕搜索请求
   * ================================================================================
   * 目标：
   * 1) 手动搜索只携带原有片名、来源和语言参数
   * 2) 本地视频搜索额外携带视频指纹和发布版本
   */
  logger.info("开始生成字幕搜索请求...");

  // 2.5.1 保留原有搜索参数
  const params = new URLSearchParams({
    q: String(query || "").trim(),
    source: String(source || "all"),
    lang: String(language || "zh-CN"),
    limit: String(limit || 80),
  });

  // 2.5.2 只给本地视频附加精准匹配参数
  if (video) {
    if (videoInfo.shooterHash) params.set("shooterHash", videoInfo.shooterHash);
    if (videoInfo.thunderCid) params.set("thunderCid", videoInfo.thunderCid);
    params.set("videoFileName", video.name || "video.mkv");
    params.set("releaseName", video.name || query || "video.mkv");
    for (const alias of Array.isArray(video.searchAliases) ? video.searchAliases.slice(0, 8) : []) {
      params.append("alias", alias);
    }
  }
  const request = {
    url: apiUrl(`/api/search?${params.toString()}`),
    headers: state.assrtToken ? { "x-assrt-token": state.assrtToken } : {},
  };

  logger.info("生成字幕搜索请求完成");
  return request;
}

async function fetchSearchData(request, timeoutMs, controller = null) {
  /*
   * ================================================================================
   * 步骤2.6：读取字幕搜索结果
   * ================================================================================
   * 目标：
   * 1) 统一手动搜索和批量匹配的接口错误处理
   * 2) ASSRT Token 只放请求头，不写入地址或本地存储
   */
  logger.info("开始读取字幕搜索结果...");

  // 2.6.1 发送请求并解析 JSON
  const response = controller
    ? await fetchWithController(request.url, { headers: request.headers, timeoutMs, controller })
    : await fetchWithUiTimeout(request.url, timeoutMs, { headers: request.headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.error || "搜索失败");

  logger.info("读取字幕搜索结果完成", Number(data.count || 0));
  return data;
}

async function fetchWithUiTimeout(url, timeoutMs, options = {}) {
  /*
   * ================================================================================
   * 步骤3：发送带超时的请求
   * ================================================================================
   * 目标：
   * 1) 新搜索开始时取消上一次搜索
   * 2) 后端或网络异常时不让界面一直停在搜索中
   */
  logger.info("开始发送带超时的请求...");

  // 3.1 创建本次搜索控制器
  const controller = new AbortController();
  state.searchController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 3.2 执行请求并清理控制器
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    logger.info("带超时的请求完成");
    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("搜索超时，已停止等待慢源");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (state.searchController === controller) {
      state.searchController = null;
    }
  }
}

async function fetchWithController(url, options = {}) {
  /*
   * ================================================================================
   * 步骤3.5：发送可暂停的批量请求
   * ================================================================================
   * 目标：
   * 1) 接受批量任务自己的 AbortController
   * 2) 到时或用户暂停时取消当前请求
   */
  logger.info("开始发送可暂停的批量请求...");

  // 3.5.1 将任务取消信号转发到单次请求控制器
  const taskController = options.controller;
  const requestController = new AbortController();
  let timedOut = false;
  const abortRequest = () => requestController.abort();
  taskController.signal.addEventListener("abort", abortRequest, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, options.timeoutMs || BATCH_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: options.headers || {}, signal: requestController.signal });
    logger.info("发送可暂停的批量请求完成");
    return response;
  } catch (error) {
    if (error.name === "AbortError") {
      if (taskController.signal.aborted) throw new Error("搜索已暂停");
      if (timedOut) throw new Error("请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    taskController.signal.removeEventListener("abort", abortRequest);
  }
}

function renderResults(results) {
  /*
   * ================================================================================
   * 步骤3：渲染搜索结果
   * ================================================================================
   * 目标：
   * 1) 将统一结果结构渲染为表格
   * 2) 给每一行绑定预览动作
   */
  logger.info("开始渲染搜索结果...");

  // 3.1 处理空结果
  if (!results.length) {
    nodes.resultsBody.innerHTML = `<tr class="empty-row"><td colspan="5">没有找到字幕。</td></tr>`;
    syncSelectAllResults();
    renderBatchDownloadState();
    logger.info("渲染搜索结果完成: empty");
    return;
  }

  // 3.2 生成结果行
  nodes.resultsBody.innerHTML = results
    .map((item) => {
      const meta = [item.size, item.duration, item.extra].filter(Boolean).join(" · ");
      const checked = state.selectedDownloadIds.has(item.id) ? "checked" : "";
      return `
        <tr data-id="${escapeHtml(item.id)}">
          <td class="select-cell">
            <input type="checkbox" data-select="${escapeHtml(item.id)}" title="选择下载" ${checked} />
          </td>
          <td class="source-cell"><span class="source-pill">${escapeHtml(item.sourceLabel)}</span></td>
          <td class="file-cell" data-preview-cell="${escapeHtml(item.id)}">
            <button class="file-button" type="button" data-preview="${escapeHtml(item.id)}" title="查看字幕内容">
              <span class="file-title">${escapeHtml(item.title)}</span>
              <span class="preview-hint">查看</span>
            </button>
            <div class="file-meta">${escapeHtml(meta || item.fileName)}</div>
            <div class="mobile-result-metrics" aria-hidden="true">
              <span>${escapeHtml(item.language || "-")}</span>
              <span>下载 ${escapeHtml(String(item.downloads || "-"))}</span>
            </div>
          </td>
          <td class="language-cell">${escapeHtml(item.language || "-")}</td>
          <td class="downloads-cell">${escapeHtml(String(item.downloads || "-"))}</td>
        </tr>
      `;
    })
    .join("");

  // 3.3 绑定点击预览
  nodes.resultsBody.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      previewSubtitle(button.dataset.preview);
    });
  });

  // 3.4 绑定文件区域预览
  nodes.resultsBody.querySelectorAll("[data-preview-cell]").forEach((cell) => {
    cell.addEventListener("click", (event) => {
      if (event.target.closest("[data-select]")) return;
      void previewSubtitle(cell.dataset.previewCell);
    });
  });

  // 3.5 绑定选择下载
  nodes.resultsBody.querySelectorAll("[data-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedDownloadIds.add(checkbox.dataset.select);
      } else {
        state.selectedDownloadIds.delete(checkbox.dataset.select);
      }
      syncSelectAllResults();
      renderBatchDownloadState();
    });
  });

  syncSelectAllResults();
  renderBatchDownloadState();
  logger.info("渲染搜索结果完成");
}

function renderSourceStats(stats) {
  /*
   * ================================================================================
   * 步骤4：渲染源级状态
   * ================================================================================
   * 目标：
   * 1) 展示每个字幕源的完成、超时、失败状态
   * 2) 展示结果数和耗时
   */
  logger.info("开始渲染源级状态...");

  // 4.1 空状态隐藏
  if (!Array.isArray(stats) || !stats.length) {
    nodes.sourceStats.hidden = true;
    nodes.sourceStats.innerHTML = "";
    logger.info("渲染源级状态完成: empty");
    return;
  }

  // 4.2 生成状态项
  nodes.sourceStats.hidden = false;
  nodes.sourceStats.innerHTML = stats
    .map((item) => {
      const message = item.message ? ` title="${escapeHtml(item.message)}"` : "";
      const countValue = Number(item.count);
      const matchedValue = Number(item.matchedCount);
      const hasCountValue = Number.isFinite(countValue);
      const hasMatchedValue = Number.isFinite(matchedValue);
      const countText = item.status === "skipped" && item.message
        ? escapeHtml(item.message)
        : !hasCountValue
        ? `${escapeHtml(String(item.count == null ? "-" : item.count))}`
        : hasMatchedValue && matchedValue !== countValue
          ? `${escapeHtml(String(countValue))} 条原始 · ${escapeHtml(String(matchedValue))} 条命中`
          : `${escapeHtml(String(countValue))} 条`;
      return `
        <div class="source-stat" data-status="${escapeHtml(item.status || "done")}"${message}>
          <span>${escapeHtml(item.sourceLabel || item.source || "-")}</span>
          <b>${escapeHtml(item.statusLabel || "-")}</b>
          <small>${countText} · ${escapeHtml(item.duration || "-")}</small>
        </div>
      `;
    })
    .join("");

  logger.info("渲染源级状态完成");
}

function toggleSelectAllResults() {
  /*
   * ================================================================================
   * 步骤5：切换结果全选
   * ================================================================================
   * 目标：
   * 1) 勾选或取消全部当前搜索结果
   * 2) 同步批量下载按钮
   */
  logger.info("开始切换结果全选...");

  // 5.1 更新选择集合
  if (nodes.selectAllResults.checked) {
    state.results.forEach((item) => state.selectedDownloadIds.add(item.id));
  } else {
    state.selectedDownloadIds.clear();
  }

  // 5.2 重绘结果行
  renderResults(state.results);
  logger.info("切换结果全选完成");
}

function syncSelectAllResults() {
  // 5.3 同步全选框状态
  const total = state.results.length;
  const selected = state.results.filter((item) => state.selectedDownloadIds.has(item.id)).length;
  nodes.selectAllResults.disabled = total === 0;
  nodes.selectAllResults.checked = total > 0 && selected === total;
  nodes.selectAllResults.indeterminate = selected > 0 && selected < total;
}

function renderBatchDownloadState() {
  // 5.4 更新批量下载按钮状态
  const count = state.results.filter((item) => state.selectedDownloadIds.has(item.id)).length;
  nodes.batchDownloadButton.textContent = count ? `下载 ${count} 个` : "批量下载";
  nodes.batchDownloadButton.setAttribute("aria-disabled", count ? "false" : "true");
}

function clearSearchQuery() {
  /*
   * ================================================================================
   * 步骤5：清空搜索字段
   * ================================================================================
   * 目标：
   * 1) 一键清空当前搜索词
   * 2) 清空后保持焦点，方便直接重输
   */
  logger.info("开始清空搜索字段...");

  // 5.1 清空输入并恢复焦点
  nodes.query.value = "";
  clearActiveVideoSelection();
  nodes.query.focus();
  renderClearQueryButton();

  logger.info("清空搜索字段完成");
}

function renderClearQueryButton() {
  // 5.2 同步清空按钮状态
  const hasValue = Boolean(nodes.query.value);
  nodes.clearQueryButton.setAttribute("aria-disabled", hasValue ? "false" : "true");
}

async function openSettingsDialog() {
  /*
   * ================================================================================
   * 步骤6：打开设置弹窗
   * ================================================================================
   * 目标：
   * 1) Windows 和 Android 共用扫描及转换设置
   * 2) Windows 额外同步右键菜单开关状态
   */
  logger.info("开始打开设置弹窗...");

  // 6.1 没有应用桥时保持设置入口隐藏
  if (!window.subtitleFinder) {
    nodes.settingsButton.hidden = true;
    logger.info("打开设置弹窗完成: unsupported");
    return;
  }
  state.settingsFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  nodes.settingsMessage.textContent = "";
  await settingsReadyPromise;
  nodes.scanExclusionRules.value = state.scanExclusionRules.join("\n");
  nodes.customDictionary.value = state.customDictionary;
  nodes.settingsPlatformLabel.textContent = window.subtitleFinder.platform === "android" ? "Android 扫描与转换" : "Windows 扫描与转换";
  nodes.contextMenuSetting.hidden = !window.subtitleFinder.getContextMenuState;
  if (window.subtitleFinder.getContextMenuState) {
    try {
      const contextState = await window.subtitleFinder.getContextMenuState();
      nodes.contextMenuToggle.checked = Boolean(contextState?.enabled);
    } catch (error) {
      logger.warn("读取 Windows 右键菜单状态失败", error);
      nodes.contextMenuToggle.checked = false;
    }
  }
  nodes.settingsModal.hidden = false;
  nodes.settingsModal.removeAttribute("aria-hidden");
  document.body.classList.add("modal-open");
  nodes.scanExclusionRules.focus();

  logger.info("打开设置弹窗完成");
}

function closeSettingsDialog() {
  /*
   * ================================================================================
   * 步骤6.2：关闭设置弹窗
   * ================================================================================
   * 目标：
   * 1) 隐藏设置层
   * 2) 恢复打开设置前的焦点
   */
  logger.info("开始关闭设置弹窗...");

  // 6.2.1 隐藏弹窗并恢复焦点
  nodes.settingsModal.hidden = true;
  nodes.settingsModal.setAttribute("aria-hidden", "true");
  if (nodes.aboutModal.hidden) document.body.classList.remove("modal-open");
  if (state.settingsFocusReturn && typeof state.settingsFocusReturn.focus === "function") {
    state.settingsFocusReturn.focus();
  } else {
    nodes.settingsButton.focus();
  }
  state.settingsFocusReturn = null;

  logger.info("关闭设置弹窗完成");
}

async function saveSettings() {
  /*
   * ================================================================================
   * 步骤6.4：保存设置
   * ================================================================================
   * 目标：
   * 1) 校验并保存扫描排除规则和简繁词库
   * 2) Windows 额外注册或移除右键菜单
   */
  logger.info("开始保存设置...");

  // 6.4.1 锁定按钮并清理旧提示
  nodes.saveSettingsButton.disabled = true;
  nodes.settingsMessage.textContent = "正在保存";
  nodes.settingsMessage.dataset.tone = "busy";
  try {
    // 6.4.2 校验并保存通用设置
    const scanExclusionRules = parseScanExclusionRules(nodes.scanExclusionRules.value);
    parseCustomConversionDictionary(nodes.customDictionary.value);
    const response = await fetch(apiUrl("/api/settings"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          scanExclusionRules,
          customDictionary: nodes.customDictionary.value,
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "设置保存失败");
    state.scanExclusionRules = parseScanExclusionRules(data.settings?.scanExclusionRules || []);
    state.customDictionary = String(data.settings?.customDictionary || "");

    // 6.4.3 Windows 保存右键菜单状态
    if (window.subtitleFinder?.setContextMenuState) {
      const result = await window.subtitleFinder.setContextMenuState({ enabled: nodes.contextMenuToggle.checked });
      if (result?.ok === false) throw new Error(result.error || "Windows 右键菜单设置失败");
      nodes.contextMenuToggle.checked = Boolean(result?.enabled);
    }

    nodes.settingsMessage.textContent = "已保存";
    nodes.settingsMessage.dataset.tone = "ok";
    setStatus("设置已保存", "ok");
    if (state.selectedId && state.conversionTarget) {
      void previewSubtitle(state.selectedId, { preserveSelection: true });
    }
    logger.info("保存设置完成");
  } catch (error) {
    nodes.settingsMessage.textContent = String(error?.message || error);
    nodes.settingsMessage.dataset.tone = "error";
    logger.error("保存设置失败", error);
  } finally {
    nodes.saveSettingsButton.disabled = false;
  }
}

function openAboutDialog() {
  /*
   * ================================================================================
   * 步骤6：打开关于弹窗
   * ================================================================================
   * 目标：
   * 1) 展示项目、源码和授权信息
   * 2) 让桌面端和移动端都能查看发布说明
   */
  logger.info("开始打开关于弹窗...");

  // 6.1 记录触发元素并展示弹窗
  state.aboutFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  nodes.aboutModal.hidden = false;
  nodes.aboutModal.removeAttribute("aria-hidden");
  document.body.classList.add("modal-open");
  nodes.aboutModal.focus();
  nodes.closeAboutButton.focus();

  logger.info("打开关于弹窗完成");
}

function closeAboutDialog() {
  /*
   * ================================================================================
   * 步骤7：关闭关于弹窗
   * ================================================================================
   * 目标：
   * 1) 退出说明弹层
   * 2) 回到原来的操作位置
   */
  logger.info("开始关闭关于弹窗...");

  // 7.1 隐藏弹窗并恢复焦点
  nodes.aboutModal.hidden = true;
  nodes.aboutModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  if (state.aboutFocusReturn && typeof state.aboutFocusReturn.focus === "function") {
    state.aboutFocusReturn.focus();
  } else {
    nodes.aboutButton.focus();
  }
  state.aboutFocusReturn = null;

  logger.info("关闭关于弹窗完成");
}

async function openThirdPartyLicenses() {
  /*
   * ================================================================================
   * 步骤7.2：打开第三方许可清单
   * ================================================================================
   * 目标：
   * 1) Windows 优先打开发布包内的离线许可清单
   * 2) 其他平台打开仓库中的公开许可清单
   */
  logger.info("开始打开第三方许可清单...");

  // 7.2.1 优先调用桌面端本地文件入口
  if (window.subtitleFinder?.openThirdPartyLicenses) {
    const result = await window.subtitleFinder.openThirdPartyLicenses();
    if (!result?.opened) {
      logger.error("打开第三方许可清单失败", result?.error || "unknown");
    }
    logger.info("打开第三方许可清单完成", result?.opened ? "local" : "failed");
    return;
  }

  // 7.2.2 Android 和浏览器回退到仓库许可清单
  window.open(
    "https://github.com/daoran9/subtitle-finder/blob/main/vendor/THIRD_PARTY_LICENSES.md",
    "_blank",
    "noopener,noreferrer"
  );
  logger.info("打开第三方许可清单完成: repository");
}

async function previewSubtitle(id, options = {}) {
  /*
   * ================================================================================
   * 步骤4：预览字幕内容
   * ================================================================================
   * 目标：
   * 1) 请求本地预览接口
   * 2) 显示字幕文本
   * 3) 更新下载链接
   */
  logger.info("开始预览字幕...");

  // 4.1 取消上一次预览请求
  if (state.previewController) {
    state.previewController.abort();
  }
  const controller = new AbortController();
  state.previewController = controller;
  const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);

  // 4.2 更新选择状态
  state.selectedId = id;
  setActiveRow(id);
  setStatus("读取中", "busy");
  nodes.previewText.textContent = "正在读取字幕内容...";
  nodes.previewMeta.textContent = "读取中";
  openMobilePreview();

  try {
    // 4.3 请求预览内容
    const params = new URLSearchParams({ id, lang: nodes.language.value });
    if (state.conversionTarget) params.set("convert", state.conversionTarget);
    const response = await fetch(apiUrl(`/api/preview?${params.toString()}`), { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "预览失败");

    // 4.4 更新预览面板
    if (state.previewController !== controller) return;
    state.previewText = data.text || "";
    nodes.previewText.textContent = state.previewText || "字幕内容为空。";
    const validation = data.validation || {};
    const validationText = validation.valid ? `已校验 · ${validation.cueCount || 0} 条` : "";
    const languageHint = validation.language?.match === false ? validation.language.message : "";
    const conversionText = state.conversionTarget === "zh-CN" ? "简体副本" : state.conversionTarget === "zh-TW" ? "繁体副本" : "";
    nodes.previewMeta.textContent = [data.source, data.fileName, formatBytes(data.size), data.encoding, validationText, languageHint, conversionText].filter(Boolean).join(" · ");
    state.downloadUrl = absoluteApiUrl(`/api/download?${params.toString()}`);
    state.downloadFileName = data.fileName || "subtitle.srt";
    nodes.downloadButton.setAttribute("aria-disabled", "false");
    renderSubtitleSyncState();
    setStatus("已读取", "ok");
    logger.info("预览字幕完成");
  } catch (error) {
    if (error.name === "AbortError") {
      if (state.previewController === controller) {
        nodes.previewText.textContent = "预览超时，已停止等待。";
        nodes.previewMeta.textContent = "读取超时";
        nodes.downloadButton.setAttribute("aria-disabled", "true");
        renderSubtitleSyncState();
        setStatus("超时", "warn");
      }
      logger.info("预览字幕完成: aborted");
      return;
    }
    state.previewText = "";
    state.downloadUrl = "";
    state.downloadFileName = "";
    nodes.previewText.textContent = String(error.message || error);
    nodes.previewMeta.textContent = "读取失败";
    nodes.downloadButton.setAttribute("aria-disabled", "true");
    renderSubtitleSyncState();
    setStatus("失败", "error");
    logger.error("预览字幕失败", error);
  } finally {
    clearTimeout(timer);
    if (state.previewController === controller) {
      state.previewController = null;
    }
  }
}

async function copyPreviewText() {
  /*
   * ================================================================================
   * 步骤5：复制字幕文本
   * ================================================================================
   * 目标：
   * 1) 将当前预览区文本复制到剪贴板
   */
  logger.info("开始复制字幕文本...");

  // 5.1 校验预览内容
  if (!state.previewText) {
    setStatus("无内容", "warn");
    logger.info("复制字幕文本完成: empty");
    return;
  }

  // 5.2 写入剪贴板
  await navigator.clipboard.writeText(state.previewText);
  setStatus("已复制", "ok");
  logger.info("复制字幕文本完成");
}

async function downloadSubtitle() {
  /*
   * ================================================================================
   * 步骤5：下载字幕文件
   * ================================================================================
   * 目标：
   * 1) 桌面版下载到预先选择的保存目录
   * 2) 浏览器版保留普通下载行为
   */
  logger.info("开始下载字幕文件...");

  // 5.1 校验下载地址
  if (!state.downloadUrl || nodes.downloadButton.getAttribute("aria-disabled") === "true") {
    setStatus("无文件", "warn");
    logger.info("下载字幕文件完成: empty");
    return;
  }

  // 5.2 桌面版调用 Electron 保存对话框
  const absoluteUrl = absoluteApiUrl(state.downloadUrl);
  const selectedResult = state.results.find((item) => item.id === state.selectedId) || null;
  const preferredBaseName = buildPreferredSubtitleBaseName(selectedResult);
  if (window.subtitleFinder && window.subtitleFinder.saveSubtitle) {
    if (!state.downloadDir) {
      setStatus("先选位置", "warn");
      logger.info("下载字幕文件完成: 未选择保存位置");
      return;
    }

    try {
      setStatus("保存中", "busy");
      const result = await window.subtitleFinder.saveSubtitle({
        downloadUrl: absoluteUrl,
        fileName: state.downloadFileName || "subtitle.srt",
        downloadDir: state.downloadDir,
        preferredBaseName,
      });
      if (result && result.error) throw new Error(result.error);
      setStatus(result && result.saved ? "已保存" : "已取消", result && result.saved ? "ok" : "warn");
      logger.info("下载字幕文件完成: desktop");
    } catch (error) {
      setStatus("失败", "error");
      nodes.resultSummary.textContent = String(error.message || error);
      logger.error("下载字幕文件失败", error);
    }
    return;
  }

  // 5.3 浏览器版使用普通下载链接
  const link = document.createElement("a");
  link.href = absoluteUrl;
  link.download = buildPreferredDownloadFileName(state.downloadFileName || "subtitle.srt", preferredBaseName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setStatus("已下载", "ok");
  logger.info("下载字幕文件完成: browser");
}

async function syncCurrentSubtitle() {
  /*
   * ================================================================================
   * 步骤5.5：启动当前字幕自动校时
   * ================================================================================
   * 目标：
   * 1) 使用当前预览字幕、当前本地视频和预选保存目录
   * 2) 启动 Windows 主进程任务并切换到可取消状态
   */
  logger.info("开始启动当前字幕自动校时...");

  // 5.5.1 校验 Windows 桥和三个必要输入
  const bridge = window.subtitleFinder;
  const video = getActiveVideo();
  if (!(bridge && bridge.platform === "windows" && bridge.syncSubtitle)) {
    setStatus("Windows 可用", "warn");
    logger.info("启动当前字幕自动校时完成: unsupported");
    return;
  }
  if (!video?.path) {
    setStatus("先选视频", "warn");
    logger.info("启动当前字幕自动校时完成: no video");
    return;
  }
  if (!state.previewText || !state.downloadFileName) {
    setStatus("先选字幕", "warn");
    logger.info("启动当前字幕自动校时完成: no subtitle");
    return;
  }
  if (!state.downloadDir) {
    setStatus("先选位置", "warn");
    logger.info("启动当前字幕自动校时完成: no directory");
    return;
  }
  if (state.syncStatus === "starting" || state.syncStatus === "running" || state.syncStatus === "canceling") {
    logger.info("启动当前字幕自动校时完成: busy");
    return;
  }

  // 5.5.2 先显示准备状态，再调用主进程
  state.syncJobId = "";
  state.syncStatus = "starting";
  state.syncProgress = 0;
  state.syncMessage = "正在准备校时";
  renderSubtitleSyncState();
  setStatus("校时准备", "busy");
  const selectedResult = state.results.find((item) => item.id === state.selectedId) || null;
  const preferredBaseName = buildPreferredSubtitleBaseName(selectedResult);

  try {
    const result = await bridge.syncSubtitle({
      videoPath: video.path,
      subtitleText: state.previewText,
      fileName: state.downloadFileName || "subtitle.srt",
      downloadDir: state.downloadDir,
      preferredBaseName,
    });
    if (!(result && result.started && result.jobId)) {
      throw new Error(result?.error || "自动校时未启动");
    }
    if (state.syncStatus === "starting") {
      state.syncJobId = result.jobId;
      state.syncStatus = "running";
      state.syncMessage = "准备视频和字幕";
    }
    renderSubtitleSyncState();
    logger.info("启动当前字幕自动校时完成", result.jobId);
  } catch (error) {
    state.syncJobId = "";
    state.syncStatus = "failed";
    state.syncProgress = 0;
    state.syncMessage = String(error?.message || error);
    renderSubtitleSyncState();
    setStatus("校时失败", "error");
    logger.error("启动当前字幕自动校时失败", error);
  }
}

async function cancelCurrentSubtitleSync() {
  /*
   * ================================================================================
   * 步骤5.6：取消当前字幕自动校时
   * ================================================================================
   * 目标：
   * 1) 阻止重复取消
   * 2) 通知主进程终止 ffsubsync 和 FFmpeg 进程树
   */
  logger.info("开始取消当前字幕自动校时...");

  // 5.6.1 校验活跃任务
  const bridge = window.subtitleFinder;
  if (!(bridge && bridge.cancelSubtitleSync) || !state.syncJobId || state.syncStatus === "canceling") {
    logger.info("取消当前字幕自动校时完成: idle");
    return;
  }

  // 5.6.2 切换取消状态并通知主进程
  state.syncStatus = "canceling";
  state.syncMessage = "正在取消";
  renderSubtitleSyncState();
  const result = await bridge.cancelSubtitleSync({ jobId: state.syncJobId }).catch((error) => ({
    canceled: false,
    error: String(error?.message || error),
  }));
  if (!result?.canceled && result?.error) {
    state.syncStatus = "failed";
    state.syncMessage = result.error;
    state.syncJobId = "";
    renderSubtitleSyncState();
  }

  logger.info("取消当前字幕自动校时完成", result?.canceled ? "requested" : "idle");
}

function handleSubtitleSyncEvent(event) {
  /*
   * ================================================================================
   * 步骤5.7：接收字幕自动校时状态
   * ================================================================================
   * 目标：
   * 1) 忽略旧任务事件
   * 2) 显示进度、质量拒绝、失败和最终保存路径
   */
  logger.info("开始接收字幕自动校时状态...");

  // 5.7.1 首个事件可能早于 IPC 返回，准备阶段允许接管任务标识
  const jobId = String(event.jobId || "").trim();
  if (!jobId || (state.syncJobId && state.syncJobId !== jobId)) {
    logger.info("接收字幕自动校时状态完成: stale");
    return;
  }
  if (!state.syncJobId && state.syncStatus === "starting") state.syncJobId = jobId;
  if (state.syncJobId !== jobId) {
    logger.info("接收字幕自动校时状态完成: unknown");
    return;
  }

  // 5.7.2 更新任务状态和进度
  state.syncStatus = String(event.status || "running");
  state.syncProgress = Math.max(0, Math.min(100, Math.round(Number(event.progress) || 0)));
  state.syncMessage = formatSubtitleSyncMessage(event);
  const finished = ["completed", "rejected", "failed", "canceled"].includes(state.syncStatus);
  if (finished) state.syncJobId = "";
  renderSubtitleSyncState();

  // 5.7.3 同步全局状态徽标
  const statusMap = {
    running: ["校时中", "busy"],
    canceling: ["取消中", "busy"],
    completed: ["校时完成", "ok"],
    rejected: ["质量不足", "warn"],
    failed: ["校时失败", "error"],
    canceled: ["已取消", "warn"],
  };
  const badge = statusMap[state.syncStatus];
  if (badge) setStatus(badge[0], badge[1]);

  logger.info("接收字幕自动校时状态完成", state.syncStatus);
}

function formatSubtitleSyncMessage(event) {
  // 5.7.4 完成时显示文件名，其他状态使用主进程消息
  const filePath = String(event.filePath || "");
  if (event.status === "completed" && filePath) {
    const fileName = filePath.split(/[\\/]/).pop() || "校时字幕";
    nodes.syncProgress.title = filePath;
    return `已保存 ${fileName}`;
  }
  nodes.syncProgress.title = "";
  return String(event.message || "正在校时");
}

function renderSubtitleSyncState() {
  /*
   * ================================================================================
   * 步骤5.8：渲染字幕自动校时控件
   * ================================================================================
   * 目标：
   * 1) Android 和浏览器完全隐藏 Windows 专属入口
   * 2) 按输入完整性和任务状态控制校时、取消和进度
   */
  logger.info("开始渲染字幕自动校时控件...");

  // 5.8.1 判断 Windows 主进程能力
  const supported = Boolean(
    window.subtitleFinder &&
    window.subtitleFinder.platform === "windows" &&
    window.subtitleFinder.syncSubtitle &&
    window.subtitleFinder.cancelSubtitleSync
  );
  nodes.syncButton.hidden = !supported;
  if (!supported) {
    nodes.cancelSyncButton.hidden = true;
    nodes.syncProgress.hidden = true;
    logger.info("渲染字幕自动校时控件完成: hidden");
    return;
  }

  // 5.8.2 同步运行状态和按钮可用性
  const active = ["starting", "running", "canceling"].includes(state.syncStatus);
  const ready = Boolean(getActiveVideo()?.path && state.previewText && state.downloadDir);
  nodes.syncButton.disabled = active || !ready;
  nodes.syncButton.hidden = active;
  nodes.cancelSyncButton.hidden = !active;
  nodes.cancelSyncButton.disabled = state.syncStatus === "starting" || state.syncStatus === "canceling" || !state.syncJobId;
  nodes.syncProgress.hidden = state.syncStatus === "idle";
  const progress = nodes.syncProgress.querySelector("progress");
  progress.value = state.syncProgress;
  nodes.syncStatus.textContent = state.syncMessage || (ready ? "可以校时" : "请选择视频、字幕和保存位置");

  logger.info("渲染字幕自动校时控件完成", state.syncStatus, ready);
}

async function downloadSelectedSubtitles() {
  /*
   * ================================================================================
   * 步骤6：批量下载字幕文件
   * ================================================================================
   * 目标：
   * 1) 按用户勾选的结果逐个下载
   * 2) 桌面版直接保存到已选目录
   */
  logger.info("开始批量下载字幕文件...");

  // 6.1 校验选择状态
  const selectedItems = state.results.filter((item) => state.selectedDownloadIds.has(item.id));
  if (!selectedItems.length || nodes.batchDownloadButton.getAttribute("aria-disabled") === "true") {
    setStatus("未选择", "warn");
    logger.info("批量下载字幕文件完成: empty");
    return;
  }

  // 6.2 校验桌面保存位置
  const isDesktop = Boolean(window.subtitleFinder && window.subtitleFinder.saveSubtitle);
  if (isDesktop && !state.downloadDir) {
    setStatus("先选位置", "warn");
    logger.info("批量下载字幕文件完成: 未选择保存位置");
    return;
  }

  // 6.3 逐个下载
  let savedCount = 0;
  let failedCount = 0;
  for (const [index, item] of selectedItems.entries()) {
    try {
      setStatus(`${index + 1}/${selectedItems.length}`, "busy");
      const params = new URLSearchParams({ id: item.id, lang: nodes.language.value });
      if (state.conversionTarget) params.set("convert", state.conversionTarget);
      const absoluteUrl = absoluteApiUrl(`/api/download?${params.toString()}`);
      const preferredBaseName = buildPreferredSubtitleBaseName(item);
      if (isDesktop) {
        const result = await window.subtitleFinder.saveSubtitle({
          downloadUrl: absoluteUrl,
          fileName: item.fileName || "subtitle.srt",
          downloadDir: state.downloadDir,
          preferredBaseName,
        });
        if ((result && result.error) || !(result && result.saved)) throw new Error((result && result.error) || "保存取消");
      } else {
        triggerBrowserDownload(
          absoluteUrl,
          buildPreferredDownloadFileName(item.fileName || "subtitle.srt", preferredBaseName)
        );
      }
      savedCount += 1;
    } catch (error) {
      failedCount += 1;
      nodes.resultSummary.textContent = String(error.message || error);
      logger.error("批量下载单项失败", item.title, error);
    }
  }

  // 6.4 更新完成状态
  setStatus(failedCount ? "部分失败" : "已保存", failedCount ? "warn" : "ok");
  nodes.resultSummary.textContent = failedCount
    ? `已保存 ${savedCount} 个 · 失败 ${failedCount} 个`
    : `已保存 ${savedCount} 个`;
  logger.info("批量下载字幕文件完成", savedCount, failedCount);
}

function triggerBrowserDownload(url, fileName) {
  // 6.5 浏览器版触发下载
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "subtitle.srt";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function buildPreferredSubtitleBaseName(result = null) {
  /*
   * ================================================================================
   * 步骤6.6：生成媒体库字幕主文件名
   * ================================================================================
   * 目标：
   * 1) 只对当前从视频列表进入的搜索启用同名规则
   * 2) 按当前命名预设生成媒体库可识别文件名
   */
  logger.info("开始生成媒体库字幕主文件名...");

  // 6.6.1 读取当前视频和语言
  const video = getActiveVideo();
  if (!video) {
    logger.info("生成媒体库字幕主文件名完成: manual search");
    return "";
  }
  const effectiveLanguage = state.conversionTarget || nodes.language.value;
  const convertedProfile = state.conversionTarget
    ? {
      ...(result?.languageProfile || {}),
      chinese: true,
      simplified: effectiveLanguage === "zh-CN",
      traditional: effectiveLanguage === "zh-TW",
    }
    : result?.languageProfile || {};
  const preferredName = buildSubtitleBaseName(video.name, {
    preset: state.namingPreset,
    language: effectiveLanguage,
    source: result?.source || "subtitle",
    languageProfile: convertedProfile,
  });
  logger.info("生成媒体库字幕主文件名完成", preferredName);
  return preferredName;
}

function buildPreferredDownloadFileName(sourceFileName, preferredBaseName) {
  // 6.6.3 浏览器下载时保留来源扩展名
  if (!preferredBaseName) return sourceFileName || "subtitle.srt";
  const extension = getLastExtension(sourceFileName) || ".srt";
  return `${preferredBaseName}${extension}`;
}

function apiUrl(path) {
  /*
   * ================================================================================
   * 步骤6：生成 API 地址
   * ================================================================================
   * 目标：
   * 1) Android 页面保留在 Capacitor 原生域，API 请求转到内置 Node 服务
   * 2) Windows 和浏览器继续使用相对路径
   */
  logger.info("开始生成 API 地址...");

  // 6.1 读取移动端内置服务地址
  const baseUrl = String(window.subtitleFinderApiBase || "").replace(/\/+$/, "");
  if (/^https?:\/\//i.test(path)) {
    logger.info("生成 API 地址完成: absolute");
    return path;
  }
  const target = baseUrl ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}` : path;

  logger.info("生成 API 地址完成", target);
  return target;
}

function absoluteApiUrl(path) {
  /*
   * ================================================================================
   * 步骤6：生成完整 API 地址
   * ================================================================================
   * 目标：
   * 1) 给 Electron 主进程提供可校验的完整下载地址
   * 2) 兼容 Android 内置服务和普通浏览器页面
   */
  logger.info("开始生成完整 API 地址...");

  // 6.1 基于 API 地址生成绝对 URL
  const target = new URL(apiUrl(path), window.location.href).href;

  logger.info("生成完整 API 地址完成", target);
  return target;
}

async function chooseDownloadDir() {
  /*
   * ================================================================================
   * 步骤6：选择下载目录
   * ================================================================================
   * 目标：
   * 1) 桌面版弹出文件夹选择框
   * 2) 记录选择结果供后续下载直接使用
   */
  logger.info("开始选择下载目录...");

  // 6.1 校验桌面能力
  if (!(window.subtitleFinder && window.subtitleFinder.selectDownloadDir)) {
    setStatus("浏览器下载", "warn");
    logger.info("选择下载目录完成: browser");
    return;
  }

  // 6.2 选择并保存目录
  const result = await window.subtitleFinder.selectDownloadDir();
  if (!(result && result.selected) || !result.directory) {
    setStatus("已取消", "warn");
    logger.info("选择下载目录完成: cancel");
    return;
  }
  state.downloadDir = result.directory;
  state.downloadDirLabel = result.label || result.directory;
  localStorage.setItem("subtitle-finder-download-dir", state.downloadDir);
  localStorage.setItem("subtitle-finder-download-dir-label", state.downloadDirLabel);
  renderDownloadDir();
  renderSubtitleSyncState();

  setStatus("已选位置", "ok");
  logger.info("选择下载目录完成", state.downloadDir);
}

function restoreDownloadDir() {
  // 6.3 恢复上次选择的下载目录
  state.downloadDir = localStorage.getItem("subtitle-finder-download-dir") || "";
  state.downloadDirLabel = localStorage.getItem("subtitle-finder-download-dir-label") || state.downloadDir;
  renderDownloadDir();
  renderSubtitleSyncState();
}

function renderDownloadDir() {
  // 6.4 更新下载目录按钮状态
  if (state.downloadDir) {
    nodes.chooseDirButton.textContent = "位置已选";
    nodes.chooseDirButton.title = state.downloadDirLabel || state.downloadDir;
    return;
  }
  nodes.chooseDirButton.textContent = "位置";
  nodes.chooseDirButton.title = "选择存放位置";
}

async function scanVideoFolder() {
  /*
   * ================================================================================
   * 步骤7：扫描视频文件夹
   * ================================================================================
   * 目标：
   * 1) 桌面版或 Android 选择视频目录
   * 2) 统一解析媒体身份和已有字幕状态
   * 3) 显示可点击搜索的视频文件
   */
  logger.info("开始扫描视频文件夹...");

  // 7.1 校验桌面能力
  if (!(window.subtitleFinder && window.subtitleFinder.selectVideoDir)) {
    setStatus("桌面版可用", "warn");
    logger.info("扫描视频文件夹完成: browser");
    return;
  }

  // 7.2 停止旧任务后选择目录
  pauseBatchMatch();
  await settingsReadyPromise;
  const result = await window.subtitleFinder.selectVideoDir({ excludeRules: state.scanExclusionRules });
  if (!(result && result.selected)) {
    setStatus("已取消", "warn");
    logger.info("扫描视频文件夹完成: cancel");
    return;
  }

  // 7.3 只有真正选择新目录后才阻止旧状态异步恢复
  state.batchStateTouched = true;
  state.videoFiles = normalizeScannedVideoFiles(Array.isArray(result.files) ? result.files : []);
  state.activeVideoPath = "";
  state.singleVideoMode = false;
  state.videoDirectoryLabel = String(result.label || result.directory || "");
  state.batchTasks = [];
  state.batchStatus = "idle";
  state.videoDirectoryId = String(result.directory || result.label || "");
  renderVideoFiles();
  renderBatchMatchState();
  await savePersistentBatchState({ immediate: true });
  setStatus(state.videoFiles.length ? "已扫描" : "无视频", state.videoFiles.length ? "ok" : "warn");
  logger.info("扫描视频文件夹完成", state.videoFiles.length);
}

async function selectSingleVideo() {
  /*
   * ================================================================================
   * 步骤7.2：选择单个视频
   * ================================================================================
   * 目标：
   * 1) Windows 和 Android 都调用系统文件选择器
   * 2) 载入后自动以该视频搜索字幕
   */
  logger.info("开始选择单个视频...");

  // 7.2.1 校验平台能力并打开选择器
  if (!(window.subtitleFinder && window.subtitleFinder.selectVideoFile)) {
    setStatus("应用版可用", "warn");
    logger.info("选择单个视频完成: unsupported");
    return;
  }
  pauseBatchMatch();
  const result = await window.subtitleFinder.selectVideoFile();
  await loadVideoSelectionResult(result, { singleVideo: true, startSearch: true });

  logger.info("选择单个视频完成");
}

async function loadVideoSelectionResult(result, options = {}) {
  /*
   * ================================================================================
   * 步骤7.3：载入视频选择结果
   * ================================================================================
   * 目标：
   * 1) 统一处理按钮选择、Windows 拖入和右键启动
   * 2) 单视频模式不创建文件夹批量任务
   */
  logger.info("开始载入视频选择结果...");

  // 7.3.1 处理取消和平台错误
  if (!(result && result.selected)) {
    if (result?.error) {
      setStatus("载入失败", "error");
      nodes.resultSummary.textContent = String(result.error);
    } else {
      setStatus("已取消", "warn");
    }
    logger.info("载入视频选择结果完成: empty");
    return false;
  }

  // 7.3.2 写入视频状态并选中目标
  state.batchStateTouched = true;
  state.videoFiles = normalizeScannedVideoFiles(Array.isArray(result.files) ? result.files : []);
  state.videoDirectoryLabel = String(result.label || result.directory || "");
  state.videoDirectoryId = options.singleVideo ? "" : String(result.directory || result.label || "");
  state.singleVideoMode = Boolean(options.singleVideo);
  state.batchTasks = [];
  state.batchStatus = "idle";
  const selectedVideo = result.videoPath
    ? state.videoFiles.find((item) => item.path === result.videoPath) || state.videoFiles[0]
    : options.singleVideo ? state.videoFiles[0] : null;
  state.activeVideoPath = selectedVideo?.path || "";
  if (selectedVideo) {
    nodes.query.value = selectedVideo.query || selectedVideo.name || "";
    renderClearQueryButton();
  }
  renderVideoFiles();
  renderSubtitleSyncState();
  renderBatchMatchState();
  if (!options.singleVideo) await savePersistentBatchState({ immediate: true });
  setStatus(state.videoFiles.length ? "已载入" : "无视频", state.videoFiles.length ? "ok" : "warn");

  // 7.3.3 单视频入口自动开始搜索
  if (options.startSearch && selectedVideo) await searchSubtitles();
  logger.info("载入视频选择结果完成", state.videoFiles.length);
  return true;
}

async function consumeDesktopLaunchTarget() {
  /*
   * ================================================================================
   * 步骤7.4：处理 Windows 右键启动目标
   * ================================================================================
   * 目标：
   * 1) 接收主进程传入的视频或文件夹
   * 2) 视频自动填入搜索词，文件夹复用批量扫描界面
   */
  logger.info("开始处理 Windows 右键启动目标...");

  // 7.4.1 仅桌面桥支持启动目标
  if (!(window.subtitleFinder && window.subtitleFinder.consumeLaunchTarget)) {
    logger.info("处理 Windows 右键启动目标完成: unsupported");
    return;
  }

  // 7.4.2 读取并载入目标
  try {
    const result = await window.subtitleFinder.consumeLaunchTarget();
    if (!(result && result.selected)) {
      logger.info("处理 Windows 右键启动目标完成: empty");
      return;
    }
    await loadVideoSelectionResult(result, {
      singleVideo: Boolean(result.videoPath),
      startSearch: Boolean(result.videoPath),
    });
    logger.info("处理 Windows 右键启动目标完成", state.videoFiles.length);
  } catch (error) {
    setStatus("载入失败", "error");
    logger.error("处理 Windows 右键启动目标失败", error);
  }
}

function renderVideoFiles() {
  /*
   * ================================================================================
   * 步骤8：渲染视频文件列表
   * ================================================================================
   * 目标：
   * 1) 展示缺字幕和已有字幕状态
   * 2) 默认隐藏已有字幕，避免重复查找
   * 3) 点击后用解析后的片名和季集号搜索字幕
   */
  logger.info("开始渲染视频文件列表...");

  // 8.1 更新扫描摘要
  renderVideoScanSummary();

  // 8.2 处理空列表
  if (!state.videoFiles.length) {
    nodes.videoList.innerHTML = `<span class="muted">未找到</span>`;
    logger.info("渲染视频文件列表完成: empty");
    return;
  }

  // 8.3 按筛选条件生成视频按钮
  const visibleFiles = state.videoFiles
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      !state.hideMatchedVideos ||
      !item.hasSubtitle ||
      state.batchTasks.some((task) => task.videoPath === item.path)
    );
  if (!visibleFiles.length) {
    nodes.videoList.innerHTML = `<span class="muted">全部视频已有字幕</span>`;
    logger.info("渲染视频文件列表完成: matched");
    return;
  }

  nodes.videoList.innerHTML = visibleFiles
    .slice(0, 80)
    .map(({ item, index }) => {
      const existingNames = Array.isArray(item.existingSubtitles) ? item.existingSubtitles.join("\n") : "";
      const task = state.batchTasks.find((candidate) => candidate.videoPath === item.path);
      const title = [item.path || item.name || "", existingNames, task?.message].filter(Boolean).join("\n");
      const statusLabel = getVideoStatusLabel(item, task);
      const statusTone = task?.status === "failed" || task?.status === "no-result"
        ? "failed"
        : task?.status === "searching"
          ? "busy"
          : item.hasSubtitle
            ? "matched"
            : "missing";
      const activeClass = item.path === state.activeVideoPath ? " is-active" : "";
      const mediaSummary = [task?.message || item.query || item.name || "", item.nfoMetadata ? "NFO" : ""].filter(Boolean).join(" · ");
      return `
      <button class="video-file-button${activeClass}" type="button" data-video-index="${index}" title="${escapeHtml(title)}">
        <span class="video-file-line">
          <strong>${escapeHtml(item.name || item.query || "video")}</strong>
          <b class="video-file-status" data-status="${statusTone}">${escapeHtml(statusLabel)}</b>
        </span>
        <small>${escapeHtml(mediaSummary)}</small>
      </button>
    `;
    })
    .join("");

  // 8.4 绑定点击搜索并记录当前视频
  nodes.videoList.querySelectorAll("[data-video-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.videoFiles[Number(button.dataset.videoIndex)];
      state.activeVideoPath = (item && item.path) || "";
      nodes.videoList.querySelectorAll(".video-file-button").forEach((videoButton) => {
        videoButton.classList.toggle("is-active", videoButton === button);
      });
      nodes.query.value = (item && item.query) || (item && item.name) || "";
      renderClearQueryButton();
      renderSubtitleSyncState();
      void searchSubtitles();
    });
  });

  logger.info("渲染视频文件列表完成");
}

function normalizeScannedVideoFiles(files) {
  /*
   * ================================================================================
   * 步骤9：规范视频扫描结果
   * ================================================================================
   * 目标：
   * 1) Electron 和 Android 共用同一套片名、季集号解析规则
   * 2) 用同目录字幕名判断视频是否已有字幕
   * 3) 缺字幕优先，同系列按季集号排序
   */
  logger.info("开始规范视频扫描结果...");

  // 9.1 补齐媒体身份和已有字幕状态
  const normalized = files.map((item) => {
    const parentNames = Array.isArray(item.parentNames) ? item.parentNames : [];
    const media = analyzeMediaFile(item.name, { parentNames, nfoMetadata: item.nfoMetadata });
    const existingSubtitles = Array.isArray(item.existingSubtitles)
      ? item.existingSubtitles
      : findExistingSubtitles(item.name, item.subtitleNames, { parentNames });
    const hasExternalSubtitle = existingSubtitles.length > 0;
    const hasEmbeddedSubtitle = hasMatchingEmbeddedSubtitle(item, nodes.language.value);
    return {
      ...item,
      ...media,
      hasExternalSubtitle,
      hasEmbeddedSubtitle,
      hasSubtitle: hasExternalSubtitle || hasEmbeddedSubtitle,
      existingSubtitleCount: existingSubtitles.length,
      existingSubtitles,
    };
  });

  // 9.2 按缺失状态、标题和季集号排序
  normalized.sort(compareMediaEntries);
  logger.info("规范视频扫描结果完成", normalized.length);
  return normalized;
}

function renderVideoScanSummary() {
  /*
   * ================================================================================
   * 步骤10：渲染视频扫描摘要
   * ================================================================================
   * 目标：
   * 1) 显示缺字幕和已有字幕数量
   * 2) 同步“仅缺字幕”筛选状态
   */
  logger.info("开始渲染视频扫描摘要...");

  // 10.1 未扫描时隐藏摘要
  if (!state.videoFiles.length && !state.videoDirectoryLabel) {
    nodes.videoScanMeta.hidden = true;
    logger.info("渲染视频扫描摘要完成: hidden");
    return;
  }

  // 10.2 统计并显示扫描结果
  const matchedCount = state.videoFiles.filter((item) => item.hasSubtitle).length;
  const missingCount = state.videoFiles.length - matchedCount;
  nodes.videoScanMeta.hidden = false;
  nodes.missingOnlyToggle.checked = state.hideMatchedVideos;
  nodes.videoScanSummary.textContent = `缺 ${missingCount} · 已有 ${matchedCount}`;
  nodes.videoScanSummary.title = state.videoDirectoryLabel;
  logger.info("渲染视频扫描摘要完成", missingCount, matchedCount);
}

function restoreVideoFilter() {
  // 10.3 恢复“仅缺字幕”筛选
  state.hideMatchedVideos = localStorage.getItem("subtitle-finder-missing-only") !== "false";
  nodes.missingOnlyToggle.checked = state.hideMatchedVideos;
}

function getActiveVideo() {
  // 9.3 返回当前由视频列表触发搜索的文件
  if (!state.activeVideoPath) return null;
  return state.videoFiles.find((item) => item.path === state.activeVideoPath) || null;
}

function clearActiveVideoSelection() {
  // 9.4 手动修改搜索词后退出视频同名下载模式
  state.activeVideoPath = "";
  nodes.videoList.querySelectorAll(".video-file-button.is-active").forEach((button) => button.classList.remove("is-active"));
  renderSubtitleSyncState();
}

function getVideoStatusLabel(video, task) {
  // 9.5 显示视频当前字幕或批量任务状态
  const taskLabels = {
    pending: "待处理",
    searching: "搜索中",
    saved: "已保存",
    "no-result": "无结果",
    failed: "失败",
    skipped: "已跳过",
  };
  if (task && taskLabels[task.status]) return taskLabels[task.status];
  if (video.hasExternalSubtitle) return `外挂 ${video.existingSubtitleCount || 1}`;
  if (video.hasEmbeddedSubtitle) return `内封 ${video.embeddedSubtitleCount || 1}`;
  return "缺字幕";
}

function hasMatchingEmbeddedSubtitle(video, language) {
  /*
   * ================================================================================
   * 步骤9.6：匹配目标语言内封字幕
   * ================================================================================
   * 目标：
   * 1) 根据字幕轨语言和标题判断中文、英文或日文
   * 2) 不把其他语言内封轨误判成目标字幕
   */
  logger.info("开始匹配目标语言内封字幕...");

  // 9.6.1 遍历文字轨并识别语言
  const tracks = Array.isArray(video?.embeddedSubtitles) ? video.embeddedSubtitles : [];
  const matched = tracks.some((track) => {
    const text = [track?.language, track?.title, track?.format].filter(Boolean).join(" ");
    const profile = analyzeSubtitleLanguage(text);
    if (language === "zh-CN") return profile.simplified || (profile.chinese && !profile.traditional);
    if (language === "zh-TW") return profile.traditional || (profile.chinese && !profile.simplified);
    if (language === "en") return profile.english;
    if (language === "ja") return profile.japanese;
    return false;
  });

  logger.info("匹配目标语言内封字幕完成", matched);
  return matched;
}

function restoreBatchSettings() {
  /*
   * ================================================================================
   * 步骤11：恢复批量匹配设置
   * ================================================================================
   * 目标：
   * 1) 恢复命名预设和并发数
   * 2) 不持久化 ASSRT Token
   */
  logger.info("开始恢复批量匹配设置...");

  // 11.1 读取非敏感设置
  state.namingPreset = localStorage.getItem("subtitle-finder-naming-preset") || "media-server";
  const storedConcurrency = localStorage.getItem("subtitle-finder-batch-concurrency");
  state.batchConcurrency = clampNumber(storedConcurrency == null ? 2 : Number(storedConcurrency), 1, 3, 2);
  state.assrtToken = "";
  nodes.namingPreset.value = state.namingPreset;
  nodes.batchConcurrency.value = String(state.batchConcurrency);
  nodes.assrtToken.value = "";

  logger.info("恢复批量匹配设置完成");
}

async function restoreAppSettings() {
  /*
   * ================================================================================
   * 步骤11.2：恢复通用设置
   * ================================================================================
   * 目标：
   * 1) 从本地服务读取扫描排除规则和简繁词库
   * 2) 服务暂未就绪时等待 Android Node 启动
   */
  logger.info("开始恢复通用设置...");

  // 11.2.1 等待本地服务并读取设置
  try {
    const ready = await waitForLocalService();
    if (!ready) throw new Error("本地服务未就绪");
    const response = await fetch(apiUrl("/api/settings"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "设置读取失败");
    state.scanExclusionRules = parseScanExclusionRules(data.settings?.scanExclusionRules || []);
    state.customDictionary = String(data.settings?.customDictionary || "");
    logger.info("恢复通用设置完成", state.scanExclusionRules.length);
  } catch (error) {
    state.scanExclusionRules = [];
    state.customDictionary = "";
    logger.warn("恢复通用设置失败", error);
  }
}

function syncConversionControl() {
  /*
   * ================================================================================
   * 步骤11.4：同步简繁转换状态
   * ================================================================================
   * 目标：
   * 1) 简体和繁体搜索允许生成新的中文副本
   * 2) 英文、日文搜索不提供无意义的字形转换
   */
  logger.info("开始同步简繁转换状态...");

  // 11.4.1 非中文语言恢复原文并禁用控件
  const chineseMode = nodes.language.value === "zh-CN" || nodes.language.value === "zh-TW";
  nodes.conversionSelect.disabled = !chineseMode;
  if (!chineseMode) {
    state.conversionTarget = "";
    nodes.conversionSelect.value = "";
  }

  logger.info("同步简繁转换状态完成", chineseMode ? "enabled" : "disabled");
}

async function restorePersistentBatchState() {
  /*
   * ================================================================================
   * 步骤11.5：恢复批量任务状态
   * ================================================================================
   * 目标：
   * 1) 等本地服务就绪后读取最近一次扫描和任务进度
   * 2) 不覆盖本次启动后用户已经选择的新目录
   */
  logger.info("开始恢复批量任务状态...");

  // 11.5.1 等待 Windows 或 Android 内置服务
  try {
    const ready = await waitForLocalService();
    if (!ready) {
      state.batchStateLoaded = true;
      logger.info("恢复批量任务状态完成: service unavailable");
      return;
    }

    // 11.5.2 读取持久化状态
    const response = await fetch(apiUrl("/api/state/batch"), { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "任务恢复失败");
    const saved = data.state;
    if (!state.batchStateTouched && saved && Array.isArray(saved.videoFiles) && saved.videoFiles.length) {
      if (["zh-CN", "zh-TW", "en", "ja"].includes(saved.language)) nodes.language.value = saved.language;
      syncConversionControl();
      state.videoDirectoryId = String(saved.videoDirectoryId || "");
      state.videoDirectoryLabel = String(saved.videoDirectoryLabel || "");
      state.videoFiles = normalizeScannedVideoFiles(saved.videoFiles);
      const videoPaths = new Set(state.videoFiles.map((item) => item.path));
      state.batchTasks = (Array.isArray(saved.batchTasks) ? saved.batchTasks : []).filter((task) => videoPaths.has(task.videoPath));
      state.batchStatus = ["idle", "paused", "completed"].includes(saved.batchStatus) ? saved.batchStatus : "paused";
      state.namingPreset = saved.namingPreset || state.namingPreset;
      state.batchConcurrency = clampNumber(saved.batchConcurrency, 1, 3, state.batchConcurrency);
      nodes.namingPreset.value = state.namingPreset;
      nodes.batchConcurrency.value = String(state.batchConcurrency);
    }

    // 11.5.3 标记恢复完成后渲染，后续变化才允许落盘
    state.batchStateLoaded = true;
    renderVideoFiles();
    renderBatchMatchState();
    if (state.batchStateTouched && state.videoDirectoryId) scheduleBatchStateSave();
    logger.info("恢复批量任务状态完成", state.batchTasks.length);
  } catch (error) {
    state.batchStateLoaded = true;
    logger.warn("恢复批量任务状态失败", error);
  }
}

async function waitForLocalService() {
  /*
   * ================================================================================
   * 步骤11.6：等待本地服务
   * ================================================================================
   * 目标：
   * 1) 桌面端立即通过健康检查
   * 2) Android 首次启动时等待 Node 服务和原生桥就绪
   */
  logger.info("开始等待本地服务...");

  // 11.6.1 最多等待 20 秒
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(apiUrl("/api/health"), { cache: "no-store" });
      if (response.ok) {
        logger.info("等待本地服务完成: ready");
        return true;
      }
    } catch {
      // 服务尚未启动时继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  logger.info("等待本地服务完成: timeout");
  return false;
}

function scheduleBatchStateSave() {
  /*
   * ================================================================================
   * 步骤11.7：安排批量状态保存
   * ================================================================================
   * 目标：
   * 1) 合并搜索进度产生的高频更新
   * 2) 恢复完成前不写空状态覆盖旧任务
   */
  logger.info("开始安排批量状态保存...");

  // 11.7.1 只在恢复完成且有目录身份时安排写入
  if (!state.batchStateLoaded || !state.videoDirectoryId) {
    logger.info("安排批量状态保存完成: skipped");
    return;
  }
  clearTimeout(state.batchStateSaveTimer);
  state.batchStateSaveTimer = setTimeout(() => {
    state.batchStateSaveTimer = null;
    void savePersistentBatchState({ immediate: true });
  }, 180);
  logger.info("安排批量状态保存完成");
}

async function savePersistentBatchState(options = {}) {
  /*
   * ================================================================================
   * 步骤11.8：保存批量任务状态
   * ================================================================================
   * 目标：
   * 1) 保存扫描快照、进度、失败原因和重试次数
   * 2) 明确排除 ASSRT Token、AbortController 和临时下载结果
   */
  logger.info("开始保存批量任务状态...");

  // 11.8.1 校验保存前提并清理定时器
  if (!state.batchStateLoaded || !state.videoDirectoryId) {
    logger.info("保存批量任务状态完成: skipped");
    return;
  }
  if (options.immediate) {
    clearTimeout(state.batchStateSaveTimer);
    state.batchStateSaveTimer = null;
  }

  // 11.8.2 组装白名单状态
  const persistedState = {
    videoDirectoryId: state.videoDirectoryId,
    videoDirectoryLabel: state.videoDirectoryLabel,
    videoFiles: state.videoFiles,
    batchTasks: state.batchTasks.map((task) => ({
      id: task.id,
      videoPath: task.videoPath,
      status: task.status,
      message: task.message,
      savedPath: task.savedPath,
      retryCount: task.retryCount || 0,
      updatedAt: task.updatedAt || Date.now(),
    })),
    batchStatus: state.batchStatus,
    namingPreset: state.namingPreset,
    batchConcurrency: state.batchConcurrency,
    language: nodes.language.value,
  };

  // 11.8.3 串行写入，避免旧响应覆盖新状态
  const previous = state.batchStateSavePromise || Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    const response = await fetch(apiUrl("/api/state/batch"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: persistedState }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "任务保存失败");
  });
  state.batchStateSavePromise = request;
  try {
    await request;
    logger.info("保存批量任务状态完成", persistedState.batchTasks.length);
  } catch (error) {
    logger.warn("保存批量任务状态失败", error);
  } finally {
    if (state.batchStateSavePromise === request) state.batchStateSavePromise = null;
  }
}

async function inspectVideoForSearch(video) {
  /*
   * ================================================================================
   * 步骤12：分析本地视频
   * ================================================================================
   * 目标：
   * 1) 读取 Shooter 和迅雷指纹
   * 2) 同时更新内封字幕状态
   */
  logger.info("开始分析本地视频...", video?.name || "video");

  // 12.1 优先复用本次扫描期间的分析结果
  if (video?.fingerprintStatus === "done" && video.shooterHash && video.thunderCid) {
    logger.info("分析本地视频完成: cached");
    return video;
  }
  if (!(window.subtitleFinder && window.subtitleFinder.inspectVideo)) {
    logger.info("分析本地视频完成: unsupported");
    return { ok: false, error: "当前版本缺少视频指纹能力" };
  }

  // 12.2 调用 Windows 或 Android 原生层
  const result = await window.subtitleFinder.inspectVideo({ videoPath: video.path });
  updateVideoInspectionState(video, result || {});
  logger.info("分析本地视频完成", result?.ok ? "ok" : "failed");
  return result || {};
}

function updateVideoInspectionState(video, inspection) {
  // 12.3 写回指纹和内封字幕结果
  if (!video || !inspection) return;
  for (const key of [
    "shooterHash",
    "thunderCid",
    "fingerprintStatus",
    "embeddedSubtitleStatus",
    "embeddedSubtitleCount",
    "embeddedSubtitles",
    "embeddedSubtitleError",
  ]) {
    if (inspection[key] !== undefined) video[key] = inspection[key];
  }
  if (inspection.ok === false && !video.fingerprintStatus) video.fingerprintStatus = "error";
  video.hasEmbeddedSubtitle = hasMatchingEmbeddedSubtitle(video, nodes.language.value);
  video.hasSubtitle = Boolean(video.hasExternalSubtitle || video.hasEmbeddedSubtitle);
}

async function startOrResumeBatchMatch() {
  /*
   * ================================================================================
   * 步骤13：启动或继续批量匹配
   * ================================================================================
   * 目标：
   * 1) 为缺字幕视频建立独立任务
   * 2) 按用户设置的并发数搜索并保存
   */
  logger.info("开始启动或继续批量匹配...");
  state.batchStateTouched = true;

  // 13.1 校验原生分析和保存能力
  if (state.batchStatus === "running") {
    logger.info("启动或继续批量匹配完成: already running");
    return;
  }
  if (!(window.subtitleFinder && window.subtitleFinder.inspectVideo && window.subtitleFinder.saveSubtitle)) {
    setStatus("当前版本不支持", "error");
    logger.info("启动或继续批量匹配完成: unsupported");
    return;
  }

  // 13.2 首次运行或全部完成后重建缺字幕任务
  if (!state.batchTasks.length || state.batchStatus === "idle" || state.batchStatus === "completed") {
    state.batchTasks = state.videoFiles
      .filter((video) => !video.hasSubtitle)
      .map((video, index) => ({
        id: `${Date.now()}-${index}`,
        videoPath: video.path,
        status: "pending",
        message: "",
        result: null,
        savedPath: "",
        retryCount: 0,
        updatedAt: Date.now(),
      }));
  }
  const pending = state.batchTasks.filter((task) => task.status === "pending");
  if (!pending.length) {
    state.batchStatus = "completed";
    renderBatchMatchState();
    logger.info("启动或继续批量匹配完成: empty");
    return;
  }

  // 13.3 创建本轮工作线程
  state.batchStatus = "running";
  const runId = state.batchRunId + 1;
  state.batchRunId = runId;
  renderBatchMatchState();
  const workerCount = Math.min(state.batchConcurrency, pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => runBatchWorker(runId)));

  // 13.4 所有工作线程结束后更新状态
  if (state.batchRunId === runId && state.batchStatus === "running") {
    state.batchStatus = "completed";
    renderBatchMatchState();
    renderVideoFiles();
  }
  logger.info("启动或继续批量匹配完成");
}

async function runBatchWorker(runId) {
  // 13.5 每个工作线程循环领取一个待处理任务
  while (state.batchStatus === "running" && state.batchRunId === runId) {
    const task = state.batchTasks.find((candidate) => candidate.status === "pending");
    if (!task) return;
    task.status = "searching";
    task.message = "正在分析视频";
    task.updatedAt = Date.now();
    renderBatchMatchState();
    renderVideoFiles();
    await processBatchTask(task, runId);
  }
}

async function processBatchTask(task, runId) {
  /*
   * ================================================================================
   * 步骤14：处理单个视频任务
   * ================================================================================
   * 目标：
   * 1) 检测内封字幕并查询全部可用来源
   * 2) 选择统一质量分最高的结果保存到视频旁边
   */
  logger.info("开始处理单个视频任务...", task.videoPath);

  // 14.1 定位视频并读取指纹
  const video = state.videoFiles.find((item) => item.path === task.videoPath);
  if (!video) {
    task.status = "failed";
    task.message = "视频文件已不在扫描列表";
    task.updatedAt = Date.now();
    renderBatchMatchState();
    logger.info("处理单个视频任务完成: missing video");
    return;
  }

  try {
    task.phase = "inspect";
    const inspection = await inspectVideoForSearch(video);
    if (state.batchRunId !== runId || state.batchStatus !== "running") return;
    updateVideoInspectionState(video, inspection);
    if (video.hasEmbeddedSubtitle) {
      task.status = "skipped";
      task.message = "已有目标语言内封字幕";
      task.updatedAt = Date.now();
      renderBatchMatchState();
      renderVideoFiles();
      logger.info("处理单个视频任务完成: embedded subtitle");
      return;
    }

    // 14.2 使用全部原有来源和可用精准来源搜索
    task.message = "正在搜索全部来源";
    task.phase = "search";
    renderBatchMatchState();
    const controller = new AbortController();
    state.batchControllers.set(task.id, controller);
    const request = buildSearchRequest({
      query: video.query || video.name,
      source: "all",
      language: nodes.language.value,
      limit: 100,
      video,
      videoInfo: inspection,
    });
    const data = await fetchSearchData(request, BATCH_SEARCH_TIMEOUT_MS, controller);
    if (state.batchRunId !== runId || state.batchStatus !== "running") return;
    const selected = await chooseBestValidSubtitleResult(data.results || [], task, controller);
    if (state.batchRunId !== runId || state.batchStatus !== "running") return;
    if (!selected) {
      task.status = "no-result";
      task.message = (data.results || []).length ? "候选字幕均未通过校验" : "全部来源均无可用结果";
      task.updatedAt = Date.now();
      renderBatchMatchState();
      renderVideoFiles();
      logger.info("处理单个视频任务完成: no result");
      return;
    }

    // 14.3 保存最高质量结果
    task.message = `正在保存 ${selected.sourceLabel || selected.source}`;
    task.phase = "save";
    task.result = selected;
    renderBatchMatchState();
    const saved = await saveBatchSubtitle(video, selected);
    if (!(saved && saved.saved)) throw new Error(saved?.error || "保存字幕失败");
    task.status = "saved";
    task.savedPath = saved.filePath || saved.fileName || "";
    task.message = "已匹配";
    task.updatedAt = Date.now();
    video.hasExternalSubtitle = true;
    video.hasSubtitle = true;
    video.existingSubtitleCount = Number(video.existingSubtitleCount || 0) + 1;
    renderBatchMatchState();
    renderVideoFiles();
    logger.info("处理单个视频任务完成: saved");
  } catch (error) {
    if (task.phase === "save") {
      task.status = "failed";
      task.message = String(error?.message || error);
      task.retryCount = Number(task.retryCount || 0) + 1;
      task.updatedAt = Date.now();
      renderBatchMatchState();
      renderVideoFiles();
      logger.error("处理单个视频保存失败", video.name, error);
      return;
    }
    if (state.batchRunId !== runId || state.batchStatus !== "running") {
      logger.info("处理单个视频任务完成: paused");
      return;
    }
    task.status = "failed";
    task.message = String(error?.message || error);
    task.retryCount = Number(task.retryCount || 0) + 1;
    task.updatedAt = Date.now();
    renderBatchMatchState();
    renderVideoFiles();
    logger.error("处理单个视频任务失败", video.name, error);
  } finally {
    task.phase = "";
    state.batchControllers.delete(task.id);
  }
}

async function chooseBestValidSubtitleResult(results, task, controller) {
  /*
   * ================================================================================
   * 步骤14.5：选择通过校验的字幕
   * ================================================================================
   * 目标：
   * 1) 按统一质量分依次检查候选字幕真实内容
   * 2) 第一条是网页、空文件或错语言时自动尝试下一条
   */
  logger.info("开始选择通过校验的字幕...");

  // 14.5.1 按现有质量规则排序并限制远程校验数量
  const candidates = (Array.isArray(results) ? results : [])
    .map((result, index) => ({ result, index }))
    .sort((left, right) => {
      const qualityOrder = Number(right.result.qualityScore || 0) - Number(left.result.qualityScore || 0);
      return qualityOrder || left.index - right.index;
    })
    .slice(0, 8)
    .map((entry) => entry.result);

  // 14.5.2 逐个请求服务端结构校验
  for (const [index, candidate] of candidates.entries()) {
    task.message = `正在校验 ${index + 1}/${candidates.length} · ${candidate.sourceLabel || candidate.source}`;
    task.updatedAt = Date.now();
    renderBatchMatchState();
    renderVideoFiles();
    try {
      const params = new URLSearchParams({ id: candidate.id, lang: nodes.language.value });
      const response = await fetchWithController(apiUrl(`/api/validate?${params.toString()}`), {
        headers: {},
        timeoutMs: PREVIEW_TIMEOUT_MS,
        controller,
      });
      const data = await response.json();
      if (response.ok && data.valid && data.validation?.language?.match !== false) {
        logger.info("选择通过校验的字幕完成", candidate.source);
        return candidate;
      }
      logger.warn("字幕候选未通过校验", candidate.title, data.validation?.language?.message || data.detail || data.error || "invalid");
    } catch (error) {
      if (controller.signal.aborted) throw error;
      logger.warn("校验字幕候选失败", candidate.title, error);
    }
  }

  logger.info("选择通过校验的字幕完成: empty");
  return null;
}

async function saveBatchSubtitle(video, result) {
  /*
   * ================================================================================
   * 步骤15：保存批量匹配字幕
   * ================================================================================
   * 目标：
   * 1) Windows 写到视频文件所在目录
   * 2) Android 写到扫描时取得授权的视频目录
   */
  logger.info("开始保存批量匹配字幕...", video.name);

  // 15.1 按当前媒体库预设生成字幕文件名
  const preferredBaseName = buildSubtitleBaseName(video.name, {
    preset: state.namingPreset,
    language: nodes.language.value,
    source: result.source,
    languageProfile: result.languageProfile || {},
  });
  const params = new URLSearchParams({ id: result.id, lang: nodes.language.value });
  const saved = await window.subtitleFinder.saveSubtitle({
    downloadUrl: absoluteApiUrl(`/api/download?${params.toString()}`),
    fileName: result.fileName || "subtitle.srt",
    preferredBaseName,
    targetVideoPath: video.path,
    targetDirectory: video.targetDirectory || "",
  });

  logger.info("保存批量匹配字幕完成", saved?.saved ? "saved" : "failed");
  return saved;
}

function pauseBatchMatch() {
  /*
   * ================================================================================
   * 步骤16：暂停批量匹配
   * ================================================================================
   * 目标：
   * 1) 取消正在等待的网络搜索
   * 2) 把未完成任务恢复为待处理，便于继续
   */
  logger.info("开始暂停批量匹配...");

  // 16.1 非运行状态无需处理
  if (state.batchStatus !== "running") {
    logger.info("暂停批量匹配完成: idle");
    return;
  }

  // 16.2 终止本轮并重置正在搜索的任务
  state.batchStatus = "paused";
  state.batchRunId += 1;
  state.batchControllers.forEach((controller) => controller.abort());
  state.batchControllers.clear();
  state.batchTasks.forEach((task) => {
    if (task.status === "searching" && task.phase !== "save") {
      task.status = "pending";
      task.message = "已暂停";
      task.updatedAt = Date.now();
    }
  });
  renderBatchMatchState();
  renderVideoFiles();

  logger.info("暂停批量匹配完成");
}

async function retryBatchMatch() {
  /*
   * ================================================================================
   * 步骤17：重试未成功任务
   * ================================================================================
   * 目标：
   * 1) 重置失败和无结果任务
   * 2) 保留已经保存或跳过的任务
   */
  logger.info("开始重试未成功任务...");

  // 17.1 标记可重试任务
  let retryCount = 0;
  state.batchTasks.forEach((task) => {
    if (task.status === "failed" || task.status === "no-result") {
      task.status = "pending";
      task.message = "等待重试";
      task.retryCount = Number(task.retryCount || 0) + 1;
      task.updatedAt = Date.now();
      retryCount += 1;
    }
  });
  if (retryCount) {
    state.batchStatus = "paused";
    renderBatchMatchState();
    await startOrResumeBatchMatch();
  }

  logger.info("重试未成功任务完成", retryCount);
}

function renderBatchMatchState() {
  /*
   * ================================================================================
   * 步骤18：渲染批量匹配状态
   * ================================================================================
   * 目标：
   * 1) 显示总体进度和各类结果数量
   * 2) 同步开始、暂停和重试按钮
   */
  logger.info("开始渲染批量匹配状态...");

  // 18.1 没有视频时隐藏面板
  const missingCount = state.videoFiles.filter((video) => !video.hasSubtitle).length;
  nodes.batchPanel.hidden = state.videoFiles.length === 0 || state.singleVideoMode;
  const total = state.batchTasks.length;
  const counts = state.batchTasks.reduce((summary, task) => {
    summary[task.status] = (summary[task.status] || 0) + 1;
    return summary;
  }, {});
  const completed = Number(counts.saved || 0) + Number(counts["no-result"] || 0) + Number(counts.failed || 0) + Number(counts.skipped || 0);

  // 18.2 更新进度条和文字
  const progress = nodes.batchProgress.querySelector("progress");
  const label = nodes.batchProgress.querySelector("span");
  progress.max = Math.max(total, 1);
  progress.value = Math.min(completed, progress.max);
  if (!total) {
    label.textContent = missingCount ? `待匹配 ${missingCount} 个视频` : "没有缺字幕视频";
  } else {
    label.textContent = `完成 ${completed}/${total} · 保存 ${counts.saved || 0} · 无结果 ${counts["no-result"] || 0} · 失败 ${counts.failed || 0} · 跳过 ${counts.skipped || 0}`;
  }

  // 18.3 同步按钮状态
  const running = state.batchStatus === "running";
  const retryable = Number(counts.failed || 0) + Number(counts["no-result"] || 0);
  nodes.startBatchButton.disabled = running || (!missingCount && state.batchStatus !== "paused");
  nodes.startBatchButton.textContent = state.batchStatus === "paused"
    ? "继续"
    : state.batchStatus === "completed"
      ? "已完成"
      : "匹配字幕";
  nodes.pauseBatchButton.disabled = !running;
  nodes.retryBatchButton.disabled = running || retryable === 0;
  nodes.namingPreset.disabled = running;
  nodes.batchConcurrency.disabled = running;
  nodes.language.disabled = running;

  // 18.4 任务和进度变化后安排持久化
  scheduleBatchStateSave();

  logger.info("渲染批量匹配状态完成");
}

function clampNumber(value, min, max, fallback) {
  // 18.4 限制并发设置范围
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function addRecent(query) {
  // 2.4 保存最近搜索
  const list = getRecent().filter((item) => item !== query);
  list.unshift(query);
  localStorage.setItem("subtitle-finder-recent", JSON.stringify(list.slice(0, 8)));
  renderRecent();
}

function getRecent() {
  // 1.5 读取最近搜索
  try {
    const list = JSON.parse(localStorage.getItem("subtitle-finder-recent") || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function renderRecent() {
  /*
   * ================================================================================
   * 步骤6：渲染最近搜索
   * ================================================================================
   * 目标：
   * 1) 显示最近搜索字段
   * 2) 点击后回填并搜索
   */
  logger.info("开始渲染最近搜索...");

  // 6.1 生成最近搜索按钮
  const list = getRecent();
  nodes.recentList.innerHTML = list.length
    ? list.map((item) => `<button type="button" data-query="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")
    : `<span class="muted">暂无</span>`;

  // 6.2 绑定回填搜索
  nodes.recentList.querySelectorAll("[data-query]").forEach((button) => {
    button.addEventListener("click", () => {
      clearActiveVideoSelection();
      nodes.query.value = button.dataset.query || "";
      renderClearQueryButton();
      void searchSubtitles();
    });
  });

  logger.info("渲染最近搜索完成");
}

function setActiveRow(id) {
  // 4.4 高亮当前选择
  nodes.resultsBody.querySelectorAll("tr").forEach((row) => {
    row.classList.toggle("is-active", row.dataset.id === id);
  });
}

function clearPreview() {
  // 2.5 清空预览状态
  state.selectedId = "";
  state.previewText = "";
  state.downloadUrl = "";
  state.downloadFileName = "";
  closeMobilePreview();
  if (state.previewController) {
    state.previewController.abort();
    state.previewController = null;
  }
  nodes.previewMeta.textContent = "未选择字幕";
  nodes.previewText.textContent = "点击左侧结果查看字幕内容。";
  nodes.downloadButton.setAttribute("aria-disabled", "true");
  renderSubtitleSyncState();
}

function scrollPreviewIntoView(behavior = "smooth") {
  /*
   * ================================================================================
   * 步骤7：定位预览区域
   * ================================================================================
   * 目标：
   * 1) 桌面端保留三栏布局，不打断用户视线
   * 2) 窄屏点击文件后自动进入预览区
   */
  logger.info("开始定位预览区域...");

  logger.info("定位预览区域完成");
}

function openMobilePreview() {
  /*
   * ================================================================================
   * 步骤8：打开移动端预览层
   * ================================================================================
   * 目标：
   * 1) 在手机上把预览直接铺到当前视口
   * 2) 不改变结果区位置，不要求手动滚动
   */
  logger.info("开始打开移动端预览层...");

  if (!window.matchMedia("(max-width: 760px)").matches) {
    logger.info("打开移动端预览层完成: desktop");
    return;
  }

  document.body.classList.add("preview-open");
  logger.info("打开移动端预览层完成");
}

function closeMobilePreview() {
  /*
   * ================================================================================
   * 步骤9：关闭移动端预览层
   * ================================================================================
   * 目标：
   * 1) 释放当前预览占位
   * 2) 让用户回到结果列表继续点选
   */
  logger.info("开始关闭移动端预览层...");

  document.body.classList.remove("preview-open");
  logger.info("关闭移动端预览层完成");
}

function setStatus(text, tone) {
  // 2.6 更新状态徽标
  nodes.statusBadge.textContent = text;
  nodes.statusBadge.dataset.tone = tone;
}

function escapeHtml(value) {
  // 3.4 转义 HTML
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getLastExtension(value) {
  // 6.6.5 读取下载文件最后一个扩展名
  const fileName = String(value || "").split(/[\\/]/).pop() || "";
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index) : "";
}

function formatBytes(bytes) {
  // 4.5 格式化字节数
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
