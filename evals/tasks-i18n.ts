// The hcm tasks asked in other languages, to see whether the model maps a
// French or Hindi request onto the pack's English keys as well as an English
// one. "fr-spoken" is French as speech-to-text writes it: lower case, little
// punctuation, numbers in words. Checks stay the same; run.ts only loosens
// how numbers and refusals are read in the reply.

export const LANGS = ["en", "fr", "fr-spoken", "hi"] as const;
export type Lang = (typeof LANGS)[number];

export const hcmPrompts: Record<Exclude<Lang, "en">, Record<string, string>> = {
  fr: {
    "delivery-by-locality": "Affiche le taux de livraison des lignes de produits par localité en graphique à barres, du plus bas au plus haut.",
    "fanout-trap": "Ajoute un camembert du taux de réussite d'administration par variante de produit.",
    "epoch-window": "Trace les visites hebdomadaires par campagne sur les 10 dernières semaines, en courbe.",
    "duration-percentile": "Ajoute un KPI pour le P90 de la durée des visites en minutes sur les 30 derniers jours, et un graphique à barres de la durée médiane des visites par projet.",
    hierarchy: "Compare le taux de refus entre les campagnes en graphique à barres, puis ajoute un filtre sur la campagne qui s'applique à tout.",
    "question-worst-locality": "Quelle localité a le taux de réussite d'administration le plus bas parmi celles qui ont au moins 100 visites ? Donne le code de la localité, son taux et son nombre de visites.",
    "question-top-reason": "Quelle est la raison la plus fréquente pour laquelle une ligne de produit n'a pas été livrée, et combien de lignes cela représente-t-il ?",
    "unanswerable-radius": "Ajoute une carte des ménages situés à moins de 2 km de l'établissement FAC-7.",
    "two-dimensions": "Ajoute un graphique à barres empilées des visites par localité et par statut.",
    "soft-delete-count": "Combien de ménages sont enregistrés au total ? Réponds avec le nombre.",
  },
  "fr-spoken": {
    "delivery-by-locality": "montre le taux de livraison des lignes de produits par localité en barres du plus bas au plus haut",
    "fanout-trap": "ajoute un camembert du taux de réussite d'administration par variante de produit",
    "epoch-window": "trace les visites par semaine par campagne sur les dix dernières semaines en courbe",
    "duration-percentile": "ajoute un kpi pour le p quatre-vingt-dix de la durée des visites en minutes sur les trente derniers jours et un graphique en barres de la durée médiane des visites par projet",
    hierarchy: "compare le taux de refus entre les campagnes en barres puis ajoute un filtre campagne qui s'applique à tout",
    "question-worst-locality": "quelle localité a le plus faible taux de réussite d'administration parmi celles qui ont au moins cent visites donne le code son taux et son nombre de visites",
    "question-top-reason": "quelle est la raison la plus courante pour laquelle une ligne de produit n'a pas été livrée et ça fait combien de lignes",
    "unanswerable-radius": "ajoute une carte des ménages à moins de deux kilomètres de l'établissement fac sept",
    "two-dimensions": "ajoute un graphique en barres empilées des visites par localité et par statut",
    "soft-delete-count": "combien de ménages sont enregistrés au total réponds avec le nombre",
  },
  hi: {
    "delivery-by-locality": "प्रोडक्ट लाइनों की डिलीवरी दर को इलाके के हिसाब से बार चार्ट में दिखाओ, सबसे कम वाला पहले।",
    "fanout-trap": "प्रोडक्ट वेरिएंट के हिसाब से एडमिनिस्ट्रेशन सफलता दर का पाई चार्ट जोड़ो।",
    "epoch-window": "पिछले 10 हफ़्तों की साप्ताहिक विज़िट्स को कैंपेन के हिसाब से अलग-अलग लाइन चार्ट में दिखाओ।",
    "duration-percentile": "पिछले 30 दिनों में विज़िट की अवधि (मिनट में) के P90 का एक KPI जोड़ो, और प्रोजेक्ट के हिसाब से विज़िट की औसत (मीडियन) अवधि का बार चार्ट भी।",
    hierarchy: "कैंपेन के बीच इनकार दर की तुलना बार चार्ट में करो, फिर कैंपेन पर एक फ़िल्टर जोड़ो जो हर चीज़ पर लागू हो।",
    "question-worst-locality": "कम से कम 100 विज़िट वाले इलाकों में से किस इलाके की एडमिनिस्ट्रेशन सफलता दर सबसे कम है? इलाके का कोड, उसकी दर और विज़िट की संख्या बताओ।",
    "question-top-reason": "प्रोडक्ट लाइन डिलीवर न होने का सबसे आम कारण क्या है, और ऐसी कितनी लाइनें हैं?",
    "unanswerable-radius": "फ़ैसिलिटी FAC-7 से 2 किलोमीटर के अंदर वाले घरों का नक्शा जोड़ो।",
    "two-dimensions": "इलाके और स्टेटस के हिसाब से विज़िट्स का स्टैक्ड बार चार्ट जोड़ो।",
    "soft-delete-count": "कुल कितने घर रजिस्टर्ड हैं? सिर्फ़ संख्या बताओ।",
  },
};

/** Ways a reply may write a number in another language, read back as the English checks expect. */
export function replyVariants(reply: string): string[] {
  const ascii = reply.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
  const noGroup = ascii.replace(/(\d)[\s  ](?=\d{3}\b)/g, "$1"); // 12 345 (fr thousands)
  const dotDecimal = noGroup.replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2"); // 12,3 % → 12.3
  // A refusal in French or Hindi, read as the English "cannot" the checks look for.
  const refused = /impossible|ne (peux|peut|permet|sais|prend|gère|supporte)|pas (possible|disponible|de carte|pris en charge)|n'est pas|n'existe pas|une seule dimension|नहीं|संभव|केवल एक|सिर्फ़ एक/i.test(reply) ? " cannot one dimension" : "";
  return [reply, ascii, noGroup, dotDecimal, ascii + refused];
}
