const { channel } = require("bridge");

async function boot() {
  /*
   * ================================================================================
   * 步骤1：启动 Android 内置服务
   * ================================================================================
   * 目标：
   * 1) 加载同步脚本生成的 Node 12 兼容服务包
   * 2) 将启动地址通知 Capacitor WebView
   */
  console.info("[subtitle-finder-mobile]", "开始启动 Android 内置服务...");

  // 1.1 加载服务包
  const { startServer } = require("./server.cjs");

  // 1.2 启动本机 HTTP 服务
  const service = await startServer({ host: "127.0.0.1", port: 8765 });

  // 1.3 通知前端服务已就绪
  channel.send("subtitle-finder:ready", { url: service.url });
  console.info("[subtitle-finder-mobile]", "Android 内置服务启动完成", service.url);
}

boot().catch((error) => {
  console.error("[subtitle-finder-mobile]", error);
  channel.send("subtitle-finder:error", { message: String((error && error.message) || error) });
});
