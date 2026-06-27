(function () {
  const win = window;
  const capacitor = win.Capacitor;
  const isAndroid = Boolean(
    capacitor &&
    typeof capacitor.isNativePlatform === "function" &&
    capacitor.isNativePlatform() &&
    typeof capacitor.getPlatform === "function" &&
    capacitor.getPlatform() === "android"
  );
  if (!isAndroid) return;

  const nodePlugin =
    (capacitor && capacitor.Plugins && capacitor.Plugins.NodeJS) ||
    (win.CapacitorCustomPlatform && win.CapacitorCustomPlatform.plugins && win.CapacitorCustomPlatform.plugins.NodeJS);
  if (!nodePlugin || typeof nodePlugin.addListener !== "function") return;

  const logger = {
    info: (...args) => console.info("[SubtitleFinderMobile]", ...args),
    error: (...args) => console.error("[SubtitleFinderMobile]", ...args),
  };

  /*
   * ================================================================================
   * 步骤1：暴露移动端保存接口
   * ================================================================================
   * 目标：
   * 1) 复用桌面端 window.subtitleFinder 调用约定
   * 2) 通过 Android 系统文件夹授权保存字幕和扫描视频
   */
  logger.info("开始暴露移动端保存接口...");

  // 1.1 暴露保存、选目录和视频扫描接口
  win.subtitleFinder = {
    async selectDownloadDir() {
      logger.info("开始选择移动端保存目录...");

      // 1.2 调用 Android 原生目录授权
      const nativePlugin = getNativePlugin();
      if (!nativePlugin || !nativePlugin.selectDownloadDir) {
        logger.info("选择移动端保存目录完成: native missing");
        return { selected: false, error: "当前 Android 包缺少文件夹授权能力" };
      }
      const result = await nativePlugin.selectDownloadDir();
      logger.info("选择移动端保存目录完成", (result && result.label) || (result && result.directory) || "cancel");
      return result;
    },
    async selectVideoDir() {
      logger.info("开始选择移动端视频目录...");

      // 1.3 调用 Android 原生视频目录扫描
      const nativePlugin = getNativePlugin();
      if (!nativePlugin || !nativePlugin.selectVideoDir) {
        logger.info("选择移动端视频目录完成: native missing");
        return { selected: false, error: "当前 Android 包缺少视频目录扫描能力" };
      }
      const result = await nativePlugin.selectVideoDir();
      logger.info("选择移动端视频目录完成", result && Array.isArray(result.files) ? result.files.length : 0);
      return result;
    },
    async saveSubtitle(payload = {}) {
      logger.info("开始保存移动端字幕...");

      // 1.4 校验 Android 原生保存能力
      const nativePlugin = getNativePlugin();
      if (!nativePlugin || !nativePlugin.saveSubtitle) {
        logger.info("保存移动端字幕完成: native missing");
        return { saved: false, error: "当前 Android 包缺少文件夹保存能力" };
      }

      // 1.5 校验保存位置和下载地址
      const downloadUrl = String(payload.downloadUrl || "");
      const requestedFileName = sanitizeMobileFileName(payload.fileName || "subtitle.srt");
      const downloadDir = String(payload.downloadDir || "");
      if (!downloadUrl) {
        logger.info("保存移动端字幕完成: missing url");
        return { saved: false, error: "没有可下载的字幕" };
      }
      if (!downloadDir) {
        logger.info("保存移动端字幕完成: missing directory");
        return { saved: false, error: "请先选择存放位置" };
      }

      // 1.6 下载字幕字节并交给原生层写入授权目录
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        logger.info("保存移动端字幕完成: download failed", response.status);
        let message = `下载失败: ${response.status}`;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const body = await response.json().catch(() => null);
          message = String((body && body.detail) || (body && body.error) || message);
        }
        return { saved: false, error: message };
      }

      const responseFileName = parseDownloadFileName(response.headers.get("content-disposition") || "");
      const fileName = sanitizeMobileFileName(responseFileName || requestedFileName);
      const base64 = await blobToBase64(await response.blob());
      const result = await nativePlugin.saveSubtitle({
        downloadDir,
        fileName,
        base64,
        mimeType: response.headers.get("content-type") || "application/octet-stream",
      });

      logger.info("保存移动端字幕完成", (result && result.fileName) || (result && result.filePath) || "unknown");
      return result;
    },
  };

  logger.info("移动端保存接口暴露完成");

  /*
   * ================================================================================
   * 步骤2：等待移动端 Node 服务
   * ================================================================================
   * 目标：
   * 1) 等待 Android 内置 NodeJS 服务启动完成
   * 2) 服务可用后记录本机 API 地址
   */
  logger.info("开始等待移动端 Node 服务...");

  // 2.1 展示启动状态
  document.addEventListener("DOMContentLoaded", () => {
    document.body.dataset.mobileBoot = "true";
    const status = document.querySelector("#statusBadge");
    const summary = document.querySelector("#resultSummary");
    if (status) status.textContent = "启动中";
    if (summary) summary.textContent = "正在启动移动端服务";
  });

  // 2.2 监听服务启动完成
  nodePlugin.addListener("subtitle-finder:ready", (event) => {
    const url = event && event.args && event.args[0] && event.args[0].url || "http://127.0.0.1:8765/";
    logger.info("移动端 Node 服务启动完成", url);
    setMobileApiBase(url);
  });

  // 2.3 轮询健康检查，避免错过启动事件
  pollMobileService();

  // 2.4 监听服务启动失败
  nodePlugin.addListener("subtitle-finder:error", (event) => {
    const message = event && event.args && event.args[0] && event.args[0].message || "移动端服务启动失败";
    logger.error("移动端 Node 服务启动失败", message);
    const status = document.querySelector("#statusBadge");
    const summary = document.querySelector("#resultSummary");
    if (status) status.textContent = "失败";
    if (summary) summary.textContent = message;
  });

  logger.info("等待移动端 Node 服务完成: listener ready");

  async function pollMobileService() {
    /*
     * ================================================================================
     * 步骤3：轮询移动端服务
     * ================================================================================
     * 目标：
     * 1) 处理 Node ready 事件早于页面监听的情况
     * 2) 服务可访问后记录 API 地址
     */
    logger.info("开始轮询移动端服务...");

    // 3.1 最多等待 20 秒
    const baseUrl = "http://127.0.0.1:8765/";
    for (let index = 0; index < 40; index += 1) {
      try {
        const response = await fetch(`${baseUrl}api/health`, { cache: "no-store" });
        if (response.ok) {
          logger.info("轮询移动端服务完成: ready");
          setMobileApiBase(baseUrl);
          return;
        }
      } catch {
        // 3.2 服务未启动时继续等待
      }
      await wait(500);
    }

    logger.info("轮询移动端服务完成: timeout");
  }

  function blobToBase64(blob) {
    /*
     * ================================================================================
     * 步骤4：转换下载字节
     * ================================================================================
     * 目标：
     * 1) 将浏览器 Blob 转为 Capacitor 文件系统需要的 base64
     * 2) 去掉 data URL 头部，只保留纯内容
     */
    logger.info("开始转换下载字节...");

    // 4.1 用 FileReader 转换 Blob
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("文件转换失败"));
      reader.onload = () => {
        const value = String(reader.result || "");
        logger.info("转换下载字节完成");
        resolve(value.includes(",") ? value.split(",").pop() : value);
      };
      reader.readAsDataURL(blob);
    });
  }

  function getNativePlugin() {
    /*
     * ================================================================================
     * 步骤5：获取 Android 原生插件
     * ================================================================================
     * 目标：
     * 1) 兼容 Capacitor 标准插件注册位置
     * 2) 兼容当前自定义平台插件容器
     */
    logger.info("开始获取 Android 原生插件...");

    // 5.1 从两个可能位置读取原生插件
    const plugin =
      (win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.SubtitleFinderNative) ||
      (win.CapacitorCustomPlatform && win.CapacitorCustomPlatform.plugins && win.CapacitorCustomPlatform.plugins.SubtitleFinderNative);

    logger.info("获取 Android 原生插件完成", plugin ? "ok" : "missing");
    return plugin;
  }

  function sanitizeMobileFileName(value) {
    /*
     * ================================================================================
     * 步骤6：清理移动端文件名
     * ================================================================================
     * 目标：
     * 1) 移除 Android 路径不允许的字符
     * 2) 避免空文件名导致写入失败
     */
    logger.info("开始清理移动端文件名...");

    // 6.1 替换路径字符和控制字符
    const safe = String(value || "subtitle.srt")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim();

    logger.info("清理移动端文件名完成", safe || "subtitle.srt");
    return safe || "subtitle.srt";
  }

  function parseDownloadFileName(value) {
    /*
     * ================================================================================
     * 步骤7：解析下载文件名
     * ================================================================================
     * 目标：
     * 1) 优先使用服务端返回的真实字幕文件名
     * 2) 兼容 filename* 和 filename 两种响应头格式
     */
    logger.info("开始解析下载文件名...");

    // 7.1 解析 UTF-8 编码文件名
    const encodedMatch = String(value || "").match(/filename\*=UTF-8''([^;]+)/i);
    const encoded = encodedMatch ? encodedMatch[1] : "";
    if (encoded) {
      const decoded = decodeHeaderFileName(encoded);
      logger.info("解析下载文件名完成", decoded);
      return decoded;
    }

    // 7.2 解析普通文件名
    const plainMatch = String(value || "").match(/filename=["']?([^"';]+)["']?/i);
    const plain = plainMatch ? plainMatch[1] : "";
    const decoded = decodeHeaderFileName(plain);
    logger.info("解析下载文件名完成", decoded || "empty");
    return decoded;
  }

  function decodeHeaderFileName(value) {
    // 7.3 解码响应头文件名，失败时保留原文
    try {
      return decodeURIComponent(String(value || "").trim());
    } catch {
      return String(value || "").trim();
    }
  }

  function setMobileApiBase(url) {
    /*
     * ================================================================================
     * 步骤8：记录移动端服务地址
     * ================================================================================
     * 目标：
     * 1) 保留当前 Capacitor 原生页面，避免丢失 Android 插件桥
     * 2) 让前端 API 请求转发到内置 Node 服务
     */
    logger.info("开始记录移动端服务地址...", url);

    // 8.1 保存 API 根地址
    win.subtitleFinderApiBase = String(url || "http://127.0.0.1:8765/").replace(/\/+$/, "");

    // 8.2 更新启动状态
    const status = document.querySelector("#statusBadge");
    const summary = document.querySelector("#resultSummary");
    if (status && status.textContent === "启动中") status.textContent = "就绪";
    if (summary && summary.textContent === "正在启动移动端服务") summary.textContent = "等待搜索";

    logger.info("记录移动端服务地址完成", win.subtitleFinderApiBase);
  }

  function wait(milliseconds) {
    /*
     * ================================================================================
     * 步骤9：等待固定时间
     * ================================================================================
     * 目标：
     * 1) 给轮询逻辑提供轻量延迟
     * 2) 避免阻塞页面主线程
     */
    logger.info("开始等待...", milliseconds);

    // 9.1 返回延迟 Promise
    return new Promise((resolve) => setTimeout(() => {
      logger.info("等待完成", milliseconds);
      resolve();
    }, milliseconds));
  }
})();
