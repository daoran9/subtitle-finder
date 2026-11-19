import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConvertedSubtitleFileName,
  convertSubtitleChinese,
  incompleteSubtitleReason,
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
  assert.equal(result.spanSeconds, 5.5);
  assert.ok(incompleteSubtitleReason(result, 7_200_000));
  assert.equal(incompleteSubtitleReason(result, 12_000), "");
});

test("按字幕正文识别来源标记和括号说明", () => {
  const rank = (text, fileName = "字幕.srt") => validateSubtitleText(
    `1\n00:00:01,000 --> 00:00:03,000\n${text}\n`,
    { fileName, language: "zh-CN" },
  ).recommendationRank;
  for (const marker of ["色花", "色花堂", "有色花", "SeHuA", "sehuatang", "SEHUATANG", "98t", "98T", "www.98T.la", "98堂", "９８Ｔ"]) {
    assert.equal(rank(marker), 2, marker);
  }
  assert.equal(rank("原色花堂\n（课外授课）"), 3);
  assert.equal(rank("<i>（脚步声渐近）</i>"), 1);
  assert.equal(rank("说明 (Door creaks softly)"), 1);
  assert.equal(rank("（網友上傳）(簡體中文)(1080p) A98T 198堂 unsehua sehuatang123"), 0);
  assert.equal(rank("普通字幕", "色花.98T（人工校对）.srt"), 0);
});

test("括号推荐统计不同说明和开场说明，重复文字只计一次", () => {
  const result = validateSubtitleText(`1
00:01:04,000 --> 00:01:06,000
（门外传来脚步声）（室内广播响起）

2
00:02:59,000 --> 00:03:01,000
(门外传来脚步声)

3
00:08:00,000 --> 00:08:02,000
（回到出发地点）（简体中文）
`, { fileName: "test.srt" });
  assert.equal(result.recommendationRank, 1);
  assert.equal(result.descriptionCount, 3);
  assert.equal(result.openingDescriptionCount, 2);
});

// 1.2 接受有效 ASS
test("有效 ASS 按 Events Format 解析", () => {
  const result = validateSubtitleText(`
[Script Info]
Title: Daria 98堂（人工校对）
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,SEHUA
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,你好，世界
`, { fileName: "Daria.ass", language: "zh-CN" });
  assert.equal(result.valid, true);
  assert.equal(result.format, "ASS");
  assert.equal(result.cueCount, 1);
  assert.equal(result.recommendationRank, 0);
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
 * 1) 转换字形，保留原有用词
 * 2) 保持时间轴不变并生成独立文件名
 */
logger.info("开始验证 OpenCC 简繁转换...");

// 2.1 简体转繁体根据词义选择字形
test("简体字幕转换为繁体副本", () => {
  const converted = convertSubtitleChinese(VALID_SRT, "zh-TW");
  assert.match(converted, /這個軟件在出租車裡面運行/);
  assert.equal(convertSubtitleChinese("发现头发，干活，吃面条。", "zh-TW"), "發現頭髮，幹活，吃麵條。");
  assert.match(converted, /00:00:01,000 --> 00:00:03,000/);
  assert.equal(buildConvertedSubtitleFileName("Daria.chs.srt", "zh-TW"), "Daria.cht.srt");
});

// 2.2 繁体转简体生成新后缀
test("繁体字幕转换为简体副本", () => {
  const converted = convertSubtitleChinese("00:00:01,000 --> 00:00:02,000\n軟體裡面", "zh-CN");
  assert.match(converted, /软体里面/);
  assert.equal(buildConvertedSubtitleFileName("Daria.zh-TW.ass", "zh-CN"), "Daria.chs.ass");
});

test("简繁混排时保留已有简体字和原用词", () => {
  const time = "00:00:01,000 --> 00:00:02,000";
  const original = `1\r\n${time}\r\n怎么又拿这个？又斡嘛？\r\n這是什麼？又幹嘛？\r\n幺号还在斡旋。用軟體叫計程車。\r\n`;
  const expected = `1\r\n${time}\r\n怎么又拿这个？又斡嘛？\r\n这是什么？又干嘛？\r\n幺号还在斡旋。用软体叫计程车。\r\n`;
  assert.equal(convertSubtitleChinese(original, "zh-CN"), expected);
  assert.equal(convertSubtitleChinese(expected, "zh-CN"), expected);
});

test("简繁混排时保留简繁同形词的含义", () => {
  const original = "请呼叫總部，建立返航序列。停用核心備份。用軟體叫計程車。";
  const expected = "请呼叫总部，建立返航序列。停用核心备份。用软体叫计程车。";
  assert.equal(convertSubtitleChinese(original, "zh-CN"), expected);
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
  assert.match(convertSubtitleChinese(VALID_SRT, "zh-TW", { customDictionary: dictionary }), /軟件在計程車裡面運行/);
  assert.equal(convertSubtitleChinese("軟件與計程車", "zh-CN", { customDictionary: dictionary }), "软件与出租车");
  assert.equal(convertSubtitleChinese("又斡嘛", "zh-CN", { customDictionary: "干啥=斡嘛" }), "又干啥");
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
