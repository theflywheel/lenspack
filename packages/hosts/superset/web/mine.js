// "My dashboards" and "Saved layouts": two menus in the chat panel's header, and the chat's offer of an own
// copy when someone who can only view a dashboard asks to change it. Self-contained: chat.js calls attach()
// once per panel and passes tool results to onTool(); everything else is here. Talks to Lenspack's
// /_superset/my routes (docs/my-dashboards.md); every right is checked there, never here.
(function () {
  if (window.LenspackMine) return;

  const CSS = `
.lpm{position:relative;flex:none}
.lpm>button{border:1px solid var(--lpc-line);background:var(--lpc-bg);color:var(--lpc-mute);border-radius:6px;cursor:pointer;width:32px;height:30px;display:grid;place-items:center;padding:0}
.lpm>button:hover,.lpm>button[aria-expanded=true]{border-color:var(--lpc-acc);color:var(--lpc-fg)}
.lpm>button:focus-visible,.lpm-pop button:focus-visible,.lpm-pop a:focus-visible,.lpm-pop input:focus-visible{outline:2px solid var(--lpc-acc);outline-offset:1px}
.lpm>button svg{width:16px;height:16px}
.lpm-pop{position:absolute;right:0;top:calc(100% + 4px);z-index:6;background:var(--lpc-bg);color:var(--lpc-fg);border:1px solid var(--lpc-line);border-radius:8px;box-shadow:0 8px 24px rgba(16,24,40,.14);padding:8px;width:min(300px,calc(100vw - 24px));max-height:min(70vh,460px);overflow:auto;display:none;font-size:13px}
.lpm-pop.on{display:block}
.lpm-pop h6{margin:2px 4px 6px;font-size:11px;font-weight:600;color:var(--lpc-mute);text-transform:uppercase;letter-spacing:.04em;display:flex;justify-content:space-between;gap:8px}
.lpm-pop hr{border:0;border-top:1px solid var(--lpc-line);margin:8px 0}
.lpm-act{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:none;color:var(--lpc-fg);font:inherit;padding:7px 6px;border-radius:6px;cursor:pointer;min-height:32px}
.lpm-act:hover:not(:disabled){background:var(--lpc-soft)}
.lpm-act:disabled{color:var(--lpc-mute);cursor:not-allowed}
.lpm-act svg{width:15px;height:15px;flex:none;color:var(--lpc-acc)}
.lpm-why{display:block;color:var(--lpc-mute);font-size:11.5px;padding:0 6px 4px 29px;line-height:1.35}
.lpm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.lpm-row{display:flex;align-items:center;gap:4px;padding:3px 2px 3px 6px;border-radius:6px}
.lpm-row:hover{background:var(--lpc-soft)}
.lpm-row .lpm-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lpc-fg);text-decoration:none;border:0;background:none;font:inherit;text-align:left;padding:4px 0;cursor:pointer}
.lpm-row a.lpm-name:hover{text-decoration:underline}
.lpm-row small{color:var(--lpc-mute);font-size:11px;white-space:nowrap}
.lpm-ico{border:0;background:none;color:var(--lpc-mute);cursor:pointer;width:30px;height:30px;border-radius:6px;display:grid;place-items:center;flex:none;padding:0}
.lpm-ico:hover:not(:disabled){color:var(--lpc-fg);background:var(--lpc-line)}
.lpm-ico.bad:hover:not(:disabled){color:var(--lpc-bad)}
.lpm-ico:disabled{opacity:.4;cursor:not-allowed}
.lpm-ico svg{width:15px;height:15px}
.lpm-pill{border:1px solid var(--lpc-acc);color:var(--lpc-acc);background:none;border-radius:6px;font:inherit;font-size:12px;font-weight:600;padding:3px 8px;cursor:pointer;min-height:28px}
.lpm-pill:hover:not(:disabled){background:var(--lpc-acc-soft)}
.lpm-pill:disabled{opacity:.45;cursor:not-allowed}
.lpm-form{display:flex;flex-direction:column;gap:6px;padding:6px;margin:2px 0 4px;background:var(--lpc-soft);border-radius:6px}
.lpm-form label{font-size:12px;color:var(--lpc-mute)}
.lpm-form input{font:inherit;padding:6px 8px;border:1px solid var(--lpc-line);border-radius:6px;background:var(--lpc-bg);color:var(--lpc-fg);width:100%}
.lpm-form .lpm-btns{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.lpm-go{border:0;background:var(--lpc-acc);color:#fff;border-radius:6px;font:inherit;font-weight:600;padding:5px 12px;cursor:pointer;min-height:30px}
.lpm-go.bad{background:var(--lpc-bad)}
.lpm-go:disabled{opacity:.5;cursor:default}
.lpm-no{border:1px solid var(--lpc-line);background:var(--lpc-bg);color:var(--lpc-fg);border-radius:6px;font:inherit;padding:5px 12px;cursor:pointer;min-height:30px}
.lpm-empty{color:var(--lpc-mute);padding:2px 6px 4px}
.lpm-err{color:var(--lpc-bad);padding:2px 6px;font-size:12px}
.lpm-offer{align-self:stretch;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px;color:var(--lpc-mute);border-left:3px solid var(--lpc-acc);padding:4px 8px}
[data-lp-theme=dark] .lpm-pop{box-shadow:0 8px 24px rgba(0,0,0,.5)}
@media (max-width:420px){.lpm-pop{position:fixed;left:12px;right:12px;top:64px;width:auto}}
`;

  const S = {
    en: {
      dashboards: "My dashboards", layouts: "Saved layouts", newDash: "New dashboard", copyThis: "Make my own copy of this dashboard", title: "Title", create: "Create", copy: "Make copy", cancel: "Cancel",
      mine: "Yours", none: "None yet.", open: "Open {0}", del: "Delete {0}", confirmDel: "Delete “{0}”? Its charts go with it. This can't be undone.", delete: "Delete", deleted: "Deleted “{0}”.",
      saveCurrent: "Save this layout", name: "Name", save: "Save", saved: "Saved the layout as “{0}”.", apply: "Apply", applyTo: "Apply {0} to this dashboard", applied: "Applied the layout “{0}”.", left: "Left out: {0}.", saveHint: "Charts made in Superset ({0} here) stay with this dashboard: a saved layout takes only the others to another dashboard.", stayed: "Charts made in Superset stay with their dashboard, so this layout carried {0} of {1} charts.", mostStay: "{0} of this layout's {1} charts were made in Superset and stay with “{2}”. Your own copy of that dashboard keeps them all.", openCopy: "Open “{0}” to copy it", applyAnyway: "Apply anyway",
      rename: "Rename {0}", renamed: "Renamed to “{0}”.", confirmLayoutDel: "Delete the saved layout “{0}”? Dashboards keep their charts.", noEdit: "You can't edit this dashboard. Make your own copy first, then apply the layout there.",
      readOnlyRole: "Your Superset role can view dashboards but not make them. A Superset admin can give you a role that can.", limitD: "{0} of {1}", off: "Turned off on this deployment.", copyNo: "You can't copy this dashboard.", fullD: "You have the most dashboards allowed ({0}). Delete one first.", fullL: "You have the most saved layouts allowed ({0}). Delete one first.",
      viewOnly: "You can only view this dashboard.", offer: "Make my own copy", copyToEdit: "Make my own copy to edit", ownOnly: "On this deployment, {name} changes only your own dashboards. Make your own copy to edit, then apply the layout there.", ownOnlyChat: "{name} changes only your own dashboards here.", offerDone: "Made your copy “{0}”. Opening it to make the change there…", made: "Made “{0}”.", openIt: "Open it", undo: "Undo", undone: "Layout undone.",
      working: "Working…", by: "by {0}", failed: "That didn't work: {0}", menuD: "My dashboards: make one, copy this one, open or delete yours", menuL: "Saved layouts: save this one, apply one here",
    },
    fr: {
      dashboards: "Mes tableaux de bord", layouts: "Dispositions enregistrées", newDash: "Nouveau tableau de bord", copyThis: "Faire ma copie de ce tableau de bord", title: "Titre", create: "Créer", copy: "Copier", cancel: "Annuler",
      mine: "Les vôtres", none: "Aucun pour l'instant.", open: "Ouvrir {0}", del: "Supprimer {0}", confirmDel: "Supprimer « {0} » ? Ses graphiques partent avec lui. C'est définitif.", delete: "Supprimer", deleted: "« {0} » supprimé.",
      saveCurrent: "Enregistrer cette disposition", name: "Nom", save: "Enregistrer", saved: "Disposition enregistrée sous « {0} ».", apply: "Appliquer", applyTo: "Appliquer {0} à ce tableau de bord", applied: "Disposition « {0} » appliquée.", left: "Laissés de côté : {0}.", saveHint: "Les graphiques créés dans Superset ({0} ici) restent sur ce tableau de bord : une disposition enregistrée n'emporte que les autres vers un autre tableau de bord.", stayed: "Les graphiques créés dans Superset restent sur leur tableau de bord : cette disposition a apporté {0} graphiques sur {1}.", mostStay: "{0} des {1} graphiques de cette disposition ont été créés dans Superset et restent sur « {2} ». Votre propre copie de ce tableau de bord les garde tous.", openCopy: "Ouvrir « {0} » pour le copier", applyAnyway: "Appliquer quand même",
      rename: "Renommer {0}", renamed: "Renommée en « {0} ».", confirmLayoutDel: "Supprimer la disposition « {0} » ? Les tableaux de bord gardent leurs graphiques.", noEdit: "Vous ne pouvez pas modifier ce tableau de bord. Faites d'abord votre copie, puis appliquez-y la disposition.",
      readOnlyRole: "Votre rôle Superset permet de consulter les tableaux de bord, pas d'en créer. Un administrateur Superset peut vous donner un rôle qui le permet.", limitD: "{0} sur {1}", off: "Désactivé sur ce déploiement.", copyNo: "Vous ne pouvez pas copier ce tableau de bord.", fullD: "Vous avez le maximum de tableaux de bord ({0}). Supprimez-en un d'abord.", fullL: "Vous avez le maximum de dispositions ({0}). Supprimez-en une d'abord.",
      viewOnly: "Vous pouvez seulement consulter ce tableau de bord.", offer: "Faire ma copie", copyToEdit: "Faire ma copie pour la modifier", ownOnly: "Ici, {name} ne modifie que vos propres tableaux de bord. Faites votre copie pour la modifier, puis appliquez-y la disposition.", ownOnlyChat: "Ici, {name} ne modifie que vos propres tableaux de bord.", offerDone: "Copie « {0} » créée. Ouverture pour y faire la modification…", made: "« {0} » créé.", openIt: "L'ouvrir", undo: "Annuler", undone: "Disposition annulée.",
      working: "En cours…", by: "de {0}", failed: "Échec : {0}", menuD: "Mes tableaux de bord : en créer un, copier celui-ci, ouvrir ou supprimer les vôtres", menuL: "Dispositions enregistrées : enregistrer celle-ci, en appliquer une ici",
    },
    pt: {
      dashboards: "Os meus painéis", layouts: "Disposições guardadas", newDash: "Novo painel", copyThis: "Fazer a minha cópia deste painel", title: "Título", create: "Criar", copy: "Copiar", cancel: "Cancelar",
      mine: "Os seus", none: "Nenhum ainda.", open: "Abrir {0}", del: "Eliminar {0}", confirmDel: "Eliminar “{0}”? Os gráficos vão com ele. Não é possível desfazer.", delete: "Eliminar", deleted: "“{0}” eliminado.",
      saveCurrent: "Guardar esta disposição", name: "Nome", save: "Guardar", saved: "Disposição guardada como “{0}”.", apply: "Aplicar", applyTo: "Aplicar {0} a este painel", applied: "Disposição “{0}” aplicada.", left: "Deixados de fora: {0}.", saveHint: "Os gráficos criados no Superset ({0} aqui) ficam neste painel: uma disposição guardada leva só os outros para outro painel.", stayed: "Os gráficos criados no Superset ficam no seu painel, por isso esta disposição trouxe {0} de {1} gráficos.", mostStay: "{0} dos {1} gráficos desta disposição foram criados no Superset e ficam em “{2}”. A sua própria cópia desse painel guarda-os todos.", openCopy: "Abrir “{0}” para o copiar", applyAnyway: "Aplicar mesmo assim",
      rename: "Mudar o nome de {0}", renamed: "Novo nome: “{0}”.", confirmLayoutDel: "Eliminar a disposição “{0}”? Os painéis mantêm os gráficos.", noEdit: "Não pode alterar este painel. Faça primeiro a sua cópia e aplique lá a disposição.",
      readOnlyRole: "O seu perfil no Superset permite ver painéis, mas não criá-los. Um administrador do Superset pode dar-lhe um perfil que o permita.", limitD: "{0} de {1}", off: "Desativado nesta instalação.", copyNo: "Não pode copiar este painel.", fullD: "Já tem o número máximo de painéis ({0}). Elimine um primeiro.", fullL: "Já tem o número máximo de disposições ({0}). Elimine uma primeiro.",
      viewOnly: "Só pode consultar este painel.", offer: "Fazer a minha cópia", copyToEdit: "Fazer a minha cópia para alterar", ownOnly: "Aqui, {name} só altera os seus próprios painéis. Faça a sua cópia para alterar e aplique lá a disposição.", ownOnlyChat: "Aqui, {name} só altera os seus próprios painéis.", offerDone: "Cópia “{0}” criada. A abrir para fazer lá a alteração…", made: "“{0}” criado.", openIt: "Abrir", undo: "Desfazer", undone: "Disposição desfeita.",
      working: "A trabalhar…", by: "de {0}", failed: "Não funcionou: {0}", menuD: "Os meus painéis: criar um, copiar este, abrir ou eliminar os seus", menuL: "Disposições guardadas: guardar esta, aplicar uma aqui",
    },
    hi: {
      dashboards: "मेरे डैशबोर्ड", layouts: "सहेजे गए लेआउट", newDash: "नया डैशबोर्ड", copyThis: "इस डैशबोर्ड की अपनी कॉपी बनाएँ", title: "शीर्षक", create: "बनाएँ", copy: "कॉपी बनाएँ", cancel: "रद्द करें",
      mine: "आपके", none: "अभी कोई नहीं।", open: "{0} खोलें", del: "{0} मिटाएँ", confirmDel: "“{0}” मिटाएँ? इसके चार्ट भी मिट जाएँगे। यह वापस नहीं होगा।", delete: "मिटाएँ", deleted: "“{0}” मिटा दिया गया।",
      saveCurrent: "यह लेआउट सहेजें", name: "नाम", save: "सहेजें", saved: "लेआउट “{0}” नाम से सहेजा गया।", apply: "लागू करें", applyTo: "{0} इस डैशबोर्ड पर लागू करें", applied: "लेआउट “{0}” लागू किया गया।", left: "छोड़े गए: {0}।", saveHint: "Superset में बने चार्ट (यहाँ {0}) इसी डैशबोर्ड पर रहते हैं: सहेजा गया लेआउट दूसरे डैशबोर्ड पर सिर्फ़ बाकी चार्ट ले जाता है।", stayed: "Superset में बने चार्ट अपने डैशबोर्ड पर ही रहते हैं, इसलिए यह लेआउट {1} में से {0} चार्ट लाया।", mostStay: "इस लेआउट के {1} में से {0} चार्ट Superset में बने हैं और “{2}” पर ही रहते हैं। उस डैशबोर्ड की अपनी कॉपी में वे सब रहते हैं।", openCopy: "कॉपी करने के लिए “{0}” खोलें", applyAnyway: "फिर भी लागू करें",
      rename: "{0} का नाम बदलें", renamed: "नया नाम “{0}”।", confirmLayoutDel: "सहेजा गया लेआउट “{0}” मिटाएँ? डैशबोर्ड के चार्ट बने रहेंगे।", noEdit: "आप यह डैशबोर्ड बदल नहीं सकते। पहले अपनी कॉपी बनाएँ, फिर उस पर लेआउट लागू करें।",
      readOnlyRole: "आपकी Superset भूमिका से आप डैशबोर्ड देख सकते हैं, बना नहीं सकते। Superset एडमिन आपको ऐसी भूमिका दे सकते हैं जिससे बना सकें।", limitD: "{1} में से {0}", off: "इस डिप्लॉयमेंट पर बंद है।", copyNo: "आप यह डैशबोर्ड कॉपी नहीं कर सकते।", fullD: "आपके पास अधिकतम डैशबोर्ड ({0}) हैं। पहले एक मिटाएँ।", fullL: "आपके पास अधिकतम सहेजे लेआउट ({0}) हैं। पहले एक मिटाएँ।",
      viewOnly: "आप यह डैशबोर्ड सिर्फ़ देख सकते हैं।", offer: "मेरी अपनी कॉपी बनाएँ", copyToEdit: "बदलने के लिए अपनी कॉपी बनाएँ", ownOnly: "यहाँ {name} सिर्फ़ आपके अपने डैशबोर्ड बदलता है। बदलने के लिए अपनी कॉपी बनाएँ, फिर उस पर लेआउट लागू करें।", ownOnlyChat: "यहाँ {name} सिर्फ़ आपके अपने डैशबोर्ड बदलता है।", offerDone: "आपकी कॉपी “{0}” बन गई। बदलाव करने के लिए उसे खोला जा रहा है…", made: "“{0}” बन गया।", openIt: "खोलें", undo: "वापस लाएँ", undone: "लेआउट हटाया गया।",
      working: "काम चल रहा है…", by: "{0} का", failed: "नहीं हो पाया: {0}", menuD: "मेरे डैशबोर्ड: नया बनाएँ, इसकी कॉपी बनाएँ, अपने खोलें या मिटाएँ", menuL: "सहेजे गए लेआउट: यह सहेजें, कोई यहाँ लागू करें",
    },
  };

  const ICON = {
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>',
  };

  /** A question waiting for a dashboard that is about to open (asked on another, which this person can only view). */
  const PENDING = "lenspack-pending:";
  const OPEN = "lenspack-overlay-open";

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgButton(cls, svg, label) {
    const b = el("button", cls);
    b.type = "button";
    b.innerHTML = svg;
    b.setAttribute("aria-label", label);
    b.title = label;
    return b;
  }
  const fmt = (s, ...a) => String(s).replace(/\{(\d)\}/g, (_, i) => (a[i] === undefined ? "" : a[i]));

  /**
   * ctx: { head, before, api, pack, board, lang(), send(text), note(text, cls), log, scroll(), features(), busy(),
   * openDashboard(id)?, onChanged()?, name()? }; name() is the assistant's name in the panel's language ({name} below). Returns { onTool(name, output), relabel(), start() }.
   */
  function attach(ctx) {
    if (!document.getElementById("lpm-css")) {
      const s = el("style");
      s.id = "lpm-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const t = (k, ...a) => fmt(String((S[ctx.lang()] || S.en)[k] || S.en[k] || k).replace(/\{name\}/g, () => (ctx.name && ctx.name()) || "Lenspack"), ...a);
    const dashboardId = Number(String(ctx.board).replace(/^superset-/, "")) || null;
    const my = (path, q) => `${ctx.api}/_superset/my${path || ""}${q ? `?${q}` : ""}`;
    const here = dashboardId ? `dashboard=${dashboardId}` : "";
    async function call(method, path, body, withHere) {
      const r = await fetch(my(path, withHere ? here : ""), { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let out = {};
      try {
        out = await r.json();
      } catch (e) {}
      if (!r.ok || out.ok === false) throw Object.assign(new Error(out.error || `${r.status}`), { code: out.code, status: r.status });
      return out;
    }
    function open(id) {
      if (ctx.openDashboard) return ctx.openDashboard(id);
      try {
        sessionStorage.setItem(OPEN, String(id));
      } catch (e) {}
      location.assign(`/superset/dashboard/${id}/`);
    }
    const pendFor = (id, text) => {
      try {
        if (text) sessionStorage.setItem(`${PENDING}superset-${id}`, text);
      } catch (e) {}
    };

    let state = null;
    const menus = [];
    function makeMenu(icon, labelKey, helpKey, render) {
      const box = el("div", "lpm");
      const btn = svgButton("", icon, t(helpKey));
      btn.setAttribute("aria-haspopup", "dialog");
      btn.setAttribute("aria-expanded", "false");
      const pop = el("div", "lpm-pop");
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", t(labelKey));
      pop.id = `lpm-${labelKey}-${Math.random().toString(36).slice(2, 7)}`;
      btn.setAttribute("aria-controls", pop.id);
      box.append(btn, pop);
      const m = { box, btn, pop, labelKey, helpKey, render, show };
      function show(on) {
        for (const o of menus) if (o !== m && on) o.show(false);
        pop.classList.toggle("on", on);
        btn.setAttribute("aria-expanded", on ? "true" : "false");
        if (on) refresh(m, true);
      }
      btn.onclick = (e) => {
        e.stopPropagation();
        show(!pop.classList.contains("on"));
      };
      pop.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        show(false);
        btn.focus();
      });
      document.addEventListener("pointerdown", (e) => {
        if (!box.contains(e.target)) show(false);
      });
      menus.push(m);
      return m;
    }
    async function refresh(m, focus) {
      try {
        state = await call("GET", "", null, true);
      } catch (e) {
        state = state || { error: e.message };
      }
      m.render(m.pop, state || {});
      if (focus) {
        const first = m.pop.querySelector("button:not(:disabled),a,input");
        if (first) first.focus();
      }
    }
    const rerender = () => menus.forEach((m) => m.pop.classList.contains("on") && m.render(m.pop, state || {}));

    /** An inline form (no prompt()): a labelled input and its buttons. */
    function form(container, labelKey, value, goKey, onGo, danger) {
      const f = el("form", "lpm-form");
      let input = null;
      if (labelKey) {
        const id = `lpm-in-${Math.random().toString(36).slice(2, 8)}`;
        const l = el("label", "", t(labelKey));
        l.htmlFor = id;
        input = el("input");
        input.id = id;
        input.maxLength = 160;
        input.value = value || "";
        f.append(l, input);
      } else if (value) f.append(el("div", "", value));
      const err = el("div", "lpm-err");
      err.setAttribute("role", "alert");
      err.hidden = true;
      const btns = el("div", "lpm-btns");
      const no = el("button", "lpm-no", t("cancel"));
      no.type = "button";
      const go = el("button", `lpm-go${danger ? " bad" : ""}`, t(goKey));
      go.type = "submit";
      btns.append(no, go);
      f.append(err, btns);
      no.onclick = () => {
        f.remove();
        rerender();
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        go.disabled = true;
        go.textContent = t("working");
        try {
          await onGo(input ? input.value.trim() : "");
        } catch (x) {
          err.textContent = t("failed", x.message);
          err.hidden = false;
          go.disabled = false;
          go.textContent = t(goKey);
        }
      };
      container.replaceChildren(f);
      (input || go).focus();
      if (input) input.select();
      return f;
    }
    function action(icon, labelKey, onClick, why) {
      const wrap = el("div");
      const b = el("button", "lpm-act");
      b.type = "button";
      b.innerHTML = icon;
      b.append(document.createTextNode(t(labelKey)));
      b.disabled = !!why;
      b.onclick = onClick;
      wrap.append(b);
      if (why) {
        const w = el("span", "lpm-why", why);
        w.id = `lpm-why-${Math.random().toString(36).slice(2, 8)}`;
        b.setAttribute("aria-describedby", w.id);
        wrap.append(w);
      }
      return wrap;
    }

    // ---- My dashboards
    const dashMenu = makeMenu(ICON.dash, "dashboards", "menuD", (pop, s) => {
      pop.replaceChildren();
      if (s.error) return pop.append(el("div", "lpm-err", t("failed", s.error)));
      if (!s.on) return pop.append(el("h6", "", t("dashboards")), el("div", "lpm-empty", t("off")));
      const slot = el("div");
      const max = s.limits ? s.limits.maxDashboardsPerUser : 0;
      const full = (s.dashboards || []).length >= max ? t("fullD", max) : "";
      // A Superset role that can't write dashboards: no create or copy, and a plain line saying why.
      if (s.canWrite === false) pop.append(el("div", "lpm-offer", t("readOnlyRole")));
      else
        pop.append(
          action(ICON.plus, "newDash", () =>
            form(slot, "title", "", "create", async (title) => {
              const r = await call("POST", "/dashboards", { title });
              ctx.note(t("made", r.title), "sync");
              open(r.dashboard);
            }), full || null),
        );
      if (s.here && s.canWrite !== false) {
        const why = !s.here.canCopy ? full || t("copyNo") : null;
        pop.append(
          action(ICON.copy, s.here.byScope ? "copyToEdit" : "copyThis", () =>
            form(slot, "title", "", "copy", async (title) => {
              const r = await call("POST", "/dashboards", { copy: true, title }, true);
              ctx.note(t("made", r.title), "sync");
              open(r.dashboard);
            }), why),
        );
      }
      pop.append(slot, el("hr"));
      const h = el("h6");
      h.append(el("span", "", t("mine")), el("span", "", t("limitD", (s.dashboards || []).length, max)));
      pop.append(h);
      if (!(s.dashboards || []).length) return pop.append(el("div", "lpm-empty", t("none")));
      const list = el("ul", "lpm-list");
      for (const d of s.dashboards) {
        const li = el("li");
        const row = el("div", "lpm-row");
        const a = el("a", "lpm-name", d.title);
        a.href = ctx.openDashboard ? "#" : d.url || `/superset/dashboard/${d.dashboard}/`;
        a.setAttribute("aria-label", t("open", d.title));
        if (d.dashboard === dashboardId) a.setAttribute("aria-current", "page");
        a.onclick = (e) => {
          e.preventDefault();
          open(d.dashboard);
        };
        const del = svgButton("lpm-ico bad", ICON.trash, t("del", d.title));
        const confirmSlot = el("div");
        del.onclick = () =>
          form(confirmSlot, null, t("confirmDel", d.title), "delete", async () => {
            await call("POST", "/dashboards/delete", { dashboard: d.dashboard });
            ctx.note(t("deleted", d.title), "sync");
            // Deleted the one this panel is on: go to Superset's list.
            if (d.dashboard === dashboardId && !ctx.openDashboard) return location.assign("/dashboard/list/");
            refresh(dashMenu, false);
          }, true);
        row.append(a, del);
        li.append(row, confirmSlot);
        list.append(li);
      }
      pop.append(list);
    });

    // ---- Saved layouts
    const layoutMenu = makeMenu(ICON.layout, "layouts", "menuL", (pop, s) => {
      pop.replaceChildren();
      if (s.error) return pop.append(el("div", "lpm-err", t("failed", s.error)));
      if (!s.on) return pop.append(el("h6", "", t("layouts")), el("div", "lpm-empty", t("off")));
      const slot = el("div");
      const max = s.limits ? s.limits.maxSavedLayoutsPerUser : 0;
      if (s.here) {
        const full = s.ownLayouts >= max ? t("fullL", max) : "";
        pop.append(
          action(ICON.save, "saveCurrent", () =>
            form(slot, "name", "", "save", async (name) => {
              const r = await call("POST", "/layouts", { name }, true);
              ctx.note(`${t("saved", r.name)}${r.superset ? ` ${t("saveHint", r.superset)}` : ""}`, "sync");
              refresh(layoutMenu, false);
            }), s.here.canSave ? null : full || t("copyNo")),
        );
        if (s.here.superset) pop.append(el("div", "lpm-offer", t("saveHint", s.here.superset)));
      }
      pop.append(slot);
      const canApply = !!(s.here && s.here.edit);
      if (s.here && !canApply) {
        const n = el("div", "lpm-offer", t(s.here.byScope ? "ownOnly" : "noEdit"));
        if (s.here.canCopy) {
          const b = el("button", "lpm-pill", t(s.here.byScope ? "copyToEdit" : "offer"));
          b.type = "button";
          b.onclick = () => copyAndGo(null);
          n.append(b);
        }
        pop.append(n);
      }
      pop.append(el("hr"));
      const h = el("h6");
      h.append(el("span", "", t("layouts")), el("span", "", t("limitD", s.ownLayouts || 0, max)));
      pop.append(h);
      if (!(s.layouts || []).length) return pop.append(el("div", "lpm-empty", t("none")));
      const list = el("ul", "lpm-list");
      for (const l of s.layouts) {
        const li = el("li");
        const row = el("div", "lpm-row");
        const name = el("span", "lpm-name", l.name);
        name.title = l.from ? `${l.name} · ${l.from}` : l.name;
        row.append(name);
        // An admin sees everyone's: whose each one is.
        if (s.layouts.some((x) => x.owner !== l.owner)) row.append(el("small", "", t("by", l.owner)));
        const sub = el("div");
        const apply = el("button", "lpm-pill", t("apply"));
        apply.type = "button";
        apply.disabled = !canApply;
        apply.setAttribute("aria-label", t("applyTo", l.name));
        const go = async () => {
          apply.disabled = true;
          try {
            const r = await call("POST", `/layouts/${encodeURIComponent(l.id)}/apply`, {}, true);
            appliedNote(r);
            dashMenu.show(false);
            layoutMenu.show(false);
            if (ctx.onChanged) ctx.onChanged();
          } catch (x) {
            sub.replaceChildren(el("div", "lpm-err", t("failed", x.message)));
            apply.disabled = false;
          }
        };
        // Most of its charts were made in Superset and stay with the dashboard it came from: their own copy of that
        // dashboard is the better way to keep them, so say so before applying.
        apply.onclick = () => {
          if (!(l.superset && l.superset * 2 > l.widgets && l.fromDashboard !== dashboardId)) return go();
          const n = el("div", "lpm-offer", t("mostStay", l.superset, l.widgets, l.from));
          if (l.fromDashboard) {
            // Opens that dashboard with the panel open, where "Make my own copy" is.
            const o = el("button", "lpm-pill", t("openCopy", l.from));
            o.type = "button";
            o.onclick = () => open(l.fromDashboard);
            n.append(o);
          }
          const b = el("button", "lpm-pill", t("applyAnyway"));
          b.type = "button";
          b.onclick = () => (sub.replaceChildren(), go());
          n.append(b);
          sub.replaceChildren(n);
          b.focus();
        };
        const ren = svgButton("lpm-ico", ICON.pencil, t("rename", l.name));
        ren.onclick = () =>
          form(sub, "name", l.name, "save", async (n) => {
            const r = await call("POST", `/layouts/${encodeURIComponent(l.id)}/rename`, { name: n });
            ctx.note(t("renamed", r.name), "sync");
            refresh(layoutMenu, false);
          });
        const del = svgButton("lpm-ico bad", ICON.trash, t("del", l.name));
        del.onclick = () =>
          form(sub, null, t("confirmLayoutDel", l.name), "delete", async () => {
            await call("POST", `/layouts/${encodeURIComponent(l.id)}/delete`, {});
            refresh(layoutMenu, false);
          }, true);
        row.append(apply, ren, del);
        li.append(row, sub);
        list.append(li);
      }
      pop.append(list);
    });

    function appliedNote(r) {
      const n = el("div", "lpc-note sync");
      n.append(document.createTextNode(`${t("applied", r.name)}${r.skipped && r.skipped.length ? ` ${t("left", r.skipped.map((s) => `“${s.title}”`).join(", "))}` : ""}${r.carried && r.carried.stayed ? ` ${t("stayed", r.carried.widgets, r.carried.of)}` : ""}`));
      if (typeof r.previous === "number") {
        const u = el("button", "lpc-undo", t("undo"));
        u.type = "button";
        u.onclick = async () => {
          u.disabled = true;
          try {
            const res = await fetch(`${ctx.api}/api/${encodeURIComponent(ctx.pack)}/${encodeURIComponent(ctx.board)}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: r.previous }) });
            if (!res.ok) throw new Error(String(res.status));
            ctx.note(t("undone"), "sync");
            if (ctx.onChanged) ctx.onChanged();
          } catch (x) {
            ctx.note(t("failed", x.message), "bad");
            u.disabled = false;
          }
        };
        n.append(u);
      }
      ctx.log.append(n);
      ctx.scroll();
    }

    /** Copies this dashboard for the person and opens the copy, carrying the change they asked for. */
    async function copyAndGo(then, button) {
      if (button) button.disabled = true;
      try {
        const r = await call("POST", "/dashboards", { copy: true }, true);
        pendFor(r.dashboard, then);
        ctx.note(t("offerDone", r.title), "sync");
        setTimeout(() => open(r.dashboard), 400);
      } catch (x) {
        ctx.note(t("failed", x.message), "bad");
        if (button) button.disabled = false;
      }
    }

    // The two buttons go before the New chat button.
    for (const m of [dashMenu, layoutMenu]) ctx.head.insertBefore(m.box, ctx.before);
    function relabel() {
      for (const m of menus) {
        m.btn.title = t(m.helpKey);
        m.btn.setAttribute("aria-label", t(m.helpKey));
        m.pop.setAttribute("aria-label", t(m.labelKey));
      }
      rerender();
      const on = (ctx.features() || {}).personalDashboards !== false;
      for (const m of menus) m.box.hidden = !on;
    }

    let offered = false;
    let lastUser = "";
    /** A tool's result in the chat: an offer of an own copy, a dashboard made, a layout applied. */
    function onTool(name, o) {
      if (!o || (ctx.features() || {}).personalDashboards === false) return;
      if (o.readOnly && o.offer === "copy_dashboard" && !offered) {
        offered = true;
        const n = el("div", "lpm-offer");
        n.setAttribute("role", "group");
        n.append(el("span", "", t(o.ownOnly ? "ownOnlyChat" : "viewOnly")));
        const b = el("button", "lpm-pill", t(o.ownOnly ? "copyToEdit" : "offer"));
        b.type = "button";
        const ask = lastUser;
        b.onclick = () => copyAndGo(ask, b);
        n.append(b);
        ctx.log.append(n);
        ctx.scroll();
        return;
      }
      if ((name === "create_dashboard" || name === "copy_dashboard") && o.ok && o.dashboard) {
        const n = el("div", "lpm-offer");
        n.append(el("span", "", t("made", o.title)));
        const b = el("button", "lpm-pill", t("openIt"));
        b.type = "button";
        b.onclick = () => {
          pendFor(o.dashboard, o.then);
          open(o.dashboard);
        };
        n.append(b);
        ctx.log.append(n);
        ctx.scroll();
      }
    }
    return {
      onTool,
      relabel,
      /** A new turn starts: one offer per turn, and the question it would carry to a copy. */
      turn(text) {
        offered = false;
        lastUser = text;
      },
      /** Once the panel is up: a question carried here from a dashboard this person could only view is asked now. */
      start() {
        let text = null;
        try {
          text = sessionStorage.getItem(`${PENDING}${ctx.board}`);
          sessionStorage.removeItem(`${PENDING}${ctx.board}`);
        } catch (e) {}
        if (text) setTimeout(() => ctx.send(text), 300);
      },
    };
  }

  window.LenspackMine = {
    attach,
    /** The chat's step lines for these tools. */
    TOOLS: { list_my_dashboards: "read your dashboards", create_dashboard: "made a dashboard", copy_dashboard: "made your copy", delete_dashboard: "deleted a dashboard", save_layout: "saved the layout", apply_layout: "applied a layout", rename_layout: "renamed a layout", delete_layout: "deleted a layout" },
  };
})();
