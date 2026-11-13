/* Attune pipeline dashboard: decrypts the ledger state in the browser and renders it.
   Data: raw.githubusercontent.com/aiZKP/attune_pipeline/data/{state.enc.json, crown.json, crown-history.json}
   (or ./data/ with ?src=local). Untrusted strings are inserted with textContent; markdown is escaped first. */
"use strict";
(function () {
  const params = new URLSearchParams(location.search);
  const CONF = {
    owner: "aiZKP",
    labRepo: "attune-lab",
    dataBase: params.get("src") === "local" ? "./data/" : "https://raw.githubusercontent.com/aiZKP/attune_pipeline/data/",
    refreshMs: 60000,
    keyStore: "attune.key.v1",
  };

  // ------------------------------------------------------------------------------------------ utils
  const $ = (s, r) => (r || document).querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function safeUrl(u) {
    try {
      const x = new URL(u, location.href);
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : "#";
    } catch (e) { return "#"; }
  }
  function h(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k === "html") e.innerHTML = v; // only ever sanitized markdown
        else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
        else if (k === "href") e.setAttribute("href", safeUrl(v));
        else e.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(e, arguments[i]);
    return e;
  }
  function append(e, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => append(e, x)); return; }
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const isNum = (x) => typeof x === "number" && isFinite(x);
  function pts(x, d) {
    if (!isNum(x)) return "—";
    const v = Math.abs(x).toFixed(d === undefined ? 1 : d);
    return (x > 0 ? "+" : x < 0 ? "−" : "±") + v;
  }
  const pct = (x) => (isNum(x) ? Math.round(x * 100) + "%" : "—");
  function ago(iso) {
    if (!iso) return "—";
    const t = Date.parse(iso);
    if (!isFinite(t)) return String(iso);
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 172800) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }
  const shortTask = (t) => String(t).replace(/^place_/, "").replace(/_/g, " ");
  const b64d = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  function b64e(u8) { let s = ""; u8.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); }

  // ------------------------------------------------------------------------------------------ crypto
  async function deriveRaw(pass, saltB64, iter) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: b64d(saltB64), iterations: iter }, base, 256);
    return new Uint8Array(bits);
  }
  async function decryptBlob(blob, raw) {
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct)));
    if (blob.z === "gzip") {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function getJSON(name) {
    const r = await fetch(CONF.dataBase + name + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(name + ": HTTP " + r.status);
    return r.json();
  }

  // ------------------------------------------------------------------------------------------ state
  let BLOB = null, STATE = null, RAW = null, CROWN = null, HIST = null;
  const UI = { tab: "overview", exp: null, method: null, tables: {} };
  const keyName = () => CONF.keyStore + ":" + (BLOB ? BLOB.salt : "");

  // ------------------------------------------------------------------------------------------ chips
  const CHIP = {
    "submit-ready": ["good", "★", "Submit-ready"],
    correct: ["good", "✓", "Correct"],
    promising: ["info", "↗", "Promising"],
    inconclusive: ["neutral", "?", "Inconclusive"],
    invalid: ["serious", "!", "Invalid"],
    false: ["critical", "✕", "False"],
    banned: ["critical", "⊘", "Banned"],
    running: ["info", "▶", "Running"],
    "awaiting-verdict": ["info", "…", "Awaiting verdict"],
    blocked: ["warning", "■", "Blocked"],
    queued: ["neutral", "•", "Queued"],
    ready: ["neutral", "•", "Ready"],
    draft: ["neutral", "✎", "Draft"],
    done: ["good", "✓", "Done"],
    withdrawn: ["neutral", "–", "Withdrawn"],
    aborted: ["neutral", "–", "Aborted"],
    vaulted: ["info", "◆", "Vaulted"],
    approved: ["good", "✓", "Approved"],
    submitted: ["info", "⇪", "Submitted"],
    crowned: ["good", "♛", "Crowned"],
    lost: ["critical", "✕", "Lost"],
    superseded: ["neutral", "–", "Superseded"],
    exact: ["neutral", "◦", "Exact"],
    variant: ["warning", "◐", "Variant"],
    family: ["critical", "●", "Family"],
    on: ["good", "●", "On"],
    off: ["neutral", "○", "Off"],
  };
  function chip(status) {
    const key = String(status || "").toLowerCase();
    const c = CHIP[key] || ["neutral", "•", String(status || "unknown")];
    return h("span", { class: "chip " + c[0] }, h("span", { class: "ico", "aria-hidden": "true", text: c[1] }), c[2]);
  }

  // ------------------------------------------------------------------------------------------ markdown
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ESC[c]);
  function inline(src) {
    let t = esc(src);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>");
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + codes[Number(i)] + "</code>");
    return t;
  }
  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith("|")) l = l.slice(1);
    if (l.endsWith("|")) l = l.slice(0, -1);
    return l.split("|").map((c) => c.trim());
  }
  function md(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    const isList = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
    const blockStart = (l) => /^```/.test(l) || /^#{1,6}\s/.test(l) || isList(l) || /^\s*\|/.test(l);
    while (i < lines.length) {
      const L = lines[i];
      if (/^```/.test(L)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      const hm = L.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        const lvl = Math.min(hm[1].length + 1, 4);
        out.push("<h" + lvl + ">" + inline(hm[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }
      if (/^\s*\|/.test(L) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = splitRow(L);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
        out.push('<div class="tablewrap"><table><thead><tr>' + head.map((c) => "<th>" + inline(c) + "</th>").join("") +
          "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table></div>");
        continue;
      }
      if (isList(L)) {
        const stack = [];
        let html = "";
        while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && stack.length))) {
          const line = lines[i];
          if (!isList(line)) { html += " " + inline(line.trim()); i++; continue; }
          const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          const indent = m[1].length;
          const tag = /\d/.test(m[2]) ? "ol" : "ul";
          while (stack.length && indent < stack[stack.length - 1].indent) { html += "</li></" + stack.pop().tag + ">"; }
          if (!stack.length || indent > stack[stack.length - 1].indent) { html += "<" + tag + ">"; stack.push({ indent, tag }); }
          else html += "</li>";
          html += "<li>" + inline(m[3]);
          i++;
        }
        while (stack.length) html += "</li></" + stack.pop().tag + ">";
        out.push(html);
        continue;
      }
      if (!L.trim()) { i++; continue; }
      const buf = [L.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) buf.push(lines[i++].trim());
      out.push("<p>" + inline(buf.join(" ")) + "</p>");
    }
    return out.join("\n");
  }
  const mdBox = (src) => h("div", { class: "md", html: md(src) });

  // ------------------------------------------------------------------------------------------ boot
  async function boot() {
    $("#theme-btn").addEventListener("click", toggleTheme);
    $("#lock-btn").addEventListener("click", () => { store.del(keyName()); RAW = null; STATE = null; renderLock(); });
    window.addEventListener("resize", debounce(drawCharts, 150));
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawCharts); } catch (e) { /* old browsers */ }
    await refreshPublic();
    try {
      BLOB = await getJSON("state.enc.json");
    } catch (e) {
      $("#app").replaceChildren(h("div", { class: "panel" }, h("div", { class: "empty", text: "No dashboard data published yet (" + e.message + ")." })));
      return;
    }
    const saved = store.get(keyName());
    if (saved) {
      try { RAW = b64d(saved); STATE = await decryptBlob(BLOB, RAW); } catch (e) { store.del(keyName()); RAW = null; STATE = null; }
    }
    if (STATE) render(); else renderLock();
    setInterval(tick, CONF.refreshMs);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store.set("attune.theme", next);
    drawCharts();
  }
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await refreshPublic();
      if (!RAW) return;
      const b = await getJSON("state.enc.json");
      if (!BLOB || b.ct !== BLOB.ct) {
        if (b.salt !== BLOB.salt) { BLOB = b; STATE = null; RAW = null; renderLock("The key changed; enter the passphrase again."); return; }
        STATE = await decryptBlob(b, RAW);
        BLOB = b;
        render();
      } else updatedLabel();
    } catch (e) {
      $("#updated").textContent = "refresh failed: " + e.message;
    } finally { ticking = false; }
  }
  async function refreshPublic() {
    try { CROWN = await getJSON("crown.json"); } catch (e) { CROWN = null; }
    try { HIST = await getJSON("crown-history.json"); } catch (e) { HIST = null; }
    renderCrown();
  }

  // ------------------------------------------------------------------------------------------ crown strip
  function renderCrown() {
    const box = $("#crown");
    const c = CROWN || (STATE && STATE.competition) || null;
    if (!c || !c.king) { box.replaceChildren(h("span", { class: "meta", text: "Crown status unavailable." })); return; }
    const k = c.king;
    const item = (label, value, mono) => h("span", null, h("span", { class: "k", text: label }), h("span", { class: "v" + (mono ? " mono" : ""), text: value }));
    const since = (STATE && STATE.competition && STATE.competition.king_since && STATE.competition.king_since.key === k.key)
      ? STATE.competition.king_since.first_seen : c.changed_at;
    box.replaceChildren(
      item("King", k.repo || "—"),
      item("key", k.key || "—", true),
      item("Level", String(c.level !== undefined ? c.level : (c.spec && c.spec.level) || "—")),
      item("Margin", "+" + ((c.spec && (c.spec.margin !== undefined ? c.spec.margin : c.spec.crown && c.spec.crown.margin)) || 3) + " pts"),
      item("King seen since", ago(since)),
      item("Gate max level", String(gateMax(c))),
      item("Next (docs)", (c.watch && c.watch.docs && c.watch.docs.next) || "—"),
      item("Checked", ago(c.checked_at) + (c.checked_by ? " · " + c.checked_by : "")),
    );
    renderAlerts(c);
  }
  function gateMax(c) {
    const g = c && c.watch && c.watch.gate && c.watch.gate.vector;
    return g && g.max_level !== null && g.max_level !== undefined ? g.max_level : "—";
  }
  // Level-watch alerts of the last 72 hours, newest first: a push that announces or starts a new level.
  function renderAlerts(c) {
    const box = $("#levelalert");
    if (!box) return;
    const recent = ((c && c.alerts) || []).filter((a) => Date.now() - Date.parse(a.at) < 72 * 3600 * 1000).slice(-6).reverse();
    box.replaceChildren(...recent.map((a) => h("div", { class: "alertbar" },
      h("strong", { text: "Level watch: " }), h("span", { text: a.text + " · " + ago(a.at) }))));
  }

  // ------------------------------------------------------------------------------------------ lock
  function renderLock(msg) {
    $("#lock-btn").hidden = true;
    const input = h("input", { type: "password", autocomplete: "current-password", placeholder: "Passphrase", "aria-label": "Passphrase" });
    const remember = h("input", { type: "checkbox", checked: true });
    const err = h("div", { class: "err", role: "alert", text: msg || "" });
    const btn = h("button", { class: "btn primary", type: "submit", text: "Unlock" });
    const form = h("form", {
      class: "lock",
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (!input.value) return;
        btn.disabled = true;
        err.textContent = "Deriving the key…";
        try {
          const raw = await deriveRaw(input.value, BLOB.salt, BLOB.iter);
          STATE = await decryptBlob(BLOB, raw);
          RAW = raw;
          if (remember.checked) store.set(keyName(), b64e(raw));
          render();
        } catch (e) {
          err.textContent = "That passphrase does not open this data. Try again.";
          btn.disabled = false;
          input.select();
        }
      },
    },
      h("h1", { text: "Unlock the dashboard" }),
      h("p", { text: "The pipeline state is encrypted. Enter the passphrase (DASHBOARD_PASSPHRASE in your .env)." }),
      input, h("label", null, remember, "Remember on this device"), btn, err);
    $("#app").replaceChildren(form);
    input.focus();
  }

  // ------------------------------------------------------------------------------------------ derived data
  function verdictRows() {
    return (STATE.experiments || [])
      .filter((e) => e.verdict && isNum(e.verdict.delta_points))
      .map((e) => ({
        id: e.id, method: e.method, cls: e.verdict.class, delta: e.verdict.delta_points, ci: e.verdict.ci,
        pwin: e.verdict.ticket && isNum(e.verdict.ticket.p_win) ? e.verdict.ticket.p_win : e.verdict.p_win_duel,
        ticket: e.verdict.ticket || null, n: e.verdict.n_paired, tier: e.tier, at: e.updated || e.created,
        current: e.verdict.king_is_current !== false, v: e.verdict, e,
      }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
  }
  function bestRow(rows) {
    const ok = rows.filter((r) => r.current && r.cls !== "INVALID");
    if (!ok.length) return null;
    return ok.reduce((a, b) => (b.delta > a.delta ? b : a));
  }
  const methodTitle = (id) => { const m = (STATE.methods || []).find((x) => x.id === id); return m ? m.title : ""; };

  // ------------------------------------------------------------------------------------------ render
  function updatedLabel() {
    $("#updated").textContent = STATE ? "Data " + ago(STATE.generated) + (STATE.lab_head ? " · lab " + STATE.lab_head : "") : "";
  }
  function render() {
    $("#lock-btn").hidden = false;
    updatedLabel();
    renderCrown();
    const app = $("#app");
    const scrollY = window.scrollY;
    const parts = [];
    if (STATE.errors && STATE.errors.length) parts.push(h("div", { class: "warnbar", text: "Ledger errors: " + STATE.errors.join(" · ") }));
    parts.push(kpis(), signalsPanel(), tabsNav(), tabBody());
    app.replaceChildren.apply(app, parts);
    $("#foot").textContent = "Encrypted state from aiZKP/attune-lab · refreshes every minute · raw CDN may lag ~5 min.";
    drawCharts();
    window.scrollTo(0, scrollY);
  }

  function tile(label, value, sub, opts) {
    opts = opts || {};
    return h("div", { class: "tile" },
      h("div", { class: "label", text: label }),
      h("div", { class: "value" + (opts.hero ? " hero" : "") + (opts.small ? " small" : "") }, value),
      sub ? h("div", { class: "sub" }, sub) : null);
  }
  // A fixed, hourly-billed pod budget (config.budget): what is left is a function of the clock alone.
  function budgetNow() {
    const b = STATE.config && STATE.config.budget;
    if (!b || !isNum(b.usd_at_rent) || !isNum(b.usd_per_hour) || b.usd_per_hour <= 0) return null;
    const t0 = Date.parse(b.rented_at);
    if (isNaN(t0)) return null;
    const usd = Math.max(0, b.usd_at_rent - Math.max(0, (Date.now() - t0) / 3.6e6) * b.usd_per_hour);
    const end = Date.parse(b.sprint_end);
    return { usd, hours: usd / b.usd_per_hour, rate: b.usd_per_hour,
      toEnd: isNaN(end) ? null : Math.max(0, (end - Date.now()) / 3.6e6) };
  }
  const tao = (x) => (isNum(x) ? (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(1) + " TAO" : "—");
  function kpis() {
    const rows = verdictRows();
    const best = bestRow(rows);
    const comp = STATE.competition || {};
    const ms = STATE.methods || [];
    const count = (st) => ms.filter((m) => st.indexOf(m.status) >= 0).length;
    const queue = ((STATE.queue || {}).items || []).map((q) => q.id);
    const gpu = STATE.runtime || {};
    const bud = budgetNow();
    const margin = (STATE.config && STATE.config.verdict && STATE.config.verdict.margin_points) || 3;
    const tk = best && best.ticket;
    const gpuUsed = (isNum(gpu.gpu_hours_used_total) ? gpu.gpu_hours_used_total.toFixed(1) + " GPU-h used" : "") +
      ((gpu.jobs || []).length ? " · " + gpu.jobs.length + " job(s)" : "") + (gpu.updated ? " · " + ago(gpu.updated) : "");
    return h("section", { class: "kpis", "aria-label": "Key numbers" },
      tile("Best Δ vs the current king", best ? pts(tk && isNum(tk.delta_points) ? tk.delta_points : best.delta) + " pts" : "—",
        best ? [best.id + " · " + best.method + " · " + (tk ? tk.units + " units (" + tk.basis + ") · " : ""), chip(best.cls.toLowerCase())]
          : "No verdict yet against the current king",
        { hero: true }),
      tile("Win chance of the best", best ? pct(best.pwin) : "—",
        tk && isNum(tk.ev_tao)
          ? "One entry is worth " + tao(tk.ev_tao) + " (crown ≈ " + tk.crown_value_tao + " TAO, fee " + tk.burn_tao + ")"
          : "Simulated 16×15 duel, crown at +" + margin + " pts"),
      tile("Reigning king", (comp.king && comp.king.repo) || "—", "Level " + (comp.level !== undefined ? comp.level : "—") + " · seen " + ago(comp.king_since && comp.king_since.first_seen), { small: true }),
      tile("Pipeline", count(["running"]) + " running · " + queue.length + " queued",
        queue.length ? "Next: " + queue.slice(0, 3).join(", ") : "Queue empty", { small: true }),
      bud
        ? tile("Pod budget left", h("span", null, "$" + bud.usd.toFixed(0) + " · " + bud.hours.toFixed(1) + " h ", chip(gpu.box || "off")),
            "$" + bud.rate.toFixed(2) + "/h, busy or idle" + (bud.toEnd !== null ? " · sprint ends in " + bud.toEnd.toFixed(1) + " h" : "") +
            ((gpu.jobs || []).length ? " · " + gpu.jobs.length + " job(s)" : ""), { small: true })
        : tile("GPU box", h("span", null, chip(gpu.box || "off")), gpuUsed),
    );
  }

  function issueUrl(type, arg, text, body) {
    const title = "SIGNAL " + type + (arg ? " " + arg : "") + (text ? ": " + text : "");
    const u = new URL("https://github.com/" + CONF.owner + "/" + CONF.labRepo + "/issues/new");
    u.searchParams.set("labels", "signal");
    u.searchParams.set("title", title);
    u.searchParams.set("body", body || "");
    return u.toString();
  }
  function sigBtn(label, type, arg, text, body, primary) {
    return h("a", { class: "btn small" + (primary ? " primary" : ""), href: issueUrl(type, arg, text, body), target: "_blank", rel: "noopener noreferrer", text: label });
  }
  function signalsPanel() {
    const cands = (STATE.candidates || []).slice().sort((a, b) => (a.status === "submit-ready" ? -1 : 0) - (b.status === "submit-ready" ? -1 : 0));
    const sel = h("select", { "aria-label": "Candidate" });
    if (!cands.length) sel.append(h("option", { value: "", text: "no candidates yet" }));
    cands.forEach((c) => sel.append(h("option", { value: c.id, text: c.id + " · " + (c.status || "") })));
    const approve = h("a", { class: "btn small primary", target: "_blank", rel: "noopener noreferrer", text: "Approve" });
    const reject = h("a", { class: "btn small", target: "_blank", rel: "noopener noreferrer", text: "Reject" });
    const sync = () => {
      const id = sel.value;
      if (!id) { approve.removeAttribute("href"); reject.removeAttribute("href"); approve.setAttribute("aria-disabled", "true"); return; }
      approve.removeAttribute("aria-disabled");
      approve.setAttribute("href", issueUrl("APPROVE", id, "", "I approve submitting " + id + " to SN58 (finney, netuid 58).\n\nRegistered hotkey: wallet.name=<name> wallet.hotkey=<hotkey>\n"));
      reject.setAttribute("href", issueUrl("REJECT", id, "", "Do not submit " + id + ". Reason:\n"));
    };
    sel.addEventListener("change", sync);
    sync();
    const open = (STATE.signals || []).length;
    return h("section", { class: "panel", "aria-label": "Signals" },
      h("h2", null, "Send a signal", h("span", { class: "hint", text: "opens a pre-filled GitHub issue; Session A or B acts on it" + (open ? " · " + open + " open" : "") })),
      h("div", { class: "signals" },
        sigBtn("Crown changed", "CROWN", "", "new king <owner/repo>", "What the leaderboard shows (king, time):\n"),
        sigBtn("Queue note", "QUEUE", "", "queue status", "What the leaderboard queue shows (entries ahead, who):\n"),
        sigBtn("Level / spec news", "LEVEL", "", "news", "What changed or was announced:\n"),
        h("span", { class: "sep" }),
        sigBtn("GPU is on", "GPU-ON", "", "", "The GPU box is on and reachable.\n"),
        sigBtn("GPU is off", "GPU-OFF", "", "", "I am switching the GPU box off.\n"),
        sigBtn("Pause B", "PAUSE", "", "", "Pause new GPU work until RESUME.\n"),
        sigBtn("Resume B", "RESUME", "", "", "Resume work.\n"),
        h("span", { class: "sep" }),
        sel, approve, reject,
        h("span", { class: "sep" }),
        sigBtn("Note to A", "NOTE", "", "note", ""),
        sigBtn("Method idea", "METHOD", "", "idea", "Idea, source/link, why it might work:\n"),
      ));
  }

  // ------------------------------------------------------------------------------------------ tabs
  const TABS = [
    ["overview", "Overview"], ["methods", "Methods"], ["experiments", "Experiments"], ["candidates", "Candidates"],
    ["bans", "Bans"], ["competition", "Competition"], ["journal", "Journal"], ["notes", "Notes"],
  ];
  function tabsNav() {
    const counts = {
      methods: (STATE.methods || []).length, experiments: (STATE.experiments || []).length,
      candidates: (STATE.candidates || []).length, bans: (STATE.bans || []).length,
      notes: (STATE.notes || []).length + (STATE.proposals || []).length,
    };
    const nav = h("nav", { class: "tabs", role: "tablist" });
    TABS.forEach(([id, label]) => {
      nav.append(h("button", {
        role: "tab", type: "button", "aria-selected": UI.tab === id ? "true" : "false",
        onclick: () => { UI.tab = id; render(); },
      }, label, counts[id] !== undefined ? h("span", { class: "count", text: String(counts[id]) }) : null));
    });
    return nav;
  }
  function tabBody() {
    switch (UI.tab) {
      case "methods": return methodsTab();
      case "experiments": return experimentsTab();
      case "candidates": return candidatesTab();
      case "bans": return bansTab();
      case "competition": return competitionTab();
      case "journal": return journalTab();
      case "notes": return notesTab();
      default: return overviewTab();
    }
  }
  function panel(title, hint, body, extra) {
    return h("section", { class: "panel" }, h("h2", null, title, hint ? h("span", { class: "hint", text: hint }) : null, extra || null), body);
  }

  // ------------------------------------------------------------------------------------------ overview
  function overviewTab() {
    const rows = verdictRows();
    const focus = (UI.exp && rows.find((r) => r.id === UI.exp)) || bestRow(rows) || rows[rows.length - 1] || null;
    const queue = ((STATE.queue || {}).items || []).slice(0, 7);
    const qList = queue.length
      ? h("div", { class: "tablewrap" }, h("table", null,
        h("thead", null, h("tr", null, h("th", { text: "#" }), h("th", { text: "Method" }), h("th", { text: "Title" }), h("th", { class: "num", text: "Priority" }))),
        h("tbody", null, queue.map((q, i) => h("tr", { class: "clickable", onclick: () => { UI.tab = "methods"; UI.method = q.id; render(); } },
          h("td", { text: String(i + 1) }), h("td", { class: "mono", text: q.id }), h("td", { text: methodTitle(q.id) }),
          h("td", { class: "num", text: isNum(q.priority) ? q.priority.toFixed(2) : String(q.priority) }))))))
      : h("div", { class: "empty", text: "Queue is empty." });
    return h("div", null,
      h("div", { class: "grid2" },
        panel("Verdicts against the king", "Δ in points with 90% CI; the crown needs +3", chartBox("delta", { rows })),
        panel("Per-task success" + (focus ? " — " + focus.id : ""), focus ? (focus.method + " · " + methodTitle(focus.method)) : "", chartBox("dumbbell", { v: focus && focus.v }))),
      level5Panel(),
      h("div", { class: "grid2" },
        panel("Up next", "from ledger/queue.json", qList),
        panel("Recent activity", "journals of A and B", recentActivity())));
  }
  // The level-5 programme: fixed steps, done one by one (ledger/competition/level5.json).
  function level5Panel() {
    const p = STATE.level5;
    if (!p || !(p.steps || []).length) return h("div", null);
    const kind = { done: "good", running: "info", next: "warning", blocked: "critical", waiting: "" };
    const rows = p.steps.map((st) => h("tr", null,
      h("td", { class: "mono", text: st.id }), h("td", { text: st.title }), h("td", { text: st.owner || "" }),
      h("td", { class: "state" }, h("span", { class: "chip " + (kind[st.state] || "") }, h("span", { class: "ico", text: "●" }), h("span", { text: " " + st.state }))),
      h("td", { text: st.result || "" })));
    return panel("Level 5 programme" + (p.goal ? ": " + p.goal : ""), "updated " + ago(p.updated) + " · steps are done in order, one at a time" + (p.note ? " · " + p.note : ""),
      h("div", { class: "tablewrap" }, h("table", { class: "steps" },
        h("thead", null, h("tr", null, ["Step", "What", "Who", "State", "Result"].map((t) => h("th", { text: t })))),
        h("tbody", null, rows))));
  }
  function recentActivity() {
    const items = [];
    ["A", "B"].forEach((sess) => {
      ((STATE.journal || {})[sess] || []).forEach((d) => {
        String(d.text).split("\n").forEach((line) => {
          const m = line.match(/^- \*\*(\d\d:\d\d)Z\*\* (.*)$/);
          if (m) items.push({ sess, when: d.date + " " + m[1], text: m[2] });
        });
      });
    });
    items.sort((a, b) => b.when.localeCompare(a.when));
    if (!items.length) return h("div", { class: "empty", text: "No journal entries yet." });
    return h("div", null, items.slice(0, 8).map((it) => h("div", { class: "md", style: null },
      h("p", null, h("span", { class: "chip neutral" }, h("span", { class: "ico", text: it.sess === "A" ? "◇" : "◆" }), "Session " + it.sess),
        " ", h("span", { class: "meta", text: it.when + "Z" }), h("br"), h("span", { html: inline(it.text.slice(0, 400)) })))));
  }

  // ------------------------------------------------------------------------------------------ methods
  const LANES = [
    ["Up next", ["queued", "ready"]],
    ["In progress", ["running", "awaiting-verdict", "blocked"]],
    ["Results", ["submit-ready", "correct", "promising", "inconclusive", "invalid", "done"]],
    ["Parked", ["false", "banned", "draft", "withdrawn", "aborted"]],
  ];
  function methodsTab() {
    const ms = STATE.methods || [];
    const queuePos = {};
    ((STATE.queue || {}).items || []).forEach((q, i) => { queuePos[q.id] = i; });
    const board = h("div", { class: "kanban" });
    LANES.forEach(([title, sts]) => {
      const items = ms.filter((m) => sts.indexOf(m.status) >= 0).sort((a, b) =>
        (queuePos[a.id] !== undefined ? queuePos[a.id] : 999) - (queuePos[b.id] !== undefined ? queuePos[b.id] : 999) ||
        (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id));
      const lane = h("div", { class: "lane" }, h("h3", null, title, h("span", { text: String(items.length) })));
      if (!items.length) lane.append(h("div", { class: "empty", text: "—" }));
      items.forEach((m) => lane.append(h("div", {
        class: "card" + (UI.method === m.id ? " sel" : ""), tabindex: "0", role: "button",
        onclick: () => { UI.method = m.id; render(); },
        onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); UI.method = m.id; render(); } },
      },
        h("div", { class: "row" }, h("span", { class: "mono", text: m.id }), chip(m.status), m.kind === "calibration" ? h("span", { class: "tag", text: "calibration" }) : h("span", { class: "tag", text: m.family })),
        h("div", { class: "t", text: m.title }),
        h("div", { class: "row" },
          isNum(m.priority) ? h("span", { text: "prio " + m.priority.toFixed(2) }) : null,
          isNum(m.expected_delta) ? h("span", { text: "E[Δ] " + pts(m.expected_delta) }) : null,
          m.best ? h("span", { text: "best " + pts(m.best.delta) + " (" + m.best.experiment + ")" }) : null))));
      board.append(lane);
    });
    const sel = ms.find((m) => m.id === UI.method);
    return h("div", null, board, sel ? methodDetail(sel) : h("div", { class: "empty", text: "Select a card to read it." }));
  }
  function methodDetail(m) {
    const exps = (STATE.experiments || []).filter((e) => e.method === m.id);
    return h("section", { class: "panel detail" },
      h("h2", null, m.id + " — " + m.title),
      h("div", { class: "kv" },
        h("span", { class: "k", text: "Status" }), h("span", null, chip(m.status)),
        h("span", { class: "k", text: "Family" }), h("span", { text: m.family + (m.parent ? " · deepens " + m.parent : "") }),
        h("span", { class: "k", text: "Tags" }), h("span", null, (m.tags || []).map((t) => h("span", { class: "tag", text: t }))),
        h("span", { class: "k", text: "Priority" }), h("span", { text: isNum(m.priority) ? m.priority.toFixed(3) + "  (E[Δ] " + pts(m.expected_delta) + ", p " + (m.p_works !== undefined ? m.p_works : "—") + ", " + (m.gpu_hours !== undefined ? m.gpu_hours : "—") + " GPU-h)" : "—" }),
        h("span", { class: "k", text: "Experiments" }), h("span", null, exps.length ? exps.map((e) => h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); UI.tab = "experiments"; UI.exp = e.id; render(); }, text: e.id + " " })) : "none yet"),
        m.bans && m.bans.length ? h("span", { class: "k", text: "Banned by" }) : null, m.bans && m.bans.length ? h("span", { text: m.bans.join(", ") }) : null,
        h("span", { class: "k", text: "Sources" }), h("span", null, (m.sources || []).length ? m.sources.map((u) => h("div", null, /^https?:/.test(u) ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer", text: u }) : h("span", { class: "mono", text: u }))) : "—")),
      mdBox(m.body));
  }

  // ------------------------------------------------------------------------------------------ experiments
  function experimentsTab() {
    const exps = (STATE.experiments || []).slice().sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
    if (!exps.length) return panel("Experiments", "", h("div", { class: "empty", text: "No experiments yet. Session B claims methods from the queue." }));
    const tbl = h("table", null,
      h("thead", null, h("tr", null, ["ID", "Method", "State", "Tier", "Δ pts", "90% CI", "P(win)", "n", "Voids", "Verdict", "GPU-h", "Updated"].map((t, i) =>
        h("th", { class: i >= 4 && i <= 8 || i === 10 ? "num" : null, text: t })))),
      h("tbody", null, exps.map((e) => {
        const v = e.verdict || {};
        return h("tr", { class: "clickable" + (UI.exp === e.id ? " sel" : ""), onclick: () => { UI.exp = e.id; render(); } },
          h("td", { class: "mono", text: e.id }), h("td", { class: "mono", text: e.method }), h("td", null, chip(e.state === "done" ? "done" : e.state)),
          h("td", { text: e.tier || "—" }), h("td", { class: "num", text: pts(v.delta_points) }),
          h("td", { class: "num", text: v.ci ? "[" + pts(v.ci[0]) + ", " + pts(v.ci[1]) + "]" : "—" }),
          h("td", { class: "num", text: pct(v.p_win_duel) }), h("td", { class: "num", text: isNum(v.n_paired) ? String(v.n_paired) : "—" }),
          h("td", { class: "num", text: isNum(v.void_frac) ? Math.round(v.void_frac * 100) + "%" : "—" }),
          h("td", null, v.class ? chip(v.class.toLowerCase()) : "—"), h("td", { class: "num", text: isNum(e.gpu_hours) ? e.gpu_hours.toFixed(1) : "—" }),
          h("td", { text: ago(e.updated || e.created) }));
      })));
    const sel = exps.find((e) => e.id === UI.exp);
    return h("div", null, panel("Experiments", "click a row for details", h("div", { class: "tablewrap" }, tbl)), sel ? experimentDetail(sel) : null);
  }
  function experimentDetail(e) {
    const v = e.verdict;
    const sanity = e.sanity || {};
    const kv = h("div", { class: "kv" },
      h("span", { class: "k", text: "Method" }), h("span", { text: e.method + " — " + methodTitle(e.method) }),
      h("span", { class: "k", text: "King" }), h("span", { text: e.king ? (e.king.repo || "") + " (" + (e.king.key || "") + ")" : "—" }),
      h("span", { class: "k", text: "Base" }), h("span", { text: e.base ? (e.base.name || "—") : "—" }),
      h("span", { class: "k", text: "Data" }), h("span", { text: e.data ? (e.data.description || "—") + (e.data.n_pairs ? " · " + e.data.n_pairs + " pairs" : "") : "—" }),
      h("span", { class: "k", text: "Sanity" }), h("span", null, Object.keys(sanity).length ? Object.keys(sanity).map((k) => h("span", { class: "tag", text: (sanity[k] === true ? "✓ " : sanity[k] === false ? "✕ " : "· ") + k })) : "—"),
      v ? h("span", { class: "k", text: "Verdict" }) : null, v ? h("span", null, chip((v.class || "").toLowerCase()), " Δ " + pts(v.delta_points) + " pts, SE " + (isNum(v.se_points) ? v.se_points.toFixed(2) : "—") + ", P(Δ>0) " + pct(v.p_delta_gt0) + ", P(win) " + pct(v.p_win_duel)) : null,
      v && v.holdout ? h("span", { class: "k", text: "Holdout" }) : null, v && v.holdout ? h("span", { text: (v.holdout.pool || "") + ": Δ " + pts(v.holdout.delta_points) + " pts on " + v.holdout.n_paired + " units, P(win) " + pct(v.holdout.p_win_duel) }) : null,
      v && v.pooled ? h("span", { class: "k", text: "Dev + holdout" }) : null, v && v.pooled ? h("span", { text: "Δ " + pts(v.pooled.delta_points) + " pts on " + v.pooled.n_paired + " units, P(Δ>0) " + pct(v.pooled.p_delta_gt0) + ", P(win) " + pct(v.pooled.p_win_duel) }) : null,
      v && v.ticket ? h("span", { class: "k", text: "One entry" }) : null, v && v.ticket ? h("span", { text: "worth " + tao(v.ticket.ev_tao) + " = P(win) " + pct(v.ticket.p_win) + " × " + v.ticket.crown_value_tao + " TAO − " + v.ticket.burn_tao + " TAO fee (from " + v.ticket.basis + ")" }) : null,
      v && v.partial ? h("span", { class: "k", text: "Stopped early" }) : null, v && v.partial ? h("span", { text: v.partial.tasks_evaluated.length + " of " + (v.partial.tasks_evaluated.length + v.partial.tasks_missing.length) + " tasks run; Δ is in points of the full score, tasks not run counted as 0" }) : null,
      v && v.reasons ? h("span", { class: "k", text: "Reasons" }) : null, v && v.reasons ? h("span", { text: v.reasons.join(" · ") }) : null,
      e.reason ? h("span", { class: "k", text: "Note" }) : null, e.reason ? h("span", { text: e.reason }) : null);
    return h("div", { class: "grid2 detail" },
      panel(e.id + " — details", e.state, h("div", null, kv, e.note ? mdBox(e.note) : null)),
      panel("Per-task success — " + e.id, "candidate vs king on the same units", chartBox("dumbbell", { v })));
  }

  // ------------------------------------------------------------------------------------------ candidates / bans
  function candidatesTab() {
    const cs = STATE.candidates || [];
    if (!cs.length) return panel("Candidate vault", "", h("div", { class: "empty", text: "No candidates yet. CORRECT experiments are vaulted here." }));
    return panel("Candidate vault", "weights live in private HF backups; never public until submitted", h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, ["ID", "Status", "Experiment", "Method", "Δ pts", "P(win)", "King", "sha256", "Submission", ""].map((t, i) => h("th", { class: i === 4 || i === 5 ? "num" : null, text: t })))),
      h("tbody", null, cs.map((c) => {
        const sc = (c.scores || [])[c.scores ? c.scores.length - 1 : 0] || {};
        const sub = c.submission;
        return h("tr", null, h("td", { class: "mono", text: c.id }), h("td", null, chip(c.status)), h("td", { class: "mono", text: c.experiment }),
          h("td", { class: "mono", text: c.method || "" }), h("td", { class: "num", text: pts(sc.delta_points) }), h("td", { class: "num", text: pct(sc.p_win_duel) }),
          h("td", { text: sc.king ? sc.king.repo || "" : "" }), h("td", { class: "mono", text: String(c.sha256 || "").slice(0, 12) }),
          h("td", { text: sub ? (sub.repo || "") + (sub.commit_block ? " @" + sub.commit_block : "") : "—" }),
          h("td", null, c.status === "submit-ready" ? h("a", { class: "btn small primary", target: "_blank", rel: "noopener noreferrer", href: issueUrl("APPROVE", c.id, "", "I approve submitting " + c.id + " to SN58 (finney, netuid 58).\n\nRegistered hotkey: wallet.name=<name> wallet.hotkey=<hotkey>\n"), text: "Approve" }) : null));
      })))));
  }
  function bansTab() {
    const bs = STATE.bans || [];
    if (!bs.length) return panel("Ban list", "", h("div", { class: "empty", text: "No bans yet. FALSE verdicts become scoped bans here." }));
    return h("div", null, bs.map((b) => h("section", { class: "panel" },
      h("h2", null, b.id + " ", chip(b.scope), h("span", { class: "hint", text: (b.methods || []).join(", ") + " · " + (b.family || "") + " · level " + (b.level !== undefined ? b.level : "—") + " · " + (b.created || "") })),
      h("div", { class: "md" }, h("p", null, h("strong", { text: "Do not propose: " }), String(b.do_not_propose || ""))),
      h("div", null, (b.tags || []).map((t) => h("span", { class: "tag", text: t })), (b.evidence || []).length ? h("span", { class: "meta", text: " evidence " + b.evidence.join(", ") }) : null),
      mdBox(b.body || ""))));
  }

  // ------------------------------------------------------------------------------------------ competition
  function competitionTab() {
    const c = STATE.competition || {};
    const kings = h("table", null, h("thead", null, h("tr", null, ["Place", "Repo", "Key", "sha256", "Revision"].map((t) => h("th", { text: t })))),
      h("tbody", null, (c.kings || []).map((k) => h("tr", null, h("td", { text: String(k.place) }), h("td", { text: k.repo }), h("td", { class: "mono", text: k.key }),
        h("td", { class: "mono", text: String(k.sha256 || "").slice(0, 16) }), h("td", { class: "mono", text: String(k.revision || "").slice(0, 10) })))));
    const sp = c.spec || {};
    const spec = h("div", { class: "kv" },
      h("span", { class: "k", text: "Spec version" }), h("span", { text: String(sp.version !== undefined ? sp.version : "—") + " @ " + String(sp.sha || "").slice(0, 10) }),
      h("span", { class: "k", text: "Level" }), h("span", { text: String(sp.level !== undefined ? sp.level : "—") + (c.level_since ? " (since " + ago(c.level_since.first_seen) + ")" : "") }),
      h("span", { class: "k", text: "Crown" }), h("span", { text: sp.crown ? "margin +" + sp.crown.margin + " pts · max void " + Math.round(sp.crown.max_void * 100) + "%" : "—" }),
      h("span", { class: "k", text: "Units" }), h("span", { text: ((sp.tasks || []).length || "—") + " tasks × " + (sp.runs_per_task || "—") + " · step ratio " + (sp.step_ratio || "—") }),
      h("span", { class: "k", text: "Architecture" }), h("span", { text: sp.model ? sp.model.architecture : "—" }),
      h("span", { class: "k", text: "Tasks" }), h("span", null, (sp.tasks || []).map((t) => h("span", { class: "tag", text: t }))));
    const heads = h("table", null, h("thead", null, h("tr", null, ["Repo", "Branch", "Head", "Date", "Last commit"].map((t) => h("th", { text: t })))),
      h("tbody", null, Object.keys(c.heads || {}).map((n) => { const x = c.heads[n]; return h("tr", null, h("td", { text: n }), h("td", { text: x.branch }), h("td", { class: "mono", text: String(x.sha || "").slice(0, 10) }), h("td", { text: ago(x.date) }), h("td", { text: x.message })); })));
    const events = [];
    (STATE.competition_history || []).forEach((hh) => (hh.changes || []).forEach((ch) => events.push({ at: hh.at, ch })));
    ((HIST && HIST.events) || []).forEach((ev) => events.push({ at: ev.at, ch: ev }));
    events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const seen = new Set();
    const evList = events.filter((e) => { const k = e.at + JSON.stringify(e.ch); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
    const describe = (ch) => ch.kind === "crown" ? "Crown: " + (ch.from || "none") + " → " + ch.to
      : ch.kind === "level" ? "Level " + ch.from + " → " + ch.to
        : ch.kind === "spec" ? "Spec fields changed: " + (ch.fields || []).join(", ")
          : ch.kind === "kings" ? "Kings list changed"
            : ch.kind === "head" ? (ch.repo + " moved: " + (ch.message || ""))
              : ch.kind === "model" ? (ch.repo + " updated")
                : ch.kind === "branch" ? (ch.repo + ": branch " + ch.branch + " " + ch.change)
                  : ch.kind === "gate" ? ("Level gate (" + ch.branch + "): max level " + ch.from + " → " + ch.to)
                    : ch.kind === "gate-factors" ? ("Level gate (" + ch.branch + "): factors changed" + (ch.added ? ", new: " + Object.keys(ch.added).join(", ") : ""))
                      : ch.kind === "level-config" ? ("Benchmark (" + ch.branch + "): new level config " + (ch.added || []).join(", "))
                        : ch.kind === "spec-branch" ? ("Orchestrator branch " + ch.branch + ": spec level " + ((ch.spec || {}).level))
                          : ch.kind === "docs" ? ("Docs: Vector is at level " + ch.level + ", next: " + ch.next)
                            : ch.kind === "repo" ? ("New public repository: " + ch.name) : JSON.stringify(ch);
    const w = (CROWN && CROWN.watch) || {};
    const gate = (w.gate && w.gate.vector) || {};
    const brRows = [];
    Object.keys(w.branches || {}).forEach((repo) => Object.keys(w.branches[repo] || {}).forEach((b) => {
      const sp = repo === "vector-orchestrator" ? (w.spec_branches || {})[b] : null;
      brRows.push(h("tr", null, h("td", { text: repo }), h("td", { text: b }), h("td", { class: "mono", text: String(w.branches[repo][b]).slice(0, 10) }),
        h("td", { text: sp ? "spec level " + sp.level + " · " + sp.tasks + " tasks · step ratio " + sp.step_ratio + " · margin " + sp.margin : "" })));
    }));
    const watchBody = CROWN && CROWN.watch ? h("div", null,
      h("div", { class: "kv" },
        h("span", { class: "k", text: "Level gate" }), h("span", { text: "max level " + gateMax(CROWN) + " · configs " + ((gate.level_configs || []).join(", ") || "—") }),
        h("span", { class: "k", text: "Factors" }), h("span", null, Object.keys(gate.factors || {}).map((f) => h("span", { class: "tag", text: f + " L" + gate.factors[f] }))),
        h("span", { class: "k", text: "Docs" }), h("span", { text: "Vector is at level " + ((w.docs || {}).level || "—") + " · next: " + ((w.docs || {}).next || "—") }),
        h("span", { class: "k", text: "Checked" }), h("span", { text: ago(CROWN.checked_at) + " by the " + (CROWN.checked_by || "watch") + " watch" + ((w.errors || []).length ? " · could not read: " + w.errors.join(", ") : "") })),
      h("div", { class: "tablewrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Repository", "Branch", "Head", "Spec on that branch"].map((t) => h("th", { text: t })))),
        h("tbody", null, brRows))))
      : h("div", { class: "empty", text: "The level watch has not reported yet." });
    return h("div", null,
      h("div", { class: "grid2" }, panel("The four paid kings", "newest first; weights public in robotensor/vector-kings", h("div", { class: "tablewrap" }, kings)),
        panel("Spec", "vector-orchestrator spec.json", spec)),
      panel("Level watch", "what would announce the next level: branches, the benchmark's level gate, the docs", watchBody),
      panel("Pinned repositories", "a move means re-pin and re-baseline", h("div", { class: "tablewrap" }, heads)),
      panel("Timeline", "crown, level, spec and repo changes", evList.length
        ? h("div", { class: "tablewrap" }, h("table", null, h("tbody", null, evList.map((e) => h("tr", null, h("td", { class: "mono", text: String(e.at || "").replace("T", " ").replace("Z", "Z") }), h("td", { text: describe(e.ch) }))))))
        : h("div", { class: "empty", text: "No changes recorded yet." })));
  }

  // ------------------------------------------------------------------------------------------ journal / notes
  function journalTab() {
    const col = (sess, title) => {
      const days = (STATE.journal || {})[sess] || [];
      return panel(title, "last 14 days", days.length ? h("div", null, days.map((d) => mdBox(d.text))) : h("div", { class: "empty", text: "No entries." }));
    };
    return h("div", { class: "journal" }, col("A", "Session A — researcher"), col("B", "Session B — engineer"));
  }
  function notesTab() {
    const notes = STATE.notes || [];
    const props = STATE.proposals || [];
    return h("div", null,
      props.length ? panel("Proposals from B", "", h("div", null, props.map((p) => h("div", null, h("h3", { text: p.id + " — " + (p.title || "") }), mdBox(p.body))))) : null,
      notes.length ? notes.map((n) => panel(n.name, "ledger/notes", mdBox(n.text))) : panel("Notes", "", h("div", { class: "empty", text: "No notes yet." })));
  }

  // ------------------------------------------------------------------------------------------ charts
  // Placeholders are drawn after insertion so they can use their real pixel width (text stays 12px on phones).
  function chartBox(kind, data) {
    const id = kind + ":" + (data && data.v ? "v" : "rows");
    const holder = h("div", { class: "chart" });
    holder.__chart = { kind, data };
    const tableOn = !!UI.tables[kind];
    const toggle = h("button", { class: "btn small", type: "button", "aria-pressed": tableOn ? "true" : "false", text: tableOn ? "Chart view" : "Table view",
      onclick: () => { UI.tables[kind] = !UI.tables[kind]; render(); } });
    return h("div", { "data-chart-id": id }, h("div", { style: null, class: "legend-row" }, toggle), holder);
  }
  function drawCharts() {
    document.querySelectorAll(".chart").forEach((holder) => {
      const spec = holder.__chart;
      if (!spec) return;
      holder.replaceChildren();
      const W = Math.max(280, Math.floor(holder.clientWidth || 600));
      if (UI.tables[spec.kind]) { holder.append(spec.kind === "delta" ? deltaTable(spec.data.rows) : dumbbellTable(spec.data.v)); return; }
      if (spec.kind === "delta") deltaChart(holder, W, spec.data.rows);
      else dumbbellChart(holder, W, spec.data.v);
    });
  }
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1;
    const raw = span / Math.max(n, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 0.5) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  function tipLayer(holder) {
    const tip = h("div", { class: "tip", role: "tooltip" });
    holder.append(tip);
    return {
      show(x, y, title, rows) {
        tip.replaceChildren(h("div", { class: "h", text: title }), ...rows.map((r) => h("div", { class: "r" },
          h("span", { class: "key" }, r.color ? h("i", { style: null }) : null, r.label), h("b", { text: r.value }))));
        // colour the line keys after creation (no inline style attribute in CSP-strict markup)
        const keys = tip.querySelectorAll(".key i");
        let k = 0;
        rows.forEach((r) => { if (r.color) { keys[k].style.background = r.color; k++; } });
        tip.style.display = "block";
        const tw = tip.offsetWidth, th = tip.offsetHeight, W = holder.clientWidth;
        let left = x + 14, top = y - th / 2;
        if (left + tw > W) left = Math.max(0, x - tw - 14);
        if (top < 0) top = 0;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
      },
      hide() { tip.style.display = "none"; },
    };
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function bindHit(rect, tip, holder, fn) {
    const show = (ev) => {
      const box = holder.getBoundingClientRect();
      let x, y;
      if (ev && ev.clientX !== undefined) { x = ev.clientX - box.left; y = ev.clientY - box.top; }
      else { const rb = rect.getBoundingClientRect(); x = rb.left - box.left + rb.width / 2; y = rb.top - box.top + rb.height / 2; }
      rect.classList.add("on");
      fn(x, y);
    };
    const hide = () => { rect.classList.remove("on"); tip.hide(); };
    rect.addEventListener("pointermove", show);
    rect.addEventListener("pointerleave", hide);
    rect.addEventListener("focus", show);
    rect.addEventListener("blur", hide);
  }

  function deltaChart(holder, W, rows) {
    if (!rows || !rows.length) { holder.append(h("div", { class: "empty", text: "No verdicts yet — calibration (R-0001…R-0006) runs first." })); return; }
    const items = rows.slice(-40);
    const margin = (STATE.config && STATE.config.verdict && STATE.config.verdict.margin_points) || 3;
    const H = 300, m = { l: 40, r: 58, t: 12, b: 40 };
    let lo = -5, hi = margin + 3;
    items.forEach((d) => { const c = d.ci || [d.delta, d.delta]; lo = Math.min(lo, c[0], d.delta); hi = Math.max(hi, c[1], d.delta); });
    const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const y = (v) => m.t + ((hi - v) / (hi - lo)) * ih;
    const step = iw / items.length;
    const x = (i) => m.l + step * (i + 0.5);
    const svgEl = s("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Verdict deltas against the king with 90% confidence intervals" });
    niceTicks(lo, hi, 5).forEach((t) => {
      svgEl.append(s("line", { class: t === 0 ? "base" : "gridline", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      svgEl.append(s("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, (t > 0 ? "+" : t < 0 ? "−" : "") + Math.abs(t)));
    });
    if (lo < 0 && hi > 0) svgEl.append(s("line", { class: "base", x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
    svgEl.append(s("line", { class: "ref", x1: m.l, x2: W - m.r, y1: y(margin), y2: y(margin) }));
    svgEl.append(s("text", { class: "lab", x: W - m.r + 6, y: y(margin) - 2 }, "margin"));
    svgEl.append(s("text", { class: "lab", x: W - m.r + 6, y: y(margin) + 12 }, "+" + margin + " pts"));
    const accent = cssVar("--accent"), surface = cssVar("--surface-1");
    const every = Math.max(1, Math.ceil(items.length / Math.max(1, Math.floor(iw / 56))));
    const tip = tipLayer(holder);
    items.forEach((d, i) => {
      const c = d.ci || [d.delta, d.delta];
      svgEl.append(s("line", { x1: x(i), x2: x(i), y1: y(c[0]), y2: y(c[1]), stroke: accent, "stroke-width": 2, "stroke-linecap": "round", opacity: d.current ? 1 : 0.45 }));
      svgEl.append(s("circle", { cx: x(i), cy: y(d.delta), r: 5, fill: accent, stroke: surface, "stroke-width": 2, opacity: d.current ? 1 : 0.45 }));
      if (i % every === 0 || i === items.length - 1) svgEl.append(s("text", { x: x(i), y: H - m.b + 16, "text-anchor": "middle" }, d.id.replace("E-", "")));
    });
    svgEl.append(s("text", { x: m.l, y: H - 6 }, "experiment"));
    const best = bestRow(items);
    if (best) {
      const i = items.indexOf(best);
      svgEl.append(s("text", { class: "strong", x: x(i) + 9, y: y(best.delta) - 8 }, pts(best.delta)));
    }
    items.forEach((d, i) => {
      const hw = Math.max(24, step);
      const r = s("rect", { class: "hit", x: x(i) - hw / 2, y: m.t, width: hw, height: ih, tabindex: 0, role: "button",
        "aria-label": d.id + " delta " + pts(d.delta) + " points, verdict " + d.cls });
      bindHit(r, tip, holder, (px, py) => tip.show(px, py, d.id + " · " + d.method + " · " + d.cls, [
        { label: "Δ vs king", value: pts(d.delta, 2) + " pts", color: accent },
        { label: "90% CI", value: d.ci ? "[" + pts(d.ci[0]) + ", " + pts(d.ci[1]) + "]" : "—" },
        { label: "P(win duel)", value: pct(d.pwin) },
        { label: "Units / tier", value: (d.n || "—") + " / " + (d.tier || "—") },
        { label: "King", value: d.current ? "current" : "previous" },
      ]));
      r.addEventListener("click", () => { UI.exp = d.id; UI.tab = "experiments"; render(); });
      svgEl.append(r);
    });
    holder.prepend(svgEl);
  }
  function deltaTable(rows) {
    if (!rows || !rows.length) return h("div", { class: "empty", text: "No verdicts yet." });
    return h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Experiment", "Method", "Verdict", "Δ pts", "90% CI", "P(win)", "n"].map((t, i) => h("th", { class: i >= 3 ? "num" : null, text: t })))),
      h("tbody", null, rows.slice().reverse().map((d) => h("tr", null, h("td", { class: "mono", text: d.id }), h("td", { class: "mono", text: d.method }),
        h("td", null, chip(String(d.cls).toLowerCase())), h("td", { class: "num", text: pts(d.delta) }),
        h("td", { class: "num", text: d.ci ? "[" + pts(d.ci[0]) + ", " + pts(d.ci[1]) + "]" : "—" }), h("td", { class: "num", text: pct(d.pwin) }),
        h("td", { class: "num", text: String(d.n || "—") }))))));
  }
  function dumbbellRows(v) {
    return Object.keys((v && v.per_task) || {}).map((t) => {
      const r = v.per_task[t];
      return { task: t, king: r.king, cand: r.candidate, n: r.n, c_only: r.c_only, k_only: r.k_only, d: r.candidate - r.king };
    }).sort((a, b) => b.d - a.d || a.task.localeCompare(b.task));
  }
  function dumbbellChart(holder, W, v) {
    const rows = dumbbellRows(v);
    if (!rows.length) { holder.append(h("div", { class: "empty", text: "No per-task results yet." })); return; }
    const kingC = cssVar("--king"), candC = cssVar("--cand"), surface = cssVar("--surface-1");
    holder.append(h("div", { class: "legend" },
      h("span", null, h("span", { class: "sw", style: null, "data-c": "king" }), "King"),
      h("span", null, h("span", { class: "sw", style: null, "data-c": "cand" }), "Candidate")));
    holder.querySelector('[data-c="king"]').style.background = kingC;
    holder.querySelector('[data-c="cand"]').style.background = candC;
    const rowH = 26, labW = Math.min(150, Math.round(W * 0.4)), m = { l: labW, r: 44, t: 6, b: 26 };
    const H = m.t + rows.length * rowH + m.b;
    const iw = W - m.l - m.r;
    const x = (p) => m.l + p * iw;
    const svgEl = s("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Per-task success, candidate versus king" });
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
      svgEl.append(s("line", { class: t === 0 ? "base" : "gridline", x1: x(t), x2: x(t), y1: m.t, y2: H - m.b }));
      svgEl.append(s("text", { x: x(t), y: H - m.b + 16, "text-anchor": "middle" }, Math.round(t * 100) + "%"));
    });
    const tip = tipLayer(holder);
    rows.forEach((r, i) => {
      const cy = m.t + i * rowH + rowH / 2;
      svgEl.append(s("text", { class: "lab", x: m.l - 10, y: cy + 4, "text-anchor": "end" }, shortTask(r.task)));
      svgEl.append(s("line", { x1: x(r.king), x2: x(r.cand), y1: cy, y2: cy, stroke: cssVar("--baseline"), "stroke-width": 2, "stroke-linecap": "round" }));
      svgEl.append(s("circle", { cx: x(r.king), cy, r: 5, fill: kingC, stroke: surface, "stroke-width": 2 }));
      svgEl.append(s("circle", { cx: x(r.cand), cy, r: 5, fill: candC, stroke: surface, "stroke-width": 2 }));
      if (i === 0 || i === rows.length - 1) {
        svgEl.append(s("text", { class: "strong", x: W - m.r + 6, y: cy + 4 }, pts(r.d * 100, 0)));
      }
      const hit = s("rect", { class: "hit", x: 0, y: cy - rowH / 2, width: W, height: rowH, tabindex: 0, role: "button",
        "aria-label": r.task + ": candidate " + pct(r.cand) + ", king " + pct(r.king) });
      bindHit(hit, tip, holder, (px, py) => tip.show(px, py, r.task, [
        { label: "Candidate", value: pct(r.cand), color: candC },
        { label: "King", value: pct(r.king), color: kingC },
        { label: "Δ", value: pts(r.d * 100, 1) + " pts" },
        { label: "Units", value: String(r.n) },
        { label: "Only candidate / only king", value: r.c_only + " / " + r.k_only },
      ]));
      svgEl.append(hit);
    });
    holder.insertBefore(svgEl, holder.querySelector(".tip"));
  }
  function dumbbellTable(v) {
    const rows = dumbbellRows(v);
    if (!rows.length) return h("div", { class: "empty", text: "No per-task results yet." });
    return h("div", { class: "tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Task", "Candidate", "King", "Δ pts", "Units", "Only cand.", "Only king"].map((t, i) => h("th", { class: i ? "num" : null, text: t })))),
      h("tbody", null, rows.map((r) => h("tr", null, h("td", { text: r.task }), h("td", { class: "num", text: pct(r.cand) }), h("td", { class: "num", text: pct(r.king) }),
        h("td", { class: "num", text: pts(r.d * 100) }), h("td", { class: "num", text: String(r.n) }), h("td", { class: "num", text: String(r.c_only) }), h("td", { class: "num", text: String(r.k_only) }))))));
  }

  boot();
})();
