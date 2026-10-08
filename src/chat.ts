// Talk to the agent in the terminal: same prompt, knowledge and escalation logic, no WhatsApp needed.
// Useful for checking knowledge.md before connecting Kapso.  npm run chat
import readline from "node:readline";
import { ClaudeAgent } from "./agent.js";
import type { Mailer, Sender } from "./channels.js";
import { config } from "./config.js";
import { Handler } from "./handler.js";
import { Store } from "./store.js";

const consoleSender: Sender = {
  async sendText(_id, _to, body) {
    console.log(`\nBot: ${body}\n`);
  },
  async markRead() {},
};
const consoleMailer: Mailer = {
  async send(subject, body) {
    console.log(`----- escalation email (not sent) -----\n${subject}\n\n${body}\n---------------------------------------\n`);
  },
};

const handler = new Handler({
  store: new Store(null),
  agent: new ClaudeAgent({
    model: config.claudeModel,
    effort: config.claudeEffort,
    historyTurns: config.historyTurns,
    knowledgePath: config.knowledgePath,
  }),
  sender: consoleSender,
  mailer: consoleMailer,
  adminPhones: [],
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Chatting as a customer (+910000000000). Ctrl+C to quit.\n");
// Also works with piped input, one customer message per line: printf 'Hi\nAre you human?\n' | npm run chat
const interactive = process.stdin.isTTY;
let i = 0;
rl.setPrompt(interactive ? "You: " : "");
rl.prompt();
for await (const line of rl) {
  const text = line.trim();
  if (text) {
    if (!interactive) console.log(`You: ${text}`);
    await handler.handle({ messageId: `local-${i++}`, phoneNumberId: "local", from: "910000000000", contactName: "Test", text });
  }
  rl.prompt();
}
