import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OAuthProvider, getOAuthApi, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// ─── Types ───

interface Env {
  DRAWER_KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
}

interface Entry {
  id: string;
  title: string;
  body: string;
  date: string;
  tags: string[];
  origin: string | null;
}

interface DrawerData {
  entries: Record<string, Entry>;
  order: string[];
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

function generateId(): string {
  return "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

// ─── MCP Server ───

let _kv: KVNamespace;

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
      const entry: Entry = {
        id,
        title,
        body,
        date: new Date().toISOString().slice(0, 10),
        tags: tags || [],
        origin: origin || null,
      };
      data.entries[id] = entry;
      data.order.unshift(id);
      await saveData(_kv, data);
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
      const entries = data.order.slice(0, n).map((id) => {
        const e = data.entries[id];
        return { id: e.id, title: e.title, date: e.date, tags: e.tags };
      });
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

  return server;
}

const mcpServer = buildServer();
const mcpHandler = createMcpHandler(mcpServer);

// ─── OAuth provider ───

// Partial config without defaultHandler (to avoid circular reference in getOAuthApi)
const oauthBaseOptions = {
  apiRoute: "/mcp" as const,
  authorizeEndpoint: "/authorize" as const,
  tokenEndpoint: "/token" as const,
  clientRegistrationEndpoint: "/register" as const,
};

export default new OAuthProvider<Env>({
  ...oauthBaseOptions,
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      _kv = env.DRAWER_KV;
      return mcpHandler(request, env, ctx);
    },
  },
  defaultHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // OAuth authorize: auto-approve all requests
      if (url.pathname === "/authorize") {
        const oauthApi: OAuthHelpers = getOAuthApi(oauthBaseOptions as any, env);
        const authRequest = await oauthApi.parseAuthRequest(request);
        const { redirectTo } = await oauthApi.completeAuthorization({
          request: authRequest,
          userId: "drawer-user",
          metadata: {},
          scope: authRequest.scope,
          props: {},
        });
        return Response.redirect(redirectTo, 302);
      }

      // Storage API
      const storageResponse = await handleStorageRequest(request, env);
      if (storageResponse) return storageResponse;

      // Static assets (Vite build)
      return env.ASSETS.fetch(request);
    },
  },
});
