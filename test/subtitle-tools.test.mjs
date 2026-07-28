import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConvertedSubtitleFileName,
  convertSubtitleChinese,
  parseCustomConversionDictionary,
  validateSubtitleText,
} from "../lib/subtitle-tools.mjs";

const logger = {
  info: (...args) => console.info("[SubtitleToolsTest]", ...args),
};

const VALID_SRT = `1
00:00:01,000 --> 00:00:03,000
这个软件在出租车里面运行。

2
00:00:04,000 --> 00:00:06,500
第二行字幕内容。
`;

/*
 * ================================================================================
 * 步骤1：验证字幕结构校验
 * ================================================================================
 * 目标：
 * 1) 接受带有效时间轴和对白的 SRT、ASS
 * 2) 拒绝网页和纯文本，但允许用户查看语言不符的有效字幕
 */
logger.info("开始验证字幕结构校验...");

// 1.1 接受有效 SRT
test("有效 SRT 返回时间轴和对白数量", () => {
  const result = validateSubtitleText(VALID_SRT, { fileName: "Daria.chs.srt", language: "zh-CN" });
  assert.equal(result.valid, true);
  assert.equal(result.format, "SRT");
  assert.equal(result.cueCount, 2);
  assert.equal(result.durationSeconds, 6.5);
});

// 1.2 接受有效 ASS
test("有效 ASS 按 Events Format 解析", () => {
  const result = validateSubtitleText(`
[Script Info]
Title: Daria
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,你好，世界
`, { fileName: "Daria.ass", language: "zh-CN" });
  assert.equal(result.valid, true);
  assert.equal(result.format, "ASS");
  assert.equal(result.cueCount, 1);
});

// 1.2.1 接受 WebVTT 可省略小时的标准时间格式
test("有效 VTT 接受分秒时间轴", () => {
  const result = validateSubtitleText(`WEBVTT\n\n00:01.000 --> 00:03.500\n你好，世界\n`, {
    fileName: "Daria.vtt",
    language: "zh-CN",
  });
  assert.equal(result.valid, true);
  assert.equal(result.format, "VTT");
  assert.equal(result.durationSeconds, 3.5);
});

// 1.3 拒绝网页和无时间轴文本
test("网页和无时间轴文本不会被当成字幕", () => {
  assert.equal(validateSubtitleText("<!doctype html><html><body>blocked</body></html>", { fileName: "x.srt" }).valid, false);
  assert.equal(validateSubtitleText("这只是说明文字，没有任何时间轴。", { fileName: "x.srt" }).valid, false);
});

// 1.4 语言不符的有效字幕仍可预览和下载
test("中文搜索仍展示纯英文长字幕并标记提示", () => {
  const english = `1\n00:00:01,000 --> 00:00:05,000\nThis subtitle contains only English dialogue and does not match the requested Chinese language.\n`;
  const result = validateSubtitleText(english, { fileName: "Daria.srt", language: "zh-CN" });
  assert.equal(result.valid, true);
  assert.equal(result.language.match, false);
  assert.ok(result.warnings.some((warning) => /语言不符/.test(warning)));
});

logger.info("验证字幕结构校验完成");

/*
 * ================================================================================
 * 步骤2：验证 OpenCC 简繁转换
 * ================================================================================
 * 目标：
 * 1) 转换字形和台湾地区词组
 * 2) 保持时间轴不变并生成独立文件名
 */
logger.info("开始验证 OpenCC 简繁转换...");

// 2.1 简体转繁体使用词组转换
test("简体字幕转换为繁体副本", () => {
  const converted = convertSubtitleChinese(VALID_SRT, "zh-TW");
  assert.match(converted, /軟體/);
  assert.match(converted, /出租車/);
  assert.match(converted, /執行/);
  assert.match(converted, /00:00:01,000 --> 00:00:03,000/);
  assert.equal(buildConvertedSubtitleFileName("Daria.chs.srt", "zh-TW"), "Daria.cht.srt");
});

// 2.2 繁体转简体生成新后缀
test("繁体字幕转换为简体副本", () => {
  const converted = convertSubtitleChinese("00:00:01,000 --> 00:00:02,000\n軟體裡面", "zh-CN");
  assert.match(converted, /软件里面/);
  assert.equal(buildConvertedSubtitleFileName("Daria.zh-TW.ass", "zh-CN"), "Daria.chs.ass");
});

logger.info("验证 OpenCC 简繁转换完成");

/*
 * ================================================================================
 * 步骤3：验证自定义简繁词库
 * ================================================================================
 * 目标：
 * 1) 按目标方向应用用户指定词组
 * 2) 拒绝格式错误和过长词条
 */
logger.info("开始验证自定义简繁词库...");

// 3.1 自定义词条覆盖 OpenCC 默认结果并支持反向转换
test("自定义词库按简体和繁体目标双向应用", () => {
  const dictionary = "软件=軟件\n出租车=計程車";
  assert.match(convertSubtitleChinese(VALID_SRT, "zh-TW", { customDictionary: dictionary }), /軟件在計程車裡面執行/);
  assert.equal(convertSubtitleChinese("軟件與計程車", "zh-CN", { customDictionary: dictionary }), "软件与出租车");
});

// 3.2 注释和重复词条不会生成多余映射
test("自定义词库忽略注释和重复词条", () => {
  const entries = parseCustomConversionDictionary("# 常用词\n软件=軟件\n软件=軟件\n");
  assert.deepEqual(entries, [{ simplified: "软件", traditional: "軟件" }]);
});

// 3.3 错误格式给出行号
test("自定义词库拒绝无分隔符的词条", () => {
  assert.throws(() => parseCustomConversionDictionary("软件 軟件"), /第 1 行/);
});

logger.info("验证自定义简繁词库完成");
