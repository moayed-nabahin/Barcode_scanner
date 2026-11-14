"use strict";
/*
 * Run the same service on your own computer or on a Node host. No packages needed (Node 18+).
 *   ADMIN_PASSWORD  required     PORT  default 3000     DATA_DIR  default ./data
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const INDEX = path.join(__dirname, "public", "index.html");

const file = (k) => path.join(DATA_DIR, ...k.split("/").map(encodeURIComponent)) + ".json";
const store = {
  async get(k) { try { return JSON.parse(await fs.promises.readFile(file(k), "utf8")); } catch (e) { return null; } },
  async set(k, v) {
    const f = file(k);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const t = f + "." + process.pid + ".tmp";
    await fs.promises.writeFile(t, JSON.stringify(v));
    await fs.promises.rename(t, f);
  },
  async del(k) { try { await fs.promises.unlink(file(k)); } catch (e) {} },
  async list(prefix) {
    const dir = path.dirname(file(prefix + "x"));
    try { return (await fs.promises.readdir(dir)).filter((n) => n.endsWith(".json")).map((n) => prefix + decodeURIComponent(n.slice(0, -5))); }
    catch (e) { return []; }
  }
};

(async () => {
  const { createApi } = await import("./lib/core.mjs");
  const api = createApi({ store, adminPassword: process.env.ADMIN_PASSWORD || "" });
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(fs.readFileSync(INDEX));
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const hasBody = !["GET", "HEAD"].includes(req.method);
      const r = await api(new Request("http://localhost:" + PORT + req.url, {
        method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined
      }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { console.error(e); res.writeHead(500); res.end("Server error"); }
  }).listen(PORT, () => {
    console.log("Price Scanner on port " + PORT + ", data in " + DATA_DIR);
    if (!process.env.ADMIN_PASSWORD) console.warn("WARNING: ADMIN_PASSWORD is not set, so admin features are disabled.");
  });
})();
