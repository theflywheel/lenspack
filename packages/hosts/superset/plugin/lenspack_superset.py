"""Lenspack's additions to Superset 6.1 (and 5.0), as one file. No fork, no custom image, no second web server.

Load it at the end of superset_config.py (on the Helm chart: a configOverrides entry):

    from lenspack_superset import *  # noqa: F401,F403

It adds:
  - /lenspack/...: Superset itself forwards these requests to the Lenspack container, for signed-in users
    only, with a signed header saying who is asking, whether they are an admin, and whether Superset would
    let them view and edit the dashboard the request is about. The dashboard is read from the path the way
    Lenspack reads it (api/<pack>/superset-<id>/...), the header names that board and pack, and a path with a
    "." or ".." segment or an encoded slash is refused. Chat replies stream through unbuffered.
    Lenspack trusts nothing else, so its port never needs to be reachable from outside.
  - the "Ask Lenspack" button on every page (Superset's tail_js_custom_extra.html), for signed-in users;
  - Settings → Manage → "AI assistant" (admins): models, languages, spend, the audit log. On Superset 6, whose pages
    are all drawn by its frontend, this page has a layout of its own that follows Superset's light or dark theme;
    on Superset 5 it sits in Superset's server-drawn layout;
  - /api/v1/lenspack/bootstrap and /api/v1/lenspack/identity-key, which Lenspack calls on start: the first
    makes Lenspack's own service account (admins only), the second hands it the signing key, derived from
    SECRET_KEY (admins and that account only);
  - /api/v1/lenspack/access?user=&datasets=&dashboards=, which Lenspack calls with hostPolicy: superset (the
    default): whether that user may read each dataset and the row-level security clauses on it, and whether they
    may open each dashboard, as Superset's security manager decides them for that user, Jinja rendered (admins
    and Lenspack's account only);
  - /api/v1/lenspack/version: Superset's version, which Lenspack reads on start (admins and Lenspack's account);
  - a fix for concurrent list requests in Flask-AppBuilder;
  - on Superset 6.1, ClickHouse column aliases with a hash suffix again, as up to 6.0 (see
    lenspack_clickhouse_label_suffix below).
If your config already sets FLASK_APP_MUTATOR, call lenspack_app_mutator(app) from yours and set
FLASK_APP_MUTATOR back to yours after this import.

Environment (all optional):
  LENSPACK_INTERNAL_URL   where Superset's server reaches Lenspack (default http://lenspack:8795).
  LENSPACK_SERVICE_USER   Lenspack's Superset account (default lenspack).
  LENSPACK_TEMPLATES      a folder whose tail_js_custom_extra.html or lenspack/settings.html replace the
                          ones built in here.
  LENSPACK_CLICKHOUSE_LABEL_SUFFIX  off keeps Superset 6.1's ClickHouse aliases without the hash suffix.

Capacity: a chat turn holds one of Superset's gunicorn threads for as long as it streams (30-60 s). Stock
Superset runs 1 worker x 20 threads (SERVER_WORKER_AMOUNT, SERVER_THREADS_AMOUNT): about 10 chats at once
with room left for dashboards. Raise the threads for more.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import time

# Import the ClickHouse driver once, while the config loads. Otherwise Superset imports it lazily
# from several request threads at once after a restart, and a worker can fail with "partially
# initialized module clickhouse_connect.common" until it is restarted.
try:
    import clickhouse_connect  # noqa: F401
    import clickhouse_connect.cc_sqlalchemy.dialect  # noqa: F401
except ImportError:  # the image without clickhouse-connect
    pass


# Flask-AppBuilder keeps the filters of a list request on the API view, which is one object per worker:
# `GET /api/v1/<thing>/?q=(filters:...)` clears and refills `self._filters` and then runs the query. Superset serves
# with gunicorn gthread (20 threads per worker), so two list requests at the same time can swap filters, and a lookup
# of dataset "a" answers with dataset "b" (or nothing). Build the filters per request. Every release from 4.5.5
# (Superset 5.0) to 5.0.2 (Superset 6.1) has it. A version that already builds its filters per request is left
# alone, so the patch is safe to keep after an upgrade.
def _per_request_list_filters() -> None:
    import inspect

    from flask_appbuilder.api import ModelRestApi
    from flask_appbuilder.const import API_FILTERS_RIS_KEY

    try:
        if "self._filters" not in inspect.getsource(ModelRestApi._handle_filters_args):
            return
    except (OSError, TypeError):  # no source to inspect: patch anyway, the replacement is equivalent
        pass

    def _handle_filters_args(self, rison_args):
        filters = self.datamodel.get_filters(search_columns=self.search_columns, search_filters=self.search_filters)
        filters.rest_add_filters(rison_args.get(API_FILTERS_RIS_KEY, []))
        return filters.get_joined_filters(self._base_filters)

    ModelRestApi._handle_filters_args = _handle_filters_args


_per_request_list_filters()


# ClickHouse resolves a SELECT's aliases inside the same SELECT. Up to Superset 6.0, Superset gave every ClickHouse
# column and metric alias a short hash suffix (`SUM(x) AS x_9dd4e4`) and renamed the results back afterwards.
# Superset 6.1 removed the suffix (apache/superset#38280, superset/db_engine_specs/clickhouse.py), so a saved metric
# named like the column it sums (`SUM(x)` saved as `x`) becomes `SUM(x) AS x`, and any other metric in the same chart
# that uses x then sums that alias: ClickHouse refuses with error 184 (ILLEGAL_AGGREGATION). Put the suffix back.
# Results keep their names (Superset renames the columns to the labels it expected), so charts and Lenspack see no
# change. A version that still adds the suffix is left alone. LENSPACK_CLICKHOUSE_LABEL_SUFFIX=off keeps Superset's own.
def lenspack_clickhouse_label_suffix() -> bool:
    """Restores the alias suffix on Superset's ClickHouse engine specs where Superset no longer adds it. True if it did."""
    if os.environ.get("LENSPACK_CLICKHOUSE_LABEL_SUFFIX", "on").strip().lower() in ("off", "false", "0", "no"):
        return False
    try:
        from superset.db_engine_specs.base import BaseEngineSpec
        from superset.db_engine_specs.clickhouse import ClickHouseConnectEngineSpec
    except ImportError:
        return False
    if ClickHouseConnectEngineSpec._mutate_label is not BaseEngineSpec._mutate_label:
        return False  # Superset 5.0 and 6.0 add it themselves

    def _mutate_label(label: str) -> str:
        # As Superset 5.0 wrote it: the label and the first six characters of its MD5. Only a name, not a secret.
        return f"{label}_{hashlib.md5(label.encode('utf-8'), usedforsecurity=False).hexdigest()[:6]}"

    ClickHouseConnectEngineSpec._mutate_label = staticmethod(_mutate_label)
    return True

LENSPACK_PATH = "/lenspack"  # where browsers reach Lenspack: Superset's own route below
LENSPACK_INTERNAL_URL = os.environ.get("LENSPACK_INTERNAL_URL", "http://lenspack:8795").rstrip("/")
LENSPACK_SERVICE_USER = os.environ.get("LENSPACK_SERVICE_USER", "lenspack")
LENSPACK_TEMPLATES = os.environ.get("LENSPACK_TEMPLATES") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates")

# Speech-to-text models measured over OpenRouter with a language hint: word error rate on two sets of French field
# recordings and on FLEURS French and Hindi, and median latency. Help text on the AI assistant page only; replace
# it with your own measurements, or set it to {} to hide the table.
STT_BENCH = {
    "mistralai/voxtral-mini-transcribe-3-0": ("6.4%", "9.1%", "3.5%", "8.2%", "0.67 s"),
    "assemblyai/universal-3-6-pro": ("6.6%", "8.5%", "3.9%", "9.4%", "0.37 s"),
    "deepgram/nova-3": ("5.1%", "8.6%", "7.5%", "14.0%", "0.65 s"),
    "elevenlabs/scribe-v2": ("7.5%", "8.6%", "3.0%", "11.7%", "0.75 s"),
    "google/chirp-3": ("6.4%", "9.6%", "3.9%", "7.8%", "1.91 s"),
    "google/gemini-3.5-transcribe": ("7.7%", "8.6%", "3.4%", "7.4%", "2.31 s"),
    "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b": ("7.5%", "11.1%", "12.1%", "13.3%", "1.33 s"),
    "openai/gpt-4o-mini-transcribe": ("10.3%", "14.6%", "4.2%", "13.6%", "0.85 s"),
    "openai/gpt-transcribe": ("5.5%", "8.2%", "3.7%", "10.4%", "0.84 s"),
    "openai/whisper-large-v3-turbo": ("9.2%", "13.9%", "7.9%", "61.9%", "1.41 s"),
    "qwen/qwen3-asr-1.7b": ("4.0%", "8.6%", "4.2%", "13.7%", "0.80 s"),
}


# Who is asking, signed for Lenspack (packages/hosts/superset/src/identity.ts verifies it): base64url(JSON) "."
# HMAC-SHA256 hex. The key is derived from SECRET_KEY, so rotating SECRET_KEY rotates it (restart Lenspack).
def lenspack_identity_key() -> str:
    from flask import current_app

    secret = current_app.config["SECRET_KEY"]
    return hmac.new(secret.encode() if isinstance(secret, str) else secret, b"lenspack-identity-v1", hashlib.sha256).hexdigest()


def lenspack_sign(user: str, admin: bool, dashboard=None, can_edit=None, can_view=None, roles=None, pack=None) -> str:
    claims = {"u": user, "a": bool(admin), "t": int(time.time())}
    if roles is not None:
        claims["r"] = sorted(roles)
    if dashboard is not None:
        # b: the board these rights are for; Lenspack refuses the request when its own route names another board or pack.
        claims.update({"d": dashboard, "b": f"superset-{dashboard}", "e": bool(can_edit), "v": bool(can_view)})
        if pack is not None:
            claims["p"] = pack
    body = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode()
    return body + "." + hmac.new(lenspack_identity_key().encode(), body.encode(), hashlib.sha256).hexdigest()


_DOT_SEGMENTS = {".", ".."}
# Left after Flask decoded the path once, these were encoded twice: an encoded dot, slash or backslash.
_ENCODED = re.compile(r"%(?:2e|2f|5c)", re.IGNORECASE)
_DASHBOARD_BOARD = re.compile(r"superset-(\d+)")


def lenspack_route(path: str):
    """The path to forward to Lenspack, and the dashboard board in it, read the way Lenspack's board API reads a
    path: api/<pack>/<board>/<action>, the board at the third place. None when the path is not forwarded at all:
    a "." or ".." segment (Lenspack would resolve it and act on another board than the one checked here), an
    encoded dot, slash or backslash still there after Flask's decoding, or a backslash.
    Paths under api/_<name>/ (the usage page, speech to text) are about no dashboard."""
    if "\\" in path or _ENCODED.search(path):
        return None
    parts = path.split("/")
    if any(p in _DOT_SEGMENTS for p in parts):
        return None
    route = {"path": path, "pack": None, "dashboard": None}
    if len(parts) >= 3 and parts[0] == "api" and parts[1] and not parts[1].startswith("_"):
        m = _DASHBOARD_BOARD.fullmatch(parts[2])
        if m:
            route.update(pack=parts[1], dashboard=int(m.group(1)))
    return route


def lenspack_rls_clauses(filters, render) -> list:
    """RLS filters as Superset applies them: each rendered; a group key's clauses ORed, the rest and the groups ANDed."""
    clauses, groups = [], {}
    for f in filters:
        clause = render(f.clause)
        if f.group_key:
            groups.setdefault(f.group_key, []).append(clause)
        else:
            clauses.append(clause)
    return clauses + [g[0] if len(g) == 1 else " OR ".join(f"({c})" for c in g) for g in groups.values()]


def lenspack_dataset_access(user, ids) -> dict:
    """Per dataset id: may this user read it, and its RLS clauses for them. A missing dataset is not readable."""
    from superset.connectors.sqla.models import SqlaTable
    from superset.extensions import db, security_manager
    from superset.jinja_context import get_template_processor
    from superset.utils.core import override_user

    out = {}
    with override_user(user):
        for ds_id in ids:
            ds = db.session.query(SqlaTable).filter_by(id=ds_id).one_or_none()
            if ds is None or not security_manager.can_access_datasource(ds):
                out[str(ds_id)] = {"access": False, "rls": []}
                continue
            processor = get_template_processor(database=ds.database, table=ds)
            out[str(ds_id)] = {"access": True, "rls": lenspack_rls_clauses(security_manager.get_rls_filters(ds), processor.process_template)}
    return out


def lenspack_dashboard_access(user, ids) -> dict:
    """Per dashboard id: may this user open it (Superset's own check: owners, admins, dashboard roles, dataset
    access). A missing dashboard may not be opened."""
    from superset.extensions import db, security_manager
    from superset.models.dashboard import Dashboard
    from superset.utils.core import override_user

    out = {}
    with override_user(user):
        for dash_id in ids:
            dash = db.session.query(Dashboard).filter_by(id=dash_id).one_or_none()
            out[str(dash_id)] = bool(dash is not None and security_manager.can_access_dashboard(dash))
    return out


def superset_version(app) -> str:
    """Superset's version as it reports it (VERSION_STRING), e.g. "6.1.0"; "" when unknown."""
    return str(app.config.get("VERSION_STRING") or "")


def lenspack_settings_layout(app) -> str:
    """The page the AI assistant settings extend. Superset 5 draws its menu bar on the server
    (superset/basic.html and its appbuilder/baselayout.html), so the page sits in it. Superset 6 draws every page
    in its frontend and ships no server-side layout: Flask-AppBuilder's stock one would show an unstyled menu of
    its own, so the page has a plain layout of its own instead, with a way back to Superset."""
    from jinja2 import TemplateNotFound

    try:
        app.jinja_env.get_template("superset/basic.html")
        return "appbuilder/base.html"
    except TemplateNotFound:
        return "lenspack/layout.html"


# Flash categories of the settings page's own messages: the page shows only these, not a message another part
# of Superset left in the session (Superset 6 leaves an "Access is Denied" from signing in, which its frontend
# never shows).
FLASH_OK, FLASH_BAD = "lenspack-info", "lenspack-danger"


def lenspack_app_mutator(app):
    import urllib.error
    import urllib.request
    from urllib.parse import urlparse

    import requests
    from flask import Response, abort, flash, g, jsonify, redirect, request, stream_with_context
    from flask_appbuilder import BaseView, expose
    from flask_appbuilder.security.decorators import has_access
    from jinja2 import ChoiceLoader, DictLoader, FileSystemLoader

    from superset.extensions import appbuilder, csrf, db, security_manager

    # The templates live in this file; a LENSPACK_TEMPLATES folder (if it exists) wins over them.
    loaders = [DictLoader({"tail_js_custom_extra.html": TAIL_JS, "lenspack/settings.html": SETTINGS_HTML, "lenspack/layout.html": LAYOUT_HTML}), app.jinja_loader]
    if os.path.isdir(LENSPACK_TEMPLATES):
        loaders.insert(0, FileSystemLoader(LENSPACK_TEMPLATES))
    app.jinja_loader = ChoiceLoader(loaders)
    settings_layout = lenspack_settings_layout(app)
    lenspack_clickhouse_label_suffix()

    def is_admin(user) -> bool:
        return any(r.name == security_manager.auth_role_admin for r in getattr(user, "roles", []) or [])

    def role_names(user) -> list:
        return [r.name for r in getattr(user, "roles", []) or []]

    # --- Rights on one dashboard, as Superset decides them ------------------------------------------
    # View: Superset's dashboard access check. Edit: what Superset's own dashboard API requires, an owner
    # (admins count as owners) with can_write on Dashboard.
    def dashboard_rights(id_or_slug):
        from superset.models.dashboard import Dashboard, id_or_slug_filter

        key = str(id_or_slug).strip()
        if not key:
            return None
        # As Superset's own API reads it: digits are an id, never a slug, so "5" cannot pick a dashboard whose slug is 5.
        dash = db.session.query(Dashboard).filter(id_or_slug_filter(key)).one_or_none()
        if dash is None:
            return None
        can_view = bool(security_manager.can_access_dashboard(dash))
        can_edit = can_view and security_manager.is_owner(dash) and (security_manager.is_admin() or security_manager.can_access("can_write", "Dashboard"))
        return {"id": dash.id, "view": can_view, "edit": bool(can_edit)}

    HOP ={"connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization"}

    # --- /lenspack/...: Superset forwards to Lenspack -------------------------------------------------
    def lenspack_proxy(path=""):
        user = g.user if getattr(g, "user", None) is not None else None
        if user is None or not getattr(user, "is_authenticated", False) or getattr(user, "is_anonymous", True):
            return jsonify({"error": "sign in to Superset first"}), 401
        # No CSRF token on these calls (the chat is a script on Superset's own pages): refuse a change sent from
        # another site instead. Browsers send Sec-Fetch-Site / Origin with every cross-site POST.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            site = request.headers.get("Sec-Fetch-Site")
            origin = request.headers.get("Origin")
            if (site and site not in ("same-origin", "none")) or (origin and urlparse(origin).netloc != request.host):
                return jsonify({"error": "cross-site request refused"}), 403
        # The dashboard this request is about: the board "superset-<id>" where Lenspack reads a board, or ?dashboard=
        # when binding. A path Lenspack would read differently (a dot segment, an encoded slash) is not forwarded.
        route = lenspack_route(path)
        if route is None:
            return jsonify({"error": "a path with a dot segment or an encoded slash is not accepted"}), 400
        path = route["path"]
        if route["dashboard"] is not None:
            wanted = str(route["dashboard"])
        else:
            wanted = request.args.get("dashboard") if path == "_superset/bind" else None
        rights = dashboard_rights(wanted) if wanted else None
        if rights and not rights["view"]:
            return jsonify({"error": "You don't have access to this dashboard in Superset."}), 403
        admin = is_admin(user)
        roles = role_names(user)
        headers = {
            "x-lenspack-identity": lenspack_sign(user.username, admin, rights["id"], rights["edit"], rights["view"], roles, pack=route["pack"]) if rights else lenspack_sign(user.username, admin, roles=roles),
            "x-forwarded-proto": request.scheme,
            "x-forwarded-host": request.host,
            "x-forwarded-prefix": LENSPACK_PATH,
        }
        for h in ("content-type", "accept", "accept-language"):
            if request.headers.get(h):
                headers[h] = request.headers[h]
        try:
            upstream = requests.request(
                request.method,
                f"{LENSPACK_INTERNAL_URL}/{path}",
                params=request.query_string,
                data=request.get_data() if request.method not in ("GET", "HEAD") else None,
                headers=headers,
                stream=True,
                allow_redirects=False,
                timeout=(5, 300),
            )
        except requests.RequestException as e:
            return jsonify({"error": f"Lenspack is not reachable: {type(e).__name__}"}), 502

        def body():
            try:
                for chunk in upstream.iter_content(chunk_size=None):
                    yield chunk
            finally:
                upstream.close()

        out = [(k, v) for k, v in upstream.headers.items() if k.lower() not in HOP]
        # Chat replies stream: no buffering in a proxy in front of Superset, no compression here.
        out += [("X-Accel-Buffering", "no"), ("Cache-Control", upstream.headers.get("cache-control", "no-store"))]
        return Response(stream_with_context(body()), status=upstream.status_code, headers=out, direct_passthrough=True)

    methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]
    app.add_url_rule(LENSPACK_PATH + "/", "lenspack_proxy_root", lenspack_proxy, methods=methods, defaults={"path": ""})
    app.add_url_rule(LENSPACK_PATH + "/<path:path>", "lenspack_proxy", lenspack_proxy, methods=methods)
    csrf.exempt(lenspack_proxy)

    # --- What Lenspack calls on start (a JWT from /api/v1/security/login) -----------------------------
    def api_user():
        from flask_jwt_extended import get_jwt_identity, verify_jwt_in_request

        try:
            verify_jwt_in_request()
        except Exception:
            return None
        ident = get_jwt_identity()
        try:
            return security_manager.get_user_by_id(int(ident))
        except (TypeError, ValueError):
            return security_manager.find_user(username=str(ident))

    def identity_key_view():
        user = api_user()
        if user is None:
            return jsonify({"message": "sign in with a token"}), 401
        if not (is_admin(user) or user.username == LENSPACK_SERVICE_USER):
            return jsonify({"message": f"only admins and {LENSPACK_SERVICE_USER} may read this"}), 403
        return jsonify({"result": {"key": lenspack_identity_key()}})

    # Lenspack's own account, made (or its password reset) by an admin's token. It edits dashboards it
    # doesn't own, which Superset allows only owners and admins, so it gets the Admin role; who may edit
    # what through the chat is decided per user, per dashboard, by the identity header above.
    def bootstrap_view():
        user = api_user()
        if user is None:
            return jsonify({"message": "sign in with a token"}), 401
        if not is_admin(user):
            return jsonify({"message": "only admins may make Lenspack's account"}), 403
        body = request.get_json(silent=True) or {}
        username, password = str(body.get("username") or ""), str(body.get("password") or "")
        if username != LENSPACK_SERVICE_USER:
            return jsonify({"message": f"the account must be {LENSPACK_SERVICE_USER} (LENSPACK_SERVICE_USER)"}), 400
        if len(password) < 24:
            return jsonify({"message": "password too short"}), 400
        role = security_manager.find_role(security_manager.auth_role_admin)
        existing = security_manager.find_user(username=username)
        if existing:
            security_manager.reset_password(existing.id, password)
            if role not in existing.roles:
                existing.roles.append(role)
                security_manager.update_user(existing)
            made = "reset"
        else:
            if not security_manager.add_user(username, "Lenspack", "Service", f"{username}@lenspack.invalid", role, password=password):
                return jsonify({"message": "Superset could not create the account"}), 500
            made = "created"
        return jsonify({"result": {"username": username, "account": made}})

    # What one user may read, as Superset decides it for them: the datasets their roles may access, and the
    # row-level security clauses on each, rendered as that user (Jinja such as current_username() included), and
    # the dashboards they may open. Lenspack reads data as its own account, so it narrows each user's queries by
    # this, and lists them only the dashboards they may open (hostPolicy: superset).
    def access_view():
        caller = api_user()
        if caller is None:
            return jsonify({"message": "sign in with a token"}), 401
        if not (is_admin(caller) or caller.username == LENSPACK_SERVICE_USER):
            return jsonify({"message": f"only admins and {LENSPACK_SERVICE_USER} may read this"}), 403
        target = security_manager.find_user(username=request.args.get("user") or "")
        if target is None:
            return jsonify({"message": "no such user"}), 404
        def ids(name):
            return [int(x) for x in (request.args.get(name) or "").split(",") if x.strip().isdigit()][:500]

        return jsonify({"result": {"datasets": lenspack_dataset_access(target, ids("datasets")), "dashboards": lenspack_dashboard_access(target, ids("dashboards"))}})

    # Superset's version, for what differs between 5 and 6 on Lenspack's side (the default basemap of maps).
    # Superset 6.1 has its own /version, 5.x and 6.0 do not.
    def version_view():
        user = api_user()
        if user is None:
            return jsonify({"message": "sign in with a token"}), 401
        if not (is_admin(user) or user.username == LENSPACK_SERVICE_USER):
            return jsonify({"message": f"only admins and {LENSPACK_SERVICE_USER} may read this"}), 403
        return jsonify({"result": {"superset": superset_version(app)}})

    app.add_url_rule("/api/v1/lenspack/identity-key", "lenspack_identity_key", identity_key_view, methods=["GET"])
    app.add_url_rule("/api/v1/lenspack/version", "lenspack_version", version_view, methods=["GET"])
    app.add_url_rule("/api/v1/lenspack/access", "lenspack_access", access_view, methods=["GET"])
    app.add_url_rule("/api/v1/lenspack/bootstrap", "lenspack_bootstrap", bootstrap_view, methods=["POST"])

    # --- Settings → Manage → AI assistant ---------------------------------------------------------------
    def call(method, path, body=None):
        """Lenspack's settings API, as the signed-in admin."""
        req = urllib.request.Request(
            LENSPACK_INTERNAL_URL + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={"content-type": "application/json", "x-lenspack-identity": lenspack_sign(g.user.username, True, roles=role_names(g.user))},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.load(r), None
        except urllib.error.HTTPError as e:
            try:
                return None, json.load(e).get("error") or f"HTTP {e.code}"
            except Exception:
                return None, f"HTTP {e.code}"
        except Exception as e:  # unreachable, not JSON: say so on the page
            return None, f"{type(e).__name__}: {str(e)[:160]}"

    def saved(what, result):
        _data, error = result
        flash(f"{what} saved." if error is None else f"{what} not saved: {error}", FLASH_OK if error is None else FLASH_BAD)
        return redirect("/ai-assistant/")

    class LenspackSettingsView(BaseView):
        route_base = "/ai-assistant"
        default_view = "index"
        # The forms below use the page's own permission (can_index), so no new permissions to sync.
        method_permission_name = {"index": "index", "chat": "index", "speech": "index", "speech_hold": "index", "language": "index", "features": "index"}

        @expose("/")
        @has_access
        def index(self):
            if not security_manager.is_admin():
                abort(403)
            from superset.models.core import Database

            settings, settings_error = call("GET", "/_superset/settings")
            stt_models = None
            if settings and settings.get("speech"):
                stt_models, _ = call("GET", "/_superset/settings/speech/models")
            info = None
            if settings is None:
                info, _ = call("GET", "/_superset/info")
            usage, usage_error = call("GET", "/api/_usage")
            audit, audit_error = call("GET", "/_superset/audit?limit=20")
            # What each answer cost, from the audit log (absent on a Lenspack without /_superset/turns: the card hides).
            turns, _ = call("GET", "/_superset/turns?limit=50")
            databases = [
                {"name": d.database_name, "backend": d.backend, "uri": d.sqlalchemy_uri, "datasets": len(d.tables)}  # URI password already masked
                for d in db.session.query(Database).order_by(Database.database_name)
            ]
            account = security_manager.find_user(username=(settings or {}).get("superset", {}).get("username") or LENSPACK_SERVICE_USER)
            return self.render_template(
                "lenspack/settings.html",
                settings=settings, settings_error=settings_error, info=info, usage=usage, usage_error=usage_error,
                audit=audit, audit_error=audit_error, turns=turns, databases=databases,
                account_roles=[r.name for r in account.roles] if account else None,
                internal_url=LENSPACK_INTERNAL_URL, stt_models=stt_models, stt_bench=STT_BENCH,
                lp_layout=settings_layout, lp_flash=[FLASH_OK, FLASH_BAD],
            )

        # Forms on the page. Admin only, Superset's CSRF token required (Flask-WTF checks every POST).
        @expose("/chat", methods=["POST"])
        @has_access
        def chat(self):
            if not security_manager.is_admin():
                abort(403)
            if request.form.get("reset"):
                return saved("Chat model", call("PUT", "/_superset/settings/chat", {"model": None}))
            model, _, effort = request.form.get("choice", "").partition("|")
            return saved("Chat model", call("PUT", "/_superset/settings/chat", {"model": model, "effort": effort or None}))

        @expose("/speech", methods=["POST"])
        @has_access
        def speech(self):
            if not security_manager.is_admin():
                abort(403)
            model = None if request.form.get("reset") else request.form.get("model", "")
            return saved("Speech-to-text model", call("PUT", "/_superset/settings/speech", {"model": model}))

        @expose("/speech-hold", methods=["POST"])
        @has_access
        def speech_hold(self):
            if not security_manager.is_admin():
                abort(403)
            if request.form.get("reset"):
                return saved("Space-bar hold", call("PUT", "/_superset/settings/speech", {"holdMs": None}))
            try:
                hold = int(request.form.get("holdMs", ""))
            except ValueError:
                flash("Space-bar hold: enter a whole number of milliseconds.", FLASH_BAD)
                return redirect("/ai-assistant/")
            return saved("Space-bar hold", call("PUT", "/_superset/settings/speech", {"holdMs": hold}))

        @expose("/language", methods=["POST"])
        @has_access
        def language(self):
            if not security_manager.is_admin():
                abort(403)
            if request.form.get("reset"):
                body = {"default": None, "titles": None, "board": None}
            else:
                body = {k: request.form[k] for k in ("default", "titles", "board") if request.form.get(k)}
            return saved("Chat language", call("PUT", "/_superset/settings/language", body))

        @expose("/features", methods=["POST"])
        @has_access
        def features(self):
            if not security_manager.is_admin():
                abort(403)
            current, error = call("GET", "/_superset/settings")
            ft = (current or {}).get("features")
            if not ft:
                flash(f"Off switches not saved: {error or 'this Lenspack has no off switches'}", FLASH_BAD)
                return redirect("/ai-assistant/")
            keys = [o["key"] for o in ft["options"]]
            if request.form.get("reset"):
                body = {k: None for k in keys}
            else:
                # Only what changed: a switch left alone keeps its source (config, LENSPACK_FEATURES).
                body = {k: request.form.get(k) == "on" for k in keys if (request.form.get(k) == "on") != ft["values"][k]}
                if not body:
                    flash("Off switches: nothing changed.", FLASH_OK)
                    return redirect("/ai-assistant/")
            return saved("Off switches", call("PUT", "/_superset/settings/features", body))

    appbuilder.add_view_no_menu(LenspackSettingsView)
    appbuilder.add_link("AI assistant", label="AI assistant", href="/ai-assistant/", icon="fa-comments", category="Manage", cond=lambda: security_manager.is_admin())


FLASK_APP_MUTATOR = lenspack_app_mutator


# Superset includes this at the end of every page and documents it as overridable.
TAIL_JS = r'''{# The "Ask Lenspack" button: one small script on every page, for signed-in users. With Talisman on it carries the page's CSP nonce.
   It loads /lenspack/overlay.js; while Lenspack is restarting (a 5xx or no answer) it tries again after 1, 2, 4… s, at most 30 s apart,
   while the tab is visible. Signed out or refused (another 4xx): it stops. Once loaded, the overlay handles restarts itself. #}
{% if current_user.is_authenticated %}{% set lp_nonce = csp_nonce() if csp_nonce is defined else "" %}
<script{% if lp_nonce %} nonce="{{ lp_nonce }}"{% endif %}>
(function () {
  var wait = 1000;
  function load() {
    var s = document.createElement("script");
    s.src = "/lenspack/overlay.js";
    s.onerror = function () {
      s.remove();
      fetch("/lenspack/healthz", { cache: "no-store" })
        .then(function (r) { return r.status; }, function () { return 0; })
        .then(function (status) {
          if (status >= 400 && status < 500 && status !== 429) return;
          setTimeout(whenVisible, wait);
          wait = Math.min(wait * 2, 30000);
        });
    };
    document.body.appendChild(s);
  }
  function whenVisible() {
    if (!document.hidden) return load();
    document.addEventListener("visibilitychange", function shown() {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", shown);
      load();
    });
  }
  load();
})();
</script>
{% endif %}
'''

# Settings → Manage → AI assistant.
SETTINGS_HTML = r"""{# Settings → Manage → AI assistant. What Lenspack runs with and Superset's data connections. Never shows a secret.
   lp_layout: Superset 5's own layout, or on Superset 6 lenspack/layout.html (light or dark, as Superset is). #}
{% extends lp_layout | default("appbuilder/base.html") %}
{% block title %}AI assistant · Settings{% endblock %}
{# Only this page's own messages, below; not whatever else Superset left in the session. #}
{% block messages %}{% endblock %}
{% block content %}
<style>
  .lp-wrap{--lp-fg:#1f2328;--lp-mute:#667085;--lp-card:#fff;--lp-line:#e4e7ec;--lp-line2:#f0f2f5;--lp-code:#f5f7fa;--lp-acc:#1a85a0;--lp-ok:#067647;--lp-bad:#b42318;--lp-okbg:#ecfdf3;--lp-badbg:#fef3f2;--lp-input:#fff;--lp-inline:#d0d5dd;
    max-width:1040px;margin:24px auto;padding:0 16px;font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--lp-fg)}
  [data-lp-theme=dark] .lp-wrap{--lp-fg:#e6e8eb;--lp-mute:#98a2b3;--lp-card:#1b1d21;--lp-line:#343842;--lp-line2:#2a2e35;--lp-code:#262a31;--lp-acc:#3fb1cc;--lp-ok:#47cd89;--lp-bad:#f97066;--lp-okbg:rgba(71,205,137,.12);--lp-badbg:rgba(249,112,102,.12);--lp-input:#14161a;--lp-inline:#3a3f48}
  .lp-wrap h1{font-size:22px;margin:0 0 4px}
  .lp-wrap .lede{color:var(--lp-mute);margin:0 0 20px}
  .lp-card{background:var(--lp-card);border:1px solid var(--lp-line);border-radius:8px;padding:16px 18px;margin:0 0 16px}
  .lp-card h2{font-size:15px;margin:0 0 10px}
  .lp-wrap table{border-collapse:collapse;width:100%}
  .lp-wrap th,.lp-wrap td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--lp-line2);vertical-align:top}
  .lp-wrap th{color:var(--lp-mute);font-weight:500;width:220px}
  .lp-wrap code{background:var(--lp-code);color:inherit;border-radius:4px;padding:1px 5px;font-size:12.5px}
  .lp-wrap .ok{color:var(--lp-ok)}.lp-wrap .bad{color:var(--lp-bad)}.lp-wrap .mute{color:var(--lp-mute)}
  .lp-wrap a{color:var(--lp-acc)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .lp-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 0}
  .lp-form select,.lp-form input[type=number]{padding:6px 8px;border:1px solid var(--lp-inline);border-radius:6px;background:var(--lp-input);color:var(--lp-fg);font:inherit}
  .lp-form select{min-width:280px;max-width:100%}
  .lp-form button{padding:6px 14px;border-radius:6px;border:1px solid #1a85a0;background:#1a85a0;color:#fff;font:inherit;cursor:pointer}
  .lp-form button.ghost{background:transparent;color:var(--lp-acc);border-color:var(--lp-acc)}
  .lp-form button[disabled]{opacity:.5;cursor:not-allowed}
  .lp-flash{padding:8px 12px;border-radius:6px;margin:0 0 12px}
  .lp-flash.info{background:var(--lp-okbg);color:var(--lp-ok)}.lp-flash.danger{background:var(--lp-badbg);color:var(--lp-bad)}
  .bench{font-variant-numeric:tabular-nums}
  .bench td,.bench th{padding:3px 8px!important;font-size:12.5px}
  @media (max-width:820px){.grid2{grid-template-columns:1fr}.lp-wrap th{width:auto}}
</style>
<div class="lp-wrap">
  <h1>AI assistant</h1>
  <p class="lede">Lenspack adds a chat to Superset dashboards: the <b>Ask Lenspack</b> button on a dashboard.
    Models are chosen here; the rest comes from Lenspack's config file and environment. This page never shows a secret.</p>

  {% for category, message in get_flashed_messages(with_categories=true, category_filter=lp_flash or ["lenspack-info", "lenspack-danger"]) %}
    <div class="lp-flash {{ 'danger' if category.endswith('danger') else 'info' }}">{{ message }}</div>
  {% endfor %}

  {% if settings and settings.chat %}{% set c = settings.chat %}
  <div class="lp-card">
    <h2>Chat model</h2>
    <p class="mute" style="margin:0 0 8px">The model that answers in the chat and edits dashboards, for everyone. Applies to the next question; no restart.</p>
    <form class="lp-form" method="post" action="/ai-assistant/chat">
      <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
      <select name="choice" aria-label="Chat model" {% if not c.writable %}disabled{% endif %}>
        {% for p in c.options %}
          {% if p.efforts %}
            <optgroup label="{{ p.name }} ({{ p.model }}){% if p.available is sameas false %}: not answering{% endif %}">
              {% for e in p.efforts.levels %}
                <option value="{{ p.name }}|{{ e }}" {% if p.name == c.model and e == c.effort %}selected{% endif %} {% if p.available is sameas false %}disabled{% endif %}>{{ p.name }} · {{ e }} effort{% if e == p.efforts.default %} (its default){% endif %}</option>
              {% endfor %}
            </optgroup>
          {% else %}
            <option value="{{ p.name }}|" {% if p.name == c.model %}selected{% endif %} {% if p.available is sameas false %}disabled{% endif %}>{{ p.name }} ({{ p.model }}){% if p.available is sameas false %}: not answering{% endif %}</option>
          {% endif %}
        {% endfor %}
      </select>
      <button type="submit" {% if not c.writable %}disabled{% endif %}>Save</button>
      {% if c.source == 'settings' %}<button class="ghost" type="submit" name="reset" value="1" {% if not c.writable %}disabled{% endif %}>Back to default ({{ c.defaultModel }})</button>{% endif %}
    </form>
    <p class="mute" style="margin:8px 0 0">Now: <b>{{ c.model or 'none' }}</b>{% if c.effort %} · {{ c.effort }} effort{% endif %} · {{ 'chosen here' if c.source == 'settings' else 'the deployment default' }}.
      Models come from the configured keys{% if settings.llmFrom %} (<code>{{ settings.llmFrom }}</code>){% endif %}; adding an OpenRouter key adds its models.</p>
    {% if not c.writable %}<p class="bad" style="margin:6px 0 0">Read-only: Lenspack has no identity key from Superset yet (restart Lenspack once Superset is up).</p>{% endif %}
  </div>
  {% endif %}

  {% if settings %}
  <div class="lp-card">
    <h2>Speech to text</h2>
    {% if settings.speech %}{% set sp = settings.speech %}
      <p class="mute" style="margin:0 0 8px">Turns the chat's microphone recordings into text.
        {% if sp.enabled %}Key from <code>{{ sp.keyFrom }}</code> (value never shown).{% else %}<span class="bad">No key set (<code>OPENROUTER_API_KEY</code>): the microphone is hidden.</span>{% endif %}</p>
      <form class="lp-form" method="post" action="/ai-assistant/speech">
        <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
        <select name="model" aria-label="Speech-to-text model" {% if not sp.writable %}disabled{% endif %}>
          {% set ids = (stt_models or [])|map(attribute='id')|list %}
          {% for m in (stt_models or []) %}
            <option value="{{ m.id }}" {% if m.id == sp.model %}selected{% endif %}>{{ m.name or m.id }}{% if m.id in stt_bench %} · WER {{ stt_bench[m.id][0] }} / {{ stt_bench[m.id][2] }} fr / {{ stt_bench[m.id][3] }} hi · {{ stt_bench[m.id][4] }}{% endif %}{% if m.usdPerMinute %} · ${{ m.usdPerMinute }}/min{% endif %}</option>
          {% endfor %}
          {% if sp.model not in ids %}<option value="{{ sp.model }}" selected>{{ sp.model }}</option>{% endif %}
        </select>
        <button type="submit" {% if not sp.writable %}disabled{% endif %}>Save</button>
        {% if sp.source == 'settings' %}<button class="ghost" type="submit" name="reset" value="1" {% if not sp.writable %}disabled{% endif %}>Back to default ({{ sp.defaultModel }})</button>{% endif %}
      </form>
      {% if sp.defaultHoldMs is defined %}
        {% set rng = sp.holdMsRange if sp.holdMsRange is defined and sp.holdMsRange else [500, 3000] %}
        {% set lo = rng.min if rng is mapping else rng[0] %}{% set hi = rng.max if rng is mapping else rng[1] %}
        <form class="lp-form" method="post" action="/ai-assistant/speech-hold" style="margin-top:8px">
          <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
          <label class="mute" for="lp-hold">Hold the space bar for</label>
          <input id="lp-hold" type="number" name="holdMs" min="{{ lo }}" max="{{ hi }}" step="100" value="{{ sp.holdMs or sp.defaultHoldMs }}" style="width:90px" {% if not sp.writable %}disabled{% endif %}>
          <span class="mute">ms to start recording ({{ lo }}–{{ hi }}; default {{ sp.defaultHoldMs }})</span>
          <button type="submit" {% if not sp.writable %}disabled{% endif %}>Save</button>
          {% if sp.holdMs is not none and sp.holdMs != sp.defaultHoldMs %}<button class="ghost" type="submit" name="reset" value="1" {% if not sp.writable %}disabled{% endif %}>Back to default</button>{% endif %}
        </form>
      {% endif %}
      {% if stt_bench %}<details style="margin-top:8px"><summary class="mute">Measured word error rate (with a language hint) and median latency</summary>
        <table class="bench"><tr><th>Model</th><th>Field fr A</th><th>Field fr B</th><th>FLEURS fr</th><th>FLEURS hi</th><th>Latency</th></tr>
          {% for id, r in stt_bench|dictsort %}<tr><td><code>{{ id }}</code>{% if id == sp.model %} <b>(current)</b>{% endif %}</td><td>{{ r[0] }}</td><td>{{ r[1] }}</td><td>{{ r[2] }}</td><td>{{ r[3] }}</td><td>{{ r[4] }}</td></tr>{% endfor %}
        </table></details>{% endif %}
    {% else %}
      <p class="mute">Speech-to-text isn't installed in this Lenspack build.</p>
    {% endif %}
  </div>

  {% if settings.language %}{% set lg = settings.language %}
  {% set names = {'auto': 'Follow the person (Superset language / browser)', 'en': 'English', 'fr': 'French', 'hi': 'Hindi', 'pt': 'Portuguese', "board": "The board's language", 'speaker': 'The language of the question'} %}
  {% set opts = lg.options if lg.options is mapping else {} %}
  <div class="lp-card">
    <h2>Chat language</h2>
    <form class="lp-form" method="post" action="/ai-assistant/language">
      <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
      <label>Replies in <select name="default" {% if not lg.writable %}disabled{% endif %}>{% for o in (opts.default or ['auto', 'en', 'fr', 'hi', 'pt']) %}<option value="{{ o }}" {% if o == lg.default %}selected{% endif %}>{{ names.get(o, o) }}</option>{% endfor %}</select></label>
      <label>Chart titles in <select name="titles" {% if not lg.writable %}disabled{% endif %}>{% for o in (opts.titles or ['board', 'speaker']) %}<option value="{{ o }}" {% if o == lg.titles %}selected{% endif %}>{{ names.get(o, o) }}</option>{% endfor %}</select></label>
      <label>Board language <select name="board" {% if not lg.writable %}disabled{% endif %}>{% for o in (opts.board or ['en', 'fr', 'hi', 'pt']) %}<option value="{{ o }}" {% if o == lg.board %}selected{% endif %}>{{ names.get(o, o) }}</option>{% endfor %}</select></label>
      <button type="submit" {% if not lg.writable %}disabled{% endif %}>Save</button>
      {% if lg.source == 'settings' %}<button class="ghost" type="submit" name="reset" value="1" {% if not lg.writable %}disabled{% endif %}>Back to defaults</button>{% endif %}
    </form>
  </div>
  {% endif %}

  {% if settings.features %}{% set ft = settings.features %}
  {% set from = {'config': 'set in the Lenspack config file', 'env': 'set by LENSPACK_FEATURES', 'settings': 'set on this page'} %}
  <div class="lp-card">
    <h2>Off switches</h2>
    <p class="mute">Turn parts of the assistant off for everyone. A change applies to the next dashboard each person opens.</p>
    <form class="lp-form" method="post" action="/ai-assistant/features">
      <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
      <table>
      {% for o in ft.options %}{% set src = ft.source[o.key] %}
        <tr>
          <th><label><input type="checkbox" name="{{ o.key }}" {% if ft['values'][o.key] %}checked{% endif %} {% if not ft.writable %}disabled{% endif %}> {{ o.label }}</label></th>
          <td>{{ o.help }}{% if src != 'default' %} <span class="mute">({{ from.get(src, src) }}{% if src == 'settings' and ft.defaults[o.key] != ft['values'][o.key] %}; the deployment says {{ 'on' if ft.defaults[o.key] else 'off' }}{% endif %})</span>{% endif %}</td>
        </tr>
      {% endfor %}
      </table>
      <button type="submit" {% if not ft.writable %}disabled{% endif %}>Save</button>
      {% if 'settings' in ft.source.values() %}<button class="ghost" type="submit" name="reset" value="1" {% if not ft.writable %}disabled{% endif %}>Back to the deployment's values</button>{% endif %}
    </form>
  </div>
  {% endif %}
  {% endif %}

  <div class="lp-card">
    <h2>Lenspack</h2>
    <table>
      <tr><th>Status</th><td>
        {% if settings %}<span class="ok">● running</span>
        {% elif info %}<span class="ok">● running</span> <span class="mute">(this Lenspack version reports less; update it for the full page)</span>
        {% else %}<span class="bad">● not reachable</span> <span class="mute">{{ settings_error }}</span>{% endif %}
        <span class="mute">· {{ internal_url }}</span>
      </td></tr>
      {% set s = settings or info or {} %}
      {% if s.pack %}<tr><th>Pack</th><td><code>{{ s.pack }}</code></td></tr>{% endif %}
      {% if settings %}
        <tr><th>Datasets it reads</th><td>{% for d in settings.datasets %}<code>{{ d.schema ~ '.' if d.schema }}{{ d.table }}</code> as <b>{{ d.entity }}</b>{% if not loop.last %}<br>{% endif %}{% endfor %}</td></tr>
        <tr><th>Vocabulary</th><td>{{ settings.dimensions }} dimensions, {{ settings.measures|length }} measures
          <details><summary class="mute">measures</summary>{% for m in settings.measures %}<code>{{ m.key }}</code> {{ m.label }} <span class="mute">({{ m.agg }})</span><br>{% endfor %}</details></td></tr>
        <tr><th>Superset account</th><td><code>{{ settings.superset.username }}</code>{% if account_roles is not none %} · roles: {{ account_roles|join(', ') or 'none' }}{% endif %}
          {% if settings.superset.account %}<span class="mute">({{ {'bootstrap': 'made by Lenspack on first start', 'state': 'made by Lenspack; password in its state directory', 'env': 'password from LENSPACK_SUPERSET_PASSWORD'}.get(settings.superset.account, settings.superset.account) }})</span>{% endif %}</td></tr>
        <tr><th>Who may edit dashboards</th><td>{% if settings.editPolicy == 'signed-in' %}Anyone signed in to Superset <span class="mute">(<code>LENSPACK_EDIT_POLICY=signed-in</code>)</span>{% else %}Whoever Superset lets edit that dashboard: its owners with write access, and admins. Everyone who can view it may ask questions. <span class="mute">(<code>LENSPACK_EDIT_POLICY=superset</code>, the default)</span>{% endif %}</td></tr>
        {% if settings.hostPolicy %}<tr><th>Whose access applies to answers</th><td>{% if settings.hostPolicy == 'off' %}<strong>Lenspack's own account, for everyone.</strong> Anyone signed in reads every configured dataset in full, without Superset's dataset permissions or row-level security. <span class="mute">(<code>hostPolicy: off</code>)</span>{% else %}Each user's own Superset access: their dataset permissions, row-level security and the dashboards they may open. <span class="mute">(<code>hostPolicy: superset</code>, the default)</span>{% endif %}</td></tr>{% endif %}
        <tr><th>Dashboards bound</th><td>{{ settings.dashboards|join(', ') or 'none yet (a dashboard binds when the chat opens on it)' }}</td></tr>
      {% elif account_roles is not none %}
        <tr><th>Superset account</th><td><code>lenspack</code> · roles: {{ account_roles|join(', ') or 'none' }}</td></tr>
      {% endif %}
      {% if settings %}<tr><th>Chat opens as</th><td>{{ 'a side panel' if settings.panel == 'dock' else 'a floating window' }} <span class="mute">(default for everyone, set by <code>overlay.panel</code> in the Lenspack config; each person can change it with the gear in the chat)</span></td></tr>{% endif %}
      {% if s.examples %}<tr><th>Example questions</th><td>{% for e in s.examples %}{{ e }}{% if not loop.last %}<br>{% endif %}{% endfor %}</td></tr>{% endif %}
    </table>
  </div>

  <div class="grid2">
    <div class="lp-card">
      <h2>Language models</h2>
      {% if settings %}
        <table>
          <tr><th>Key from</th><td>{% if settings.llmFrom %}<code>{{ settings.llmFrom }}</code> <span class="mute">(environment; the value is never shown)</span>{% else %}<span class="bad">no key set: the chat is off</span>{% endif %}</td></tr>
          {% for p in settings.providers %}
            <tr><th>{{ p.name }}</th><td><code>{{ p.model }}</code> <span class="mute">{{ p.kind }}</span>
              {% if p.available %}<span class="ok">● answering</span>{% elif p.available is sameas false %}<span class="bad">● {{ p.error or 'not answering' }}</span>{% else %}<span class="mute">● not checked yet</span>{% endif %}</td></tr>
          {% endfor %}
        </table>
      {% else %}<p class="mute">Shown once Lenspack reports its settings.</p>{% endif %}
    </div>
    <div class="lp-card">
      <h2>Spend today</h2>
      {% if usage %}
        <table>
          <tr><th>Spent</th><td>${{ '%.4f'|format(usage.budget.spent if usage.budget else usage.total.usd) }}{% if usage.budget and usage.budget.usdPerDay %} of ${{ usage.budget.usdPerDay }} a day{% endif %}</td></tr>
          {% if usage.budget and usage.budget.usdPerUserPerDay %}<tr><th>Per person</th><td>${{ usage.budget.usdPerUserPerDay }} a day</td></tr>{% endif %}
          <tr><th>Chat turns</th><td>{{ usage.total.turns }}</td></tr>
          <tr><th>Model calls</th><td>{{ usage.total.calls }}{% if usage.total.failed %} <span class="bad">({{ usage.total.failed }} failed)</span>{% endif %}</td></tr>
          <tr><th>Tokens</th><td>{{ usage.total.inputTokens }} in, {{ usage.total.outputTokens }} out</td></tr>
        </table>
      {% else %}<p class="mute">Not available: {{ usage_error }}</p>{% endif %}
    </div>
  </div>

  {% if turns and turns.enabled %}
  <div class="lp-card">
    <h2>Cost per answer</h2>
    <p class="mute" style="margin:0 0 8px">What each chat answer cost: every model call it made (chat steps and the reviewer) plus speech to text when the question was spoken. {{ turns.estimate }} Read from the audit log, so it survives restarts.{% if settings and settings.features and settings.features.values.turnCost is sameas false %} The cost line in the chat is turned off (Off switches); costs are still recorded here.{% endif %}</p>
    <table>
      <tr><th>Today (UTC)</th><td>≈ ${{ '%.4f'|format(turns.today.costUsd) }} for {{ turns.today.turns }} answer{{ '' if turns.today.turns == 1 else 's' }}{% if turns.today.sttUsd %} <span class="mute">(speech to text ${{ '%.4f'|format(turns.today.sttUsd) }})</span>{% endif %} · {{ '{:,}'.format(turns.today.tokensIn) }} tokens in, {{ '{:,}'.format(turns.today.tokensOut) }} out</td></tr>
      <tr><th>Last 7 days</th><td>≈ ${{ '%.4f'|format(turns.week.costUsd) }} for {{ turns.week.turns }} answer{{ '' if turns.week.turns == 1 else 's' }}{% if turns.week.sttUsd %} <span class="mute">(speech to text ${{ '%.4f'|format(turns.week.sttUsd) }})</span>{% endif %} · {{ '{:,}'.format(turns.week.tokensIn) }} tokens in, {{ '{:,}'.format(turns.week.tokensOut) }} out{% if turns.week.unpriced %} <span class="mute">({{ turns.week.unpriced }} unpriced calls not counted)</span>{% endif %}</td></tr>
    </table>
    {% if turns.recent %}
    <details open><summary class="mute">Recent answers (newest first, last {{ turns.recent|length }})</summary>
      <table class="lp-turns">
        <tr><th>Time (UTC)</th><th>User</th><th>Dashboard</th><th>Model</th><th>Tokens in / out</th><th>Cost</th></tr>
        {% for r in turns.recent %}<tr><td>{{ r.at[:19]|replace('T', ' ') }}</td><td>{{ r.user }}</td><td>{% if r.board and r.board.startswith('superset-') %}<a href="/superset/dashboard/{{ r.board[9:] }}/">{{ r.board[9:] }}</a>{% else %}{{ r.board or '' }}{% endif %}</td><td><code>{{ r.models|join(', ') }}</code></td><td>{{ '{:,}'.format(r.tokens['in']) }} / {{ '{:,}'.format(r.tokens.out) }}</td><td>≈ ${{ '%.4f'|format(r.costUsd) }}{% if r.sttUsd %} <span class="mute">(speech ${{ '%.4f'|format(r.sttUsd) }})</span>{% endif %}</td></tr>
        {% endfor %}
      </table>
    </details>
    {% else %}<p class="mute">No answers in the last 7 days.</p>{% endif %}
  </div>
  {% endif %}

  <div class="lp-card">
    <h2>Audit log</h2>
    {% if audit and audit.enabled %}
      <p class="mute" style="margin:0 0 8px">Every board change, refused change, chat turn and settings change, with who made it. Kept {{ audit.retentionDays }} days in Lenspack's state directory (<code>audit.jsonl</code>, one file a month); the spend figures above reset when Lenspack restarts, this does not.</p>
      <table class="bench">
        <tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Outcome</th><th>Detail</th></tr>
        {% for e in audit.events %}<tr><td>{{ e.at[:19]|replace('T', ' ') }}</td><td>{{ e.user }}</td><td>{{ e.action }}{% if e.board %} <span class="mute">{{ e.board }}</span>{% endif %}</td><td class="{{ 'ok' if e.outcome == 'ok' else 'bad' }}">{{ e.outcome }}</td><td class="mute">{{ (e.detail or '')[:120] }}</td></tr>
        {% else %}<tr><td colspan="5" class="mute">Nothing yet this month.</td></tr>{% endfor %}
      </table>
      {% if audit.months|length > 1 %}<p class="mute" style="margin:6px 0 0">Earlier months on file: {{ audit.months[1:]|join(', ') }}.</p>{% endif %}
    {% elif audit %}<p class="mute">Off (<code>audit: false</code> in the Lenspack config).</p>
    {% else %}<p class="mute">Not available: {{ audit_error or 'this Lenspack version has no audit log' }}</p>{% endif %}
  </div>

  <div class="lp-card">
    <h2>Data connections in Superset</h2>
    <table>
      <tr><th>Name</th><td class="mute">Backend · connection (password masked) · datasets</td></tr>
      {% for d in databases %}
        <tr><th>{{ d.name }}</th><td><code>{{ d.backend }}</code> · <code>{{ d.uri }}</code> · {{ d.datasets }}</td></tr>
      {% else %}
        <tr><td colspan="2" class="mute">None yet.</td></tr>
      {% endfor %}
    </table>
    <p class="mute">Add or edit them under Settings → Database Connections. Saved passwords are encrypted with Superset's secret key.</p>
  </div>

  <div class="lp-card">
    <h2>Where to change things</h2>
    <table>
      <tr><th>Chat and speech models</th><td>On this page (saved in Lenspack's state, kept across restarts)</td></tr>
      <tr><th>LLM and speech keys</th><td><code>ANTHROPIC_API_KEY</code>, <code>LENSPACK_LLM_PROVIDERS</code>, <code>OPENROUTER_API_KEY</code> in Lenspack's environment</td></tr>
      <tr><th>Datasets, guidance, budget</th><td>Lenspack's config file (<code>lenspack superset --config &lt;file&gt;</code>)</td></tr>
      <tr><th>Who may use the chat</th><td>Anyone signed in to Superset who can view the dashboard. Superset's <code>/lenspack/</code> route checks the session and signs who is asking for every Lenspack request.</td></tr>
      <tr><th>Whose data access applies</th><td><code>LENSPACK_HOST_POLICY</code> on the Lenspack container: off (default), the answers use what Lenspack's own account may read; <code>superset</code>, each user's own dataset access and row-level security.</td></tr>
      <tr><th>Who may edit through it</th><td><code>LENSPACK_EDIT_POLICY</code> on the Lenspack container: <code>superset</code> (default) or <code>signed-in</code>. The Dashboard edits switch above turns edits off for everyone.</td></tr>
      <tr><th>Off switches</th><td>On this page, or <code>features:</code> in Lenspack's config file and <code>LENSPACK_FEATURES</code> on the Lenspack container (this page wins)</td></tr>
    </table>
  </div>
</div>
{% endblock %}
"""

# The AI assistant page's own layout on Superset 6, which has no server-drawn one (lenspack_settings_layout).
# Light or dark as Superset is: Superset keeps the choice in localStorage (superset-theme-mode: default, dark, or
# system, which follows the browser), and its own page reads it the same way before its frontend starts.
LAYOUT_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{% block title %}{% endblock %}</title>
  <script{% if csp_nonce is defined %} nonce="{{ csp_nonce() }}"{% endif %}>
    try {
      var lpMode = localStorage.getItem("superset-theme-mode");
      if (lpMode === "dark" || (lpMode !== "default" && window.matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.setAttribute("data-lp-theme", "dark");
    } catch (e) {}
  </script>
  <style>
    :root{--lp-page:#f5f6f8;--lp-bar:#fff;--lp-barline:#e4e7ec;--lp-text:#1f2328;--lp-dim:#667085;--lp-link:#1a85a0;color-scheme:light}
    [data-lp-theme=dark]{--lp-page:#0f1012;--lp-bar:#16181b;--lp-barline:#2a2e35;--lp-text:#e6e8eb;--lp-dim:#98a2b3;--lp-link:#3fb1cc;color-scheme:dark}
    body{margin:0;background:var(--lp-page);color:var(--lp-text);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
    .lp-top{display:flex;align-items:center;gap:10px;height:56px;padding:0 24px;background:var(--lp-bar);border-bottom:1px solid var(--lp-barline);box-sizing:border-box}
    .lp-top a{color:var(--lp-link);text-decoration:none}
    .lp-top a:hover{text-decoration:underline}
    .lp-top .lp-home{font-weight:600;font-size:16px;color:var(--lp-text)}
    .lp-top .lp-sep{color:var(--lp-dim)}
    .lp-top .lp-back{margin-left:auto}
  </style>
</head>
<body>
  <header class="lp-top">
    <a class="lp-home" href="/superset/welcome/">Superset</a><span class="lp-sep">/</span><span class="lp-sep">Settings</span><span class="lp-sep">/</span><b>AI assistant</b>
    <a class="lp-back" href="/superset/welcome/">← Back to Superset</a>
  </header>
  {% block messages %}{% endblock %}
  {% block content %}{% endblock %}
</body>
</html>
"""

__all__ = [
    "LENSPACK_PATH", "LENSPACK_INTERNAL_URL", "LENSPACK_SERVICE_USER", "LENSPACK_TEMPLATES", "STT_BENCH", "FLASK_APP_MUTATOR",
    "lenspack_app_mutator", "lenspack_sign", "lenspack_identity_key", "lenspack_rls_clauses", "lenspack_dataset_access",
    "lenspack_settings_layout", "superset_version", "lenspack_clickhouse_label_suffix",
]
