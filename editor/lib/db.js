// Biblioteca local de stickers creados (IndexedDB).
const DB = "yapper";
const LEGACY_DB = "sonistick"; // nombre anterior del proyecto: se migra una sola vez
const STORE = "stickers";

function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const res = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(res && "result" in res ? res.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

let migrated = null;
async function migrate() {
  try {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    if (!dbs.some((d) => d.name === LEGACY_DB)) return;
    const old = await openDb(LEGACY_DB);
    const items = (await run(old, "readonly", (s) => s.getAll())) || [];
    old.close();
    if (items.length) {
      const db = await openDb(DB);
      await run(db, "readwrite", (s) => items.forEach((it) => s.put(it)));
      db.close();
    }
    await new Promise((r) => { const q = indexedDB.deleteDatabase(LEGACY_DB); q.onsuccess = q.onerror = q.onblocked = r; });
  } catch (e) { /* la migración es opcional */ }
}

async function tx(mode, fn) {
  migrated = migrated || migrate();
  await migrated;
  const db = await openDb(DB);
  try { return await run(db, mode, fn); } finally { db.close(); }
}

export const library = {
  add(item) {
    const rec = { id: crypto.randomUUID(), created: Date.now(), ...item };
    return tx("readwrite", (s) => s.put(rec)).then(() => rec);
  },
  async all() {
    const list = (await tx("readonly", (s) => s.getAll())) || [];
    return list.sort((a, b) => b.created - a.created);
  },
  remove(id) {
    return tx("readwrite", (s) => s.delete(id));
  },
};
