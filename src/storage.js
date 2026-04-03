// Storage shim — talks to the Express server API
window.storage = {
  async get(key) {
    const res = await fetch(`/api/storage/${encodeURIComponent(key)}`);
    const data = await res.json();
    return data.value ? { value: data.value } : null;
  },
  async set(key, value) {
    const res = await fetch(`/api/storage/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error("Storage write failed");
  },
};
