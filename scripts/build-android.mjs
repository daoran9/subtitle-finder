import { access, copyFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const androidRoot = path.join(projectRoot, "android");
const buildType = process.argv[2] === "release" ? "release" : "debug";
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const applicationVersion = String(packageMetadata.version || "0.0.0");

/*
 * ================================================================================
 * 步骤1：选择 Android 构建 JDK
 * ================================================================================
 * 目标：
 * 1) 优先复用兼容 Gradle 7.0 的 JDK 11 或 17
 * 2) 避免系统 Java 25 导致 Unsupported class file major version 69
 */
console.info("[build-android]", "开始选择 Android 构建 JDK...");

// 1.1 读取显式配置和本机常用 E 盘路径
const javaHomeCandidates = [
  process.env.SUBTITLE_FINDER_JAVA_HOME,
  process.env.JAVA_HOME,
  "E:\\Java\\jdk-11.0.31+11",
].filter(Boolean);

// 1.2 选择首个 Java 主版本为 11 或 17 的 JDK
let javaHome = "";
for (const candidate of javaHomeCandidates) {
  const executable = path.join(candidate, "bin", "java.exe");
  try {
    await access(executable);
    const versionOutput = await runProcess(executable, ["-version"], { capture: true });
    const major = parseJavaMajorVersion(versionOutput);
    if (major === 11 || major === 17) {
      javaHome = candidate;
      break;
    }
  } catch {
    // 候选不可用时继续检查下一个路径。
  }
}
if (!javaHome) throw new Error("Android 构建需要 JDK 11 或 17。可用 SUBTITLE_FINDER_JAVA_HOME 指定 JDK 路径。");
console.info("[build-android]", "选择 Android 构建 JDK 完成", javaHome);

/*
 * ================================================================================
 * 步骤2：同步并构建 Android 应用
 * ================================================================================
 * 目标：
 * 1) 同步内置 Node 服务和 Capacitor 静态资源
 * 2) 使用 E 盘项目缓存生成指定类型 APK
 */
console.info("[build-android]", "开始构建 Android 应用...", buildType);

// 2.1 同步移动端服务和 Capacitor 工程
await runProcess(process.execPath, [path.join(__dirname, "sync-mobile-nodejs.mjs")]);
await runProcess(process.execPath, [path.join(projectRoot, "node_modules", "@capacitor", "cli", "bin", "capacitor"), "sync", "android"], { cwd: projectRoot });

// 2.2 使用兼容 JDK 和项目内 Gradle 缓存构建
const gradleTask = buildType === "release" ? "assembleRelease" : "assembleDebug";
const gradleCommand = process.platform === "win32"
  ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe"
  : path.join(androidRoot, "gradlew");
const gradleArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", `gradlew.bat ${gradleTask}`]
  : [gradleTask];
await runProcess(gradleCommand, gradleArgs, {
  cwd: androidRoot,
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    GRADLE_USER_HOME: path.join(projectRoot, ".gradle-cache"),
    PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`,
  },
});

// 2.3 发布构建复制到统一 dist 目录
if (buildType === "release") {
  const sourcePath = path.join(androidRoot, "app", "build", "outputs", "apk", "release", "app-release.apk");
  const targetPath = path.join(projectRoot, "dist", `SubtitleFinder Android ${applicationVersion}.apk`);
  await copyFile(sourcePath, targetPath);
  console.info("[build-android]", "复制 Android 发布包完成", targetPath);
}

console.info("[build-android]", "构建 Android 应用完成", buildType);

function parseJavaMajorVersion(value) {
  // 2.4 兼容 Java 8 的 1.x 写法和 Java 9 以后的主版本写法
  const match = String(value || "").match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (!match) return 0;
  return Number(match[1]) === 1 ? Number(match[2] || 0) : Number(match[1]);
}

function runProcess(command, args, options = {}) {
  // 2.5 继承终端输出；探测 Java 版本时收集标准错误
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || projectRoot,
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} 退出，代码 ${code}`));
    });
  });
}
