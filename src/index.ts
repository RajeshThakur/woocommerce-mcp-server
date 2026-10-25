import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// import fetch from "node-fetch";
import * as dotenv from "dotenv";

dotenv.config({ quiet: true });

// --- WooCommerce API client ---
const WC_URL = (process.env.WC_URL || "").replace(/\/+$/, "");
const WC_KEY = process.env.WC_CONSUMER_KEY!;
const WC_SECRET = process.env.WC_CONSUMER_SECRET!;

if (!WC_URL || !WC_KEY || !WC_SECRET) {
  process.stderr.write("Missing WooCommerce credentials in .env\n");
  process.exit(1);
}

async function wcFetch(
  endpoint: string,
  params: Record<string, string> = {},
  options: { method?: string; body?: unknown } = {}
) {
  const url = new URL(`${WC_URL}/wp-json/wc/v3/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const auth = Buffer.from(`${WC_KEY}:${WC_SECRET}`).toString("base64");
  const headers: Record<string, string> = { Authorization: `Basic ${auth}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      throw new WooError(0, "The store did not respond within 15 seconds. Check that the site is up and try again.");
    }
    // Log the real cause (DNS, TLS, connection reset...) to stderr so it shows up in host logs.
    const cause: any = err?.cause;
    process.stderr.write(
      `[wcFetch] network error calling ${url.origin}: ${err?.message || err}` +
        (cause ? ` | cause: ${cause.code || ""} ${cause.message || cause}` : "") +
        "\n"
    );
    throw new WooError(0, `Could not reach the store at ${WC_URL}. Check the URL and your network connection.`);
  }

  if (!res.ok) {
    const text = await res.text();
    let wooMessage = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) wooMessage = String(parsed.message).replace(/<[^>]*>/g, "");
    } catch {
      // response was not JSON; keep the raw snippet
    }
    throw new WooError(res.status, wooMessage);
  }
  return res.json();
}

class WooError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof WooError) {
    switch (err.status) {
      case 0:
        return err.message;
      case 401:
        return "Authentication failed (401). The WooCommerce API keys are wrong, revoked, or missing. Regenerate them in WooCommerce > Settings > Advanced > REST API and update the MCP config.";
      case 403:
        return "Permission denied (403). The API key may be read-only. Write actions such as updating an order need Read/Write permissions.";
      case 404:
        return `Not found (404): ${err.message}`;
      case 400:
      case 422:
        return `The store rejected the request (${err.status}): ${err.message}`;
      default:
        if (err.status >= 500) {
          return `The store returned a server error (${err.status}). Try again in a moment. Details: ${err.message}`;
        }
        return `WooCommerce error ${err.status}: ${err.message}`;
    }
  }
  return `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
}

// --- MCP Server ---
const server = new McpServer({
  name: "woocommerce-mcp-server",
  version: "1.0.0",
});

// Wraps every tool so failures come back to Claude as a readable message instead of a crash.
function registerTool(
  name: string,
  description: string,
  schema: any,
  handler: (args: any) => Promise<any>
) {
  (server as any).tool(name, description, schema, async (args: any) => {
    try {
      return await handler(args);
    } catch (err) {
      process.stderr.write(`[${name}] ${err instanceof Error ? err.message : String(err)}\n`);
      return { isError: true, content: [{ type: "text", text: friendlyError(err) }] };
    }
  });
}

// Tool 1: Get Products
registerTool(
  "get_products",
  "List or search WooCommerce products by name, category, or status",
  {
    search: z.string().optional().describe("Search term for product name"),
    category: z
      .string()
      .optional()
      .describe("Category name to filter by (e.g. 'Shirt'); matches categories by name"),
    status: z
      .enum(["any", "publish", "draft", "pending"])
      .optional()
      .default("any")
      .describe("Product status filter"),
    per_page: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Number of products to return"),
  },
  async ({ search, category, status, per_page }) => {
    const params: Record<string, string> = {
      per_page: String(per_page),
      status: status || "any",
    };
    if (search) params.search = search;

    if (category) {
      const cats = (await wcFetch("products/categories", {
        search: category,
        per_page: "20",
      })) as any[];
      if (!cats.length) {
        return { content: [{ type: "text", text: `No category matching "${category}" found.` }] };
      }
      // Prefer an exact name match ("Shirts" should not also pull in "Tshirts")
      const exact = cats.filter(
        (c: any) => String(c.name).toLowerCase() === category.toLowerCase()
      );
      params.category = (exact.length ? exact : cats).map((c: any) => c.id).join(",");
    }

    const products = (await wcFetch("products", params)) as any[];

    if (!products.length) {
      return { content: [{ type: "text", text: "No products found." }] };
    }

    const summary = products.map((p: any) =>
      `#${p.id} — ${p.name} | Status: ${p.status} | Price: ${p.price || "N/A"} | Stock: ${p.stock_status}${p.categories?.length ? " | Categories: " + p.categories.map((c: any) => c.name).join(", ") : ""}`
    ).join("\n");

    return {
      content: [{ type: "text", text: `Found ${products.length} product(s):\n\n${summary}` }],
    };
  }
);

// Tool 2: Get Orders
registerTool(
  "get_orders",
  "List WooCommerce orders filtered by status or date range",
  {
    status: z
      .enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"])
      .optional()
      .default("any")
      .describe("Order status filter"),
    per_page: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Number of orders to return"),
    after: z
      .string()
      .optional()
      .describe("Return orders after this date (ISO 8601 format, e.g. 2026-01-01T00:00:00)"),
    customer_id: z
      .number()
      .optional()
      .describe("Only return orders for this customer ID (get it from get_customers)"),
  },
  async ({ status, per_page, after, customer_id }) => {
    const params: Record<string, string> = {
      per_page: String(per_page),
      status: status || "any",
    };
    if (after) params.after = after;
    if (customer_id) params.customer = String(customer_id);

    const orders = (await wcFetch("orders", params)) as any[];

    if (!orders.length) {
      return { content: [{ type: "text", text: "No orders found." }] };
    }

    const summary = orders.map((o: any) =>
      `#${o.id} — ${o.billing?.first_name} ${o.billing?.last_name} | Status: ${o.status} | Total: ${o.currency_symbol || ""}${o.total} | Date: ${o.date_created?.slice(0, 10)}`
    ).join("\n");

    return {
      content: [{ type: "text", text: `Found ${orders.length} order(s):\n\n${summary}` }],
    };
  }
);

// Tool 3: Get Order Details
registerTool(
  "get_order_details",
  "Get full details of a specific WooCommerce order by ID",
  {
    order_id: z.number().describe("The WooCommerce order ID"),
  },
  async ({ order_id }) => {
    const order = (await wcFetch(`orders/${order_id}`)) as any;

    const items = order.line_items
      ?.map((i: any) => `  - ${i.name} × ${i.quantity} @ ${i.price}`)
      .join("\n") || "No items";

    const details = [
      `Order #${order.id}`,
      `Status: ${order.status}`,
      `Date: ${order.date_created?.slice(0, 10)}`,
      `Customer: ${order.billing?.first_name} ${order.billing?.last_name} (${order.billing?.email})`,
      `Total: ${order.currency_symbol || ""}${order.total}`,
      `Payment: ${order.payment_method_title}`,
      `Items:\n${items}`,
      `Shipping: ${order.shipping?.address_1}, ${order.shipping?.city}, ${order.shipping?.country}`,
    ].join("\n");

    return { content: [{ type: "text", text: details }] };
  }
);

// Tool 4: Get Store Stats
registerTool(
  "get_store_stats",
  "Get WooCommerce store sales statistics for a date range",
  {
    period: z
      .enum(["week", "month", "last_month", "year"])
      .optional()
      .default("month")
      .describe("Time period for stats"),
  },
  async ({ period }) => {
    const stats = (await wcFetch("reports/sales", { period: period || "month" })) as any[];

    if (!stats.length) {
      return { content: [{ type: "text", text: "No stats available." }] };
    }

    const s = stats[0];
    const summary = [
      `Store Stats (${period}):`,
      `Total Sales: ${s.total_sales}`,
      `Net Sales: ${s.net_sales}`,
      `Orders: ${s.total_orders}`,
      `Items Sold: ${s.total_items}`,
      `Refunds: ${s.total_refunds}`,
    ].join("\n");

    return { content: [{ type: "text", text: summary }] };
  }
);

// Tool 5: Update Order Status
registerTool(
  "update_order_status",
  "Change the status of a WooCommerce order (e.g. mark as completed or cancelled)",
  {
    order_id: z.number().describe("The WooCommerce order ID"),
    status: z
      .enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"])
      .describe("The new order status"),
  },
  async ({ order_id, status }) => {
    const before = (await wcFetch(`orders/${order_id}`)) as any;
    const updated = (await wcFetch(`orders/${order_id}`, {}, {
      method: "PUT",
      body: { status },
    })) as any;

    return {
      content: [
        {
          type: "text",
          text: `Order #${updated.id} updated: ${before.status} -> ${updated.status}`,
        },
      ],
    };
  }
);

// Tool 6: Get Customers
registerTool(
  "get_customers",
  "List or search WooCommerce customers by name or email",
  {
    search: z.string().optional().describe("Search term (name or email)"),
    per_page: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Number of customers to return"),
  },
  async ({ search, per_page }) => {
    const params: Record<string, string> = { per_page: String(per_page) };
    if (search) params.search = search;

    const customers = (await wcFetch("customers", params)) as any[];

    if (!customers.length) {
      return { content: [{ type: "text", text: "No customers found." }] };
    }

    // The customers endpoint does not return order totals, so look them up per customer.
    const rows = await Promise.all(
      customers.map(async (c: any) => {
        const orders = (await wcFetch("orders", { customer: String(c.id), per_page: "100" })) as any[];
        const paid = orders.filter((o: any) => ["completed", "processing", "on-hold"].includes(o.status));
        const spent = paid.reduce((sum: number, o: any) => sum + parseFloat(o.total || "0"), 0);
        return `#${c.id} — ${c.first_name} ${c.last_name} | ${c.email} | Orders: ${orders.length} | Spent (paid orders): ${spent.toFixed(2)}`;
      })
    );
    const summary = rows.join("\n");

    return {
      content: [{ type: "text", text: `Found ${customers.length} customer(s):\n\n${summary}` }],
    };
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("WooCommerce MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});