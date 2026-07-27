import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OAuthProvider, getOAuthApi, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// ─── Types ───

interface Env {
  DRAWER_KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  CF_ACCESS_TEAM: string;
  CF_ACCESS_AUD: string;
  // Absent by default. import_entry writes server-assigned fields (id, date), so it
  // stays off unless deliberately enabled — the tool being missing is a stronger
  // guarantee than the tool being present and careful.
  DRAWER_ALLOW_IMPORT?: string;
}

interface Entry {
  id: string;
  title: string;
  body: string;
  date: string;
  tags: string[];
  origin: string | null;
  // Added 2026-07. Legacy records predate these and are backfilled on read by
  // hydrate() rather than by rewriting the store. `date` stays the human-facing
  // filing date; created_at is what actually orders two entries filed the same day.
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

interface DrawerData {
  entries: Record<string, Entry>;
  order: string[];
  // Monotonic across all mutations. One comparison tells a backup whether anything
  // changed at all, which is the cheapest possible no-op run.
  revision?: number;
}

// ─── Constants ───

const STORAGE_KEY = "claude-drawer:entries";
const EMPTY_STATE: DrawerData = { entries: {}, order: [] };

// ─── KV helpers ───

async function loadData(kv: KVNamespace): Promise<DrawerData> {
  const raw = await kv.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : EMPTY_STATE;
}

async function saveData(kv: KVNamespace, data: DrawerData): Promise<void> {
  await kv.put(STORAGE_KEY, JSON.stringify(data));
}

// Every mutation goes through here so store_revision cannot drift out of sync with
// the data. NOTE: load/modify/commit is still read-modify-write against a single KV
// value with no compare-and-set — concurrent writers can lose an entry. Narrowing
// that properly needs a Durable Object; this only keeps the revision honest.
async function commit(kv: KVNamespace, data: DrawerData): Promise<number> {
  data.revision = (data.revision ?? 0) + 1;
  await saveData(kv, data);
  return data.revision;
}

function generateId(): string {
  return "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Ids are "e_" + base36 ms timestamp + 4 random base36 chars. Lenient on the
// timestamp width so this keeps working when it grows a digit (~year 2059), strict
// enough that import_entry cannot smuggle in an arbitrary string as a primary key.
const ID_RE = /^e_[0-9a-z]{10,16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The id is time-seeded, so created_at is recoverable for records written before the
// field existed — verified against all 29 live entries, which decode to their own
// filing dates. Returns null rather than a wrong guess if the id is not ours.
function createdAtFromId(id: string): string | null {
  const m = /^e_([0-9a-z]+)[0-9a-z]{4}$/.exec(id);
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  if (!Number.isFinite(ms)) return null;
  // Sanity window: 2000-01-01 .. tomorrow. Outside it, the id is not a timestamp.
  if (ms < 946684800000 || ms > Date.now() + 86400000) return null;
  return new Date(ms).toISOString();
}

// Deterministic, non-destructive backfill: same input always yields the same
// timestamps, so a backup diffing successive exports sees no spurious drift.
function hydrate(e: Entry): Required<Pick<Entry, "created_at" | "updated_at" | "deleted_at">> & Entry {
  const created = e.created_at ?? createdAtFromId(e.id) ?? `${e.date}T00:00:00.000Z`;
  return {
    ...e,
    created_at: created,
    updated_at: e.updated_at ?? created,
    deleted_at: e.deleted_at ?? null,
  };
}

function isLive(e: Entry | undefined): e is Entry {
  return !!e && !e.deleted_at;
}

// `order` is most-recent-first. Insert by created_at instead of unshifting so a
// restored entry lands in its real chronological slot rather than at the top.
function insertOrdered(data: DrawerData, entry: Entry): void {
  const at = hydrate(entry).created_at;
  const i = data.order.findIndex((id) => {
    const other = data.entries[id];
    return !!other && hydrate(other).created_at < at;
  });
  if (i === -1) data.order.push(entry.id);
  else data.order.splice(i, 0, entry.id);
}

// ─── Storage API handler ───

async function handleStorageRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/storage\/(.+)$/);
  if (!match) return null;

  const key = decodeURIComponent(match[1]);

  if (request.method === "GET") {
    const value = await env.DRAWER_KV.get(key);
    return Response.json({ value });
  }

  if (request.method === "PUT") {
    const { value } = await request.json() as { value: string };
    await env.DRAWER_KV.put(key, value);
    return Response.json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
}

// ─── Cloudflare Access JWT validation ───

let _jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getAccessJWKS(team: string): Promise<JsonWebKey[]> {
  if (_jwksCache && Date.now() - _jwksCache.fetchedAt < JWKS_TTL_MS) {
    return _jwksCache.keys;
  }
  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Failed to fetch Access JWKS");
  const data = await res.json() as { keys: JsonWebKey[] };
  _jwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function validateAccessJWT(request: Request, env: Env): Promise<string | null> {
  if (!env.CF_ACCESS_TEAM || !env.CF_ACCESS_AUD) return null;

  // Extract token from header or cookie
  let token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/CF_Authorization=([^;]+)/);
    token = match ? match[1] : null;
  }
  if (!token) return null;

  try {
    // Decode header and payload without verification first
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));

    // Verify audience
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.CF_ACCESS_AUD)) return null;

    // Verify expiry
    if (payload.exp && payload.exp < Date.now() / 1000) return null;

    // Verify signature using JWKS
    const keys = await getAccessJWKS(env.CF_ACCESS_TEAM);
    const jwk = keys.find((k: any) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const signatureBytes = base64UrlDecode(parts[2]);
    const dataBytes = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, dataBytes);

    return valid ? (payload.email || payload.sub || "authenticated") : null;
  } catch {
    return null;
  }
}

// ─── MCP Server ───

let _kv: KVNamespace;
let _allowImport = false;

function buildServer(): McpServer {
  const server = new McpServer({
    name: "the-drawer",
    version: "1.0.0",
  });

  server.tool(
    "add_entry",
    "Add a new entry to The Drawer",
    {
      title: z.string().describe("Entry title"),
      body: z.string().describe("Entry body text"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
      origin: z.string().optional().describe("Optional origin/source note"),
    },
    async ({ title, body, tags, origin }) => {
      const data = await loadData(_kv);
      const id = generateId();
      const now = new Date().toISOString();
      const entry: Entry = {
        id,
        title,
        body,
        date: now.slice(0, 10),
        tags: tags || [],
        origin: origin || null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
      data.entries[id] = entry;
      data.order.unshift(id);
      await commit(_kv, data);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entry, null, 2) }],
      };
    }
  );

  server.tool(
    "search_entries",
    "Search entries in The Drawer by keyword. Searches titles, bodies, tags, and origins.",
    {
      query: z.string().describe("Search query"),
    },
    async ({ query }) => {
      const data = await loadData(_kv);
      const q = query.toLowerCase();
      const results = data.order
        .map((id) => data.entries[id])
        .filter(isLive)
        .map(hydrate)
        .filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.body.toLowerCase().includes(q) ||
            e.tags?.some((t) => t.toLowerCase().includes(q)) ||
            (e.origin || "").toLowerCase().includes(q)
        );
      return {
        content: [
          {
            type: "text" as const,
            text: results.length
              ? JSON.stringify(results, null, 2)
              : `No entries matching "${query}"`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_entries",
    "List entries in The Drawer, most recent first.",
    {
      limit: z.number().optional().describe("Max entries to return (default 20)"),
    },
    async ({ limit }) => {
      const data = await loadData(_kv);
      const n = limit || 20;
      // origin is short and it is the most useful field for judging whether an old
      // entry is relevant to the current conversation. body stays out — that is what
      // export_entries and get_entry are for.
      const entries = data.order
        .map((id) => data.entries[id])
        .filter(isLive)
        .slice(0, n)
        .map((e) => ({ id: e.id, title: e.title, date: e.date, tags: e.tags, origin: e.origin ?? null }));
      return {
        content: [
          {
            type: "text" as const,
            text: entries.length
              ? JSON.stringify(entries, null, 2)
              : "The Drawer is empty.",
          },
        ],
      };
    }
  );

  server.tool(
    "get_entry",
    "Fetch a single entry from The Drawer by its id, including the full body. Returns null if no such entry exists.",
    {
      id: z.string().describe("Entry id, e.g. e_mnjzu6v5alte"),
    },
    async ({ id }) => {
      const data = await loadData(_kv);
      const e = data.entries[id];
      return {
        content: [
          {
            type: "text" as const,
            text: e ? JSON.stringify(hydrate(e), null, 2) : "null",
          },
        ],
      };
    }
  );

  server.tool(
    "export_entries",
    "Export full entry records for backup, including bodies, origins, timestamps, and " +
      "soft-deleted tombstones. For backups, call with no `since` — a full export is what " +
      "lets a backup detect edits, deletions, and drift, and the whole store is read into " +
      "memory on every call regardless, so `since` shrinks the response but saves no work. " +
      "To skip an unchanged run cheaply, compare `store_revision` against the previous run's.",
    {
      since: z
        .string()
        .optional()
        .describe("ISO timestamp; return only entries with updated_at > since. Omit for a full export (recommended for backups)."),
      cursor: z.string().optional().describe("Opaque cursor from a previous call's next_cursor."),
      limit: z.number().optional().describe("Max entries per page (default 100, max 500)."),
    },
    async ({ since, cursor, limit }) => {
      const data = await loadData(_kv);
      const revision = data.revision ?? 0;
      const n = Math.min(Math.max(limit ?? 100, 1), 500);

      let start = 0;
      if (cursor) {
        // `order` is mutated by unshift on every add, so a bare index cursor silently
        // shifts under the client. Binding the cursor to a revision turns that into a
        // loud restart instead of a skipped entry.
        const [rev, idx] = cursor.split(":");
        if (rev !== String(revision)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "cursor_expired",
                  message: `The drawer changed during pagination (cursor revision ${rev}, store now ${revision}). Restart the export from the beginning.`,
                  store_revision: String(revision),
                }),
              },
            ],
          };
        }
        start = parseInt(idx, 10) || 0;
      }

      const all = data.order.map((id) => data.entries[id]).filter(Boolean).map(hydrate);
      const filtered = since ? all.filter((e) => e.updated_at > since) : all;
      const page = filtered.slice(start, start + n);
      const end = start + page.length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                entries: page,
                next_cursor: end < filtered.length ? `${revision}:${end}` : null,
                store_revision: String(revision),
                total: filtered.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "import_entry",
    "Restore a single entry with its original id and date preserved. This is the restore " +
      "path, not the filing path — use add_entry for normal writing. Disabled unless the " +
      "server sets DRAWER_ALLOW_IMPORT=1.",
    {
      id: z.string().describe("Original entry id. Must match the server's id grammar."),
      title: z.string(),
      body: z.string(),
      date: z.string().describe("Original filing date, YYYY-MM-DD"),
      tags: z.array(z.string()).optional(),
      origin: z.string().optional(),
      created_at: z.string().optional().describe("ISO timestamp; derived from the id if omitted."),
      updated_at: z.string().optional(),
      on_conflict: z
        .enum(["skip", "fail", "replace"])
        .optional()
        .describe("What to do if the id already exists. Default 'fail'."),
    },
    async ({ id, title, body, date, tags, origin, created_at, updated_at, on_conflict }) => {
      const fail = (message: string) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "import_rejected", message }) }],
      });

      if (!_allowImport) {
        return fail("import_entry is disabled. Set DRAWER_ALLOW_IMPORT=1 on the server to enable restores.");
      }
      if (!ID_RE.test(id)) {
        return fail(`'${id}' is not a valid drawer id. Expected e_ followed by 10-16 base36 characters.`);
      }
      if (!DATE_RE.test(date)) {
        return fail(`'${date}' is not a valid date. Expected YYYY-MM-DD.`);
      }

      const mode = on_conflict ?? "fail";
      const data = await loadData(_kv);
      const existing = data.entries[id];

      if (existing) {
        if (mode === "fail") {
          return fail(`Entry ${id} already exists. Pass on_conflict='skip' to make the restore idempotent, or 'replace' to overwrite.`);
        }
        if (mode === "skip") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ id, action: "skipped" }) }],
          };
        }
      }

      const created = created_at ?? createdAtFromId(id) ?? `${date}T00:00:00.000Z`;
      const entry: Entry = {
        id,
        title,
        body,
        date,
        tags: tags ?? [],
        origin: origin ?? null,
        created_at: created,
        updated_at: updated_at ?? created,
        deleted_at: null,
      };

      data.entries[id] = entry;
      // On replace the id already holds its slot in `order`; only a new id needs placing.
      if (!existing) insertOrdered(data, entry);
      await commit(_kv, data);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, action: existing ? "replaced" : "created" }),
          },
        ],
      };
    }
  );

  return server;
}

// ─── OAuth provider ───

// Store the full options so getOAuthApi can access them from defaultHandler
let _oauthOptions: any;

const oauthConfig = {
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      _kv = env.DRAWER_KV;
      _allowImport = env.DRAWER_ALLOW_IMPORT === "1";
      // Create a fresh McpServer per request (stateless handler requirement)
      const server = buildServer();
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    },
  },
  defaultHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // OAuth authorize: require Access JWT, then auto-approve
      if (url.pathname === "/authorize") {
        const user = await validateAccessJWT(request, env);
        if (!user) return new Response("Unauthorized — Cloudflare Access login required", { status: 401 });
        const oauthApi: OAuthHelpers = getOAuthApi(_oauthOptions, env);
        const authRequest = await oauthApi.parseAuthRequest(request);
        const { redirectTo } = await oauthApi.completeAuthorization({
          request: authRequest,
          userId: user,
          metadata: {},
          scope: authRequest.scope,
          props: {},
        });
        return Response.redirect(redirectTo, 302);
      }

      // Storage API (protected by Access JWT)
      if (url.pathname.startsWith("/api/storage/")) {
        const user = await validateAccessJWT(request, env);
        if (!user) return new Response("Unauthorized", { status: 401 });
        const storageResponse = await handleStorageRequest(request, env);
        if (storageResponse) return storageResponse;
      }

      // Static assets (Vite build)
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
};

_oauthOptions = oauthConfig;

export default new OAuthProvider<Env>(oauthConfig);
