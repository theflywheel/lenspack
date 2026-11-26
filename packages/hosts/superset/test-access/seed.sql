-- The access suite's sample data. Every number is a different power of two, so a total says exactly which rows
-- were counted: visits by region are North 1+2 = 3, South 4, East 8, West 16 (all 31); stock North 32, South 64,
-- East 128, West 256 (all 480). The team column holds the name of one test user (lp_templ), for the templated rule.
CREATE TABLE visits (day date NOT NULL, region text NOT NULL, district text NOT NULL, team text NOT NULL, visits integer NOT NULL);
INSERT INTO visits VALUES
  ('2026-10-01', 'North', 'N1', 'lp_templ', 1),
  ('2026-10-02', 'North', 'N2', 'others', 2),
  ('2026-10-03', 'South', 'S1', 'others', 4),
  ('2026-10-04', 'East', 'E1', 'lp_templ', 8),
  ('2026-10-05', 'West', 'W1', 'others', 16);

CREATE TABLE stock (region text NOT NULL, item text NOT NULL, qty integer NOT NULL);
INSERT INTO stock VALUES
  ('North', 'nets', 32),
  ('South', 'nets', 64),
  ('East', 'vials', 128),
  ('West', 'vials', 256);
