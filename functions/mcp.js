const STORAGE_KEY = "claude-drawer:entries";
const EMPTY_STATE = { entries: {}, order: [] };

// ─── KV helpers ───

async function loadData(kv) {
  const raw = await kv.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : EMPTY_STATE;
}

async function saveData(kv, data) {
  await kv.put(STORAGE_KEY, JSON.stringify(data));
}

function generateId() {
  return "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Tool definitions ───

const TOOLS = [
  {
    name: "add_entry",
    description: "Add a new entry to The Drawer. Returns the created entry.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Entry title" },
        body: { type: "string", description: "Entry body text" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        origin: { type: "string", description: "Optional origin/source note" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "search_entries",
    description: "Search entries in The Drawer by keyword. Searches titles, bodies, tags, and origins.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_entries",
    description: "List entries in The Drawer, most recent first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries to return (default 20)" },
      },
    },
  },
];

// ─── Tool handlers ───

async function handleAddEntry(kv, params) {
  const data = await loadData(kv);
  const id = generateId();
  const entry = {
    id,
    title: params.title,
    body: params.body,
    date: new Date().toISOString().slice(0, 10),
    tags: params.tags || [],
    origin: params.origin || null,
  };
  data.entries[id] = entry;
  data.order.unshift(id);
  await saveData(kv, data);
  return { type: "text", text: JSON.stringify(entry, null, 2) };
}

async function handleSearchEntries(kv, params) {
  const data = await loadData(kv);
  const q = (params.query || "").toLowerCase();
  const results = data.order
    .map(id => data.entries[id])
    .filter(e =>
      e.title.toLowerCase().includes(q) ||
      e.body.toLowerCase().includes(q) ||
      e.tags?.some(t => t.toLowerCase().includes(q)) ||
      (e.origin || "").toLowerCase().includes(q)
    );
  return {
    type: "text",
    text: results.length
      ? JSON.stringify(results, null, 2)
      : `No entries matching "${params.query}"`,
  };
}

async function handleListEntries(kv, params) {
  const data = await loadData(kv);
  const limit = params.limit || 20;
  const entries = data.order.slice(0, limit).map(id => {
    const e = data.entries[id];
    return { id: e.id, title: e.title, date: e.date, tags: e.tags };
  });
  return {
    type: "text",
    text: entries.length
      ? JSON.stringify(entries, null, 2)
      : "The Drawer is empty.",
  };
}

async function callTool(kv, name, params) {
  switch (name) {
    case "add_entry": return handleAddEntry(kv, params);
    case "search_entries": return handleSearchEntries(kv, params);
    case "list_entries": return handleListEntries(kv, params);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC helpers ───

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ─── MCP request handler ───

async function handleMcpRequest(body, kv, sessionId) {
  const { id, method, params } = body;

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "the-drawer", version: "1.0.0" },
      });

    case "notifications/initialized":
      // Client acknowledgement — no response needed for notifications
      return null;

    case "tools/list":
      return jsonRpcResult(id, { tools: TOOLS });

    case "tools/call":
      try {
        const content = await callTool(kv, params.name, params.arguments || {});
        return jsonRpcResult(id, { content: [content] });
      } catch (e) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        });
      }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Pages Function handler ───

export async function onRequestPost(context) {
  const kv = context.env.DRAWER_KV;
  const body = await context.request.json();
  const sessionId = context.request.headers.get("mcp-session-id") || crypto.randomUUID();

  // Handle batch requests
  if (Array.isArray(body)) {
    const results = [];
    for (const req of body) {
      const result = await handleMcpRequest(req, kv, sessionId);
      if (result) results.push(result);
    }
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
      },
    });
  }

  // Single request
  const result = await handleMcpRequest(body, kv, sessionId);

  // Notifications have no response
  if (!result) {
    return new Response(null, {
      status: 202,
      headers: { "Mcp-Session-Id": sessionId },
    });
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    },
  });
}

// GET for SSE — return empty stream (stateless, no pending messages)
export async function onRequestGet(context) {
  return new Response("", {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
