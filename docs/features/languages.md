# Languages

This page describes which languages Lenspack speaks, how the reply language is chosen, and how board titles stay
in one language. It is for admins and pack authors writing for readers in more than one language.

## Replies in the reader's language

On every host, the assistant replies in the language the person wrote or spoke in. Nothing needs setting up for
this.

## The chat panel's languages

The chat panel inside Superset has a language menu: **Auto**, **English**, **Français**, **हिन्दी** and
**Português**, remembered per browser. The panel's own words (its button, menu and grip) and the suggested
questions follow the pick.

- **Auto** sends no language hint (the model detects it), and the reply follows whatever language the person used.
- **A picked language** is the speech hint, the reply language and the panel's own words.
- **Without a pick**, the panel follows Superset's language when one was chosen there (Superset's default,
  English, does not count), else the deployment's default. A locale counts by its first two letters, so Superset's
  `pt` and `pt_BR` both give Portuguese.
- **Portuguese** is written once for both sides of the Atlantic: the panel's words and the reply instruction aim at
  Portuguese that reads naturally in Africa and Europe as well as in Brazil (noun forms where the two split their verb
  forms, words both use). Write example questions the same way.

The admin panel is in English and French.

## Offering only some languages

A deployment can offer fewer than the four: `language.offer: [en, fr, pt]` in `superset.yaml` (default: all four), or
`LENSPACK_LANGUAGES=en,fr,pt`, which wins over the file. An admin can change it on a running server
(`PUT /_superset/settings/language` with `offer`; `null` goes back to the deployment's value).

- The menu lists the offered languages, plus Auto.
- A pick saved earlier, or a Superset language, that is not offered is ignored, and `language.default` applies.
- The speech hint follows the same rule: it is never a language that is not offered.
- `language.default` (unless `auto`) and `language.board` must be offered. The server refuses to start otherwise,
  and a change at runtime is refused with a 400.

The offer only shapes the menu and the hint. Replies still follow the language the person actually writes or speaks
in, so someone who writes Hindi to a deployment that does not offer it is still answered in Hindi.

The `languageMenu` switch hides the picker; the deployment's default language then applies, and a pick saved
earlier is ignored.

## Board and widget titles

New board and widget titles are written in the board's language (`language.board`, English by default), whatever
language the person speaks, so a board does not end up with titles in three languages. With
`language.titles: speaker`, titles follow the reply's language instead.

## Suggested questions in several languages

A pack's example question may be written per language, with one query for all of them:

```yaml
overlay:
  examples:
    - question: { en: Orders by country, fr: Commandes par pays, pt: Encomendas por país }
      query: { kind: breakdown, dimension: country, measure: orders, limit: 10 }
```

The model sees the English wording (else the first) as a worked example; a language an example lacks shows its
English. `/_superset/info` returns `examplesByLang`, and `examples` for `?lang=` (English by default). The other
languages go into the pack as the example's `wordings`, so a chip clicked in any of them is answered by the same checked
query ([Saved answers](saved-answers.md#the-tiers-cheapest-first)).

## Settings

`language.default` (`auto`), `language.titles` (`board`), `language.board` (`en`) and `language.offer` (all four) in `superset.yaml` are
defaults; an admin can change them on a running server. See
[Settings and switches in Superset](../hosts/superset/settings.md#voice-and-language).

Saved answers are kept per language: a question asked in French is not answered with a reply saved in English.

---

**Next:** [Naming the assistant](naming.md).

**Related:** [Voice](voice.md) · [Answering questions](answering.md)
