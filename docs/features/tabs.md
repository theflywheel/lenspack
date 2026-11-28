# Tabs on dashboards

On a Superset dashboard laid out in tabs, a deployment can decide which tabs the chat may change, let the chat make
tabs, and let people who may only view a dashboard try things out on a tab of their own. Everything here is off by
default: with no setting changed, the chat works on tabs as before.

The fuller design behind this is in [pull request #113](https://github.com/theflywheel/lenspack/pull/113). What is
built is a smaller version of it, described on this page.

## What you can turn on

| what | how | default |
|---|---|---|
| Protected tabs | `tabs.protected`: per dashboard, the tabs the chat never changes | none |
| Only tabs made through the chat | `tabs.editable: own`: every other tab is protected | `all` |
| Tabs made through the chat | the `chatTabs` switch: people who may edit a dashboard can ask for a new tab, rename it and delete it | off |
| Playground tabs | the `playground` switch: people who may only view a dashboard can have tabs of their own on it | off |
| How many tabs | `tabs.maxPerUser` per person per dashboard, `tabs.maxPerDashboard` per dashboard | 3 and 20 |
| How many widgets on one tab | `tabs.maxWidgetsPerTab`: `auto` or a number | `auto` |

## Protected tabs

A protected tab is never changed through the chat, for anyone, admins included. That covers:

- the tab itself: its title, its place among the tabs beside it, and whether it exists;
- everything on it, and on tabs inside it: no chart or note is added, changed, resized or removed;
- the charts on it, even where the same chart is also placed on another tab;
- filters that reach any chart on it: such a filter is not added, changed or removed.

Questions about a protected tab are answered as usual. Asked to change one, the chat says the tab is protected and,
when the person may have a tab of their own, offers that instead.

Name protected tabs by their id (`TAB-…`), as Superset keeps it in the dashboard's layout. A tab keeps its id when it
is renamed or moved in Superset; a tab deleted and made again gets a new id. The settings API lists each dashboard's
protected ids.

```yaml
tabs:
  protected:
    "12": [TAB-k3Jd9, TAB-p0Qx2]   # the dashboard's id, as in `dashboards:`
```

For a pilot, the simplest strong rule is `editable: own`: the chat changes only tabs it made, and every other tab on
every dashboard is protected.

```yaml
tabs:
  editable: own
features:
  chatTabs: true
```

## Tabs made through the chat

With `chatTabs` on, someone who may edit a dashboard can ask "make a tab called Stock and put a chart of stock by
ward on it". The chat makes the tab at the end of the outermost tabs, then puts widgets on it. A tab made this way is
its maker's: only they and admins change, rename or delete it through the chat.

Making, renaming and deleting a tab are ordinary dashboard edits: each is a version, the reviewer checks it, it is in
the audit log with the person's name, and Undo brings it back (a deleted tab comes back with the same id and its
charts).

Deleting a tab deletes what is on it: charts made through Lenspack are deleted, charts made in Superset are taken off
the dashboard but kept. Superset switches off an email report or alert sent from a deleted tab, so before deleting
one that has any, the chat names them and asks. Undo brings the tab back, not the reports.

Who may delete which tab:

- its maker, a tab they made through the chat;
- an admin, any tab that isn't protected;
- nobody, a protected tab, or the only tab in its set.

A dashboard with no tabs gets no first tab through the chat: that would move everything on it into the tab. Add the
first tab in Superset.

## The playground

With the `playground` switch on, anyone who can open a dashboard, viewers too, can ask the chat for a tab of their own
on it. The tab is named after them ("asha", or "asha: stock trend"). On their own tabs they can add, change and remove
widgets and filters that reach only those widgets, and delete the tabs. Nothing else on the dashboard changes:
another tab, the dashboard's title and a filter that reaches other tabs all stay as they are.

Lenspack's own Superset account saves these changes, as it saves every chat change. So who may do this is Lenspack's
decision, made by its policy, and the audit log records the real person for each change.

The tab limits and the widget limit apply. Questions about any tab are answered as usual.

## Limits

**Tabs.** A person may have at most `maxPerUser` tabs made through the chat on one dashboard (3 by default), and a
dashboard at most `maxPerDashboard` (20 by default). Only tabs that are on the dashboard now count. Over the limit, the
chat says the limit, names the person's tabs, and says to delete one first.

**Widgets on one tab.** The chat doesn't put more than `maxWidgetsPerTab` widgets on one tab. With `auto` (the
default), the limit is 1.5 times the most widgets on any one tab of that dashboard, rounded up, and at least 4. It is
worked out from the dashboard as it is at each edit, counting only tabs not made through the chat, so the chat's own
tabs never raise it. A widget counts on the tab it sits directly on: a tab inside another counts its own widgets. A
tab already over the limit can still lose widgets or have one changed.

The limits apply while any tab rule is on: a protected tab on the dashboard, `editable: own`, `chatTabs` or the
playground.

## Settings

In `superset.yaml`, under `tabs:`, with an environment variable for each that wins over the file. An admin's value on
the settings page wins over both, as for `editScope`. The start-up log has one line with the rules in force.

| key | variable | values |
|---|---|---|
| `tabs.editable` | `LENSPACK_TABS_EDITABLE` | `all` (default) or `own` |
| `tabs.protected` | `LENSPACK_PROTECTED_TABS` | per dashboard id, a list of tab ids. The variable takes JSON, or `12=TAB-a\|TAB-b;13=TAB-c` |
| `tabs.maxPerDashboard` | `LENSPACK_MAX_TABS_PER_DASHBOARD` | 0 to 1000 (default 20) |
| `tabs.maxPerUser` | `LENSPACK_MAX_TABS_PER_USER` | 0 to 1000 (default 3) |
| `tabs.maxWidgetsPerTab` | `LENSPACK_MAX_WIDGETS_PER_TAB` | `auto` (default) or 1 to 1000 |
| `features.chatTabs` | `LENSPACK_FEATURES=chatTabs=on` | off by default |
| `features.playground` | `LENSPACK_FEATURES=playground=on` | off by default |

Both switches need `boardEdits` on.

## On the settings page

The Settings tab of the admin pages, on Superset's AI assistant page and on the admin panel alike, has two cards:

- **Tabs on dashboards**: which tabs the chat may change, the `chatTabs` and `playground` switches, and the limits.
  Leave the widget box empty for `auto`.
- **Tabs on each dashboard**: for each dashboard the assistant has opened, its tabs by title, nested ones indented.
  Tick a tab to protect it; a tab inside a protected one is protected with it. Each chat-made tab shows who made it
  (and whether it is a playground tab), with a Delete button. The line above says how many chat tabs the dashboard
  has against its limit, each person's count, and the widget limit in force. Protected ids the dashboard no longer has
  are named, and dropped when that dashboard is saved.

Saving sends the settings' revision like every settings change: if another admin changed the tab rules since the
page was read, nothing is changed and the page shows theirs.

## Routes

Admins only, like every settings route.

| route | what it does |
|---|---|
| `GET /_superset/settings` | `tabs`: the rules in force, what the config and environment say (`defaults`) and what an admin saved (`saved`) |
| `GET /_superset/settings/tabs` | the same, alone |
| `PUT /_superset/settings/tabs` | any of `{editable, protected, maxPerDashboard, maxPerUser, maxWidgetsPerTab}`; `null` hands a value back to the config. `protected` is a map of dashboard id to tab ids. Audited |
| `PUT /_superset/settings/features` | `{chatTabs, playground}`, like any switch |
| `GET /_superset/tabs` | `tabs`: every tab made through the chat on the dashboards Lenspack has open (dashboard, tab id, title, maker, whether it is a playground tab, when, how many widgets); `dashboards`: each open dashboard's tabs, what is protected, who made which, the counts and the widget limit; `limits` |
| `DELETE /_superset/tabs/<dashboard>/<tab>` | an admin deletes a tab made through the chat. When email reports are sent from it, the answer is 409 naming them; add `?confirm=1` to delete it anyway. Audited |

## How it is enforced

Every write to a dashboard is checked, whatever starts it:

1. The chat's edit tools ask before an edit is queued, so the reply and the reviewer see a refusal.
2. The board API, a restore of an earlier version, and an applied saved layout go through the same check.
3. Last, before Superset is sent a layout, Lenspack checks that every protected tab, and the charts on it, are as
   Superset has them now.

Who made which tab is kept in `chat-tabs.json` in the state directory.

## Known limits

- **Superset has no per-tab permissions.** Someone editing in Superset's own edit mode can still change any tab,
  protected or not, and the last save wins. These rules bind the chat only.
- **A tab made for one person is visible to everyone** who can open the dashboard. Superset has no per-tab
  visibility. Something private belongs on a [personal copy](personal-dashboards.md).
- **Deleting a tab switches off email reports sent from it.** The chat names them and asks first; Undo does not
  switch them back on.
- Moving charts between tabs, and making a tab inside another, are not done through the chat.
