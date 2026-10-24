# WooCommerce MCP Server

An MCP (Model Context Protocol) server that exposes a WooCommerce store to AI agents. An agent can read products, orders, customers and sales stats, and perform one controlled write action (changing an order's status), all through typed tool definitions over stdio.

Built with TypeScript and the official MCP SDK. It runs locally as a child process of any MCP-compatible client such as Claude Desktop.

## Tools

| Tool | Type | Description |
| --- | --- | --- |
| `get_products` | read | List or search products by name, category (e.g. "Shirts") or status |
| `get_orders` | read | List orders filtered by status or date |
| `get_order_details` | read | Full detail on a single order by ID |
| `get_store_stats` | read | Sales stats for a period (week, month, last month, year) |
| `get_customers` | read | Search customers by name or email, with order count and amount spent |
| `update_order_status` | write | Change an order's status (e.g. processing to completed) |

`update_order_status` changes store data. MCP clients ask the user to approve a tool call before it runs, which keeps a human in the loop for write actions.

## Setup

**Requirements:** Node.js 18+ (uses the built-in `fetch`) and a WooCommerce store with the REST API enabled.

1. Clone and install:

   ```bash
   git clone https://github.com/RajeshThakur/woocommerce-mcp-server.git
   cd woocommerce-mcp-server
   npm install
   ```

2. Create REST API keys in WooCommerce: **Settings → Advanced → REST API → Add key**. Use **Read/Write** permissions (Read is enough if you do not need `update_order_status`).

3. Create a `.env` file from the example and fill in your values:

   ```bash
   cp .env.example .env
   ```

   ```
   WC_URL=https://your-store.com
   WC_CONSUMER_KEY=ck_xxxxxxxx
   WC_CONSUMER_SECRET=cs_xxxxxxxx
   ```

4. Build:

   ```bash
   npm run build
   ```

## Connect to Claude Desktop

Add the server to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/woocommerce-mcp-server/build/index.js"],
      "env": {
        "WC_URL": "https://your-store.com",
        "WC_CONSUMER_KEY": "ck_xxxxxxxx",
        "WC_CONSUMER_SECRET": "cs_xxxxxxxx"
      }
    }
  }
}
```

Then fully quit (Cmd+Q) and reopen Claude Desktop. Try prompts such as:

- "Show my last 5 orders"
- "Get products in the Shirts category"
- "How are sales this month?"
- "Show my customers"
- "Mark order #94 as processing"

### Note on `command`

Claude Desktop starts MCP servers with a stripped environment that does not load your shell PATH. If you use nvm or any non-default Node install, a bare `"command": "node"` fails to start. Use the absolute path to your Node binary (`which node`).

Claude Desktop uses the `env` values in its own config, not your project's `.env`. If you rotate your API keys, update both.

## Demo data

The repo includes a seeder for populating a **test** store with realistic data, which is handy for trying the tools and recording demos.

```bash
npm run seed                    # dry run: shows what would be created
npm run seed -- --yes           # creates 3 customers and 8 orders
npm run seed:clean -- --yes     # deletes only what the seeder created
```

Seeded customers use `@seed.example.com` emails and seeded orders carry a `_mcp_seed` meta key, so cleanup never touches real data. The WooCommerce REST API ignores a backdated creation date on orders, so every seeded order is dated the day you run it. Never point the seeder at a live production store.

## Testing with MCP Inspector

To call the tools directly without a client:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

This opens a browser UI where each tool can be called and the raw JSON-RPC traffic inspected.

## Implementation notes

- **stdio transport.** The protocol uses stdout for JSON-RPC frames, so nothing else may write to stdout. All logging goes to stderr. An early bug came from `dotenv` v17+ printing a startup banner to stdout, which corrupted the first message. It is fixed by initialising dotenv with `{ quiet: true }`.
- **Error handling.** Every tool runs through one wrapper that turns failures into a readable tool error instead of crashing the server:

  | Situation | Message the agent sees |
  | --- | --- |
  | Wrong or revoked API keys (401) | Authentication failed, with where to regenerate the keys |
  | Read-only key used for a write (403) | Permission denied, notes that write actions need Read/Write keys |
  | Unknown order or resource (404) | Not found, with the store's own message |
  | Store down or slow | Could not reach the store, or no response within 15 seconds |
  | Store error (5xx) | Server error, try again, with details |

- **Auth.** Keys are sent as an HTTP Basic `Authorization` header (not in the URL), so use HTTPS.
- **Customer totals.** WooCommerce's customers endpoint does not return order counts or totals, so `get_customers` looks them up per customer. "Spent" counts completed, processing and on-hold orders.

## Security

Credentials live only in `.env` (gitignored) or the client's `env` config, never in the repo. Create keys with the minimum permissions you need, and revoke any key that gets exposed.

## License

MIT
