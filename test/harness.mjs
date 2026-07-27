// Runs src/worker.ts under plain node.
//
// The worker imports two Workers-only modules (`agents/mcp` pulls in cloudflare:
// scheme imports), so it cannot be imported directly. esbuild bundles it with those
// two aliased to local stubs; everything else — the MCP SDK, zod, and all of the
// worker's own logic — is the real thing.

import * as esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, ".build", "worker.bundle.mjs");

let provider = null;

async function loadWorker() {
  if (provider) return provider;

  await esbuild.build({
    entryPoints: [join(here, "..", "src", "worker.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: BUNDLE,
    alias: {
      "agents/mcp": join(here, "stubs", "agents-mcp.js"),
      "@cloudflare/workers-oauth-provider": join(here, "stubs", "oauth.js"),
    },
    // Left as real imports, resolved by node from node_modules.
    external: ["@modelcontextprotocol/sdk/*", "zod"],
    logLevel: "warning",
  });

  provider = (await import(pathToFileURL(BUNDLE).href)).default;
  return provider;
}

/**
 * Boot the worker against an in-memory KV holding `initialData`.
 *
 * Returns `call(name, args)` for invoking a tool, plus `read()` for inspecting the
 * store as the worker actually left it — which is how the tests check that reads
 * do not write.
 */
export async function makeDrawer(initialData, { allowImport = false } = {}) {
  const p = await loadWorker();

  let raw = JSON.stringify(initialData);
  const kv = {
    async get() {
      return raw;
    },
    async put(_key, value) {
      raw = value;
    },
  };

  const env = { DRAWER_KV: kv, ...(allowImport ? { DRAWER_ALLOW_IMPORT: "1" } : {}) };
  await p.opts.apiHandler.fetch(new Request("https://test.invalid/mcp"), env, {});

  const server = globalThis.__capturedMcpServer;
  const tools = server?._registeredTools;
  if (!tools) {
    throw new Error(
      "Could not read registered tools off McpServer. The SDK's internal shape " +
        "probably changed; update this harness."
    );
  }

  return {
    /** Invoke a tool and return its parsed JSON response (or raw text). */
    async call(name, args = {}) {
      const tool = tools[name];
      if (!tool) {
        throw new Error(`No tool "${name}". Registered: ${Object.keys(tools).join(", ")}`);
      }
      const fn = tool.callback ?? tool.handler ?? tool.cb;
      const result = await fn(args, {});
      const text = result.content[0].text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    /** The raw stored value, exactly as the worker left it. */
    read: () => raw,
    toolNames: () => Object.keys(tools),
  };
}
