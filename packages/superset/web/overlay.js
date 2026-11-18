// Loaded on every Superset page by one script tag in Superset's
// tail_js_custom_extra.html (a template Superset documents as overridable).
// On a dashboard it adds an "Ask Lenspack" button; the chat edits that
// dashboard through the Lenspack server, and the page reloads to show it.
(function () {
  if (window.top !== window.self || window.__lenspackOverlay) return;
  window.__lenspackOverlay = true;
  var src = document.currentScript && document.currentScript.src;
  if (!src) return;
  var origin = new URL(src).origin;
  var OPEN = "lenspack-overlay-open";
  var WIDTH = 400;

  var css = document.createElement("style");
  css.textContent =
    ".lpo-btn{position:fixed;right:20px;bottom:20px;z-index:1001;border:0;border-radius:99px;background:#1a85a0;color:#fff;font:600 14px/1 Inter,system-ui,sans-serif;padding:12px 18px;box-shadow:0 6px 20px rgba(16,24,40,.22);cursor:pointer;display:none;align-items:center;gap:8px}" +
    ".lpo-btn:hover{background:#156d84}" +
    ".lpo-btn b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:rgba(255,255,255,.2);font-size:12px}" +
    ".lpo-panel{position:fixed;top:0;right:0;bottom:0;width:" + WIDTH + "px;max-width:100vw;z-index:1002;background:#fff;box-shadow:-8px 0 24px rgba(16,24,40,.14);border-left:1px solid #e4e7ec;display:none}" +
    "body.lpo-open{margin-right:" + WIDTH + "px!important}" +
    "@media (max-width:800px){body.lpo-open{margin-right:0!important}}";
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
  function open() {
    if (!current) return;
    sessionStorage.setItem(OPEN, current.key);
    panel.style.display = "block";
    btn.style.display = "none";
    document.body.classList.add("lpo-open");
    relayout();
    loadChat(function () {
      if (mounted !== current.board) {
        mounted = current.board;
        window.LenspackChat.mount(panel, {
          api: origin, pack: current.pack, board: current.board, title: current.title, examples: current.examples, reloadsPage: true,
          onClose: close,
          onChanged: function () { location.reload(); },
        }).focus();
      }
    });
  }
  function close() {
    sessionStorage.removeItem(OPEN);
    panel.style.display = "none";
    document.body.classList.remove("lpo-open");
    if (current) btn.style.display = "inline-flex";
    relayout();
  }
  function hideAll() {
    current = null;
    btn.style.display = "none";
    panel.style.display = "none";
    document.body.classList.remove("lpo-open");
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
