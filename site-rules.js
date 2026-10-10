// Settings-page UI for user-defined site rules (shared with the Obsidian fork;
// the host options.html just needs the #siteRules container, see below).
// Rules live in chrome.storage.local "siteRules": [{host, content, remove}],
// read by content.js (jcpUserSiteRule) at clip time.
(function () {
  const root = document.getElementById("siteRules");
  if (!root) return;

  root.innerHTML = `
    <details class="rules-help">
      <summary>How do I find the selector? (step by step)</summary>
      <ol>
        <li>Open the article page that clips badly.</li>
        <li>Press <b>F12</b> (developer tools), then click the small <b>arrow-in-a-square</b> icon at the top-left of the tools panel.</li>
        <li>Click the <b>article text</b> on the page. A line gets highlighted in the tools panel.</li>
        <li>Right-click that highlighted line → <b>Copy</b> → <b>Copy selector</b>.</li>
        <li>Paste it into <b>Content selector</b> below, and put the site address (e.g. <code>www.example.com</code>) in <b>Site</b>.</li>
        <li>Optional: if some junk (ads, share buttons) is still inside, do the same on that junk and paste its selector into <b>Remove</b>.</li>
        <li>Press <b>Save rules</b>, then clip the page again.</li>
      </ol>
      <p>The title is usually outside the text block. To include it, copy its selector too and join them with a comma: <code>h1.title, #articleBody</code>.</p>
      <p>Tips: a short selector with an <code>#id</code> or a clear <code>.class</code> lasts longer than a long <code>div:nth-child(…)</code> chain. Separate several selectors with commas.</p>
    </details>
    <details class="rules-help">
      <summary>한국어 설명</summary>
      <ol>
        <li>클리핑이 잘 안 되는 기사 페이지를 엽니다.</li>
        <li><b>F12</b>를 눌러 개발자 도구를 열고, 도구 왼쪽 위의 <b>화살표 아이콘(요소 선택)</b>을 누릅니다.</li>
        <li>페이지에서 <b>기사 본문</b>을 클릭합니다. 도구 안에서 한 줄이 파랗게 선택됩니다.</li>
        <li>선택된 줄을 마우스 오른쪽 버튼 → <b>Copy</b> → <b>Copy selector</b>.</li>
        <li>아래 <b>Content selector</b>에 붙여 넣고, <b>Site</b>에는 사이트 주소(예: <code>www.example.com</code>)를 적습니다.</li>
        <li>선택: 본문 안에 광고·공유 버튼 같은 게 남아 있으면 같은 방법으로 그 요소의 셀렉터를 복사해 <b>Remove</b>에 붙여 넣습니다.</li>
        <li><b>Save rules</b>를 누르고 페이지를 다시 클리핑합니다.</li>
      </ol>
      <p>제목은 보통 본문 바깥에 있습니다. 제목도 넣으려면 제목의 셀렉터를 복사해 쉼표로 이어 붙이세요: <code>h1.title, #articleBody</code></p>
      <p>팁: <code>div:nth-child(…)</code>처럼 긴 것보다 <code>#id</code>나 알아볼 수 있는 <code>.class</code>가 들어간 짧은 셀렉터가 오래 갑니다. 여러 개는 쉼표로 구분합니다.</p>
    </details>
    <div id="rulesList"></div>
    <button type="button" id="addRule" class="secondary" style="margin-left:0">+ Add rule</button>
    <button type="button" id="saveRules">Save rules</button>
    <div id="rulesStatus" class="hint"></div>
  `;

  const listEl = document.getElementById("rulesList");
  const statusEl = document.getElementById("rulesStatus");

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.style.color = ok ? "#1a7f37" : ok === false ? "#c62828" : "";
  }

  function addRow(rule) {
    const row = document.createElement("div");
    row.className = "rule-row";
    const mk = (cls, label, ph, val) => {
      const wrap = document.createElement("label");
      wrap.textContent = label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = cls;
      input.placeholder = ph;
      input.value = val || "";
      wrap.appendChild(input);
      return wrap;
    };
    row.appendChild(mk("r-host", "Site", "www.example.com", rule.host));
    row.appendChild(mk("r-content", "Content selector (title, body …)", "h1.title, #articleBody", rule.content));
    row.appendChild(mk("r-remove", "Remove (optional)", ".ad, .share-buttons", rule.remove));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary";
    del.style.marginLeft = "0";
    del.textContent = "Delete";
    del.addEventListener("click", () => row.remove());
    row.appendChild(del);
    listEl.appendChild(row);
  }

  function normHost(h) {
    return String(h || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  }

  function validSelector(sel) {
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch (e) {
      return false;
    }
  }

  document.getElementById("addRule").addEventListener("click", () => addRow({}));

  document.getElementById("saveRules").addEventListener("click", () => {
    const rules = [];
    for (const row of listEl.querySelectorAll(".rule-row")) {
      const host = normHost(row.querySelector(".r-host").value);
      const content = row.querySelector(".r-content").value.trim();
      const remove = row.querySelector(".r-remove").value.trim();
      if (!host && !content && !remove) continue; // blank row
      if (!host || !content) return setStatus("Every rule needs a Site and a Content selector.", false);
      if (!validSelector(content)) return setStatus(`Content selector isn't valid for ${host}: ${content}`, false);
      if (remove && !validSelector(remove)) return setStatus(`Remove selector isn't valid for ${host}: ${remove}`, false);
      rules.push({ host, content, remove });
    }
    chrome.storage.local.set({ siteRules: rules }, () => setStatus(`Saved ${rules.length} rule(s).`, true));
  });

  chrome.storage.local.get("siteRules", (data) => {
    const rules = Array.isArray(data.siteRules) ? data.siteRules : [];
    rules.forEach(addRow);
    if (!rules.length) addRow({});
  });
})();
