import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");

let mainWindow = null;
let runtimeServer = null;

const logger = {
  info: (...args) => console.info("[SubtitleFinderApp]", ...args),
  error: (...args) => console.error("[SubtitleFinderApp]", ...args),
};

/*
 * ================================================================================
 * 步骤1：启动桌面应用
 * ================================================================================
 * 目标：
 * 1) 启动内置本地字幕服务
 * 2) 创建 Windows 桌面窗口并加载页面
 */
async function bootApp() {
  logger.info("开始启动桌面应用...");

  // 1.1 启动内置服务
  const service = await startServer({ port: 0 });
  runtimeServer = service.server;

  // 1.2 创建主窗口
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "字幕检索台",
    icon: APP_ICON_PATH,
    backgroundColor: "#f5f4ef",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });

  // 1.3 限制外链在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 1.4 加载本地页面
  await mainWindow.loadURL(service.url);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

logger.info("桌面应用启动完成", service.url);
}

/*
 * ================================================================================
 * 步骤2：保存字幕文件
 * ================================================================================
 * 目标：
 * 1) 接收前端传入的下载地址和默认文件名
 * 2) 弹出 Windows 保存对话框
 * 3) 拉取字幕内容并写入用户选择的位置
 */
logger.info("开始绑定字幕保存接口...");

// 2.1 绑定保存接口
ipcMain.handle("subtitle:save", async (event, payload = {}) => {
  logger.info("开始保存字幕文件...");

  // 2.2 读取保存参数
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const downloadUrl = String(payload.downloadUrl || "");
  const defaultFileName = path.basename(String(payload.fileName || "subtitle.srt"));
  if (!downloadUrl) {
    logger.info("保存字幕文件完成: 缺少下载地址");
    return { saved: false, error: "没有可下载的字幕" };
  }

  // 2.3 选择保存路径
  const selected = await dialog.showSaveDialog(owner, {
    title: "保存字幕",
    defaultPath: defaultFileName,
    filters: [
      { name: "字幕文件", extensions: ["srt", "ass", "ssa", "vtt", "sub"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (selected.canceled || !selected.filePath) {
    logger.info("保存字幕文件完成: 用户取消");
    return { saved: false };
  }

  // 2.4 下载并写入文件
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    logger.info("保存字幕文件完成: 下载失败", response.status);
    return { saved: false, error: `下载失败: ${response.status}` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(selected.filePath, buffer);

  logger.info("保存字幕文件完成", selected.filePath);
  return { saved: true, filePath: selected.filePath };
});

logger.info("字幕保存接口绑定完成");

/*
 * ================================================================================
 * 步骤3：绑定应用生命周期
 * ================================================================================
 * 目标：
 * 1) Electron 就绪后启动窗口
 * 2) 退出时关闭内置服务
 */
logger.info("开始绑定应用生命周期...");

// 3.1 Electron 就绪后启动应用
app.whenReady().then(() => {
  void bootApp();
});

// 3.2 macOS 激活兼容，Windows 下不会影响行为
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootApp();
  }
});

// 3.3 关闭全部窗口后退出
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// 3.4 退出前关闭本地服务
app.on("before-quit", () => {
  if (runtimeServer) {
    runtimeServer.close();
    runtimeServer = null;
  }
});

logger.info("应用生命周期绑定完成");
