"""Lenspack's additions to Superset 6.1 (and 5.0), as one file. No fork, no custom image, no second web server.

Load it at the end of superset_config.py (on the Helm chart: a configOverrides entry):

    from lenspack_superset import *  # noqa: F401,F403

It adds:
  - /lenspack/...: Superset itself forwards these requests to the Lenspack container, for signed-in users
    only, with a signed header saying who is asking, their role names, whether they are an admin, and whether Superset would
    let them view and edit the dashboard the request is about. The dashboard is read from the path the way
    Lenspack reads it (api/<pack>/superset-<id>/...), the header names that board and pack, and a path with a
    "." or ".." segment or an encoded slash is refused. Chat replies stream through unbuffered. Pages Lenspack
    serves (its admin panel) get the request's Content-Security-Policy nonce on their scripts, which Superset's
    default policy needs before a browser runs them.
    Lenspack trusts nothing else, so its port never needs to be reachable from outside.
    Superset under a path of its host (SUPERSET_APP_ROOT=/superset, Superset 6.1) works the same: every address this
    file gives a browser starts from request.script_root, and the route tells Lenspack both paths (lenspack_root).
  - the "Ask Lenspack" button on every page (Superset's tail_js_custom_extra.html), for signed-in users;
  - Settings → Manage → "AI assistant" (Superset admins whom Lenspack's admins rule also names; Lenspack refuses the
    page for anyone else): models, languages, spend, the audit log, and a link to Lenspack's own
    admin panel (/lenspack/_superset/admin/: a board of how the assistant is used, the daily review, open questions, definitions). On Superset 6, whose pages
    are all drawn by its frontend, this page has a layout of its own that follows Superset's light or dark theme;
    on Superset 5 it sits in Superset's server-drawn layout;
  - /api/v1/lenspack/bootstrap and /api/v1/lenspack/identity-key, which Lenspack calls on start: the first
    makes Lenspack's own service account (admins only), the second hands it the signing key, derived from
    SECRET_KEY (admins and that account only);
  - /api/v1/lenspack/access?user=&datasets=&dashboards=, which Lenspack calls with hostPolicy: superset (the
    default): whether that user may read each dataset and the row-level security clauses on it, whether they
    may open each dashboard, and, with dashboard roles on (DASHBOARD_RBAC), which datasets they may read only on
    each dashboard, as Superset's security manager decides them for that user, Jinja rendered (admins and
    Lenspack's account only);
  - /api/v1/lenspack/version: Superset's version, which Lenspack reads on start (admins and Lenspack's account);
  - a fix for concurrent list requests in Flask-AppBuilder;
  - on Superset 6.1, ClickHouse column aliases with a hash suffix again, as up to 6.0 (see
    lenspack_clickhouse_label_suffix below).
If your config already sets FLASK_APP_MUTATOR, call lenspack_app_mutator(app) from yours and set
FLASK_APP_MUTATOR back to yours after this import.

Environment (all optional):
  LENSPACK_INTERNAL_URL   where Superset's server reaches Lenspack (default http://lenspack:8795).
  LENSPACK_PATH           where browsers reach it below Superset's root (default /lenspack), e.g. /assistant.
  LENSPACK_BRAND_NAME     the menu entry's and settings page's name, when superset_config sets none (see
                          lenspack_brand_label); without either, the assistant's own name from its server.
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


def lenspack_sign(user: str, admin: bool, dashboard=None, can_edit=None, can_view=None, roles=None, pack=None, user_id=None, can_write=None) -> str:
    claims = {"u": user, "a": bool(admin), "t": int(time.time())}
    if can_write is not None:
        # w: Superset lets this user write dashboards at all; Lenspack makes, copies and changes their own only with it.
        claims["w"] = bool(can_write)
    if isinstance(user_id, int) and not isinstance(user_id, bool) and user_id > 0:
        # i: the user's Superset id, so a dashboard Lenspack makes for them can be theirs in Superset.
        claims["i"] = user_id
    if roles is not None:
        claims["r"] = sorted(roles)
    if dashboard is not None:
        # b: the board these rights are for; Lenspack refuses the request when its own route names another board or pack.
        claims.update({"d": dashboard, "b": f"superset-{dashboard}", "e": bool(can_edit), "v": bool(can_view)})
        if pack is not None:
            claims["p"] = pack
    body = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode()
    return body + "." + hmac.new(lenspack_identity_key().encode(), body.encode(), hashlib.sha256).hexdigest()


def lenspack_sign_client(address: str) -> str:
    """The caller's address, signed for Lenspack's own admin sign-in (identity.ts signedClient): its requests carry no
    identity, and without this every failed try would count against Superset's one address. base64url(JSON {c, t}) "."
    HMAC-SHA256 hex of "client:" + body, with the identity key."""
    body = base64.urlsafe_b64encode(json.dumps({"c": str(address)[:64], "t": int(time.time())}, separators=(",", ":")).encode()).rstrip(b"=").decode()
    return body + "." + hmac.new(lenspack_identity_key().encode(), ("client:" + body).encode(), hashlib.sha256).hexdigest()


# The cookies Lenspack's own admin sign-in sets (admin-signin.ts); the only cookies forwarded, and only on its pages.
LENSPACK_ADMIN_COOKIES = ("lenspack_admin", "lenspack_admin_device")


def lenspack_is_admin_signin_path(path: str) -> bool:
    """Lenspack's own admin pages, under admin access "password" (docs/access/admin-access.md): forwarded without a
    Superset session, since their sign-in is the deployment's admin password. Lenspack answers 404 under any other mode."""
    return path == "_admin" or path.startswith("_admin/")


_DOT_SEGMENTS = {".", ".."}
# Left after Flask decoded the path once, these were encoded twice: an encoded dot, slash or backslash.
_ENCODED = re.compile(r"%(?:2e|2f|5c)", re.IGNORECASE)
_DASHBOARD_BOARD = re.compile(r"superset-(\d+)")


def lenspack_reads_dashboard_arg(path: str) -> bool:
    """Paths whose dashboard is ?dashboard=<id> instead of a board in the path: binding a dashboard, and the
    routes for a person's own dashboards and saved layouts (copy this one, save its layout, apply one here)."""
    return path == "_superset/bind" or path == "_superset/my" or path.startswith("_superset/my/")


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


# A <script> start tag with no nonce attribute yet: "<script" then a space, ">" or "/", in any case ("<scripts" is not one).
_SCRIPT_TAG = re.compile(rb"<script(?=[\s>/])(?![^>]*?[\s\"']nonce\s*=)", re.IGNORECASE)


def lenspack_stamp_nonce(html: bytes, nonce: str) -> bytes:
    """The page with this request's CSP nonce on every <script> tag that has none. Superset's Content-Security-Policy
    (Talisman, on by default) has script-src 'self' 'strict-dynamic' 'nonce-...': with 'strict-dynamic' browsers ignore
    'self', so a page's own scripts run only if they carry the nonce. Scripts those create are trusted in turn."""
    if not nonce:
        return html
    attr = b' nonce="' + nonce.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").encode() + b'"'
    return _SCRIPT_TAG.sub(lambda m: m.group(0) + attr, html)


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


def lenspack_dataset_access(user, ids, also_rls=()) -> dict:
    """Per dataset id: may this user read it, and its RLS clauses for them. A missing dataset is not readable.
    also_rls: datasets the user may not read in general but may read on a dashboard (lenspack_dashboard_datasets):
    their RLS clauses are rendered too, as Superset applies RLS there as well."""
    from superset.connectors.sqla.models import SqlaTable
    from superset.extensions import db, security_manager
    from superset.jinja_context import get_template_processor
    from superset.utils.core import override_user

    out = {}
    with override_user(user):
        for ds_id in ids:
            ds = db.session.query(SqlaTable).filter_by(id=ds_id).one_or_none()
            access = ds is not None and security_manager.can_access_datasource(ds)
            if ds is None or not (access or ds_id in also_rls):
                out[str(ds_id)] = {"access": False, "rls": []}
                continue
            processor = get_template_processor(database=ds.database, table=ds)
            out[str(ds_id)] = {"access": bool(access), "rls": lenspack_rls_clauses(security_manager.get_rls_filters(ds), processor.process_template)}
    return out


class _ChartOnDashboard:
    """What Superset's raise_for_access reads of a chart's data request (a QueryContext): the dataset it reads, and
    form data naming the dashboard and the chart it is drawn on, as a dashboard's charts send them."""

    def __init__(self, datasource, dashboard_id, slice_id):
        self.datasource = datasource
        self.form_data = {"dashboardId": dashboard_id, "slice_id": slice_id}


def lenspack_dashboard_datasets(user, dashboard_ids, dataset_ids) -> dict:
    """Per dashboard id: the datasets of dataset_ids this user may not read in general but may read on that dashboard,
    as Superset decides it for a chart's data on a dashboard. Superset's own raise_for_access is asked, as the user,
    for a data request from one of the dashboard's charts on each dataset. With DASHBOARD_RBAC on, Superset lets it
    through when the dashboard has dashboard roles, the user may open the dashboard (a member of one of its roles
    and the dashboard published, or an owner, or an admin), and the chart is on the dashboard and reads that dataset.
    So only datasets behind the dashboard's charts count. A dataset only a native filter of the dashboard reads is
    left out: Superset lets that filter list its values, nothing else. Missing dashboards and datasets count as none."""
    from superset.connectors.sqla.models import SqlaTable
    from superset.exceptions import SupersetSecurityException
    from superset.extensions import db, security_manager
    from superset.models.dashboard import Dashboard
    from superset.utils.core import override_user

    wanted = set(dataset_ids)
    out = {}
    with override_user(user):
        for dash_id in dashboard_ids:
            dash = db.session.query(Dashboard).filter_by(id=dash_id).one_or_none()
            found = []
            # One chart per dataset: what Superset checks is the same for every chart on the dashboard that reads it.
            charts = {}
            for slc in (dash.slices if dash is not None else []):
                if slc.datasource_type == "table" and slc.datasource_id in wanted:
                    charts.setdefault(slc.datasource_id, slc)
            for ds_id, slc in sorted(charts.items()):
                ds = db.session.query(SqlaTable).filter_by(id=ds_id).one_or_none()
                if ds is None or security_manager.can_access_datasource(ds):
                    continue  # readable everywhere already, or gone
                try:
                    security_manager.raise_for_access(query_context=_ChartOnDashboard(ds, dash.id, slc.id))
                except SupersetSecurityException:
                    continue
                found.append(ds_id)
            out[str(dash_id)] = found
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


DEFAULT_BRAND_NAME = "Lenspack"  # the server's brand.name when a deployment names nothing


def lenspack_brand_label(config, environ=None, server=None) -> str:
    """What the menu entry and the settings page are called, first one set wins: superset_config's
    LENSPACK_BRAND_NAME; the LENSPACK_BRAND_NAME environment variable of Superset's own process; the assistant's
    name as its server says (its brand.name: config, environment or admin panel), unless that is still the
    default; else "AI assistant", as before. The page's address stays /ai-assistant/, and the name is shown as text."""
    environ = os.environ if environ is None else environ
    for value in (config.get("LENSPACK_BRAND_NAME"), environ.get("LENSPACK_BRAND_NAME"), None if server == DEFAULT_BRAND_NAME else server):
        name = str(value or "").strip()[:40]
        if name:
            return name
    return "AI assistant"


# Paths of Superset's own that the assistant's route may not take.
_SUPERSET_PATHS = {"api", "superset", "static", "login", "logout", "health", "healthcheck", "ping", "dashboard", "chart", "explore",
                   "sqllab", "savedqueryview", "tablemodelview", "databaseview", "users", "roles", "ai-assistant", "lang", "oauth-authorized", "register"}


def lenspack_mount_path(value) -> str:
    """Where browsers reach the assistant below Superset's root (LENSPACK_PATH): "/lenspack" by default, or another
    plain path such as "/assistant" so that no address shows the product's name. Not one of Superset's own paths.
    A value that breaks this keeps the default, with a warning in Superset's log."""
    raw = str(value or "").strip()
    if not raw:
        return "/lenspack"
    path = lenspack_root(raw) if raw.startswith("/") else ""
    if not path or path.split("/")[1].lower() in _SUPERSET_PATHS:
        import logging

        logging.getLogger(__name__).warning("LENSPACK_PATH=%r is not a plain path of its own (like /assistant); using /lenspack", raw)
        return "/lenspack"
    return path


# The assistant's name as its server last said it (the settings page reads it; the menu entry refreshes it now and
# then), for the menu entry and the settings page when neither superset_config nor the environment names it.
_SERVER_BRAND = {"name": None, "at": 0.0}


# Superset can run below a path of its host (SUPERSET_APP_ROOT=/superset, Superset 6.1 and later; or a proxy's
# X-Forwarded-Prefix with ENABLE_PROXY_FIX). Superset then answers only under that path, so every address a browser
# is given must start with it: the page script, the forms and redirects of the settings page, its links, and what
# Lenspack builds behind the /lenspack route. Flask knows the path for each request as request.script_root
# ("" at the root), so addresses are built from it per request and never written down with a leading "/" alone.
_SAFE_ROOT = re.compile(r"(?:/[A-Za-z0-9._~-]+)*")


def lenspack_root(script_root) -> str:
    """The path Superset runs under, as browsers reach it: "" at the root, else "/superset" (no trailing slash).
    Anything that isn't a plain path (a quote, a space, a "." or ".." segment) counts as the root, so it can't
    break out of an attribute or a script where it is written."""
    root = str(script_root or "").rstrip("/")
    if not _SAFE_ROOT.fullmatch(root) or any(p in _DOT_SEGMENTS for p in root.split("/")):
        return ""
    return root


def lenspack_url(script_root, path: str) -> str:
    """A browser-facing address on Superset's host: Superset's root, then the path ("/ai-assistant/")."""
    return lenspack_root(script_root) + "/" + path.lstrip("/")


# Where browsers reach the assistant, below Superset's own root: Superset's own route below. /lenspack, or LENSPACK_PATH.
LENSPACK_PATH = lenspack_mount_path(os.environ.get("LENSPACK_PATH"))


def lenspack_app_mutator(app):
    import urllib.error
    import urllib.request
    from urllib.parse import urlparse

    import requests
    from flask import Response, abort, g, jsonify, redirect, request, stream_with_context
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

    # Every page's templates (the page script, the settings page) get Superset's root and Lenspack's address below
    # it for the request being drawn: lenspack_root ("" or "/superset") and lenspack_base ("/superset/lenspack").
    @app.context_processor
    def lenspack_paths():
        from flask import has_request_context

        root = lenspack_root(request.script_root) if has_request_context() else ""
        return {"lenspack_root": root, "lenspack_base": root + LENSPACK_PATH}

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
    def cross_site():
        # No CSRF token on these calls (the chat is a script on Superset's own pages): refuse a change sent from
        # another site instead. Browsers send Sec-Fetch-Site / Origin with every cross-site POST.
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            site = request.headers.get("Sec-Fetch-Site")
            origin = request.headers.get("Origin")
            if (site and site not in ("same-origin", "none")) or (origin and urlparse(origin).netloc != request.host):
                return True
        return False

    def lenspack_proxy(path=""):
        if lenspack_is_admin_signin_path(path):
            return lenspack_admin_signin_proxy(path)
        user = g.user if getattr(g, "user", None) is not None else None
        if user is None or not getattr(user, "is_authenticated", False) or getattr(user, "is_anonymous", True):
            return jsonify({"error": "sign in to Superset first"}), 401
        if cross_site():
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
            wanted = request.args.get("dashboard") if lenspack_reads_dashboard_arg(path) else None
        rights = dashboard_rights(wanted) if wanted else None
        if rights and not rights["view"]:
            return jsonify({"error": "You don't have access to this dashboard in Superset."}), 403
        admin = is_admin(user)
        roles = role_names(user)
        can_write = admin or bool(security_manager.can_access("can_write", "Dashboard"))
        headers = {
            "x-lenspack-identity": lenspack_sign(user.username, admin, rights["id"], rights["edit"], rights["view"], roles, pack=route["pack"], user_id=getattr(user, "id", None), can_write=can_write) if rights else lenspack_sign(user.username, admin, roles=roles, user_id=getattr(user, "id", None), can_write=can_write),
            "x-forwarded-proto": request.scheme,
            "x-forwarded-host": request.host,
            # Where the browser reached this route, Superset's root included (/superset/lenspack), and Superset's
            # root alone: Lenspack builds the addresses on its pages and in its answers from these.
            "x-forwarded-prefix": lenspack_root(request.script_root) + LENSPACK_PATH,
            "x-lenspack-superset-root": lenspack_root(request.script_root),
        }
        for h in ("content-type", "accept", "accept-language"):
            if request.headers.get(h):
                headers[h] = request.headers[h]
        return lenspack_forward(path, headers)

    def lenspack_admin_signin_proxy(path):
        """Lenspack's own admin pages: no Superset session needed and no identity sent; Lenspack's sign-in decides.
        Only its own cookies go through, with the caller's address signed so its attempt limiter counts per person."""
        if cross_site():
            return jsonify({"error": "cross-site request refused"}), 403
        if lenspack_route(path) is None:
            return jsonify({"error": "a path with a dot segment or an encoded slash is not accepted"}), 400
        headers = {
            "x-forwarded-proto": request.scheme,
            "x-forwarded-host": request.host,
            "x-forwarded-prefix": lenspack_root(request.script_root) + LENSPACK_PATH,
            "x-lenspack-superset-root": lenspack_root(request.script_root),
            "x-lenspack-client": lenspack_sign_client(request.remote_addr or "unknown"),
        }
        for h in ("content-type", "accept", "accept-language", "origin", "sec-fetch-site"):
            if request.headers.get(h):
                headers[h] = request.headers[h]
        jar = "; ".join(f"{k}={v}" for k, v in request.cookies.items() if k in LENSPACK_ADMIN_COOKIES)
        if jar:
            headers["cookie"] = jar
        return lenspack_forward(path, headers)

    def lenspack_forward(path, headers):
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
            return jsonify({"error": f"The assistant's server is not reachable: {type(e).__name__}"}), 502

        out = [(k, v) for k, v in upstream.headers.items() if k.lower() not in HOP and k.lower() != "set-cookie"]
        # Each cookie on its own line: requests joins repeated Set-Cookie headers with commas, which breaks them.
        raw = getattr(getattr(upstream, "raw", None), "headers", None)
        cookies = raw.getlist("Set-Cookie") if raw is not None and hasattr(raw, "getlist") else None
        if not isinstance(cookies, list):
            cookies = [upstream.headers["set-cookie"]] if upstream.headers.get("set-cookie") else []
        out += [("Set-Cookie", c) for c in cookies]
        # Chat replies stream: no buffering in a proxy in front of Superset, no compression here.
        out += [("X-Accel-Buffering", "no"), ("Cache-Control", upstream.headers.get("cache-control", "no-store"))]

        # A page (the admin panel, the chat page): its scripts need this request's nonce under Superset's
        # Content-Security-Policy. Pages are small, so read it whole; everything else streams as it comes.
        nonce = getattr(request, "csp_nonce", None)
        if nonce and request.method != "HEAD" and upstream.headers.get("content-type", "").lower().startswith("text/html"):
            try:
                page = lenspack_stamp_nonce(b"".join(upstream.iter_content(chunk_size=None)), nonce)
            finally:
                upstream.close()
            return Response(page, status=upstream.status_code, headers=out)

        def body():
            try:
                for chunk in upstream.iter_content(chunk_size=None):
                    yield chunk
            finally:
                upstream.close()

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
            return jsonify({"message": "only admins may make the assistant's service account"}), 403
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
            # Shown in Superset's user list and as the owner of the charts it makes: a neutral name.
            if not security_manager.add_user(username, "Assistant", "Service account", f"{username}@lenspack.invalid", role, password=password):
                return jsonify({"message": "Superset could not create the account"}), 500
            made = "created"
        return jsonify({"result": {"username": username, "account": made}})

    # What one user may read, as Superset decides it for them: the datasets their roles may access, and the
    # row-level security clauses on each, rendered as that user (Jinja such as current_username() included), the
    # dashboards they may open, and with DASHBOARD_RBAC on, the datasets they may read only on a dashboard (its
    # charts' datasets, on a dashboard they open through its dashboard roles). Lenspack reads data as its own
    # account, so it narrows each user's queries by this, and lists them only the dashboards they may open
    # (hostPolicy: superset).
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

        from superset import is_feature_enabled

        datasets, dashboards = ids("datasets"), ids("dashboards")
        # Dashboard roles (DASHBOARD_RBAC): on a dashboard a user opens through one, its charts' datasets are readable
        # to them there, even without access to those datasets. Off, Superset grants nothing through a dashboard.
        rbac = bool(is_feature_enabled("DASHBOARD_RBAC"))
        via = lenspack_dashboard_datasets(target, dashboards, datasets) if rbac else {str(d): [] for d in dashboards}
        on_dashboards = {ds for found in via.values() for ds in found}
        return jsonify({"result": {
            "datasets": lenspack_dataset_access(target, datasets, also_rls=on_dashboards),
            "dashboards": lenspack_dashboard_access(target, dashboards),
            "dashboardRbac": rbac,
            "dashboardDatasets": via,
        }})

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
    # The page is the admin pages' own script (Lenspack's panel.js) drawn inside Superset's frame: what it shows depends
    # on where the deployment puts the admin pages (admin.surface in the assistant's config). Every change it makes goes
    # straight to the assistant's server through Superset's own route (LENSPACK_PATH), signed as the person, so there are
    # no forms here and Lenspack's admin rule decides each one.
    class Refused(Exception):
        """Lenspack said no (403): its admin rule (auth.adminAccess, auth.admins) does not make this user an admin."""

    def call(method, path, body=None, refuse=False):
        """Lenspack's settings API, as the signed-in user. refuse: raise Refused when Lenspack answers 403."""
        req = urllib.request.Request(
            LENSPACK_INTERNAL_URL + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={"content-type": "application/json", "x-lenspack-identity": lenspack_sign(g.user.username, is_admin(g.user), roles=role_names(g.user), user_id=getattr(g.user, "id", None))},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.load(r), None
        except urllib.error.HTTPError as e:
            if refuse and e.code == 403:
                raise Refused() from None
            try:
                return None, json.load(e).get("error") or f"HTTP {e.code}"
            except Exception:
                return None, f"HTTP {e.code}"
        except Exception as e:  # unreachable, not JSON: say so on the page
            return None, f"{type(e).__name__}: {str(e)[:160]}"

    class LenspackSettingsView(BaseView):
        route_base = "/ai-assistant"
        default_view = "index"
        method_permission_name = {"index": "index"}

        @expose("/")
        @has_access
        def index(self):
            if not security_manager.is_admin():
                abort(403)
            from superset.models.core import Database

            # Lenspack decides who its admins are. One it refuses gets no page, unless the admin pages are elsewhere
            # for this deployment (its own password sign-in, or everything on the panel): then a link to them.
            refused = False
            try:
                settings, error = call("GET", "/_superset/settings", refuse=True)
            except Refused:
                settings, error, refused = None, None, True
            info, info_error = call("GET", "/_superset/info")
            error = error or (info_error if info is None else None)
            adm = (info or {}).get("admin") or {}
            # What this page shows (admin.surface): "host", what Superset needs (split, the default, and a Lenspack
            # that says nothing); "all", everything (superset); "link", a link to the admin panel (separate, password).
            page = adm.get("page") if adm.get("page") in ("host", "all", "link") else "host"
            if adm.get("access") == "password":
                page = "link"
            if refused and page != "link":
                abort(403)
            lp = lenspack_root(request.script_root) + LENSPACK_PATH
            panel = None if page == "all" else lp + ("/_admin/" if adm.get("access") == "password" else "/_superset/admin/")
            # The assistant's own name, as its server says: kept for the menu entry, and used on this page.
            server_name = ((settings or {}).get("brand") or {}).get("values", {}).get("name") or ((info or {}).get("brand") or {}).get("name")
            if server_name:
                _SERVER_BRAND.update(name=str(server_name), at=time.time())
            label = lenspack_brand_label(app.config, server=_SERVER_BRAND["name"])
            # What only Superset knows, for the Assistant section: its data connections (no addresses) and the roles
            # of the assistant's own account.
            account = security_manager.find_user(username=(settings or {}).get("superset", {}).get("username") or LENSPACK_SERVICE_USER)
            facts = None
            if page != "link":
                facts = {
                    "databases": [{"name": d.database_name, "backend": d.backend, "datasets": len(d.tables)} for d in db.session.query(Database).order_by(Database.database_name)],
                    "accountRoles": [r.name for r in account.roles] if account else None,
                }
            shell = {
                "shell": "superset", "name": label, "superset": True, "surface": adm.get("surface") or "split", "sections": page,
                "host": lp + "/_superset/", "api": {"panel": lp + "/_superset/admin/api/", "host": lp + "/_superset/"}, "assets": lp + "/_superset/admin/",
                "panelUrl": panel, "access": adm.get("access"), "facts": facts, "nonce": getattr(request, "csp_nonce", None),
            }
            return self.render_template(
                "lenspack/settings.html",
                lp_layout=settings_layout, lp_brand=label, lp_error=error, lp_shell=shell, lp_assets=shell["assets"], lp_panel=panel,
            )

    appbuilder.add_view_no_menu(LenspackSettingsView)

    class MenuLabel:
        """The menu entry's name, read each time Superset draws its menu (lenspack_brand_label). When only the
        assistant's server names it, its name is fetched in the background at most every 5 minutes, so the menu
        follows a rename made in the admin panel without a restart, and drawing the menu never waits for it."""

        def __str__(self):
            if not (app.config.get("LENSPACK_BRAND_NAME") or os.environ.get("LENSPACK_BRAND_NAME")) and time.time() - _SERVER_BRAND["at"] > 300:
                _SERVER_BRAND["at"] = time.time()
                try:
                    header = lenspack_sign(LENSPACK_SERVICE_USER, False)
                except Exception:  # no app context: try again next time
                    _SERVER_BRAND["at"] = 0.0
                else:
                    import threading

                    threading.Thread(target=fetch_brand, args=(header,), daemon=True).start()
            return lenspack_brand_label(app.config, server=_SERVER_BRAND["name"])

        def __html__(self):
            from markupsafe import escape

            return str(escape(str(self)))

    def fetch_brand(header):
        try:
            req = urllib.request.Request(LENSPACK_INTERNAL_URL + "/_superset/info", headers={"x-lenspack-identity": header})
            with urllib.request.urlopen(req, timeout=5) as r:
                name = (json.load(r).get("brand") or {}).get("name")
            if name:
                _SERVER_BRAND["name"] = str(name)
        except Exception:
            pass
    # A menu entry's address is fixed when Superset starts, so it takes Superset's root from its config, as Superset's
    # own entries do (APPLICATION_ROOT, which SUPERSET_APP_ROOT sets).
    menu_href = lenspack_url("" if app.config.get("APPLICATION_ROOT") in (None, "", "/") else app.config["APPLICATION_ROOT"], "/ai-assistant/")
    appbuilder.add_link("AI assistant", label=MenuLabel(), href=menu_href, icon="fa-comments", category="Manage", cond=lambda: security_manager.is_admin())


FLASK_APP_MUTATOR = lenspack_app_mutator


# Superset includes this at the end of every page and documents it as overridable.
TAIL_JS = r'''{# The "Ask Lenspack" button: one small script on every page, for signed-in users. With Talisman on it carries the page's CSP nonce.
   It loads overlay.js from Lenspack's route below Superset's root (lenspack_base: /lenspack, or LENSPACK_PATH, below Superset's
   root: /superset/lenspack when Superset runs under /superset); while Lenspack is restarting (a 5xx or no answer) it tries again after 1, 2, 4… s, at most 30 s apart,
   while the tab is visible. Signed out or refused (another 4xx): it stops. Once loaded, the overlay handles restarts itself. #}
{% if current_user.is_authenticated %}{% set lp_nonce = csp_nonce() if csp_nonce is defined else "" %}
<script{% if lp_nonce %} nonce="{{ lp_nonce }}"{% endif %}>
(function () {
  var base = {{ lenspack_base | tojson }};
  var wait = 1000;
  function load() {
    var s = document.createElement("script");
    s.src = base + "/overlay.js";
    s.onerror = function () {
      s.remove();
      fetch(base + "/healthz", { cache: "no-store" })
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
SETTINGS_HTML = r"""{# Settings → Manage → AI assistant: the admin pages' own script (panel.js, served by the assistant's server) drawn in
   Superset's frame. What it shows follows admin.surface: what Superset needs, everything, or a link to the admin panel.
   The heading and any error are drawn here, so the page says something when the assistant's server is down. #}
{% extends lp_layout %}
{% block title %}{{ lp_brand | default("AI assistant") }}{% endblock %}
{% block messages %}{% endblock %}
{% block content %}
{% set lp_nonce = csp_nonce() if csp_nonce is defined else "" %}
<link rel="stylesheet" href="{{ lp_assets }}panel.css">
<div id="lp-admin" class="lpa" data-shell="superset">
  <header class="page-h lpa-static">
    <h1>{{ lp_brand | default("AI assistant") }}</h1>
    {% if lp_error %}<p class="bad-line">The assistant's server didn't answer: {{ lp_error }}</p>
    {% elif lp_panel %}<p><a href="{{ lp_panel }}">Open the admin panel</a></p>{% endif %}
  </header>
</div>
{% if not lp_error %}
<script{% if lp_nonce %} nonce="{{ lp_nonce }}"{% endif %}>window.__lpAdmin = {{ lp_shell | tojson }};</script>
<script src="{{ lp_assets }}checklist.js"{% if lp_nonce %} nonce="{{ lp_nonce }}"{% endif %}></script>
<script src="{{ lp_assets }}panel.js"{% if lp_nonce %} nonce="{{ lp_nonce }}"{% endif %}></script>
{% endif %}
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
    /* Superset 6.1's header, as its antd theme draws it: white bar, 4px radii, its teal for links and the active item. */
    :root{--lp-page:#f5f5f5;--lp-bar:#fff;--lp-barline:#f0f0f0;--lp-text:rgba(0,0,0,.88);--lp-dim:rgba(0,0,0,.55);--lp-link:#2893b3;color-scheme:light}
    [data-lp-theme=dark]{--lp-page:#141414;--lp-bar:#1f1f1f;--lp-barline:#303030;--lp-text:rgba(255,255,255,.85);--lp-dim:rgba(255,255,255,.55);--lp-link:#3fb1cc;color-scheme:dark}
    body{margin:0;background:var(--lp-page);color:var(--lp-text);font:14px/1.5715 Inter,Helvetica,Arial,sans-serif}
    .lp-top{display:flex;align-items:center;gap:4px;min-height:53px;padding:0 16px;background:var(--lp-bar);border-bottom:1px solid var(--lp-barline);box-sizing:border-box;flex-wrap:wrap}
    .lp-top a{color:var(--lp-text);text-decoration:none;padding:6px 12px;border-radius:4px}
    .lp-top a:hover{color:var(--lp-link)}
    .lp-top .lp-home{font-weight:700;font-size:16px;letter-spacing:-.01em;margin-right:12px;padding-left:0}
    .lp-top .lp-crumb{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--lp-dim)}
    .lp-top .lp-crumb b{color:var(--lp-text);font-weight:600}
    .lp-top .lp-back{color:var(--lp-link)}
    @media (max-width:760px){.lp-top .lp-nav{display:none}.lp-top .lp-crumb span{display:none}}
  </style>
</head>
<body>
  <header class="lp-top">
    <a class="lp-home" href="{{ lenspack_root }}/superset/welcome/">Superset</a>
    <a class="lp-nav" href="{{ lenspack_root }}/dashboard/list/">Dashboards</a>
    <a class="lp-nav" href="{{ lenspack_root }}/chart/list/">Charts</a>
    <a class="lp-nav" href="{{ lenspack_root }}/tablemodelview/list/">Datasets</a>
    <a class="lp-nav" href="{{ lenspack_root }}/sqllab/">SQL</a>
    <span class="lp-crumb"><span>Settings /</span><b>{{ lp_brand | default("AI assistant") }}</b><a class="lp-back" href="{{ lenspack_root }}/superset/welcome/">← Back to Superset</a></span>
  </header>
  {% block messages %}{% endblock %}
  {% block content %}{% endblock %}
</body>
</html>
"""

__all__ = [
    "LENSPACK_PATH", "LENSPACK_INTERNAL_URL", "LENSPACK_SERVICE_USER", "LENSPACK_TEMPLATES", "STT_BENCH", "FLASK_APP_MUTATOR",
    "lenspack_app_mutator", "lenspack_sign", "lenspack_identity_key", "lenspack_rls_clauses", "lenspack_dataset_access",
    "lenspack_settings_layout", "superset_version", "lenspack_clickhouse_label_suffix", "lenspack_reads_dashboard_arg",
    "lenspack_root", "lenspack_url",
]
