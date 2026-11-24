"""Tests for lenspack_superset.py. They need Superset's own Python environment, so they run in its image:

    docker run --rm -e SUPERSET_CONFIG_PATH=/cfg/superset_config.py -e PYTHONPATH=/plugin:/cfg \\
      -v "$PWD/packages/superset/plugin:/plugin:ro" -v "$PWD/<a folder with superset_config.py>:/cfg:ro" \\
      apache/superset:5.0.0 sh -c 'superset db upgrade && superset init && python -m unittest discover -s /plugin'

where superset_config.py sets SECRET_KEY, a SQLite SQLALCHEMY_DATABASE_URI, PREVENT_UNSAFE_DB_CONNECTIONS = False,
FEATURE_FLAGS = {"ENABLE_TEMPLATE_PROCESSING": True} (Superset renders RLS templates only with it),
and ends with `from lenspack_superset import *`. RlsClauses needs only the module. AccessEndpoint makes a
throwaway SQLite database, a dataset, a role with access to it, users and RLS rules in Superset's metadata,
and calls /api/v1/lenspack/access through Flask's test client.
"""

import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace

import lenspack_superset as lp

PASSWORD = "test-password-0123456789"


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


class AccessEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from superset.app import create_app

        cls.app = create_app()
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
