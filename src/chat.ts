// Talk to the agent in the terminal: same prompt, knowledge and escalation logic, no WhatsApp needed.
// Useful for checking knowledge.md before connecting Kapso.  npm run chat
import readline from "node:readline/promises";
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
for (let i = 0; ; i++) {
  const text = (await rl.question("You: ")).trim();
  if (!text) continue;
  await handler.handle({ messageId: `local-${i}`, phoneNumberId: "local", from: "910000000000", contactName: "Test", text });
}
