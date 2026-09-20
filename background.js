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

function cdpSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function cdpAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function cdpDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

// Fallback for images fetch() can't read due to CORS (see content.js).
// Screenshots the given page-relative rectangle directly via the Chrome
// DevTools Protocol's Page.captureScreenshot, with captureBeyondViewport —
// this renders the requested area in one call regardless of how tall it is
// or whether it's currently scrolled into view at all, which is how "full
// page screenshot" extensions avoid needing to scroll+stitch in the first
// place. Replaced an earlier chrome.tabs.captureVisibleTab-based approach
// (screenshot only the visible viewport, scroll and repeat for anything
// taller) that went through several rounds of scroll-timing bugs — a
// screenshot taken before the browser had actually finished repainting
// after a scroll could capture a blended frame, showing part of the
// previous scroll position and part of the new one overlaid together.
//
// Requires the "debugger" permission: Chrome shows its own "<extension>
// started debugging this browser" banner while attached (expected, every
// extension using this API gets it), and attach fails if DevTools is
// already open on that same tab (only one debugger client per target).
async function captureElementViaCDP(tabId, cssRect) {
  const target = { tabId };
  await cdpAttach(target);
  try {
    const result = await cdpSendCommand(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 90,
      clip: {
        x: cssRect.x,
        y: cssRect.y,
        width: cssRect.width,
        height: cssRect.height,
        scale: cssRect.dpr || 1,
      },
      captureBeyondViewport: true,
    });
    return `data:image/jpeg;base64,${result.data}`;
  } finally {
    await cdpDetach(target);
  }
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
          60000,
          "클리핑이 60초 안에 끝나지 않았어요. 이미지가 너무 크거나 사이트가 느릴 수 있어요."
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
      } else if (msg.type === "captureElementCDP") {
        const dataUrl = await captureElementViaCDP(sender.tab.id, msg.rect);
        sendResponse({ ok: true, dataUrl });
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
