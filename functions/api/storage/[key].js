// GET /api/storage/:key
export async function onRequestGet(context) {
  const key = decodeURIComponent(context.params.key);
  const value = await context.env.DRAWER_KV.get(key);
  return Response.json({ value });
}

// PUT /api/storage/:key
export async function onRequestPut(context) {
  const key = decodeURIComponent(context.params.key);
  const { value } = await context.request.json();
  await context.env.DRAWER_KV.put(key, value);
  return Response.json({ ok: true });
}
