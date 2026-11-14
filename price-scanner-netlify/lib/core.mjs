// Price Scanner API. Storage-agnostic: it works with Netlify Blobs or with plain files (see server.js).
//
// Layout in the store:
//   meta            { gen, total, updatedAt }       which generation of data is live
//   <gen>/<0..255>  { <code without leading zeros>: { c: code, n: name, p: price } }
// A lookup reads meta plus ONE small shard, so it stays fast with 100,000+ products.
// "Replace the whole list" writes a new generation and switches to it when done.

const SHARDS = 256;
const MAX_CHUNK = 20000;

export function createApi({ store, adminPassword }) {
  const stripZeros = (s) => s.replace(/^0+/, "");
  function shardOf(z) {
    let h = 2166136261;
    for (let i = 0; i < z.length; i++) { h ^= z.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h % SHARDS;
  }
  const getMeta = async () => (await store.get("meta")) || { gen: "g0", total: 0, updatedAt: null };
  const readShard = async (gen, i) => (await store.get(gen + "/" + i)) || {};

  async function pool(n, arr, fn) {
    let i = 0;
    const out = [];
    await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
      while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
    }));
    return out;
  }

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
    });
  }
  function cleanItem(it) {
    if (!it || typeof it !== "object") return null;
    const code = String(it.code == null ? "" : it.code).replace(/\D+/g, "");
    const price = Math.round(Number(it.price) * 100) / 100;
    const name = String(it.name == null ? "" : it.name).trim().slice(0, 200);
    const z = stripZeros(code);
    if (code.length < 4 || code.length > 20 || z.length < 3 || !isFinite(price) || price < 0 || price > 1e7) return null;
    return { code, z, name, price };
  }
  async function sameSecret(a, b) {
    const enc = new TextEncoder();
    const [ha, hb] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(String(a))),
      crypto.subtle.digest("SHA-256", enc.encode(String(b)))
    ]);
    const x = new Uint8Array(ha), y = new Uint8Array(hb);
    let d = 0;
    for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
    return d === 0;
  }
  // Best effort: counts wrong passwords per server instance. Use a long password.
  const fails = new Map();
  async function checkAdmin(req) {
    if (!adminPassword) return json({ error: "Admin is disabled: set ADMIN_PASSWORD on the server." }, 503);
    const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
    const f = fails.get(ip);
    if (f && f.n >= 8 && Date.now() < f.until) return json({ error: "Too many wrong passwords. Try again in 10 minutes." }, 429);
    if (await sameSecret(req.headers.get("x-admin-password") || "", adminPassword)) { fails.delete(ip); return null; }
    fails.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
    return json({ error: "Wrong password." }, 401);
  }
  async function body(req) {
    const text = await req.text();
    if (text.length > 5 * 1024 * 1024) { const e = new Error("Request too large"); e.status = 413; throw e; }
    if (!text) return {};
    try { return JSON.parse(text); } catch (e) { const x = new Error("Invalid JSON"); x.status = 400; throw x; }
  }

  return async function handle(req) {
    try {
      const p = new URL(req.url).pathname.replace(/\/+$/, "");
      const q = new URL(req.url).searchParams;
      const m = req.method;

      if (m === "GET" && p === "/api/health") return json({ ok: true });

      // ---- customers ----
      if (m === "GET" && p === "/api/info") {
        const meta = await getMeta();
        return json({ count: meta.total, updatedAt: meta.updatedAt });
      }
      if (m === "GET" && p.startsWith("/api/product/")) {
        const d = String(decodeURIComponent(p.slice("/api/product/".length))).replace(/\D+/g, "");
        const z = stripZeros(d);
        if (z.length < 3) return json({ found: false }, 404);
        const meta = await getMeta();
        const hit = (await readShard(meta.gen, shardOf(z)))[z];
        if (!hit) return json({ found: false }, 404);
        return json({ found: true, code: hit.c, name: hit.n, price: hit.p });
      }

      // ---- admin ----
      if (p.startsWith("/api/admin/")) {
        const denied = await checkAdmin(req);
        if (denied) return denied;

        if (m === "POST" && p === "/api/admin/login") return json({ ok: true });

        // one product
        if (m === "POST" && p === "/api/admin/product") {
          const it = cleanItem(await body(req));
          if (!it || !it.name) return json({ error: "Enter a barcode, a name and a price." }, 400);
          const meta = await getMeta();
          const i = shardOf(it.z), sh = await readShard(meta.gen, i);
          const existed = !!sh[it.z];
          sh[it.z] = { c: existed ? sh[it.z].c : it.code, n: it.name, p: it.price };
          await store.set(meta.gen + "/" + i, sh);
          await store.set("meta", { gen: meta.gen, total: meta.total + (existed ? 0 : 1), updatedAt: new Date().toISOString() });
          return json({ code: sh[it.z].c, name: it.name, price: it.price });
        }
        if (m === "DELETE" && p.startsWith("/api/admin/product/")) {
          const z = stripZeros(String(decodeURIComponent(p.slice("/api/admin/product/".length))).replace(/\D+/g, ""));
          const meta = await getMeta();
          const i = shardOf(z), sh = await readShard(meta.gen, i);
          if (!sh[z]) return json({ error: "Not found." }, 404);
          delete sh[z];
          await store.set(meta.gen + "/" + i, sh);
          await store.set("meta", { gen: meta.gen, total: Math.max(0, meta.total - 1), updatedAt: new Date().toISOString() });
          return json({ ok: true });
        }

        // big upload, in batches: start, chunk (many times), finish
        if (m === "POST" && p === "/api/admin/import/start") {
          const b = await body(req);
          const meta = await getMeta();
          const gen = b.mode === "replace" ? "g" + Date.now() : meta.gen;
          return json({ gen, total: meta.total });
        }
        if (m === "POST" && p === "/api/admin/import/chunk") {
          const b = await body(req);
          const dry = !!b.dry;
          if (!Array.isArray(b.items)) return json({ error: "No items." }, 400);
          if (b.items.length > MAX_CHUNK) return json({ error: "Batch too large." }, 400);
          const meta = await getMeta();
          const gen = dry ? meta.gen : String(b.gen || "");
          if (!/^g\d+$/.test(gen)) return json({ error: "Bad upload id." }, 400);
          if (!dry && b.mode !== "replace" && gen !== meta.gen) return json({ error: "The list changed during the upload. Start again." }, 409);
          if (!dry && b.mode === "replace" && gen === meta.gen) return json({ error: "Bad upload id." }, 400);

          const groups = new Map();
          for (const raw of b.items) {
            const it = cleanItem(raw);
            if (!it) continue;
            const i = shardOf(it.z);
            if (!groups.has(i)) groups.set(i, []);
            groups.get(i).push(it);
          }
          const st = { added: 0, changed: 0, same: 0, existing: 0, created: 0, samples: [] };
          await pool(24, [...groups.keys()], async (i) => {
            const live = await readShard(meta.gen, i);
            const same = gen === meta.gen;
            const tgt = same ? live : (dry ? {} : await readShard(gen, i));
            for (const it of groups.get(i)) {
              const prev = live[it.z];
              if (!prev) st.added++;
              else {
                st.existing++;
                if (prev.p !== it.price) {
                  st.changed++;
                  if (st.samples.length < 5) st.samples.push({ name: it.name || prev.n, from: prev.p, to: it.price });
                } else st.same++;
              }
              if (!dry) {
                if (!tgt[it.z]) st.created++;
                tgt[it.z] = { c: (tgt[it.z] && tgt[it.z].c) || (prev && prev.c) || it.code, n: it.name || (prev && prev.n) || it.code, p: it.price };
              }
            }
            if (!dry) await store.set(gen + "/" + i, tgt);
          });
          return json(st);
        }
        if (m === "POST" && p === "/api/admin/import/finish") {
          const b = await body(req);
          const gen = String(b.gen || "");
          const created = Math.max(0, Math.floor(Number(b.created) || 0));
          if (!/^g\d+$/.test(gen)) return json({ error: "Bad upload id." }, 400);
          const meta = await getMeta();
          if (b.mode === "replace") {
            if (gen === meta.gen) return json({ error: "Bad upload id." }, 400);
            await store.set("meta", { gen, total: created, updatedAt: new Date().toISOString() });
            const old = await store.list(meta.gen + "/");
            await pool(16, old, (k) => store.del(k));
            return json({ ok: true, total: created });
          }
          if (gen !== meta.gen) return json({ error: "The list changed during the upload. Start again." }, 409);
          const total = meta.total + created;
          await store.set("meta", { gen, total, updatedAt: new Date().toISOString() });
          return json({ ok: true, total });
        }

        // download the whole list in slices
        if (m === "GET" && p === "/api/admin/export") {
          const from = Math.max(0, parseInt(q.get("from"), 10) || 0);
          const to = Math.min(SHARDS, parseInt(q.get("to"), 10) || SHARDS);
          const meta = await getMeta();
          const idx = []; for (let i = from; i < to; i++) idx.push(i);
          const out = [];
          await pool(16, idx, async (i) => {
            const sh = await readShard(meta.gen, i);
            for (const z of Object.keys(sh)) out.push({ code: sh[z].c, name: sh[z].n, price: sh[z].p });
          });
          return json({ items: out, shards: SHARDS, total: meta.total });
        }
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      if (e && e.status) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Server error." }, 500);
    }
  };
}
