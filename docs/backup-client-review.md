---
name: backup-client-review
description: Open questions from the backup client (my_obsidian drawer-backup skill) against the backup/restore surface added in claude/drawer-backup-api. Read this before merging that branch, or when changing export_entries, import_entry, or the soft-delete semantics.
---

# Backup client review — `claude/drawer-backup-api`

Reviewed at `382800d`. Filed by the maintainer of the consuming client: the
`drawer-backup` skill in `aleozlx/my_obsidian`
(`agent-toolbox/skills/drawer-backup/SKILL.md`), which mirrors this store into a
git-tracked vault. The proposal this branch implements lives at
`aleozlx/agent-toolbox` → `design-docs/drawer-mcp-backup-restore-proposal.md`.

This is not a list of defects. The surface covers the proposal, and two decisions
are better than what was asked for:

- **The cursor is bound to `store_revision`.** A page issued before a concurrent
  write fails loudly with `cursor_expired` instead of silently skipping an entry.
  A backup that skips one entry and reports success is worse than one that fails,
  so this is the right trade.
- **`hydrate` is a deterministic, non-destructive backfill.** Successive exports
  of an unchanged store are byte-identical, so the client sees no phantom drift
  and reading provably never writes. Both are covered by tests.

What follows is the small set of things the client still needs answered or wants
recorded, so the next person to touch this surface does not have to re-derive them.

---

## 1. Write atomicity is still read-modify-write — is that the long-term posture?

`commit()` documents this honestly:

> `load/modify/commit is still read-modify-write against a single KV value with no`
> `compare-and-set — concurrent writers can lose an entry. Narrowing that properly`
> `needs a Durable Object; this only keeps the revision honest.`

This is the one open item from the proposal (question 2) that the branch does not
close, and it matters to the client because of a specific artifact.
`e_mnpxl3cs1myr` is a partial duplicate of `e_mnpxnpvvnhuy`: body truncated
mid-sentence (`"...because the over-actuation that"`), `tags: []`, `origin: null`.
It is backed up verbatim — a backup that repairs its source is a lossy backup —
but it is the evidence that a partial write already happened once in production.

The regression suite has no concurrency or lost-update coverage, which is
reasonable (the stub KV cannot exhibit the race), but it means the hazard is
unguarded by tests as well as unfixed.

**Question:** is the Durable Object migration planned, or is read-modify-write the
accepted posture for a single-writer-in-practice store?

Either answer is fine — the client does not depend on the fix. It depends on
knowing, because it changes how much `store_revision` can be trusted as a
consistency marker. If the answer is "accepted posture," a one-line note in the
`export_entries` docstring saying `store_revision` orders writes but does not
guarantee they were atomic would stop a future client from over-trusting it.

## 2. There is no `delete_entry` tool — deliberate?

Six tools are registered: `add_entry`, `search_entries`, `list_entries`,
`get_entry`, `export_entries`, `import_entry`. None delete.

Soft deletion happens only in the UI (`src/App.jsx`, the `persist` call that sets
`deleted_at` and `updated_at`). So an MCP client cannot delete, and tombstones
appear in the backup with no MCP-visible action having caused them.

This is very likely intentional — deletion is a human judgment call, and keeping
it off the agent surface is defensible. Worth confirming explicitly, because
`export_entries`' own docstring advertises tombstones as a first-class export
concern, which reads as though something on this surface produces them.

## 3. `updated_at` currently only moves on create and delete

Nothing can edit an entry: there is no `update_entry` tool, and the UI writes
`updated_at` only on create and on soft-delete. So `since`-based incremental
export can surface creations and deletions, but never body edits — because body
edits are not currently possible.

Coherent today. Flagging it because:

- `since`'s docstring reads as general-purpose change detection, which is
  slightly ahead of what the store can actually express.
- If editing is ever added, every backup already in the field starts needing
  content-level drift detection rather than id-set comparison. Cheaper to know
  that is coming than to discover it from a silently stale mirror.

**Question:** is editing out of scope by design, or just not built yet?

## 4. Deploy-time prerequisite for restore

`import_entry` is gated behind `DRAWER_ALLOW_IMPORT=1`
(`_allowImport = env.DRAWER_ALLOW_IMPORT === "1"`). The gate is right — a restore
path that is always live is a foot-gun.

Recording it here because it is a deploy-config step, not a code one, and is
therefore easy to lose: **a restore attempted against a worker without that
variable set fails at call time**, with
`"import_entry is disabled. Set DRAWER_ALLOW_IMPORT=1 on the server to enable restores."`
The tool is still registered and still advertised, so the failure surfaces only
once a restore is actually attempted — which is exactly the moment someone is
least happy to discover a config gap. The message is clear, and the tests cover
the behaviour (`import_entry is absent unless the server enables it`); consider
whether the disabled state should be visible before that point.

---

## What the client changes on its side (no action needed here)

Recorded so the coupling is visible from this repo.

Soft deletion moves the burden of detecting deletions from *absence* to a *field*.
The current skill infers a deletion by noticing an id vanished from `list_entries`
and tombstoning it in `Drawer/anomalies.jsonl`. Once it reads `export_entries`,
deleted entries keep arriving with `deleted_at` set, so that inference stops
firing — **silently, not with an error**. The client's Steps 2 and 4 need
rewriting to read `deleted_at` rather than diff id sets. That is the client's
work, not this repo's, but it is the kind of coupling that is invisible from
either side alone.

The client also intends to replace its per-title `search_entries` walk with a
single paginated `export_entries` call once this branch is merged **and
deployed** — the skill talks to the deployed worker, so an unmerged branch is not
yet usable. `SKILL.md` already anticipates the swap.
