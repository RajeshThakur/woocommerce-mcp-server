#!/usr/bin/env node
/**
 * Seed (or clean) demo data in the WooCommerce TEST store.
 *
 *   npm run seed            -> dry run, shows what would be created
 *   npm run seed -- --yes   -> creates 3 customers and 8 orders (all dated today; the API cannot backdate orders)
 *   npm run seed:clean -- --yes -> deletes everything this script created
 *
 * Everything it creates is tagged (customer emails end in @seed.example.com,
 * orders carry the meta key _mcp_seed) so cleanup never touches real data.
 * Reads WC_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET from .env.
 * Never point this at a live production store.
 */
require("dotenv").config({ quiet: true });

const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const KEY = process.env.WC_CONSUMER_KEY;
const SECRET = process.env.WC_CONSUMER_SECRET;
const args = process.argv.slice(2);
const CONFIRM = args.includes("--yes");
const CLEAN = args.includes("--clean");

if (!WC_URL || !KEY || !SECRET) {
  console.error("Missing WC_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET in .env");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");

async function wc(method, endpoint, { params = {}, body } = {}) {
  const url = new URL(`${WC_URL}/wp-json/wc/v3/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const CUSTOMERS = [
  { first_name: "Aarav", last_name: "Mehta", email: "aarav.mehta@seed.example.com", city: "Mumbai", country: "IN" },
  { first_name: "Sophie", last_name: "Carter", email: "sophie.carter@seed.example.com", city: "Austin", country: "US" },
  { first_name: "Liam", last_name: "Novak", email: "liam.novak@seed.example.com", city: "Berlin", country: "DE" },
];

// [customerIndex, (unused, kept for readability), status, [[productIndex, qty], ...]]
// Note: the WooCommerce REST API ignores date_created on orders, so every seeded order is dated 'now'.
const ORDERS = [
  [0, 28, "completed", [[0, 1], [1, 2]]],
  [1, 24, "completed", [[2, 1]]],
  [2, 21, "completed", [[1, 1], [3, 1]]],
  [0, 17, "completed", [[4, 3]]],
  [1, 13, "processing", [[0, 2], [2, 1]]],
  [2, 9, "cancelled", [[3, 2]]],
  [0, 5, "processing", [[1, 1]]],
  [1, 2, "pending", [[2, 1], [4, 1]]],
];

async function clean() {
  const orders = await wc("GET", "orders", { params: { per_page: "100", status: "any" } });
  const seeded = orders.filter((o) => (o.meta_data || []).some((m) => m.key === "_mcp_seed"));
  const customers = await wc("GET", "customers", { params: { per_page: "100", search: "seed.example.com" } });
  const seededCustomers = customers.filter((c) => String(c.email).endsWith("@seed.example.com"));
  console.log(`Found ${seeded.length} seeded order(s) and ${seededCustomers.length} seeded customer(s).`);
  if (!CONFIRM) return console.log("Dry run. Re-run with --yes to delete them.");
  for (const o of seeded) {
    await wc("DELETE", `orders/${o.id}`, { params: { force: "true" } });
    console.log(`  deleted order #${o.id}`);
  }
  for (const c of seededCustomers) {
    await wc("DELETE", `customers/${c.id}`, { params: { force: "true" } });
    console.log(`  deleted customer #${c.id} ${c.email}`);
  }
}

async function seed() {
  const products = (await wc("GET", "products", { params: { per_page: "20", status: "publish" } }))
    .filter((p) => p.price);
  if (products.length < 5) throw new Error("Need at least 5 published products with prices in the store.");

  console.log(`Store: ${WC_URL}`);
  console.log(`Plan: ${CUSTOMERS.length} customers, ${ORDERS.length} orders using products: ` +
    products.slice(0, 5).map((p) => `#${p.id} ${p.name}`).join(", "));
  if (!CONFIRM) return console.log("Dry run. Re-run with --yes to create them.");

  const existing = await wc("GET", "customers", { params: { per_page: "100", search: "seed.example.com" } });
  const customerIds = [];
  for (const c of CUSTOMERS) {
    const found = existing.find((e) => e.email === c.email);
    if (found) {
      customerIds.push(found.id);
      console.log(`  customer exists #${found.id} ${c.email}`);
      continue;
    }
    const created = await wc("POST", "customers", {
      body: {
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
        username: c.email.split("@")[0].replace(/\./g, "_"),
        billing: { first_name: c.first_name, last_name: c.last_name, email: c.email, city: c.city, country: c.country },
        shipping: { first_name: c.first_name, last_name: c.last_name, city: c.city, country: c.country },
      },
    });
    customerIds.push(created.id);
    console.log(`  created customer #${created.id} ${c.email}`);
  }

  for (const [ci, daysAgo, status, items] of ORDERS) {
    const c = CUSTOMERS[ci];
    const paid = status === "completed" || status === "processing";
    const order = await wc("POST", "orders", {
      body: {
        status,
        customer_id: customerIds[ci],
        set_paid: paid,
        payment_method: "bacs",
        payment_method_title: "Direct bank transfer",
        billing: { first_name: c.first_name, last_name: c.last_name, email: c.email, city: c.city, country: c.country },
        shipping: { first_name: c.first_name, last_name: c.last_name, city: c.city, country: c.country, address_1: "1 Demo Street" },
        line_items: items.map(([pi, qty]) => ({ product_id: products[pi].id, quantity: qty })),
        meta_data: [{ key: "_mcp_seed", value: "1" }],
      },
    });
    console.log(`  created order #${order.id} ${status} ${order.currency_symbol || ""}${order.total}`);
  }
  console.log("Done. Remove it all later with: npm run seed:clean -- --yes");
}

(CLEAN ? clean() : seed()).catch((e) => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
