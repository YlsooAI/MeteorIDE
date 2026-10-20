// Extension store UI + hooks used by renderer.js (slash commands, instructions).
// Extensions are declarative; see renderer/docs/extensions.html.
(() => {
  const api = window.meteorAPI?.extensions;
  if (!api) return;

  let installed = [];
  let registry = [];
  let tab = "store";
  let statusMsg = null;
  let busyId = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function refreshInstalled() {
    try {
      installed = (await api.list()).installed || [];
    } catch (e) {
      console.warn("extensions list", e);
    }
    const n = $("ext-installed-count");
    if (n) n.textContent = String(installed.length);
  }

  // ── hooks for renderer.js ──
  window.meteorExt = {
    expandCommand(text) {
      const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text);
      if (!m) return null;
      for (const ext of installed) {
        const cmd = (ext.commands || []).find((c) => c.name === m[1]);
        if (cmd) {
          const input = (m[2] || "").trim();
          return cmd.prompt.includes("{{input}}") ? cmd.prompt.split("{{input}}").join(input) : input ? `${cmd.prompt}\n\n${input}` : cmd.prompt;
        }
      }
      return null;
    },
    helpLines() {
      const lines = installed.flatMap((e) => (e.commands || []).map((c) => `/${c.name} — ${c.description} (${e.name})`));
      return lines.length ? "\n" + lines.join("\n") : "";
    },
    instructions() {
      const parts = installed.filter((e) => e.instructions).map((e) => `- ${e.instructions}`);
      return parts.length ? "\n\n# Extension instructions\n" + parts.join("\n") : "";
    },
  };

  // ── UI ──
  function setStatus(msg, isError) {
    statusMsg = msg ? { msg, isError: !!isError } : null;
    const el = $("ext-status");
    if (!el) return;
    el.classList.toggle("hidden", !statusMsg);
    el.classList.toggle("error", !!statusMsg?.isError);
    el.textContent = statusMsg?.msg || "";
  }

  function tagsFor(e) {
    const tags = [];
    for (const k of Object.keys(e.mcpServers || {})) tags.push(`MCP: ${k}`);
    for (const c of e.commands || []) tags.push(`/${c.name}`);
    if (e.instructions) tags.push("Instructions");
    return tags.map((t) => `<span class="ext-tag">${esc(t)}</span>`).join("");
  }

  function card(e, mode) {
    const meta = [e.author, `v${e.version}`].filter(Boolean).map(esc).join(" · ");
    const isInstalled = mode === "installed" || e.installed;
    let actions;
    if (mode === "installed") {
      actions = `<button class="ext-pill" data-act="remove" data-id="${esc(e.id)}">Remove</button>`;
    } else if (isInstalled) {
      actions = `<span class="ext-installed-badge">Installed</span><button class="ext-pill" data-act="remove" data-id="${esc(e.id)}">Remove</button>`;
    } else {
      actions = `<button class="btn-primary" data-act="install" data-id="${esc(e.id)}"${busyId === e.id ? " disabled" : ""}>${busyId === e.id ? "Installing…" : "Install"}</button>`;
    }
    return `<article class="ext-card"><div><h3>${esc(e.name)}</h3><div class="ext-meta">${meta}</div></div><p>${esc(e.description)}</p><div class="ext-tags">${tagsFor(e)}</div><div class="ext-actions">${actions}</div></article>`;
  }

  function render() {
    const grid = $("ext-grid");
    if (!grid) return;
    const list = tab === "store" ? registry : installed;
    if (!list.length) {
      grid.innerHTML = `<div class="ext-empty">${tab === "store" ? "No extensions available right now." : "Nothing installed yet. Browse the Store, or install your own from a file."}</div>`;
      return;
    }
    grid.innerHTML = list.map((e) => card(e, tab)).join("");
  }

  async function loadStore() {
    setStatus("Loading store…");
    try {
      const res = await api.registry();
      registry = res.entries || [];
      if (res.source === "bundled") setStatus(res.error ? `Offline — showing the built-in list (${res.error}).` : "Showing the built-in list.", false);
      else setStatus(null);
    } catch (e) {
      registry = [];
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
    render();
  }

  async function afterChange() {
    await refreshInstalled();
    if (tab === "store") await loadStore();
    else render();
  }

  async function onAction(ev) {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === "install") {
        busyId = id;
        render();
        const res = await api.install(id);
        busyId = null;
        if (!res?.cancelled) setStatus(`Installed ${res.installed.name}.`);
      } else if (btn.dataset.act === "remove") {
        await api.uninstall(id);
        setStatus("Extension removed.");
      }
    } catch (e) {
      busyId = null;
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
    await afterChange();
  }

  function setTab(next) {
    tab = next;
    document.querySelectorAll(".ext-tab").forEach((b) => b.classList.toggle("active", b.dataset.extTab === next));
    if (next === "store") loadStore();
    else { setStatus(null); render(); }
  }

  function open() {
    const o = $("ext-overlay");
    o.classList.remove("hidden");
    o.setAttribute("aria-hidden", "false");
    setTab("store");
    refreshInstalled();
  }
  function close() {
    const o = $("ext-overlay");
    o.classList.add("hidden");
    o.setAttribute("aria-hidden", "true");
  }

  function init() {
    $("btn-extensions")?.addEventListener("click", open);
    $("ext-close")?.addEventListener("click", close);
    $("ext-backdrop")?.addEventListener("click", close);
    $("ext-docs")?.addEventListener("click", () => api.openDocs());
    $("ext-open-folder")?.addEventListener("click", () => api.openFolder());
    $("ext-install-file")?.addEventListener("click", async () => {
      try {
        const res = await api.installFile();
        if (!res?.cancelled) setStatus(`Installed ${res.installed.name}.`);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e), true);
      }
      await refreshInstalled();
      if (tab === "installed") render();
    });
    document.querySelectorAll(".ext-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.extTab)));
    $("ext-grid")?.addEventListener("click", onAction);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("ext-overlay").classList.contains("hidden")) close();
    });
    refreshInstalled();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
