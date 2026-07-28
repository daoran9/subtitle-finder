import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeScanPath,
  parseScanExclusionRules,
  shouldExcludeScanPath,
} from "../public/scan-rules.js";

const logger = {
  info: (...args) => console.info("[ScanRulesTest]", ...args),
};

/*
 * ================================================================================
 * 步骤1：验证扫描排除规则
 * ================================================================================
 * 目标：
 * 1) 支持目录双星号和任意层级文件名规则
 * 2) 统一 Windows 与 Android 相对路径
 */
logger.info("开始验证扫描排除规则...");

// 1.1 解析时清理重复项和注释
test("排除规则忽略空行、注释和大小写重复项", () => {
  assert.deepEqual(parseScanExclusionRules("# cache\n**/Extras/**\n\n**/extras/**"), ["**/Extras/**"]);
});

// 1.2 双星号规则匹配目录自身和后代
test("目录规则排除任意层级 Extras", () => {
  const rules = parseScanExclusionRules("**/Extras/**");
  assert.equal(shouldExcludeScanPath("Extras", rules), true);
  assert.equal(shouldExcludeScanPath("Daria/Extras", rules), true);
  assert.equal(shouldExcludeScanPath("Daria/Extras/interview.mkv", rules), true);
  assert.equal(shouldExcludeScanPath("Daria/Season 01/Episode.mkv", rules), false);
});

// 1.3 不带路径的规则匹配任意层级文件名
test("文件名规则排除 sample 视频", () => {
  const rules = parseScanExclusionRules("*.sample.*");
  assert.equal(shouldExcludeScanPath("Daria/Daria.S01E01.sample.mkv", rules), true);
  assert.equal(shouldExcludeScanPath("Daria/Daria.S01E01.mkv", rules), false);
});

// 1.4 路径分隔符和大小写不影响匹配
test("Windows 路径规范为统一相对路径", () => {
  assert.equal(normalizeScanPath(".\\Daria\\Extras\\clip.MKV"), "Daria/Extras/clip.MKV");
  assert.equal(shouldExcludeScanPath("Daria\\EXTRAS\\clip.MKV", "**/Extras/**"), true);
});

logger.info("验证扫描排除规则完成");
