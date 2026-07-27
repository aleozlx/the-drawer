// Stand-in for `agents/mcp`, which only loads inside the Workers runtime.
//
// The real createMcpHandler wires an McpServer to HTTP transport. The tests do not
// exercise transport — they call the tool implementations directly — so this just
// captures the server the worker built. It goes through globalThis because esbuild
// inlines this module into the bundle, giving the bundle its own copy.
export function createMcpHandler(server) {
  globalThis.__capturedMcpServer = server;
  return async () => new Response("stub");
}
