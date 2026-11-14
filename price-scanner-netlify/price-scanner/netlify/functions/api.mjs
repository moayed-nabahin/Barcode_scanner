// Price Scanner API for Netlify. The price list lives in Netlify Blobs, so every visitor sees the same data.
// Set ADMIN_PASSWORD in Netlify: Site configuration, Environment variables.
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const KEY = "products";
const MAX_ITEMS = 200000;

function store() { return getStore({ name: "prices", consistency: "strong" }); }

async function loadData() {
  const d = await store().get(KEY, { type: "json" });
  return d && d.products ? d : { products: {}, updatedAt: null };
}
async function saveData(products) {
  const data = { products, updatedAt: new Date().toISOString() };
  await store().setJSON(KEY, data);
  return data;
}
function stripZeros(s) { return s.replace(/^0+/, ""); }
function find(products, code) {
  const d = String(code).replace(/\D+/g, "");
  if (!d) return null;
  if (products[d]) return d;
  const z = stripZeros(d);
  for (const k of Object.keys(products)) if (stripZeros(k) === z) return k;
  return null;
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
  if (code.length < 4 || code.length > 20 || !isFinite(price) || price < 0 || price > 1e7) return null;
  return { code, name, price };
}
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b)))
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Best effort only: each server instance counts its own wrong passwords. Use a long password.
const fails = new Map();
async function checkAdmin(req) {
  const pw = process.env.ADMIN_PASSWORD || "";
  if (!pw) return json({ error: "Admin is disabled: set ADMIN_PASSWORD in the Netlify environment variables." }, 503);
  const ip = (req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "?").split(",")[0].trim();
  const f = fails.get(ip);
  if (f && f.n >= 8 && Date.now() < f.until) return json({ error: "Too many wrong passwords. Try again in 10 minutes." }, 429);
  if (await sameSecret(req.headers.get("x-admin-password") || "", pw)) { fails.delete(ip); return null; }
  const n = (f && Date.now() < f.until ? f.n : 0) + 1;
  fails.set(ip, { n, until: Date.now() + 10 * 60 * 1000 });
  return json({ error: "Wrong password." }, 401);
}
async function body(req) {
  const text = await req.text();
  if (text.length > 8 * 1024 * 1024) { const e = new Error("File too large"); e.status = 413; throw e; }
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { const x = new Error("Invalid JSON"); x.status = 400; throw x; }
}

export default async (req) => {
  try {
    const p = new URL(req.url).pathname.replace(/\/+$/, "");
    const m = req.method;

    if (m === "GET" && p === "/api/health") return json({ ok: true });

    // Customers
    if (m === "GET" && p === "/api/info") {
      const d = await loadData();
      return json({ count: Object.keys(d.products).length, updatedAt: d.updatedAt });
    }
    if (m === "GET" && p.startsWith("/api/product/")) {
      const d = await loadData();
      const k = find(d.products, decodeURIComponent(p.slice("/api/product/".length)));
      if (!k) return json({ found: false }, 404);
      return json({ found: true, code: k, name: d.products[k].name, price: d.products[k].price });
    }

    // Admin
    if (p.startsWith("/api/admin/")) {
      const denied = await checkAdmin(req);
      if (denied) return denied;

      if (m === "POST" && p === "/api/admin/login") return json({ ok: true });

      if (m === "GET" && p === "/api/admin/products") return json(await loadData());

      if (m === "POST" && p === "/api/admin/product") {
        const it = cleanItem(await body(req));
        if (!it || !it.name) return json({ error: "Enter a barcode, a name and a price." }, 400);
        const d = await loadData();
        const k = find(d.products, it.code) || it.code;
        d.products[k] = { name: it.name, price: it.price };
        await saveData(d.products);
        return json({ code: k, name: it.name, price: it.price });
      }

      if (m === "DELETE" && p.startsWith("/api/admin/product/")) {
        const d = await loadData();
        const k = find(d.products, decodeURIComponent(p.slice("/api/admin/product/".length)));
        if (!k) return json({ error: "Not found." }, 404);
        delete d.products[k];
        await saveData(d.products);
        return json({ ok: true });
      }

      if (m === "POST" && p === "/api/admin/products") {
        const b = await body(req);
        const mode = b.mode === "replace" ? "replace" : "merge";
        if (!Array.isArray(b.items)) return json({ error: "No items." }, 400);
        if (b.items.length > MAX_ITEMS) return json({ error: "Too many rows." }, 400);
        const items = b.items.map(cleanItem).filter(Boolean);
        if (!items.length) return json({ error: "No valid rows." }, 400);
        const d = await loadData();
        const old = d.products;
        const next = mode === "replace" ? {} : Object.assign({}, old);
        const lookup = {};
        for (const k of Object.keys(next)) lookup[stripZeros(k)] = k;
        const oldLookup = {};
        for (const k of Object.keys(old)) oldLookup[stripZeros(k)] = k;
        let added = 0, changed = 0;
        for (const it of items) {
          const z = stripZeros(it.code);
          const k = lookup[z] || it.code;
          const prev = old[oldLookup[z] || ""] || null;
          if (!prev) added++; else if (prev.price !== it.price) changed++;
          next[k] = { name: it.name || (prev && prev.name) || it.code, price: it.price };
          lookup[z] = k;
        }
        const keep = new Set(Object.keys(next).map(stripZeros));
        const removed = mode === "replace" ? Object.keys(old).filter(k => !keep.has(stripZeros(k))).length : 0;
        await saveData(next);
        return json({ ok: true, total: Object.keys(next).length, added, changed, removed });
      }
    }
    return json({ error: "Not found." }, 404);
  } catch (e) {
    if (e && e.status) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Server error." }, 500);
  }
};
