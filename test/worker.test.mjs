import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDrawer } from "./harness.mjs";
import {
  legacyDrawer,
  COUNT,
  BACKDATED,
  SAME_MS,
  SAME_TITLE,
  TRUNCATED,
  NEWEST,
} from "./fixtures.mjs";

const fresh = (opts) => makeDrawer(legacyDrawer(), opts);

// ─── Backfill of legacy records ───

test("export backfills timestamps onto records that predate them", async () => {
  const d = await fresh();
  const { entries } = await d.call("export_entries", { limit: 500 });

  assert.equal(entries.length, COUNT);
  for (const e of entries) {
    assert.ok(e.created_at, `${e.id} has created_at`);
    assert.ok(e.updated_at, `${e.id} has updated_at`);
    assert.equal(e.deleted_at, null, `${e.id} defaults deleted_at to null`);
    assert.ok(e.body.length > 0, `${e.id} has a body`);
  }
});

test("reading never writes — backfill leaves the store untouched", async () => {
  const d = await fresh();
  const before = d.read();
  await d.call("export_entries", { limit: 500 });
  await d.call("list_entries", { limit: 500 });
  await d.call("get_entry", { id: NEWEST });
  await d.call("search_entries", { query: "the" });
  assert.equal(d.read(), before);
});

test("backfill is deterministic, so successive exports show no phantom drift", async () => {
  const d = await fresh();
  const a = await d.call("export_entries", { limit: 500 });
  const b = await d.call("export_entries", { limit: 500 });
  assert.deepEqual(a.entries, b.entries);
});

test("created_at is recovered exactly from the time-seeded id", async () => {
  const d = await fresh();
  const e = await d.call("get_entry", { id: TRUNCATED });
  assert.equal(e.created_at, "2026-04-08T10:54:29.692Z");
});

test("an entry filed earlier than it was written keeps both dates", async () => {
  const d = await fresh();
  const { entries } = await d.call("export_entries", { limit: 500 });

  const backdated = entries.filter((e) => BACKDATED.includes(e.id));
  assert.equal(backdated.length, BACKDATED.length);
  for (const e of backdated) {
    assert.equal(e.date, "2026-03-31", "authored date preserved");
    assert.ok(e.created_at.startsWith("2026-04-04"), "write time recovered from id");
    assert.notEqual(e.date, e.created_at.slice(0, 10), "the two must not be collapsed");
  }
});

test("two entries minted in the same millisecond both survive", async () => {
  const d = await fresh();
  const { entries } = await d.call("export_entries", { limit: 500 });
  const same = entries.filter((e) => SAME_MS.includes(e.id));
  assert.equal(same.length, 2);
  assert.equal(same[0].created_at, same[1].created_at);
  assert.notEqual(same[0].id, same[1].id);
});

test("duplicate titles are addressable by id", async () => {
  const d = await fresh();
  const [a, b] = await Promise.all(SAME_TITLE.map((id) => d.call("get_entry", { id })));
  assert.equal(a.title, b.title);
  assert.notEqual(a.body, b.body);
});

// ─── list / search / get ───

test("list_entries returns origin but withholds body", async () => {
  const d = await fresh();
  const list = await d.call("list_entries", { limit: 500 });
  assert.equal(list.length, COUNT);
  for (const e of list) {
    assert.ok("origin" in e, "origin included");
    assert.ok(!("body" in e), "body excluded");
  }
});

test("get_entry returns null for an unknown id", async () => {
  const d = await fresh();
  assert.equal(await d.call("get_entry", { id: "e_doesnotexist0" }), null);
});

// ─── Pagination ───

test("paged export covers everything exactly once, in full-export order", async () => {
  const d = await fresh();
  const full = await d.call("export_entries", { limit: 500 });

  const seen = [];
  let cursor;
  for (let guard = 0; guard < 50; guard++) {
    const page = await d.call("export_entries", { limit: 2, ...(cursor ? { cursor } : {}) });
    seen.push(...page.entries);
    cursor = page.next_cursor;
    if (!cursor) break;
  }

  assert.equal(seen.length, COUNT, "no gaps");
  assert.equal(new Set(seen.map((e) => e.id)).size, COUNT, "no duplicates");
  assert.deepEqual(
    seen.map((e) => e.id),
    full.entries.map((e) => e.id)
  );
});

test("a cursor issued before a write is rejected, not silently skewed", async () => {
  const d = await fresh();
  const page = await d.call("export_entries", { limit: 2 });
  assert.ok(page.next_cursor);

  // add_entry unshifts onto `order`, so every index in the old cursor now points
  // one entry to the left. Resuming would silently skip a record.
  await d.call("add_entry", { title: "New", body: "b" });

  const stale = await d.call("export_entries", { limit: 2, cursor: page.next_cursor });
  assert.equal(stale.error, "cursor_expired");
  assert.match(stale.message, /restart/i);
});

// ─── add_entry ───

test("add_entry stamps timestamps and bumps the store revision", async () => {
  const d = await fresh();
  const before = await d.call("export_entries", { limit: 500 });
  assert.equal(before.store_revision, "0");

  const added = await d.call("add_entry", { title: "T", body: "B", tags: ["x"], origin: "o" });
  assert.ok(added.created_at);
  assert.equal(added.updated_at, added.created_at);
  assert.equal(added.deleted_at, null);

  const after = await d.call("export_entries", { limit: 500 });
  assert.equal(after.store_revision, "1");
  assert.equal(after.entries.length, COUNT + 1);
});

// ─── since ───

test("since filters on updated_at", async () => {
  const d = await fresh();
  const { entries } = await d.call("export_entries", {
    since: "2026-06-01T00:00:00.000Z",
    limit: 500,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, NEWEST);
});

// ─── Soft delete ───

test("a tombstoned entry leaves the UI surfaces but stays in the backup", async () => {
  const data = legacyDrawer();
  const victim = data.order[2];
  const ts = "2026-07-26T12:00:00.000Z";
  data.entries[victim].deleted_at = ts;
  data.entries[victim].updated_at = ts;
  const d = await makeDrawer(data);

  const list = await d.call("list_entries", { limit: 500 });
  assert.equal(list.length, COUNT - 1);
  assert.ok(!list.some((e) => e.id === victim), "hidden from list_entries");

  const hits = await d.call("search_entries", { query: data.entries[victim].title });
  if (Array.isArray(hits)) {
    assert.ok(!hits.some((e) => e.id === victim), "hidden from search_entries");
  }

  const { entries } = await d.call("export_entries", { limit: 500 });
  assert.equal(entries.length, COUNT, "still exported");
  const tomb = entries.find((e) => e.id === victim);
  assert.equal(tomb.deleted_at, ts, "deleted, not merely absent");
  assert.ok(tomb.body.length > 0, "body retained");

  const direct = await d.call("get_entry", { id: victim });
  assert.equal(direct.id, victim, "still resolvable by id");
});

// ─── import_entry: refusals ───

test("import_entry is absent unless the server enables it", async () => {
  const d = await fresh();
  // Absence, not a polite refusal: a restore path that is always advertised only
  // reveals the missing config at the moment someone attempts a restore.
  assert.ok(!d.toolNames().includes("import_entry"), "not registered");
  await assert.rejects(
    () => d.call("import_entry", { id: "e_mnjzu6v5zzzz", title: "T", body: "B", date: "2026-01-01" }),
    /No tool "import_entry"/
  );
});

test("import_entry appears once the server enables it", async () => {
  const d = await fresh({ allowImport: true });
  assert.ok(d.toolNames().includes("import_entry"), "registered");
});

test("the read surface is identical whether or not import is enabled", async () => {
  const off = await fresh();
  const on = await fresh({ allowImport: true });
  const readTools = (d) => d.toolNames().filter((n) => n !== "import_entry").sort();
  assert.deepEqual(readTools(off), readTools(on));
});

test("import_entry refuses an id that is not the server's own grammar", async () => {
  const d = await fresh({ allowImport: true });
  for (const id of ["../../etc/passwd", "e_short", "nope", ""]) {
    const res = await d.call("import_entry", { id, title: "T", body: "B", date: "2026-01-01" });
    assert.equal(res.error, "import_rejected", `rejected: ${JSON.stringify(id)}`);
    assert.match(res.message, /not a valid drawer id/);
  }
});

test("import_entry refuses a malformed date", async () => {
  const d = await fresh({ allowImport: true });
  const res = await d.call("import_entry", {
    id: "e_mnjzu6v5zzzz",
    title: "T",
    body: "B",
    date: "March 1st",
  });
  assert.equal(res.error, "import_rejected");
  assert.match(res.message, /not a valid date/);
});

// ─── import_entry: conflict handling ───

test("import_entry defaults to refusing to overwrite a live entry", async () => {
  const d = await fresh({ allowImport: true });
  const res = await d.call("import_entry", {
    id: NEWEST,
    title: "Clobbered",
    body: "Clobbered",
    date: "2026-01-01",
  });
  assert.equal(res.error, "import_rejected");
  assert.match(res.message, /already exists/);

  const still = await d.call("get_entry", { id: NEWEST });
  assert.notEqual(still.title, "Clobbered");
});

test("on_conflict=skip makes a restore re-runnable", async () => {
  const d = await fresh({ allowImport: true });
  const original = await d.call("get_entry", { id: NEWEST });

  const res = await d.call("import_entry", {
    id: NEWEST,
    title: "Different",
    body: "Different",
    date: "2026-01-01",
    on_conflict: "skip",
  });
  assert.equal(res.action, "skipped");
  assert.deepEqual(await d.call("get_entry", { id: NEWEST }), original);
});

// ─── The point of all this: lossless restore ───

test("a record round-trips through replace byte-identical", async () => {
  const d = await fresh({ allowImport: true });
  const before = await d.call("get_entry", { id: BACKDATED[0] });

  const res = await d.call("import_entry", {
    id: before.id,
    title: before.title,
    body: before.body,
    date: before.date,
    tags: before.tags,
    origin: before.origin ?? undefined,
    created_at: before.created_at,
    updated_at: before.updated_at,
    on_conflict: "replace",
  });
  assert.equal(res.action, "replaced");
  assert.deepEqual(await d.call("get_entry", { id: before.id }), before);
});

test("a whole drawer restores into an empty store with ids, dates and order intact", async () => {
  const source = await fresh();
  const original = (await source.call("export_entries", { limit: 500 })).entries;

  const target = await makeDrawer({ entries: {}, order: [] }, { allowImport: true });
  for (const e of original) {
    const res = await target.call("import_entry", {
      id: e.id,
      title: e.title,
      body: e.body,
      date: e.date,
      tags: e.tags,
      origin: e.origin ?? undefined,
      created_at: e.created_at,
      updated_at: e.updated_at,
    });
    assert.equal(res.action, "created", `imported ${e.id}`);
  }

  const restored = (await target.call("export_entries", { limit: 500 })).entries;
  assert.equal(restored.length, original.length);
  assert.deepEqual(
    restored.map((e) => e.id),
    original.map((e) => e.id),
    "chronological order reconstructed, not filing order"
  );
  assert.deepEqual(restored, original, "every field survives");
});
