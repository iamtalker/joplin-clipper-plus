// Injected into the page on demand. Runs Readability + Turndown and returns
// structured clip data to the caller via the return value of executeScript.
//
// Wrapped in an IIFE because this file (along with the library files) gets
// re-injected into the same tab on every clip attempt without a page reload
// in between. chrome.scripting.executeScript's "isolated world" persists
// across separate injections, so top-level const/let declarations would
// throw "Identifier has already been declared" on the second clip — an
// uncaught SyntaxError that silently breaks the whole script, which is what
// made the popup hang on "Clipping…" forever with no error shown. Wrapping
// everything in a function scope means each injection gets its own fresh
// scope; only window.__jcpRunClip crosses that boundary, and reassigning it
// on each injection is harmless.
(function () {

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
  // Readability was grabbing the ~55,000-char comment thread instead of the
  // actual post (title metadata table + one attached photo). The site's own
  // template comment literally reads "게시물 이미지, 동영상 들어갈 테이블 시작".
  "web.humoruniv.com": "#cnts",
  // Readability was pulling in comments, ads, prev/next links, etc. The
  // actual post body (text + attached photos) is this one small div.
  "www.slrclub.com": "#userct",
  // Next.js-rendered site with a massive page shell (500k+ chars body) —
  // Readability grabbed comments, an "other posts" list, and category
  // filters. The real post is just the title heading plus this content div.
  "etoland.co.kr": "article h1, .view-content",
  // Readability was pulling in Inven's gamification widget (#inventory-skin-*,
  // a user-inventory/badge display, ~2800 chars) and a recommend-button block
  // alongside the actual post.
  "www.inven.co.kr": ".articleTitle h1, #powerbbsContent",
  // Uses the Froala editor; the whole post (with the real body wrapped in
  // .article-body) also sits inside <article> alongside a huge
  // .included-article-list (board post table) and a right sidebar — but
  // .article-content alone is exactly the post content, nothing else, so no
  // separate cleanup selectors are even needed here.
  "arca.live": ".fr-view.article-content",
  // The page has ~38 h1-h4 headings scattered across nav/sidebar/"인기글"
  // widgets, so heading-LCA climbs almost to <body> and Readability's
  // density scoring loses to the comment thread / related-post sidebar —
  // Readability was grabbing unrelated content instead of the actual post.
  "bbs.ruliweb.com": "h4.subject, .view_content.autolink",
  // SvelteKit site — CSS classes are build-hashed (svelte-xxxxxxx suffixes)
  // and even the un-hashed classes (Tailwind utility classes) aren't
  // distinctive enough to target just the post: the same "card" utility
  // classes are shared by the comments container too. Readability was
  // pulling in the 46-comment thread and the top nav category menu
  // alongside the actual post. h1 (page has exactly one) plus
  // #economy-post-content (a stable id despite the odd name — reused
  // across all board types, not just the "economy" board) together are
  // exactly the title and body, nothing else.
  "damoang.net": "h1, #economy-post-content",
  // Readability was grabbing the 13000+ char comment thread (.read_bottom)
  // and/or the Naver ad slot (.powerAD) alongside — both are siblings of the
  // actual post body (#articleBody) inside the same #column2 container, not
  // wrapped in anything that separates them, so Readability's density
  // scoring had no reason to prefer just the post.
  "www.82cook.com": "h4.title.bbstitle, #readHead, #articleBody",
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

// Readability scores candidates by <p>/<td> text density, which works poorly
// on sites (wiki-style SPAs especially, e.g. namu.wiki) that spread an
// article's real content across many separate sibling branches rather than
// one dense container — Readability ends up picking just one small branch and
// silently dropping the rest, with no error. This is a structural fallback
// that doesn't depend on any site's (often build-hashed, unstable) class
// names: find the lowest common ancestor of every heading (h1–h4) on the
// page. An article's headings mark its section boundaries, so their LCA
// should span the whole article while still excluding unrelated page chrome
// (nav/sidebar/footer) that sits outside it — unless the page barely has
// headings, in which case this returns null and Readability's result is used
// as-is.
function jcpHeadingLCA(root) {
  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4"));
  if (headings.length < 2) return null;
  function ancestorsOf(el) {
    const arr = [];
    let p = el;
    while (p) {
      arr.push(p);
      p = p.parentElement;
    }
    return arr;
  }
  let common = ancestorsOf(headings[0]);
  for (let i = 1; i < headings.length; i++) {
    const set = new Set(ancestorsOf(headings[i]));
    common = common.filter((el) => set.has(el));
  }
  return common[0] || null;
}

// The heading-LCA (see jcpHeadingLCA) sometimes includes a leading site
// logo/banner that sits before the article's own first heading, since the
// LCA is computed from the *headings* but still includes whatever else is a
// child of the same containers. An article should start at its own title,
// so drop every top-level child of root that comes before the one
// containing the first heading.
function jcpTrimBeforeFirstHeading(root) {
  const heading = root.querySelector("h1, h2, h3, h4");
  if (!heading) return root;
  let containerChild = heading;
  while (containerChild.parentElement && containerChild.parentElement !== root) {
    containerChild = containerChild.parentElement;
  }
  if (containerChild.parentElement !== root) return root;
  let sib = root.firstChild;
  while (sib && sib !== containerChild) {
    const next = sib.nextSibling;
    sib.remove();
    sib = next;
  }
  return root;
}

// MediaWiki-family wiki engines (namu.wiki's "the seed" included) show a
// "최근 수정 시각: ..." (last modified) line and a "분류" (category) tag list
// right under the title — page metadata, not article content. Matched by
// text pattern, same reasoning as jcpStripWikiAttributionNotice: these
// engines use build-hashed classes, so a class-based selector wouldn't hold
// up (and may not even match consistently across different articles on the
// same site, since Vue's scoped-style hash is per component, not global).
function jcpStripWikiMetaLine(root) {
  root.querySelectorAll("div, span, p").forEach((el) => {
    const text = el.textContent.trim();
    if (text.length < 60 && /^최근\s*수정\s*시각\s*[:：]/.test(text)) el.remove();
  });
  root.querySelectorAll("div, section").forEach((el) => {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (text.length > 0 && text.length < 200 && /^분류/.test(text)) el.remove();
  });
  return root;
}

// Wiki table-of-contents entries ("1. 개요", "2. 역사", ...) are laid out with
// CSS (each entry an inline <span>, indentation for sub-sections done by
// nesting an extra wrapper <div> per depth level rather than any text
// indent) — losing that CSS once clipped runs every entry together on one
// line. namu.wiki wraps its TOC in a real <details> element (a stable,
// semantic HTML5 tag, unlike everything else on this site), so it can be
// found reliably: rebuild it as one entry per line (a hard line break, so
// turndown doesn't insert paragraph gaps between every item) with two
// non-breaking spaces of indent per nesting level, inferred purely from how
// many container elements sit between each entry and the <details> —
// structural, not tied to any class name.
function jcpFixWikiToc(root) {
  root.querySelectorAll("details").forEach((details) => {
    // jcpAbsolutize() runs before this (on the clone headingLCA is derived
    // from) and rewrites these fragment-only hrefs ("#s-1") into absolute
    // URLs ("https://namu.wiki/w/...#s-1"), so a startsWith match (^=) never
    // matches post-absolutize — use a substring match instead so this still
    // finds the entries regardless of whether absolutize already ran.
    const entries = Array.from(details.querySelectorAll("a[href*='#s-']"))
      .map((a) => a.closest("span, li, div"))
      .filter(Boolean);
    if (entries.length < 2) return;
    const replacement = document.createElement("div");
    const seen = new Set();
    let first = true;
    entries.forEach((entrySpan) => {
      if (seen.has(entrySpan)) return;
      seen.add(entrySpan);
      let depth = 0;
      let p = entrySpan.parentElement;
      while (p && p !== details) {
        depth++;
        p = p.parentElement;
      }
      if (!first) replacement.appendChild(document.createElement("br"));
      first = false;
      const span = document.createElement("span");
      span.textContent = "  ".repeat(Math.max(0, depth - 1)) + entrySpan.textContent.trim();
      replacement.appendChild(span);
    });
    details.replaceWith(replacement);
  });
  return root;
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
  // Custom video-player chrome (speed/volume controls, progress bar) that
  // sits as sibling divs next to a self-hosted <video> — see jcpCleanVideoTags.
  "aagag.com": [".s_opt", ".v_progress"],
  // Custom video-player control bar (timestamp, speed selector) rendered as
  // a sibling of the <video> element itself.
  "etoland.co.kr": ['[class*="peer/controls"]'],
  // A literal <img src="/images/loading_bar2.gif"> sits right before every
  // real photo in the raw HTML, hidden via an onload handler once the real
  // image finishes loading on the live page. That script never runs on our
  // cloned/detached copy, so without this the loading-bar graphic itself
  // gets treated as real content and clipped in alongside every photo.
  "web.humoruniv.com": ['img[src*="loading_bar"]'],
  // .reply_count is a "[4]"-style comment-count badge nested right inside
  // the title heading. .rv-video-control-panel is custom video-player
  // chrome (play/volume/공유/새창 buttons) sitting as a sibling of the
  // <video> itself — its button labels are plain text, so without this
  // they'd leak into the markdown as stray "공유새창" noise (see jcpCleanVideoTags,
  // which only replaces the <video> tag, not sibling chrome around it).
  "bbs.ruliweb.com": [".reply_count", ".rv-video-control-panel"],
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
  "web.humoruniv.com",
  "www.slrclub.com",
  "www.inven.co.kr",
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
  const NAV_LABEL = /^(이전\s*\S*글?|다음\s*\S*글?|목록|랜덤\s*\S*|list|prev(ious)?|next|편집|토론|역사)$/i;
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

// "the seed" wiki engine (namu.wiki and other wikis built on it) inserts a
// standalone notice — "이 문서의 내용 중 전체 또는 일부는 [문서명] 문서의 rNNN 판에서
// 가져왔습니다. 이전 역사 보러 가기" — wherever a section's content was forked from
// another page's revision (a CC BY-NC-SA attribution requirement, not article
// content). Matched by text pattern rather than any class name, since this
// engine also uses build-hashed classes; only removes small blocks that are
// essentially just this notice, so real paragraphs mentioning similar words
// in passing are left alone.
function jcpStripWikiAttributionNotice(root) {
  const PATTERN = /이\s*문서의\s*내용\s*중\s*전체\s*또는\s*일부는[\s\S]*?판에서\s*가져왔습니다/;
  root.querySelectorAll("div, p").forEach((el) => {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (PATTERN.test(text) && text.length < 300) el.remove();
  });
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

// Self-hosted <video> tags (meme/GIF-style clips, direct mp4/webm — not an
// embedded player) have no Markdown representation either, and downloading +
// base64-inlining them like images would bloat the note hugely for what's
// usually several MB of video. Instead, replace the (often messy, with a
// site's custom player chrome as sibling elements) original with one clean
// <video controls src="..."> pointing at the original URL — Joplin's
// renderer supports <video> natively — which Turndown is told to keep as
// raw HTML via td.keep(["video"]) in jcpMakeTurndown(). Some sites lazy-load
// video the same way they lazy-load images (real URL in data-src, src left
// empty until scrolled into view), so that's checked as a fallback too.
function jcpCleanVideoTags(root, baseUrl) {
  root.querySelectorAll("video").forEach((video) => {
    let src = video.getAttribute("src") || video.getAttribute("data-src");
    if (!src) {
      const source = video.querySelector("source[src]");
      if (source) src = source.getAttribute("src") || source.getAttribute("data-src");
    }
    if (!src) return;
    let abs;
    try {
      abs = new URL(src, baseUrl).href;
    } catch (e) {
      return;
    }
    const clean = document.createElement("video");
    clean.setAttribute("controls", "");
    clean.setAttribute("src", abs);
    video.replaceWith(clean);
  });
  return root;
}

function jcpBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// High-resolution photos (some sites serve originals well over 2000px on the
// long side) make for slow, heavy clips once base64-encoded — a full-res
// image isn't needed to read a note later. Downscale by WIDTH (not the
// longest edge) and re-encode as JPEG. Capping by longest edge used to
// crush extremely tall, narrow images — a single-file vertical webtoon
// strip, aspect ratio 1:35+ isn't unusual — down to an unreadably thin
// sliver, since height alone blew past the cap and dragged width down
// with it even though the width itself was already perfectly reasonable.
// MAX_HEIGHT stays only as a crash-guard for pathological cases (nothing
// real is expected to hit it); wrapped in try/catch since an oversized
// canvas throwing here must not hang the whole clip. Runs on a blob: URL
// of bytes we already fetched ourselves, so this never hits canvas
// cross-origin tainting.
function jcpDownscaleImage(blob) {
  const MAX_WIDTH = 1600;
  const MAX_HEIGHT = 30000;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = Math.min(1, MAX_WIDTH / w, MAX_HEIGHT / h);
        if (!w || !h || scale >= 1) {
          URL.revokeObjectURL(url);
          resolve(blob);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((outBlob) => resolve(outBlob || blob), "image/jpeg", 0.85);
      } catch (e) {
        URL.revokeObjectURL(url);
        resolve(blob);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    img.src = url;
  });
}

// Plain fetch() has no timeout — if an image host just never responds (slow
// server, silently-dropped connection, a bot-check that hangs instead of
// failing), this call would otherwise wait indefinitely, and since
// jcpInlineImages awaits each image in sequence, that one stuck image freezes
// the entire clip: the popup just sits on "Clipping…" forever with no error.
function jcpFetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Lazy-loading gallery scripts (DCinside included, once a post has more than a
// couple of images) leave the real image URL in data-original/data-src and only
// swap it into src once the image scrolls near the viewport. Reading src alone
// misses any image that hasn't been scrolled to yet — src is left pointing at
// a small placeholder/thumbnail (e.g. Naver Blog's SmartEditor ONE, which uses
// data-lazy-src specifically and leaves a tiny list-thumbnail-sized URL in src
// for any image not yet scrolled into view). data-originalurl is a different
// case — src isn't broken there, just a smaller/compressed variant (arca.live
// does this); preferring it gets a better-quality clip, not a fix for a
// missing image.
function jcpRealImgUrl(img) {
  return (
    img.getAttribute("data-original") ||
    img.getAttribute("data-originalurl") ||
    img.getAttribute("data-lazy-src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("src") ||
    ""
  );
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
//
// Page zoom scales width and height together — zooming out enough to fit a
// merely-tall image in one shot only costs a little resolution, but for a
// single-file vertical webtoon page (aspect ratio 1:30+ isn't unusual) even
// the minimum zoom can't make the whole thing fit in one screen, and forcing
// it anyway would crush the WIDTH down along with the height for no benefit
// (there was never going to be a single shot). So: only zoom out when that
// actually gets the whole image into one screenshot; otherwise leave zoom
// alone and fall through to capturing multiple scrolled segments at full
// resolution instead.
//
// Returns an array of data URLs — length 1 for the common (zoomed, fits in
// one shot) case, or several for an extremely tall image, each a same-width
// slice captured at native resolution. Segments are placed as separate,
// block-wrapped <img> tags in reading order rather than stitched into one
// canvas, which sidesteps the seam problem entirely (no stitching means no
// alignment to get wrong) — see jcpInlineImages.
async function jcpCaptureImageViaTab(liveImgEl, targetAbsUrl) {
  if (!liveImgEl) return null;

  // Forced to "instant": a page with CSS `scroll-behavior: smooth` (common)
  // would otherwise animate every scroll here over several hundred ms, and
  // a screenshot taken before that animation finishes captures a half-
  // scrolled, blended frame — the previous segment's tail end and the next
  // segment's start overlaid on top of each other. That looked like (and
  // was reported as) duplicated/overlapping content, not a timing bug.
  liveImgEl.scrollIntoView({ block: "start", inline: "center", behavior: "instant" });
  await new Promise((r) => setTimeout(r, 150));
  if (targetAbsUrl) await jcpWaitForRealSrc(liveImgEl, targetAbsUrl, 4000);

  // naturalWidth being set only means the file finished downloading and its
  // dimensions are known — for an unusually large image (a single-file
  // vertical webtoon page can be tens of thousands of pixels tall) the
  // browser may still be progressively decoding/painting it, so a
  // screenshot taken right after can catch a not-yet-fully-rendered frame
  // for whatever's newly scrolled into view. img.decode() resolves only
  // once the browser has the whole image fully decoded and ready to paint,
  // which naturalWidth alone doesn't guarantee.
  await liveImgEl.decode().catch(() => {});

  const zoomRes = await chrome.runtime.sendMessage({ type: "getZoom" });
  const originalZoom = (zoomRes && zoomRes.zoom) || 1;
  let appliedZoom = originalZoom;
  const MIN_ZOOM = 0.3;

  try {
    let rect = liveImgEl.getBoundingClientRect();
    const fitHeight = window.innerHeight * 0.92;
    const zoomToFit = originalZoom * (fitHeight / rect.height);
    if (rect.height > fitHeight && zoomToFit >= MIN_ZOOM) {
      await chrome.runtime.sendMessage({ type: "setZoom", factor: zoomToFit });
      appliedZoom = zoomToFit;
      await new Promise((r) => setTimeout(r, 350));
      liveImgEl.scrollIntoView({ block: "start", inline: "center", behavior: "instant" });
      await new Promise((r) => setTimeout(r, 150));
      rect = liveImgEl.getBoundingClientRect();
    }
    // else: even the minimum zoom wouldn't have fit it in one shot, so don't
    // zoom out at all — go straight to segmented capture below at whatever
    // zoom the tab already had (usually 100%), keeping full width fidelity.

    const dpr = window.devicePixelRatio || 1;

    if (rect.height <= fitHeight) {
      const visTop = Math.max(0, rect.top);
      const visBottom = Math.min(window.innerHeight, rect.bottom);
      if (rect.width < 1 || visBottom - visTop < 1) return null;
      const res = await chrome.runtime.sendMessage({
        type: "captureImageRect",
        rect: { x: rect.left, y: visTop, width: rect.width, height: visBottom - visTop, dpr },
      });
      return res && res.ok ? [res.dataUrl] : null;
    }

    // Still taller than one screen — scroll and capture in segments, one
    // full viewport height per segment (no deliberate overlap — diagnostic
    // logging elsewhere confirmed the scroll/rect math lands on exact,
    // drift-free coordinates every time, so there's nothing to guard
    // against here; an earlier version's overlap, meant only as a rounding
    // margin, just left a visible seam of its own once the actual bug
    // below was fixed).
    //
    // A ghosted/doubled-content bug was chased here for a long time
    // (scroll animation, overlap sizing, scroll drift during the capture
    // throttle wait, incomplete image decode — see git history around this
    // comment) before finding the actual cause was downstream, in how
    // jcpInlineImages inserts the resulting segments — see the comment
    // there. The capture logic itself was never the problem.
    const MAX_SEGMENTS = 25;
    const dataUrls = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      rect = liveImgEl.getBoundingClientRect();
      if (rect.bottom <= 1 || rect.width < 1) break;
      const visTop = Math.max(0, rect.top);
      const visBottom = Math.min(window.innerHeight, rect.bottom);
      if (visBottom - visTop < 1) break;
      const res = await chrome.runtime.sendMessage({
        type: "captureImageRect",
        rect: { x: rect.left, y: visTop, width: rect.width, height: visBottom - visTop, dpr },
      });
      if (res && res.ok) dataUrls.push(res.dataUrl);
      if (rect.bottom <= window.innerHeight) break; // this segment already reached the image's bottom edge
      window.scrollBy({ top: window.innerHeight, left: 0, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 200));
    }
    return dataUrls.length ? dataUrls : null;
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

// Some images are sized only via external CSS or a relative unit tied to a
// parent container (namu.wiki's flag/icon templates use height="100%" with
// no pixel width/height at all) — clipped in isolation, that sizing info is
// meaningless and the image can render at its full native size instead of
// the small icon it actually was on the page. Bake in the live, actually-
// rendered CSS-pixel size as explicit width/height attributes so it survives
// being lifted out of the page. jcpMakeTurndown() then keeps small images
// (<=100px) as raw HTML so those attributes aren't lost in the markdown
// conversion, which normal ![]() syntax can't carry at all.
function jcpPreserveRenderedImageSize(img, baseUrl) {
  const src = jcpRealImgUrl(img);
  if (!src) return;
  let abs;
  try {
    abs = new URL(src, baseUrl).href;
  } catch (e) {
    return;
  }
  const liveEl = jcpFindLiveImg(abs, baseUrl);
  if (!liveEl) return;
  const rect = liveEl.getBoundingClientRect();
  if (rect.width >= 1 && rect.height >= 1) {
    img.setAttribute("width", String(Math.round(rect.width)));
    img.setAttribute("height", String(Math.round(rect.height)));
  }
}

async function jcpInlineImages(root, baseUrl) {
  const MAX_BYTES = 6 * 1024 * 1024;
  const MAX_TAB_CAPTURES = 20; // captureVisibleTab is rate-limited; cap the fallback
  const imgs = Array.from(
    root.querySelectorAll("img[src], img[data-original], img[data-lazy-src], img[data-src]")
  );
  imgs.forEach((img) => jcpPreserveRenderedImageSize(img, baseUrl));

  // Phase 1: fetch() every image concurrently — this is the common, fast
  // path (most sites need no fallback at all) and has no reason to be
  // serialized; awaiting one full fetch+decode before even starting the next
  // was needlessly slow on multi-image posts.
  const results = await Promise.all(
    imgs.map(async (img) => {
      const src = jcpRealImgUrl(img);
      if (!src || src.startsWith("data:")) return { img, abs: null, dataUrl: null };
      let abs;
      try {
        abs = new URL(src, baseUrl).href;
      } catch (e) {
        return { img, abs: null, dataUrl: null };
      }

      // An https page can never fetch() a plain-http URL — the browser blocks
      // it as mixed content before our code even sees it, logging a console
      // error in the process. Skip the doomed attempt outright and go
      // straight to the tab-capture fallback instead of triggering that
      // warning for nothing.
      const isMixedContent = location.protocol === "https:" && abs.startsWith("http://");

      let dataUrl = null;
      if (!isMixedContent) {
        try {
          const res = await jcpFetchWithTimeout(abs, { credentials: "include" }, 12000);
          if (res.ok) {
            let blob = await res.blob();
            if (blob.size > 0) {
              blob = await jcpDownscaleImage(blob);
              if (blob.size <= MAX_BYTES) {
                dataUrl = await jcpBlobToDataUrl(blob);
              }
            }
          }
        } catch (e) {
          // Likely CORS-blocked; fall through to the tab-capture fallback below.
        }
      }
      return { img, abs, dataUrl };
    })
  );

  // Phase 2: anything fetch() couldn't get falls back to tab-capture — this
  // MUST stay sequential, since it scrolls the page and only one screenshot
  // can be taken at a time.
  let tabCaptures = 0;
  for (const r of results) {
    let dataUrls = r.dataUrl ? [r.dataUrl] : null;
    if (!dataUrls && r.abs && tabCaptures < MAX_TAB_CAPTURES && SCREENSHOT_FALLBACK_HOSTS.has(location.hostname)) {
      try {
        const liveEl = jcpFindLiveImg(r.abs, baseUrl);
        dataUrls = await jcpCaptureImageViaTab(liveEl, r.abs);
        tabCaptures++;
      } catch (e) {
        // Give up on this image; the original (likely broken) URL stays.
      }
    }

    if (dataUrls && dataUrls.length === 1) {
      r.img.setAttribute("src", dataUrls[0]);
      r.img.removeAttribute("srcset");
      r.img.removeAttribute("data-original");
      r.img.removeAttribute("data-src");
    } else if (dataUrls && dataUrls.length > 1) {
      // A single-file image too tall for even a maximally zoomed-out
      // screenshot (see jcpCaptureImageViaTab) came back as several scrolled
      // segments — lay them out in reading order (top to bottom) instead of
      // forcing them into one image.
      //
      // Originally each segment was wrapped in its own <div> to force a
      // vertical stack (bare sibling <img> tags are inline and just flow
      // left-to-right instead). That div-wrapping was the real cause of
      // the "ghosted/overlapping" note content reported on humoruniv,
      // chased for a long time as a capture-timing/GPU-compositor bug
      // before the actual mechanism was found: the original single <img>
      // there sits inside an inline <b> tag (IMG > SPAN > B > P). Swapping
      // it for several sibling <div>s put block elements inside an inline
      // one in the live DOM — harmless there, but jcpClipArticle serializes
      // the whole wrapper back to an HTML *string* (`wrapper.innerHTML`)
      // for Turndown to re-parse, and the HTML5 parser's "adoption agency"
      // algorithm doesn't allow a block element inside an open inline
      // formatting element: it implicitly closes the <b> before each <div>
      // and reopens a *new* <b> after it. One "<b>...</b>" around the
      // original image became several independently-reconstructed
      // "<b>"s, one per segment — which Turndown then rendered as
      // mismatched/interleaved "**" runs, and Joplin's markdown renderer
      // turned that broken bold nesting into the reported stray blank
      // gaps and doubled-looking text. <img>/<br> are both inline, so
      // nesting them inside <b> never triggers that reconstruction — the
      // original single <b> survives intact, and turndown's hard-line-
      // break rule for <br> still puts each segment on its own line.
      const frag = document.createDocumentFragment();
      dataUrls.forEach((du, i) => {
        if (i > 0) frag.appendChild(document.createElement("br"));
        const seg = document.createElement("img");
        seg.setAttribute("src", du);
        frag.appendChild(seg);
      });
      r.img.replaceWith(frag);
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
  td.keep(["video"]);
  // Standard markdown image syntax (![]()) carries no size information, so a
  // small inline icon (wiki flag templates etc. — see jcpPreserveRenderedImageSize)
  // would lose its baked-in width/height and could render at native/huge size
  // instead. Keep small images as raw <img> HTML instead so the size sticks;
  // normal content-sized photos still convert to plain markdown as before.
  // Uses addRule (not keep) because turndown checks its regular rule array —
  // which includes the built-in image rule — before the _keep list, so a
  // keep() filter for "img" would never actually run.
  td.addRule("jcpSmallImageAsHtml", {
    filter: (node) => {
      if (node.nodeName !== "IMG") return false;
      const w = parseInt(node.getAttribute("width") || "0", 10);
      const h = parseInt(node.getAttribute("height") || "0", 10);
      return w > 0 && w <= 100 && h > 0 && h <= 100;
    },
    replacement: (content, node) => node.outerHTML,
  });
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
    // Measured on its own clone, kept untouched — Readability.parse() mutates
    // its document in place as part of scoring/cleanup, which would corrupt
    // this reference if it shared a clone with the Readability call below.
    const docCloneForLCA = effectiveDoc.cloneNode(true);
    jcpAbsolutize(docCloneForLCA, baseUrl);
    const headingLCA = jcpHeadingLCA(docCloneForLCA);
    const headingLCALen = headingLCA ? headingLCA.textContent.trim().length : 0;
    const bodyTextLen = docCloneForLCA.body ? docCloneForLCA.body.textContent.trim().length : 0;

    const docClone = effectiveDoc.cloneNode(true);
    jcpAbsolutize(docClone, baseUrl);
    jcpStripBoardChrome(docClone);
    const readabilityArticle = new Readability(docClone).parse();
    const readabilityLen = readabilityArticle ? readabilityArticle.textContent.trim().length : 0;

    // Only switch to the heading-LCA when it's substantially bigger (not just
    // noise) and still clearly narrower than the whole page (not "nav +
    // sidebar + everything" — i.e. the page barely has distinguishing
    // headings and the LCA walked almost all the way up to <body>).
    const preferHeadingLCA =
      headingLCA && headingLCALen > readabilityLen * 1.5 && bodyTextLen > 0 && headingLCALen < bodyTextLen * 0.7;

    if (preferHeadingLCA) {
      jcpTrimBeforeFirstHeading(headingLCA);
      jcpStripWikiMetaLine(headingLCA);
      jcpStripBoardChrome(headingLCA);
      article = { title: document.title, content: headingLCA.innerHTML, excerpt: "", byline: "" };
    } else if (readabilityArticle) {
      article = readabilityArticle;
    } else if (headingLCA) {
      jcpTrimBeforeFirstHeading(headingLCA);
      jcpStripWikiMetaLine(headingLCA);
      jcpStripBoardChrome(headingLCA);
      article = { title: document.title, content: headingLCA.innerHTML, excerpt: "", byline: "" };
    } else {
      return { error: "Readability could not parse this page." };
    }
  }

  const wrapper = document.createElement("div");
  wrapper.innerHTML = article.content;
  jcpStripNonContentTags(wrapper);
  jcpStripTrailingWireFooter(wrapper);
  jcpStripWikiAttributionNotice(wrapper);
  jcpFixWikiToc(wrapper);
  const videoIds = jcpExtractVideoPlaceholders(wrapper);
  jcpCleanVideoTags(wrapper, baseUrl);
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
  jcpCleanVideoTags(container, location.href);
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

})();
