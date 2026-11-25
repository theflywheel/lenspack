// Loaded on every Superset page by one script tag in Superset's
// tail_js_custom_extra.html (a template Superset documents as overridable).
// On a dashboard it adds an "Ask Lenspack" button; the chat edits that
// dashboard through the Lenspack server, and the dashboard is re-read in
// place to show it (no page reload; see refreshInPlace).
// The chat floats over the dashboard (drag it by its header, resize it by the
// grip in its bottom-left corner or from its left and top edges), or opens as a side panel that narrows Superset's page. Which one
// is a setting (the gear in the chat's header), defaulting to the deployment's
// overlay.panel; mode, size and position are remembered per browser.
// When Lenspack restarts (a deploy, a crash) the button stays, muted, saying it is reconnecting; an open chat
// shows a banner and waits. A light health check every few seconds notices, and retries back off 1, 2, 4… s
// up to 30 s, for as long as the tab is visible. Signed out of Superset (401): the button goes, no retrying.
(function () {
  if (window.top !== window.self || window.__lenspackOverlay) return;
  window.__lenspackOverlay = true;
  var src = document.currentScript && document.currentScript.src;
  if (!src) return;
  // Where this script came from, path included: Lenspack may sit under a path of Superset's own host (/lenspack).
  var origin = src.replace(/\/overlay\.js(?:[?#].*)?$/, "");
  var OPEN = "lenspack-overlay-open";
  var WIDTH = 400;
  var MODE = "lenspack-overlay-mode"; // the user's choice: "float" or "dock"; unset = the deployment's default
  var POS = "lenspack-overlay-pos"; // the floating window's {right, top} ({right, bottom} before the grip moved)
  var SIZE = "lenspack-overlay-size"; // the floating window's {w, h}
  var DOCKW = "lenspack-overlay-dockw"; // the docked panel's width
  var MIN_W = 320, MIN_H = 360, MARGIN = 12;
  var TOP = 64; // below Superset's navbar
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var chosen = load(MODE);
  var mode = chosen === "dock" || chosen === "float" ? chosen : "float";
  var adminDefault = "float";

  // The overlay's own words, in the chat's language: the same rule as chat.js (a pick in the chat's
  // menu, unless Superset's language changed since; else Superset's language; else the deployment's).
  var STRINGS = {
    en: { ask: "Ask Lenspack", settings: "Chat settings", openAs: "Open as", float: "Floating window", dock: "Side panel", resize: "Drag to resize", reconnecting: "Reconnecting…", restarting: "Lenspack is restarting, reconnecting…" },
    fr: { ask: "Demander à Lenspack", settings: "Réglages du chat", openAs: "Ouvrir en", float: "Fenêtre flottante", dock: "Panneau latéral", resize: "Faire glisser pour redimensionner", reconnecting: "Reconnexion…", restarting: "Lenspack redémarre, reconnexion…" },
    pt: { ask: "Perguntar ao Lenspack", settings: "Opções do chat", openAs: "Abrir como", float: "Janela flutuante", dock: "Painel lateral", resize: "Arraste para redimensionar", reconnecting: "Reconexão…", restarting: "Lenspack em reinício, reconexão em curso…" },
    hi: { ask: "Lenspack से पूछें", settings: "चैट सेटिंग्स", openAs: "ऐसे खोलें", float: "तैरती विंडो", dock: "साइड पैनल", resize: "आकार बदलने के लिए खींचें", reconnecting: "फिर से जुड़ रहे हैं…", restarting: "Lenspack फिर से शुरू हो रहा है, दोबारा जुड़ रहे हैं…" },
  };
  var adminLang = "auto";
  function pageLocale() {
    try {
      var app = document.getElementById("app");
      var boot = app && app.dataset && app.dataset.bootstrap ? JSON.parse(app.dataset.bootstrap) : null;
      var l = boot && boot.common && boot.common.locale;
      if (l) return String(l).slice(0, 2).toLowerCase();
    } catch (e) {}
    return (document.documentElement.lang || navigator.language || "en").slice(0, 2).toLowerCase();
  }
  function uiLang() {
    var p = {};
    try { p = JSON.parse(load("lenspack-voice") || "{}") || {}; } catch (e) {}
    var page = pageLocale(), l;
    if (p.lang && p.lang !== "auto") l = p.langPage !== undefined && p.langPage !== page && STRINGS[page] ? page : p.lang;
    else if (page !== "en" && STRINGS[page]) l = page;
    else if (p.lang === "auto") l = page;
    else l = adminLang;
    return STRINGS[l] ? l : STRINGS[page] ? page : "en";
  }
  function t(k) { return (STRINGS[uiLang()] || STRINGS.en)[k] || STRINGS.en[k]; }

  var css = document.createElement("style");
  css.textContent =
    ".lpo-btn{position:fixed;right:20px;bottom:20px;z-index:1001;border:0;border-radius:99px;background:#1a85a0;color:#fff;font:600 14px/1 Inter,system-ui,sans-serif;padding:12px 18px;box-shadow:0 6px 20px rgba(16,24,40,.22);cursor:pointer;display:none;align-items:center;gap:8px}" +
    ".lpo-btn:hover{background:#156d84}" +
    ".lpo-btn.lpo-wait,.lpo-btn.lpo-wait:hover{background:#98a2b3;cursor:progress;box-shadow:0 4px 14px rgba(16,24,40,.14)}" +
    ".lpo-btn b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:rgba(255,255,255,.2);font-size:12px}" +
    ".lpo-panel{position:fixed;z-index:1002;background:#fff;display:none;box-sizing:border-box}" +
    ".lpo-panel.lpo-dock{top:0;right:0;bottom:0;width:var(--lpo-dw," + WIDTH + "px);max-width:100vw;box-shadow:-8px 0 24px rgba(16,24,40,.14);border-left:1px solid #e4e7ec}" +
    ".lpo-panel.lpo-float{right:20px;top:" + TOP + "px;width:420px;height:min(600px,calc(100vh - " + (TOP + 160) + "px));max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(16,24,40,.28)}" +
    ".lpo-panel.lpo-float .lpc-head{cursor:move;user-select:none;touch-action:none}" +
    ".lpo-panel .lpc-x{font-size:22px;color:#344054}" +
    // Resize handles: the window is anchored top-right; it grows from its left and top edges, and by the grip.
    ".lpo-rz{position:absolute;z-index:2;touch-action:none}" +
    ".lpo-rz-l{left:0;top:0;bottom:0;width:7px;cursor:ew-resize}" +
    ".lpo-rz-t{left:0;right:0;top:0;height:6px;cursor:ns-resize}" +
    ".lpo-rz-tl{left:0;top:0;width:14px;height:14px;cursor:nwse-resize;z-index:3}" +
    ".lpo-panel.lpo-dock .lpo-rz-t,.lpo-panel.lpo-dock .lpo-rz-tl{display:none}" +
    // The grip: the visible way to resize the floating window, width and height together, its top-right corner staying put.
    ".lpo-grip{position:absolute;left:0;bottom:0;z-index:3;width:16px;height:16px;padding:0;border:0;border-radius:0 0 0 13px;background:none;color:#667085;cursor:nesw-resize;touch-action:none;display:grid;place-items:center}" +
    ".lpo-grip:hover,.lpo-grip.on{color:#1a85a0;background:rgba(26,133,160,.1)}" +
    ".lpo-grip svg{width:12px;height:12px;display:block}" +
    ".lpo-panel.lpo-dock .lpo-grip{display:none}" +
    ".lpo-panel.lpo-float .lpc-foot{padding:10px 10px 14px 18px}" +
    "body.lpo-dragging,body.lpo-dragging *{user-select:none!important}" +
    ".lpo-gear{border:0;background:none;color:#667085;cursor:pointer;padding:4px 6px;border-radius:6px;font:16px/1 system-ui,sans-serif;margin-left:auto}" +
    ".lpo-gear:hover,.lpo-gear[aria-expanded=true]{background:#f5f7fa;color:#344054}" +
    ".lpo-gear+.lpc-x{margin-left:0}" +
    ".lpo-menu{position:absolute;z-index:4;right:44px;top:44px;min-width:200px;background:#fff;border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 10px 30px rgba(16,24,40,.18);padding:8px;font:13px/1.4 Inter,system-ui,sans-serif;color:#344054;display:none}" +
    ".lpo-menu.on{display:block}" +
    ".lpo-menu b{display:block;font-size:11px;font-weight:600;color:#667085;text-transform:uppercase;letter-spacing:.04em;margin:2px 6px 6px}" +
    ".lpo-menu label{display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;cursor:pointer}" +
    ".lpo-menu label:hover{background:#f5f7fa}" +
    "body.lpo-docked{margin-right:var(--lpo-dw," + WIDTH + "px)!important}" +
    // Superset 6's dark theme (pageTheme): the panel, its gear menu and grip in dark colours; chat.js has the chat's.
    ".lpo-panel[data-lp-theme=dark]{background:#1b1d21;border-color:#343842;box-shadow:0 18px 50px rgba(0,0,0,.6)}" +
    ".lpo-panel.lpo-dock[data-lp-theme=dark]{box-shadow:-8px 0 24px rgba(0,0,0,.5)}" +
    ".lpo-panel[data-lp-theme=dark] .lpc-x{color:#c9ced6}" +
    ".lpo-panel[data-lp-theme=dark] .lpo-gear,.lpo-panel[data-lp-theme=dark] .lpo-grip{color:#98a2b3}" +
    ".lpo-panel[data-lp-theme=dark] .lpo-gear:hover,.lpo-panel[data-lp-theme=dark] .lpo-gear[aria-expanded=true]{background:#262a31;color:#e6e8eb}" +
    ".lpo-panel[data-lp-theme=dark] .lpo-grip:hover,.lpo-panel[data-lp-theme=dark] .lpo-grip.on{color:#3fb1cc;background:rgba(63,177,204,.15)}" +
    ".lpo-panel[data-lp-theme=dark] .lpo-menu{background:#1b1d21;border-color:#343842;color:#e6e8eb;box-shadow:0 10px 30px rgba(0,0,0,.5)}" +
    ".lpo-panel[data-lp-theme=dark] .lpo-menu b{color:#98a2b3}" +
    ".lpo-panel[data-lp-theme=dark] .lpo-menu label:hover{background:#262a31}" +
    ".lpo-btn[data-lp-theme=dark]{box-shadow:0 6px 20px rgba(0,0,0,.55)}" +
    "@media (max-width:800px){body.lpo-docked{margin-right:0!important}.lpo-rz,.lpo-grip{display:none}.lpo-panel.lpo-float,.lpo-panel.lpo-dock{top:0!important;left:0;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;max-width:none;max-height:none;border-radius:0}}";
  document.head.appendChild(css);

  var btn = document.createElement("button");
  btn.className = "lpo-btn";
  btn.innerHTML = "<b>L</b><span></span>";
  btn.lastChild.textContent = t("ask");
  var panel = document.createElement("div");
  panel.className = "lpo-panel";
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  // Light or dark, as the page is: Superset 6 has a dark theme (its theme menu, or the browser's setting), and a
  // deployment can set its own colours, so the page's own background decides. Read again with every check below.
  var theme = null;
  function rgb(el) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/.exec(getComputedStyle(el).backgroundColor || "");
    if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
    return [+m[1], +m[2], +m[3]];
  }
  function pageTheme() {
    var c = rgb(document.body) || rgb(document.documentElement);
    var now = c && (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5 ? "dark" : "light";
    if (now === theme) return;
    theme = now;
    btn.setAttribute("data-lp-theme", now);
    panel.setAttribute("data-lp-theme", now);
  }
  pageTheme();

  var current = null; // { key, board, title }
  var mounted = null;
  var chat = null; // the mounted chat's handle (send, focus, setOffline)

  // ---- Reaching Lenspack. A failed call is "retry" (network error, 429, 5xx: Lenspack restarting, or a
  // proxy in front of it), "signedout" (401) or "stop" (any other 4xx: retrying would not help).
  var BACKOFF_MAX = 30000, HEALTH_EVERY = 4000;
  var down = false, signedOut = false, delay = 1000, timer = null, pending = null;
  function kind(status) {
    if (status === 401) return "signedout";
    if (status === 429 || status >= 500) return "retry";
    return "stop";
  }
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(
      function (r) {
        if (!r.ok) { var e = new Error(String(r.status)); e.kind = kind(r.status); throw e; }
        return r.json();
      },
      function () { var e = new Error("network"); e.kind = "retry"; throw e; }
    );
  }
  // Runs fn after the current backoff, doubling it; while the tab is hidden it waits for the tab to come back.
  function later(fn) {
    clearTimeout(timer);
    var d = delay;
    delay = Math.min(delay * 2, BACKOFF_MAX);
    timer = setTimeout(function () {
      timer = null;
      if (document.hidden) pending = fn;
      else fn();
    }, d);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !pending) return;
    var fn = pending;
    pending = null;
    fn();
  });
  function setDown(on) {
    down = on;
    if (!on) { delay = 1000; clearTimeout(timer); timer = null; pending = null; }
    btn.classList.toggle("lpo-wait", on);
    relabel();
    if (chat && chat.setOffline) chat.setOffline(on);
  }
  // Something failed: show "reconnecting" and keep trying to bind this dashboard until Lenspack answers.
  function failed(e, key) {
    if (seen !== key) return;
    if (e.kind === "signedout") { signedOut = true; return hideAll(); }
    if (e.kind !== "retry") return;
    if (!down) setDown(true);
    if (panel.style.display !== "block") btn.style.display = "inline-flex";
    later(function () { if (seen === key) bind(key); });
  }
  // While bound and visible, a cheap check that Lenspack still answers (its /healthz, through Superset).
  var lastHealth = 0;
  function health() {
    if (!current || down || signedOut || document.hidden || Date.now() - lastHealth < HEALTH_EVERY) return;
    lastHealth = Date.now();
    var key = current.key;
    getJSON(origin + "/healthz").catch(function (e) { failed(e, key); });
  }

  function loadChat(cb) {
    if (window.LenspackChat) return cb();
    var s = document.createElement("script");
    s.src = origin + "/chat.js";
    s.onload = cb;
    document.head.appendChild(s);
  }
  function relayout() {
    // Superset sizes its grid from the window; tell it the width changed.
    setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 50);
  }
  // Floating: a window over the dashboard, Superset's layout untouched. Docked: a side panel
  // that narrows the page (Superset re-sizes its grid).
  function place() {
    panel.classList.toggle("lpo-float", mode === "float");
    panel.classList.toggle("lpo-dock", mode === "dock");
    var docked = mode === "dock" && panel.style.display === "block";
    var was = document.body.classList.contains("lpo-docked");
    document.body.classList.toggle("lpo-docked", docked);
    panel.style.right = panel.style.top = panel.style.bottom = panel.style.width = panel.style.height = "";
    var dw = Number(load(DOCKW)) || WIDTH;
    document.body.style.setProperty("--lpo-dw", Math.max(MIN_W, Math.min(dw, window.innerWidth - 200)) + "px");
    if (mode === "float") {
      try {
        var sz = JSON.parse(load(SIZE) || "null");
        if (sz) sizeTo(sz.w, sz.h);
        var p = JSON.parse(load(POS) || "null");
        // A position saved before the window was anchored at the top: {right, bottom}.
        if (p && p.top === undefined && p.bottom !== undefined) p.top = window.innerHeight - p.bottom - ((sz && sz.h) || panel.getBoundingClientRect().height || 600);
        if (p) clampTo(p.right, p.top);
      } catch (e) {}
    }
    if (was !== docked) relayout();
    if (menu) menu.querySelectorAll("input").forEach(function (i) { i.checked = i.value === mode; });
  }
  function sizeTo(w, h) {
    w = Math.max(MIN_W, Math.min(w, window.innerWidth - 2 * MARGIN));
    h = Math.max(MIN_H, Math.min(h, window.innerHeight - 2 * MARGIN));
    panel.style.width = w + "px";
    panel.style.height = h + "px";
    return { w: w, h: h };
  }
  function clampTo(right, top) {
    var r = panel.getBoundingClientRect();
    var w = r.width || 420, h = r.height || 600;
    right = Math.max(0, Math.min(right, window.innerWidth - w));
    top = Math.max(0, Math.min(top, window.innerHeight - h));
    panel.style.right = right + "px";
    panel.style.top = top + "px";
    return { right: right, top: top };
  }
  var menu = null;
  function decorate() {
    var head = panel.querySelector(".lpc-head");
    if (!head || head.querySelector(".lpo-gear")) return;
    // Settings: the gear opens a small menu; "Open as" is remembered in this browser.
    var gear = document.createElement("button");
    gear.className = "lpo-gear";
    gear.className += " lpo-t";
    gear.dataset.t = "settings";
    gear.setAttribute("aria-expanded", "false");
    gear.textContent = "\u2699";
    menu = document.createElement("div");
    menu.className = "lpo-menu";
    menu.setAttribute("role", "menu");
    var heading = document.createElement("b");
    heading.className = "lpo-t";
    heading.dataset.t = "openAs";
    menu.appendChild(heading);
    ["float", "dock"].forEach(function (key) {
      var o = [key, key];
      var label = document.createElement("label");
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "lpo-mode";
      input.value = o[0];
      input.checked = mode === o[0];
      input.addEventListener("change", function () {
        mode = chosen = o[0];
        save(MODE, mode);
        place();
        showMenu(false);
      });
      label.appendChild(input);
      var words = document.createElement("span");
      words.className = "lpo-t";
      words.dataset.t = o[1];
      label.appendChild(words);
      menu.appendChild(label);
    });
    function showMenu(on) {
      menu.classList.toggle("on", on);
      gear.setAttribute("aria-expanded", on ? "true" : "false");
    }
    gear.addEventListener("click", function (e) { e.stopPropagation(); showMenu(!menu.classList.contains("on")); });
    panel.addEventListener("pointerdown", function (e) { if (!menu.contains(e.target) && e.target !== gear) showMenu(false); });
    head.insertBefore(gear, head.querySelector(".lpc-x"));
    panel.appendChild(menu);
    // Drag the floating window by its header.
    head.addEventListener("pointerdown", function (e) {
      if (mode !== "float" || e.button !== 0 || e.target.closest("button") || window.innerWidth <= 800) return;
      var r = panel.getBoundingClientRect();
      var right0 = window.innerWidth - r.right, top0 = r.top, x0 = e.clientX, y0 = e.clientY, at = null;
      function move(ev) { at = clampTo(right0 - (ev.clientX - x0), top0 + (ev.clientY - y0)); }
      drag(move, function () { if (at) save(POS, JSON.stringify(at)); });
      e.preventDefault();
    });
    // Also resize from the left edge, the top edge or the top-left corner (docked: the left edge sets the width).
    ["l", "t", "tl"].forEach(function (side) {
      var h = document.createElement("div");
      h.className = "lpo-rz lpo-rz-" + side;
      panel.appendChild(h);
      h.addEventListener("pointerdown", function (e) {
        if (e.button !== 0 || window.innerWidth <= 800) return;
        var r = panel.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, got = null, at = null;
        function move(ev) {
          var dx = x0 - ev.clientX, dy = y0 - ev.clientY;
          if (mode === "dock") {
            var w = Math.max(MIN_W, Math.min(r.width + dx, window.innerWidth - 200));
            document.body.style.setProperty("--lpo-dw", w + "px");
            got = w;
            return;
          }
          // Keep the window inside the viewport while it grows towards the top-left; growing
          // upwards moves its top up by as much (the bottom edge stays).
          var w2 = side === "t" ? r.width : Math.min(r.width + dx, r.right - MARGIN);
          var h2 = side === "l" ? r.height : Math.min(r.height + dy, r.bottom - MARGIN);
          got = sizeTo(w2, h2);
          at = { right: window.innerWidth - r.right, top: Math.max(0, r.bottom - got.h) };
          panel.style.top = at.top + "px";
        }
        drag(move, function () {
          if (got === null) return;
          if (mode === "dock") { save(DOCKW, String(Math.round(got))); relayout(); }
          else { save(SIZE, JSON.stringify(got)); save(POS, JSON.stringify(at)); }
        });
        e.preventDefault();
        e.stopPropagation();
      });
    });
    // The grip, bottom-left: drag it down and left to grow the floating window both ways. The window
    // is anchored top-right ({right, top}), and the default leaves room below it, so it can grow at once.
    var grip = document.createElement("button");
    grip.type = "button";
    grip.className = "lpo-grip";
    grip.className += " lpo-t";
    grip.dataset.t = "resize";
    grip.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M1 3 9 11M1 7 5 11M1 10.5 1.5 11"/></svg>';
    panel.appendChild(grip);
    grip.addEventListener("pointerdown", function (e) {
      if (mode !== "float" || (e.pointerType === "mouse" && e.button !== 0) || window.innerWidth <= 800) return;
      var r = panel.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, got = null;
      var at = { right: window.innerWidth - r.right, top: r.top };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      grip.classList.add("on");
      function move(ev) {
        // Grow towards the bottom-left, stopping at the viewport's margin; the top-right corner stays.
        got = sizeTo(Math.min(r.width + x0 - ev.clientX, r.right - MARGIN), Math.min(r.height + ev.clientY - y0, window.innerHeight - MARGIN - r.top));
        panel.style.right = at.right + "px";
        panel.style.top = at.top + "px";
      }
      drag(move, function () {
        grip.classList.remove("on");
        if (got === null) return;
        save(SIZE, JSON.stringify(got));
        save(POS, JSON.stringify(at));
      });
      e.preventDefault();
      e.stopPropagation();
    });
    // Esc closes the chat, but only while focus is in it: Superset's own dialogs keep their Esc.
    if (!panel.__lpoKeys) {
      panel.__lpoKeys = true;
      panel.addEventListener("keydown", function (e) {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.stopPropagation();
        if (menu && menu.classList.contains("on")) { menu.classList.remove("on"); return; }
        close();
      });
    }
    relabel();
    place();
  }
  // Every translated word: text for menu entries, a tooltip and label for buttons.
  function relabel() {
    btn.lastChild.textContent = down ? t("reconnecting") : t("ask");
    btn.title = down ? t("restarting") : "";
    panel.querySelectorAll(".lpo-t").forEach(function (n) {
      var words = t(n.dataset.t);
      if (n.tagName === "BUTTON") { n.title = words; n.setAttribute("aria-label", words); }
      else n.textContent = words;
    });
  }
  window.addEventListener("lenspack-lang", relabel);
  window.addEventListener("storage", function (e) { if (e.key === "lenspack-voice") relabel(); });
  function drag(move, done) {
    document.body.classList.add("lpo-dragging");
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("lpo-dragging");
      done();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
  // Keep the floating window on screen when the browser window shrinks.
  window.addEventListener("resize", function () {
    if (panel.style.display !== "block" || mode !== "float" || window.innerWidth <= 800) return;
    var r = panel.getBoundingClientRect();
    if (panel.style.width) sizeTo(r.width, r.height);
    clampTo(window.innerWidth - r.right, r.top);
  });

  // Re-reads the dashboard without reloading the page. Superset's dashboard page is a React route
  // (/superset/dashboard/:idOrSlug/) that loads the dashboard, its charts and datasets once when
  // it mounts. Pointing the router at a path no route matches unmounts it; pointing it back mounts
  // a fresh one, which fetches everything again. The chat lives outside Superset's React root, so
  // it keeps its state. If no fresh dashboard appears, fall back to a reload once the chat is idle.
  var refreshing = false;
  // The deployment's off switches, from /_superset/info (overlay, inPlaceRefresh are read here).
  var features = {};
  var DASH = ".dashboard-content"; // the dashboard grid's root (Superset's production build has no data-test attributes)
  function refreshInPlace() {
    if (refreshing) return;
    if (features.inPlaceRefresh === false) return reloadWhenIdle();
    var url = location.pathname + location.search + location.hash;
    var old = document.querySelector(DASH);
    if (!/\/superset\/dashboard\//.test(location.pathname) || !old) return reloadWhenIdle();
    refreshing = true;
    var y = window.scrollY;
    var state = window.history.state;
    function go(path) {
      window.history.replaceState(state, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: state }));
    }
    go(origin.replace(/^https?:\/\/[^/]+/, "") + "/__refresh__");
    setTimeout(function () {
      go(url);
      var t0 = Date.now();
      (function wait() {
        var now = document.querySelector(DASH);
        if (now && now !== old && document.contains(now)) {
          refreshing = false;
          setTimeout(function () { window.scrollTo(0, y); }, 400);
          return;
        }
        if (Date.now() - t0 > 12000) {
          refreshing = false;
          return reloadWhenIdle();
        }
        setTimeout(wait, 150);
      })();
    }, 80);
  }
  function reloadWhenIdle() {
    var goBtn = panel.querySelector(".lpc-go");
    if (goBtn && goBtn.disabled) return setTimeout(reloadWhenIdle, 500);
    location.reload();
  }
  function open() {
    if (!current) {
      // Not bound yet (Lenspack was down when the page loaded): a click tries again now.
      if (down && seen) { delay = 1000; bind(seen); }
      return;
    }
    sessionStorage.setItem(OPEN, current.key);
    panel.style.display = "block";
    btn.style.display = "none";
    place();
    loadChat(function () {
      if (mounted !== current.board) {
        mounted = current.board;
        menu = null;
        chat = window.LenspackChat.mount(panel, {
          api: origin, pack: current.pack, board: current.board, title: current.title, examples: current.examples,
          onClose: close,
          onChanged: refreshInPlace,
          // A chat turn lost its connection: check now rather than at the next health check.
          onUnreachable: function () { lastHealth = 0; health(); },
        });
        chat.focus();
      }
      if (chat.setOffline) chat.setOffline(down);
      decorate();
    });
  }
  function close() {
    sessionStorage.removeItem(OPEN);
    panel.style.display = "none";
    place();
    if (current) btn.style.display = "inline-flex";
  }
  function hideAll() {
    current = null;
    clearTimeout(timer);
    timer = pending = null;
    if (down) setDown(false);
    btn.style.display = "none";
    panel.style.display = "none";
    place();
  }

  var seen = null;
  function check() {
    if (refreshing) return;
    var m = /\/superset\/dashboard\/([^/]+)\/?/.exec(location.pathname);
    var key = m ? m[1] : null;
    if (key === seen) return;
    seen = key;
    if (!key || /[?&]standalone=/.test(location.search) || signedOut) return hideAll();
    current = null;
    clearTimeout(timer);
    timer = pending = null;
    bind(key);
  }
  function bind(key) {
    Promise.all([
      getJSON(origin + "/_superset/bind?dashboard=" + encodeURIComponent(key)),
      getJSON(origin + "/_superset/info"),
    ]).then(function (res) {
      var b = res[0], info = res[1];
      if (seen !== key) return;
      if (b.error) { if (down) setDown(false); btn.style.display = "none"; return; }
      features = info.features || {};
      if (features.overlay === false) { if (down) setDown(false); return hideAll(); }
      var again = !!current && current.board === b.board;
      current = { key: key, board: b.board, title: b.title, pack: info.pack, examples: info.examplesByLang || info.examples };
      lastHealth = Date.now();
      if (down) setDown(false);
      // Back after a restart with the chat already showing: nothing more to do.
      if (again && panel.style.display === "block") return;
      if (info.language && info.language.default) adminLang = info.language.default;
      relabel();
      // The deployment's default applies until this browser has chosen.
      adminDefault = info.panel === "dock" ? "dock" : "float";
      if (chosen !== "dock" && chosen !== "float") mode = adminDefault;
      if (sessionStorage.getItem(OPEN) === key) open();
      else btn.style.display = "inline-flex";
    }).catch(function (e) { failed(e, key); });
  }
  btn.onclick = open;
  check();
  setInterval(function () { check(); health(); pageTheme(); }, 800);
})();
