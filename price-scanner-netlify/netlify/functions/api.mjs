// Netlify entry point. The price list is kept in Netlify Blobs.
// Set ADMIN_PASSWORD in Netlify: Site configuration, Environment variables.
import { getStore } from "@netlify/blobs";
import { createApi } from "../../lib/core.mjs";

export const config = { path: "/api/*" };

const s = () => getStore({ name: "prices", consistency: "strong" });
const store = {
  get: (k) => s().get(k, { type: "json" }),
  set: (k, v) => s().setJSON(k, v),
  del: (k) => s().delete(k),
  list: async (prefix) => ((await s().list({ prefix })).blobs || []).map((b) => b.key)
};

export default (req) => createApi({ store, adminPassword: process.env.ADMIN_PASSWORD || "" })(req);
