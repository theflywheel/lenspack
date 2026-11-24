"""Tests for lenspack_superset.py. They need Superset's own Python environment, so they run in its image:

    docker run --rm -e SUPERSET_CONFIG_PATH=/cfg/superset_config.py -e PYTHONPATH=/plugin:/cfg \\
      -v "$PWD/packages/hosts/superset/plugin:/plugin:ro" -v "$PWD/<a folder with superset_config.py>:/cfg:ro" \\
      apache/superset:5.0.0 sh -c 'superset db upgrade && superset init && python -m unittest discover -s /plugin'

where superset_config.py sets SECRET_KEY, a SQLite SQLALCHEMY_DATABASE_URI, PREVENT_UNSAFE_DB_CONNECTIONS = False,
FEATURE_FLAGS = {"ENABLE_TEMPLATE_PROCESSING": True} (Superset renders RLS templates only with it),
and ends with `from lenspack_superset import *`. RlsClauses and Route need only the module. ProxyEndpoint makes
users and dashboards and sends /lenspack/... requests through Flask's test client, with the forward to Lenspack
caught. AccessEndpoint makes a throwaway SQLite database, a dataset, a role with access to it, users and RLS rules
in Superset's metadata, and calls /api/v1/lenspack/access through Flask's test client.
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

    def send(self, method, path, **kw):
        """The response, and the (url, claims) forwarded to Lenspack, or None when nothing was forwarded."""
        import base64
        import json
        from unittest import mock

        forwarded = []

        def fake(method_, url, **kwargs):
            body = kwargs["headers"]["x-lenspack-identity"].split(".")[0]
            forwarded.append((url, json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))))
            return mock.Mock(status_code=200, headers={"content-type": "application/json"}, iter_content=lambda chunk_size=None: iter([b"{}"]), close=lambda: None)

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

    def test_digits_are_an_id_never_a_slug(self):
        # The lookalike's slug is OTHER's id, and the owner owns the lookalike: the rights are still OTHER's.
        _, (_, claims) = self.send("GET", f"/lenspack/api/hcm/superset-{self.other}")
        self.assertEqual((claims["d"], claims["e"]), (self.other, False))
        _, (_, claims) = self.send("GET", "/lenspack/_superset/bind", query_string={"dashboard": str(self.other)})
        self.assertEqual((claims["d"], claims["e"]), (self.other, False))


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


if __name__ == "__main__":
    unittest.main()
