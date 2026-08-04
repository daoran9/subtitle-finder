import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import extractZip from "extract-zip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const cacheDirectory = path.join(projectRoot, ".cache", "sync-tools");
const outputDirectory = path.join(projectRoot, "vendor", "sync-tools", "win32-x64");
const temporaryDirectory = path.join(cacheDirectory, "extract");

const FFSUBSYNC = {
  version: "0.5.1",
  url: "https://github.com/smacke/ffsubsync/releases/download/0.5.1/windows-x86_64.zip",
  sha256: "fa97d6923bb3444e61fb2d01ff649089f733798e01939bd5fa4c25a409323683",
  archiveName: "ffsubsync-0.5.1-windows-x86_64.zip",
};
const FFMPEG = {
  version: "n7.1.5-10-g2aefd64d48",
  buildTag: "autobuild-2026-07-27-14-00",
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-27-14-00/ffmpeg-n7.1.5-10-g2aefd64d48-win64-lgpl-shared-7.1.zip",
  sha256: "d2a6df844a674c04780478f33224134a29d1b54152f8d8314b82e02eccb02edd",
  archiveName: "ffmpeg-n7.1.5-10-g2aefd64d48-win64-lgpl-shared-7.1.zip",
  sourceArchiveUrl: "https://github.com/FFmpeg/FFmpeg/archive/2aefd64d4840a8555016a59dd7ac826974a307fc.tar.gz",
  buildScriptsArchiveUrl: "https://github.com/BtbN/FFmpeg-Builds/archive/8c736b2d6fe5da2a10a8896d01e53bfb0ca4f665.tar.gz",
};
const FFMPEG_GPLV3 = {
  url: "https://raw.githubusercontent.com/FFmpeg/FFmpeg/2aefd64d4840a8555016a59dd7ac826974a307fc/COPYING.GPLv3",
  sha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
  fileName: "FFmpeg-GPLv3.txt",
};
const SYNC_TOOL_LAYOUT_VERSION = 3;

const logger = {
  info: (...args) => console.info("[prepare-sync-tools]", ...args),
};

/*
 * ================================================================================
 * 步骤1：准备固定版本自动校时工具
 * ================================================================================
 * 目标：
 * 1) 下载并校验官方 ffsubsync 和 LGPL FFmpeg 构建
 * 2) 只保留 Windows 运行所需文件和版本清单
 */
logger.info("开始准备自动校时工具...");

// 1.1 已存在完整且版本匹配的运行目录时直接复用
if (await isPrepared()) {
  logger.info("准备自动校时工具完成: 已存在");
  process.exit(0);
}

// 1.2 下载并校验两个固定归档
await mkdir(cacheDirectory, { recursive: true });
const ffsubsyncArchive = await downloadVerifiedArchive(FFSUBSYNC);
const ffmpegArchive = await downloadVerifiedArchive(FFMPEG);
const ffmpegGplv3Path = await downloadVerifiedFile(FFMPEG_GPLV3);

// 1.3 解压到项目磁盘临时目录
await rm(temporaryDirectory, { recursive: true, force: true });
await mkdir(path.join(temporaryDirectory, "ffsubsync"), { recursive: true });
await mkdir(path.join(temporaryDirectory, "ffmpeg"), { recursive: true });
await extractZip(ffsubsyncArchive, { dir: path.join(temporaryDirectory, "ffsubsync") });
await extractZip(ffmpegArchive, { dir: path.join(temporaryDirectory, "ffmpeg") });

// 1.4 收集 ffsubsync、FFmpeg 可执行文件和共享库
const ffsubsyncPath = await findFile(temporaryDirectory, "ffsubsync.exe");
const ffmpegPath = await findFile(temporaryDirectory, "ffmpeg.exe");
const ffprobePath = await findFile(temporaryDirectory, "ffprobe.exe");
if (!ffsubsyncPath || !ffmpegPath || !ffprobePath) {
  throw new Error("自动校时归档缺少必需的可执行文件");
}
const ffmpegBinDirectory = path.dirname(ffmpegPath);
const runtimeFiles = (await readdir(ffmpegBinDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && (
    /\.dll$/i.test(entry.name) || /^(?:ffmpeg|ffprobe)\.exe$/i.test(entry.name)
  ))
  .map((entry) => path.join(ffmpegBinDirectory, entry.name));
const ffmpegLicensePath = await findFile(path.join(temporaryDirectory, "ffmpeg"), "LICENSE.txt");
if (!ffmpegLicensePath) throw new Error("FFmpeg 归档缺少许可证文件");

// 1.5 原子替换运行目录并写入版本清单
const stagingDirectory = `${outputDirectory}.staging`;
await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(path.join(stagingDirectory, "ffmpeg-bin"), { recursive: true });
await copyFile(ffsubsyncPath, path.join(stagingDirectory, "ffsubsync.exe"));
await copyFile(ffmpegLicensePath, path.join(stagingDirectory, "FFmpeg-LICENSE.txt"));
await copyFile(ffmpegGplv3Path, path.join(stagingDirectory, FFMPEG_GPLV3.fileName));
for (const sourcePath of runtimeFiles) {
  await copyFile(sourcePath, path.join(stagingDirectory, "ffmpeg-bin", path.basename(sourcePath)));
}
await writeFile(path.join(stagingDirectory, "versions.json"), JSON.stringify({
  layoutVersion: SYNC_TOOL_LAYOUT_VERSION,
  ffsubsync: {
    version: FFSUBSYNC.version,
    source: FFSUBSYNC.url,
    sha256: FFSUBSYNC.sha256,
  },
  ffmpeg: {
    version: FFMPEG.version,
    buildTag: FFMPEG.buildTag,
    source: FFMPEG.url,
    sourceArchive: FFMPEG.sourceArchiveUrl,
    buildScriptsArchive: FFMPEG.buildScriptsArchiveUrl,
    sha256: FFMPEG.sha256,
    variant: "win64-lgpl-shared-7.1",
    gplv3LicenseSha256: FFMPEG_GPLV3.sha256,
  },
}, null, 2), "utf8");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.dirname(outputDirectory), { recursive: true });
await import("node:fs/promises").then(({ rename }) => rename(stagingDirectory, outputDirectory));
await rm(temporaryDirectory, { recursive: true, force: true });

logger.info("准备自动校时工具完成", runtimeFiles.length + 1);

async function isPrepared() {
  /*
   * ================================================================================
   * 步骤2：核对已准备工具
   * ================================================================================
   * 目标：
   * 1) 检查三个入口文件和版本清单
   * 2) 版本变化时强制重新准备
   */
  logger.info("开始核对自动校时工具...");

  // 2.1 核对文件和版本
  try {
    const [, , , gplv3Valid] = await Promise.all([
      access(path.join(outputDirectory, "ffsubsync.exe")),
      access(path.join(outputDirectory, "ffmpeg-bin", "ffmpeg.exe")),
      access(path.join(outputDirectory, "ffmpeg-bin", "ffprobe.exe")),
      fileHasHash(path.join(outputDirectory, FFMPEG_GPLV3.fileName), FFMPEG_GPLV3.sha256),
    ]);
    const manifest = JSON.parse(await readFile(path.join(outputDirectory, "versions.json"), "utf8"));
    const prepared = (
      manifest?.layoutVersion === SYNC_TOOL_LAYOUT_VERSION &&
      manifest?.ffsubsync?.sha256 === FFSUBSYNC.sha256 &&
      manifest?.ffmpeg?.sha256 === FFMPEG.sha256 &&
      gplv3Valid
    );
    logger.info("核对自动校时工具完成", prepared ? "ready" : "version mismatch");
    return prepared;
  } catch {
    logger.info("核对自动校时工具完成: missing");
    return false;
  }
}

async function downloadVerifiedFile(definition) {
  /*
   * ================================================================================
   * 步骤3.5：下载并校验许可正文
   * ================================================================================
   * 目标：
   * 1) 固定到 FFmpeg 对应源码提交中的 GPLv3 正文
   * 2) 哈希不匹配时拒绝打包，避免许可文件静默漂移
   */
  logger.info("开始下载自动校时许可正文...", definition.fileName);

  // 3.5.1 复用项目内哈希正确的许可缓存
  const filePath = path.join(cacheDirectory, definition.fileName);
  if (await fileHasHash(filePath, definition.sha256)) {
    logger.info("下载自动校时许可正文完成: cache", definition.fileName);
    return filePath;
  }

  // 3.5.2 下载、校验并原子替换缓存文件
  await rm(filePath, { force: true });
  const temporaryPath = `${filePath}.download`;
  await rm(temporaryPath, { force: true });
  const response = await fetch(definition.url, {
    headers: { "user-agent": "SubtitleFinder-license-fetch/1.6.1" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error(`下载失败: ${response.status} ${definition.fileName}`);
  await pipeline(response.body, createWriteStream(temporaryPath));
  if (!(await fileHasHash(temporaryPath, definition.sha256))) {
    await rm(temporaryPath, { force: true });
    throw new Error(`SHA-256 校验失败: ${definition.fileName}`);
  }
  await import("node:fs/promises").then(({ rename }) => rename(temporaryPath, filePath));

  logger.info("下载自动校时许可正文完成", definition.fileName);
  return filePath;
}

async function downloadVerifiedArchive(definition) {
  /*
   * ================================================================================
   * 步骤3：下载并校验归档
   * ================================================================================
   * 目标：
   * 1) 复用哈希正确的项目内缓存
   * 2) 下载后校验 SHA-256，拒绝漂移或损坏文件
   */
  logger.info("开始下载自动校时归档...", definition.archiveName);

  // 3.1 检查缓存，不匹配时重新下载
  const archivePath = path.join(cacheDirectory, definition.archiveName);
  if (await fileHasHash(archivePath, definition.sha256)) {
    logger.info("下载自动校时归档完成: cache", definition.archiveName);
    return archivePath;
  }
  await rm(archivePath, { force: true });
  const temporaryPath = `${archivePath}.download`;
  await rm(temporaryPath, { force: true });
  const response = await fetch(definition.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`下载失败: ${response.status} ${definition.archiveName}`);
  await pipeline(response.body, createWriteStream(temporaryPath));
  if (!(await fileHasHash(temporaryPath, definition.sha256))) {
    await rm(temporaryPath, { force: true });
    throw new Error(`SHA-256 校验失败: ${definition.archiveName}`);
  }
  await import("node:fs/promises").then(({ rename }) => rename(temporaryPath, archivePath));

  logger.info("下载自动校时归档完成", definition.archiveName);
  return archivePath;
}

async function fileHasHash(filePath, expectedHash) {
  // 3.2 小归档和大归档都用流式读取计算哈希
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size === 0) return false;
    const hash = createHash("sha256");
    const handle = await import("node:fs").then(({ createReadStream }) => createReadStream(filePath));
    for await (const chunk of handle) hash.update(chunk);
    return hash.digest("hex") === expectedHash.toLowerCase();
  } catch {
    return false;
  }
}

async function findFile(directory, fileName) {
  // 1.6 递归查找归档中版本化目录里的目标文件
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return fullPath;
    }
  }
  return "";
}
