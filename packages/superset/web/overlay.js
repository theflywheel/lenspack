// Loaded on every Superset page by one script tag in Superset's
// tail_js_custom_extra.html (a template Superset documents as overridable).
// On a dashboard it adds an "Ask Lenspack" button; the chat edits that
// dashboard through the Lenspack server, and the page reloads to show it.
// The chat floats over the dashboard (drag it by its header), or docks as a
// side panel that narrows Superset's page; the choice is remembered.
(function () {
  if (window.top !== window.self || window.__lenspackOverlay) return;
  window.__lenspackOverlay = true;
  var src = document.currentScript && document.currentScript.src;
  if (!src) return;
  // Where this script came from, path included: Lenspack may sit under a path of Superset's own host (/lenspack).
  var origin = src.replace(/\/overlay\.js(?:[?#].*)?$/, "");
  var OPEN = "lenspack-overlay-open";
  var WIDTH = 400;
  var MODE = "lenspack-overlay-mode"; // "float" (default) or "dock"
  var POS = "lenspack-overlay-pos"; // the floating window's {right, bottom}
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var mode = load(MODE) === "dock" ? "dock" : "float";

  var css = document.createElement("style");
  css.textContent =
    ".lpo-btn{position:fixed;right:20px;bottom:20px;z-index:1001;border:0;border-radius:99px;background:#1a85a0;color:#fff;font:600 14px/1 Inter,system-ui,sans-serif;padding:12px 18px;box-shadow:0 6px 20px rgba(16,24,40,.22);cursor:pointer;display:none;align-items:center;gap:8px}" +
    ".lpo-btn:hover{background:#156d84}" +
    ".lpo-btn b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:rgba(255,255,255,.2);font-size:12px}" +
    ".lpo-panel{position:fixed;z-index:1002;background:#fff;display:none;box-sizing:border-box}" +
    ".lpo-panel.lpo-dock{top:0;right:0;bottom:0;width:" + WIDTH + "px;max-width:100vw;box-shadow:-8px 0 24px rgba(16,24,40,.14);border-left:1px solid #e4e7ec}" +
    ".lpo-panel.lpo-float{right:20px;bottom:20px;width:420px;height:min(680px,calc(100vh - 100px));max-width:calc(100vw - 24px);border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(16,24,40,.28)}" +
    ".lpo-panel.lpo-float .lpc-head{cursor:move;user-select:none}" +
    ".lpo-dk{border:0;background:none;color:#667085;cursor:pointer;padding:4px 6px;border-radius:6px;font:600 12px/1 Inter,system-ui,sans-serif;margin-left:auto}" +
    ".lpo-dk:hover{background:#f5f7fa}" +
    ".lpo-dk+.lpc-x{margin-left:0}" +
    "body.lpo-docked{margin-right:" + WIDTH + "px!important}" +
    "@media (max-width:800px){body.lpo-docked{margin-right:0!important}.lpo-panel.lpo-float,.lpo-panel.lpo-dock{top:0;left:0;right:0!important;bottom:0!important;width:100vw;height:100vh;max-width:none;border-radius:0}}";
  document.head.appendChild(css);

  var btn = document.createElement("button");
  btn.className = "lpo-btn";
  btn.innerHTML = "<b>L</b>Ask Lenspack";
  var panel = document.createElement("div");
  panel.className = "lpo-panel";
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var current = null; // { key, board, title }
  var mounted = null;

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
    panel.style.right = panel.style.bottom = "";
    if (mode === "float") {
      try {
        var p = JSON.parse(load(POS) || "null");
        if (p) clampTo(p.right, p.bottom);
      } catch (e) {}
    }
    if (was !== docked) relayout();
    if (dockBtn) {
      dockBtn.textContent = mode === "float" ? "Dock" : "Float";
      dockBtn.title = mode === "float" ? "Dock as a side panel" : "Float over the dashboard";
    }
  }
  function clampTo(right, bottom) {
    var r = panel.getBoundingClientRect();
    var w = r.width || 420, h = r.height || 600;
    right = Math.max(0, Math.min(right, window.innerWidth - w));
    bottom = Math.max(0, Math.min(bottom, window.innerHeight - h));
    panel.style.right = right + "px";
    panel.style.bottom = bottom + "px";
    return { right: right, bottom: bottom };
  }
  var dockBtn = null;
  function decorate() {
    var head = panel.querySelector(".lpc-head");
    if (!head || head.querySelector(".lpo-dk")) return;
    dockBtn = document.createElement("button");
    dockBtn.className = "lpo-dk";
    dockBtn.onclick = function () {
      mode = mode === "float" ? "dock" : "float";
      save(MODE, mode);
      place();
    };
    head.insertBefore(dockBtn, head.querySelector(".lpc-x"));
    // Drag the floating window by its header.
    head.addEventListener("pointerdown", function (e) {
      if (mode !== "float" || e.button !== 0 || e.target.closest("button") || window.innerWidth <= 800) return;
      var r = panel.getBoundingClientRect();
      var right0 = window.innerWidth - r.right, bottom0 = window.innerHeight - r.bottom, x0 = e.clientX, y0 = e.clientY, at = null;
      function move(ev) { at = clampTo(right0 - (ev.clientX - x0), bottom0 - (ev.clientY - y0)); }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (at) save(POS, JSON.stringify(at));
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      e.preventDefault();
    });
    place();
  }
  function open() {
    if (!current) return;
    sessionStorage.setItem(OPEN, current.key);
    panel.style.display = "block";
    btn.style.display = "none";
    place();
    loadChat(function () {
      if (mounted !== current.board) {
        mounted = current.board;
        dockBtn = null;
        window.LenspackChat.mount(panel, {
          api: origin, pack: current.pack, board: current.board, title: current.title, examples: current.examples, reloadsPage: true,
          onClose: close,
          onChanged: function () { location.reload(); },
        }).focus();
      }
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
    btn.style.display = "none";
    panel.style.display = "none";
    place();
  }

  var seen = null;
  function check() {
    var m = /\/superset\/dashboard\/([^/]+)\/?/.exec(location.pathname);
    var key = m ? m[1] : null;
    if (key === seen) return;
    seen = key;
    if (!key || /[?&]standalone=/.test(location.search)) return hideAll();
    Promise.all([
      fetch(origin + "/_superset/bind?dashboard=" + encodeURIComponent(key)).then(function (r) { return r.json(); }),
      fetch(origin + "/_superset/info").then(function (r) { return r.json(); }),
    ]).then(function (res) {
      var b = res[0], info = res[1];
      if (b.error || seen !== key) return;
      current = { key: key, board: b.board, title: b.title, pack: info.pack, examples: info.examples };
      if (sessionStorage.getItem(OPEN) === key) open();
      else btn.style.display = "inline-flex";
    }).catch(function () { /* Lenspack is down: Superset carries on without the button */ });
  }
  btn.onclick = open;
  check();
  setInterval(check, 800);
})();
