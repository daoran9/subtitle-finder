import { app, BrowserWindow, shell } from "electron";
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
 * 步骤2：绑定应用生命周期
 * ================================================================================
 * 目标：
 * 1) Electron 就绪后启动窗口
 * 2) 退出时关闭内置服务
 */
logger.info("开始绑定应用生命周期...");

// 2.1 Electron 就绪后启动应用
app.whenReady().then(() => {
  void bootApp();
});

// 2.2 macOS 激活兼容，Windows 下不会影响行为
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootApp();
  }
});

// 2.3 关闭全部窗口后退出
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// 2.4 退出前关闭本地服务
app.on("before-quit", () => {
  if (runtimeServer) {
    runtimeServer.close();
    runtimeServer = null;
  }
});

logger.info("应用生命周期绑定完成");
