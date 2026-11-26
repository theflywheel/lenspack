// The Lenspack admin pages: plain JavaScript, no framework, no build. The same script draws them on Lenspack's own page
// (shell "panel") and inside Superset's page (shell "superset"); the host says where its routes are (window.__lpAdmin),
// so the pages work wherever a host mounts them. English and French.
(function () {
  "use strict";

  const STRINGS = {
    en: {
      title: "{name} admin", pack: "Pack", loading: "Loading…", failed: "Could not load: {0}", saved: "Saved.", done: "Done.",
      tabOverview: "Overview", tabReview: "Review", tabQuestions: "Open questions", tabProposals: "Proposals", tabDefinitions: "Definitions", tabCache: "Cache", tabSettings: "Settings",
      themeAuto: "Theme: system", themeLight: "Theme: light", themeDark: "Theme: dark",
      // Overview
      lastDays: "Last {0} days", turns: "Questions", people: "People", cost: "Cost", errors: "Errors", refusals: "Refusals", findings: "Reviewer findings", openQ: "Open questions", pending: "Proposals waiting", saved$: "Saved by cache",
      day: "Day", asked: "Asked back", assumed: "Answered with a reading", picked: "Quick replies", byDay: "By day", estimateNote: "Costs are estimates from list prices.",
      usageLede: "How people use this server: a {name} board over the server's own record of its chat turns, drawn by the same engine as every other board. Change it like any board.", usageFrom: "From {0}.", src_telemetry: "the turn telemetry", src_audit: "the audit log", src_none: "nothing yet",
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
      bTitle: "Name", bLede: "What the assistant is called on dashboards and in this panel: its name, the dashboard button's label, and words for one language only. Saved for everyone; open pages show it after a reload. Leave a box empty for the deployment's value.",
      bName: "Name", bButton: "Button label", bButtonHelp: "{0} in the label stands for the name.", bIcon: "Icon: an https:// address, a path on this site, or a small data:image file", bPowered: "Show a small “Powered by Lenspack” credit under the chat (only when the assistant has its own name)", bIn: "In {0}", bSave: "Save name", bPreview: "Preview",
      sLede: "Switches for this server. A change applies to the next question. Where a value comes from: default, the config file, the environment, or this page.",
      source_default: "default", source_config: "config", source_env: "environment", source_settings: "set here", reset: "Reset to the deployment's value",
      // Telemetry
      tabTelemetry: "Telemetry", tlTitle: "What this deployment records", tlLede: "Every item {name} can record for this deployment, each with its switch. A change applies to the next question. Print it or copy it into a pilot report.",
      tlGenerated: "Checked {0}.", tlSumRecording: "{0} of {1} recording", tlSumNoData: "{0} on but no data", tlSumConfig: "{0} need configuration", tlSumOff: "{0} off", tlSumNot: "{0} not telemetry",
      tlMaster: "Record telemetry", tlRetention: "Keep records for (days)", tlNote: "Switching something off stops new records. What was already recorded stays until it ages out (the days set here) or is deleted per user.", tlOn: "on", tlOff: "off", tlNoSwitch: "no switch",
      tlColOn: "On", tlItem: "Item", tlStatus: "Status", tl7d: "7 days", tlLastSeen: "Last seen", tlDecision: "Drives", tlPrivacyCol: "Privacy", tlDetailsCol: "Details", tlNotes: "Notes",
      tlDetails: "Details for {0}", tlSection: "Record the {0} section", tlShowHide: "Show or hide {0}", tlGroupCount: "{0} of {1} recording", tlSince: "since {0} · {1}", tlOffSince: "Off since {0}, by {1}.",
      tlHow: "How to enable", tlFields: "Fields read", tlPrivacy: "Privacy", tlWhy: "Why it can't be switched here", tlSource: "Source", tlDefault: "Default", tlSensitive: "Privacy-sensitive: turning it on asks you to confirm.",
      tlOwned: "Change it with the {0} switch on the Settings tab.", tlGoSettings: "Open Settings",
      tlConfirmTitle: "Turn on {0}?", tlConfirmLede: "This item is privacy-sensitive. Here is what it records:", tlConsent: "Each user sees this notice once, and agrees, before the mic records:", tlNoConsent: "No consent notice is set yet. Set one under Kept recordings on the Models & voice tab so people are told before they are recorded.", tlConfirmOn: "Turn on",
      tlSavedOn: "Saved. Applies to the next question.", tlSavedOff: "Saved. What was already recorded is kept until it ages out.",
      st_recording: "recording", "st_enabled-no-data": "on, no data yet", st_off: "off", "st_needs-config": "needs configuration", "st_not-telemetry": "not telemetry",
      tlLegend: "✓ recording · ◐ on but no data · ○ off · ⚠ needs configuration · — not telemetry", tlPrint: "Print", tlCopy: "Copy as Markdown", tlCopied: "Copied.",
      // Access
      tabAccess: "Access", acWho: "Who has access", acAdmins: "Admins", acUsers: "Users", acFrom: "set by {0}", acFromDefault: "default",
      acOwners: "Owners", acOwnerNote: "Change owners in the deployment, then restart.", acGranted: "Granted admins", acNoGranted: "No granted admins.",
      acUser: "User", acBy: "Granted by", acAt: "When", acRemove: "Remove", acAdd: "Add", acAddPh: "Superset user name or id:12",
      acOwnersOnly: "Only owners can add or remove admins.", acRemoveQ: "Remove {0}?", acSeeded: "From the deployment", acPeople: "People granted",
      acNoPeople: "Nobody granted yet.", acSearch: "Search", acRange: "{0}–{1} of {2}", acPrev: "Previous", acNext: "Next", acRoles: "Roles: {0}",
      acEveryone: "Everyone signed in", acSignOut: "Sign out", acNoneSet: "Not available on this server.",
      tlAbsent: "Telemetry is not available on this server.", tlAbsentHelp: "This server does not report its telemetry yet. The checklist appears here once it does.", tlSwitchAbsent: "This server cannot change that setting from here.",
    },
    fr: {
      title: "Administration {name}", pack: "Pack", loading: "Chargement…", failed: "Chargement impossible : {0}", saved: "Enregistré.", done: "Fait.",
      tabOverview: "Vue d'ensemble", tabReview: "Revue", tabQuestions: "Questions ouvertes", tabProposals: "Propositions", tabDefinitions: "Définitions", tabCache: "Cache", tabSettings: "Réglages",
      themeAuto: "Thème : système", themeLight: "Thème : clair", themeDark: "Thème : sombre",
      lastDays: "{0} derniers jours", turns: "Questions", people: "Personnes", cost: "Coût", errors: "Erreurs", refusals: "Refus", findings: "Remarques du vérificateur", openQ: "Questions ouvertes", pending: "Propositions en attente", saved$: "Économisé par le cache",
      day: "Jour", asked: "Questions en retour", assumed: "Réponses avec une lecture", picked: "Réponses rapides", byDay: "Par jour", estimateNote: "Coûts estimés d'après les prix publics.",
      usageLede: "L'usage de ce serveur : un tableau {name} sur le propre relevé des échanges du serveur, dessiné par le même moteur que tous les tableaux. Modifiable comme n'importe quel tableau.", usageFrom: "Source : {0}.", src_telemetry: "la télémétrie des échanges", src_audit: "le journal d'audit", src_none: "rien pour l'instant",
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
      bTitle: "Nom", bLede: "Comment l'assistant s'appelle sur les tableaux de bord et dans ce panneau : son nom, le libellé du bouton, et des mots pour une seule langue. Enregistré pour tout le monde ; les pages ouvertes l'affichent après rechargement. Laissez une case vide pour la valeur du déploiement.",
      bName: "Nom", bButton: "Libellé du bouton", bButtonHelp: "{0} dans le libellé représente le nom.", bIcon: "Icône : une adresse https://, un chemin sur ce site, ou un petit fichier data:image", bPowered: "Afficher une petite mention « Propulsé par Lenspack » sous la discussion (seulement quand l'assistant a son propre nom)", bIn: "En {0}", bSave: "Enregistrer le nom", bPreview: "Aperçu",
      sLede: "Les interrupteurs de ce serveur. Un changement s'applique à la question suivante. Origine de chaque valeur : défaut, fichier de configuration, environnement ou cette page.",
      source_default: "défaut", source_config: "configuration", source_env: "environnement", source_settings: "réglé ici", reset: "Revenir à la valeur du déploiement",
      tabTelemetry: "Télémétrie", tlTitle: "Ce que ce déploiement enregistre", tlLede: "Chaque élément que {name} peut enregistrer pour ce déploiement, avec son interrupteur. Un changement s'applique à la question suivante. À imprimer ou à copier dans un rapport de pilote.",
      tlGenerated: "Vérifié le {0}.", tlSumRecording: "{0} sur {1} enregistrés", tlSumNoData: "{0} activés sans données", tlSumConfig: "{0} à configurer", tlSumOff: "{0} désactivés", tlSumNot: "{0} hors télémétrie",
      tlMaster: "Enregistrer la télémétrie", tlRetention: "Conserver (jours)", tlNote: "Désactiver un élément arrête les nouveaux enregistrements. Ce qui a déjà été enregistré reste jusqu'à expiration (les jours réglés ici) ou suppression par utilisateur.", tlOn: "activé", tlOff: "désactivé", tlNoSwitch: "sans interrupteur",
      tlColOn: "Actif", tlItem: "Élément", tlStatus: "État", tl7d: "7 jours", tlLastSeen: "Dernier", tlDecision: "Sert à", tlPrivacyCol: "Confidentialité", tlDetailsCol: "Détails", tlNotes: "Remarques",
      tlDetails: "Détails : {0}", tlSection: "Enregistrer la section {0}", tlShowHide: "Afficher ou masquer {0}", tlGroupCount: "{0} sur {1} enregistrés", tlSince: "depuis le {0} · {1}", tlOffSince: "Désactivé depuis le {0}, par {1}.",
      tlHow: "Pour l'activer", tlFields: "Champs lus", tlPrivacy: "Confidentialité", tlWhy: "Pourquoi il ne se règle pas ici", tlSource: "Source", tlDefault: "Par défaut", tlSensitive: "Sensible pour la vie privée : l'activer demande une confirmation.",
      tlOwned: "Se règle avec l'interrupteur {0} dans l'onglet Réglages.", tlGoSettings: "Ouvrir les réglages",
      tlConfirmTitle: "Activer « {0} » ?", tlConfirmLede: "Cet élément touche à la vie privée. Voici ce qu'il enregistre :", tlConsent: "Chaque utilisateur voit cet avis une fois, et l'accepte, avant que le micro n'enregistre :", tlNoConsent: "Aucun avis de consentement n'est défini. Ajoutez-en un sous Enregistrements gardés, dans l'onglet Modèles et voix, pour prévenir chacun avant tout enregistrement.", tlConfirmOn: "Activer",
      tlSavedOn: "Enregistré. S'applique à la question suivante.", tlSavedOff: "Enregistré. Ce qui a déjà été enregistré est gardé jusqu'à expiration.",
      st_recording: "enregistré", "st_enabled-no-data": "activé, sans données", st_off: "désactivé", "st_needs-config": "à configurer", "st_not-telemetry": "hors télémétrie",
      tlLegend: "✓ enregistré · ◐ activé sans données · ○ désactivé · ⚠ à configurer · — hors télémétrie", tlPrint: "Imprimer", tlCopy: "Copier en Markdown", tlCopied: "Copié.",
      // Accès
      tabAccess: "Accès", acWho: "Qui a accès", acAdmins: "Administrateurs", acUsers: "Utilisateurs", acFrom: "défini par {0}", acFromDefault: "par défaut",
      acOwners: "Propriétaires", acOwnerNote: "Les propriétaires se changent dans le déploiement, puis redémarrage.", acGranted: "Administrateurs ajoutés", acNoGranted: "Aucun administrateur ajouté.",
      acUser: "Utilisateur", acBy: "Ajouté par", acAt: "Quand", acRemove: "Retirer", acAdd: "Ajouter", acAddPh: "Nom d'utilisateur Superset ou id:12",
      acOwnersOnly: "Seuls les propriétaires ajoutent ou retirent des administrateurs.", acRemoveQ: "Retirer {0} ?", acSeeded: "Du déploiement", acPeople: "Personnes ajoutées",
      acNoPeople: "Personne n'est encore ajouté.", acSearch: "Rechercher", acRange: "{0}–{1} sur {2}", acPrev: "Précédent", acNext: "Suivant", acRoles: "Rôles : {0}",
      acEveryone: "Toute personne connectée", acSignOut: "Se déconnecter", acNoneSet: "Indisponible sur ce serveur.",
      tlAbsent: "La télémétrie n'est pas disponible sur ce serveur.", tlAbsentHelp: "Ce serveur ne communique pas encore sa télémétrie. La liste apparaîtra ici dès qu'il le fera.", tlSwitchAbsent: "Ce réglage ne peut pas être modifié d'ici sur ce serveur.",
    },
  };  // The admin pages' frame, the new tabs and the pager: terse, in both languages.
  Object.assign(STRINGS.en, {
    gUsage: "Usage", gAnswers: "Answers", gConfig: "Configuration", gRecords: "Records",
    tabModels: "Models & voice", tabSpend: "Spend & audit", tabAssistant: "Assistant",
    lede_overview: "How people use {name}, and what waits for you.",
    lede_review: "The daily review of answers, and what it found.",
    lede_questions: "Questions with more than one reading. Pick the one that counts.",
    lede_proposals: "Changes the review suggests. Nothing applies until you accept it.",
    lede_definitions: "What {name} is told about your data, with its history.",
    lede_cache: "Answers kept for questions asked again.",
    lede_models: "The models that answer and listen, and kept recordings.",
    lede_access: "Who is an admin, and who may use {name}.",
    lede_settings: "Switches and limits for this server.",
    lede_telemetry: "What this deployment records, item by item.",
    lede_spend: "What answers cost, and every admin action.",
    lede_assistant: "What Superset needs: the name, the connection, languages and datasets.",
    lede_link: "This deployment keeps every admin setting on the admin panel.",
    signOut: "Sign out", sections: "Sections",
    pgRange: "{0}–{1} of {2}", pgPrev: "Previous", pgNext: "Next", pgSize: "Per page", pgPage: "Page {0}",
    // Models & voice
    chatModelH: "Chat model", chatNow: "Now: {0}", chatFromSettings: "chosen here", chatFromDefault: "the deployment's default", chatFallback: "{0} is not answering; {1} answers until it is back.",
    chatBack: "Back to the deployment's default: {0}", effort: "Effort", effortN: "{0} effort", notAnswering: "not answering", saveModel: "Save model",
    modelsH: "Language models", mName: "Model", mKind: "Kind", mState: "State", mLatency: "Latency", mPriced: "Priced", up: "answering", down: "not answering",
    sttH: "Speech to text", sttOff: "Off: no speech key is set (LENSPACK_STT_API_KEY).", sttModel: "Model", sttHold: "Hold Space to talk after (ms)", sttSave: "Save",
    measuredH: "Measured accuracy", measuredLede: "Word error rate with a language hint, and median latency, on our test sets.",
    keptH: "Kept recordings", keptOn: "Kept: {0} recordings, {1}.", keptOff: "Off. Turn on “voice audio” on the Telemetry tab to keep recordings.", keptOnLine: "On.",
    keptDays: "Keep for (days)", keptMb: "At most (MB)", consent: "Notice each person accepts once before recording", keptSave: "Save", keptReset: "Back to defaults",
    clipsH: "Recordings", clipWhen: "When", clipUser: "User", clipSize: "Size", clipPlay: "Play", clipDelete: "Delete", clipDeleteQ: "Delete this recording?", noClips: "No recordings kept.",
    delUser: "Delete every recording of", delUserPh: "Superset user name", delUserBtn: "Delete", exportBtn: "Export for evaluation", exported: "{0} clips exported, {1} set aside.", openTelemetry: "Open Telemetry",
    // Spend & audit
    costH: "Cost per answer", today: "Today (UTC)", week: "Last 7 days", rangeT: "This range", answers: "answers", fromD: "From", toD: "To", userF: "User", apply: "Apply", clear: "Clear",
    tWhen: "When", tUser: "User", tBoard: "Board", tModel: "Model", tTokens: "Tokens", tCost: "Cost", tStt: "Speech", noTurns: "No answers in this range.", costOff: "Cost per answer needs the audit log (audit: on).", unpricedN: "{0} unpriced",
    auditH: "Audit log", auditLede: "Kept {0} days in {1}.", aAction: "Action", aOutcome: "Outcome", aDetail: "Detail", aAll: "All", aOk: "ok", aDenied: "denied", search: "Search", noEvents: "No events match.", auditOff: "The audit log is off (audit: false).",
    // Cache settings
    cacheSetH: "Saved answer settings", cOn: "Keep and serve saved answers", cTtl: "Drop entries older than (hours)", cRouter: "Match differently worded questions", cMax: "At most (entries)", cFresh: "Show as is for (minutes)", cPw: "Refresh before busy times", cPwTimes: "At (local times, comma-separated)", cPwTop: "Most-asked to refresh", cPwUsd: "Most per refresh (US$)",
    queueH: "Turn queue", qConc: "At once", qWait: "Waiting at most", qSecs: "Longest wait (s)",
    resetDefaults: "Back to the deployment's values", saveB: "Save",
    // Settings
    offH: "Off switches", personalH: "Own dashboards", pOn: "People may keep their own dashboards and layouts", pDash: "Dashboards per person", pLayouts: "Saved layouts per person",
    scopeH: "Where the chat may edit", scopeSuperset: "Any dashboard Superset lets the person edit", scopeOwn: "Only their own dashboards", scopeExempt: "Admins may edit shared ones",
    configH: "From the deployment's config", whereH: "Where to change things", wWhat: "What", wWhere: "Where",
    budgetDay: "Spend per day", budgetUser: "Spend per person per day", none2: "none", contextN: "{0} context labels", nameHere: "The name and button label are set on the Assistant tab.", nameElsewhere: "The name and button label are set on Superset's settings page.",
    // Assistant (Superset)
    panelH: "Admin panel", panelLede: "Models, voice, costs, logs, switches, review and saved answers.", openPanel: "Open the admin panel", panelPassword: "Admins sign in with the deployment's admin password.",
    whoH: "Who can use it", onOff: "The assistant", isOn: "on", isOff: "off (the Assistant button switch)", hostPolicyL: "Whose data access applies", hostSuperset: "each person's own Superset access", hostOff: "Lenspack's account (off)", editPolicyL: "Who may edit dashboards", editSuperset: "whoever Superset lets edit", editSigned: "anyone signed in", scopeL: "Edit scope",
    connH: "Connection", cServer: "Server", cAccount: "Service account", cIdentity: "Signing key", cReceived: "received", cMissing: "missing: settings can't be saved", cChat: "Chat", cChatOk: "answering", cChatDown: "no model answering", cUrl: "Superset at", cRoles: "Service account roles", dbH: "Superset databases", dbName: "Database", dbBackend: "Engine", dbDatasets: "Datasets",
    langH: "Language", lReplies: "Replies in", lTitles: "Chart titles in", lBoard: "Board language", lAuto: "the asker's language", lTitleBoard: "the board's language", lTitleSpeaker: "the asker's language",
    dataH: "Datasets", dPack: "Pack", dEntity: "Read as", dTable: "Dataset", dWarnings: "Left out or renamed", dDashboards: "Dashboards opened", dEdit: "Edit in Superset",
  });
  Object.assign(STRINGS.fr, {
    gUsage: "Usage", gAnswers: "Réponses", gConfig: "Configuration", gRecords: "Registres",
    tabModels: "Modèles et voix", tabSpend: "Coûts et journal", tabAssistant: "Assistant",
    lede_overview: "Comment {name} est utilisé, et ce qui vous attend.",
    lede_review: "La revue quotidienne des réponses, et ce qu'elle a trouvé.",
    lede_questions: "Les questions à plusieurs lectures. Choisissez celle qui compte.",
    lede_proposals: "Les changements proposés par la revue. Rien ne s'applique sans votre accord.",
    lede_definitions: "Ce que {name} sait de vos données, avec l'historique.",
    lede_cache: "Les réponses gardées pour les questions reposées.",
    lede_models: "Les modèles qui répondent et écoutent, et les enregistrements gardés.",
    lede_access: "Qui administre, et qui peut utiliser {name}.",
    lede_settings: "Interrupteurs et limites de ce serveur.",
    lede_telemetry: "Ce que ce déploiement enregistre, élément par élément.",
    lede_spend: "Le coût des réponses, et chaque action d'administration.",
    lede_assistant: "Ce dont Superset a besoin : le nom, la connexion, les langues et les jeux de données.",
    lede_link: "Ce déploiement garde tous les réglages d'administration dans le panneau.",
    signOut: "Se déconnecter", sections: "Sections",
    pgRange: "{0}–{1} sur {2}", pgPrev: "Précédent", pgNext: "Suivant", pgSize: "Par page", pgPage: "Page {0}",
    chatModelH: "Modèle de discussion", chatNow: "Actuel : {0}", chatFromSettings: "choisi ici", chatFromDefault: "par défaut du déploiement", chatFallback: "{0} ne répond pas ; {1} répond en attendant.",
    chatBack: "Revenir au modèle par défaut : {0}", effort: "Effort", effortN: "effort {0}", notAnswering: "ne répond pas", saveModel: "Enregistrer",
    modelsH: "Modèles de langage", mName: "Modèle", mKind: "Type", mState: "État", mLatency: "Latence", mPriced: "Tarifé", up: "répond", down: "ne répond pas",
    sttH: "Reconnaissance vocale", sttOff: "Désactivée : aucune clé (LENSPACK_STT_API_KEY).", sttModel: "Modèle", sttHold: "Maintenir Espace pour parler après (ms)", sttSave: "Enregistrer",
    measuredH: "Précision mesurée", measuredLede: "Taux d'erreur par mot avec indication de langue, et latence médiane, sur nos jeux de test.",
    keptH: "Enregistrements gardés", keptOn: "Gardés : {0} enregistrements, {1}.", keptOff: "Désactivé. Activez « voix » dans l'onglet Télémétrie pour garder les enregistrements.", keptOnLine: "Activé.",
    keptDays: "Garder pendant (jours)", keptMb: "Au plus (Mo)", consent: "Avis accepté une fois avant tout enregistrement", keptSave: "Enregistrer", keptReset: "Valeurs par défaut",
    clipsH: "Enregistrements", clipWhen: "Quand", clipUser: "Utilisateur", clipSize: "Taille", clipPlay: "Écouter", clipDelete: "Supprimer", clipDeleteQ: "Supprimer cet enregistrement ?", noClips: "Aucun enregistrement gardé.",
    delUser: "Supprimer tous les enregistrements de", delUserPh: "Nom d'utilisateur Superset", delUserBtn: "Supprimer", exportBtn: "Exporter pour évaluation", exported: "{0} extraits exportés, {1} mis de côté.", openTelemetry: "Ouvrir Télémétrie",
    costH: "Coût par réponse", today: "Aujourd'hui (UTC)", week: "7 derniers jours", rangeT: "Cette période", answers: "réponses", fromD: "Du", toD: "Au", userF: "Utilisateur", apply: "Appliquer", clear: "Effacer",
    tWhen: "Quand", tUser: "Utilisateur", tBoard: "Tableau", tModel: "Modèle", tTokens: "Jetons", tCost: "Coût", tStt: "Voix", noTurns: "Aucune réponse sur cette période.", costOff: "Le coût par réponse demande le journal d'audit (audit : activé).", unpricedN: "{0} sans tarif",
    auditH: "Journal d'audit", auditLede: "Gardé {0} jours dans {1}.", aAction: "Action", aOutcome: "Résultat", aDetail: "Détail", aAll: "Tous", aOk: "ok", aDenied: "refusé", search: "Rechercher", noEvents: "Aucun événement.", auditOff: "Le journal d'audit est désactivé (audit : false).",
    cacheSetH: "Réglages des réponses gardées", cOn: "Garder et servir les réponses", cTtl: "Supprimer après (heures)", cRouter: "Rapprocher les questions formulées autrement", cMax: "Au plus (entrées)", cFresh: "Montrer telle quelle pendant (minutes)", cPw: "Actualiser avant les heures chargées", cPwTimes: "À (heures locales, séparées par des virgules)", cPwTop: "Questions les plus posées à actualiser", cPwUsd: "Maximum par actualisation (US$)",
    queueH: "File des réponses", qConc: "En même temps", qWait: "En attente au plus", qSecs: "Attente maximale (s)",
    resetDefaults: "Valeurs du déploiement", saveB: "Enregistrer",
    offH: "Interrupteurs", personalH: "Tableaux personnels", pOn: "Chacun peut garder ses tableaux et dispositions", pDash: "Tableaux par personne", pLayouts: "Dispositions par personne",
    scopeH: "Où la discussion peut modifier", scopeSuperset: "Tout tableau que Superset laisse modifier", scopeOwn: "Seulement ses propres tableaux", scopeExempt: "Les administrateurs modifient les tableaux partagés",
    configH: "Depuis la configuration", whereH: "Où changer quoi", wWhat: "Quoi", wWhere: "Où",
    budgetDay: "Dépense par jour", budgetUser: "Dépense par personne et par jour", none2: "aucune", contextN: "{0} libellés de contexte", nameHere: "Le nom et le libellé du bouton se règlent dans l'onglet Assistant.", nameElsewhere: "Le nom et le libellé du bouton se règlent sur la page de réglages de Superset.",
    panelH: "Panneau d'administration", panelLede: "Modèles, voix, coûts, journaux, interrupteurs, revue et réponses gardées.", openPanel: "Ouvrir le panneau", panelPassword: "Les administrateurs se connectent avec le mot de passe du déploiement.",
    whoH: "Qui peut l'utiliser", onOff: "L'assistant", isOn: "activé", isOff: "désactivé (interrupteur du bouton)", hostPolicyL: "Accès aux données appliqué", hostSuperset: "l'accès Superset de chacun", hostOff: "le compte de Lenspack (désactivé)", editPolicyL: "Qui modifie les tableaux", editSuperset: "qui Superset laisse modifier", editSigned: "toute personne connectée", scopeL: "Portée des modifications",
    connH: "Connexion", cServer: "Serveur", cAccount: "Compte de service", cIdentity: "Clé de signature", cReceived: "reçue", cMissing: "absente : les réglages ne s'enregistrent pas", cChat: "Discussion", cChatOk: "répond", cChatDown: "aucun modèle ne répond", cUrl: "Superset à", cRoles: "Rôles du compte de service", dbH: "Bases de données Superset", dbName: "Base", dbBackend: "Moteur", dbDatasets: "Jeux de données",
    langH: "Langue", lReplies: "Réponses en", lTitles: "Titres des graphiques en", lBoard: "Langue du tableau", lAuto: "la langue de la question", lTitleBoard: "la langue du tableau", lTitleSpeaker: "la langue de la question",
    dataH: "Jeux de données", dPack: "Pack", dEntity: "Lu comme", dTable: "Jeu de données", dWarnings: "Écartés ou renommés", dDashboards: "Tableaux ouverts", dEdit: "Modifier dans Superset",
  });

  // The switches' names and help in French; English comes from the server.
  const FEATURES_FR = {
    overlay: ["Bouton de l'assistant", "Le bouton et la discussion sur les tableaux de bord."],
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

  // The telemetry catalogue in French (sections, items, and the privacy notes of the sensitive ones); English comes from the server.
  const TL_FR = {
    groups: { users: "Utilisateurs", "volume-cost": "Volume et coût", quality: "Qualité", asks: "Ce que l'on demande", speed: "Rapidité", voice: "Voix et langue", conversation: "Conversation", "trust-reuse": "Confiance et réutilisation", "device-network": "Appareil et réseau" },
    items: {
      "users-active": ["Utilisateurs actifs par jour et par semaine", "Le pilote touche-t-il les gens, et l'usage progresse-t-il ?"],
      "users-by-role": ["Utilisateurs actifs par rôle", "Quels rôles s'en servent, et qui a besoin de formation ou d'un autre point d'entrée ?"],
      "users-by-country": ["Utilisateurs actifs par pays", "Où mettre le support et le prochain déploiement."],
      "users-return": ["Utilisateurs qui reviennent à la campagne suivante", "Garde-t-il ses utilisateurs d'une campagne à l'autre ?"],
      "volume-per-user": ["Questions par utilisateur", "À quel point chacun s'en sert ; dimensionnement et budgets."],
      "cost-per-question": ["Coût par question (modèle, voix, vérification)", "Quel modèle utiliser, et si la vérification vaut son coût."],
      "cost-per-user": ["Coût par utilisateur", "Le budget par superviseur pour une campagne."],
      "cost-voice": ["Coût de la reconnaissance vocale", "Si la voix reste abordable à l'échelle d'une campagne."],
      "quality-answer-rate": ["Taux de réponse par type de campagne et langue", "Où le pack ou le modèle est en défaut."],
      "quality-unanswered": ["Questions sans réponse les plus fréquentes", "Ce qu'il faut ajouter au pack ensuite."],
      "quality-thumbs-down": ["Pouces vers le bas et leurs raisons", "Quelles réponses inspirent peu confiance, et pourquoi."],
      "quality-clarify": ["Questions de clarification : répondues ou abandonnées", "Si redemander aide ou fait fuir."],
      "asks-top-by-role": ["Les 10 questions les plus posées par rôle", "Ce qu'il faut mettre sur les tableaux et dans les suggestions."],
      "asks-repeated-direct": ["Questions directes répétées", "Quels chiffres méritent un graphique plutôt qu'une question."],
      "asks-repeated-derived": ["Questions dérivées répétées", "Quels taux ou comparaisons ajouter comme mesures."],
      "asks-mix": ["Part des questions directes, dérivées et graphiques", "Si l'on s'en sert pour demander ou pour construire."],
      "question-text": ["Texte des questions", "Lire les mots derrière les questions fréquentes et sans réponse."],
      "speed-p95": ["Réponses les plus lentes (95e centile) par type", "Si les réponses sont assez rapides sur les réseaux de terrain."],
      "speed-abandoned": ["Réponses quittées avant la fin", "Où l'attente fait perdre des gens."],
      "speed-queue": ["Attente d'une place libre", "Quand ajouter de la capacité aux pics de campagne."],
      "speed-time-saved": ["Temps gagné par rapport à avant", "Si l'outil vaut le changement."],
      "voice-share": ["Part des questions dites à voix haute", "Si la voix vaut d'être gardée et améliorée."],
      "voice-edit-rate": ["Transcriptions corrigées avant envoi", "Quelles langues la reconnaissance vocale comprend mal."],
      "voice-reask": ["Retapé après avoir parlé", "Si les échecs de la voix ramènent au clavier."],
      "voice-not-sent": ["Transcriptions jamais envoyées", "Si l'on abandonne après avoir vu la transcription."],
      "language-mix": ["Langues utilisées", "Quelles langues bien prendre en charge."],
      "voice-wer-proxy": ["Taux d'erreur de mots (estimé d'après les corrections)", "Quel modèle de reconnaissance utiliser par langue."],
      "voice-wer-true": ["Vrai taux d'erreur de mots", "Quel modèle de reconnaissance utiliser par langue."],
      "transcript-text": ["Texte des transcriptions", "Voir ce que la reconnaissance a entendu, pour trouver les mots qu'elle rate."],
      "voice-audio": ["Enregistrements conservés", "De quoi tester les modèles de reconnaissance sur du vrai son de terrain."],
      "conv-rephrase": ["Questions reposées autrement", "Où la première réponse manque sa cible."],
      "conv-follow-ups": ["Relances par conversation", "Si l'on explore ou si l'on pose une question puis part."],
      "trust-explain": ["« Comment c'est calculé » ouvert", "Si l'on vérifie d'où viennent les chiffres."],
      "trust-export-share": ["Graphiques exportés ou tableaux partagés depuis la discussion", "Si les réponses circulent au-delà de qui les a demandées."],
      "trust-superset-actions": ["Exports et partages dans Superset sur les tableaux construits par l'assistant", "Si les tableaux construits par l'assistant servent."],
      "reuse-hit-rate": ["Réponses gardées réutilisées, par niveau", "Ce que la réutilisation fait gagner, et si ses niveaux sont justes."],
      "reuse-saved": ["Argent économisé par les réponses gardées", "Si la réutilisation est rentable."],
      "review-runs": ["Passages de la revue quotidienne", "À quelle fréquence les réponses sont vérifiées après coup."],
      "review-proposals": ["Propositions de la revue quotidienne", "Quels changements de définitions la revue suggère, et lesquels sont acceptés."],
      "review-open-questions": ["Questions ouvertes (deux lectures)", "Ce qui attend une décision humaine."],
      "device-class": ["Téléphone, tablette ou ordinateur, et largeur d'écran", "Pour quels écrans concevoir d'abord."],
      "device-network": ["Type de réseau et économiseur de données", "À quel point les réponses doivent être légères sur le terrain."],
    },
    sensitive: {
      "question-text": "Garde les mots de chaque question telle qu'envoyée, les valeurs des filtres du tableau et les commentaires. Une question peut nommer des lieux, des personnes ou des chiffres. Désactivé, seule une empreinte chiffrée est gardée : les questions répétées se comptent toujours.",
      "transcript-text": "Garde mot pour mot ce que la reconnaissance vocale a entendu, à côté de la question envoyée. Une question dite peut nommer des lieux, des personnes ou des chiffres. Désactivé, une empreinte chiffrée suffit à compter les corrections.",
      "voice-audio": "Garde l'enregistrement de chaque question dite pendant le nombre de jours réglé sous Voix dans les réglages, pour que les administrateurs l'écoutent, l'exportent et le suppriment. Une voix peut identifier la personne. Chaque utilisateur voit l'avis de consentement une fois avant que le micro n'enregistre.",
      "device-class": "Enregistre le type d'appareil et la largeur d'écran de chaque utilisateur à chaque question. Avec le nom d'utilisateur, cela décrit l'équipement de chacun.",
      "device-network": "Enregistre le type de réseau de chaque utilisateur (wifi, mobile, 2g à 4g) et si l'économiseur de données est actif, à chaque question.",
    },
  };

  // ---- State and helpers ------------------------------------------------------------------------
  // What the host wrote into the page: which shell draws it (Lenspack's own page or Superset's), where the panel's and
  // the host's routes are from here, where the scripts are, which sections this page shows, and a sign-out address when
  // the admin pages have a sign-in of their own.
  const shell = window.__lpAdmin || {};
  const SHELL = shell.shell === "superset" ? "superset" : "panel";
  const apiBase = shell.api || {};
  const HOST = typeof apiBase.host === "string" ? apiBase.host : typeof shell.host === "string" ? shell.host : "../";
  const API = typeof apiBase.panel === "string" ? apiBase.panel : "api/";
  const ASSETS = typeof shell.assets === "string" ? shell.assets : "";
  const root = document.getElementById("lp-admin") || document.body.appendChild(document.createElement("div"));
  const store = {
    get(k) { try { return localStorage.getItem(`lp-admin-${k}`); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(`lp-admin-${k}`, v); } catch (e) { /* private window */ } },
  };
  const params = new URLSearchParams(location.search);
  let lang = params.get("lang") || store.get("lang") || ((navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en");
  if (!STRINGS[lang]) lang = "en";
  let theme = store.get("theme") || "auto";
  const [hashTab, hashSection] = (location.hash || "").slice(1).split("/");
  let tab = hashTab || params.get("tab") || "";
  let pack = params.get("pack") || store.get("pack") || "";
  let packs = [];
  let qFilter = "open";
  let usageInfo = null;
  let usageChat = [];
  let mounted = null;
  let openRun = null;

  // {name} is the assistant's name (the deployment's brand), which the server writes into the page.
  const named = shell.name || document.documentElement.dataset.name;
  const assistant = named && named !== "__NAME__" ? named : "Lenspack";
  const t = (k, ...a) => String((STRINGS[lang] && STRINGS[lang][k]) ?? STRINGS.en[k] ?? k).replace(/\{name\}/g, () => assistant).replace(/\{(\d)\}/g, (_, i) => (a[i] === undefined ? "" : a[i]));
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
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return e;
  }
  function toast(msg, bad) {
    const el = root.querySelector(".toast");
    el.textContent = msg;
    el.className = `toast show${bad ? " bad" : ""}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (el.className = "toast"), bad ? 6000 : 2500);
  }
  async function api(path, opts = {}) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${API}${path}${pack ? `${sep}pack=${encodeURIComponent(pack)}` : ""}`, {
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
    const res = await fetch(`${HOST}cache${path}`, { method: opts.method || "GET", credentials: "same-origin" });
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
  // The tabs, in groups. `superset` tabs exist only when Superset is the host; which tabs a page shows depends on where
  // it is (shell.sections): "all", "lenspack" (all but the host's own), "host" (the host's own only) or "link".
  const TAB_DEFS = [
    { id: "overview", grp: "gUsage", label: "tabOverview" },
    { id: "review", grp: "gAnswers", label: "tabReview" },
    { id: "questions", grp: "gAnswers", label: "tabQuestions" },
    { id: "proposals", grp: "gAnswers", label: "tabProposals" },
    { id: "definitions", grp: "gAnswers", label: "tabDefinitions" },
    { id: "cache", grp: "gAnswers", label: "tabCache" },
    { id: "models", grp: "gConfig", label: "tabModels" },
    { id: "access", grp: "gConfig", label: "tabAccess" },
    { id: "settings", grp: "gConfig", label: "tabSettings" },
    { id: "assistant", grp: "gConfig", label: "tabAssistant", superset: true },
    { id: "telemetry", grp: "gRecords", label: "tabTelemetry" },
    { id: "spend", grp: "gRecords", label: "tabSpend" },
  ];
  const sections = shell.sections || "all";
  const shownTabs = () => TAB_DEFS.filter((d) => (d.superset ? !!shell.superset : true) && (sections === "all" || (sections === "lenspack" ? !d.superset : d.superset)));
  const markEl = root.querySelector(".mark") || h("span", { class: "mark", "aria-hidden": "true" });
  if (!markEl.classList.contains("icon")) markEl.textContent = Array.from(assistant.trim())[0]?.toLocaleUpperCase() || "L";
  const titleEl = h("h1", {});
  const subEl = h("div", { class: "who" });
  const packSel = h("select", { "aria-label": "Pack" });
  const packPick = h("label", { class: "sel", hidden: true }, packSel);
  const langs = h("div", { class: "seg", role: "group", "aria-label": "Language" }, ["en", "fr"].map((l) => h("button", { type: "button", "data-lang": l }, l.toUpperCase())));
  const themeBtn = h("button", { type: "button", class: "icon theme-tool" });
  const signOutEl = shell.signOut ? h("a", { class: "icon", href: shell.signOut, title: "", "aria-label": "" }, "⎋") : null;
  const navEl = h("nav", { class: "lpa-nav", "aria-label": "Tabs" });
  const secnavEl = h("nav", { class: "secnav", "aria-label": "Sections" });
  const pageHead = h("header", { class: "page-h" });
  const main = h("div", { id: "main" });
  const mainWrap = h("main", { class: "lpa-main", tabindex: "-1" }, pageHead, secnavEl, main);
  root.classList.add("lpa");
  root.dataset.shell = SHELL;
  root.replaceChildren(
    h("header", { class: "lpa-top" }, h("div", { class: "lpa-brand" }, markEl, h("div", { style: "min-width:0" }, titleEl, subEl)), h("div", { class: "tools" }, packPick, langs, themeBtn, signOutEl)),
    h("div", { class: "lpa-body" }, navEl, mainWrap),
    h("div", { class: "toast", id: "toast", role: "status", "aria-live": "polite" }));

  function paintNav() {
    const tabs = shownTabs();
    root.dataset.nav = tabs.length < 2 ? "none" : "tabs";
    let grp = null;
    const kids = [];
    for (const d of tabs) {
      if (d.grp !== grp) { grp = d.grp; kids.push(h("div", { class: "grp" }, t(grp))); }
      kids.push(h("button", { type: "button", role: "tab", "data-tab": d.id, "aria-selected": String(d.id === tab), onclick: () => go(d.id) }, h("span", {}, t(d.label))));
    }
    navEl.replaceChildren(...kids);
  }
  function applyChrome() {
    root.lang = lang;
    if (SHELL === "panel") document.documentElement.lang = lang;
    // Inside Superset the theme is Superset's own (its layout marks the page); on the panel's page, the reader's pick.
    if (theme === "auto" || SHELL === "superset") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    themeBtn.textContent = theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐";
    themeBtn.title = themeBtn.ariaLabel = t(theme === "dark" ? "themeDark" : theme === "light" ? "themeLight" : "themeAuto");
    if (signOutEl) signOutEl.title = signOutEl.ariaLabel = t("signOut");
    titleEl.textContent = t("title");
    for (const b of langs.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
    paintNav();
    const d = TAB_DEFS.find((x) => x.id === tab);
    pageHead.replaceChildren(h("h1", {}, d ? t(d.label) : ""), h("p", {}, t(sections === "link" ? "lede_link" : `lede_${tab}`)));
    if (SHELL === "panel") document.title = `${d ? t(d.label) : ""} · ${t("title")}`;
  }
  /** Opens a tab (and a section of it): #tab or #tab/section, so a link or a reload lands in the same place. */
  function go(id, section) {
    tab = id;
    openRun = null;
    history.replaceState(null, "", `#${id}${section ? `/${section}` : ""}`);
    applyChrome();
    render(section);
    if (!section) mainWrap.focus({ preventScroll: true });
  }
  themeBtn.onclick = () => {
    theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    store.set("theme", theme);
    applyChrome();
  };
  for (const b of langs.querySelectorAll("button"))
    b.onclick = () => {
      lang = b.dataset.lang;
      store.set("lang", lang);
      applyChrome();
      render();
    };
  packSel.onchange = (e) => {
    pack = e.target.value;
    store.set("pack", pack);
    render();
  };
  window.addEventListener("hashchange", () => {
    const [id, section] = (location.hash || "").slice(1).split("/");
    if (id && id !== tab && TAB_DEFS.some((d) => d.id === id)) go(id, section);
    else if (section) scrollToSection(section);
  });

  /** The section nav: each section heading on the page, as a link; the one in view is marked. */
  let watching = null;
  function paintSections() {
    const heads = [...main.querySelectorAll(":scope > section.card > h2")];
    if (watching) watching.disconnect();
    if (heads.length < 2) return secnavEl.replaceChildren();
    const links = heads.map((hd) => {
      const id = hd.parentElement.id || slug(hd.textContent);
      hd.parentElement.id = id;
      return h("a", { href: `#${tab}/${id}`, onclick: (e) => { e.preventDefault(); history.replaceState(null, "", `#${tab}/${id}`); scrollToSection(id); } }, hd.textContent);
    });
    secnavEl.setAttribute("aria-label", t("sections"));
    secnavEl.replaceChildren(...links);
    if ("IntersectionObserver" in window) {
      watching = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) for (const a of links) a.setAttribute("aria-current", String(a.getAttribute("href") === `#${tab}/${en.target.id}`));
      }, { rootMargin: "-120px 0px -60% 0px" });
      heads.forEach((hd) => watching.observe(hd.parentElement));
    }
  }
  const slug = (s) => `s-${String(s).toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
  function scrollToSection(id) {
    const el = main.querySelector(`#${CSS.escape(id)}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- The pager: one for every list. -------------------------------------------------------------
  // page is what the server answered ({offset, limit, total, next, prev}); go(query) loads another page, with a query
  // like "cursor=…&limit=25" or "offset=50&limit=25".
  const pagingState = {};
  /** The query for a list's current page ("limit=25&offset=0" by default: offset asks the server for a page). */
  const pageQuery = (key, limit = 25) => pagingState[key] || `limit=${limit}&offset=0`;
  function pager(page, goTo, o = {}) {
    if (!page || !page.total) return null;
    const { offset, limit, total } = page;
    const pages = Math.max(1, Math.ceil(total / limit));
    const cur = Math.floor(offset / limit) + 1;
    const from = offset + 1, to = Math.min(offset + limit, total);
    const nums = [];
    for (let n = 1; n <= pages; n++) if (n === 1 || n === pages || Math.abs(n - cur) <= 1) nums.push(n); else if (nums[nums.length - 1] !== "…") nums.push("…");
    const btn = (label, q, extra = {}) => h("button", { type: "button", class: "pg", disabled: !q, onclick: () => q && goTo(q), ...extra }, label);
    const sizes = o.sizes || [10, 25, 50, 100];
    const size = h("select", { "aria-label": t("pgSize"), onchange: (e) => goTo(`limit=${e.target.value}&offset=0`) }, [...new Set([...sizes, limit])].sort((a, b) => a - b).map((n) => h("option", { value: String(n), selected: n === limit ? "" : null }, String(n))));
    return h("nav", { class: "pager", "aria-label": t("pgRange", from, to, total) },
      h("span", { class: "range" }, t("pgRange", nf(from), nf(to), nf(total))),
      h("div", { class: "pages" },
        pages > 1 ? btn("‹", page.prev ? `cursor=${encodeURIComponent(page.prev)}&limit=${limit}` : null, { "aria-label": t("pgPrev") }) : null,
        pages > 1 ? nums.map((n) => (n === "…" ? h("span", { class: "gap" }, "…") : btn(String(n), n === cur ? null : `offset=${(n - 1) * limit}&limit=${limit}`, { "aria-label": t("pgPage", n), "aria-current": n === cur ? "page" : null }))) : null,
        pages > 1 ? btn("›", page.next ? `cursor=${encodeURIComponent(page.next)}&limit=${limit}` : null, { "aria-label": t("pgNext") }) : null,
        h("label", { class: "row", style: "gap:6px;margin-left:8px" }, h("span", { class: "mute" }, t("pgSize")), size)));
  }
  /** A pager that keeps its list's page in pagingState and draws the tab again. */
  const listPager = (key, page) => pager(page, (q) => { pagingState[key] = q; render(); });

  // ---- Tabs ---------------------------------------------------------------------------------------
  // The board renderer (@lenspack/react, bundled as board.js), loaded once, when the Overview first opens.
  let boardLib = null;
  function loadBoardLib() {
    if (boardLib) return boardLib;
    boardLib = new Promise((resolve, reject) => {
      const css = h("link", { rel: "stylesheet", href: `${ASSETS}board.css` });
      document.head.append(css);
      const js = h("script", { src: `${ASSETS}board.js`, nonce: shell.nonce || null });
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
        const res = await fetch(`${API}usage/${usageInfo.board}/chat?language=${lang}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history.slice(-16), language: lang }) });
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
        mounted = lib.mount(boardEl, { api: `${API}usage/${usageInfo.board}` });
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
    const [s, runs] = await Promise.all([api("review/settings"), api(`runs?${pageQuery("runs", 10)}`)]);
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
    return [settingsCard, card(t("runs"), null, list, listPager("runs", runs.page))];
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
    const { questions: list, page: qPage } = await api(`questions?${qFilter === "all" ? "" : `status=${qFilter}&`}${pageQuery("questions", 10)}`);
    const filters = h("div", { class: "seg", role: "group", style: "margin:0 0 12px" }, ["open", "answered", "dismissed", "all"].map((k) =>
      h("button", { type: "button", "aria-pressed": String(qFilter === k), onclick: () => { qFilter = k; delete pagingState.questions; render(); } }, t(`filter${k[0].toUpperCase()}${k.slice(1)}`))));
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
    return [h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("qLede")), filters, items.length ? items : h("p", { class: "empty" }, t("noQuestions")), listPager("questions", qPage), addCard];
  }

  async function proposals() {
    const [{ proposals: pending }, { proposals: decided, page: dPage }] = await Promise.all([api("proposals?status=pending"), api(`proposals?status=decided&${pageQuery("proposals", 10)}`)]);
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
    return [h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("pLede")), pending.length ? pending.map(item) : h("p", { class: "empty" }, t("noProposals")), decided.length ? card(t("decided"), null, decided.map(item), listPager("proposals", dPage)) : null];
  }

  async function definitions() {
    const [d, hist0] = await Promise.all([api("definitions"), api(`definitions/history?${pageQuery("history", 20)}`).catch(() => null)]);
    const histItems = hist0 ? hist0.history : d.history.slice().reverse();
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
    const hist = histItems.length
      ? h("div", { class: "scroll" }, h("table", {}, h("tbody", {}, histItems.map((c) => h("tr", {},
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
      hist ? card(t("history"), null, hist, hist0 ? listPager("history", hist0.page) : null) : null,
      card(t("packOwn"), null, h("pre", {}, d.packInstructions || t("none"))),
    ];
  }

  async function cache() {
    // The saved answers' admin routes (docs/features/saved-answers.md): <prefix>/cache, …/suggestions, …/chart-candidates, …/boards.
    let data;
    try {
      data = await cacheApi(`?${pageQuery("cache")}`);
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
      const res = await fetch(`${HOST}cache${path}`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    const tierLine = ["t1", "t2", "t3", "t4"].map((k) => `${t(`tier_${k}`)} ${nf(hits[k] || 0)}`).join(" · ");
    const q = data.queue;
    const pw = data.prewarm;
    const settled = ((boardInfo && boardInfo.boards) || []).filter((b) => b.settled);
    const candidates = (cands && cands.candidates) || [];
    const host = await hostSettings().catch(() => null);
    return [
      h("p", { class: "lede mute", style: "margin:0 0 12px" }, t("cacheLede"), st.since ? ` ${t("since", when(st.since))}.` : ""),
      h("div", { class: "tiles" },
        tile(t("turns"), nf(st.turns)),
        tile(t("hits"), nf(totalHits), st.turns ? `${nf((100 * totalHits) / st.turns)}%` : null),
        tile(t("misses"), nf(st.misses)),
        tile(t("saved$"), usd(st.savedUsd)),
        tile(t("entries"), nf(data.total ?? entries.length)),
        q ? tile(t("queueNow"), `${nf(q.running)} / ${nf(q.waiting)}`, t("queueHelp")) : null),
      h("p", { class: "mute", style: "margin:-6px 0 14px;font-size:12.5px" }, tierLine),
      card(t("prewarmH"), pw ? t("prewarmLast", when(pw.at), t(`pwr_${pw.reason}`), nf(pw.refreshed), nf(pw.entries), nf(pw.rewritten), usd(pw.spentUsd)) : t("prewarmNever"),
        h("div", { class: "actions" }, h("button", { class: "btn sm ghost", type: "button", onclick: post("/prewarm") }, t("prewarmNow")))),
      card(t("entries"), null, entries.length ? h("div", { class: "scroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, t("question")), h("th", { class: "hide-s" }, t("board")), h("th", { class: "n" }, t("hits")), h("th", { class: "n hide-s" }, t("asks7d")), h("th", { class: "hide-s" }, t("dataAsOf")), h("th", {}))),
        h("tbody", {}, entries.map((e) => h("tr", {},
          h("td", {}, e.question, e.kind === "edit" ? h("span", { class: "pill", style: "margin-left:6px" }, t("kindEdit")) : null, e.pinned ? h("span", { class: "pill acc", style: "margin-left:6px" }, t("pinned")) : null, e.variants && e.variants.length ? h("div", { class: "mute", style: "font-size:12px" }, e.variants.slice(0, 3).join(" · ")) : null),
          h("td", { class: "hide-s" }, e.board || ""), h("td", { class: "n" }, nf(e.hits)), h("td", { class: "n hide-s" }, nf(e.asks7d)), h("td", { class: "hide-s mute" }, when(e.dataAsOf)),
          h("td", { style: "white-space:nowrap" }, h("button", { class: "btn sm quiet", type: "button", onclick: post(`/${encodeURIComponent(e.id)}/${e.pinned ? "unpin" : "pin"}`) }, e.pinned ? t("unpin") : t("pin")), " ", h("button", { class: "btn sm danger", type: "button", onclick: post(`/${encodeURIComponent(e.id)}/evict`) }, t("evict")))))))) : h("p", { class: "empty" }, t("noEntries")), listPager("cache", data.page)),
      sugg.some((x) => x && x.suggestions && x.suggestions.length) ? card(t("suggestions"), t("suggestionsLede"), boards.map((b, i) => (sugg[i] && sugg[i].suggestions.length ? h("div", {}, h("h3", {}, b), h("ul", {}, sugg[i].suggestions.map((x) => h("li", {}, x)))) : null))) : null,
      candidates.length ? card(t("chartCandidates"), t("candidatesLede"), h("ul", {}, candidates.map((c) => h("li", {}, c.question, h("span", { class: "mute" }, ` · ${c.board} · ${t("askedN", nf(c.asks))}`))))) : null,
      settled.length ? card(t("settledH"), t("settledLede"), h("ul", {}, settled.map((b) => h("li", {}, b.board, h("span", { class: "mute" }, ` · ${t("lastEdit", when(b.lastEdit))}`))))) : null,
      host ? cacheSettingsCards(host) : null,
    ];
  }

  // What the assistant is called (PUT api/settings/brand, the same change as <prefix>/settings/brand): the name, the
  // button's label, a language's own words, an icon and the attribution line. Every box is text, shown as text.
  const LANG_NAMES = { en: "English", fr: "Français", hi: "हिन्दी", pt: "Português" };
  function brandCard(b) {
    const v = b.values, d = b.defaults, s = b.saved || {}, lim = b.limits, off = !b.writable;
    const box = (label, value, placeholder, max) => h("input", { type: "text", value: value || "", placeholder: placeholder || "", maxlength: max ? String(max) : null, "aria-label": label, disabled: off });
    const fld = (label, input, extra) => h("label", { class: "field" }, h("span", {}, label, extra ? h("small", { class: "mute" }, ` ${extra}`) : null), input);
    const name = box(t("bName"), s.name, d.name, lim.name);
    const label = box(t("bButton"), s.buttonLabel, d.buttonLabel, lim.buttonLabel);
    const icon = box(t("bIcon"), s.icon, d.icon || "", null);
    const powered = h("input", { type: "checkbox", checked: b.poweredBySwitch.value, disabled: off });
    const own = {};
    for (const l of b.languages) own[l] = { name: box(`${t("bName")} (${l})`, s.i18n && s.i18n[l] && s.i18n[l].name, d.i18n[l].name, lim.name), buttonLabel: box(`${t("bButton")} (${l})`, s.i18n && s.i18n[l] && s.i18n[l].buttonLabel, b.templates[l], lim.buttonLabel) };
    // The button as a dashboard shows it, in this panel's language, as the boxes read now.
    const preview = h("span", { class: "brand-btn" }, h("b", {}, "L"), h("span", {}));
    const show = () => {
      const w = own[lang] || own.en;
      const n = w.name.value.trim() || name.value.trim() || (d.i18n[lang] || d).name;
      const l = w.buttonLabel.value.trim() || label.value.trim() || b.templates[lang] || b.templates.en;
      preview.lastChild.textContent = l.replace(/\{name\}/g, () => n);
      const src = icon.value.trim() || d.icon;
      const letter = Array.from(Array.from(n.trim())[0]?.toLocaleUpperCase() || "?")[0] || "?";
      preview.firstChild.replaceChildren(src ? h("img", { src, alt: "" }) : letter);
    };
    // An empty box shows what applies without it, from the boxes above it and the deployment's own words (its config
    // and environment): a renamed deployment never shows the default name there.
    const fill = (tpl, n) => String(tpl).replace(/\{name\}/g, () => n);
    const hints = () => {
      const n = name.value.trim() || d.name;
      label.placeholder = fill(label.value.trim() ? label.value.trim() : b.templates.en, n);
      for (const l of b.languages) {
        const ownName = d.i18n[l] && d.i18n[l].name !== d.name ? d.i18n[l].name : null;
        const ln = own[l].name.value.trim() || ownName || n;
        own[l].name.placeholder = ownName || n;
        own[l].buttonLabel.placeholder = fill(label.value.trim() || b.templates[l], ln);
      }
    };
    [name, label, icon, ...Object.values(own).flatMap((w) => [w.name, w.buttonLabel])].forEach((i) => i.addEventListener("input", () => { hints(); show(); }));
    hints();
    show();
    const orNull = (i) => i.value.trim() || null;
    const save = act(() => api("settings/brand", { body: {
      name: orNull(name), buttonLabel: orNull(label), icon: orNull(icon),
      poweredBy: powered.checked === b.poweredBySwitch.deployment ? null : powered.checked,
      i18n: Object.fromEntries(Object.entries(own).map(([l, w]) => [l, { name: orNull(w.name), buttonLabel: orNull(w.buttonLabel) }])),
    } }), t("saved"));
    const changed = Object.values(b.source).some((x) => x === "settings");
    const reset = act(() => api("settings/brand", { body: { name: null, buttonLabel: null, icon: null, poweredBy: null, i18n: null } }), t("saved"));
    return card(t("bTitle"), t("bLede"),
      h("div", { class: "row", style: "margin:0 0 10px;flex-wrap:wrap" }, h("span", { class: "mute" }, `${t("bPreview")}:`), preview, pill(t(`source_${b.source.name}`), b.source.name === "settings" ? "acc" : "")),
      h("div", { class: "form" }, fld(t("bName"), name), fld(t("bButton"), label, t("bButtonHelp", "{name}")), h("div", { class: "wide" }, fld(t("bIcon"), icon))),
      h("details", { class: "brand-langs" }, h("summary", {}, b.languages.map((l) => LANG_NAMES[l] || l).join(" · ")),
        h("div", { class: "form" }, b.languages.flatMap((l) => [fld(`${t("bName")} · ${t("bIn", LANG_NAMES[l] || l)}`, own[l].name), fld(`${t("bButton")} · ${t("bIn", LANG_NAMES[l] || l)}`, own[l].buttonLabel)]))),
      h("label", { class: "switch", style: "margin-top:10px" }, powered, h("div", {}, h("div", { class: "lbl" }, t("bPowered")))),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: save, disabled: off }, t("bSave")), changed ? h("button", { class: "btn sm quiet", type: "button", onclick: reset, disabled: off }, t("reset")) : null));
  }

  async function settings() {
    const { features, brand } = await api("settings");
    const rows = features.options.map((o) => {
      const fr = lang === "fr" ? FEATURES_FR[o.key] : null;
      const input = h("input", { type: "checkbox", checked: features.values[o.key], "aria-label": fr ? fr[0] : o.label, onchange: act(() => api("settings/features", { body: { [o.key]: input.checked } }), t("saved")) });
      return h("label", { class: "switch" }, input, h("div", { style: "flex:1" },
        h("div", { class: "row" }, h("span", { class: "lbl" }, fr ? fr[0] : o.label), h("code", {}, o.key), pill(t(`source_${features.source[o.key]}`), features.source[o.key] === "settings" ? "acc" : "")),
        h("div", { class: "help" }, fr ? fr[1] : o.help)));
    });
    const changed = Object.values(features.source).some((s) => s === "settings");
    const host = await hostSettings().catch(() => null);
    // On a Superset host the name card is on the Assistant tab (here, or on Superset's page in the split surface).
    const nameCard = !shell.superset ? (brand ? brandCard(brand) : null) : card(t("bTitle"), null, h("p", { class: "row" }, sections === "lenspack" ? t("nameElsewhere") : t("nameHere"), sections === "lenspack" && shell.supersetPage ? h("a", { class: "btn sm quiet", href: shell.supersetPage }, t("tabAssistant")) : sections !== "lenspack" ? h("button", { class: "btn sm quiet", type: "button", onclick: () => go("assistant") }, t("tabAssistant")) : null));
    return [
      card(t("offH"), t("sLede"), rows, changed ? h("div", { class: "actions" }, h("button", { class: "btn sm quiet", type: "button", onclick: act(() => api("settings/features", { body: Object.fromEntries(features.options.map((o) => [o.key, null])) })) }, t("reset"))) : null),
      nameCard,
      host ? supersetSettingsCards(host) : null,
      host ? configCards(host) : null,
    ];
  }

  /** The telemetry checklist (GET <prefix>/telemetry/checklist), if the server has it: null when it does not (404). */
  async function telemetryApi() {
    const res = await fetch(`${HOST}telemetry/checklist`, { credentials: "same-origin" });
    if (res.status === 404) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { return null; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data && Array.isArray(data.groups) ? data : null;
  }
  /**
   * A change to the switchboard through the host's Settings routes: PUT <prefix>/settings/telemetry {"<switch>": value}.
   * A privacy-sensitive item the server wants confirmed (409 with confirm) opens the confirm step, then goes again.
   */
  async function setTelemetrySwitch(body) {
    const put = (b) => fetch(`${HOST}settings/telemetry`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b), credentials: "same-origin" });
    let res = await put(body);
    if (res.status === 404) throw new Error(t("tlSwitchAbsent"));
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 409 && data && data.confirm) {
      if (!(await confirmSensitive(data.confirm.key.replace(/^items\./, ""), data.confirm.label, data.confirm.sensitive, data.confirm.consent, data.confirm.key === "items.voice-audio"))) return null;
      res = await put({ ...body, confirm: true });
      data = null;
      try { data = await res.json(); } catch (e) { /* not JSON */ }
    }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }
  const tlLabel = (it) => (lang === "fr" && TL_FR.items[it.id] ? TL_FR.items[it.id][0] : it.label);
  const tlDecision = (it) => (lang === "fr" && TL_FR.items[it.id] ? TL_FR.items[it.id][1] : it.decision);
  const tlGroup = (g) => (lang === "fr" && TL_FR.groups[g.id]) || g.title;
  const tlSensitive = (id, text) => (lang === "fr" && TL_FR.sensitive[id]) || text;
  /** The confirm step before a privacy-sensitive item turns on: its privacy note, and for recordings the consent notice. Resolves true to go ahead. */
  function confirmSensitive(id, label, sensitive, consent, audio) {
    return new Promise((resolve) => {
      const title = h("h2", { id: "tl-confirm-t", style: "font-size:15px;margin:0 0 10px" }, t("tlConfirmTitle", label));
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
  const LOCK = () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", "M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V6H6V4.5Z");
    svg.append(path);
    return svg;
  };
  const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(lang, { day: "numeric", month: "short" }) : "—");
  const collapsedGroups = () => { try { return new Set(JSON.parse(store.get("tl-collapsed") || "[]")); } catch (e) { return new Set(); } };

  async function telemetry() {
    const C = window.LenspackChecklist;
    let data = null;
    try { data = C ? await telemetryApi() : null; } catch (e) { data = null; }
    if (!data) return [card(t("tlTitle"), null, h("p", { class: "empty" }, t("tlAbsent")), h("p", { class: "mute" }, t("tlAbsentHelp")))];
    const view = { ...data, groups: data.groups.map((g) => ({ ...g, title: tlGroup(g), items: g.items.map((it) => ({ ...it, label: tlLabel(it), decision: tlDecision(it) })) })) };
    const md = () => C.markdown(view, t, { date: (iso) => when(iso), num: (n) => nf(n) });
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
    // A change: saved, said (turning off keeps what was recorded), and the table drawn again from the server's answer.
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
    const toggle = (it, input) => {
      const on = input.checked;
      const key = it.switch.key;
      if (on && it.switch.sensitive) {
        input.checked = false;
        return confirmSensitive(it.id, it.label, it.switch.sensitive, it.switch.consent, it.id === "voice-audio").then((ok) => (ok ? change({ [key]: true, confirm: true }, true, input)() : null));
      }
      return change({ [key]: on }, on, input)();
    };
    const statusCls = (st) => (st === "recording" ? "ok" : st === "needs-config" ? "warn" : st === "enabled-no-data" ? "acc" : "");
    const collapsed = collapsedGroups();
    const groupBody = (g) => {
      const gid = `tl-g-${g.id}`;
      const rec = g.items.filter((i) => i.status === "recording").length;
      const body = h("tbody", { class: collapsed.has(g.id) ? "collapsed" : "", id: `${gid}-rows` });
      const chev = h("button", { class: "tl-chev", type: "button", "aria-expanded": String(!collapsed.has(g.id)), "aria-controls": `${gid}-rows`, "aria-label": t("tlShowHide", g.title), onclick: () => {
        const open = body.classList.toggle("collapsed");
        chev.setAttribute("aria-expanded", String(!open));
        const now = collapsedGroups();
        if (open) now.add(g.id); else now.delete(g.id);
        store.set("tl-collapsed", JSON.stringify([...now]));
      } }, "▾");
      const gsw = h("input", { class: "tg", type: "checkbox", role: "switch", checked: g.on, "aria-label": t("tlSection", g.title), onchange: () => change({ [`groups.${g.id}`]: gsw.checked }, gsw.checked, gsw)() });
      body.append(h("tr", { class: "tl-g" }, h("th", { colspan: "8", scope: "rowgroup", id: gid },
        h("div", { class: "tl-gin" }, chev, gsw, h("span", {}, g.title), h("span", { class: "tl-gn" }, t("tlGroupCount", rec, g.items.length)),
          !g.on && g.changed ? h("span", { class: "tl-gsince" }, t("tlSince", shortDate(g.changed.at), g.changed.by)) : null))));
      for (const it of g.items) {
        const did = `tl-d-${it.id}`;
        const sw = it.switch || {};
        const input = h("input", { class: "tg", type: "checkbox", role: "switch", checked: sw.on, disabled: !sw.editable, "aria-label": it.label, "aria-describedby": sw.editable ? null : `${did}-why`, title: sw.editable ? null : sw.reason, onchange: () => toggle(it, input) });
        const x = h("button", { class: "tl-x", type: "button", "aria-expanded": "false", "aria-controls": did, "aria-label": t("tlDetails", it.label) }, "›");
        const off = it.status === "off" && it.offSince;
        const privacy = [sw.sensitive ? tlSensitive(it.id, sw.sensitive) : null, ...(it.privacy || [])].filter(Boolean).join(" · ");
        const row = h("tr", { class: `tl-i${it.status === "off" || it.status === "not-telemetry" ? " is-off" : ""}` },
          h("td", { class: "c-on" }, input, h("span", { class: "print-on" }, sw.key || sw.feature ? (sw.on ? t("tlOn") : t("tlOff")) : t("tlNoSwitch"))),
          h("th", { class: "c-name", scope: "row" }, it.label),
          h("td", { class: "c-st" }, pill(t(`st_${it.status}`), statusCls(it.status)), off ? h("span", { class: "tl-since" }, t("tlSince", shortDate(it.offSince), it.offBy)) : null),
          h("td", { class: "c-n" }, it.status === "not-telemetry" ? "—" : nf(it.count7d)),
          h("td", { class: "c-seen" }, it.lastSeen ? shortDate(it.lastSeen) : "—"),
          h("td", { class: "c-dr" }, tip("", it.decision, it.decision)),
          h("td", { class: "c-pv" }, privacy ? tip("tl-pv", privacy, LOCK(), { role: "img", "aria-label": `${t("tlPrivacy")}: ${privacy}` }) : null),
          h("td", { class: "c-x" }, x));
        // The row's detail, collapsed: the long text, and on a phone the columns that do not fit.
        const dl = h("dl", { class: "tl-dl" },
          h("dt", {}, t("tlDecision")), h("dd", {}, it.decision),
          h("div", { class: "p-only" }, h("dt", {}, t("tl7d")), h("dd", {}, it.status === "not-telemetry" ? "—" : nf(it.count7d)), h("dt", {}, t("tlLastSeen")), h("dd", {}, it.lastSeen ? when(it.lastSeen) : "—")),
          off ? [h("dt", {}, t("tlStatus")), h("dd", {}, t("tlOffSince", when(it.offSince), it.offBy))] : null,
          !sw.editable && sw.reason ? [h("dt", {}, t("tlWhy")), h("dd", { id: `${did}-why` }, sw.reason, sw.feature ? [" ", h("button", { class: "btn sm quiet", type: "button", onclick: () => document.querySelector('#tabs [data-tab="settings"]').click() }, t("tlGoSettings"))] : null)] : null,
          it.status !== "recording" && it.howToEnable && it.howToEnable !== sw.reason ? [h("dt", {}, t("tlHow")), h("dd", {}, h("span", { class: "tl-warn" }, it.howToEnable))] : null,
          privacy ? [h("dt", {}, t("tlPrivacy")), h("dd", {}, privacy, sw.sensitive ? h("div", { class: "mute" }, t("tlSensitive")) : null)] : null,
          (it.fields || []).length ? [h("dt", {}, t("tlFields")), h("dd", {}, (it.fields || []).map((f) => h("code", {}, f)))] : null,
          h("dt", {}, t("tlSource")), h("dd", {}, h("code", {}, it.source)),
          sw.key ? [h("dt", {}, t("tlDefault")), h("dd", {}, sw.default ? t("tlOn") : t("tlOff"), " · ", h("code", {}, `telemetry.${sw.key}`))] : null);
        const detail = h("tr", { class: "tl-d", id: did, hidden: true }, h("td", { colspan: "8" }, dl));
        x.onclick = () => {
          const open = detail.hidden;
          detail.hidden = !open;
          x.setAttribute("aria-expanded", String(open));
        };
        body.append(row, detail);
      }
      return body;
    };
    const master = h("input", { class: "tg", type: "checkbox", role: "switch", checked: data.telemetry ? data.telemetry.on : data.switches.telemetry, "aria-label": t("tlMaster"), onchange: () => change({ telemetry: master.checked }, master.checked, master)() });
    const days = h("input", { type: "number", min: "1", max: "3650", value: String((data.settings && data.settings.retentionDays) || data.switches.retentionDays || 90), "aria-label": t("tlRetention") });
    const masterSince = data.telemetry && !data.telemetry.on && data.telemetry.changed ? data.telemetry.changed : null;
    return [
      h("div", { class: "tl-head" },
        h("div", {}, h("h2", { class: "tl-title" }, t("tlTitle")), h("p", { class: "lede mute", style: "margin:2px 0 0" }, t("tlLede"))),
        h("div", { class: "row no-print" }, h("button", { class: "btn sm ghost", type: "button", onclick: () => window.print() }, t("tlPrint")), h("button", { class: "btn sm", type: "button", onclick: copy }, t("tlCopy")))),
      h("p", { class: "tl-summary" }, C.summary(data, t)),
      h("div", { class: "tl-bar" },
        h("label", {}, master, h("b", {}, t("tlMaster")), h("span", { class: "print-on" }, data.telemetry && data.telemetry.on ? t("tlOn") : t("tlOff")), masterSince ? h("span", { class: "mute", style: "font-size:12px" }, t("tlSince", shortDate(masterSince.at), masterSince.by)) : null),
        h("label", {}, h("span", {}, t("tlRetention")), days, h("button", { class: "btn sm quiet no-print", type: "button", onclick: change({ retentionDays: Number(days.value) }, true) }, t("save"))),
        h("p", { class: "tl-note" }, t("tlNote"))),
      h("div", { class: "tl-wrap" }, h("table", { class: "tl" },
        h("caption", { class: "vh" }, t("tlTitle")),
        h("thead", {}, h("tr", {},
          h("th", { class: "c-on", scope: "col" }, t("tlColOn")), h("th", { class: "c-name", scope: "col" }, t("tlItem")), h("th", { class: "c-st", scope: "col" }, t("tlStatus")),
          h("th", { class: "c-n", scope: "col" }, t("tl7d")), h("th", { class: "c-seen", scope: "col" }, t("tlLastSeen")), h("th", { class: "c-dr", scope: "col" }, t("tlDecision")),
          h("th", { class: "c-pv", scope: "col" }, h("span", { class: "vh" }, t("tlPrivacyCol"))), h("th", { class: "c-x", scope: "col" }, h("span", { class: "vh" }, t("tlDetailsCol"))))),
        view.groups.map(groupBody))),
      h("p", { class: "tl-legend" }, t("tlGenerated", when(data.generatedAt)), " ", t("tlLegend")),
    ];
  }

  /** A host route (<prefix>/settings/…): null when the server has none (404). */
  async function hostApi(path, opts = {}) {
    const res = await fetch(`${HOST}${path}`, {
      method: opts.method || (opts.body ? "PUT" : "GET"),
      headers: opts.body ? { "content-type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 404 && !opts.body) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  const fromText = (f) => (f === "default" ? t("acFromDefault") : f);
  /** A small form with one text box and a button: add a person. */
  function addForm(label, send) {
    const input = h("input", { type: "text", placeholder: t("acAddPh"), "aria-label": label, maxlength: "150", autocomplete: "off" });
    const go = act(async () => { const v = input.value.trim(); if (!v) return; await send(v); input.value = ""; }, t("saved"));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(e); } });
    return h("div", { class: "row add-row" }, input, h("button", { class: "btn sm", type: "button", onclick: go }, t("acAdd")));
  }
  let usersQuery = "";

  // Access: who administers and who may use the assistant, as the deployment set them; the people admins added.
  async function access() {
    const [adm, usr] = await Promise.all([
      hostApi("settings/admins").catch(() => null),
      hostApi(`settings/users?${pageQuery("users", 20)}${usersQuery ? `&q=${encodeURIComponent(usersQuery)}` : ""}`).catch(() => null),
    ]);
    if ((!adm || !adm.mode) && (!usr || !usr.modes)) return card(t("tabAccess"), t("acNoneSet"));
    const warn = (list) => (list || []).map((w) => h("p", { class: "warn-line" }, w));
    const line = (label, mode, from, extra) => h("div", { class: "kv" }, h("dt", {}, label), h("dd", {}, h("b", {}, mode), " ", h("span", { class: "mute" }, t("acFrom", fromText(from))), extra ? h("div", { class: "mute" }, extra) : null));
    const out = [card(t("acWho"), null,
      h("dl", { class: "kvs" },
        adm && adm.mode ? line(t("acAdmins"), adm.label, adm.from, adm.roles ? t("acRoles", adm.roles.join(", ")) : null) : null,
        usr && usr.modes ? line(t("acUsers"), usr.label, usr.from, usr.everyone ? t("acEveryone") : usr.roles && usr.roles.length ? t("acRoles", usr.roles.join(", ")) : null) : null),
      warn(adm && adm.warnings), warn(usr && usr.warnings),
      shell.signOut ? h("div", { class: "actions" }, h("a", { class: "btn sm quiet", href: shell.signOut }, t("acSignOut"))) : null)];

    if (adm && adm.mode === "superset-users") {
      const remove = (u) => (ev) => (confirm(t("acRemoveQ", u)) ? act(() => hostApi("settings/admins", { body: { remove: u } }), t("saved"))(ev) : null);
      out.push(card(t("acAdmins"), null,
        h("h3", { class: "sub-h" }, t("acOwners")),
        h("ul", { class: "people" }, adm.owners.map((o) => h("li", {}, h("b", {}, o)))),
        h("p", { class: "mute small" }, adm.ownersFrom ? `${t("acOwnerNote")} (${adm.ownersFrom})` : t("acOwnerNote")),
        h("h3", { class: "sub-h" }, t("acGranted")),
        adm.granted.length ? peopleTable(adm.granted, adm.canGrant ? remove : null) : h("p", { class: "mute" }, t("acNoGranted")),
        adm.canGrant ? addForm(t("acAdmins"), (u) => hostApi("settings/admins", { body: { add: u } })) : h("p", { class: "mute small" }, t("acOwnersOnly"))));
    }
    if (usr && usr.modes && usr.modes.includes("granted")) {
      const remove = (u) => (ev) => (confirm(t("acRemoveQ", u)) ? act(() => hostApi("settings/users", { body: { remove: u } }), t("saved"))(ev) : null);
      const search = h("input", { type: "search", value: usersQuery, placeholder: t("acSearch"), "aria-label": t("acSearch") });
      search.addEventListener("change", () => { usersQuery = search.value.trim(); delete pagingState.users; render(); });
      out.push(card(t("acUsers"), null,
        usr.seeded && usr.seeded.length ? [h("h3", { class: "sub-h" }, t("acSeeded")), h("ul", { class: "people" }, usr.seeded.map((u) => h("li", {}, h("b", {}, u)))), usr.seededFrom ? h("p", { class: "mute small" }, usr.seededFrom) : null] : null,
        h("div", { class: "row between" }, h("h3", { class: "sub-h" }, t("acPeople")), search),
        usr.users.length ? peopleTable(usr.users, remove) : h("p", { class: "mute" }, t("acNoPeople")),
        listPager("users", usr.page),
        addForm(t("acUsers"), (u) => hostApi("settings/users", { body: { add: u } }))));
    }
    return out;
  }
  function peopleTable(rows, remove) {
    return h("div", { class: "table-wrap" }, h("table", { class: "people-table" },
      h("thead", {}, h("tr", {}, h("th", {}, t("acUser")), h("th", {}, t("acBy")), h("th", {}, t("acAt")), remove ? h("th", {}, h("span", { class: "sr" }, t("acRemove"))) : null)),
      h("tbody", {}, rows.map((g) => h("tr", {}, h("td", {}, h("b", {}, g.user)), h("td", {}, g.by), h("td", { class: "num" }, when(g.at)),
        remove ? h("td", { class: "end" }, h("button", { class: "btn sm quiet", type: "button", onclick: remove(g.user), "aria-label": `${t("acRemove")} ${g.user}` }, t("acRemove"))) : null)))));
  }

  // ---- Host settings, shared by the tabs that read them ------------------------------------------------------
  /** The host's settings (GET <prefix>/settings), once per drawing. */
  let hostSettingsAt = 0, hostSettingsP = null;
  const hostSettings = () => {
    if (!hostSettingsP || Date.now() - hostSettingsAt > 1500) { hostSettingsAt = Date.now(); hostSettingsP = hostApi("settings"); }
    return hostSettingsP;
  };
  const put = (path, body, msg) => act(() => hostApi(path, { body }), msg || t("saved"));
  const fld = (label, input, wide) => h("label", { class: `field${wide ? " wide" : ""}` }, h("span", {}, label), input);
  const num = (value, min, max, step) => h("input", { type: "number", value: value === null || value === undefined ? "" : String(value), min: min === undefined ? null : String(min), max: max === undefined ? null : String(max), step: step ? String(step) : null, inputmode: "numeric" });
  const sourcePill = (src) => pill(t(`source_${src === "settings" ? "settings" : src === "env" ? "env" : src === "config" ? "config" : "default"}`), src === "settings" ? "acc" : "");
  const kvList = (rows) => h("dl", { class: "kvs" }, rows.filter(Boolean).map(([k, v]) => h("div", { class: "kv" }, h("dt", {}, k), h("dd", {}, v))));
  const mb = (bytes) => ((bytes || 0) < 1048576 ? `${nf((bytes || 0) / 1024)} KB` : `${nf(bytes / 1048576, 1)} MB`);
  const table = (heads, rows, empty) => (rows.length
    ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, heads.map((x) => (typeof x === "string" ? h("th", {}, x) : h("th", { class: x.n ? "n" : x.cls || "" }, x.t))))), h("tbody", {}, rows)))
    : h("p", { class: "empty" }, empty));

  // ---- Models & voice ------------------------------------------------------------------------------------------
  async function models() {
    const s = await hostSettings();
    const c = s.chat;
    const out = [];
    // The chat model: model × effort; models that are down are greyed. "Back to" names the deployment's default plainly.
    if (c) {
      const choices = [];
      for (const p of c.options) {
        const levels = p.efforts ? p.efforts.levels : [null];
        for (const e of levels) choices.push({ value: `${p.name}|${e || ""}`, label: `${p.label || p.name}${e ? ` · ${t("effortN", e)}` : ""}${p.available === false ? ` · ${t("notAnswering")}` : ""}`, disabled: p.available === false });
      }
      const sel = h("select", { "aria-label": t("chatModelH"), disabled: !c.writable }, choices.map((o) => h("option", { value: o.value, disabled: o.disabled ? "" : null, selected: o.value === `${c.model}|${c.effort || ""}` ? "" : null }, o.label)));
      const save = act(() => { const [model, effort] = sel.value.split("|"); return hostApi("settings/chat", { body: { model, effort: effort || null } }); }, t("saved"));
      out.push(card(t("chatModelH"), null,
        h("p", { class: "row" }, t("chatNow", `${c.label || c.model || "—"}${c.effort ? ` · ${t("effortN", c.effort)}` : ""}`), sourcePill(c.source)),
        c.fallback ? h("p", { class: "warn-line" }, t("chatFallback", c.defaultLabel, c.label)) : null,
        h("div", { class: "row", style: "margin-top:12px" }, sel, h("button", { class: "btn", type: "button", onclick: save, disabled: !c.writable }, t("saveModel")),
          c.source === "settings" && c.defaultLabel ? h("button", { class: "btn quiet", type: "button", onclick: put("settings/chat", { model: null }), disabled: !c.writable }, t("chatBack", c.defaultLabel)) : null)));
      out.push(card(t("modelsH"), null, table([t("mName"), t("mKind"), t("mState"), { t: t("mLatency"), n: true }, t("mPriced")],
        c.options.map((p) => h("tr", {}, h("td", {}, h("b", {}, p.label || p.name), h("div", { class: "mute small mono" }, p.model)), h("td", {}, p.kind), h("td", {}, pill(p.available === false ? t("down") : t("up"), p.available === false ? "bad" : "ok")), h("td", { class: "n" }, p.latencyMs ? `${nf(p.latencyMs)} ms` : "—"), h("td", {}, p.priced ? "✓" : "—"))), t("none"))));
    }
    // Speech to text: model and hold-to-talk, then the measured table, then kept recordings.
    const sp = s.speech;
    if (sp) {
      if (!sp.enabled) out.push(card(t("sttH"), null, h("p", { class: "mute" }, t("sttOff"))));
      else {
        const list = await hostApi("settings/speech/models").catch(() => null);
        const opts = (Array.isArray(list) ? list : []).map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
        if (!opts.includes(sp.model)) opts.unshift(sp.model);
        const sel = h("select", { "aria-label": t("sttModel"), disabled: !sp.writable }, opts.map((m) => h("option", { value: m, selected: m === sp.model ? "" : null }, m)));
        const hold = num(sp.holdMs, sp.holdMsRange && sp.holdMsRange.min, sp.holdMsRange && sp.holdMsRange.max, 50);
        out.push(card(t("sttH"), null,
          h("div", { class: "form" }, fld(t("sttModel"), sel), fld(t("sttHold"), hold)),
          h("div", { class: "actions" }, h("button", { class: "btn", type: "button", disabled: !sp.writable, onclick: act(() => hostApi("settings/speech", { body: { model: sel.value === sp.defaultModel ? null : sel.value, holdMs: hold.value === "" ? null : Number(hold.value) } }), t("saved")) }, t("sttSave")), sourcePill(sp.source))));
      }
      const measured = sp.measured && sp.measured.rows ? Object.entries(sp.measured.rows) : [];
      if (measured.length)
        out.push(card(t("measuredH"), t("measuredLede"), table([t("mName"), ...sp.measured.columns.map((c2) => ({ t: c2, n: true }))],
          measured.map(([m, vals]) => h("tr", { class: m === sp.model ? "on" : "" }, h("td", { class: "mono small" }, m === sp.model ? h("b", {}, m) : m), vals.map((v) => h("td", { class: "n" }, v)))), t("none"))));
      out.push(await keptRecordings(sp));
    }
    return out;
  }
  async function keptRecordings(sp) {
    const a = await hostApi(`audio?${pageQuery("audio", 10)}`).catch(() => null);
    const on = !!sp.keepAudio;
    const days = num(sp.audioRetentionDays, sp.audioRetentionRange && sp.audioRetentionRange.min, sp.audioRetentionRange && sp.audioRetentionRange.max);
    const maxMb = num(sp.maxStoredMb, sp.maxStoredMbRange && sp.maxStoredMbRange.min, sp.maxStoredMbRange && sp.maxStoredMbRange.max);
    const notice = h("textarea", { rows: 2, maxlength: "2000", value: sp.consentNotice || "" });
    const who = h("input", { type: "text", placeholder: t("delUserPh"), "aria-label": t("delUser") });
    const clips = (a && a.clips) || [];
    const remove = (id) => (ev) => (confirm(t("clipDeleteQ")) ? act(() => hostApi(`audio/${encodeURIComponent(id)}`, { method: "DELETE" }), t("done"))(ev) : null);
    return card(t("keptH"), null,
      h("p", { class: "row" }, on ? t("keptOn", nf(a ? a.files ?? clips.length : 0), mb(a && a.bytes)) : t("keptOff"), h("button", { class: "btn sm quiet", type: "button", onclick: () => go("telemetry") }, t("openTelemetry"))),
      h("div", { class: "form", style: "margin-top:8px" }, fld(t("keptDays"), days), fld(t("keptMb"), maxMb), fld(t("consent"), notice, true)),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", disabled: !sp.writable, onclick: act(() => hostApi("settings/speech", { body: { audioRetentionDays: days.value === "" ? null : Number(days.value), maxStoredMb: maxMb.value === "" ? null : Number(maxMb.value), consentNotice: notice.value.trim() || null } }), t("saved")) }, t("keptSave")),
        h("button", { class: "btn quiet", type: "button", disabled: !sp.writable, onclick: put("settings/speech", { audioRetentionDays: null, maxStoredMb: null, consentNotice: null }) }, t("keptReset"))),
      h("h3", {}, t("clipsH")),
      table([t("clipWhen"), t("clipUser"), { t: t("clipSize"), n: true }, t("clipPlay"), { t: "", cls: "end" }],
        clips.map((c) => h("tr", {}, h("td", { class: "num" }, when(c.at)), h("td", {}, c.user), h("td", { class: "n" }, mb(c.bytes)),
          h("td", {}, h("audio", { controls: true, preload: "none", src: `${HOST}audio/${encodeURIComponent(c.id)}`, "aria-label": `${t("clipPlay")} ${c.user} ${when(c.at)}` })),
          h("td", { class: "end" }, h("button", { class: "btn sm danger", type: "button", onclick: remove(c.id) }, t("clipDelete"))))), t("noClips")),
      listPager("audio", a && a.page),
      h("div", { class: "row", style: "margin-top:16px" }, h("span", { class: "mute" }, t("delUser")), who,
        h("button", { class: "btn sm danger", type: "button", onclick: (ev) => (who.value.trim() ? act(() => hostApi(`audio?user=${encodeURIComponent(who.value.trim())}`, { method: "DELETE" }), t("done"))(ev) : null) }, t("delUserBtn")),
        h("button", { class: "btn sm ghost", type: "button", disabled: !clips.length, style: "margin-left:auto", onclick: act(async () => { const r = await hostApi("audio/export", { method: "POST" }); toast(t("exported", nf(r.clips), nf(r.flagged))); }, false) }, t("exportBtn"))));
  }

  // ---- Spend & audit -----------------------------------------------------------------------------------------
  const spendF = { from: "", to: "", user: "" };
  const auditF = { from: "", to: "", user: "", action: "", outcome: "", q: "" };
  const filterQuery = (f) => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  function filterBar(f, keys, onApply) {
    const inputs = {};
    const box = (k) => {
      if (k === "outcome") return (inputs[k] = h("select", {}, [["", t("aAll")], ["ok", t("aOk")], ["denied", t("aDenied")]].map(([v, l]) => h("option", { value: v, selected: f[k] === v ? "" : null }, l))));
      return (inputs[k] = h("input", { type: k === "from" || k === "to" ? "date" : k === "q" ? "search" : "text", value: f[k] || "", size: k === "q" ? 18 : 12 }));
    };
    const label = { from: "fromD", to: "toD", user: "userF", action: "aAction", outcome: "aOutcome", q: "search" };
    const apply = () => { for (const k of keys) f[k] = inputs[k].value.trim(); onApply(); };
    const bar = h("form", { class: "filters", onsubmit: (e) => { e.preventDefault(); apply(); } },
      keys.map((k) => h("label", {}, t(label[k]), box(k))),
      h("button", { class: "btn sm", type: "submit" }, t("apply")),
      keys.some((k) => f[k]) ? h("button", { class: "btn sm quiet", type: "button", onclick: () => { for (const k of keys) f[k] = ""; onApply(); } }, t("clear")) : null);
    return bar;
  }
  async function spend() {
    const fq = filterQuery(spendF);
    const [turns, audit] = await Promise.all([
      hostApi(`turns?${pageQuery("turns")}${fq ? `&${fq}` : ""}`).catch((e) => ({ error: e.message })),
      hostApi(`audit?${pageQuery("audit", 50)}${filterQuery(auditF) ? `&${filterQuery(auditF)}` : ""}`).catch((e) => ({ error: e.message })),
    ]);
    const out = [];
    const tot = (label, x) => h("span", {}, `${label}: `, h("b", {}, usd(x && x.costUsd)), x ? ` · ${nf(x.turns)} ${t("answers")}` : "");
    if (turns.error) out.push(card(t("costH"), null, h("p", { class: "bad-line" }, turns.error)));
    else if (!turns.enabled) out.push(card(t("costH"), null, h("p", { class: "mute" }, t("costOff"))));
    else
      out.push(card(t("costH"), null,
        h("div", { class: "totals" }, tot(t("today"), turns.today), tot(t("week"), turns.week), turns.range ? tot(t("rangeT"), turns.range) : null, turns.range && turns.range.unpriced ? h("span", { class: "pill warn" }, t("unpricedN", nf(turns.range.unpriced))) : null),
        filterBar(spendF, ["from", "to", "user"], () => { delete pagingState.turns; render(); }),
        table([t("tWhen"), t("tUser"), t("tBoard"), t("tModel"), { t: t("tTokens"), n: true }, { t: t("tStt"), n: true }, { t: t("tCost"), n: true }],
          (turns.recent || []).map((r) => h("tr", {}, h("td", { class: "num" }, when(r.at)), h("td", {}, r.user), h("td", { class: "mono small" }, r.board || "—"), h("td", { class: "small" }, (r.models || []).join(", ") || "—"),
            h("td", { class: "n" }, r.tokens ? `${nf(r.tokens.in)} / ${nf(r.tokens.out)}` : "—"), h("td", { class: "n" }, r.sttUsd ? usd(r.sttUsd) : "—"), h("td", { class: "n" }, usd(r.costUsd)))), t("noTurns")),
        listPager("turns", turns.page)));
    if (audit.error) out.push(card(t("auditH"), null, h("p", { class: "bad-line" }, audit.error)));
    else if (!audit.enabled) out.push(card(t("auditH"), null, h("p", { class: "mute" }, t("auditOff"))));
    else
      out.push(card(t("auditH"), t("auditLede", nf(audit.retentionDays), (audit.months || []).length ? audit.months.join(", ") : "—"),
        filterBar(auditF, ["from", "to", "user", "action", "outcome", "q"], () => { delete pagingState.audit; render(); }),
        table([t("tWhen"), t("tUser"), t("aAction"), t("aOutcome"), t("aDetail")],
          (audit.events || []).map((e) => h("tr", {}, h("td", { class: "num", style: "white-space:nowrap" }, when(e.at)), h("td", {}, e.user), h("td", {}, e.action, e.board ? h("div", { class: "mute small mono" }, e.board) : null), h("td", {}, pill(e.outcome === "ok" ? t("aOk") : t("aDenied"), e.outcome === "ok" ? "ok" : "bad")), h("td", { class: "small", style: "overflow-wrap:anywhere" }, e.detail || ""))), t("noEvents")),
        listPager("audit", audit.page)));
    return out;
  }

  // ---- Saved answers' settings and the queue (on the Cache tab) -------------------------------------------------
  function cacheSettingsCards(s) {
    const out = [];
    const c = s.cache;
    if (c) {
      const on = h("input", { type: "checkbox", checked: c.enabled, disabled: !c.writable });
      const router = h("input", { type: "checkbox", checked: c.router === "on", disabled: !c.writable });
      const ttl = num(c.ttlHours, 1, 2160), max = num(c.maxEntries, 10, 20000), fresh = num(c.freshMinutes, 0, 1440);
      const pw = c.prewarm || {};
      const pwOn = h("input", { type: "checkbox", checked: !!pw.enabled, disabled: !c.writable });
      const pwTimes = h("input", { type: "text", value: (pw.times || []).join(", ") });
      const pwTop = num(pw.topN, 1, 100), pwUsd = num(pw.maxUsd, 0, 100, 0.01);
      const save = act(() => hostApi("settings/cache", { body: { enabled: on.checked, router: router.checked ? "on" : "off", ttlHours: Number(ttl.value), maxEntries: Number(max.value), freshMinutes: Number(fresh.value), prewarm: { enabled: pwOn.checked, times: pwTimes.value.split(",").map((x) => x.trim()).filter(Boolean), topN: Number(pwTop.value), maxUsd: Number(pwUsd.value) } } }), t("saved"));
      out.push(card(t("cacheSetH"), null,
        h("label", { class: "switch" }, on, h("div", {}, h("div", { class: "lbl" }, t("cOn")))),
        h("label", { class: "switch" }, router, h("div", {}, h("div", { class: "lbl" }, t("cRouter")))),
        h("div", { class: "form", style: "margin-top:8px" }, fld(t("cTtl"), ttl), fld(t("cMax"), max), fld(t("cFresh"), fresh)),
        h("label", { class: "switch", style: "margin-top:8px" }, pwOn, h("div", {}, h("div", { class: "lbl" }, t("cPw")))),
        h("div", { class: "form" }, fld(t("cPwTimes"), pwTimes), fld(t("cPwTop"), pwTop), fld(t("cPwUsd"), pwUsd)),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: save, disabled: !c.writable }, t("saveB")), c.source === "settings" ? h("button", { class: "btn quiet", type: "button", onclick: put("settings/cache", { enabled: null, router: null, ttlHours: null, maxEntries: null, freshMinutes: null, prewarm: null }) }, t("resetDefaults")) : null, sourcePill(c.source))));
    }
    const q = s.queue;
    if (q) {
      const conc = num(q.maxConcurrent, 1, 1000), wait = num(q.maxWaiting, 0, 10000), secs = num(q.maxWaitSeconds, 1, 3600);
      out.push(card(t("queueH"), null,
        h("div", { class: "form" }, fld(t("qConc"), conc), fld(t("qWait"), wait), fld(t("qSecs"), secs)),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", disabled: !q.writable, onclick: act(() => hostApi("settings/queue", { body: { maxConcurrent: Number(conc.value), maxWaiting: Number(wait.value), maxWaitSeconds: Number(secs.value) } }), t("saved")) }, t("saveB")),
          q.source === "settings" ? h("button", { class: "btn quiet", type: "button", onclick: put("settings/queue", { maxConcurrent: null, maxWaiting: null, maxWaitSeconds: null }) }, t("resetDefaults")) : null, sourcePill(q.source))));
    }
    return out;
  }

  // ---- Settings: own dashboards, edit scope, config, where to change things (Superset host) ----------------------
  function supersetSettingsCards(s) {
    const out = [];
    if (s.personal) {
      const p = s.personal;
      const dash = num(p.maxDashboardsPerUser, 0, 10000), lay = num(p.maxSavedLayoutsPerUser, 0, 10000);
      out.push(card(t("personalH"), null,
        h("p", { class: "row" }, t("pOn"), pill(p.on ? t("isOn") : t("isOff"), p.on ? "ok" : "")),
        h("div", { class: "form", style: "margin-top:8px" }, fld(t("pDash"), dash), fld(t("pLayouts"), lay)),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: act(() => hostApi("settings/personal", { body: { maxDashboardsPerUser: Number(dash.value), maxSavedConfigsPerUser: Number(lay.value) } }), t("saved")) }, t("saveB")),
          h("button", { class: "btn quiet", type: "button", onclick: put("settings/personal", { maxDashboardsPerUser: null, maxSavedConfigsPerUser: null }) }, t("resetDefaults")))));
    }
    if (s.editScope) {
      const e = s.editScope;
      const radio = (v, label) => h("label", { class: "row", style: "gap:8px" }, h("input", { type: "radio", name: "lp-scope", value: v, checked: e.scope === v }), label);
      const exempt = h("input", { type: "checkbox", checked: !!e.adminsExempt });
      const box = h("div", {}, radio("superset", t("scopeSuperset")), radio("own", t("scopeOwn")));
      out.push(card(t("scopeH"), null, box,
        h("label", { class: "switch" }, exempt, h("div", {}, h("div", { class: "lbl" }, t("scopeExempt")))),
        e.warning ? h("p", { class: "warn-line" }, e.warning) : null,
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: act(() => hostApi("settings/edit-scope", { body: { scope: box.querySelector("input:checked").value, adminsExempt: exempt.checked } }), t("saved")) }, t("saveB")),
          h("button", { class: "btn quiet", type: "button", onclick: put("settings/edit-scope", { scope: null, adminsExempt: null }) }, t("resetDefaults")))));
    }
    return out;
  }
  function configCards(s) {
    const b = s.budget || {};
    const rows = [
      [t("budgetDay"), b.usdPerDay ? usd(b.usdPerDay) : t("none2")],
      [t("budgetUser"), b.usdPerUserPerDay ? usd(b.usdPerUserPerDay) : t("none2")],
      s.telemetry && s.telemetry.context ? [t("tabTelemetry"), t("contextN", nf(s.telemetry.context))] : null,
      s.hostPolicy ? [t("hostPolicyL"), s.hostPolicy === "superset" ? t("hostSuperset") : t("hostOff")] : null,
      s.editPolicy ? [t("editPolicyL"), s.editPolicy === "superset" ? t("editSuperset") : t("editSigned")] : null,
    ];
    // Where each kind of setting is changed. hostPolicy defaults to superset (each person's own access), not off.
    const where = [
      [t("chatModelH"), `${t("tabModels")} · superset.yaml llm.providers · LENSPACK_LLM_PROVIDERS`],
      [t("sttH"), `${t("tabModels")} · LENSPACK_STT_API_KEY`],
      [t("dataH"), "superset.yaml datasets, overlay, budget"],
      [t("whoH"), `${t("tabAccess")} · auth.userAccess, auth.users · LENSPACK_USER_ACCESS, LENSPACK_USER_ROLES`],
      [t("acAdmins"), `${t("tabAccess")} · auth.adminAccess · LENSPACK_ADMIN_ACCESS`],
      [t("hostPolicyL"), "hostPolicy: superset (default) or off · LENSPACK_HOST_POLICY"],
      [t("editPolicyL"), "editPolicy: superset (default) or signed-in · LENSPACK_EDIT_POLICY"],
      [t("offH"), `${t("tabSettings")} · features · LENSPACK_FEATURES`],
    ];
    return [
      card(t("configH"), null, kvList(rows)),
      s.superset ? card(t("whereH"), null, table([t("wWhat"), t("wWhere")], where.map(([a, b2]) => h("tr", {}, h("td", {}, a), h("td", { class: "small" }, b2))), "")) : null,
    ];
  }

  // ---- Assistant: what Superset needs (Superset host only) -----------------------------------------------------
  async function assistantTab() {
    const info = await hostApi("info").catch(() => null);
    const adminInfo = (info && info.admin) || {};
    const panelLink = shell.panelUrl || adminInfo.panel;
    const link = card(t("panelH"), null, h("div", { class: "linkcard" },
      h("div", {}, h("b", {}, t("panelLede")), adminInfo.access === "password" ? h("p", { class: "note" }, t("panelPassword")) : null),
      panelLink ? h("a", { class: "btn", href: panelLink }, t("openPanel")) : null));
    if (sections === "link") return [link];
    const s = await hostSettings();
    const out = [];
    if (sections === "host" && panelLink) out.push(link);
    const ua = s.userAccess || {};
    out.push(card(t("whoH"), null, kvList([
      [t("onOff"), s.features && s.features.values ? (s.features.values.overlay ? t("isOn") : t("isOff")) : "—"],
      [t("acUsers"), ua.label || "—"],
      [t("acAdmins"), (s.adminAccess && s.adminAccess.label) || "—"],
      [t("hostPolicyL"), s.hostPolicy === "off" ? t("hostOff") : t("hostSuperset")],
      [t("editPolicyL"), s.editPolicy === "signed-in" ? t("editSigned") : t("editSuperset")],
      s.editScope ? [t("scopeL"), s.editScope.scope === "own" ? t("scopeOwn") : t("scopeSuperset")] : null,
    ])));
    if (s.brand) out.push(brandCard(s.brand, true));
    const sup = s.superset || {};
    // What only Superset knows (its data connections, the service account's roles), written into its page.
    const facts = shell.facts || null;
    const chatUp = (s.providers || []).some((p) => p.available !== false);
    out.push(card(t("connH"), null, kvList([
      [t("cUrl"), sup.url ? h("code", {}, sup.url) : "—"],
      [t("cAccount"), sup.username ? `${sup.username} (${sup.account || ""})` : "—"],
      [t("cIdentity"), s.chat && s.chat.writable === false ? h("span", { class: "pill bad" }, t("cMissing")) : h("span", { class: "pill ok" }, t("cReceived"))],
      [t("cChat"), h("span", { class: `pill ${chatUp ? "ok" : "bad"}` }, chatUp ? t("cChatOk") : t("cChatDown"))],
      facts && facts.accountRoles ? [t("cRoles"), facts.accountRoles.join(", ") || "—"] : null,
    ]),
    facts && facts.databases && facts.databases.length ? [h("h3", {}, t("dbH")), table([t("dbName"), t("dbBackend"), { t: t("dbDatasets"), n: true }], facts.databases.map((d) => h("tr", {}, h("td", {}, d.name), h("td", { class: "mono small" }, d.backend || "—"), h("td", { class: "n" }, nf(d.datasets)))), "")] : null));
    const l = s.language;
    if (l) {
      const opt = (v, label, cur) => h("option", { value: v, selected: v === cur ? "" : null }, label);
      const rep = h("select", {}, l.options.map((o) => opt(o, o === "auto" ? t("lAuto") : LANG_NAMES[o] || o, l.default)));
      const titles = h("select", {}, [opt("board", t("lTitleBoard"), l.titles), opt("speaker", t("lTitleSpeaker"), l.titles)]);
      const board = h("select", {}, l.options.filter((o) => o !== "auto").map((o) => opt(o, LANG_NAMES[o] || o, l.board)));
      out.push(card(t("langH"), null,
        h("div", { class: "form" }, fld(t("lReplies"), rep), fld(t("lTitles"), titles), fld(t("lBoard"), board)),
        h("div", { class: "actions" }, h("button", { class: "btn", type: "button", disabled: !l.writable, onclick: act(() => hostApi("settings/language", { body: { default: rep.value, titles: titles.value, board: board.value } }), t("saved")) }, t("saveB")),
          l.source === "settings" ? h("button", { class: "btn quiet", type: "button", onclick: put("settings/language", { default: null, titles: null, board: null }) }, t("resetDefaults")) : null, sourcePill(l.source))));
    }
    if (s.datasets) {
      const root2 = (info && info.supersetRoot) || "";
      out.push(card(t("dataH"), s.pack ? `${t("dPack")}: ${s.pack}` : null,
        table([t("dTable"), t("dEntity"), ""], s.datasets.map((d) => h("tr", {}, h("td", { class: "mono" }, d.schema ? `${d.schema}.${d.table}` : d.table), h("td", {}, d.entity || "—"), h("td", { class: "end" }, h("a", { href: `${root2}/tablemodelview/edit/${d.id}` }, t("dEdit"))))), t("none")),
        s.warnings && s.warnings.length ? [h("h3", {}, t("dWarnings")), h("ul", { class: "small" }, s.warnings.map((w) => h("li", {}, typeof w === "string" ? w : JSON.stringify(w))))] : null,
        s.dashboards && s.dashboards.length ? [h("h3", {}, t("dDashboards")), h("p", { class: "small mute" }, s.dashboards.map((d) => (typeof d === "object" ? d.title || d.id : d)).join(", "))] : null));
    }
    return out;
  }

  const TABS = { overview, review, questions, proposals, definitions, cache, models, access, settings, assistant: assistantTab, telemetry, spend };
  let rendering = 0;
  async function render(section) {
    const mine = ++rendering;
    const shown = shownTabs();
    if (!shown.some((d) => d.id === tab)) tab = shown[0] ? shown[0].id : "overview";
    applyChrome();
    try {
      const nodes = await TABS[tab]();
      if (mine !== rendering) return;
      main.replaceChildren(...[nodes].flat(Infinity).filter(Boolean));
    } catch (e) {
      if (mine !== rendering) return;
      main.replaceChildren(h("p", { class: "pad bad" }, t("failed", e.message)));
    }
    paintSections();
    if (section) scrollToSection(section);
    counts();
  }
  async function counts() {
    // Small badges on the tabs that wait for a decision.
    try {
      const [q, p] = await Promise.all([api("questions?status=open"), api("proposals?status=pending")]);
      for (const [name, n] of [["questions", q.questions.length], ["proposals", p.proposals.length]]) {
        const b = navEl.querySelector(`[data-tab="${name}"]`);
        if (!b) continue;
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
      packSel.replaceChildren(...packs.map((p) => h("option", { value: p.name, selected: p.name === pack ? "" : null }, p.name)));
      packPick.hidden = packs.length < 2;
      subEl.textContent = `${r.me.user} · ${packs.map((p) => p.name).join(", ")}`;
    } catch (e) {
      // A link to the admin panel needs nothing from it (the person may not be its admin: the password signs in there).
      if (sections !== "link") {
        main.replaceChildren(h("p", { class: "pad" }, t("failed", e.message)));
        return;
      }
    }
    render(hashSection);
  }
  start();
})();
