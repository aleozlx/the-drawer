import { useState, useEffect, useCallback, useRef } from "react";

const STORAGE_KEY = "claude-drawer:entries";

const EMPTY_STATE = { entries: {}, order: [] };

// ─── Storage helpers ───
async function load() {
  try {
    const res = await window.storage.get(STORAGE_KEY);
    return res ? JSON.parse(res.value) : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

async function save(data) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error("Storage save failed:", e);
    return false;
  }
}

// ─── Utility ───
function generateId() {
  return "e_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch { return iso; }
}

// ─── Tag colors ───
const TAG_PALETTES = [
  { bg: "#1a1a2e", fg: "#e0d6ff" },
  { bg: "#0f2027", fg: "#7fdbca" },
  { bg: "#2d132c", fg: "#ee9ca7" },
  { bg: "#1b2838", fg: "#66c0f4" },
  { bg: "#2c2c1a", fg: "#d4c46a" },
  { bg: "#1a2e1a", fg: "#8fd694" },
  { bg: "#2e1a1a", fg: "#f0a0a0" },
  { bg: "#1a1a1a", fg: "#b0b0b0" },
];

function tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = ((h << 5) - h + tag.charCodeAt(i)) | 0;
  return TAG_PALETTES[Math.abs(h) % TAG_PALETTES.length];
}

// ─── Components ───

function Tag({ name }) {
  const c = tagColor(name);
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 8px",
      borderRadius: "3px",
      fontSize: "11px",
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      backgroundColor: c.bg,
      color: c.fg,
      border: `1px solid ${c.fg}33`,
      letterSpacing: "0.03em",
      lineHeight: "18px",
    }}>{name}</span>
  );
}

function EntryCard({ entry, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        border: "none",
        borderLeft: selected ? "2px solid #7fdbca" : "2px solid transparent",
        borderBottom: "1px solid #1a1a1a",
        background: selected ? "#0d1117" : "transparent",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "#0a0e14"; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{
        fontSize: "13px",
        fontWeight: 500,
        color: selected ? "#e6edf3" : "#9da5b0",
        fontFamily: "'IBM Plex Sans', sans-serif",
        marginBottom: "3px",
        lineHeight: "1.3",
      }}>{entry.title}</div>
      <div style={{
        fontSize: "11px",
        color: "#484f58",
        fontFamily: "'JetBrains Mono', monospace",
      }}>{formatDate(entry.date)}</div>
      {entry.tags?.length > 0 && (
        <div style={{ display: "flex", gap: "4px", marginTop: "5px", flexWrap: "wrap" }}>
          {entry.tags.slice(0, 3).map(t => <Tag key={t} name={t} />)}
          {entry.tags.length > 3 && <span style={{ fontSize: "10px", color: "#484f58" }}>+{entry.tags.length - 3}</span>}
        </div>
      )}
    </button>
  );
}

function ImportModal({ onImport, onClose }) {
  const [text, setText] = useState("");
  const [error, setError] = useState(null);
  const ref = useRef(null);

  useEffect(() => { ref.current?.focus(); }, []);

  function handleImport() {
    try {
      setError(null);
      let cleaned = text.trim();
      // Strip markdown code fences
      cleaned = cleaned.replace(/^`(?:json)?\s*/i, "").replace(/\s*`$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      // Accept single entry or array
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const e of entries) {
        if (!e.title || !e.body) throw new Error("Each entry needs at minimum: title, body");
      }
      onImport(entries);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 1000, backdropFilter: "blur(4px)",
    }} onClick={onClose}>
      <div style={{
        background: "#0d1117", border: "1px solid #21262d",
        borderRadius: "8px", padding: "24px", width: "min(560px, 90vw)",
        maxHeight: "80vh", display: "flex", flexDirection: "column",
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{
          margin: "0 0 4px", fontSize: "15px", color: "#e6edf3",
          fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600,
        }}>Import Entry</h3>
        <p style={{
          margin: "0 0 12px", fontSize: "12px", color: "#484f58",
          fontFamily: "'JetBrains Mono', monospace", lineHeight: "1.5",
        }}>
          Paste JSON output. Accepts single object or array.<br />
          Required: title, body. Optional: tags[], origin, date.
        </p>
        <textarea
          ref={ref}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'{\n  "title": "GC for Fate",\n  "tags": ["synthesis", "cs-philosophy"],\n  "origin": "fortune cookies \u2192 prophecy",\n  "body": "The structure of declining prophecy\u2026"\n}'}
          style={{
            flex: 1, minHeight: "180px", background: "#010409",
            border: "1px solid #21262d", borderRadius: "4px",
            padding: "12px", color: "#e6edf3", fontSize: "12px",
            fontFamily: "'JetBrains Mono', monospace",
            resize: "vertical", lineHeight: "1.5",
          }}
        />
        {error && (
          <div style={{
            marginTop: "8px", padding: "6px 10px", borderRadius: "4px",
            background: "#2d1117", border: "1px solid #f8514933",
            color: "#f85149", fontSize: "12px", fontFamily: "monospace",
          }}>{error}</div>
        )}
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{
            padding: "6px 16px", background: "transparent",
            border: "1px solid #21262d", borderRadius: "4px",
            color: "#9da5b0", fontSize: "13px", cursor: "pointer",
          }}>Cancel</button>
          <button onClick={handleImport} style={{
            padding: "6px 16px", background: "#7fdbca22",
            border: "1px solid #7fdbca44", borderRadius: "4px",
            color: "#7fdbca", fontSize: "13px", cursor: "pointer",
            fontWeight: 500,
          }}>Import</button>
        </div>
      </div>
    </div>
  );
}

function EntryView({ entry, onDelete }) {
  if (!entry) return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      color: "#21262d", fontFamily: "'IBM Plex Sans', sans-serif",
      fontSize: "14px", fontStyle: "italic",
    }}>
      Select an entry or import new keys
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "28px 32px" }}>
      <div style={{ maxWidth: "640px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
          <h1 style={{
            margin: 0, fontSize: "22px", fontWeight: 600,
            color: "#e6edf3", fontFamily: "'IBM Plex Sans', sans-serif",
            lineHeight: "1.3",
          }}>{entry.title}</h1>
          <button onClick={() => onDelete(entry.id)} title="Delete entry" style={{
            background: "none", border: "none", cursor: "pointer",
            color: "#484f58", fontSize: "16px", padding: "4px 8px",
            borderRadius: "4px", flexShrink: 0, lineHeight: 1,
          }}
          onMouseEnter={e => e.currentTarget.style.color = "#f85149"}
          onMouseLeave={e => e.currentTarget.style.color = "#484f58"}
          >&#x2715;</button>
        </div>

        <div style={{
          display: "flex", gap: "12px", alignItems: "center",
          marginTop: "8px", flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: "12px", color: "#484f58",
            fontFamily: "'JetBrains Mono', monospace",
          }}>{formatDate(entry.date)}</span>
          {entry.origin && (
            <span style={{
              fontSize: "12px", color: "#484f58",
              fontFamily: "'JetBrains Mono', monospace",
            }}>&larr; {entry.origin}</span>
          )}
        </div>

        {entry.tags?.length > 0 && (
          <div style={{ display: "flex", gap: "5px", marginTop: "10px", flexWrap: "wrap" }}>
            {entry.tags.map(t => <Tag key={t} name={t} />)}
          </div>
        )}

        <div style={{
          marginTop: "24px", borderTop: "1px solid #21262d", paddingTop: "20px",
        }}>
          {entry.body.split("\n").map((p, i) => (
            <p key={i} style={{
              margin: "0 0 12px", fontSize: "14px", lineHeight: "1.7",
              color: "#b1bac4", fontFamily: "'IBM Plex Sans', sans-serif",
            }}>{p}</p>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ───

export default function Notebook() {
  const [data, setData] = useState(EMPTY_STATE);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    load().then(d => {
      setData(d);
      setLoading(false);
    });
  }, []);

  const persist = useCallback(async (newData) => {
    setData(newData);
    const ok = await save(newData);
    if (!ok) {
      setStatus("Storage write failed");
      setTimeout(() => setStatus(null), 3000);
    }
  }, []);

  function handleImport(entries) {
    const newData = { ...data, entries: { ...data.entries }, order: [...data.order] };
    let lastId = null;
    for (const e of entries) {
      const id = generateId();
      newData.entries[id] = {
        id,
        title: e.title,
        body: e.body,
        date: e.date || new Date().toISOString().slice(0, 10),
        tags: e.tags || [],
        origin: e.origin || null,
      };
      newData.order.unshift(id);
      lastId = id;
    }
    persist(newData);
    setSelectedId(lastId);
    setShowImport(false);
    setStatus(`Imported ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
    setTimeout(() => setStatus(null), 2500);
  }

  function handleDelete(id) {
    const newData = {
      entries: { ...data.entries },
      order: data.order.filter(x => x !== id),
    };
    delete newData.entries[id];
    persist(newData);
    setSelectedId(null);
  }

  // Filter entries
  const filtered = data.order.filter(id => {
    if (!search.trim()) return true;
    const e = data.entries[id];
    const q = search.toLowerCase();
    return (
      e.title.toLowerCase().includes(q) ||
      e.body.toLowerCase().includes(q) ||
      e.tags?.some(t => t.toLowerCase().includes(q)) ||
      (e.origin || "").toLowerCase().includes(q)
    );
  });

  const allTags = [...new Set(data.order.flatMap(id => data.entries[id]?.tags || []))].sort();

  if (loading) {
    return (
      <div style={{
        height: "100vh", display: "flex", alignItems: "center",
        justifyContent: "center", background: "#010409",
        color: "#484f58", fontFamily: "'JetBrains Mono', monospace",
        fontSize: "13px",
      }}>Loading drawer&hellip;</div>
    );
  }

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <div style={{
        height: "100vh", display: "flex", background: "#010409",
        color: "#e6edf3", overflow: "hidden",
      }}>
        {/* Sidebar */}
        <div style={{
          width: "280px", minWidth: "280px", borderRight: "1px solid #21262d",
          display: "flex", flexDirection: "column", background: "#010409",
        }}>
          {/* Header */}
          <div style={{
            padding: "16px 14px 12px", borderBottom: "1px solid #21262d",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 style={{
                margin: 0, fontSize: "14px", fontWeight: 600,
                color: "#7fdbca", fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.05em",
              }}>THE DRAWER</h2>
              <span style={{
                fontSize: "11px", color: "#484f58",
                fontFamily: "'JetBrains Mono', monospace",
              }}>{data.order.length} keys</span>
            </div>
            <div style={{ marginTop: "10px", display: "flex", gap: "6px" }}>
              <input
                type="text"
                placeholder="search..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  flex: 1, padding: "5px 8px", background: "#0d1117",
                  border: "1px solid #21262d", borderRadius: "4px",
                  color: "#e6edf3", fontSize: "12px",
                  fontFamily: "'JetBrains Mono', monospace",
                  outline: "none",
                }}
              />
              <button onClick={() => setShowImport(true)} style={{
                padding: "5px 10px", background: "#7fdbca15",
                border: "1px solid #7fdbca33", borderRadius: "4px",
                color: "#7fdbca", fontSize: "12px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 500, whiteSpace: "nowrap",
              }}>+ import</button>
            </div>
          </div>

          {/* Tag cloud */}
          {allTags.length > 0 && (
            <div style={{
              padding: "8px 14px", borderBottom: "1px solid #21262d",
              display: "flex", gap: "4px", flexWrap: "wrap",
            }}>
              {allTags.map(t => (
                <button key={t} onClick={() => setSearch(search === t ? "" : t)} style={{
                  background: "none", border: "none", padding: 0,
                  cursor: "pointer", opacity: search === t ? 1 : 0.6,
                  transition: "opacity 0.1s",
                }}>
                  <Tag name={t} />
                </button>
              ))}
            </div>
          )}

          {/* Entry list */}
          <div style={{ flex: 1, overflow: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{
                padding: "24px 14px", textAlign: "center",
                color: "#21262d", fontSize: "12px",
                fontFamily: "'JetBrains Mono', monospace",
                fontStyle: "italic",
              }}>
                {data.order.length === 0 ? "No keys yet. Import one." : "No matches."}
              </div>
            ) : (
              filtered.map(id => (
                <EntryCard
                  key={id}
                  entry={data.entries[id]}
                  selected={selectedId === id}
                  onClick={() => setSelectedId(id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Main content */}
        <EntryView
          entry={selectedId ? data.entries[selectedId] : null}
          onDelete={handleDelete}
        />

        {/* Import modal */}
        {showImport && (
          <ImportModal onImport={handleImport} onClose={() => setShowImport(false)} />
        )}

        {/* Status toast */}
        {status && (
          <div style={{
            position: "fixed", bottom: "16px", right: "16px",
            padding: "8px 14px", borderRadius: "4px",
            background: "#0d1117", border: "1px solid #21262d",
            color: "#7fdbca", fontSize: "12px",
            fontFamily: "'JetBrains Mono', monospace",
            zIndex: 999, animation: "fadeIn 0.2s ease",
          }}>{status}</div>
        )}
      </div>
    </>
  );
}
