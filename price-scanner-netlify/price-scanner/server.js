"use strict";
/*
 * Price Scanner server. No npm packages needed (Node 18 or newer).
 *
 *   ADMIN_PASSWORD   required. The password admins type on the page.
 *   PORT             optional, default 3000.
 *   DATA_DIR         optional, default ./data. Put this on a persistent disk when hosting.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DATA_FILE = path.join(DATA_DIR, "products.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const INDEX = path.join(__dirname, "public", "index.html");
const MAX_BODY = 8 * 1024 * 1024;
const MAX_ITEMS = 200000;

/* ---------- storage ---------- */
let products = {};   // code -> { name, price }
let byStripped = {}; // code without leading zeros -> code
let updatedAt = null;

function reindex() {
  byStripped = {};
  for (const k of Object.keys(products)) byStripped[k.replace(/^0+/, "")] = k;
}
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    products = j.products || {};
    updatedAt = j.updatedAt || null;
  } catch (e) {
    products = {};
  }
  reindex();
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  updatedAt = new Date().toISOString();
  const tmp = DATA_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ updatedAt, products }));
  fs.renameSync(tmp, DATA_FILE); // atomic, so a crash never leaves half a file
  reindex();
}
function find(code) {
  const d = String(code).replace(/\D+/g, "");
  if (!d) return null;
  if (products[d]) return d;
  return byStripped[d.replace(/^0+/, "")] || null;
}

/* ---------- helpers ---------- */
function send(res, status, body, headers) {
  const isStr = typeof body === "string" || Buffer.isBuffer(body);
  res.writeHead(status, Object.assign({
    "Content-Type": isStr ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  }, headers || {}));
  res.end(isStr ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("File too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const fails = new Map(); // ip -> { n, until }
function ipOf(req) {
  const x = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return x || req.socket.remoteAddress || "?";
}
function checkAdmin(req, res) {
  if (!ADMIN_PASSWORD) { send(res, 503, { error: "Admin is disabled: set ADMIN_PASSWORD on the server." }); return false; }
  const ip = ipOf(req), f = fails.get(ip);
  if (f && f.n >= 8 && Date.now() < f.until) { send(res, 429, { error: "Too many wrong passwords. Try again in 10 minutes." }); return false; }
  if (sameSecret(req.headers["x-admin-password"] || "", ADMIN_PASSWORD)) { fails.delete(ip); return true; }
  const n = (f && Date.now() < f.until ? f.n : 0) + 1;
  fails.set(ip, { n, until: Date.now() + 10 * 60 * 1000 });
  send(res, 401, { error: "Wrong password." });
  return false;
}
function cleanItem(it) {
  if (!it || typeof it !== "object") return null;
  const code = String(it.code == null ? "" : it.code).replace(/\D+/g, "");
  const price = Math.round(Number(it.price) * 100) / 100;
  const name = String(it.name == null ? "" : it.name).trim().slice(0, 200);
  if (code.length < 4 || code.length > 20 || !isFinite(price) || price < 0 || price > 1e7) return null;
  return { code, name, price };
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && (p === "/" || p === "/index.html")) {
    return send(res, 200, fs.readFileSync(INDEX), { "Cache-Control": "no-cache" });
  }
  if (m === "GET" && p === "/api/health") return send(res, 200, { ok: true });

  // Customers
  if (m === "GET" && p === "/api/info") {
    return send(res, 200, { count: Object.keys(products).length, updatedAt });
  }
  if (m === "GET" && p.startsWith("/api/product/")) {
    const k = find(decodeURIComponent(p.slice("/api/product/".length)));
    if (!k) return send(res, 404, { found: false });
    return send(res, 200, { found: true, code: k, name: products[k].name, price: products[k].price });
  }

  // Admin
  if (p.startsWith("/api/admin/")) {
    if (!checkAdmin(req, res)) return;

    if (m === "POST" && p === "/api/admin/login") return send(res, 200, { ok: true });

    if (m === "GET" && p === "/api/admin/products") {
      return send(res, 200, { products, updatedAt });
    }

    if (m === "POST" && p === "/api/admin/product") {
      const it = cleanItem(await readJson(req));
      if (!it || !it.name) return send(res, 400, { error: "Enter a barcode, a name and a price." });
      const k = find(it.code) || it.code;
      products[k] = { name: it.name, price: it.price };
      save();
      return send(res, 200, { code: k, name: it.name, price: it.price });
    }

    if (m === "DELETE" && p.startsWith("/api/admin/product/")) {
      const k = find(decodeURIComponent(p.slice("/api/admin/product/".length)));
      if (!k) return send(res, 404, { error: "Not found." });
      delete products[k]; save();
      return send(res, 200, { ok: true });
    }

    if (m === "POST" && p === "/api/admin/products") {
      const body = await readJson(req);
      const mode = body.mode === "replace" ? "replace" : "merge";
      const raw = Array.isArray(body.items) ? body.items : null;
      if (!raw) return send(res, 400, { error: "No items." });
      if (raw.length > MAX_ITEMS) return send(res, 400, { error: "Too many rows." });
      const items = raw.map(cleanItem).filter(Boolean);
      if (!items.length) return send(res, 400, { error: "No valid rows." });
      const next = mode === "replace" ? {} : Object.assign({}, products);
      const lookup = {};
      for (const k of Object.keys(next)) lookup[k.replace(/^0+/, "")] = k;
      let added = 0, changed = 0;
      for (const it of items) {
        const k = lookup[it.code.replace(/^0+/, "")] || it.code;
        const old = products[k] || products[find(it.code) || ""] || null;
        if (!old) added++; else if (old.price !== it.price) changed++;
        next[k] = { name: it.name || (old && old.name) || it.code, price: it.price };
        lookup[it.code.replace(/^0+/, "")] = k;
      }
      const removed = mode === "replace" ? Object.keys(products).filter(k => !next[k]).length : 0;
      products = next; save();
      return send(res, 200, { ok: true, total: Object.keys(products).length, added, changed, removed });
    }
  }

  send(res, 404, { error: "Not found." });
}

load();
http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Server error." });
    if (!e.status) console.error(e);
  });
}).listen(PORT, () => {
  console.log("Price Scanner running on port " + PORT + ", data in " + DATA_DIR);
  if (!ADMIN_PASSWORD) console.warn("WARNING: ADMIN_PASSWORD is not set, so admin features are disabled.");
});
