const state = {
  results: [],
  selectedId: "",
  selectedDownloadIds: new Set(),
  previewText: "",
  aboutFocusReturn: null,
  downloadUrl: "",
  downloadFileName: "",
  downloadDir: "",
  downloadDirLabel: "",
  videoFiles: [],
  searchController: null,
  previewController: null,
};
const PREVIEW_TIMEOUT_MS = 20000;

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
  downloadButton: document.querySelector("#downloadButton"),
  batchDownloadButton: document.querySelector("#batchDownloadButton"),
  aboutModal: document.querySelector("#aboutModal"),
  closeAboutButton: document.querySelector("#closeAboutButton"),
  closeAboutFooterButton: document.querySelector("#closeAboutFooterButton"),
  scanVideoButton: document.querySelector("#scanVideoButton"),
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
  renderClearQueryButton();
});

// 1.4 绑定关于弹窗
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
  if (event.key === "Escape" && !nodes.aboutModal.hidden) {
    closeAboutDialog();
  }
});

nodes.closePreviewButton.addEventListener("click", () => {
  closeMobilePreview();
});

// 1.5 绑定字幕下载按钮
nodes.downloadButton.addEventListener("click", async () => {
  await downloadSubtitle();
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

// 1.9 绑定视频文件夹扫描
nodes.scanVideoButton.addEventListener("click", async () => {
  await scanVideoFolder();
});

// 1.10 绑定最近搜索清理
nodes.clearRecentButton.addEventListener("click", () => {
  localStorage.removeItem("subtitle-finder-recent");
  renderRecent();
});

// 1.11 恢复保存位置
restoreDownloadDir();

// 1.12 渲染最近搜索
renderClearQueryButton();
renderRecent();
renderBatchDownloadState();
logger.info("页面初始化完成");

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

  // 2.1 读取搜索条件
  const query = nodes.query.value.trim();
  const source = nodes.source.value;
  const language = nodes.language.value;
  if (!query) {
    setStatus("请输入字段", "warn");
    nodes.query.focus();
    logger.info("搜索字幕完成: 空字段");
    return;
  }

  // 2.2 请求搜索接口
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
    const params = new URLSearchParams({ q: query, source, lang: language, limit: "80" });
    const response = await fetchWithUiTimeout(apiUrl(`/api/search?${params.toString()}`), 48000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "搜索失败");

    // 2.3 渲染搜索结果
    state.results = data.results || [];
    addRecent(query);
    renderResults(state.results);
    renderSourceStats(data.sourceStats || []);
    const errorCount = Array.isArray(data.errors) ? data.errors.length : 0;
    setStatus(errorCount ? "部分完成" : "完成", errorCount ? "warn" : "ok");
    nodes.resultSummary.textContent = errorCount ? `${data.count} 条结果 · ${errorCount} 个源失败` : `${data.count} 条结果`;
    logger.info(`搜索字幕完成: ${data.count} 条`);
  } catch (error) {
    state.results = [];
    state.selectedDownloadIds.clear();
    renderResults([]);
    renderSourceStats([]);
    setStatus("失败", "error");
    nodes.resultSummary.textContent = String(error.message || error);
    logger.error("搜索字幕失败", error);
  }
}

async function fetchWithUiTimeout(url, timeoutMs) {
  /*
   * ================================================================================
   * 步骤3：发送带超时的请求
   * ================================================================================
   * 目标：
   * 1) 新搜索开始时取消上一次搜索
   * 2) 后端或网络异常时不让界面一直停在搜索中
   */
  logger.info("开始发送带超时的请求...");

  // 3.1 取消上一次搜索
  if (state.searchController) {
    state.searchController.abort();
  }

  // 3.2 创建本次搜索控制器
  const controller = new AbortController();
  state.searchController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 3.3 执行请求并清理控制器
  try {
    const response = await fetch(url, { signal: controller.signal });
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
    nodes.resultsBody.innerHTML = `<tr class="empty-row"><td colspan="6">没有找到字幕。</td></tr>`;
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
              <span>评分 ${escapeHtml(String(item.score == null ? "-" : item.score))}</span>
              <span>下载 ${escapeHtml(String(item.downloads || "-"))}</span>
            </div>
          </td>
          <td class="language-cell">${escapeHtml(item.language || "-")}</td>
          <td class="score-cell">${escapeHtml(String(item.score == null ? "-" : item.score))}</td>
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
      const countText = !hasCountValue
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
  nodes.query.focus();
  renderClearQueryButton();

  logger.info("清空搜索字段完成");
}

function renderClearQueryButton() {
  // 5.2 同步清空按钮状态
  const hasValue = Boolean(nodes.query.value);
  nodes.clearQueryButton.setAttribute("aria-disabled", hasValue ? "false" : "true");
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

async function previewSubtitle(id) {
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
    const response = await fetch(apiUrl(`/api/preview?${params.toString()}`), { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "预览失败");

    // 4.4 更新预览面板
    if (state.previewController !== controller) return;
    state.previewText = data.text || "";
    nodes.previewText.textContent = state.previewText || "字幕内容为空。";
    nodes.previewMeta.textContent = `${data.source} · ${data.fileName} · ${formatBytes(data.size)} · ${data.encoding}`;
    state.downloadUrl = absoluteApiUrl(`/api/download?${params.toString()}`);
    state.downloadFileName = data.fileName || "subtitle.srt";
    nodes.downloadButton.setAttribute("aria-disabled", "false");
    setStatus("已读取", "ok");
    logger.info("预览字幕完成");
  } catch (error) {
    if (error.name === "AbortError") {
      if (state.previewController === controller) {
        nodes.previewText.textContent = "预览超时，已停止等待。";
        nodes.previewMeta.textContent = "读取超时";
        nodes.downloadButton.setAttribute("aria-disabled", "true");
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
  link.download = state.downloadFileName || "subtitle.srt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setStatus("已下载", "ok");
  logger.info("下载字幕文件完成: browser");
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
      const absoluteUrl = absoluteApiUrl(`/api/download?${params.toString()}`);
      if (isDesktop) {
        const result = await window.subtitleFinder.saveSubtitle({
          downloadUrl: absoluteUrl,
          fileName: item.fileName || "subtitle.srt",
          downloadDir: state.downloadDir,
        });
        if ((result && result.error) || !(result && result.saved)) throw new Error((result && result.error) || "保存取消");
      } else {
        triggerBrowserDownload(absoluteUrl, item.fileName || "subtitle.srt");
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

  setStatus("已选位置", "ok");
  logger.info("选择下载目录完成", state.downloadDir);
}

function restoreDownloadDir() {
  // 6.3 恢复上次选择的下载目录
  state.downloadDir = localStorage.getItem("subtitle-finder-download-dir") || "";
  state.downloadDirLabel = localStorage.getItem("subtitle-finder-download-dir-label") || state.downloadDir;
  renderDownloadDir();
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
   * 1) 桌面版选择视频目录
   * 2) 显示可点击搜索的视频文件
   */
  logger.info("开始扫描视频文件夹...");

  // 7.1 校验桌面能力
  if (!(window.subtitleFinder && window.subtitleFinder.selectVideoDir)) {
    setStatus("桌面版可用", "warn");
    logger.info("扫描视频文件夹完成: browser");
    return;
  }

  // 7.2 选择目录并渲染视频文件
  const result = await window.subtitleFinder.selectVideoDir();
  if (!(result && result.selected)) {
    setStatus("已取消", "warn");
    logger.info("扫描视频文件夹完成: cancel");
    return;
  }

  state.videoFiles = Array.isArray(result.files) ? result.files : [];
  renderVideoFiles();
  setStatus(state.videoFiles.length ? "已扫描" : "无视频", state.videoFiles.length ? "ok" : "warn");
  logger.info("扫描视频文件夹完成", state.videoFiles.length);
}

function renderVideoFiles() {
  /*
   * ================================================================================
   * 步骤8：渲染视频文件列表
   * ================================================================================
   * 目标：
   * 1) 展示扫描到的视频文件
   * 2) 点击后用清洗后的文件名搜索字幕
   */
  logger.info("开始渲染视频文件列表...");

  // 8.1 处理空列表
  if (!state.videoFiles.length) {
    nodes.videoList.innerHTML = `<span class="muted">未找到</span>`;
    logger.info("渲染视频文件列表完成: empty");
    return;
  }

  // 8.2 生成视频按钮
  nodes.videoList.innerHTML = state.videoFiles
    .slice(0, 80)
    .map((item, index) => `
      <button type="button" data-video-index="${index}" title="${escapeHtml(item.path || item.name || "")}">
        <span>${escapeHtml(item.name || item.query || "video")}</span>
        <small>${escapeHtml(item.query || item.name || "")}</small>
      </button>
    `)
    .join("");

  // 8.3 绑定点击搜索
  nodes.videoList.querySelectorAll("[data-video-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.videoFiles[Number(button.dataset.videoIndex)];
      nodes.query.value = (item && item.query) || (item && item.name) || "";
      renderClearQueryButton();
      void searchSubtitles();
    });
  });

  logger.info("渲染视频文件列表完成");
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

function formatBytes(bytes) {
  // 4.5 格式化字节数
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
