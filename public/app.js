const state = {
  results: [],
  selectedId: "",
  previewText: "",
};

const logger = {
  info: (...args) => console.info("[SubtitleFinderUI]", ...args),
  warn: (...args) => console.warn("[SubtitleFinderUI]", ...args),
  error: (...args) => console.error("[SubtitleFinderUI]", ...args),
};

const nodes = {
  form: document.querySelector("#searchForm"),
  query: document.querySelector("#queryInput"),
  source: document.querySelector("#sourceSelect"),
  language: document.querySelector("#languageSelect"),
  resultSummary: document.querySelector("#resultSummary"),
  statusBadge: document.querySelector("#statusBadge"),
  resultsBody: document.querySelector("#resultsBody"),
  previewMeta: document.querySelector("#previewMeta"),
  previewText: document.querySelector("#previewText"),
  copyButton: document.querySelector("#copyButton"),
  downloadLink: document.querySelector("#downloadLink"),
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

// 1.3 绑定最近搜索清理
nodes.clearRecentButton.addEventListener("click", () => {
  localStorage.removeItem("subtitle-finder-recent");
  renderRecent();
});

// 1.4 渲染最近搜索
renderRecent();
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
  nodes.resultsBody.innerHTML = `<tr class="empty-row"><td colspan="5">正在搜索...</td></tr>`;
  clearPreview();

  try {
    const params = new URLSearchParams({ q: query, source, lang: language, limit: "30" });
    const response = await fetch(`/api/search?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "搜索失败");

    // 2.3 渲染搜索结果
    state.results = data.results || [];
    addRecent(query);
    renderResults(state.results);
    setStatus("完成", "ok");
    nodes.resultSummary.textContent = `${data.count} 条结果`;
    logger.info(`搜索字幕完成: ${data.count} 条`);
  } catch (error) {
    state.results = [];
    renderResults([]);
    setStatus("失败", "error");
    nodes.resultSummary.textContent = String(error.message || error);
    logger.error("搜索字幕失败", error);
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
    logger.info("渲染搜索结果完成: empty");
    return;
  }

  // 3.2 生成结果行
  nodes.resultsBody.innerHTML = results
    .map((item) => {
      const meta = [item.size, item.duration, item.extra].filter(Boolean).join(" · ");
      return `
        <tr data-id="${escapeHtml(item.id)}">
          <td><span class="source-pill">${escapeHtml(item.sourceLabel)}</span></td>
          <td>
            <button class="file-button" type="button" data-preview="${escapeHtml(item.id)}">
              ${escapeHtml(item.title)}
            </button>
            <div class="file-meta">${escapeHtml(meta || item.fileName)}</div>
          </td>
          <td>${escapeHtml(item.language || "-")}</td>
          <td>${escapeHtml(String(item.score ?? "-"))}</td>
          <td>${escapeHtml(String(item.downloads || "-"))}</td>
        </tr>
      `;
    })
    .join("");

  // 3.3 绑定点击预览
  nodes.resultsBody.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => previewSubtitle(button.dataset.preview));
  });

  logger.info("渲染搜索结果完成");
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

  // 4.1 更新选择状态
  state.selectedId = id;
  setActiveRow(id);
  setStatus("读取中", "busy");
  nodes.previewText.textContent = "正在读取字幕内容...";
  nodes.previewMeta.textContent = "读取中";

  try {
    // 4.2 请求预览内容
    const params = new URLSearchParams({ id, lang: nodes.language.value });
    const response = await fetch(`/api/preview?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "预览失败");

    // 4.3 更新预览面板
    state.previewText = data.text || "";
    nodes.previewText.textContent = state.previewText || "字幕内容为空。";
    nodes.previewMeta.textContent = `${data.source} · ${data.fileName} · ${formatBytes(data.size)} · ${data.encoding}`;
    nodes.downloadLink.href = `/api/download?${params.toString()}`;
    nodes.downloadLink.setAttribute("aria-disabled", "false");
    setStatus("已读取", "ok");
    logger.info("预览字幕完成");
  } catch (error) {
    state.previewText = "";
    nodes.previewText.textContent = String(error.message || error);
    nodes.previewMeta.textContent = "读取失败";
    nodes.downloadLink.href = "#";
    nodes.downloadLink.setAttribute("aria-disabled", "true");
    setStatus("失败", "error");
    logger.error("预览字幕失败", error);
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
  nodes.previewMeta.textContent = "未选择字幕";
  nodes.previewText.textContent = "点击左侧结果查看字幕内容。";
  nodes.downloadLink.href = "#";
  nodes.downloadLink.setAttribute("aria-disabled", "true");
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
