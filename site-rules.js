// Settings-page UI for user-defined site rules (shared with the Obsidian fork;
// the host options.html just needs the #siteRules container).
// Rules live in chrome.storage.local "siteRules": [{host, content, remove}],
// read by content.js (jcpUserSiteRule) at clip time and created by picker.js
// (the "pick the area by clicking" tool). This page lists them, deletes them,
// and imports/exports them as a plain text file.
//
// Text file format (hand-editable):
//   # comment
//   [www.example.com]
//   content = h1.title, #articleBody
//   remove = .ad, .share
(function () {
  const root = document.getElementById("siteRules");
  if (!root) return;

  root.innerHTML = `
    <details class="rules-help" open>
      <summary>규칙은 어떻게 만드나요?</summary>
      <ol>
        <li>클리핑이 잘 안 되는 기사 페이지에서 확장 아이콘을 누릅니다.</li>
        <li><b>🎯 이 사이트 영역 직접 고르기</b>를 누릅니다.</li>
        <li>페이지에서 넣을 부분(제목·본문 등)을 클릭합니다. 광고처럼 지울 것은 <b>🗑 지울 영역</b> 탭에서 클릭합니다.</li>
        <li><b>💾 저장</b>을 누르면 이 사이트의 규칙으로 저장되고, 아래 목록에 나타납니다.</li>
      </ol>
      <p>규칙을 다른 컴퓨터로 옮기거나 백업하려면 <b>내보내기</b>로 텍스트 파일을 만들고, 다른 곳에서 <b>불러오기</b>를 누르세요. 파일은 메모장으로 직접 고칠 수도 있습니다. 형식은 이렇습니다:</p>
      <pre>[www.example.com]
content = h1.title, #articleBody
remove = .ad, .share</pre>
      <p><code>content</code>는 클리핑에 넣을 영역, <code>remove</code>는 그 안에서 지울 영역(선택)의 CSS 셀렉터입니다. <code>#</code>으로 시작하는 줄은 설명입니다.</p>
    </details>
    <div id="rulesList"></div>
    <div class="rules-actions">
      <button type="button" id="exportRules" class="secondary" style="margin-left:0">⬇ 내보내기 (텍스트 파일)</button>
      <button type="button" id="importRules" class="secondary">⬆ 불러오기</button>
      <input type="file" id="importFile" accept=".txt,text/plain" hidden />
    </div>
    <div id="rulesStatus" class="hint"></div>
  `;

  const listEl = document.getElementById("rulesList");
  const statusEl = document.getElementById("rulesStatus");
  const fileEl = document.getElementById("importFile");

  const normHost = (h) =>
    String(h || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.style.color = ok ? "#1a7f37" : ok === false ? "#c62828" : "";
  }

  function validSelector(sel) {
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch (e) {
      return false;
    }
  }

  function getRules(cb) {
    chrome.storage.local.get("siteRules", (data) => {
      cb(Array.isArray(data.siteRules) ? data.siteRules.filter((r) => r && r.host && r.content) : []);
    });
  }

  function render(rules) {
    listEl.innerHTML = "";
    if (!rules.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "아직 저장된 규칙이 없습니다.";
      listEl.appendChild(empty);
      return;
    }
    rules.forEach((rule) => {
      const row = document.createElement("div");
      row.className = "rule-row";
      const host = document.createElement("div");
      host.style.cssText = "font-weight:600;margin-top:6px;word-break:break-all";
      host.textContent = rule.host;
      const mk = (label, value) => {
        const d = document.createElement("div");
        d.className = "hint";
        d.style.wordBreak = "break-all";
        d.textContent = `${label}: ${value}`;
        return d;
      };
      row.appendChild(host);
      row.appendChild(mk("넣을 영역", rule.content));
      if (rule.remove) row.appendChild(mk("지울 영역", rule.remove));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "secondary";
      del.style.marginLeft = "0";
      del.textContent = "삭제";
      del.addEventListener("click", () => {
        getRules((cur) => {
          const next = cur.filter((r) => normHost(r.host) !== normHost(rule.host));
          chrome.storage.local.set({ siteRules: next }, () => {
            render(next);
            setStatus(`${rule.host} 규칙을 삭제했습니다.`, true);
          });
        });
      });
      row.appendChild(del);
      listEl.appendChild(row);
    });
  }

  // ---- text format ----
  function serialize(rules) {
    const lines = [
      "# Clipper site rules - [site] / content = what to clip / remove = what to drop (optional)",
      "# Edit freely. Import merges by site: an imported site replaces the one saved here.",
      "",
    ];
    rules.forEach((r) => {
      lines.push(`[${r.host}]`, `content = ${r.content}`);
      if (r.remove) lines.push(`remove = ${r.remove}`);
      lines.push("");
    });
    return lines.join("\n");
  }

  // Returns { rules, errors }.
  function parse(text) {
    const rules = [];
    const errors = [];
    let cur = null;
    const flush = () => {
      if (!cur) return;
      if (!cur.content) errors.push(`${cur.host}: content 줄이 없어 건너뜀`);
      else if (!validSelector(cur.content)) errors.push(`${cur.host}: content 셀렉터가 올바르지 않아 건너뜀`);
      else if (cur.remove && !validSelector(cur.remove)) errors.push(`${cur.host}: remove 셀렉터가 올바르지 않아 건너뜀`);
      else rules.push({ host: cur.host, content: cur.content, remove: cur.remove || "" });
      cur = null;
    };
    text
      .replace(/^﻿/, "")
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return;
        const h = line.match(/^\[(.+)\]$/);
        if (h) {
          flush();
          const host = normHost(h[1]);
          if (host) cur = { host, content: "", remove: "" };
          else errors.push(`${i + 1}번째 줄: 사이트 주소가 비어 있음`);
          return;
        }
        const kv = line.match(/^(content|remove)\s*=\s*(.*)$/i);
        if (kv && cur) cur[kv[1].toLowerCase()] = kv[2].trim();
        else errors.push(`${i + 1}번째 줄을 이해하지 못해 건너뜀: ${line.slice(0, 40)}`);
      });
    flush();
    return { rules, errors };
  }

  // ---- buttons ----
  document.getElementById("exportRules").addEventListener("click", () => {
    getRules((rules) => {
      if (!rules.length) return setStatus("내보낼 규칙이 없습니다.", false);
      const blob = new Blob([serialize(rules)], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "clipper-site-rules.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setStatus(`규칙 ${rules.length}개를 내보냈습니다.`, true);
    });
  });

  document.getElementById("importRules").addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", () => {
    const file = fileEl.files && fileEl.files[0];
    if (!file) return;
    file.text().then((text) => {
      fileEl.value = "";
      const { rules: incoming, errors } = parse(text);
      if (!incoming.length) {
        return setStatus("불러올 규칙이 없습니다." + (errors.length ? " " + errors[0] : ""), false);
      }
      getRules((cur) => {
        const incomingHosts = new Set(incoming.map((r) => normHost(r.host)));
        const kept = cur.filter((r) => !incomingHosts.has(normHost(r.host)));
        const next = kept.concat(incoming);
        chrome.storage.local.set({ siteRules: next }, () => {
          render(next);
          setStatus(
            `규칙 ${incoming.length}개를 불러왔습니다.` + (errors.length ? ` (건너뜀 ${errors.length}건: ${errors[0]})` : ""),
            true
          );
        });
      });
    });
  });

  getRules(render);
})();
