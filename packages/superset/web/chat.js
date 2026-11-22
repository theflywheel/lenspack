// The Lenspack chat panel, framework-free so it can sit beside a Superset
// iframe or float on Superset's own pages. It speaks the board API's chat
// stream (AI SDK UI message stream over SSE) and says when Superset changed.
(function () {
  if (window.LenspackChat) return;

  const CSS = `
.lpc{--lpc-fg:#1f2328;--lpc-mute:#667085;--lpc-line:#e4e7ec;--lpc-bg:#fff;--lpc-soft:#f5f7fa;--lpc-acc:#1a85a0;--lpc-acc-soft:#e6f4f7;--lpc-bad:#b42318;--lpc-ok:#067647;
  font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI","Noto Sans","Noto Sans Devanagari","Nirmala UI","Kohinoor Devanagari",sans-serif;color:var(--lpc-fg);background:var(--lpc-bg);display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box}
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
.lpc-bot{align-self:flex-start;background:var(--lpc-soft);border-bottom-left-radius:3px;white-space:normal}
.lpc-bot.lpc-pre{background:none;color:var(--lpc-mute);font-size:12.5px;padding:0 2px}
.lpc-bot p{margin:0 0 6px}
.lpc-bot>:last-child{margin-bottom:0}
.lpc-bot ul,.lpc-bot ol{margin:0 0 6px;padding-left:20px}
.lpc-bot li{margin:1px 0}
.lpc-bot li>ul,.lpc-bot li>ol{margin:2px 0 0}
.lpc-bot code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(16,24,40,.06);border-radius:4px;padding:1px 4px}
.lpc-bot pre{margin:0 0 6px;padding:8px 10px;background:rgba(16,24,40,.06);border-radius:6px;overflow-x:auto;white-space:pre}
.lpc-bot pre code{background:none;padding:0}
.lpc-bot a{color:var(--lpc-acc);text-decoration:underline}
.lpc-bot .lpc-tw{overflow-x:auto;margin:2px 0 6px;max-width:100%}
.lpc-bot table{border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;background:var(--lpc-bg);border-radius:6px}
.lpc-bot th,.lpc-bot td{padding:4px 9px;border-bottom:1px solid var(--lpc-line);text-align:left;white-space:nowrap;vertical-align:top}
.lpc-bot th{font-weight:600;color:var(--lpc-mute);font-size:12px}
.lpc-bot tr:last-child td{border-bottom:0}
.lpc-bot .lpc-num{text-align:right}
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


  // A small markdown renderer for model replies. It builds DOM nodes and sets only
  // textContent, so nothing the model writes is ever parsed as HTML. Supported:
  // paragraphs, **bold**, *italic*, `code`, fenced code, bullet and numbered lists
  // (one level of nesting), links (http/https only) and compact tables. Headings are
  // shown as a bold paragraph. Half-streamed input renders as text until it is whole.
  const NUM = /^[-+−]?(?:\d[\d,\s]*(?:\.\d+)?|\.\d+)\s*(?:%|pp|k|K|M|bn|x|×)?$/;
  function inline(text, out) {
    let i = 0;
    let buf = "";
    const flush = () => {
      if (buf) out.append(document.createTextNode(buf));
      buf = "";
    };
    while (i < text.length) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length && /[\\`*_\[\]()|#>-]/.test(text[i + 1])) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (c === "`") {
        const j = text.indexOf("`", i + 1);
        if (j > i + 1) {
          flush();
          out.append(el("code", "", text.slice(i + 1, j)));
          i = j + 1;
          continue;
        }
      }
      if ((c === "*" || c === "_") && text[i + 1] === c) {
        const j = text.indexOf(c + c, i + 2);
        if (j > i + 2) {
          flush();
          const b = el("strong");
          inline(text.slice(i + 2, j), b);
          out.append(b);
          i = j + 2;
          continue;
        }
      }
      // _italic_ only at word edges, so snake_case names (children_coverage_pct) stay as they are.
      if ((c === "*" || (c === "_" && !/\w/.test(text[i - 1] || ""))) && text[i + 1] && !/\s/.test(text[i + 1])) {
        let j = i + 1;
        for (; (j = text.indexOf(c, j)) > 0; j++) {
          if (text[j + 1] === c) {
            j++;
            continue;
          }
          if (!/\s/.test(text[j - 1]) && (c === "*" || !/\w/.test(text[j + 1] || ""))) break;
        }
        if (j > i + 1) {
          flush();
          const e = el("em");
          inline(text.slice(i + 1, j), e);
          out.append(e);
          i = j + 1;
          continue;
        }
      }
      if (c === "[") {
        const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
        if (m) {
          flush();
          if (/^https?:\/\//i.test(m[2])) {
            const a = el("a");
            a.href = m[2];
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            inline(m[1], a);
            out.append(a);
          } else inline(m[1], out);
          i += m[0].length;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }
  const cells = (line) => {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((x) => x.trim().replace(/\\\|/g, "|"));
  };
  const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  function table(lines) {
    const head = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    const n = head.length;
    const numeric = head.map((_, k) => rows.some((r) => (r[k] || "") !== "") && rows.every((r) => !r[k] || NUM.test(r[k].replace(/\*\*/g, ""))));
    const wrap = el("div", "lpc-tw");
    const t = el("table");
    const tr = el("tr");
    head.forEach((h, k) => tr.append(inline(h, el("th", numeric[k] ? "lpc-num" : ""))));
    const thead = el("thead");
    thead.append(tr);
    const tbody = el("tbody");
    for (const r of rows) {
      const row = el("tr");
      for (let k = 0; k < n; k++) row.append(inline(r[k] || "", el("td", numeric[k] ? "lpc-num" : "")));
      tbody.append(row);
    }
    t.append(thead, tbody);
    wrap.append(t);
    return wrap;
  }
  function markdown(src) {
    const frag = document.createDocumentFragment();
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    let para = [];
    const endPara = () => {
      if (!para.length) return;
      const p = el("p");
      para.forEach((l, k) => {
        if (k) p.append(el("br"));
        inline(l, p);
      });
      frag.append(p);
      para = [];
    };
    for (let i = 0; i < lines.length; ) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        endPara();
        const body = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
        i++;
        const pre = el("pre");
        pre.append(el("code", "", body.join("\n")));
        frag.append(pre);
        continue;
      }
      if (!line.trim()) {
        endPara();
        i++;
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && SEP.test(lines[i + 1]) && cells(lines[i + 1]).length === cells(line).length) {
        endPara();
        const block = [line, lines[i + 1]];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) block.push(lines[i]);
        frag.append(table(block));
        continue;
      }
      if (ITEM.test(line)) {
        endPara();
        const first = ITEM.exec(line);
        const list = el(/\d/.test(first[2]) ? "ol" : "ul");
        if (list.tagName === "OL" && parseInt(first[2], 10) > 1) list.start = parseInt(first[2], 10);
        const base = first[1].length;
        let li = null;
        let sub = null;
        for (; i < lines.length; i++) {
          const m = ITEM.exec(lines[i]);
          if (m && m[1].length <= base + 1) {
            li = inline(m[3], el("li"));
            list.append(li);
            sub = null;
          } else if (m && li) {
            if (!sub) {
              sub = el(/\d/.test(m[2]) ? "ol" : "ul");
              li.append(sub);
            }
            sub.append(inline(m[3], el("li")));
          } else if (li && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
            li.append(el("br"));
            inline(lines[i].trim(), li);
          } else break;
        }
        frag.append(list);
        continue;
      }
      const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (h) {
        endPara();
        const p = el("p");
        p.append(inline(h[1].replace(/\s#+\s*$/, ""), el("strong")));
        frag.append(p);
        i++;
        continue;
      }
      para.push(line.replace(/^\s*>\s?/, ""));
      i++;
    }
    endPara();
    return frag;
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
      const b = el("div", `lpc-msg ${role === "user" ? "lpc-user" : "lpc-bot"}`, role === "user" ? text : undefined);
      if (role !== "user" && text) b.append(markdown(text));
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
      // Each run of text the model writes is its own segment: a new text part (id) or a
      // tool call ends one. Text written before a tool call is narration ("Adding it."),
      // shown muted and kept out of the reply that history and the next turn see.
      const segments = [];
      let textId = null;
      let frame = 0;
      const paint = () => {
        frame = 0;
        if (bot) bot.replaceChildren(markdown(answer));
        scroll();
      };
      // The store writes to Superset inside the edit tool, so by the time a tool's output
      // arrives the board version has moved: say "saved" then, not after the reviewer.
      let savedAt = null;
      let saving = null;
      const checkSaved = async () => {
        if (savedAt !== null || before === null) return;
        let v = null;
        try {
          v = await version();
        } catch (e) {}
        if (v === null || v <= before || savedAt !== null) return;
        savedAt = v;
        since = v;
        persist();
        if (opts.reloadsPage) note("Saved to Superset. The dashboard refreshes when the reviewer finishes.", "sync");
        else {
          note("Saved to Superset. Refreshing the dashboard…", "sync");
          if (opts.onChanged) opts.onChanged();
        }
      };
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
                  if (bot && ev.id && textId && ev.id !== textId && answer.trim()) {
                    segments.push(answer);
                    bot = null;
                    answer = "";
                  }
                  textId = ev.id || textId;
                  if (!bot) bot = bubble("assistant", "");
                  answer += ev.delta;
                  if (!frame) frame = requestAnimationFrame(paint);
                  break;
                case "tool-input-available": {
                  if (bot && answer.trim()) {
                    paint();
                    bot.classList.add("lpc-pre");
                    segments.push(answer);
                  } else if (bot) bot.remove();
                  bot = null;
                  answer = "";
                  if (ev.toolName === "get_board" || ev.toolName === "list_metrics") break;
                  if (!steps) {
                    steps = el("div", "lpc-steps");
                    log.append(steps);
                  }
                  const s = el("div", "lpc-step run", describe(ev.toolName, ev.input));
                  steps.append(s);
                  calls[ev.toolCallId] = s;
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
                  if (!bad) saving = checkSaved();
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
        if (frame) cancelAnimationFrame(frame);
        paint();
        // The reply is the text after the last tool call; when the model wrote nothing
        // after it, fall back to its last narration so the turn is not empty.
        const reply = answer.trim() ? answer : segments[segments.length - 1] || "";
        history.push({ id: `a${Date.now()}`, role: "assistant", parts: [{ type: "text", text: reply || "(no answer)" }] });
        status.textContent = "";
        if (saving) await saving;
        let after = null;
        try {
          after = await version();
        } catch (e) {}
        since = after ?? since;
        persist();
        if (savedAt !== null) {
          // Already said "saved" mid-turn. Beside refreshed then; refresh again only if a later
          // edit in this turn moved the version further. Inside reloads now the reviewer is done.
          if (opts.reloadsPage) {
            try {
              sessionStorage.setItem(key, JSON.stringify({ messages: history.slice(-30), since, notice: "Saved to Superset." }));
            } catch (e) {}
            if (opts.onChanged) opts.onChanged();
          } else if (after !== null && after > savedAt && opts.onChanged) opts.onChanged();
        } else if (before !== null && after !== null && after > before) {
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

  window.LenspackChat = { mount, markdown };
})();
