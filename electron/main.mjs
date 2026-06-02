import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts"]);
const MAX_VIDEO_SCAN_COUNT = 500;

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
 * 步骤2：选择字幕保存目录
 * ================================================================================
 * 目标：
 * 1) 接收前端选择目录请求
 * 2) 弹出 Windows 文件夹选择框
 * 3) 返回用户选择的目录路径
 */
logger.info("开始绑定字幕保存目录接口...");

// 2.1 绑定目录选择接口
ipcMain.handle("subtitle:select-download-dir", async (event) => {
  logger.info("开始选择字幕保存目录...");

  // 2.2 弹出文件夹选择框
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const selected = await dialog.showOpenDialog(owner, {
    title: "选择字幕保存位置",
    properties: ["openDirectory", "createDirectory"],
  });
  if (selected.canceled || !selected.filePaths.length) {
    logger.info("选择字幕保存目录完成: 用户取消");
    return { selected: false };
  }

  // 2.3 返回选择结果
  logger.info("选择字幕保存目录完成", selected.filePaths[0]);
  return { selected: true, directory: selected.filePaths[0] };
});

logger.info("字幕保存目录接口绑定完成");

/*
 * ================================================================================
 * 步骤3：选择并扫描视频目录
 * ================================================================================
 * 目标：
 * 1) 接收前端扫描视频目录请求
 * 2) 递归读取常见视频文件
 * 3) 返回可用于搜索字幕的文件名字段
 */
logger.info("开始绑定视频目录扫描接口...");

// 3.1 绑定视频目录选择接口
ipcMain.handle("subtitle:select-video-dir", async (event) => {
  logger.info("开始选择视频目录...");

  // 3.2 弹出文件夹选择框
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const selected = await dialog.showOpenDialog(owner, {
    title: "选择视频文件夹",
    properties: ["openDirectory"],
  });
  if (selected.canceled || !selected.filePaths.length) {
    logger.info("选择视频目录完成: 用户取消");
    return { selected: false };
  }

  // 3.3 扫描视频文件
  const directory = selected.filePaths[0];
  const files = await scanVideoFiles(directory);
  logger.info("选择视频目录完成", directory, files.length);
  return { selected: true, directory, files };
});

logger.info("视频目录扫描接口绑定完成");

/*
 * ================================================================================
 * 步骤4：保存字幕文件
 * ================================================================================
 * 目标：
 * 1) 接收前端传入的下载地址、文件名和保存目录
 * 2) 拉取字幕内容
 * 3) 直接写入用户预先选择的目录
 */
logger.info("开始绑定字幕保存接口...");

// 4.1 绑定保存接口
ipcMain.handle("subtitle:save", async (event, payload = {}) => {
  logger.info("开始保存字幕文件...");

  // 4.2 读取保存参数
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const downloadUrl = String(payload.downloadUrl || "");
  const defaultFileName = path.basename(String(payload.fileName || "subtitle.srt"));
  const downloadDir = String(payload.downloadDir || "");
  if (!downloadUrl) {
    logger.info("保存字幕文件完成: 缺少下载地址");
    return { saved: false, error: "没有可下载的字幕" };
  }

  // 4.3 确认保存路径
  let targetPath = "";
  if (downloadDir) {
    await mkdir(downloadDir, { recursive: true });
    targetPath = await resolveAvailableSubtitlePath(downloadDir, defaultFileName);
  } else {
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
    targetPath = selected.filePath;
  }

  // 4.4 下载并写入文件
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    logger.info("保存字幕文件完成: 下载失败", response.status);
    return { saved: false, error: `下载失败: ${response.status}` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, buffer);

  logger.info("保存字幕文件完成", targetPath);
  return { saved: true, filePath: targetPath };
});

logger.info("字幕保存接口绑定完成");

async function resolveAvailableSubtitlePath(directory, fileName) {
  /*
   * ================================================================================
   * 步骤4：生成可用保存路径
   * ================================================================================
   * 目标：
   * 1) 使用字幕原始文件名
   * 2) 文件已存在时自动追加序号
   */
  logger.info("开始生成可用保存路径...");

  // 4.1 拆分文件名
  const safeFileName = path.basename(fileName || "subtitle.srt");
  const extension = path.extname(safeFileName);
  const baseName = path.basename(safeFileName, extension) || "subtitle";

  // 4.2 查找未占用路径
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = path.join(directory, `${baseName}${suffix}${extension || ".srt"}`);
    try {
      await access(candidate);
    } catch {
      logger.info("生成可用保存路径完成", candidate);
      return candidate;
    }
  }

  logger.info("生成可用保存路径完成: fallback");
  return path.join(directory, `${baseName}-${Date.now()}${extension || ".srt"}`);
}

async function scanVideoFiles(directory) {
  /*
   * ================================================================================
   * 步骤5：扫描视频文件
   * ================================================================================
   * 目标：
   * 1) 递归读取目录下常见视频扩展名
   * 2) 控制最多返回数量，避免大目录卡住界面
   */
  logger.info("开始扫描视频文件...");

  // 5.1 深度优先扫描目录
  const results = [];
  const stack = [directory];
  while (stack.length && results.length < MAX_VIDEO_SCAN_COUNT) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      logger.error("读取视频目录失败", current, error);
      continue;
    }

    // 5.2 收集视频文件
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      results.push({
        name: entry.name,
        path: fullPath,
        query: buildVideoSearchQuery(entry.name),
      });
      if (results.length >= MAX_VIDEO_SCAN_COUNT) break;
    }
  }

  logger.info("扫描视频文件完成", results.length);
  return results;
}

function buildVideoSearchQuery(fileName) {
  /*
   * ================================================================================
   * 步骤6：生成视频搜索词
   * ================================================================================
   * 目标：
   * 1) 移除扩展名、清晰度和编码噪声
   * 2) 保留片名、编号、季集号等有效字段
   */
  logger.info("开始生成视频搜索词...");

  // 6.1 清洗常见发布组噪声
  const baseName = path.basename(fileName, path.extname(fileName));
  const query = baseName
    .replace(/\[[^\]]*\]|\([^\)]*\)/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\b(2160p|1080p|720p|480p|4k|hdr|web[- ]?dl|webrip|bluray|brrip|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|ddp?\d?(?:\.\d)?|10bit|8bit)\b/gi, " ")
    .replace(/\b(complete|proper|repack|internal|multi|chs|cht|eng|jpn)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  logger.info("生成视频搜索词完成", query || baseName);
  return query || baseName;
}

/*
 * ================================================================================
 * 步骤7：绑定应用生命周期
 * ================================================================================
 * 目标：
 * 1) Electron 就绪后启动窗口
 * 2) 退出时关闭内置服务
 */
logger.info("开始绑定应用生命周期...");

// 5.1 Electron 就绪后启动应用
app.whenReady().then(() => {
  void bootApp();
});

// 5.2 macOS 激活兼容，Windows 下不会影响行为
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootApp();
  }
});

// 5.3 关闭全部窗口后退出
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// 5.4 退出前关闭本地服务
app.on("before-quit", () => {
  if (runtimeServer) {
    runtimeServer.close();
    runtimeServer = null;
  }
});

logger.info("应用生命周期绑定完成");
