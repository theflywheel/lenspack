// The Lenspack chat panel, framework-free so it can sit beside a Superset
// iframe or float on Superset's own pages. It speaks the board API's chat
// stream (AI SDK UI message stream over SSE) and says when Superset changed.
(function () {
  if (window.LenspackChat) return;

  const CSS = `
.lpc{--lpc-fg:#1f2328;--lpc-mute:#667085;--lpc-line:#e4e7ec;--lpc-bg:#fff;--lpc-soft:#f5f7fa;--lpc-acc:#1a85a0;--lpc-acc-soft:#e6f4f7;--lpc-bad:#b42318;--lpc-ok:#067647;
  font:14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--lpc-fg);background:var(--lpc-bg);display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box}
.lpc *{box-sizing:border-box}
.lpc-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--lpc-line)}
.lpc-mark{width:26px;height:26px;border-radius:7px;background:var(--lpc-acc);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.lpc-ttl{flex:1;min-width:0}
.lpc-ttl b{display:block;font-size:14px}
.lpc-ttl span{display:block;color:var(--lpc-mute);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lpc-x{border:0;background:none;font-size:20px;line-height:1;color:var(--lpc-mute);cursor:pointer;padding:4px 6px;border-radius:6px}
.lpc-x:hover{background:var(--lpc-soft)}
.lpc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:0}
.lpc-empty{color:var(--lpc-mute);font-size:13px}
.lpc-empty p{margin:0 0 10px}
.lpc-chips{display:flex;flex-direction:column;gap:6px}
.lpc-chip{text-align:left;border:1px solid var(--lpc-line);background:var(--lpc-bg);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;color:var(--lpc-fg);cursor:pointer}
.lpc-chip:hover{border-color:var(--lpc-acc);background:var(--lpc-acc-soft)}
.lpc-msg{max-width:92%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}
.lpc-user{align-self:flex-end;background:var(--lpc-acc);color:#fff;border-bottom-right-radius:3px}
.lpc-bot{align-self:flex-start;background:var(--lpc-soft);border-bottom-left-radius:3px}
.lpc-steps{align-self:flex-start;display:flex;flex-direction:column;gap:2px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--lpc-mute)}
.lpc-step.bad{color:var(--lpc-bad)}
.lpc-step.ok::before{content:"✓ ";color:var(--lpc-ok)}
.lpc-step.bad::before{content:"✗ "}
.lpc-step.run::before{content:"… "}
.lpc-note{align-self:stretch;font-size:12px;color:var(--lpc-mute);border-left:3px solid var(--lpc-line);padding:2px 8px}
.lpc-note.sync{border-color:var(--lpc-acc);color:var(--lpc-acc)}
.lpc-note.bad{border-color:var(--lpc-bad);color:var(--lpc-bad)}
.lpc-foot{border-top:1px solid var(--lpc-line);padding:10px;display:flex;gap:8px;align-items:flex-end}
.lpc-in{flex:1;resize:none;border:1px solid var(--lpc-line);border-radius:8px;padding:8px 10px;font:inherit;min-height:40px;max-height:140px;outline:none;color:var(--lpc-fg);background:var(--lpc-bg)}
.lpc-in:focus{border-color:var(--lpc-acc);box-shadow:0 0 0 3px var(--lpc-acc-soft)}
.lpc-go{border:0;background:var(--lpc-acc);color:#fff;border-radius:8px;height:40px;padding:0 14px;font:inherit;font-weight:600;cursor:pointer}
.lpc-go:disabled{opacity:.5;cursor:default}
.lpc-status{font-size:12px;color:var(--lpc-mute);padding:0 14px 6px;min-height:18px}
`;

  const TOOL = {
    get_board: "read the dashboard", list_metrics: "read the metrics", query: "ran a query", explain: "checked a query", list_values: "listed values",
    list_versions: "read the history", restore_version: "restored a version", add_widget: "add chart", update_widget: "change chart", move_widget: "move chart",
    resize_widget: "resize chart", remove_widget: "remove chart", add_filter: "add filter", remove_filter: "remove filter", set_layout_mode: "layout", rename_board: "rename dashboard", propose_measure: "proposed a metric",
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function describe(name, input) {
    const what = TOOL[name] || name;
    const w = input && input.widget;
    if (w && w.title) return `${what}: “${w.title}”`;
    if (input && input.id && /widget/.test(name)) return `${what}: ${input.id}`;
    if (input && input.title) return `${what}: “${input.title}”`;
    return what;
  }

  function mount(root, opts) {
    if (!document.getElementById("lpc-css")) {
      const s = el("style");
      s.id = "lpc-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const api = (opts.api || "").replace(/\/$/, "");
    const base = `${api}/api/${encodeURIComponent(opts.pack)}/${encodeURIComponent(opts.board)}`;
    const key = `lenspack-chat:${opts.board}`;
    let saved = {};
    try {
      saved = JSON.parse(sessionStorage.getItem(key) || "{}");
    } catch (e) {}
    const history = saved.messages || [];
    let since = saved.since;
    const persist = () => {
      try {
        sessionStorage.setItem(key, JSON.stringify({ messages: history.slice(-30), since }));
      } catch (e) {}
    };

    root.innerHTML = "";
    const wrap = el("div", "lpc");
    const head = el("div", "lpc-head");
    head.append(el("div", "lpc-mark", "L"));
    const ttl = el("div", "lpc-ttl");
    ttl.append(el("b", "", "Ask Lenspack"), el("span", "", opts.title || "Superset dashboard"));
    head.append(ttl);
    if (opts.onClose) {
      const x = el("button", "lpc-x", "×");
      x.title = "Close";
      x.onclick = opts.onClose;
      head.append(x);
    }
    const log = el("div", "lpc-log");
    const status = el("div", "lpc-status");
    const foot = el("div", "lpc-foot");
    const input = el("textarea", "lpc-in");
    input.rows = 1;
    input.placeholder = "Ask for a chart, a change, or a number…";
    const go = el("button", "lpc-go", "Send");
    foot.append(input, go);
    wrap.append(head, log, status, foot);
    root.append(wrap);

    const scroll = () => (log.scrollTop = log.scrollHeight);
    function bubble(role, text) {
      const b = el("div", `lpc-msg ${role === "user" ? "lpc-user" : "lpc-bot"}`, text);
      log.append(b);
      scroll();
      return b;
    }
    function note(text, cls) {
      log.append(el("div", `lpc-note ${cls || ""}`, text));
      scroll();
    }
    function empty() {
      if (history.length) return;
      const e = el("div", "lpc-empty");
      e.append(el("p", "", "Changes you ask for are saved to this Superset dashboard. The numbers come from Superset's own metrics."));
      const chips = el("div", "lpc-chips");
      for (const q of opts.examples || []) {
        const c = el("button", "lpc-chip", q);
        c.onclick = () => send(q);
        chips.append(c);
      }
      e.append(chips);
      log.append(e);
    }
    for (const m of history) bubble(m.role, m.parts.map((p) => p.text || "").join(""));
    if (saved.notice) note(saved.notice, "sync");
    empty();
    if (saved.notice) {
      delete saved.notice;
      persist();
    }

    async function version() {
      const r = await fetch(base);
      if (!r.ok) throw new Error(`board: ${r.status}`);
      return (await r.json()).board.version;
    }

    let busy = false;
    async function send(text) {
      text = (text || "").trim();
      if (!text || busy) return;
      busy = true;
      go.disabled = true;
      input.value = "";
      const emptyEl = log.querySelector(".lpc-empty");
      if (emptyEl) emptyEl.remove();
      history.push({ id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text }] });
      persist();
      bubble("user", text);
      status.textContent = "Working…";
      let before = null;
      try {
        before = await version();
      } catch (e) {}
      let steps = null;
      const calls = {};
      let bot = null;
      let answer = "";
      try {
        const res = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history, ...(typeof since === "number" ? { since } : {}) }) });
        if (!res.ok || !res.body) {
          let msg = `${res.status}`;
          try {
            msg = (await res.json()).error || msg;
          } catch (e) {}
          throw new Error(msg);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let ev;
              try {
                ev = JSON.parse(data);
              } catch (e) {
                continue;
              }
              switch (ev.type) {
                case "text-delta":
                  if (!bot) bot = bubble("assistant", "");
                  answer += ev.delta;
                  bot.textContent = answer;
                  scroll();
                  break;
                case "tool-input-available": {
                  if (ev.toolName === "get_board" || ev.toolName === "list_metrics") break;
                  if (!steps) {
                    steps = el("div", "lpc-steps");
                    log.append(steps);
                  }
                  const s = el("div", "lpc-step run", describe(ev.toolName, ev.input));
                  steps.append(s);
                  calls[ev.toolCallId] = s;
                  bot = null;
                  answer = answer ? answer + "\n\n" : "";
                  scroll();
                  break;
                }
                case "tool-output-available": {
                  const s = calls[ev.toolCallId];
                  if (!s) break;
                  const o = ev.output || {};
                  const bad = o.applied === false || o.ok === false || o.error;
                  s.className = `lpc-step ${bad ? "bad" : "ok"}`;
                  if (bad && o.error) s.textContent += ` (${String(o.error).slice(0, 140)})`;
                  break;
                }
                case "tool-output-error": {
                  const s = calls[ev.toolCallId];
                  if (s) {
                    s.className = "lpc-step bad";
                    s.textContent += ` (${String(ev.errorText || "").slice(0, 140)})`;
                  }
                  break;
                }
                case "data-status":
                  status.textContent = "Reviewing the result…";
                  break;
                case "data-review": {
                  const r = ev.data || {};
                  if (r.unavailable) break;
                  note(r.satisfied ? `Reviewer: done as asked. ${r.note || ""}` : `Reviewer: ${[...(r.missing || []), ...(r.wrong || [])].join("; ") || r.note}`, r.satisfied ? "" : "bad");
                  break;
                }
                case "error":
                  note(ev.errorText || "Something went wrong", "bad");
                  break;
              }
            }
          }
        }
        const full = log.querySelectorAll(".lpc-bot");
        const text = [...full].slice(-3).map((b) => b.textContent).join("\n\n") || answer;
        history.push({ id: `a${Date.now()}`, role: "assistant", parts: [{ type: "text", text: answer || text || "(no answer)" }] });
        status.textContent = "";
        let after = null;
        try {
          after = await version();
        } catch (e) {}
        since = after ?? since;
        persist();
        if (before !== null && after !== null && after > before) {
          const msg = "Saved to Superset. Refreshing the dashboard…";
          // The page is about to reload: say so again once it is back.
          if (opts.reloadsPage)
            try {
              sessionStorage.setItem(key, JSON.stringify({ messages: history.slice(-30), since, notice: "Saved to Superset." }));
            } catch (e) {}
          note(msg, "sync");
          if (opts.onChanged) setTimeout(() => opts.onChanged(), 600);
        }
      } catch (e) {
        status.textContent = "";
        note(`Could not reach Lenspack: ${e.message}`, "bad");
      } finally {
        busy = false;
        go.disabled = false;
        input.focus();
      }
    }

    go.onclick = () => send(input.value);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(input.value);
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    });
    return { send, focus: () => input.focus() };
  }

  window.LenspackChat = { mount };
})();
