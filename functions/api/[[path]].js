// Wine Menu API (Cloudflare Pages Functions + D1)
// Public:  GET /api/public, GET /api/version, GET /api/img/:id
// Admin (header x-admin-key = master password ADMIN_PASSWORD, or a store manager's password):
//   GET /api/admin/me                       -> {role: "master"|"store", storeId?}
//   GET /api/admin/all
//   PUT|DELETE /api/admin/doc/:kind/:id   (kind: stores | items | cats | sheets)
//   POST /api/admin/image  (raw image body)  -> {id, url}
//   DELETE /api/admin/image/:id
//   GET /api/admin/usage
//   Master only: GET /api/admin/storekeys, PUT|DELETE /api/admin/storekey/:storeId  {password}
// Store managers may only change items / sheets that belong to their own store alone.

const KINDS = new Set(["stores", "items", "cats", "sheets"]);
const MAX_IMAGE = 1_500_000; // D1 rows are capped at 2MB; the browser compresses photos well below this
let ready = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, body BLOB NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS store_keys (store_id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL)"),
  ]);
  ready = true;
}

const bump = (db) =>
  db.prepare("INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(Date.now()));

async function version(db) {
  const r = await db.prepare("SELECT v FROM meta WHERE k = 'version'").first();
  return r ? r.v : "0";
}

async function loadAll(db, admin) {
  const { results } = await db.prepare("SELECT kind, id, data FROM docs").all();
  const out = { stores: [], items: [], cats: [], sheets: [] };
  for (const r of results) {
    if (!out[r.kind]) continue;
    const d = { ...JSON.parse(r.data), id: r.id };
    if (!admin && (r.kind === "items" || r.kind === "sheets") && d.active === false) continue;
    out[r.kind].push(d);
  }
  out.version = await version(db);
  return out;
}

// passwords are compared after NFKC (full-width -> half-width) and trimming
const norm = (s) => String(s || "").normalize("NFKC").trim();

async function salt(db) {
  const r = await db.prepare("SELECT v FROM meta WHERE k = 'salt'").first();
  if (r) return r.v;
  const v = crypto.randomUUID() + crypto.randomUUID();
  await db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('salt', ?)").bind(v).run();
  const again = await db.prepare("SELECT v FROM meta WHERE k = 'salt'").first();
  return again.v;
}
async function hashKey(db, pw) {
  const data = new TextEncoder().encode((await salt(db)) + ":" + norm(pw));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function whoIs(db, env, key) {
  key = norm(key);
  if (!key) return null;
  if (safeEqual(key, norm(env.ADMIN_PASSWORD))) return { role: "master" };
  const r = await db.prepare("SELECT store_id FROM store_keys WHERE hash = ?").bind(await hashKey(db, key)).first();
  return r ? { role: "store", storeId: r.store_id } : null;
}
const onlyMine = (doc, storeId) => !!doc && Array.isArray(doc.stores) && doc.stores.length === 1 && doc.stores[0] === storeId;
async function getDoc(db, kind, id) {
  const r = await db.prepare("SELECT data FROM docs WHERE kind = ? AND id = ?").bind(kind, id).first();
  return r ? JSON.parse(r.data) : null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const db = env.DB;
  if (!db) return json({ error: "database_not_bound", message: "Bind a D1 database to this project with the variable name DB." }, 500);
  const parts = Array.isArray(params.path) ? params.path : String(params.path || "").split("/").filter(Boolean);
  const method = request.method;

  try {
    await init(db);

    if (parts[0] === "version" && method === "GET") return json({ version: await version(db) });
    if (parts[0] === "public" && method === "GET") return json(await loadAll(db, false));

    if (parts[0] === "img" && parts[1] && method === "GET") {
      const r = await db.prepare("SELECT mime, body FROM images WHERE id = ?").bind(parts[1]).first();
      if (!r) return new Response("Not found", { status: 404 });
      return new Response(new Uint8Array(r.body), {
        headers: { "content-type": r.mime, "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (parts[0] === "admin") {
      if (!env.ADMIN_PASSWORD) return json({ error: "password_not_set", message: "Set ADMIN_PASSWORD in the project's environment variables." }, 500);
      const who = await whoIs(db, env, request.headers.get("x-admin-key"));
      if (!who) return json({ error: "unauthorized" }, 401);
      const master = who.role === "master";

      if (parts[1] === "me" && method === "GET") return json(who);

      if (parts[1] === "all" && method === "GET") {
        const all = await loadAll(db, true);
        if (!master) {
          all.stores = all.stores.filter((s) => s.id === who.storeId);
          all.items = all.items.filter((d) => (d.stores || []).includes(who.storeId));
          all.sheets = all.sheets.filter((d) => (d.stores || []).includes(who.storeId));
        }
        all.me = who;
        return json(all);
      }

      if (parts[1] === "storekeys" && method === "GET") {
        if (!master) return json({ error: "forbidden" }, 403);
        const { results } = await db.prepare("SELECT store_id, updated_at FROM store_keys").all();
        return json({ keys: results });
      }
      if (parts[1] === "storekey" && parts[2]) {
        if (!master) return json({ error: "forbidden" }, 403);
        const storeId = decodeURIComponent(parts[2]);
        if (method === "DELETE") {
          await db.prepare("DELETE FROM store_keys WHERE store_id = ?").bind(storeId).run();
          return json({ ok: true });
        }
        if (method === "PUT") {
          const { password } = await request.json();
          const pw = norm(password);
          if (pw.length < 6) return json({ error: "too_short" }, 400);
          if (pw === norm(env.ADMIN_PASSWORD)) return json({ error: "same_as_master" }, 400);
          const h = await hashKey(db, pw);
          const clash = await db.prepare("SELECT store_id FROM store_keys WHERE hash = ? AND store_id != ?").bind(h, storeId).first();
          if (clash) return json({ error: "duplicate" }, 409);
          await db.prepare("INSERT INTO store_keys (store_id, hash, updated_at) VALUES (?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at")
            .bind(storeId, h, Date.now()).run();
          return json({ ok: true });
        }
      }

      if (parts[1] === "doc" && KINDS.has(parts[2]) && parts[3]) {
        const kind = parts[2], id = decodeURIComponent(parts[3]);
        if (!master) {
          // store managers: only items / image menus that belong to their own store alone
          if (kind !== "items" && kind !== "sheets") return json({ error: "forbidden" }, 403);
          const existing = await getDoc(db, kind, id);
          if (existing && !onlyMine(existing, who.storeId)) return json({ error: "forbidden" }, 403);
        }
        if (method === "PUT") {
          const body = await request.json();
          if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_body" }, 400);
          delete body.id;
          if (!master) body.stores = [who.storeId];
          const text = JSON.stringify(body);
          if (text.length > 500_000) return json({ error: "too_large" }, 413);
          await db.batch([
            db.prepare("INSERT INTO docs (kind, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
              .bind(kind, id, text, Date.now()),
            bump(db),
          ]);
          return json({ ok: true });
        }
        if (method === "DELETE") {
          await db.batch([db.prepare("DELETE FROM docs WHERE kind = ? AND id = ?").bind(kind, id), bump(db)]);
          return json({ ok: true });
        }
      }

      if (parts[1] === "image" && !parts[2] && method === "POST") {
        const mime = (request.headers.get("content-type") || "").split(";")[0].trim();
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json({ error: "bad_type" }, 400);
        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0) return json({ error: "empty" }, 400);
        if (buf.byteLength > MAX_IMAGE) return json({ error: "too_large" }, 413);
        const id = crypto.randomUUID().replace(/-/g, "");
        await db.prepare("INSERT INTO images (id, mime, body, created_at) VALUES (?, ?, ?, ?)").bind(id, mime, buf, Date.now()).run();
        return json({ id, url: "/api/img/" + id });
      }
      if (parts[1] === "image" && parts[2] && method === "DELETE") {
        if (!master) return json({ ok: true }); // store managers never delete shared image files
        await db.prepare("DELETE FROM images WHERE id = ?").bind(parts[2]).run();
        return json({ ok: true });
      }
      if (parts[1] === "usage" && method === "GET") {
        const r = await db.prepare("SELECT COUNT(*) AS images, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM images").first();
        return json(r);
      }
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    return json({ error: "server_error", message: String((e && e.message) || e) }, 500);
  }
}
