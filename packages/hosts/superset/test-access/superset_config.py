# Superset's config for the access suite: a throwaway SQLite metadata database inside the container, the two
# feature flags the suite exercises, and the plugin. The secret key comes from the environment, made fresh per run.
import os

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = "sqlite:////tmp/superset-access.db"
FEATURE_FLAGS = {
    # Superset renders Jinja in RLS clauses ({{ current_username() }}) only with this on.
    "ENABLE_TEMPLATE_PROCESSING": True,
    # Dashboard roles: a dashboard with roles opens only for those roles (and its owners and admins).
    "DASHBOARD_RBAC": True,
}
# The suite's sample data is in Postgres on the same host; nothing else is reachable from here.
PREVENT_UNSAFE_DB_CONNECTIONS = False
TALISMAN_ENABLED = False
# Superset 5 warns and slows down without a cache; the suite needs none.
CACHE_CONFIG = {"CACHE_TYPE": "NullCache"}
DATA_CACHE_CONFIG = {"CACHE_TYPE": "NullCache"}
RATELIMIT_ENABLED = False
AUTH_RATE_LIMITED = False

from lenspack_superset import *  # noqa: E402,F401,F403
