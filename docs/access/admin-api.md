# The admin API key

An admin API key lets a script, or a person at a terminal, do everything an admin can do on the admin pages: read and
change settings, switch features, pick the chat model, add admins and users, read the audit log and usage, clear saved
answers and edit the pack's definitions. It works through Superset's public address, so you need no access to the
server itself.

**It is a master key.** Whoever holds it is an admin, whatever [admin access mode](admin-access.md) the deployment
uses, and can add other admins. Keep it as you would keep a root password: in your deployment's secrets, never in a
file you commit, a chat or a URL.

It is off by default. With no key set, nothing changes.

## What a key can and can't do

- **Can:** call every admin route (listed [below](#what-you-can-do-with-it)). It counts as an admin who may also see user
  names (on the usage board and the Telemetry tab), and as an owner under `superset-users`, so it can add and remove
  admins in every mode.
- **Can't:** use the chat, read boards or data, or open anyone's own dashboards. It is not a Superset user, so it has
  none of Superset's data rights. A request with a key to any route that is not an admin route is refused with `403`
  (`"code": "api-key-admin-only"`), and the key isn't even checked there.
- **Shows up as itself.** Each key has a name. Everything done with the key named `ci` is in the audit log as `api:ci`.
  The first time it is used, the audit log gets an `admin first use` line, and the **Access** tab's list of admins shows
  it as "API key ci".

## Set it up

1. **Make a key**, 32 characters or more. For example:

   ```sh
   openssl rand -base64 36
   ```

2. **Turn it into a hash**, so the server (and whoever runs it) only ever holds the hash. Use Lenspack's own command,
   from the same image the server runs, with the key on standard input (it never shows in your shell history):

   ```sh
   read -rs KEY; printf %s "$KEY" | docker run --rm -i ghcr.io/theflywheel/lenspack:<tag> hash-password
   ```

   Where the `lenspack` command is installed, `printf %s "$KEY" | lenspack hash-password` does the same. Either prints
   one line starting `scrypt$`.

3. **Give it a name** (letters, digits, dot, dash or underscore, up to 40) and hand `name:hash` to whoever runs the
   cluster, for example `ci:scrypt$32768$8$1$…`. Keep the key itself. They put it in a Kubernetes Secret and pass it to
   the server as an environment variable:

   ```sh
   kubectl create secret generic lenspack-api-keys --from-literal=keys='ci:scrypt$32768$8$1$…'
   ```

   ```yaml
   # the Lenspack server's Deployment (or the env of your Helm values)
   env:
     - name: LENSPACK_ADMIN_API_KEYS
       valueFrom:
         secretKeyRef: { name: lenspack-api-keys, key: keys }
   ```

   Several keys are separated by commas: `ci:scrypt$…,ops:scrypt$…`. Or mount the Secret as a file with one
   `name:key` per line and set `LENSPACK_ADMIN_API_KEYS_FILE` to its path, as for
   [named passwords](admin-access.md#named-passwords-password). A plain key (not a hash) works too, but then the
   Secret holds the key itself.

   In Docker Compose, write each `$` of a hash as `$$`, or Compose reads it as a variable.

4. **Restart the server.** Also make sure Superset runs the `lenspack_superset.py` from the same release: it is the part
   that passes the key on.

5. **Check it**, changing nothing:

   ```sh
   curl -s -H "Authorization: Bearer $KEY" https://superset.example.org/lenspack/_admin/whoami
   # {"user":"api:ci","administer":true,"users":true,"owner":true,"via":"api-key","detail":"ci","usesAssistant":false}
   ```

   The server's log at start says how many keys there are and their names, never a key:
   `admin API keys: 1 (ci) from LENSPACK_ADMIN_API_KEYS; …`. A bad entry (no colon, a name used twice, a plain key
   under 32 characters, a hash that doesn't read, a file that can't be read) stops the server at start, naming the
   entry, never the key.

## Where to send it

Always as a header, `Authorization: Bearer <key>`. A key in the address (`?key=…`) is never read.

| From | Address |
|---|---|
| Anywhere, through Superset | `https://<your Superset>/lenspack/_admin/<route>` (with Superset under a path: `https://<host>/superset/lenspack/_admin/<route>`). No Superset session needed. |
| Inside the cluster | `http://<lenspack service>:8795/_admin/<route>`, or `/_superset/<route>` |
| With a port-forward | `kubectl port-forward deploy/lenspack 8795`, then `http://localhost:8795/_admin/<route>` |

Superset passes the header on for `/lenspack/_admin/…` only. Every other Superset route ignores it and still asks
for a Superset session, so a key can't reach the chat or data through Superset either. Use https.

## What you can do with it

The examples assume:

```sh
LP=https://superset.example.org/lenspack/_admin
AUTH="Authorization: Bearer $KEY"
```

**Read every setting** (what the admin pages show, with no secrets):

```sh
curl -s -H "$AUTH" $LP/settings
```

**Don't undo someone else's change.** Every settings answer carries the revision it is at as its `ETag`. Send it back
as `If-Match`, and a change to something changed since is refused with `409` and the values as they are now, instead of
silently overwriting it (see [Changes made elsewhere](../hosts/superset/settings.md#changes-made-elsewhere)). Without
`If-Match`, the last change wins, as before.

```sh
TAG=$(curl -s -o /dev/null -D - -H "$AUTH" $LP/settings | awk 'tolower($1)=="etag:" {print $2}' | tr -d '\r')
curl -s -X PUT -H "$AUTH" -H "If-Match: $TAG" -H 'content-type: application/json' -d '{"default": "fr"}' $LP/settings/language
```

**Turn a feature off, and back to the deployment's value** (`null`):

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"heatmap": false}' $LP/settings/features
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"heatmap": null}' $LP/settings/features
```

**Pick the chat model** (one of those the server offers, listed under `chat.options` in the settings):

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"model": "<a model name>"}' $LP/settings/chat
```

**Rename the assistant:**

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"name": "Field helper"}' $LP/settings/brand
```

**Change the budget, the models that answer, or how long the audit log is kept** (`null` hands a value back to the
deploy config; every option that can change is on [What can change without a redeploy](../hosts/superset/runtime.md)):

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"usdPerDay": 20}' $LP/settings/budget
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"offered": ["<a model name>"]}' $LP/settings/models
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"retentionDays": 180}' $LP/settings/audit
```

**Add an admin** (under `superset-users`) **or a user** (under `granted`), by Superset user name or `id:<n>`; `remove`
takes them away:

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"add": "amira"}' $LP/settings/admins
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"add": "amira"}' $LP/settings/users
```

**Read the pack's definitions** (instructions, hints, synonyms and readings added on top of the pack), **add one, and
undo the last change:**

```sh
curl -s -H "$AUTH" $LP/admin/api/definitions
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"kind": "instruction", "text": "Weeks start on Monday.", "why": "agreed with the programme team"}' $LP/admin/api/definitions
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"why": "wrong wording"}' $LP/admin/api/definitions/undo
```

`kind` is `instruction`, `hint` (with `key`, a measure or dimension), `synonym` (with `key` and `words`) or
`definition` (with `when`). Edit or remove one with `POST …/definitions/<id>/edit` or `…/<id>/remove`.

**Change the pack** (labels, hints, measures, example questions, `notDimensions`, hierarchies, more exclusions),
**checking first, then go back if needed:**

```sh
curl -s -H "$AUTH" $LP/settings/pack
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"fields": {"labels": {"region": "Sales region"}}}' $LP/settings/pack/validate
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"fields": {"labels": {"region": "Sales region"}}, "why": "clearer word"}' $LP/settings/pack
curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"version": 0}' $LP/settings/pack/revert
```

Each change is checked against Superset's datasets as at start-up, and refused with nothing changed if it adds a
problem. See [Changing the pack while it runs](../hosts/superset/pack-runtime.md) for every route and what can't change.

**Protect tabs, turn on the playground, and list or delete tabs made through the chat** (see
[Tabs on dashboards](../features/tabs.md)):

```sh
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"protected": {"12": ["TAB-k3Jd9"]}}' $LP/settings/tabs
curl -s -X PUT -H "$AUTH" -H 'content-type: application/json' -d '{"playground": true}' $LP/settings/features
curl -s -H "$AUTH" $LP/tabs
curl -s -X DELETE -H "$AUTH" "$LP/tabs/12/TAB-lp-abc123?confirm=1"
```

**Read the audit log** (newest first; `?month=2026-11`, `?limit=`), **and recent turns and their cost:**

```sh
curl -s -H "$AUTH" "$LP/audit?limit=50"
curl -s -H "$AUTH" $LP/turns
```

**Clear saved answers, or tell Lenspack the data changed** (after a load):

```sh
curl -s -X POST -H "$AUTH" $LP/cache/clear
curl -s -X POST -H "$AUTH" $LP/cache/data-changed
```

Every admin route works the same way. The full list is in the [HTTP API](../reference/http-api.md#the-admin-api):
take a route written `/_superset/<route>` and send it to `…/lenspack/_admin/<route>`.

## Rotate or remove a key

You don't need access to the server, only to whoever runs it:

1. Make a new key and its hash, as above.
2. Have them change the Secret's value to the new `name:hash` and restart the server
   (`kubectl rollout restart deploy/lenspack`).
3. From then on the old key gets `401`.

To change keys with no gap, set both for a while (`ci:<new hash>,ci-old:<old hash>`), move your scripts over, then remove
the old one and restart again. To remove a key, take its entry out and restart. A key that is no longer set grants
nothing, even if a request with it was in flight.

## Wrong keys

A wrong key gets `401`. After 5 wrong keys from one address, that address waits, doubling up to 15 minutes, and gets
`429` with `retry-after`, even for a right key, so guessing teaches nothing. 100 wrong keys in 10 minutes from anywhere
hold every new address for a while. Through Superset, the address is the caller's, as Superset signs it, not Superset's
own. Each wrong key is in the audit log as `api:?` with the address, never the key.

## What still needs a redeploy

Most options can change with a key: the budget caps, which models answer and their roles, the audit log's retention,
how the chat opens, where the admin pages are, and everything on the settings page. The whole list, option by option,
is on [What can change without a redeploy](../hosts/superset/runtime.md). These stay in `superset.yaml` or the
environment:

- the datasets, dashboards and the pack's own row scope, and the overlay's `pack`, `entities`, `timeZone`, `geo` and
  `mapStyle`; an exclusion `superset.yaml` makes can't be removed;
- the model and speech keys (`LENSPACK_LLM_PROVIDERS`, speech keys) and where spoken questions are sent;
- who is an admin and who may use the assistant (`auth.adminAccess`, `auth.userAccess`, roles, owners, passwords),
  the admin API keys themselves, the host policy and the edit policy;
- switching the audit log off, how the server reaches Superset, its port and its state directory.

Grants made on the Access tab (admins under `superset-users`, users under `granted`), everything in the definitions and
changes to the pack are kept in the state directory and survive restarts.
