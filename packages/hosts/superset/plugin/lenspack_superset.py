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
    class Refused(Exception):
        """Lenspack said no (403): its admins rule (auth.admins in superset.yaml) does not name this user's roles."""

    def call(method, path, body=None, refuse=False):
        """Lenspack's settings API, as the signed-in admin. refuse: raise Refused when Lenspack answers 403."""
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
            if refuse and e.code == 403:
                raise Refused() from None
            try:
                return None, json.load(e).get("error") or f"HTTP {e.code}"
            except Exception:
                return None, f"HTTP {e.code}"
        except Exception as e:  # unreachable, not JSON: say so on the page
            return None, f"{type(e).__name__}: {str(e)[:160]}"

    def back():
        """Back to the settings page, below Superset's root."""
        return redirect(lenspack_url(request.script_root, "/ai-assistant/"))

    def saved(what, result):
        _data, error = result
        flash(f"{what} saved." if error is None else f"{what} not saved: {error}", FLASH_OK if error is None else FLASH_BAD)
        return back()

    class LenspackSettingsView(BaseView):
        route_base = "/ai-assistant"
        default_view = "index"
        # The forms below use the page's own permission (can_index), so no new permissions to sync.
        method_permission_name = {"index": "index", "chat": "index", "speech": "index", "speech_hold": "index", "speech_audio": "index", "audio_delete": "index", "audio_export": "index", "language": "index", "features": "index", "telemetry": "index"}

        @expose("/")
        @has_access
        def index(self):
            if not security_manager.is_admin():
                abort(403)
            from superset.models.core import Database

            # Lenspack decides who its admins are: a Superset admin its admins rule does not name gets no page.
            try:
                settings, settings_error = call("GET", "/_superset/settings", refuse=True)
            except Refused:
                abort(403)
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
            # The assistant's own name, as its server says: kept for the menu entry, and used on this page.
            server_name = ((settings or {}).get("brand") or {}).get("values", {}).get("name") or ((info or {}).get("brand") or {}).get("name")
            if server_name:
                _SERVER_BRAND.update(name=str(server_name), at=time.time())
            label = lenspack_brand_label(app.config, server=_SERVER_BRAND["name"])
            return self.render_template(
                "lenspack/settings.html",
                settings=settings, settings_error=settings_error, info=info, usage=usage, usage_error=usage_error,
                audit=audit, audit_error=audit_error, turns=turns, databases=databases,
                account_roles=[r.name for r in account.roles] if account else None,
                internal_url=LENSPACK_INTERNAL_URL, lenspack_path=lenspack_root(request.script_root) + LENSPACK_PATH, stt_models=stt_models, stt_bench=STT_BENCH,
                lp_layout=settings_layout, lp_flash=[FLASH_OK, FLASH_BAD], lp_brand=label, service_user=LENSPACK_SERVICE_USER,
                lp_assistant=label if label != "AI assistant" else "the assistant",
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
                return back()
            return saved("Space-bar hold", call("PUT", "/_superset/settings/speech", {"holdMs": hold}))

        # Kept recordings of spoken questions: how long, how much, and the consent notice. Whether they are kept at all is
        # the voice-audio item on the admin panel's Telemetry tab, which asks the admin to confirm first.
        @expose("/speech-audio", methods=["POST"])
        @has_access
        def speech_audio(self):
            if not security_manager.is_admin():
                abort(403)
            if request.form.get("reset"):
                body = {"audioRetentionDays": None, "maxStoredMb": None, "consentNotice": None}
            else:
                body = {"consentNotice": request.form.get("consentNotice", "")}
                try:
                    body["audioRetentionDays"] = int(request.form.get("audioRetentionDays", ""))
                    body["maxStoredMb"] = int(request.form.get("maxStoredMb", ""))
                except ValueError:
                    flash("Kept recordings: enter whole numbers of days and MB.", FLASH_BAD)
                    return back()
            return saved("Kept recordings", call("PUT", "/_superset/settings/speech", body))

        @expose("/audio-delete", methods=["POST"])
        @has_access
        def audio_delete(self):
            if not security_manager.is_admin():
                abort(403)
            from urllib.parse import quote

            user = request.form.get("user", "").strip()
            done, error = call("DELETE", f"/_superset/audio?user={quote(user)}" if user else "/_superset/audio?all=1")
            if error is None:
                flash(f"Deleted {done.get('deleted', 0)} kept recording(s){' of ' + user if user else ''}.", FLASH_OK)
            else:
                flash(f"Recordings not deleted: {error}", FLASH_BAD)
            return back()

        @expose("/audio-export", methods=["POST"])
        @has_access
        def audio_export(self):
            if not security_manager.is_admin():
                abort(403)
            done, error = call("POST", "/_superset/audio/export", {})
            if error is None:
                flash(f"Manifest written: {done.get('clips', 0)} clip(s) in {done.get('file')}, {done.get('flagged', 0)} set aside in {done.get('flaggedFile')}.", FLASH_OK)
            else:
                flash(f"Manifest not written: {error}", FLASH_BAD)
            return back()

        @expose("/telemetry", methods=["POST"])
        @has_access
        def telemetry(self):
            if not security_manager.is_admin():
                abort(403)
            if request.form.get("reset"):
                return saved("Usage telemetry", call("PUT", "/_superset/settings/telemetry", {"retentionDays": None}))
            try:
                days = int(request.form.get("retentionDays", ""))
            except ValueError:
                flash("Usage telemetry: enter a whole number of days.", FLASH_BAD)
                return back()
            return saved("Usage telemetry", call("PUT", "/_superset/settings/telemetry", {"retentionDays": days}))

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
                flash(f"Off switches not saved: {error or 'this version of the server has no off switches'}", FLASH_BAD)
                return back()
            keys = [o["key"] for o in ft["options"]]
            if request.form.get("reset"):
                body = {k: None for k in keys}
            else:
                # Only what changed: a switch left alone keeps its source (config, LENSPACK_FEATURES).
                body = {k: request.form.get(k) == "on" for k in keys if (request.form.get(k) == "on") != ft["values"][k]}
                if not body:
                    flash("Off switches: nothing changed.", FLASH_OK)
                    return back()
            return saved("Off switches", call("PUT", "/_superset/settings/features", body))

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
SETTINGS_HTML = r"""{# Settings → Manage → AI assistant. What the assistant's server runs with and Superset's data connections. Never shows a secret.
   Prose names the assistant by its brand (lp_name) or says "the assistant"; names of settings and variables stay as code.
   lp_layout: Superset 5's own layout, or on Superset 6 lenspack/layout.html (light or dark, as Superset is). #}
{% extends lp_layout | default("appbuilder/base.html") %}
{% block title %}{{ lp_brand | default("AI assistant") }} · Settings{% endblock %}
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
  {% set lp_named = (settings or {}).get('brand', {}).get('values') or {} %}
  {% set lp_name = lp_named.get('name') or lp_assistant | default("the assistant") %}
  <h1>{{ lp_brand | default("AI assistant") }}</h1>
  <p class="lede">A chat on Superset dashboards{% if lp_named.get('buttonLabel') %}: the <b>{{ lp_named.get('buttonLabel') }}</b> button on a dashboard{% endif %}.
    Models are chosen here; the rest comes from the assistant's config file and environment. This page never shows a secret.</p>

  <div class="lp-card">
    <h2>Admin panel</h2>
    <p class="mute" style="margin:0 0 8px">How people use {{ lp_name }} each day, the daily review and its proposed fixes, open questions about definitions, the definitions you have added, and every switch. Served by the assistant's server, for its admins.</p>
    <p style="margin:0"><a href="{{ lenspack_path }}/_superset/admin/" target="_blank" rel="noopener">Open the admin panel</a></p>
  </div>

  {% for category, message in get_flashed_messages(with_categories=true, category_filter=lp_flash or ["lenspack-info", "lenspack-danger"]) %}
    <div class="lp-flash {{ 'danger' if category.endswith('danger') else 'info' }}">{{ message }}</div>
  {% endfor %}

  {% if settings and settings.chat %}{% set c = settings.chat %}
  <div class="lp-card">
    <h2>Chat model</h2>
    <p class="mute" style="margin:0 0 8px">The model that answers in the chat and edits dashboards, for everyone. Applies to the next question; no restart.</p>
    <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/chat">
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
    {% if not c.writable %}<p class="bad" style="margin:6px 0 0">Read-only: the assistant's server has no identity key from Superset yet (restart it once Superset is up).</p>{% endif %}
  </div>
  {% endif %}

  {% if settings %}
  <div class="lp-card">
    <h2>Speech to text</h2>
    {% if settings.speech %}{% set sp = settings.speech %}
      <p class="mute" style="margin:0 0 8px">Turns the chat's microphone recordings into text.
        {% if sp.enabled %}Key from <code>{{ sp.keyFrom }}</code> (value never shown).{% else %}<span class="bad">No key set (<code>OPENROUTER_API_KEY</code>): the microphone is hidden.</span>{% endif %}</p>
      <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/speech">
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
        <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/speech-hold" style="margin-top:8px">
          <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
          <label class="mute" for="lp-hold">Hold the space bar for</label>
          <input id="lp-hold" type="number" name="holdMs" min="{{ lo }}" max="{{ hi }}" step="100" value="{{ sp.holdMs or sp.defaultHoldMs }}" style="width:90px" {% if not sp.writable %}disabled{% endif %}>
          <span class="mute">ms to start recording ({{ lo }}–{{ hi }}; default {{ sp.defaultHoldMs }})</span>
          <button type="submit" {% if not sp.writable %}disabled{% endif %}>Save</button>
          {% if sp.holdMs is not none and sp.holdMs != sp.defaultHoldMs %}<button class="ghost" type="submit" name="reset" value="1" {% if not sp.writable %}disabled{% endif %}>Back to default</button>{% endif %}
        </form>
      {% endif %}
      {% if sp.keepAudio is defined %}
        <h3 style="font-size:13.5px;margin:14px 0 6px">Kept recordings</h3>
        <p class="mute" style="margin:0 0 6px">{% if sp.keepAudio %}<b>On.</b>{% else %}<b>Off.</b>{% endif %} Turned on or off as "Kept recordings" on the <a href="{{ lenspack_path }}/_superset/admin/#telemetry" target="_blank" rel="noopener">admin panel's Telemetry tab</a>, which shows what it means first. On, each spoken question's recording is kept in the assistant's state folder for checking speech to text, deleted after the days below or, oldest first, when over the size cap. Only Superset admins can play one, and each play is in the audit log. The speech provider receives the recording either way.
          {% if sp.stored %}Kept now: {{ sp.stored.files }} recording(s), {{ (sp.stored.bytes / 1048576)|round(1) }} MB.{% endif %}</p>
        <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/speech-audio">
          <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
          <label class="mute">Keep for <input type="number" name="audioRetentionDays" min="1" max="3650" value="{{ sp.audioRetentionDays }}" style="width:70px" {% if not sp.writable %}disabled{% endif %}> days</label>
          <label class="mute">at most <input type="number" name="maxStoredMb" min="1" max="100000" value="{{ sp.maxStoredMb }}" style="width:90px" {% if not sp.writable %}disabled{% endif %}> MB</label>
          <label class="mute" style="flex-basis:100%">Notice each person acknowledges once before recording (optional)<br><textarea name="consentNotice" rows="2" maxlength="2000" style="width:100%" {% if not sp.writable %}disabled{% endif %}>{{ sp.consentNotice or '' }}</textarea></label>
          <button type="submit" {% if not sp.writable %}disabled{% endif %}>Save</button>
          <button class="ghost" type="submit" name="reset" value="1" {% if not sp.writable %}disabled{% endif %}>Back to defaults</button>
        </form>
        <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/audio-delete" style="margin-top:8px">
          <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
          <input type="text" name="user" placeholder="Superset username (empty: everyone's)" aria-label="Superset username" style="width:240px" {% if not sp.writable %}disabled{% endif %}>
          <button class="ghost" type="submit" {% if not sp.writable %}disabled{% endif %}>Delete stored audio</button>
        </form>
        <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/audio-export" style="margin-top:8px">
          <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
          <button class="ghost" type="submit" {% if not sp.writable or not sp.stored or not sp.stored.files %}disabled{% endif %}>Export for evaluation</button>
          <span class="mute">writes manifest.jsonl beside the recordings, in the speech benchmark's format (evals/speech)</span>
        </form>
      {% endif %}
      {% if stt_bench %}<details style="margin-top:8px"><summary class="mute">Measured word error rate (with a language hint) and median latency</summary>
        <table class="bench"><tr><th>Model</th><th>Field fr A</th><th>Field fr B</th><th>FLEURS fr</th><th>FLEURS hi</th><th>Latency</th></tr>
          {% for id, r in stt_bench|dictsort %}<tr><td><code>{{ id }}</code>{% if id == sp.model %} <b>(current)</b>{% endif %}</td><td>{{ r[0] }}</td><td>{{ r[1] }}</td><td>{{ r[2] }}</td><td>{{ r[3] }}</td><td>{{ r[4] }}</td></tr>{% endfor %}
        </table></details>{% endif %}
    {% else %}
      <p class="mute">Speech-to-text isn't installed in this build of the assistant.</p>
    {% endif %}
  </div>

  {% if settings.language %}{% set lg = settings.language %}
  {% set names = {'auto': 'Follow the person (Superset language / browser)', 'en': 'English', 'fr': 'French', 'hi': 'Hindi', 'pt': 'Portuguese', "board": "The board's language", 'speaker': 'The language of the question'} %}
  {% set opts = lg.options if lg.options is mapping else {} %}
  <div class="lp-card">
    <h2>Chat language</h2>
    <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/language">
      <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
      <label>Replies in <select name="default" {% if not lg.writable %}disabled{% endif %}>{% for o in (opts.default or ['auto', 'en', 'fr', 'hi', 'pt']) %}<option value="{{ o }}" {% if o == lg.default %}selected{% endif %}>{{ names.get(o, o) }}</option>{% endfor %}</select></label>
      <label>Chart titles in <select name="titles" {% if not lg.writable %}disabled{% endif %}>{% for o in (opts.titles or ['board', 'speaker']) %}<option value="{{ o }}" {% if o == lg.titles %}selected{% endif %}>{{ names.get(o, o) }}</option>{% endfor %}</select></label>
      <label>Board language <select name="board" {% if not lg.writable %}disabled{% endif %}>{% for o in (opts.board or ['en', 'fr', 'hi', 'pt']) %}<option value="{{ o }}" {% if o == lg.board %}selected{% endif %}>{{ names.get(o, o) }}</option>{% endfor %}</select></label>
      <button type="submit" {% if not lg.writable %}disabled{% endif %}>Save</button>
      {% if lg.source == 'settings' %}<button class="ghost" type="submit" name="reset" value="1" {% if not lg.writable %}disabled{% endif %}>Back to defaults</button>{% endif %}
    </form>
  </div>
  {% endif %}

  {% if settings.telemetry %}{% set tl = settings.telemetry %}
  <div class="lp-card">
    <h2>Usage telemetry</h2>
    <p class="mute" style="margin:0 0 8px">One record per question (who asked, the kind of question, how it went, time and cost) and the thumbs under each answer, in <code>{{ tl.file }}</code>.
      {% if not tl.enabled %}<span class="bad">Off (Off switches).</span>{% endif %} Read it as an admin at <code>{{ lenspack_path }}/_superset/telemetry</code>.
      What is recorded, item by item, is switched on the <a href="{{ lenspack_path }}/_superset/admin/#telemetry" target="_blank" rel="noopener">admin panel's Telemetry tab</a>.</p>
    <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/telemetry">
      <input type="hidden" name="csrf_token" value="{{ csrf_token() }}">
      <label class="mute">Keep for <input type="number" name="retentionDays" min="1" max="3650" value="{{ tl.retentionDays }}" style="width:80px" {% if not tl.writable %}disabled{% endif %}> days</label>
      <button type="submit" {% if not tl.writable %}disabled{% endif %}>Save</button>
      {% if tl.source == 'settings' %}<button class="ghost" type="submit" name="reset" value="1" {% if not tl.writable %}disabled{% endif %}>Back to defaults</button>{% endif %}
    </form>
  </div>
  {% endif %}

  {% if settings.features %}{% set ft = settings.features %}
  {% set from = {'config': 'set in the config file', 'env': 'set by LENSPACK_FEATURES', 'settings': 'set on this page'} %}
  <div class="lp-card">
    <h2>Off switches</h2>
    <p class="mute">Turn parts of the assistant off for everyone. A change applies to the next dashboard each person opens.</p>
    <form class="lp-form" method="post" action="{{ lenspack_root }}/ai-assistant/features">
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
    <h2>The assistant's server</h2>
    <table>
      <tr><th>Status</th><td>
        {% if settings %}<span class="ok">● running</span>
        {% elif info %}<span class="ok">● running</span> <span class="mute">(this version of the server reports less; update it for the full page)</span>
        {% else %}<span class="bad">● not reachable</span> <span class="mute">{{ settings_error }}</span>{% endif %}
      </td></tr>
      <tr><th>Address inside the cluster</th><td><code>{{ internal_url }}</code> <span class="mute">(<code>LENSPACK_INTERNAL_URL</code>)</span></td></tr>
      {% set s = settings or info or {} %}
      {% if s.pack %}<tr><th>Pack</th><td><code>{{ s.pack }}</code></td></tr>{% endif %}
      {% if settings %}
        <tr><th>Datasets it reads</th><td>{% for d in settings.datasets %}<code>{{ d.schema ~ '.' if d.schema }}{{ d.table }}</code> as <b>{{ d.entity }}</b>{% if not loop.last %}<br>{% endif %}{% endfor %}</td></tr>
        <tr><th>Vocabulary</th><td>{{ settings.dimensions }} dimensions, {{ settings.measures|length }} measures
          <details><summary class="mute">measures</summary>{% for m in settings.measures %}<code>{{ m.key }}</code> {{ m.label }} <span class="mute">({{ m.agg }})</span><br>{% endfor %}</details></td></tr>
        <tr><th>Superset account</th><td><code>{{ settings.superset.username }}</code>{% if account_roles is not none %} · roles: {{ account_roles|join(', ') or 'none' }}{% endif %}
          {% if settings.superset.account %}<span class="mute">({{ {'bootstrap': 'made by the assistant on first start', 'state': 'made by the assistant; password in its state directory', 'env': 'password from an environment variable'}.get(settings.superset.account, settings.superset.account) }})</span>{% endif %}</td></tr>
        <tr><th>Who may edit dashboards</th><td>{% if settings.editPolicy == 'signed-in' %}Anyone signed in to Superset <span class="mute">(edit policy <code>signed-in</code>)</span>{% else %}Whoever Superset lets edit that dashboard: its owners with write access, and admins. Everyone who can view it may ask questions. <span class="mute">(edit policy <code>superset</code>, the default)</span>{% endif %}</td></tr>
        {% if settings.hostPolicy %}<tr><th>Whose access applies to answers</th><td>{% if settings.hostPolicy == 'off' %}<strong>The assistant's own account, for everyone.</strong> Anyone signed in reads every configured dataset in full, without Superset's dataset permissions or row-level security. <span class="mute">(<code>hostPolicy: off</code>)</span>{% else %}Each user's own Superset access: their dataset permissions, row-level security and the dashboards they may open. <span class="mute">(<code>hostPolicy: superset</code>, the default)</span>{% endif %}</td></tr>{% endif %}
        <tr><th>Dashboards bound</th><td>{{ settings.dashboards|join(', ') or 'none yet (a dashboard binds when the chat opens on it)' }}</td></tr>
      {% elif account_roles is not none %}
        <tr><th>Superset account</th><td><code>{{ service_user }}</code> · roles: {{ account_roles|join(', ') or 'none' }}</td></tr>
      {% endif %}
      {% if settings %}<tr><th>Chat opens as</th><td>{{ 'a side panel' if settings.panel == 'dock' else 'a floating window' }} <span class="mute">(default for everyone, set by <code>overlay.panel</code> in the config; each person can change it with the gear in the chat)</span></td></tr>{% endif %}
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
      {% else %}<p class="mute">Shown once the assistant's server reports its settings.</p>{% endif %}
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
        {% for r in turns.recent %}<tr><td>{{ r.at[:19]|replace('T', ' ') }}</td><td>{{ r.user }}</td><td>{% if r.board and r.board.startswith('superset-') %}<a href="{{ lenspack_root }}/superset/dashboard/{{ r.board[9:] }}/">{{ r.board[9:] }}</a>{% else %}{{ r.board or '' }}{% endif %}</td><td><code>{{ r.models|join(', ') }}</code></td><td>{{ '{:,}'.format(r.tokens['in']) }} / {{ '{:,}'.format(r.tokens.out) }}</td><td>≈ ${{ '%.4f'|format(r.costUsd) }}{% if r.sttUsd %} <span class="mute">(speech ${{ '%.4f'|format(r.sttUsd) }})</span>{% endif %}</td></tr>
        {% endfor %}
      </table>
    </details>
    {% else %}<p class="mute">No answers in the last 7 days.</p>{% endif %}
  </div>
  {% endif %}

  <div class="lp-card">
    <h2>Audit log</h2>
    {% if audit and audit.enabled %}
      <p class="mute" style="margin:0 0 8px">Every board change, refused change, chat turn and settings change, with who made it. Kept {{ audit.retentionDays }} days in the assistant's state directory (<code>audit.jsonl</code>, one file a month); the spend figures above reset when its server restarts, this does not.</p>
      <table class="bench">
        <tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Outcome</th><th>Detail</th></tr>
        {% for e in audit.events %}<tr><td>{{ e.at[:19]|replace('T', ' ') }}</td><td>{{ e.user }}</td><td>{{ e.action }}{% if e.board %} <span class="mute">{{ e.board }}</span>{% endif %}</td><td class="{{ 'ok' if e.outcome == 'ok' else 'bad' }}">{{ e.outcome }}</td><td class="mute">{{ (e.detail or '')[:120] }}</td></tr>
        {% else %}<tr><td colspan="5" class="mute">Nothing yet this month.</td></tr>{% endfor %}
      </table>
      {% if audit.months|length > 1 %}<p class="mute" style="margin:6px 0 0">Earlier months on file: {{ audit.months[1:]|join(', ') }}.</p>{% endif %}
    {% elif audit %}<p class="mute">Off (<code>audit: false</code> in the config).</p>
    {% else %}<p class="mute">Not available: {{ audit_error or 'this version of the server has no audit log' }}</p>{% endif %}
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
      <tr><th>Chat and speech models</th><td>On this page (saved in the assistant's state, kept across restarts)</td></tr>
      <tr><th>LLM and speech keys</th><td><code>ANTHROPIC_API_KEY</code>, <code>LENSPACK_LLM_PROVIDERS</code>, <code>OPENROUTER_API_KEY</code> in the assistant's environment</td></tr>
      <tr><th>Datasets, guidance, budget</th><td>The assistant's config file (<code>--config &lt;file&gt;</code>)</td></tr>
      <tr><th>Who may use the chat</th><td>Anyone signed in to Superset who can view the dashboard. Superset's <code>{{ lenspack_path }}/</code> route checks the session and signs who is asking for every request to the assistant.</td></tr>
      <tr><th>Whose data access applies</th><td><code>LENSPACK_HOST_POLICY</code> on the assistant's container: <code>superset</code> (default), each user's own dataset access and row-level security; <code>off</code>, the answers use what the assistant's own account may read.</td></tr>
      <tr><th>Who may edit through it</th><td><code>LENSPACK_EDIT_POLICY</code> on the assistant's container: <code>superset</code> (default) or <code>signed-in</code>. The Dashboard edits switch above turns edits off for everyone.</td></tr>
      <tr><th>Off switches</th><td>On this page, or <code>features:</code> in the assistant's config file and <code>LENSPACK_FEATURES</code> on its container (this page wins)</td></tr>
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
    <a class="lp-home" href="{{ lenspack_root }}/superset/welcome/">Superset</a><span class="lp-sep">/</span><span class="lp-sep">Settings</span><span class="lp-sep">/</span><b>{{ lp_brand | default("AI assistant") }}</b>
    <a class="lp-back" href="{{ lenspack_root }}/superset/welcome/">← Back to Superset</a>
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
