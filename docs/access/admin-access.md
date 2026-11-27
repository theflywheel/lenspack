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
| Your own Superset, and its admins should run the assistant too | `superset-role` (the default) | Nothing to set up. A Superset role decides. |
| As above, plus an operator or supplier with no Superset account | `superset-role,password` | A role for people in Superset, a named password each for the others. |
| A shared Superset where many people hold Superset's Admin role, but only a few should run the assistant | `superset-users` | You name the people. Holding a Superset role grants nothing, so a Superset Admin can't make themselves an assistant admin. |
| As above, plus a way in if no owner can sign in to Superset | `superset-users,password` | Owners and the people they add, plus named passwords kept for emergencies. |
| The assistant's operators have no Superset account, or you can't count on Superset's user list | `password` | A named password for each admin, from your deployment's secrets, on a sign-in page of its own. |

**Use a role of its own.** Under `superset-role`, create a Superset role named `Lenspack admin` (it needs no
permissions) and set `LENSPACK_ADMIN_ROLES="Lenspack admin"`. Superset's own `Admin` role is still the default, so
existing deployments keep working, but it makes every Superset Admin an assistant admin, and the log warns about it.

**What `superset-role` can't stop.** Anyone who can edit roles in Superset (every Superset Admin) can give themselves
the admin role. Lenspack can't prevent that under `superset-role`; it only makes it visible: the admin panel's
**Access** tab lists everyone who has used admin rights, the audit log has a line the first time each person does, and
every admin sees "New admin since your last visit" when someone new appears. If Superset Admins must not be able to make
themselves assistant admins, use `superset-users`.

### Users

| Your situation | Use | Why |
|---|---|---|
| Everyone in Superset may use it, or a Superset role already marks who may | `superset-role` (the default) | Nothing to set up, or give people a role in Superset. |
| You choose people one by one, and Superset's roles belong to someone else | `granted` | Admins add people by Superset user name on the admin pages. |
| Both: a role for whole teams, plus a few people added by hand | `superset-role,granted` | Either one lets a person in. |
| A Superset that exists only for the assistant | `everyone` | Everyone signed in to Superset. Not for a shared Superset. |

**For a shared Superset** (one that several projects or organisations use), we recommend users `granted`, with a role as a
fallback if one exists (`superset-role,granted`), and admins `superset-users` (with `password` added if operators need a
way in without Superset).

Admins can always use the assistant, whatever the user mode.

## Admins

The setting is `auth.adminAccess` in `superset.yaml`, or `LENSPACK_ADMIN_ACCESS` in the environment. The environment wins.
An unknown value stops the server at start, with a message that names the allowed values: the server never guesses who
should be an admin.

### Combining modes

`password` combines with either of the other two. Separate them with a comma: `superset-role,password` or
`superset-users,password` (in YAML, quote the value, or write a list: `adminAccess: [superset-role, password]`). A
person who qualifies under any of them is an admin. The order you write them in doesn't matter.

- **Refused at start:** `superset-role,superset-users`. Under `superset-users` holding a role must grant nothing, and
  under `superset-role` it grants admin, so the two can't both hold. The server stops with a message saying so.
- **Who comes in where:** people with a Superset account come in through Superset as usual; people with a named password
  sign in at `/lenspack/_admin/`. With `password` alone, Superset's link to the admin panel leads to that sign-in.
- **How each admin qualifies** is shown in the **Access** tab: "Superset role Lenspack admin", "owner", "granted by an
  owner", or "named password ops".
- **Admins with a password may add and remove admins** under `superset-users,password`, as owners can: the password is
  the way in when no owner can be reached.

### The admins roster

The **Access** tab lists everyone who has used admin rights on this deployment, in every mode: their name, how they
qualified, when they were first seen and when they were last seen. It is kept in the state directory beside the
settings, so it survives restarts.

- **The first time** someone uses admin rights, the audit log gets an `admin first use` line naming them and how they
  qualified. If they later qualify another way (a role taken away, then a grant), it gets an `admin qualifies another way`
  line.
- **New admin since your last visit:** when you come back after a break of 30 minutes or more, the admin panel names
  anyone who used admin rights for the first time while you were away, at the top of every tab.
- **Being on the roster grants nothing.** It is a record. Who is an admin is decided by the mode, on every request.

### Superset roles (`superset-role`, the default)

Members of a Superset role are admins. The default role is Superset's own `Admin`; use a role of its own instead:

1. In Superset, Settings → List Roles, add a role named `Lenspack admin`. It needs no permissions.
2. Name it:

   ```yaml
   auth:
     adminAccess: superset-role     # the default; can be left out
     admins: ["Lenspack admin"]     # or LENSPACK_ADMIN_ROLES="Lenspack admin"
   ```

3. Give the role to the people who should run the assistant, and restart the server.

- **Add or remove an admin:** in Superset, Settings → List Users, give or take away the role. It applies from their next
  page load.
- **Check it worked:** the server's log at start says `admins: Superset role Lenspack admin from auth.admins (access
  superset-role, from auth.adminAccess)`. The admin panel's **Access** tab says the same.
- **The audit log** names each admin by their Superset user name.
- **Anyone who can edit roles can give themselves this one.** See [What `superset-role` can't stop](#admins).

More on roles: [Who is asking](../hosts/superset/identity.md#who-may-administer).

### Named Superset users (`superset-users`)

Only the people you name are admins. Superset roles grant nothing in this mode, not even Superset's own Admin role, so a
Superset Admin can't make themselves an assistant admin.

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
  - Only owners (and, under `superset-users,password`, admins signed in with a password) can add or remove admins. An
    admin an owner added can't add others.
  - Owners come from the deployment. They can't be removed on the page: change `adminUsers` (or `LENSPACK_ADMIN_USERS`)
    and restart.
- **Check it worked:** the log at start says `admins: named Superset users (2 owners from LENSPACK_ADMIN_USERS, 1 granted;
  access superset-users, from LENSPACK_ADMIN_ACCESS)`. A Superset Admin who is not named gets "only assistant admins can
  do this" on the admin pages.
- **No owners named:** nobody is an admin that way, including people added earlier, and the log says so with a warning.
  Name an owner and restart.
- **The audit log** shows `settings admins grant` and `settings admins revoke` with the owner who did it and the person
  added or removed, and `PUT settings admins denied` when someone who isn't an owner tries.

The people added are kept in the server's state directory (`settings.json`, beside its other settings). They survive
restarts and upgrades. Back up the state directory as you already do.

### Named passwords (`password`)

Admins sign in on a page of their own with their name and their own password, kept in your deployment's secrets. Each
person shows up in the audit log under their own name, as `admin:<name>`.

1. Choose a short name for each person (letters, digits, dot, dash or underscore, up to 40), and make each a password of
   at least 12 characters, for example with `openssl rand -base64 24`.
2. Pass them to the server, one `name:password` per person, in either of two ways:

   - **A file**, one per line, as a Kubernetes Secret mounted into the server (lines starting with `#` are skipped; a
     password may contain any character):

     ```
     kubectl create secret generic lenspack-admins --from-file=passwords=./admin-passwords.txt
     ```

     ```
     # admin-passwords.txt, kept out of version control
     ops:<a long password>
     vendor:<another long password>
     ```

     ```yaml
     # the server's Deployment (or the env, volumes and volumeMounts of your Helm values)
     env:
       - name: LENSPACK_ADMIN_ACCESS
         value: superset-role,password
       - name: LENSPACK_ADMIN_ROLES
         value: Lenspack admin
       - name: LENSPACK_ADMIN_PASSWORDS_FILE
         value: /secrets/admins/passwords
     volumeMounts:
       - { name: admins, mountPath: /secrets/admins, readOnly: true }
     volumes:
       - name: admins
         secret: { secretName: lenspack-admins }
     ```

   - **An environment variable**, `LENSPACK_ADMIN_PASSWORDS`, with the pairs separated by commas. A password given this
     way can't contain a comma; use the file if one does. With Docker Compose:

     ```yaml
     lenspack:
       environment:
         LENSPACK_ADMIN_ACCESS: password
         LENSPACK_ADMIN_PASSWORDS: ${LENSPACK_ADMIN_PASSWORDS}   # ops:…,vendor:… from an .env file kept out of version control
     ```

   A password that starts with `scrypt$` is read as a hash (make one with `lenspack hash-password`), so the file or
   variable needn't hold the passwords themselves.
3. Restart the server.

**One shared password, as before.** `LENSPACK_ADMIN_PASSWORD` (or `LENSPACK_ADMIN_PASSWORD_HASH`) still works: it is one
more entry, named `password`, signed in to with the name left empty, and shown as `admin:password` in the audit log.
Everyone who knows it is the same person there, so prefer named passwords.

- **Where admins sign in:** `https://<your Superset>/lenspack/_admin/`. The page works without a Superset session.
- **Check it worked:** the log at start says `admins: named passwords (2 from LENSPACK_ADMIN_PASSWORDS_FILE; access
  password, from LENSPACK_ADMIN_ACCESS)`. It never prints a password. The **Access** tab lists the names.
- **A mistake stops the server at start:** a line without a colon, a name used twice, a password under 12 characters, a
  file that can't be read. The message says which entry, never the password.
- **No password set:** nobody signs in that way. The sign-in page says why, and the log has a warning.
- **Too many wrong tries:** after 5 wrong tries from one browser or address, or 5 wrong tries for one name from
  anywhere, the sign-in waits, doubling up to 15 minutes. A browser that has signed in as that name before is not held up
  by the name's count, so someone guessing a name can't lock its owner out. A wrong name and a wrong password get the
  same answer. Every sign-in, wrong try, wait and sign-out is in the audit log, under the name that was typed.
- **Sessions** last 8 hours (`LENSPACK_ADMIN_SESSION_HOURS`). The cookie is sent only over https, only to the admin pages,
  and never from another site.
- **Add someone:** add their line and restart.
- **Remove someone:** remove their line and restart. Their session ends at once, since their name is no longer on the
  list. Nobody else is signed out.
- **Change one person's password:** change their line and restart. Only their sessions end.

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
- Switching admins to `password` alone sends Superset's link to the admin panel to the password sign-in instead.
- Taking `password` out of the admin modes turns the password sign-in off: its address answers "not found".
- The admins roster is kept whatever the mode.

## How the modes fit with the rest

- **Admins always count as users.** Under `granted`, an admin needs no grant to use the assistant.
- **Admin modes and user modes are separate.** Any admin mode works with any user mode.
- **Being an admin gives no more data.** An admin added under `superset-users` still sees only their own Superset access.
  An admin signed in with a password has no Superset account at all, so no dashboard or dataset of their own.
- **Superset's Settings → AI assistant page** stays a Superset Admin's page. Under `superset-users` and `password`, its
  changes are refused unless the person is also an admin by the mode; use the admin panel instead.
- The decision is made in one place, Lenspack's policy layer, from what Superset signs about each person (user name, id
  and roles) and the lists above. See [Rights](rights.md#admin).
