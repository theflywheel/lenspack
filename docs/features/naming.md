# Naming the assistant

This page explains how a deployment gives the assistant its own name and button label, in each language. It is for
admins and whoever sets up a deployment.

The assistant is called Lenspack, and its dashboard button says "Ask Lenspack". A deployment can give it another
name, such as "Sales assistant", and another button label, such as "Ask the data". People then see that name
everywhere they meet the assistant:

- the button on each dashboard, and the header of the chat panel;
- messages in the chat that name the assistant: "Sales assistant is restarting…", "too busy right now", and the
  notes under "How this was worked out";
- the "My dashboards" menus, where they say who changes which dashboards ("Sales assistant changes only your own
  dashboards here"; see [Personal dashboards](personal-dashboards.md));
- the admin panel's title, and the names of browser tabs;
- the pages beside Superset, and the demo board app;
- the admin panel's tabs and the Superset settings page, which say "the assistant" where they once said Lenspack;
- messages from the server, such as refusals and errors, which say "the assistant" too;
- the assistant itself: it calls itself by this name only. Asked what it is, what it runs on, who made it or which
  model it uses, it gives this name, says it is the assistant for these dashboards, and names no product, company
  or model behind it.

Superset's menu entry and settings page heading take the name too (see [Superset](#superset) below).

Once the assistant has another name, the only place the word Lenspack shows is the small "Powered by Lenspack"
credit under the chat, and only while `poweredBy` is on.

## Setting it

In the config (`lenspack.yaml`, or `superset.yaml` for Superset):

```yaml
brand:
  name: Sales assistant          # default: Lenspack
  buttonLabel: Ask the data         # default: "Ask {name}", in each language
  i18n:                             # a language's own words, for en, fr, hi or pt
    fr: { name: Assistant commercial, buttonLabel: Interroger les données }
    pt: { name: Assistente de vendas }
  icon: https://example.org/mark.svg  # optional: replaces the "L" on the button and in the panel
  poweredBy: true                   # default: true
```

Every field is optional.

- **name** is the name people see, at most 40 characters.
- **buttonLabel** is the dashboard button's text, and the chat panel's header, at most 40 characters. `{name}`
  in it stands for the name. Without it, each language keeps its own wording with the name in it: "Ask Sales
  assistant", "Demander à Sales assistant", "Sales assistant से पूछें", "Perguntar ao Sales assistant".
  Once you set it, that label is used in every language, unless a language has its own under `i18n`.
- **i18n** gives one language its own name or label. It wins over the general ones for that language only.
- **icon** is an `https://` address, a path on the same site (`/static/mark.png`), or a small image written into
  the config as a `data:image/…;base64,…` value (PNG, JPEG, GIF, WebP or SVG, at most 32 KB).
- **poweredBy** shows a small "Powered by Lenspack" line under the chat when the assistant has another name.
  It links to the project. Set it to `false` to leave it out. While the name is Lenspack the line never shows.

Names and labels are plain text. They can't be empty, can't hold `<` or `>`, and are always shown as text, never
as part of the page.

The same can come from the environment, which wins over the config (see
[What wins](../operating/configuration.md#what-wins)):

| variable | sets |
|---|---|
| `LENSPACK_BRAND_NAME` | `name` |
| `LENSPACK_BRAND_BUTTON` | `buttonLabel` |
| `LENSPACK_BRAND_ICON` | `icon` |
| `LENSPACK_BRAND_POWERED_BY` | `poweredBy` (`on` or `off`) |

A value that breaks the rules above stops the server at start, with the reason.

## Changing it while the server runs

Admins can change all of it in the admin panel's **Settings** tab, under **Name**. A box left empty keeps the
deployment's value (the config or the environment). The change is kept in the server's state directory, so it
survives a restart, and it wins over the config and the environment. **Reset** hands every field back to them.

Nothing restarts. The next question already uses the new name, and an open dashboard shows it after a reload.
Each change is written to the audit log with who made it.

Behind the panel, the change is `PUT <prefix>/settings/brand` (`/_superset/settings/brand` on Superset) with any
of the fields above. `null` puts a field back to the deployment's value; under `i18n`, `{ "fr": { "name": null } }`
drops one language's name. Only admins may make it. `GET <prefix>/settings` shows the brand now, the deployment's
value, and where each field comes from. Every signed-in user's `<prefix>/info` carries the brand for the chat
panel, with each language's words already worked out.

## Saved answers

The assistant's name is part of what it is told, so [saved answers](saved-answers.md) are kept per name.
After a rename, the first time a question comes again the assistant answers it afresh, and that answer is saved
under the new name.

## What keeps the name Lenspack

Only what people read changes. These stay as they are, so links, scripts and settings keep working:

- addresses: `/_lenspack/…` on the server and every API route. In Superset the assistant's route is `/lenspack/…`
  unless you move it with `LENSPACK_PATH` (see [Superset](#superset));
- names of config keys, environment variables, packages and files (such as `lenspack_superset.py`)
- the server's log lines and start-up messages, the command line's help, and the names of actions in the audit log
- names in the code, and the names the page scripts give themselves in the browser
- the Superset account the server uses, which is `lenspack` unless you name it otherwise (`superset.username`
  and `LENSPACK_SERVICE_USER`). Superset shows it in its user list as "Assistant Service account".

## Superset

On Superset (6.1 and 5.0) the button and the chat are drawn by Lenspack's own scripts, so they follow the brand
above with nothing to change in Superset.

The settings page that the Superset plugin adds (Settings → Manage → "AI assistant") is drawn by Superset. Its
menu entry and heading take the first of these that is set:

1. `LENSPACK_BRAND_NAME` in `superset_config.py`;
2. `LENSPACK_BRAND_NAME` in Superset's own environment;
3. the name the assistant's server uses: its `brand.name` from the config, the environment, or the admin panel.

Without any of them, they say "AI assistant". So one setting is enough: set the name on the assistant's server
(in its config, its environment or the admin panel), and Superset's menu follows it within five minutes, and the
settings page at once. Set it on Superset's side only if Superset's menu should say something else. The page stays
at `/ai-assistant/`. See [The settings page](../hosts/superset/settings.md).

Browsers reach the assistant through Superset at `/lenspack/…`. To keep the product's name out of addresses too,
set `LENSPACK_PATH` in Superset's environment, for example `LENSPACK_PATH=/assistant`; the button, the chat and
the admin panel then live at `/assistant/…`. It must be a plain path of its own, not `/` and not one of Superset's
(such as `/api`, `/superset`, `/static` or `/login`); anything else keeps `/lenspack`, with a warning in Superset's
log. The assistant's server needs no change: it learns the path from each request.

---

**Next:** [Choose a host](../hosts/README.md).

**Related:** [Languages](languages.md) · [The admin panel](admin-panel.md) ·
[Configuration keys](../reference/config.md)
