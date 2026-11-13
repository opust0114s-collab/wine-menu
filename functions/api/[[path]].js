// Wine Menu API (Cloudflare Pages Functions + D1)
// Public:  GET /api/public, GET /api/version, GET /api/img/:id
// Admin (header x-admin-key = ADMIN_PASSWORD):
//   GET /api/admin/all
//   PUT|DELETE /api/admin/doc/:kind/:id   (kind: stores | items | cats | sheets)
//   POST /api/admin/image  (raw image body)  -> {id, url}
//   DELETE /api/admin/image/:id
//   GET /api/admin/usage

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
      if (!safeEqual(request.headers.get("x-admin-key") || "", env.ADMIN_PASSWORD)) return json({ error: "unauthorized" }, 401);

      if (parts[1] === "all" && method === "GET") return json(await loadAll(db, true));

      if (parts[1] === "doc" && KINDS.has(parts[2]) && parts[3]) {
        const kind = parts[2], id = decodeURIComponent(parts[3]);
        if (method === "PUT") {
          const body = await request.json();
          if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_body" }, 400);
          delete body.id;
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
