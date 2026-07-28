import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSyncedSubtitleFileName,
  parseFfsubsyncProgress,
  parseFfsubsyncSummary,
} from "../lib/subtitle-sync.mjs";

const logger = {
  info: (...args) => console.info("[SubtitleSyncTest]", ...args),
};

/*
 * ================================================================================
 * 步骤1：验证自动校时辅助逻辑
 * ================================================================================
 * 目标：
 * 1) 输出文件始终为独立 synced SRT
 * 2) 准确识别进度、偏移和低质量拒绝
 */
logger.info("开始验证自动校时辅助逻辑...");

// 1.1 命名不覆盖原字幕并避免重复后缀
test("校时输出生成独立 SRT 文件名", () => {
  assert.equal(buildSyncedSubtitleFileName("Daria.S01E01.chs.ass"), "Daria.S01E01.chs.synced.srt");
  assert.equal(buildSyncedSubtitleFileName("old.srt", "Daria.S01E01.zh"), "Daria.S01E01.zh.synced.srt");
  assert.equal(buildSyncedSubtitleFileName("Daria.synced.srt"), "Daria.synced.srt");
});

// 1.2 只接受完整的进度数字行
test("ffsubsync 进度只接受 0 到 100", () => {
  assert.equal(parseFfsubsyncProgress("42\r\n"), 42);
  assert.equal(parseFfsubsyncProgress("100%"), 100);
  assert.equal(parseFfsubsyncProgress("score: 42.000"), null);
  assert.equal(parseFfsubsyncProgress("101"), null);
});

// 1.3 低质量日志会提取拒绝原因和对齐数值
test("ffsubsync 摘要识别低质量结果", () => {
  const summary = parseFfsubsyncSummary(`
INFO score: -1.000
INFO offset seconds: 45.500
INFO framerate scale factor: 1.042
WARNING low-quality alignment (score -1.0 < 0.0; |offset| 45.5s > 30.0s); leaving subtitles unmodified
`);
  assert.equal(summary.lowQuality, true);
  assert.match(summary.lowQualityReason, /score/);
  assert.equal(summary.score, -1);
  assert.equal(summary.offsetSeconds, 45.5);
  assert.equal(summary.framerateScale, 1.042);
});

// 1.4 Rich 终端折行不能漏掉退出码为 0 的质量拒绝
test("ffsubsync 摘要识别跨行低质量日志", () => {
  const summary = parseFfsubsyncSummary(`
WARNING  low-quality alignment (score -1.0 < 0.0; |offset|
         45.5s > 30.0s); leaving subtitles unmodified
`);
  assert.equal(summary.lowQuality, true);
  assert.equal(summary.lowQualityReason, "score -1.0 < 0.0; |offset| 45.5s > 30.0s");
});

logger.info("验证自动校时辅助逻辑完成");
