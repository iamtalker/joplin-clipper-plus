const LIB_FILES = ["lib/Readability.js", "lib/turndown.js", "lib/turndown-plugin-gfm.js", "content.js"];

async function getSettings() {
  const { joplinToken = "", joplinPort = "41184" } = await chrome.storage.local.get([
    "joplinToken",
    "joplinPort",
  ]);
  return { joplinToken, joplinPort };
}

function apiBase(port) {
  return `http://127.0.0.1:${port}`;
}

async function joplinFetch(path, options = {}) {
  const { joplinToken, joplinPort } = await getSettings();
  if (!joplinToken) {
    throw new Error("Joplin API token is not set. Open the extension options first.");
  }
  const sep = path.includes("?") ? "&" : "?";
  const url = `${apiBase(joplinPort)}${path}${sep}token=${encodeURIComponent(joplinToken)}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error || "";
    } catch (e) {}
    throw new Error(`Joplin API ${res.status}: ${detail || res.statusText}`);
  }
  return res.json();
}

async function testConnection() {
  const { joplinToken } = await getSettings();
  if (!joplinToken) return { ok: false, error: "No token set." };
  try {
    await joplinFetch("/folders?limit=1");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listFolders() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await joplinFetch(`/folders?fields=id,title,parent_id&limit=100&page=${page}`);
    all.push(...data.items);
    if (!data.has_more) break;
    page++;
  }
  return all;
}

async function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// chrome.tabs.captureVisibleTab enforces its own quota (Chrome allows at
// most ~2 calls/second per profile) — a post with several images in a row
// that all need the screenshot fallback (see SCREENSHOT_FALLBACK_HOSTS in
// content.js) can fire captures faster than that. When the quota is hit the
// call just throws, which the caller in content.js catches and silently
// gives up on that one image — the site's original (CORS-blocked, so
// unloadable once clipped) URL is left in place, which is what actually
// looked like "some images go missing" from a multi-image post. Throttle
// every call to at least MIN_CAPTURE_INTERVAL_MS apart, and retry once if
// the quota error slips through anyway (e.g. another tab captured around
// the same time).
const MIN_CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;

async function throttleCapture() {
  const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
}

async function captureVisibleTabThrottled(windowId) {
  await throttleCapture();
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (e) {
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e.message || "")) throw e;
    await new Promise((r) => setTimeout(r, MIN_CAPTURE_INTERVAL_MS));
    lastCaptureAt = Date.now();
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

// Fallback for images fetch() can't read due to CORS (see content.js). We
// screenshot the whole visible tab, then crop to just the image's rect in an
// OffscreenCanvas — screenshot pixels aren't subject to the CORS check.
async function captureImageRect(tabId, rect) {
  const tab = await chrome.tabs.get(tabId);
  const shotDataUrl = await captureVisibleTabThrottled(tab.windowId);
  const shotBlob = await (await fetch(shotDataUrl)).blob();
  const bitmap = await createImageBitmap(shotBlob);
  const dpr = rect.dpr || 1;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * dpr)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * dpr)));
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const base64 = await arrayBufferToBase64(await outBlob.arrayBuffer());
  return `data:image/png;base64,${base64}`;
}

// Safety net for the whole clip operation: content.js has its own per-image
// fetch timeout now, but this guards against any other stuck step (script
// injection, a hung message round-trip, something not yet anticipated) so
// the popup always gets a response instead of sitting on "Clipping…" forever.
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runClipOnTab(tabId, mode) {
  await chrome.scripting.executeScript({ target: { tabId }, files: LIB_FILES });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (m) => window.__jcpRunClip(m),
    args: [mode],
  });
  return result;
}

function buildNoteBody(clip) {
  const base = { source_url: clip.url };
  if (clip.mode === "full") {
    return { ...base, title: clip.title, body_html: clip.html, base_url: clip.url };
  }
  if (clip.mode === "bookmark") {
    return {
      ...base,
      title: clip.title,
      body: `${clip.description ? clip.description + "\n\n" : ""}[${clip.title}](${clip.url})`,
    };
  }
  // article / selection
  return { ...base, title: clip.title, body: clip.markdown };
}

async function createNote({ clip, parentId, tags, titleOverride }) {
  const payload = buildNoteBody(clip);
  if (titleOverride) payload.title = titleOverride;
  if (parentId) payload.parent_id = parentId;
  if (tags) payload.tags = tags;
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
  return joplinFetch("/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "testConnection") {
        sendResponse(await testConnection());
      } else if (msg.type === "listFolders") {
        sendResponse({ ok: true, folders: await listFolders() });
      } else if (msg.type === "clip") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const clip = await withTimeout(
          runClipOnTab(tab.id, msg.mode),
          45000,
          "클리핑이 45초 안에 끝나지 않았어요. 이미지가 너무 크거나 사이트가 느릴 수 있어요."
        );
        if (clip.error) {
          sendResponse({ ok: false, error: clip.error });
          return;
        }
        const note = await createNote({
          clip,
          parentId: msg.parentId,
          tags: msg.tags,
          titleOverride: msg.title,
        });
        sendResponse({ ok: true, note, preview: clip });
      } else if (msg.type === "captureImageRect") {
        const dataUrl = await captureImageRect(sender.tab.id, msg.rect);
        sendResponse({ ok: true, dataUrl });
      } else if (msg.type === "getZoom") {
        const zoom = await chrome.tabs.getZoom(sender.tab.id);
        sendResponse({ ok: true, zoom });
      } else if (msg.type === "setZoom") {
        await chrome.tabs.setZoom(sender.tab.id, msg.factor);
        sendResponse({ ok: true });
      } else if (msg.type === "preview") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const clip = await runClipOnTab(tab.id, msg.mode);
        sendResponse({ ok: !clip.error, clip, error: clip.error });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});
