export function createSubtitleCatHtml(items) {
  return `<table class="sub-table"><tbody>${items.map((item) => `<tr>
    <td><a href="${item.href}">${item.title}</a> translated from en</td>
    <td>${item.comment === "none" ? "" : `<i class="fa-thumbs-${item.comment}"></i>`}</td>
    <td>${item.downloads} downloads</td>
  </tr>`).join("")}</tbody></table>`;
}

// 未登记的请求直接失败；测试既不依赖真实字幕站，也不允许回退到网络。
export function createFixtureRequest(fixture, { failedDownload = "", missingLanguage = false } = {}) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    const target = new URL(url);
    if (target.origin === "https://api-shoulei-ssl.xunlei.com" && target.pathname === "/oracle/subtitle") {
      return new Response(JSON.stringify(fixture.thunder), { headers: { "content-type": "application/json" } });
    }
    if (target.origin === "https://subtitlecat.com" && target.pathname === "/index.php") {
      return new Response(createSubtitleCatHtml(fixture.subtitlecat));
    }
    const item = fixture.subtitlecat.find((item) => new URL(item.href, "https://subtitlecat.com/").href === url);
    if (item) {
      return new Response(missingLanguage ? "<html></html>" : `<a id="download_${fixture.language}" href="/download/${item.href.split("/").at(-1)}.srt">Download</a>`);
    }
    if ((target.origin === "https://subtitlecat.com" && target.pathname.startsWith("/download/"))
      || fixture.thunder.data.some((item) => item.url === url)) {
      if (url === failedDownload) throw new Error("fixture download failed");
      return new Response("1\n00:00:01,000 --> 00:00:02,000\nFixture subtitle\n");
    }
    throw new Error(`Unmocked request: ${url}`);
  };
  return { request, calls };
}
