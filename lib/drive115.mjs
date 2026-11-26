import { createHash, randomBytes } from "crypto";
import https from "https";
import { createExistingSubtitleMatcher, SUBTITLE_EXTENSIONS } from "../public/media-library.js";
import { createScanExclusionMatcher } from "../public/scan-rules.js";

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
const PAGE_SIZE = 100;
const SAVE_PAGE_SIZE = 1000;
const SORT_ORDERS = new Map([
  ["name-asc", ["file_name", "1"]], ["name-desc", ["file_name", "0"]],
  ["newest", ["user_ptime", "0", "addedAt"]], ["oldest", ["user_ptime", "1", "addedAt"]],
  ["updated-desc", ["user_utime", "0", "updatedAt"]], ["updated-asc", ["user_utime", "1", "updatedAt"]],
]);
const validId = (value) => /^(0|[1-9]\d*)$/.test(String(value));
const success = (value) => value === true || value === 1 || value === "1";
const idText = (value) => typeof value === "number" && !Number.isSafeInteger(value) ? "" : String(value);

class DirectoryListingChanged extends Error {}
class SubtitleFilterUnavailable extends Error {}

// Android 内置 Node 没有 Intl。对字母忽略大小写，并按数字大小排列连续数字。
function compareNames(left, right) {
  const a = left.toLowerCase().split(/(\d+)/);
  const b = right.toLowerCase().split(/(\d+)/);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const numeric = i % 2 === 1;
    const x = numeric ? a[i].replace(/^0+(?=\d)/, "") : a[i];
    const y = numeric ? b[i].replace(/^0+(?=\d)/, "") : b[i];
    if (numeric && x.length !== y.length) return x.length - y.length;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

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
    parentId: idText(directory ? row.pid ?? row.parent_id ?? "" : row.cid ?? row.category_id ?? row.parent_id ?? row.pid ?? ""),
    name: String(row.n || row.file_name || row.category_name || row.fn || ""),
    directory, size: Number(row.s ?? row.file_size ?? row.size_byte ?? row.fs ?? 0),
    addedAt: Number(row.tp || row.user_pptime || 0) || 0,
    updatedAt: Number(row.te || row.user_utime || 0) || 0,
    sha1: String(row.sha || row.sha1 || row.file_sha1 || "").toUpperCase(),
  };
  if (!validId(entry.id) || !validId(entry.parentId) || !entry.name) throw new Error("115 文件信息不完整");
  const video = !directory && VIDEO_EXT.test(entry.name);
  const durationSeconds = Number(row.play_long);
  const durationMs = video && Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : 0;
  return { ...entry, video, durationMs };
}

function pageQuery(parentId, offset, sort, pageSize = PAGE_SIZE) {
  if (!validId(parentId) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("目录参数无效");
  const order = SORT_ORDERS.get(sort);
  if (!order) throw new Error("115 排序方式无效");
  const [o, asc] = order;
  return new URLSearchParams({ cid: parentId, offset: String(offset), limit: String(pageSize), aid: "1", show_dir: "1", o, asc, fc_mix: "0", format: "json" });
}

function readPage(value, offset, search = false) {
  const total = Number(value.count);
  const rows = value.data ?? (search && total === 0 ? [] : null);
  const returnedOffset = Number(value.offset ?? (search && total === 0 ? offset : NaN));
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total < 0 || returnedOffset !== offset) {
    throw new Error("115 分页信息不完整，请刷新后重试");
  }
  if ((!rows.length && offset < total) || offset + rows.length > total) {
    throw new DirectoryListingChanged("115 计数不一致，请稍后重试");
  }
  return { entries: rows.map(decodeDriveEntry), total, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null };
}

function readFolderPath(value, parentId) {
  if (!Array.isArray(value.path)) return null;
  const path = value.path.map((item) => ({ id: idText(item?.cid), name: String(item?.name || "") }));
  if (path[0]?.id !== "0" || path[path.length - 1]?.id !== parentId || path.some((item) => !validId(item.id) || !item.name)) return null;
  return path;
}

export function cloudSubtitleName(videoName, subtitleName, matchVideoName = true, version) {
  const ext = String(subtitleName).match(/\.(srt|ass|ssa|vtt|sub)$/i)?.[0];
  if (!ext || !VIDEO_EXT.test(videoName) || /[\r\n/\\\x00]/.test(videoName) || /[\r\n/\\\x00]/.test(subtitleName)) throw new Error("视频或字幕文件名无效");
  const name = matchVideoName ? videoName.replace(/\.[^.]+$/, "") + ext.toLowerCase() : subtitleName;
  if (!Number.isSafeInteger(version) || version < 2) return name;
  return `${name.slice(0, -ext.length)}.v${version}${name.slice(-ext.length)}`;
}

// Cookie 只留在当前服务进程中，既不返回网页，也不写入磁盘。
export class Drive115 {
  constructor(fetcher = driveFetch) {
    this.fetcher = fetcher;
    this.session = null;
    this.pending = null;
    this.writes = new Map();
    this.folderWrites = new Map();
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
    const responseCode = Number(value.code ?? NaN);
    const status = value.data?.status ?? value.status;
    // 115 的长轮询超时会返回 code=0 且缺少状态，同一个二维码仍可继续扫码。
    if (responseCode === 90038 || (responseCode === 0 && status == null)) return { status: "waiting" };
    if (responseCode === 40199002) return { status: "expired" };
    const code = Number(status);
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

  async list(parentId = "0", offset = 0, sort = "name-asc", { pageSize = PAGE_SIZE, suffix = "" } = {}) {
    const query = pageQuery(parentId, offset, sort, pageSize);
    query.set("custom_order", "1");
    if (suffix) {
      query.set("suffix", suffix);
      query.set("show_dir", "0");
      query.set("cur", "1");
      query.set("record_open_time", "0");
    }
    const value = await this.json(`https://webapi.115.com/files?${query}`);
    const path = readFolderPath(value, String(parentId));
    if (suffix && (String(value.suffix ?? "").replace(/^\./, "").toLowerCase() !== suffix ||
        (idText(value.cid) !== String(parentId) && !path))) throw new SubtitleFilterUnavailable();
    const page = readPage(value, offset);
    if (suffix && page.entries.some((entry) => entry.directory || entry.parentId !== String(parentId) ||
        !entry.name.toLowerCase().endsWith(`.${suffix}`))) throw new SubtitleFilterUnavailable();
    if (page.entries.some((item) => item.parentId !== String(parentId))) throw new Error("115 返回了其他目录的文件");
    const hasPriorityEntries = Number(value.sys_count) > 0 || value.data.some((row) => Number(row.is_top) === 1);
    return { ...page, path, hasPriorityEntries };
  }

  async browse(parentId = "0", offset = 0, sort = "name-asc") {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("目录参数无效");
    const first = await this.list(parentId, 0, sort);
    if (parentId !== "0" && !first.hasPriorityEntries) return offset ? this.list(parentId, offset, sort) : first;

    // 115 会把置顶项和系统目录提前。将它们和同目录其他条目一起排序，再分页。
    const entries = await this.allEntries(parentId, first, sort);
    const [, asc, timeField] = SORT_ORDERS.get(sort);
    const direction = asc === "1" ? 1 : -1;
    entries.sort((a, b) => {
      if (a.directory !== b.directory) return a.directory ? -1 : 1;
      if (timeField) {
        const left = a[timeField];
        const right = b[timeField];
        if (Boolean(left) !== Boolean(right)) return left ? -1 : 1;
        if (left !== right) return direction * (left - right);
      }
      return direction * compareNames(a.name, b.name);
    });
    return { entries: entries.slice(offset, offset + PAGE_SIZE), total: entries.length, offset,
      nextOffset: offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null, path: first.path };
  }

  async search(parentId, text, offset = 0, sort = "name-asc") {
    const keyword = String(text ?? "").trim();
    if (!keyword || keyword.length > 120) throw new Error("请输入 1 至 120 个字符的 115 搜索词");
    const query = pageQuery(parentId, offset, sort);
    query.set("search_value", keyword);
    // 115 按文件名在指定目录及其子目录搜索，结果保留各自的父目录。
    return readPage(await this.json(`https://webapi.115.com/files/search?${query}`), offset, true);
  }

  async allEntries(parentId, firstPage, sort, options) {
    let page = firstPage || await this.list(parentId, 0, sort, options);
    const entries = [...page.entries];
    const total = page.total;
    while (page.nextOffset !== null) {
      page = await this.list(parentId, page.nextOffset, sort, options);
      if (total !== page.total) throw new DirectoryListingChanged("115 返回的分页总数不一致，请稍后重试");
      entries.push(...page.entries);
    }
    if (new Set(entries.map((item) => item.id)).size !== entries.length) throw new DirectoryListingChanged("115 目录分页重复");
    return entries;
  }

  async readFile(fileId) {
    if (!validId(fileId) || fileId === "0") throw new Error("115 文件 ID 无效");
    const value = await this.json(`https://webapi.115.com/files/get_info?file_id=${fileId}`);
    const data = Array.isArray(value.data) && value.data.length === 1 ? value.data[0] : value.data;
    if (!data || Array.isArray(data)) throw new Error("115 文件详情不可用");
    const ancestors = Array.isArray(data.paths) ? data.paths : [];
    const last = ancestors[ancestors.length - 1];
    const scoped = data.parent_id ?? data.category_id ?? data.cid ?? last?.file_id ?? last?.cid;
    const entry = decodeDriveEntry({ ...data, parent_id: scoped });
    if (entry.id !== fileId || entry.directory) throw new Error("115 返回的文件身份不一致");
    return entry;
  }

  async readSubtitleEntries(parentId, fileName, session) {
    let suffix = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
    let retried = false;
    while (true) {
      if (this.session !== session) throw new Error("115 登录已变更，请重新选择视频");
      try {
        const entries = await this.allEntries(parentId, undefined, "name-asc", { pageSize: SAVE_PAGE_SIZE, suffix });
        if (this.session !== session) throw new Error("115 登录已变更，请重新选择视频");
        return entries;
      } catch (error) {
        if (error instanceof SubtitleFilterUnavailable && suffix) {
          suffix = "";
          retried = false;
        } else if (error instanceof DirectoryListingChanged) {
          if (retried) throw new Error("暂时无法核对同名字幕，本次未上传，请稍后重试");
          retried = true;
        } else {
          throw error;
        }
      }
    }
  }

  async scanFolder(parentId, folderExclusionRules, folderName = "", { start = 1, end, videoExclusionRules = folderExclusionRules } = {}) {
    const session = this.session;
    if (!session) throw new Error("请先登录 115");
    if (!Number.isSafeInteger(start) || start < 1 || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
      throw new Error("请输入有效的扫描范围，结束位置不得小于起始位置");
    }
    const excludeFolder = createScanExclusionMatcher(folderExclusionRules);
    const excludeVideo = createScanExclusionMatcher(videoExclusionRules);
    const folders = [{ id: parentId, names: [] }];
    const visited = new Set();
    const files = [];
    let position = 0;
    while (folders.length) {
      const folder = folders.pop();
      if (visited.has(folder.id)) throw new Error("115 返回了重复目录，请刷新后重试");
      visited.add(folder.id);
      const entries = await this.allEntries(folder.id);
      if (this.session !== session) throw new Error("115 登录已变更，请重新选择文件夹");
      const subtitles = entries.filter((entry) => !entry.directory && SUBTITLE_EXTENSIONS.has(entry.name.match(/\.[^.]+$/)?.[0].toLowerCase())).map((entry) => entry.name);
      const parentNames = [folderName, ...folder.names].filter(Boolean);
      let matchSubtitles;
      for (const entry of entries) {
        const relativeNames = [...folder.names, entry.name];
        if (entry.directory) {
          if (excludeFolder(relativeNames.join("/"))) continue;
          folders.push({ id: entry.id, names: relativeNames });
        } else if (entry.video) {
          if (excludeVideo(relativeNames.join("/"))) continue;
          position += 1;
          if (position < start) continue;
          if (end !== undefined && position > end) return { files, truncated: true, accountId: session.id };
          matchSubtitles ??= createExistingSubtitleMatcher(subtitles, { parentNames });
          files.push({
            id: entry.id, parentId: entry.parentId, name: entry.name,
            path: `115:${entry.id}`, parentNames, durationMs: entry.durationMs,
            existingSubtitles: matchSubtitles(entry.name),
          });
        }
      }
    }
    return { files, truncated: false, accountId: session.id };
  }

  async save(video, payload, matchVideoName = true, accountId, version) {
    if (!this.session) throw new Error("请先登录 115");
    if (accountId && this.session.id !== accountId) throw new Error("115 登录账号已变更，请重新选择文件夹");
    if (!validId(video?.parentId) || !validId(video?.id)) throw new Error("请选择 115 视频");
    const session = this.session;
    const fileName = cloudSubtitleName(video.name, payload.fileName, matchVideoName, version);
    const folderKey = `${session.id}/${video.parentId}`;
    const key = `${folderKey}/${fileName}`;
    if (this.writes.has(key)) throw new Error(this.writes.get(key) === "unknown" ? "上次上传结果不明，请先到 115 核对，当前会话不重复上传该文件" : "该字幕正在上传");
    this.writes.set(key, "checking");
    // 同一目录逐个完成检查、上传和读回，避免批量任务互相影响。
    const previous = this.folderWrites.get(folderKey);
    let releaseFolder;
    const completion = new Promise((resolve) => { releaseFolder = resolve; });
    this.folderWrites.set(folderKey, completion);
    let submitted = false;
    try {
      await previous;
      if (this.session !== session) throw new Error("115 登录已变更，请重新选择视频");
      const current = await this.readFile(video.id);
      if (!current.video || current.name !== video.name || current.parentId !== video.parentId) throw new Error("115 视频已移动或更名，请重新选择");
      const entries = await this.readSubtitleEntries(video.parentId, fileName, session);
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
      const response = await this.request(host.href, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(chunks) }, false);
      const sha1 = createHash("sha1").update(payload.buffer).digest("hex").toUpperCase();
      const matches = (entry) => entry.parentId === video.parentId && entry.name === fileName &&
        entry.size === payload.buffer.length && entry.sha1 === sha1;
      const receipt = await response.json().catch(() => null);
      const fileId = idText(success(receipt?.state) ? receipt?.data?.file_id ?? "" : "");
      let saved;
      if (validId(fileId) && fileId !== "0") {
        if (this.session !== session) throw new Error("115 登录已变更");
        saved = await this.readFile(fileId).catch(() => null);
        if (saved && !matches(saved)) throw new Error("115 回执文件与上传内容不符");
      }
      if (!saved) {
        const found = (await this.readSubtitleEntries(video.parentId, fileName, session)).filter(matches);
        if (found.length !== 1) throw new Error("上传后未核对到唯一的同内容字幕");
        [saved] = found;
      }
      if (this.session !== session) throw new Error("115 登录已变更");
      this.writes.delete(key);
      return { saved: true, fileName, id: saved.id, parentId: video.parentId };
    } catch (error) {
      if (submitted) {
        this.writes.set(key, "unknown");
        throw new Error("上传结果不明，请先到 115 核对；未自动重试");
      }
      this.writes.delete(key);
      throw error;
    } finally {
      if (this.folderWrites.get(folderKey) === completion) this.folderWrites.delete(folderKey);
      releaseFolder();
    }
  }
}
