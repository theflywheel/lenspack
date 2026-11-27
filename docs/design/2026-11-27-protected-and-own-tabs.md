# Protected tabs and tabs of one's own

Status: a scoping note, 2026-11-27, for review before anything is built. Nothing here is built yet.

This note scopes three abilities for Superset dashboards with tabs:

1. **Protected tabs.** A deployment marks some tabs of a dashboard as protected. The chat never changes them.
2. **Tabs of one's own.** The chat makes a new tab and puts a person's changes there, instead of changing tabs others
   rely on.
3. **Deleting a tab** through the chat, with clear limits on who may delete which tab.

## The problem

Whoever Superset lets edit a dashboard can change any part of it through the chat. Two things go wrong:

- **Official content gets changed.** A tab of agreed figures, the one a report is sent from, can be changed by anyone
  with edit rights through a casual request.
- **People undo each other's work.** Two editors add, resize and remove charts on the same tabs.

Superset has no per-tab permissions: access is per dashboard and per dataset. So protecting a tab has to be Lenspack's
own rule, and it binds only the chat. Someone editing in Superset itself is not stopped by it.

Today, `editScope: own` keeps the chat to each person's own copies. That protects shared dashboards completely, but a
copy is a separate dashboard with its own link, filters and reports. Since PR #94 the chat reads tabs, knows the
viewer's tab, adds charts to the right tab, resizes and removes in place, refuses moves, and checks the layout before
each save. It cannot make, rename or delete tabs.

## What each feature does, in examples

**Protected tabs.** An admin protects the "Official KPIs" tab.

- Asha, on that tab: "Add a chart of stock by ward here." Refused: "The Official KPIs tab is protected on this
  deployment, so the chat doesn't change it. I can put this chart on a tab of your own, or on another tab."
- "Make the KPI tiles smaller", or "Make the Region filter default to North" when that filter reaches the tab: refused,
  naming the tab.
- "What does the stock-out tile count?" Answered as usual. Protection limits changes, not questions.

**Tabs of one's own** (the `ownTabs` switch on).

- Ben: "Make me a tab and add a weekly trend of visits there." The chat makes "Ben: visits trend", puts the chart on it,
  and opens it.
- Ben, on his tab: "Add a filter by district." The filter applies to his tab only.
- Asha, on Ben's tab: "Remove this chart." Refused: only Ben and admins change it through the chat. She is offered a
  tab of her own.
- With `editScope: tab`, Ben on a shared tab: "Add a chart of visits by day." The chat offers to make his own tab with
  the chart on it, rather than changing the shared tab.

**Deleting a tab.**

- Ben: "Delete my visits tab." The chat says what goes with it ("two charts made through the chat; one chart made in
  Superset will be taken off this dashboard but kept") and deletes it after he confirms.
- Ben: "Delete the Stock tab" (shared). Refused: only admins delete a tab they didn't make through the chat.
- An admin: "Delete the Official KPIs tab." Refused: protected tabs aren't deleted through the chat. The admin lifts
  the protection on the settings page first.

## What "protected" covers

Nothing the chat does changes a protected tab. That covers:

- **the tab itself**: its title, its place among its sibling tabs, and its existence;
- **everything inside it**, nested tabs included: which charts and notes, their rows, order and sizes. Nothing is
  added, moved in or out, resized or removed;
- **every chart on it**: what it counts, its type, title and formatting, even when the same chart is also placed
  elsewhere;
- **what filters do to its charts**: a filter that reaches any chart on the tab isn't added, changed or removed; a new
  filter is scoped so it doesn't reach the tab;
- **restores and saved layouts**: Undo, a restore of an earlier version, or an applied saved layout is refused when it
  would change a protected tab. One that leaves protected tabs as they are now goes ahead.

Not covered: questions, the viewer's own filter selections (not saved), changes that don't reach the tab (the
dashboard title, a chart elsewhere), and anything done in Superset itself.

The rule is about effect. A write that rewrites a stored filter scope but leaves protected charts filtered exactly as
before is allowed.

## Settings

All off by default. A deployment that sets none of them sees no change.

| setting | where | default | what it does |
|---|---|---|---|
| `protectedTabs` | `superset.yaml`; an admin's value on the settings page wins, as for `editScope` | none | per dashboard, the tabs the chat never changes |
| `ownTabs` | a feature switch (`features:`, `LENSPACK_FEATURES`, the settings page) | off | the chat may make, rename and delete tabs of a person's own |
| `editScope: tab` | a new value of `editScope` | `superset`, as now | on shared dashboards, the chat changes only tabs the person made, and offers one on shared tabs |
| `personal.maxTabsPerUser` | beside the other personal limits | 3 | tabs of their own one person may have on one dashboard |

```yaml
protectedTabs:
  "12":                                         # the dashboard's id, as in `dashboards:`
    - TAB-k3Jd9
    - { id: TAB-p0Qx2, title: Official KPIs }   # the title is a label and a fallback
features: { ownTabs: true }
editScope: tab
```

**Tabs are named by id.** Superset keeps a tab's `TAB-…` id when it is renamed or dragged; titles change and can repeat.
The settings page lists each dashboard's tabs by title and stores ids, so nobody types one. A tab deleted and made again
in Superset gets a new id, so:

- a protected id missing from its dashboard is a warning on the settings page and in the log at start;
- if the entry has a title and exactly one tab now has it, that tab is protected until an admin confirms or removes the
  entry. When in doubt, Lenspack protects.

**Why not in the pack, or in Superset.** In Superset the pack comes from datasets; dashboards aren't in it, and their
ids differ between instances. A key in the dashboard's own metadata would travel with Superset's copy and export (so
personal copies would inherit it) and anyone editing in Superset could drop it. A marker in the title ("(locked)") is
lost on a rename. Deployment config with a settings-page override keeps it beside the other edit rules, audited.

## The rules

Everything below still needs what is needed today: `boardEdits` on, and the person allowed to edit the dashboard (by
`editPolicy`, normally Superset's own edit right). A viewer never changes a dashboard through the chat and is offered a
copy, as now. "Admins" means Lenspack admins while `editScope.adminsExempt` is true (the default); otherwise they
follow the same column as everyone. On a person's own dashboard everything is theirs: protection is per dashboard id,
so a copy is never protected.

On a shared dashboard:

| action | `editScope: superset` | `editScope: tab` (new) | `editScope: own` |
|---|---|---|---|
| Change or delete a protected tab | nobody, admins included | nobody | nobody |
| Change a shared tab (not made through the chat) | yes | admins; others offered a tab of their own | admins; others offered a copy |
| Delete a shared tab | admins | admins | admins |
| Make a tab of one's own (`ownTabs` on) | yes | yes | admins; others offered a copy |
| Change, rename or delete one's own tab | its maker, admins | its maker, admins | its maker, admins |
| Change, rename or delete someone else's own tab | admins | admins | admins |
| Change the whole dashboard (its title, a filter on every tab, density) | yes, unless it changes a protected tab | admins | admins |

A tab made through the chat is changed through the chat only by its maker, under every scope, since stopping people
undoing each other's work is its point. A maker can always delete their own tab, even after the scope changes.

**Deleting a tab**, as Superset does and as removing a widget does today:

- charts Lenspack made for it are deleted, unless used elsewhere; charts made in Superset are taken off the dashboard
  but kept;
- a filter scoped only to that tab is removed; one scoped to it and elsewhere loses that tab;
- it is a version like any other, so Undo brings the tab back with the same id and its charts in place (made again or
  relinked, as restores do since PR #94);
- refused when the tab holds a protected tab or someone else's tab, or is the only tab of its set.

**A new tab goes** at the end of the top-level tabs, or of the first set of tabs inside the grid. On a dashboard with no
tabs, a first tab means moving all content into a tab: see the open questions.

## How it is enforced, and where

Superset can't enforce any of this, so Lenspack checks every write, whatever starts it: the chat, the board API, a
restore, an applied saved layout.

| step | where | what |
|---|---|---|
| Which tabs a change reaches | `kernel/core` | a pure function of the board, its tabs (`BoardStore.tabs()` already lists each tab's widgets) and the edit: a widget's tab, an add's target tab, the tabs of a filter's charts, every tab a restore changes |
| May this person change them | `kernel/policy` | `tabRights(who, tab, facts)`: from the protected tabs, each tab's maker, `editScope` and admin, gives may change, may delete, and the reason in words. Like `boardRights`, it only narrows |
| Refuse early, in the turn | `kernel/agent` | the edit tools ask before queueing an edit, so the model and the reviewer see the refusal and the reply offers a way out. The prompt names protected tabs and each tab's maker, so the model doesn't propose such edits |
| One gate for every write | `kernel/core` | a store wrapper, like `stagedStore`, that asks a decision callback before `patch` and `replaceConfig`; the host wires it to policy |
| Last check before saving | `hosts/superset` | PR #94's layout check gains one test: protected tabs, their charts and their filters are unchanged. The host is given the list; it doesn't decide |
| Who made which tab | durable store | a small document (board, tab id, maker's name and Superset id, when) in the state directory, moving to Postgres with the other stores |
| Tab operations | `kernel/core` ops, the Superset writer | `add_tab`, `rename_tab`, `remove_tab` and a placement on a tab, written by `layout.ts` |

## Edge cases

- **A chart on a protected tab and elsewhere.** Its content is protected everywhere; its other placement can still be
  resized or removed.
- **Nested tabs.** Protecting a tab protects the tabs inside it. Protecting an inner tab leaves the rest of its parent
  editable, but the parent can't be deleted.
- **Email reports and alerts.** Superset ties a report to a tab id; when a save drops the tab it switches the report off
  and emails its owners. The chat never drops a protected tab. Before deleting any other tab it names the reports and
  alerts on it and asks to confirm. Undo brings the tab back, not the reports: Lenspack doesn't switch others' reports
  back on.
- **Filters scoped to tabs.** A filter added from someone's own tab is scoped to that tab and kept so. Today Lenspack
  turns a tab-scoped filter into a fixed chart list when it changes that filter's charts; it must stop doing so for
  filters it isn't asked to change.
- **Undo.** A restore that would change a protected tab is refused and names the tab. Superset version history is still
  in memory, so undoing a deletion doesn't survive a restart until history moves to a database (already planned).
- **Two people in the chat.** Lenspack already runs one edit per dashboard at a time and reads Superset's latest layout
  before each save, so chat edits on different tabs don't overwrite each other. Tabs of one's own add that nobody
  changes another's tab. This holds for one Lenspack server; several need the planned shared turn gate.
- **Two people on one new tab.** A tab has one maker. Others ask about it, or make their own. A shared working tab for
  a group is out of scope.
- **Superset's edit mode saving over the chat.** The real limit. Superset saves the whole layout from the browser's
  copy; the page sends when it last loaded, but Superset 5.0 and 6.1 don't compare it. Someone who opened edit mode
  before a chat change and saves after it removes that change, a chat-made tab included (and switches off reports on
  it). Lenspack sees "changed in Superset" on its next read, and the change can be restored from history. An overlay
  notice in edit mode ("the assistant changed this dashboard since you opened it; reload before saving") makes it
  rarer. So tabs of one's own stop trampling between chat users, not from Superset's editor.
- **Clutter.** Superset has no per-tab visibility: everyone who opens the dashboard sees every tab of one's own, with
  its maker's name in the title. Hence the limit. Something private belongs on a personal copy.
- **Copies.** A personal copy is not protected and has no makers: all of it is the copier's.
- **Saved edits.** Keyed today by the board, the viewer's tab and the person's edit rights. The protected tabs and the
  tab's maker join the key, so an edit saved for one person is never replayed for someone who may not make it.
- **Audit and telemetry.** Tab operations go to the audit log as chat edits naming the person; so do changes to
  `protectedTabs`. Telemetry records the tool and a refusal's reason (`protected-tab`, `not-your-tab`, `tab-limit`) with
  tab ids, not titles, since a title is text a person wrote.

## What Superset can and can't do

| | Superset | so Lenspack |
|---|---|---|
| Per-tab permissions | none | enforces protection itself, for the chat only |
| Stable tab ids | kept across renames and drags; new when made again | names tabs by id, with a title fallback |
| Make, rename, delete tabs by API | yes, by writing the whole layout, unchecked | builds the layout and checks it before each save |
| Reports on a tab | switched off when a save drops the tab | warns and asks before deleting a tab |
| Filters scoped to a tab | yes, recomputed in the browser | writes tab scopes and keeps them |
| Conflicting saves | last save wins | serialises its own edits; notices Superset's on the next read |
| Who changed it | Lenspack's account | the person, in Lenspack's audit log and tab records |

## Options considered

1. **Protect with Superset alone**: official content on its own dashboard, owned by a curator, and `editScope: own`
   elsewhere. Works today with nothing built and is worth telling deployments, but splits one dashboard in two.
2. **Where protection is set**: deployment config with a settings-page override (recommended), the dashboard's metadata,
   or a marker in the title. See [Settings](#settings).
3. **Tab operations as board edits, or as a separate host feature** like personal dashboards. Separate is smaller, but a
   new tab would skip versions, Undo, the reviewer and saved edits. Recommended: board edits, with the board knowing
   only what these features need (a list of tabs, each widget's tab), not yet moving tabs or widgets between tabs.
4. **How "make changes on a new tab" starts**: only when asked, or for every edit on a shared tab. Recommended: when
   asked, plus `editScope: tab` for deployments that want shared tabs left alone, where the chat offers it rather than
   doing it silently.
5. **Tabs of one's own or copies**: copies are private; tabs keep everyone on one dashboard, one link, the same filters
   and reports, but everyone sees them. Recommended: both: a tab when the person may edit the dashboard and `ownTabs`
   is on, a copy otherwise.

**Recommendation.** Build protected tabs first. They need no new board model, since the chat already knows each tab's
widgets, and they solve the official-content problem alone. Then teach the board about tabs and build tabs of one's own
and deletion on that. Keep every rule in `kernel/policy` and every refusal in the turn, so the chat, the board API and
Undo follow the same rules.

## Build plan

Each pull request is useful on its own. S is a day or two, M three to five days.

| # | what | size |
|---|---|---|
| 1 | Rules only: `tabRights` in `kernel/policy`, `protectedTabs` and `editScope: tab` read from config, tests. No behaviour change | S |
| 2 | Protected tabs enforced: which tabs a change reaches, the check in the edit tools and the store wrapper, filter rules, the extra Superset pre-save check, restores and saved layouts refused when they'd change a protected tab, prompt lines, docs | M |
| 3 | Settings page: pick protected tabs by title, `PUT /_superset/settings/protected-tabs`, audit lines, missing-tab warnings; optionally a lock mark the overlay draws on protected tab titles | S |
| 4 | The board knows tabs: tab list, each widget's tab, a placement on a tab, summaries grouped by tab; the Superset reader and writer use them; the standalone app draws labelled groups | M |
| 5 | Tab operations: `add_tab`, `rename_tab`, `remove_tab`, the `ownTabs` switch and limit, tab-maker records, deletion (charts, filters, the report check and confirmation), Undo of a deletion | M |
| 6 | Filters on one's own tab: scoped to that tab and kept so; untouched tab scopes no longer turned into chart lists | S |
| 7 | `editScope: tab`: the offer of a tab of one's own in the chat and panel, and a "My tabs" list in the panel | S |
| 8 | Optional: the overlay notice in Superset's edit mode after an assistant change | S |

Protected tabs (1 to 3) take about a week; tabs of one's own and deletion (4 to 7) about two more. PRs 1 and 2 touch
`kernel/policy` and the Superset server, where other work is under way, so they start from the latest `main`.

## Fits the architecture

- **Policy decides, in `kernel/policy`.** `tabRights` is a pure function of what the host says and the deployment's
  rules. Like `boardRights`, it never grants more than the host does.
- **The turn refuses, in `kernel/agent`.** Edit tools ask before queueing; the reviewer sees refusals; the reply offers a
  tab of one's own or a copy. Prompt lines about protected and own tabs are turn logic there.
- **Hosts render and write; they don't decide.** The Superset host turns tab operations into layout, checks it before
  saving, and draws the settings picker and lock mark. It is given the protected tabs.
- **Core stays host-neutral.** Tabs in the board carry only an opaque id; the store wrapper takes a callback, not policy.
- **Durable stores.** Tab-maker records and the protected-tab setting live in the state directory's document store,
  behind the interface that moves to Postgres.
- **Writes are attributed.** Every tab operation names the person in the audit log, and each tab of one's own records
  its maker. Superset still shows Lenspack's account until the planned "run as the user" work.

## Other hosts

Boards in the standalone server have no tabs, and people there already have boards of their own to share. These
features are for Superset; the rules and the board model (PRs 1 and 4) are host-neutral, so another host with tabs can
use them.

## Open questions for Kanav

1. **Filters.** As proposed, a filter on every tab can't be changed through the chat while a protected tab exists, since
   it would change what protected charts show. Right, or should dashboard-wide filters stay editable?
2. **Deleting shared tabs.** Proposed: admins only. Should dashboard owners also delete shared, unprotected tabs under
   `editScope: superset`?
3. **Dashboards with no tabs.** Should the first tab of one's own move all content into a tab (a whole-dashboard change,
   so admins or owners only), or should the chat offer a copy instead?
4. **`editScope: tab`.** Worth a third scope, or are the action and protected tabs enough?
5. **Limits.** Three tabs of one's own per person per dashboard, no cap per dashboard. Right?
6. **Admins and protection.** Proposed: not even admins change a protected tab through the chat; they lift protection
   first. Or should admins be exempt?
7. **Visible marks.** Should the overlay mark protected tabs (a lock) and tabs of one's own (the maker), or is a refusal
   when asked enough?
