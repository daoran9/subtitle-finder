import assert from "node:assert/strict";
import test from "node:test";
import { decodeSubtitle, normalizeSubtitlePayload } from "../server.mjs";

const logger = {
  info: (...args) => console.info("[SubtitleEncodingTest]", ...args),
};

const SRT_PREFIX = "1\r\n00:00:01,000 --> 00:00:03,000\r\n";

/*
 * ================================================================================
 * 步骤1：验证字幕编码兼容性
 * ================================================================================
 * 目标：
 * 1) 正确识别 GB18030、UTF-16 和双重错误编码
 * 2) 保证下载字节统一为 UTF-8，供 Android 播放器直接读取
 */
logger.info("开始验证字幕编码兼容性...");

// 1.1 GB18030 中文字幕必须优先于 UTF-8 替换符结果
test("GB18030 字幕可解码并保存为 UTF-8", () => {
  const buffer = Buffer.concat([
    Buffer.from(SRT_PREFIX, "ascii"),
    Buffer.from([0xc4, 0xe3, 0xba, 0xc3]),
    Buffer.from("\r\n", "ascii"),
  ]);
  const decoded = decodeSubtitle(buffer, "text/plain; charset=GBK", "zh-CN");
  const payload = normalizeSubtitlePayload({ buffer, fileName: "Daria.srt", contentType: "text/plain" }, decoded);

  assert.equal(decoded.encoding, "gb18030");
  assert.match(decoded.text, /你好/);
  assert.match(payload.buffer.toString("utf8"), /你好/);
  assert.equal(payload.contentType, "application/x-subrip; charset=utf-8");
});

// 1.1.1 下载响应必须按字幕格式返回，不能把 SRT 标成普通文本
test("字幕下载类型保留文件后缀语义", () => {
  const decoded = { text: `${SRT_PREFIX}Subtitle\r\n` };

  assert.equal(normalizeSubtitlePayload({ fileName: "Daria.ass" }, decoded).contentType, "text/x-ssa; charset=utf-8");
  assert.equal(normalizeSubtitlePayload({ fileName: "Daria.vtt" }, decoded).contentType, "text/vtt; charset=utf-8");
  assert.equal(normalizeSubtitlePayload({ fileName: "Daria.sub" }, decoded).contentType, "application/octet-stream");
});

// 1.2 带 BOM 的 UTF-16LE 不能被 UTF-8 和 NUL 清理逻辑误判
test("UTF-16LE BOM 字幕可解码", () => {
  const source = `${SRT_PREFIX}中文字幕\r\n`;
  const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]);
  const decoded = decodeSubtitle(buffer, "application/octet-stream", "zh-CN");

  assert.equal(decoded.encoding, "utf-16le");
  assert.equal(decoded.text, source);
});

// 1.3 UTF-8 被 Windows-1252 显示后再保存，仍应恢复原始中文
test("双重 UTF-8 乱码会自动修复", () => {
  const source = `${SRT_PREFIX}中文测试\r\n`;
  const mojibake = new TextDecoder("windows-1252").decode(Buffer.from(source, "utf8"));
  const decoded = decodeSubtitle(Buffer.from(mojibake, "utf8"), "text/plain; charset=utf-8", "zh-CN");

  assert.match(decoded.encoding, /utf-8\+repair/);
  assert.equal(decoded.text, source);
});

logger.info("字幕编码兼容性验证已注册完成");
