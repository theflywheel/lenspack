# Busy hours

This page explains what happens when many people ask at once: the queue, retries when the model provider is busy,
and one change at a time per board. It is for admins and anyone sizing a deployment.

Use of a dashboard is concentrated. Most people open it at the start of the day and before a review meeting, so most questions arrive in two or three short peaks, and they are mostly the same questions. That makes peaks both predictable and repetitive, and Lenspack uses both facts: saved answers take the repetitive part, and the rest waits its turn instead of failing.

- **At most `maxConcurrent` model turns run at once** (8 by default). The others wait in line, oldest first. A turn answered from a saved answer never waits: it uses no model.
- **The person waiting is told so.** The chat shows "Busy, about 12 s (number 3 in line)" and updates it as the line moves.
- **When the line is full** (`maxWaiting`, 50 by default), or a turn has waited `maxWaitSeconds` (60 by default), the reply is a short "Lenspack is too busy right now. Try again in a minute", with a Try again button and the board's suggestion chips beside it. Those chips are usually saved answers, so they still answer at once.
- **A rate limit is not a failure.** When the model provider turns a call away because of its rate limit (HTTP 429) or because it is overloaded (529), the call is tried again after about 1, 2, 4 seconds and so on (up to 15 seconds each, with a random part so that many waiting turns do not all retry at the same moment, and longer if the provider asks for longer). It only fails once the turn's wait limit would be passed.
- **Two changes to the same dashboard do not run at once.** If a second request to change a board arrives while another change to it is still being made, it waits for the first to finish ("waiting for another edit on this dashboard"), then starts from the board as the first left it. Questions, and changes to other boards, do not wait for it. A request counts as a change when it starts with a word such as "add", "remove", "move" or "change" (in English, French, Portuguese and Hindi). A question mistaken for a change only waits a little longer; a change mistaken for a question still works, as it always did.
- How long each turn waited is recorded as `queueMs` in its `chat-turn` audit record.

Settings under `queue` (`PUT <prefix>/settings/queue`, or `queue:` in the deployment config):

| setting | default | |
|---|---|---|
| `maxConcurrent` | `8` | model turns at once (1 to 200) |
| `maxWaiting` | `50` | turns that may wait (0 to 2,000) |
| `maxWaitSeconds` | `60` | how long a turn may wait, and how long a rate-limited call keeps retrying (1 to 600) |


## How it is built

The queue and the one-change-at-a-time rule are the turn gate (`localTurnGate` in `@lenspack/agent`), kept in the
server's memory. That is right for one copy of the server. With several copies behind a load balancer, each limits
only its own turns. See [Stores, and running several copies](../architecture/stores.md).

---

**Next:** [Dashboard edits, versions and undo](dashboard-edits.md).

**Related:** [Saved answers](saved-answers.md#pre-warming-ready-before-the-peak) · [Chat stream parts](../reference/stream-parts.md) ·
[HTTP API: saved answers and the queue](../reference/http-api.md#saved-answers-and-the-queue)
