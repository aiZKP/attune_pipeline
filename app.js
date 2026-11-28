/* Vector V2 (Bin picking) dashboard: decrypts the lab's state and the live feed in the browser and renders them.
   Data: raw.githubusercontent.com/aiZKP/attune_pipeline/data/state.enc.json (the lab's state, on every publish) and
   signals.enc.json (the live feed, every minute, read through the GitHub API). ?src=local reads ./data/ instead.
   Every string from the data is inserted with textContent. */
"use strict";
(function () {
  const params = new URLSearchParams(location.search);
  const CONF = {
    dataBase: params.get("src") === "local" ? "./data/" : "https://raw.githubusercontent.com/aiZKP/attune_pipeline/data/",
    signalsApi: "https://api.github.com/repos/aiZKP/attune_pipeline/contents/signals.enc.json?ref=data",
    stateMs: 60000, signalsMs: 20000, keyStore: "attune.key.v1",
  };

  // ------------------------------------------------------------------------------------------ utils
  const $ = (sel, r) => (r || document).querySelector(sel);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function h(tag, props) {
    const e = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
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
  const fmtInt = (n) => (isNum(n) ? n.toLocaleString("en-US") : "—");
  const pct1 = (x) => (isNum(x) ? (100 * x).toFixed(1) + "%" : "—");
  const score3 = (x) => (isNum(x) ? x.toFixed(3) : "—");
  const b64d = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  function b64e(u8) { let o = ""; u8.forEach((b) => { o += String.fromCharCode(b); }); return btoa(o); }
  function ago(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return "—";
    const sec = Math.max(0, (Date.now() - t) / 1000);
    if (sec < 90) return Math.round(sec) + " s ago";
    if (sec < 5400) return Math.round(sec / 60) + " min ago";
    if (sec < 172800) return Math.round(sec / 3600) + " h ago";
    return Math.round(sec / 86400) + " days ago";
  }
  function until(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms)) return "—";
    if (ms <= 0) return "ended";
    const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60);
    return d > 0 ? d + " d " + hh + " h" : hh > 0 ? hh + " h " + (m % 60) + " min" : m + " min";
  }
  function when(iso) {
    const t = Date.parse(iso);
    return isFinite(t) ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : String(iso || "—");
  }
  const owner = (image) => String(image || "").replace(/^ghcr\.io\//, "").split("@")[0];

  // ------------------------------------------------------------------------------------------ crypto and data
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
  async function getSignalsBlob() {
    if (params.get("src") !== "local") {
      try {
        const r = await fetch(CONF.signalsApi, { cache: "no-cache", headers: { Accept: "application/vnd.github.raw+json" } });
        if (r.ok) return [await r.json(), "live"];
      } catch (e) { /* the delayed copy below */ }
    }
    return [await getJSON("signals.enc.json"), "delayed"];
  }

  let BLOB = null, STATE = null, RAW = null, SIG = null, SIG_CT = null, SIG_SRC = "", SIG_ERR = "", sigBusy = false, stateBusy = false;
  const UI = { tab: store.get("attune.v2.tab") || "overview", filter: "all", open: {} };
  const keyName = () => CONF.keyStore + ":" + (BLOB ? BLOB.salt : "");
  const V2 = () => (SIG && SIG.v2) || {};
  const roundNow = () => { const v = V2(), bp = (STATE && STATE.binpick) || {}; return (v.round && v.round.n) || bp.round || 1; };
  // The best entries of the running round. The feed says which round its list is for (top_round); a list without it is round 1's.
  function topNow() {
    const v = V2(), rn = roundNow();
    if (v.top_round === undefined || v.top_round === null) return rn >= 2 ? [] : (v.top || []);
    return v.top_round === rn ? (v.top || []) : [];
  }
  function bestR2() { const l = ((STATE && STATE.binpick) || {}).levels2 || []; return l.length ? l[l.length - 1] : null; }

  // ------------------------------------------------------------------------------------------ small pieces
  const CHIPS = {
    kept: ["good", "✓", "Kept"], banned: ["critical", "⊘", "Banned"], running: ["info", "▶", "Running"],
    queued: ["neutral", "•", "Queued"], research: ["neutral", "✎", "Research"], invalid: ["serious", "!", "Invalid"],
    tested: ["neutral", "◦", "Tested"], replaced: ["neutral", "–", "Replaced"], used: ["good", "✓", "Used"],
    parked: ["neutral", "■", "Parked"], open: ["info", "?", "Open"], "dead end": ["critical", "✕", "Dead end"],
    ready: ["good", "✓", "Ready"], planned: ["neutral", "•", "Planned"],
  };
  function chip(state, label) {
    const c = CHIPS[state] || ["neutral", "•", state || "—"];
    return h("span", { class: "chip " + c[0] }, h("span", { class: "ico", "aria-hidden": "true", text: c[1] }), label || c[2]);
  }
  function panel(title, sub) {
    const p = h("section", { class: "panel" }, h("h2", { text: title }), sub ? h("p", { class: "sub", text: sub }) : null);
    for (let i = 2; i < arguments.length; i++) append(p, arguments[i]);
    return p;
  }
  function table(heads, rows) {
    const t = h("table", null, h("thead", null, h("tr", null, heads.map((x) => h("th", { class: x.num ? "num" : null, text: x.t || x })))));
    const tb = h("tbody");
    rows.forEach((r) => tb.append(r instanceof Node ? r : h("tr", null, r.map((c, i) => (c instanceof Node && c.tagName === "TD" ? c : h("td", { class: heads[i] && heads[i].num ? "num" : null }, c))))));
    t.append(tb);
    return h("div", { class: "tablewrap" }, t);
  }
  const methodState = (m) => (m.measured && m.measured.verdict) || m.state || "queued";
  function sixSets(m) {
    const sets = (m.measured && m.measured.sets) || [];
    return sets.find((x) => /six sets/i.test(x.name || "")) || sets.find((x) => (x.n || 0) >= 2000) || null;
  }
  function bestPoint() {
    const sc = (STATE && STATE.scores) || [];
    return sc.length ? sc[sc.length - 1] : null;
  }

  // ------------------------------------------------------------------------------------------ header and KPIs
  function renderStatus() {
    const box = $("#status");
    if (!box) return;
    if (!RAW) { box.replaceChildren(); return; }
    const t = SIG ? Date.parse(SIG.generated) : NaN, age = (Date.now() - t) / 1000;
    const cls = !SIG ? "down" : age < 240 && SIG_SRC === "live" ? "live" : age < 900 ? "late" : "down";
    const txt = !SIG ? "live feed: " + (SIG_ERR || "loading…") : "live feed " + ago(SIG.generated) + (SIG_SRC === "live" ? "" : " (delayed copy)");
    box.replaceChildren(h("span", { class: "dot " + cls, "aria-hidden": "true" }), txt);
    $("#updated").textContent = STATE ? "lab state " + ago(STATE.generated) : "";
  }
  function kpi(label, value, detail, accent) {
    return h("div", { class: "kpi" + (accent ? " accent" : "") }, h("div", { class: "k", text: label }), h("div", { class: "v", text: value }), h("div", { class: "d", text: detail || "" }));
  }
  function renderKpis() {
    const bp = STATE.binpick || {}, v = V2(), top = topNow(), best = bestPoint(), pl = STATE.pipeline || {}, en = pl.entry || {};
    const ends = (v.round && v.round.ends) || bp.round_ends, rn = roundNow();
    const third = top[2], lead = top[0];
    if (rn >= 2) {
      const b2 = bestR2();
      return h("div", { class: "kpis" },
        kpi("Our round-" + rn + " score", b2 ? score3(b2.score) : "—", b2 ? b2.name + " · mean of " + fmtInt(b2.picks) + " picks" : (bp.r2_status || "not measured yet"), true),
        kpi("Goal", "Top 3", "of round " + rn + ": no king and no bar yet"),
        kpi("Leader", lead ? score3(lead[1]) : "—", lead ? owner(lead[4]) + " · UID " + lead[0] : "no entry in round " + rn + " yet"),
        kpi("Third place", third ? score3(third[1]) : "—", third ? "a place needs more than this" : "still open"),
        kpi("Round " + rn + " ends in", until(ends), ends ? when(ends) : ""),
        kpi("Our entry", en.uid ? "UID " + en.uid : "—", en.fee_paid ? "fee paid" : "registered · not entered · fee " + (en.fee_tao || 0.1) + " TAO"));
    }
    return h("div", { class: "kpis" },
      kpi("Our best version", best ? pct1(best.solved / best.of) : "—", best ? (pl.best || best.name) + " · " + best.solved + " of " + best.of + " fresh scenes" : "no measurement yet", true),
      kpi("Goal", isNum(bp.goal) ? pct1(bp.goal) : "—", "every scene solved"),
      kpi("Leader", lead ? score3(lead[1]) : "—", lead ? owner(lead[4]) + " · UID " + lead[0] : "board not read yet"),
      kpi("Third place", third ? score3(third[1]) : "—", third ? "a place needs more than this" : ""),
      kpi("Round " + ((v.round && v.round.n) || 1) + " ends in", until(ends), ends ? when(ends) : ""),
      kpi("Our entry", en.uid ? "UID " + en.uid : "—", en.fee_paid ? "fee paid" : "registered · not entered · fee " + (en.fee_tao || 0.1) + " TAO"));
  }

  // ------------------------------------------------------------------------------------------ overview
  function renderPipeline() {
    const pl = STATE.pipeline || {}, stages = pl.stages || [];
    const idx = stages.findIndex((x) => x.id === pl.stage);
    const running = ((STATE.binpick || {}).methods || []).filter((m) => methodState(m) === "running");
    return panel("Pipeline: cycle " + (pl.cycle || "—"), pl.rule_line || ("Best version " + (pl.best || "—") + ". One method at a time: kept only if it gains at least twice its noise on 6,000 scenes."),
      h("ol", { class: "stages" }, stages.map((st, i) => h("li", { class: "stage" + (i < idx ? " done" : i === idx ? " now" : ""), title: st.what || "" },
        h("div", { class: "n", text: st.name }), h("div", { class: "w", text: st.who || "" })))),
      h("div", { class: "note", text: pl.note || "" }),
      running.length ? h("div", { class: "note" }, "Running now: ", running.map((m) => m.id).join(", ")) : null);
  }
  function renderMachines() {
    const ms = (V2().machines || {}), list = ms.machines || [];
    if (!list.length) return panel("Computers", "Three 32-core machines", h("div", { class: "empty", text: "No machine status yet." }));
    return panel("Computers", "Three 32-core machines · checked " + ago(ms.at),
      h("div", { class: "grid three" }, list.map((m) => {
        if (!m.reachable) return h("div", { class: "machine" }, h("div", { class: "name", text: m.name }), h("div", { class: "role", text: m.role || "" }), chip("invalid", "Not reachable"));
        const busy = Math.round(100 * (m.busy || 0));
        return h("div", { class: "machine" },
          h("div", { class: "name" }, m.name, " ", busy >= 15 ? chip("running", "Working") : chip("neutral", "Idle")),
          h("div", { class: "role", text: m.role || "" }),
          h("div", { class: "meter", role: "img", "aria-label": "Load " + busy + " percent" }, h("span", { style: null, "data-w": busy })),
          h("div", { class: "row" }, h("span", { text: "load " + busy + "% of " + m.cores + " cores" }), h("span", { text: (m.mem_used_gb || 0) + " / " + Math.round(m.mem_total_gb || 0) + " GB" })),
          h("div", { class: "doing", text: m.doing || "idle" }));
      })));
  }
  function applyMeters(root) { root.querySelectorAll(".meter > span").forEach((e) => { e.style.width = Math.max(1, Math.min(100, +e.getAttribute("data-w") || 0)) + "%"; }); }

  function scoreChart() {
    const pts = ((STATE && STATE.scores) || []).filter((p) => isNum(p.solved) && isNum(p.of) && p.of > 0);
    if (pts.length < 2) return h("div", { class: "empty", text: "Not enough measurements for a chart yet." });
    const v = V2(), top = v.top || [], third = top[2] ? top[2][1] : (STATE.binpick || {}).rank_line;
    const W = 760, H = 270, L = 44, R = 118, T = 22, B = 44;
    const vals = pts.map((p) => 100 * p.solved / p.of);
    const lo = Math.min(Math.floor(Math.min.apply(null, vals)) - 1, 93), hi = 100;
    const x = (i) => L + (pts.length === 1 ? 0 : (i * (W - L - R)) / (pts.length - 1));
    const y = (val) => T + ((hi - val) * (H - T - B)) / (hi - lo);
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Share of fresh scenes solved by each measured version" });
    for (let g = Math.ceil(lo); g <= hi; g += (hi - lo > 5 ? 2 : 1)) {
      svg.append(s("line", { class: "gridline", x1: L, x2: W - R, y1: y(g), y2: y(g) }));
      svg.append(s("text", { x: L - 6, y: y(g) + 4, "text-anchor": "end" }, g + "%"));
    }
    const refs = [[100, "goal 100%"]];
    if (isNum(third) && third < 1) refs.push([100 * third, "third place " + (100 * third).toFixed(1) + "%"]);
    refs.forEach((r, i) => {
      svg.append(s("line", { class: "ref", x1: L, x2: W - R, y1: y(r[0]), y2: y(r[0]) }));
      svg.append(s("text", { x: W - R + 6, y: y(r[0]) + (i ? 13 : -3) }, r[1]));
    });
    svg.append(s("path", { class: "line", d: pts.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(vals[i]).toFixed(1)).join(" ") }));
    // the best point is labelled only when it is far enough from the last one for both labels to fit
    const bestI = vals.indexOf(Math.max.apply(null, vals)), labelAt = new Set([0, pts.length - 1]);
    if (pts.length - 1 - bestI > 2 && bestI > 1) labelAt.add(bestI);
    const every = pts.length > 14 ? 2 : 1;
    const box = h("div", { class: "chartbox" }), tip = h("div", { class: "tip", hidden: true });
    pts.forEach((p, i) => {
      svg.append(s("circle", { class: "pt", cx: x(i), cy: y(vals[i]), r: 4.5 }));
      if (labelAt.has(i)) svg.append(s("text", { class: "lab", x: x(i), y: y(vals[i]) - 10, "text-anchor": i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle" }, vals[i].toFixed(1) + "%"));
      if (i % every === 0 || i === pts.length - 1) svg.append(s("text", { x: x(i), y: H - B + 16, "text-anchor": "middle" }, String(p.name)));
      const hit = s("rect", { class: "hit", x: x(i) - 16, y: T, width: 32, height: H - T - B, tabindex: 0, "aria-label": p.name + ": " + p.solved + " of " + p.of });
      const show = () => {
        tip.replaceChildren(h("div", null, h("strong", { text: String(p.name) })), h("div", { text: p.solved + " of " + p.of + " solved (" + vals[i].toFixed(1) + "%)" }),
          h("div", { class: "meta", text: "fresh set " + (p.set || "—") + (isNum(p.paired) ? " · the version before: " + p.paired : "") }));
        tip.hidden = false;
        const bw = box.clientWidth || W, px = (x(i) / W) * bw;
        tip.style.left = Math.max(0, Math.min(bw - 240, px + 10)) + "px";
        tip.style.top = Math.max(0, (y(vals[i]) / H) * (box.clientHeight || H) - 10) + "px";
      };
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", () => { tip.hidden = true; }); hit.addEventListener("blur", () => { tip.hidden = true; });
      svg.append(hit);
    });
    svg.append(s("text", { x: L, y: H - 6 }, "versions in the order they were measured; each on a fresh set of 1,000 scenes never used to choose"));
    box.append(h("div", { class: "chart" }, svg), tip);
    return box;
  }
  function alertItem(a) {
    const key = /KEY|BOARD|ACTIVE|PUBLIC|MAINNET/.test(a.text || "");
    return h("li", { class: key ? "key" : null }, h("span", { class: "t", text: when(a.at) }), String(a.text || "").slice(0, 420));
  }
  function renderTask() {
    const t = (STATE.binpick || {}).task2;
    if (!t || roundNow() < 2) return null;
    return panel(t.title || "Round 2: the task", t.sub || "",
      table(["", "Round 1 (closed)", "Round 2 (running)"], (t.rows || []).map((r) => [h("strong", { text: r[0] }), r[1], r[2]])),
      t.note ? h("p", { class: "note", text: t.note }) : null);
  }
  function r2Versions() {
    const l = (STATE.binpick || {}).levels2 || [];
    if (!l.length) return null;
    return panel("Round 2: our measured versions", "Mean pick score on fresh pile scenes (1.0 would be every target picked at once)",
      table(["Version", { t: "Score", num: true }, { t: "Picks", num: true }, { t: "Picked", num: true }, { t: "Mean robot time", num: true }, { t: "Parts out", num: true }, "Note"],
        l.slice().reverse().map((x) => [x.name, h("td", { class: "num", text: score3(x.score) }), h("td", { class: "num", text: fmtInt(x.picks) }), h("td", { class: "num", text: isNum(x.picked) ? pct1(x.picked) : "—" }),
          h("td", { class: "num", text: isNum(x.time_s) ? x.time_s.toFixed(2) + " s" : "—" }), h("td", { class: "num", text: isNum(x.outs) ? String(x.outs) : "—" }), x.note || ""])));
  }
  function renderOverview() {
    const v = V2(), alerts = (v.alerts || (SIG && SIG.alerts) || []).slice().reverse();
    const team = ((v.discord || {}).team || []).slice().reverse();
    const r2 = roundNow() >= 2;
    return [
      renderTask(), r2Versions(),
      h("div", { class: "grid two" }, renderPipeline(),
        panel("Latest from the organisers", "Their messages in the SN58 channel",
          team.length ? h("ul", { class: "feed" }, team.slice(0, 2).map((m) => h("li", { class: "key" }, h("span", { class: "t", text: m.at }), h("span", { class: "who", text: m.who }), m.text))) : h("div", { class: "empty", text: "Nothing yet." }))),
      renderMachines(),
      h("div", { class: "grid two" },
        panel(r2 ? "Round 1 (closed): score progress" : "Score progress", "Share of fresh scenes solved by each measured version" + (r2 ? "; round 2 is scored differently" : ""), scoreChart()),
        panel("Latest alerts", "From the watches (site, code, chain, Discord)",
          alerts.length ? h("ul", { class: "feed" }, alerts.slice(0, 4).map((a) => alertItem({ at: a.at, text: String(a.text || "").slice(0, 230) + (String(a.text || "").length > 230 ? "…" : "") }))) : h("div", { class: "empty", text: "No alerts." }))),
    ];
  }

  // ------------------------------------------------------------------------------------------ methods
  function renderMethods() {
    const bp = STATE.binpick || {}, r2 = roundNow() >= 2;
    const ms2 = (bp.methods || []).filter((m) => m.round === 2).slice().reverse();
    const ms = (bp.methods || []).filter((m) => (m.round || 1) === 1).slice().reverse();
    const head2 = r2 ? panel("Round 2 methods, newest first", "One method at a time against the base on the same pile scenes; kept only if the mean scene-score gain is at least twice its standard error.",
      ms2.length ? table(["Method", { t: "Cycle", num: true }, "Status", "What it is", "Result"], ms2.map((m) => [h("span", { class: "mono", text: m.id }), h("td", { class: "num", text: m.cycle || "—" }), chip(methodState(m)), m.title || "", m.result || "—"]))
        : h("div", { class: "empty", text: bp.r2_methods_note || "No round-2 method yet." })) : null;
    const counts = {};
    ms.forEach((m) => { const st = methodState(m); counts[st] = (counts[st] || 0) + 1; });
    const order = ["all", "running", "kept", "banned", "invalid", "queued", "research", "tested", "replaced"];
    const filters = h("div", { class: "filters", role: "group", "aria-label": "Filter by status" }, order.filter((k) => k === "all" || counts[k]).map((k) =>
      h("button", { class: "chip", type: "button", "aria-pressed": UI.filter === k ? "true" : "false", onclick: () => { UI.filter = k; render(); } },
        k === "all" ? "All " + ms.length : (CHIPS[k] ? CHIPS[k][2] : k) + " " + counts[k])));
    const rows = [];
    ms.filter((m) => UI.filter === "all" || methodState(m) === UI.filter).forEach((m) => {
      const st = methodState(m), six = sixSets(m), open = !!UI.open[m.id];
      const res = six ? h("span", null, six.before + " → " + six.after + "  (", h("span", { class: "gain", text: "+" + six.gained }), " ", h("span", { class: "loss", text: "−" + six.lost }), ", bar " + six.bar + ")") : (m.result ? String(m.result).slice(0, 90) + (String(m.result).length > 90 ? "…" : "") : "—");
      rows.push(h("tr", { class: "click", tabindex: 0, onclick: () => { UI.open[m.id] = !open; render(); }, onkeydown: (ev) => { if (ev.key === "Enter") { UI.open[m.id] = !open; render(); } } },
        h("td", { class: "mono", text: m.id }), h("td", { class: "num", text: m.cycle || "—" }), h("td", null, chip(st)), h("td", { text: m.title || "" }), h("td", null, res)));
      if (open) {
        const dl = h("dl", { class: "kv" });
        [["Aimed at", m.targets], ["Session A's test", m.a_test], ["Result", m.result], ["Session B's note", m.measured && m.measured.note], ["Measured", m.measured && m.measured.measured_at ? when(m.measured.measured_at) + " against " + (m.measured.base || "the best version") : null]]
          .forEach((kv) => { if (kv[1]) dl.append(h("dt", { text: kv[0] }), h("dd", { text: String(kv[1]) })); });
        rows.push(h("tr", { class: "detail" }, h("td", { colspan: 5 }, dl)));
      }
    });
    return [head2, panel(r2 ? "Round 1 methods (closed), newest first" : "Methods, newest first", "One method at a time against the best version on 6,000 scenes; kept only if gained − lost is at least 2·√(gained + lost). Click a row for the details.", filters,
      table(["Method", { t: "Cycle", num: true }, "Status", "What it is", "On 6,000 scenes: before → after (gained, lost, bar)"], rows))];
  }

  // ------------------------------------------------------------------------------------------ research
  function renderResearch() {
    const r = STATE.research || {}, items = r.items || [];
    return [panel("Research findings, newest first", r.note || "", items.length ? items.map((it) => h("div", { class: "finding" },
      h("div", { class: "head" }, h("span", { class: "mono meta", text: it.id }), h("span", { class: "title", text: it.title }), chip(it.status), h("span", { class: "meta", text: it.date || "" }),
        (it.methods || []).length ? h("span", { class: "meta", text: "→ " + it.methods.join(", ") }) : null),
      h("p", { text: it.finding || "" }))) : h("div", { class: "empty", text: "No findings recorded yet." }))];
  }

  // ------------------------------------------------------------------------------------------ monitoring
  function renderMonitoring() {
    const v = V2(), top = topNow(), counts = v.counts || {}, rules = v.rules || {}, slot = v.slot || {}, vault = v.vault || {}, en = (STATE.pipeline || {}).entry || {};
    const rn = roundNow(), r2 = rn >= 2, bp = STATE.binpick || {}, b2 = bestR2();
    const best = r2 ? null : bestPoint();
    const row = (t, i) => [String(i + 1), owner(t[4]), h("td", { class: "num", text: score3(t[1]) }), h("td", { class: "num", text: fmtInt(t[2]) }), h("td", { class: "num", text: fmtInt(t[3]) }), "UID " + t[0]];
    const boardRows = top.map(row);
    if (r2 && b2) boardRows.push(["—", "ours (" + b2.name + ", measured here, not entered)", h("td", { class: "num", text: score3(b2.score) }), h("td", { class: "num", text: fmtInt(b2.picks) }), h("td", { class: "num", text: "—" }), en.uid ? "UID " + en.uid : ""]);
    const prev = r2 ? (v.top_prev || []) : [];
    if (best) boardRows.push(["—", "ours (" + (((STATE.pipeline || {}).best) || best.name) + ", measured here, not entered)", h("td", { class: "num", text: score3(best.solved / best.of) }), h("td", { class: "num", text: fmtInt(best.of) }), h("td", { class: "num", text: "—" }), en.uid ? "UID " + en.uid : ""]);
    const shares = (rules.rank_shares || []).map((x) => Math.round(100 * x) + "%").join(" / ");
    const kv = (pairs) => { const dl = h("dl", { class: "kv" }); pairs.forEach((p) => { if (p[1] !== null && p[1] !== undefined && p[1] !== "") dl.append(h("dt", { text: p[0] }), h("dd", { text: String(p[1]) })); }); return dl; };
    const disc = v.discord || {}, team = (disc.team || []).slice().reverse(), other = (disc.other || []).slice().reverse();
    const alerts = (v.alerts || (SIG && SIG.alerts) || []).slice().reverse();
    return [
      h("div", { class: "grid two" },
        panel(r2 ? "The board: round " + rn : "The board", "Best entries on the organisers' site" + (v.api_at ? " · read " + ago(v.api_at) : ""), boardRows.length ? table(["#", "Entry", { t: "Score", num: true }, { t: "Scenes", num: true }, { t: "Commit block", num: true }, ""], boardRows) : h("div", { class: "empty", text: r2 ? "No entry in round " + rn + " yet." : "Board not read yet." }),
          r2 && (v.entries || []).length ? h("h3", { text: "Round " + rn + ": every entry so far" }) : null,
          r2 && (v.entries || []).length ? table(["Entry", "Status", { t: "Scenes", num: true }, { t: "Score so far", num: true }, "Committed", ""],
            v.entries.map((e) => [owner(e[1]), String(e[2] || "").replace(/_/g, " "), h("td", { class: "num", text: e[4] ? (e[3] || 0) + " / " + e[4] : "—" }), h("td", { class: "num", text: score3(e[5]) }), when(e[7] + "Z"), "UID " + e[0]])) : null,
          prev.length ? h("h3", { text: "Round " + (rn - 1) + " (closed): best entries still in its final check" }) : null,
          prev.length ? table(["#", "Entry", { t: "Score", num: true }, { t: "Scenes", num: true }, { t: "Commit block", num: true }, ""], prev.map(row)) : null,
          r2 && bp.board_note ? h("p", { class: "note", text: bp.board_note }) : null,
          h("h3", { text: "Round and entries" }),
          kv([["Round", v.round ? v.round.n + " · ends " + when(v.round.ends) + " (in " + until(v.round.ends) + ")" : null], ["Entries scored", counts.scored], ["Being played now", counts.phase1], ["Invalid / unpaid", (counts.invalid || 0) + " / " + (counts.unpaid || 0)], ["Scenes per entry", r2 && bp.sizes2 ? bp.sizes2 : rules.scenes ? rules.scenes + ", then " + rules.phase2_scenes + " re-run on the organisers' side" : null], ["Pay split of the top three", shares], r2 ? ["Final check of round " + (rn - 1), (counts.passed || 0) + " passed, " + (counts.disqualified || 0) + " refused, " + (counts.scored || 0) + " waiting"] : ["Next round's skill (bin-picking-v2)", v.skills && "bin-picking-v2" in v.skills ? (v.skills["bin-picking-v2"] ? "ACTIVE" : "listed, switched off") : null]])),
        panel("Fee and our slot", "What an entry needs",
          kv([["Our UID", slot.uid], ["Registered at block", fmtInt(slot.registered_block)], ["Entry fee", ((v.fee && v.fee.tao) || en.fee_tao || 0.1) + " TAO per entry"], ["Fee paid", en.fee_paid ? "yes" : "not yet"], ["Image pushed", en.image_pushed ? "yes" : "not yet"], ["Candidate", en.candidate], ["Fee vault holds", isNum(vault.tao) ? vault.tao + " TAO (" + Math.round(vault.tao / 0.1) + " fees)" : null], ["Chain head", fmtInt(slot.head)]]),
          en.deadline_note ? h("p", { class: "note", text: en.deadline_note }) : null,
          h("h3", { text: "Newest entries on chain" }),
          h("ul", { class: "feed" }, (v.chain_log || []).slice().reverse().slice(0, 8).map((ln) => h("li", { text: String(ln).replace(/ hotkey .*$/, "") }))))),
      h("div", { class: "grid two" },
        panel("Alerts", "Everything the watches raised, newest first", alerts.length ? h("ul", { class: "feed" }, alerts.slice(0, 30).map(alertItem)) : h("div", { class: "empty", text: "No alerts." })),
        panel("Discord: SN58 channel", "The organisers first, then other miners (their words, unverified)",
          h("ul", { class: "feed" }, team.slice(0, 5).map((m) => h("li", { class: "key" }, h("span", { class: "t", text: m.at }), h("span", { class: "who", text: m.who }), m.text)),
            other.slice(0, 8).map((m) => h("li", null, h("span", { class: "t", text: m.at }), h("span", { class: "who", text: m.who }), m.text))))),
    ];
  }

  // ------------------------------------------------------------------------------------------ verification
  function renderVerification() {
    const vf = STATE.verification;
    if (!vf) return [panel("Verification", "", h("div", { class: "empty", text: "No final record yet." }))];
    const o = vf.ours || {}, lim = vf.limits || {}, dl = vf.deadlines || {}, img = vf.image || {};
    const eq = (x) => (x && isNum(x.equal) ? x.equal + " of " + (x.paired || x.compared) : "—");
    const okEq = (x) => !!x && x.equal === (x.paired || x.compared);
    const det = (vf.determinism_B || {}).determinism || {};
    const mark = (ok, text) => h("span", { class: ok ? "pass" : "fail", text: text });
    const rows = [
      ["Two runs give the same actions", "all equal", mark(okEq(det), eq(det))],
      ["Live path against re-run path", "all equal", mark(okEq(vf.phase1_vs_phase2_hashes_A_C), eq(vf.phase1_vs_phase2_hashes_A_C))],
      ["1 CPU against 4 CPUs", "all equal", mark(okEq(vf.cpus1_vs_cpus4_hashes), eq(vf.cpus1_vs_cpus4_hashes))],
      ["Machine against machine", "all equal", mark(okEq(vf.worker_vs_this_machine_hashes), eq(vf.worker_vs_this_machine_hashes))],
      ["First answer", "10 s (our margin 7 s)", mark(lim.first_act_max_s <= 10, (lim.first_act_max_s || 0).toFixed(2) + " s at most")],
      ["Later answers", "2 s (our margin 1.3 s)", mark(lim.later_act_max_s <= 2, (lim.later_act_max_s || 0).toFixed(2) + " s at most")],
      ["Late or timed-out steps", "none", mark((lim.late_acts || 0) === 0 && (lim.step_timeouts || 0) === 0, (lim.late_acts || 0) + " late, " + (lim.step_timeouts || 0) + " timed out")],
      ["Whole scene, re-run on 4 CPUs", "45 s (our margin 15 s)", mark(lim.phase2_cpus4_wall_max_s <= 45, (lim.phase2_cpus4_wall_max_s || 0).toFixed(1) + " s at most")],
      ["Whole scene on 1 CPU (our own safety check)", "our margin 32 s", mark(lim.phase2_cpus1_wall_max_s <= 45, (lim.phase2_cpus1_wall_max_s || 0).toFixed(1) + " s at most")],
      ["Memory", "8 GB", mark((lim.peak_rss_mb || 0) < 8000, ((lim.peak_rss_mb || 0) / 1000).toFixed(2) + " GB at peak")],
      ["Rehearsed successes confirmed by the harness", "all", mark(o.verdict_check && o.verdict_check.mismatch_count === 0, o.verdict_check ? o.verdict_check.plan_success_harness_success + " of " + o.verdict_check.plan_success : "—")],
    ];
    const cls = o.by_class || {}, outc = o.outcomes || {}, ways = vf.ways_of_success || {};
    return [
      panel(roundNow() >= 2 ? "Round 1's last version: verification" : "Verification of the best version", "Cycle " + vf.cycle + " · image " + (img.tag || "—") + " · final set " + ((vf.set || {}).seed || "—") + ": " + (o.successes || "—") + " of " + ((vf.set || {}).scenes || "—") + " solved" + (o.ci95 ? " (95% " + o.ci95.map((x) => (100 * x).toFixed(1)).join("–") + "%)" : ""),
        table(["Check", "Limit", "Measured"], rows)),
      h("div", { class: "grid two" },
        panel("By kind of scene", "Hardest class that applies", table(["Class", { t: "Solved", num: true }, { t: "Of", num: true }, { t: "Share", num: true }], Object.keys(cls).map((k) => [k, h("td", { class: "num", text: cls[k][0] }), h("td", { class: "num", text: cls[k][1] }), h("td", { class: "num", text: pct1(cls[k][0] / cls[k][1]) })]))),
        panel("How scenes ended, and which pinch won", "", table(["Outcome", { t: "Scenes", num: true }], Object.keys(outc).map((k) => [k.replace(/_/g, " "), h("td", { class: "num", text: outc[k] })])),
          h("h3", { text: "Successes by family" }), table(["Family", { t: "Scenes", num: true }], Object.keys(ways).map((k) => [k.replace(/_/g, " "), h("td", { class: "num", text: ways[k] })])))),
    ];
  }

  // ------------------------------------------------------------------------------------------ round 2
  function renderRound2() {
    const r = STATE.round2;
    if (!r) return [panel("Round 2", "", h("div", { class: "empty", text: "No plan recorded yet." }))];
    const a = r.announcement || {}, v = V2();
    const v2on = v.skills && v.skills["bin-picking-v2"];
    return [
      panel("Round 2: what the organisers said", (a.who || "") + " · " + when(a.at), h("p", { class: "note", text: a.text || "" }),
        h("p", null, roundNow() >= 2 ? chip("running", "Round " + roundNow() + " is running") : chip(v2on ? "running" : "queued", v2on ? "bin-picking-v2 is ACTIVE" : "bin-picking-v2 is listed, not yet active")),
        h("ul", { class: "feed" }, (r.known || []).map((k) => h("li", { text: k })))),
      h("div", { class: "grid two" },
        panel(roundNow() >= 2 ? "Round-2 plan" : "Day-one plan", roundNow() >= 2 ? "In order" : "In order; nothing here waits for us except the organisers' release", table(["Step", "What", "State"], (r.plan || []).map((p) => [p.step, p.detail, chip(/ready/.test(p.state || "") ? "ready" : /waiting/.test(p.state || "") ? "queued" : "planned", p.state)]))),
        panel("Lessons from round 1", "What we change", (r.lessons || []).map((l) => h("div", { class: "finding" }, h("div", { class: "title", text: l.title }), h("p", { text: l.text }))))),
      panel("What we carry over", "", h("ul", { class: "feed" }, (r.assets || []).map((k) => h("li", { text: k })))),
    ];
  }

  // ------------------------------------------------------------------------------------------ render
  const TABS = [["overview", "Overview", renderOverview], ["methods", "Methods", renderMethods], ["research", "Research", renderResearch],
    ["monitoring", "Monitoring", renderMonitoring], ["verification", "Verification", renderVerification], ["round2", "Round 2", renderRound2]];
  function render() {
    if (!STATE) return;
    $("#lock-btn").hidden = false;
    const tab = TABS.find((t) => t[0] === UI.tab) || TABS[0];
    const nm = ((STATE.binpick || {}).methods || []).length, nr = ((STATE.research || {}).items || []).length;
    const nav = h("nav", { class: "tabs", role: "tablist" }, TABS.map((t) => h("button", { type: "button", role: "tab", "aria-selected": t[0] === tab[0] ? "true" : "false",
      onclick: () => { UI.tab = t[0]; store.set("attune.v2.tab", t[0]); render(); } }, t[1], t[0] === "methods" ? h("span", { class: "count", text: nm }) : t[0] === "research" ? h("span", { class: "count", text: nr }) : null)));
    let body;
    try { body = tab[2](); } catch (e) { body = [panel("This view failed to draw", String(e && e.message ? e.message : e))]; }
    const app = $("#app");
    app.replaceChildren(renderKpis(), nav, h("div", { role: "tabpanel" }, body));
    applyMeters(app);
    renderStatus();
    $("#foot").textContent = "Decrypted in your browser. The lab state updates on every publish; the live feed (board, chain, Discord, computers) every minute.";
  }
  function renderLock(msg) {
    $("#lock-btn").hidden = true;
    const input = h("input", { type: "password", autocomplete: "current-password", placeholder: "Passphrase", "aria-label": "Passphrase" });
    const remember = h("input", { type: "checkbox", checked: true });
    const err = h("div", { class: "err", role: "alert", text: msg || "" });
    const btn = h("button", { class: "btn primary", type: "submit", text: "Unlock" });
    const form = h("form", { class: "lock", onsubmit: async (ev) => {
      ev.preventDefault();
      if (!input.value) return;
      btn.disabled = true; err.textContent = "Deriving the key…";
      try {
        const raw = await deriveRaw(input.value, BLOB.salt, BLOB.iter);
        STATE = await decryptBlob(BLOB, raw); RAW = raw;
        if (remember.checked) store.set(keyName(), b64e(raw));
        render(); refreshSignals();
      } catch (e) { err.textContent = "That passphrase does not open this data. Try again."; btn.disabled = false; input.select(); }
    } }, h("h1", { text: "Unlock the dashboard" }), h("p", { text: "The data is encrypted. Enter the passphrase (DASHBOARD_PASSPHRASE in your .env)." }),
      input, h("label", null, remember, "Remember on this device"), btn, err);
    $("#app").replaceChildren(form);
    renderStatus();
    input.focus();
  }

  // ------------------------------------------------------------------------------------------ refresh
  async function refreshState() {
    if (stateBusy || !RAW) return;
    stateBusy = true;
    try {
      const b = await getJSON("state.enc.json");
      if (!BLOB || b.ct !== BLOB.ct) {
        if (BLOB && b.salt !== BLOB.salt) { BLOB = b; STATE = null; RAW = null; renderLock("The key changed; enter the passphrase again."); return; }
        STATE = await decryptBlob(b, RAW); BLOB = b; render();
      } else renderStatus();
    } catch (e) { $("#updated").textContent = "refresh failed: " + e.message; }
    finally { stateBusy = false; }
  }
  async function refreshSignals() {
    if (sigBusy || document.hidden || !RAW || !BLOB) { renderStatus(); return; }
    sigBusy = true;
    try {
      const got = await getSignalsBlob(), b = got[0];
      SIG_SRC = got[1]; SIG_ERR = "";
      if (b.ct !== SIG_CT) {
        if (b.salt !== BLOB.salt) SIG_ERR = "the live feed uses another key";
        else { SIG = await decryptBlob(b, RAW); SIG_CT = b.ct; if (STATE) render(); }
      }
    } catch (e) { SIG_ERR = e.message; }
    finally { sigBusy = false; renderStatus(); }
  }
  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next); store.set("attune.theme", next);
  }
  async function boot() {
    $("#theme-btn").addEventListener("click", toggleTheme);
    $("#lock-btn").addEventListener("click", () => { store.del(keyName()); RAW = null; STATE = null; SIG = null; SIG_CT = null; renderLock(); });
    try { BLOB = await getJSON("state.enc.json"); }
    catch (e) { $("#app").replaceChildren(h("section", { class: "panel" }, h("div", { class: "empty", text: "No dashboard data published yet (" + e.message + ")." }))); return; }
    const saved = store.get(keyName());
    if (saved) { try { RAW = b64d(saved); STATE = await decryptBlob(BLOB, RAW); } catch (e) { store.del(keyName()); RAW = null; STATE = null; } }
    if (STATE) render(); else renderLock();
    setInterval(refreshState, CONF.stateMs);
    setInterval(refreshSignals, CONF.signalsMs);
    setInterval(() => { if (STATE && UI.tab === "overview") renderStatus(); }, 5000);
    refreshSignals();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshState(); refreshSignals(); } });
  }
  if (typeof window !== "undefined" && window.__ATTUNE_TEST__) window.__ATTUNE_TEST__({ setState: (st, sig) => { STATE = st; SIG = sig; RAW = new Uint8Array(1); BLOB = { salt: "x" }; SIG_SRC = "live"; }, render, setTab: (t) => { UI.tab = t; }, openAll: () => { ((STATE.binpick || {}).methods || []).forEach((m) => { UI.open[m.id] = true; }); } });
  else boot();
})();
