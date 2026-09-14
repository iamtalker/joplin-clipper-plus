// Injected into the page on demand. Runs Readability + Turndown and returns
// structured clip data to the caller via the return value of executeScript.

// Some sites bury the real post inside a page where a *different* block (a
// sidebar, or a huge "other posts" list) has more raw text than the actual
// content, so Readability's text-density scoring picks the wrong container
// entirely. For those, skip Readability and point straight at the known
// content selector instead. Add more entries here as new sites come up.
// A selector may match several separate elements (e.g. title + author + body
// live in three different siblings) — every match is kept, in document order.
const SITE_CONTENT_SELECTORS = {
  "gall.dcinside.com": ".view_content_wrap",
  "m.dcinside.com": ".thum-txt, .view_content_wrap",
  "www.clien.net": ".post_title, .post_author, .post_view",
  // Image-macro posts here have almost no text, so Readability's density
  // scoring often finds no article at all and fails outright.
  "www.ppomppu.co.kr": ".board-contents",
  // Skips the verbose writerInfoContainer meta block (post id, IP, permalink,
  // recommend/view/comment counts) and the "추천한 분들" list + legend footer —
  // title and body live in their own separate siblings anyway.
  "www.todayhumor.co.kr": ".viewSubjectDiv, .viewContent",
  // Gnuboard-based site: Readability was grabbing a big ad/category-link
  // sidebar plus the usual prev/next/list nav instead of the actual post
  // (a single image), so point straight at the real content div.
  "qquing.net": "#bo_v_con",
  // Readability grabbed the whole page shell — like/clip/report buttons,
  // a bandwidth-savings widget, comments, and the "other issues" list table —
  // instead of just the title + post image.
  "aagag.com": "h1.title, #vContent",
  // Readability (running on the iframe doc via SITE_IFRAME_SELECTORS below)
  // was pulling in a "공지 목록" (notices) widget along with the real post.
  // Naver's SmartEditor ONE wraps just the actual post body in this class.
  "blog.naver.com": ".se-main-container",
};

// Naver Blog (and similar sites) don't put the real post in the top-level
// page at all — the whole content area is a same-origin <iframe> that loads
// a *different* URL (blog.naver.com/PostView.naver?...). Our content script
// only ever sees the top-level document, so Readability found nothing to
// parse there. Since the iframe is same-origin, its contentDocument is
// directly readable — jcpGetEffectiveDoc() swaps in that inner document (and
// its own URL, for resolving relative links/images) wherever a matching
// hostname is configured here.
const SITE_IFRAME_SELECTORS = {
  "blog.naver.com": "#mainFrame",
};

function jcpGetEffectiveDoc() {
  const sel = SITE_IFRAME_SELECTORS[location.hostname];
  if (!sel) return { doc: document, baseUrl: location.href };
  const iframe = document.querySelector(sel);
  if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
    return { doc: iframe.contentDocument, baseUrl: iframe.contentDocument.location.href };
  }
  return { doc: document, baseUrl: location.href };
}

// Extra elements to strip out of a SITE_CONTENT_SELECTORS match — post-footer
// widgets (recommend buttons, attachment file lists, related-gallery boxes,
// ad slots) that live inside the content container but aren't part of the post.
const SITE_CLEANUP_SELECTORS = {
  "gall.dcinside.com": [
    ".btn_recommend_box",
    ".appending_file_box",
    "[id^='sch_alliance_box']",
    ".adsbygoogle",
    "ins.adsbygoogle",
  ],
};

// Icon+number counters (comment/like buttons etc.) whose real label lives in
// a `title` tooltip attribute, not in the visible text — so on their own they
// clip down to a bare, unlabeled number. Matching elements are replaced with
// plain text taken from their `title` (and un-linked, since the href is just
// an in-page anchor that means nothing once clipped).
const SITE_LABEL_FROM_TITLE_SELECTORS = {
  "www.clien.net": [".post_reply", ".post_symph"],
};

// The tab-screenshot fallback (see jcpCaptureImageViaTab) is a last resort for
// sites whose image CDN blocks CORS entirely — confirmed necessary for
// DCinside. It's expensive (scrolling, temporary zoom) and risks grabbing page
// chrome that happens to overlap the image (e.g. a sticky category label on a
// news site), so it's only attempted on sites known to actually need it rather
// than for every CORS failure everywhere.
const SCREENSHOT_FALLBACK_HOSTS = new Set([
  "gall.dcinside.com",
  "m.dcinside.com",
  "www.ppomppu.co.kr",
  "www.todayhumor.co.kr",
  "aagag.com",
]);

// script/style/template content has no Markdown representation, but Turndown
// doesn't drop it by default — it just walks into every element and includes
// its text. Sites that keep inline <script> blocks inside the post body (image
// numbering widgets, ad loaders, etc. — DCinside does this) leak raw JS into
// the clip unless we strip these out before conversion.
function jcpStripNonContentTags(root) {
  root.querySelectorAll("script, style, noscript, template, link[rel='stylesheet']").forEach((el) => el.remove());
  return root;
}

function jcpAbsolutize(root, baseUrl) {
  root.querySelectorAll("[src]").forEach((el) => {
    const v = el.getAttribute("src");
    if (v) {
      try { el.setAttribute("src", new URL(v, baseUrl).href); } catch (e) {}
    }
  });
  root.querySelectorAll("[href]").forEach((el) => {
    const v = el.getAttribute("href");
    if (v) {
      try { el.setAttribute("href", new URL(v, baseUrl).href); } catch (e) {}
    }
  });
  root.querySelectorAll("[srcset]").forEach((el) => {
    const v = el.getAttribute("srcset");
    if (v) {
      const resolved = v
        .split(",")
        .map((part) => {
          const [url, size] = part.trim().split(/\s+/);
          try {
            return new URL(url, baseUrl).href + (size ? " " + size : "");
          } catch (e) {
            return part;
          }
        })
        .join(", ");
      el.setAttribute("srcset", resolved);
    }
  });
  return root;
}

function jcpApplyTitleLabels(root, selectors) {
  if (!selectors || !selectors.length) return;
  root.querySelectorAll(selectors.join(",")).forEach((el) => {
    const label = el.getAttribute("title");
    if (!label) return;
    const span = document.createElement("span");
    span.textContent = label;
    el.replaceWith(span);
  });
}

// Strips common Korean bulletin-board (Gnuboard-style) chrome — prev/next/list
// nav links and "author | date | 조회 N" meta lines — that Readability's
// scoring sometimes keeps because it sits right next to the real post body.
function jcpStripBoardChrome(root) {
  const NAV_LABEL = /^(이전\s*\S*글?|다음\s*\S*글?|목록|랜덤\s*\S*|list|prev(ious)?|next)$/i;
  root.querySelectorAll("p, div, li, ul, nav").forEach((el) => {
    const text = el.textContent.trim();
    if (!text || text.length > 60) return;
    const links = el.querySelectorAll("a");
    if (links.length === 0) return;
    const linkTexts = Array.from(links).map((a) => a.textContent.trim()).filter(Boolean);
    if (linkTexts.length && linkTexts.every((t) => NAV_LABEL.test(t))) {
      el.remove();
    }
  });
  root.querySelectorAll("p, div, span, li").forEach((el) => {
    if (!el.isConnected) return;
    const text = el.textContent.trim();
    if (
      text.length < 80 &&
      /조회\s*\d+/.test(text) &&
      /\d{4}[.\-]\s?\d{1,2}[.\-]\s?\d{1,2}/.test(text)
    ) {
      el.remove();
    }
  });
  return root;
}

// Korean wire services (머니투데이, 뉴시스, 이데일리, ...) append a "[XX 주요뉴스]"
// related-headlines block plus a copyright line directly inside the article
// body HTML, with no wrapping container of their own — just trailing siblings
// after the real article text. Because it's baked into the syndicated HTML
// itself, the same trailer shows up verbatim on every portal that republishes
// that wire's content (Nate, Naver, Daum, ...), so this is handled generically
// instead of per-site.
function jcpStripTrailingWireFooter(root) {
  const marker = Array.from(root.querySelectorAll("b, strong, h3, h4, p")).find((el) =>
    /^\[.{1,20}(주요\s*뉴스|헤드라인)\]$/.test(el.textContent.trim())
  );
  if (marker) {
    let node = marker;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toRemove = [];
  let n;
  while ((n = walker.nextNode())) {
    if (/ⓒ\s*.+(무단\s*전재|재배포|AI\s*학습)/.test(n.textContent)) toRemove.push(n);
  }
  toRemove.forEach((t) => t.remove());
  return root;
}

// Embedded <iframe> players (YouTube, etc.) have no Markdown representation
// and Turndown just drops them. Joplin's renderer will auto-embed a YouTube
// video, but ONLY if the URL sits completely alone on its own line — wrapping
// it in a [text](url) link, or leaving other text on the line, disables the
// auto-embed. So each matching iframe is swapped for a plain-text placeholder
// paragraph pre-conversion, then patched to the bare URL post-conversion —
// going through a placeholder avoids Turndown's text-escaping (it backslash-
// escapes underscores etc., which would corrupt a video ID written directly).
function jcpYoutubeIdFromEmbedUrl(src) {
  try {
    const u = new URL(src, location.href);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const m = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    if (host === "youtu.be") {
      const m = u.pathname.match(/^\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

function jcpExtractVideoPlaceholders(root) {
  const ids = [];
  root.querySelectorAll("iframe[src]").forEach((iframe) => {
    const id = jcpYoutubeIdFromEmbedUrl(iframe.getAttribute("src"));
    if (!id) return;
    const idx = ids.push(id) - 1;
    const p = document.createElement("p");
    p.textContent = `JCPVIDEOPLACEHOLDERx${idx}xENDPLACEHOLDER`;
    iframe.replaceWith(p);
  });
  return ids;
}

function jcpApplyVideoPlaceholders(markdown, ids) {
  let result = markdown;
  ids.forEach((id, idx) => {
    result = result.replace(
      `JCPVIDEOPLACEHOLDERx${idx}xENDPLACEHOLDER`,
      `https://www.youtube.com/watch?v=${id}`
    );
  });
  return result;
}

function jcpBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Lazy-loading gallery scripts (DCinside included, once a post has more than a
// couple of images) leave the real image URL in data-original/data-src and only
// swap it into src once the image scrolls near the viewport. Reading src alone
// misses any image that hasn't been scrolled to yet.
function jcpRealImgUrl(img) {
  return img.getAttribute("data-original") || img.getAttribute("data-src") || img.getAttribute("src") || "";
}

// Wait for the live page's own lazy-load script to swap the real image into
// src and finish loading it, so a tab-capture screenshot doesn't just grab
// a placeholder. Gives up after timeoutMs and captures whatever is there.
async function jcpWaitForRealSrc(liveEl, targetAbsUrl, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = liveEl.getAttribute("src") || "";
    let curAbs;
    try {
      curAbs = new URL(cur, location.href).href;
    } catch (e) {
      curAbs = cur;
    }
    if (curAbs === targetAbsUrl && liveEl.complete && liveEl.naturalWidth > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Some image CDNs (DCinside's dcimg*.dcinside.co.kr included) allow the browser
// to *display* an <img> but refuse CORS entirely, so fetch() can never read the
// bytes ("TypeError: Failed to fetch") no matter what Referer/credentials we
// send. As a last resort we screenshot the real, already-rendered <img> on the
// live page — a screen capture is plain pixel data, so it isn't subject to the
// CORS check that blocks fetch() at all.
//
// Images taller than one viewport can't fit in a single screenshot. An earlier
// version captured several scrolled segments and stitched them into one canvas,
// but any sub-pixel drift between the scroll position we measured and the
// scroll position at actual capture time left a visible seam at the join. Zooming
// the tab out until the whole image fits avoids that entirely, at the cost of
// some resolution on very tall images.
async function jcpCaptureImageViaTab(liveImgEl, targetAbsUrl) {
  if (!liveImgEl) return null;

  liveImgEl.scrollIntoView({ block: "start", inline: "center" });
  await new Promise((r) => setTimeout(r, 150));
  if (targetAbsUrl) await jcpWaitForRealSrc(liveImgEl, targetAbsUrl, 4000);

  const zoomRes = await chrome.runtime.sendMessage({ type: "getZoom" });
  const originalZoom = (zoomRes && zoomRes.zoom) || 1;
  let appliedZoom = originalZoom;

  try {
    let rect = liveImgEl.getBoundingClientRect();
    const fitHeight = window.innerHeight * 0.92;
    if (rect.height > fitHeight) {
      const targetZoom = Math.max(0.3, originalZoom * (fitHeight / rect.height));
      await chrome.runtime.sendMessage({ type: "setZoom", factor: targetZoom });
      appliedZoom = targetZoom;
      await new Promise((r) => setTimeout(r, 350));
      liveImgEl.scrollIntoView({ block: "start", inline: "center" });
      await new Promise((r) => setTimeout(r, 150));
      rect = liveImgEl.getBoundingClientRect();
    }

    const dpr = window.devicePixelRatio || 1;
    const visTop = Math.max(0, rect.top);
    const visBottom = Math.min(window.innerHeight, rect.bottom);
    if (rect.width < 1 || visBottom - visTop < 1) return null;

    const res = await chrome.runtime.sendMessage({
      type: "captureImageRect",
      rect: { x: rect.left, y: visTop, width: rect.width, height: visBottom - visTop, dpr },
    });
    return res && res.ok ? res.dataUrl : null;
  } finally {
    if (appliedZoom !== originalZoom) {
      await chrome.runtime.sendMessage({ type: "setZoom", factor: originalZoom });
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function jcpFindLiveImg(absSrc, baseUrl) {
  return Array.from(document.querySelectorAll("img")).find((el) => {
    try {
      return new URL(jcpRealImgUrl(el), baseUrl).href === absSrc;
    } catch (e) {
      return false;
    }
  });
}

async function jcpInlineImages(root, baseUrl) {
  const MAX_BYTES = 6 * 1024 * 1024;
  const MAX_TAB_CAPTURES = 20; // captureVisibleTab is rate-limited; cap the fallback
  const imgs = Array.from(root.querySelectorAll("img[src], img[data-original], img[data-src]"));
  let tabCaptures = 0;

  for (const img of imgs) {
    const src = jcpRealImgUrl(img);
    if (!src || src.startsWith("data:")) continue;
    let abs;
    try {
      abs = new URL(src, baseUrl).href;
    } catch (e) {
      continue;
    }

    // An https page can never fetch() a plain-http URL — the browser blocks it
    // as mixed content before our code even sees it, logging a console error
    // in the process. Skip the doomed attempt outright and go straight to the
    // tab-capture fallback instead of triggering that warning for nothing.
    const isMixedContent = location.protocol === "https:" && abs.startsWith("http://");

    let dataUrl = null;
    if (!isMixedContent) {
      try {
        const res = await fetch(abs, { credentials: "include" });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 0 && blob.size <= MAX_BYTES) {
            dataUrl = await jcpBlobToDataUrl(blob);
          }
        }
      } catch (e) {
        // Likely CORS-blocked; fall through to the tab-capture fallback below.
      }
    }

    if (!dataUrl && tabCaptures < MAX_TAB_CAPTURES && SCREENSHOT_FALLBACK_HOSTS.has(location.hostname)) {
      try {
        const liveEl = jcpFindLiveImg(abs, baseUrl);
        dataUrl = await jcpCaptureImageViaTab(liveEl, abs);
        tabCaptures++;
      } catch (e) {
        // Give up on this image; the original (likely broken) URL stays.
      }
    }

    if (dataUrl) {
      img.setAttribute("src", dataUrl);
      img.removeAttribute("srcset");
      img.removeAttribute("data-original");
      img.removeAttribute("data-src");
    }
  }
  return root;
}

function jcpMakeTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  if (typeof turndownPluginGfm !== "undefined") {
    td.use(turndownPluginGfm.gfm);
  }
  td.remove(["script", "style", "noscript", "template"]);
  return td;
}

function jcpPageMeta() {
  const getMeta = (name) => {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute("content") : null;
  };
  const favicon =
    document.querySelector('link[rel="icon"]') ||
    document.querySelector('link[rel="shortcut icon"]');
  return {
    title: document.title,
    url: location.href,
    description: getMeta("og:description") || getMeta("description") || "",
    image: getMeta("og:image") || "",
    favicon: favicon ? new URL(favicon.getAttribute("href"), location.href).href : "",
  };
}

async function jcpClipArticle() {
  const { doc: effectiveDoc, baseUrl } = jcpGetEffectiveDoc();
  const overrideSelector = SITE_CONTENT_SELECTORS[location.hostname];
  const overrideEls = overrideSelector ? Array.from(effectiveDoc.querySelectorAll(overrideSelector)) : [];

  let article;
  if (overrideEls.length) {
    const container = document.createElement("div");
    overrideEls.forEach((el) => container.appendChild(el.cloneNode(true)));
    jcpAbsolutize(container, baseUrl);
    jcpStripNonContentTags(container);
    const cleanupSelectors = SITE_CLEANUP_SELECTORS[location.hostname];
    if (cleanupSelectors && cleanupSelectors.length) {
      container.querySelectorAll(cleanupSelectors.join(",")).forEach((el) => el.remove());
    }
    jcpApplyTitleLabels(container, SITE_LABEL_FROM_TITLE_SELECTORS[location.hostname]);
    article = { title: document.title, content: container.innerHTML, excerpt: "", byline: "" };
  } else {
    const docClone = effectiveDoc.cloneNode(true);
    jcpAbsolutize(docClone, baseUrl);
    jcpStripBoardChrome(docClone);
    article = new Readability(docClone).parse();
    if (!article) return { error: "Readability could not parse this page." };
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = article.content;
  jcpStripNonContentTags(wrapper);
  jcpStripTrailingWireFooter(wrapper);
  const videoIds = jcpExtractVideoPlaceholders(wrapper);
  await jcpInlineImages(wrapper, baseUrl);
  const td = jcpMakeTurndown();
  const markdown = jcpApplyVideoPlaceholders(td.turndown(wrapper.innerHTML), videoIds);
  return {
    mode: "article",
    title: article.title || document.title,
    markdown,
    html: wrapper.innerHTML,
    excerpt: article.excerpt || "",
    byline: article.byline || "",
    url: location.href,
  };
}

async function jcpClipFullPage() {
  const clone = document.documentElement.cloneNode(true);
  jcpAbsolutize(clone, location.href);
  clone.querySelectorAll("script, noscript").forEach((el) => el.remove());
  await jcpInlineImages(clone, location.href);
  return {
    mode: "full",
    title: document.title,
    html: "<!DOCTYPE html>" + clone.outerHTML,
    url: location.href,
  };
}

async function jcpClipSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return { error: "No text is selected on the page." };
  }
  const container = document.createElement("div");
  for (let i = 0; i < sel.rangeCount; i++) {
    container.appendChild(sel.getRangeAt(i).cloneContents());
  }
  jcpAbsolutize(container, location.href);
  jcpStripNonContentTags(container);
  const videoIds = jcpExtractVideoPlaceholders(container);
  await jcpInlineImages(container, location.href);
  const td = jcpMakeTurndown();
  const markdown = jcpApplyVideoPlaceholders(td.turndown(container.innerHTML), videoIds);
  return {
    mode: "selection",
    title: document.title,
    markdown,
    html: container.innerHTML,
    url: location.href,
  };
}

function jcpClipBookmark() {
  const meta = jcpPageMeta();
  return { mode: "bookmark", ...meta };
}

async function jcpRunClip(mode) {
  switch (mode) {
    case "article":
      return jcpClipArticle();
    case "full":
      return jcpClipFullPage();
    case "selection":
      return jcpClipSelection();
    case "bookmark":
      return jcpClipBookmark();
    default:
      return { error: "Unknown clip mode: " + mode };
  }
}

// The background script injects this file then calls jcpRunClip(mode)
// as the injected function's return expression via a second exec call,
// but to keep it to a single injection we expose it on window.
window.__jcpRunClip = jcpRunClip;
