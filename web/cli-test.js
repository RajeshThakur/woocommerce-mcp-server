// Terminal test for the agent loop (no web server needed).
//   node web/cli-test.js "Which shirts do we have?"            one question
//   node web/cli-test.js --approve "Mark order 94 as completed"  auto-approve writes
//   node web/cli-test.js                                        interactive chat
require("dotenv").config({ quiet: true });
const readline = require("node:readline/promises");
const { createSession, chat, resolveApproval, MODEL } = require("./agent");
const { close } = require("./mcp-client");

const args = process.argv.slice(2);
const autoApprove = args.includes("--approve");
const question = args.filter((a) => !a.startsWith("--")).join(" ");

function show(r) {
  for (const t of r.trace) {
    const tag = t.declined ? "declined" : t.blocked ? "blocked" : t.ok ? "ok" : "error";
    console.log(`  [tool] ${t.tool} ${JSON.stringify(t.args)} -> ${tag}`);
  }
}

async function ask(session, text, rl) {
  let r = await chat(session, text);
  show(r);
  while (r.status === "approval_required") {
    console.log(`  [approval needed] ${r.pending.summary}`);
    let yes = autoApprove;
    if (!autoApprove && rl) yes = (await rl.question("  approve? (y/n) ")).trim().toLowerCase() === "y";
    if (!autoApprove && !rl) console.log("  (non-interactive: declining)");
    r = await resolveApproval(session, yes);
    show(r);
  }
  console.log(`\nassistant> ${r.text}\n`);
  console.log(`  tokens: ${r.usage.prompt_tokens} in / ${r.usage.completion_tokens} out (${MODEL})`);
}

(async () => {
  const session = createSession();
  if (question) {
    await ask(session, question, null);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const text = (await rl.question("you> ")).trim();
      if (!text || text === "exit") break;
      await ask(session, text, rl);
    }
    rl.close();
  }
  await close();
})().catch(async (err) => {
  console.error("Error:", err.message);
  await close();
  process.exit(1);
});
