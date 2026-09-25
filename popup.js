let mode = "article";
const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const notebookEl = document.getElementById("notebook");
const tagsEl = document.getElementById("tags");
const clipBtn = document.getElementById("clip");

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

document.querySelectorAll(".modes button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".modes button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
  });
});

document.getElementById("settingsLink").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function init() {
  document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleEl.value = tab.title || "";

  chrome.runtime.sendMessage({ type: "listFolders" }, (res) => {
    notebookEl.innerHTML = "";
    if (!res || !res.ok) {
      notebookEl.innerHTML = '<option value="">(default notebook)</option>';
      if (res && res.error) setStatus(res.error, "err");
      return;
    }
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "(default notebook)";
    notebookEl.appendChild(opt0);
    res.folders
      .sort((a, b) => a.title.localeCompare(b.title))
      .forEach((f) => {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.title;
        notebookEl.appendChild(opt);
      });
  });
}

clipBtn.addEventListener("click", () => {
  clipBtn.disabled = true;
  setStatus("Clipping…");
  chrome.runtime.sendMessage(
    {
      type: "clip",
      mode,
      parentId: notebookEl.value || undefined,
      tags: tagsEl.value.trim() || undefined,
      title: titleEl.value.trim() || undefined,
    },
    (res) => {
      clipBtn.disabled = false;
      if (res && res.ok) {
        const via = res.preview && res.preview.via;
        setStatus("Saved to Joplin ✓" + (via ? " (" + via + ")" : ""), "ok");
      } else {
        setStatus((res && res.error) || "Unknown error", "err");
      }
    }
  );
});

init();
