const $ = (s) => document.querySelector(s);

const els = {
  modelSelect: $("#model-select"),
  reasoningSelect: $("#reasoning-select"),
  keyDot: $("#key-dot"),
  messages: $("#messages"),
  input: $("#input"),
  editor: $("#editor"),
  highlightCode: $("#highlight-code"),
  highlight: $("#highlight"),
  gutter: $("#gutter"),
  fileName: $("#file-name"),
  dirtyFlag: $("#dirty-flag"),
  langLabel: $("#lang-label"),
  cursorPos: $("#cursor-pos"),
  statusLeft: $("#status-left"),
  divider: $("#divider"),
  editorPane: $("#editor-pane"),
  chatPane: $("#chat-pane") || $("#z-sidebar"),
  layout: $("#layout") || $("#app"),
  sidebar: $("#sidebar"),
  tree: $("#tree"),
  wsRoot: $("#ws-root"),
  tabs: $("#tabs"),
};

let models = [];
let currentModel = "";
let currentReasoningEffort = localStorage.getItem("meteor:reasoningEffort") || "";
let chatHistory = [];
let busy = false;
let savedContent = "";

// Workspace state: { root, name, truncated, files: Map<relPath, {path, size, content, skipReason}> }
let workspace = null;
const collapsedDirs = new Set();

// Projects (meteor_projects)
let currentProjectId = localStorage.getItem("meteor:currentProjectId") || null;
let projectsCache = [];
let expandedProjects = new Set(JSON.parse(localStorage.getItem("meteor:expandedProjects") || "[]"));
function persistExpanded(){ try{ localStorage.setItem("meteor:expandedProjects", JSON.stringify([...expandedProjects])); }catch{} }

// Tab state: { id, name, rel (workspace-relative) | null, absPath | null, buffer, savedContent }
let tabs = [];
let activeTabId = null;
let tabSeq = 0;

const CONTEXT_BUDGET = 180000;
const ACTIVE_FILE_CAP = 60000;
const PER_FILE_CAP = 40000;

let autoCreateEnabled = localStorage.getItem("meteor:autoCreate") !== "false";
let buildMode = localStorage.getItem("meteor:buildMode") || "build";
let terminalLog = [];

// ── Image attachments ───────────────────────────────────────────────
let pendingImages = []; // {id, name, dataUrl, size}
let imageSeq = 0;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

function formatBytes(n){
  if (n < 1024) return n+" B";
  if (n < 1024*1024) return (n/1024).toFixed(1)+" KB";
  return (n/1024/1024).toFixed(2)+" MB";
}

function renderImagePreview(){
  const wrap = document.getElementById("image-preview");
  if (!wrap) return;
  if (pendingImages.length === 0){ wrap.classList.add("hidden"); wrap.innerHTML=""; return; }
  wrap.classList.remove("hidden");
  wrap.innerHTML = "";
  for (const img of pendingImages){
    const div = document.createElement("div");
    div.className = "img-thumb";
    div.innerHTML = `<img src="${img.dataUrl}" alt="${esc(img.name)}"><button class="remove" title="Remove">${ICONS.close}</button><span class="size">${esc(formatBytes(img.size))}</span>`;
    div.querySelector(".remove").addEventListener("click", ()=> removePendingImage(img.id));
    div.querySelector("img").addEventListener("click", ()=> window.open(img.dataUrl, "_blank"));
    wrap.append(div);
  }
  const more = document.createElement("div");
  more.style.cssText="font-size:10px;color:var(--dim2);align-self:center;padding:4px 6px";
  more.textContent = `${pendingImages.length}/${MAX_IMAGES} · ${formatBytes(pendingImages.reduce((a,b)=>a+b.size,0))}`;
  wrap.append(more);
}

function removePendingImage(id){
  pendingImages = pendingImages.filter(x=>x.id!==id);
  renderImagePreview();
}

function clearPendingImages(){
  pendingImages = [];
  renderImagePreview();
  const inp = document.getElementById("image-input");
  if (inp) inp.value = "";
}

function addPendingFiles(fileList){
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let added = 0;
  let skipped = 0;
  let total = pendingImages.reduce((a,b)=>a+b.size,0);
  for (const f of files){
    if (!f.type || !f.type.startsWith("image/")){
      // skip non-images
      skipped++;
      continue;
    }
    if (pendingImages.length >= MAX_IMAGES){ skipped++; continue; }
    if (f.size > MAX_IMAGE_BYTES){
      addMsg("system", `✗ ${f.name} too large (${formatBytes(f.size)} > ${formatBytes(MAX_IMAGE_BYTES)})`);
      continue;
    }
    if (total + f.size > MAX_TOTAL_BYTES){
      addMsg("system", `✗ not enough budget for ${f.name} (${formatBytes(total+f.size)} > ${formatBytes(MAX_TOTAL_BYTES)})`);
      continue;
    }
    // read as dataURL
    const reader = new FileReader();
    const id = ++imageSeq;
    const name = f.name;
    const size = f.size;
    reader.onload = () => {
      const dataUrl = reader.result;
      pendingImages.push({ id, name, dataUrl, size });
      renderImagePreview();
    };
    reader.onerror = () => addMsg("system", `✗ failed to read ${name}`);
    reader.readAsDataURL(f);
    total += f.size;
    added++;
  }
  if (skipped) addMsg("system", `↷ skipped ${skipped} non-image or over-limit file(s)`);
}

const BASE_PROMPT =
  "You are Meteor, a helpful coding assistant. Be concise and use full markdown: headings, bold, italic, lists, tables, blockquotes, links, and fenced code blocks with language tags. Always use markdown for structure and readability.";

const EDIT_PROTOCOL = `# Editing files
You can write files directly to the user's workspace. To create or modify a file, output ONE fenced block per file:

\`\`\`write:<relative/path/from/workspace/root>
<the ENTIRE new file content>
\`\`\`

Rules:
- Always output the complete file — never abbreviate with "..." or "unchanged".
- One block per file; use the exact relative path from the workspace root.
- Only emit write: blocks for files that actually change; describe the rest in prose.
- Use plain fenced blocks (with a language tag) only for snippets you are NOT writing to disk.`;

const TERMINAL_PROTOCOL = `# Terminal commands
To run a terminal command, output ONE fenced block per command:

\`\`\`exec
<single shell command>
\`\`\`

Rules:
- One command per block (e.g. \`npm run build\`, \`ls -la\`, \`node script.js\`)
- Every exec block requires user approval before it runs — never assume it executed
- After approval the output + exit code appear in "Terminal history" below — always check it for errors on your next turn and fix them
- Use plain fences (\`\`\`bash, \`\`\`sh, etc.) for snippets you do NOT want to execute`;

function esc(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const ICONS = {
  plus: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  undo: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 8H5v4"/><path d="M5 8a7 7 0 0112 5"/><circle cx="12" cy="12" r="10" opacity=".2"/></svg>`,
  settings: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 009 15a1.65 1.65 0 001-1.51V13a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82-.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 009 9a1.65 1.65 0 001-1.51V7a2 2 0 014 0v.09a1.65 1.65 0 001 1.51z"/></svg>`,
  theme: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>`,
  logout: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  chevronDown: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`,
  chevronRight: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`,
  chevronUp: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>`,
  file: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  fileCode: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/><polyline points="9 13 11 15 9 17"/><polyline points="15 13 13 15 15 17"/></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
  eyeOpen: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeClosed: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17.94 17.94A10.94 10.94 0 0112 19C5 19 1 12 1 12a20.3 20.3 0 015.06-6.94"/><path d="M9.53 9.53A3 3 0 0012 15a3 3 0 002.47-1.47"/><path d="M14.12 14.12L9.88 9.88"/><path d="M1 1l22 22"/></svg>`,
  send: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  terminal: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="8 10 12 14 8 18"/><line x1="14" y1="18" x2="20" y2="18"/></svg>`,
  editor: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
  layout: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  search: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  sparkle: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l2.4 7.2H22l-6.2 4.5 2.4 7.3L12 16.5 5.8 21l2.4-7.3L2 9.2h7.6z"/></svg>`,
  dot: `<svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg>`,
};
function icon(name, size){ return ICONS[name] || ""; }

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function statusReady() {
  return workspace ? `ready · ${workspace.name} · ${workspace.files.size} files` : "ready";
}

function setBusy(v) {
  busy = v;
  els.statusLeft.textContent = v ? "streaming…" : "ready";
  els.statusLeft.classList.toggle("busy", v);
  if (els.modelSelect) els.modelSelect.disabled = v;
  if (els.reasoningSelect) els.reasoningSelect.disabled = v;
}

function inlineFormat(s) {
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  s = s.replace(/\*([^*`]+?)\*/g, "<em>$1</em>");
  s = s.replace(/\b_([^_`\n]+?)_\b/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/&lt;(https?:\/\/[^&]+?)&gt;/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return s;
}

function renderMarkdown(src) {
  if (!src) return "";
  const codeBlocks = [];
  const inlineCodes = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="msg-code"><div class="msg-code-head">${esc(lang || "code")}</div><code>${esc(code.trimEnd())}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });
  src = src.replace(/`([^`\n]+?)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="inline">${esc(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  const parts = src.split(/(\x00(?:CB|IC)\d+\x00)/);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith("\x00")) {
      parts[i] = parts[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
  }
  src = parts.join("");

  const lines = src.split("\n");
  let html = "";
  let inUL = false;
  let inOL = false;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      const raw = para.join("\n");
      let inner = inlineFormat(raw);
      inner = inner.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
      inner = inner.replace(/\n/g, "<br>");
      html += `<p>${inner}</p>`;
      para = [];
    }
  };
  const closeLists = () => {
    if (inUL) { html += "</ul>"; inUL = false; }
    if (inOL) { html += "</ol>"; inOL = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^\x00CB\d+\x00$/.test(trimmed)) {
      flushPara(); closeLists();
      const idx = Number(trimmed.match(/\d+/)[0]);
      html += codeBlocks[idx];
      continue;
    }
    if (trimmed === "") {
      flushPara(); closeLists();
      continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); closeLists();
      const lvl = h[1].length;
      let inner = inlineFormat(h[2]);
      inner = inner.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
      html += `<h${lvl}>${inner}</h${lvl}>`;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1(\s*\1)*\s*$/.test(line)) {
      flushPara(); closeLists();
      html += "<hr>";
      continue;
    }
    if (/^\s*(?:>|&gt;)\s?(.*)$/.test(line)) {
      flushPara(); closeLists();
      const quotes = [];
      let j = i;
      while (j < lines.length && /^\s*(?:>|&gt;)\s?(.*)$/.test(lines[j])) {
        quotes.push(lines[j].replace(/^\s*(?:>|&gt;)\s?/, ""));
        j++;
      }
      let q = quotes.join("\n");
      q = inlineFormat(q);
      q = q.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
      q = q.replace(/\n/g, "<br>");
      html += `<blockquote>${q}</blockquote>`;
      i = j - 1;
      continue;
    }
    if (/^\s*\|\s*.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s|:-]+\|?[\s|:-]*$/.test(lines[i + 1])) {
      flushPara(); closeLists();
      const headerCells = line.split("|").map(s => s.trim()).filter(Boolean);
      html += '<table><thead><tr>';
      headerCells.forEach(c => {
        let inner = inlineFormat(c);
        inner = inner.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
        html += `<th>${inner}</th>`;
      });
      html += '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        const cells = lines[i].split("|").map(s => s.trim()).filter(Boolean);
        html += "<tr>";
        cells.forEach(c => {
          let inner = inlineFormat(c);
          inner = inner.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
          html += `<td>${inner}</td>`;
        });
        for (let k = cells.length; k < headerCells.length; k++) html += "<td></td>";
        html += "</tr>";
        i++;
      }
      html += "</tbody></table>";
      i--;
      continue;
    }
    let m;
    if (m = line.match(/^\s*[-*+]\s+(.*)$/)) {
      flushPara();
      if (inOL) { html += "</ol>"; inOL = false; }
      if (!inUL) { html += '<ul>'; inUL = true; }
      let inner = inlineFormat(m[1]);
      inner = inner.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
      const task = inner.match(/^\[( |x|X)\]\s*(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === "x" ? "checked" : "";
        html += `<li class="task"><input type="checkbox" disabled ${checked}> ${task[2]}</li>`;
      } else {
        html += `<li>${inner}</li>`;
      }
      const nxt = lines[i + 1] || "";
      if (!/^\s*[-*+]\s+/.test(nxt)) { html += "</ul>"; inUL = false; }
      continue;
    }
    if (m = line.match(/^\s*\d+\.\s+(.*)$/)) {
      flushPara();
      if (inUL) { html += "</ul>"; inUL = false; }
      if (!inOL) { html += '<ol>'; inOL = true; }
      let inner = inlineFormat(m[1]);
      inner = inner.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
      html += `<li>${inner}</li>`;
      const nxt = lines[i + 1] || "";
      if (!/^\s*\d+\.\s+/.test(nxt)) { html += "</ol>"; inOL = false; }
      continue;
    }
    para.push(line);
  }
  flushPara(); closeLists();
  html = html.replace(/\x00IC(\d+)\x00/g, (_, n) => inlineCodes[Number(n)] || "");
  html = html.replace(/\x00CB(\d+)\x00/g, (_, n) => codeBlocks[Number(n)] || "");
  return html || `<p>${esc(src).replace(/\n/g, "<br>")}</p>`;
}
const mdLite = renderMarkdown;

function mdFragment(text) {
  const div = document.createElement("div");
  div.innerHTML = text.trim() ? mdLite(text) : "";
  return div;
}

function updateCenterVisibility() {
  const center = document.getElementById("center-stage");
  const greeting = document.getElementById("greeting");
  const banner = document.getElementById("sub-banner");
  const tpl = document.getElementById("templates");
  const geo = document.getElementById("geo-bg");
  const stage = document.getElementById("stage");
  const composer = document.getElementById("composer-card");
  const bottom = document.getElementById("composer-bottom");
  if (!center || !composer || !bottom) return;
  const hasChat = chatHistory.length > 0 || els.messages.children.length > 1;
  if (greeting) greeting.style.display = hasChat ? "none" : "";
  if (banner) banner.style.display = hasChat ? "none" : "";
  if (tpl) tpl.style.display = hasChat ? "none" : "";
  if (geo) geo.style.display = hasChat ? "none" : "";
  if (hasChat) center.style.paddingBottom = "0";
  else center.style.paddingBottom = "";
  // move composer to bottom after first message
  if (hasChat) {
    if (composer.parentElement !== bottom) {
      const wasFocused = document.activeElement === els.input;
      bottom.append(composer);
      bottom.classList.remove("hidden");
      center.classList.add("composer-moved");
      if (stage) stage.classList.add("has-chat");
      composer.style.animation = "none";
      // force reflow then re-enable
      void composer.offsetHeight;
      composer.style.animation = "";
      if (wasFocused) setTimeout(()=> els.input?.focus(), 10);
    }
  } else {
    if (composer.parentElement === bottom) {
      const wasFocused = document.activeElement === els.input;
      // insert after greeting (second child)
      if (greeting && greeting.nextSibling) center.insertBefore(composer, greeting.nextSibling);
      else center.prepend(composer);
      bottom.classList.add("hidden");
      center.classList.remove("composer-moved");
      if (stage) stage.classList.remove("has-chat");
      if (wasFocused) setTimeout(()=> els.input?.focus(), 10);
    }
  }
}

function addMsg(role, text, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}${opts.error ? " error" : ""}`;
  if (opts.chatIndex !== undefined && opts.chatIndex !== null && (role==="user" || role==="assistant")) {
    wrap.dataset.chatIndex = String(opts.chatIndex);
  }
  const head = document.createElement("div");
  head.className = "msg-head";
  head.innerHTML = role === "user" ? `<span style="color:var(--accent);display:inline-flex;vertical-align:middle">${ICONS.dot}</span> you` : role === "system" ? `<span style="color:var(--dim);display:inline-flex;vertical-align:middle">${ICONS.dot}</span> system` : `<span style="color:var(--accent);display:inline-flex;vertical-align:middle">${ICONS.dot}</span> ${esc(opts.label || currentModel || "meteor")}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  if (opts.images && opts.images.length) {
    const imgRow = document.createElement("div");
    imgRow.className = "msg-images";
    for (const u of opts.images) {
      const im = document.createElement("img");
      im.src = u;
      im.loading = "lazy";
      im.alt = "attachment";
      im.addEventListener("click", () => window.open(u, "_blank"));
      imgRow.append(im);
    }
    body.append(imgRow);
  }
  if (role === "assistant" && !opts.error) {
    const txt = document.createElement("div");
    txt.innerHTML = text ? mdLite(text) : `<span class="cursor-blink">▌</span>`;
    body.append(txt);
  } else {
    if (text) {
      const t = document.createElement("div");
      t.textContent = text;
      t.style.whiteSpace = "pre-wrap";
      body.append(t);
    } else if (!opts.images || !opts.images.length) {
      body.textContent = "";
    }
  }
  wrap.append(head, body);
  els.messages.append(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  updateCenterVisibility();
  return { wrap, body };
}

function langFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "js";
  if (ext === "json") return "json";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "css") return "css";
  if (ext === "py") return "py";
  if (["sh", "bash", "zsh"].includes(ext)) return "sh";
  if (ext === "md") return "md";
  return "plain";
}

const RULES = {
  js: [
    { cls: "tok-comment", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
    { cls: "tok-string", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y },
    { cls: "tok-number", re: /\b\d[\d_]*(\.\d+)?([eE][+-]?\d+)?\b|0x[0-9a-fA-F]+\b/y },
    { cls: "tok-keyword", re: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|export|from|default|try|catch|finally|throw|async|await|yield|typeof|instanceof|in|of|delete|void|null|undefined|true|false|interface|type|enum|implements|readonly|public|private|protected|static|declare|namespace|as|is|keyof|never|unknown|any|string|number|boolean|symbol|bigint)\b/y },
  ],
  json: [
    { cls: "tok-string", re: /"(?:\\.|[^"\\])*"/y },
    { cls: "tok-number", re: /\b-?\d+(\.\d+)?([eE][+-]?\d+)?\b/y },
    { cls: "tok-keyword", re: /\b(true|false|null)\b/y },
  ],
  html: [
    { cls: "tok-comment", re: /<!--[\s\S]*?-->/y },
    { cls: "tok-string", re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y },
    { cls: "tok-tag", re: /<\/?[a-zA-Z][^>]*>/y },
  ],
  css: [
    { cls: "tok-comment", re: /\/\*[\s\S]*?\*\//y },
    { cls: "tok-string", re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y },
    { cls: "tok-number", re: /\b\d+(\.\d+)?(px|em|rem|%|vh|vw|deg)?\b/y },
  ],
  py: [
    { cls: "tok-comment", re: /#[^\n]*/y },
    { cls: "tok-string", re: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y },
    { cls: "tok-number", re: /\b\d+(\.\d+)?\b/y },
    { cls: "tok-keyword", re: /\b(def|class|import|from|as|if|elif|else|for|while|return|yield|try|except|finally|raise|with|pass|break|continue|and|or|not|in|is|lambda|global|nonlocal|assert|async|await|True|False|None|self)\b/y },
  ],
  sh: [
    { cls: "tok-comment", re: /#[^\n]*/y },
    { cls: "tok-string", re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y },
    { cls: "tok-keyword", re: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|local|in|select|until)\b/y },
  ],
  md: [
    { cls: "tok-heading", re: /^#{1,6}\s.*/my },
    { cls: "tok-string", re: /`[^`\n]+`|```[\s\S]*?```/y },
  ],
  plain: [],
};

function highlightWhole(code, lang) {
  if (code.length > 220000) return esc(code);
  const rules = RULES[lang] || RULES.plain;
  if (!rules.length) return esc(code);
  let out = "";
  let i = 0;
  while (i < code.length) {
    if (code[i] === "\n") { out += "\n"; i++; continue; }
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i) {
        out += `<span class="${r.cls}">${esc(m[0])}</span>`;
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) { out += esc(code[i]); i++; }
  }
  return out;
}

/* ---------------- diff (unified, subtle glass) ---------------- */
function diffLines(oldStr, newStr) {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  // edge: empty file
  if (oldStr === "") return b.map((line, i) => ({ type: i === b.length - 1 && line === "" ? "equal" : "add", text: line, newLine: i + 1 }));
  if (newStr === "") return a.map((line, i) => ({ type: "del", text: line, oldLine: i + 1 }));
  const m = a.length, n = b.length;
  // LCS DP with optimization for large files: limit to 800 lines each for perf
  const max = 800;
  const am = Math.min(m, max), bn = Math.min(n, max);
  const dp = Array(am + 1).fill(null).map(() => Array(bn + 1).fill(0));
  for (let i = am - 1; i >= 0; i--) for (let j = bn - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0, oldLine = 1, newLine = 1;
  while (i < am && j < bn) {
    if (a[i] === b[j]) { ops.push({ type: "equal", text: a[i], oldLine, newLine }); i++; j++; oldLine++; newLine++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "del", text: a[i], oldLine }); i++; oldLine++; }
    else { ops.push({ type: "add", text: b[j], newLine }); j++; newLine++; }
  }
  while (i < am) { ops.push({ type: "del", text: a[i], oldLine }); i++; oldLine++; }
  while (j < bn) { ops.push({ type: "add", text: b[j], newLine }); j++; newLine++; }
  // tail beyond max
  if (m > max) for (let k = max; k < m; k++) ops.push({ type: "del", text: a[k], oldLine: k + 1 });
  if (n > max) for (let k = max; k < n; k++) ops.push({ type: "add", text: b[k], newLine: k + 1 });
  return ops;
}

function diffStats(ops) {
  let add = 0, del = 0, eq = 0;
  for (const o of ops) { if (o.type === "add") add++; else if (o.type === "del") del++; else eq++; }
  return { add, del, eq, total: ops.length };
}

function renderDiff(oldStr, newStr, opts = {}) {
  const ops = diffLines(oldStr, newStr);
  const stats = diffStats(ops);
  const wrap = document.createElement("div");
  wrap.className = "diff-wrap";
  const head = document.createElement("div");
  head.className = "diff-head";
  head.innerHTML = `<span class="diff-stat add">+${stats.add}</span><span class="diff-stat del">-${stats.del}</span><span class="diff-file">${esc(opts.path || "")}</span><span class="spacer"></span><span class="diff-hint">${stats.total > 800 ? "truncated" : `${stats.add + stats.del} changes`}</span>`;
  wrap.append(head);
  const body = document.createElement("div");
  body.className = "diff-body";
  // group with 3 lines context, collapse equal runs > 6
  let eqRun = [];
  const flushEq = (force = false) => {
    if (eqRun.length === 0) return;
    if (!force && eqRun.length > 6) {
      for (let k = 0; k < 3; k++) body.append(diffLineEl(eqRun[k]));
      const gap = document.createElement("div");
      gap.className = "diff-gap";
      gap.textContent = `⋯ ${eqRun.length - 6} unchanged lines collapsed ⋯`;
      gap.addEventListener("click", () => {
        gap.remove();
        for (let k = 3; k < eqRun.length - 3; k++) body.append(diffLineEl(eqRun[k]));
        for (let k = eqRun.length - 3; k < eqRun.length; k++) body.append(diffLineEl(eqRun[k]));
      });
      body.append(gap);
      for (let k = eqRun.length - 3; k < eqRun.length; k++) body.append(diffLineEl(eqRun[k]));
    } else {
      for (const o of eqRun) body.append(diffLineEl(o));
    }
    eqRun = [];
  };
  for (const op of ops) {
    if (op.type === "equal") eqRun.push(op);
    else { flushEq(); body.append(diffLineEl(op)); }
  }
  flushEq(true);
  if (ops.length === 0) {
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = "no changes";
    body.append(empty);
  }
  wrap.append(body);
  return { wrap, ops, stats };
}

function diffLineEl(op) {
  const line = document.createElement("div");
  line.className = `diff-line diff-${op.type}`;
  const gutter = document.createElement("span");
  gutter.className = "diff-gutter";
  const oldN = op.oldLine ? String(op.oldLine).padStart(3, " ") : "   ";
  const newN = op.newLine ? String(op.newLine).padStart(3, " ") : "   ";
  gutter.textContent = `${oldN} ${newN}`;
  const sign = document.createElement("span");
  sign.className = "diff-sign";
  sign.textContent = op.type === "add" ? "+" : op.type === "del" ? "−" : " ";
  const text = document.createElement("span");
  text.className = "diff-text";
  text.textContent = op.text;
  line.append(gutter, sign, text);
  return line;
}

let undoStack = [];
function pushUndo(path, oldContent) {
  undoStack.push({ path, oldContent, at: Date.now() });
  if (undoStack.length > 50) undoStack.shift();
  updateUndoUI();
}
function updateUndoUI() {
  const btn = document.getElementById("btn-undo");
  if (!btn) return;
  btn.disabled = undoStack.length === 0;
  btn.title = undoStack.length ? `Undo ${undoStack[undoStack.length - 1].path} (${undoStack.length})` : "Nothing to undo";
  const cnt = document.getElementById("undo-count");
  if (cnt) cnt.textContent = undoStack.length ? String(undoStack.length) : "";
}

async function undoLast() {
  const last = undoStack.pop();
  if (!last || !workspace) { updateUndoUI(); return; }
  try {
    await window.meteorAPI.writeWorkspaceFile({ root: workspace.root, relPath: last.path, content: last.oldContent });
    workspace.files.set(last.path, { path: last.path, content: last.oldContent, size: last.oldContent.length });
    renderTree();
    const t = tabs.find((x) => x.rel === last.path);
    if (t) { t.buffer = last.oldContent; t.savedContent = last.oldContent; if (activeTabId === t.id) { els.editor.value = last.oldContent; updateHighlight(); } }
    addMsg("system", `Undid ${last.path}`);
  } catch (e) {
    addMsg("system", `✗ undo failed ${last.path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  updateUndoUI();
}

function updateHighlight() {
  const lang = langFor(els.fileName.textContent || "untitled");
  els.langLabel.textContent = lang === "plain" ? "plaintext" : lang;
  const code = els.editor.value;
  els.highlightCode.innerHTML = highlightWhole(code, lang) + "\n";
  updateGutter();
}

function updateGutter() {
  const n = els.editor.value.split("\n").length;
  const pad = String(n).length;
  els.gutter.textContent = Array.from({ length: n }, (_, i) => String(i + 1).padStart(pad, " ")).join("\n");
  els.gutter.scrollTop = els.editor.scrollTop;
}

function updateCursorPos() {
  const pos = els.editor.selectionStart ?? 0;
  const before = els.editor.value.slice(0, pos);
  const line = before.split("\n").length;
  const col = before.split("\n").pop().length + 1;
  els.cursorPos.textContent = `${line}:${col}`;
}

function setDirty(v) {
  els.dirtyFlag.classList.toggle("hidden", !v);
  renderTabs();
}

function setFileName(name) {
  els.fileName.textContent = name;
  els.fileName.title = name;
}

/* ---------------- workspace ---------------- */

async function openWorkspace() {
  const scan = await window.meteorAPI.openWorkspace();
  if (!scan) return;
  setWorkspace(scan);
}

function setWorkspace(scan) {
  workspace = {
    root: scan.root,
    name: scan.name,
    truncated: scan.truncated,
    files: new Map(scan.files.map((f) => [f.path, f])),
  };
  collapsedDirs.clear();
  els.wsRoot.textContent = workspace.name;
  els.wsRoot.title = workspace.root;
  els.sidebar?.classList.remove("hidden");
  const ccName = document.getElementById("cc-project-name");
  if (ccName) ccName.textContent = workspace.name || "MeteorCLI";
  renderTree();
  setBusy(false);
  termCwd = scan.root;
  termUpdatePrompt();
  refreshGitStatus();
  updateUndoUI();
  updateCenterVisibility();
}

async function refreshWorkspace() {
  if (!workspace) return;
  const scan = await window.meteorAPI.refreshWorkspace(workspace.root);
  const wasActive = activeTab();
  setWorkspace(scan);
  // Reload the open tab's content if the tab has no unsaved edits.
  if (wasActive?.rel && workspace.files.has(wasActive.rel)) {
    const t = activeTab();
    if (t && t.buffer === t.savedContent) {
      const f = workspace.files.get(t.rel);
      t.buffer = f.content ?? "";
      t.savedContent = t.buffer;
      els.editor.value = t.buffer;
      savedContent = t.buffer;
      setDirty(false);
      updateHighlight();
      updateCursorPos();
    }
  }
  addMsg("system", `↻ rescanned workspace · ${workspace.files.size} files`);
}

function closeWorkspace() {
  if (!workspace) return;
  const dirtyRels = tabs.filter((t) => t.rel && t.buffer !== t.savedContent);
  if (dirtyRels.length > 0 && !confirm(`Discard unsaved edits in ${dirtyRels.length} workspace file(s)?`)) return;
  workspace = null;
  collapsedDirs.clear();
  els.sidebar.classList.add("hidden");
  for (const t of [...tabs]) if (t.rel) closeTab(t.id, true);
  setBusy(false);
}

/* ── Projects (meteor_projects) ─────────────────────────────── */
function timeAgo(iso){
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff/60000);
  if (mins < 1) return "now";
  if (mins < 60) return mins + "m";
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return hrs + "h";
  const days = Math.floor(hrs/24);
  if (days === 1) return "1d";
  if (days < 7) return days + "d";
  if (days < 30) return Math.floor(days/7) + "w";
  return Math.floor(days/30) + "mo";
}

async function refreshProjects(){
  if (!currentUser) { projectsCache = []; renderProjects(); return; }
  try{
    if (!window.meteorAPI?.projects?.list) return;
    const list = await window.meteorAPI.projects.list();
    projectsCache = Array.isArray(list) ? list : [];
  } catch(e){ console.warn("listProjects", e); projectsCache = []; }
  renderProjects();
}

function renderProjects(){
  const container = document.getElementById("sb-projects");
  const tree = document.getElementById("tree");
  const gitPanel = document.getElementById("git-panel");
  if (!container) return;
  // preserve tree and gitPanel
  const treeClone = tree;
  const gitClone = gitPanel;
  // clear container
  container.innerHTML = "";
  if (!currentUser){
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = "Sign in to see projects";
    container.append(empty);
    if (treeClone) container.append(treeClone);
    if (gitClone) container.append(gitClone);
    return;
  }
  if (projectsCache.length === 0){
    const empty = document.createElement("div");
    empty.className = "sb-empty";
    empty.textContent = "No projects yet — open a folder and send a message to create one";
    container.append(empty);
  } else {
    for (const p of projectsCache){
      const isActive = p.id === currentProjectId;
      const isExpanded = expandedProjects.has(p.id) || isActive;
      const group = document.createElement("div");
      group.className = "project-group";
      const row = document.createElement("button");
      row.className = "proj-row" + (isActive ? " active" : "");
      row.title = `${p.name} — ${p.folder_path}\n${p.last_message || ""}\nClick to toggle chats, right-click to delete`;
      const folderIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/></svg>`;
      row.innerHTML = `${folderIcon} <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left">${esc(p.name)}</span><small style="color:var(--dim2);font-family:var(--mono);font-size:10px">${timeAgo(p.updated_at)}</small><span class="chev">${isExpanded ? ICONS.chevronDown : ICONS.chevronRight}</span>`;
      if (isActive) row.style.background = "rgba(255,106,42,.1)";
      const chats = document.createElement("div");
      chats.className = "project-chats" + (isExpanded ? "" : " hidden");
      if (p.last_message){
        const prev = document.createElement("button");
        prev.className = "sb-history-row";
        prev.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left">${esc(p.last_message.slice(0,40))}</span><small>${timeAgo(p.updated_at)}</small>`;
        prev.title = p.last_message + "\nClick to open project";
        prev.addEventListener("click", (e)=>{ e.stopPropagation(); switchProject(p.id); });
        chats.append(prev);
      } else {
        const emptyChat = document.createElement("div");
        emptyChat.className = "sb-empty";
        emptyChat.style.fontSize = "11px";
        emptyChat.textContent = "No chats yet";
        chats.append(emptyChat);
      }
      const openBtn = document.createElement("button");
      openBtn.className = "sb-history-row";
      openBtn.style.color = "var(--dim2)";
      openBtn.innerHTML = `<span>↗ Open folder</span><small style="opacity:.6">${esc(p.folder_path.split("/").pop() || "")}</small>`;
      openBtn.title = p.folder_path;
      openBtn.addEventListener("click", async (e)=>{ e.stopPropagation(); try{ const scan = await window.meteorAPI.refreshWorkspace(p.folder_path); if (scan) setWorkspace(scan); }catch{} switchProject(p.id); });
      chats.append(openBtn);
      row.addEventListener("click", ()=>{
        const nowHidden = chats.classList.contains("hidden");
        if (nowHidden){ chats.classList.remove("hidden"); expandedProjects.add(p.id); const c=row.querySelector(".chev"); if(c) c.innerHTML=ICONS.chevronDown; }
        else { chats.classList.add("hidden"); expandedProjects.delete(p.id); const c=row.querySelector(".chev"); if(c) c.innerHTML=ICONS.chevronRight; }
        persistExpanded();
        if (!isActive) switchProject(p.id);
      });
      row.addEventListener("contextmenu", async (e)=>{
        e.preventDefault();
        if (!confirm(`Delete project "${p.name}"?`)) return;
        try{ await window.meteorAPI.projects.delete(p.id); }catch(err){ addMsg("system", String(err)); return; }
        expandedProjects.delete(p.id); persistExpanded();
        if (currentProjectId === p.id){ currentProjectId = null; localStorage.removeItem("meteor:currentProjectId"); chatHistory = []; els.messages.innerHTML=""; const w = document.createElement("div"); w.className="msg assistant"; w.innerHTML='<div class="msg-head"><span style="color:var(--accent);display:inline-flex;vertical-align:middle"><svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg></span> meteor</div><div class="msg-body tui-box">Project deleted — select another or create a new one.</div>'; els.messages.append(w); updateCenterVisibility(); }
        await refreshProjects();
      });
      group.append(row, chats);
      container.append(group);
    }
  }
  if (treeClone) container.append(treeClone);
  if (gitClone) container.append(gitClone);
}

async function ensureProjectForCurrentMessage(firstMessage){
  if (!currentUser) return null;
  if (!workspace && !termCwd) return null;
  const folderPath = workspace?.root || termCwd || "";
  if (!folderPath) return null;
  const name = workspace?.name || folderPath.split("/").pop() || "Untitled";
  // check if we already have a project for this folder with currentProjectId matching
  if (currentProjectId){
    const existing = projectsCache.find(p=> p.id === currentProjectId);
    if (existing && existing.folder_path === folderPath){
      // update last_message
      try{ await window.meteorAPI.projects.update(existing.id, { last_message: firstMessage.slice(0,200), preview: firstMessage.slice(0,120) }); } catch{}
      await refreshProjects();
      return existing.id;
    }
  }
  // look for existing project with same folder_path
  const sameFolder = projectsCache.find(p=> p.folder_path === folderPath);
  if (sameFolder){
    currentProjectId = sameFolder.id;
    localStorage.setItem("meteor:currentProjectId", currentProjectId);
    try{ await window.meteorAPI.projects.update(sameFolder.id, { last_message: firstMessage.slice(0,200), preview: firstMessage.slice(0,120) }); } catch{}
    await refreshProjects();
    return sameFolder.id;
  }
  // create new
  try{
    const proj = await window.meteorAPI.projects.create({ name, folder_path: folderPath, last_message: firstMessage.slice(0,200) });
    currentProjectId = proj.id;
    localStorage.setItem("meteor:currentProjectId", currentProjectId);
    projectsCache.unshift(proj);
    renderProjects();
    return proj.id;
  } catch(e){
    console.warn("createProject", e);
    return null;
  }
}

async function switchProject(id){
  if (!id || id === currentProjectId) return;
  // save current chat to previous project
  if (currentProjectId && chatHistory.length){
    try{ await window.meteorAPI.projects.saveMessages(currentProjectId, chatHistory); } catch{}
    try{ await window.meteorAPI.projects.update(currentProjectId, { last_message: chatHistory.filter(m=>m.role==="user").pop()?.content ? String(chatHistory.filter(m=>m.role==="user").pop().content).slice(0,200) : undefined }); } catch{}
  }
  const proj = projectsCache.find(p=>p.id===id) || await window.meteorAPI.projects.get(id).catch(()=>null);
  if (!proj) { addMsg("system", "Project not found"); return; }
  currentProjectId = id;
  localStorage.setItem("meteor:currentProjectId", id);
  renderProjects();
  // load folder as workspace if exists
  if (proj.folder_path){
    try{
      const scan = await window.meteorAPI.refreshWorkspace(proj.folder_path);
      if (scan && scan.root) setWorkspace(scan);
      else {
        // fallback: try openWorkspace scan
        const s = await window.meteorAPI.refreshWorkspace(proj.folder_path);
        if (s) setWorkspace(s);
      }
    } catch(e){ console.warn("switchProject workspace", e); }
  }
  // load messages
  try{
    const msgs = await window.meteorAPI.projects.loadMessages(id);
    chatHistory = Array.isArray(msgs) ? msgs : [];
    els.messages.innerHTML = "";
    const welcome = document.createElement("div");
    welcome.className = "msg assistant";
    welcome.style.display = "none";
    welcome.innerHTML = '<div class="msg-head"><span style="color:var(--accent);display:inline-flex;vertical-align:middle"><svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg></span> meteor</div><div class="msg-body tui-box">Project: ' + esc(proj.name) + ' — ' + esc(proj.folder_path) + '</div>';
    els.messages.append(welcome);
    for (let i=0; i<chatHistory.length; i++){
      const m = chatHistory[i];
      if (m.role === "user"){
        const txt = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((c)=>c.text||"").join(" ") : String(m.content));
        const imgs = Array.isArray(m.content) ? m.content.filter((c)=>c.type==="image_url").map((c)=>c.image_url?.url).filter(Boolean) : [];
        addMsg("user", txt, { images: imgs, chatIndex: i });
      } else if (m.role === "assistant"){
        const txt = typeof m.content === "string" ? m.content : String(m.content);
        addMsg("assistant", txt, { chatIndex: i });
      } else {
        addMsg(m.role, typeof m.content === "string" ? m.content : String(m.content));
      }
    }
    updateCenterVisibility();
    addMsg("system", `↪ switched to ${proj.name}`);
  } catch(e){ console.warn("loadMessages", e); }
}

function buildTreeModel() {
  const root = { dirs: new Map(), files: [] };
  for (const f of workspace.files.values()) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function renderTree() {
  if (!workspace) return;
  els.tree.innerHTML = "";
  const model = buildTreeModel();
  const activeRel = activeTab()?.rel;

  const renderDir = (node, dirPath, depth, container) => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
      const child = node.dirs.get(name);
      const childPath = dirPath ? `${dirPath}/${name}` : name;
      const collapsed = collapsedDirs.has(childPath);
      const row = document.createElement("div");
      row.className = "tree-row";
      row.style.paddingLeft = 6 + depth * 12 + "px";
      row.innerHTML = `<span class="caret" style="display:inline-flex;vertical-align:middle">${collapsed ? ICONS.chevronRight : ICONS.chevronDown}</span><span>${esc(name)}</span>`;
      row.addEventListener("click", () => {
        if (collapsed) collapsedDirs.delete(childPath);
        else collapsedDirs.add(childPath);
        renderTree();
      });
      container.append(row);
      if (!collapsed) renderDir(child, childPath, depth + 1, container);
    }
    const fileNames = node.files.map((f) => f.path.split("/").pop()).sort((a, b) => a.localeCompare(b));
    for (const fname of fileNames) {
      const rel = dirPath ? `${dirPath}/${fname}` : fname;
      const f = workspace.files.get(rel);
      const row = document.createElement("div");
      row.className = "tree-row" + (rel === activeRel ? " active" : "") + (f.content === null ? " skipped" : "");
      row.style.paddingLeft = 6 + depth * 12 + 12 + "px";
      row.innerHTML = `<span class="tree-icon">·</span><span>${esc(fname)}</span>`;
      row.title = f.content === null ? `${rel} — ${f.skipReason}` : `${rel} — ${f.size} chars`;
      row.addEventListener("click", () => openWorkspaceFile(rel));
      container.append(row);
    }
  };

  renderDir(model, "", 0, els.tree);
  if (workspace.files.size === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "no files found";
    els.tree.append(empty);
  }
  if (workspace.truncated) {
    const note = document.createElement("div");
    note.className = "tree-empty";
    note.textContent = "scan truncated at 4000 files";
    els.tree.append(note);
  }
}

function openWorkspaceFile(rel, contentOverride) {
  const content = contentOverride !== undefined ? contentOverride : (workspace.files.get(rel)?.content ?? "");
  let t = tabs.find((x) => x.rel === rel);
  if (t) {
    if (t.buffer !== t.savedContent && t.buffer !== content && !confirm(`Discard unsaved edits in ${rel}?`)) return;
  } else {
    t = { id: ++tabSeq, name: rel.split("/").pop(), rel, absPath: null, buffer: content, savedContent: content };
    tabs.push(t);
  }
  t.buffer = content;
  t.savedContent = content;
  activateTab(t.id);
}

/* ---------------- tabs ---------------- */

function activateTab(id) {
  if (!editorVisible) setEditorVisible(true, { silent: true });
  const prev = activeTab();
  if (prev && prev.id !== id) prev.buffer = els.editor.value;
  activeTabId = id;
  const t = activeTab();
  if (!t) return;
  els.editor.value = t.buffer;
  savedContent = t.savedContent;
  setFileName(t.rel || t.name || "untitled");
  setDirty(els.editor.value !== savedContent);
  updateHighlight();
  updateCursorPos();
  renderTabs();
  renderTree();
}

function closeTab(id, force = false) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const t = tabs[idx];
  if (!force && t.buffer !== t.savedContent && !confirm(`Discard unsaved edits in ${t.rel || t.name}?`)) return;
  tabs.splice(idx, 1);
  if (activeTabId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) activateTab(next.id);
    else {
      activeTabId = null;
      els.editor.value = "";
      savedContent = "";
      setFileName("untitled");
      setDirty(false);
      updateHighlight();
      updateCursorPos();
      renderTabs();
      renderTree();
    }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  if (!els.tabs) return;
  els.tabs.innerHTML = "";
  els.tabs.classList.toggle("hidden", tabs.length === 0);
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeTabId ? " active" : "");
    const name = document.createElement("span");
    name.textContent = t.rel || t.name;
    el.append(name);
    if (t.id === activeTabId && els.editor.value !== t.savedContent) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      dot.innerHTML = ICONS.dot;
      el.append(dot);
    }
    const close = document.createElement("span");
    close.className = "tab-close";
    close.innerHTML = ICONS.close;
    close.title = "close";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    el.append(close);
    el.title = t.rel || t.absPath || t.name;
    el.addEventListener("click", () => activateTab(t.id));
    els.tabs.append(el);
  }
}

/* ---------------- file open/save ---------------- */

async function openFile() {
  const res = await window.meteorAPI.openFile();
  if (!res) return;
  const name = res.filePath.split("/").pop() || res.filePath;
  let t = tabs.find((x) => x.absPath === res.filePath);
  if (t) {
    if (t.buffer !== t.savedContent && !confirm(`Discard unsaved edits in ${t.name}?`)) return;
    t.buffer = res.content;
    t.savedContent = res.content;
    activateTab(t.id);
  } else {
    t = { id: ++tabSeq, name, rel: null, absPath: res.filePath, buffer: res.content, savedContent: res.content };
    tabs.push(t);
    activateTab(t.id);
  }
}

async function saveFile() {
  const t = activeTab();
  if (!t) return;
  const content = els.editor.value;
  t.buffer = content;
  if (workspace && t.rel) {
    const old = workspace.files.get(t.rel)?.content ?? t.savedContent;
    if (old !== content) pushUndo(t.rel, old ?? "");
    try {
      await window.meteorAPI.writeWorkspaceFile({ root: workspace.root, relPath: t.rel, content });
    } catch (err) {
      addMsg("system", `✗ failed to save ${t.rel}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const f = workspace.files.get(t.rel);
    if (f) {
      f.content = content;
      f.size = content.length;
    }
    refreshGitStatus();
  } else {
    const res = await window.meteorAPI.saveFile({ content, filePath: t.absPath ?? undefined });
    if (!res) return;
    t.absPath = res.filePath;
    t.name = res.filePath.split("/").pop() || res.filePath;
    setFileName(t.name);
  }
  t.savedContent = content;
  savedContent = content;
  setDirty(false);
  renderTabs();
  updateUndoUI();
}

let untitledSeq = 0;

function newFile() {
  untitledSeq += 1;
  const t = {
    id: ++tabSeq,
    name: untitledSeq === 1 ? "untitled" : `untitled-${untitledSeq}`,
    rel: null,
    absPath: null,
    buffer: "",
    savedContent: "",
  };
  tabs.push(t);
  activateTab(t.id);
  els.editor.focus();
}

/* ---------------- AI context ---------------- */

function clip(s, cap, label) {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n… [${label} truncated — ${s.length - cap} of ${s.length} chars omitted]`;
}

function pushTerminalLog(cmd, output, exitCode) {
  terminalLog.push({ cmd, output: (output || "").slice(-8000), exitCode, at: Date.now() });
  if (terminalLog.length > 12) terminalLog.shift();
}

function terminalContext() {
  if (!terminalLog.length) return "";
  let out = "# Terminal history — check here for errors (most recent last)\n";
  for (const e of terminalLog.slice(-6)) {
    const body = clip(e.output || "(no output)", 6000, e.cmd);
    out += `\n$ ${e.cmd}\n${body}\n[exit ${e.exitCode}${e.exitCode !== 0 ? " — ERROR" : ""}]\n`;
  }
  return out;
}

function activeFileOverride() {
  const t = activeTab();
  if (workspace && t?.rel && els.editor.value !== t.savedContent) {
    return { path: t.rel, content: els.editor.value };
  }
  return null;
}

function workspaceContext() {
  const listing = [];
  for (const f of workspace.files.values()) {
    listing.push(f.content === null ? `${f.path}  (${f.skipReason})` : `${f.path}  (${f.size} chars)`);
  }
  let out = `# Workspace\nRoot: ${workspace.root}\nFiles (${workspace.files.size}):\n${listing.join("\n")}\n`;
  if (workspace.truncated) out += "(scan truncated — some directories may be missing)\n";

  let budget = CONTEXT_BUDGET - out.length;
  out += "\n# File contents\n";
  const override = activeFileOverride();
  const ordered = [];
  if (override) ordered.push(override);
  const rest = [...workspace.files.values()]
    .filter((f) => f.content !== null && f.path !== override?.path)
    .sort((a, b) => a.size - b.size);
  for (const f of rest) ordered.push(f);

  let omitted = 0;
  for (const f of ordered) {
    const cap = f === override ? ACTIVE_FILE_CAP : PER_FILE_CAP;
    const body = clip(f.content ?? "", cap, f.path);
    if (body.length + f.path.length + 16 > budget) {
      omitted += 1;
      continue;
    }
    budget -= body.length + f.path.length + 16;
    out += `\n=== ${f.path} ===\n${body}\n`;
  }
  if (omitted > 0) out += `\n(${omitted} more files exist but were omitted to fit the context budget)\n`;
  return out;
}

function singleFileContext() {
  const t = activeTab();
  const source = t?.rel ? null : t;
  if (!source || !els.editor.value) return null;
  const name = source.absPath || source.name;
  return `# Open file: ${name}\n\`\`\`${langFor(name)}\n${clip(els.editor.value, ACTIVE_FILE_CAP, name)}\n\`\`\`\n`;
}

function buildSystemMessage() {
  const modeNote = buildMode === "plan"
    ? "\n\n# Mode: PLAN — do NOT write files. Describe the build plan, list each file that would be created/modified with its path, and show snippets with normal ``` fences (not write:). The user will switch to Build to actually write."
    : "\n\n# Mode: BUILD — you may write files using write: blocks. New files will be created automatically, overwrites will ask for confirmation.";
  const withTerminal = `${EDIT_PROTOCOL}\n\n${TERMINAL_PROTOCOL}`;
  if (workspace) return `${BASE_PROMPT}${modeNote}\n\n${withTerminal}\n\n${workspaceContext()}\n\n${terminalContext()}`;
  const single = singleFileContext();
  if (single) return `${BASE_PROMPT}${modeNote}\n\n${TERMINAL_PROTOCOL}\n\n${single}\n\n${terminalContext()}`;
  return `${BASE_PROMPT}${modeNote}\n\n${TERMINAL_PROTOCOL}\n\n${terminalContext()}`;
}

/* ---------------- AI file edits ---------------- */

const WRITE_BLOCK_RE = /```write:[ \t]*([^\n`]+?)[ \t]*\n([\s\S]*?)\n?```/g;
const EXEC_BLOCK_RE = /```exec[ \t]*([^\n]*)\n([\s\S]*?)\n?```/g;

function normalizeEditPath(raw) {
  const p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.split("/").includes("..")) return null;
  return p;
}

function extractEdits(text) {
  const edits = [];
  WRITE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = WRITE_BLOCK_RE.exec(text))) {
    const path = normalizeEditPath(m[1]);
    edits.push({ raw: m[0], path, content: m[2], applied: false });
  }
  return edits;
}

function extractExecs(text) {
  const execs = [];
  EXEC_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = EXEC_BLOCK_RE.exec(text))) {
    const cmd = (m[1] + "\n" + m[2]).trim().replace(/^:\s*/, "");
    if (!cmd) continue;
    execs.push({ raw: m[0], cmd, approved: false, executed: false, output: "" });
  }
  return execs;
}

function isImportantEdit(edit) {
  if (!edit.path) return true;
  if (!workspace) return true;
  if (/^\.env(\.|$)/.test(edit.path)) return true;
  if (/\.key$|\.pem$|\.p12$/.test(edit.path)) return true;
  if (workspace.files.has(edit.path)) return true;
  return false;
}

function shouldAutoCreate(edit) {
  if (buildMode === "plan") return false;
  return autoCreateEnabled && !isImportantEdit(edit);
}

function setBuildMode(mode) {
  buildMode = mode === "plan" ? "plan" : "build";
  localStorage.setItem("meteor:buildMode", buildMode);
  document.querySelectorAll("#mode-seg [data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === buildMode);
  });
  const hint = document.getElementById("mode-hint");
  if (hint) hint.textContent = buildMode === "plan" ? "plan — preview only" : "build — writes files";
  const chk = document.getElementById("chk-auto");
  if (chk) {
    chk.disabled = buildMode === "plan";
    chk.parentElement.style.opacity = buildMode === "plan" ? "0.5" : "1";
    chk.parentElement.title = buildMode === "plan" ? "Auto-create off in plan mode" : "Auto-create new files";
  }
}

async function applyEdit(edit) {
  if (!workspace || !edit.path) return false;
  const old = workspace.files.get(edit.path)?.content ?? null;
  try {
    if (old !== null) pushUndo(edit.path, old);
    await window.meteorAPI.writeWorkspaceFile({ root: workspace.root, relPath: edit.path, content: edit.content });
    edit.applied = true;
    workspace.files.set(edit.path, { path: edit.path, content: edit.content, size: edit.content.length });
    renderTree();
    openWorkspaceFile(edit.path, edit.content);
    addMsg("system", `✓ wrote ${edit.path}`);
    refreshGitStatus();
    return true;
  } catch (err) {
    // rollback undo push if failed and it was new file (old null) we still pushed? remove last if old null and failed
    if (old !== null && undoStack.length && undoStack[undoStack.length - 1].path === edit.path) {
      // keep it for undo, but we pushed before write, so if write failed we should pop the push we just did? Actually we want to keep old for retry, so don't pop.
    }
    addMsg("system", `✗ failed to write ${edit.path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function buildEditBlock(edit) {
  const box = document.createElement("div");
  box.className = "file-change";
  if (shouldAutoCreate(edit) && edit.applied) box.classList.add("auto-applied");
  const oldContent = edit.path && workspace ? (workspace.files.get(edit.path)?.content ?? (edit.applied ? null : null)) : null;
  const hasOld = oldContent !== null && oldContent !== undefined;
  const isNewFile = !hasOld && edit.path && workspace && !workspace.files.has(edit.path);
  let add = 0, del = 0;
  if (hasOld) {
    const ops = diffLines(oldContent, edit.content);
    const st = diffStats(ops);
    add = st.add; del = st.del;
  } else if (edit.content) {
    const lines = edit.content.split("\n");
    // count lines ignoring final empty trailing line
    add = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  }
  const fileName = edit.path ? edit.path.split("/").pop() : "invalid";
  const dirPart = edit.path && edit.path.includes("/") ? edit.path.slice(0, edit.path.lastIndexOf("/")) : "";
  // header - IDE style
  const head = document.createElement("div");
  head.className = "file-change-head";
  head.title = edit.path || "invalid path";
  const icon = document.createElement("span");
  icon.className = "fc-icon";
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const codeExts = ["js","ts","tsx","jsx","py","json","html","css","md","sh","go","rs","cjs","mjs"];
  icon.innerHTML = codeExts.includes(ext) ? ICONS.fileCode : ICONS.file;
  const nameWrap = document.createElement("span");
  nameWrap.className = "fc-name";
  nameWrap.innerHTML = `<span class="fc-file">${esc(fileName)}</span>${dirPart ? `<span class="fc-dir">${esc(dirPart)}</span>` : ""}`;
  nameWrap.title = edit.path || "";
  const stats = document.createElement("span");
  stats.className = "fc-stats";
  if (add || del) {
    stats.innerHTML = `${add ? `<span class="add">+${add}</span>` : ""}${del ? `<span class="del">−${del}</span>` : ""}`;
  } else if (isNewFile && add) {
    stats.innerHTML = `<span class="add">+${add}</span>`;
  }
  const badge = document.createElement("span");
  badge.className = "fc-badge";
  if (!edit.path || !workspace) {
    badge.textContent = "no workspace";
    badge.classList.add("warn");
  } else if (shouldAutoCreate(edit) && edit.applied) {
    badge.textContent = "✓";
    badge.classList.add("ok");
    badge.title = "auto-created";
  } else if (isImportantEdit(edit) && edit.path && workspace) {
    badge.textContent = hasOld ? "•" : "new";
    badge.classList.add("warn");
    badge.title = hasOld ? "Needs apply — overwrites existing file" : "New file";
  } else {
    badge.style.display = "none";
  }
  const btn = document.createElement("button");
  btn.className = "fc-apply";
  if (!edit.path || !workspace) {
    btn.textContent = "—";
    btn.disabled = true;
  } else {
    const auto = shouldAutoCreate(edit);
    btn.textContent = edit.applied ? "applied" : auto ? "…" : "Apply";
    btn.disabled = edit.applied || (auto && !edit.applied);
    if (edit.applied) btn.classList.add("applied");
  }
  const expand = document.createElement("span");
  expand.className = "fc-expand";
  expand.innerHTML = ICONS.chevronRight;
  expand.title = "Show diff";
  head.append(icon, nameWrap, badge, stats, btn, expand);
  // click header toggles diff (unless apply button clicked)
  let diffWrap = null;
  let expanded = false;
  const toggleExpand = () => {
    if (!edit.path || !workspace) return;
    expanded = !expanded;
    expand.innerHTML = expanded ? ICONS.chevronDown : ICONS.chevronRight;
    if (diffWrap) diffWrap.classList.toggle("hidden", !expanded);
    if (expanded && !diffWrap) {
      if (hasOld) {
        const { wrap } = renderDiff(oldContent, edit.content, { path: edit.path });
        diffWrap = wrap;
      } else {
        const pre = document.createElement("pre");
        pre.className = "fc-preview";
        pre.textContent = edit.content.slice(0, 6000) + (edit.content.length > 6000 ? "\n… truncated" : "");
        diffWrap = document.createElement("div");
        diffWrap.className = "diff-wrap";
        diffWrap.append(pre);
      }
      diffWrap.classList.remove("hidden");
      box.append(diffWrap);
      // auto open in editor on expand
      openWorkspaceFile(edit.path, edit.content);
    }
  };
  head.addEventListener("click", (e) => {
    if (e.target === btn || btn.contains(e.target)) return;
    toggleExpand();
  });
  // apply
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (edit.applied) return;
    btn.textContent = "…";
    const ok = await applyEdit(edit);
    if (ok) {
      btn.textContent = "applied";
      btn.classList.add("applied");
      btn.disabled = true;
      badge.textContent = "✓";
      badge.classList.remove("warn");
      badge.classList.add("ok");
      // update stats to applied state
      if (diffWrap) diffWrap.classList.add("applied");
    } else {
      btn.textContent = "Apply";
    }
  });
  // open file on name click (also toggle)
  nameWrap.addEventListener("click", (e) => {
    e.stopPropagation();
    if (edit.path && workspace) openWorkspaceFile(edit.path, edit.content);
    toggleExpand();
  });
  box.append(head);
  return box;
}

function extractEditsLive(text) {
  const edits = [];
  let idx = 0;
  while (true) {
    const start = text.indexOf("```write:", idx);
    if (start === -1) break;
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    const pathRaw = text.slice(start + "```write:".length, nl).trim();
    const path = normalizeEditPath(pathRaw);
    const contentStart = nl + 1;
    const nextFence = text.indexOf("\n```", contentStart);
    const nextWrite = text.indexOf("```write:", contentStart);
    let contentEnd, isComplete;
    if (nextFence !== -1 && (nextWrite === -1 || nextFence < nextWrite)) {
      contentEnd = nextFence;
      isComplete = true;
    } else if (nextWrite !== -1) {
      contentEnd = nextWrite;
      // trim trailing newline before next block
      if (text[contentEnd - 1] === "\n") contentEnd -= 1;
      isComplete = false;
    } else {
      if (text.endsWith("```")) {
        const lastFence = text.lastIndexOf("\n```");
        if (lastFence >= contentStart) { contentEnd = lastFence; isComplete = true; }
        else { contentEnd = text.length - 3; isComplete = true; }
      } else {
        contentEnd = text.length;
        isComplete = false;
      }
    }
    let content = text.slice(contentStart, contentEnd);
    if (content.endsWith("\n```")) content = content.slice(0, -4);
    if (content.endsWith("```")) content = content.slice(0, -3);
    edits.push({ path, raw: text.slice(start, contentEnd + (isComplete ? 4 : 0)), content, isComplete, applied: false, _livePath: pathRaw });
    if (!isComplete) break;
    idx = contentEnd + 4;
    if (idx >= text.length) break;
  }
  // dedupe by path keep last
  const byPath = new Map();
  for (const e of edits) { if (e.path) byPath.set(e.path, e); else byPath.set(`__invalid_${Math.random()}`, e); }
  return [...byPath.values()];
}

function buildLiveFileCard(edit) {
  // reuse buildEditBlock but mark incomplete
  const card = buildEditBlock(edit);
  if (edit.isComplete === false) {
    const badge = card.querySelector(".fc-badge");
    if (badge) { badge.textContent = "writing…"; badge.className = "fc-badge warn"; badge.style.display = ""; }
    const btn = card.querySelector(".fc-apply");
    if (btn) { btn.textContent = "…"; btn.disabled = true; }
    card.classList.add("live-writing");
  }
  return card;
}

function buildExecBlock(exec) {
  const box = document.createElement("div");
  box.className = "msg-exec";
  const head = document.createElement("div");
  head.className = "msg-exec-head";
  const icon = document.createElement("span");
  icon.innerHTML = ICONS.terminal;
  icon.style.color = "var(--accent)";
  icon.style.display = "inline-flex";
  const cmd = document.createElement("span");
  cmd.className = "exec-cmd";
  cmd.textContent = exec.cmd;
  cmd.title = exec.cmd;
  head.append(icon, cmd);
  const btnApprove = document.createElement("button");
  btnApprove.className = "btn-apply";
  const btnDeny = document.createElement("button");
  btnDeny.textContent = "deny";
  btnDeny.className = "btn-deny";
  const out = document.createElement("pre");
  out.className = "exec-out hidden";
  const status = document.createElement("span");
  status.className = "exec-status";
  const updateButtons = () => {
    if (exec.executed) {
      btnApprove.textContent = "ran ✓";
      btnApprove.disabled = true;
      btnApprove.classList.add("applied");
      btnDeny.style.display = "none";
    } else if (exec.denied) {
      btnApprove.style.display = "none";
      btnDeny.textContent = "denied";
      btnDeny.disabled = true;
    } else {
      btnApprove.textContent = "approve & run";
      btnDeny.textContent = "deny";
    }
  };
  updateButtons();
  btnApprove.addEventListener("click", async () => {
    if (exec.executed || exec.denied) return;
    if (!termVisible) setTerminalVisible(true);
    exec.approved = true;
    btnApprove.textContent = "running…";
    btnApprove.disabled = true;
    btnDeny.disabled = true;
    out.classList.remove("hidden");
    out.textContent = "";
    status.textContent = "running…";
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let buf = "";
    let full = "";
    const flush = () => {
      if (buf) {
        out.textContent += termStripAnsi(buf);
        buf = "";
        out.scrollTop = out.scrollHeight;
        termAppend("out", termStripAnsi(out.textContent.slice(-4000)));
      }
    };
    const offData = window.meteorAPI.termOnData(id, (chunk) => {
      full += chunk;
      buf += chunk;
      if (buf.includes("\n") || buf.length > 300) flush();
      const termOut = document.getElementById("term-output");
      if (termOut) {
        const div = document.createElement("div");
        div.className = "term-line out";
        div.textContent = termStripAnsi(chunk);
        termOut.append(div);
        termOut.scrollTop = termOut.scrollHeight;
      }
    });
    const offExit = window.meteorAPI.termOnExit(id, (code) => {
      flush();
      pushTerminalLog(exec.cmd, full, code);
      offData(); offExit(); offClear();
      exec.executed = true;
      status.textContent = code === 0 ? "done ✓" : `exit ${code}`;
      status.className = code === 0 ? "edit-ok" : "edit-fail";
      termAppend(code === 0 ? "out" : "err", `▶ ${exec.cmd} — exit ${code}`);
      termUpdatePrompt();
      updateButtons();
    });
    const offClear = window.meteorAPI.termOnClear(id, () => {
      out.textContent = "";
    });
    termAppendPrompt(exec.cmd);
    try {
      await window.meteorAPI.termExec(id, exec.cmd);
    } catch (e) {
      const msg = String(e);
      out.textContent += `\n${msg}`;
      pushTerminalLog(exec.cmd, msg, 1);
      offData(); offExit(); offClear();
      exec.executed = true;
      status.textContent = "error";
      status.className = "edit-fail";
      updateButtons();
    }
  });
  btnDeny.addEventListener("click", () => {
    if (exec.executed || exec.denied) return;
    exec.denied = true;
    status.textContent = "denied";
    status.className = "edit-fail";
    updateButtons();
  });
  head.append(status, btnApprove, btnDeny);
  box.append(head, out);
  return box;
}

/* ---------------- MCP tool calls (glassy) ---------------- */
function buildMcpToolBlock(call) {
  const box = document.createElement("div");
  box.className = "msg-mcp-tool";
  box.dataset.toolId = call.id;
  const head = document.createElement("div");
  head.className = "msg-mcp-head";
  const icon = document.createElement("span");
  icon.innerHTML = ICONS.sparkle;
  icon.style.color = "var(--blue)";
  icon.style.display = "inline-flex";
  const name = document.createElement("span");
  name.className = "mcp-tool-name";
  name.textContent = `${call.server} · ${call.tool}`;
  name.title = call.name;
  const badge = document.createElement("span");
  badge.className = "mcp-tool-badge";
  badge.textContent = "calling…";
  const argsPre = document.createElement("pre");
  argsPre.className = "mcp-tool-args";
  try { argsPre.textContent = JSON.stringify(call.parsedArgs ?? JSON.parse(call.arguments || "{}"), null, 2); } catch { argsPre.textContent = call.arguments || "{}"; }
  head.append(icon, name, badge);
  const out = document.createElement("pre");
  out.className = "mcp-tool-out hidden";
  out.textContent = "";
  box.append(head, argsPre, out);
  box._badge = badge;
  box._out = out;
  box._argsPre = argsPre;
  return box;
}
function updateMcpToolResult(box, result, isError) {
  if (!box) return;
  const badge = box._badge;
  const out = box._out;
  if (badge) { badge.textContent = isError ? "error" : "done ✓"; badge.className = isError ? "mcp-tool-badge error" : "mcp-tool-badge ok"; }
  if (out) {
    out.textContent = typeof result === "string" ? result.slice(0, 8000) : JSON.stringify(result, null, 2).slice(0, 8000);
    out.classList.remove("hidden");
    if (isError) out.classList.add("error");
  }
}

/* ---------------- Git status (sidebar) ---------------- */
let gitStatusCache = null;
async function refreshGitStatus() {
  const el = document.getElementById("git-status");
  const list = document.getElementById("git-file-list");
  const statEl = document.getElementById("git-stat");
  if (!el || !list) return;
  try {
    const res = await window.meteorAPI.git.status();
    if (!res.ok) {
      el.textContent = res.error && res.error.includes("not a git repo") ? "not a repo" : res.error || "no git";
      list.innerHTML = "";
      if (statEl) statEl.textContent = "";
      gitStatusCache = null;
      return;
    }
    gitStatusCache = res;
    const files = res.files || [];
    el.textContent = files.length ? `${files.length} changed` : "clean";
    el.title = (res.log || "").slice(0, 300);
    if (statEl) statEl.textContent = (res.diffStat || "").split("\n").slice(0, 3).join(" · ").slice(0, 120);
    list.innerHTML = "";
    for (const f of files.slice(0, 80)) {
      const row = document.createElement("div");
      row.className = "git-row";
      const dot = document.createElement("span");
      dot.className = `git-dot ${f.staged !== " " && f.staged !== "?" ? "staged" : ""} ${f.unstaged !== " " ? "unstaged" : ""}`;
      dot.textContent = f.status.trim() || "·";
      dot.title = `staged:${f.staged} unstaged:${f.unstaged}`;
      const name = document.createElement("span");
      name.className = "git-path";
      name.textContent = f.path;
      name.title = f.path;
      row.append(dot, name);
      row.addEventListener("click", async () => {
        // show diff in editor or in tool block
        try {
          const diffRes = await window.meteorAPI.git.diffFile(f.path, false);
          if (diffRes.ok && diffRes.diff) {
            // open in editor as diff preview
            const tab = { id: ++tabSeq, name: `${f.path} (diff)`, rel: null, absPath: null, buffer: diffRes.diff, savedContent: diffRes.diff };
            tabs.push(tab);
            activateTab(tab.id);
          } else {
            addMsg("system", diffRes.error || "no diff");
          }
        } catch (e) { addMsg("system", String(e)); }
      });
      list.append(row);
    }
    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "git-empty";
      empty.textContent = "working tree clean";
      list.append(empty);
    }
  } catch (e) {
    el.textContent = "git error";
    if (list) list.innerHTML = `<div class="git-empty">${esc(String(e))}</div>`;
  }
}

async function renderAssistantFinal(body, text) {
  body.innerHTML = "";
  const edits = extractEdits(text);
  const execs = extractExecs(text);
  for (const edit of edits) {
    if (shouldAutoCreate(edit)) {
      await applyEdit(edit);
    }
  }
  const pending = edits.filter((e) => e.path && workspace && !e.applied);
  const autoCount = edits.filter((e) => e.applied).length;
  if (edits.length > 1) {
    const bar = document.createElement("div");
    bar.className = "apply-all-bar";
    const label = document.createElement("span");
    if (autoCount > 0 && pending.length > 0) {
      label.textContent = `${autoCount} auto-created, ${pending.length} need apply`;
    } else if (autoCount > 0) {
      label.textContent = `${autoCount} file(s) auto-created ✓`;
      label.className = "edit-ok";
    } else {
      label.textContent = `${edits.length} file changes proposed`;
    }
    bar.append(label);
    if (pending.length > 0) {
      const btnAll = document.createElement("button");
      btnAll.textContent = `apply remaining ${pending.length}`;
      btnAll.addEventListener("click", async () => {
        btnAll.disabled = true;
        btnAll.textContent = "writing…";
        for (const edit of pending) {
          if (!edit.applied) await applyEdit(edit);
        }
        btnAll.textContent = "done";
        await renderAssistantFinal(body, text);
      });
      bar.append(btnAll);
    }
    body.append(bar);
  } else if (autoCount === 1 && edits.length === 1) {
    const note = document.createElement("div");
    note.className = "apply-all-bar";
    note.style.borderStyle = "solid";
    note.style.background = "transparent";
    const label = document.createElement("span");
    label.className = "edit-ok";
    label.textContent = `✓ auto-created ${edits[0].path}`;
    note.append(label);
    body.append(note);
  }
  if (execs.length > 1) {
    const bar = document.createElement("div");
    bar.className = "apply-all-bar";
    bar.style.borderColor = "var(--border)";
    const label = document.createElement("span");
    label.textContent = `${execs.length} terminal commands — each needs approval`;
    label.style.color = "var(--dim)";
    bar.append(label);
    body.append(bar);
  }
  const blocks = [];
  WRITE_BLOCK_RE.lastIndex = 0;
  let mm;
  while ((mm = WRITE_BLOCK_RE.exec(text))) blocks.push({ type: "write", index: mm.index, end: mm.index + mm[0].length, raw: mm[0] });
  EXEC_BLOCK_RE.lastIndex = 0;
  while ((mm = EXEC_BLOCK_RE.exec(text))) blocks.push({ type: "exec", index: mm.index, end: mm.index + mm[0].length, raw: mm[0] });
  blocks.sort((a, b) => a.index - b.index);
  let last = 0;
  let editIdx = 0;
  let execIdx = 0;
  for (const b of blocks) {
    const before = text.slice(last, b.index);
    if (before.trim()) body.append(mdFragment(before));
    if (b.type === "write") {
      const edit = edits[editIdx++];
      if (edit) body.append(buildEditBlock(edit));
    } else {
      const exec = execs[execIdx++];
      if (exec) body.append(buildExecBlock(exec));
    }
    last = b.end;
  }
  const tail = text.slice(last);
  if (tail.trim()) body.append(mdFragment(tail));
  if (!body.childNodes.length) body.innerHTML = `<span class="cursor-blink">▌</span>`;
}

/* ---------------- chat ---------------- */

async function sendCurrent() {
  if (!currentUser) {
    addMsg("system", "Please sign in to use Meteor — authentication required.");
    showAuthOverlay();
    return;
  }
  const raw = els.input.value;
  const text = raw.trim();
  const hasImages = pendingImages.length > 0;
  if ((!text && !hasImages) || busy) return;
  // slash commands only when no images
  if (!hasImages) {
    if (text === "/clear" || text === "/new") {
      els.input.value = "";
      autoSizeInput();
      document.getElementById("btn-clear")?.click();
      return;
    }
    if (text === "/help") {
      els.input.value = "";
      autoSizeInput();
      addMsg("system", "/model [name] — switch model (sunlight-2, sunlight-2-pro)\n/reasoning [auto|low|high|max] — set reasoning effort (current: " + (currentReasoningEffort || "auto") + ")\n/clear — clear chat\n/help — show this");
      return;
    }
    if (text === "/model" || text.startsWith("/model ")) {
      const target = text.slice(6).trim();
      els.input.value = "";
      autoSizeInput();
      if (!target) {
        const cur = models.find((m) => m.key === currentModel);
        addMsg("system", `Current: ${cur ? `${cur.name}${cur.key === "sunlight-2-pro" ? " (Unlimited)" : ""}` : currentModel} (${currentModel}) · reasoning: ${currentReasoningEffort || "auto"}. Available models: ${models.map((m) => `${m.key} (${m.name}${m.key === "sunlight-2-pro" ? " (Unlimited)" : ""})`).join(", ")} · reasoning: auto, low, high, max`);
      } else {
        const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        let f = models.find((m) => m.key.toLowerCase() === target.toLowerCase() || m.name.toLowerCase() === target.toLowerCase());
        if (!f) f = models.find((m) => norm(m.key) === norm(target) || norm(m.name) === norm(target));
        if (f) {
          currentModel = f.key;
          els.modelSelect.value = currentModel;
          localStorage.setItem("meteor:chatModel", currentModel);
          addMsg("system", `switched to ${f.name}${f.key === "sunlight-2-pro" ? " (Unlimited)" : ""} · reasoning: ${currentReasoningEffort || "auto"}`);
        } else {
          addMsg("system", `Unknown model "${target}". Available: ${models.map((m) => m.key).join(", ")}`);
        }
      }
      return;
    }
    if (text === "/reasoning" || text.startsWith("/reasoning ")) {
      const target = text.slice("/reasoning".length).trim().toLowerCase();
      els.input.value = "";
      autoSizeInput();
      const allowed = ["", "auto", "low", "high", "max"];
      if (!target) {
        addMsg("system", `Reasoning effort: ${currentReasoningEffort || "auto"} (auto = model default). Available: ${allowed.filter(Boolean).join(", ")}`);
        if (els.reasoningSelect) els.reasoningSelect.focus();
      } else if (!allowed.includes(target)) {
        addMsg("system", `Unknown reasoning "${target}". Available: ${allowed.filter(Boolean).join(", ")}`);
      } else {
        const next = target === "auto" ? "" : target;
        currentReasoningEffort = next;
        localStorage.setItem("meteor:reasoningEffort", next);
        if (els.reasoningSelect) els.reasoningSelect.value = next;
        addMsg("system", `reasoning effort → ${next || "auto"}`);
      }
      return;
    }
  }
  // capture images before clearing
  const imgs = [...pendingImages];
  const imageUrls = imgs.map(i=>i.dataUrl);
  els.input.value = "";
  clearPendingImages();
  autoSizeInput();
  let userContent;
  if (hasImages) {
    const parts = [];
    if (text) parts.push({ type: "text", text });
    for (const im of imgs) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
    userContent = parts;
  } else {
    userContent = text;
  }
  chatHistory.push({ role: "user", content: userContent });
  addMsg("user", text, { images: imageUrls, chatIndex: chatHistory.length - 1 });
  // meteor_projects: create on first message for this folder
  if (currentUser) {
    try {
      const pid = await ensureProjectForCurrentMessage(text || (imageUrls.length ? "[image]" : ""));
      if (pid) {
        try { await window.meteorAPI.projects.saveMessages(pid, chatHistory); } catch {}
      }
    } catch(e){ console.warn("ensureProject", e); }
  }
  const reasoningLabel = currentReasoningEffort ? ` · ${currentReasoningEffort}` : "";
  const { wrap: assistantWrap, body } = addMsg("assistant", "", { label: currentModel + reasoningLabel, chatIndex: chatHistory.length });
  // reasoning container (hidden until first reasoning delta)
  const reasoningBox = document.createElement("div");
  reasoningBox.className = "reasoning hidden";
  const reasoningHead = document.createElement("button");
  reasoningHead.className = "reasoning-head";
  reasoningHead.innerHTML = `<span class="reasoning-caret" style="display:inline-flex">${ICONS.chevronDown}</span><span class="reasoning-title">Reasoning</span><span class="reasoning-effort">${esc(currentReasoningEffort || "auto")}</span><span class="reasoning-status">thinking…</span>`;
  const reasoningBody = document.createElement("div");
  reasoningBody.className = "reasoning-body";
  reasoningBody.textContent = "";
  reasoningBox.append(reasoningHead, reasoningBody);
  let reasoningExpanded = true;
  let reasoningAcc = "";
  let reasoningStart = Date.now();
  reasoningHead.addEventListener("click", () => {
    reasoningExpanded = !reasoningExpanded;
    reasoningBody.classList.toggle("collapsed", !reasoningExpanded);
    const caret = reasoningHead.querySelector(".reasoning-caret");
    if (caret) caret.innerHTML = reasoningExpanded ? ICONS.chevronDown : ICONS.chevronRight;
  });
  body.append(reasoningBox);
  const liveFilesDiv = document.createElement("div");
  liveFilesDiv.className = "live-files";
  body.append(liveFilesDiv);
  // split body into text + tools so streaming doesn't clobber tool blocks
  const textDiv = document.createElement("div");
  textDiv.className = "msg-text-stream";
  const toolsDiv = document.createElement("div");
  toolsDiv.className = "msg-tools";
  body.append(textDiv, toolsDiv);
  let acc = "";
  function stripWritesForDisplay(s){
    // hide ```write: blocks from chat text — file cards show them instead
    return s.replace(/```write:\s*[^\n]*\n[\s\S]*?(?:\n```|$)/g, (m)=>{
      // keep prose before/after, remove the whole fence
      // if incomplete (no closing), still remove from start to end
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
  }
  function refreshLiveFiles(){
    const edits = extractEditsLive(acc);
    liveFilesDiv.innerHTML = "";
    if (!edits.length) { liveFilesDiv.style.display = "none"; return; }
    liveFilesDiv.style.display = "";
    for (const ed of edits) {
      const card = buildLiveFileCard(ed);
      liveFilesDiv.append(card);
    }
  }
  const toolBlocks = new Map();
  const onToolCallUI = (call) => {
    const id = call.id || call.tool || call.name || `${Date.now()}`;
    if (toolBlocks.has(id)) return;
    const block = buildMcpToolBlock({ id, server: call.server || "mcp", tool: call.tool || call.name || "unknown", name: call.name || `${call.server}__${call.tool}`, arguments: call.arguments || "{}", parsedArgs: call.parsedArgs });
    toolBlocks.set(id, block);
    toolsDiv.append(block);
    els.messages.scrollTop = els.messages.scrollHeight;
  };
  const onToolResultUI = (res) => {
    const b = toolBlocks.get(res.id) || [...toolBlocks.values()].slice(-1)[0];
    if (b) updateMcpToolResult(b, res.result, !!res.isError);
    // also log to terminal history for context
    pushTerminalLog(`${res.server || "mcp"}:${res.tool || ""}`, typeof res.result === "string" ? res.result : JSON.stringify(res.result), res.isError ? 1 : 0);
  };
  setBusy(true);
  const stop = window.meteorAPI.stream(
    { modelKey: currentModel, reasoningEffort: currentReasoningEffort, messages: [{ role: "system", content: buildSystemMessage() }, ...chatHistory] },
    {
      onChunk: (delta) => {
        acc += delta;
        refreshLiveFiles();
        const display = stripWritesForDisplay(acc);
        if (display) {
          let renderSrc = display;
          const fences = (renderSrc.match(/```/g) || []).length;
          if (fences % 2 === 1) renderSrc += "\n```";
          textDiv.innerHTML = mdLite(renderSrc) + `<span class="cursor-blink">▌</span>`;
        } else textDiv.innerHTML = `<span class="cursor-blink">▌</span>`;
        els.messages.scrollTop = els.messages.scrollHeight;
      },
      onReasoning: (delta) => {
        if (!delta) return;
        if (reasoningBox.classList.contains("hidden")) {
          reasoningBox.classList.remove("hidden");
          reasoningStart = Date.now();
        }
        reasoningAcc += delta;
        // stream as monospace, preserve whitespace
        reasoningBody.textContent = reasoningAcc;
        reasoningBody.scrollTop = reasoningBody.scrollHeight;
        els.messages.scrollTop = els.messages.scrollHeight;
      },
      onToolCall: onToolCallUI,
      onToolResult: onToolResultUI,
      onToolInfo: (info) => {
        if (info && info.count) {
          const pill = document.createElement("div");
          pill.className = "tool-info";
          pill.innerHTML = `${ICONS.sparkle} ${info.count} MCP tools available`;
          pill.title = (info.tools || []).map((t) => `${t.server}.${t.name}`).join(", ");
          toolsDiv.append(pill);
        }
      },
      onToolDelta: (delta) => {
        // optional streaming of tool args — ignore for now, tool_call will come as complete
      },
      onDone: async (data) => {
        // finalize reasoning
        if (data && data.reasoning && !reasoningAcc) {
          reasoningAcc = data.reasoning;
          if (reasoningAcc) {
            reasoningBox.classList.remove("hidden");
            reasoningBody.textContent = reasoningAcc;
          }
        }
        if (reasoningAcc) {
          const elapsed = ((Date.now() - reasoningStart) / 1000).toFixed(1);
          const statusEl = reasoningHead.querySelector(".reasoning-status");
          if (statusEl) statusEl.textContent = `thought for ${elapsed}s · ${reasoningAcc.length} chars`;
          // auto-collapse after completion if text exists
          if (acc) {
            reasoningExpanded = false;
            reasoningBody.classList.add("collapsed");
            const caret = reasoningHead.querySelector(".reasoning-caret");
            if (caret) caret.innerHTML = ICONS.chevronRight;
          }
          reasoningHead.title = "Click to toggle reasoning";
        } else {
          reasoningBox.classList.add("hidden");
        }
        // hide live files before final render — final compact cards will replace them
        liveFilesDiv.style.display = "none";
        const displayFinal = stripWritesForDisplay(acc);
        textDiv.innerHTML = displayFinal ? mdLite(displayFinal) : "";
        // if no tool calls, render normal edits/execs
        // if tool calls happened, keep them visible and also render edits
        const finalText = data && data.text !== undefined ? data.text : acc;
        if (finalText !== acc) { acc = finalText; const d2 = stripWritesForDisplay(acc); textDiv.innerHTML = d2 ? mdLite(d2) : ""; }
        // preserve reasoning box after renderAssistantFinal (which clears body)
        const savedReasoningBox = reasoningAcc ? reasoningBox : null;
        await renderAssistantFinal(body, acc);
        if (savedReasoningBox) body.prepend(savedReasoningBox);
        // re-append toolsDiv after renderAssistantFinal cleared body — re-add tools
        if (toolsDiv.childNodes.length) body.append(toolsDiv);
        chatHistory.push({ role: "assistant", content: acc });
        if (chatHistory.length > 80) chatHistory.splice(0, chatHistory.length - 80);
        // persist to meteor_projects
        if (currentProjectId) {
          try { await window.meteorAPI.projects.saveMessages(currentProjectId, chatHistory); } catch {}
          try { await window.meteorAPI.projects.update(currentProjectId, { last_message: acc.slice(0,200) || text.slice(0,200), preview: acc.slice(0,120) }); await refreshProjects(); } catch {}
          // Sunlight 2 Pro title generation after first exchange
          if (chatHistory.length === 2) {
            const firstUserText = text;
            const firstAssistantText = acc;
            window.meteorAPI.projects.generateTitle(currentProjectId, firstUserText, firstAssistantText).then(async (res)=>{
              if (res?.title) await refreshProjects();
            }).catch(e=> console.warn("title generation", e?.message || String(e)));
          }
        }
        setBusy(false);
        refreshGitStatus();
        els.messages.scrollTop = els.messages.scrollHeight;
      },
      onError: (msg) => {
        textDiv.textContent = msg;
        body.parentElement.classList.add("error");
        if (reasoningAcc) {
          const statusEl = reasoningHead.querySelector(".reasoning-status");
          if (statusEl) statusEl.textContent = "error";
        }
        setBusy(false);
      },
    },
  );
  void stop;
}

function autoSizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(140, els.input.scrollHeight) + "px";
}

function bindDivider() {
  if (!els.divider || !els.divider.addEventListener) return;
  // divider now is horizontal between center and dock — resize dock height
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const dockMain = $("#main");
  els.divider.addEventListener("pointerdown", (e) => {
    if (!dockMain) return;
    dragging = true;
    startY = e.clientY;
    startH = dockMain.getBoundingClientRect().height;
    els.divider.setPointerCapture(e.pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  });
  window.addEventListener("pointermove", (e) => {
    if (!dragging || !dockMain) return;
    const dy = e.clientY - startY;
    const next = Math.min(window.innerHeight * 0.7, Math.max(180, startH - dy));
    const mainBody = document.getElementById("main-body");
    if (mainBody) mainBody.style.minHeight = next + "px";
    const termPane = document.getElementById("terminal-pane");
    if (dockMain) dockMain.style.minHeight = next + 40 + "px";
  });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
  // also support sidebar width drag via z-sidebar edge
  const sidebar = document.getElementById("z-sidebar");
  if (sidebar) {
    let sdrag = false, sx = 0, sw = 0;
    sidebar.addEventListener("pointerdown", (e) => {
      if (e.offsetX < sidebar.clientWidth - 8) return;
      sdrag = true; sx = e.clientX; sw = sidebar.getBoundingClientRect().width;
      document.body.style.cursor = "col-resize";
    });
    window.addEventListener("pointermove", (e) => {
      if (!sdrag) return;
      const dx = e.clientX - sx;
      const nw = Math.min(420, Math.max(240, sw + dx));
      sidebar.style.width = nw + "px";
    });
    window.addEventListener("pointerup", () => { sdrag = false; document.body.style.cursor=""; });
  }
}

let termHist = [];
let termHistIdx = -1;
let termBusy = false;
let termCwd = "";
let currentTermId = null;

function termStripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function termAppend(type, text) {
  const out = document.getElementById("term-output");
  if (!out) return;
  const div = document.createElement("div");
  div.className = `term-line ${type}`;
  div.textContent = text;
  out.append(div);
  out.scrollTop = out.scrollHeight;
}

function termAppendPrompt(cmd) {
  const out = document.getElementById("term-output");
  if (!out) return;
  const div = document.createElement("div");
  div.className = "term-line prompt";
  const base = termCwd ? termCwd.split("/").pop() || termCwd : "MeteorCLI";
  div.innerHTML = `<span class="p-host">${esc(base)}</span> <span style="color:var(--dim)">%</span> ${esc(cmd)}`;
  out.append(div);
  out.scrollTop = out.scrollHeight;
}

async function termUpdatePrompt() {
  try {
    termCwd = await window.meteorAPI.termGetCwd();
  } catch {}
  const el = document.getElementById("term-prompt");
  if (el) {
    const base = termCwd ? termCwd.split("/").pop() || termCwd : "~";
    el.textContent = `${base} % `;
  }
}

async function termExec(cmd) {
  if (termBusy) return;
  if (!termVisible) setTerminalVisible(true);
  termHist.push(cmd);
  termHistIdx = termHist.length;
  termAppendPrompt(cmd);
  termBusy = true;
  const input = document.getElementById("term-input");
  if (input) input.disabled = true;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  currentTermId = id;
  let buf = "";
  let full = "";
  const flush = () => {
    if (buf) {
      termAppend("out", termStripAnsi(buf));
      buf = "";
    }
  };
  const offData = window.meteorAPI.termOnData(id, (chunk) => {
    full += chunk;
    buf += chunk;
    if (buf.includes("\n") || buf.length > 200) flush();
  });
  const offExit = window.meteorAPI.termOnExit(id, async (code) => {
    flush();
    pushTerminalLog(cmd, full, code);
    if (code !== 0) termAppend("err", `exit ${code}`);
    offData(); offExit(); offClear();
    termBusy = false;
    currentTermId = null;
    if (input) input.disabled = false;
    await termUpdatePrompt();
    input?.focus();
  });
  const offClear = window.meteorAPI.termOnClear(id, () => {
    const out = document.getElementById("term-output");
    if (out) out.innerHTML = "";
  });
  try {
    await window.meteorAPI.termExec(id, cmd);
  } catch (e) {
    const msg = String(e);
    termAppend("err", msg);
    pushTerminalLog(cmd, msg, 1);
    offData(); offExit(); offClear();
    termBusy = false;
    currentTermId = null;
    if (input) input.disabled = false;
  }
}

function initTerminal() {
  const input = document.getElementById("term-input");
  const out = document.getElementById("term-output");
  if (!input || !out) return;
  termUpdatePrompt();
  window.meteorAPI.termGetInfo().then((info) => {
    if (info?.cwd) termCwd = info.cwd;
    termUpdatePrompt();
    const base = termCwd ? termCwd.split("/").pop() : "MeteorCLI";
    if (!out.childNodes.length) {
      termAppend("out", `${info?.user || "user"}@${info?.host || "host"} ${base} % — type a command, Enter to run, Ctrl+C to kill`);
    }
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input.value;
      input.value = "";
      if (!cmd.trim()) { termAppendPrompt(""); await termUpdatePrompt(); return; }
      await termExec(cmd);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (termHist.length && termHistIdx > 0) {
        termHistIdx--;
        input.value = termHist[termHistIdx] || "";
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (termHistIdx < termHist.length - 1) {
        termHistIdx++;
        input.value = termHist[termHistIdx] || "";
      } else {
        termHistIdx = termHist.length;
        input.value = "";
      }
    } else if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
      if (termBusy && currentTermId) {
        e.preventDefault();
        try { await window.meteorAPI.termKill(currentTermId); } catch {}
        termAppend("err", "^C");
        termBusy = false;
        currentTermId = null;
        input.disabled = false;
        termUpdatePrompt();
      }
    }
  });
  out.addEventListener("click", () => input.focus());
}

let termVisible = localStorage.getItem("meteor:termVisible") !== "false";
function setTerminalVisible(v, opts = {}) {
  termVisible = !!v;
  localStorage.setItem("meteor:termVisible", String(termVisible));
  const pane = document.getElementById("terminal-pane");
  const divider = document.getElementById("divider");
  const dock = document.getElementById("dock");
  const btn = document.getElementById("term-toggle");
  const btnDock = document.getElementById("term-toggle-dock");
  if (pane) pane.classList.toggle("hidden", !termVisible);
  if (divider) { divider.style.display = (!termVisible && !editorVisible) ? "none" : ""; divider.classList.toggle("hidden", !termVisible && !editorVisible); }
  if (dock) { dock.classList.toggle("term-collapsed", !termVisible); updateDockHidden(); }
  if (btn) { btn.classList.toggle("active", termVisible); btn.innerHTML = ICONS.terminal; btn.title = termVisible ? "Hide terminal (⌘J)" : "Show terminal (⌘J)"; }
  if (btnDock) {
    btnDock.classList.toggle("active", termVisible);
    btnDock.innerHTML = termVisible
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/></svg> Terminal`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3"/></svg> Show terminal`;
  }
  if (termVisible && !opts.silent) {
    const inp = document.getElementById("term-input");
    setTimeout(() => inp?.focus(), 30);
    const out = document.getElementById("term-output");
    if (out) out.scrollTop = out.scrollHeight;
  }
}
function toggleTerminal(){ setTerminalVisible(!termVisible); }

let editorVisible = localStorage.getItem("meteor:editorVisible") !== "false";
function updateDockHidden(){
  const dock = document.getElementById("dock");
  if (!dock) return;
  const bothHidden = !termVisible && !editorVisible;
  dock.classList.toggle("dock-hidden", bothHidden);
  const divider = document.getElementById("divider");
  if (divider) divider.classList.toggle("hidden", bothHidden);
}
function setEditorVisible(v, opts = {}) {
  editorVisible = !!v;
  localStorage.setItem("meteor:editorVisible", String(editorVisible));
  const pane = document.getElementById("editor-pane");
  const mainBody = document.getElementById("main-body");
  const dock = document.getElementById("dock");
  const btn = document.getElementById("editor-toggle");
  const btnDock = document.getElementById("editor-toggle-dock");
  if (pane) pane.classList.toggle("hidden", !editorVisible);
  if (mainBody) mainBody.classList.toggle("editor-collapsed", !editorVisible);
  if (dock) { dock.classList.toggle("editor-collapsed", !editorVisible); updateDockHidden(); }
  // when editor is hidden but terminal visible, terminal gets full height
  const termPane = document.getElementById("terminal-pane");
  if (termPane && termVisible) {
    if (!editorVisible) termPane.style.height = "320px";
    else termPane.style.height = "";
  }
  if (btn) { btn.classList.toggle("active", editorVisible); btn.innerHTML = ICONS.editor; btn.title = editorVisible ? "Hide editor (⌘E)" : "Show editor (⌘E)"; }
  if (btnDock) {
    btnDock.classList.toggle("active", editorVisible);
    btnDock.innerHTML = editorVisible
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg> Editor`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg> Show editor`;
  }
  if (editorVisible && !opts.silent) {
    setTimeout(() => { updateHighlight(); updateGutter(); }, 30);
  }
}
function toggleEditor(){ setEditorVisible(!editorVisible); }

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("meteor:theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) { btn.innerHTML = ICONS.theme; btn.title = theme === "light" ? "Dark mode" : "Light mode"; }
}

/* ───────────────── MCP / Settings ───────────────── */

let mcpServers = {};
let mcpStatuses = {};
let mcpEditing = null;
let mcpJsonDirty = false;

function mcpCountLabel() {
  const n = Object.keys(mcpServers).length;
  return `${n} server${n === 1 ? "" : "s"}`;
}

function mcpIsHttpType(t) {
  return t === "sse" || t === "http" || t === "streamable-http";
}

function parseMcpArgs(raw) {
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith("[") ) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
    } catch {}
  }
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function parseKeyValueLines(raw, sep = "=") {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf(sep);
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function stringifyEnv(env) {
  if (!env || typeof env !== "object") return "";
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

function stringifyHeaders(headers) {
  if (!headers || typeof headers !== "object") return "";
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\n");
}

function parseHeadersLines(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    // support "Key: value" or "Key=value"
    let idx = t.indexOf(":");
    let sepLen = 1;
    if (idx === -1) { idx = t.indexOf("="); sepLen = 1; }
    else sepLen = 1;
    if (idx === -1) continue;
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + sepLen).trim();
    if (k) out[k] = v;
  }
  return out;
}

function buildConfigFromForm() {
  const name = document.getElementById("mcp-name").value.trim();
  const type = document.getElementById("mcp-type").value;
  const command = document.getElementById("mcp-command").value.trim();
  const argsRaw = document.getElementById("mcp-args").value;
  const url = document.getElementById("mcp-url").value.trim();
  const envRaw = document.getElementById("mcp-env").value;
  const headersRaw = document.getElementById("mcp-headers").value;
  const cwd = document.getElementById("mcp-cwd").value.trim();
  const disabled = document.getElementById("mcp-disabled").checked;
  if (!name) throw new Error("Name is required");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Name must match [a-zA-Z0-9_-]+');
  const cfg = { type };
  if (mcpIsHttpType(type)) {
    if (!url) throw new Error("URL is required for sse/http type");
    try { new URL(url); } catch { throw new Error("URL is not valid"); }
    cfg.url = url;
  } else {
    if (!command) throw new Error("Command is required for stdio type");
    cfg.command = command;
    const args = parseMcpArgs(argsRaw);
    if (args.length) cfg.args = args;
  }
  const env = parseKeyValueLines(envRaw, "=");
  if (Object.keys(env).length) cfg.env = env;
  const headers = parseHeadersLines(headersRaw);
  if (Object.keys(headers).length) cfg.headers = headers;
  if (cwd) cfg.cwd = cwd;
  if (disabled) cfg.disabled = true;
  // For stdio also allow url? keep optional
  if (!mcpIsHttpType(type) && url) cfg.url = url;
  if (mcpIsHttpType(type) && command) cfg.command = command;
  return { name, config: cfg };
}

function fillForm(name, cfg) {
  document.getElementById("mcp-name").value = name || "";
  // lock name when editing
  document.getElementById("mcp-name").disabled = !!mcpEditing;
  document.getElementById("mcp-type").value = cfg?.type || (cfg?.url ? "sse" : "stdio");
  document.getElementById("mcp-command").value = cfg?.command || "";
  const args = cfg?.args;
  document.getElementById("mcp-args").value = Array.isArray(args) ? args.join("\n") : (args || "");
  document.getElementById("mcp-url").value = cfg?.url || "";
  document.getElementById("mcp-env").value = stringifyEnv(cfg?.env);
  document.getElementById("mcp-headers").value = stringifyHeaders(cfg?.headers);
  document.getElementById("mcp-cwd").value = cfg?.cwd || "";
  document.getElementById("mcp-disabled").checked = !!cfg?.disabled;
  syncFormType();
}

function syncFormType() {
  const type = document.getElementById("mcp-type").value;
  const isHttp = mcpIsHttpType(type);
  document.getElementById("mcp-field-url").classList.toggle("hidden", !isHttp);
  document.getElementById("mcp-field-command").classList.toggle("hidden", isHttp && false); // keep command visible for http as optional
  // Make url required visual: add * if http
  const urlLabel = document.querySelector("#mcp-field-url span");
  if (urlLabel) urlLabel.innerHTML = isHttp ? "URL <em>*</em>" : "URL";
}

function openSettings(tab = "servers") {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  switchSettingsTab(tab);
  loadMcp();
  document.body.style.overflow = "hidden";
}

function closeSettings() {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  hideMcpForm();
}

function switchSettingsTab(tab) {
  document.querySelectorAll(".settings-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("settings-tab-servers")?.classList.toggle("hidden", tab !== "servers");
  document.getElementById("settings-tab-json")?.classList.toggle("hidden", tab !== "json");
  if (tab === "json") syncJsonEditor();
}

async function loadMcp() {
  try {
    if (!window.meteorAPI?.mcp?.get) throw new Error("MCP API not available — rebuild app (npm run build) and restart Electron");
    const res = await window.meteorAPI.mcp.get();
    mcpServers = res.servers || {};
    mcpStatuses = {};
    if (res.withStatus) {
      for (const [k, v] of Object.entries(res.withStatus)) {
        mcpStatuses[k] = v.status || { state: "disconnected", at: 0 };
      }
    }
    // fill missing statuses
    for (const k of Object.keys(mcpServers)) if (!mcpStatuses[k]) mcpStatuses[k] = { state: "disconnected", at: 0 };
    renderMcpList();
    updateMcpCount();
    syncJsonEditorIfPristine();
  } catch (err) {
    const el = document.getElementById("mcp-status");
    if (el) { el.textContent = err instanceof Error ? err.message : String(err); el.className = "mcp-inline-status err"; }
  }
}

function updateMcpCount() {
  const el = document.getElementById("mcp-count");
  if (el) el.textContent = mcpCountLabel();
}

function renderMcpList() {
  const list = document.getElementById("mcp-list");
  const empty = document.getElementById("mcp-empty");
  if (!list) return;
  list.innerHTML = "";
  const showDisabled = document.getElementById("mcp-show-disabled")?.checked ?? true;
  const names = Object.keys(mcpServers).sort((a, b) => a.localeCompare(b));
  const visible = names.filter((n) => showDisabled || !mcpServers[n]?.disabled);
  if (empty) empty.classList.toggle("hidden", visible.length !== 0);
  if (visible.length === 0 && names.length !== 0) {
    const note = document.createElement("div");
    note.className = "mcp-empty";
    note.style.padding = "12px";
    note.innerHTML = `<span style="color:var(--dim)">All ${names.length} server(s) are disabled — toggle filter to show.</span>`;
    list.append(note);
    return;
  }
  for (const name of visible) {
    const cfg = mcpServers[name];
    const status = mcpStatuses[name] || { state: "disconnected" };
    const card = document.createElement("div");
    card.className = "mcp-card" + (cfg.disabled ? " disabled" : "");
    const typeLabel = cfg.type || (cfg.url ? "sse" : "stdio");
    const typeCls = typeLabel === "stdio" ? "type-stdio" : typeLabel === "sse" ? "type-sse" : "type-http";
    const dotState = status.state === "connected" ? "connected" : status.state === "error" ? "error" : status.state === "connecting" ? "connecting" : "disconnected";
    const cmdPreview = cfg.command ? `${esc(cfg.command)} ${(cfg.args || []).map(esc).join(" ")}`.trim() : "";
    const statusText = status.state === "connected" ? "connected ✓" : status.state === "error" ? "error" : status.state === "connecting" ? "connecting…" : cfg.disabled ? "disabled" : "disconnected";
    card.innerHTML = `
      <div class="mcp-card-head">
        <div class="mcp-card-name">${esc(name)} <small class="${typeCls}">${esc(typeLabel)}</small> ${cfg.disabled ? '<small style="color:var(--dim2)">disabled</small>' : ""}</div>
        <div class="mcp-card-actions">
          <span class="mcp-dot ${dotState}"></span>
          <span class="mcp-card-status ${dotState}">${statusText}</span>
          <button class="btn-connect" data-act="connect" style="padding:4px 10px;font-size:11px">${status.state === "connected" ? "Reconnect" : "Connect"}</button>
          <button data-act="edit" title="Edit">edit</button>
          <button data-act="dup" title="Duplicate">dup</button>
        </div>
      </div>
      <div class="mcp-card-body">
        ${cfg.command ? `<div class="row"><b>cmd</b><code>${esc(cmdPreview) || esc(cfg.command)}</code></div>` : ""}
        ${cfg.url ? `<div class="row"><b>url</b><code>${esc(cfg.url)}</code></div>` : ""}
        ${cfg.cwd ? `<div class="row"><b>cwd</b><code>${esc(cfg.cwd)}</code></div>` : ""}
        ${cfg.env ? `<div class="row"><b>env</b><code>${esc(Object.keys(cfg.env).join(", "))}</code></div>` : ""}
        ${cfg.headers ? `<div class="row"><b>hdr</b><code>${esc(Object.keys(cfg.headers).join(", "))}</code></div>` : ""}
        ${status.error ? `<div class="mcp-card-err">${esc(status.error)}</div>` : ""}
      </div>
    `;
    const btnConnect = card.querySelector('[data-act="connect"]');
    const btnEdit = card.querySelector('[data-act="edit"]');
    const btnDup = card.querySelector('[data-act="dup"]');
    if (btnConnect) btnConnect.addEventListener("click", () => connectMcp(name, btnConnect));
    if (btnEdit) btnEdit.addEventListener("click", () => showMcpForm(name));
    if (btnDup) btnDup.addEventListener("click", () => duplicateMcp(name));
    list.append(card);
  }
}

async function connectMcp(name, btn) {
  const orig = btn ? btn.textContent : "";
  const status = mcpStatuses[name] || { state: "disconnected" };
  if (btn) { btn.textContent = "connecting…"; btn.disabled = true; }
  mcpStatuses[name] = { state: "connecting", at: Date.now() };
  renderMcpList();
  const inline = document.getElementById("mcp-status");
  if (inline) { inline.textContent = `connecting ${name}…`; inline.className = "mcp-inline-status"; }
  try {
    await window.meteorAPI.mcp.test(name);
    mcpStatuses[name] = { state: "connected", at: Date.now() };
    if (inline) { inline.textContent = `✓ ${name} connected`; inline.className = "mcp-inline-status ok"; }
    addMsg("system", `✓ MCP ${name} connected`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    mcpStatuses[name] = { state: "error", error: msg, at: Date.now() };
    if (inline) { inline.textContent = `✗ ${name}: ${msg}`; inline.className = "mcp-inline-status err"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig || "Connect"; }
    renderMcpList();
  }
}

function showMcpForm(name) {
  const form = document.getElementById("mcp-form");
  const title = document.getElementById("mcp-form-title");
  const delBtn = document.getElementById("mcp-form-delete");
  if (!form) return;
  mcpEditing = name || null;
  if (name && mcpServers[name]) {
    fillForm(name, mcpServers[name]);
    if (title) title.textContent = `Edit ${name}`;
    if (delBtn) delBtn.classList.remove("hidden");
  } else {
    fillForm("", null);
    if (title) title.textContent = "New MCP server";
    if (delBtn) delBtn.classList.add("hidden");
    if (name) document.getElementById("mcp-name").value = name;
  }
  form.classList.remove("hidden");
  document.getElementById("mcp-name")?.focus();
  document.getElementById("mcp-form-error").textContent = "";
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideMcpForm() {
  const form = document.getElementById("mcp-form");
  if (form) form.classList.add("hidden");
  mcpEditing = null;
  const err = document.getElementById("mcp-form-error");
  if (err) err.textContent = "";
}

function duplicateMcp(name) {
  const cfg = mcpServers[name];
  if (!cfg) return;
  const base = `${name}-copy`;
  let dupName = base;
  let i = 2;
  while (mcpServers[dupName]) { dupName = `${base}-${i++}`; }
  showMcpForm(dupName);
  fillForm(dupName, cfg);
}

async function saveFromForm(e) {
  if (e) e.preventDefault();
  const errEl = document.getElementById("mcp-form-error");
  const btn = document.getElementById("mcp-form-save");
  let parsed;
  try {
    parsed = buildConfigFromForm();
  } catch (err) {
    if (errEl) errEl.textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  const wasEditing = mcpEditing;
  // If renaming, need to delete old key
  const next = { ...mcpServers };
  if (wasEditing && wasEditing !== parsed.name) {
    delete next[wasEditing];
  }
  next[parsed.name] = parsed.config;
  if (btn) { btn.textContent = "saving…"; btn.disabled = true; }
  if (errEl) errEl.textContent = "";
  try {
    const res = await window.meteorAPI.mcp.save(next);
    mcpServers = res.servers || next;
    mcpStatuses[parsed.name] = mcpStatuses[parsed.name] || mcpStatuses[wasEditing] || { state: "disconnected", at: 0 };
    if (wasEditing && wasEditing !== parsed.name) delete mcpStatuses[wasEditing];
    renderMcpList();
    updateMcpCount();
    syncJsonEditor();
    hideMcpForm();
    const inline = document.getElementById("mcp-status");
    if (inline) { inline.textContent = `✓ saved ${parsed.name}`; inline.className = "mcp-inline-status ok"; setTimeout(() => { if (inline.textContent.startsWith("✓ saved")) inline.textContent = ""; }, 2200); }
  } catch (err) {
    if (errEl) errEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    if (btn) { btn.textContent = "Save server"; btn.disabled = false; }
  }
}

async function deleteCurrentMcp() {
  if (!mcpEditing) return;
  if (!confirm(`Delete MCP server "${mcpEditing}"?`)) return;
  const errEl = document.getElementById("mcp-form-error");
  const next = { ...mcpServers };
  delete next[mcpEditing];
  try {
    const res = await window.meteorAPI.mcp.save(next);
    mcpServers = res.servers || next;
    delete mcpStatuses[mcpEditing];
    renderMcpList();
    updateMcpCount();
    syncJsonEditor();
    hideMcpForm();
  } catch (err) {
    if (errEl) errEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

function syncJsonEditor() {
  const editor = document.getElementById("mcp-json-editor");
  if (!editor) return;
  const payload = Object.keys(mcpServers).length === 0 ? '{\n  "mcpServers": {}\n}' : JSON.stringify({ mcpServers }, null, 2);
  editor.value = payload;
  mcpJsonDirty = false;
  const ok = document.getElementById("mcp-json-ok");
  const err = document.getElementById("mcp-json-error");
  if (ok) ok.classList.add("hidden");
  if (err) err.textContent = "";
}

function syncJsonEditorIfPristine() {
  const editor = document.getElementById("mcp-json-editor");
  if (!editor) return;
  if (mcpJsonDirty) return;
  syncJsonEditor();
}

async function handleJsonValidate() {
  const editor = document.getElementById("mcp-json-editor");
  const errEl = document.getElementById("mcp-json-error");
  const okEl = document.getElementById("mcp-json-ok");
  if (!editor) return;
  const text = editor.value.trim();
  if (!text) {
    if (errEl) errEl.textContent = "JSON is empty";
    if (okEl) okEl.classList.add("hidden");
    return;
  }
  try {
    const res = await window.meteorAPI.mcp.validate(text);
    if (!res.ok) {
      if (errEl) errEl.textContent = res.error;
      if (okEl) okEl.classList.add("hidden");
      return;
    }
    if (errEl) errEl.textContent = "";
    if (okEl) { okEl.textContent = `✓ valid — ${res.count} server${res.count === 1 ? "" : "s"}`; okEl.classList.remove("hidden"); }
  } catch (err) {
    if (errEl) errEl.textContent = err instanceof Error ? err.message : String(err);
    if (okEl) okEl.classList.add("hidden");
  }
}

async function handleJsonSaveConnect() {
  const editor = document.getElementById("mcp-json-editor");
  const errEl = document.getElementById("mcp-json-error");
  const okEl = document.getElementById("mcp-json-ok");
  const btn = document.getElementById("mcp-json-connect");
  if (!editor) return;
  const text = editor.value.trim();
  if (btn) { btn.textContent = "saving…"; btn.disabled = true; }
  if (errEl) errEl.textContent = "";
  if (okEl) okEl.classList.add("hidden");
  try {
    const res = await window.meteorAPI.mcp.saveJson(text);
    mcpServers = res.servers || {};
    mcpStatuses = {};
    for (const k of Object.keys(mcpServers)) mcpStatuses[k] = { state: "disconnected", at: 0 };
    renderMcpList();
    updateMcpCount();
    mcpJsonDirty = false;
    if (okEl) { okEl.textContent = `✓ saved ${Object.keys(mcpServers).length} server(s)`; okEl.classList.remove("hidden"); }
    if (errEl) errEl.textContent = "";
    // auto-test each server sequentially
    const names = Object.keys(mcpServers);
    for (const name of names) {
      if (mcpServers[name]?.disabled) continue;
      try {
        await window.meteorAPI.mcp.test(name);
        mcpStatuses[name] = { state: "connected", at: Date.now() };
      } catch (err) {
        mcpStatuses[name] = { state: "error", error: err instanceof Error ? err.message : String(err), at: Date.now() };
      }
      renderMcpList();
    }
    // switch to servers tab to show results
    switchSettingsTab("servers");
  } catch (err) {
    if (errEl) errEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    if (btn) { btn.textContent = "Save & Connect"; btn.disabled = false; }
  }
}

let _mcpSettingsBound = false;
function initMcpSettings() {
  if (_mcpSettingsBound) return;
  _mcpSettingsBound = true;
  // expose for debugging / inline onclick fallback
  window.__openSettings = openSettings;
  window.__closeSettings = closeSettings;
  console.log("[mcp] initMcpSettings binding");
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    console.log("[mcp] settings-btn clicked");
    openSettings("servers");
  });
  document.getElementById("settings-close")?.addEventListener("click", closeSettings);
  document.getElementById("settings-backdrop")?.addEventListener("click", closeSettings);
  document.querySelectorAll(".settings-tab").forEach((b) => b.addEventListener("click", () => switchSettingsTab(b.dataset.tab)));
  document.getElementById("mcp-add-btn")?.addEventListener("click", () => showMcpForm(null));
  document.getElementById("mcp-refresh-btn")?.addEventListener("click", () => loadMcp());
  document.getElementById("mcp-show-disabled")?.addEventListener("change", renderMcpList);
  document.getElementById("mcp-form")?.addEventListener("submit", saveFromForm);
  document.getElementById("mcp-form-cancel")?.addEventListener("click", hideMcpForm);
  document.getElementById("mcp-form-delete")?.addEventListener("click", deleteCurrentMcp);
  document.getElementById("mcp-type")?.addEventListener("change", syncFormType);
  document.getElementById("mcp-json-editor")?.addEventListener("input", () => {
    mcpJsonDirty = true;
    const errEl = document.getElementById("mcp-json-error");
    const okEl = document.getElementById("mcp-json-ok");
    if (errEl) errEl.textContent = "";
    if (okEl) okEl.classList.add("hidden");
  });
  document.getElementById("mcp-json-validate")?.addEventListener("click", handleJsonValidate);
  document.getElementById("mcp-json-connect")?.addEventListener("click", handleJsonSaveConnect);
  document.getElementById("mcp-json-format")?.addEventListener("click", () => {
    const ed = document.getElementById("mcp-json-editor");
    if (!ed) return;
    try {
      const parsed = JSON.parse(ed.value);
      ed.value = JSON.stringify(parsed, null, 2);
      mcpJsonDirty = true;
    } catch (err) {
      const errEl = document.getElementById("mcp-json-error");
      if (errEl) errEl.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  document.getElementById("mcp-json-copy")?.addEventListener("click", async () => {
    const ed = document.getElementById("mcp-json-editor");
    if (!ed) return;
    try { await navigator.clipboard.writeText(ed.value); const el = document.getElementById("mcp-json-ok"); if (el) { el.textContent = "✓ copied"; el.classList.remove("hidden"); setTimeout(() => el.classList.add("hidden"), 1500); } } catch {}
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const overlay = document.getElementById("settings-overlay");
      if (overlay && !overlay.classList.contains("hidden")) { e.preventDefault(); closeSettings(); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === ",") {
      e.preventDefault();
      const overlay = document.getElementById("settings-overlay");
      if (overlay?.classList.contains("hidden")) openSettings("servers"); else closeSettings();
    }
  });
}

/* ─────────────── Auth (Supabase) ─────────────── */
let currentUser = null;
let authMode = "signin";
let emailVisible = false;
let fullEmailCache = "";

function setAuthMode(mode){
  authMode = mode === "signup" ? "signup" : "signin";
  document.querySelectorAll(".auth-tab").forEach(b=> b.classList.toggle("active", b.dataset.mode===authMode));
  const confirmWrap = document.getElementById("auth-confirm-wrap");
  if (confirmWrap) confirmWrap.classList.toggle("hidden", authMode==="signin");
  const submit = document.getElementById("auth-submit");
  if (submit) submit.textContent = authMode==="signin" ? "Sign in" : "Create account";
  const hint = document.getElementById("auth-switch-hint");
  if (hint) hint.innerHTML = authMode==="signin" ? 'No account? <a href="#" id="auth-switch">Create one</a>' : 'Have an account? <a href="#" id="auth-switch">Sign in</a>';
  const sw = document.getElementById("auth-switch");
  if (sw) sw.addEventListener("click", (e)=>{ e.preventDefault(); setAuthMode(authMode==="signin"?"signup":"signin"); });
  const errEl = document.getElementById("auth-error");
  const okEl = document.getElementById("auth-ok");
  if (errEl){ errEl.textContent=""; errEl.classList.add("hidden"); }
  if (okEl){ okEl.textContent=""; okEl.classList.add("hidden"); }
}
function showAuthOverlay(){
  const ov = document.getElementById("auth-overlay");
  const app = document.getElementById("app");
  if (ov){ ov.classList.remove("hidden"); ov.setAttribute("aria-hidden","false"); }
  if (app) app.classList.add("auth-locked");
  document.body.style.overflow="hidden";
}
function hideAuthOverlay(){
  const ov = document.getElementById("auth-overlay");
  const app = document.getElementById("app");
  if (ov){ ov.classList.add("hidden"); ov.setAttribute("aria-hidden","true"); }
  if (app) app.classList.remove("auth-locked");
  document.body.style.overflow="";
}
function updateAuthUserUI(user){
  currentUser = user;
  const nameEl = document.getElementById("auth-user-name");
  const emailEl = document.getElementById("auth-user-email");
  const av = document.getElementById("auth-avatar");
  const avImg = document.getElementById("auth-avatar-img");
  const avFallback = document.getElementById("auth-avatar-fallback");
  const logoutBtn = document.getElementById("auth-logout");
  const toggleBtn = document.getElementById("toggle-email");
  if (user && user.email){
    fullEmailCache = user.email;
    emailVisible = false;
    const meta = user.user_metadata || {};
    const metaName = meta.full_name || meta.fullName || meta.name || null;
    const initialName = metaName || user.email.split("@")[0];
    if (nameEl) nameEl.textContent = initialName;
    if (emailEl) { emailEl.textContent = "••••••••"; emailEl.title = "Click eye to show email"; emailEl.dataset.full = user.email; }
    if (toggleBtn) { toggleBtn.style.display = ""; toggleBtn.title = "Show email"; const open = toggleBtn.querySelector(".eye-open"); const closed = toggleBtn.querySelector(".eye-closed"); if (open) open.classList.remove("hidden"); if (closed) closed.classList.add("hidden"); }
    if (avFallback) avFallback.textContent = (initialName[0] || user.email[0] || "•").toUpperCase();
    if (av) av.classList.remove("has-img");
    if (avImg) { avImg.classList.add("hidden"); avImg.removeAttribute("src"); }
    if (logoutBtn) logoutBtn.classList.remove("hidden");
    // fetch avatar_url + full_name from profiles
    (async ()=>{
      try{
        if (!window.meteorAPI?.profile?.get) return;
        const res = await window.meteorAPI.profile.get();
        const url = res?.avatarUrl;
        const profName = res?.fullName;
        if (profName && nameEl) nameEl.textContent = profName;
        else if (metaName && nameEl) nameEl.textContent = metaName;
        if (profName && avFallback) avFallback.textContent = profName[0].toUpperCase();
        if (url && avImg && av) {
          // bust cache with timestamp to ensure fresh load after CSP fix
          avImg.src = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
          avImg.classList.remove("hidden");
          av.classList.add("has-img");
          avImg.onerror = ()=> { avImg.classList.add("hidden"); av.classList.remove("has-img"); console.warn("avatar load failed", url); };
          avImg.onload = ()=> console.log("avatar loaded", url);
        }
      } catch {}
    })();
  } else {
    fullEmailCache = "";
    emailVisible = false;
    if (nameEl) nameEl.textContent = "Not signed in";
    if (emailEl) { emailEl.textContent = "••••••••"; emailEl.title = ""; emailEl.removeAttribute("data-full"); }
    if (toggleBtn) toggleBtn.style.display = "none";
    if (avFallback) avFallback.textContent = "•";
    if (av) av.classList.remove("has-img");
    if (avImg) { avImg.classList.add("hidden"); avImg.removeAttribute("src"); }
    if (logoutBtn) logoutBtn.classList.add("hidden");
  }
}
function toggleEmailVisibility(){
  const emailEl = document.getElementById("auth-user-email");
  const toggleBtn = document.getElementById("toggle-email");
  if (!emailEl || !fullEmailCache) return;
  emailVisible = !emailVisible;
  if (emailVisible){
    emailEl.textContent = fullEmailCache;
    emailEl.title = "Click eye to hide email";
    if (toggleBtn){ toggleBtn.title = "Hide email"; const open = toggleBtn.querySelector(".eye-open"); const closed = toggleBtn.querySelector(".eye-closed"); if (open) open.classList.add("hidden"); if (closed) closed.classList.remove("hidden"); }
  } else {
    emailEl.textContent = "••••••••";
    emailEl.title = "Click eye to show email";
    if (toggleBtn){ toggleBtn.title = "Show email"; const open = toggleBtn.querySelector(".eye-open"); const closed = toggleBtn.querySelector(".eye-closed"); if (open) open.classList.remove("hidden"); if (closed) closed.classList.add("hidden"); }
  }
}
async function checkAuth(){
  try{
    if (!window.meteorAPI?.auth?.getSession) { hideAuthOverlay(); return; }
    const res = await window.meteorAPI.auth.getSession();
    const badge = document.getElementById("auth-supabase-badge");
    const hint = document.getElementById("auth-mode-hint");
    if (badge){
      if (res.isConfigured) { badge.textContent = "Supabase live ✓"; badge.style.background="rgba(46,192,113,.12)"; badge.style.borderColor="rgba(46,192,113,.22)"; badge.style.color="var(--green)"; badge.classList.remove("hidden"); }
      else if (res.isMock) { badge.textContent = "Local mock auth"; badge.style.background="rgba(245,158,11,.12)"; badge.style.borderColor="rgba(245,158,11,.22)"; badge.style.color="#f59e0b"; badge.classList.remove("hidden"); }
      else badge.classList.add("hidden");
    }
    if (hint){
      if (res.isMock && !res.isConfigured) hint.textContent = "Supabase not configured — using local mock (set SUPABASE_URL & SUPABASE_ANON_KEY for real auth).";
      else if (res.isConfigured) hint.textContent = "Supabase authentication active.";
      else hint.textContent = "";
      hint.className = res.isMock ? "auth-hint is-mock" : "auth-hint is-live";
    }
    if (res.isAuthenticated && res.user){
      updateAuthUserUI(res.user);
      hideAuthOverlay();
      // load projects for this user
      try { await refreshProjects(); } catch {}
      if (currentProjectId) {
        const exists = projectsCache.find(p=>p.id===currentProjectId);
        if (!exists) { currentProjectId = null; localStorage.removeItem("meteor:currentProjectId"); renderProjects(); }
      }
    } else {
      updateAuthUserUI(null);
      projectsCache = [];
      renderProjects();
      showAuthOverlay();
      setAuthMode("signin");
    }
  } catch(e){
    console.error("checkAuth", e);
    showAuthOverlay();
  }
}
function initAuth(){
  const form = document.getElementById("auth-form");
  const emailEl = document.getElementById("auth-email");
  const pwEl = document.getElementById("auth-password");
  const confirmEl = document.getElementById("auth-confirm");
  const errEl = document.getElementById("auth-error");
  const okEl = document.getElementById("auth-ok");
  const submitBtn = document.getElementById("auth-submit");
  document.querySelectorAll(".auth-tab").forEach(b=>{
    b.addEventListener("click", ()=> setAuthMode(b.dataset.mode || "signin"));
  });
  document.getElementById("auth-switch")?.addEventListener("click", (e)=>{ e.preventDefault(); setAuthMode(authMode==="signin"?"signup":"signin"); });
  // delegate for dynamically recreated switch link
  document.getElementById("auth-switch-hint")?.addEventListener("click", (e)=>{
    const t = e.target;
    if (t && t.id==="auth-switch"){ e.preventDefault(); setAuthMode(authMode==="signin"?"signup":"signin"); }
  });
  document.getElementById("toggle-email")?.addEventListener("click", (e)=>{ e.preventDefault(); toggleEmailVisibility(); });
  document.getElementById("auth-user-email")?.addEventListener("click", ()=>{ if (currentUser) toggleEmailVisibility(); });
  document.getElementById("auth-logout")?.addEventListener("click", async ()=>{
    try{ await window.meteorAPI.auth.signOut(); } catch{}
    await checkAuth();
    addMsg("system", "Signed out — please sign in again to use Meteor.");
  });
  if (form){
    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      const email = (emailEl?.value || "").trim();
      const pw = pwEl?.value || "";
      const confirm = confirmEl?.value || "";
      if (!email || !pw){ if(errEl){ errEl.textContent="Email and password required"; errEl.classList.remove("hidden"); } return; }
      if (authMode==="signup" && pw !== confirm){ if(errEl){ errEl.textContent="Passwords do not match"; errEl.classList.remove("hidden"); } return; }
      if (errEl) { errEl.textContent=""; errEl.classList.add("hidden"); }
      if (okEl) { okEl.textContent=""; okEl.classList.add("hidden"); }
      if (submitBtn){ submitBtn.disabled=true; submitBtn.textContent= authMode==="signin" ? "Signing in…" : "Creating…"; }
      try{
        const api = window.meteorAPI.auth;
        const res = authMode==="signin" ? await api.signIn(email, pw) : await api.signUp(email, pw);
        if (okEl){
          if (authMode==="signup" && !res.session) {
            okEl.textContent = "Account created — check your email to confirm, then sign in.";
          } else {
            okEl.textContent = authMode==="signin" ? "Signed in ✓" : "Account created ✓";
          }
          okEl.classList.remove("hidden");
        }
        // re-check session
        await checkAuth();
        if (currentUser) addMsg("system", `Signed in as ${res.user?.email || email}`);
        else if (authMode==="signup" && !res.session) {
          // confirmation required — switch to signin tab for next step
          setAuthMode("signin");
          if (errEl){ errEl.textContent = "Confirmation email sent (or confirmation required) — please confirm your email then sign in. If you see 'Error sending confirmation email' in Supabase, disable 'Confirm email' in Dashboard > Authentication > Providers > Email."; errEl.classList.remove("hidden"); }
        }
      } catch(err){
        const msg = err instanceof Error ? err.message : String(err);
        if (errEl){ errEl.textContent = msg; errEl.classList.remove("hidden"); }
      } finally {
        if (submitBtn){ submitBtn.disabled=false; submitBtn.textContent= authMode==="signin" ? "Sign in" : "Create account"; }
      }
    });
  }
  // close overlay click outside? not allowed — must sign in
  document.getElementById("auth-backdrop")?.addEventListener("click", (e)=> e.preventDefault());
}

let chatContextTarget = null;
function showChatContextMenu(x, y, target){
  const menu = document.getElementById("chat-context-menu");
  if (!menu) return;
  chatContextTarget = target;
  const delBtn = menu.querySelector('[data-action="delete"]');
  if (delBtn){
    if (target.type==="message") delBtn.innerHTML = `${ICONS.trash} Delete message`;
    else if (target.type==="history") delBtn.innerHTML = `${ICONS.trash} Delete chat`;
    else delBtn.innerHTML = `${ICONS.trash} Delete project`;
  }
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.remove("hidden");
  // clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + "px";
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + "px";
}
function hideChatContextMenu(){
  const menu = document.getElementById("chat-context-menu");
  if (menu) menu.classList.add("hidden");
  chatContextTarget = null;
}
function initChatContextMenu(){
  const menu = document.getElementById("chat-context-menu");
  if (!menu) return;
  // sidebar: right click on project history row -> delete chat
  document.addEventListener("contextmenu", (e)=>{
    const hist = e.target.closest && e.target.closest(".sb-history-row");
    const projRow = e.target.closest && e.target.closest(".proj-row");
    const msg = e.target.closest && e.target.closest(".msg");
    if (hist){
      e.preventDefault();
      const projId = hist.dataset.projectId || hist.closest(".project-group")?.querySelector(".proj-row")?.dataset.projectId;
      // try to find project id from closest group
      let pid = null;
      const group = hist.closest(".project-group");
      if (group){
        const r = group.querySelector(".proj-row");
        // find by title or look up in cache
        const title = r ? r.title.split(" — ")[0] : "";
        const found = projectsCache.find(p=> p.name===title || p.last_message===hist.title);
        if (found) pid = found.id;
      }
      if (!pid && currentProjectId) pid = currentProjectId;
      showChatContextMenu(e.clientX, e.clientY, {type:"history", projectId: pid, element: hist});
      return;
    }
    if (projRow && !hist){
      // right click on project row already handled for delete project, but also show menu to delete project
      // let default project delete handle via contextmenu, but also show our menu
      // we will let the existing project delete logic handle, but also show menu
      // For now, don't override project row delete — let it show menu as well
      // Use same menu but action will delete project
      e.preventDefault();
      const title = projRow.title.split(" — ")[0];
      const found = projectsCache.find(p=> p.name===title);
      const pid = found ? found.id : currentProjectId;
      showChatContextMenu(e.clientX, e.clientY, {type:"project", projectId: pid, element: projRow});
      return;
    }
    if (msg){
      // only allow delete for user/assistant msgs that are in chatHistory
      const isUser = msg.classList.contains("user") || msg.classList.contains("assistant");
      if (!isUser) return;
      e.preventDefault();
      // find index via dataset or position
      let idx = -1;
      if (msg.dataset.chatIndex !== undefined && msg.dataset.chatIndex !== ""){
        idx = parseInt(msg.dataset.chatIndex, 10);
      } else {
        // fallback: find by order among .msg that have chatIndex
        const all = Array.from(document.querySelectorAll("#messages .msg"));
        idx = all.indexOf(msg);
        // map to chatHistory index by counting only user/assistant
        // we store chatHistory order same as DOM order for those
        // simpler: use DOM index among chatHistory-linked msgs
      }
      showChatContextMenu(e.clientX, e.clientY, {type:"message", element: msg, index: idx, role: msg.classList.contains("user") ? "user" : "assistant"});
      return;
    }
  });
  document.addEventListener("click", (e)=>{
    const menuEl = document.getElementById("chat-context-menu");
    if (menuEl && !menuEl.contains(e.target)) hideChatContextMenu();
  });
  document.addEventListener("keydown", (e)=>{ if (e.key==="Escape") hideChatContextMenu(); });
  window.addEventListener("blur", hideChatContextMenu);
  // menu actions
  menu.addEventListener("click", async (e)=>{
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    const target = chatContextTarget;
    hideChatContextMenu();
    if (!target) return;
    if (action==="copy"){
      try{
        const text = target.type==="message" ? target.element.querySelector(".msg-body")?.innerText || target.element.textContent : target.element.textContent;
        await navigator.clipboard.writeText(text || "");
      }catch{}
      return;
    }
    if (action==="delete"){
      if (target.type==="message"){
        // delete single message from history and DOM
        const idxAttr = target.element.dataset.chatIndex;
        let idx = idxAttr !== undefined && idxAttr !== "" ? parseInt(idxAttr,10) : -1;
        if (idx >=0 && idx < chatHistory.length){
          if (!confirm("Delete this chat message?")) return;
          chatHistory.splice(idx, 1);
          target.element.remove();
          // re-index remaining
          document.querySelectorAll("#messages .msg[data-chat-index]").forEach((el, i)=>{
            // need to remap? simpler: rebuild indices
          });
          // update indices
          let cIdx = 0;
          document.querySelectorAll("#messages .msg").forEach(el=>{
            if (el.classList.contains("user") || el.classList.contains("assistant")){
              el.dataset.chatIndex = String(cIdx);
              cIdx++;
            }
          });
          // persist
          if (currentProjectId){
            try{ await window.meteorAPI.projects.saveMessages(currentProjectId, chatHistory); }catch{}
            try{ await window.meteorAPI.projects.update(currentProjectId, { last_message: chatHistory.filter(m=>m.role==="user").pop()?.content ? String(chatHistory.filter(m=>m.role==="user").pop().content).slice(0,200) : "" }); await refreshProjects(); }catch{}
          }
          updateCenterVisibility();
        } else {
          // fallback: just remove DOM
          if (confirm("Delete this message?")) target.element.remove();
        }
      } else if (target.type==="history" || target.type==="project"){
        const pid = target.projectId;
        if (!pid) return;
        if (target.type==="history"){
          if (!confirm("Delete this chat's messages? This will clear the conversation for this project.")) return;
          try{
            // clear messages for this project
            await window.meteorAPI.projects.saveMessages(pid, []);
            await window.meteorAPI.projects.update(pid, { last_message: "", preview: "", message_count: 0 });
            if (currentProjectId===pid){
              chatHistory = [];
              els.messages.innerHTML = "";
              const w = document.createElement("div");
              w.className="msg assistant";
              w.innerHTML='<div class="msg-head"><span style="color:var(--accent);display:inline-flex;vertical-align:middle">'+ICONS.dot+'</span> meteor</div><div class="msg-body tui-box">Chat cleared.</div>';
              els.messages.append(w);
              updateCenterVisibility();
            }
            await refreshProjects();
          }catch(err){ addMsg("system", String(err)); }
        } else if (target.type==="project"){
          if (!confirm("Delete this project? This cannot be undone.")) return;
          try{ await window.meteorAPI.projects.delete(pid); }catch(err){ addMsg("system", String(err)); return; }
          if (currentProjectId===pid){ currentProjectId=null; localStorage.removeItem("meteor:currentProjectId"); chatHistory=[]; els.messages.innerHTML=""; const w=document.createElement("div"); w.className="msg assistant"; w.innerHTML='<div class="msg-head"><span style="color:var(--accent);display:inline-flex;vertical-align:middle">'+ICONS.dot+'</span> meteor</div><div class="msg-body tui-box">Project deleted.</div>'; els.messages.append(w); updateCenterVisibility(); }
          await refreshProjects();
        }
      }
    }
  });
}

let updateStatus = null;
async function refreshUpdateBanner(force=false){
  try{
    if (!window.meteorAPI?.updater?.check) return;
    const status = await window.meteorAPI.updater.check(force);
    updateStatus = status;
    const banner = document.getElementById("update-banner");
    const versionEl = document.getElementById("update-version");
    const footerVer = document.getElementById("update-footer-version");
    const footerStatus = document.getElementById("update-footer-status");
    if (footerVer && status) footerVer.textContent = `v${status.currentVersion}`;
    if (footerStatus && status){
      if (status.error) footerStatus.textContent = "check failed";
      else if (status.hasUpdate) footerStatus.textContent = `update → ${status.latestVersion}`;
      else footerStatus.textContent = "up to date";
      footerStatus.title = status.hasUpdate ? `Update ${status.currentVersion} → ${status.latestVersion}` : `Latest ${status.latestVersion} — checked just now`;
    }
    if (!banner || !status) return;
    const dismissed = localStorage.getItem("meteor:updateDismissed");
    const recentlyDismissed = dismissed && (Date.now() - parseInt(dismissed,10) < 1000*60*60*24);
    const shouldShow = status.hasUpdate && (!recentlyDismissed || force);
    if (shouldShow){
      if (versionEl) versionEl.textContent = `${status.currentVersion} → ${status.latestVersion}`;
      const textEl = document.getElementById("update-text");
      if (textEl && status.changelog) textEl.title = status.changelog.slice(0, 300);
      banner.classList.remove("hidden");
      if (force && recentlyDismissed){ try{ localStorage.removeItem("meteor:updateDismissed"); }catch{} }
    } else {
      banner.classList.add("hidden");
      if (force && status && !status.hasUpdate){
        banner.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;color:var(--dim)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> You are up to date — v${status.currentVersion} (latest ${status.latestVersion})</span><span class="spacer"></span><button id="update-banner-ok" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #2a2a30;background:#1e1e22;color:var(--dim);cursor:pointer">OK</button>`;
        banner.classList.remove("hidden");
        setTimeout(()=> document.getElementById("update-banner-ok")?.addEventListener("click", ()=> banner.classList.add("hidden")), 0);
        setTimeout(()=> banner.classList.add("hidden"), 4000);
      }
    }
  } catch(e){ console.warn("updater check", e); const fs=document.getElementById("update-footer-status"); if(fs) fs.textContent="error"; }
}
function initUpdater(){
  const banner = document.getElementById("update-banner");
  const viewBtn = document.getElementById("update-view");
  const installBtn = document.getElementById("update-install");
  const dismissBtn = document.getElementById("update-dismiss");
  const checkBtn = document.getElementById("check-update-btn");
  if (!banner) return;
  viewBtn?.addEventListener("click", async ()=>{ try{ await window.meteorAPI.updater.openRepo(); }catch{} });
  dismissBtn?.addEventListener("click", ()=>{ banner.classList.add("hidden"); try{ localStorage.setItem("meteor:updateDismissed", Date.now().toString()); }catch{} });
  installBtn?.addEventListener("click", async ()=>{
    installBtn.textContent = "Updating…";
    installBtn.disabled = true;
    try{
      const res = await window.meteorAPI.updater.install();
      if (res?.needsRestart){
        banner.innerHTML = `<span style="color:var(--green);display:inline-flex;align-items:center;gap:6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Updated — restart to apply</span><span class="spacer"></span><button onclick="location.reload()" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #2a2a30;background:#1e1e22;color:var(--text);cursor:pointer">Restart</button>`;
      } else if (res?.fallbackOpened){
        banner.innerHTML = `<span>Opened GitHub — pull manually</span><span class="spacer"></span><button id="update-dismiss2" style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #2a2a30;background:#1e1e22;color:var(--dim);cursor:pointer">Dismiss</button>`;
        document.getElementById("update-dismiss2")?.addEventListener("click", ()=> banner.classList.add("hidden"));
      } else {
        viewBtn?.click();
      }
    } catch(e){
      installBtn.textContent = "Update";
      installBtn.disabled = false;
      addMsg("system", "Update failed: " + (e instanceof Error ? e.message : String(e)));
    }
  });
  checkBtn?.addEventListener("click", async ()=>{
    const orig = checkBtn.textContent;
    checkBtn.textContent = "Checking…";
    checkBtn.disabled = true;
    await refreshUpdateBanner(true);
    checkBtn.textContent = orig;
    checkBtn.disabled = false;
  });
  refreshUpdateBanner(false);
  setInterval(()=> refreshUpdateBanner(false), 1000*60*30);
}

async function init() {
  const savedTheme = localStorage.getItem("meteor:theme") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  applyTheme(savedTheme);
  const tbtn = document.getElementById("theme-toggle");
  if (tbtn) tbtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(cur);
  });
  if (navigator.platform.toLowerCase().includes("mac")) document.body.classList.add("platform-mac");

  // gate: must sign in via Supabase before using Meteor
  try { initAuth(); } catch(e){ console.error("initAuth", e); }
  try { await checkAuth(); } catch(e){ console.error("checkAuth", e); }

  const info = await window.meteorAPI.info();
  // sync user UI from info.auth as well
  if (info.auth?.user) updateAuthUserUI(info.auth.user);
  else if (!currentUser) {
    try { const s = await window.meteorAPI.auth.getSession(); if (s?.user) updateAuthUserUI(s.user); } catch {}
  }
  if (currentUser) {
    try { await refreshProjects(); } catch(e){ console.warn("refreshProjects", e); }
    // restore current project if any
    if (currentProjectId) {
      const exists = projectsCache.find(p=>p.id===currentProjectId);
      if (exists) {
        // load its workspace silently
        try { await switchProject(currentProjectId); } catch {}
      } else {
        currentProjectId = null;
        localStorage.removeItem("meteor:currentProjectId");
        renderProjects();
      }
    }
  }
  models = info.models || [];
  currentModel = info.defaultModel && models.find((m) => m.key === info.defaultModel) ? info.defaultModel : models[0]?.key || "sunlight-2-pro";

  const savedChatModel = localStorage.getItem("meteor:chatModel");
  if (savedChatModel && models.find((m) => m.key === savedChatModel)) currentModel = savedChatModel;
  const renderModelOptions = () => {
    els.modelSelect.innerHTML = models.map((m) => {
      const suffix = m.key === "sunlight-2-pro" ? " (Unlimited)" : "";
      return `<option value="${esc(m.key)}">${esc(m.name)}${suffix}</option>`;
    }).join("");
    els.modelSelect.value = currentModel;
  };
  renderModelOptions();
  els.modelSelect.addEventListener("change", (e) => {
    const prev = currentModel;
    currentModel = e.target.value;
    localStorage.setItem("meteor:chatModel", currentModel);
    const m = models.find((x) => x.key === currentModel);
    const prevM = models.find((x) => x.key === prev);
    if (m && prev !== currentModel) {
      const re = currentReasoningEffort ? ` · reasoning ${currentReasoningEffort}` : "";
      addMsg("system", `switched to ${m.name}${m.key === "sunlight-2-pro" ? " (Unlimited)" : ""}${prevM ? ` from ${prevM.name}` : ""}${re}`);
    }
  });

  // reasoning effort — glassy select next to model
  const savedReasoning = localStorage.getItem("meteor:reasoningEffort") || "";
  const allowedReasoning = ["", "low", "high", "max"];
  if (allowedReasoning.includes(savedReasoning)) currentReasoningEffort = savedReasoning;
  else if (savedReasoning === "minimal" || savedReasoning === "medium") {
    // migrate old values: minimal→low, medium→high
    currentReasoningEffort = savedReasoning === "minimal" ? "low" : "high";
    localStorage.setItem("meteor:reasoningEffort", currentReasoningEffort);
  }
  if (els.reasoningSelect) {
    els.reasoningSelect.value = currentReasoningEffort;
    els.reasoningSelect.addEventListener("change", (e) => {
      const next = e.target.value;
      currentReasoningEffort = next;
      localStorage.setItem("meteor:reasoningEffort", next);
      const label = next || "auto";
      addMsg("system", `reasoning effort → ${label}`);
    });
  }

  els.keyDot.className = `dot ${info.hasKey ? "dot-on" : "dot-off"}`;
  els.keyDot.title = info.hasKey ? `API key present (${info.keySource})` : "No API key — run meteor auth set <key> in the terminal";

  if (!info.hasKey) {
    const b = document.createElement("div");
    b.className = "banner";
    b.textContent = "No API key found. Run:  meteor auth set <your-key>";
    els.messages.append(b);
  }

  const chkAuto = document.getElementById("chk-auto");
  if (chkAuto) {
    chkAuto.checked = autoCreateEnabled;
    chkAuto.addEventListener("change", () => {
      autoCreateEnabled = chkAuto.checked;
      localStorage.setItem("meteor:autoCreate", String(autoCreateEnabled));
    });
  }
  setBuildMode(buildMode);
  document.querySelectorAll("#mode-seg [data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setBuildMode(btn.dataset.mode));
  });

  const welcome = document.createElement("div");
  welcome.className = "msg assistant";
  welcome.style.display = "none";
  welcome.innerHTML = `<div class="msg-head"><span style="color:var(--accent);display:inline-flex;vertical-align:middle"><svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="currentColor"/></svg></span> meteor</div><div class="msg-body tui-box">┌─ <span class="hl"><span style="display:inline-flex;vertical-align:middle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l2.4 7.2H22l-6.2 4.5 2.4 7.3L12 16.5 5.8 21l2.4-7.3L2 9.2h7.6z"/></svg></span> meteor</span> <span class="fg">v${esc(info.version || "0.2.0")}</span> ──────────────────────┐\n│  AI coding assistant                                  │\n│  <span class="fg">Sunlight 2</span>  ·  <span class="fg">Sunlight 2 Pro</span>                           │\n└────────────────────────────────────────────┘\n\nAsk anything. Open a folder (<span class="fg">⌘⇧O</span>) and Meteor can read your whole codebase.\n<span class="fg">Build</span> writes files automatically (overwrites ask to apply) · <span class="fg">Plan</span> only previews — toggle at the top.</div>`;
  els.messages.append(welcome);
  // greeting time-of-day
  const greetingEl = document.getElementById("greeting");
  if (greetingEl) {
    const h = new Date().getHours();
    const part = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
    greetingEl.textContent = `${part}, nice work today`;
  }

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });
  els.input.addEventListener("input", autoSizeInput);
  autoSizeInput();

  const clearChat = () => {
    chatHistory = [];
    els.messages.innerHTML = "";
    els.messages.append(welcome);
    if (!info.hasKey) els.messages.append(document.querySelector(".banner")?.cloneNode(true) || Object.assign(document.createElement("div"), { className: "banner", textContent: "No API key found." }));
    updateCenterVisibility();
  };
  $("#btn-clear")?.addEventListener("click", clearChat);
  $("#btn-new-task")?.addEventListener("click", clearChat);
  // banner dismiss
  $("#banner-close")?.addEventListener("click", () => {
    const b = document.getElementById("sub-banner");
    if (b) b.style.display = "none";
  });
  // template cards fill input
  document.querySelectorAll(".tpl-card").forEach((card) => {
    card.addEventListener("click", () => {
      const title = card.querySelector(".tpl-title")?.textContent?.trim() || "";
      const desc = card.querySelector(".tpl-desc")?.textContent?.trim() || "";
      const prompt = title ? `${title}: ${desc}` : desc;
      els.input.value = prompt;
      autoSizeInput();
      els.input.focus();
    });
  });
  // history rows
  document.querySelectorAll(".sb-history-row").forEach((r) => {
    r.addEventListener("click", () => {
      const q = r.getAttribute("data-query") || r.querySelector("span")?.textContent?.trim() || "";
      if (q) { els.input.value = q; autoSizeInput(); els.input.focus(); }
    });
  });
  // project pill click opens folder
  $("#cc-project")?.addEventListener("click", openWorkspace);
  $("#sb-proj-meteor")?.addEventListener("click", openWorkspace);
  // ── Chat search (left upper corner) ──
  let chatSearchQuery = "";
  function applyChatSearchFilter(){
    const q = chatSearchQuery.trim().toLowerCase();
    const groups = document.querySelectorAll("#sb-projects .project-group");
    let visible = 0;
    groups.forEach(g => {
      if (!q){ g.style.display=""; visible++; return; }
      const row = g.querySelector(".proj-row");
      const text = (row ? row.textContent : "") + " " + (g.textContent || "");
      const match = text.toLowerCase().includes(q);
      g.style.display = match ? "" : "none";
      if (match){
        visible++;
        const chats = g.querySelector(".project-chats");
        if (chats && chats.classList.contains("hidden")){ chats.classList.remove("hidden"); }
      }
    });
    const countEl = document.getElementById("search-count");
    const clearBtn = document.getElementById("search-clear");
    if (q){
      if (clearBtn) clearBtn.style.display = chatSearchQuery ? "inline-flex" : "none";
      if (countEl){ countEl.style.display="block"; countEl.textContent = visible ? `${visible} match${visible===1?"":"es"}` : "No chats found"; }
    } else {
      if (clearBtn) clearBtn.style.display="none";
      if (countEl) countEl.style.display="none";
    }
    document.querySelectorAll("#sb-projects .sb-history-row").forEach(r=>{
      if (!q) { r.style.display=""; return; }
      const t=(r.textContent||"").toLowerCase();
      r.style.display = t.includes(q) ? "" : "none";
    });
  }
  const searchWrap = document.getElementById("search-wrap");
  const searchInput = document.getElementById("chat-search");
  const searchClear = document.getElementById("search-clear");
  $("#sb-search-btn")?.addEventListener("click", () => {
    if (!searchWrap || !searchInput) return;
    const wasHidden = searchWrap.classList.contains("hidden");
    if (wasHidden){ searchWrap.classList.remove("hidden"); searchInput.focus(); searchInput.select(); }
    else {
      if (chatSearchQuery){ chatSearchQuery=""; searchInput.value=""; applyChatSearchFilter(); }
      searchWrap.classList.add("hidden");
    }
  });
  if (searchInput){
    searchInput.addEventListener("input", ()=>{
      chatSearchQuery = searchInput.value;
      applyChatSearchFilter();
    });
    searchInput.addEventListener("keydown", (e)=>{
      if (e.key==="Escape"){ e.preventDefault(); chatSearchQuery=""; searchInput.value=""; applyChatSearchFilter(); if(searchWrap) searchWrap.classList.add("hidden"); }
      if (e.key==="Enter"){ const first = document.querySelector("#sb-projects .project-group:not([style*='display: none']) .proj-row"); if (first) first.click(); }
    });
  }
  if (searchClear){
    searchClear.addEventListener("click", ()=>{ chatSearchQuery=""; if(searchInput){ searchInput.value=""; searchInput.focus(); } applyChatSearchFilter(); });
  }
  window.addEventListener("keydown", (e)=>{
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); const btn=document.getElementById("sb-search-btn"); if(btn) btn.click(); }
  });
  window.__applyChatSearch = applyChatSearchFilter;
  const _rp = renderProjects;
  renderProjects = function(){ _rp(); setTimeout(applyChatSearchFilter, 0); };
  // send btn
  $("#send-btn")?.addEventListener("click", sendCurrent);
  // ── Image upload (+ button) ──
  const imageInput = document.getElementById("image-input");
  const composerCard = document.getElementById("composer-card");
  const attachBtn = document.getElementById("btn-attach") || document.querySelector(".cc-plus");
  if (attachBtn && imageInput) {
    attachBtn.addEventListener("click", (e) => {
      e.preventDefault();
      imageInput.click();
    });
  }
  if (imageInput) {
    imageInput.addEventListener("change", () => {
      if (imageInput.files && imageInput.files.length) {
        addPendingFiles(imageInput.files);
        imageInput.value = "";
      }
    });
  }
  // drag & drop on composer
  if (composerCard) {
    const onDragOver = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        composerCard.classList.add("drag-over");
      }
    };
    const onDragLeave = (e) => {
      if (!composerCard.contains(e.relatedTarget)) composerCard.classList.remove("drag-over");
    };
    const onDrop = (e) => {
      e.preventDefault();
      composerCard.classList.remove("drag-over");
      const files = e.dataTransfer?.files;
      if (files && files.length) addPendingFiles(files);
    };
    composerCard.addEventListener("dragover", onDragOver);
    composerCard.addEventListener("dragenter", onDragOver);
    composerCard.addEventListener("dragleave", onDragLeave);
    composerCard.addEventListener("drop", onDrop);
  }
  // paste image from clipboard
  els.input.addEventListener("paste", (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      const imgs = Array.from(files).filter(f=>f.type.startsWith("image/"));
      if (imgs.length) {
        e.preventDefault();
        addPendingFiles(imgs);
        return;
      }
    }
    // also check dataTransfer items for data URL?
    const items = e.clipboardData?.items;
    if (items) {
      const imageItems = Array.from(items).filter(it=>it.type.startsWith("image/"));
      if (imageItems.length) {
        const files2 = imageItems.map(it=>it.getAsFile()).filter(Boolean);
        if (files2.length) { e.preventDefault(); addPendingFiles(files2); }
      }
    }
  });
  // ESC clears pending images if any
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pendingImages.length) {
      clearPendingImages();
      e.stopPropagation();
    }
  });

  els.editor.addEventListener("input", () => {
    const t = activeTab();
    if (t) t.buffer = els.editor.value;
    setDirty(els.editor.value !== savedContent);
    updateHighlight();
    updateCursorPos();
  });
  els.editor.addEventListener("scroll", () => {
    els.highlight.scrollTop = els.editor.scrollTop;
    els.highlight.scrollLeft = els.editor.scrollLeft;
    els.gutter.scrollTop = els.editor.scrollTop;
  });
  els.editor.addEventListener("keyup", updateCursorPos);
  els.editor.addEventListener("click", updateCursorPos);
  els.editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = els.editor.selectionStart;
      const ee = els.editor.selectionEnd;
      const v = els.editor.value;
      els.editor.value = v.slice(0, s) + "  " + v.slice(ee);
      els.editor.selectionStart = els.editor.selectionEnd = s + 2;
      const t = activeTab();
      if (t) t.buffer = els.editor.value;
      setDirty(els.editor.value !== savedContent);
      updateHighlight();
      updateCursorPos();
    }
  });

  $("#btn-open")?.addEventListener("click", openFile);
  $("#btn-save")?.addEventListener("click", saveFile);
  $("#btn-new")?.addEventListener("click", newFile);
  $("#btn-folder")?.addEventListener("click", openWorkspace);
  $("#btn-ws-refresh")?.addEventListener("click", refreshWorkspace);
  $("#btn-ws-close")?.addEventListener("click", closeWorkspace);
  $("#btn-undo")?.addEventListener("click", undoLast);
  $("#git-refresh")?.addEventListener("click", refreshGitStatus);

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+J or Ctrl+` toggle terminal
    if (mod && (e.key.toLowerCase() === "j" || e.key === "`" || e.code === "Backquote")) {
      e.preventDefault();
      toggleTerminal();
      return;
    }
    // Cmd/Ctrl+E toggle editor
    if (mod && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggleEditor();
      return;
    }
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "o" && e.shiftKey) { e.preventDefault(); openWorkspace(); }
    else if (key === "o") { e.preventDefault(); openFile(); }
    if (key === "s") { e.preventDefault(); saveFile(); }
    if (key === "n") { e.preventDefault(); newFile(); }
    if (key === "k") { e.preventDefault(); document.getElementById("btn-clear")?.click(); }
    if (key === "z" && !e.shiftKey) { e.preventDefault(); undoLast(); }
  });
  // refresh git on focus
  window.addEventListener("focus", () => { if (workspace) refreshGitStatus(); });

  bindDivider();
  initTerminal();
  initChatContextMenu();
  initUpdater();
  // terminal toggle wiring
  $("#term-toggle")?.addEventListener("click", toggleTerminal);
  $("#term-toggle-dock")?.addEventListener("click", toggleTerminal);
  $("#term-close")?.addEventListener("click", () => setTerminalVisible(false));
  document.querySelector("#terminal-pane .term-tab small")?.parentElement?.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest && t.closest("small")) { e.stopPropagation(); setTerminalVisible(false); }
    else if (t.closest && t.closest(".term-tab")) {
      const tab = t.closest(".term-tab");
      const small = tab ? tab.querySelector("small") : null;
      if (small && small.contains(t)) { e.stopPropagation(); setTerminalVisible(false); }
    }
  });
  // editor toggle wiring
  $("#editor-toggle")?.addEventListener("click", toggleEditor);
  $("#editor-toggle-dock")?.addEventListener("click", toggleEditor);
  $("#editor-close")?.addEventListener("click", () => setEditorVisible(false));
  setTerminalVisible(termVisible, { silent: true });
  setEditorVisible(editorVisible, { silent: true });
  try { initMcpSettings(); } catch (e) { console.error("initMcpSettings failed", e); }
  updateHighlight();
  updateCursorPos();
  updateUndoUI();
  refreshGitStatus();
  setFileName("untitled");
  updateCenterVisibility();
}

init();

// Eager fallback: ensure settings button works even if init() threw before reaching initMcpSettings
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    try { initMcpSettings(); } catch (e) { console.error(e); }
  }, { once: true });
} else {
  try { initMcpSettings(); } catch (e) { console.error(e); }
}
