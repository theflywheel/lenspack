// The Lenspack chat panel, framework-free so it can sit beside a Superset
// iframe or float on Superset's own pages. It speaks the board API's chat
// stream (AI SDK UI message stream over SSE) and says when Superset changed.
(function () {
  if (window.LenspackChat) return;

  const CSS = `
.lpc{--lpc-fg:#1f2328;--lpc-mute:#667085;--lpc-line:#e4e7ec;--lpc-bg:#fff;--lpc-soft:#f5f7fa;--lpc-acc:#1a85a0;--lpc-acc-soft:#e6f4f7;--lpc-bad:#b42318;--lpc-ok:#067647;
  font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI","Noto Sans","Noto Sans Devanagari","Nirmala UI","Kohinoor Devanagari",sans-serif;color:var(--lpc-fg);background:var(--lpc-bg);display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box}
.lpc *{box-sizing:border-box}
.lpc [hidden]{display:none!important}
.lpc-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--lpc-line)}
.lpc-mark{width:26px;height:26px;border-radius:7px;background:var(--lpc-acc);color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.lpc-mark.lpc-icon{background:none}
.lpc-mark img{width:100%;height:100%;object-fit:contain;border-radius:inherit;display:block}
.lpc-by{display:block;padding:0 14px 8px;font-size:11px;color:var(--lpc-mute);text-decoration:none;text-align:right}
.lpc-by:hover{text-decoration:underline}
.lpc-ttl{flex:1;min-width:0}
.lpc-ttl b{display:block;font-size:14px}
.lpc-ttl span{display:block;color:var(--lpc-mute);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lpc-x{border:0;background:none;font-size:20px;line-height:1;color:var(--lpc-mute);cursor:pointer;padding:4px 6px;border-radius:6px}
.lpc-x:hover{background:var(--lpc-soft)}
.lpc-new{border:0;background:none;color:var(--lpc-mute);cursor:pointer;padding:5px;border-radius:6px;display:grid;place-items:center}
.lpc-new:hover:not(:disabled){background:var(--lpc-soft);color:var(--lpc-fg)}
.lpc-new:disabled{opacity:.4;cursor:not-allowed}
.lpc-new svg{width:17px;height:17px}
.lpc-undo{margin-left:8px;border:0;background:none;color:var(--lpc-acc);font:inherit;font-weight:600;cursor:pointer;padding:0;text-decoration:underline}
.lpc-undo:disabled{opacity:.45;cursor:default}
.lpc-down{padding:5px 14px;font-size:12px;line-height:1.4;background:#fffaeb;color:#93370d;border-bottom:1px solid #fedf89}
.lpc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:0}
.lpc-empty{color:var(--lpc-mute);font-size:13px}
.lpc-empty p{margin:0 0 10px}
.lpc-chips{display:flex;flex-direction:column;gap:6px}
.lpc-chip{text-align:left;border:1px solid var(--lpc-line);background:var(--lpc-bg);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;color:var(--lpc-fg);cursor:pointer}
.lpc-chip:hover{border-color:var(--lpc-acc);background:var(--lpc-acc-soft)}
.lpc-quick{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}
.lpc-quick .lpc-chip{padding:6px 10px;border-color:var(--lpc-acc);color:var(--lpc-acc);font-weight:500}
.lpc-msg{max-width:92%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}
.lpc-user{align-self:flex-end;background:var(--lpc-acc);color:#fff;border-bottom-right-radius:3px}
.lpc-bot{align-self:flex-start;background:var(--lpc-soft);border-bottom-left-radius:3px;white-space:normal}
.lpc-bot.lpc-pre{background:none;color:var(--lpc-mute);font-size:12.5px;padding:0 2px}
.lpc-bot p{margin:0 0 6px}
.lpc-plain{white-space:pre-wrap}
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
.lpc-cost{align-self:flex-start;font-size:11.5px;color:var(--lpc-mute);margin:-4px 0 0 2px;max-width:100%}
.lpc-cost summary{cursor:pointer;list-style:none;display:inline-block;border-radius:4px;padding:0 3px;font-variant-numeric:tabular-nums}
.lpc-cost summary::-webkit-details-marker{display:none}
.lpc-cost summary:hover,.lpc-cost summary:focus-visible{color:var(--lpc-fg);outline:1px solid var(--lpc-line)}
.lpc-cost>div{padding:2px 3px 0;line-height:1.4}
.lpc-nocost .lpc-cost{display:none}
.lpc-note{align-self:stretch;font-size:12px;color:var(--lpc-mute);border-left:3px solid var(--lpc-line);padding:2px 8px}
.lpc-note.sync{border-color:var(--lpc-acc);color:var(--lpc-acc)}
.lpc-note.bad{border-color:var(--lpc-bad);color:var(--lpc-bad)}
.lpc-saved{align-self:flex-start;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:11.5px;color:var(--lpc-mute);margin:-4px 0 0 2px}
.lpc-saved svg{width:12px;height:12px;flex:none}
.lpc-saved .lpc-undo{margin-left:0;font-size:11.5px}
.lpc-foot{border-top:1px solid var(--lpc-line);padding:10px;display:flex;gap:8px;align-items:flex-end}
.lpc-in{flex:1;resize:none;border:1px solid var(--lpc-line);border-radius:8px;padding:8px 10px;font:inherit;min-height:40px;max-height:140px;outline:none;color:var(--lpc-fg);background:var(--lpc-bg)}
.lpc-in::placeholder{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lpc-in:focus{border-color:var(--lpc-acc);box-shadow:0 0 0 3px var(--lpc-acc-soft)}
.lpc-go{border:0;background:var(--lpc-acc);color:#fff;border-radius:8px;height:40px;padding:0 14px;font:inherit;font-weight:600;cursor:pointer}
.lpc-go:disabled{opacity:.5;cursor:default}
.lpc-status{font-size:12px;color:var(--lpc-mute);padding:0 14px 6px;min-height:18px;display:flex;align-items:center;gap:8px}
.lpc-lang{position:relative;flex:none}
.lpc-lang>button{border:1px solid var(--lpc-line);background:var(--lpc-bg);color:var(--lpc-mute);border-radius:6px;font:12px/1 inherit;font-family:inherit;padding:5px 7px;cursor:pointer;white-space:nowrap}
.lpc-lang>button:hover,.lpc-lang>button[aria-expanded=true]{border-color:var(--lpc-acc);color:var(--lpc-fg)}
.lpc-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:5;background:var(--lpc-bg);border:1px solid var(--lpc-line);border-radius:8px;box-shadow:0 8px 24px rgba(16,24,40,.12);padding:6px;min-width:190px;display:none}
.lpc-menu.on{display:block}
.lpc-menu h6{margin:4px 6px;font-size:11px;font-weight:600;color:var(--lpc-mute);text-transform:uppercase;letter-spacing:.04em}
.lpc-menu label{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;font-size:13px;cursor:pointer}
.lpc-menu label:hover{background:var(--lpc-soft)}
.lpc-menu hr{border:0;border-top:1px solid var(--lpc-line);margin:6px 0}
.lpc-menu small{display:block;color:var(--lpc-mute);font-size:11.5px;padding:0 6px 4px 30px;line-height:1.35}
.lpc-mic{flex:none;width:40px;height:40px;border:1px solid var(--lpc-line);background:var(--lpc-bg);color:var(--lpc-fg);border-radius:8px;cursor:pointer;display:grid;place-items:center;touch-action:none;user-select:none;-webkit-user-select:none}
.lpc-mic:hover{border-color:var(--lpc-acc)}
.lpc-mic:disabled{opacity:.45;cursor:not-allowed}
.lpc-mic svg{width:18px;height:18px}
.lpc-mic.rec{background:var(--lpc-bad);border-color:var(--lpc-bad);color:#fff;animation:lpc-pulse 1.2s ease-in-out infinite}
.lpc-mic.wait{opacity:.6;cursor:progress}
.lpc-mic.hold{border-color:var(--lpc-acc);color:var(--lpc-acc);background:linear-gradient(to top,color-mix(in srgb,var(--lpc-acc) 32%,transparent) var(--lpc-hold,0%),var(--lpc-bg) var(--lpc-hold,0%))}
.lpc-menu select{font:inherit;font-size:12px;margin-left:6px;padding:2px 4px;border:1px solid var(--lpc-line);border-radius:5px;background:var(--lpc-bg);color:var(--lpc-fg)}
@keyframes lpc-pulse{0%,100%{box-shadow:0 0 0 0 rgba(180,35,24,.35)}50%{box-shadow:0 0 0 6px rgba(180,35,24,0)}}
.lpc-rec{color:var(--lpc-bad);font-weight:600;font-variant-numeric:tabular-nums}
.lpc-meter{flex:none;width:64px;height:6px;border-radius:3px;background:var(--lpc-line);overflow:hidden}
.lpc-meter i{display:block;height:100%;width:0;background:var(--lpc-bad);transition:width 60ms linear}
@media (prefers-reduced-motion:reduce){.lpc-mic.rec{animation:none}}
[data-lp-theme=dark] .lpc,.lpc[data-lp-theme=dark]{--lpc-fg:#e6e8eb;--lpc-mute:#98a2b3;--lpc-line:#343842;--lpc-bg:#1b1d21;--lpc-soft:#262a31;--lpc-acc:#1f8fab;--lpc-acc-soft:rgba(31,143,171,.22);--lpc-bad:#f97066;--lpc-ok:#47cd89;color-scheme:dark}
[data-lp-theme=dark] .lpc-down{background:#3a2a0a;color:#fec84b;border-bottom-color:#5c4210}
[data-lp-theme=dark] .lpc-bot code,[data-lp-theme=dark] .lpc-bot pre{background:rgba(255,255,255,.08)}
[data-lp-theme=dark] .lpc-bot a,[data-lp-theme=dark] .lpc-undo,[data-lp-theme=dark] .lpc-note.sync{color:#3fb1cc}
[data-lp-theme=dark] .lpc-note.sync{border-color:#3fb1cc}
[data-lp-theme=dark] .lpc-saved .lpc-undo{color:#3fb1cc}
[data-lp-theme=dark] .lpc-menu{box-shadow:0 8px 24px rgba(0,0,0,.5)}
`;

  // "How this was worked out" under an answer (docs/explain.md): its own styles and words, so the
  // rest of the panel's are left as they are.
  const EXPLAIN_CSS = `
.lpc-ex{align-self:stretch;min-width:0;max-width:100%;margin:-4px 0 0;font-size:12.5px}
.lpc-ex-btn{display:inline-flex;align-items:center;gap:5px;border:0;background:none;color:var(--lpc-acc);font:inherit;font-weight:600;cursor:pointer;padding:2px 4px;border-radius:5px}
.lpc-ex-btn:hover,.lpc-ex-btn:focus-visible{background:var(--lpc-acc-soft);outline:none}
.lpc-ex-btn::before{content:"";width:0;height:0;border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .12s}
.lpc-ex-btn[aria-expanded=true]::before{transform:rotate(90deg)}
.lpc-ex-body{margin-top:4px;border:1px solid var(--lpc-line);border-radius:8px;background:var(--lpc-bg);padding:8px 10px;display:flex;flex-direction:column;gap:12px;min-width:0}
.lpc-ex-call{display:flex;flex-direction:column;gap:6px;min-width:0}
.lpc-ex-call+.lpc-ex-call{border-top:1px solid var(--lpc-line);padding-top:10px}
.lpc-ex-desc{margin:0;line-height:1.5;color:var(--lpc-fg)}
.lpc-ex-n{display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:9px;background:var(--lpc-soft);color:var(--lpc-mute);font-size:11px;font-weight:600;margin-right:6px;vertical-align:1px}
.lpc-ex-tag{margin:0;font-size:11.5px;color:var(--lpc-mute)}
.lpc-ex-sql{border:1px solid var(--lpc-line);border-radius:6px;overflow:hidden;min-width:0}
.lpc-ex-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 4px 3px 8px;background:var(--lpc-soft);font-size:11.5px;color:var(--lpc-mute)}
.lpc-ex-copy{border:1px solid var(--lpc-line);background:var(--lpc-bg);color:var(--lpc-fg);border-radius:5px;font:inherit;font-size:11.5px;padding:1px 8px;cursor:pointer}
.lpc-ex-copy:hover,.lpc-ex-copy:focus-visible{border-color:var(--lpc-acc);outline:none}
.lpc-ex pre{margin:0;padding:8px;max-height:240px;overflow:auto;white-space:pre;font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--lpc-fg);background:var(--lpc-bg);tab-size:2}
.lpc-ex-params{margin:0;padding:4px 8px 6px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--lpc-mute);overflow-x:auto;white-space:nowrap}
.lpc-ex-tw{overflow-x:auto;max-width:100%;border:1px solid var(--lpc-line);border-radius:6px}
.lpc-ex table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;width:max-content;min-width:100%}
.lpc-ex th,.lpc-ex td{padding:3px 8px;border-bottom:1px solid var(--lpc-line);text-align:left;white-space:nowrap}
.lpc-ex th{font-weight:600;color:var(--lpc-mute);font-size:11.5px;background:var(--lpc-soft)}
.lpc-ex tr:last-child td{border-bottom:0}
.lpc-ex .lpc-num{text-align:right}
.lpc-ex caption{caption-side:bottom;text-align:left;padding:3px 8px;font-size:11.5px;color:var(--lpc-mute)}
[data-lp-theme=dark] .lpc-ex-btn{color:#3fb1cc}
`;
  const EXPLAIN_STRINGS = {
    en: { toggle: "How this was worked out", sql: "SQL that ran", request: "Request that ran", copy: "Copy", copied: "Copied", values: "Values", rows: "Showing {0} of {1} rows", allRows: "{0} rows", oneRow: "1 row", noRows: "No rows came back.", saved: "Saved answer, data as of {0}", cached: "Answered from the source's cache, data as of {0}", more: "{0} more data calls are not shown.", call: "Data call {0}", filters: "Dashboard filters when you asked", applied: "applied", notApplied: "not applied to these numbers" },
    fr: { toggle: "Comment ce résultat a été obtenu", sql: "SQL exécuté", request: "Requête exécutée", copy: "Copier", copied: "Copié", values: "Valeurs", rows: "{0} lignes affichées sur {1}", allRows: "{0} lignes", oneRow: "1 ligne", noRows: "Aucune ligne renvoyée.", saved: "Réponse enregistrée, données au {0}", cached: "Réponse tirée du cache de la source, données au {0}", more: "{0} autres appels de données ne sont pas affichés.", call: "Appel de données {0}", filters: "Filtres du tableau de bord au moment de la question", applied: "appliqué", notApplied: "non appliqué à ces chiffres" },
    hi: { toggle: "यह कैसे निकाला गया", sql: "चलाया गया SQL", request: "चलाया गया अनुरोध", copy: "कॉपी करें", copied: "कॉपी हो गया", values: "मान", rows: "{1} में से {0} पंक्तियाँ दिखाई गईं", allRows: "{0} पंक्तियाँ", oneRow: "1 पंक्ति", noRows: "कोई पंक्ति नहीं मिली।", saved: "सहेजा गया जवाब, डेटा {0} तक का", cached: "स्रोत के कैश से जवाब, डेटा {0} तक का", more: "{0} और डेटा कॉल नहीं दिखाए गए।", call: "डेटा कॉल {0}", filters: "पूछते समय डैशबोर्ड के फ़िल्टर", applied: "लागू", notApplied: "इन संख्याओं पर लागू नहीं" },
    pt: { toggle: "Como este resultado foi obtido", sql: "SQL executado", request: "Pedido executado", copy: "Copiar", copied: "Copiado", values: "Valores", rows: "{0} de {1} linhas mostradas", allRows: "{0} linhas", oneRow: "1 linha", noRows: "Nenhuma linha devolvida.", saved: "Resposta gravada, dados de {0}", cached: "Resposta da cache da fonte, dados de {0}", more: "Mais {0} chamadas de dados não são mostradas.", call: "Chamada de dados {0}", filters: "Filtros do painel no momento da pergunta", applied: "aplicado", notApplied: "não aplicado a estes números" },
  };

  // The panel's words, by language. "auto" shows the page's language (Superset's, else the
  // browser's) when it is one of these, else English. Tool names stay as the model's steps.
  // {name} is the assistant's name, and the title is the button's label: both from the deployment's brand.
  const STRINGS = {
    en: {
      title: "Ask {name}", sub: "Superset dashboard", close: "Close", placeholder: "Ask for a chart, a change, or a number…", send: "Send",
      intro: "Changes you ask for are saved to this Superset dashboard. The numbers come from Superset's own metrics.",
      working: "Working…", reviewing: "Reviewing the result…", noAnswer: "(no answer)", wrong: "Something went wrong", unreachable: "Could not reach {name}: {0}",
      saved: "Saved to Superset.", savedRefreshing: "Saved to Superset. Refreshing the dashboard…", savedLater: "Saved to Superset. The dashboard refreshes when the reviewer finishes.",
      language: "Language", auto: "Auto", autoHelp: "Speak or type in any language; replies follow it.", pickedHelp: "Speech is transcribed as {0}, and replies are in {0}.", space: "Hold Space to talk", spaceHelp: "Hold Space for {0} s, even while typing; a quick press types a space. Or hold the mic button.", holdFor: "Hold for", holdDefault: "{0} s (default)", keepHolding: "Keep holding to talk…", newChat: "New chat", newChatHelp: "New chat: clear this conversation (the dashboard stays as it is)", cleared: "Chat cleared.", undo: "Undo", followSuperset: "Following Superset's language: {0}. Pick one here to use another.", adminDefault: "This deployment's default: {0}. Pick one here to use another.", unsureLang: "Couldn't tell which language that was: pick one in the language menu and try again.", missedIn: "Didn't catch that in {0}: try again.",
      mic: "Speak (click to start and stop, or hold)", micNeedsHttps: "The microphone needs a secure (https) page", micUnsupported: "This browser cannot record audio",
      listening: "Listening… {0}", transcribing: "Transcribing…", tooShort: "Nothing was recorded. Hold the mic or click it, speak, then stop.", heard: "Check the text, then send.", nothingHeard: "No speech was recognised. Try again a little closer to the microphone.",
      denied: "Microphone access is blocked. Allow it for this site in the browser (the icon left of the address), then try again.", noMic: "No microphone was found.", sttFailed: "Transcription failed: {0}", sttOff: "Speech to text is not set up on this server.",
      cost: "≈ ${0}", costTitle: "Estimated cost of this answer, from list prices", costTokens: "{0}: {1} tokens in, {2} out", costSpeech: "includes speech to text, ${0}", costUnpriced: "some calls have no price and are not counted", sessionCost: "This session: ≈ ${0} for {1} answers (estimate from list prices)",
      restarting: "{name} is restarting, reconnecting…", lost: "The connection to {name} was lost before the answer finished (it may be restarting).", retry: "Retry",
      busyWait: "Busy, about {0} s (number {1} in line)…", waitEdit: "Waiting for another edit on this dashboard…", busyFull: "{name} is too busy right now. Try again in a minute, or pick a common question below: those are answered at once.",
      savedAnswer: "Saved answer, data as of {0}", savedEdit: "Saved change, made as before", savedTitle: "Answered from an earlier answer to the same question, with the numbers read again. No AI model was used.", askFresh: "Ask fresh", askFreshTitle: "Have the assistant work this out again from scratch",
    },
    fr: {
      title: "Demander à {name}", sub: "Tableau de bord Superset", close: "Fermer", placeholder: "Demandez un graphique, une modification ou un chiffre…", send: "Envoyer",
      intro: "Les modifications demandées sont enregistrées dans ce tableau de bord Superset. Les chiffres viennent des métriques de Superset.",
      working: "En cours…", reviewing: "Vérification du résultat…", noAnswer: "(pas de réponse)", wrong: "Un problème est survenu", unreachable: "Impossible de joindre {name} : {0}",
      saved: "Enregistré dans Superset.", savedRefreshing: "Enregistré dans Superset. Actualisation du tableau de bord…", savedLater: "Enregistré dans Superset. Le tableau de bord s'actualise à la fin de la vérification.",
      language: "Langue", auto: "Auto", autoHelp: "Parlez ou écrivez dans n'importe quelle langue ; les réponses suivent.", pickedHelp: "La voix est transcrite en {0} et les réponses sont en {0}.", space: "Maintenir Espace pour parler", spaceHelp: "Maintenez Espace {0} s, même en écrivant ; un appui bref tape une espace. Ou maintenez le bouton micro.", holdFor: "Durée", holdDefault: "{0} s (par défaut)", keepHolding: "Maintenez pour parler…", newChat: "Nouvelle discussion", newChatHelp: "Nouvelle discussion : effacer cette conversation (le tableau de bord reste tel quel)", cleared: "Discussion effacée.", undo: "Annuler", followSuperset: "Suit la langue de Superset : {0}. Choisissez-en une ici pour en changer.", adminDefault: "Langue par défaut de ce déploiement : {0}. Choisissez-en une ici pour en changer.", unsureLang: "Impossible de savoir quelle langue c'était : choisissez-en une dans le menu des langues et réessayez.", missedIn: "Pas compris en {0} : réessayez.",
      mic: "Parler (cliquer pour démarrer et arrêter, ou maintenir)", micNeedsHttps: "Le micro nécessite une page sécurisée (https)", micUnsupported: "Ce navigateur ne peut pas enregistrer le son",
      listening: "À l'écoute… {0}", transcribing: "Transcription…", tooShort: "Rien n'a été enregistré. Maintenez ou cliquez le micro, parlez, puis arrêtez.", heard: "Vérifiez le texte, puis envoyez.", nothingHeard: "Aucune parole reconnue. Réessayez un peu plus près du micro.",
      denied: "L'accès au micro est bloqué. Autorisez-le pour ce site dans le navigateur (l'icône à gauche de l'adresse), puis réessayez.", noMic: "Aucun micro trouvé.", sttFailed: "La transcription a échoué : {0}", sttOff: "La reconnaissance vocale n'est pas configurée sur ce serveur.",
      cost: "≈ {0} $", costTitle: "Coût estimé de cette réponse, d'après les prix publics", costTokens: "{0} : {1} jetons en entrée, {2} en sortie", costSpeech: "dont reconnaissance vocale : {0} $", costUnpriced: "certains appels n'ont pas de prix et ne sont pas comptés", sessionCost: "Cette session : ≈ {0} $ pour {1} réponses (estimation d'après les prix publics)",
      restarting: "{name} redémarre, reconnexion…", lost: "La connexion à {name} a été perdue avant la fin de la réponse (il redémarre peut-être).", retry: "Réessayer",
      busyWait: "Occupé, environ {0} s (n° {1} dans la file)…", waitEdit: "En attente d'une autre modification de ce tableau de bord…", busyFull: "{name} est très sollicité en ce moment. Réessayez dans une minute, ou choisissez une question courante ci-dessous : elles ont une réponse immédiate.",
      savedAnswer: "Réponse enregistrée, données du {0}", savedEdit: "Modification enregistrée, refaite comme avant", savedTitle: "Réponse tirée d'une réponse précédente à la même question, avec les chiffres relus. Aucun modèle d'IA n'a été utilisé.", askFresh: "Redemander", askFreshTitle: "Faire refaire la réponse par l'assistant depuis le début",
    },
    hi: {
      title: "{name} से पूछें", sub: "Superset डैशबोर्ड", close: "बंद करें", placeholder: "चार्ट, बदलाव या कोई संख्या पूछें…", send: "भेजें",
      intro: "आप जो बदलाव कहेंगे, वे इसी Superset डैशबोर्ड में सेव होंगे। संख्याएँ Superset के अपने मेट्रिक्स से आती हैं।",
      working: "काम चल रहा है…", reviewing: "नतीजे की जाँच हो रही है…", noAnswer: "(कोई जवाब नहीं)", wrong: "कुछ गड़बड़ हो गई", unreachable: "{name} तक नहीं पहुँच सके: {0}",
      saved: "Superset में सेव हो गया।", savedRefreshing: "Superset में सेव हो गया। डैशबोर्ड रीफ़्रेश हो रहा है…", savedLater: "Superset में सेव हो गया। जाँच पूरी होने पर डैशबोर्ड रीफ़्रेश होगा।",
      language: "भाषा", auto: "ऑटो", autoHelp: "किसी भी भाषा में बोलें या लिखें; जवाब उसी भाषा में आएगा।", pickedHelp: "आवाज़ {0} में लिखी जाएगी और जवाब {0} में आएँगे।", space: "बोलने के लिए Space दबाकर रखें", spaceHelp: "टाइप करते हुए भी Space को {0} सेकंड दबाकर रखें; जल्दी दबाने से स्पेस टाइप होता है। या माइक बटन दबाकर रखें।", holdFor: "कितनी देर", holdDefault: "{0} सेकंड (डिफ़ॉल्ट)", keepHolding: "बोलने के लिए दबाए रखें…", newChat: "नई बातचीत", newChatHelp: "नई बातचीत: यह बातचीत मिटाएँ (डैशबोर्ड जैसा है वैसा रहेगा)", cleared: "बातचीत मिटा दी गई।", undo: "वापस लाएँ", followSuperset: "Superset की भाषा: {0}। कोई और भाषा चाहिए तो यहाँ चुनें।", adminDefault: "इस डिप्लॉयमेंट की डिफ़ॉल्ट भाषा: {0}। कोई और भाषा चाहिए तो यहाँ चुनें।", unsureLang: "पता नहीं चला कि यह कौन सी भाषा थी: भाषा मेनू में एक चुनें और फिर से कोशिश करें।", missedIn: "{0} में समझ नहीं आया: फिर से कोशिश करें।",
      mic: "बोलें (शुरू और बंद करने के लिए क्लिक करें, या दबाकर रखें)", micNeedsHttps: "माइक के लिए सुरक्षित (https) पेज चाहिए", micUnsupported: "यह ब्राउज़र आवाज़ रिकॉर्ड नहीं कर सकता",
      listening: "सुन रहे हैं… {0}", transcribing: "लिखा जा रहा है…", tooShort: "कुछ रिकॉर्ड नहीं हुआ। माइक दबाकर रखें या क्लिक करें, बोलें, फिर रोकें।", heard: "टेक्स्ट जाँचें, फिर भेजें।", nothingHeard: "कोई आवाज़ पहचानी नहीं गई। माइक के थोड़ा पास से फिर कोशिश करें।",
      denied: "माइक की अनुमति बंद है। ब्राउज़र में इस साइट के लिए अनुमति दें (पते के बाईं ओर का आइकन), फिर कोशिश करें।", noMic: "कोई माइक नहीं मिला।", sttFailed: "लिखना नहीं हो सका: {0}", sttOff: "इस सर्वर पर स्पीच-टू-टेक्स्ट सेट नहीं है।",
      busyWait: "व्यस्त, लगभग {0} सेकंड (कतार में {1}वें)…", waitEdit: "इस डैशबोर्ड पर दूसरे बदलाव के पूरा होने का इंतज़ार…", busyFull: "{name} अभी बहुत व्यस्त है। एक मिनट बाद फिर कोशिश करें, या नीचे कोई आम सवाल चुनें: उनका जवाब तुरंत मिलता है।",
      savedAnswer: "सहेजा गया जवाब, डेटा {0} तक का", savedEdit: "सहेजा गया बदलाव, पहले की तरह किया गया", savedTitle: "यह जवाब इसी सवाल के पिछले जवाब से बना है, संख्याएँ फिर से पढ़ी गईं। किसी AI मॉडल का उपयोग नहीं हुआ।", askFresh: "नए सिरे से पूछें", askFreshTitle: "सहायक से जवाब शुरू से दोबारा बनवाएँ",
      cost: "≈ ${0}", costTitle: "इस जवाब की अनुमानित लागत, सूची कीमतों के आधार पर", costTokens: "{0}: {1} टोकन इनपुट, {2} आउटपुट", costSpeech: "इसमें स्पीच-टू-टेक्स्ट ${0} शामिल है", costUnpriced: "कुछ कॉल की कीमत नहीं है, वे गिनी नहीं गईं", sessionCost: "इस सत्र में: ≈ ${0}, {1} जवाब (सूची कीमतों से अनुमान)",
      restarting: "{name} फिर से शुरू हो रहा है, दोबारा जुड़ रहे हैं…", lost: "जवाब पूरा होने से पहले {name} से कनेक्शन टूट गया (शायद वह फिर से शुरू हो रहा है)।", retry: "फिर से कोशिश करें",
    },
    // Neutral Portuguese, read in Mozambique, Angola and Portugal as well as Brazil: noun forms where the
    // two split (Em escuta, not Ouvindo / A ouvir), words both use (gravado, conexão, padrão), formal imperatives.
    pt: {
      title: "Perguntar ao {name}", sub: "Painel do Superset", close: "Fechar", placeholder: "Peça um gráfico, uma alteração ou um número…", send: "Enviar",
      intro: "As alterações que pedir ficam gravadas neste painel do Superset. Os números vêm das métricas do próprio Superset.",
      working: "Em curso…", reviewing: "Verificação do resultado…", noAnswer: "(sem resposta)", wrong: "Ocorreu um problema", unreachable: "Sem acesso ao {name}: {0}",
      saved: "Gravado no Superset.", savedRefreshing: "Gravado no Superset. Atualização do painel…", savedLater: "Gravado no Superset. O painel é atualizado quando a verificação terminar.",
      language: "Idioma", auto: "Auto", autoHelp: "Fale ou escreva em qualquer idioma; as respostas seguem esse idioma.", pickedHelp: "A voz é transcrita em {0} e as respostas são em {0}.", space: "Manter Espaço para falar", spaceHelp: "Mantenha a tecla Espaço pressionada {0} s, mesmo ao escrever; um toque curto escreve um espaço. Ou mantenha pressionado o botão do microfone.", holdFor: "Duração", holdDefault: "{0} s (padrão)", keepHolding: "Mantenha pressionado para falar…", newChat: "Nova conversa", newChatHelp: "Nova conversa: apagar esta conversa (o painel fica como está)", cleared: "Conversa apagada.", undo: "Desfazer", followSuperset: "Segue o idioma do Superset: {0}. Escolha outro aqui para mudar.", adminDefault: "Idioma padrão desta instalação: {0}. Escolha outro aqui para mudar.", unsureLang: "Não foi possível identificar o idioma: escolha um no menu de idiomas e tente de novo.", missedIn: "Não foi possível entender em {0}: tente de novo.",
      mic: "Falar (clique para iniciar e parar, ou mantenha pressionado)", micNeedsHttps: "O microfone precisa de uma página segura (https)", micUnsupported: "Este navegador não consegue gravar áudio",
      listening: "Em escuta… {0}", transcribing: "Transcrição em curso…", tooShort: "Nada foi gravado. Mantenha pressionado ou clique no microfone, fale e depois pare.", heard: "Verifique o texto e depois envie.", nothingHeard: "Nenhuma fala reconhecida. Tente de novo um pouco mais perto do microfone.",
      denied: "O acesso ao microfone está bloqueado. Permita-o para este site no navegador (o ícone à esquerda do endereço) e tente de novo.", noMic: "Nenhum microfone encontrado.", sttFailed: "A transcrição falhou: {0}", sttOff: "A transcrição de voz não está configurada neste servidor.",
      restarting: "{name} em reinício, reconexão em curso…", lost: "A conexão com o {name} foi interrompida antes do fim da resposta (talvez esteja em reinício).", retry: "Tentar de novo",
      busyWait: "Ocupado, cerca de {0} s (n.º {1} na fila)…", waitEdit: "À espera de outra alteração neste painel…", busyFull: "O {name} está muito ocupado neste momento. Tente de novo dentro de um minuto, ou escolha uma pergunta frequente abaixo: essas têm resposta imediata.",
      savedAnswer: "Resposta guardada, dados de {0}", savedEdit: "Alteração guardada, refeita como antes", savedTitle: "Resposta tirada de uma resposta anterior à mesma pergunta, com os números lidos de novo. Nenhum modelo de IA foi usado.", askFresh: "Perguntar de novo", askFreshTitle: "Pedir ao assistente que refaça a resposta desde o início",
      cost: "≈ US$ {0}", costTitle: "Custo estimado desta resposta, segundo os preços de tabela", costTokens: "{0}: {1} tokens de entrada, {2} de saída", costSpeech: "inclui transcrição de voz: US$ {0}", costUnpriced: "algumas chamadas não têm preço e não foram contadas", sessionCost: "Esta sessão: ≈ US$ {0} em {1} respostas (estimativa segundo os preços de tabela)",
    },
  };
  // The language menu's choices, each named in its own language.
  const LANGS = [
    ["auto", null],
    ["en", "English"],
    ["fr", "Français"],
    ["hi", "हिन्दी"],
    ["pt", "Português"],
  ];
  const SHORT = { auto: "Auto", en: "EN", fr: "FR", hi: "हि", pt: "PT" };
  const NAMES_IN = {
    en: { en: "English", fr: "French", hi: "Hindi", pt: "Portuguese" },
    fr: { en: "anglais", fr: "français", hi: "hindi", pt: "portugais" },
    hi: { en: "अंग्रेज़ी", fr: "फ़्रेंच", hi: "हिन्दी", pt: "पुर्तगाली" },
    pt: { en: "inglês", fr: "francês", hi: "híndi", pt: "português" },
  };

  // The page's language: Superset's (its bootstrap data, then <html lang>), else the browser's.
  function pageLocale() {
    try {
      const app = document.getElementById("app");
      const boot = app && app.dataset && app.dataset.bootstrap ? JSON.parse(app.dataset.bootstrap) : null;
      const l = boot && boot.common && boot.common.locale;
      if (l) return String(l).slice(0, 2).toLowerCase();
    } catch (e) {}
    return (document.documentElement.lang || navigator.language || "en").slice(0, 2).toLowerCase();
  }

  // What this browser remembers for voice: the language picked and whether Space talks.
  const PREFS = "lenspack-voice";
  function prefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  function savePrefs(p) {
    try {
      localStorage.setItem(PREFS, JSON.stringify(p));
    } catch (e) {}
  }

  const HOLD_CHOICES = [500, 1000, 1500, 2000, 2500, 3000];
  const NEW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';

  const TOOL = {
    get_board: "read the dashboard", list_metrics: "read the metrics", query: "ran a query", explain: "checked a query", list_values: "listed values",
    list_versions: "read the history", restore_version: "restored a version", add_widget: "add chart", update_widget: "change chart", move_widget: "move chart",
    resize_widget: "resize chart", remove_widget: "remove chart", add_filter: "add filter", update_filter: "change filter", remove_filter: "remove filter", set_layout_mode: "layout", rename_board: "rename dashboard", propose_measure: "proposed a metric",
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
      s.textContent = CSS + EXPLAIN_CSS;
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
    // What this tab's chat has spent on this board, across New chat: the menu's running total.
    const spent = saved.spent && typeof saved.spent.usd === "number" ? saved.spent : { usd: 0, turns: 0 };
    // Clip ids from speech to text since the last question: the next question names them, so its cost includes them.
    const clips = [];
    const persist = () => {
      try {
        sessionStorage.setItem(key, JSON.stringify({ messages: history.slice(-30), since, spent }));
      } catch (e) {}
    };

    // Language, and why: a language picked here, unless Superset's language was changed after the pick
    // (the newer choice wins); on Auto or with no pick, Superset's language when someone chose one (its
    // default, English, is not a choice); else, with no pick, the deployment's default (settings).
    // Auto with Superset left in English is real auto: no speech hint, replies follow the speaker.
    const fmt = (str, ...a) => String(str).replace(/\{(\d)\}/g, (_, i) => (a[i] === undefined ? "" : a[i]));
    let prefsNow = prefs();
    // The deployment's off switches (/_superset/info features): a switch that is false hides its part.
    let feat = (opts.features && typeof opts.features === "object") ? opts.features : {};
    const page = pageLocale();
    let adminLang = (opts.language && opts.language.default) || "auto";
    function effectiveLang() {
      // With the language menu switched off, a pick saved earlier no longer applies.
      const p = feat.languageMenu === false ? undefined : prefsNow.lang;
      const fromSuperset = page !== "en" && STRINGS[page] ? page : null;
      if (p && p !== "auto") {
        // langPage: Superset's language when the pick was made. Older prefs have none: the pick stands.
        const changedSince = prefsNow.langPage !== undefined && prefsNow.langPage !== page && STRINGS[page];
        return changedSince ? { code: page, source: "superset" } : { code: p, source: "picked" };
      }
      if (fromSuperset) return { code: fromSuperset, source: "superset" };
      if (p === "auto") return { code: "auto", source: "auto" };
      return { code: adminLang, source: adminLang === "auto" ? "auto" : "admin" };
    }
    const pickedLang = () => effectiveLang().code;
    const uiLang = () => {
      const l = pickedLang();
      return l !== "auto" && STRINGS[l] ? l : STRINGS[page] ? page : "en";
    };
    // What the assistant is called (/_superset/info brand), each language's words already worked out by the server.
    let brand = (opts.brand && typeof opts.brand === "object") ? opts.brand : {};
    const own = () => (brand.i18n && (brand.i18n[uiLang()] || brand.i18n.en)) || {};
    const t = (k, ...a) => (k === "title" && own().buttonLabel) || fmt(String((STRINGS[uiLang()] || STRINGS.en)[k] ?? STRINGS.en[k] ?? k).replace(/\{name\}/g, () => own().name || "Lenspack"), ...a);
    // A dollar amount with the precision a chat turn needs: $0.0042, $0.031, $1.20 (a comma in French).
    const usdText = (usd) => {
      const v = Number(usd) || 0;
      const out = v.toFixed(v >= 1 ? 2 : v >= 0.01 ? 3 : 4);
      return uiLang() === "fr" ? out.replace(".", ",") : out;
    };

    // A panel mounted again (another dashboard) drops the last one's page-wide listeners and mic.
    if (root.__lpcCleanup) root.__lpcCleanup();
    const cleanups = [];
    root.__lpcCleanup = () => cleanups.splice(0).forEach((f) => f());
    const listen = (target, type, fn, capture) => {
      target.addEventListener(type, fn, capture);
      cleanups.push(() => target.removeEventListener(type, fn, capture));
    };

    root.innerHTML = "";
    const wrap = el("div", "lpc");
    const head = el("div", "lpc-head");
    const mark = el("div", "lpc-mark", "L");
    head.append(mark);
    const ttl = el("div", "lpc-ttl");
    const ttlB = el("b", "", t("title"));
    const ttlS = el("span", "", opts.title || t("sub"));
    ttl.append(ttlB, ttlS);
    head.append(ttl);
    // The language menu: Auto or a language, and whether holding Space talks.
    const lang = el("div", "lpc-lang");
    const langBtn = el("button");
    langBtn.type = "button";
    langBtn.setAttribute("aria-haspopup", "true");
    langBtn.setAttribute("aria-expanded", "false");
    const menu = el("div", "lpc-menu");
    menu.setAttribute("role", "menu");
    lang.append(langBtn, menu);
    head.append(lang);
    const showMenu = (on) => {
      menu.classList.toggle("on", on);
      langBtn.setAttribute("aria-expanded", on ? "true" : "false");
    };
    langBtn.onclick = (e) => {
      e.stopPropagation();
      showMenu(!menu.classList.contains("on"));
    };
    listen(document, "pointerdown", (e) => {
      if (!lang.contains(e.target)) showMenu(false);
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        showMenu(false);
        langBtn.focus();
      }
    });
    function renderMenu() {
      const eff = effectiveLang();
      const cur = eff.code;
      const followed = eff.source === "superset" || eff.source === "admin";
      // The button says what's in effect: "FR" picked here, "Auto · FR" from Superset or the default, "Auto".
      langBtn.textContent = `${followed ? `${t("auto")} · ` : ""}${SHORT[cur] || cur} ▾`;
      const ui0 = uiLang();
      const named = (NAMES_IN[ui0] || NAMES_IN.en)[cur] || cur;
      langBtn.title = followed ? t(eff.source === "superset" ? "followSuperset" : "adminDefault", named) : t("language");
      menu.replaceChildren(el("h6", "", t("language")));
      for (const [code, name] of LANGS) {
        const l = el("label");
        const r = el("input");
        r.type = "radio";
        r.name = `lpc-lang-${opts.board}`;
        r.checked = (eff.source === "picked" ? cur : "auto") === code;
        r.onchange = () => {
          prefsNow = { ...prefsNow, lang: code, langPage: page };
          savePrefs(prefsNow);
          relabel();
          // The overlay around the panel (its button and menu) follows the same pick.
          window.dispatchEvent(new CustomEvent("lenspack-lang", { detail: { lang: uiLang() } }));
        };
        l.append(r, document.createTextNode(code === "auto" ? t("auto") : name));
        menu.append(l);
      }
      const ui = uiLang();
      menu.append(el("small", "", followed ? `${t(eff.source === "superset" ? "followSuperset" : "adminDefault", named)} ${t("pickedHelp", named)}` : cur === "auto" ? t("autoHelp") : t("pickedHelp", (NAMES_IN[ui] || NAMES_IN.en)[cur] || cur)));
      if (micState.enabled && feat.spaceHold !== false) {
        menu.append(el("hr"));
        const l = el("label");
        const c = el("input");
        c.type = "checkbox";
        c.checked = prefsNow.space !== false;
        c.onchange = () => {
          prefsNow = { ...prefsNow, space: c.checked };
          savePrefs(prefsNow);
        };
        l.append(c, document.createTextNode(t("space")));
        const hl = el("label");
        const sel = el("select");
        sel.setAttribute("aria-label", t("holdFor"));
        const opt = (value, text) => {
          const o = el("option", "", text);
          o.value = value;
          return o;
        };
        sel.append(opt("", t("holdDefault", secs(micState.holdMs))));
        for (const ms of HOLD_CHOICES) sel.append(opt(String(ms), `${secs(ms)} s`));
        sel.value = prefsNow.holdMs ? String(prefsNow.holdMs) : "";
        sel.onchange = () => {
          const { holdMs: _old, ...rest } = prefsNow;
          prefsNow = sel.value ? { ...rest, holdMs: Number(sel.value) } : rest;
          savePrefs(prefsNow);
          renderMenu();
        };
        hl.append(document.createTextNode(t("holdFor")), sel);
        menu.append(l, hl, el("small", "", t("spaceHelp", secs(holdMs()))));
      }
      if (feat.turnCost !== false && spent.turns > 0) {
        menu.append(el("hr"));
        const total = el("small", "lpc-total", t("sessionCost", usdText(spent.usd), spent.turns));
        total.setAttribute("role", "status");
        menu.append(total);
      }
    }
    // New chat: forgets this conversation, never the board.
    const newBtn = el("button", "lpc-new");
    newBtn.type = "button";
    newBtn.innerHTML = NEW_SVG;
    head.append(newBtn);
    if (opts.onClose) {
      const x = el("button", "lpc-x", "×");
      x.title = t("close");
      x.onclick = opts.onClose;
      head.append(x);
    }
    const log = el("div", "lpc-log");
    const status = el("div", "lpc-status");
    const foot = el("div", "lpc-foot");
    const input = el("textarea", "lpc-in");
    input.rows = 1;
    input.placeholder = t("placeholder");
    const go = el("button", "lpc-go", t("send"));
    const mic = el("button", "lpc-mic");
    mic.type = "button";
    mic.innerHTML = MIC_SVG;
    mic.hidden = true;
    foot.append(input, mic, go);
    // The mic, shown when the server has speech to text (its /_superset/info says so).
    const micState = { enabled: false, maxSeconds: 60, holdMs: 2000 };
    // How long Space must be held to talk: this browser's pick, else the deployment's.
    const secs = (ms) => (uiLang() === "fr" ? String(ms / 1000).replace(".", ",") : String(ms / 1000));
    const holdMs = () => (prefsNow.holdMs >= 500 && prefsNow.holdMs <= 3000 ? prefsNow.holdMs : micState.holdMs);
    // Shown while Lenspack is unreachable (the overlay finds out and calls setOffline): input waits until it is back.
    const downBar = el("div", "lpc-down");
    downBar.hidden = true;
    downBar.setAttribute("role", "status");
    // Declared before the first render: the suggested questions read it (disabled while offline).
    let offline = false;
    const retries = new Set();
    // "Powered by Lenspack", when the assistant has another name and the deployment keeps the line (brand.poweredBy).
    const by = el("a", "lpc-by");
    by.href = "https://github.com/theflywheel/lenspack";
    by.target = "_blank";
    by.rel = "noopener noreferrer";
    by.hidden = true;
    wrap.append(head, downBar, log, status, foot, by);
    root.append(wrap);

    const scroll = () => (log.scrollTop = log.scrollHeight);
    // A reply as formatted text, or as plain text when formatting is switched off.
    const replyNode = (text) => {
      if (feat.markdown !== false) return markdown(text);
      const p = el("div", "lpc-plain");
      p.textContent = text;
      return p;
    };
    function bubble(role, text) {
      const b = el("div", `lpc-msg ${role === "user" ? "lpc-user" : "lpc-bot"}`, role === "user" ? text : undefined);
      if (role !== "user" && text) b.append(replyNode(text));
      log.append(b);
      scroll();
      return b;
    }
    function note(text, cls) {
      log.append(el("div", `lpc-note ${cls || ""}`, text));
      scroll();
    }
    // A turn's cost under its reply: "≈ $0.0042", opening (keyboard or click) to the models, tokens and any speech to text.
    // Always drawn; the turnCost switch hides it with a class, so switching it back on shows it again.
    function costLine(c) {
      const d = el("details", "lpc-cost");
      const sum = el("summary", "", t("cost", usdText(c.costUsd)));
      sum.title = t("costTitle");
      sum.setAttribute("aria-label", `${t("costTitle")}: ${t("cost", usdText(c.costUsd))}`);
      const n = (x) => Number(x || 0).toLocaleString(uiLang() === "auto" ? undefined : uiLang());
      const tokens = c.tokens || {};
      const lines = [t("costTokens", (c.models || []).join(", ") || "—", n(tokens.in), n(tokens.out))];
      if (c.sttUsd > 0) lines.push(t("costSpeech", usdText(c.sttUsd)));
      if (c.unpriced > 0) lines.push(t("costUnpriced"));
      d.append(sum, el("div", "", lines.join(" · ")));
      return d;
    }
    // ---- How this was worked out (docs/explain.md): one expander under an answer, from the turn's
    // data-answer-card part (the answer card). Kept in this tab beside the conversation (by message id), so it is there
    // again after a reload, and never sent back to the server.
    const exKey = `lenspack-explain:${opts.board}`;
    const tx = (k, ...a) => fmt((EXPLAIN_STRINGS[uiLang()] || EXPLAIN_STRINGS.en)[k] ?? EXPLAIN_STRINGS.en[k], ...a);
    let exSeq = 0;
    function exStore(id, ex) {
      let all = {};
      try {
        all = JSON.parse(sessionStorage.getItem(exKey) || "{}") || {};
      } catch (e) {}
      if (ex === undefined) return all[id];
      all[id] = ex;
      // Only answers still in the conversation are kept.
      const ids = new Set(history.map((m) => m.id));
      for (const k of Object.keys(all)) if (!ids.has(k)) delete all[k];
      try {
        sessionStorage.setItem(exKey, JSON.stringify(all));
      } catch (e) {}
    }
    const exNumber = (v, format) => {
      if (typeof v !== "number") return v === null || v === undefined ? "—" : String(v);
      const loc = uiLang() === "auto" ? undefined : uiLang();
      if (format === "percent") return `${(v * 100).toLocaleString(loc, { maximumFractionDigits: 1 })}%`;
      return v.toLocaleString(loc, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });
    };
    function exCopy(btn, text) {
      const done = () => {
        btn.textContent = tx("copied");
        setTimeout(() => (btn.textContent = tx("copy")), 1500);
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
      else {
        const ta = el("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.append(ta);
        ta.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {}
        ta.remove();
      }
    }
    function exStatement(s) {
      const box = el("div", "lpc-ex-sql");
      const bar = el("div", "lpc-ex-bar");
      const copy = el("button", "lpc-ex-copy", tx("copy"));
      copy.type = "button";
      const params = s.params && s.params.length ? s.params : null;
      const full = params ? `${s.text}\n-- ${tx("values")}: ${params.map((p, i) => `${i + 1} = ${p}`).join(", ")}` : s.text;
      copy.onclick = () => exCopy(copy, full);
      bar.append(el("span", "", s.language === "sql" ? tx("sql") : tx("request")), copy);
      const pre = el("pre");
      pre.tabIndex = 0;
      pre.append(el("code", "", s.text));
      box.append(bar, pre);
      if (params) box.append(el("p", "lpc-ex-params", `${tx("values")}: ${params.map((p, i) => `${i + 1} = ${p}`).join(", ")}`));
      if (s.note) box.append(el("p", "lpc-ex-params", s.note));
      return box;
    }
    function exTable(c) {
      if (!c.rows || !c.rows.length) return el("p", "lpc-ex-tag", tx("noRows"));
      const wrap = el("div", "lpc-ex-tw");
      wrap.tabIndex = 0;
      const tbl = el("table");
      const num = c.columns.map((_, k) => c.rows.every((r) => r[k] === null || typeof r[k] === "number"));
      const head = el("tr");
      c.columns.forEach((col, k) => head.append(el("th", num[k] ? "lpc-num" : "", col.label)));
      const thead = el("thead");
      thead.append(head);
      const tbody = el("tbody");
      for (const r of c.rows) {
        const tr = el("tr");
        c.columns.forEach((col, k) => tr.append(el("td", num[k] ? "lpc-num" : "", exNumber(r[k], col.format))));
        tbody.append(tr);
      }
      tbl.append(el("caption", "", c.total > c.rows.length ? tx("rows", c.rows.length, c.total) : c.rows.length === 1 ? tx("oneRow") : tx("allRows", c.rows.length)), thead, tbody);
      wrap.append(tbl);
      return wrap;
    }
    const exWhen = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? String(iso) : d.toLocaleString(uiLang() === "auto" ? undefined : uiLang(), { dateStyle: "medium", timeStyle: "short" });
    };
    /** The expander for one answer: collapsed, one level, each data call in the order made. */
    function explainNode(ex) {
      const box = el("div", "lpc-ex");
      const btn = el("button", "lpc-ex-btn", tx("toggle"));
      btn.type = "button";
      btn.setAttribute("aria-expanded", "false");
      const body = el("div", "lpc-ex-body");
      body.id = `lpc-ex-${opts.board}-${++exSeq}`;
      body.hidden = true;
      btn.setAttribute("aria-controls", body.id);
      btn.onclick = () => {
        const open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        body.hidden = !open;
      };
      if (ex.selections && ex.selections.length) {
        const f = el("p", "lpc-ex-tag lpc-ex-filters", `${tx("filters")}: `);
        f.append(document.createTextNode(ex.selections.map((x) => `${x.label} = ${x.value} (${x.applied ? tx("applied") : tx("notApplied")})`).join("; ")));
        body.append(f);
      }
      (ex.calls || []).forEach((c, i) => {
        const sec = el("section", "lpc-ex-call");
        sec.setAttribute("aria-label", tx("call", i + 1));
        const p = el("p", "lpc-ex-desc");
        p.append(el("span", "lpc-ex-n", String(i + 1)), document.createTextNode(c.description || ""));
        sec.append(p);
        if (c.saved && c.saved.asOf) sec.append(el("p", "lpc-ex-tag", tx("saved", exWhen(c.saved.asOf))));
        const cached = (c.statements || []).find((s) => s.cachedAt);
        if (cached && !c.saved) sec.append(el("p", "lpc-ex-tag", tx("cached", exWhen(cached.cachedAt))));
        for (const s of c.statements || []) sec.append(exStatement(s));
        if (c.after) sec.append(el("p", "lpc-ex-tag", c.after));
        sec.append(exTable(c));
        body.append(sec);
      });
      if (ex.more) body.append(el("p", "lpc-ex-tag", tx("more", ex.more)));
      box.append(btn, body);
      return box;
    }
    /** The viewer's dashboard filters, from the host page (opts.selections: () => {field: value}), sent as turn context. */
    function selectionsNow() {
      try {
        const picked = typeof opts.selections === "function" ? opts.selections() : null;
        return picked && typeof picked === "object" && Object.keys(picked).length ? { selections: picked } : {};
      } catch {
        return {};
      }
    }
    /** Shows an answer's explanation under it: the one just streamed (kept for reloads), or the one kept for it. */
    function showExplain(id, ex) {
      if (ex) exStore(id, ex);
      const shown = ex || exStore(id);
      if (!shown || feat.explain === false || !shown.calls || !shown.calls.length) return;
      log.append(explainNode(shown));
      scroll();
    }
    // The suggested questions in the panel's language: `examples` is a list, or lists by language
    // ({en: [...], fr: [...]}), English standing in for a language the deployment didn't write.
    function examplesNow() {
      const ex = opts.examples;
      if (Array.isArray(ex)) return ex;
      if (!ex || typeof ex !== "object") return [];
      return ex[uiLang()] || ex.en || Object.values(ex)[0] || [];
    }
    // A reply served from a saved answer says so, with when its data was read, and offers to ask afresh.
    function savedLine(r, question) {
      const d = el("div", "lpc-saved");
      d.title = t("savedTitle");
      d.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
      const when = new Date(r.dataAsOf);
      const lang = uiLang() === "auto" ? undefined : uiLang();
      const today = when.toDateString() === new Date().toDateString();
      const at = isNaN(when) ? "" : today ? when.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) : when.toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      d.append(el("span", "", r.kind === "edit" ? t("savedEdit") : t("savedAnswer", at)));
      if (question) {
        const b = el("button", "lpc-undo", t("askFresh"));
        b.type = "button";
        b.title = t("askFreshTitle");
        b.onclick = () => {
          if (busy || offline) return;
          b.disabled = true;
          send(question, true);
        };
        d.append(b);
      }
      return d;
    }
    // The queue was full: a friendly line, Try again, and the suggestion chips, which saved answers answer at once.
    function busyLine(question, userB) {
      const d = el("div", "lpc-note");
      d.append(el("span", "", t("busyFull") + " "));
      const again = el("button", "lpc-undo", t("retry"));
      again.type = "button";
      again.onclick = () => {
        if (busy || offline) return;
        d.remove();
        userB.remove();
        send(question);
      };
      d.append(again);
      const chips = el("div", "lpc-chips");
      fetch(`${base}/suggestions?lang=${encodeURIComponent(uiLang())}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => {
          for (const q of ((r && r.suggestions) || []).slice(0, 4)) {
            const c = el("button", "lpc-chip", q);
            c.onclick = () => {
              if (busy || offline) return;
              d.remove();
              userB.remove();
              send(q);
            };
            chips.append(c);
          }
          if (chips.children.length) d.append(chips);
        })
        .catch(() => {});
      return d;
    }
    function empty() {
      if (history.length) return;
      const e = el("div", "lpc-empty");
      e.append(el("p", "", t("intro")));
      const chips = el("div", "lpc-chips");
      const chip = (q, first) => {
        const c = el("button", "lpc-chip", q);
        c.disabled = offline;
        c.onclick = () => send(q);
        if (first) chips.prepend(c);
        else chips.append(c);
      };
      const shown = examplesNow();
      for (const q of shown) chip(q);
      e.append(chips);
      log.append(e);
      // The questions asked most on this board (by people with your access) come first: one click answers from the saved answer.
      fetch(`${base}/suggestions?lang=${encodeURIComponent(uiLang())}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => {
          const seen = new Set(shown.map((q) => q.trim().toLowerCase()));
          const top = ((r && r.suggestions) || []).filter((q) => typeof q === "string" && !seen.has(q.trim().toLowerCase())).slice(0, 4);
          if (!top.length || !chips.isConnected) return;
          for (const q of top.reverse()) chip(q, true);
          while (chips.children.length > 6) chips.lastChild.remove();
        })
        .catch(() => {});
    }
    const replay = () => {
      history.forEach((m, i) => {
        bubble(m.role, m.parts.map((p) => p.text || "").join(""));
        if (m.role === "assistant") showExplain(m.id);
        if (m.metadata && m.metadata.cost) log.append(costLine(m.metadata.cost));
        const asked = history[i - 1];
        if (m.metadata && m.metadata.reuse) log.append(savedLine(m.metadata.reuse, asked && asked.role === "user" ? asked.parts.map((p) => p.text || "").join("") : ""));
      });
    };
    replay();
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
    // The server's notice when no data of this dashboard is open to this user; the input stays off while it holds.
    let noAccess = null;
    // ---- Lenspack restarting: the overlay notices (its health check fails) and calls setOffline(true); the
    // banner shows, input waits, and everything comes back by itself when Lenspack answers again.
    function setOffline(on) {
      on = !!on;
      if (on === offline) return;
      offline = on;
      downBar.textContent = t("restarting");
      downBar.hidden = !on;
      input.disabled = on || !!noAccess;
      go.disabled = on || busy || !!noAccess;
      for (const b of retries) b.disabled = on;
      log.querySelectorAll(".lpc-chip").forEach((c) => (c.disabled = on));
      if (on) mic.disabled = true;
      else {
        mic.disabled = !window.isSecureContext || !canRecord;
        loadInfo();
      }
    }
    // A clarifying question's readings, as buttons under the reply: one tap sends that reading as the next message,
    // naming the question it answers so the server counts the choice.
    function quickReplies(q) {
      if (!q || !Array.isArray(q.options) || !q.options.length) return;
      const box = el("div", "lpc-quick");
      box.setAttribute("role", "group");
      for (const o of q.options) {
        const b = el("button", "lpc-chip", o.label);
        b.type = "button";
        b.title = o.text;
        b.disabled = offline;
        b.onclick = () => {
          if (busy || offline) return;
          box.remove();
          send(o.text, false, { quickReply: { question: q.question || "", option: o.label } });
        };
        box.append(b);
      }
      log.append(box);
      scroll();
    }
    // fresh: "Ask fresh" on a saved answer; the full assistant answers, whatever is saved. extra.quickReply: the reading picked.
    async function send(text, fresh, extra) {
      text = (text || "").trim();
      if (!text || busy || offline) return;
      busy = true;
      syncNew();
      go.disabled = true;
      input.value = "";
      const emptyEl = log.querySelector(".lpc-empty");
      if (emptyEl) emptyEl.remove();
      log.querySelectorAll(".lpc-quick").forEach((q) => q.remove());
      history.push({ id: `u${Date.now()}`, role: "user", parts: [{ type: "text", text }] });
      persist();
      const userB = bubble("user", text);
      status.textContent = t("working");
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
        if (bot) bot.replaceChildren(replyNode(answer));
        scroll();
      };
      // With the reviewer off, the store writes to Superset inside the edit tool, so by the time a
      // tool's output arrives the board version has moved: say "saved" then. With it on, a turn's
      // edits are saved once the reviewer has checked them, at the end of the turn.
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
        if (opts.reloadsPage) note(t("savedLater"), "sync");
        else {
          note(t("savedRefreshing"), "sync");
          if (opts.onChanged) opts.onChanged();
        }
      };
      try {
        const spoken = clips.slice();
        const res = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history, language: pickedLang(), ...(typeof since === "number" ? { since } : {}), ...(spoken.length ? { speech: spoken } : {}), ...selectionsNow(), ...(fresh ? { fresh: true } : {}), ...(extra && extra.quickReply && extra.quickReply.question ? { quickReply: extra.quickReply } : {}) }) });
        if (!res.ok || !res.body) {
          let msg = `${res.status}`;
          try {
            msg = (await res.json()).error || msg;
          } catch (e) {}
          throw Object.assign(new Error(msg), { status: res.status });
        }
        // The stream ends with a finish event and [DONE]; a stream that stops short was cut (Lenspack restarted).
        let finished = false;
        let usage = null;
        let clarify = null;
        let reused = null;
        let full = null;
        let explained = null;
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
              if (data === "[DONE]") finished = true;
              if (!data || data === "[DONE]") continue;
              let ev;
              try {
                ev = JSON.parse(data);
              } catch (e) {
                continue;
              }
              switch (ev.type) {
                case "text-delta":
                  // A new text part straight after another (no tool call between) continues the
                  // same reply: the server's own closing lines, a note after the model's answer.
                  if (bot && ev.id && textId && ev.id !== textId && answer.trim()) answer += "\n\n";
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
                  status.textContent = t("reviewing");
                  break;
                case "error":
                  note(ev.errorText || t("wrong"), "bad");
                  break;
                case "data-usage":
                  if (ev.data && ev.data.summary) usage = ev.data.summary;
                  break;
                case "data-clarify":
                  clarify = ev.data;
                  break;
                case "data-queue":
                  // Waiting for a place: the place and about how long; the queue full: said below, with the suggestions.
                  if (ev.data && ev.data.state === "waiting") status.textContent = ev.data.reason === "edit" ? t("waitEdit") : t("busyWait", ev.data.etaSeconds, ev.data.position);
                  else if (ev.data && ev.data.state === "full") full = ev.data;
                  break;
                case "data-reuse":
                  if (ev.data && ev.data.tier) reused = { tier: ev.data.tier, kind: ev.data.kind, dataAsOf: ev.data.dataAsOf };
                  break;
                case "data-answer-card":
                  explained = ev.data;
                  break;
                case "finish":
                  finished = true;
                  break;
              }
            }
          }
        }
        if (frame) cancelAnimationFrame(frame);
        paint();
        if (!finished) throw Object.assign(new Error("stream cut"), { lost: true });
        if (full) {
          // Too busy: the question leaves the history, and the suggestions (answered at once, from saved answers) stay clickable.
          history.pop();
          persist();
          status.textContent = "";
          log.append(busyLine(text, userB));
          scroll();
          return;
        }
        // The reply is the text after the last tool call; when the model wrote nothing
        // after it, fall back to its last narration so the turn is not empty.
        const reply = answer.trim() ? answer : segments[segments.length - 1] || "";
        const metadata = { ...(usage ? { cost: usage } : {}), ...(reused ? { reuse: reused } : {}) };
        history.push({ id: `a${Date.now()}`, role: "assistant", parts: [{ type: "text", text: reply || t("noAnswer") }], ...(usage || reused ? { metadata } : {}) });
        if (explained) showExplain(history[history.length - 1].id, explained);
        // The clips were counted in this turn (the server claims each once).
        clips.splice(0, spoken.length);
        quickReplies(clarify);
        if (usage) {
          log.append(costLine(usage));
          spent.usd = Math.round((spent.usd + (usage.costUsd || 0)) * 1e6) / 1e6;
          spent.turns += 1;
          renderMenu();
          scroll();
        }
        if (reused) {
          log.append(savedLine(reused, text));
          scroll();
        }
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
              sessionStorage.setItem(key, JSON.stringify({ messages: history.slice(-30), since, notice: t("saved") }));
            } catch (e) {}
            if (opts.onChanged) opts.onChanged();
          } else if (after !== null && after > savedAt && opts.onChanged) opts.onChanged();
        } else if (before !== null && after !== null && after > before) {
          const msg = t("savedRefreshing");
          // The page is about to reload: say so again once it is back.
          if (opts.reloadsPage)
            try {
              sessionStorage.setItem(key, JSON.stringify({ messages: history.slice(-30), since, notice: t("saved") }));
            } catch (e) {}
          note(msg, "sync");
          if (opts.onChanged) setTimeout(() => opts.onChanged(), 600);
        }
      } catch (e) {
        status.textContent = "";
        // Lost: the request never reached Lenspack, or its answer was cut off (a restart, a proxy's 502–504).
        const lost = e.lost || e.name === "TypeError" || [502, 503, 504].includes(e.status);
        // The question leaves the history; Retry asks it again (and the overlay checks whether Lenspack is back).
        const last = history[history.length - 1];
        if (last && last.role === "user") history.pop();
        persist();
        const n = el("div", "lpc-note bad", lost ? t("lost") : t("unreachable", e.message));
        const again = el("button", "lpc-undo", t("retry"));
        again.type = "button";
        again.disabled = offline;
        again.onclick = () => {
          if (busy || offline) return;
          retries.delete(again);
          n.remove();
          userB.remove();
          send(text);
        };
        retries.add(again);
        n.append(again);
        log.append(n);
        scroll();
        if (lost && opts.onUnreachable) opts.onUnreachable();
      } finally {
        busy = false;
        syncNew();
        go.disabled = offline || !!noAccess;
        if (!offline) input.focus();
      }
    }

    // ---- New chat. The model starts over but still hears of edits made after this point (since =
    // the board's version now). An Undo note brings the conversation back for a few seconds.
    let clearing = 0;
    function syncNew() {
      newBtn.disabled = busy || rec.state !== "idle";
    }
    async function newChat() {
      if (busy || rec.state !== "idle") return;
      const token = ++clearing;
      const kept = { messages: history.splice(0), since };
      log.replaceChildren();
      setStatus("");
      empty();
      persist();
      const n = el("div", "lpc-note sync", t("cleared"));
      const undo = el("button", "lpc-undo", t("undo"));
      undo.type = "button";
      n.append(undo);
      log.append(n);
      const gone = setTimeout(() => n.remove(), 5000);
      undo.onclick = () => {
        clearTimeout(gone);
        clearing++;
        if (history.length || busy) return n.remove();
        history.push(...kept.messages);
        since = kept.since;
        persist();
        log.replaceChildren();
        replay();
        empty();
        input.focus();
      };
      try {
        const v = await version();
        if (token === clearing && !history.length) {
          since = v;
          persist();
        }
      } catch (e) {}
    }
    newBtn.onclick = newChat;

    // Words that change with the language pick.
    function relabel() {
      ttlB.textContent = t("title");
      by.textContent = own().poweredBy || "";
      by.hidden = !brand.poweredBy || !own().poweredBy;
      // The deployment's icon (an image's address, never markup), else the name's letter ("L" until the brand is heard).
      const shownIcon = mark.querySelector("img");
      if (brand.icon && (!shownIcon || shownIcon.getAttribute("src") !== brand.icon)) {
        const img = el("img");
        img.alt = "";
        img.src = brand.icon;
        mark.replaceChildren(img);
      } else if (!brand.icon) mark.textContent = own().mark || (own().name ? "?" : "L");
      mark.classList.toggle("lpc-icon", !!brand.icon);
      if (!opts.title) ttlS.textContent = t("sub");
      input.placeholder = t("placeholder");
      go.textContent = t("send");
      const shown = log.querySelector(".lpc-empty");
      if (shown) {
        shown.remove();
        empty();
      }
      micTitle();
      downBar.textContent = t("restarting");
      for (const b of retries) b.textContent = t("retry");
      newBtn.title = t("newChatHelp");
      newBtn.setAttribute("aria-label", t("newChat"));
      renderMenu();
    }

    // ---- Voice: click the mic to start and again to stop, or hold it (or Space) while speaking.
    // The clip goes to this server's /api/_stt, and the text lands in the input to check before sending.
    const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    function micTitle() {
      mic.title = !window.isSecureContext ? t("micNeedsHttps") : !canRecord ? t("micUnsupported") : t("mic");
      mic.setAttribute("aria-label", mic.title);
    }
    const rec = { recorder: null, stream: null, chunks: [], started: 0, timer: 0, raf: 0, held: false, audio: null, cancelled: false, caret: 0 };
    // The mic's state also decides whether New chat is allowed.
    let recState = "idle";
    Object.defineProperty(rec, "state", { get: () => recState, set: (v) => ((recState = v), syncNew()) });
    /** Puts the transcript into the input at a caret position, with a space either side where words would touch. */
    function insertAt(text, at) {
      const v = input.value;
      const pos = Math.max(0, Math.min(v.length, at == null ? v.length : at));
      const before = v.slice(0, pos);
      const after = v.slice(pos);
      const pre = before && !/\s$/.test(before) ? " " : "";
      const post = after && !/^\s/.test(after) ? " " : "";
      input.value = before + pre + text + post + after;
      const caret = (before + pre + text).length;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(caret, caret);
    }
    const meter = el("span", "lpc-meter");
    const meterBar = el("i");
    meter.append(meterBar);
    function setStatus(text, recording) {
      status.replaceChildren();
      if (!text) return;
      if (recording) status.append(el("span", "lpc-rec", "●"), document.createTextNode(text), meter);
      else status.append(document.createTextNode(text));
    }
    const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    function mimeType() {
      for (const m of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"]) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
      return "";
    }
    async function startRec() {
      if (rec.state !== "idle" || busy || !micState.enabled) return;
      if (!window.isSecureContext || !canRecord) return note(mic.title, "bad");
      rec.state = "starting";
      rec.cancelled = false;
      // Where the words go: the input's caret now (the end of a selection), so typed text is kept.
      rec.caret = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      try {
        rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        rec.state = "idle";
        return note(e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? t("denied") : e && e.name === "NotFoundError" ? t("noMic") : t("sttFailed", e.message || e.name), "bad");
      }
      // A release (or a second click) that came while the browser asked for permission ends it at once.
      if (rec.state !== "starting") return stopTracks();
      const type = mimeType();
      rec.recorder = new MediaRecorder(rec.stream, type ? { mimeType: type } : undefined);
      rec.chunks = [];
      rec.recorder.ondataavailable = (e) => e.data && e.data.size && rec.chunks.push(e.data);
      rec.recorder.onstop = finish;
      rec.recorder.start(250);
      rec.started = Date.now();
      rec.state = "recording";
      mic.classList.add("rec");
      mic.innerHTML = STOP_SVG;
      // Level meter: cheap RMS from an analyser; skipped where AudioContext is missing.
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        rec.audio = new Ctx();
        const an = rec.audio.createAnalyser();
        an.fftSize = 512;
        rec.audio.createMediaStreamSource(rec.stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += (v - 128) * (v - 128);
          meterBar.style.width = `${Math.min(100, Math.sqrt(sum / buf.length) * 2.5)}%`;
          rec.raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {}
      const show = () => setStatus(t("listening", clock(Date.now() - rec.started)), true);
      show();
      rec.timer = setInterval(() => {
        show();
        if (Date.now() - rec.started >= micState.maxSeconds * 1000) stopRec();
      }, 250);
    }
    function stopTracks() {
      clearInterval(rec.timer);
      cancelAnimationFrame(rec.raf);
      if (rec.audio) rec.audio.close().catch(() => {});
      rec.audio = null;
      if (rec.stream) rec.stream.getTracks().forEach((tr) => tr.stop());
      rec.stream = null;
      mic.classList.remove("rec");
      mic.innerHTML = MIC_SVG;
      meterBar.style.width = "0";
    }
    function stopRec(cancel) {
      if (rec.state === "starting") {
        rec.state = "idle";
        return;
      }
      if (rec.state !== "recording") return;
      rec.cancelled = !!cancel;
      rec.state = "stopping";
      try {
        rec.recorder.stop();
      } catch (e) {
        finish();
      }
    }
    async function finish() {
      const ms = Date.now() - rec.started;
      stopTracks();
      const type = (rec.recorder && rec.recorder.mimeType) || "audio/webm";
      const blob = new Blob(rec.chunks, { type });
      rec.recorder = null;
      rec.chunks = [];
      if (rec.cancelled) {
        rec.state = "idle";
        return setStatus("");
      }
      if (ms < 400 || blob.size < 800) {
        rec.state = "idle";
        return setStatus(t("tooShort"));
      }
      rec.state = "sending";
      mic.classList.add("wait");
      mic.disabled = true;
      setStatus(t("transcribing"));
      try {
        const l = pickedLang();
        const q = new URLSearchParams({ pack: opts.pack });
        if (l && l !== "auto") q.set("language", l);
        else {
          // No hint: the server checks the words came back in one of the panel's languages, and
          // otherwise tries once more as the panel's own language.
          q.set("expected", LANGS.map(([c]) => c).filter((c) => c !== "auto").join(","));
          q.set("fallback", uiLang());
        }
        const r = await fetch(`${api}/api/_stt?${q}`, { method: "POST", headers: { "content-type": type.split(";")[0] }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (r.status === 422) {
          setStatus("");
          return note(j.error === "wrong_script" ? t("missedIn", (NAMES_IN[uiLang()] || NAMES_IN.en)[j.language] || j.language) : t("unsureLang"), "bad");
        }
        if (!r.ok) throw new Error(r.status === 503 ? t("sttOff") : j.error || String(r.status));
        const text = (j.text || "").trim();
        if (text && typeof j.clip === "string") clips.push(j.clip);
        if (!text) setStatus(t("nothingHeard"));
        else {
          insertAt(text, rec.caret);
          setStatus(t("heard"));
        }
      } catch (e) {
        setStatus("");
        note(t("sttFailed", e.message), "bad");
      } finally {
        rec.state = "idle";
        mic.classList.remove("wait");
        mic.disabled = false;
      }
    }
    // One button, two ways: a quick click toggles; pressing past 300 ms is push-to-talk, ended by the release.
    let pressAt = 0;
    mic.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || mic.disabled) return;
      e.preventDefault();
      mic.setPointerCapture && mic.setPointerCapture(e.pointerId);
      if (rec.state === "recording" || rec.state === "starting") {
        pressAt = 0;
        return stopRec();
      }
      pressAt = Date.now();
      startRec();
    });
    const release = () => {
      if (pressAt && Date.now() - pressAt > 300) stopRec();
      pressAt = 0;
    };
    mic.addEventListener("pointerup", release);
    mic.addEventListener("pointercancel", release);
    mic.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) (rec.state === "recording" || rec.state === "starting" ? stopRec() : startRec());
      }
    });
    // Hold Space to talk: a press held past holdMs (2 s unless changed) starts the mic, even while
    // typing in this panel, and the release stops it. A shorter press types one space, as Space
    // would. Superset's own fields, buttons and other controls keep Space to themselves.
    const typing = (n) => !!n && (n.isContentEditable || /^(TEXTAREA|SELECT)$/.test(n.tagName) || (n.tagName === "INPUT" && /^(text|search|email|url|tel|password|number|)$/i.test(n.type || "")) || n.getAttribute("role") === "textbox" || !!n.closest(".ace_editor, .CodeMirror, .monaco-editor, [contenteditable]"));
    const control = (n) => !!n && n !== document.body && (/^(BUTTON|SELECT|SUMMARY|A)$/.test(n.tagName) || (n.tagName === "INPUT" && !typing(n)) || /^(button|checkbox|radio|switch|tab|menuitem|menuitemradio|option|slider)$/.test(n.getAttribute("role") || ""));
    const visible = () => wrap.isConnected && wrap.getClientRects().length > 0;
    const textField = (n) => (typing(n) && wrap.contains(n) && typeof n.setRangeText === "function" ? n : null);
    // A press in progress: where it started, and the timer that turns it into talking.
    let press = null;
    function clearPress() {
      if (!press) return;
      clearTimeout(press.timer);
      cancelAnimationFrame(press.raf);
      mic.classList.remove("hold");
      mic.style.removeProperty("--lpc-hold");
      if (status.textContent === t("keepHolding")) setStatus("");
      press = null;
    }
    /** The short press: one space at the caret, replacing a selection, as the key itself would. */
    function typeSpace() {
      const f = press && press.field;
      clearPress();
      if (!f || !f.isConnected) return;
      f.setRangeText(" ", f.selectionStart, f.selectionEnd, "end");
      f.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: " " }));
    }
    const onKeyDown = (e) => {
      if (e.code === "Escape" && rec.state === "recording") return stopRec(true);
      // Another key while Space is down (fast typing rolls over): the space goes in first, in order.
      if (press && e.code !== "Space") return typeSpace();
      if (e.code !== "Space") return;
      // Auto-repeat of a press we own: swallowed, so no spaces pile up while it's held.
      if (e.repeat) {
        if (press || rec.held) e.preventDefault();
        return;
      }
      const a = document.activeElement;
      if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (!micState.enabled || mic.disabled || feat.spaceHold === false || prefsNow.space === false || !visible() || rec.state !== "idle") return;
      if (control(a) || (typing(a) && !wrap.contains(a))) return;
      e.preventDefault();
      const ms = holdMs();
      press = { at: performance.now(), ms, field: textField(a), timer: 0, raf: 0 };
      mic.classList.add("hold");
      const fill = () => {
        if (!press) return;
        const p = Math.min(1, (performance.now() - press.at) / press.ms);
        mic.style.setProperty("--lpc-hold", `${Math.round(p * 100)}%`);
        // A short tap shouldn't flash text; say what's coming once the press is clearly deliberate.
        if (p > 0.25 && !status.textContent) setStatus(t("keepHolding"));
        press.raf = requestAnimationFrame(fill);
      };
      fill();
      press.timer = setTimeout(() => {
        clearPress();
        rec.held = true;
        startRec();
      }, ms);
    };
    const onKeyUp = (e) => {
      if (e.code !== "Space") return;
      if (press) {
        e.preventDefault();
        return typeSpace();
      }
      if (rec.held) {
        e.preventDefault();
        rec.held = false;
        stopRec();
      }
    };
    listen(document, "keydown", onKeyDown, true);
    listen(document, "keyup", onKeyUp, true);
    listen(window, "blur", () => {
      clearPress();
      if (rec.held) {
        rec.held = false;
        stopRec();
      }
    });
    cleanups.push(() => {
      rec.cancelled = true;
      if (rec.state === "recording") stopRec(true);
      else stopTracks();
    });

    // A pick made in another tab (or another panel) applies here too, instead of this panel's stale copy.
    listen(window, "storage", (e) => {
      if (e.key !== PREFS) return;
      prefsNow = prefs();
      relabel();
    });

    // What the server offers: speech on or off, and the deployment's default language.
    function applyInfo(info) {
      if (info && info.features && typeof info.features === "object") feat = info.features;
      if (info && info.brand && typeof info.brand === "object") brand = info.brand;
      if (info && info.language && info.language.default) adminLang = info.language.default;
      micState.enabled = !!(info && info.speech && info.speech.enabled) && feat.voice !== false;
      lang.hidden = feat.languageMenu === false;
      newBtn.hidden = feat.newChat === false;
      wrap.classList.toggle("lpc-nocost", feat.turnCost === false);
      if (info && info.speech && info.speech.maxSeconds) micState.maxSeconds = info.speech.maxSeconds;
      if (info && info.speech && info.speech.holdMs >= 500 && info.speech.holdMs <= 3000) micState.holdMs = info.speech.holdMs;
      mic.hidden = !micState.enabled;
      mic.disabled = !window.isSecureContext || !canRecord;
      relabel();
    }
    function loadInfo() {
      fetch(`${api}/_superset/info`)
        .then((r) => (r.ok ? r.json() : null))
        .then((info) => info && applyInfo(info))
        .catch(() => {});
    }
    if (opts.speech || opts.language) applyInfo({ speech: opts.speech, language: opts.language, features: opts.features, brand: opts.brand });
    else {
      relabel();
      loadInfo();
    }
    // Nothing of this dashboard's data is open to this user in Superset: say so now, before anything is asked,
    // and keep the input off (the server refuses the chat as well).
    fetch(base)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b || !b.accessNotice) return;
        noAccess = b.accessNotice;
        log.querySelectorAll(".lpc-empty").forEach((e) => e.remove());
        note(noAccess, "lpc-access");
        input.disabled = true;
        go.disabled = true;
        mic.disabled = true;
      })
      .catch(() => {});

    go.onclick = () => send(input.value);
    // Enter sends, Shift+Enter starts a new line. The key is taken on the window, before the page sees it: a
    // listener of the host page (or a browser extension) on the document or body that stops or cancels Enter
    // would otherwise keep it from the box, and the button would be the only way to send. The Enter that ends
    // an input method's composition (accents, predictive text, CJK and Indic keyboards) only ends it.
    let shift = false;
    let sawEnter = false;
    const composing = (e) => e.isComposing || e.keyCode === 229;
    listen(window, "keydown", (e) => {
      shift = e.shiftKey;
      sawEnter = e.target === input && e.key === "Enter";
      if (!sawEnter || e.shiftKey || composing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      send(input.value);
    }, true);
    listen(window, "keyup", (e) => { shift = e.shiftKey; }, true);
    // And if the key never reached the window's listener (another listener there stopped it first), the line
    // break it is about to type is the sign: send instead.
    input.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "insertLineBreak") return;
      if (sawEnter) {
        sawEnter = false;
        return;
      }
      if (shift || e.isComposing) return;
      e.preventDefault();
      send(input.value);
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    });
    return { send, focus: () => input.focus(), setOffline };
  }

  window.LenspackChat = { mount, markdown };
})();
