"""Tests for lenspack_superset.py. They need Superset's own Python environment, so they run in its image, once for
each supported version. Superset 6.1:

    docker run --rm -e SUPERSET_CONFIG_PATH=/cfg/superset_config.py -e PYTHONPATH=/plugin:/cfg \\
      -v "$PWD/packages/hosts/superset/plugin:/plugin:ro" -v "$PWD/<a folder with superset_config.py>:/cfg:ro" \\
      apache/superset:6.1.0 sh -c 'superset db upgrade && superset init && python -m unittest discover -s /plugin'

Superset 5.0: the same with apache/superset:5.0.0.

The ClickHouse query test runs only when LENSPACK_TEST_CLICKHOUSE is a clickhousedb:// URI of a ClickHouse the
container can reach (it makes and drops one table), in an image with clickhouse-connect installed (0.13 or later
for 6.1); add --network and -e LENSPACK_TEST_CLICKHOUSE to the command above.

where superset_config.py sets SECRET_KEY, a SQLite SQLALCHEMY_DATABASE_URI, PREVENT_UNSAFE_DB_CONNECTIONS = False,
FEATURE_FLAGS = {"ENABLE_TEMPLATE_PROCESSING": True} (Superset renders RLS templates only with it),
and ends with `from lenspack_superset import *`. RlsClauses and Route need only the module. ProxyEndpoint makes
users and dashboards and sends /lenspack/... requests through Flask's test client, with the forward to Lenspack
caught. AccessEndpoint makes a throwaway SQLite database, a dataset, a role with access to it, users and RLS rules
in Superset's metadata, and dashboards with and without dashboard roles, and calls /api/v1/lenspack/access (and
/api/v1/lenspack/version) through Flask's test client; it turns DASHBOARD_RBAC on and off itself where a case needs it. SettingsPage renders Settings -> AI assistant as an admin, with Lenspack unreachable. ClickHouseLabels
checks the ClickHouse column-name suffix, and runs a query against ClickHouse when one is given (above).
"""

import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace

import lenspack_superset as lp

PASSWORD = "test-password-0123456789"
_APP = None


def superset_app():
    """One Superset app per process: Flask-AppBuilder's views can be registered only once."""
    global _APP
    if _APP is None:
        from superset.app import create_app

        _APP = create_app()
    return _APP


class RlsClauses(unittest.TestCase):
    def test_renders_each_and_ors_a_group(self):
        filters = [
            SimpleNamespace(clause="a = 1", group_key=None),
            SimpleNamespace(clause="r = 'x'", group_key="g"),
            SimpleNamespace(clause="r = '{{ who }}'", group_key="g"),
            SimpleNamespace(clause="t = 2", group_key="h"),
        ]
        rendered = lp.lenspack_rls_clauses(filters, lambda c: c.replace("{{ who }}", "y"))
        self.assertEqual(rendered, ["a = 1", "(r = 'x') OR (r = 'y')", "t = 2"])


class StampNonce(unittest.TestCase):
    def test_adds_the_nonce_to_script_tags_only(self):
        page = b'<script src="a.js"></script><Script>x()</Script><scripts><script nonce="n0"></script><script/>'
        self.assertEqual(lp.lenspack_stamp_nonce(page, "n1"), b'<script nonce="n1" src="a.js"></script><Script nonce="n1">x()</Script><scripts><script nonce="n0"></script><script nonce="n1"/>')
        self.assertEqual(lp.lenspack_stamp_nonce(page, ""), page)
        self.assertEqual(lp.lenspack_stamp_nonce(b"<script>", 'a"b'), b'<script nonce="a&quot;b">')


class Route(unittest.TestCase):
    """lenspack_route gets the path as Flask hands it over: decoded once, so %2e%2e is already "..", %2f is "/",
    and a doubly encoded %252e is "%2e"."""

    def test_reads_the_board_where_lenspack_reads_it(self):
        self.assertEqual(lp.lenspack_route("api/hcm/superset-7/ops"), {"path": "api/hcm/superset-7/ops", "pack": "hcm", "dashboard": 7})
        self.assertEqual(lp.lenspack_route("api/hcm/superset-7")["dashboard"], 7)
        # A board elsewhere in the path is not the board Lenspack acts on, so it is about no dashboard.
        for path in ["api/hcm/b_123/superset-7", "api/hcm/superset-7x/ops", "api/_usage/superset-7", "api/_stt/superset-7", "x/hcm/superset-7/ops", "api//superset-7/ops", "_superset/bind", ""]:
            self.assertIsNone(lp.lenspack_route(path)["dashboard"], path)

    def test_refuses_dot_segments_and_encoded_dots_and_slashes(self):
        for path in [
            "api/hcm/superset-1/../superset-2/ops",
            "api/hcm/superset-1/./../superset-2/ops",
            "api/hcm/superset-1/..",
            "api/hcm/../hcm/superset-2/ops",
            "../api/hcm/superset-2/ops",
            "api/hcm/superset-1/./ops",
            "api/hcm/superset-1/%2e%2e/superset-2/ops",
            "api/hcm/superset-1/%2E%2E/superset-2/ops",
            "api/hcm/superset-1/.%2e/superset-2/ops",
            "api/hcm/superset-1%2f..%2fsuperset-2/ops",
            "api/hcm/superset-1/..%5csuperset-2/ops",
            "api/hcm/superset-1/..\\superset-2/ops",
        ]:
            self.assertIsNone(lp.lenspack_route(path), path)

    def test_leaves_dots_inside_a_name_alone(self):
        self.assertEqual(lp.lenspack_route("chat.js")["path"], "chat.js")
        # Lenspack reads the same parts: board superset-3, action "ops;x" (which it does not know).
        self.assertEqual(lp.lenspack_route("api/hcm/superset-3/ops;x")["dashboard"], 3)
        self.assertIsNone(lp.lenspack_route("api/hcm/superset-3;x/ops")["dashboard"])


class ProxyEndpoint(unittest.TestCase):
    """/lenspack/... through Flask's test client, with the forward to Lenspack caught: what is sent, and what is signed."""

    @classmethod
    def setUpClass(cls):
        cls.app = superset_app()
        cls.ctx = cls.app.app_context()
        cls.ctx.push()
        from superset.extensions import db, security_manager as sm
        from superset.models.dashboard import Dashboard

        def user(name, roles):
            return sm.find_user(username=name) or sm.add_user(name, name, "Test", f"{name}@example.invalid", roles, password=PASSWORD)

        # Gamma has can_write on Dashboard; a dashboard with no charts is viewable by anyone signed in.
        cls.owner = user("lp_proxy_owner", [sm.find_role("Gamma")])
        admin = user("lp_proxy_admin", [sm.find_role("Admin")])
        mine = Dashboard(dashboard_title=f"lp mine {os.getpid()}", published=True)
        mine.owners = [cls.owner]
        other = Dashboard(dashboard_title=f"lp other {os.getpid()}", published=True)
        other.owners = [admin]
        # A dashboard whose slug is another dashboard's id: digits always mean an id.
        lookalike = Dashboard(dashboard_title=f"lp lookalike {os.getpid()}", published=True)
        lookalike.owners = [cls.owner]
        db.session.add_all([mine, other, lookalike])
        db.session.commit()
        lookalike.slug = str(other.id)
        db.session.commit()
        cls.mine, cls.other = mine.id, other.id
        cls.client = cls.app.test_client()
        with cls.client.session_transaction() as s:
            s["_user_id"] = str(cls.owner.id)
            s["_fresh"] = True

    @classmethod
    def tearDownClass(cls):
        cls.ctx.pop()

    def send(self, method, path, upstream=("application/json", [b"{}"]), **kw):
        """The response, and the (url, claims) forwarded to Lenspack, or None when nothing was forwarded. Lenspack
        answers with upstream: (content type, the chunks of its body)."""
        import base64
        import json
        from unittest import mock

        forwarded = []

        def fake(method_, url, **kwargs):
            body = kwargs["headers"]["x-lenspack-identity"].split(".")[0]
            forwarded.append((url, json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))))
            return mock.Mock(status_code=200, headers={"content-type": upstream[0]}, iter_content=lambda chunk_size=None: iter(upstream[1]), close=lambda: None)

        with mock.patch("requests.request", side_effect=fake):
            r = self.client.open(path, method=method, **kw)
        return r, (forwarded[0] if forwarded else None)

    def test_signs_the_board_and_pack_it_checked(self):
        r, (url, claims) = self.send("POST", f"/lenspack/api/hcm/superset-{self.mine}/ops", json={"ops": []})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(url.endswith(f"/api/hcm/superset-{self.mine}/ops"), url)
        self.assertEqual((claims["d"], claims["b"], claims["p"], claims["e"], claims["v"]), (self.mine, f"superset-{self.mine}", "hcm", True, True))
        _, (_, claims) = self.send("POST", f"/lenspack/api/hcm/superset-{self.other}/ops", json={"ops": []})
        self.assertEqual((claims["d"], claims["b"], claims["e"]), (self.other, f"superset-{self.other}", False))

    def test_never_forwards_a_path_with_dot_segments_or_encoded_dots_and_slashes(self):
        for path in [
            f"/lenspack/api/hcm/superset-{self.mine}/../superset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/%2e%2e/superset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/%2E%2E/superset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/.%2e/superset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/..%2fsuperset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}%2f..%2fsuperset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/%252e%252e/superset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/..%5csuperset-{self.other}/ops",
            f"/lenspack/api/hcm/superset-{self.mine}/../../_usage",
        ]:
            r, forwarded = self.send("POST", path, json={"ops": []})
            self.assertEqual((r.status_code, forwarded), (400, None), path)

    def test_signs_no_dashboard_where_lenspack_reads_none(self):
        for path in [f"/lenspack/api/_usage/superset-{self.mine}", f"/lenspack/api/hcm/boards/superset-{self.mine}", f"/lenspack/api/hcm/superset-{self.other}/ops/superset-{self.mine}"]:
            _, (_, claims) = self.send("GET", path)
            self.assertNotEqual(claims.get("d"), self.mine, path)
            self.assertFalse(claims.get("e", False), path)

    def test_signs_the_users_role_names_on_every_request_telemetry_reads(self):
        # Telemetry records the Superset role names: on a dashboard's board, on the telemetry and speech routes alike.
        for method, path in [("POST", f"/lenspack/api/hcm/superset-{self.mine}/chat"), ("POST", "/lenspack/api/_telemetry"), ("POST", "/lenspack/api/_stt"), ("GET", "/lenspack/_superset/info")]:
            r, (url, claims) = self.send(method, path, json={})
            r.get_data()
            self.assertEqual(r.status_code, 200, path)
            self.assertEqual(claims["r"], ["Gamma"], path)

    def test_an_identity_without_roles_has_no_r_claim(self):
        # Older callers sign no roles; Lenspack then records none (backward compatible both ways).
        import base64
        import json

        body = lp.lenspack_sign("alice", False).split(".")[0]
        self.assertNotIn("r", json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))))

    def test_digits_are_an_id_never_a_slug(self):
        # The lookalike's slug is OTHER's id, and the owner owns the lookalike: the rights are still OTHER's.
        _, (_, claims) = self.send("GET", f"/lenspack/api/hcm/superset-{self.other}")
        self.assertEqual((claims["d"], claims["e"]), (self.other, False))
        _, (_, claims) = self.send("GET", "/lenspack/_superset/bind", query_string={"dashboard": str(self.other)})
        self.assertEqual((claims["d"], claims["e"]), (self.other, False))

    # A page as Lenspack serves one: scripts by src and inline, in any case, one that has a nonce already, and
    # look-alikes that are not script tags.
    PAGE = [b'<!doctype html><title>x</title><link rel="stylesheet" href="panel.css">\n<script>/*vars*/</script>\n',
            b'<SCRIPT src="checklist.js"></SCRIPT>\n<script\tsrc="panel.js" defer></script>\n<script nonce="theirs">1</script>\n',
            b'<scripts></scripts><p data-x="<script">text</p><script data-nonce="x" src="a.js"></script>']

    @staticmethod
    def nonce_of(response):
        import re

        m = re.search(r"'nonce-([^']+)'", response.headers.get("Content-Security-Policy", ""))
        return m.group(1) if m else None

    def test_a_page_s_scripts_get_the_request_s_nonce(self):
        if not self.app.config.get("TALISMAN_ENABLED"):
            self.skipTest("Talisman is off in this config")
        r, _ = self.send("GET", "/lenspack/_superset/admin/", upstream=("text/html; charset=utf-8", self.PAGE))
        self.assertEqual(r.status_code, 200)
        nonce = self.nonce_of(r)
        self.assertTrue(nonce, r.headers.get("Content-Security-Policy"))
        html = r.get_data(as_text=True)
        self.assertEqual(html, b"".join(self.PAGE).decode().replace("<script>", f'<script nonce="{nonce}">').replace("<SCRIPT src", f'<SCRIPT nonce="{nonce}" src').replace("<script\tsrc", f'<script nonce="{nonce}"\tsrc').replace("<script data-nonce", f'<script nonce="{nonce}" data-nonce'))
        self.assertIn('<script nonce="theirs">', html)
        self.assertEqual(int(r.headers["Content-Length"]), len(r.get_data()))

    def test_anything_else_streams_through_untouched(self):
        body = [b'{"html": "<script src=x>', b'</script>"}']
        r, _ = self.send("GET", "/lenspack/_superset/dashboards", upstream=("application/json", body))
        self.assertEqual(r.get_data(), b"".join(body))
        r, _ = self.send("POST", "/lenspack/api/hcm/chat", upstream=("text/event-stream", [b"data: <script>\n\n"]), json={})
        self.assertEqual(r.get_data(), b"data: <script>\n\n")
        self.assertNotIn("Content-Length", r.headers)  # streamed as it came, not read whole

    def test_without_a_nonce_a_page_is_untouched(self):
        # As with Talisman off: no Content-Security-Policy, so no nonce to add.
        # Talisman reads a view's own options from the view function, per request.
        view = self.app.view_functions["lenspack_proxy"]
        view.talisman_view_options = {"content_security_policy": None}
        try:
            r, _ = self.send("GET", "/lenspack/_superset/admin/", upstream=("text/html", self.PAGE))
        finally:
            del view.talisman_view_options
        self.assertIsNone(self.nonce_of(r))
        self.assertEqual(r.get_data(), b"".join(self.PAGE))


    def test_signs_the_users_superset_id(self):
        # Lenspack makes a person's own dashboards theirs in Superset by this id.
        _, (_, claims) = self.send("GET", f"/lenspack/api/hcm/superset-{self.mine}")
        self.assertEqual(claims["i"], self.owner.id)
        _, (_, claims) = self.send("GET", "/lenspack/_superset/info")
        self.assertEqual(claims["i"], self.owner.id)

    def test_own_dashboard_routes_carry_the_rights_on_the_dashboard_named(self):
        # Copy this one, save its layout, apply a layout here: ?dashboard= is signed like bind's.
        for path in ["/lenspack/_superset/my", "/lenspack/_superset/my/dashboards", "/lenspack/_superset/my/layouts", "/lenspack/_superset/my/layouts/l_abc/apply"]:
            method = "GET" if path.endswith("/my") else "POST"
            _, (_, claims) = self.send(method, path, query_string={"dashboard": str(self.mine)}, json={})
            self.assertEqual((claims["d"], claims["e"], claims["v"]), (self.mine, True, True), path)
            _, (_, claims) = self.send(method, path, query_string={"dashboard": str(self.other)}, json={})
            self.assertEqual((claims["d"], claims["e"]), (self.other, False), path)
        # Elsewhere ?dashboard= means nothing.
        _, (_, claims) = self.send("GET", "/lenspack/_superset/info", query_string={"dashboard": str(self.mine)})
        self.assertNotIn("d", claims)


class AccessEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = superset_app()
        cls.ctx = cls.app.app_context()
        cls.ctx.push()
        from superset.connectors.sqla.models import RowLevelSecurityFilter, SqlaTable, TableColumn
        from superset.extensions import db, security_manager as sm
        from superset.models.core import Database
        from superset.utils.core import RowLevelSecurityFilterType

        # Unique names, so the test can run again on the same metadata database.
        name = f"visits_{os.getpid()}"
        path = os.path.join(tempfile.mkdtemp(), "data.db")
        con = sqlite3.connect(path)
        con.execute(f"create table {name} (region text, team text)")
        con.commit()
        con.close()
        database = Database(database_name=f"lenspack_test_{os.getpid()}", sqlalchemy_uri=f"sqlite:///{path}")
        db.session.add(database)
        db.session.flush()
        table = SqlaTable(table_name=name, database=database)
        table.columns = [TableColumn(column_name="region", type="TEXT"), TableColumn(column_name="team", type="TEXT")]
        db.session.add(table)
        db.session.flush()
        perm = sm.add_permission_view_menu("datasource_access", table.get_perm())
        sales = sm.find_role("LenspackSales") or sm.add_role("LenspackSales")
        sm.add_permission_role(sales, perm)
        gamma = sm.find_role("Gamma")

        def user(name, roles):
            return sm.find_user(username=name) or sm.add_user(name, name, "Test", f"{name}@example.invalid", roles, password=PASSWORD)

        user("lp_admin", [sm.find_role("Admin")])
        user("alice", [gamma, sales])
        user("bob", [gamma])
        for name, clause, group in [("lp_north", "region = 'north'", "region"), ("lp_south", "region = 'south'", "region"), ("lp_team", "team = '{{ current_username() }}'", None)]:
            rule = RowLevelSecurityFilter(name=f"{name}_{os.getpid()}", filter_type=RowLevelSecurityFilterType.REGULAR, clause=clause, group_key=group)
            rule.roles = [sales]
            rule.tables = [table]
            db.session.add(rule)
        db.session.commit()
        cls.table = str(table.id)
        # A dashboard with a chart on the table, and one with a dashboard role: alice may open the first (she reads
        # the table), bob neither; the dashboard role opens the second for its members only.
        from superset.models.dashboard import Dashboard
        from superset.models.slice import Slice

        chart = Slice(slice_name=f"lp chart {os.getpid()}", datasource_type="table", datasource_id=table.id, viz_type="table", params="{}")
        mine = Dashboard(dashboard_title=f"lp table {os.getpid()}", published=True, slices=[chart])
        board_role = sm.find_role("LenspackBoard") or sm.add_role("LenspackBoard")
        roled = Dashboard(dashboard_title=f"lp roled {os.getpid()}", published=True, slices=[])
        roled.roles = [board_role]
        user("carol", [gamma, board_role])
        # Dashboard roles on a dashboard with a chart on the table: dave is in its role and reads no dataset, and an
        # RLS rule of that role narrows the table for him. The same chart on an unpublished dashboard with the same
        # role: Superset opens it to its owners and admins only.
        charted_role = sm.find_role("LenspackCharted") or sm.add_role("LenspackCharted")
        dave = user("dave", [gamma, charted_role])
        rule = RowLevelSecurityFilter(name=f"lp_charted_{os.getpid()}", filter_type=RowLevelSecurityFilterType.REGULAR, clause="team = '{{ current_username() }}'")
        rule.roles = [charted_role]
        rule.tables = [table]
        db.session.add(rule)
        charted = Dashboard(dashboard_title=f"lp charted {os.getpid()}", published=True, slices=[chart])
        charted.roles = [charted_role]
        draft = Dashboard(dashboard_title=f"lp draft {os.getpid()}", published=False, slices=[chart])
        draft.roles = [charted_role]
        # An owner of the draft who is not in its role: owners open a dashboard whether or not it is published.
        erin = user("erin", [gamma])
        draft.owners = [erin]
        db.session.add_all([chart, mine, roled, charted, draft])
        db.session.commit()
        cls.dash, cls.roled, cls.charted, cls.draft = str(mine.id), str(roled.id), str(charted.id), str(draft.id)
        del dave
        cls.client = cls.app.test_client()
        cls.admin = cls.token("lp_admin")

    @classmethod
    def tearDownClass(cls):
        cls.ctx.pop()

    @classmethod
    def token(cls, username):
        r = cls.client.post("/api/v1/security/login", json={"username": username, "password": PASSWORD, "provider": "db", "refresh": False})
        return {"Authorization": f"Bearer {r.get_json()['access_token']}"}

    def access(self, user, headers=None):
        return self.client.get(f"/api/v1/lenspack/access?user={user}&datasets={self.table},999999", headers=self.admin if headers is None else headers)

    def test_a_user_with_access_gets_their_rls_rendered_and_grouped(self):
        r = self.access("alice")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        datasets = r.get_json()["result"]["datasets"]
        self.assertTrue(datasets[self.table]["access"])
        self.assertEqual(sorted(datasets[self.table]["rls"]), sorted(["team = 'alice'", "(region = 'north') OR (region = 'south')"]))
        self.assertEqual(datasets["999999"], {"access": False, "rls": []})

    def test_a_user_without_access_is_told_so(self):
        datasets = self.access("bob").get_json()["result"]["datasets"]
        self.assertEqual(datasets[self.table], {"access": False, "rls": []})

    def test_says_which_dashboards_each_user_may_open(self):
        def dashboards(user):
            r = self.client.get(f"/api/v1/lenspack/access?user={user}&datasets=&dashboards={self.dash},{self.roled},999999", headers=self.admin)
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
            return r.get_json()["result"]["dashboards"]

        # With DASHBOARD_RBAC on, the role decides the second; without it, a dashboard with no charts opens for anyone.
        rbac = bool(self.app.config["FEATURE_FLAGS"].get("DASHBOARD_RBAC"))
        self.assertEqual(dashboards("alice"), {self.dash: True, self.roled: not rbac, "999999": False})
        self.assertEqual(dashboards("bob"), {self.dash: False, self.roled: not rbac, "999999": False})
        self.assertEqual(dashboards("carol"), {self.dash: False, self.roled: True, "999999": False})
        self.assertEqual(dashboards("lp_admin"), {self.dash: True, self.roled: True, "999999": False})

    def on_dashboards(self, user, rbac):
        """The access answer for one user about the table and every test dashboard, with DASHBOARD_RBAC on or off."""
        from superset.extensions import feature_flag_manager

        flags = feature_flag_manager._feature_flags
        before = dict(flags)
        flags["DASHBOARD_RBAC"] = rbac
        try:
            ids = ",".join([self.dash, self.roled, self.charted, self.draft, "999999"])
            r = self.client.get(f"/api/v1/lenspack/access?user={user}&datasets={self.table},999999&dashboards={ids}", headers=self.admin)
        finally:
            flags.clear()
            flags.update(before)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        return r.get_json()["result"]

    def test_dashboard_roles_open_a_dashboard_s_chart_datasets_on_that_dashboard_only(self):
        r = self.on_dashboards("dave", True)
        self.assertTrue(r["dashboardRbac"])
        table = int(self.table)
        # The charted dashboard opens through its role and reads the table there; nowhere else does.
        self.assertEqual(r["dashboardDatasets"], {self.dash: [], self.roled: [], self.charted: [table], self.draft: [], "999999": []})
        self.assertEqual((r["dashboards"][self.charted], r["dashboards"][self.draft], r["dashboards"][self.dash]), (True, False, False))
        # Not readable in general; its RLS for dave comes with it, rendered as dave, as Superset applies RLS there too.
        self.assertEqual(r["datasets"][self.table], {"access": False, "rls": ["team = 'dave'"]})
        self.assertEqual(r["datasets"]["999999"], {"access": False, "rls": []})

    def test_superset_grants_nothing_through_a_dashboard_with_dashboard_roles_off(self):
        r = self.on_dashboards("dave", False)
        self.assertFalse(r["dashboardRbac"])
        self.assertEqual(r["dashboardDatasets"], {self.dash: [], self.roled: [], self.charted: [], self.draft: [], "999999": []})
        self.assertEqual(r["datasets"][self.table], {"access": False, "rls": []})

    def test_only_the_role_s_members_and_owners_get_a_dashboard_s_datasets(self):
        table = int(self.table)
        # alice reads the table everywhere: nothing is listed for her as only-on-a-dashboard.
        self.assertEqual(self.on_dashboards("alice", True)["dashboardDatasets"][self.charted], [])
        # bob and carol are in neither role of the charted dashboard.
        for user in ("bob", "carol"):
            self.assertEqual(set(map(tuple, self.on_dashboards(user, True)["dashboardDatasets"].values())), {()}, user)
        # erin owns the unpublished draft (not in its role): Superset opens it to her and its chart reads the table.
        erin = self.on_dashboards("erin", True)
        self.assertEqual((erin["dashboardDatasets"][self.draft], erin["dashboardDatasets"][self.charted]), ([table], []))

    def test_the_identity_header_carries_the_role_names(self):
        import base64
        import json

        body = lp.lenspack_sign("alice", False, roles=["LenspackSales", "Gamma"]).split(".")[0]
        claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        self.assertEqual((claims["u"], claims["a"], claims["r"]), ("alice", False, ["Gamma", "LenspackSales"]))

    def test_only_admins_and_the_service_account_may_ask(self):
        self.assertEqual(self.access("alice", headers={}).status_code, 401)
        self.assertEqual(self.access("alice", headers=self.token("alice")).status_code, 403)
        missing = self.access("nobody-here")
        self.assertEqual((missing.status_code, missing.get_json()["message"]), (404, "no such user"))

    def test_the_version_is_told_to_admins_and_the_service_account_only(self):
        r = self.client.get("/api/v1/lenspack/version", headers=self.admin)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertEqual(r.get_json()["result"]["superset"], self.app.config["VERSION_STRING"])
        self.assertRegex(r.get_json()["result"]["superset"], r"^[56]\.")
        self.assertEqual(self.client.get("/api/v1/lenspack/version").status_code, 401)
        self.assertEqual(self.client.get("/api/v1/lenspack/version", headers=self.token("alice")).status_code, 403)


class SettingsPage(unittest.TestCase):
    """Settings → AI assistant, as an admin, with Lenspack unreachable (the page says so and still renders)."""

    @classmethod
    def setUpClass(cls):
        cls.app = superset_app()
        cls.ctx = cls.app.app_context()
        cls.ctx.push()
        from superset.extensions import security_manager as sm

        admin = sm.find_user(username="lp_settings_admin") or sm.add_user("lp_settings_admin", "lp", "Test", "lp_settings_admin@example.invalid", [sm.find_role("Admin")], password=PASSWORD)
        cls.client = cls.app.test_client()
        with cls.client.session_transaction() as s:
            s["_user_id"] = str(admin.id)
            s["_fresh"] = True

    @classmethod
    def tearDownClass(cls):
        cls.ctx.pop()

    def page(self, flashes=()):
        import urllib.error
        from unittest import mock

        with self.client.session_transaction() as s:
            s["_flashes"] = list(flashes)
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("no Lenspack in the tests")):
            return self.client.get("/ai-assistant/")

    def test_uses_superset_5s_page_frame_or_its_own_on_superset_6(self):
        # Superset 6 dropped the server-rendered page frame (superset/basic.html) that 5 had.
        major = int(self.app.config["VERSION_STRING"].split(".")[0])
        self.assertEqual(lp.lenspack_settings_layout(self.app), "lenspack/layout.html" if major >= 6 else "appbuilder/base.html")
        r = self.page()
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:500])
        html = r.get_data(as_text=True)
        self.assertIn("AI assistant", html)
        # Without LENSPACK_BRAND_NAME in superset_config, the heading and the button are named as before.
        self.assertIn("<h1>AI assistant</h1>", html)
        self.assertIn("<b>Ask Lenspack</b>", html)
        self.assertIn("no Lenspack in the tests", html)
        if major >= 6:
            # Its own frame follows Superset's light or dark theme, and its script carries the page's nonce.
            self.assertIn("superset-theme-mode", html)
            self.assertIn("Back to Superset", html)

    def test_shows_its_own_messages_and_not_superset_s_leftovers(self):
        import re

        html = self.page([("lenspack-info", "Chat language saved."), ("lenspack-danger", "Chat model not saved: nope"), ("message", "A message left from another page")]).get_data(as_text=True)
        # Superset 5 also hands every message to its menu bar, in the page's bootstrap data; the page's own list is what counts.
        html = re.sub(r'data-bootstrap="[^"]*"', "", html)
        self.assertIn("Chat language saved.", html)
        self.assertIn("Chat model not saved: nope", html)
        self.assertNotIn("A message left from another page", html)


class BrandLabel(unittest.TestCase):
    """The menu entry's and settings page's name: superset_config's optional LENSPACK_BRAND_NAME, else today's."""

    def test_reads_the_optional_key_and_keeps_todays_name_without_it(self):
        self.assertEqual(lp.lenspack_brand_label({}), "AI assistant")
        self.assertEqual(lp.lenspack_brand_label({"LENSPACK_BRAND_NAME": None}), "AI assistant")
        self.assertEqual(lp.lenspack_brand_label({"LENSPACK_BRAND_NAME": "  "}), "AI assistant")
        self.assertEqual(lp.lenspack_brand_label({"LENSPACK_BRAND_NAME": " Campaign assistant "}), "Campaign assistant")
        self.assertEqual(len(lp.lenspack_brand_label({"LENSPACK_BRAND_NAME": "x" * 90})), 40)


class ClickHouseLabels(unittest.TestCase):
    """A saved metric named like the column it sums (`SUM(x)` saved as x), beside a metric that uses x again. Without the
    alias suffix, Superset 6.1 writes `SUM(x) AS x` and ClickHouse reads the second metric's x as that alias (error 184)."""

    @classmethod
    def setUpClass(cls):
        cls.app = superset_app()  # the app start puts the suffix back where Superset no longer adds it
        cls.ctx = cls.app.app_context()
        cls.ctx.push()

    @classmethod
    def tearDownClass(cls):
        cls.ctx.pop()

    def test_aliases_carry_a_suffix_on_every_version(self):
        from superset.db_engine_specs.clickhouse import ClickHouseConnectEngineSpec

        label = str(ClickHouseConnectEngineSpec.make_label_compatible("x"))
        self.assertRegex(label, r"^x_[0-9a-f]{6}$")
        self.assertEqual(label, str(ClickHouseConnectEngineSpec.make_label_compatible("x")))
        self.assertNotEqual(label, str(ClickHouseConnectEngineSpec.make_label_compatible("y")))
        # Applying it again changes nothing.
        self.assertFalse(lp.lenspack_clickhouse_label_suffix())

    @unittest.skipUnless(os.environ.get("LENSPACK_TEST_CLICKHOUSE"), "set LENSPACK_TEST_CLICKHOUSE to a clickhousedb:// URI to run it")
    def test_a_metric_reusing_a_summed_column_runs_and_keeps_its_names(self):
        import sqlalchemy as sa
        from superset.connectors.sqla.models import SqlMetric, SqlaTable, TableColumn
        from superset.extensions import db
        from superset.models.core import Database

        uri = os.environ["LENSPACK_TEST_CLICKHOUSE"]
        name = f"lenspack_labels_{os.getpid()}"
        engine = sa.create_engine(uri)
        with engine.connect() as con:
            con.execute(sa.text(f"CREATE TABLE {name} (g String, x Int32) ENGINE = MergeTree ORDER BY g"))
            con.execute(sa.text(f"INSERT INTO {name} SELECT if(number % 2 = 0, 'a', 'b'), toInt32(number) FROM numbers(10)"))
        try:
            database = Database(database_name=name, sqlalchemy_uri=uri)
            db.session.add(database)
            db.session.flush()
            table = SqlaTable(table_name=name, database=database)
            table.columns = [TableColumn(column_name="g", type="String", groupby=True), TableColumn(column_name="x", type="Int32")]
            table.metrics = [SqlMetric(metric_name="x", expression="SUM(x)"), SqlMetric(metric_name="x_per_row", expression="SUM(x) / COUNT(*)")]
            db.session.add(table)
            db.session.commit()
            result = table.query({"columns": ["g"], "metrics": ["x", "x_per_row"], "is_timeseries": False, "row_limit": 10, "filter": [], "extras": {}, "orderby": [("x", False)]})
            self.assertIsNone(result.error_message, result.query)
            self.assertEqual(list(result.df.columns), ["g", "x", "x_per_row"])
            self.assertEqual(result.df.to_dict("records"), [{"g": "b", "x": 25, "x_per_row": 5.0}, {"g": "a", "x": 20, "x_per_row": 4.0}])
        finally:
            with engine.connect() as con:
                con.execute(sa.text(f"DROP TABLE IF EXISTS {name}"))


if __name__ == "__main__":
    unittest.main()
