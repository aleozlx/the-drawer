---
name: backup-client-review-response
description: Answers to the four open questions in backup-client-review.md, and the code changes made in response. Read alongside that doc when changing export_entries, import_entry, or the soft-delete semantics.
---

# Response to the backup client review

Answers to [`backup-client-review.md`](./backup-client-review.md), filed by the
maintainer of the `drawer-backup` skill in `aleozlx/my_obsidian`.

Three of the four items are answered as design intent and recorded in the tool
descriptions so a future client does not have to re-derive them. The fourth was a
real gap and is fixed. One factual correction is noted at the end.

---

## 1. Write atomicity — accepted posture, not a pending migration

**Read-modify-write is the accepted posture.** The Durable Object migration was
explicitly considered when this surface was built and deliberately deferred: the
store is single-writer in practice, and a DO means an architectural change plus a
KV migration for a race that has not been observed to bite. It is not an oversight
and it is not scheduled.

The review's suggested caveat was the right one and is now in the `export_entries`
description:

> `store_revision` orders writes but does not guarantee they were atomic: the store
> is a single KV value updated by read-modify-write with no compare-and-set, so
> concurrent writers can still lose an entry. Treat it as a change marker, not a
> consistency proof.

On the artifact cited as evidence — `e_mnpxl3cs1myr`, the truncated partial
duplicate — **it is not evidence of a lost update.** Both ids are time-seeded and
decode to `2026-04-08T10:54:29.692Z` and `2026-04-08T10:56:32.203Z`: 123 seconds
apart. They are two separate `add_entry` calls, and the body arrived already
truncated. The atomicity gap is real; this record is not the demonstration of it.
This correction is also recorded in the proposal doc in `aleozlx/agent-toolbox`.

The observation that the regression suite has no lost-update coverage is accurate
and stands. The stub KV cannot exhibit the race, and adding a fake that could would
be testing the fake.

## 2. No `delete_entry` — deliberate

Confirmed. Six tools, none delete. Deletion is a human judgment call and stays off
the agent surface; nothing an MCP client does will ever tombstone an entry.

The review is right that `export_entries` advertised tombstones as a first-class
concern without saying where they come from, which reads as though something here
produces them. Its description now ends:

> Tombstones originate in the web UI — nothing on this tool surface deletes an entry.

## 3. Editing — not designed out, just not built

There is no general `update_entry`, and none is planned, but editing is not
excluded on principle. The `since` description no longer implies more change
detection than the store can express:

> there is no general update tool, so `updated_at` only moves on creation,
> soft-deletion, and `import_entry` replace — `since` cannot surface arbitrary body
> edits, because they are not possible.

The review's warning about what happens if editing is ever added is worth keeping:
every backup already in the field would need content-level drift detection rather
than id-set comparison. `index.jsonl` already carries `body_sha256` per entry, so
the client has the primitive for that whenever it needs it.

## 4. Import gate visible only at call time — fixed

This was a real gap, and the review named it precisely. The original proposal
argued that *the tool being absent by default is a stronger guarantee than the tool
being present and polite*. The first implementation registered `import_entry`
unconditionally and refused inside the callback, which is the weaker form: the tool
appeared in every client's list, and the missing config surfaced only when someone
attempted a restore.

`import_entry` is now **registered only when `DRAWER_ALLOW_IMPORT=1`**. When the
server has not opted in, the tool does not exist — its absence from the tool list is
the signal, available before it matters rather than at the worst moment. The
call-time refusal is gone, because there is no longer a call to refuse.

Three tests cover this: the tool is absent by default, present when enabled, and the
read surface is otherwise identical either way.

---

## Correction: `import_entry` replace *is* an edit path

The review states that nothing can edit an entry. `import_entry` with
`on_conflict: "replace"` writes a new body and sets `updated_at`. It is gated behind
`DRAWER_ALLOW_IMPORT` and intended for repair during a restore, but it is a genuine
mutation of an existing record and the client should not assume bodies are immutable
once written. Its description now says so.

The broader point the review was making — that `since` cannot be relied on for
general change detection — is unaffected and correct.

## On the client-side coupling

The soft-delete coupling recorded at the end of the review is accurate and worth
restating from this side: the client's current deletion inference fires on an id
disappearing from `list_entries`. Once it reads `export_entries`, deleted entries
keep arriving with `deleted_at` set, so that inference stops firing **silently**.
Steps 2 and 4 of `SKILL.md` need to read `deleted_at` rather than diff id sets
before the switch to `export_entries`, not after.
