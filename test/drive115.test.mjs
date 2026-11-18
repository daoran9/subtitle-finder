import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Drive115, LOGIN_APPS, cloudSubtitleName, decodeDriveEntry } from "../lib/drive115.mjs";
import { startServer } from "../server.mjs";

const video = { id: "42", parentId: "7", name: "测试 JAC-090.1080p.mkv" };
const payload = { fileName: "download.zh-TW.srt", buffer: Buffer.from("1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n") };
const videoRow = { fid: "42", cid: "7", n: video.name, s: 900, sha: "VIDEO" };
const APP_CODES = { web: "A1", ios: "D1", "115ios": "D3", android: "F1", "115ipad": "H3", tv: "I1", apple_tv: "I2", qios: "N1", os_windows: "P1", os_linux: "P3", wechatmini: "R1", alipaymini: "R2", harmony: "S1" };
const QR_PLATFORMS = { web: /Windows NT/, ios: /\(iPhone;/, "115ios": /\(iPhone;/, android: /Android/, "115ipad": /\(iPad;/, tv: /Android/, apple_tv: /Apple TV.*tvOS/, qios: /\(iPhone;/, os_windows: /Windows NT/, os_linux: /X11; Linux/, wechatmini: /iPhone.*MicroMessenger/, alipaymini: /iPhone.*AlipayClient/, harmony: /HarmonyOS/ };

function fixture({ failUpload = false, existing = false, changedVideo = false, host = "https://bucket.oss-cn-shenzhen.aliyuncs.com/", wrongReadback = false, returnedApp = null, savedName = "测试 JAC-090.1080p.srt", directories } = {}) {
  const calls = [];
  let uploaded = false;
  const uploadedRow = { fid: "43", cid: "7", n: savedName, s: payload.buffer.length, sha: createHash("sha1").update(payload.buffer).digest("hex") };
  const fetcher = async (address, options = {}) => {
    const url = new URL(address);
    calls.push({ url, options });
    let value;
    if (url.pathname.endsWith("/token/")) value = { state: true, data: { uid: "QR-ONLY", time: 123, sign: "SIGN-ONLY" } };
    else if (url.pathname === "/get/status/") value = { state: true, data: { status: 2 } };
    else if (url.pathname.endsWith("/qrcode")) return { ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => Buffer.from("fixture image") };
    else if (url.pathname.endsWith("/login/qrcode/")) {
      let app = url.pathname.split("/")[3];
      if (app === "ios") app = options.headers["user-agent"] === "OfficePhone/1.0.0" ? "qios" : options.headers["user-agent"] === "UPhone/1.0.0" ? "ios" : "web";
      value = { state: true, data: { cookie: { UID: `123_${APP_CODES[returnedApp || app]}_1`, CID: "COOKIE-CID", SEID: "COOKIE-SEID" } } };
    }
    else if (url.hostname === "my.115.com") value = { state: true, data: { user_id: "123", user_name: "测试账号" } };
    else if (url.pathname === "/files") {
      const offset = Number(url.searchParams.get("offset"));
      const rows = directories ? directories[url.searchParams.get("cid")] : [{ ...videoRow, n: changedVideo ? "renamed.mkv" : video.name }];
      if (!directories && (existing || uploaded)) rows.push({ ...uploadedRow, sha: wrongReadback ? "WRONG" : uploadedRow.sha });
      value = { state: true, offset, count: rows.length, data: directories ? rows.slice(offset, offset + 2) : rows };
    } else if (url.hostname === "uplb.115.com") value = { host, object: "object", policy: "policy", accessid: "access", callback: "callback", signature: "signature" };
    else if (url.hostname.endsWith(".aliyuncs.com")) {
      if (failUpload) throw new Error("network failure with secret URL");
      uploaded = true; value = { state: true };
    } else throw new Error(`Unexpected fixture request ${url.hostname}${url.pathname}`);
    return { ok: true, status: 200, json: async () => value };
  };
  const drive = new Drive115(fetcher);
  async function login(app = "ios") { const token = await drive.begin(app); await drive.qrImage(token.id); await drive.poll(token.id); return token; }
  return { drive, calls, login, fetcher };
}

test("13 种端的二维码、凭据换取与返回端一致，页面不接收 Cookie", async () => {
  assert.equal(LOGIN_APPS.length, 13);
  for (const app of LOGIN_APPS) {
    const { drive, calls, login } = fixture();
    await login(app.id);
    assert.equal(calls[0].url.pathname, `/api/1.0/${app.id}/1.0/token/`);
    const image = calls.find((call) => call.url.pathname.endsWith("/qrcode"));
    assert.equal(image.url.pathname, `/api/1.0/${app.id}/1.0/qrcode`);
    assert.equal(image.url.searchParams.has("client"), false);
    const status = calls.find((call) => call.url.pathname === "/get/status/");
    for (const request of [calls[0], image, status]) {
      assert.match(request.options.headers["user-agent"], QR_PLATFORMS[app.id]);
      assert.equal(request.options.headers["user-agent"], calls[0].options.headers["user-agent"]);
      assert.equal(request.options.headers.cookie, undefined);
    }
    const exchange = calls.find((call) => call.url.hostname === "passportapi.115.com");
    const endpointApp = app.id === "qios" ? "ios" : app.id;
    assert.equal(exchange.url.pathname, `/app/1.0/${endpointApp}/1.0/login/qrcode/`);
    assert.equal(new URLSearchParams(exchange.options.body).get("app"), endpointApp);
    if (app.id === "ios") assert.equal(exchange.options.headers["user-agent"], "UPhone/1.0.0");
    if (app.id === "qios") assert.equal(exchange.options.headers["user-agent"], "OfficePhone/1.0.0");
    assert.deepEqual(drive.status().account, { id: "123", name: "测试账号", app: app.id });
    assert.doesNotMatch(JSON.stringify(drive.status()), /COOKIE-|SEID|SIGN-ONLY/);
  }
});

test("选择非网页端却返回网页凭据时拒绝成功，不保存或显示错误登录端", async () => {
  const { drive, login, calls } = fixture({ returnedApp: "web" });
  for (const app of LOGIN_APPS.filter((item) => item.id !== "web")) {
    await assert.rejects(login(app.id), /115生活 · 网页.*不一致.*未保存/);
    assert.equal(drive.status().account, null);
  }
  assert.ok(!calls.some((call) => call.url.hostname === "my.115.com"));
  await assert.rejects(drive.list(), /先登录/);
});

test("返回未知端的凭据时拒绝登录且不泄漏凭据", async () => {
  const { drive, login, fetcher } = fixture();
  drive.fetcher = async (url, options) => new URL(url).pathname.endsWith("/login/qrcode/")
    ? { ok: true, json: async () => ({ state: true, data: { cookie: { UID: "123_Z9_SECRET", CID: "SECRET-CID", SEID: "SECRET-SEID" } } }) }
    : fetcher(url, options);
  await assert.rejects(login(), (error) => /无法识别.*未保存/.test(error.message) && !/SECRET/.test(error.message));
  assert.equal(drive.status().account, null);
});

test("二维码等待、过期和取消不触发登录换取", async () => {
  for (const [value, status] of [[{ code: 90038, state: false }, "waiting"], [{ code: 40199002 }, "expired"], [{ data: { status: -2 } }, "canceled"]]) {
    const { drive, fetcher, calls } = fixture();
    drive.fetcher = async (url, options) => new URL(url).pathname === "/get/status/" ? { ok: true, json: async () => value } : fetcher(url, options);
    const token = await drive.begin("android");
    assert.equal((await drive.poll(token.id)).status, status);
    assert.ok(!calls.some((call) => call.url.hostname === "passportapi.115.com"));
  }
});

test("不接受未知登录端、旧二维码、失效会话和账号不符的凭据", async () => {
  const { drive, login, fetcher } = fixture();
  await assert.rejects(drive.begin("unknown"), /不支持/);
  const old = await drive.begin("ios");
  await drive.begin("web");
  await assert.rejects(drive.poll(old.id), /失效/);
  drive.fetcher = async (url, options) => new URL(url).hostname === "my.115.com" ? { ok: true, json: async () => ({ data: { user_id: "999" } }) } : fetcher(url, options);
  await assert.rejects(login(), /账号核对失败/);
  assert.equal(drive.status().account, null);
  drive.logout();
  await assert.rejects(drive.list(), /先登录/);
});

test("中文、多点视频名保持原主文件名，只替换字幕扩展名", () => {
  assert.equal(cloudSubtitleName(video.name, "source.zh-TW.ASS"), "测试 JAC-090.1080p.ass");
  assert.throws(() => cloudSubtitleName("../video.mp4", "source.srt"), /无效/);
  assert.throws(() => cloudSubtitleName("video.mp4", "error.html"), /无效/);
});

test("上传到视频原目录，OSS 不接收 Cookie，读回名称、字节数和 SHA1 后才报成功", async () => {
  const { drive, calls, login } = fixture(); await login("os_windows");
  const result = await drive.save(video, payload);
  assert.equal(result.fileName, "测试 JAC-090.1080p.srt");
  assert.equal(result.parentId, "7");
  const init = calls.find((call) => call.url.hostname === "uplb.115.com");
  assert.equal(new URLSearchParams(init.options.body).get("target"), "U_1_7");
  const upload = calls.find((call) => call.url.hostname.endsWith(".aliyuncs.com"));
  assert.equal(upload.options.headers.cookie, undefined);
  assert.ok(upload.options.body.includes(payload.buffer));
  assert.doesNotMatch(upload.options.body.toString(), /COOKIE-SEID/);
  assert.equal(calls.filter((call) => call.url.pathname === "/files").length, 2);
  assert.ok(!calls.some((call) => /rename|delete|copy/.test(call.url.pathname)));
});

test("同名字幕、视频更名和不可信上传地址都在上传前停止", async () => {
  for (const [options, error] of [[{ existing: true }, /已有/], [{ changedVideo: true }, /移动或更名/], [{ host: "https://evil.example/" }, /地址不受支持/]]) {
    const { drive, calls, login } = fixture(options); await login();
    await assert.rejects(drive.save(video, payload), error);
    assert.ok(!calls.some((call) => call.url.hostname.endsWith(".aliyuncs.com")));
  }
});

test("关闭按视频名保存后使用字幕名，并按所选名称检查冲突", async () => {
  const { drive, calls, login } = fixture({ savedName: payload.fileName });
  await login();
  const result = await drive.save(video, payload, false);
  assert.equal(result.fileName, payload.fileName);
  assert.equal(result.parentId, video.parentId);
  const init = calls.find((call) => call.url.hostname === "uplb.115.com");
  assert.equal(new URLSearchParams(init.options.body).get("filename"), payload.fileName);
  await assert.rejects(drive.save(video, payload, false), /已有/);
  assert.equal(calls.filter((call) => call.url.hostname === "uplb.115.com").length, 1);
});

test("上传超时或读回内容不符时报告结果不明，不自动或重复上传", async () => {
  for (const options of [{ failUpload: true }, { wrongReadback: true }]) {
    const { drive, calls, login } = fixture(options); await login();
    await assert.rejects(drive.save(video, payload), /结果不明/);
    await assert.rejects(drive.save(video, payload), /上次上传结果不明/);
    assert.equal(calls.filter((call) => call.url.hostname.endsWith(".aliyuncs.com")).length, 1);
  }
});

test("不完整目录及失去精度的文件 ID 不能成为上传依据", async () => {
  assert.throws(() => decodeDriveEntry({ ...videoRow, fid: Number.MAX_SAFE_INTEGER + 1 }), /不完整/);
  const { drive, login, fetcher, calls } = fixture(); await login();
  drive.fetcher = async (url, options) => new URL(url).pathname === "/files" ? { ok: true, json: async () => ({ state: true, offset: 0, count: 0, data: [videoRow] }) } : fetcher(url, options);
  await assert.rejects(drive.save(video, payload), /计数不一致/);
  assert.ok(!calls.some((call) => call.url.hostname === "uplb.115.com"));
});

test("两个同时保存请求只上传一次", async () => {
  const { drive, login, fetcher, calls } = fixture(); await login();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  drive.fetcher = async (url, options) => {
    if (new URL(url).hostname.endsWith(".aliyuncs.com")) { entered(); await gate; }
    return fetcher(url, options);
  };
  const first = drive.save(video, payload);
  await ready;
  await assert.rejects(drive.save(video, payload), /正在上传/);
  release();
  assert.equal((await first).saved, true);
  assert.equal(calls.filter((call) => call.url.hostname.endsWith(".aliyuncs.com")).length, 1);
});

test("115 HTTP 接口限制外部来源、写入方法及输入，退出清空当前账号", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "subtitle-115-test-"));
  const { fetcher } = fixture();
  const { server, url } = await startServer({ port: 0, dataDir, drive115Fetch: fetcher });
  try {
    const post = async (action, body) => fetch(`${url}/api/drive115/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${url}/api/drive115/status`, { headers: { origin: "https://outside.example" } })).status, 403);
    assert.equal((await fetch(`${url}/api/drive115/logout`)).status, 405);
    assert.equal((await fetch(`${url}/api/drive115/scan?parentId=7`)).status, 400);
    assert.equal((await fetch(`${url}/api/drive115/login`, { method: "POST", body: "app=ios" })).status, 415);
    const token = await (await post("login", { app: "harmony" })).json();
    assert.equal((await (await post("poll", token)).json()).status, "confirmed");
    const status = await (await fetch(`${url}/api/drive115/status`)).json();
    assert.equal(status.account.app, "harmony");
    assert.doesNotMatch(JSON.stringify(status), /COOKIE|SEID/);
    const scan = await (await fetch(`${url}/api/drive115/scan?parentId=7&folderName=Series`)).json();
    assert.equal(scan.files[0].parentId, "7");
    assert.equal(scan.accountId, "123");
    assert.equal((await post("save", { resultId: "missing" })).status, 404);
    await post("logout", {});
    assert.equal((await (await fetch(`${url}/api/drive115/status`)).json()).account, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("115 文件夹分页递归扫描，只用同目录字幕判定并遵守扫描排除规则", async () => {
  const { drive, login, calls } = fixture({ directories: {
    7: [videoRow, { fid: "43", cid: "7", n: "JAC-090.zh.srt" },
      { cid: "8", pid: "7", n: "Season 1" }, { cid: "9", pid: "7", n: "Extras" }],
    8: [{ fid: "50", cid: "8", n: "01.mp4" },
      { fid: "51", cid: "8", n: "02.mp4" }, { fid: "52", cid: "8", n: "02.srt" }],
  } });
  await login();
  const scan = await drive.scanFolder("7", ["Extras"], "Series");
  assert.deepEqual(scan.files.map(({ id, parentId, parentNames, existingSubtitles }) => [id, parentId, parentNames, existingSubtitles]), [
    ["42", "7", ["Series"], ["JAC-090.zh.srt"]],
    ["50", "8", ["Series", "Season 1"], []],
    ["51", "8", ["Series", "Season 1"], ["02.srt"]],
  ]);
  assert.equal(scan.truncated, false);
  assert.equal(calls.filter(({ url }) => url.pathname === "/files").length, 4);
  await assert.rejects(drive.save(video, payload, true, "999"), /登录账号已变更/);
});

test("115 名称、添加时间及更新时间升降序，搜索分页保留真实父目录", async () => {
  const { drive, login, fetcher } = fixture();
  await login();
  const folderPath = [{ cid: "0", name: "根目录" }, { cid: "7", name: "Series" }];
  const orders = [
    ["name-asc", "file_name", "1"], ["name-desc", "file_name", "0"],
    ["oldest", "user_ptime", "1"], ["newest", "user_ptime", "0"],
    ["updated-asc", "user_utime", "1"], ["updated-desc", "user_utime", "0"],
  ];
  const requests = [];
  drive.fetcher = async (address, options) => {
    const url = new URL(address);
    if (url.pathname === "/files") {
      requests.push(url.searchParams);
      return Response.json({ state: true, offset: 0, count: 1, data: [videoRow], path: folderPath });
    }
    if (url.pathname === "/files/search") {
      const offset = Number(url.searchParams.get("offset"));
      requests.push(url.searchParams);
      const rows = [{ cid: "9", pid: "8", n: "云 & + 文件夹" }, { fid: "71", cid: "9", n: "云 & + 视频.mkv" }];
      return Response.json({ state: true, offset, count: 2, data: rows.slice(offset, offset + 1) });
    }
    return fetcher(address, options);
  };
  for (const [sort, key, direction] of orders) {
    const { path } = await drive.list("7", 0, sort);
    assert.deepEqual(path, folderPath.map(({ cid, name }) => ({ id: cid, name })));
    const params = requests.at(-1);
    assert.deepEqual([params.get("o"), params.get("asc"), params.get("fc_mix"), params.get("custom_order")], [key, direction, "0", "1"]);
  }
  const first = await drive.search("7", " 云 & + ", 0, "updated-desc");
  assert.equal(first.nextOffset, 1);
  const second = await drive.search("7", "云 & +", first.nextOffset, "updated-desc");
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.entries, ...second.entries].map(({ directory, video, parentId }) => [directory, video, parentId]),
    [[true, false, "8"], [false, true, "9"]]);
  assert.deepEqual(requests.slice(-2).map((params) => [params.get("cid"), params.get("search_value"), params.get("show_dir"), params.get("o"), params.get("asc"), params.get("offset")]),
    [["7", "云 & +", "1", "user_utime", "0", "0"], ["7", "云 & +", "1", "user_utime", "0", "1"]]);
  await assert.rejects(drive.search("7", "   "), /搜索词/);
  await assert.rejects(drive.list("7", 0, "unknown"), /排序方式无效/);
});

test("115 浏览排序包含置顶项和系统目录，并在重新排序后分页", async () => {
  const { drive, login, fetcher } = fixture();
  await login();
  const rows = [
    { cid: "8", pid: "7", n: "Folder 101", tp: "101", te: "1", is_top: 1 },
    { cid: "9", pid: "7", n: "Folder 100", tp: "100", user_utime: "2" },
    ...Array.from({ length: 99 }, (_, index) => ({ cid: String(index + 10), pid: "7", n: `Folder ${index + 1}`, tp: index + 1, te: 101 - index })),
    { ...videoRow, tp: 1, te: 200, fid: "120" },
  ];
  drive.fetcher = async (address, options) => {
    const url = new URL(address);
    if (url.pathname !== "/files") return fetcher(address, options);
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ state: true, sys_count: 1, offset, count: rows.length, data: rows.slice(offset, offset + 79) });
  };
  for (const sort of ["name-asc", "oldest", "updated-desc"]) {
    const { entries, nextOffset } = await drive.browse("7", 0, sort);
    assert.equal(nextOffset, 100);
    assert.equal(entries[0].name, "Folder 1");
    assert.equal(entries.at(-1).name, "Folder 100");
    const next = await drive.browse("7", nextOffset, sort);
    assert.deepEqual(next.entries.map(item => item.name), ["Folder 101", video.name]);
  }
  for (const sort of ["name-desc", "newest", "updated-asc"]) {
    const { entries } = await drive.browse("7", 0, sort);
    assert.deepEqual(entries.slice(0, 2).map(item => item.name), ["Folder 101", "Folder 100"]);
    assert.equal(entries.at(-1).name, "Folder 2");
  }
});
