// Loaded on every Superset page by one script tag in Superset's
// tail_js_custom_extra.html (a template Superset documents as overridable).
// On a dashboard it adds an "Ask Lenspack" button; the chat edits that
// dashboard through the Lenspack server, and the dashboard is re-read in
// place to show it (no page reload; see refreshInPlace).
// The chat floats over the dashboard (drag it by its header, resize it from
// its edges), or opens as a side panel that narrows Superset's page. Which one
// is a setting (the gear in the chat's header), defaulting to the deployment's
// overlay.panel; mode, size and position are remembered per browser.
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
  var POS = "lenspack-overlay-pos"; // the floating window's {right, bottom}
  var SIZE = "lenspack-overlay-size"; // the floating window's {w, h}
  var DOCKW = "lenspack-overlay-dockw"; // the docked panel's width
  var MIN_W = 320, MIN_H = 360, MARGIN = 12;
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var chosen = load(MODE);
  var mode = chosen === "dock" || chosen === "float" ? chosen : "float";
  var adminDefault = "float";

  var css = document.createElement("style");
  css.textContent =
    ".lpo-btn{position:fixed;right:20px;bottom:20px;z-index:1001;border:0;border-radius:99px;background:#1a85a0;color:#fff;font:600 14px/1 Inter,system-ui,sans-serif;padding:12px 18px;box-shadow:0 6px 20px rgba(16,24,40,.22);cursor:pointer;display:none;align-items:center;gap:8px}" +
    ".lpo-btn:hover{background:#156d84}" +
    ".lpo-btn b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:rgba(255,255,255,.2);font-size:12px}" +
    ".lpo-panel{position:fixed;z-index:1002;background:#fff;display:none;box-sizing:border-box}" +
    ".lpo-panel.lpo-dock{top:0;right:0;bottom:0;width:var(--lpo-dw," + WIDTH + "px);max-width:100vw;box-shadow:-8px 0 24px rgba(16,24,40,.14);border-left:1px solid #e4e7ec}" +
    ".lpo-panel.lpo-float{right:20px;bottom:20px;width:420px;height:min(680px,calc(100vh - 100px));max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);border:1px solid #e4e7ec;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(16,24,40,.28)}" +
    ".lpo-panel.lpo-float .lpc-head{cursor:move;user-select:none;touch-action:none}" +
    ".lpo-panel .lpc-x{font-size:22px;color:#344054}" +
    // Resize handles: the window is anchored bottom-right, so it grows from its left and top edges.
    ".lpo-rz{position:absolute;z-index:2;touch-action:none}" +
    ".lpo-rz-l{left:0;top:0;bottom:0;width:7px;cursor:ew-resize}" +
    ".lpo-rz-t{left:0;right:0;top:0;height:6px;cursor:ns-resize}" +
    ".lpo-rz-tl{left:0;top:0;width:14px;height:14px;cursor:nwse-resize;z-index:3}" +
    ".lpo-panel.lpo-dock .lpo-rz-t,.lpo-panel.lpo-dock .lpo-rz-tl{display:none}" +
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
    "@media (max-width:800px){body.lpo-docked{margin-right:0!important}.lpo-rz{display:none}.lpo-panel.lpo-float,.lpo-panel.lpo-dock{top:0;left:0;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;max-width:none;max-height:none;border-radius:0}}";
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
    panel.style.right = panel.style.bottom = panel.style.width = panel.style.height = "";
    var dw = Number(load(DOCKW)) || WIDTH;
    document.body.style.setProperty("--lpo-dw", Math.max(MIN_W, Math.min(dw, window.innerWidth - 200)) + "px");
    if (mode === "float") {
      try {
        var sz = JSON.parse(load(SIZE) || "null");
        if (sz) sizeTo(sz.w, sz.h);
        var p = JSON.parse(load(POS) || "null");
        if (p) clampTo(p.right, p.bottom);
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
  function clampTo(right, bottom) {
    var r = panel.getBoundingClientRect();
    var w = r.width || 420, h = r.height || 600;
    right = Math.max(0, Math.min(right, window.innerWidth - w));
    bottom = Math.max(0, Math.min(bottom, window.innerHeight - h));
    panel.style.right = right + "px";
    panel.style.bottom = bottom + "px";
    return { right: right, bottom: bottom };
  }
  var menu = null;
  function decorate() {
    var head = panel.querySelector(".lpc-head");
    if (!head || head.querySelector(".lpo-gear")) return;
    // Settings: the gear opens a small menu; "Open as" is remembered in this browser.
    var gear = document.createElement("button");
    gear.className = "lpo-gear";
    gear.title = "Chat settings";
    gear.setAttribute("aria-label", "Chat settings");
    gear.setAttribute("aria-expanded", "false");
    gear.textContent = "\u2699";
    menu = document.createElement("div");
    menu.className = "lpo-menu";
    menu.setAttribute("role", "menu");
    var heading = document.createElement("b");
    heading.textContent = "Open as";
    menu.appendChild(heading);
    [["float", "Floating window"], ["dock", "Side panel"]].forEach(function (o) {
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
      label.appendChild(document.createTextNode(o[1]));
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
      var right0 = window.innerWidth - r.right, bottom0 = window.innerHeight - r.bottom, x0 = e.clientX, y0 = e.clientY, at = null;
      function move(ev) { at = clampTo(right0 - (ev.clientX - x0), bottom0 - (ev.clientY - y0)); }
      drag(move, function () { if (at) save(POS, JSON.stringify(at)); });
      e.preventDefault();
    });
    // Resize from the left edge, the top edge or the top-left corner (docked: the left edge sets the width).
    ["l", "t", "tl"].forEach(function (side) {
      var h = document.createElement("div");
      h.className = "lpo-rz lpo-rz-" + side;
      panel.appendChild(h);
      h.addEventListener("pointerdown", function (e) {
        if (e.button !== 0 || window.innerWidth <= 800) return;
        var r = panel.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, got = null;
        function move(ev) {
          var dx = x0 - ev.clientX, dy = y0 - ev.clientY;
          if (mode === "dock") {
            var w = Math.max(MIN_W, Math.min(r.width + dx, window.innerWidth - 200));
            document.body.style.setProperty("--lpo-dw", w + "px");
            got = w;
            return;
          }
          // Keep the window inside the viewport while it grows towards the top-left.
          var w2 = side === "t" ? r.width : Math.min(r.width + dx, r.right - MARGIN);
          var h2 = side === "l" ? r.height : Math.min(r.height + dy, r.bottom - MARGIN);
          got = sizeTo(w2, h2);
        }
        drag(move, function () {
          if (got === null) return;
          if (mode === "dock") { save(DOCKW, String(Math.round(got))); relayout(); }
          else save(SIZE, JSON.stringify(got));
        });
        e.preventDefault();
        e.stopPropagation();
      });
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
    place();
  }
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
    clampTo(window.innerWidth - r.right, window.innerHeight - r.bottom);
  });

  // Re-reads the dashboard without reloading the page. Superset's dashboard page is a React route
  // (/superset/dashboard/:idOrSlug/) that loads the dashboard, its charts and datasets once when
  // it mounts. Pointing the router at a path no route matches unmounts it; pointing it back mounts
  // a fresh one, which fetches everything again. The chat lives outside Superset's React root, so
  // it keeps its state. If no fresh dashboard appears, fall back to a reload once the chat is idle.
  var refreshing = false;
  var DASH = ".dashboard-content"; // the dashboard grid's root (Superset's production build has no data-test attributes)
  function refreshInPlace() {
    if (refreshing) return;
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
    if (!current) return;
    sessionStorage.setItem(OPEN, current.key);
    panel.style.display = "block";
    btn.style.display = "none";
    place();
    loadChat(function () {
      if (mounted !== current.board) {
        mounted = current.board;
        menu = null;
        window.LenspackChat.mount(panel, {
          api: origin, pack: current.pack, board: current.board, title: current.title, examples: current.examples,
          onClose: close,
          onChanged: refreshInPlace,
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
    if (refreshing) return;
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
      // The deployment's default applies until this browser has chosen.
      adminDefault = info.panel === "dock" ? "dock" : "float";
      if (chosen !== "dock" && chosen !== "float") mode = adminDefault;
      if (sessionStorage.getItem(OPEN) === key) open();
      else btn.style.display = "inline-flex";
    }).catch(function () { /* Lenspack is down: Superset carries on without the button */ });
  }
  btn.onclick = open;
  check();
  setInterval(check, 800);
})();
