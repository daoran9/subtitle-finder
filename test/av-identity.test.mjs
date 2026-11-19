import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildAvSearchTerms,
  extractAvIdentity,
  sameAvIdentity,
} from "../public/av-identity.js";

/*
 * ================================================================================
 * 步骤1：验证番号身份提取
 * ================================================================================
 * 目标：
 * 1) 覆盖恢复文件和特殊系列
 * 2) 确保标准码不受前缀、零宽字符和分隔符影响
 */
console.info("[AvIdentityTest] 开始验证番号身份提取...");

test("TODO 样本全部提取为标准番号", async () => {
  console.info("[AvIdentityTest] 开始读取番号样本...");

  // 1.1 从固定夹具读取用户列出的恢复文件和特殊系列。
  const fixtureUrl = new URL("./fixtures/av-identity.json", import.meta.url);
  const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));
  for (const fixture of fixtures) {
    const identity = extractAvIdentity(fixture.input);
    assert.equal(identity?.canonicalCode ?? null, fixture.finderScanCode === undefined ? fixture.canonicalCode : fixture.finderScanCode, fixture.input);
    assert.equal(extractAvIdentity(fixture.input, { allowLooseCode: true })?.canonicalCode ?? null, fixture.canonicalCode, fixture.input);
  }

  console.info("[AvIdentityTest] 读取番号样本完成", fixtures.length);
});

/*
 * ================================================================================
 * 步骤2：验证精确身份比较
 * ================================================================================
 * 目标：
 * 1) JAC-089 与连写、空格写法视为同一身份
 * 2) JAC-0890 不能因包含 JAC-089 被误判为命中
 */
test("相似番号不会通过精确比较", () => {
  console.info("[AvIdentityTest] 开始比较相似番号...");

  // 2.1 验证可接受的分隔符变体和错误相邻编号。
  assert.equal(sameAvIdentity("JAC-089", "jac 089"), true);
  assert.equal(sameAvIdentity("JAC-089", "JAC-0890"), false);
  assert.equal(sameAvIdentity("FC2-PPV-4818259", "fc2ppv4818259"), true);

  console.info("[AvIdentityTest] 比较相似番号完成");
});

test("MIDA 补零编号统一为三位，其他系列保留原位数", () => {
  assert.equal(extractAvIdentity("mida00458_4K60fps_ltx.mp4")?.canonicalCode, "MIDA-458");
  assert.equal(extractAvIdentity("mida00459_4K60fps_restored.mp4")?.canonicalCode, "MIDA-459");
  assert.equal(extractAvIdentity("MIDA-00007.mp4")?.canonicalCode, "MIDA-007");
  assert.deepEqual(buildAvSearchTerms("MIDA-00458"), ["MIDA-458", "MIDA 458", "MIDA458"]);
  assert.equal(sameAvIdentity("MIDA-458", "mida00458"), true);
  assert.equal(sameAvIdentity("MIDA-458", "MIDA-00459"), false);
  assert.equal(sameAvIdentity("MIDA-458", "MIDA-4580"), false);
  assert.equal(extractAvIdentity("ABC-00458")?.canonicalCode, "ABC-00458");
});

/*
 * ================================================================================
 * 步骤3：验证普通影视保护
 * ================================================================================
 * 目标：
 * 1) 普通片名和年份不进入 AV 模式
 * 2) 标准番号仍生成三种检索词
 */
test("普通影视标题不被识别为番号", () => {
  console.info("[AvIdentityTest] 开始验证普通影视保护...");

  // 3.1 Title Case 片名加年份不能触发通用番号规则。
  assert.equal(extractAvIdentity("Dune.2021.2160p.mkv"), null);
  assert.equal(extractAvIdentity("Dune-2021.2160p.mkv"), null);
  assert.equal(extractAvIdentity("Daria_1997.mkv"), null);
  assert.equal(extractAvIdentity("Daria 1997"), null);
  assert.equal(extractAvIdentity("Episode.01.mkv"), null);
  assert.deepEqual(buildAvSearchTerms("ABC-123"), ["ABC-123", "ABC 123", "ABC123"]);

  console.info("[AvIdentityTest] 普通影视保护验证完成");
});

/*
 * ================================================================================
 * 步骤4：验证手动紧凑号码边界
 * ================================================================================
 * 目标：
 * 1) 文件扫描继续拒绝小写紧凑文本，避免普通标题误判
 * 2) 手动搜索可显式放宽为标准番号，兼容用户直接输入
 */
test("手动紧凑号码可放宽，文件扫描保持保守", () => {
  console.info("[AvIdentityTest] 开始验证手动紧凑号码边界...");

  // 4.1 默认扫描不把小写紧凑文本当成番号。
  assert.equal(extractAvIdentity("abc123"), null);

  // 4.2 搜索入口显式传入放宽标记后，返回稳定标准码。
  assert.equal(extractAvIdentity("abc123", { allowLooseCode: true })?.canonicalCode, "ABC-123");
  assert.equal(extractAvIdentity("murikuri-009.mp4")?.canonicalCode, "MURIKURI-009");

  console.info("[AvIdentityTest] 手动紧凑号码边界验证完成");
});
