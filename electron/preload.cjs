const { contextBridge, ipcRenderer } = require("electron");

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

// 1.1 暴露保存字幕方法
contextBridge.exposeInMainWorld("subtitleFinder", {
  selectDownloadDir: () => ipcRenderer.invoke("subtitle:select-download-dir"),
  saveSubtitle: (payload) => ipcRenderer.invoke("subtitle:save", payload),
});

logger.info("桌面保存接口暴露完成");
