# Who can use and administer the assistant

This page is for people who run Lenspack inside Superset. It explains the two choices every deployment makes:

- **who is an admin**: who may open the admin pages and change the settings;
- **who may use the assistant**: who sees the **Ask** button and may use the chat.

Each has a few modes, set with one setting in `superset.yaml` or one environment variable. Neither one ever gives anyone
more data. Whatever mode you pick, people still see only the datasets, rows and dashboards that Superset lets them see.

## Which one should I use?

### Admins

| Your situation | Use | Why |
|---|---|---|
| Your own Superset, and its admins should run the assistant too | `superset-role` (the default) | Nothing to set up. Superset's Admin role, or roles you name, decide. |
| A shared Superset where many people hold Superset's Admin role, but only a few should run the assistant | `superset-users` | You name the people. Holding Superset's Admin role grants nothing. |
| A shared Superset where you can't count on the user list, or the assistant's operators have no Superset account | `password` | One password from your deployment's secrets, on a sign-in page of its own. |

### Users

| Your situation | Use | Why |
|---|---|---|
| Everyone in Superset may use it, or a Superset role already marks who may | `superset-role` (the default) | Nothing to set up, or give people a role in Superset. |
| You choose people one by one, and Superset's roles belong to someone else | `granted` | Admins add people by Superset user name on the admin pages. |
| Both: a role for whole teams, plus a few people added by hand | `superset-role,granted` | Either one lets a person in. |
| A Superset that exists only for the assistant | `everyone` | Everyone signed in to Superset. Not for a shared Superset. |

**For a shared Superset** (one that several projects or organisations use), we recommend users `granted`, with a role as a
fallback if one exists (`superset-role,granted`), and admins `superset-users` or `password`.

Admins can always use the assistant, whatever the user mode.

## Admins

The setting is `auth.adminAccess` in `superset.yaml`, or `LENSPACK_ADMIN_ACCESS` in the environment. The environment wins.
An unknown value stops the server at start, with a message that names the allowed values: the server never guesses who
should be an admin.

### Superset roles (`superset-role`, the default)

Members of Superset's Admin role are admins. To use other roles, name them:

```yaml
auth:
  adminAccess: superset-role   # the default; can be left out
  admins: ["Lenspack admin"]   # or LENSPACK_ADMIN_ROLES="Lenspack admin"
```

- **Add or remove an admin:** in Superset, Settings → List Users, give or take away the role. It applies from their next
  page load.
- **Check it worked:** the server's log at start says `admins: Superset role Lenspack admin from auth.admins (access
  superset-role, from auth.adminAccess)`. The admin panel's **Access** tab says the same.
- **The audit log** names each admin by their Superset user name.

More on roles: [Who is asking](../hosts/superset/identity.md#who-may-administer).

### Named Superset users (`superset-users`)

Only the people you name are admins. Superset roles grant nothing in this mode, not even Superset's own Admin role.

1. Choose the **owners**: one to three people who will run the assistant. Write their Superset user names, or their user
   ids as `id:12` (Superset shows the id in Settings → List Users).
2. Set them:

   ```yaml
   auth:
     adminAccess: superset-users
     adminUsers: [alice, id:12]
   ```

   or in the environment:

   ```
   LENSPACK_ADMIN_ACCESS=superset-users
   LENSPACK_ADMIN_USERS=alice,id:12
   ```

3. Restart the server.

**User name or id?** A user name is easier to read, but if someone in Superset renames an account, or deletes it and
creates another with the same name, the new account inherits admin. An id stays with the one account. For owners on a
shared Superset, ids are the safer choice.

- **Add or remove an admin:** an owner opens the admin panel's **Access** tab and adds a Superset user name (or `id:12`)
  under **Admins**, or removes one. It applies from that person's next request. The list shows who added each admin and
  when.
  - Only owners can add or remove admins. An admin an owner added can't add others.
  - Owners come from the deployment. They can't be removed on the page: change `adminUsers` (or `LENSPACK_ADMIN_USERS`)
    and restart.
- **Check it worked:** the log at start says `admins: named Superset users (2 owners from LENSPACK_ADMIN_USERS, 1 granted;
  access superset-users, from LENSPACK_ADMIN_ACCESS)`. A Superset Admin who is not named gets "only assistant admins can
  do this" on the admin pages.
- **No owners named:** nobody is an admin, including people added earlier, and the log says so with a warning. Name an
  owner and restart.
- **The audit log** shows `settings admins grant` and `settings admins revoke` with the owner who did it and the person
  added or removed, and `PUT settings admins denied` when someone who isn't an owner tries.

The people added are kept in the server's state directory (`settings.json`, beside its other settings). They survive
restarts and upgrades. Back up the state directory as you already do.

### One shared password (`password`)

No Superset user is an admin. Admins sign in on a page of their own, with one password kept in your deployment's secrets.

1. Make a password of at least 12 characters, for example with `openssl rand -base64 24`.
2. Store it as a secret and pass it to the server as `LENSPACK_ADMIN_PASSWORD`. With Docker Compose:

   ```yaml
   lenspack:
     environment:
       LENSPACK_ADMIN_ACCESS: password
       LENSPACK_ADMIN_PASSWORD: ${LENSPACK_ADMIN_PASSWORD}   # from an .env file kept out of version control
   ```

   With Kubernetes, put it in a Secret and refer to it from the server's environment (the same lines go in the `env`
   list of your Helm values):

   ```
   kubectl create secret generic lenspack-admin --from-literal=password='<the password>'
   ```

   ```yaml
   env:
     - name: LENSPACK_ADMIN_ACCESS
       value: password
     - name: LENSPACK_ADMIN_PASSWORD
       valueFrom: { secretKeyRef: { name: lenspack-admin, key: password } }
   ```

   To keep only a hash in the environment, set `LENSPACK_ADMIN_PASSWORD_HASH` to a scrypt hash instead (the same format
   as the standalone server's password; see [Sign-in](sign-in.md)).
3. Restart the server.

- **Where admins sign in:** `https://<your Superset>/lenspack/_admin/`. Superset's own link to the admin panel leads there
  too. The page works without a Superset session, so the sign-in is the password alone.
- **Check it worked:** the log at start says `admins: one shared password (LENSPACK_ADMIN_PASSWORD set; access password,
  from LENSPACK_ADMIN_ACCESS)`. It never prints the password. Open the address above: you should see the sign-in page.
- **No password set:** nobody is an admin. The sign-in page says why, and the log has a warning.
- **Too many wrong passwords:** after 5 wrong tries from one browser or address, the sign-in waits, doubling up to 15
  minutes. Every sign-in, wrong password, wait and sign-out is in the audit log.
- **Sessions** last 8 hours (`LENSPACK_ADMIN_SESSION_HOURS`). The cookie is sent only over https, only to the admin pages,
  and never from another site.
- **Change the password:** change the secret and restart. Everyone signed in is signed out.
- **Add or remove an admin:** give the password to them, or change it and give the new one to everyone who should keep
  access.

**What a shared password can't tell you:** everyone who knows it is the same user, `admin:password`, in the audit log.
The log shows that a change was made and from which address, not which person made it. If you need that, use
`superset-users`.

**How the sign-in page is reached.** By default, through Superset's own route: Superset passes `/lenspack/_admin/`
on without asking for a Superset session, and signs each visitor's address so the wrong-password limit counts per
person. Two other ways work with the same server and need no change to it:

- **A separate address**, such as `admin.assistant.example.org`, pointing at the server's `/_admin/` through your own
  ingress or proxy. Only do this over https, and set `x-forwarded-prefix` and `x-forwarded-host` on the proxy.
- **A port-forward** for operators only, such as `kubectl port-forward deploy/lenspack 8795` and then
  `http://localhost:8795/_admin/`. Nothing is exposed to the internet.

## Users

The setting is `auth.userAccess` in `superset.yaml`, or `LENSPACK_USER_ACCESS` in the environment. The environment wins.
To combine modes, separate them with commas: `superset-role,granted`. A person who matches any of them is let in. An
unknown value stops the server at start.

People left out see no **Ask** button, and every chat and data route answers "The assistant isn't turned on for your
account". Being let in only switches the assistant on: what they see is still what Superset lets them see.

### Superset roles (`superset-role`, the default)

With no role named, everyone signed in to Superset may use the assistant, as before. To limit it to some roles:

```yaml
auth:
  users: ["Lenspack user"]   # or LENSPACK_USER_ROLES="Lenspack user"
```

- **Add or remove someone:** in Superset, give or take away the role. It applies from their next page load.
- **Check it worked:** the log says `users: Superset role Lenspack user and admins (access superset-role, the default)`.

More: [Who is asking](../hosts/superset/identity.md#who-may-use-the-assistant).

### People granted one by one (`granted`)

```yaml
auth:
  userAccess: granted
  seedUsers: [alice]   # optional; or LENSPACK_USERS=alice
```

- **Add or remove someone:** an admin opens the admin panel's **Access** tab and adds a Superset user name (or `id:12`)
  under **Users**, or removes one. It applies from that person's next page load. The list shows who added each person and
  when, and can be searched.
- **People from the deployment** (`seedUsers`, `LENSPACK_USERS`) are always let in. They can't be removed on the page:
  change the setting and restart.
- **Nobody added yet:** only admins can use the assistant. The log says so at start.
- **Check it worked:** the log says `users: 1 seeded from LENSPACK_USERS and 3 granted and admins (access granted, from
  LENSPACK_USER_ACCESS)`.
- **The audit log** shows `settings users grant` and `settings users revoke`, with the admin and the person.

The people added are kept in the state directory, like the admins added under `superset-users`.

### A role or a grant (`superset-role,granted`)

```yaml
auth:
  userAccess: superset-role,granted
  users: ["Field team"]
```

People with the Superset role, and people an admin added, may both use the assistant. If you combine them without naming
a role, only the people added are let in, and the log warns you.

### Everyone signed in (`everyone`)

```yaml
auth:
  userAccess: everyone
```

Everyone signed in to Superset may use the assistant, whatever roles are named. The log warns at every start that this is
for a Superset that exists only for the assistant. On a shared Superset, people from other projects would see the button.

## Switching modes

Change the setting (or the environment variable) and restart the server. Nothing else needs to change:

- People added under `superset-users` or `granted` are kept when you switch away, and count again if you switch back.
- Switching admins to `password` sends Superset's link to the admin panel to the password sign-in instead.
- Switching admins away from `password` turns the password sign-in off: its address answers "not found".

## How the modes fit with the rest

- **Admins always count as users.** Under `granted`, an admin needs no grant to use the assistant.
- **Admin modes and user modes are separate.** Any admin mode works with any user mode.
- **Being an admin gives no more data.** An admin added under `superset-users` still sees only their own Superset access.
  The password admin has no Superset account at all, so no dashboard or dataset of its own.
- **Superset's Settings → AI assistant page** stays a Superset Admin's page. Under `superset-users` and `password`, its
  changes are refused unless the person is also an admin by the mode; use the admin panel instead.
- The decision is made in one place, Lenspack's policy layer, from what Superset signs about each person (user name, id
  and roles) and the lists above. See [Rights](rights.md#admin).
