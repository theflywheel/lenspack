# Saved answers

A saved answer lets Lenspack answer a repeated question without asking the model again. This page explains the
idea and the one rule that keeps it safe. It is for anyone who wants to understand what a deployment costs and why
answers come back fast.

## The idea

People who use a dashboard do not come up with new questions every day. A team asks the same few dozen things
again and again, in slightly different words, about different places and days. A full turn with the model is
mostly planning (which queries to run) and writing (the reply). The plan is small and can be kept.

So Lenspack keeps a **plan** for each question it answered well, with the reply and the numbers the reply was
written from. When the same question comes in again, it runs the plan on today's data and puts today's numbers
into the saved reply. **The numbers are always read fresh.** Only the work of deciding what to read is reused.

The same goes for edits: a change to a board that was made and accepted before is made again without the model
when someone asks for it on a board in the same state.

## The safety rule

**A saved answer is only ever given to someone with the same access.** Two people can ask the same words and be
entitled to different answers. So every saved answer carries a fingerprint of the access it was made under (the
tenant, the row filters, the keys and tables hidden), and its queries run again under the asking person's own
access. Someone who may see one region is never given a number counted over all of them.

A saved answer is also tied to the pack and its definitions, the assistant's instructions, the board's filters, the
reader's filter picks and their language. Change any of these and the question is answered afresh.

## What the person sees

A reply from a saved answer looks like any other, with one line under it:

> Saved answer, data as of 09:41 · **Ask fresh**

**Ask fresh** sends the question to the full assistant, whatever is saved.

---

**Next:** the [Architecture overview](../architecture/README.md), or jump to [Features](../features/README.md).

**Related:** [Saved answers in depth](../features/saved-answers.md) · [Busy hours](../features/busy-hours.md)
