// The admin panel's Telemetry tab, on its own: what's recorded (the field switches) and what it tells you (a board
// over the usage pack, with its chat). The panel mounts it: it lends the tab its helpers through create(), and merges
// the tab's words into its own. Plain JavaScript, no build; English and French.
(function () {
  "use strict";

  const STRINGS = {
    en: {
      tlTitle: "Telemetry", tlLede: "Only facts are recorded; every figure is worked out from them when you look.",
      tlViews: "Telemetry views", tlViewRecorded: "What's recorded", tlViewMetrics: "What it tells you",
      tlRecLede: "A change applies to the next question.",
      askTl: "Ask about what's recorded", askTlLede: "Logged and costed; left out of the daily review.",
      tlEx1: "Which roles asked most this week?", tlEx2: "How did the answer rate change over the last 30 days?", tlEx3: "Which kind of question is slowest to answer?",
      tlBoardOff: "Needs the usage board, which needs DuckDB and a state directory on this server.",
      tlGenerated: "Checked {0}.", tlSumRecording: "{0} of {1} fields recording", tlSumNoData: "{0} on, nothing yet", tlSumConfig: "{0} need configuration", tlSumOff: "{0} off",
      tlMaster: "Record telemetry", tlRetention: "Keep records for (days)", tlNote: "Off stops new records; what's recorded stays until it ages out.", tlOn: "on", tlOff: "off", tlMixed: "mixed", tlNoSwitch: "no switch",
      tlTelOff: "Telemetry is off: nothing is recorded.",
      tlColOn: "On", tlField: "Field", tlStatus: "Status", tl7d: "Records, 7 days", tl7dHelp: "Records, not a metric's value.", tlUsedBy: "Used by", tlPrivacyCol: "Privacy", tlDetailsCol: "Details", tlLastSeen: "Last seen",
      tlDetails: "Details for {0}", tlCategory: "All of {0}", tlShowHide: "Show or hide {0}", tlGroupCount: "{0} of {1} recording", tlSince: "since {0} · {1}", tlOffSince: "Off since {0}, by {1}.",
      tlCatApart: "Privacy-sensitive fields stay off; switch each on by itself.", tlCatOnly: "Each is switched on by itself, after a confirm step.",
      tlUsedNone: "not on the board", tlUsedMore: "+{0}", tlAbout: "What it holds", tlFields: "Record fields", tlFieldsTip: "Record fields: {0}", tlPrivacy: "Privacy", tlHow: "How to enable", tlSource: "Source", tlDefault: "Default", tlSensitive: "Privacy-sensitive: turning it on asks you to confirm.", tlMetricsUsing: "Board widgets that use it", tlPrivacyIcon: "Privacy: {0}",
      tlGoSettings: "Open Settings", tlGoField: "Show the field",
      tlLockOwned: "Owned by the {0} switch.", tlLockFeature: "Needs the {0} switch, which is off.", tlLockMissing: "Comes with the {0} feature, which this version does not have.", tlLockVoice: "Needs voice: set up in Settings.", tlLockConfig: "Needs configuration: map dashboards, datasets or roles to a {0} (context: in the config).", tlLockSuperset: "Only inside Superset, which keeps the action log.",
      tlCtx_country: "country", tlCtx_campaign: "campaign", tlCtx_campaignType: "campaign type", tlOr: "or",
      "tlF_review.daily": "daily review", tlF_clarify: "clarify", tlF_cache: "saved answers", tlF_personalDashboards: "personal dashboards", tlF_voice: "voice",
      tlConfirmTitle: "Turn on {0}?", tlConfirmLede: "This field is privacy-sensitive. Here is what it records:", tlConsent: "Each user sees this notice once, and agrees, before the mic records:", tlNoConsent: "No consent notice is set yet. Set one under Speech on the Settings page so users are told before they are recorded.", tlConfirmOn: "Turn on",
      tlSavedOn: "Saved. Applies to the next question.", tlSavedOff: "Saved. What was already recorded is kept until it ages out.",
      st_recording: "recording", "st_enabled-no-data": "on, nothing yet", st_off: "off", "st_needs-config": "needs configuration",
      tlLegend: "✓ recording · ◐ on, nothing yet · ○ off · ⚠ needs configuration", tlPrint: "Print", tlCopy: "Copy as Markdown", tlCopied: "Copied.",
      tlAbsent: "Telemetry is not available on this server.", tlSwitchAbsent: "This server cannot change that setting from here.",
    },
    fr: {
      tlTitle: "Télémétrie", tlLede: "Seuls des faits sont enregistrés ; chaque chiffre en est tiré à l'affichage.",
      tlViews: "Vues de la télémétrie", tlViewRecorded: "Ce qui est enregistré", tlViewMetrics: "Ce qu'on en tire",
      tlRecLede: "Un changement s'applique à la question suivante.",
      askTl: "Questions sur ce qui est enregistré", askTlLede: "Journalisées et comptées ; exclues de la revue quotidienne.",
      tlEx1: "Quels rôles ont posé le plus de questions cette semaine ?", tlEx2: "Comment le taux de réponse a-t-il évolué sur 30 jours ?", tlEx3: "Quel type de question est le plus lent à répondre ?",
      tlBoardOff: "Il faut le tableau d'usage, qui demande DuckDB et un dossier d'état sur ce serveur.",
      tlGenerated: "Vérifié le {0}.", tlSumRecording: "{0} champs sur {1} enregistrés", tlSumNoData: "{0} activés, rien encore", tlSumConfig: "{0} à configurer", tlSumOff: "{0} désactivés",
      tlMaster: "Enregistrer la télémétrie", tlRetention: "Conserver (jours)", tlNote: "Désactiver arrête les nouveaux enregistrements ; l'existant reste jusqu'à expiration.", tlOn: "activé", tlOff: "désactivé", tlMixed: "partiel", tlNoSwitch: "sans interrupteur",
      tlTelOff: "La télémétrie est désactivée : rien n'est enregistré.",
      tlColOn: "Actif", tlField: "Champ", tlStatus: "État", tl7d: "Enreg., 7 jours", tl7dHelp: "Des enregistrements, pas la valeur d'un indicateur.", tlUsedBy: "Utilisé par", tlPrivacyCol: "Confidentialité", tlDetailsCol: "Détails", tlLastSeen: "Dernier",
      tlDetails: "Détails : {0}", tlCategory: "Toute la catégorie {0}", tlShowHide: "Afficher ou masquer {0}", tlGroupCount: "{0} sur {1} enregistrés", tlSince: "depuis le {0} · {1}", tlOffSince: "Désactivé depuis le {0}, par {1}.",
      tlCatApart: "Les champs sensibles restent désactivés ; activez-les un par un.", tlCatOnly: "Chacun s'active séparément, après confirmation.",
      tlUsedNone: "pas sur le tableau", tlUsedMore: "+{0}", tlAbout: "Ce qu'il contient", tlFields: "Champs des enregistrements", tlFieldsTip: "Champs : {0}", tlPrivacy: "Confidentialité", tlHow: "Pour l'activer", tlSource: "Source", tlDefault: "Par défaut", tlSensitive: "Sensible pour la vie privée : l'activer demande une confirmation.", tlMetricsUsing: "Éléments du tableau qui l'utilisent", tlPrivacyIcon: "Confidentialité : {0}",
      tlGoSettings: "Ouvrir les réglages", tlGoField: "Voir le champ",
      tlLockOwned: "Dépend de l'interrupteur {0}.", tlLockFeature: "Il faut l'interrupteur {0}, qui est désactivé.", tlLockMissing: "Vient avec la fonction {0}, absente de cette version.", tlLockVoice: "Il faut la voix : à régler dans les réglages.", tlLockConfig: "À configurer : rattachez des tableaux, des jeux de données ou des rôles à leur {0} (context: dans la configuration).", tlLockSuperset: "Seulement dans Superset, qui tient le journal des actions.",
      tlCtx_country: "pays", tlCtx_campaign: "campagne", tlCtx_campaignType: "type de campagne", tlOr: "ou",
      "tlF_review.daily": "revue quotidienne", tlF_clarify: "clarifier l'intention", tlF_cache: "réponses gardées", tlF_personalDashboards: "tableaux personnels", tlF_voice: "voix",
      tlConfirmTitle: "Activer « {0} » ?", tlConfirmLede: "Ce champ touche à la vie privée. Voici ce qu'il enregistre :", tlConsent: "Chaque utilisateur voit cet avis une fois, et l'accepte, avant que le micro n'enregistre :", tlNoConsent: "Aucun avis de consentement n'est défini. Ajoutez-en un sous Voix dans les réglages pour prévenir les utilisateurs avant tout enregistrement.", tlConfirmOn: "Activer",
      tlSavedOn: "Enregistré. S'applique à la question suivante.", tlSavedOff: "Enregistré. Ce qui a déjà été enregistré est gardé jusqu'à expiration.",
      st_recording: "enregistré", "st_enabled-no-data": "activé, rien encore", st_off: "désactivé", "st_needs-config": "à configurer",
      tlLegend: "✓ enregistré · ◐ activé, rien encore · ○ désactivé · ⚠ à configurer", tlPrint: "Imprimer", tlCopy: "Copier en Markdown", tlCopied: "Copié.",
      tlAbsent: "La télémétrie n'est pas disponible sur ce serveur.", tlSwitchAbsent: "Ce réglage ne peut pas être modifié d'ici sur ce serveur.",
    },
  };

  // The telemetry catalogue in French (categories and fields, metric groups and metrics, the privacy notes of the sensitive fields); English comes from the server.
  const TL_FR = {
    categories: { who: "Qui et où", asked: "Ce qui a été demandé", happened: "Ce qui s'est passé", "cost-speed": "Coût et rapidité", feedback: "Avis", voice: "Voix", texts: "Textes" },
    fields: {
      user: ["Nom d'utilisateur", "Qui a posé la question, sur chaque enregistrement."],
      roles: ["Noms des rôles", "Les rôles que la connexion donne à la personne."],
      context: ["Étiquettes de campagne et de pays", "La campagne, le type de campagne et le pays que la section context: de la configuration rattache au tableau, au jeu de données ou au rôle."],
      conversation: ["Conversation", "La conversation à laquelle appartient une question, pour compter les relances."],
      selections: ["Filtres choisis sur le tableau", "Les valeurs de filtre choisies au moment de la question. Les valeurs sont chiffrées sauf si les mots des questions sont gardés."],
      "device-class": ["Appareil et largeur d'écran", "Téléphone, tablette ou ordinateur, et un écran étroit, moyen ou large."],
      "device-network": ["Type de réseau et économiseur de données", "Wifi ou mobile (2g à 4g), et si l'économiseur de données est actif."],
      "question-hash": ["Empreinte et longueur de la question", "Une empreinte chiffrée des mots de la question, pour compter les répétitions sans garder les mots, et son nombre de mots."],
      language: ["Langues", "La langue choisie dans la discussion, celle de la question et celle de la réponse."],
      repeats: ["Reposée", "La question antérieure, à moins de deux minutes, que celle-ci répète en d'autres mots, et si elle était dite."],
      outcome: ["Comment ça s'est terminé", "Répondue, refusée, en échec ou question en retour, et pourquoi."],
      work: ["Type de question et travail fourni", "Directe, dérivée, graphique ou méta, et le nombre d'appels d'outils, de requêtes, d'étapes de calcul et de modifications du tableau."],
      review: ["Étape de vérification", "Si le vérificateur est passé, ses remarques importantes, et si une correction a suivi."],
      reuse: ["Réponses gardées utilisées", "Le niveau de la réponse gardée utilisée, et ce qu'elle a fait économiser."],
      "superset-actions": ["Exports et partages dans Superset", "Lus dans le journal des actions de Superset au moment où l'on regarde, pour les tableaux sur lesquels {name} travaille. Rien n'est copié dans les enregistrements."],
      "daily-review": ["Passages et propositions de la revue quotidienne", "Tenus par la revue quotidienne elle-même."],
      "open-questions": ["Questions ouvertes", "Les questions à deux lectures, tenues par la fonction de clarification."],
      cost: ["Coût, jetons et modèles", "Le coût de chaque question (modèle, voix et vérification), les jetons, et les modèles qui ont répondu."],
      timing: ["Temps de réponse", "Le temps jusqu'aux premiers mots et jusqu'à la fin de la réponse."],
      queue: ["Attente d'une place libre", "Combien de temps une question a attendu dans la file aux heures chargées."],
      abandoned: ["Réponses quittées avant la fin", "Les réponses quittées avant leur fin, et comment."],
      feedback: ["Pouce levé ou baissé, et la raison", "L'avis sous une réponse, la raison choisie, et une empreinte de tout commentaire."],
      "quick-replies": ["Réponses rapides choisies", "Le bouton choisi quand l'assistant a posé une question en retour."],
      explain: ["« Comment c'est calculé » ouvert", "Chaque fois que quelqu'un ouvre le détail d'une réponse."],
      "export-share": ["Graphiques exportés, tableaux partagés", "Les exports et partages faits dans l'application de {name}."],
      "personal-dashboards": ["Tableaux personnels et dispositions gardées", "Les tableaux créés, copiés ou supprimés, et les dispositions utilisées : identifiants et nombres seulement."],
      input: ["Tapée ou dite", "Si une question a été tapée ou dite."],
      "transcript-links": ["Liens vers les transcriptions", "La transcription d'où vient une question dite."],
      "transcript-edits": ["Corrections de la transcription", "Combien de mots ont changé entre ce que la reconnaissance a entendu et ce qui a été envoyé, avec une empreinte de la transcription."],
      "speech-cost": ["Coût et durée de la reconnaissance vocale", "Le coût de chaque transcription, la durée de l'extrait, le modèle, et s'il y a eu un nouvel essai."],
      "voice-not-sent": ["Transcriptions jamais envoyées", "Une transcription qu'aucune question n'a reprise dans l'heure."],
      "question-text": ["Mots des questions", "Les mots de chaque question tels qu'envoyés, les valeurs des filtres et les commentaires."],
      "transcript-text": ["Mots des transcriptions", "Ce que la reconnaissance vocale a entendu, mot pour mot."],
      "voice-audio": ["Enregistrements", "L'enregistrement de chaque question dite, pendant les jours réglés sous Voix."],
    },


    sensitive: {
      "question-text": "Garde les mots de chaque question telle qu'envoyée, les valeurs des filtres du tableau et les commentaires. Une question peut nommer des lieux, des personnes ou des chiffres. Désactivé, seule une empreinte chiffrée est gardée : les questions répétées se comptent toujours.",
      "transcript-text": "Garde mot pour mot ce que la reconnaissance vocale a entendu, à côté de la question envoyée. Une question dite peut nommer des lieux, des personnes ou des chiffres. Désactivé, une empreinte chiffrée suffit à compter les corrections.",
      "voice-audio": "Garde l'enregistrement de chaque question dite pendant le nombre de jours réglé sous Voix dans les réglages, pour que les administrateurs l'écoutent, l'exportent et le suppriment. Une voix peut identifier la personne. Chaque utilisateur voit l'avis de consentement une fois avant que le micro n'enregistre.",
      "device-class": "Enregistre le type d'appareil et la largeur d'écran de chaque utilisateur à chaque question. Avec le nom d'utilisateur, cela décrit l'équipement de chacun.",
      "device-network": "Enregistre le type de réseau de chaque utilisateur (wifi, mobile, 2g à 4g) et si l'économiseur de données est actif, à chaque question.",
    },
    privacy: { "usernames visible to admins with the usage right": "noms d'utilisateur visibles des administrateurs qui ont le droit d'usage", "stores question text": "garde le texte des questions", "stores transcripts": "garde les transcriptions", "stores audio": "garde l'audio", "device class per user": "type d'appareil par utilisateur", "network type per user": "type de réseau par utilisateur" },
  };

  /**
   * The tab, given what the panel lends it: h (an element), t (the panel's words), nf, when, store, toast, card and
   * pill; render() to draw the current tab again; lang(), tab() and usageInfo() as they stand; goTab(name);
   * usageBoardView(board, options), the board and chat Overview uses; assistant, the assistant's name; and field, a
   * field to open at first (from #telemetry/field/<id>); host, where the host's own routes are from this page ("../"
   * when not given).
   */
  function create(p) {
    const { h, t, nf, when, store, toast, card, pill, assistant } = p;
    const render = () => p.render();
    let pendingField = p.field || null;
    const HOST = typeof p.host === "string" ? p.host : "../";

    /** The telemetry checklist (GET <prefix>/telemetry/checklist), if the server has it: null when it does not (404). */
    async function telemetryApi() {
      const res = await fetch(`${HOST}telemetry/checklist`, { credentials: "same-origin" });
      if (res.status === 404) return null;
      let data = null;
      try { data = await res.json(); } catch (e) { return null; }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data && Array.isArray(data.categories) ? data : null;
    }
    /**
     * A change to the switchboard through the host's Settings routes: PUT <prefix>/settings/telemetry {"<switch>": value}.
     * A privacy-sensitive field the server wants confirmed (409 with confirm) opens the confirm step, then goes again.
     */
    async function setTelemetrySwitch(body) {
      const put = (b) => fetch(`${HOST}settings/telemetry`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b), credentials: "same-origin" });
      let res = await put(body);
      if (res.status === 404) throw new Error(t("tlSwitchAbsent"));
      let data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
      if (res.status === 409 && data && data.confirm) {
        const id = data.confirm.key.replace(/^(fields|items)\./, "");
        if (!(await confirmSensitive(id, tlFieldLabel({ id, label: data.confirm.label }), data.confirm.sensitive, data.confirm.consent, id === "voice-audio"))) return null;
        res = await put({ ...body, confirm: true });
        data = null;
        try { data = await res.json(); } catch (e) { /* not JSON */ }
      }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    }
    // The server's words (English, with {name} for the assistant's name), in the panel's language.
    const nm = (s) => String(s === null || s === undefined ? "" : s).replace(/\{name\}/g, () => assistant);
    const fr = () => p.lang() === "fr";
    const tlFieldLabel = (f) => nm(fr() && TL_FR.fields[f.id] ? TL_FR.fields[f.id][0] : f.label);
    const tlFieldAbout = (f) => nm(fr() && TL_FR.fields[f.id] ? TL_FR.fields[f.id][1] : f.about);
    const tlCategory = (c) => nm((fr() && TL_FR.categories[c.id]) || c.title);
    const tlSensitive = (id, text) => nm((fr() && TL_FR.sensitive[id]) || text);
    const tlPrivacyNote = (p) => (fr() && TL_FR.privacy[p]) || p;
    const featureWord = (f) => t(`tlF_${f}`) === `tlF_${f}` ? f : t(`tlF_${f}`);
    const orWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${t("tlOr")} ${xs[xs.length - 1]}`);
    /** A lock in the panel's language: why the switch can't be changed here. */
    function lockText(lock, fallback) {
      if (!lock) return nm(fallback);
      if (lock.kind === "owned") return t("tlLockOwned", featureWord(lock.feature));
      if (lock.kind === "feature") return lock.missing ? t("tlLockMissing", featureWord(lock.feature)) : t("tlLockFeature", featureWord(lock.feature));
      if (lock.kind === "voice") return t("tlLockVoice");
      if (lock.kind === "needs-config") return t("tlLockConfig", orWords((lock.context || []).map((c) => t(`tlCtx_${c}`))));
      if (lock.kind === "superset") return t("tlLockSuperset");
      return nm(fallback);
    }

    /** The confirm step before a privacy-sensitive field turns on: its privacy note, and for recordings the consent notice. Resolves true to go ahead. */
    function confirmSensitive(id, label, sensitive, consent, audio) {
      return new Promise((resolve) => {
        const title = h("h2", { id: "tl-confirm-t", class: "tl-confirm-title" }, t("tlConfirmTitle", label));
        const yes = h("button", { class: "btn", type: "button", onclick: () => { d.close(); resolve(true); } }, t("tlConfirmOn"));
        const d = h("dialog", { class: "modal tl-confirm", "aria-labelledby": "tl-confirm-t" },
          title,
          h("p", {}, t("tlConfirmLede")),
          h("blockquote", {}, tlSensitive(id, sensitive)),
          audio ? (consent ? [h("p", {}, t("tlConsent")), h("blockquote", {}, consent)] : h("p", { class: "mute" }, t("tlNoConsent"))) : null,
          h("div", { class: "actions" },
            h("button", { class: "btn quiet", type: "button", onclick: () => { d.close(); resolve(false); } }, t("cancel")),
            yes));
        d.addEventListener("cancel", () => resolve(false));
        document.body.append(d);
        d.showModal();
        yes.focus();
        d.addEventListener("close", () => d.remove());
      });
    }
    /** One tooltip for the table's truncated text and privacy marks, on hover and on keyboard focus. */
    let tlPop = null;
    function showTip(e) {
      const el = e.currentTarget;
      const text = el.dataset.tip;
      if (!text) return;
      if (!tlPop) tlPop = h("div", { class: "tl-pop", role: "tooltip", id: "tl-pop" });
      tlPop.textContent = text;
      document.body.append(tlPop);
      const r = el.getBoundingClientRect();
      const w = Math.min(340, window.innerWidth - 24);
      tlPop.style.maxWidth = `${w}px`;
      tlPop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
      const below = r.bottom + 6;
      tlPop.style.top = `${below + tlPop.offsetHeight > window.innerHeight - 8 ? r.top - tlPop.offsetHeight - 6 : below}px`;
      el.setAttribute("aria-describedby", "tl-pop");
    }
    function hideTip(e) {
      if (tlPop) tlPop.remove();
      if (e && e.currentTarget && e.currentTarget.removeAttribute) e.currentTarget.removeAttribute("aria-describedby");
    }
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
    const tip = (cls, text, kid, extra) => h("span", { class: `tl-tip ${cls || ""}`, tabindex: "0", "data-tip": text, onmouseenter: showTip, onmouseleave: hideTip, onfocus: showTip, onblur: hideTip, ...(extra || {}) }, kid);
    /** The privacy mark: an eye, since these fields say something about people; it is not a lock. */
    const EYE = () => {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(ns, "path");
      path.setAttribute("fill", "currentColor");
      path.setAttribute("d", "M8 3C4.4 3 1.6 5.4.5 8c1.1 2.6 3.9 5 7.5 5s6.4-2.4 7.5-5C14.4 5.4 11.6 3 8 3Zm0 8.2A3.2 3.2 0 1 1 8 4.8a3.2 3.2 0 0 1 0 6.4Zm0-1.7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z");
      svg.append(path);
      return svg;
    };
    const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(p.lang(), { day: "numeric", month: "short" }) : "—");
    const collapsedGroups = () => { try { return new Set(JSON.parse(store.get("tl-collapsed") || "[]")); } catch (e) { return new Set(); } };
    const goSettings = () => p.goTab("settings");
    /** A field's row under What's recorded: that view, the row brought into view and its switch focused. */
    function openField(id) {
      tlView = "recorded";
      store.set("tl-view", tlView);
      tlFocus = id;
      if (p.tab() === "telemetry") render();
      else p.goTab("telemetry");
    }
    let tlView = store.get("tl-view") === "metrics" ? "metrics" : "recorded";
    /** After a render, the field row to bring into view (from a metric's "show the field"). */
    let tlFocus = null;

    async function telemetry() {
      if (pendingField) {
        tlView = "recorded";
        tlFocus = pendingField;
        pendingField = null;
      }
      const C = window.LenspackChecklist;
      let data = null;
      try { data = C ? await telemetryApi() : null; } catch (e) { data = null; }
      if (!data) return [card(t("tlTitle"), null, h("p", { class: "empty" }, t("tlAbsent")))];
      // The page's words: the catalogue in the panel's language, with the assistant's name.
      const view = {
        ...data,
        categories: data.categories.map((c) => ({ ...c, title: tlCategory(c), rows: c.rows.map((r) => ({ ...r, label: tlFieldLabel(r), about: tlFieldAbout(r), reasonText: r.switch.lock ? lockText(r.switch.lock, r.switch.reason) : null })) })),
      };
      const md = () => C.markdown(view, t, { date: (iso) => when(iso), num: (n) => nf(n), name: nm });
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
      // A change: saved, said (turning off keeps what was recorded), and the page drawn again from the server's answer.
      const change = (body, on, input) => async () => {
        if (input) input.disabled = true;
        try {
          const r = await setTelemetrySwitch(body);
          if (r !== null) toast(on ? t("tlSavedOn") : t("tlSavedOff"));
        } catch (e) {
          toast(e.message, true);
        }
        await render();
      };
      const toggle = (r, input) => {
        const on = input.checked;
        const key = r.switch.key;
        if (on && r.switch.sensitive) {
          input.checked = false;
          return confirmSensitive(r.id, r.label, r.switch.sensitive, r.switch.consent, r.id === "voice-audio").then((ok) => (ok ? change({ [key]: true, confirm: true }, true, input)() : null));
        }
        return change({ [key]: on }, on, input)();
      };
      /** Where a fix lives: a feature's switch on the Settings tab, or a field's switch in What's recorded. */
      const fixButton = (fix, label) => {
        if (!fix) return null;
        if (fix.kind === "settings") return h("button", { class: "btn sm quiet no-print", type: "button", onclick: goSettings }, t("tlGoSettings"));
        if (fix.kind === "field") return h("button", { class: "btn sm quiet no-print", type: "button", onclick: () => showField(fix.id) }, label || t("tlGoField"));
        return null;
      };
      const showField = openField;
      // A field to bring into view: its category opens, so the row can be seen.
      if (tlFocus) {
        const cat = data.categories.find((c) => c.rows.some((r) => r.id === tlFocus));
        if (cat) {
          const now = collapsedGroups();
          now.delete(cat.id);
          store.set("tl-collapsed", JSON.stringify([...now]));
        }
      }
      const setView = (v) => {
        tlView = v;
        store.set("tl-view", v);
        render();
      };

      // ---- What's recorded: the fields, each with its switch -----------------------------------------
      const statusCls = (st) => (st === "recording" ? "ok" : st === "needs-config" ? "warn" : st === "enabled-no-data" ? "acc" : "");
      const collapsed = collapsedGroups();
      const categoryBody = (c) => {
        const gid = `tl-g-${c.id}`;
        const own = c.rows.filter((r) => r.switch.key);
        const rec = c.rows.filter((r) => r.status === "recording").length;
        const body = h("tbody", { class: collapsed.has(c.id) ? "collapsed" : "", id: `${gid}-rows` });
        const chev = h("button", { class: "tl-chev", type: "button", "aria-expanded": String(!collapsed.has(c.id)), "aria-controls": `${gid}-rows`, "aria-label": t("tlShowHide", c.title), onclick: () => {
          const open = body.classList.toggle("collapsed");
          chev.setAttribute("aria-expanded", String(!open));
          const now = collapsedGroups();
          if (open) now.add(c.id); else now.delete(c.id);
          store.set("tl-collapsed", JSON.stringify([...now]));
        } }, "▾");
        // The category's switch holds no value: it shows the switches inside it (on, off or mixed) and sets them all.
        const noteId = `${gid}-note`;
        const csw = own.length ? h("input", { class: "tg", type: "checkbox", checked: c.state === "on", disabled: c.next === null, "aria-label": t("tlCategory", c.title), "aria-describedby": c.note ? noteId : null, onclick: (e) => { e.preventDefault(); if (c.next !== null) change({ [`categories.${c.id}`]: c.next }, c.next, csw)(); } }) : null;
        if (csw) csw.indeterminate = c.state === "mixed";
        body.append(h("tr", { class: "tl-g" }, h("th", { colspan: "7", scope: "rowgroup", id: gid },
          h("div", { class: "tl-gin" }, chev, csw, h("span", {}, c.title), h("span", { class: "print-on" }, t(c.state === "mixed" ? "tlMixed" : c.state === "on" ? "tlOn" : "tlOff")), h("span", { class: "tl-gn" }, t("tlGroupCount", rec, c.rows.length))),
          c.note ? h("div", { class: "tl-gnote", id: noteId }, t(c.note === "sensitive-only" ? "tlCatOnly" : "tlCatApart")) : null)));
        for (const r of c.rows) {
          const did = `tl-d-${r.id}`;
          const sw = r.switch || {};
          const locked = !sw.editable;
          const input = h("input", { class: "tg", type: "checkbox", role: "switch", checked: sw.on, disabled: locked, "aria-label": r.label, "aria-describedby": locked ? `${did}-lock` : null, onchange: () => toggle(r, input) });
          const x = h("button", { class: "tl-x", type: "button", "aria-expanded": "false", "aria-controls": did, "aria-label": t("tlDetails", r.label) }, "›");
          const off = r.status === "off" && r.offSince;
          const privacy = [sw.sensitive ? tlSensitive(r.id, sw.sensitive) : null, ...(r.privacy || []).map(tlPrivacyNote)].filter(Boolean);
          const shortPrivacy = (r.privacy || []).map(tlPrivacyNote).join(" · ");
          const fieldsTip = t("tlFieldsTip", (r.fields || []).join(", "));
          const used = r.usedBy || [];
          const usedText = used.length ? `${used.slice(0, 2).map((m) => m.label).join(" · ")}${used.length > 2 ? ` ${t("tlUsedMore", used.length - 2)}` : ""}` : t("tlUsedNone");
          // Shown on the row itself: why a switch is locked (with where to fix it), or what a field means for privacy.
          const sub = locked
            ? h("div", { class: "tl-lock", id: `${did}-lock` }, h("span", {}, r.reasonText), " ", fixButton(sw.fix))
            : shortPrivacy ? h("div", { class: "tl-sub" }, shortPrivacy) : null;
          const row = h("tr", { class: `tl-i${r.status === "off" ? " is-off" : ""}${locked ? " is-locked" : ""}`, id: `tl-r-${r.id}` },
            h("td", { class: "c-on" }, sw.key || sw.lock ? input : null, h("span", { class: "print-on" }, sw.key || sw.lock ? (sw.on ? t("tlOn") : t("tlOff")) : t("tlNoSwitch"))),
            h("th", { class: "c-name", scope: "row" }, tip("tl-fname", fieldsTip, r.label), sub),
            h("td", { class: "c-st" }, pill(t(`st_${r.status}`), statusCls(r.status)), off ? h("span", { class: "tl-since" }, t("tlSince", shortDate(r.offSince), r.offBy)) : null),
            h("td", { class: "c-n" }, nf(r.count7d)),
            h("td", { class: "c-used" }, used.length ? tip("", used.map((m) => m.label).join(" · "), usedText) : h("span", { class: "mute" }, usedText)),
            h("td", { class: "c-pv" }, privacy.length ? tip("tl-pv", privacy.join(" · "), EYE(), { role: "img", "aria-label": t("tlPrivacyIcon", privacy.join(" · ")) }) : null),
            h("td", { class: "c-x" }, x));
          // The row's detail, collapsed: the longer text, and on a phone the columns that do not fit.
          const dl = h("dl", { class: "tl-dl" },
            h("dt", {}, t("tlAbout")), h("dd", {}, r.about),
            h("div", { class: "p-only" }, h("dt", {}, t("tl7d")), h("dd", {}, nf(r.count7d)), h("dt", {}, t("tlUsedBy")), h("dd", {}, used.length ? used.map((m) => m.label).join(" · ") : t("tlUsedNone"))),
            h("dt", {}, t("tlLastSeen")), h("dd", {}, r.lastSeen ? when(r.lastSeen) : "—"),
            off ? [h("dt", {}, t("tlStatus")), h("dd", {}, t("tlOffSince", when(r.offSince), r.offBy))] : null,
            r.status !== "recording" && r.howToEnable && !locked ? [h("dt", {}, t("tlHow")), h("dd", {}, h("span", { class: "tl-warn" }, nm(r.howToEnable)))] : null,
            privacy.length ? [h("dt", {}, t("tlPrivacy")), h("dd", {}, privacy.join(" · "), sw.sensitive ? h("div", { class: "mute" }, t("tlSensitive")) : null)] : null,
            used.length ? [h("dt", { class: "hide-p" }, t("tlMetricsUsing")), h("dd", { class: "hide-p" }, used.map((m) => m.label).join(" · "))] : null,
            (r.fields || []).length ? [h("dt", {}, t("tlFields")), h("dd", {}, r.fields.map((f) => h("code", {}, f)))] : null,
            h("dt", {}, t("tlSource")), h("dd", {}, h("code", {}, r.source)),
            sw.key ? [h("dt", {}, t("tlDefault")), h("dd", {}, sw.default ? t("tlOn") : t("tlOff"), " · ", h("code", {}, `telemetry.${sw.key}`))] : null);
          const detail = h("tr", { class: "tl-d", id: did, hidden: true }, h("td", { colspan: "7" }, dl));
          x.onclick = () => {
            const open = detail.hidden;
            detail.hidden = !open;
            x.setAttribute("aria-expanded", String(open));
          };
          body.append(row, detail);
        }
        return body;
      };
      const master = h("input", { class: "tg", type: "checkbox", role: "switch", checked: data.telemetry.on, "aria-label": t("tlMaster"), onchange: () => change({ telemetry: master.checked }, master.checked, master)() });
      const days = h("input", { type: "number", min: "1", max: "3650", value: String((data.settings && data.settings.retentionDays) || 90), "aria-label": t("tlRetention") });
      const masterSince = !data.telemetry.on && data.telemetry.changed ? data.telemetry.changed : null;
      const recorded = () => [
        h("p", { class: "lede mute tl-vlede" }, t("tlRecLede")),
        h("p", { class: "tl-summary" }, C.summary(view, t)),
        h("div", { class: "tl-bar" },
          h("label", {}, master, h("b", {}, t("tlMaster")), h("span", { class: "print-on" }, data.telemetry.on ? t("tlOn") : t("tlOff")), masterSince ? h("span", { class: "tl-since" }, t("tlSince", shortDate(masterSince.at), masterSince.by)) : null),
          h("label", {}, h("span", {}, t("tlRetention")), days, h("button", { class: "btn sm quiet no-print", type: "button", onclick: change({ retentionDays: Number(days.value) }, true) }, t("save"))),
          h("p", { class: "tl-note" }, t("tlNote"))),
        data.telemetry.on ? null : h("p", { class: "tl-banner", role: "status" }, t("tlTelOff")),
        h("div", { class: "tl-wrap" }, h("table", { class: "tl" },
          h("caption", { class: "vh" }, t("tlViewRecorded")),
          h("thead", {}, h("tr", {},
            h("th", { class: "c-on", scope: "col" }, t("tlColOn")), h("th", { class: "c-name", scope: "col" }, t("tlField")), h("th", { class: "c-st", scope: "col" }, t("tlStatus")),
            h("th", { class: "c-n", scope: "col" }, tip("", t("tl7dHelp"), t("tl7d"))), h("th", { class: "c-used", scope: "col" }, t("tlUsedBy")),
            h("th", { class: "c-pv", scope: "col" }, h("span", { class: "vh" }, t("tlPrivacyCol"))), h("th", { class: "c-x", scope: "col" }, h("span", { class: "vh" }, t("tlDetailsCol"))))),
          view.categories.map(categoryBody))),
        h("p", { class: "tl-legend" }, t("tlGenerated", when(data.generatedAt)), " ", t("tlLegend")),
      ];

      // ---- What it tells you: a board over the records, with a chat about it ------------------------
      // The usage pack's telemetry board: each widget a measure the engine works out from the records when it is drawn.
      // A widget that needs a field that is off or not set up says so, with a link to the field's row above.
      const metrics = () => [
          data.telemetry.on ? null : h("p", { class: "tl-banner", role: "status" }, t("tlTelOff")),
        p.usageInfo()
          ? p.usageBoardView(p.usageInfo().telemetryBoard || "telemetry", { title: t("askTl"), lede: t("askTlLede"), placeholder: t("tlEx1"), examples: [t("tlEx1"), t("tlEx2"), t("tlEx3")] })
          : h("p", { class: "empty" }, t("tlBoardOff")),
      ];

      const tabBtn = (v, label) => h("button", { type: "button", "aria-pressed": String(tlView === v), onclick: () => setView(v) }, label);
      const out = [
        h("div", { class: "tl-head" },
          h("div", {}, h("h2", { class: "tl-title" }, t("tlTitle")), h("p", { class: "lede mute tl-lede" }, t("tlLede"))),
          h("div", { class: "row no-print" }, h("button", { class: "btn sm ghost", type: "button", onclick: () => window.print() }, t("tlPrint")), h("button", { class: "btn sm", type: "button", onclick: copy }, t("tlCopy")))),
        h("div", { class: "seg tl-views no-print", role: "group", "aria-label": t("tlViews") }, tabBtn("recorded", t("tlViewRecorded")), tabBtn("metrics", t("tlViewMetrics"))),
        h("h2", { class: "print-on tl-ptitle" }, tlView === "metrics" ? t("tlViewMetrics") : t("tlViewRecorded")),
        tlView === "metrics" ? metrics() : recorded(),
      ];
      if (tlFocus) {
        const id = tlFocus;
        tlFocus = null;
        setTimeout(() => {
          const el = document.getElementById(`tl-r-${id}`);
          if (!el) return;
          el.scrollIntoView({ block: "center" });
          el.classList.add("flash");
          const sw = el.querySelector("input.tg:not(:disabled)") || el.querySelector(".tl-tip");
          if (sw) sw.focus({ preventScroll: true });
          setTimeout(() => el.classList.remove("flash"), 1600);
        }, 0);
      }
      return out;
    }

    return { render: telemetry, openField };
  }

  window.LenspackTelemetry = { strings: STRINGS, create };
})();
