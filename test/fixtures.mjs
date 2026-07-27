// Synthetic drawer, shaped like the real one.
//
// The entries are invented — the live drawer is private — but every structural
// property the worker has to survive is reproduced here deliberately:
//
//   - Records are in *legacy* shape: no created_at / updated_at / deleted_at.
//     This is what is actually in KV, and what hydrate() has to backfill.
//   - Ids are time-seeded ("e_" + base36 ms + 4 random chars), so created_at is
//     recoverable from the id alone.
//   - Two entries share a millisecond, so created_at is NOT a unique key.
//   - Two entries share a title, so title is NOT a key either.
//   - Two entries have a `date` earlier than their id's timestamp, reproducing
//     entries that arrived through the UI import path with an explicit date.
//     `date` is the authored date; created_at is the write time.
//   - One entry has a body truncated mid-sentence, empty tags and null origin.
//   - Bodies carry the unicode the real ones do: em-dashes, arrows, ≥, U+2212.
//
// `order` is most-recent-first, matching the server's convention.

/** @returns {{entries: Record<string, object>, order: string[]}} */
export function legacyDrawer() {
  const e = [
    {
      id: "e_mrncknu8ffff", // 2026-07-16T10:09:34.640Z
      title: "Fallible Because Embodied",
      body: "A system that cannot be wrong about the world is a system that is not in it.",
      date: "2026-07-16",
      tags: ["agency", "embodiment"],
      origin: "conversation about robot arms",
    },
    {
      id: "e_mp85asw0eeee", // 2026-05-16T09:30:00.000Z
      title: "The Maintainer Is the Verifier",
      body: "Whoever carries the pager decides what “correct” means — the spec is downstream of that.",
      date: "2026-05-16",
      tags: ["software", "verification"],
      origin: null,
    },
    {
      // Duplicate title, 123 seconds after the truncated one below.
      id: "e_mnpxnpvvdddd", // 2026-04-08T10:56:32.203Z
      title: "Redundancy Is Entanglement's Shadow",
      body: "Two components fail independently only if nothing couples them — and “nothing” is a claim about the whole system, not the pair. Coupling ≥ 1 bit means the second copy buys less than it costs. Call the deficit −Δ.",
      date: "2026-04-08",
      tags: ["reliability", "information"],
      origin: "thinking about failover",
    },
    {
      // Partial write: truncated mid-sentence, no tags, no origin.
      id: "e_mnpxl3cscccc", // 2026-04-08T10:54:29.692Z
      title: "Redundancy Is Entanglement's Shadow",
      body: "Two components fail independently only if nothing couples them, because the over-actuation that",
      date: "2026-04-08",
      tags: [],
      origin: null,
    },
    {
      // Backdated: filed 2026-03-31, actually written 2026-04-04.
      id: "e_mnjzu6v5aaaa", // 2026-04-04T07:10:56.321Z
      title: "You Just Learn the Weight",
      body: "Some doors you carry. You don't open them.",
      date: "2026-03-31",
      tags: ["parable"],
      origin: "The Locksmith of Untried Doors",
    },
    {
      // Same millisecond as the entry above, also backdated.
      id: "e_mnjzu6v5bbbb", // 2026-04-04T07:10:56.321Z
      title: "Garbage Collection for Fate",
      body: "Declining a prophecy by never observing it → the reference count stays at zero.",
      date: "2026-03-31",
      tags: ["parable", "runtime"],
      origin: null,
    },
  ];

  return {
    entries: Object.fromEntries(e.map((x) => [x.id, x])),
    order: e.map((x) => x.id), // already most-recent-first
  };
}

export const COUNT = legacyDrawer().order.length;

/** Ids whose `date` is deliberately earlier than the id's own timestamp. */
export const BACKDATED = ["e_mnjzu6v5aaaa", "e_mnjzu6v5bbbb"];

/** Two ids minted in the same millisecond. */
export const SAME_MS = ["e_mnjzu6v5aaaa", "e_mnjzu6v5bbbb"];

/** Two ids sharing a title. */
export const SAME_TITLE = ["e_mnpxnpvvdddd", "e_mnpxl3cscccc"];

/** The truncated partial write. */
export const TRUNCATED = "e_mnpxl3cscccc";

/** Most recent entry, used for `since` filtering. */
export const NEWEST = "e_mrncknu8ffff";
