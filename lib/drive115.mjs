import { createHash, randomBytes } from "crypto";
import https from "https";

export const LOGIN_APPS = [
  ["web", "115生活 · 网页", "A1"], ["ios", "115生活 · 苹果", "D1"], ["115ios", "115 · 苹果", "D3"],
  ["android", "115生活 · 安卓", "F1"], ["115ipad", "115 · iPad", "H3"], ["tv", "115生活 · 安卓电视", "I1"],
  ["apple_tv", "115生活 · Apple TV", "I2"], ["qios", "115管理 · 苹果", "N1"],
  ["os_windows", "115生活 · Windows", "P1"], ["os_linux", "115生活 · Linux", "P3"],
  ["wechatmini", "115生活 · 微信小程序", "R1"], ["alipaymini", "115生活 · 支付宝小程序", "R2"], ["harmony", "115 · 鸿蒙", "S1"],
].map(([id, label, ssoent]) => ({ id, label, ssoent }));
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36";
const IPHONE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const ANDROID_USER_AGENT = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
// 二维码申请时的系统标识会影响手机确认页；凭据换取的原生 UA 单独处理。
const QR_USER_AGENTS = {
  ios: IPHONE_USER_AGENT, "115ios": IPHONE_USER_AGENT, qios: IPHONE_USER_AGENT,
  "115ipad": "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  android: ANDROID_USER_AGENT, tv: ANDROID_USER_AGENT,
  apple_tv: "Mozilla/5.0 (Apple TV; CPU tvOS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  os_linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  wechatmini: `${IPHONE_USER_AGENT} MicroMessenger/8.0.42 miniProgram`,
  alipaymini: `${IPHONE_USER_AGENT} AlipayClient/10.5.0 AlipayMiniProgram/1.0`,
  harmony: "Mozilla/5.0 (Linux; Android 12; HarmonyOS) AppleWebKit/537.36 (KHTML, like Gecko) HuaweiBrowser/14.0.0.0 Mobile Safari/537.36",
};
const qrHeaders = (app) => ({ "user-agent": QR_USER_AGENTS[app] || USER_AGENT });
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|webm|flv|iso)$/i;
const validId = (value) => /^(0|[1-9]\d*)$/.test(String(value));
const success = (value) => value === true || value === 1 || value === "1";
const idText = (value) => typeof value === "number" && !Number.isSafeInteger(value) ? "" : String(value);

// 独立传输避免通用字幕下载器记录登录 URL，并兼容 Android 内置 Node 12。
function driveFetch(url, options) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers };
    if (options.body) headers["content-length"] = Buffer.byteLength(options.body);
    const request = https.request(url, { method: options.method || "GET", headers }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) request.destroy(new Error("response too large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        clearTimeout(timer);
        const buffer = Buffer.concat(chunks);
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
          headers: { get: (name) => response.headers[name.toLowerCase()] },
          json: async () => JSON.parse(buffer.toString("utf8")), arrayBuffer: async () => buffer });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("timeout")), 45000);
    request.on("error", (error) => { clearTimeout(timer); reject(error); });
    if (options.body) request.write(options.body);
    request.end();
  });
}

export function decodeDriveEntry(row) {
  const directory = !row.fid && !row.file_id;
  const entry = {
    id: idText(row.file_id || row.fid || row.cid || row.category_id || ""),
    parentId: idText(directory ? row.pid ?? row.parent_id ?? "" : row.cid ?? row.category_id ?? row.parent_id ?? ""),
    name: String(row.n || row.file_name || row.category_name || ""),
    directory, size: Number(row.s ?? row.file_size ?? 0),
    sha1: String(row.sha || row.sha1 || row.file_sha1 || "").toUpperCase(),
  };
  if (!validId(entry.id) || !validId(entry.parentId) || !entry.name) throw new Error("115 文件信息不完整");
  return { ...entry, video: !directory && VIDEO_EXT.test(entry.name) };
}

export function cloudSubtitleName(videoName, subtitleName, matchVideoName = true) {
  const ext = String(subtitleName).match(/\.(srt|ass|ssa|vtt|sub)$/i)?.[0];
  if (!ext || !VIDEO_EXT.test(videoName) || /[\r\n/\\\x00]/.test(videoName) || /[\r\n/\\\x00]/.test(subtitleName)) throw new Error("视频或字幕文件名无效");
  return matchVideoName ? videoName.replace(/\.[^.]+$/, "") + ext.toLowerCase() : subtitleName;
}

// Cookie 只留在当前服务进程中，既不返回网页，也不写入磁盘。
export class Drive115 {
  constructor(fetcher = driveFetch) {
    this.fetcher = fetcher;
    this.session = null;
    this.pending = null;
    this.writes = new Map();
  }

  async request(url, options = {}, authenticated = true) {
    const headers = { "user-agent": USER_AGENT, referer: "https://115.com/", ...options.headers };
    if (authenticated) {
      if (!this.session) throw new Error("请先登录 115");
      headers.cookie = this.session.cookie;
    }
    try {
      const response = await this.fetcher(url, { ...options, headers, redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      // 不将含扫码参数或 OSS 临时凭据的 URL 带到 UI / 日志。
      throw new Error(/^HTTP \d+$/.test(error.message) ? `115 请求失败：${error.message}` : "115 请求未完成，请检查网络");
    }
  }

  async json(url, options, authenticated = true) {
    const response = await this.request(url, options, authenticated);
    let data;
    try { data = await response.json(); } catch { throw new Error("115 返回了无法识别的响应"); }
    if (data.state !== undefined && !success(data.state)) throw new Error("115 拒绝请求，登录可能已失效或触发限制");
    return data;
  }

  status() { return { account: this.session ? { id: this.session.id, name: this.session.name, app: this.session.app } : null, apps: LOGIN_APPS }; }
  logout() { this.session = null; this.pending = null; }

  async begin(app) {
    if (!LOGIN_APPS.some((item) => item.id === app)) throw new Error("不支持的 115 登录端");
    const value = await this.json(`https://qrcodeapi.115.com/api/1.0/${app}/1.0/token/`, { headers: qrHeaders(app) }, false);
    const data = value.data;
    if (!data?.uid || !data.time || !data.sign) throw new Error("115 二维码信息不完整");
    this.pending = { app, uid: String(data.uid), time: String(data.time), sign: String(data.sign), id: randomBytes(18).toString("hex"), expires: Date.now() + 5 * 60 * 1000 };
    return { id: this.pending.id };
  }

  token(id) {
    if (!this.pending || this.pending.id !== id || this.pending.expires < Date.now()) throw new Error("二维码已失效，请重新生成");
    return this.pending;
  }

  async qrImage(id) {
    const token = this.token(id);
    const response = await this.request(`https://qrcodeapi.115.com/api/1.0/${token.app}/1.0/qrcode?qrfrom=1&uid=${encodeURIComponent(token.uid)}`, { headers: qrHeaders(token.app) }, false);
    const contentType = response.headers.get("content-type") || "";
    if (!/^image\/(png|jpeg|gif|webp)(;|$)/i.test(contentType)) throw new Error("115 二维码图片无效");
    return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
  }

  async poll(id) {
    const token = this.token(id);
    if (token.finishing) return { status: "scanned" };
    const query = new URLSearchParams({ uid: token.uid, time: token.time, sign: token.sign });
    const response = await this.request(`https://qrcodeapi.115.com/get/status/?${query}`, { headers: qrHeaders(token.app) }, false);
    let value;
    try { value = await response.json(); } catch { throw new Error("115 二维码状态响应无效"); }
    if (Number(value.code) === 90038) return { status: "waiting" };
    if (Number(value.code) === 40199002) return { status: "expired" };
    const code = Number(value.data?.status ?? value.status);
    if (code !== 2) return { status: ({ 0: "waiting", 1: "scanned", 9: "expired", "-1": "expired", "-2": "canceled" })[code] || "expired" };
    token.finishing = true;
    try {
      // 115生活苹果与115管理苹果共用 ios 接口，通过原生客户端标识区分登录端。
      const loginApp = token.app === "qios" ? "ios" : token.app;
      const headers = { "content-type": "application/x-www-form-urlencoded" };
      if (token.app === "ios") headers["user-agent"] = "UPhone/1.0.0";
      if (token.app === "qios") headers["user-agent"] = "OfficePhone/1.0.0";
      const body = new URLSearchParams({ account: token.uid, app: loginApp }).toString();
      const login = await this.json(`https://passportapi.115.com/app/1.0/${loginApp}/1.0/login/qrcode/`, {
        method: "POST", headers, body,
      }, false);
      if (this.pending !== token) throw new Error("登录已取消，请重新扫码");
      const cookies = login.data?.cookie;
      if (!["UID", "CID", "SEID"].every((key) => typeof cookies?.[key] === "string" && cookies[key] && !/[;\r\n]/.test(cookies[key]))) throw new Error("115 登录凭据不完整");
      if (cookies.KID && (typeof cookies.KID !== "string" || /[;\r\n]/.test(cookies.KID))) throw new Error("115 登录凭据无效");
      const cookie = ["UID", "CID", "SEID", "KID"].filter((key) => cookies[key]).map((key) => `${key}=${cookies[key]}`).join("; ");
      const id = cookies.UID.split("_")[0];
      if (!validId(id)) throw new Error("115 账号信息无效");
      const selectedApp = LOGIN_APPS.find((app) => app.id === token.app);
      const ssoent = cookies.UID.split("_")[1];
      if (ssoent !== selectedApp.ssoent) {
        const actualApp = LOGIN_APPS.find((app) => app.ssoent === ssoent);
        throw new Error(`115 返回${actualApp ? `“${actualApp.label}”` : "的登录端无法识别"}，与所选“${selectedApp.label}”不一致，未保存本次登录；请重新扫码`);
      }
      const account = await this.json("https://my.115.com/?ct=ajax&ac=nav", { headers: { cookie } }, false);
      if (String(account.data?.user_id || account.data?.uid || "") !== id) throw new Error("115 账号核对失败，请重新扫码");
      if (this.pending !== token) throw new Error("登录已取消，请重新扫码");
      this.session = { id, name: String(account.data?.user_name || account.data?.uname || `115 · ${id}`), cookie, app: token.app };
      this.pending = null;
      return { status: "confirmed", account: this.status().account };
    } finally { token.finishing = false; }
  }

  async list(parentId = "0", offset = 0) {
    if (!validId(parentId) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("目录参数无效");
    const query = new URLSearchParams({ cid: String(parentId), offset: String(offset), limit: "100", aid: "1", show_dir: "1", o: "file_name", asc: "1", format: "json" });
    const value = await this.json(`https://webapi.115.com/files?${query}`);
    if (!Array.isArray(value.data) || !Number.isSafeInteger(Number(value.count)) || Number(value.count) < 0 || Number(value.offset) !== offset) throw new Error("115 目录分页信息不完整");
    const entries = value.data.map(decodeDriveEntry);
    if (offset + entries.length > Number(value.count)) throw new Error("115 目录计数不一致，请刷新后重试");
    if (entries.some((item) => item.parentId !== String(parentId))) throw new Error("115 返回了其他目录的文件");
    if (!entries.length && offset < Number(value.count)) throw new Error("115 目录分页不完整");
    return { entries, total: Number(value.count), offset, nextOffset: offset + entries.length < Number(value.count) ? offset + entries.length : null };
  }

  async allEntries(parentId) {
    const entries = [];
    let offset = 0;
    let total;
    do {
      const page = await this.list(parentId, offset);
      if (total !== undefined && total !== page.total) throw new Error("115 目录已变化，请刷新后重试");
      total = page.total;
      entries.push(...page.entries);
      offset = page.nextOffset;
    } while (offset !== null);
    if (new Set(entries.map((item) => item.id)).size !== entries.length) throw new Error("115 目录分页重复，请刷新后重试");
    return entries;
  }

  async save(video, payload, matchVideoName = true) {
    if (!this.session) throw new Error("请先登录 115");
    if (!validId(video?.parentId) || !validId(video?.id)) throw new Error("请选择 115 视频");
    const session = this.session;
    const fileName = cloudSubtitleName(video.name, payload.fileName, matchVideoName);
    const key = `${session.id}/${video.parentId}/${fileName}`;
    if (this.writes.has(key)) throw new Error(this.writes.get(key) === "unknown" ? "上次上传结果不明，请先到 115 核对，当前会话不重复上传该文件" : "该字幕正在上传");
    this.writes.set(key, "checking");
    let submitted = false;
    try {
      const entries = await this.allEntries(video.parentId);
      const current = entries.find((entry) => entry.id === video.id);
      if (!current?.video || current.name !== video.name) throw new Error("115 视频已移动或更名，请重新选择");
      if (entries.some((entry) => entry.name === fileName)) throw new Error(`同目录已有 ${fileName}，未覆盖`);
      const init = await this.json("https://uplb.115.com/3.0/sampleinitupload.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ userid: session.id, filename: fileName, filesize: String(payload.buffer.length), target: `U_1_${video.parentId}` }).toString(),
      });
      const info = init.data || init;
      const host = new URL(info.host);
      if (host.protocol !== "https:" || !/^[a-z0-9.-]+\.aliyuncs\.com$/i.test(host.hostname) || host.username || host.password || host.port) throw new Error("115 上传地址不受支持");
      const fields = { key: info.object, policy: info.policy, OSSAccessKeyId: info.accessid, success_action_status: "200", callback: info.callback, signature: info.signature };
      if (Object.values(fields).some((value) => typeof value !== "string" || !value)) throw new Error("115 上传凭据不完整");
      const boundary = `SubtitleFinder${randomBytes(16).toString("hex")}`;
      const chunks = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, "%22")}"\r\nContent-Type: application/octet-stream\r\n\r\n`), payload.buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
      if (this.session !== session) throw new Error("115 登录已变更，请重新选择视频");
      submitted = true;
      // OSS 仅接收临时上传凭据，不发送 115 Cookie，也不重放写请求。
      await this.request(host.href, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(chunks) }, false);
      const sha1 = createHash("sha1").update(payload.buffer).digest("hex").toUpperCase();
      const saved = (await this.allEntries(video.parentId)).filter((entry) => entry.name === fileName && entry.size === payload.buffer.length && entry.sha1 === sha1);
      if (saved.length !== 1) throw new Error("上传后未核对到唯一的同内容字幕");
      this.writes.delete(key);
      return { saved: true, fileName, id: saved[0].id, parentId: video.parentId };
    } catch (error) {
      if (submitted) {
        this.writes.set(key, "unknown");
        throw new Error("上传结果不明，请先到 115 核对；未自动重试");
      }
      this.writes.delete(key);
      throw error;
    }
  }
}
