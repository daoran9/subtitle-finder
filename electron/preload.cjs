const { contextBridge, ipcRenderer, webUtils } = require("electron");

const logger = {
  info: (...args) => console.info("[SubtitleFinderPreload]", ...args),
};

/*
 * ================================================================================
 * 步骤1：暴露桌面保存接口
 * ================================================================================
 * 目标：
 * 1) 给前端提供安全的字幕保存方法
 * 2) 不暴露 Node.js 文件系统能力
 */
logger.info("开始暴露桌面保存接口...");

const droppedVideoListeners = new Set();

// 1.1 捕获拖入文件并由主进程校验本地路径
window.addEventListener("dragover", (event) => {
  if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files")) {
    event.preventDefault();
  }
});
window.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  event.preventDefault();
  try {
    const filePath = webUtils.getPathForFile(file);
    const result = await ipcRenderer.invoke("subtitle:load-video-path", { path: filePath });
    for (const listener of droppedVideoListeners) listener(result);
  } catch (error) {
    const result = { selected: false, error: String(error?.message || error) };
    for (const listener of droppedVideoListeners) listener(result);
  }
});

// 1.2 暴露保存字幕方法
contextBridge.exposeInMainWorld("subtitleFinder", {
  platform: "windows",
  selectDownloadDir: () => ipcRenderer.invoke("subtitle:select-download-dir"),
  selectVideoDir: (payload) => ipcRenderer.invoke("subtitle:select-video-dir", payload),
  selectVideoFile: () => ipcRenderer.invoke("subtitle:select-video-file"),
  inspectVideo: (payload) => ipcRenderer.invoke("subtitle:inspect-video", payload),
  saveSubtitle: (payload) => ipcRenderer.invoke("subtitle:save", payload),
  syncSubtitle: (payload) => ipcRenderer.invoke("subtitle:start-sync", payload),
  cancelSubtitleSync: (payload) => ipcRenderer.invoke("subtitle:cancel-sync", payload),
  getContextMenuState: () => ipcRenderer.invoke("subtitle:get-context-menu-state"),
  setContextMenuState: (payload) => ipcRenderer.invoke("subtitle:set-context-menu-state", payload),
  consumeLaunchTarget: () => ipcRenderer.invoke("subtitle:consume-launch-target"),
  openThirdPartyLicenses: () => ipcRenderer.invoke("subtitle:open-third-party-licenses"),
  onLaunchTargetAvailable: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("subtitle:launch-target-available", listener);
    return () => ipcRenderer.removeListener("subtitle:launch-target-available", listener);
  },
  onVideoDropped: (callback) => {
    if (typeof callback !== "function") return () => {};
    droppedVideoListeners.add(callback);
    return () => droppedVideoListeners.delete(callback);
  },
  onSubtitleSyncEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("subtitle:sync-event", listener);
    return () => ipcRenderer.removeListener("subtitle:sync-event", listener);
  },
});

logger.info("桌面保存接口暴露完成");
