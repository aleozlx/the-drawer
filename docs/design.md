---
name: design
description: Overall design of The Drawer — architecture, data model, auth, tool surface, and the reasoning behind the decisions that are not visible in the code. Start here.
---

# The Drawer — design

The Drawer is a shared notebook for ideas that emerge *between* a human and an AI in
conversation — entries neither participant brought in, which is why they cannot be
rewritten from memory and why durability decisions below are conservative. It is one
Cloudflare Worker serving three things: a React web UI for the human, an MCP server
for AI clients, and the storage both write to.

Production: `https://the-drawer.aleozlx.workers.dev`, deployed by Cloudflare Workers
Builds on every push to `main` (configured in the dashboard — there is no
`.github/workflows` here).

---

## Components

```
                 ┌─────────────────────────────────────────────┐
                 │  Cloudflare Worker (src/worker.ts)          │
                 │                                             │
  human ──────► │  /            static UI (Vite build, dist/) │
  (CF Access)    │  /api/storage KV passthrough for the UI     │
                 │  /authorize   OAuth grant, gated by Access  │
                 │                                             │
  MCP client ──► │  /mcp         MCP server (OAuth bearer)     │
  (OAuth)        │  /token /register  OAuth plumbing           │
                 │                                             │
                 │  DRAWER_KV ── "claude-drawer:entries"       │
                 │  OAUTH_KV  ── grants, tokens, clients       │
                 └─────────────────────────────────────────────┘
```

- **`src/worker.ts`** — everything server-side: the MCP tools, OAuth provider
  (`@cloudflare/workers-oauth-provider`), Cloudflare Access JWT validation, and the
  `/api/storage/*` passthrough the UI uses.
- **`src/App.jsx`** — the web UI. Reads and writes the same KV value through
  `/api/storage`, so it is a *peer writer* to the MCP server, not a viewer. Most of
  the subtle code in it exists because of that (see "Two writers, one blob").
- **`docs/skills/drawer-keeper.md`** — the conversational skill that decides what
  gets filed. Filing policy lives there, not in the server.

### Authentication — two doors, one wall

Humans and MCP clients authenticate differently, but both paths bottom out in
Cloudflare Access:

- **Humans** hit the UI and `/api/storage` behind a Cloudflare Access application;
  the Worker verifies the `CF_Authorization` JWT itself (signature against the team
  JWKS, audience, expiry) rather than trusting the header.
- **MCP clients** speak OAuth against `/authorize`–`/token`–`/register`. The trick
  is that `/authorize` *also* requires a valid Access JWT before it auto-approves —
  so an OAuth grant can only ever be minted by a browser session that already passed
  Access. OAuth is the session mechanism; Access is the identity gate.

---

## Data model

The entire drawer is **one KV value** under `claude-drawer:entries`:

```ts
{
  entries: Record<string, Entry>,   // keyed by id
  order: string[],                  // most-recent-first
  revision?: number                 // monotonic, bumped by every mutation
}

Entry = {
  id: string,          // "e_" + Date.now().toString(36) + 4 random base36 chars
  title: string,
  body: string,
  date: string,        // YYYY-MM-DD — the human-facing *authored* date
  tags: string[],
  origin: string | null,
  created_at?: string, // ISO — the *write* time
  updated_at?: string,
  deleted_at?: string | null
}
```

Decisions worth knowing before touching this:

- **`date` ≠ `created_at`, deliberately.** Four live entries carry
  `date: 2026-03-31` but ids decoding to 2026-04-04 — they arrived through the UI's
  import path with an explicit authored date. Both fields are load-bearing;
  collapsing them silently rewrites the chronology of every imported entry.
- **Ids are time-seeded**, so `created_at` is exactly recoverable for records
  written before the field existed. `hydrate()` backfills the three timestamp
  fields **on read, deterministically, without writing** — verified live: after
  every deploy the stored blob still contains zero timestamp fields for legacy
  records. Same input, same output, so a backup diffing successive exports sees no
  phantom drift.
- **Timestamps are not unique.** Two live entries share a millisecond. Anything
  that sorts or pages must tiebreak or, like `export_entries`, walk `order` by
  index instead.
- **Titles are not unique** either (two live entries share one). `id` is the only
  key.
- **`revision`** exists so a backup can answer "did anything change?" with one
  comparison. All mutations flow through `commit()`, which bumps it — that funnel
  is what keeps the revision honest, and it is also the anchor for pagination
  cursors (`${revision}:${index}`), which turn a store mutation mid-export into a
  loud `cursor_expired` instead of a silently skipped entry.

### Why one blob, and what that costs

The single-value design means every call parses the whole store, which is fine at
~30 entries and is *why* `export_entries`' `since` parameter saves no server work —
it only shrinks the response. It also means a true point-in-time snapshot/restore
is one command, no tools required:

```
wrangler kv key get/put --binding=DRAWER_KV 'claude-drawer:entries'
```

The cost: **writes are read-modify-write with no compare-and-set**, and KV is
eventually consistent. Two concurrent writers can lose an entry. This is an
*accepted posture*, not an oversight — the store is single-writer in practice, and
the proper fix (a Durable Object serializing writes) is an architectural migration
that was considered and deliberately deferred until the race is observed to bite.
`store_revision` orders writes but is a change marker, not a consistency proof, and
the tool description says so.

### Two writers, one blob

The UI and the MCP server both write the whole value, which produced the one real
data-loss bug found in this store's history: the UI used to read the blob once at
page load and write that snapshot back on every mutation, so a tab left open
silently discarded every entry MCP filed in the meantime. The fixes, all in
`App.jsx`:

- `persist()` takes a **mutator**, re-reads the store, applies the change to the
  fresh copy, then writes. The tab's copy is assumed stale at all times.
- A failed read **throws** instead of returning an empty drawer, and the app then
  renders a read-only error screen — a failed read that looks like an empty drawer
  is exactly how you overwrite the store with nothing.
- Deletion is a **soft delete**: set `deleted_at`/`updated_at`, keep the record and
  its slot in `order`. Tombstoned entries vanish from every UI and MCP listing
  surface but remain in `export_entries` and `get_entry`, so a backup can tell
  *deleted* from *never seen*.

This narrows the overwrite window rather than closing it (no CAS, see above), and
any *third* client — a script, a raw `wrangler kv put` — reintroduces the original
hazard in full. If you add a writer, route it through a re-read or accept the risk
knowingly.

---

## MCP tool surface

Five tools always; a sixth only when the server opts in.

| Tool | Role | Notes |
|---|---|---|
| `add_entry` | The filing path | Server assigns id and timestamps; callers can never pick an id. |
| `list_entries` | Cheap enumeration | id/title/date/tags/`origin`, no body. Hides tombstones. |
| `search_entries` | Keyword retrieval | Full records over title/body/tags/origin. Hides tombstones. |
| `get_entry` | Fetch by known id | Returns tombstoned entries too — a known id is a deliberate ask. |
| `export_entries` | The backup path | Full records incl. tombstones, revision-bound cursor pagination, `store_revision`. |
| `import_entry` | The restore path | **Registered only when `DRAWER_ALLOW_IMPORT=1`.** |

Surface-wide invariants:

- **Nothing on the MCP surface deletes.** Deletion is a human judgment call and
  lives in the web UI only.
- **Editing is nearly absent by design.** There is no `update_entry`; the only
  mutation of an existing record is `import_entry` with `on_conflict: "replace"`,
  which is gated. Consequently `updated_at` only moves on creation, soft-deletion,
  and gated replace — `since` cannot surface arbitrary body edits, because they are
  not possible. If a general edit path is ever added, every backup in the field
  needs content-level drift detection; the backup's `index.jsonl` already carries
  `body_sha256` per entry for exactly that day.
- **The import gate is *absence*, not refusal.** `import_entry` writes
  server-assigned fields, so it is a separate tool from `add_entry` (normal filing
  must never pick its own id) and it is not registered at all unless
  `DRAWER_ALLOW_IMPORT=1` is set. A present-but-refusing tool shows up in every
  client's list and reveals the missing config only at the moment someone attempts
  a restore; an absent tool is legible before it matters. Production does not set
  the flag — restore is a deliberate two-step human operation.
- `import_entry` validates the id against the server's own grammar
  (`ID_RE`), defaults `on_conflict` to `fail` so a replayed backup cannot silently
  overwrite a live drawer (`skip` makes restore idempotent; `replace` is explicit
  repair), and inserts restored entries into `order` by `created_at` so they land
  in their real chronological slot instead of at the top.

A full export → wipe → restore round-trip over the real store returns every record
byte-identical and in the original order; the last test in `test/worker.test.mjs`
holds that property.

---

## The backup ecosystem (lives elsewhere)

The server is one corner of a three-repo arrangement:

- **`aleozlx/agent-toolbox`** — `skills/drawer-backup/` (the weekly backup skill)
  and `design-docs/drawer-mcp-backup-restore-proposal.md` +
  `drawer-backup-handoff.md`, the design history of the export/import surface.
- **`aleozlx/my_obsidian`** — the backup target: `Drawer/` with an authoritative
  append-only `index.jsonl` (the `.md` files are derived views; on disagreement the
  JSONL wins), keyed on `id`, never title.
- **This repo** — the surface was reviewed by the skill's maintainer and answered
  point by point before the skill migrated to it; that exchange
  (`backup-client-review.md` / `backup-client-review-response.md`) is preserved in
  git history, and everything durable from it was folded into this doc and the tool
  descriptions.

One coupling to keep in mind: the backup skill historically inferred deletion from
an id disappearing from `list_entries`. Under soft delete that inference goes
silent — deleted entries keep arriving via `export_entries` with `deleted_at` set —
so the skill must read `deleted_at` rather than diff id sets.

---

## Testing

`npm test` runs `test/worker.test.mjs` (node:test, 23 tests) against the **real**
`src/worker.ts`: `test/harness.mjs` bundles it with esbuild, stubbing only
`agents/mcp` and the OAuth provider, so the tool implementations, zod schemas, and
hydration logic under test are the shipped ones.

`test/fixtures.mjs` is **synthetic** — this repo is public and the real entries sit
behind Access, so no live content is committed — but it reproduces every structural
property the live data taught us to design around: time-seeded ids, two entries
sharing a millisecond, duplicate titles, backdated entries whose `date` and id
timestamp disagree, a truncated body with empty tags, and unicode in bodies.

The suite was mutation-tested: eight deliberate breakages (timestamp recovery,
tombstone filtering, cursor revision check, `on_conflict` default, id grammar, the
import gate, chronological insert, revision bump) were each caught. What it
deliberately does *not* cover is the KV write race — the stub KV cannot exhibit it,
and a fake that could would be testing the fake.

---

## Known limitations, in one place

1. **No CAS.** Concurrent writers can lose an entry; `store_revision` will not tell
   you it happened. Fix is a Durable Object; deferred until observed in practice.
2. **`since` is a bandwidth optimization only**, and blind to edits that predate
   `updated_at` semantics. Backups should full-export and use `store_revision` for
   the no-op check.
3. **Any new direct-KV writer reintroduces the UI's old clobber bug.** The re-read
   discipline lives in each client, not in the store.
4. **`createdAtFromId` trusts a sanity window** (2000-01-01 .. tomorrow). An id
   minted by a machine with a badly wrong clock would backfill a wrong-but-plausible
   timestamp; `import_entry` callers can pass `created_at` explicitly to override.
