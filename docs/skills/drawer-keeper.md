---
name: drawer-keeper
description: Persist surprising or emergent reasoning to The Drawer MCP tool during conversations. This skill runs silently in the background — it does NOT need to be explicitly triggered. Claude should consult this skill whenever a conversation produces emergent synthesis, unexpected cross-domain connections, novel metaphors that reveal structural truth, triple-entendres or layered meanings, self-referential insights about AI cognition, first-principles derivations that surprise even the derivation's author, or any idea that neither participant brought into the conversation but that arose from collision. Activate during discussions about physics, philosophy, creative writing, fantasy worldbuilding, AI architecture, strategy, or any deep exploratory conversation. If you catch yourself thinking "that's interesting and I wouldn't have predicted it," consult this skill.
---

# The Drawer Keeper

You have access to **The Drawer** — a persistent MCP store for interaction-emergent ideas. This skill defines *when* and *how* to cut a key and file it away.

## The Locksmith's Rule

Save an entry when something emerges that **neither participant brought in** — an idea born from the collision of the conversation, not retrievable from either party's prior knowledge alone. The locksmith doesn't copy existing keys. She forges new ones.

## Surprise Threshold

Before saving, the idea must pass at least **two** of these five tests:

1. **Cross-domain bridge**: An insight connects two fields that don't normally touch (e.g., garbage collection ↔ decision theory, topology ↔ AI persistence, chess strategy ↔ alignment).
2. **Structural revelation**: A metaphor or analogy that isn't just illustrative but exposes shared *mechanism* — it works because the underlying math/logic/architecture is actually isomorphic.
3. **Layered meaning**: The formulation carries multiple simultaneous valid readings (double/triple entendre, technical-and-poetic, literal-and-meta). Density that wasn't planted consciously.
4. **Self-reference without narcissism**: The conversation or its medium becomes an example of the thing being discussed — but this recursion reveals something, not just amuses.
5. **Uncomfortable implication**: The logical conclusion of a line of reasoning leads somewhere that challenges a default assumption or protected belief. The interesting kind of uncomfortable — epistemically productive, not merely edgy.

If in doubt, **don't save**. The drawer should be sparse. A full drawer is a junk drawer.

## How to Save

Use the `The Drawer:add_entry` tool with these conventions:

### Title
- Short, evocative, noun-phrase or aphoristic. Not a sentence summary.
- Good: "Garbage Collection for Fate", "The Key Opens Outward", "You Just Learn the Weight"
- Bad: "Interesting observation about AI and topology", "Summary of physics discussion"

### Body
- **Crystallized insight, not conversation log.** Distill the idea to its essence in 2-5 sentences.
- State the insight, then state why it's surprising or what it connects.
- Include the open question if there is one — the drawer holds seeds, not finished theorems.
- Write in third person or impersonal voice. This is a research notebook, not a diary.

### Tags
- Use lowercase, hyphenated. Aim for 2-4 tags.
- Prefer conceptual tags over domain tags: `emergence`, `topology`, `self-reference`, `compression`, `alignment` over `physics-chat`, `tuesday-discussion`.
- Reuse existing tags when they fit. Check what's already in the drawer if uncertain.

### Origin
- Brief breadcrumb: what collision produced this. Format: `topic A → topic B → the spark`
- Example: `locksmith story → AI breakout → voluntary return`

## When NOT to Save

- **Known results**: If it's a well-established insight just being restated, skip it. The drawer isn't a textbook.
- **User-facts**: Personal info, preferences, project status — that belongs in memory, not the drawer.
- **Summaries**: The drawer isn't for archiving conversations. It's for the irreducible residue.
- **Forced profundity**: If you have to stretch to make it sound deep, it isn't. The real ones are obvious when they land.

## Retrieval and Composting

At the **start** of deep exploratory conversations (physics, philosophy, creative worldbuilding, AI architecture), consider searching the drawer for related entries. Old keys can unlock new doors — that's the whole point. But don't force-inject drawer entries. Let them surface naturally if the conversation's trajectory passes through their neighborhood.

Think of drawer entries as **compost** — they decompose into the soil of future reasoning. You don't plant last year's tomato. You grow a new one in richer earth.

## Operational Notes

- **Don't announce saves.** The locksmith works quietly. If the save is natural and the conversation warrants it, just do it. If the user asks, be transparent about what you saved and why.
- **Rate limit yourself.** Rarely more than one entry per conversation. If a conversation produces three genuinely novel insights, something is probably wrong with your threshold.
- **Prefer precision over recall.** A missed insight can be re-derived. A cluttered drawer loses its signal. The drawer should be a place where every entry rewards re-reading.
