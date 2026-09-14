const portEl = document.getElementById("port");
const tokenEl = document.getElementById("token");
const statusEl = document.getElementById("status");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === undefined ? "" : ok ? "ok" : "err";
}

chrome.storage.local.get(["joplinToken", "joplinPort"], (data) => {
  tokenEl.value = data.joplinToken || "";
  portEl.value = data.joplinPort || "41184";
});

document.getElementById("save").addEventListener("click", () => {
  chrome.storage.local.set(
    { joplinToken: tokenEl.value.trim(), joplinPort: portEl.value.trim() || "41184" },
    () => setStatus("Saved.", true)
  );
});

document.getElementById("test").addEventListener("click", async () => {
  await chrome.storage.local.set({
    joplinToken: tokenEl.value.trim(),
    joplinPort: portEl.value.trim() || "41184",
  });
  setStatus("Testing…");
  chrome.runtime.sendMessage({ type: "testConnection" }, (res) => {
    if (res && res.ok) setStatus("Connected to Joplin ✓", true);
    else setStatus("Failed: " + (res ? res.error : "no response"), false);
  });
});
