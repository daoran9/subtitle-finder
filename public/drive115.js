import { analyzeMediaFile, formatMediaDuration } from "./media-library.js";

const SORT_ORDERS = {
  name: { asc: "name-asc", desc: "name-desc" },
  time: { asc: "oldest", desc: "newest" },
  updated: { asc: "updated-asc", desc: "updated-desc" },
};

export function initDrive115({ apiUrl, onSelect, onFolder, getSubtitle, shouldMatchVideoName, feedback }) {
  const modal = document.querySelector("#drive115Modal");
  const dialog = modal.querySelector("[role=dialog]");
  const message = document.querySelector("#drive115Message");
  const appSelect = document.querySelector("#drive115App");
  const qr = document.querySelector("#drive115Qr");
  const list = document.querySelector("#drive115Files");
  const accountLabel = document.querySelector("#drive115Account");
  const loginPanel = document.querySelector("#drive115LoginPanel");
  const browser = document.querySelector("#drive115Browser");
  const target = document.querySelector("#drive115Target");
  const destination = target.querySelector(".drive115-destination");
  const targetDirectory = document.querySelector("#drive115TargetPath");
  const targetName = document.querySelector("#drive115TargetName");
  const clearButton = document.querySelector("#drive115Clear");
  const saveButton = document.querySelector("#save115Button");
  const nextButton = document.querySelector("#drive115Next");
  const previousButton = document.querySelector("#drive115Previous");
  const folderButton = document.querySelector("#drive115SelectFolder");
  const searchForm = document.querySelector("#drive115SearchForm");
  const searchInput = document.querySelector("#drive115SearchInput");
  const clearSearchButton = document.querySelector("#drive115ClearSearch");
  const sortSelect = document.querySelector("#drive115Sort");
  const directionSelect = document.querySelector("#drive115Direction");
  const rootPath = [{ id: "0", name: "根目录" }];
  let video = null;
  let targetPath = "";
  let account = null;
  let path = rootPath;
  let searchTerm = "";
  let pageIndex = 0;
  let pageOffsets = [0];
  let pageRun = 0;
  let folderTotal = 0;
  let nextOffset = null;
  let generation = 0;
  let timer;
  let saving = false;
  let loading = false;
  let scanning = false;
  let focusReturn;

  async function api(action, body) {
    const response = await fetch(apiUrl(`/api/drive115/${action}`), body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "115 操作失败");
    return data;
  }

  function render() {
    const subtitle = getSubtitle();
    target.hidden = !video;
    if (video) {
      const ext = subtitle?.fileName?.match(/\.(srt|ass|ssa|vtt|sub)$/i)?.[0]?.toLowerCase();
      targetDirectory.textContent = ["115", targetPath, formatMediaDuration(video.durationMs)].filter(Boolean).join(" · ");
      targetName.textContent = shouldMatchVideoName()
        ? video.name.replace(/\.[^.]+$/, "") + (ext || "（字幕扩展名）")
        : subtitle?.fileName || "选择字幕后显示文件名";
      destination.title = `${targetDirectory.textContent} / ${targetName.textContent}`;
    }
    saveButton.disabled = saving || !video || !subtitle;
    clearButton.disabled = saving;
    saveButton.textContent = saving ? "上传中…" : "存到 115";
  }

  function clearTarget() { video = null; render(); }
  function selectTarget(item, directory) { video = item; targetPath = directory; render(); }
  function saveSubtitle(item, subtitle) {
    return api("save", {
      video: { id: item.id, parentId: item.parentId, name: item.name },
      accountId: item.accountId,
      resultId: subtitle.id, language: subtitle.language, conversion: subtitle.conversion,
      version: subtitle.version,
    });
  }
  function cancelPolling() { generation += 1; clearTimeout(timer); qr.hidden = true; qr.removeAttribute("src"); }
  function close() {
    cancelPolling();
    pageRun += 1;
    loading = false;
    modal.hidden = true;
    if (!document.querySelector(".modal-backdrop:not([hidden])")) document.body.classList.remove("modal-open");
    focusReturn?.focus();
  }

  function renderAccount() {
    const loginLabel = account && [...appSelect.options].find((option) => option.value === account.app)?.textContent;
    accountLabel.textContent = account ? `${account.name} · ${account.id} · ${loginLabel || account.app}（已核对）` : "未登录";
    loginPanel.hidden = Boolean(account);
    browser.hidden = !account;
    document.querySelector("#drive115Logout").hidden = !account;
  }

  function clearSearch() {
    searchTerm = "";
    searchInput.value = "";
    clearSearchButton.hidden = true;
  }

  function browse(directory) {
    clearSearch();
    return loadFiles(0, directory);
  }

  async function openEntry(entry, button) {
    if (loading || saving) return;
    const parent = entry.parentId === path[path.length - 1].id ? path
      : entry.parentId === "0" ? rootPath : [...rootPath, { id: entry.parentId, name: `目录 ${entry.parentId}` }];
    if (entry.directory) {
      const folder = { id: entry.id, name: entry.name };
      return browse(entry.parentId === path[path.length - 1].id ? [...path, folder] : [...rootPath, folder]);
    }
    if (!entry.video) return browse(parent);

    const run = pageRun;
    button.disabled = true;
    try {
      let directory = parent;
      let durationMs = entry.durationMs;
      if (parent !== path && parent !== rootPath) {
        const page = await api(`files?parentId=${entry.parentId}`);
        if (run !== pageRun) return;
        directory = page.path || parent;
        durationMs ||= page.entries.find((item) => item.id === entry.id)?.durationMs;
      }
      selectTarget({ ...entry, ...analyzeMediaFile(entry.name), durationMs, remote115: true, accountId: account.id }, directory.map((item) => item.name).join(" / "));
      close(); onSelect(video);
    } catch (error) {
      if (run === pageRun) message.textContent = error.message;
    } finally { button.disabled = false; }
  }

  async function loadFiles(newIndex = 0, requestPath = path, newOffset = 0) {
    const run = ++pageRun;
    const keyword = searchTerm;
    const sort = SORT_ORDERS[sortSelect.value][directionSelect.value];
    const params = new URLSearchParams({ parentId: requestPath[requestPath.length - 1].id, offset: String(newOffset), sort });
    if (keyword) params.set("q", keyword);
    pageIndex = newIndex;
    if (!newIndex) pageOffsets = [];
    pageOffsets[newIndex] = newOffset;
    loading = true;
    folderTotal = 0;
    list.replaceChildren();
    message.textContent = keyword ? "正在搜索 115…" : "正在读取目录…";
    folderButton.disabled = true;
    nextButton.disabled = true;
    previousButton.disabled = true;
    nextOffset = null;
    const pageLabel = document.querySelector("#drive115Page");
    pageLabel.textContent = "";
    try {
      const data = await api(`${keyword ? "search" : "files"}?${params}`);
      if (run !== pageRun) return;
      path = data.path || requestPath;
      folderTotal = data.total;
      nextOffset = data.nextOffset;
      const crumbs = document.querySelector("#drive115Path");
      crumbs.replaceChildren();
      path.forEach((entry, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = entry.name;
        button.disabled = index === path.length - 1;
        button.onclick = () => { void browse(path.slice(0, index + 1)); };
        crumbs.append(button);
      });
      for (const entry of data.entries) {
        const clickable = entry.directory || entry.video || Boolean(keyword);
        const row = document.createElement(clickable ? "button" : "span");
        row.textContent = [entry.directory ? "文件夹" : entry.video ? "视频" : "文件", entry.name, formatMediaDuration(entry.durationMs)].filter(Boolean).join(" · ");
        row.className = clickable ? "drive115-file" : "drive115-file-label";
        if (clickable) {
          row.type = "button";
          row.onclick = () => { void openEntry(entry, row); };
        }
        list.append(row);
      }
      list.scrollTop = 0;
      message.textContent = keyword
        ? (data.total ? `“${keyword}”的搜索结果` : `未找到与“${keyword}”匹配的文件或文件夹。`)
        : (data.total ? "选择视频后搜索字幕，可将字幕保存到视频所在目录。" : "此目录为空。");
      pageLabel.textContent = `第 ${pageIndex + 1} 页 · 共 ${data.total} 项`;
    } catch (error) {
      if (run === pageRun) message.textContent = error.message;
    }
    finally {
      if (run === pageRun) {
        loading = false;
        nextButton.disabled = nextOffset === null;
        previousButton.disabled = pageIndex === 0;
        folderButton.disabled = scanning || !folderTotal || Boolean(keyword);
      }
    }
  }

  function refresh() { return loadFiles(pageIndex, path, pageOffsets[pageIndex]); }
  function resetBrowser() {
    pageRun += 1;
    path = rootPath;
    pageIndex = 0;
    pageOffsets = [0];
    clearSearch();
  }

  async function open() {
    focusReturn = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    dialog.focus();
    message.textContent = "正在读取登录状态…";
    const run = generation;
    try {
      const data = await api("status");
      if (run !== generation) return;
      account = data.account;
      if (!appSelect.options.length) {
        for (const app of data.apps) appSelect.add(new Option(app.label, app.id));
        appSelect.value = "ios";
      }
      renderAccount();
      if (account) await refresh();
      else message.textContent = "选择登录端，用 115 官方客户端扫描二维码并确认。";
    } catch (error) { if (run === generation) message.textContent = error.message; }
  }

  async function beginLogin() {
    cancelPolling();
    const run = generation;
    message.textContent = "正在生成二维码…";
    try {
      const token = await api("login", { app: appSelect.value });
      if (run !== generation) return;
      qr.src = apiUrl(`/api/drive115/qr-image?id=${encodeURIComponent(token.id)}`);
      qr.hidden = false;
      message.textContent = "请用 115 官方客户端扫码并确认登录。";
      async function poll() {
        if (run !== generation) return;
        try {
          const data = await api("poll", { id: token.id });
          if (run !== generation) return;
          if (data.status === "confirmed") {
            account = data.account;
            resetBrowser();
            clearTarget(); cancelPolling(); renderAccount(); await loadFiles(); return;
          }
          message.textContent = ({ waiting: "等待扫码…", scanned: "已扫码，请在 115 中确认。", expired: "二维码已过期，请重新生成。", canceled: "已取消登录。" })[data.status];
          if (data.status === "waiting" || data.status === "scanned") timer = setTimeout(poll, 1800);
          else qr.hidden = true;
        } catch (error) { if (run === generation) message.textContent = `${error.message}，可重新生成二维码。`; }
      }
      timer = setTimeout(poll, 1800);
    } catch (error) { if (run === generation) message.textContent = error.message; }
  }

  document.querySelector("#drive115Button").onclick = () => { void open(); };
  document.querySelector("#close115Button").onclick = close;
  document.querySelector("#drive115Login").onclick = () => { void beginLogin(); };
  appSelect.onchange = cancelPolling;
  qr.onerror = () => { message.textContent = "二维码图片加载失败，请重新生成。"; cancelPolling(); };
  clearButton.onclick = clearTarget;
  document.querySelector("#drive115Refresh").onclick = () => { void refresh(); };
  searchForm.onsubmit = (event) => {
    event.preventDefault();
    const keyword = searchInput.value.trim();
    if (!keyword) return;
    searchTerm = keyword;
    clearSearchButton.hidden = false;
    void loadFiles();
  };
  searchInput.oninput = () => { if (!searchInput.value && searchTerm) void browse(path); };
  clearSearchButton.onclick = () => { void browse(path); searchInput.focus(); };
  sortSelect.onchange = () => {
    const byName = sortSelect.value === "name";
    directionSelect.options[0].textContent = byName ? "A → Z" : "旧 → 新";
    directionSelect.options[1].textContent = byName ? "Z → A" : "新 → 旧";
    void loadFiles();
  };
  directionSelect.onchange = () => { void loadFiles(); };
  folderButton.onclick = async () => {
    if (!account || loading || scanning || saving || searchTerm) return;
    const run = pageRun;
    const folder = path[path.length - 1];
    const directory = path.map((entry) => entry.name).join(" / ");
    const stillSelected = () => run === pageRun;
    const params = new URLSearchParams({ parentId: folder.id, folderName: folder.id === "0" ? "" : folder.name });
    scanning = true;
    folderButton.disabled = true;
    message.textContent = "正在扫描 115 文件夹及子目录…";
    try {
      const data = await api(`scan?${params}`);
      if (!stillSelected()) return;
      const files = data.files.map((file) => ({ ...file, remote115: true, accountId: data.accountId,
        directoryLabel: [directory, ...file.parentNames.slice(folder.id === "0" ? 0 : 1)].join(" / ") }));
      close();
      await onFolder({ selected: true, label: `115 · ${directory}`, files, truncated: data.truncated });
    } catch (error) {
      if (stillSelected()) message.textContent = error.message;
    } finally {
      scanning = false;
      if (!loading) folderButton.disabled = !folderTotal || Boolean(searchTerm);
    }
  };
  nextButton.onclick = () => { if (nextOffset !== null) void loadFiles(pageIndex + 1, path, nextOffset); };
  previousButton.onclick = () => { if (pageIndex) void loadFiles(pageIndex - 1, path, pageOffsets[pageIndex - 1]); };
  document.querySelector("#drive115Logout").onclick = async () => {
    if (saving) return;
    try {
      await api("logout", {}); cancelPolling(); account = null; clearTarget(); renderAccount();
      resetBrowser();
      message.textContent = "已退出 115。";
    } catch (error) { message.textContent = error.message; }
  };
  saveButton.onclick = async () => {
    const subtitle = getSubtitle();
    if (!video || !subtitle || saving) return;
    saving = true; render(); feedback("正在上传字幕到 115…", "busy");
    try {
      const result = await saveSubtitle(video, subtitle);
      feedback(`已保存到 115 · ${result.fileName}`, "ok");
    } catch (error) { feedback(error.message, "error"); }
    finally { saving = false; render(); }
  };
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled)")].filter((element) => element.getClientRects().length);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  render();
  return { get video() { return video; }, render, clearTarget, selectTarget, saveSubtitle,
    isSignedIn: (accountId) => Boolean(account && account.id === accountId) };
}
