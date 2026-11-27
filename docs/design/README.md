# Design notes

Historical design notes: the documents Lenspack was built from, kept for history. It is for contributors who want to
know why something is the way it is. They describe plans at the time they were written: where they differ from the
rest of these docs, the rest of these docs are right.

| note | date | what it is |
|---|---|---|
| [The original design](2026-09-22-lenspack-design.md) | 2026-09-22 | the first design: the board as data, the closed query format, the pack, the compiler, and the claims the build checks |
| [Connectors](2026-09-29-connectors-design.md) | 2026-09-29 | the connector interface, Elasticsearch, `lenspack serve` and the DSS importer |
| [Protected tabs and tabs of one's own](2026-11-27-protected-and-own-tabs.md) | 2026-11-27 | a scoping note: tabs the chat never changes, tabs a person makes for their own changes, and deleting tabs; nothing built |
| [What Superset 6 could add](2026-11-25-superset-6-roadmap.md) | 2026-11-25 | Superset 6.0 and 6.1 features the assistant could use next, with a rough size for each; nothing built |
| [How far can packs go?](2026-11-11-pack-expressiveness.md) | 2026-11-11 | a review of what packs and queries would need to answer more questions; parts of it have since been built (the compute step, two-stage measures, `levels`) |

Today's design is in [Architecture](../architecture/README.md).

---

**Next:** back to the [documentation home](../README.md).

**Related:** [Architecture overview](../architecture/README.md) · [What Lenspack does not do](../introduction/limits.md)
