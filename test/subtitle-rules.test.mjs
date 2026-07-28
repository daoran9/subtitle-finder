import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import SevenZip from "7z-wasm";
import {
  buildSubtitleBaseName,
  scoreArchiveSubtitle,
  scoreSubtitleCandidate,
} from "../public/subtitle-rules.js";
import { extractSubtitlePayload } from "../server.mjs";

const logger = {
  info: (...args) => console.info("[SubtitleRulesTest]", ...args),
};

/*
 * ================================================================================
 * 步骤1：验证统一字幕质量分
 * ================================================================================
 * 目标：
 * 1) 简体模式优先简体，繁体模式优先繁体
 * 2) 同集和同发布版本结果优先
 */
logger.info("开始验证统一字幕质量分...");

// 1.1 简体模式优先简体字幕
test("简体模式不会把纯繁体字幕排在简体前面", () => {
  const context = { query: "Daria S01E02", language: "zh-CN", releaseName: "Daria.S01E02.1080p.WEB-DL" };
  const simplified = scoreSubtitleCandidate({ source: "subtitlecat", title: "Daria S01E02 简体", fileName: "Daria.S01E02.chs.srt" }, context);
  const traditional = scoreSubtitleCandidate({ source: "subtitlecat", title: "Daria S01E02 繁体", fileName: "Daria.S01E02.cht.srt" }, context);
  assert.ok(simplified.qualityScore > traditional.qualityScore);
});

// 1.2 繁体模式优先繁体字幕
test("繁体模式不会把纯简体字幕排在繁体前面", () => {
  const context = { query: "Daria S01E02", language: "zh-TW", releaseName: "Daria.S01E02.1080p.WEB-DL" };
  const simplified = scoreSubtitleCandidate({ source: "subtitlecat", title: "Daria S01E02 简体", fileName: "Daria.S01E02.chs.srt" }, context);
  const traditional = scoreSubtitleCandidate({ source: "subtitlecat", title: "Daria S01E02 繁体", fileName: "Daria.S01E02.cht.srt" }, context);
  assert.ok(traditional.qualityScore > simplified.qualityScore);
});

// 1.3 同集和发布版本匹配提高质量分
test("同集同发布版本结果优先", () => {
  const context = { query: "Daria S01E02", language: "zh-CN", releaseName: "Daria.S01E02.1080p.WEB-DL" };
  const matched = scoreSubtitleCandidate({ source: "thunder", title: "Daria S01E02 简体 1080p WEB-DL", fileName: "Daria.S01E02.chs.srt" }, context);
  const wrongEpisode = scoreSubtitleCandidate({ source: "thunder", title: "Daria S01E03 简体 BluRay", fileName: "Daria.S01E03.chs.srt" }, context);
  assert.ok(matched.qualityScore > wrongEpisode.qualityScore);
  assert.ok(matched.qualityReasons.includes("集数匹配"));
  assert.ok(matched.qualityReasons.includes("版本匹配"));
});

logger.info("验证统一字幕质量分完成");

/*
 * ================================================================================
 * 步骤2：验证媒体库命名预设
 * ================================================================================
 * 目标：
 * 1) 通用、Jellyfin、Plex 使用语言后缀
 * 2) Emby 和视频同名预设保持各自格式
 */
logger.info("开始验证媒体库命名预设...");

// 2.1 验证所有预设的稳定输出
test("生成通用、Emby、Jellyfin、Plex 和视频同名文件名", () => {
  const video = "Daria.S01E02.1080p.WEB-DL.mkv";
  const commonOptions = { language: "zh-CN", source: "subtitlecat", languageProfile: { bilingual: true } };
  assert.equal(buildSubtitleBaseName(video, { ...commonOptions, preset: "media-server" }), "Daria.S01E02.1080p.WEB-DL.zh");
  assert.equal(buildSubtitleBaseName(video, { ...commonOptions, preset: "jellyfin" }), "Daria.S01E02.1080p.WEB-DL.zh");
  assert.equal(buildSubtitleBaseName(video, { ...commonOptions, preset: "plex" }), "Daria.S01E02.1080p.WEB-DL.zh");
  assert.equal(buildSubtitleBaseName(video, { ...commonOptions, preset: "emby" }), "Daria.S01E02.1080p.WEB-DL.chinese(简英,subtitlecat)");
  assert.equal(buildSubtitleBaseName(video, { ...commonOptions, preset: "same-name" }), "Daria.S01E02.1080p.WEB-DL");
});

logger.info("验证媒体库命名预设完成");

/*
 * ================================================================================
 * 步骤3：验证压缩包字幕选择
 * ================================================================================
 * 目标：
 * 1) 季集号优先于包内其他字幕
 * 2) ZIP 下载后返回真正字幕文件而不是压缩包
 */
logger.info("开始验证压缩包字幕选择...");

// 3.1 单独验证包内文件评分
test("压缩包内同集简体字幕分数最高", () => {
  const context = { language: "zh-CN", query: "Daria S01E02", releaseName: "Daria.S01E02.1080p.WEB-DL" };
  const selected = scoreArchiveSubtitle("Daria.S01E02.1080p.WEB-DL.chs.srt", context);
  const wrongEpisode = scoreArchiveSubtitle("Daria.S01E03.1080p.WEB-DL.chs.srt", context);
  const readme = scoreArchiveSubtitle("说明-readme.srt", context);
  assert.ok(selected > wrongEpisode);
  assert.ok(selected > readme);
});

// 3.2 下载 ZIP 后自动解出最高分字幕
test("ZIP 自动解出目标集字幕", async () => {
  const zip = createStoredZip([
    { name: "Daria.S01E01.chs.srt", content: "episode one" },
    { name: "Daria.S01E02.1080p.WEB-DL.chs.srt", content: "episode two" },
    { name: "readme.txt", content: "not subtitle" },
  ]);
  const selected = await extractSubtitlePayload(zip, "application/zip", "Daria.zip", "zh-CN", {
    query: "Daria S01E02",
    releaseName: "Daria.S01E02.1080p.WEB-DL",
  });
  assert.equal(selected.fileName, "Daria.S01E02.1080p.WEB-DL.chs.srt");
  assert.equal(selected.buffer.toString("utf8"), "episode two");
});

// 3.3 下载 RAR 后自动解出最高分字幕
test("RAR 自动解出目标集字幕", async () => {
  const rar = createStoredRar([
    { name: "Daria.S01E01.chs.srt", content: "episode one" },
    { name: "Daria.S01E02.1080p.WEB-DL.chs.srt", content: "episode two" },
  ]);
  const selected = await extractSubtitlePayload(rar, "application/vnd.rar", "Daria.rar", "zh-CN", {
    query: "Daria S01E02",
    releaseName: "Daria.S01E02.1080p.WEB-DL",
  });
  assert.equal(selected.fileName, "Daria.S01E02.1080p.WEB-DL.chs.srt");
  assert.equal(selected.buffer.toString("utf8"), "episode two");
});

// 3.4 下载 7z 后自动解出最高分字幕
test("7z 自动解出目标集字幕", async () => {
  const sevenZip = await createSevenZip([
    { name: "Daria.S01E01.chs.srt", content: "episode one" },
    { name: "Daria.S01E02.1080p.WEB-DL.chs.srt", content: "episode two" },
  ]);
  const selected = await extractSubtitlePayload(sevenZip, "application/x-7z-compressed", "Daria.7z", "zh-CN", {
    query: "Daria S01E02",
    releaseName: "Daria.S01E02.1080p.WEB-DL",
  });
  assert.equal(selected.fileName, "Daria.S01E02.1080p.WEB-DL.chs.srt");
  assert.equal(selected.buffer.toString("utf8"), "episode two");
});

logger.info("验证压缩包字幕选择完成");

function createStoredZip(files) {
  /*
   * ================================================================================
   * 步骤4：创建测试 ZIP
   * ================================================================================
   * 目标：
   * 1) 只生成测试需要的 STORE 格式 ZIP
   * 2) 同时写入本地文件头、中央目录和结束记录
   */
  logger.info("开始创建测试 ZIP...");

  // 4.1 生成本地文件和中央目录记录
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + content.length;
  }

  // 4.2 写入 ZIP 结束目录
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  const result = Buffer.concat([...localParts, centralDirectory, end]);

  logger.info("创建测试 ZIP 完成", result.length);
  return result;
}

function createStoredRar(files) {
  /*
   * ================================================================================
   * 步骤5：创建测试 RAR
   * ================================================================================
   * 目标：
   * 1) 生成只使用 STORE 方法的最小 RAR4 测试包
   * 2) 避免测试依赖本机 WinRAR 或提交二进制夹具
   */
  logger.info("开始创建测试 RAR...");

  // 5.1 写入 RAR4 标识和主文件头
  const signature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const mainHeader = createRarHeader(0x73, 0x0000, Buffer.alloc(6));

  // 5.2 写入未压缩文件记录
  const fileRecords = files.map((file) => {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const payload = Buffer.alloc(25 + name.length);
    payload.writeUInt32LE(content.length, 0);
    payload.writeUInt32LE(content.length, 4);
    payload[8] = 2;
    payload.writeUInt32LE(calculateCrc32(content), 9);
    payload.writeUInt32LE(0, 13);
    payload[17] = 20;
    payload[18] = 0x30;
    payload.writeUInt16LE(name.length, 19);
    payload.writeUInt32LE(0x20, 21);
    name.copy(payload, 25);
    return Buffer.concat([createRarHeader(0x74, 0x8000, payload), content]);
  });

  // 5.3 写入结束记录
  const endHeader = createRarHeader(0x7b, 0x4000, Buffer.alloc(0));
  const result = Buffer.concat([signature, mainHeader, ...fileRecords, endHeader]);
  logger.info("创建测试 RAR 完成", result.length);
  return result;
}

function createRarHeader(type, flags, payload) {
  // 5.4 按 RAR4 规则生成低 16 位 CRC 文件头
  const body = Buffer.alloc(5 + payload.length);
  body[0] = type;
  body.writeUInt16LE(flags, 1);
  body.writeUInt16LE(7 + payload.length, 3);
  payload.copy(body, 5);
  const result = Buffer.alloc(2 + body.length);
  result.writeUInt16LE(calculateCrc32(body) & 0xffff, 0);
  body.copy(result, 2);
  return result;
}

function calculateCrc32(buffer) {
  // 5.5 计算 RAR 文件头和文件内容使用的 CRC32
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createSevenZip(files) {
  /*
   * ================================================================================
   * 步骤6：创建测试 7z
   * ================================================================================
   * 目标：
   * 1) 使用应用随附的 7-Zip WASM 创建真实 7z 测试包
   * 2) 验证同一运行时创建和读取时都能保留字幕文件名
   */
  logger.info("开始创建测试 7z...");

  // 6.1 初始化独立 7-Zip WASM 文件系统
  const wasmFile = await readFile(new URL("../vendor/7zz.wasm", import.meta.url));
  const wasmBinary = wasmFile.buffer.slice(wasmFile.byteOffset, wasmFile.byteOffset + wasmFile.byteLength);
  const output = [];
  const sevenZip = await SevenZip({
    wasmBinary,
    print: (value) => output.push(String(value || "")),
    printErr: (value) => output.push(String(value || "")),
  });

  // 6.2 写入待压缩字幕文件
  const inputPaths = [];
  for (const file of files) {
    const inputPath = `/${file.name}`;
    sevenZip.FS.writeFile(inputPath, new TextEncoder().encode(file.content));
    inputPaths.push(inputPath);
  }

  // 6.3 创建并返回 7z 字节
  try {
    sevenZip.callMain(["a", "/test.7z", ...inputPaths, "-y"]);
  } catch (error) {
    if (!String(error?.message || error).includes("Program terminated with exit(0)")) throw error;
  }
  const result = Buffer.from(sevenZip.FS.readFile("/test.7z"));
  logger.info("创建测试 7z 完成", result.length);
  return result;
}
