// The Lenspack admin panel: plain JavaScript, no framework, no build. Every call is relative to the
// page (api/…, ../cache), so the panel works wherever a host mounts it. English and French.
(function () {
  "use strict";

  const STRINGS = {
    en: {
      title: "Lenspack admin", pack: "Pack", loading: "Loading…", failed: "Could not load: {0}", saved: "Saved.", done: "Done.",
      tabOverview: "Overview", tabReview: "Review", tabQuestions: "Open questions", tabProposals: "Proposals", tabDefinitions: "Definitions", tabCache: "Cache", tabSettings: "Settings",
      themeAuto: "Theme: system", themeLight: "Theme: light", themeDark: "Theme: dark",
      // Overview
      lastDays: "Last {0} days", turns: "Questions", people: "People", cost: "Cost", errors: "Errors", refusals: "Refusals", findings: "Reviewer findings", openQ: "Open questions", pending: "Proposals waiting", saved$: "Saved by cache",
      day: "Day", asked: "Asked back", assumed: "Answered with a reading", picked: "Quick replies", byDay: "By day", estimateNote: "Costs are estimates from list prices.",
      usageLede: "How people use this server: a Lenspack board over the server's own record of its chat turns, drawn by the same engine as every other board. Change it like any board.", usageFrom: "From {0}.", src_telemetry: "the turn telemetry", src_audit: "the audit log", src_none: "nothing yet",
      askUsage: "Ask about usage", askUsageLede: "Questions about this board's data, answered by the assistant. Only admins see this; these questions are logged and costed, but left out of the daily review.", askPlaceholder: "Which board cost most this week?", send: "Ask", thinking: "Working…", noAnswer: "No answer.",
      usageEx1: "Which board cost most this week?", usageEx2: "How many questions were answered from saved answers yesterday?", usageEx3: "Who asked the most questions in the last 30 days?",
      waiting: "Waiting for you", boardOff: "The usage board is off on this server: {0}",
      // Review
      reviewLede: "Once a day a strong model reads the day's questions and answers and proposes fixes to the definitions. Nothing is applied until you accept it.",
      reviewSettings: "Daily review settings", enabled: "Run every day", time: "Local time", tz: "Time zone", model: "Model", maxUsd: "Most per run (US$)", lookback: "Look back (hours)", minTurns: "Skip below (questions)",
      saveSettings: "Save settings", nextRun: "Next run: {0}", notScheduled: "Not scheduled: the daily review is off.", runNow: "Run now", estimating: "Estimating…", estimateTitle: "Run the review now?",
      estimateBody: "{0} questions in the period; {1} would be read ({2} shortened, {3} left out to stay within the cap). It would cost about ${4}, and at most ${5}.", confirmRun: "Run it", cancel: "Cancel", running: "A review is running…", started: "Review started.",
      runs: "Runs", noRuns: "No review has run yet.", status: "Status", when: "When", trigger: "How", schedule: "scheduled", manual: "Run now", report: "Report",
      summary: "Summary", findingsH: "Where answers went wrong", proposalsH: "Proposed fixes", questionsH: "New open questions", chartsH: "Chart candidates", problems: "Left out of the report", cited: "Turns", noItems: "None.", back: "Back to runs",
      // Questions
      qLede: "Questions that can be read more than one way, with no sane default. Answer one with a reading and it becomes a definition the assistant follows.",
      filterOpen: "Open", filterAnswered: "Answered", filterDismissed: "Dismissed", filterAll: "All", seen: "Seen {0}×", first: "first {0}", last: "last {0}", from: "from {0}",
      src_turn: "the chat", src_reviewer: "the reviewer", src_review: "the daily review", src_admin: "an admin",
      examples: "Asked as", readingsH: "Readings", compareNow: "Compare on the data", comparing: "Comparing…", answerWith: "Answer with this reading", dismiss: "Dismiss", reopen: "Reopen", edit: "Edit", why: "Why (kept in the history)",
      chosen: "Chosen", choices: "Picked in the chat: {0}", assumedN: "Assumed: {0}", noQuery: "No query: described in words only.", notRunnable: "Not runnable", addQuestion: "Add a question", pattern: "The question, in general words",
      readingsJson: "Readings (one per line: label: explanation)", add: "Add", answeredBy: "Answered by {0}, {1}", dismissedBy: "Dismissed by {0}, {1}", noQuestions: "No questions here.", top: "Top groups", value: "Value", group: "Group",
      // Proposals
      pLede: "Edits to the definitions proposed by the daily review, each with why and the questions it would fix. Accepting writes the definitions; nothing changes until you do.",
      accept: "Accept", editAccept: "Edit, then accept", reject: "Reject", rejectWhy: "Why reject? (optional)", noProposals: "No proposals waiting.", decided: "Decided", kind: "Kind", key: "Key", text: "Text", when2: "When", words: "Words (comma-separated)", rationale: "Why",
      kind_instruction: "Instruction", kind_hint: "Hint", kind_synonym: "Synonyms", kind_definition: "Definition", accepted: "accepted", rejected: "rejected", fromRun: "from the review of {0}",
      // Definitions
      dLede: "What admins have added to the pack on this server. It is sent with every question, applies at once with no restart, and never changes the deployment's own pack file.",
      budget: "{0} of {1} characters", version: "Version {0}", defsVersion: "Definitions version", addDef: "Add a definition", remove: "Remove", undo: "Undo last change", restore: "Restore", history: "History", noDefs: "Nothing added yet.",
      packOwn: "The pack's own instructions (read only)", none: "(none)", by: "by {0}", removeWhy: "Why remove it?", save: "Save", whenHelp: "The kind of question it settles", textHelpDef: "The reading to use",
      // Cache
      cacheOff: "Caching is not enabled on this server.", cacheLede: "Answers kept for questions that repeat, and what they saved.", since: "Since {0}", hits: "Hits", misses: "Misses", entries: "Entries", question: "Question", board: "Board", lastHit: "Last hit", pin: "Pin", unpin: "Unpin", evict: "Evict", suggestions: "Suggestions", chartCandidates: "Chart candidates", pinned: "pinned",
      tier_t1: "same question, fresh data", tier_t2: "same question, re-run", tier_t3: "another place or time", tier_t4: "other words", queueNow: "Running / waiting", queueHelp: "model turns now",
      prewarmH: "Refreshing saved answers", prewarmLast: "Last refresh {0} ({1}): {2} of {3} refreshed, {4} rewritten, {5}.", prewarmNever: "No refresh yet. Refreshes run at the times set in Settings, when the data pipeline reports a load, or now.", prewarmNow: "Refresh now",
      pwr_schedule: "scheduled", pwr_data: "data changed", pwr_admin: "by an admin", asks7d: "Asked, 7 days", dataAsOf: "Data as of", kindEdit: "board change", noEntries: "No saved answers yet.",
      suggestionsLede: "The most-asked questions on each board: the chat offers them as suggestions.", candidatesLede: "Asked often, and no chart on their board answers them.", askedN: "asked {0}×", settledH: "Settled boards", settledLede: "No change in a week.", lastEdit: "last changed {0}",
      // Settings
      sLede: "Switches for this server. A change applies to the next question. Where a value comes from: default, the config file, the environment, or this page.",
      source_default: "default", source_config: "config", source_env: "environment", source_settings: "set here", reset: "Reset to the deployment's value",
      // Telemetry
      tabTelemetry: "Telemetry", tlTitle: "What this deployment records", tlLede: "Every signal Lenspack can record for this deployment, the decision it feeds, and whether it is coming in. Print it or copy it into a pilot report.",
      tlGenerated: "Checked {0}.", tlSumRecording: "{0} of {1} recording", tlSumNoData: "{0} on but no data", tlSumConfig: "{0} need configuration", tlSumOff: "{0} off", tlSumNot: "{0} not telemetry",
      tlSwitches: "Switches", tlSwLede: "What is recorded, and for how long. A change applies to the next question.", tlOn: "on", tlOff: "off",
      tlSw_telemetry: "Record telemetry", tlSw_questionText: "Keep question text", tlSw_audio: "Keep audio", tlSw_retentionDays: "Keep for (days)",
      tlItem: "Signal", tlDecision: "Decision it drives", tl7d: "Last 7 days", tlLastSeen: "Last seen", tlNotes: "Notes", tlHow: "How to enable", tlFields: "Fields", tlPrivacy: "Privacy",
      st_recording: "recording", "st_enabled-no-data": "on, no data yet", st_off: "off", "st_needs-config": "needs configuration", "st_not-telemetry": "not telemetry",
      tlLegend: "✓ recording · ◐ on but no data · ○ off · ⚠ needs configuration · — not telemetry", tlPrint: "Print", tlCopy: "Copy as Markdown", tlCopied: "Copied.",
      tlAbsent: "Telemetry is not available on this server.", tlAbsentHelp: "This server does not report its telemetry yet. The checklist appears here once it does.", tlSwitchAbsent: "This server cannot change that setting from here.",
    },
    fr: {
      title: "Administration Lenspack", pack: "Pack", loading: "Chargement…", failed: "Chargement impossible : {0}", saved: "Enregistré.", done: "Fait.",
      tabOverview: "Vue d'ensemble", tabReview: "Revue", tabQuestions: "Questions ouvertes", tabProposals: "Propositions", tabDefinitions: "Définitions", tabCache: "Cache", tabSettings: "Réglages",
      themeAuto: "Thème : système", themeLight: "Thème : clair", themeDark: "Thème : sombre",
      lastDays: "{0} derniers jours", turns: "Questions", people: "Personnes", cost: "Coût", errors: "Erreurs", refusals: "Refus", findings: "Remarques du vérificateur", openQ: "Questions ouvertes", pending: "Propositions en attente", saved$: "Économisé par le cache",
      day: "Jour", asked: "Questions en retour", assumed: "Réponses avec une lecture", picked: "Réponses rapides", byDay: "Par jour", estimateNote: "Coûts estimés d'après les prix publics.",
      usageLede: "L'usage de ce serveur : un tableau Lenspack sur le propre relevé des échanges du serveur, dessiné par le même moteur que tous les tableaux. Modifiable comme n'importe quel tableau.", usageFrom: "Source : {0}.", src_telemetry: "la télémétrie des échanges", src_audit: "le journal d'audit", src_none: "rien pour l'instant",
      askUsage: "Questions sur l'usage", askUsageLede: "Des questions sur les données de ce tableau, auxquelles répond l'assistant. Réservé aux administrateurs ; ces questions sont journalisées et comptées, mais exclues de la revue quotidienne.", askPlaceholder: "Quel tableau a coûté le plus cette semaine ?", send: "Demander", thinking: "En cours…", noAnswer: "Pas de réponse.",
      usageEx1: "Quel tableau a coûté le plus cette semaine ?", usageEx2: "Combien de questions ont reçu une réponse enregistrée hier ?", usageEx3: "Qui a posé le plus de questions ces 30 derniers jours ?",
      waiting: "En attente de vous", boardOff: "Le tableau d'usage est désactivé sur ce serveur : {0}",
      reviewLede: "Une fois par jour, un modèle puissant lit les questions et réponses de la journée et propose des corrections aux définitions. Rien n'est appliqué sans votre accord.",
      reviewSettings: "Réglages de la revue quotidienne", enabled: "Lancer chaque jour", time: "Heure locale", tz: "Fuseau horaire", model: "Modèle", maxUsd: "Maximum par revue (US$)", lookback: "Période (heures)", minTurns: "Ignorer sous (questions)",
      saveSettings: "Enregistrer", nextRun: "Prochaine revue : {0}", notScheduled: "Pas planifiée : la revue quotidienne est désactivée.", runNow: "Lancer maintenant", estimating: "Estimation…", estimateTitle: "Lancer la revue maintenant ?",
      estimateBody: "{0} questions sur la période ; {1} seraient lues ({2} raccourcies, {3} écartées pour rester sous le plafond). Coût d'environ {4} $, au plus {5} $.", confirmRun: "Lancer", cancel: "Annuler", running: "Une revue est en cours…", started: "Revue lancée.",
      runs: "Revues", noRuns: "Aucune revue pour l'instant.", status: "État", when: "Quand", trigger: "Comment", schedule: "planifiée", manual: "manuelle", report: "Rapport",
      summary: "Résumé", findingsH: "Où les réponses ont échoué", proposalsH: "Corrections proposées", questionsH: "Nouvelles questions ouvertes", chartsH: "Graphiques à créer", problems: "Écarté du rapport", cited: "Échanges", noItems: "Aucun.", back: "Retour aux revues",
      qLede: "Des questions qui se lisent de plusieurs façons, sans choix évident. Répondez par une lecture : elle devient une définition que l'assistant suit.",
      filterOpen: "Ouvertes", filterAnswered: "Répondues", filterDismissed: "Écartées", filterAll: "Toutes", seen: "Vue {0} fois", first: "première {0}", last: "dernière {0}", from: "source : {0}",
      src_turn: "la discussion", src_reviewer: "le vérificateur", src_review: "la revue quotidienne", src_admin: "un administrateur",
      examples: "Posée ainsi", readingsH: "Lectures", compareNow: "Comparer sur les données", comparing: "Comparaison…", answerWith: "Répondre avec cette lecture", dismiss: "Écarter", reopen: "Rouvrir", edit: "Modifier", why: "Pourquoi (gardé dans l'historique)",
      chosen: "Choisie", choices: "Choisie dans la discussion : {0}", assumedN: "Supposée : {0}", noQuery: "Pas de requête : décrite en mots seulement.", notRunnable: "Non exécutable", addQuestion: "Ajouter une question", pattern: "La question, en termes généraux",
      readingsJson: "Lectures (une par ligne : libellé : explication)", add: "Ajouter", answeredBy: "Répondue par {0}, {1}", dismissedBy: "Écartée par {0}, {1}", noQuestions: "Aucune question ici.", top: "Premiers groupes", value: "Valeur", group: "Groupe",
      pLede: "Modifications des définitions proposées par la revue quotidienne, avec leur raison et les questions qu'elles corrigeraient. Accepter écrit les définitions ; rien ne change sans vous.",
      accept: "Accepter", editAccept: "Modifier puis accepter", reject: "Refuser", rejectWhy: "Pourquoi refuser ? (facultatif)", noProposals: "Aucune proposition en attente.", decided: "Traitées", kind: "Type", key: "Clé", text: "Texte", when2: "Quand", words: "Mots (séparés par des virgules)", rationale: "Pourquoi",
      kind_instruction: "Consigne", kind_hint: "Indication", kind_synonym: "Synonymes", kind_definition: "Définition", accepted: "acceptée", rejected: "refusée", fromRun: "de la revue du {0}",
      dLede: "Ce que les administrateurs ont ajouté au pack sur ce serveur. Envoyé avec chaque question, appliqué tout de suite sans redémarrage, sans jamais modifier le fichier du pack du déploiement.",
      budget: "{0} sur {1} caractères", version: "Version {0}", defsVersion: "Version des définitions", addDef: "Ajouter une définition", remove: "Retirer", undo: "Annuler la dernière modification", restore: "Restaurer", history: "Historique", noDefs: "Rien d'ajouté pour l'instant.",
      packOwn: "Consignes du pack lui-même (lecture seule)", none: "(aucune)", by: "par {0}", removeWhy: "Pourquoi la retirer ?", save: "Enregistrer", whenHelp: "Le type de question qu'elle tranche", textHelpDef: "La lecture à utiliser",
      cacheOff: "Le cache n'est pas activé sur ce serveur.", cacheLede: "Les réponses gardées pour les questions qui reviennent, et ce qu'elles ont économisé.", since: "Depuis {0}", hits: "Réutilisations", misses: "Absences", entries: "Entrées", question: "Question", board: "Tableau", lastHit: "Dernière réutilisation", pin: "Épingler", unpin: "Détacher", evict: "Retirer", suggestions: "Suggestions", chartCandidates: "Graphiques à créer", pinned: "épinglée",
      tier_t1: "même question, données récentes", tier_t2: "même question, relancée", tier_t3: "autre lieu ou période", tier_t4: "autres mots", queueNow: "En cours / en attente", queueHelp: "échanges avec le modèle",
      prewarmH: "Rafraîchir les réponses gardées", prewarmLast: "Dernier rafraîchissement {0} ({1}) : {2} sur {3} rafraîchies, {4} réécrites, {5}.", prewarmNever: "Pas encore de rafraîchissement. Ils ont lieu aux heures réglées, quand le chargement des données le signale, ou maintenant.", prewarmNow: "Rafraîchir maintenant",
      pwr_schedule: "planifié", pwr_data: "données modifiées", pwr_admin: "par un administrateur", asks7d: "Posées, 7 jours", dataAsOf: "Données du", kindEdit: "modification du tableau", noEntries: "Aucune réponse gardée pour l'instant.",
      suggestionsLede: "Les questions les plus posées sur chaque tableau : le chat les propose en suggestions.", candidatesLede: "Posées souvent, sans graphique qui y réponde sur leur tableau.", askedN: "posée {0} fois", settledH: "Tableaux stables", settledLede: "Aucun changement depuis une semaine.", lastEdit: "dernier changement {0}",
      sLede: "Les interrupteurs de ce serveur. Un changement s'applique à la question suivante. Origine de chaque valeur : défaut, fichier de configuration, environnement ou cette page.",
      source_default: "défaut", source_config: "configuration", source_env: "environnement", source_settings: "réglé ici", reset: "Revenir à la valeur du déploiement",
      tabTelemetry: "Télémétrie", tlTitle: "Ce que ce déploiement enregistre", tlLede: "Chaque signal que Lenspack peut enregistrer pour ce déploiement, la décision qu'il éclaire, et s'il arrive bien. À imprimer ou à copier dans un rapport de pilote.",
      tlGenerated: "Vérifié le {0}.", tlSumRecording: "{0} sur {1} enregistrés", tlSumNoData: "{0} activés sans données", tlSumConfig: "{0} à configurer", tlSumOff: "{0} désactivés", tlSumNot: "{0} hors télémétrie",
      tlSwitches: "Interrupteurs", tlSwLede: "Ce qui est enregistré, et pour combien de temps. Un changement s'applique à la question suivante.", tlOn: "activé", tlOff: "désactivé",
      tlSw_telemetry: "Enregistrer la télémétrie", tlSw_questionText: "Garder le texte des questions", tlSw_audio: "Garder l'audio", tlSw_retentionDays: "Conserver (jours)",
      tlItem: "Signal", tlDecision: "Décision éclairée", tl7d: "7 derniers jours", tlLastSeen: "Vu pour la dernière fois", tlNotes: "Remarques", tlHow: "Pour l'activer", tlFields: "Champs", tlPrivacy: "Confidentialité",
      st_recording: "enregistré", "st_enabled-no-data": "activé, pas encore de données", st_off: "désactivé", "st_needs-config": "à configurer", "st_not-telemetry": "hors télémétrie",
      tlLegend: "✓ enregistré · ◐ activé sans données · ○ désactivé · ⚠ à configurer · — hors télémétrie", tlPrint: "Imprimer", tlCopy: "Copier en Markdown", tlCopied: "Copié.",
      tlAbsent: "La télémétrie n'est pas disponible sur ce serveur.", tlAbsentHelp: "Ce serveur ne communique pas encore sa télémétrie. La liste apparaîtra ici dès qu'il le fera.", tlSwitchAbsent: "Ce réglage ne peut pas être modifié d'ici sur ce serveur.",
    },
  };
  // The switches' names and help in French; English comes from the server.
  const FEATURES_FR = {
    overlay: ["Bouton Demander à Lenspack", "Le bouton et la discussion sur les tableaux de bord."],
    voice: ["Saisie vocale", "Le micro dans la discussion (il faut aussi une clé de reconnaissance vocale)."],
    spaceHold: ["Maintenir Espace pour parler", "Maintenir Espace lance le micro."],
    languageMenu: ["Menu des langues", "Le choix de la langue dans la discussion."],
    markdown: ["Réponses mises en forme", "Gras, listes et tableaux dans les réponses."],
    inPlaceRefresh: ["Actualiser sur place", "Après une modification, redessiner le tableau sans recharger la page."],
    newChat: ["Bouton Nouvelle discussion", "Le bouton qui efface la conversation."],
    boardEdits: ["Modifications des tableaux", "Modifier les tableaux de bord par la discussion. Désactivé : l'assistant répond seulement aux questions."],
    heatmap: ["Cartes de chaleur", "Les cartes de chaleur créées par la discussion."],
    maps: ["Cartes", "Les cartes de points créées et lues par la discussion."],
    reviewer: ["Vérificateur", "Un second appel au modèle qui vérifie chaque modification de tableau."],
    turnCost: ["Coût par réponse", "Une ligne sous chaque réponse avec son coût estimé."],
    clarify: ["Clarifier l'intention", "Quand une question se lit de deux façons aux chiffres différents, l'assistant demande laquelle (avec des boutons) ou dit laquelle il a utilisée, et note la question pour un administrateur."],
    "review.daily": ["Revue quotidienne", "Chaque jour, un modèle puissant lit les questions et réponses et propose des corrections des définitions, à accepter ou refuser. Coûte au plus le plafond réglé. Désactivée par défaut."],
    "review.compare": ["Comparer les lectures", "Après la revue, les lectures de chaque question ouverte sont calculées sur les données, sans modèle, pour comparer les chiffres."],
  };

  // ---- State and helpers ------------------------------------------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(`lp-admin-${k}`); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(`lp-admin-${k}`, v); } catch (e) { /* private window */ } },
  };
  const params = new URLSearchParams(location.search);
  let lang = params.get("lang") || store.get("lang") || ((navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en");
  if (!STRINGS[lang]) lang = "en";
  let theme = store.get("theme") || "auto";
  let tab = (location.hash || "").slice(1) || params.get("tab") || "overview";
  let pack = params.get("pack") || store.get("pack") || "";
  let packs = [];
  let qFilter = "open";
  let usageInfo = null;
  let usageChat = [];
  let mounted = null;
  let openRun = null;

  const t = (k, ...a) => String((STRINGS[lang] && STRINGS[lang][k]) ?? STRINGS.en[k] ?? k).replace(/\{(\d)\}/g, (_, i) => (a[i] === undefined ? "" : a[i]));
  const nf = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString(lang, { maximumFractionDigits: d }));
  const usd = (v) => (v === null || v === undefined ? "—" : Number(v) < 0.01 && Number(v) > 0 ? `$${Number(v).toFixed(4)}` : `$${Number(v).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const when = (iso) => (iso ? new Date(iso).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" }) : "—");
  const dayOf = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(lang, { day: "numeric", month: "short", timeZone: "UTC" }) : "");

  /** An element: h("div", {class: "x", onclick}, "text", child, …). Text is always text. */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "value") e.value = v;
      else if (k === "checked") e.checked = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const main = document.getElementById("main");
  function toast(msg, bad) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = `toast show${bad ? " bad" : ""}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (el.className = "toast"), bad ? 6000 : 2500);
  }
  async function api(path, opts = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`api/${path}${pack ? `${sep}pack=${encodeURIComponent(pack)}` : ""}`, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: opts.body ? { "content-type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }
  /** A cache route, if the server has one: null when it does not (404). */
  async function cacheApi(path, opts = {}) {
    const res = await fetch(`../cache${path}`, { method: opts.method || "GET", credentials: "same-origin" });
    if (res.status === 404) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { return null; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }
  const act = (fn, okMsg) => async (ev) => {
    const b = ev && ev.currentTarget;
    if (b) b.disabled = true;
    try {
      await fn();
      if (okMsg !== false) toast(okMsg || t("done"));
      await render();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (b && b.isConnected) b.disabled = false;
    }
  };
  function ask(title, fields) {
    // A small dialog with text fields; resolves to their values, or null when cancelled.
    return new Promise((resolve) => {
      const inputs = fields.map((f) => (f.area ? h("textarea", { rows: 3, value: f.value || "" }) : h("input", { type: "text", value: f.value || "" })));
      const d = h("dialog", { class: "modal" },
        h("h2", { style: "font-size:15px;margin:0 0 10px" }, title),
        ...fields.map((f, i) => h("label", { class: "field", style: "margin:0 0 10px" }, h("span", {}, f.label), inputs[i])),
        h("div", { class: "actions" },
          h("button", { class: "btn", type: "button", onclick: () => { d.close(); resolve(inputs.map((x) => x.value)); } }, t("save")),
          h("button", { class: "btn quiet", type: "button", onclick: () => { d.close(); resolve(null); } }, t("cancel"))));
      d.addEventListener("cancel", () => resolve(null));
      document.body.append(d);
      d.showModal();
      d.addEventListener("close", () => d.remove());
    });
  }
  const tile = (k, v, small) => h("div", { class: "tile" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v, small ? h("small", {}, ` ${small}`) : null));
  const card = (title, lede, ...body) => h("section", { class: "card" }, title ? h("h2", {}, title) : null, lede ? h("p", { class: "lede" }, lede) : null, ...body);
  const pill = (text, cls) => h("span", { class: `pill ${cls || ""}` }, text);
  const statusPill = (s, label) => pill(label || s, s === "ok" || s === "accepted" || s === "answered" ? "ok" : s === "failed" || s === "rejected" ? "bad" : s === "running" || s === "pending" || s === "open" ? "acc" : "");
  const queryText = (q) => (q ? Object.entries(q).map(([k, v]) => `${k}=${v}`).join("  ") : "");

  // ---- Chrome -----------------------------------------------------------------------------------
  function applyChrome() {
    document.documentElement.lang = lang;
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    const tb = document.getElementById("theme");
    tb.textContent = theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐";
    tb.title = tb.ariaLabel = t(theme === "dark" ? "themeDark" : theme === "light" ? "themeLight" : "themeAuto");
    for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
    for (const b of document.querySelectorAll("#langs button")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
    for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    document.title = `${t("title")}`;
  }
  document.getElementById("theme").onclick = () => {
    theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    store.set("theme", theme);
    applyChrome();
  };
  for (const b of document.querySelectorAll("#langs button"))
    b.onclick = () => {
      lang = b.dataset.lang;
      store.set("lang", lang);
      applyChrome();
      render();
    };
  for (const b of document.querySelectorAll("#tabs button"))
    b.onclick = () => {
      tab = b.dataset.tab;
      openRun = null;
      history.replaceState(null, "", `#${tab}`);
      applyChrome();
      render();
      main.focus({ preventScroll: true });
    };
  document.getElementById("pack").onchange = (e) => {
    pack = e.target.value;
    store.set("pack", pack);
    render();
  };

  // ---- Tabs ---------------------------------------------------------------------------------------
  // The board renderer (@lenspack/react, bundled as board.js), loaded once, when the Overview first opens.
  let boardLib = null;
  function loadBoardLib() {
    if (boardLib) return boardLib;
    boardLib = new Promise((resolve, reject) => {
      const css = h("link", { rel: "stylesheet", href: "board.css" });
      document.head.append(css);
      const js = h("script", { src: "board.js" });
      js.onload = () => (window.LenspackBoard ? resolve(window.LenspackBoard) : reject(new Error("board.js did not load")));
      js.onerror = () => { boardLib = null; reject(new Error("board.js is missing: build @lenspack/react")); };
      document.head.append(js);
    });
    return boardLib;
  }

  async function overview() {
    if (!usageInfo) return overviewCounts();
    const [o] = await Promise.all([api("overview?days=14").catch(() => null)]);
    // What waits for an admin, as links to the tabs: words, not charts. The charts are the board below.
    const waiting = o ? h("p", { class: "row", style: "margin:0 0 12px" },
      h("span", { class: "mute" }, `${t("waiting")}:`),
      h("a", { href: "#questions" }, `${t("openQ")}: ${nf(o.open)}`),
      h("a", { href: "#proposals" }, `${t("pending")}: ${nf(o.pending)}`)) : null;
    const boardEl = h("div", { class: "usage-board" }, h("p", { class: "mute" }, t("loading")));
    const log = h("div", { class: "uchat-log", "aria-live": "polite" });
    const input = h("textarea", { rows: 2, placeholder: t("askPlaceholder"), "aria-label": t("askUsage") });
    const button = h("button", { class: "btn", type: "submit" }, t("send"));
    const paintLog = () => log.replaceChildren(...usageChat.map((m) => h("div", { class: `uchat-msg ${m.role}${m.bad ? " bad" : ""}` }, m.text)));
    async function askUsage(text) {
      text = text.trim();
      if (!text || button.disabled) return;
      button.disabled = true;
      usageChat.push({ role: "user", text });
      const reply = { role: "assistant", text: t("thinking") };
      usageChat.push(reply);
      paintLog();
      const history = usageChat.filter((m) => m !== reply && !m.bad).map((m, i) => ({ id: `m${i}`, role: m.role, parts: [{ type: "text", text: m.text }] }));
      try {
        const res = await fetch(`api/usage/${usageInfo.board}/chat?language=${lang}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history.slice(-16), language: lang }) });
        if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))).error) || `HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let answer = "";
        let textId = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split("\n")) {
              const data = line.startsWith("data:") ? line.slice(5).trim() : "";
              if (!data || data === "[DONE]") continue;
              let ev;
              try { ev = JSON.parse(data); } catch (e) { continue; }
              // The reply is the text after the last tool call, as in the chat on a board.
              if (ev.type === "tool-input-available") answer = "";
              if (ev.type === "text-delta") {
                if (ev.id && textId && ev.id !== textId && answer.trim()) answer += "\n\n";
                textId = ev.id || textId;
                answer += ev.delta;
                reply.text = answer;
                paintLog();
              }
              if (ev.type === "error") { reply.text = ev.errorText || t("noAnswer"); reply.bad = true; }
            }
          }
        }
        if (!reply.text.trim() || reply.text === t("thinking")) reply.text = t("noAnswer");
        // The turn may have changed the board (a new chart): draw it again.
        if (mounted) mounted.reload();
      } catch (e) {
        reply.text = e.message;
        reply.bad = true;
      }
      button.disabled = false;
      paintLog();
    }
    const form = h("form", { class: "uchat-form", onsubmit: (e) => { e.preventDefault(); const v = input.value; input.value = ""; askUsage(v); } }, input, button);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    const examples = h("div", { class: "row", style: "margin-top:8px" }, ["usageEx1", "usageEx2", "usageEx3"].map((k) => h("button", { class: "btn quiet sm", type: "button", onclick: () => askUsage(t(k)) }, t(k))));
    paintLog();
    const nodes = [
      h("p", { class: "mute", style: "margin:0 0 6px" }, t("usageLede"), " ", t("usageFrom", t(`src_${usageInfo.source}`)), " ", t("estimateNote")),
      waiting,
      boardEl,
      card(t("askUsage"), t("askUsageLede"), log, form, examples),
    ];
    // Mounted once the nodes are on the page.
    setTimeout(async () => {
      try {
        const lib = await loadBoardLib();
        if (!boardEl.isConnected) return;
        if (mounted) mounted.unmount();
        boardEl.replaceChildren();
        mounted = lib.mount(boardEl, { api: `api/usage/${usageInfo.board}` });
      } catch (e) {
        boardEl.replaceChildren(h("p", { class: "bad" }, t("boardOff", e.message)));
      }
    });
    return nodes;
  }

  // Without the usage board (no DuckDB on this server): the counts as a plain table.
  async function overviewCounts() {
    const [o, cache] = await Promise.all([api("overview?days=14"), cacheApi("").catch(() => null)]);
    const tiles = h("div", { class: "tiles" },
      tile(t("turns"), nf(o.total.turns)), tile(t("people"), nf(o.total.users)), tile(t("cost"), usd(o.total.costUsd)),
      tile(t("errors"), nf(o.total.errors), o.total.turns ? `${nf((100 * o.total.errors) / o.total.turns)}%` : ""),
      tile(t("openQ"), nf(o.open)), tile(t("pending"), nf(o.pending)),
      cache && cache.stats ? tile(t("saved$"), usd(cache.stats.savedUsd)) : null);
    const rows = o.days.slice().reverse().map((d) =>
      h("tr", {},
        h("td", {}, dayOf(d.day)),
        h("td", { class: "n" }, nf(d.turns)),
        h("td", { class: "n" }, nf(d.users)), h("td", { class: "n" }, usd(d.costUsd)), h("td", { class: "n" }, nf(d.errors)),
        h("td", { class: "n hide-s" }, nf(d.refusals)), h("td", { class: "n hide-s" }, nf(d.findings)), h("td", { class: "n" }, nf(d.asked)), h("td", { class: "n hide-s" }, nf(d.assumed)), h("td", { class: "n hide-s" }, nf(d.picked))));
    return [
      h("p", { class: "mute", style: "margin:0 0 10px" }, t("lastDays", 14)),
      tiles,
      card(t("byDay"), null, h("div", { class: "scroll" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, t("day")), h("th", { class: "n" }, t("turns")), h("th", { class: "n" }, t("people")), h("th", { class: "n" }, t("cost")), h("th", { class: "n" }, t("errors")), h("th", { class: "n hide-s" }, t("refusals")), h("th", { class: "n hide-s" }, t("findings")), h("th", { class: "n" }, t("asked")), h("th", { class: "n hide-s" }, t("assumed")), h("th", { class: "n hide-s" }, t("picked")))),
        h("tbody", {}, rows))), h("p", { class: "mute", style: "margin:8px 0 0;font-size:12.5px" }, t("estimateNote"))),
    ];
  }

  async function review() {
    if (openRun) return runReport(openRun);
    const [s, runs] = await Promise.all([api("review/settings"), api("runs")]);
    const f = {
      enabled: h("input", { type: "checkbox", checked: s.enabled }),
      time: h("input", { type: "time", value: s.time }),
      timeZone: h("input", { type: "text", value: s.timeZone }),
      model: h("select", {}, s.models.map((m) => h("option", { value: m.name, selected: m.name === s.model ? "" : null }, `${m.name}${m.priced ? "" : " (no price)"}`))),
      maxUsd: h("input", { type: "number", min: "0.05", step: "0.05", value: s.maxUsd }),
      lookbackHours: h("input", { type: "number", min: "1", step: "1", value: s.lookbackHours }),
      minTurns: h("input", { type: "number", min: "0", step: "1", value: s.minTurns }),
    };
    if (!s.models.some((m) => m.name === s.model)) f.model.prepend(h("option", { value: s.model, selected: "" }, `${s.model} (not configured)`));
    const save = act(async () => {
      await api("review/settings", { body: { time: f.time.value, timeZone: f.timeZone.value.trim(), model: f.model.value, maxUsd: Number(f.maxUsd.value), lookbackHours: Number(f.lookbackHours.value), minTurns: Number(f.minTurns.value) } });
      if (f.enabled.checked !== s.enabled) await api("settings/features", { body: { "review.daily": f.enabled.checked } });
    }, t("saved"));
    const runNow = async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      b.textContent = t("estimating");
      try {
        const e = await api("review/estimate", { body: {} });
        const ps = e.packs.filter((p) => p.turns);
        const err = e.packs.find((p) => p.error);
        if (err) throw new Error(err.error);
        const sum = (k) => ps.reduce((n, p) => n + (p[k] || 0), 0);
        const body = t("estimateBody", sum("turns"), ps.reduce((n, p) => n + (p.included ? p.included.length : 0), 0), sum("shortened"), sum("dropped"), sum("expectedUsd").toFixed(2), sum("worstUsd").toFixed(2));
        const ok = await new Promise((resolve) => {
          const d = h("dialog", { class: "modal" }, h("h2", { style: "font-size:15px;margin:0 0 8px" }, t("estimateTitle")), h("p", {}, body),
            h("p", { class: "mute" }, `${t("model")}: ${e.settings.model} · ${t("maxUsd")}: $${e.settings.maxUsd}`),
            h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => { d.close(); resolve(true); } }, t("confirmRun")), h("button", { class: "btn quiet", type: "button", onclick: () => { d.close(); resolve(false); } }, t("cancel"))));
          d.addEventListener("cancel", () => resolve(false));
          d.addEventListener("close", () => d.remove());
          document.body.append(d);
          d.showModal();
        });
        if (ok) {
          await api("review/run", { body: { confirm: true } });
          toast(t("started"));
          setTimeout(render, 1500);
        }
      } catch (e) {
        toast(e.message, true);
      } finally {
        if (b.isConnected) { b.disabled = false; b.textContent = t("runNow"); }
      }
    };
    const fld = (label, input) => h("label", { class: "field" }, h("span", {}, label), input);
    const settingsCard = card(t("reviewSettings"), t("reviewLede"),
      h("label", { class: "switch" }, f.enabled, h("div", {}, h("div", { class: "lbl" }, t("enabled")), h("div", { class: "help" }, s.next ? t("nextRun", when(s.next)) : t("notScheduled")))),
      h("div", { class: "form", style: "margin-top:8px" }, fld(t("time"), f.time), fld(t("tz"), f.timeZone), fld(t("model"), f.model), fld(t("maxUsd"), f.maxUsd), fld(t("lookback"), f.lookbackHours), fld(t("minTurns"), f.minTurns)),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: save }, t("saveSettings")), h("button", { class: "btn ghost", type: "button", onclick: runNow, disabled: s.running }, t("runNow")), s.running ? h("span", { class: "mute" }, t("running")) : null));
    const list = runs.runs.length
      ? h("div", { class: "scroll" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, t("when")), h("th", {}, t("trigger")), h("th", {}, t("status")), h("th", { class: "n" }, t("turns")), h("th", { class: "n hide-s" }, t("findingsH")), h("th", { class: "n hide-s" }, t("proposalsH")), h("th", { class: "n" }, t("cost")), h("th", {}))),
          h("tbody", {}, runs.runs.map((r) => {
            const sum = (k) => r.packs.reduce((n, p) => n + (p[k] || 0), 0);
            return h("tr", {},
              h("td", {}, when(r.at)), h("td", {}, t(r.trigger)), h("td", {}, statusPill(r.status), r.reason ? h("div", { class: "mute", style: "font-size:12px;max-width:320px" }, r.reason) : null),
              h("td", { class: "n" }, nf(sum("turns"))), h("td", { class: "n hide-s" }, nf(sum("findings"))), h("td", { class: "n hide-s" }, nf(sum("proposals"))), h("td", { class: "n" }, usd(r.usd)),
              h("td", {}, h("button", { class: "btn sm ghost", type: "button", onclick: () => { openRun = r.id; render(); } }, t("report"))));
          }))))
      : h("p", { class: "empty" }, t("noRuns"));
    if (s.running) setTimeout(() => { if (tab === "review" && !openRun) render(); }, 5000);
    return [settingsCard, card(t("runs"), null, list)];
  }

  async function runReport(id) {
    const r = await api(`runs/${encodeURIComponent(id)}`);
    const out = [h("div", { class: "row", style: "margin:0 0 12px" }, h("button", { class: "btn quiet sm", type: "button", onclick: () => { openRun = null; render(); } }, `← ${t("back")}`), h("span", { class: "mute" }, `${when(r.at)} · ${t(r.trigger)} · ${r.settings.model} · ${usd(r.usd)}`), statusPill(r.status))];
    for (const p of r.packs) {
      const turnsBy = new Map((p.turnIndex || []).map((x) => [x.n, x]));
      const cite = (ns) => (ns && ns.length ? h("details", {}, h("summary", {}, `${t("cited")}: ${ns.join(", ")}`), h("ul", { class: "examples" }, ns.map((n) => turnsBy.get(n)).filter(Boolean).map((x) => h("li", {}, `#${x.n} ${when(x.at)} · ${x.question}`)))) : null);
      const rep = p.report;
      if (!rep) {
        out.push(card(p.pack, null, statusPill(p.status), h("p", {}, p.reason || "")));
        continue;
      }
      out.push(card(`${t("summary")} · ${p.pack}`, null, h("p", { style: "margin:0" }, rep.summary), p.plan ? h("p", { class: "mute", style: "font-size:12.5px;margin:8px 0 0" }, t("estimateBody", p.turns, p.plan.included.length, p.plan.shortened, p.plan.dropped, (p.plan.expectedUsd || 0).toFixed(2), (p.plan.worstUsd || 0).toFixed(2))) : null));
      out.push(card(t("findingsH"), null, rep.findings.length ? rep.findings.map((f) => h("div", { class: "q" }, h("div", { class: "spread" }, h("p", { class: "pattern" }, f.title), pill(f.severity, f.severity === "bad" ? "bad" : "warn")), h("p", { style: "margin:6px 0" }, f.why), cite(f.turns))) : h("p", { class: "mute" }, t("noItems"))));
      out.push(card(t("proposalsH"), null, rep.proposals.length ? rep.proposals.map((x) => h("div", { class: "q" }, h("div", { class: "row" }, pill(t(`kind_${x.kind}`), "acc"), x.key ? h("code", {}, x.key) : null), h("p", { style: "margin:6px 0", class: "mono" }, x.kind === "definition" ? `${x.when} → ${x.text}` : x.kind === "synonym" ? (x.words || []).join(", ") : x.text), h("p", { class: "mute", style: "margin:0" }, x.rationale), cite(x.turns))) : h("p", { class: "mute" }, t("noItems"))));
      out.push(card(t("questionsH"), null, rep.questions.length ? rep.questions.map((q) => h("div", { class: "q" }, h("p", { class: "pattern" }, q.pattern), h("ul", { class: "examples" }, q.readings.map((x) => h("li", {}, h("b", {}, x.label), ` — ${x.explanation}`, x.query ? h("div", { class: "mono mute" }, queryText(x.query)) : null))), cite(q.turns))) : h("p", { class: "mute" }, t("noItems"))));
      out.push(card(t("chartsH"), null, rep.chartCandidates.length ? h("ul", {}, rep.chartCandidates.map((c) => h("li", {}, h("b", {}, `${c.count}× `), c.question, c.why ? h("span", { class: "mute" }, ` — ${c.why}`) : null, c.query ? h("div", { class: "mono mute" }, queryText(c.query)) : null))) : h("p", { class: "mute" }, t("noItems"))));
      if (p.problems && p.problems.length) out.push(card(t("problems"), null, h("ul", { class: "examples" }, p.problems.map((x) => h("li", {}, x)))));
    }
    return out;
  }

  function readingCard(q, r, cmp) {
    const fig = cmp && cmp.readings.find((x) => x.reading === r.id);
    const body = [h("div", { class: "lbl" }, r.label, q.chosen === r.id ? h("span", { class: "pill ok", style: "margin-left:6px" }, t("chosen")) : null), r.explanation ? h("div", { style: "font-size:13px" }, r.explanation) : null];
    if (r.query) body.push(h("div", { class: "mono mute", style: "margin-top:4px;word-break:break-word" }, queryText(r.query)));
    else body.push(h("div", { class: "mute", style: "font-size:12.5px;margin-top:4px" }, r.how || t("noQuery")));
    if (fig) {
      if (!fig.ok) body.push(h("div", { class: "pill warn", style: "margin-top:6px" }, fig.error ? `${t("notRunnable")}: ${fig.error.slice(0, 120)}` : t("notRunnable")));
      else if (fig.rows && fig.rows.length && fig.kind === "breakdown")
        body.push(h("table", { style: "margin-top:6px" }, h("thead", {}, h("tr", {}, h("th", {}, t("group")), h("th", { class: "n" }, t("value")))), h("tbody", {}, fig.rows.slice(0, 5).map((x) => h("tr", {}, h("td", {}, x.group), h("td", { class: "n" }, nf(x.value, 2)))))));
      else body.push(h("div", { class: "fig" }, fig.summary));
    }
    const tally = [q.choices && q.choices[r.label] ? t("choices", q.choices[r.label]) : null, q.assumed && q.assumed[r.label] ? t("assumedN", q.assumed[r.label]) : null].filter(Boolean).join(" · ");
    if (tally) body.push(h("div", { class: "mute", style: "font-size:12px;margin-top:6px" }, tally));
    if (q.status === "open")
      body.push(h("div", { class: "actions", style: "margin-top:8px" }, h("button", { class: "btn sm", type: "button", onclick: async (ev) => {
        const v = await ask(`${t("answerWith")}: ${r.label}`, [{ label: t("why"), area: true }]);
        if (v) await act(() => api(`questions/${q.id}/answer`, { body: { reading: r.id, why: v[0] } }))(ev);
      } }, t("answerWith"))));
    return h("div", { class: `reading${q.chosen === r.id ? " chosen" : ""}` }, body);
  }

  async function questions() {
    const { questions: list } = await api(`questions${qFilter === "all" ? "" : `?status=${qFilter}`}`);
    const filters = h("div", { class: "seg", role: "group", style: "margin:0 0 12px" }, ["open", "answered", "dismissed", "all"].map((k) =>
      h("button", { type: "button", "aria-pressed": String(qFilter === k), onclick: () => { qFilter = k; render(); } }, t(`filter${k[0].toUpperCase()}${k.slice(1)}`))));
    const items = list.map((q) => {
      const cmp = q.compared;
      const runnable = q.readings.filter((r) => r.query).length >= 2;
      const status = q.status === "answered" ? t("answeredBy", q.answeredBy, when(q.answeredAt)) : q.status === "dismissed" ? t("dismissedBy", q.answeredBy, when(q.answeredAt)) : null;
      return h("article", { class: "q" },
        h("div", { class: "spread" }, h("p", { class: "pattern" }, q.pattern), statusPill(q.status, t(`filter${q.status[0].toUpperCase()}${q.status.slice(1)}`))),
        h("div", { class: "meta" }, h("span", {}, t("seen", q.count)), h("span", {}, t("first", when(q.firstSeen))), h("span", {}, t("last", when(q.lastSeen))), h("span", {}, t("from", q.sources.map((s) => t(`src_${s}`)).join(", ")))),
        status ? h("p", { class: "mute", style: "margin:0 0 8px" }, status, q.why ? ` — ${q.why}` : "") : null,
        cmp ? h("div", { class: "headline" }, cmp.headline, h("span", { class: "mute", style: "font-size:12px" }, ` (${when(cmp.at)})`)) : null,
        h("div", { class: "readings" }, q.readings.map((r) => readingCard(q, r, cmp))),
        q.examples.length ? h("details", { style: "margin-top:10px" }, h("summary", {}, `${t("examples")} (${q.examples.length})`), h("ul", { class: "examples" }, q.examples.map((x) => h("li", {}, x)))) : null,
        h("div", { class: "actions" },
          runnable ? h("button", { class: "btn sm ghost", type: "button", onclick: act(() => api(`questions/${q.id}/compare`, { body: {} })) }, t("compareNow")) : null,
          h("button", { class: "btn sm quiet", type: "button", onclick: async (ev) => {
            const v = await ask(t("edit"), [{ label: t("pattern"), value: q.pattern }, { label: t("readingsJson"), area: true, value: JSON.stringify(q.readings.map(({ id, ...r }) => r), null, 1) }]);
            if (!v) return;
            let readings;
            try { readings = JSON.parse(v[1]); } catch (e) { readings = v[1].split("\n").filter(Boolean).map((l) => { const [label, ...rest] = l.split(":"); return { label: label.trim(), explanation: rest.join(":").trim() }; }); }
            await act(() => api(`questions/${q.id}/edit`, { body: { pattern: v[0], readings } }))(ev);
          } }, t("edit")),
          q.status === "open"
            ? h("button", { class: "btn sm danger", type: "button", onclick: async (ev) => { const v = await ask(t("dismiss"), [{ label: t("why"), area: true }]); if (v) await act(() => api(`questions/${q.id}/dismiss`, { body: { why: v[0] } }))(ev); } }, t("dismiss"))
            : h("button", { class: "btn sm quiet", type: "button", onclick: act(() => api(`questions/${q.id}/reopen`, { body: {} })) }, t("reopen"))));
    });
    const pattern = h("input", { type: "text" });
    const readings = h("textarea", { rows: 3, placeholder: "Stock dispatched: units sent from the facility store\nDoses given: doses given to children there" });
    const addCard = card(t("addQuestion"), null, h("div", { class: "form" }, h("label", { class: "field wide" }, h("span", {}, t("pattern")), pattern), h("label", { class: "field wide" }, h("span", {}, t("readingsJson")), readings)),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: act(() => api("questions", { body: { pattern: pattern.value, readings: readings.value.split("\n").filter(Boolean).map((l) => { const [label, ...rest] = l.split(":"); return { label: label.trim(), explanation: rest.join(":").trim() }; }) } })) }, t("add"))));
    return [h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("qLede")), filters, items.length ? items : h("p", { class: "empty" }, t("noQuestions")), addCard];
  }

  async function proposals() {
    const { proposals: list } = await api("proposals");
    const pending = list.filter((p) => p.status === "pending");
    const decided = list.filter((p) => p.status !== "pending");
    const body = (p) => (p.kind === "definition" ? `${p.when} → ${p.text}` : p.kind === "synonym" ? (p.words || []).join(", ") : p.text);
    const item = (p) => h("article", { class: "q" },
      h("div", { class: "spread" }, h("div", { class: "row" }, pill(t(`kind_${p.kind}`), "acc"), p.key ? h("code", {}, p.key) : null, h("span", { class: "mute", style: "font-size:12.5px" }, `${p.pack} · ${t("fromRun", when(p.createdAt))}`)), statusPill(p.status, p.status === "pending" ? t("pending") : t(p.status))),
      h("p", { class: "mono", style: "margin:8px 0" }, body(p)),
      p.rationale ? h("p", { class: "mute", style: "margin:0" }, p.rationale) : null,
      p.turns && p.turns.length ? h("p", { class: "mute", style: "font-size:12.5px;margin:4px 0 0" }, `${t("cited")}: ${p.turns.join(", ")}`) : null,
      p.status !== "pending" ? h("p", { class: "mute", style: "font-size:12.5px;margin:6px 0 0" }, `${t(p.status)} ${t("by", p.decidedBy)}, ${when(p.decidedAt)}${p.note ? ` — ${p.note}` : ""}`) : null,
      p.status === "pending" ? h("div", { class: "actions" },
        h("button", { class: "btn sm", type: "button", onclick: act(() => api(`proposals/${p.id}/accept`, { body: {} })) }, t("accept")),
        h("button", { class: "btn sm ghost", type: "button", onclick: async (ev) => {
          const fields = p.kind === "definition" ? [{ label: t("when2"), value: p.when }, { label: t("text"), value: p.text, area: true }] : p.kind === "synonym" ? [{ label: t("words"), value: (p.words || []).join(", ") }] : [{ label: t("text"), value: p.text, area: true }];
          const v = await ask(t("editAccept"), [...fields, { label: t("why") }]);
          if (!v) return;
          const edit = p.kind === "definition" ? { when: v[0], text: v[1] } : p.kind === "synonym" ? { words: v[0].split(",").map((w) => w.trim()).filter(Boolean) } : { text: v[0] };
          await act(() => api(`proposals/${p.id}/accept`, { body: { edit, why: v[v.length - 1] } }))(ev);
        } }, t("editAccept")),
        h("button", { class: "btn sm danger", type: "button", onclick: async (ev) => { const v = await ask(t("reject"), [{ label: t("rejectWhy"), area: true }]); if (v) await act(() => api(`proposals/${p.id}/reject`, { body: { why: v[0] } }))(ev); } }, t("reject"))) : null);
    return [h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("pLede")), pending.length ? pending.map(item) : h("p", { class: "empty" }, t("noProposals")), decided.length ? card(t("decided"), null, decided.slice(0, 30).map(item)) : null];
  }

  async function definitions() {
    const d = await api("definitions");
    const over = d.size > d.budget;
    const kind = h("select", {}, ["instruction", "definition", "hint", "synonym"].map((k) => h("option", { value: k }, t(`kind_${k}`))));
    const key = h("select", {}, d.keys.map((k) => h("option", { value: k.key }, `${k.key} (${k.kind})`)));
    const when2 = h("input", { type: "text", placeholder: t("whenHelp") });
    const text = h("textarea", { rows: 2 });
    const why = h("input", { type: "text" });
    const keyField = h("label", { class: "field" }, h("span", {}, t("key")), key);
    const whenField = h("label", { class: "field" }, h("span", {}, t("when2")), when2);
    const textLabel = h("span", {}, t("text"));
    const sync = () => {
      keyField.hidden = !["hint", "synonym"].includes(kind.value);
      whenField.hidden = kind.value !== "definition";
      textLabel.textContent = kind.value === "synonym" ? t("words") : kind.value === "definition" ? t("textHelpDef") : t("text");
    };
    kind.onchange = sync;
    sync();
    const add = act(() => api("definitions", { body: { kind: kind.value, key: key.value, when: when2.value, text: text.value, words: kind.value === "synonym" ? text.value.split(",") : undefined, why: why.value } }), t("saved"));
    const entries = d.entries.length
      ? h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, t("kind")), h("th", {}, t("text")), h("th", { class: "hide-s" }, t("by", "")), h("th", {}))),
          h("tbody", {}, d.entries.map((e) => h("tr", {},
            h("td", {}, pill(t(`kind_${e.kind}`), "acc"), e.key ? h("div", {}, h("code", {}, e.key)) : null),
            h("td", { class: "mono" }, e.kind === "definition" ? `${e.when} → ${e.text}` : e.kind === "synonym" ? (e.words || []).join(", ") : e.text),
            h("td", { class: "hide-s mute", style: "font-size:12.5px" }, `${e.createdBy}, ${when(e.createdAt)}`),
            h("td", { style: "white-space:nowrap" },
              h("button", { class: "btn sm quiet", type: "button", onclick: async (ev) => {
                const fields = e.kind === "definition" ? [{ label: t("when2"), value: e.when }, { label: t("text"), value: e.text, area: true }] : e.kind === "synonym" ? [{ label: t("words"), value: (e.words || []).join(", ") }] : [{ label: t("text"), value: e.text, area: true }];
                const v = await ask(t("edit"), [...fields, { label: t("why") }]);
                if (!v) return;
                const b = e.kind === "definition" ? { when: v[0], text: v[1] } : e.kind === "synonym" ? { words: v[0].split(","), text: v[0] } : { text: v[0] };
                await act(() => api(`definitions/${e.id}/edit`, { body: { ...b, why: v[v.length - 1] } }), t("saved"))(ev);
              } }, t("edit")), " ",
              h("button", { class: "btn sm danger", type: "button", onclick: async (ev) => { const v = await ask(t("remove"), [{ label: t("removeWhy") }]); if (v) await act(() => api(`definitions/${e.id}/remove`, { body: { why: v[0] } }))(ev); } }, t("remove"))))))))
      : h("p", { class: "empty" }, t("noDefs"));
    const hist = d.history.length
      ? h("div", { class: "scroll" }, h("table", {}, h("tbody", {}, d.history.slice(0, 40).map((c) => h("tr", {},
          h("td", { class: "mono" }, `v${c.version}`), h("td", {}, c.summary, c.why ? h("div", { class: "mute", style: "font-size:12.5px" }, c.why) : null, c.undone ? h("span", { class: "pill warn", style: "margin-left:6px" }, "undone") : null),
          h("td", { class: "mute hide-s", style: "font-size:12.5px;white-space:nowrap" }, `${c.by}, ${when(c.at)}`),
          h("td", {}, c.version !== d.version ? h("button", { class: "btn sm quiet", type: "button", onclick: act(() => api("definitions/restore", { body: { version: c.version } })) }, t("restore")) : null))))))
      : null;
    return [
      h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("dLede")),
      card(null, null,
        h("div", { class: "spread" }, h("div", {}, h("b", {}, t("version", d.version)), h("div", { class: "mute mono", style: "font-size:12px" }, `${t("defsVersion")}: ${d.definitionsVersion}`)), h("div", { style: "min-width:220px;flex:1;max-width:360px" }, h("div", { class: `meter${over ? " over" : ""}` }, h("div", { style: `width:${Math.min(100, (100 * d.size) / d.budget)}%` })), h("div", { class: "mute", style: "font-size:12.5px" }, t("budget", nf(d.size), nf(d.budget))))),
        h("div", { style: "margin-top:12px" }, entries),
        d.history.length ? h("div", { class: "actions" }, h("button", { class: "btn sm ghost", type: "button", onclick: act(() => api("definitions/undo", { body: {} })) }, t("undo"))) : null),
      card(t("addDef"), null, h("div", { class: "form" }, h("label", { class: "field" }, h("span", {}, t("kind")), kind), keyField, whenField, h("label", { class: "field wide" }, textLabel, text), h("label", { class: "field wide" }, h("span", {}, t("why")), why)), h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: add }, t("add")))),
      hist ? card(t("history"), null, hist) : null,
      card(t("packOwn"), null, h("pre", {}, d.packInstructions || t("none"))),
    ];
  }

  async function cache() {
    // The saved answers' admin routes (docs/caching.md): <prefix>/cache, …/suggestions, …/chart-candidates, …/boards.
    let data;
    try {
      data = await cacheApi("");
    } catch (e) {
      data = null;
    }
    if (!data) return [card(null, null, h("p", { class: "empty" }, t("cacheOff")))];
    const st = data.stats || {};
    const hits = st.hits || {};
    const totalHits = ["t1", "t2", "t3", "t4"].reduce((n, k) => n + (hits[k] || 0), 0);
    const entries = data.entries || [];
    const [cands, boardInfo] = await Promise.all([cacheApi("/chart-candidates").catch(() => null), cacheApi("/boards").catch(() => null)]);
    const boards = [...new Set(entries.map((e) => e.board).filter(Boolean))].slice(0, 4);
    const sugg = await Promise.all(boards.map((b) => cacheApi(`/suggestions?board=${encodeURIComponent(b)}`).catch(() => null)));
    const post = (path) => act(async () => {
      const res = await fetch(`../cache${path}`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    const tierLine = ["t1", "t2", "t3", "t4"].map((k) => `${t(`tier_${k}`)} ${nf(hits[k] || 0)}`).join(" · ");
    const q = data.queue;
    const pw = data.prewarm;
    const settled = ((boardInfo && boardInfo.boards) || []).filter((b) => b.settled);
    const candidates = (cands && cands.candidates) || [];
    return [
      h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("cacheLede"), st.since ? ` ${t("since", when(st.since))}.` : ""),
      h("div", { class: "tiles" },
        tile(t("turns"), nf(st.turns)),
        tile(t("hits"), nf(totalHits), st.turns ? `${nf((100 * totalHits) / st.turns)}%` : null),
        tile(t("misses"), nf(st.misses)),
        tile(t("saved$"), usd(st.savedUsd)),
        tile(t("entries"), nf(entries.length)),
        q ? tile(t("queueNow"), `${nf(q.running)} / ${nf(q.waiting)}`, t("queueHelp")) : null),
      h("p", { class: "mute", style: "margin:-6px 0 14px;font-size:12.5px" }, tierLine),
      card(t("prewarmH"), pw ? t("prewarmLast", when(pw.at), t(`pwr_${pw.reason}`), nf(pw.refreshed), nf(pw.entries), nf(pw.rewritten), usd(pw.spentUsd)) : t("prewarmNever"),
        h("div", { class: "actions" }, h("button", { class: "btn sm ghost", type: "button", onclick: post("/prewarm") }, t("prewarmNow")))),
      card(t("entries"), null, entries.length ? h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, t("question")), h("th", { class: "hide-s" }, t("board")), h("th", { class: "n" }, t("hits")), h("th", { class: "n hide-s" }, t("asks7d")), h("th", { class: "hide-s" }, t("dataAsOf")), h("th", {}))),
        h("tbody", {}, entries.map((e) => h("tr", {},
          h("td", {}, e.question, e.kind === "edit" ? h("span", { class: "pill", style: "margin-left:6px" }, t("kindEdit")) : null, e.pinned ? h("span", { class: "pill acc", style: "margin-left:6px" }, t("pinned")) : null, e.variants && e.variants.length ? h("div", { class: "mute", style: "font-size:12px" }, e.variants.slice(0, 3).join(" · ")) : null),
          h("td", { class: "hide-s" }, e.board || ""), h("td", { class: "n" }, nf(e.hits)), h("td", { class: "n hide-s" }, nf(e.asks7d)), h("td", { class: "hide-s mute" }, when(e.dataAsOf)),
          h("td", { style: "white-space:nowrap" }, h("button", { class: "btn sm quiet", type: "button", onclick: post(`/${encodeURIComponent(e.id)}/${e.pinned ? "unpin" : "pin"}`) }, e.pinned ? t("unpin") : t("pin")), " ", h("button", { class: "btn sm danger", type: "button", onclick: post(`/${encodeURIComponent(e.id)}/evict`) }, t("evict")))))))) : h("p", { class: "empty" }, t("noEntries"))),
      sugg.some((x) => x && x.suggestions && x.suggestions.length) ? card(t("suggestions"), t("suggestionsLede"), boards.map((b, i) => (sugg[i] && sugg[i].suggestions.length ? h("div", {}, h("h3", {}, b), h("ul", {}, sugg[i].suggestions.map((x) => h("li", {}, x)))) : null))) : null,
      candidates.length ? card(t("chartCandidates"), t("candidatesLede"), h("ul", {}, candidates.map((c) => h("li", {}, c.question, h("span", { class: "mute" }, ` · ${c.board} · ${t("askedN", nf(c.asks))}`))))) : null,
      settled.length ? card(t("settledH"), t("settledLede"), h("ul", {}, settled.map((b) => h("li", {}, b.board, h("span", { class: "mute" }, ` · ${t("lastEdit", when(b.lastEdit))}`))))) : null,
    ];
  }

  async function settings() {
    const { features } = await api("settings");
    const rows = features.options.map((o) => {
      const fr = lang === "fr" ? FEATURES_FR[o.key] : null;
      const input = h("input", { type: "checkbox", checked: features.values[o.key], "aria-label": fr ? fr[0] : o.label, onchange: act(() => api("settings/features", { body: { [o.key]: input.checked } }), t("saved")) });
      return h("label", { class: "switch" }, input, h("div", { style: "flex:1" },
        h("div", { class: "row" }, h("span", { class: "lbl" }, fr ? fr[0] : o.label), h("code", {}, o.key), pill(t(`source_${features.source[o.key]}`), features.source[o.key] === "settings" ? "acc" : "")),
        h("div", { class: "help" }, fr ? fr[1] : o.help)));
    });
    const changed = Object.values(features.source).some((s) => s === "settings");
    return [card(t("tabSettings"), t("sLede"), rows, changed ? h("div", { class: "actions" }, h("button", { class: "btn sm quiet", type: "button", onclick: act(() => api("settings/features", { body: Object.fromEntries(features.options.map((o) => [o.key, null])) })) }, t("reset"))) : null)];
  }

  /** The telemetry checklist (GET <prefix>/telemetry/checklist), if the server has it: null when it does not (404). */
  async function telemetryApi() {
    const res = await fetch("../telemetry/checklist", { credentials: "same-origin" });
    if (res.status === 404) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { return null; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data && Array.isArray(data.groups) ? data : null;
  }
  /** A telemetry switch (on/off, or the retention), changed through the host's Settings routes: PUT <prefix>/settings/telemetry. */
  async function setTelemetrySwitch(key, value) {
    const res = await fetch("../settings/telemetry", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: value }), credentials: "same-origin" });
    if (res.status === 404) throw new Error(t("tlSwitchAbsent"));
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }
  async function telemetry() {
    const C = window.LenspackChecklist;
    let data = null;
    try { data = C ? await telemetryApi() : null; } catch (e) { data = null; }
    if (!data) return [card(t("tlTitle"), null, h("p", { class: "empty" }, t("tlAbsent")), h("p", { class: "mute" }, t("tlAbsentHelp")))];
    const swLabel = (k) => (t(`tlSw_${k}`) === `tlSw_${k}` ? k : t(`tlSw_${k}`));
    const switches = Object.entries(data.switches || {}).map(([k, v]) => {
      if (typeof v === "boolean") {
        const input = h("input", { type: "checkbox", checked: v, "aria-label": swLabel(k), onchange: act(() => setTelemetrySwitch(k, input.checked), t("saved")) });
        return h("label", { class: "switch" }, input, h("div", { style: "flex:1" }, h("div", { class: "row" }, h("span", { class: "lbl" }, swLabel(k)), h("code", {}, k))));
      }
      const input = h("input", { type: typeof v === "number" ? "number" : "text", min: typeof v === "number" ? "1" : null, value: String(v ?? ""), style: "width:110px" });
      return h("div", { class: "switch" }, h("div", { style: "flex:1" }, h("div", { class: "row" }, h("span", { class: "lbl" }, swLabel(k)), h("code", {}, k))),
        h("div", { class: "row" }, input, h("button", { class: "btn sm quiet", type: "button", onclick: act(() => setTelemetrySwitch(k, typeof v === "number" ? Number(input.value) : input.value), t("saved")) }, t("save"))));
    });
    const md = () => C.markdown(data, t, { date: (iso) => when(iso), num: (n) => nf(n) });
    const copy = async () => {
      const text = md();
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        // No clipboard access (an http page, an old browser): select the text instead.
        const area = h("textarea", { style: "position:fixed;top:0;left:0;opacity:0" }, text);
        document.body.append(area);
        area.select();
        try { document.execCommand("copy"); } finally { area.remove(); }
      }
      toast(t("tlCopied"));
    };
    const item = (it) => {
      const notRec = it.status !== "recording" && it.status !== "not-telemetry";
      return h("li", { class: `ck ck-${it.status}` },
        h("span", { class: "ck-mark", title: t(`st_${it.status}`), "aria-label": t(`st_${it.status}`) }, C.MARKS[it.status] || "?"),
        h("div", { class: "ck-body" },
          h("div", { class: "ck-head" }, h("b", {}, it.label), pill(t(`st_${it.status}`), it.status === "recording" ? "ok" : it.status === "needs-config" ? "warn" : it.status === "enabled-no-data" ? "acc" : "")),
          h("div", { class: "ck-decision" }, it.decision),
          h("div", { class: "ck-meta mute" },
            it.status === "not-telemetry" ? null : h("span", {}, `${t("tl7d")}: `, h("b", {}, nf(it.count7d))),
            it.status === "not-telemetry" ? null : h("span", {}, `${t("tlLastSeen")}: ${it.lastSeen ? when(it.lastSeen) : "—"}`),
            it.source ? h("span", {}, h("code", {}, it.source)) : null,
            (it.fields || []).length ? h("span", { class: "ck-fields" }, `${t("tlFields")}: `, ...(it.fields || []).map((f) => h("code", {}, f))) : null),
          it.privacy ? h("div", { class: "ck-privacy" }, h("b", {}, `${t("tlPrivacy")}: `), it.privacy) : null,
          notRec && it.howToEnable ? h("div", { class: "ck-how" }, h("b", {}, `${t("tlHow")}: `), it.howToEnable) : null));
    };
    return [
      h("div", { class: "spread no-print-gap" },
        h("div", {}, h("h2", { class: "tl-title" }, t("tlTitle")), h("p", { class: "lede mute", style: "margin:2px 0 0" }, t("tlLede"))),
        h("div", { class: "row no-print" }, h("button", { class: "btn sm ghost", type: "button", onclick: () => window.print() }, t("tlPrint")), h("button", { class: "btn sm", type: "button", onclick: copy }, t("tlCopy")))),
      h("p", { class: "tl-summary" }, C.summary(data, t)),
      h("p", { class: "mute", style: "margin:-6px 0 14px;font-size:12.5px" }, t("tlGenerated", when(data.generatedAt)), " ", t("tlLegend")),
      switches.length ? card(t("tlSwitches"), t("tlSwLede"), h("div", { class: "tl-switches" }, switches)) : null,
      ...(data.groups || []).map((g) => h("section", { class: "card ck-group" }, h("h2", {}, g.title, h("span", { class: "mute", style: "font-weight:400;margin-left:8px;font-size:12.5px" }, `${(g.items || []).filter((i) => i.status === "recording").length}/${(g.items || []).length}`)), h("ul", { class: "ck-list" }, (g.items || []).map(item)))),
    ];
  }

  const TABS = { overview, review, questions, proposals, definitions, telemetry, cache, settings };
  let rendering = 0;
  async function render() {
    const mine = ++rendering;
    if (!TABS[tab]) tab = "overview";
    applyChrome();
    try {
      const nodes = await TABS[tab]();
      if (mine !== rendering) return;
      main.replaceChildren(...[nodes].flat().filter(Boolean));
    } catch (e) {
      if (mine !== rendering) return;
      main.replaceChildren(h("p", { class: "pad bad" }, t("failed", e.message)));
    }
    counts();
  }
  async function counts() {
    // Small badges on the tabs that wait for a decision.
    try {
      const [q, p] = await Promise.all([api("questions?status=open"), api("proposals?status=pending")]);
      for (const [name, n] of [["questions", q.questions.length], ["proposals", p.proposals.length]]) {
        const b = document.querySelector(`#tabs [data-tab="${name}"]`);
        const old = b.querySelector(".count");
        if (old) old.remove();
        if (n) b.append(h("span", { class: "count" }, String(n)));
      }
    } catch (e) { /* badges are a nicety */ }
  }

  async function start() {
    applyChrome();
    try {
      const r = await api("packs");
      packs = r.packs;
      usageInfo = r.usage || null;
      if (!packs.some((p) => p.name === pack)) pack = packs[0] ? packs[0].name : "";
      const pick = document.getElementById("pack");
      pick.replaceChildren(...packs.map((p) => h("option", { value: p.name, selected: p.name === pack ? "" : null }, p.name)));
      document.getElementById("packPick").hidden = packs.length < 2;
      document.getElementById("sub").textContent = `${r.me.user} · ${packs.map((p) => p.name).join(", ")}`;
    } catch (e) {
      main.replaceChildren(h("p", { class: "pad" }, t("failed", e.message)));
      return;
    }
    render();
  }
  start();
})();
