# Contextual ontologies: a scoping proposal

This page proposes how Lenspack could keep shared meaning (what words mean, how things nest, what they are called
in each language, and which reading of an ambiguous term holds where) in one place that admins edit from
Lenspack's admin panel and that other systems can feed. It also looks at which systems are worth an adapter, and at
one in depth: DIGIT's localisation service. Nothing here is built yet.

The worked example throughout is a health campaign on DIGIT HCM. Every figure about campaign data on this page is
made up. The localisation key counts come from our own HCM demo instance, which holds demo configuration, not
campaign data.

Effort: **small** is up to a week of one person's time, **medium** two to three weeks, **large** more than that.

## In short

- **A pack binds keys to data; an ontology says what they mean.** The pack stays the only thing the model can
  query. The ontology never adds a key. It gives keys and values their labels, synonyms, definitions and readings,
  per language and per context, and it is shared across packs and deployments instead of copied into each.
- **It grows out of the definitions overlay.** The overlay and its open-questions log, which the admin panel is
  gaining now (`docs/review.md` will describe them), are the first, flat version: one deployment, one key at a time.
  The ontology adds concepts that several keys and packs bind to, hierarchies, languages, and context.
- **The format is a small SKOS-like subset in YAML**, with a handful of Lenspack additions: readings and their status,
  bindings to pack keys, context, and provenance. Large lists of values (thousands of place names) live beside it
  as value sets, not inside it.
- **The model sees a slice, never the whole thing.** The concepts bound to the pack's keys fold into the catalogue it
  already reads. Per question, only the concepts and values the question mentions are added, within a fixed budget.
- **Adapters feed it, admins have the last word.** An adapter pulls labels and structure from another system with
  filters, keeps where each label came from, and syncs only what changed. An admin's edit is never overwritten by a
  sync; an upstream change to an edited field becomes an item in the review queue.
- **The localisation adapter is worth building first.** Our demo instance holds 122,762 localisation messages
  (98,226 in English, 24,106 in Portuguese, 430 in French) across 89 modules. A deployment needs a small part of
  that: about 1,300 labels for a one-region campaign whose boundaries stop at health facility level, or about
  12,700 if it goes down to settlements. The filter is the deployment's languages, an allow-list of modules, and
  above all the values that actually occur in the deployment's data.
- **Phase 1** (medium): the ontology file and package, the overlay turned into concepts, the localisation adapter
  for dimension-value labels, labels in `list_values` and filters, and a browse-and-edit admin page. Phases 2 and 3
  add the other DIGIT adapters, context-dependent labels, relations, units and sharing across deployments.

## 1. What a contextual ontology is for Lenspack

### Pack and ontology, side by side

A **pack** describes one dataset so that a model can query it by name: entities, dimensions, measures, joins,
hierarchies, and the SQL or Superset metric behind each key ([pack-spec.md](pack-spec.md)). It is a binding to
data. Two deployments of the same product over different warehouses have two packs, and the same idea can sit
under different keys in each: `children_vaccinated` in one, `doses_administered` in another.

An **ontology** describes the domain those packs are about: the concepts, how they relate, what they are called,
and what they mean. It is shared meaning. It says that "dose administered" is a kind of delivery event, that it is
called *dose administrée* in French, that "vaccinated" is a common way to ask for it, that in a polio campaign the
success outcome reads "vaccination success" while in a spraying campaign it reads "sprayed", and that "children
vaccinated" has two defensible readings, one of which this deployment has confirmed.

| | pack | ontology |
|---|---|---|
| answers | which column or metric a key reads, and how it aggregates | what the key means, what people call it, how it relates to others |
| scope | one dataset in one deployment | a domain, shared by packs and deployments, with context saying where each meaning holds |
| who writes it | a person, reviewed in git, or derived from Superset's catalogue | admins in the panel, adapters from other systems, imports |
| what the model does with it | names its keys; nothing else can be queried | reads labels, synonyms, definitions and readings; resolves people's words to keys and values |
| changes | rarely; keys are a contract boards are built on | often; a new label or a settled definition needs no new pack version |

Today the meaning is spread across several places, each tied to one pack or one deployment:

- the pack's `label`, `hint` and `synonyms` on each key, and its `instructions` (2,000 characters, sent every turn);
- the Superset overlay in a deployment's config (`labels`, `hints`, `hierarchies`, `instructions`, `examples`);
- the definitions overlay and its open questions, edited in the admin panel;
- outside Lenspack: a register of ambiguous terms kept for the evals, and the labels already maintained in DIGIT
  (localisation, MDMS), which Lenspack does not read.

Two Superset deployments of the same campaign data today each restate "a dose is counted once per child, revisits
included" in their own instructions, and each declares a `boundary` hierarchy with its own level keys. The ontology
is where such a statement is written once and bound to each pack's keys.

**The guarantee that stays.** The ontology cannot make anything queryable. A concept that no pack key binds to is
something the model can explain, not something it can chart. Labels and value mappings only ever resolve to keys and
values the pack and its source already have.

### What it holds, on the health-campaign example

**Concepts.** The things people ask about, independent of any table:

| concept | broader | notes |
|---|---|---|
| campaign | | one run of a programme in an area and period; has a campaign type |
| campaign type | | SMC, polio, bednet distribution, indoor spraying, and so on; the main context for meaning |
| household | | registered once, visited many times |
| individual | | a person in a household register |
| beneficiary | individual or household | who a campaign delivers to; an individual in a polio campaign, a household in a bednet one |
| visit | delivery event | a health worker's visit to a household or person, whatever its outcome |
| dose delivered | delivery event | handed over (for example a blister pack left with a caregiver) |
| dose administered | delivery event | given and observed (swallowed, injected, sprayed) |
| zero-dose child | individual | a child who had never had a dose before this campaign |
| facility | place | health facility, warehouse or store |
| store level | | where stock sits in the supply chain: national, state, LGA, facility, team |
| stock transaction | | stock received, issued, returned, lost or damaged, between two places |
| coverage | indicator | doses or people reached over a target |

**Hierarchies.** Two kinds, and each is a context-dependent shape, not a fixed list:

- **Administrative areas:** state > LGA > ward > settlement in one country; province > district > administrative
  post > locality > village in another. Same concept ("administrative area"), different levels and level names.
  HCM's boundary service already holds these per hierarchy type.
- **Supply chain:** national store > state store > LGA store > health facility > team. Stock flows down it and
  returns up it.

**Labels per language.** A preferred label and alternative labels in each language the deployment speaks: *dose
administered*, *dose administrée*, *dose administrada*; alternatives *vaccinated*, *doses given*, *treated*. This
covers concepts, hierarchy levels ("LGA", *zone de gouvernement local*) and the values of dimensions (an outcome code
`BENEFICIARY_REFUSED`, a boundary code standing for a ward).

**Definitions with readings.** Some terms have more than one defensible meaning in the data, and the readings give
different numbers. "Children vaccinated" might be every vaccinated child including revisits (made-up figure: 1,240),
or only visits whose outcome was a success (1,212). The open-questions flow already records these: each term lists
its readings, a status (*open*: nothing says which; *stated*: the config picks one, not yet confirmed; *settled*:
confirmed, or the readings agree), and the question for the people who own the data. In the ontology a reading is
part of the concept, and the chosen one is what the model states in one clause when it answers.

**Units.** Doses, vials, tablets, nets, households, people; percentages; per day. Some conversions are contextual:
doses per vial depends on the product (a made-up 10-dose and 20-dose presentation), so a wastage figure needs the
product in context.

**Relations.** A small, fixed set, enough to say what the data cannot:

- a dose is *administered at* a facility or settlement and *administered by* a team;
- a household *has member* individuals; a beneficiary is *registered in* a household;
- stock *flows from* one store level *to* the next;
- a measure *is a reading of* a concept ("this key counts doses administered, revisits included").

**Context.** The part that makes it contextual. A label, a definition, a reading or a hierarchy holds for a context:

| context | example |
|---|---|
| global | "household" means the same everywhere |
| country | the administrative levels and their names |
| programme or campaign type | the success outcome is "sprayed" for indoor spraying, "vaccination success" for polio |
| deployment | this deployment confirmed reading A of "children vaccinated" |
| campaign | this campaign targets children 3 to 59 months; its products are these |
| language | the label to use when the person writes in French |

DIGIT's own configuration already works this way, which is the strongest argument for context. On our demo
instance the same status code reads differently by campaign type: `ADMINISTRATION_SUCCESS` is "Administration
success" in most modules, "Vaccination Success" in the polio modules and "Delivery success" in the bednet ones, and a
prefixed key `IRS_ADMINISTRATION_SUCCESS` reads "Sprayed". `DELIVERED` reads "Administered" in one module and
"Visited" in another. `CLOSED_HOUSEHOLD` reads "Closed household" in 37 modules and "Missed Children" in 3. A flat
code-to-label map would pick one at random; an ontology with context picks the one for this deployment's campaign
type.

**Which context wins.** The most specific one that matches, in this order: campaign, deployment, campaign type,
country, global. Two statements at the same level that disagree are a conflict, shown in the admin panel until an
admin picks one.

## 2. The format

### A SKOS-like subset, in YAML

SKOS (the W3C's Simple Knowledge Organisation System) is the common standard for vocabularies like this: concepts,
preferred and alternative labels per language, broader and narrower, definitions and notes, and matches to concepts
in other vocabularies. Lenspack would use a small subset of it with SKOS's meaning, and add what SKOS has no field
for. Using SKOS's terms keeps the door open to exchange (export to SKOS for other tools, import a published
vocabulary) without making Lenspack depend on RDF.

| ours | SKOS | meaning |
|---|---|---|
| `scheme` | `skos:ConceptScheme` | a vocabulary or hierarchy: "delivery", "administrative areas", "supply chain" |
| `id` | `skos:Concept` (its IRI) | a stable slug, unique in the ontology |
| `label` | `skos:prefLabel` | one per language |
| `alt` | `skos:altLabel` | other names per language: synonyms, abbreviations, common misspellings |
| `definition` | `skos:definition` | one per language |
| `note` | `skos:scopeNote` | how to use it, what it excludes |
| `broader`, `narrower` | `skos:broader`, `skos:narrower` | one is written, the other derived |
| `related` | `skos:related` | related without nesting |
| `match` | `skos:exactMatch`, `skos:closeMatch` | the same thing in another system: a localisation code, an MDMS code |
| `levels` | (none) | the ordered levels of a hierarchy scheme |
| `readings` | (none) | competing definitions, each with a status and the chosen one |
| `context` | (none) | where a label, definition or reading holds |
| `bind` | (none) | which pack keys and values this concept is |
| `unit`, `relations` | (none) | the unit a concept is counted in; typed links from the fixed list above |
| `source` | (none) | provenance, on every statement an adapter wrote |

### An example

```yaml
ontology: health_campaigns
version: 7                       # bumped on each published change; every edit is also a revision
languages: [en, fr, pt]

schemes:
  delivery: { label: { en: Delivery, fr: Distribution } }
  admin_area:
    label: { en: Administrative area, fr: Zone administrative }
    levels:                      # one shape per context; the most specific matching one applies
      - context: { country: XA }
        is: [state, lga, ward, settlement]
      - context: { country: XB }
        is: [province, district, administrative_post, locality, village]
  supply_chain:
    label: { en: Supply chain }
    levels: [{ is: [national_store, state_store, lga_store, facility, team] }]

concepts:
  - id: dose_administered
    scheme: delivery
    broader: [delivery_event]
    related: [dose_delivered]
    unit: dose
    label: { en: Dose administered, fr: Dose administrée, pt: Dose administrada }
    alt: { en: [vaccinated, doses given, treated], fr: [vaccinés] }
    definition: { en: A dose a health worker gave and saw taken, recorded as a success. }
    relations: [{ administered_at: facility }, { administered_by: team }]
    readings:
      term: { en: children vaccinated }
      status: stated             # open | stated | settled
      chosen: incl_revisits
      options:
        - id: incl_revisits
          en: every vaccinated child, revisits included
        - id: success_outcome
          en: visits whose outcome was a success
      question: { en: Which count do you report as children vaccinated? }
    bind:
      - { pack: campaign_registry, measure: doses_administered }
      - { pack: campaign_warehouse, measure: children_vaccinated, reading: incl_revisits }

  - id: outcome_success
    scheme: delivery
    match: [{ localisation: ADMINISTRATION_SUCCESS }]
    label:
      en: Administration success
      fr: Administration réussie
    contextual:                  # overrides for narrower contexts
      - { context: { campaign_type: POLIO }, label: { en: Vaccination success } }
      - { context: { campaign_type: IRS }, label: { en: Sprayed } }
    bind:
      - { pack: campaign_registry, dimension: outcome, value: ADMINISTRATION_SUCCESS }
    source: { adapter: localisation, ref: "en_MZ/hcm-beneficiary/ADMINISTRATION_SUCCESS", at: 2026-11-26 }

value_sets:
  - id: boundary_names           # too many to list here: kept in their own file
    scheme: admin_area
    file: value-sets/boundary_names.jsonl
    bind: [{ pack: campaign_warehouse, dimensions: [state, lga, ward, health_facility, settlement] }]
```

A **value set** is a large list of values with labels, such as thousands of boundary codes and their names. It is
stored as one JSON line per value (`{"value": "ADMIN_XA_01_02", "label": {"en": "Example Ward"}, "level": "ward",
"parent": "ADMIN_XA_01", "source": …}`) so that YAML stays readable and a sync can rewrite it cheaply.

The schema is checked at load the way a pack is (zod, every problem listed): ids unique, every `broader`, `related`
and `bind` target exists, at most one `label` per language and context, `chosen` names one of the `options`,
bound pack keys exist in the pack named (checked when that pack loads, since the ontology may be shared with packs
this server does not have).

### Versions

- **Every edit is a revision**, kept with who made it and why, like board versions. Any revision can be viewed and
  restored.
- **A published version** is a numbered snapshot. A deployment follows the latest published version or pins one.
  Drafts are visible in the admin panel only.
- **Export is YAML** (plus the value-set files), so an ontology can be reviewed in git, diffed, and carried to
  another server. Import takes the same files.
- **Packs are untouched by ontology versions.** A pack records nothing about the ontology; the binding lives in the
  ontology. Boards do not change when a label does. A binding to a key the pack no longer has is reported, not fatal.

### How it merges with a pack

At load, and again on each ontology change, Lenspack resolves the pack against the ontology for the deployment's
context:

1. find the concepts bound to each pack key, and the value sets bound to each dimension;
2. pick, for each statement, the one from the most specific matching context;
3. fill the key's `label`, `synonyms` and `hint` where the pack leaves them empty, and add the chosen reading's
   clause to the hint ("counts every vaccinated child, revisits included");
4. attach value labels to dimensions, for `list_values`, filters and replies.

Precedence for each field, highest first:

1. the pack file's own text for its own key (it is the most specific context there is: this exact binding);
2. an admin's edit in the ontology;
3. an adapter's statement, by an order the admin sets per adapter (for example MDMS above localisation above
   Superset);
4. an imported vocabulary.

Synonyms are added together rather than replaced, minus any an admin removed. Whether an admin edit should beat the
pack file's own label is an open decision below; the order above keeps the pack's reviewed text in charge.

### What the model sees

The ontology could be large: a few hundred concepts and tens of thousands of value labels. None of it is sent whole.

- **Always, at no extra cost:** what step 3 above folds into the catalogue (labels, synonyms, a hint with the chosen
  reading). This sits in the stable part of the prompt that is already cached.
- **Per question, within a budget:** the words of the question are matched (any language, accents and case ignored)
  against the labels and alternative labels of concepts and values in context. The matches add a short block: each
  matched concept's definition and readings, and each matched value as `"Example Ward" → ward = ADMIN_XA_01_02`.
  The block is capped (a starting point: 40 lines or about 1,500 tokens), most specific matches first, and goes in
  the part of the prompt after the cache breakpoint.
- **On demand:** a `lookup_term` tool, or a `q` on `list_metrics` that also searches concepts, for what the slice
  left out. `list_values` returns each value's label in the person's language beside the stored value.
- **Filters take labels.** When the model sets a filter to a label, the server maps it to the stored value through
  the value set, exactly, so the model never has to guess a code.

## 3. The admin panel

The admin panel is gaining the definitions overlay and the open-questions log now. The ontology pages grow from
those, behind the same sign-in and roles.

| page | what it does |
|---|---|
| **Concepts** | A tree per scheme and a search box that matches labels in any language. Filters: status (open, stated, settled), source (admin, an adapter, import), context, bound or unbound. |
| **Concept** | Labels as a grid of language by context; definition, notes and readings with the chosen one; bindings to pack keys with a check that they still exist; relations; each field shows where it came from and when; history with restore. |
| **Review queue** | Proposals waiting for a decision: from the daily review of chat turns (a term the model had to guess, a synonym people used that matched nothing), from the open-questions log, and from adapters (an upstream label changed on a field an admin edited). Accept, edit then accept, or reject with a reason. |
| **Conflicts** | Two statements at the same context that disagree (two adapters, or an adapter and an import), and bindings to keys a pack no longer has. |
| **Sources** | One row per adapter: last sync, how many statements, what the filters kept and dropped, coverage (share of the data's values that found a label), errors; run now; edit filters. |
| **Import and export** | YAML and value-set files out and in; CSV in for labels and synonyms; later SKOS out. An import shows a diff and goes through the review queue. |
| **Permissions** | Viewer (read), editor (draft edits), approver (publish, settle readings), per scheme if needed. Adapter-written fields are read-only until an editor takes them over, which turns them into admin edits. |

**The smallest useful first version** is four things:

1. browse and search concepts, which at first are the overlay's entries turned into concepts and the pack keys they
   bind to, plus the values the localisation adapter labelled;
2. edit labels, synonyms and the definition, and pick or settle a reading on an open question;
3. one Sources row for the localisation adapter, with run now and its counts;
4. export to YAML.

No relations editor, no hierarchy editor (hierarchies come from the pack and, later, the boundary adapter), no
conflicts page (one adapter cannot conflict with itself) and no SKOS in the first version.

## 4. Adapters

### The interface

An adapter reads another system and returns statements: "this subject has this label in this language, in this
context, and here is where I read it".

```ts
type Statement = {
  subject: { concept: string } | { valueSet: string; value: string } | { scheme: string; level: string };
  field: "label" | "alt" | "definition" | "note" | "broader" | "level" | "match";
  lang?: string;                       // BCP 47, e.g. "fr"
  context?: Record<string, string>;    // e.g. { campaign_type: "IRS" }
  text: string;
  source: { adapter: string; ref: string; fetchedAt: string; hash: string };  // ref: where exactly, e.g. "en_MZ/hcm-common/MALE"
};

type OntologyAdapter<Config> = {
  kind: string;                                          // "digit-localisation", "digit-mdms", "csv", …
  config: z.ZodType<Config>;                             // checked at startup; secrets as env:NAME
  // What a sync would cover, without writing anything: for the Sources page and for tuning filters.
  plan(cfg: Config, ctx: SyncContext): Promise<{ units: string[]; estimate?: number }>;
  // One unit at a time (a locale and module, an MDMS schema, a file); each can be skipped when unchanged.
  pull(cfg: Config, unit: string, ctx: SyncContext): AsyncIterable<Statement>;
};

type SyncContext = {
  context: Record<string, string>;     // the deployment's: country, campaign types, languages
  values: (dimension: string) => Promise<string[]>;   // distinct values in the bound packs' data, for filters
  lastHash?: (unit: string) => string | undefined;     // what the previous sync saw
  signal: AbortSignal;
};
```

Adapters are registered the way chat-model adapters are ([llm.md](llm.md#adding-an-adapter)), and configured in
`lenspack.yaml` with a schedule:

```yaml
ontology:
  file: ./ontology/health_campaigns.yaml
  context: { country: XA, campaign_type: SMC, languages: [en, fr] }
  adapters:
    - kind: digit-localisation
      url: env:DIGIT_URL
      tenant: mz
      schedule: daily 02:00          # or "manual"
      precedence: 20                 # higher wins among adapters
      filters: { … }                 # see section 5
```

What the sync engine does around every adapter:

- **Incremental.** Each unit's content hash is kept. An unchanged unit is skipped; a changed one is diffed statement
  by statement, so only real changes are written and reviewed.
- **Deletes are soft.** A statement missing from upstream is marked gone after two syncs in a row, not at once, so a
  half-loaded upstream does not wipe labels.
- **Provenance on everything.** Each statement keeps its adapter, its exact reference upstream and when it was read,
  and the Concept page shows it.
- **Admin edits are never overwritten.** If upstream changes a field an admin edited, the change goes to the review
  queue as "upstream now says …".
- **Read-only upstream.** Adapters only ever call search or read endpoints.
- **No personal data.** Value-referenced filters read distinct values of dimensions typed as codes, enums or places,
  never free text, names, phone numbers or ids of people; the pack's `access` rules on hidden keys apply to the sync
  too.

### Candidates

| adapter | what it would give | value | effort | verdict |
|---|---|---|---|---|
| **DIGIT localisation** | labels per language for codes and places: outcome and reason codes, boundary names, level names, campaign type names; dashboard calculation notes as draft definitions | high: multilingual labels, value resolution, voice vocabulary | medium: no paging, big and inconsistent data, needs filters (section 5) | **phase 1** |
| **DIGIT MDMS** (v2 `/mdms-v2/v2/_search`) | the code lists themselves: project types (with cycles, eligibility ages, products), boundary hierarchy types, facility types, refusal, referral and ineligibility reasons, product types, the deployment's languages (`common-masters.StateInfo`) | high: the codes localisation labels, and the campaign context | small to medium: schema-coded JSON, paged with `limit` and `offset`; needs a token | phase 2 |
| **Boundary service** (`/boundary-service/boundary-hierarchy-definition/_search`, `…/boundary-relationships/_search`) | hierarchy levels and the parent of every boundary, per hierarchy type | high for hierarchies; names still come from localisation | small: one tree per hierarchy (1.9 s for about 900 boundaries on our instance) | phase 2, with MDMS |
| **HCM project and campaign config** (project service, project-factory campaign search) | campaign context: type, dates, the boundaries in scope, products and doses, target age bands | medium to high: sets context and narrows the value filter | medium: auth, and the shapes vary between HCM releases | phase 2 |
| **CSV** | labels, synonyms, definitions from a sheet a programme team keeps | high for bootstrapping, any domain | small | phase 1 if cheap, else 2 |
| **SKOS or OWL import** | a published vocabulary | low today: no shared health-campaign vocabulary is in use; clinical ones (ICD, SNOMED) are out of scope | medium: RDF parsing, mapping a large model to a small one | export in phase 3; import only on demand |
| **Superset** (dataset and column `verbose_name`, `description`, metric descriptions) | labels and descriptions people already wrote | medium: Lenspack already reads these into the pack; the adapter would make them shared concepts with provenance | small: the reading code exists in `packages/hosts/superset` | phase 3 |
| **ClickHouse or dbt comments** (`system.columns.comment`, dbt `manifest.json` descriptions) | descriptions from the data pipeline | medium, where the pipeline writes them | small | phase 3, if the pipeline has comments |

## 5. The DIGIT localisation adapter

### The API

- **Endpoint:** `POST /localization/messages/v1/_search` (the `egov-localization` service, behind the gateway).
- **Parameters, in the query string:**
  - `locale` (required; a missing one answers 400), for example `en_MZ`;
  - `tenantId`, the state-level tenant, for example `mz`; a city tenant (`mz.city`) gets the state's messages merged
    with its own;
  - `module`, optional, one module or several separated by commas; absent, every module for the locale;
  - `codes`, optional, codes separated by commas.
- **Body:** `{ "RequestInfo": { "apiId": "Rainmaker" } }`. The criteria do not go in the body.
- **Answer:** `{ "messages": [ { "code", "message", "module", "locale" } ] }`.
- **Paging:** none. `limit` and `offset` are ignored and the whole answer comes back at once: every English message
  on our instance is one 12.6 MB answer in 4.6 seconds. Fetching one module at a time keeps answers small.
- **Auth:** on our instance, as in DIGIT's usual gateway setup, search needs no token, because the UI loads
  labels before anyone signs in. The adapter should still accept a token (DIGIT's password grant at
  `/user/oauth/token`) for deployments that close it.
- **Which locales exist:** not a localisation endpoint; MDMS `common-masters.StateInfo` lists the deployment's
  languages (on our instance: `en_MZ`, `pt_MZ`, `fr_MZ`).
- **Writes** (`_upsert`, `_create`, `_delete`) exist; the adapter never calls them.

### What a running instance holds

Counted on our HCM demo instance on 2026-11-26 with read-only searches, and checked against its database table.
Its localisation was copied from DIGIT's public HCM demo, so the content is DIGIT's standard HCM configuration, not
a campaign's.

| locale | messages | distinct codes | modules |
|---|---:|---:|---:|
| `en_MZ` | 98,226 | 59,433 | 77 |
| `pt_MZ` | 24,106 | 18,821 | 17 |
| `fr_MZ` | 430 | 429 | 12 |
| **all** | **122,762** | | 89 |

By kind of module:

| kind | modules (examples) | en | pt | fr | useful for Lenspack |
|---|---|---:|---:|---:|---|
| boundary names | `hcm-boundary-admin` (20,616), `hcm-boundary-microplan` (8,210) | 28,826 | 0 | 0 | yes, filtered to the data's places |
| field app form templates, one copy per campaign type | `hcm-base-registration-mr-dn`, `hcm-base-inventory-oncho`, … | 36,621 | 0 | 0 | only to resolve outcome and reason codes by campaign type |
| copies of those for one campaign | `hcm-registration-CMP-…` | 2,730 | 0 | 0 | as above, for that campaign |
| dashboards | `rainmaker-hcm-dss`, `hcm-dss`, `hcm-dashboard` | 10,271 | 11,494 | 0 | indicator names; 371 `DSS_CALCULATION_*` notes as draft definitions |
| shared field app and common | `hcm-common`, `rainmaker-hcm-common`, `hcm-beneficiary`, `hcm-stock`, … | 2,561 | 12,568 | 395 | yes: outcome, reason, gender, stock codes |
| upload template columns | `hcm-admin-schemas` | 6,865 | 0 | 0 | only `<HIERARCHY>_<LEVEL>` level names (148 keys) |
| console and platform screens | `digit-ui`, `hcm-campaignmanager`, `hcm-appconfiguration`, `hcm-workbench`, … | 10,352 | 44 | 35 | campaign type names only (`CAMPAIGN_PROJECT_<TYPE>`) |

What the data is like, which shapes the adapter:

- **The same code, different words.** 1,572 English codes have more than one text across modules. Some differences
  are capitals only; many are the campaign-type differences described in section 1, which are exactly what context
  is for.
- **Prefixed variants.** Besides the 43 exact outcome, reason, gender, level and stock codes we looked for, there are
  476 distinct prefixed keys for the same values (`IRS_ADMINISTRATION_SUCCESS`, `REGISTRATION_ADMINISTRATION_SUCCESS`,
  `HCM_SEARCH_FILTER_…`). The prefix often names the campaign type or the screen.
- **Untidy codes.** 1,428 English and 2,074 Portuguese codes have leading or trailing spaces; codes are trimmed
  before matching.
- **Gaps between languages.** Portuguese covers the dashboards and common screens but none of the boundary modules
  and only 3 of the 43 exact codes (`MALE`, `FEMALE`, `OTHER`); French covers 430 messages. The adapter reports these
  gaps, and the admin panel is where they get filled.
- **Localisation and data must come from the same instance.** On our instance the boundary keys do not match its own
  boundary table (6 of the 9,553 boundaries in its main hierarchy have a key), because the messages were copied from
  another instance. A coverage figure on the Sources page (share of the data's values that found a label) catches
  this at once.

### Filtering: from 122,762 to what the deployment uses

The filters run in this order, each cheap:

1. **Locales:** only the deployment's languages, from the config or from MDMS `StateInfo`.
2. **Module allow-list:** a default list per kind, editable: the boundary module for the hierarchy the deployment
   uses (`hcm-boundary-<hierarchy>`), the shared field app and common modules, the dashboard modules (for
   definitions, phase 2), and the form-template modules only for the campaign types in context
   (`hcm-base-*-<type>`). Everything else (console screens, upload templates, payments, attendance, sign-in) is left
   out by default.
3. **Values that occur in the data:** the strongest filter. The adapter asks the bound packs for the distinct values
   of each code-, enum- or place-typed dimension (boundary codes, outcome and reason codes, product variant ids,
   project types, facility ids and types), adds the codes from MDMS code lists when that adapter is on, and keeps
   only messages whose trimmed code is one of them, or matches a pattern below around one of them. For allow-listed
   modules it is cheaper to fetch the module whole and filter locally (the 20,616-key boundary module is 2.5 MB in
   1.3 seconds) than to send thousands of `codes`.
4. **Prefix patterns** turn keys into statements, configurable as patterns:

   | key pattern | becomes |
   |---|---|
   | `<VALUE>` | the value's label |
   | `<CAMPAIGN_TYPE>_<VALUE>` | the value's label in that campaign type's context |
   | `<HIERARCHY>_<LEVEL>` | a hierarchy level's label |
   | `CAMPAIGN_PROJECT_<TYPE>`, or a project type code itself | the campaign type's name |
   | `DSS_CALCULATION_*` | a draft definition, to the review queue (phase 2) |

   Among several texts for one code in one context, a module order decides (for example `hcm-common` before
   `hcm-beneficiary` before form templates); the others become alternative labels.
5. **Changed since:** the API has no "changed since" parameter, so the adapter keeps a hash per locale and module and
   per message, refetches only the allow-listed modules on schedule (small once filtered), and diffs locally.

**What it comes to**, on our instance's numbers, for a deployment speaking English, French and Portuguese:

| step | messages kept |
|---|---:|
| everything | 122,762 |
| the deployment's three locales | 122,762 |
| allow-listed modules (boundary, shared and common, dashboards) | about 57,900 |
| values in the data, one region's campaign, boundaries to health facility level | about 1,200 boundary labels + about 100 code labels, level names and campaign type names |
| the same, boundaries down to settlements | about 12,500 boundary labels + about 100 others |

So roughly **1,300 labels** (to facility level) or **12,700** (to settlements), against 122,762. The boundary
figures come from the structure of the boundary module (one of its two top-level regions holds 1,205 keys down to
health facility level and 11,311 below that). The code labels are the 43 exact codes found, collapsed to one label
per code, language and campaign type. Boundary names are the same in every language, so they are stored once, not
once per locale. Dashboard calculation notes add 371 draft definitions in phase 2.

### Mapping keys onto labels

- **Values of dimensions.** Each code-typed dimension gets a value set: stored value → label per language, with
  alternative labels from the other texts. When the data already stores names rather than codes (some pipelines
  join localisation before the data reaches Superset), the adapter builds the map the other way round, name → code,
  so the same place is one value whatever form a source or a person uses.
- **Concepts and hierarchy levels.** Level names (`<HIERARCHY>_<LEVEL>`) label the levels of the pack's hierarchy;
  campaign type names label the context; outcome and reason codes label the values bound to concepts like
  `outcome_success`.
- **Multilingual answers.** A reply in French can say *refus du bénéficiaire* instead of `BENEFICIARY_REFUSED`, chart
  titles and suggested questions can use the deployment's own words, and a person can filter by a translated name.
  Where a language has no label, the stored value is shown as it is and the gap is listed on the Sources page; there
  is no machine translation in the first version.
- **Voice.** Place names are the words speech-to-text gets wrong most often. The value labels give two things:
  - a **vocabulary hint**: the few hundred most frequent place names and terms in context, passed to the transcription
    model where its API takes a prompt or a list of words to favour (to be checked for the model and provider in use);
  - a **correction after transcription** that works with any provider: a word close to a known place name is
    offered as that name (the person still checks the text before sending, as now).

## 6. A phased plan

### Phase 1: labels from localisation, and the overlay as concepts (medium, about 2 to 3 weeks)

- An ontology package in the kernel: the schema above minus relations and units, loading and checks, revisions in
  the state directory, YAML and value-set export. It knows no domain, like the rest of the kernel (the zero-domain
  check applies); the DIGIT adapters live in their own package beside `packages/packs/dss`.
- The definitions overlay and open questions read as concepts: each entry becomes a concept bound to its key, each
  open question becomes the concept's readings with their status. The overlay keeps working as it does; the panel
  edits the concept underneath.
- The localisation adapter: locales, module allow-list, values in the data, the exact and campaign-type patterns,
  hashing; run on demand and daily.
- Resolution into the pack (labels, synonyms, hints with the chosen reading); value labels in `list_values`; filters
  that accept a label; the per-question slice with its budget.
- Admin panel: Concepts and Concept pages (browse, search, edit labels, synonyms, definition, readings), one Sources
  row, export.
- Checks: an eval question or two in French and Portuguese that name a place or an outcome by its label, run without
  paid models first (resolution is deterministic and testable on its own).

### Phase 2: DIGIT structure and context (medium, about 3 weeks)

- MDMS, boundary service and campaign config adapters; hierarchies as schemes bound to the pack's hierarchies.
- Context-dependent labels and readings (campaign type, country), with the specificity rule and the Conflicts page.
- Review queue fed by the daily review, the open-questions log and upstream changes; permissions by role.
- Scheduled syncs for all adapters; coverage and gap reports.
- Draft definitions from dashboard calculation notes; the speech vocabulary hint and post-transcription correction.
- CSV import if not done in phase 1.

### Phase 3: relations, units and sharing (large, 4 weeks or more)

- Relations (administered at, flows to) and units with contextual conversions (doses per vial by product) that the
  compute step and the reviewer can use to catch a wrong ratio.
- A shared base ontology for health campaigns, published from the Lenspack repository and versioned, that each
  deployment follows and overrides.
- SKOS export (and import on demand); Superset and ClickHouse or dbt adapters.
- Readings checked by the evals: each reading's value computed, so a settled definition is tested like a measure.

### Risks

- **Two sources disagree, quietly.** Localisation copied from another instance, or a pipeline that already turned
  codes into names, gives labels that do not match the data. The coverage figure must be visible, and a low one
  must warn.
- **Upstream is untidy.** Conflicting texts and prefixed variants mean a code-to-label map is a set of choices. The
  module order and context rules must be explicit, and an admin must be able to override any of them.
- **Prompt growth.** Without the budget the slice would grow with every label added. The cap and the "most specific
  first" order are part of phase 1, not an afterthought.
- **Meaning leaking into querying.** Nothing in the ontology may make a key queryable or change what a key computes.
  Readings change what the model *says*, not the SQL. A reading that needs a different number needs a pack key.
- **Personal data.** Value filters read distinct values; restricting them to code-, enum- and place-typed dimensions,
  and honouring the pack's hidden keys, keeps names and identifiers out.
- **Big value sets.** Settlement-level boundaries run to tens of thousands per country. Storing them as line files
  and matching them with an index, not in the prompt, keeps them cheap.
- **Scope creep.** A full ontology editor is a product of its own. The first version edits labels and readings only.

### Decisions for the owner

1. **Where the ontology lives:** in Lenspack's state directory, edited in the panel and exported to git (proposed),
   or in git first with the panel opening pull requests.
2. **Shared or per deployment:** one ontology per deployment, or a shared health-campaign base in the Lenspack
   repository that deployments override (proposed from phase 3; per deployment until then).
3. **Pack text versus admin edit:** does an admin's label or hint beat the one written in the pack file? Proposed:
   the pack file wins for its own keys, and the panel shows that the pack overrides the edit.
4. **The context dimensions:** a fixed set (country, campaign type, deployment, campaign, language), proposed, or
   free-form tags.
5. **Languages and gaps:** which languages a deployment counts, and whether machine translation may ever fill a gap
   (proposed: not in phase 1 or 2; gaps are shown and filled by people).
6. **Reading the data for filters:** the localisation adapter queries distinct values of code, enum and place
   dimensions. Acceptable as proposed, or only from an explicit list of dimensions?
7. **Writing back to DIGIT:** never (proposed), or later offer label fixes as a file the DIGIT admins load.
8. **Format:** the SKOS-like YAML subset (proposed), or full SKOS in JSON-LD from the start.
9. **Phase 1 scope:** include the CSV adapter in phase 1, or keep phase 1 to localisation alone.
