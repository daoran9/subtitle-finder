import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mediaInfoFactory from "mediainfo.js";
import { parseNfoMetadata } from "../lib/nfo-metadata.mjs";
import {
  buildSyncedSubtitleFileName,
  parseFfsubsyncProgress,
  parseFfsubsyncSummary,
} from "../lib/subtitle-sync.mjs";
import { validateSubtitleText } from "../lib/subtitle-tools.mjs";
import {
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  analyzeMediaFile,
  compareMediaEntries,
  findExistingSubtitles,
} from "../public/media-library.js";
import { createScanExclusionMatcher, parseScanExclusionRules } from "../public/scan-rules.js";
import { startServer } from "../server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ICON_PATH = path.join(__dirname, "..", "build", "icon.ico");
const MAX_VIDEO_SCAN_COUNT = 500;
const MEDIA_SCAN_CONCURRENCY = 2;
const DEFAULT_WINDOW_STATE = { width: 1280, height: 820, maximized: false };
const MIN_WINDOW_WIDTH = 980;
const MIN_WINDOW_HEIGHT = 640;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const RUNTIME_DATA_DIR = resolveRuntimeDataDir();
const LOG_DIR_PATH = path.join(RUNTIME_DATA_DIR, "logs");
const LOG_FILE_PATH = path.join(LOG_DIR_PATH, "app.log");
const WINDOW_STATE_PATH = path.join(RUNTIME_DATA_DIR, "window-state.json");
const CONTEXT_MENU_COMMAND = "SubtitleFinder.SearchSubtitles";
const LEGACY_CONTEXT_MENU_ROOT = `HKCU\\Software\\Classes\\SystemFileAssociations\\video\\shell\\${CONTEXT_MENU_COMMAND}`;
const MAX_SYNC_SUBTITLE_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_LOG_BYTES = 2 * 1024 * 1024;
const execFileAsync = promisify(execFile);

let mainWindow = null;
let runtimeServer = null;
let runtimeService = null;
let pendingLaunchTarget = "";
let activeSubtitleSyncJob = null;

ensureDirectorySync(RUNTIME_DATA_DIR);
ensureDirectorySync(LOG_DIR_PATH);
app.setPath("userData", RUNTIME_DATA_DIR);
installConsoleFileLogger();

const logger = {
  info: (...args) => console.info("[SubtitleFinderApp]", ...args),
  error: (...args) => console.error("[SubtitleFinderApp]", ...args),
};

// 启动日志完成初始化后再解析资源管理器参数。
pendingLaunchTarget = extractLaunchTarget(process.argv);

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
  const service = await startServer({ port: 0, dataDir: RUNTIME_DATA_DIR });
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
ipcMain.handle("subtitle:select-video-dir", async (event, payload = {}) => {
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
  const excludeRules = parseScanExclusionRules(payload.excludeRules || []);
  const files = await scanVideoFiles(directory, { excludeRules });
  logger.info("选择视频目录完成", directory, files.length);
  return { selected: true, directory, files };
});

// 3.4 绑定单视频选择接口
ipcMain.handle("subtitle:select-video-file", async (event) => {
  logger.info("开始选择单个视频...");

  // 3.4.1 弹出视频文件选择框
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const selected = await dialog.showOpenDialog(owner, {
    title: "选择视频文件",
    properties: ["openFile"],
    filters: [
      { name: "视频文件", extensions: [...VIDEO_EXTENSIONS].map((extension) => extension.slice(1)) },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (selected.canceled || !selected.filePaths.length) {
    logger.info("选择单个视频完成: 用户取消");
    return { selected: false };
  }

  // 3.4.2 复用单目标载入逻辑
  const result = await loadLaunchTarget(selected.filePaths[0]);
  logger.info("选择单个视频完成", selected.filePaths[0]);
  return result;
});

// 3.5 接收预加载层解析后的拖入路径
ipcMain.handle("subtitle:load-video-path", async (_event, payload = {}) => {
  logger.info("开始载入拖入视频...");

  // 3.5.1 只接受主进程校验后的本地视频
  const targetPath = normalizeLaunchTargetCandidate(payload.path);
  if (!targetPath || !VIDEO_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
    logger.info("载入拖入视频完成: unsupported");
    return { selected: false, error: "请拖入支持的视频文件" };
  }
  const result = await loadLaunchTarget(targetPath);
  logger.info("载入拖入视频完成", targetPath);
  return result;
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
    const preferredBaseName = String(payload.preferredBaseName || "").trim();
    const targetVideoPath = String(payload.targetVideoPath || "").trim();
    const downloadDir = targetVideoPath ? path.dirname(targetVideoPath) : String(payload.downloadDir || "");
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
    const sourceFileName = sanitizeWindowsFileName(dispositionFileName || fallbackFileName);
    const finalFileName = preferredBaseName
      ? buildPreferredSubtitleFileName(sourceFileName, preferredBaseName)
      : sourceFileName;
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

/*
 * ================================================================================
 * 步骤4.8：读取本地视频匹配信息
 * ================================================================================
 * 目标：
 * 1) 按需计算 Shooter MD5 和迅雷 CID
 * 2) 批量任务开始前重新检测内封字幕
 */
logger.info("开始绑定视频匹配信息接口...");

// 4.8.1 绑定单个视频分析接口
ipcMain.handle("subtitle:inspect-video", async (_event, payload = {}) => {
  const videoPath = String(payload.videoPath || "").trim();
  if (!videoPath || !path.isAbsolute(videoPath) || !VIDEO_EXTENSIONS.has(path.extname(videoPath).toLowerCase())) {
    return { ok: false, error: "视频路径无效" };
  }
  try {
    const fileStat = await stat(videoPath);
    if (!fileStat.isFile()) return { ok: false, error: "视频文件不存在" };
    const [fingerprints, embedded] = await Promise.all([
      computeVideoFingerprints(videoPath, fileStat.size),
      inspectEmbeddedSubtitleTracks(videoPath),
    ]);
    return { ok: true, ...fingerprints, ...embedded };
  } catch (error) {
    logger.error("读取视频匹配信息失败", videoPath, error);
    return { ok: false, error: String(error?.message || error) };
  }
});

logger.info("视频匹配信息接口绑定完成");

/*
 * ================================================================================
 * 步骤4.85：绑定 Windows 字幕自动校时
 * ================================================================================
 * 目标：
 * 1) 用当前预览字幕和当前本地视频启动独立 ffsubsync 任务
 * 2) 发送进度、完成、低质量拒绝和取消状态
 * 3) 只在校时成功后生成独立 synced SRT
 */
logger.info("开始绑定字幕自动校时接口...");

// 4.85.1 启动单个自动校时任务
ipcMain.handle("subtitle:start-sync", async (event, payload = {}) => {
  logger.info("开始启动字幕自动校时...");

  if (process.platform !== "win32") {
    logger.info("启动字幕自动校时完成: unsupported");
    return { started: false, error: "自动校时目前仅支持 Windows" };
  }
  if (activeSubtitleSyncJob && !activeSubtitleSyncJob.settled) {
    logger.info("启动字幕自动校时完成: busy");
    return { started: false, error: "已有字幕正在校时" };
  }

  let pendingJobDirectory = "";
  try {
    // 4.85.2 校验视频、字幕和目标目录
    const videoPath = String(payload.videoPath || "").trim();
    const subtitleText = String(payload.subtitleText || "");
    const sourceFileName = sanitizeWindowsFileName(payload.fileName || "subtitle.srt");
    const preferredBaseName = sanitizeOptionalWindowsBaseName(payload.preferredBaseName || "");
    const downloadDir = String(payload.downloadDir || "").trim();
    if (!videoPath || !path.isAbsolute(videoPath) || !VIDEO_EXTENSIONS.has(path.extname(videoPath).toLowerCase())) {
      throw new Error("请先选择有效的本地视频");
    }
    const videoStat = await stat(videoPath);
    if (!videoStat.isFile()) throw new Error("本地视频不存在");
    if (!downloadDir || !path.isAbsolute(downloadDir)) throw new Error("请先选择字幕保存位置");
    await mkdir(downloadDir, { recursive: true });
    const subtitleBytes = Buffer.byteLength(subtitleText, "utf8");
    if (!subtitleText.trim()) throw new Error("当前预览没有可校时的字幕内容");
    if (subtitleBytes > MAX_SYNC_SUBTITLE_BYTES) throw new Error("字幕文件过大，无法自动校时");
    const validation = validateSubtitleText(subtitleText, { fileName: sourceFileName });
    if (!validation.valid) throw new Error(validation.message || "字幕结构无效");

    // 4.85.3 准备工具和本次任务文件
    const tools = await resolveSubtitleSyncTools();
    const jobId = randomUUID();
    const jobDirectory = await mkdtemp(path.join(downloadDir, ".subtitle-finder-sync-"));
    pendingJobDirectory = jobDirectory;
    const inputExtension = getSubtitleSyncInputExtension(validation.format, sourceFileName);
    const inputPath = path.join(jobDirectory, `input${inputExtension}`);
    const finalFileName = sanitizeWindowsFileName(buildSyncedSubtitleFileName(sourceFileName, preferredBaseName));
    const temporaryOutputPath = path.join(jobDirectory, "output.srt");
    await writeFile(inputPath, subtitleText.replace(/^\uFEFF/, ""), "utf8");

    // 4.85.4 启动固定版本 ffsubsync，并立即把任务标识返回前端
    const args = [
      videoPath,
      "-i", inputPath,
      "-o", temporaryOutputPath,
      "--encoding", "utf-8",
      "--output-encoding", "utf-8",
      "--ffmpeg-path", tools.ffmpegDirectory,
      "--skip-sync-on-low-quality",
      "--gui-mode",
      "--vlc-mode",
    ];
    const child = spawn(tools.ffsubsyncPath, args, {
      cwd: jobDirectory,
      env: {
        ...process.env,
        PATH: `${tools.ffmpegDirectory}${path.delimiter}${process.env.PATH || ""}`,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = {
      id: jobId,
      child,
      sender: event.sender,
      jobDirectory,
      temporaryOutputPath,
      downloadDir,
      finalFileName,
      log: "",
      stdoutBuffer: "",
      stderrBuffer: "",
      canceled: false,
      settled: false,
      lastProgress: -1,
      lastStage: "",
    };
    activeSubtitleSyncJob = job;
    pendingJobDirectory = "";
    monitorSubtitleSyncJob(job);
    sendSubtitleSyncEvent(job, { status: "running", progress: 2, message: "准备视频和字幕" });

    logger.info("启动字幕自动校时完成", jobId);
    return { started: true, jobId };
  } catch (error) {
    if (pendingJobDirectory) {
      await rm(pendingJobDirectory, { recursive: true, force: true }).catch(() => {});
    }
    logger.error("启动字幕自动校时失败", error);
    return { started: false, error: String(error?.message || error) };
  }
});

// 4.85.5 取消当前自动校时及其 FFmpeg 子进程
ipcMain.handle("subtitle:cancel-sync", async (_event, payload = {}) => {
  logger.info("开始取消字幕自动校时...");

  const jobId = String(payload.jobId || "").trim();
  const job = activeSubtitleSyncJob;
  if (!job || job.settled || (jobId && job.id !== jobId)) {
    logger.info("取消字幕自动校时完成: idle");
    return { canceled: false };
  }
  job.canceled = true;
  sendSubtitleSyncEvent(job, { status: "canceling", progress: job.lastProgress, message: "正在取消" });
  await terminateSubtitleSyncProcess(job);

  logger.info("取消字幕自动校时完成", job.id);
  return { canceled: true };
});

logger.info("字幕自动校时接口绑定完成");

/*
 * ================================================================================
 * 步骤4.9：绑定 Windows 右键菜单和启动目标
 * ================================================================================
 * 目标：
 * 1) 允许用户在设置中注册或移除当前用户右键菜单
 * 2) 将资源管理器传入的视频或文件夹交给前端
 */
logger.info("开始绑定 Windows 右键菜单接口...");

// 4.9.1 返回右键菜单状态
ipcMain.handle("subtitle:get-context-menu-state", async () => {
  if (process.platform !== "win32") return { supported: false, enabled: false };
  return { supported: true, enabled: await isContextMenuRegistered() };
});

// 4.9.2 注册或移除右键菜单
ipcMain.handle("subtitle:set-context-menu-state", async (_event, payload = {}) => {
  if (process.platform !== "win32") return { ok: false, enabled: false, error: "当前系统不支持 Windows 右键菜单" };
  try {
    const enabled = Boolean(payload.enabled);
    await setContextMenuRegistered(enabled);
    return { ok: true, enabled: await isContextMenuRegistered() };
  } catch (error) {
    logger.error("设置 Windows 右键菜单失败", error);
    return { ok: false, enabled: false, error: String(error?.message || error) };
  }
});

// 4.9.3 消费当前待处理路径
ipcMain.handle("subtitle:consume-launch-target", async () => {
  const target = pendingLaunchTarget;
  pendingLaunchTarget = "";
  if (!target) return { selected: false };
  return loadLaunchTarget(target);
});

logger.info("Windows 右键菜单接口绑定完成");

/*
 * ================================================================================
 * 步骤4.10：绑定第三方许可入口
 * ================================================================================
 * 目标：
 * 1) 开发环境打开仓库中的许可清单
 * 2) 发布包打开 resources/licenses 中的离线许可清单
 */
logger.info("开始绑定第三方许可入口...");

// 4.10.1 打开当前运行环境对应的许可清单
ipcMain.handle("subtitle:open-third-party-licenses", async () => {
  logger.info("开始打开第三方许可清单...");
  const licensePath = app.isPackaged
    ? path.join(process.resourcesPath, "licenses", "THIRD_PARTY_LICENSES.md")
    : path.join(__dirname, "..", "vendor", "THIRD_PARTY_LICENSES.md");
  const error = await shell.openPath(licensePath);
  if (error) {
    logger.error("打开第三方许可清单失败", error);
    return { opened: false, error };
  }
  logger.info("打开第三方许可清单完成", licensePath);
  return { opened: true };
});

logger.info("第三方许可入口绑定完成");

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

async function resolveSubtitleSyncTools() {
  /*
   * ================================================================================
   * 步骤5.5：定位自动校时工具
   * ================================================================================
   * 目标：
   * 1) 开发环境读取项目 vendor 目录
   * 2) 打包环境读取 resources 下的独立工具目录
   */
  logger.info("开始定位字幕自动校时工具...");

  // 5.5.1 计算并核对三个必需文件
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "sync-tools")
    : path.join(__dirname, "..", "vendor", "sync-tools", "win32-x64");
  const ffsubsyncPath = path.join(root, "ffsubsync.exe");
  const ffmpegDirectory = path.join(root, "ffmpeg-bin");
  await Promise.all([
    access(ffsubsyncPath),
    access(path.join(ffmpegDirectory, "ffmpeg.exe")),
    access(path.join(ffmpegDirectory, "ffprobe.exe")),
  ]).catch(() => {
    throw new Error("自动校时组件缺失，请重新安装完整版本");
  });

  logger.info("定位字幕自动校时工具完成", root);
  return { ffsubsyncPath, ffmpegDirectory };
}

function monitorSubtitleSyncJob(job) {
  /*
   * ================================================================================
   * 步骤5.6：监听自动校时进程
   * ================================================================================
   * 目标：
   * 1) 合并标准输出和错误输出供质量判断
   * 2) 持续解析进度并在进程结束后统一验收结果
   */
  logger.info("开始监听字幕自动校时进程...", job.id);

  // 5.6.1 绑定两个输出流
  bindSubtitleSyncOutput(job, job.child.stdout, "stdoutBuffer");
  bindSubtitleSyncOutput(job, job.child.stderr, "stderrBuffer");

  // 5.6.2 记录启动错误并等待进程关闭
  job.child.once("error", (error) => {
    job.processError = error;
  });
  job.child.once("close", (exitCode, signal) => {
    void finalizeSubtitleSyncJob(job, exitCode, signal).catch((error) => {
      logger.error("验收字幕自动校时结果失败", error);
    });
  });

  logger.info("监听字幕自动校时进程完成: 已绑定", job.id);
}

function bindSubtitleSyncOutput(job, stream, bufferKey) {
  // 5.6.3 按行处理 ffsubsync 输出，兼容 CR 进度行
  if (!stream) return;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const value = String(chunk || "");
    job.log = `${job.log}${value}`.slice(-MAX_SYNC_LOG_BYTES);
    const combined = `${job[bufferKey] || ""}${value}`;
    const lines = combined.split(/[\r\n]+/);
    job[bufferKey] = lines.pop() || "";
    for (const line of lines) updateSubtitleSyncProgress(job, line);
  });
}

function updateSubtitleSyncProgress(job, value) {
  // 5.6.4 将音轨读取百分比映射到完整校时流程
  const line = stripTerminalFormatting(value).trim();
  if (!line) return;
  const rawProgress = /^\d{1,3}%?$/.test(line) ? parseFfsubsyncProgress(line) : null;
  if (rawProgress != null) {
    sendSubtitleSyncProgress(job, Math.min(85, 5 + Math.round(rawProgress * 0.8)), "分析视频音轨");
    return;
  }
  if (/extracting speech|checking video for subtitles/i.test(line)) {
    sendSubtitleSyncProgress(job, 5, "分析视频音轨");
  } else if (/total of speech segments|computing alignments|score:/i.test(line)) {
    sendSubtitleSyncProgress(job, 88, "计算时间偏移");
  } else if (/writing (?:output|original)/i.test(line)) {
    sendSubtitleSyncProgress(job, 95, "生成校时字幕");
  }
}

function sendSubtitleSyncProgress(job, progress, message) {
  // 5.6.5 相同进度和阶段不重复发送
  const normalizedProgress = Math.max(0, Math.min(99, Math.round(Number(progress) || 0)));
  if (normalizedProgress === job.lastProgress && message === job.lastStage) return;
  job.lastProgress = normalizedProgress;
  job.lastStage = message;
  sendSubtitleSyncEvent(job, { status: "running", progress: normalizedProgress, message });
}

async function finalizeSubtitleSyncJob(job, exitCode, signal) {
  /*
   * ================================================================================
   * 步骤5.7：验收自动校时结果
   * ================================================================================
   * 目标：
   * 1) 同时检查取消状态、退出码、低质量日志和输出文件
   * 2) 成功时原子改名，其他情况删除临时输出
   */
  logger.info("开始验收字幕自动校时结果...", job.id, exitCode, signal || "");

  // 5.7.1 保证每个任务只结算一次
  if (job.settled) {
    logger.info("验收字幕自动校时结果完成: already settled", job.id);
    return;
  }
  job.settled = true;
  const normalizedLog = stripTerminalFormatting(`${job.log}\n${job.stdoutBuffer || ""}\n${job.stderrBuffer || ""}`);
  const summary = parseFfsubsyncSummary(normalizedLog);

  try {
    // 5.7.2 取消和低质量结果都不保留输出
    if (job.canceled) {
      await rm(job.temporaryOutputPath, { force: true });
      sendSubtitleSyncEvent(job, { status: "canceled", progress: job.lastProgress, message: "已取消" });
      logger.info("验收字幕自动校时结果完成: canceled", job.id);
      return;
    }
    if (summary.lowQuality) {
      await rm(job.temporaryOutputPath, { force: true });
      sendSubtitleSyncEvent(job, {
        status: "rejected",
        progress: 100,
        message: "匹配质量不足，未保存",
        summary,
      });
      logger.info("验收字幕自动校时结果完成: low quality", job.id);
      return;
    }

    // 5.7.3 检查进程和输出字幕结构
    if (job.processError) throw job.processError;
    if (exitCode !== 0) throw new Error(buildSubtitleSyncFailureMessage(normalizedLog, exitCode));
    await access(job.temporaryOutputPath).catch(() => {
      throw new Error("自动校时没有生成字幕文件");
    });
    const outputBuffer = await readFile(job.temporaryOutputPath);
    const outputText = outputBuffer.toString("utf8");
    const validation = validateSubtitleText(outputText, { fileName: "output.srt" });
    if (!validation.valid) throw new Error(validation.message || "校时结果不是有效字幕");

    // 5.7.4 只在全部检查通过后写入用户目录
    const finalPath = await writeAvailableSubtitleFile(job.downloadDir, job.finalFileName, outputBuffer);
    sendSubtitleSyncEvent(job, {
      status: "completed",
      progress: 100,
      message: "校时完成",
      filePath: finalPath,
      summary,
    });
    logger.info("验收字幕自动校时结果完成", finalPath);
  } catch (error) {
    await rm(job.temporaryOutputPath, { force: true }).catch(() => {});
    sendSubtitleSyncEvent(job, {
      status: "failed",
      progress: job.lastProgress,
      message: String(error?.message || error),
    });
    logger.error("验收字幕自动校时结果失败", error);
  } finally {
    // 5.7.5 清理任务目录并释放任务槽位
    await rm(job.jobDirectory, { recursive: true, force: true }).catch(() => {});
    if (activeSubtitleSyncJob?.id === job.id) activeSubtitleSyncJob = null;
  }
}

async function writeAvailableSubtitleFile(directory, fileName, buffer) {
  /*
   * ================================================================================
   * 步骤5.75：独占写入校时字幕
   * ================================================================================
   * 目标：
   * 1) 成功验收前不在保存目录暴露半成品
   * 2) 文件同名时原子选择下一个序号，不覆盖已有字幕
   */
  logger.info("开始独占写入校时字幕...");

  // 5.75.1 逐个尝试未占用文件名
  const safeFileName = sanitizeWindowsFileName(fileName || "subtitle.synced.srt");
  const extension = path.extname(safeFileName) || ".srt";
  const baseName = path.basename(safeFileName, extension) || "subtitle.synced";
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = path.join(directory, `${baseName}${suffix}${extension}`);
    let handle = null;
    try {
      handle = await open(candidate, "wx");
      await handle.writeFile(buffer);
      await handle.close();
      logger.info("独占写入校时字幕完成", candidate);
      return candidate;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === "EEXIST") continue;
      await rm(candidate, { force: true }).catch(() => {});
      throw error;
    }
  }

  throw new Error("保存目录中同名字幕过多，请清理后重试");
}

async function terminateSubtitleSyncProcess(job) {
  /*
   * ================================================================================
   * 步骤5.8：终止自动校时进程树
   * ================================================================================
   * 目标：
   * 1) Windows 同时终止 ffsubsync 和它启动的 FFmpeg
   * 2) 进程已经退出时保持幂等
   */
  logger.info("开始终止字幕自动校时进程...", job.id);

  // 5.8.1 优先使用 Windows 进程树终止
  const pid = Number(job.child?.pid || 0);
  if (pid > 0 && process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10000,
    }).catch(() => {
      job.child?.kill();
    });
  } else if (pid > 0) {
    job.child?.kill("SIGTERM");
  }

  logger.info("终止字幕自动校时进程完成", job.id);
}

function sendSubtitleSyncEvent(job, payload) {
  // 5.8.2 只向启动任务的有效页面发送状态
  if (!job.sender || job.sender.isDestroyed()) return;
  job.sender.send("subtitle:sync-event", { jobId: job.id, ...payload });
}

function getSubtitleSyncInputExtension(format, sourceFileName) {
  // 5.8.3 用已校验格式选择 ffsubsync 输入解析器
  const normalized = String(format || "").toUpperCase();
  if (normalized === "ASS") return ".ass";
  if (normalized === "SSA") return ".ssa";
  if (normalized === "VTT") return ".vtt";
  if (normalized === "MICRODVD SUB") return ".sub";
  const sourceExtension = path.extname(String(sourceFileName || "")).toLowerCase();
  return sourceExtension === ".srt" ? sourceExtension : ".srt";
}

function sanitizeOptionalWindowsBaseName(value) {
  // 5.8.4 空主文件名保持为空，非空时复用 Windows 文件名规则
  const raw = String(value || "").trim();
  if (!raw) return "";
  const safe = sanitizeWindowsFileName(`${raw}.srt`);
  return path.basename(safe, path.extname(safe));
}

function stripTerminalFormatting(value) {
  // 5.8.5 清理 Rich 和终端进度控制序列
  return String(value || "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function buildSubtitleSyncFailureMessage(log, exitCode) {
  // 5.8.6 把常见底层错误转换成可操作提示
  if (/Unable to detect speech|total of speech segments:\s*0/i.test(log)) return "无法从视频音轨识别出可用于校时的对白";
  if (/ffmpeg unavailable|ffprobe unavailable|FileNotFoundError|WinError 2/i.test(log)) return "自动校时组件不完整，请重新安装";
  if (/unsupported format|failed to parse|SRTParseError/i.test(log)) return "当前字幕格式无法用于自动校时";
  return `自动校时失败（代码 ${Number.isInteger(exitCode) ? exitCode : "未知"}）`;
}

async function scanVideoFiles(directory, options = {}) {
  /*
   * ================================================================================
   * 步骤6：扫描视频文件
   * ================================================================================
   * 目标：
   * 1) 递归读取目录下常见视频扩展名
   * 2) 解析电影、剧集、季号和集号
   * 3) 检查视频同目录是否已有匹配字幕
   * 4) 控制最多返回数量，避免大目录卡住界面
   */
  logger.info("开始扫描视频文件...");

  // 6.1 深度优先扫描目录
  const results = [];
  const requestedVideoPath = String(options.targetPath || "").trim();
  const requestedVideoKey = requestedVideoPath ? path.resolve(requestedVideoPath).toLowerCase() : "";
  const shouldExcludePath = createScanExclusionMatcher(requestedVideoKey ? [] : options.excludeRules || []);
  const stack = [{
    directory,
    parentNames: [path.basename(directory), path.basename(path.dirname(directory))],
    inheritedNfoMetadata: null,
  }];
  while (stack.length && results.length < MAX_VIDEO_SCAN_COUNT) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      logger.error("读取视频目录失败", current.directory, error);
      continue;
    }

    // 6.2 收集当前目录字幕和 NFO，供视频逐项匹配
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    const subtitleNames = entries
      .filter((entry) => entry.isFile() && SUBTITLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name);
    const nfoFiles = await readDirectoryNfoFiles(current.directory, entries);
    const seriesMetadata = mergeNfoMetadata(current.inheritedNfoMetadata, nfoFiles.get("tvshow.nfo"));
    const directoryMetadata = mergeNfoMetadata(seriesMetadata, nfoFiles.get("movie.nfo"));

    // 6.3 收集视频文件并解析媒体身份
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      const relativePath = path.relative(directory, fullPath);
      if (entry.isDirectory()) {
        if (requestedVideoKey) continue;
        if (shouldExcludePath(relativePath)) continue;
        stack.push({
          directory: fullPath,
          parentNames: [entry.name, ...current.parentNames],
          inheritedNfoMetadata: seriesMetadata,
        });
        continue;
      }
      if (!entry.isFile() || !VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (requestedVideoKey && path.resolve(fullPath).toLowerCase() !== requestedVideoKey) continue;
      if (!requestedVideoKey && shouldExcludePath(relativePath)) continue;
      const sameNameNfo = nfoFiles.get(`${path.basename(entry.name, path.extname(entry.name)).toLowerCase()}.nfo`);
      const nfoMetadata = mergeNfoMetadata(directoryMetadata, sameNameNfo);
      const media = analyzeMediaFile(entry.name, { parentNames: current.parentNames, nfoMetadata });
      const existingSubtitles = findExistingSubtitles(entry.name, subtitleNames, { parentNames: current.parentNames });
      results.push({
        name: entry.name,
        path: fullPath,
        relativePath,
        ...media,
        hasSubtitle: existingSubtitles.length > 0,
        existingSubtitleCount: existingSubtitles.length,
        existingSubtitles,
        nfoMetadata: media.nfoMetadata || null,
      });
      if (results.length >= MAX_VIDEO_SCAN_COUNT) break;
    }
  }

  // 6.4 限流检测内封字幕
  await mapWithConcurrency(results, MEDIA_SCAN_CONCURRENCY, async (item) => {
    const embedded = await inspectEmbeddedSubtitleTracks(item.path);
    item.embeddedSubtitleStatus = embedded.embeddedSubtitleStatus;
    item.embeddedSubtitleCount = embedded.embeddedSubtitleCount;
    item.embeddedSubtitles = embedded.embeddedSubtitles;
    item.hasEmbeddedSubtitle = embedded.embeddedSubtitleCount > 0;
    item.hasSubtitle = item.hasSubtitle || item.hasEmbeddedSubtitle;
  });

  // 6.5 缺字幕优先，同系列按季集号排序
  results.sort(compareMediaEntries);
  logger.info("扫描视频文件完成", results.length);
  return results;
}

async function readDirectoryNfoFiles(directory, entries) {
  /*
   * ================================================================================
   * 步骤6.5：读取目录 NFO 文件
   * ================================================================================
   * 目标：
   * 1) 读取同名、movie.nfo 和 tvshow.nfo
   * 2) 限制文件大小，损坏 NFO 不阻止视频扫描
   */
  logger.info("开始读取目录 NFO 文件...", directory);

  // 6.5.1 遍历当前目录的小型 NFO 文件
  const metadata = new Map();
  const nfoEntries = entries.filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".nfo");
  for (const entry of nfoEntries) {
    try {
      const filePath = path.join(directory, entry.name);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > 1024 * 1024) continue;
      const parsed = parseNfoMetadata(await readFile(filePath, "utf8"));
      if (parsed) metadata.set(entry.name.toLowerCase(), { ...parsed, sourceFile: entry.name });
    } catch (error) {
      logger.error("读取 NFO 文件失败", entry.name, error);
    }
  }

  logger.info("读取目录 NFO 文件完成", metadata.size);
  return metadata;
}

function mergeNfoMetadata(...values) {
  // 6.5.2 后面的单集或同名 NFO 覆盖通用元数据，并合并标题别名
  const available = values.filter((value) => value && typeof value === "object");
  if (!available.length) return null;
  const aliases = [];
  for (const value of available) {
    if (value.mediaType === "tvshow" && value.title && !value.showTitle) aliases.push(value.title);
    aliases.push(...(Array.isArray(value.aliases) ? value.aliases : []));
  }
  const result = Object.assign({}, ...available);
  const series = available.findLast ? available.findLast((value) => value.mediaType === "tvshow") : [...available].reverse().find((value) => value.mediaType === "tvshow");
  if (!result.showTitle && series?.title && result.mediaType !== "tvshow") result.showTitle = series.title;
  result.aliases = [...new Set(aliases.filter(Boolean))];
  return result;
}

async function computeVideoFingerprints(videoPath, fileSize) {
  /*
   * ================================================================================
   * 步骤6.6：计算视频文件指纹
   * ================================================================================
   * 目标：
   * 1) 复现 Shooter 四段 MD5 算法
   * 2) 复现迅雷三段 SHA1 CID 算法
   */
  logger.info("开始计算视频文件指纹...", videoPath);

  // 6.6.1 校验最小文件大小并打开文件
  if (fileSize < 0xf000) throw new Error("视频文件过小，无法计算字幕指纹");
  const fileHandle = await open(videoPath, "r");
  try {
    // 6.6.2 读取 Shooter 四个 4 KiB 样本
    const shooterPositions = [
      4 * 1024,
      Math.floor(fileSize / 3 * 2),
      Math.floor(fileSize / 3),
      fileSize - 8 * 1024,
    ];
    const shooterHashes = [];
    for (const position of shooterPositions) {
      const sample = await readFileSample(fileHandle, position, 4 * 1024);
      shooterHashes.push(createHash("md5").update(sample).digest("hex"));
    }

    // 6.6.3 读取迅雷三个 20 KiB 样本并连续计算 SHA1
    const thunderHash = createHash("sha1");
    const thunderSampleSize = 0x5000;
    for (const position of [0, Math.floor(fileSize / 3), fileSize - thunderSampleSize]) {
      thunderHash.update(await readFileSample(fileHandle, position, thunderSampleSize));
    }
    const result = {
      shooterHash: shooterHashes.join(";"),
      thunderCid: thunderHash.digest("hex").toUpperCase(),
      fingerprintStatus: "done",
    };

    logger.info("计算视频文件指纹完成", path.basename(videoPath));
    return result;
  } finally {
    await fileHandle.close();
  }
}

async function readFileSample(fileHandle, position, length) {
  // 6.6.4 从指定位置读取固定长度样本
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fileHandle.read(buffer, 0, length, Math.max(0, position));
  if (bytesRead !== length) throw new Error("视频样本读取不完整");
  return buffer;
}

async function inspectEmbeddedSubtitleTracks(videoPath) {
  /*
   * ================================================================================
   * 步骤6.7：检测桌面视频内封字幕
   * ================================================================================
   * 目标：
   * 1) 用随应用打包的 MediaInfo WASM 读取字幕轨
   * 2) 检测失败时标为未知，不误判成无字幕
   */
  logger.info("开始检测桌面视频内封字幕...", videoPath);

  // 6.7.1 打开视频并创建 MediaInfo 实例
  let fileHandle = null;
  let mediaInfo = null;
  try {
    fileHandle = await open(videoPath, "r");
    const fileStat = await fileHandle.stat();
    mediaInfo = await mediaInfoFactory({
      format: "object",
      locateFile: (fileName) => path.join(__dirname, "..", "node_modules", "mediainfo.js", "dist", fileName),
    });

    // 6.7.2 按 MediaInfo 要求读取文件片段
    const result = await mediaInfo.analyzeData(
      () => fileStat.size,
      async (size, offset) => {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await fileHandle.read(buffer, 0, size, offset);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      }
    );

    // 6.7.3 整理文字轨信息
    const tracks = (Array.isArray(result?.media?.track) ? result.media.track : [])
      .filter((track) => track?.["@type"] === "Text")
      .map((track) => ({
        language: track.Language_String || track.Language || "未知",
        title: track.Title || "",
        format: track.Format || "",
        default: String(track.Default || "").toLowerCase() === "yes",
        forced: String(track.Forced || "").toLowerCase() === "yes",
      }));
    const response = {
      embeddedSubtitleStatus: "done",
      embeddedSubtitleCount: tracks.length,
      embeddedSubtitles: tracks,
    };

    logger.info("检测桌面视频内封字幕完成", tracks.length);
    return response;
  } catch (error) {
    logger.error("检测桌面视频内封字幕失败", videoPath, error);
    return {
      embeddedSubtitleStatus: "unknown",
      embeddedSubtitleCount: 0,
      embeddedSubtitles: [],
      embeddedSubtitleError: String(error?.message || error),
    };
  } finally {
    if (mediaInfo) mediaInfo.close();
    if (fileHandle) await fileHandle.close();
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  // 6.8 以固定并发处理扫描文件，避免磁盘随机读取拥塞
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
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

async function loadLaunchTarget(targetPath) {
  /*
   * ================================================================================
   * 步骤8.3：载入 Windows 右键目标
   * ================================================================================
   * 目标：
   * 1) 视频文件只分析所在目录并选中该视频
   * 2) 文件夹复用现有递归扫描结果
   */
  logger.info("开始载入 Windows 右键目标...", targetPath);

  // 8.3.1 校验绝对路径和目标类型
  if (!targetPath || !path.isAbsolute(targetPath)) return { selected: false, error: "目标路径无效" };
  const targetStat = await stat(targetPath);
  let directory = targetPath;
  let videoPath = "";
  if (targetStat.isFile()) {
    if (!VIDEO_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) return { selected: false, error: "请选择视频文件" };
    directory = path.dirname(targetPath);
    videoPath = targetPath;
  } else if (!targetStat.isDirectory()) {
    return { selected: false, error: "目标不是视频或文件夹" };
  }

  // 8.3.2 扫描目录并保留目标视频
  const files = await scanVideoFiles(directory, { targetPath: videoPath });
  logger.info("载入 Windows 右键目标完成", files.length);
  return { selected: true, directory, label: directory, videoPath, files };
}

function extractLaunchTarget(argv) {
  /*
   * ================================================================================
   * 步骤8.4：解析启动参数中的本地目标
   * ================================================================================
   * 目标：
   * 1) 忽略 Electron、ASAR 和命令行开关
   * 2) 只接受现存的绝对视频或文件夹路径
   */
  logger.info("开始解析启动目标...");

  // 8.4.1 只读取本应用注册表命令写入的显式参数
  const values = Array.isArray(argv) ? argv : [];
  const markerIndex = values.findIndex((value) => String(value || "").trim() === "--subtitle-target");
  const candidate = markerIndex >= 0
    ? String(values[markerIndex + 1] || "").trim().replace(/^"|"$/g, "")
    : "";
  const target = normalizeLaunchTargetCandidate(candidate);
  if (target) {
    logger.info("解析启动目标完成", target);
    return target;
  }

  logger.info("解析启动目标完成: empty");
  return "";
}

function normalizeLaunchTargetCandidate(value) {
  /*
   * ================================================================================
   * 步骤8.5：校验 Windows 右键启动目标
   * ================================================================================
   * 目标：
   * 1) 命令行和单实例 additionalData 共用同一套路径校验
   * 2) 只接受现存目录或已支持的视频文件
   */
  logger.info("开始校验 Windows 右键启动目标...");

  // 8.5.1 规范字符串并拒绝相对路径
  const candidate = String(value || "").trim().replace(/^"|"$/g, "");
  if (!candidate || !path.isAbsolute(candidate)) {
    logger.info("校验 Windows 右键启动目标完成: invalid");
    return "";
  }

  // 8.5.2 检查目录或视频文件是否仍然存在
  try {
    const candidateStat = statSync(candidate);
    const accepted = candidateStat.isDirectory()
      || (candidateStat.isFile() && VIDEO_EXTENSIONS.has(path.extname(candidate).toLowerCase()));
    logger.info("校验 Windows 右键启动目标完成", accepted ? candidate : "unsupported");
    return accepted ? candidate : "";
  } catch {
    logger.info("校验 Windows 右键启动目标完成: missing");
    return "";
  }
}

async function isContextMenuRegistered() {
  /*
   * ================================================================================
   * 步骤8.6：核对当前用户 Windows 右键菜单
   * ================================================================================
   * 目标：
   * 1) 检查所有支持的视频扩展名和文件夹菜单
   * 2) 命令必须完整指向当前稳定可执行文件
   */
  logger.info("开始核对 Windows 右键菜单...");

  // 8.6.1 生成当前版本应有的完整命令
  const expectedCommand = buildContextMenuLaunchCommand();
  const roots = getContextMenuRoots();

  // 8.6.2 逐项核对，缺失或路径过期都视为未注册
  for (const root of roots) {
    const command = await readRegistryDefaultValue(`${root}\\command`);
    if (!registryCommandsEqual(command, expectedCommand)) {
      logger.info("核对 Windows 右键菜单完成: incomplete", root);
      return false;
    }
  }

  logger.info("核对 Windows 右键菜单完成: enabled");
  return true;
}

async function setContextMenuRegistered(enabled) {
  /*
   * ================================================================================
   * 步骤8.6：设置当前用户 Windows 右键菜单
   * ================================================================================
   * 目标：
   * 1) 给支持的视频扩展名和文件夹增加“查找字幕”
   * 2) 便携版始终注册外层 EXE，安装版注册安装目录 EXE
   * 3) 关闭时只删除本应用创建的注册表项
   */
  logger.info("开始设置 Windows 右键菜单...", enabled);

  // 8.6.1 计算稳定启动器、完整命令和注册位置
  const executable = resolveContextMenuExecutable();
  const command = buildContextMenuLaunchCommand();
  const roots = getContextMenuRoots();

  // 8.6.2 清理旧版泛型视频项，避免菜单重复和临时路径残留
  await deleteRegistryTree(LEGACY_CONTEXT_MENU_ROOT);

  // 8.6.3 写入或移除各扩展名和文件夹注册项
  for (const root of roots) {
    if (!enabled) {
      await deleteRegistryTree(root);
      continue;
    }
    await execFileAsync("reg.exe", ["add", root, "/ve", "/d", "查找字幕", "/f"], { windowsHide: true });
    await execFileAsync("reg.exe", ["add", root, "/v", "Icon", "/d", executable, "/f"], { windowsHide: true });
    await execFileAsync("reg.exe", ["add", `${root}\\command`, "/ve", "/d", command, "/f"], { windowsHide: true });
  }

  logger.info("设置 Windows 右键菜单完成", enabled);
}

async function migrateContextMenuRegistration() {
  /*
   * ================================================================================
   * 步骤8.7：迁移旧版 Windows 右键菜单
   * ================================================================================
   * 目标：
   * 1) 只迁移用户已经启用过的右键菜单
   * 2) 把临时解压路径和泛型视频项替换为新版稳定注册项
   */
  logger.info("开始迁移 Windows 右键菜单...");

  // 8.7.1 非 Windows、开发环境或从未注册时不改系统状态
  if (process.platform !== "win32" || !app.isPackaged) {
    logger.info("迁移 Windows 右键菜单完成: unsupported");
    return;
  }
  const registeredRoots = [...getContextMenuRoots(), LEGACY_CONTEXT_MENU_ROOT];
  const hasExistingRegistration = (await Promise.all(
    registeredRoots.map((root) => registryKeyExists(root))
  )).some(Boolean);
  if (!hasExistingRegistration) {
    logger.info("迁移 Windows 右键菜单完成: disabled");
    return;
  }

  // 8.7.2 完整注册已经有效时只清理旧泛型项
  if (await isContextMenuRegistered()) {
    await deleteRegistryTree(LEGACY_CONTEXT_MENU_ROOT);
    logger.info("迁移 Windows 右键菜单完成: current");
    return;
  }

  // 8.7.3 重写全部菜单，修复便携版临时路径和扩展名覆盖
  try {
    await setContextMenuRegistered(true);
    logger.info("迁移 Windows 右键菜单完成: updated");
  } catch (error) {
    logger.error("迁移 Windows 右键菜单失败", error);
  }
}

function getContextMenuRoots() {
  // 8.7.4 按应用支持的视频扩展名生成稳定注册位置
  const videoRoots = [...VIDEO_EXTENSIONS].map(
    (extension) => `HKCU\\Software\\Classes\\SystemFileAssociations\\${extension}\\shell\\${CONTEXT_MENU_COMMAND}`
  );
  return [
    ...videoRoots,
    `HKCU\\Software\\Classes\\Directory\\shell\\${CONTEXT_MENU_COMMAND}`,
  ];
}

function resolveContextMenuExecutable() {
  // 8.7.5 便携版使用 electron-builder 注入的外层启动器路径
  const portableExecutable = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (app.isPackaged && path.isAbsolute(portableExecutable)) return path.normalize(portableExecutable);
  return path.normalize(process.execPath);
}

function resolvePortableExecutableDir() {
  // 8.7.6 便携版数据跟随外层启动器，避免写入临时解压目录
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (app.isPackaged && path.isAbsolute(portableDir)) return path.normalize(portableDir);
  const portableExecutable = String(process.env.PORTABLE_EXECUTABLE_FILE || "").trim();
  if (app.isPackaged && path.isAbsolute(portableExecutable)) return path.dirname(path.normalize(portableExecutable));
  return "";
}

function buildContextMenuLaunchCommand() {
  // 8.7.7 开发环境补充项目入口，打包版本只启动稳定 EXE
  const executable = resolveContextMenuExecutable();
  const launchPrefix = app.isPackaged
    ? `\"${executable}\"`
    : `\"${executable}\" \"${path.join(__dirname, "..")}\"`;
  return `${launchPrefix} --subtitle-target \"%1\"`;
}

async function readRegistryDefaultValue(key) {
  // 8.7.8 读取注册表默认值，不存在时返回空字符串
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/ve"], { windowsHide: true });
    const line = String(stdout || "").split(/\r?\n/).find((value) => /REG_(?:SZ|EXPAND_SZ)/i.test(value));
    return line ? line.replace(/^.*?REG_(?:SZ|EXPAND_SZ)\s+/i, "").trim() : "";
  } catch {
    return "";
  }
}

async function registryKeyExists(key) {
  // 8.7.9 查询本应用注册项是否存在
  try {
    await execFileAsync("reg.exe", ["query", key], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function deleteRegistryTree(key) {
  // 8.7.10 删除本应用独占注册项，键不存在时视为完成
  await execFileAsync("reg.exe", ["delete", key, "/f"], { windowsHide: true }).catch(() => {});
}

function registryCommandsEqual(actual, expected) {
  // 8.7.11 Windows 路径忽略大小写，保留路径内部的原始空格
  const normalize = (value) => String(value || "").trim().toLowerCase();
  return normalize(actual) === normalize(expected);
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

function buildPreferredSubtitleFileName(sourceFileName, preferredBaseName) {
  /*
   * ================================================================================
   * 步骤12.3：生成视频同名字幕文件名
   * ================================================================================
   * 目标：
   * 1) 保留字幕源返回的真实扩展名
   * 2) 用“视频主文件名.语言”替换来源站文件名
   * 3) 继续复用 Windows 文件名安全校验
   */
  logger.info("开始生成视频同名字幕文件名...");

  // 12.3.1 读取来源扩展名
  const safeSourceName = sanitizeWindowsFileName(sourceFileName || "subtitle.srt");
  const extension = path.extname(safeSourceName) || ".srt";

  // 12.3.2 组合并清理首选文件名
  const finalName = sanitizeWindowsFileName(`${preferredBaseName}${extension}`);
  logger.info("生成视频同名字幕文件名完成", finalName);
  return finalName;
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
    await migrateContextMenuRegistration();
    configureApplicationMenu();
    await bootApp();
  }).catch(handleStartupFailure);

  // 16.2 重复打开时聚焦已有窗口
  app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
    // 16.2.1 优先读取单实例锁传来的目标，旧版 Electron 再回退命令行
    const additionalTarget = normalizeLaunchTargetCandidate(additionalData?.launchTarget);
    const target = additionalTarget || extractLaunchTarget(commandLine);
    if (target) {
      pendingLaunchTarget = target;
      mainWindow?.webContents.send("subtitle:launch-target-available");
    }
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
    if (activeSubtitleSyncJob && !activeSubtitleSyncJob.settled) {
      activeSubtitleSyncJob.canceled = true;
      void terminateSubtitleSyncProcess(activeSubtitleSyncJob);
    }
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

  // 17.1 便携版使用外层启动器目录，安装版使用已安装程序目录
  const portableDir = resolvePortableExecutableDir();
  const appRoot = app.isPackaged ? portableDir || path.dirname(app.getPath("exe")) : path.join(__dirname, "..");
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
const singleInstanceData = pendingLaunchTarget ? { launchTarget: pendingLaunchTarget } : {};
const gotSingleInstanceLock = shouldUseSingleInstanceLock ? app.requestSingleInstanceLock(singleInstanceData) : true;
if (!gotSingleInstanceLock) {
  logger.info("已有实例运行，退出当前进程");
  app.quit();
} else {
  bindAppLifecycle();
}
