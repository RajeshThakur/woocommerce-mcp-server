// Connects to the WooCommerce MCP server as an MCP client over stdio.
// This is the same thing Claude Desktop does, done in code.
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "build", "index.js");

// Tools that change store data. These always need explicit approval,
// and are hidden entirely when DEMO_READ_ONLY=true.
const WRITE_TOOLS = new Set(["update_order_status"]);

function isReadOnly() {
  return String(process.env.DEMO_READ_ONLY).toLowerCase() === "true";
}

let clientPromise = null;

function connect() {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Only pass variables that are actually set, so the child falls back to its own .env otherwise.
      const env = {};
      for (const k of ["WC_URL", "WC_CONSUMER_KEY", "WC_CONSUMER_SECRET"]) {
        if (process.env[k]) env[k] = process.env[k];
      }
      const transport = new StdioClientTransport({
        command: process.execPath, // absolute path to the current node binary
        args: [SERVER_PATH],
        cwd: ROOT,
        env,
        stderr: "inherit",
      });
      const client = new Client({ name: "store-assistant", version: "1.0.0" });
      client.onclose = () => {
        clientPromise = null; // reconnect on next use if the server process dies
      };
      await client.connect(transport);
      return client;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function listTools() {
  const client = await connect();
  const { tools } = await client.listTools();
  return tools.filter((t) => !(isReadOnly() && WRITE_TOOLS.has(t.name)));
}

async function callTool(name, args) {
  if (isReadOnly() && WRITE_TOOLS.has(name)) {
    return { text: "Write actions are disabled in this public demo.", isError: true };
  }
  const client = await connect();
  const res = await client.callTool({ name, arguments: args || {} });
  const text = (res.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text, isError: Boolean(res.isError) };
}

async function close() {
  if (clientPromise) {
    const c = await clientPromise.catch(() => null);
    clientPromise = null;
    if (c) await c.close().catch(() => {});
  }
}

module.exports = { listTools, callTool, close, isReadOnly, WRITE_TOOLS };
