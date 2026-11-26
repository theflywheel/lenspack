# Changelog

What changed in Lenspack, newest first. Read the entries since your version before you upgrade; the steps are in
[Upgrading](docs/operating/upgrading.md).

**Versions.** The packages are at version `0.1.0`, and no version has been released since. Everything below is on the
main branch and not yet in a release; it will become the next version's notes. Each entry links the change that
brought it.

## Not yet released

### 26 November 2026

- **Personal dashboards and saved layouts in Superset.** Someone who can only view a dashboard can make their own
  copy and change it through the chat, or save a layout by name and apply it later. `editScope: own` limits chat
  edits to people's own dashboards. See [Personal dashboards](docs/features/personal-dashboards.md).
  ([#89](https://github.com/theflywheel/lenspack/pull/89))
- **Chat edits work on Superset dashboards with tabs.** New charts go on the tab the person is looking at, or the one
  they name, and the layout is checked before every save. ([#94](https://github.com/theflywheel/lenspack/pull/94))
- **Usage telemetry.** One record per chat turn, a thumbs up or down under answers, and a switch for each item
  recorded. Question text, recordings and device detail start off. See [Telemetry](docs/features/telemetry.md).
  ([#86](https://github.com/theflywheel/lenspack/pull/86))
- **Superset's dashboard roles count.** With `DASHBOARD_RBAC` on, a person who opens a dashboard through its roles
  reads its data through the chat too, on that dashboard only. ([#93](https://github.com/theflywheel/lenspack/pull/93))
- **The admin panel loads under Superset's Content-Security-Policy.**
  ([#92](https://github.com/theflywheel/lenspack/pull/92))
- **Each person's Superset access is the default** (`hostPolicy: superset`), with a test suite that runs real
  Superset 6.1 and 5.0 and checks what each kind of user sees. Upgrading from an older default needs a look: see
  [Upgrading in Superset](docs/hosts/superset/upgrading.md#changes-that-need-attention).
  ([#88](https://github.com/theflywheel/lenspack/pull/88))
- **The admin panel shows the cards on its Open questions and Proposals tabs.**
  ([#90](https://github.com/theflywheel/lenspack/pull/90))
- **Open questions, definitions, the daily review and the admin panel.** Questions with two readings are logged
  for an admin to settle, definitions are added without a pack release, and an optional daily review proposes
  changes. See [Open questions and definitions](docs/features/open-questions.md).
  ([#82](https://github.com/theflywheel/lenspack/pull/82))
- **Saved answers.** A repeated question is answered again on today's data without the model, only for someone
  with the same access, and busy hours get a queue. See [Saved answers](docs/features/saved-answers.md).
  ([#85](https://github.com/theflywheel/lenspack/pull/85))
- **How this was worked out.** Under each answer: each data call in plain words, the measure behind each figure, its
  SQL and its rows. See [How this was worked out](docs/features/explain.md).
  ([#81](https://github.com/theflywheel/lenspack/pull/81))
- **Evals:** an answer of "none of them" is scored ([#84](https://github.com/theflywheel/lenspack/pull/84),
  [#87](https://github.com/theflywheel/lenspack/pull/87)); runs can apply Superset's access and run as a given
  user ([#83](https://github.com/theflywheel/lenspack/pull/83)).

### 25 November 2026

- **A reviewed turn's edits are drafts until the turn ends**, in the chat panel and in the audit log, so nothing
  half-checked is saved. ([#78](https://github.com/theflywheel/lenspack/pull/78))
- **A bad dataset column no longer stops Lenspack starting in Superset.**
  ([#77](https://github.com/theflywheel/lenspack/pull/77))
- **Superset 6.1 is supported**, alongside 5.0. See [Versions](docs/hosts/superset/versions.md).
  ([#74](https://github.com/theflywheel/lenspack/pull/74))
- **Averages over time run over the measure's own days**, and the answer says which days; a fixed edit is reported
  once. ([#70](https://github.com/theflywheel/lenspack/pull/70))
- **Calendar-date columns group by day correctly in any time zone.**
  ([#66](https://github.com/theflywheel/lenspack/pull/66))
- **Evals:** suites run with the same reviewer as production and record its cost
  ([#67](https://github.com/theflywheel/lenspack/pull/67)); `--reviewer` and `--escalate` pick those models
  ([#69](https://github.com/theflywheel/lenspack/pull/69)); more ways of writing numbers are read
  ([#68](https://github.com/theflywheel/lenspack/pull/68), [#79](https://github.com/theflywheel/lenspack/pull/79)); a
  turn the database failed counts as an error ([#73](https://github.com/theflywheel/lenspack/pull/73)); question
  sets for the registry example data ([#72](https://github.com/theflywheel/lenspack/pull/72)); the speech-to-text
  benchmark runs from the repository ([#71](https://github.com/theflywheel/lenspack/pull/71)).

### 24 November 2026

- **Numbers:** a ratio keeps its empty days, one rule decides what may be added up, and a cut-off result says so.
  ([#65](https://github.com/theflywheel/lenspack/pull/65))
- **The model sees only what the person asking may see**, and a widget update can clear a field.
  ([#64](https://github.com/theflywheel/lenspack/pull/64))
- **`lenspack-mcp` is safer by default:** read-only data, no file access from SQL, and HTTP on this machine only
  unless a token is set. ([#62](https://github.com/theflywheel/lenspack/pull/62))
- **In Superset, a signed right only works on the dashboard it was signed for.**
  ([#63](https://github.com/theflywheel/lenspack/pull/63))
- **Edits are saved all together or not at all**, and a KPI's summary of a series is a compute step.
  ([#61](https://github.com/theflywheel/lenspack/pull/61))
- **The packages sit in folders by job** (kernel, sources, packs, hosts), and the pack loader `@lenspack/spec` is
  now `@lenspack/pack`. Code that imports it needs the new name: see
  [Upgrading](docs/operating/upgrading.md#code-using-the-packages).
  ([#60](https://github.com/theflywheel/lenspack/pull/60))
- **The Superset dashboard's own filter bar becomes board filters** the chat can read and change.
  ([#59](https://github.com/theflywheel/lenspack/pull/59))
- **A problem the reviewer finds is fixed, or the change is undone, before the reply.**
  ([#58](https://github.com/theflywheel/lenspack/pull/58))
- **The compute step:** rates, changes, rolling averages and averages per day over simple measures, worked out
  after the source answers ([#55](https://github.com/theflywheel/lenspack/pull/55)); summaries per group save as
  Superset pivot tables that agree with the chat ([#57](https://github.com/theflywheel/lenspack/pull/57)). See
  [The compute step](docs/features/compute.md).
- **One policy package decides access** for every host, and Superset's roles and row-level security go through it.
  ([#54](https://github.com/theflywheel/lenspack/pull/54), [#56](https://github.com/theflywheel/lenspack/pull/56))
- **Replies keep to the writing systems the person used or picked**, and Portuguese replies keep the data's own
  terms. ([#53](https://github.com/theflywheel/lenspack/pull/53), [#48](https://github.com/theflywheel/lenspack/pull/48))
- **One server runtime for the standalone server and Superset**, with the Superset plugin kept in this repository.
  ([#50](https://github.com/theflywheel/lenspack/pull/50), [#51](https://github.com/theflywheel/lenspack/pull/51))
- **The board tools are their own package**, and `lenspack-mcp` is only the MCP server; its built package exports
  the tools again. ([#45](https://github.com/theflywheel/lenspack/pull/45),
  [#52](https://github.com/theflywheel/lenspack/pull/52))
- **Portuguese in the Superset chat panel.** ([#39](https://github.com/theflywheel/lenspack/pull/39))
- **Sign-in for the standalone server:** a password by default, OIDC, roles, and pack access rules.
  See [Sign-in](docs/access/sign-in.md). ([#13](https://github.com/theflywheel/lenspack/pull/13))
- **Apache Superset as a host:** its datasets as the source, its dashboards as boards, and the chat on every
  dashboard. See [Apache Superset](docs/hosts/superset/README.md).
  ([#16](https://github.com/theflywheel/lenspack/pull/16))
- **Tables page and sort, text widgets take formatting, and replies carry their cost.**
  ([#36](https://github.com/theflywheel/lenspack/pull/36))
- **Cleanups with no change in behaviour:** shared helpers and dead code out across the kernel, the engine, the
  React components, the examples, the server and the importers; the demo is the app only.
  ([#40](https://github.com/theflywheel/lenspack/pull/40), [#41](https://github.com/theflywheel/lenspack/pull/41),
  [#42](https://github.com/theflywheel/lenspack/pull/42), [#43](https://github.com/theflywheel/lenspack/pull/43),
  [#44](https://github.com/theflywheel/lenspack/pull/44), [#46](https://github.com/theflywheel/lenspack/pull/46),
  [#47](https://github.com/theflywheel/lenspack/pull/47), [#49](https://github.com/theflywheel/lenspack/pull/49))

## 0.1.0 (22 September 2026)

The first version: the board as data, a closed query format, packs, the compiler for Postgres and DuckDB, and the
first example packs.
