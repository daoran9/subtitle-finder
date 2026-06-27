import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts"]);
const MAX_VIDEO_SCAN_COUNT = 500;
const DEFAULT_WINDOW_STATE = { width: 1280, height: 820, maximized: false };
const MIN_WINDOW_WIDTH = 980;
const MIN_WINDOW_HEIGHT = 640;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const RUNTIME_DATA_DIR = resolveRuntimeDataDir();
const LOG_DIR_PATH = path.join(RUNTIME_DATA_DIR, "logs");
const LOG_FILE_PATH = path.join(LOG_DIR_PATH, "app.log");
const WINDOW_STATE_PATH = path.join(RUNTIME_DATA_DIR, "window-state.json");

let mainWindow = null;
let runtimeServer = null;
let runtimeService = null;

ensureDirectorySync(RUNTIME_DATA_DIR);
ensureDirectorySync(LOG_DIR_PATH);
app.setPath("userData", RUNTIME_DATA_DIR);
installConsoleFileLogger();

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
 * 3) 发生启动异常时写入日志并显示错误
 */
async function bootApp() {
  logger.info("开始启动桌面应用...");

  // 1.1 启动内置服务
  const service = await startServer({ port: 0 });
  runtimeServer = service.server;
  runtimeService = service;

  // 1.2 读取窗口状态
  const windowState = loadWindowState();

  // 1.3 创建主窗口
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
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

  // 1.4 恢复最大化状态
  if (windowState.maximized) {
    mainWindow.maximize();
  }

  // 1.5 限制外链在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isInternalNavigationUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.once("ready-to-show", () => {
    bringMainWindowToFront();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    bringMainWindowToFront();
  });

  // 1.6 加载本地页面
  await mainWindow.loadURL(service.url);
  bringMainWindowToFront();
  mainWindow.on("close", () => {
    saveWindowState(mainWindow);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  logger.info("桌面应用启动完成", service.url);
}

function bringMainWindowToFront() {
  /*
   * ================================================================================
   * 步骤1.7：显示主窗口
   * ================================================================================
   * 目标：
   * 1) 兜住 ready-to-show 事件丢失
   * 2) 二次启动时把已存在的隐藏窗口拉出来
   */
  logger.info("开始显示主窗口...");

  // 1.7.1 校验主窗口
  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.info("显示主窗口完成: 无可用窗口");
    return;
  }

  // 1.7.2 恢复并显示窗口
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  mainWindow.moveTop();
  mainWindow.setAlwaysOnTop(false);

  logger.info("显示主窗口完成");
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
 * 1) 只允许保存内置本地服务返回的字幕下载地址
 * 2) 优先使用响应头里的真实文件名
 * 3) 写入用户预先选择的目录并自动避开重名
 */
logger.info("开始绑定字幕保存接口...");

// 4.1 绑定保存接口
ipcMain.handle("subtitle:save", async (event, payload = {}) => {
  logger.info("开始保存字幕文件...");

  try {
    // 4.2 读取并校验保存参数
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const downloadUrl = String(payload.downloadUrl || "");
    const fallbackFileName = sanitizeWindowsFileName(payload.fileName || "subtitle.srt");
    const downloadDir = String(payload.downloadDir || "");
    const urlCheck = validateDownloadUrl(downloadUrl);
    if (!urlCheck.ok) {
      logger.info("保存字幕文件完成: 地址不允许", urlCheck.error);
      return { saved: false, error: urlCheck.error };
    }

    // 4.3 下载字幕字节
    const response = await fetch(urlCheck.url);
    if (!response.ok) {
      logger.info("保存字幕文件完成: 下载失败", response.status);
      let message = `下载失败: ${response.status}`;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = await response.json().catch(() => null);
        message = String(body?.detail || body?.error || message);
      }
      return { saved: false, error: message };
    }
    const dispositionFileName = parseContentDispositionFileName(response.headers.get("content-disposition") || "");
    const finalFileName = sanitizeWindowsFileName(dispositionFileName || fallbackFileName);
    const buffer = Buffer.from(await response.arrayBuffer());

    // 4.4 确认保存路径
    let targetPath = "";
    if (downloadDir) {
      if (!path.isAbsolute(downloadDir)) {
        logger.info("保存字幕文件完成: 保存目录无效");
        return { saved: false, error: "保存目录无效，请重新选择位置" };
      }
      await mkdir(downloadDir, { recursive: true });
      targetPath = await resolveAvailableSubtitlePath(downloadDir, finalFileName);
    } else {
      const selected = await dialog.showSaveDialog(owner, {
        title: "保存字幕",
        defaultPath: finalFileName,
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

    // 4.5 写入字幕文件
    await writeFile(targetPath, buffer);
    logger.info("保存字幕文件完成", targetPath);
    return { saved: true, filePath: targetPath };
  } catch (error) {
    logger.error("保存字幕文件失败", error);
    return { saved: false, error: String(error?.message || error) };
  }
});

logger.info("字幕保存接口绑定完成");

async function resolveAvailableSubtitlePath(directory, fileName) {
  /*
   * ================================================================================
   * 步骤5：生成可用保存路径
   * ================================================================================
   * 目标：
   * 1) 清理 Windows 非法文件名字符
   * 2) 文件已存在时自动追加序号
   */
  logger.info("开始生成可用保存路径...");

  // 5.1 拆分安全文件名
  const safeFileName = sanitizeWindowsFileName(fileName || "subtitle.srt");
  const extension = path.extname(safeFileName);
  const baseName = path.basename(safeFileName, extension) || "subtitle";

  // 5.2 查找未占用路径
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
   * 步骤6：扫描视频文件
   * ================================================================================
   * 目标：
   * 1) 递归读取目录下常见视频扩展名
   * 2) 控制最多返回数量，避免大目录卡住界面
   */
  logger.info("开始扫描视频文件...");

  // 6.1 深度优先扫描目录
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

    // 6.2 收集视频文件
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
   * 步骤7：生成视频搜索词
   * ================================================================================
   * 目标：
   * 1) 移除扩展名、清晰度和编码噪声
   * 2) 保留片名、编号、季集号等有效字段
   */
  logger.info("开始生成视频搜索词...");

  // 7.1 清洗常见发布组噪声
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

function configureApplicationMenu() {
  /*
   * ================================================================================
   * 步骤8：配置桌面菜单
   * ================================================================================
   * 目标：
   * 1) 提供打开数据目录和日志文件的排障入口
   * 2) 保留重载和退出等基础窗口操作
   */
  logger.info("开始配置桌面菜单...");

  // 8.1 生成菜单模板
  const template = [
    {
      label: "字幕检索台",
      submenu: [
        {
          label: "打开数据目录",
          click: () => {
            shell.openPath(RUNTIME_DATA_DIR);
          },
        },
        {
          label: "打开日志文件",
          click: () => {
            shell.openPath(LOG_FILE_PATH);
          },
        },
        { type: "separator" },
        {
          label: "重新加载",
          accelerator: "Ctrl+R",
          click: () => {
            mainWindow?.reload();
          },
        },
        { type: "separator" },
        { label: "退出", role: "quit" },
      ],
    },
  ];

  // 8.2 应用菜单
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  logger.info("桌面菜单配置完成");
}

function loadWindowState() {
  /*
   * ================================================================================
   * 步骤9：读取窗口状态
   * ================================================================================
   * 目标：
   * 1) 从便携数据目录读取上次窗口大小
   * 2) 异常时回退默认尺寸
   */
  logger.info("开始读取窗口状态...");

  // 9.1 读取窗口状态文件
  try {
    const raw = readFileSync(WINDOW_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const width = clampNumber(parsed.width, MIN_WINDOW_WIDTH, 2200, DEFAULT_WINDOW_STATE.width);
    const height = clampNumber(parsed.height, MIN_WINDOW_HEIGHT, 1600, DEFAULT_WINDOW_STATE.height);
    const maximized = Boolean(parsed.maximized);
    logger.info("读取窗口状态完成", width, height, maximized);
    return { width, height, maximized };
  } catch {
    logger.info("读取窗口状态完成: 默认");
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function saveWindowState(window) {
  /*
   * ================================================================================
   * 步骤10：保存窗口状态
   * ================================================================================
   * 目标：
   * 1) 关闭窗口前记录尺寸
   * 2) 下次启动恢复到相同大小
   */
  logger.info("开始保存窗口状态...");

  // 10.1 校验窗口对象
  if (!window || window.isDestroyed()) {
    logger.info("保存窗口状态完成: 无窗口");
    return;
  }

  // 10.2 写入窗口状态文件
  try {
    const bounds = window.getNormalBounds();
    const payload = {
      width: clampNumber(bounds.width, MIN_WINDOW_WIDTH, 2200, DEFAULT_WINDOW_STATE.width),
      height: clampNumber(bounds.height, MIN_WINDOW_HEIGHT, 1600, DEFAULT_WINDOW_STATE.height),
      maximized: window.isMaximized(),
    };
    writeFileSync(WINDOW_STATE_PATH, JSON.stringify(payload, null, 2));
    logger.info("保存窗口状态完成", payload);
  } catch (error) {
    logger.error("保存窗口状态失败", error);
  }
}

function validateDownloadUrl(value) {
  /*
   * ================================================================================
   * 步骤11：校验下载地址
   * ================================================================================
   * 目标：
   * 1) 只允许前端请求内置服务的下载接口
   * 2) 阻止主进程被滥用为任意 URL 下载器
   */
  logger.info("开始校验下载地址...");

  // 11.1 解析 URL
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    logger.info("校验下载地址完成: 格式错误");
    return { ok: false, error: "下载地址无效，请重新预览后下载" };
  }

  // 11.2 限定协议、主机、端口和路径
  const expectedPort = String(runtimeService?.port || "");
  const actualPort = parsed.port || (parsed.protocol === "http:" ? "80" : "");
  const expectedHost = runtimeService?.host || "127.0.0.1";
  const valid = parsed.protocol === "http:" && parsed.hostname === expectedHost && actualPort === expectedPort && parsed.pathname === "/api/download";
  if (!valid) {
    logger.info("校验下载地址完成: 不允许", parsed.href);
    return { ok: false, error: "下载地址不属于本地字幕服务，请重新搜索" };
  }

  logger.info("校验下载地址完成");
  return { ok: true, url: parsed.href };
}

function parseContentDispositionFileName(header) {
  /*
   * ================================================================================
   * 步骤12：解析响应文件名
   * ================================================================================
   * 目标：
   * 1) 优先识别 filename* 的 UTF-8 文件名
   * 2) 兼容普通 filename 字段
   */
  logger.info("开始解析响应文件名...");

  // 12.1 解析 RFC 5987 文件名
  const encodedMatch = String(header || "").match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (encodedMatch) {
    try {
      const decoded = decodeURIComponent(encodedMatch[1].trim().replace(/^"|"$/g, ""));
      logger.info("解析响应文件名完成", decoded);
      return decoded;
    } catch {
      logger.info("解析响应文件名失败: encoded");
    }
  }

  // 12.2 解析普通文件名
  const quotedMatch = String(header || "").match(/filename="?([^";]+)"?/i);
  const fileName = quotedMatch ? quotedMatch[1].trim() : "";
  logger.info("解析响应文件名完成", fileName || "empty");
  return fileName;
}

function sanitizeWindowsFileName(value) {
  /*
   * ================================================================================
   * 步骤13：清理 Windows 文件名
   * ================================================================================
   * 目标：
   * 1) 去掉 Windows 禁止字符和控制字符
   * 2) 避免保留设备名和过长文件名
   */
  logger.info("开始清理 Windows 文件名...");

  // 13.1 归一化基础文件名
  const rawName = path.basename(String(value || "subtitle.srt").replace(/[\\/]+/g, path.sep));
  let safeName = rawName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!safeName) safeName = "subtitle.srt";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(safeName)) {
    safeName = `_${safeName}`;
  }

  // 13.2 控制文件名长度和扩展名
  const extension = path.extname(safeName) || ".srt";
  const baseName = path.basename(safeName, extension).slice(0, 160).replace(/[. ]+$/g, "") || "subtitle";
  const finalName = `${baseName}${extension}`;
  logger.info("清理 Windows 文件名完成", finalName);
  return finalName;
}

function isInternalNavigationUrl(value) {
  /*
   * ================================================================================
   * 步骤14：判断内部导航地址
   * ================================================================================
   * 目标：
   * 1) 允许窗口停留在内置本地页面
   * 2) 外部地址统一交给系统浏览器
   */
  logger.info("开始判断内部导航地址...");

  // 14.1 比对本地服务 origin
  try {
    const current = new URL(value);
    const internal = runtimeService ? new URL(runtimeService.url) : null;
    const result = Boolean(internal && current.origin === internal.origin);
    logger.info("判断内部导航地址完成", result);
    return result;
  } catch {
    logger.info("判断内部导航地址完成: false");
    return false;
  }
}

function handleStartupFailure(error) {
  /*
   * ================================================================================
   * 步骤15：处理启动失败
   * ================================================================================
   * 目标：
   * 1) 写入启动错误日志
   * 2) 用系统弹窗告诉用户日志位置
   */
  logger.error("桌面应用启动失败", error);

  // 15.1 显示错误弹窗
  dialog.showErrorBox(
    "字幕检索台启动失败",
    `程序没有正常启动。\n\n原因：${String(error?.message || error)}\n\n日志：${LOG_FILE_PATH}`
  );

  // 15.2 退出当前进程
  app.quit();
}

function bindAppLifecycle() {
  /*
   * ================================================================================
   * 步骤16：绑定应用生命周期
   * ================================================================================
   * 目标：
   * 1) Electron 就绪后启动窗口
   * 2) 处理重复打开、激活、退出和服务关闭
   */
  logger.info("开始绑定应用生命周期...");

  // 16.1 Electron 就绪后启动应用
  app.whenReady().then(async () => {
    configureApplicationMenu();
    await bootApp();
  }).catch(handleStartupFailure);

  // 16.2 重复打开时聚焦已有窗口
  app.on("second-instance", () => {
    if (!mainWindow) return;
    bringMainWindowToFront();
  });

  // 16.3 macOS 激活兼容，Windows 下不会影响行为
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      bootApp().catch(handleStartupFailure);
    } else {
      bringMainWindowToFront();
    }
  });

  // 16.4 关闭全部窗口后退出
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // 16.5 退出前关闭本地服务
  app.on("before-quit", () => {
    if (runtimeServer) {
      runtimeServer.close();
      runtimeServer = null;
    }
  });

  logger.info("应用生命周期绑定完成");
}

function resolveRuntimeDataDir() {
  /*
   * ================================================================================
   * 步骤17：确定运行数据目录
   * ================================================================================
   * 目标：
   * 1) 便携版优先写到 exe 同级目录
   * 2) 开发环境写到项目目录，避免默认落到 C 盘用户目录
   */

  // 17.0 优先使用显式指定的数据目录
  const overrideDir = String(process.env.SUBTITLE_FINDER_DATA_DIR || "").trim();
  if (overrideDir && isWritableDirectoryCandidate(overrideDir)) return overrideDir;

  // 17.1 计算首选目录
  const appRoot = app.isPackaged ? path.dirname(app.getPath("exe")) : path.join(__dirname, "..");
  const preferredDir = path.join(appRoot, app.isPackaged ? "SubtitleFinderData" : ".subtitle-finder-data");
  if (isWritableDirectoryCandidate(preferredDir)) return preferredDir;

  // 17.2 权限不足时回退 Electron 默认目录
  return path.join(app.getPath("userData"), "SubtitleFinderData");
}

function isWritableDirectoryCandidate(directory) {
  /*
   * ================================================================================
   * 步骤18：检测目录是否可写
   * ================================================================================
   * 目标：
   * 1) 创建候选数据目录
   * 2) 写入测试文件确认权限
   */

  // 18.1 创建并测试目录
  try {
    mkdirSync(directory, { recursive: true });
    const probePath = path.join(directory, ".write-test");
    writeFileSync(probePath, String(Date.now()));
    rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function ensureDirectorySync(directory) {
  /*
   * ================================================================================
   * 步骤19：确保目录存在
   * ================================================================================
   * 目标：
   * 1) 创建日志和数据目录
   * 2) 忽略已经存在的正常情况
   */

  // 19.1 创建目录
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // 启动日志还没有完成初始化，保持静默并让后续流程报错。
  }
}

function installConsoleFileLogger() {
  /*
   * ================================================================================
   * 步骤20：安装文件日志
   * ================================================================================
   * 目标：
   * 1) 将主进程和内置服务日志写入本地文件
   * 2) 保留原始控制台输出，方便开发调试
   */

  // 20.1 保存原始控制台方法
  const originalConsole = {
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  // 20.2 包装日志方法
  console.info = (...args) => {
    appendLogLine("INFO", args);
    safeOriginalConsoleWrite(originalConsole.info, args);
  };
  console.warn = (...args) => {
    appendLogLine("WARN", args);
    safeOriginalConsoleWrite(originalConsole.warn, args);
  };
  console.error = (...args) => {
    appendLogLine("ERROR", args);
    safeOriginalConsoleWrite(originalConsole.error, args);
  };
}

function safeOriginalConsoleWrite(writer, args) {
  /*
   * ================================================================================
   * 步骤20.3：安全写回原始控制台
   * ================================================================================
   * 目标：
   * 1) 保留开发期标准输出
   * 2) 标准输出管道断开时不影响主进程
   */

  // 20.3.1 兜住已断开的 stdout/stderr
  try {
    writer(...args);
  } catch (error) {
    const message = String(error && error.message ? error.message : error || "");
    const code = String(error && error.code ? error.code : "");
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || /broken pipe/i.test(message)) {
      return;
    }
    throw error;
  }
}

function appendLogLine(level, args) {
  /*
   * ================================================================================
   * 步骤21：写入单行日志
   * ================================================================================
   * 目标：
   * 1) 追加一行带时间的日志
   * 2) 文件过大时轮转到 app.old.log
   */

  // 21.1 轮转日志文件
  try {
    rotateLogFileIfNeeded();
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(formatLogValue).join(" ")}\n`;
    appendFileSync(LOG_FILE_PATH, line, "utf8");
  } catch {
    // 文件日志不能影响程序启动。
  }
}

function rotateLogFileIfNeeded() {
  /*
   * ================================================================================
   * 步骤22：轮转日志文件
   * ================================================================================
   * 目标：
   * 1) 控制日志体积
   * 2) 保留最近一次旧日志
   */

  // 22.1 超出大小后改名
  try {
    const fileStat = statSync(LOG_FILE_PATH);
    if (fileStat.size <= LOG_MAX_BYTES) return;
    renameSync(LOG_FILE_PATH, path.join(LOG_DIR_PATH, "app.old.log"));
  } catch {
    // 日志文件不存在时不用处理。
  }
}

function formatLogValue(value) {
  // 21.2 格式化日志参数
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampNumber(value, min, max, fallback) {
  // 9.2 限制数值范围
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

const shouldUseSingleInstanceLock = process.env.SUBTITLE_FINDER_DISABLE_SINGLE_INSTANCE !== "1";
const gotSingleInstanceLock = shouldUseSingleInstanceLock ? app.requestSingleInstanceLock() : true;
if (!gotSingleInstanceLock) {
  logger.info("已有实例运行，退出当前进程");
  app.quit();
} else {
  bindAppLifecycle();
}
