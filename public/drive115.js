import { analyzeMediaFile } from "./media-library.js";

export function initDrive115({ apiUrl, onSelect, getSubtitle, shouldMatchVideoName, feedback }) {
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
  let video = null;
  let targetPath = "";
  let account = null;
  let path = [{ id: "0", name: "根目录" }];
  let offset = 0;
  let nextOffset = null;
  let generation = 0;
  let timer;
  let saving = false;
  let loading = false;
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
      targetDirectory.textContent = `115 · ${targetPath}`;
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
  function cancelPolling() { generation += 1; clearTimeout(timer); qr.hidden = true; qr.removeAttribute("src"); }
  function close() {
    cancelPolling();
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

  async function loadFiles(newOffset = 0) {
    if (loading) return;
    loading = true;
    list.replaceChildren();
    message.textContent = "正在读取目录…";
    nextButton.disabled = true;
    previousButton.disabled = true;
    nextOffset = null;
    const requestPath = path.slice();
    try {
      const data = await api(`files?parentId=${encodeURIComponent(requestPath[requestPath.length - 1].id)}&offset=${newOffset}`);
      if (requestPath[requestPath.length - 1].id !== path[path.length - 1].id) return;
      offset = data.offset;
      nextOffset = data.nextOffset;
      const crumbs = document.querySelector("#drive115Path");
      crumbs.replaceChildren();
      path.forEach((entry, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = entry.name;
        button.disabled = index === path.length - 1;
        button.onclick = () => { if (loading) return; path = path.slice(0, index + 1); void loadFiles(); };
        crumbs.append(button);
      });
      for (const entry of data.entries.filter((item) => item.directory || item.video)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "drive115-file";
        button.textContent = `${entry.directory ? "文件夹 · " : "视频 · "}${entry.name}`;
        button.onclick = () => {
          if (loading || saving) return;
          if (entry.directory) { path.push({ id: entry.id, name: entry.name }); void loadFiles(); }
          else {
            video = { ...entry, ...analyzeMediaFile(entry.name), remote115: true };
            targetPath = path.map((item) => item.name).join(" / ");
            render(); close(); onSelect(video);
          }
        };
        list.append(button);
      }
      message.textContent = list.children.length ? "选择视频后搜索字幕，可将字幕保存到视频所在目录。" : "本页没有文件夹或视频。";
      document.querySelector("#drive115Page").textContent = `第 ${Math.floor(offset / 100) + 1} 页 · 共 ${data.total} 项`;
    } catch (error) { message.textContent = error.message; }
    finally {
      loading = false;
      nextButton.disabled = nextOffset === null;
      previousButton.disabled = offset === 0;
    }
  }

  async function open() {
    focusReturn = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    dialog.focus();
    message.textContent = "正在读取登录状态…";
    try {
      const data = await api("status");
      account = data.account;
      if (!appSelect.options.length) {
        for (const app of data.apps) appSelect.add(new Option(app.label, app.id));
        appSelect.value = "ios";
      }
      renderAccount();
      if (account) await loadFiles(offset);
      else message.textContent = "选择登录端，用 115 官方客户端扫描二维码并确认。";
    } catch (error) { message.textContent = error.message; }
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
            path = [{ id: "0", name: "根目录" }]; offset = 0;
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
  document.querySelector("#drive115Refresh").onclick = () => { void loadFiles(offset); };
  nextButton.onclick = () => { if (nextOffset !== null) void loadFiles(nextOffset); };
  previousButton.onclick = () => { void loadFiles(Math.max(0, offset - 100)); };
  document.querySelector("#drive115Logout").onclick = async () => {
    if (saving) return;
    try {
      await api("logout", {}); cancelPolling(); account = null; clearTarget(); renderAccount();
      path = [{ id: "0", name: "根目录" }]; offset = 0;
      message.textContent = "已退出 115。";
    } catch (error) { message.textContent = error.message; }
  };
  saveButton.onclick = async () => {
    const subtitle = getSubtitle();
    if (!video || !subtitle || saving) return;
    saving = true; render(); feedback("正在上传字幕到 115…", "busy");
    try {
      const result = await api("save", { video: { id: video.id, parentId: video.parentId, name: video.name }, resultId: subtitle.id, language: subtitle.language, conversion: subtitle.conversion });
      feedback(`已保存到 115 · ${result.fileName}`, "ok");
    } catch (error) { feedback(error.message, "error"); }
    finally { saving = false; render(); }
  };
  modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const focusable = [...dialog.querySelectorAll("button:not(:disabled), select")].filter((element) => element.getClientRects().length);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  render();
  return { get video() { return video; }, render, clearTarget };
}
