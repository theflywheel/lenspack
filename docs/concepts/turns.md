# Turns

A turn is one message in the chat and everything Lenspack does to answer it. This page explains the parts of a
turn: the model, its tools, the reviewer and the reply. It is for anyone who wants to know what happens after
someone presses Enter.

## The parts of a turn

1. **The question arrives**, with the board it was asked on, the filters the reader had picked, and their
   language.
2. **Access is decided.** Lenspack works out what this person may see and change. See [Policy](policy.md).
3. **A saved answer is tried first.** If the same question was answered well before, by someone with the same
   access, its queries are run again on today's data and no model is needed. See [Saved answers](saved-answers.md).
4. **The model plans.** It gets the pack's catalogue, the board, the deployment's rules and definitions, and a set
   of **tools**. It calls them to read numbers or change the board.
5. **Edits are held as drafts.** While a reviewer is on, every change the turn makes is staged, not saved.
6. **A reviewer checks the edits** against the request, and nothing misleading is saved. See
   [The reviewer](../features/dashboard-edits.md#the-reviewer).
7. **The reply streams back**, with **How this was worked out** under it and a line with what the turn cost.
8. **Everything is recorded**: the audit log, the usage ledger and, where it is on, telemetry.

## The tools

The model can only act through tools, and every tool goes through the pack and the person's access.

| to read | to change the board | other |
|---|---|---|
| `list_metrics`: search the catalogue | `add_widget`, `update_widget`, `remove_widget` | `propose_measure`: suggest a measure for a person to review |
| `query`: run a query | `move_widget`, `resize_widget` | `clarify`: ask which reading was meant |
| `explain`: compile a query without running it | `add_filter`, `update_filter`, `remove_filter` | `run_sql`: off by default |
| `list_values`: the values of a dimension | `set_layout_mode`, `rename_board` | |
| `get_board`, `list_versions` | `restore_version` | |

A person who may only view the board can still ask questions. The edit tools then refuse, with a message the model
passes on.

## Models in a turn

A deployment can name different models for different jobs:

- the **builder** answers and edits;
- the **reviewer** checks edits;
- the **escalation** model runs the fix round;
- a **small model** matches a new wording to a saved answer.

See [Chat models](../operating/models.md#roles).

Where each step lives in the code is in [The life of a turn](../architecture/life-of-a-turn.md).

---

**Next:** [Hosts](hosts.md).

**Related:** [The life of a turn](../architecture/life-of-a-turn.md) · [Chat stream parts](../reference/stream-parts.md)
