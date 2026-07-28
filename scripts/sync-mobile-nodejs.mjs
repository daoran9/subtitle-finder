import { mkdir, copyFile, rm } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const targetDir = path.join(projectRoot, "public", "nodejs");
const targetPublicDir = path.join(targetDir, "public");

await mkdir(targetDir, { recursive: true });

async function removeWithRetry(targetPath, options = {}) {
  const retries = options.retries ?? 8;
  const delayMs = options.delayMs ?? 250;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await rm(targetPath, { force: true, recursive: Boolean(options.recursive) });
      return;
    } catch (error) {
      if ((error?.code !== "EPERM" && error?.code !== "EBUSY") || attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/*
 * ================================================================================
 * 步骤1：同步 Android Node 服务文件
 * ================================================================================
 * 目标：
 * 1) 生成 Node 12.19 可运行的 CommonJS 服务包
 * 2) 同步前端静态资源到 Node 运行目录
 */
console.info("[sync-mobile-nodejs]", "开始同步 Android Node 服务文件...");

// 1.1 清理旧产物
await removeWithRetry(path.join(targetDir, "server.mjs"));

// 1.2 打包服务端为旧 Node 可运行格式
await build({
  entryPoints: [path.join(projectRoot, "server.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node12.19",
  outfile: path.join(targetDir, "server-alt.cjs"),
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "import_meta_url",
  },
  logLevel: "warning",
});

// 1.3 同步 Capacitor 运行时
await copyFile(
  path.join(projectRoot, "node_modules", "@capacitor", "core", "dist", "capacitor.js"),
  path.join(projectRoot, "public", "capacitor.js")
);

// 1.4 同步静态资源到 Node 运行目录
await mkdir(targetPublicDir, { recursive: true });
for (const fileName of [
  "index.html",
  "styles.css",
  "conversion-dictionary.js",
  "media-library.js",
  "scan-rules.js",
  "subtitle-rules.js",
  "app.js",
  "mobile.js",
  "capacitor.js",
  "capacitor-early-bridge.js",
]) {
  await copyFile(path.join(projectRoot, "public", fileName), path.join(targetPublicDir, fileName));
}

// 1.5 同步压缩包解码 WASM 运行文件
await mkdir(path.join(targetDir, "vendor"), { recursive: true });
for (const [sourcePath, fileName] of [
  [path.join(projectRoot, "vendor", "unrar.wasm"), "unrar.wasm"],
  [path.join(projectRoot, "vendor", "7zz.wasm"), "7zz.wasm"],
]) {
  await copyFile(sourcePath, path.join(targetDir, "vendor", fileName));
}

// 1.6 同步第三方许可清单和完整许可正文
await copyFile(
  path.join(projectRoot, "vendor", "THIRD_PARTY_LICENSES.md"),
  path.join(targetDir, "vendor", "THIRD_PARTY_LICENSES.md")
);
await mkdir(path.join(targetDir, "vendor", "licenses"), { recursive: true });
await copyFile(
  path.join(projectRoot, "LICENSE"),
  path.join(targetDir, "vendor", "licenses", "SubtitleFinder-LICENSE.txt")
);
for (const fileName of [
  "7z-wasm-LICENSE.txt",
  "7z-wasm-unRAR-LICENSE.txt",
  "node-unrar-js-LICENSE.md",
  "mediainfo.js-LICENSE.txt",
  "ChineseSubFinder-LICENSE.txt",
  "opencc-js-LICENSE.txt",
  "opencc-js-THIRD_PARTY_LICENSES.md",
  "fast-xml-parser-LICENSE.txt",
  "iconv-lite-LICENSE.md",
  "safer-buffer-LICENSE.md",
]) {
  await copyFile(
    path.join(projectRoot, "vendor", "licenses", fileName),
    path.join(targetDir, "vendor", "licenses", fileName)
  );
}

// 1.7 清理早期测试产物
await removeWithRetry(path.join(targetDir, "_test_server.cjs"));
await removeWithRetry(path.join(targetDir, "_test2.cjs"));
await removeWithRetry(path.join(targetDir, "_test3.cjs"));
await removeWithRetry(path.join(projectRoot, "mobile-www"), { recursive: true });

console.info("[sync-mobile-nodejs]", "同步 Android Node 服务文件完成");
