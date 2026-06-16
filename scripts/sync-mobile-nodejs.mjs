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
await rm(path.join(targetDir, "server.cjs"), { force: true });
await rm(path.join(targetDir, "server.mjs"), { force: true });
await rm(targetPublicDir, { recursive: true, force: true });

// 1.2 打包服务端为旧 Node 可运行格式
await build({
  entryPoints: [path.join(projectRoot, "server.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node12.19",
  outfile: path.join(targetDir, "server.cjs"),
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
for (const fileName of ["index.html", "styles.css", "app.js", "mobile.js", "capacitor.js", "capacitor-early-bridge.js"]) {
  await copyFile(path.join(projectRoot, "public", fileName), path.join(targetPublicDir, fileName));
}

// 1.5 清理早期测试产物
await rm(path.join(targetDir, "_test_server.cjs"), { force: true });
await rm(path.join(targetDir, "_test2.cjs"), { force: true });
await rm(path.join(targetDir, "_test3.cjs"), { force: true });
await rm(path.join(projectRoot, "mobile-www"), { recursive: true, force: true });

console.info("[sync-mobile-nodejs]", "同步 Android Node 服务文件完成");
