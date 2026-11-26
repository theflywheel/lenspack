"""The access suite's people, roles, datasets, row-level security rules and dashboards, made in Superset's metadata
after `superset init`. Run inside the Superset container (see stack.ts); prints what it made as one JSON line.

Users (all with the password in LP_USER_PASSWORD):
  lp_admin     Admin
  lp_owner     Gamma + both datasets; owns dashboard A
  lp_viewer    Gamma + both datasets
  lp_partial   Gamma + visits only
  lp_north     Gamma + both datasets; RLS region = 'North' on visits and stock
  lp_inlist    Gamma + both datasets; RLS region IN ('North', 'East') on visits
  lp_complex   Gamma + both datasets; RLS region LIKE 'N%' on visits (Lenspack can't translate it)
  lp_templ     Gamma + both datasets; RLS team = '{{ current_username() }}' on visits
  lp_rbac      Gamma + the dashboard roles of dashboards B and C, and no dataset; RLS region IN ('North', 'South') on
               stock through B's role
  lp_rbac_off  the same roles as lp_rbac (asked about only while dashboard roles are turned off)
  lp_noroles   no roles at all
  lp_outage    Gamma + both datasets (asked about only while Superset is cut off)
Dashboards: A (owner lp_owner, no dashboard roles), B (owner lp_admin, dashboard role lp_board_b) and C (owner
lp_admin, dashboard role lp_board_c). All start empty; the suite adds their charts through Lenspack as lp_admin: one
of each dataset on A, stock on B, visits on C.
Dashboard T (owner lp_admin; dashboard role lp_board_t, which no user holds) has top-level tabs, laid out as Superset
leaves them: "Overview" (with tabs "By region" and "Trend" inside it) and "Stock", all empty, and GRID_ID left behind,
empty and off ROOT_ID.
"""

import json
import os

from superset.app import create_app

app = create_app()

with app.app_context():
    from superset.connectors.sqla.models import RowLevelSecurityFilter, SqlaTable, SqlMetric, TableColumn
    from superset.extensions import db, security_manager as sm
    from superset.models.core import Database
    from superset.models.dashboard import Dashboard
    from superset.utils.core import RowLevelSecurityFilterType

    password = os.environ["LP_USER_PASSWORD"]

    database = Database(database_name="access_data")
    database.set_sqlalchemy_uri(os.environ["LP_DATA_URI"])
    db.session.add(database)
    db.session.flush()

    def dataset(name, columns, metrics, dttm=None):
        table = SqlaTable(table_name=name, schema="public", database=database, main_dttm_col=dttm)
        table.columns = [TableColumn(column_name=c, type=t, groupby=t != "DATE", is_dttm=t == "DATE", filterable=True) for c, t in columns]
        table.metrics = [SqlMetric(metric_name=m, expression=e) for m, e in metrics]
        db.session.add(table)
        db.session.flush()
        return table

    visits = dataset(
        "visits",
        [("day", "DATE"), ("region", "TEXT"), ("district", "TEXT"), ("team", "TEXT")],
        [("visit_total", "SUM(visits)"), ("visit_count", "COUNT(*)")],
        dttm="day",
    )
    stock = dataset("stock", [("region", "TEXT"), ("item", "TEXT")], [("stock_total", "SUM(qty)"), ("stock_count", "COUNT(*)")])

    def role(name, tables=()):
        r = sm.find_role(name) or sm.add_role(name)
        for t in tables:
            sm.add_permission_role(r, sm.add_permission_view_menu("datasource_access", t.get_perm()))
        return r

    gamma, admin = sm.find_role("Gamma"), sm.find_role("Admin")
    r_visits, r_stock = role("lp_visits", [visits]), role("lp_stock", [stock])
    r_north, r_inlist, r_like, r_templ, r_board_b, r_board_c = (role(n) for n in ["lp_rls_north", "lp_rls_inlist", "lp_rls_like", "lp_rls_templ", "lp_board_b", "lp_board_c"])

    def rule(name, clause, roles, tables):
        f = RowLevelSecurityFilter(name=name, filter_type=RowLevelSecurityFilterType.REGULAR, clause=clause)
        f.roles = roles
        f.tables = tables
        db.session.add(f)

    rule("north only", "region = 'North'", [r_north], [visits, stock])
    rule("north and east", "region IN ('North', 'East')", [r_inlist], [visits])
    rule("regions starting with N", "region LIKE 'N%'", [r_like], [visits])
    rule("own team", "team = '{{ current_username() }}'", [r_templ], [visits])
    rule("north and south, dashboard B's role", "region IN ('North', 'South')", [r_board_b], [stock])

    both = [gamma, r_visits, r_stock]
    users = {
        "lp_admin": [admin],
        "lp_owner": both,
        "lp_viewer": both,
        "lp_partial": [gamma, r_visits],
        "lp_north": [*both, r_north],
        "lp_inlist": [*both, r_inlist],
        "lp_complex": [*both, r_like],
        "lp_templ": [*both, r_templ],
        "lp_rbac": [gamma, r_board_b, r_board_c],
        "lp_rbac_off": [gamma, r_board_b, r_board_c],
        "lp_noroles": [],
        "lp_outage": both,
    }
    made = {}
    for name, roles in users.items():
        u = sm.add_user(name, name, "Test", f"{name}@example.invalid", roles or [], password=password)
        if not u:
            raise SystemExit(f"could not make {name}")
        if not roles:
            # add_user gives a user with no roles the default role; take it away again.
            u.roles = []
        made[name] = u
    db.session.commit()

    a = Dashboard(dashboard_title="Access A", slug="access-a", published=True)
    a.owners = [made["lp_owner"]]
    b = Dashboard(dashboard_title="Access B (dashboard role)", slug="access-b", published=True)
    b.owners = [made["lp_admin"]]
    b.roles = [r_board_b]
    c = Dashboard(dashboard_title="Access C (dashboard role)", slug="access-c", published=True)
    c.owners = [made["lp_admin"]]
    c.roles = [r_board_c]
    def comp(cid, kind, children, parents, **meta):
        return {"id": cid, "type": kind, "children": children, "parents": parents, "meta": meta}

    top = ["ROOT_ID", "TABS-top"]
    tabbed = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"id": "ROOT_ID", "type": "ROOT", "children": ["TABS-top"]},
        "GRID_ID": comp("GRID_ID", "GRID", [], ["ROOT_ID"]),
        "HEADER_ID": {"id": "HEADER_ID", "type": "HEADER", "meta": {"text": "Access tabs"}},
        "TABS-top": comp("TABS-top", "TABS", ["TAB-overview", "TAB-stock"], ["ROOT_ID"]),
        "TAB-overview": comp("TAB-overview", "TAB", ["TABS-inner"], top, text="Overview", defaultText="Tab title"),
        "TABS-inner": comp("TABS-inner", "TABS", ["TAB-region", "TAB-trend"], [*top, "TAB-overview"]),
        "TAB-region": comp("TAB-region", "TAB", [], [*top, "TAB-overview", "TABS-inner"], text="By region", defaultText="Tab title"),
        "TAB-trend": comp("TAB-trend", "TAB", [], [*top, "TAB-overview", "TABS-inner"], text="Trend", defaultText="Tab title"),
        "TAB-stock": comp("TAB-stock", "TAB", [], top, text="Stock", defaultText="Tab title"),
    }
    t = Dashboard(dashboard_title="Access tabs", slug="access-tabs", published=True, position_json=json.dumps(tabbed), json_metadata=json.dumps({"positions": tabbed}))
    t.owners = [made["lp_admin"]]
    t.roles = [role("lp_board_t")]
    db.session.add_all([a, b, c, t])
    db.session.commit()

    print(json.dumps({"datasets": {"visits": visits.id, "stock": stock.id}, "dashboards": {"a": a.id, "b": b.id, "c": c.id, "t": t.id}, "noroles": [r.name for r in made["lp_noroles"].roles]}))
