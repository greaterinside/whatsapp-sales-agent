import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Agent, AgentDecision } from "../src/agent.js";
import type { Mailer, Sender } from "../src/channels.js";
import { config } from "../src/config.js";
import { Handler, parseKapsoWebhook, type InboundMessage } from "../src/handler.js";
import { route, verifyKapsoSignature, type App } from "../src/http.js";
import { createServer } from "../src/server.js";
import { FileStore, type Conversation } from "../src/store.js";

function decision(over: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply: "Hi! I'm Greater Inside's AI assistant.",
    topic: "greeting",
    escalate: false,
    escalation_reason: "",
    summary_for_team: "New visitor said hi.",
    lead: { name: "", company: "", requirement: "" },
    ...over,
  };
}

function setup(decide: (c: Conversation) => Promise<AgentDecision> = async () => decision()) {
  const sent: { to: string; body: string }[] = [];
  const emails: { subject: string; body: string }[] = [];
  const agentCalls: Conversation[] = [];
  const agent: Agent = {
    decide: async (c) => {
      agentCalls.push(structuredClone(c));
      return decide(c);
    },
  };
  const sender: Sender = {
    sendText: async (_id, to, body) => void sent.push({ to, body }),
    markRead: async () => {},
  };
  const mailer: Mailer = { send: async (subject, body) => void emails.push({ subject, body }) };
  const store = new FileStore(null);
  const handler = new Handler({ store, agent, sender, mailer, adminPhones: ["919999999999"] });
  return { handler, store, sent, emails, agentCalls };
}

let n = 0;
const msg = (text: string, from = "919876543210"): InboundMessage => ({
  messageId: `wamid.${++n}`,
  phoneNumberId: "pnid",
  from,
  contactName: "Ravi",
  text,
});

test("replies via Claude and keeps per-number history", async () => {
  const { handler, store, sent, agentCalls } = setup();
  await handler.handle(msg("Hi"));
  await handler.handle(msg("What do you do?"));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, "919876543210");
  assert.deepEqual(
    agentCalls[1].turns.map((t) => t.role),
    ["user", "assistant", "user"],
  );
  assert.equal((await store.getConversation("919876543210")).contactName, "Ravi");
});

test("ignores webhook retries of the same message id", async () => {
  const { handler, sent } = setup();
  const m = msg("Hi");
  await handler.handle(m);
  await handler.handle(m);
  assert.equal(sent.length, 1);
});

test("escalation sends an email with number, lead details and summary", async () => {
  const { handler, sent, emails, store } = setup(async () =>
    decision({
      reply: "A team member will follow up.",
      topic: "sales",
      escalate: true,
      escalation_reason: "Asked for a custom quote",
      summary_for_team: "Ravi from Acme wants a quote for SEO.",
      lead: { name: "Ravi", company: "Acme", requirement: "SEO retainer" },
    }),
  );
  await handler.handle(msg("Can you quote me for SEO? I'm Ravi from Acme"));
  assert.equal(sent[0].body, "A team member will follow up.");
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /Ravi/);
  assert.match(emails[0].body, /\+919876543210/);
  assert.match(emails[0].body, /Acme/);
  assert.match(emails[0].body, /custom quote/);
  assert.deepEqual((await store.getConversation("919876543210")).lead, { name: "Ravi", company: "Acme", requirement: "SEO retainer" });
});

test("lead details are not wiped by a later empty value", async () => {
  let first = true;
  const { handler, store } = setup(async () => {
    const d = first ? decision({ lead: { name: "Ravi", company: "Acme", requirement: "" } }) : decision();
    first = false;
    return d;
  });
  await handler.handle(msg("I'm Ravi from Acme"));
  await handler.handle(msg("thanks"));
  assert.equal((await store.getConversation("919876543210")).lead.company, "Acme");
});

test("Claude failure: customer gets a safe reply and the team is emailed", async () => {
  const { handler, sent, emails } = setup(async () => {
    throw new Error("boom");
  });
  await handler.handle(msg("Hello?"));
  assert.match(sent[0].body, /passed it to the Greater Inside team/);
  assert.equal(emails.length, 1);
});

test("if the WhatsApp send fails, the team is still emailed", async () => {
  const { handler, emails } = (() => {
    const s = setup();
    (s.handler as any).deps.sender.sendText = async () => {
      throw new Error("Kapso down");
    };
    return s;
  })();
  await handler.handle(msg("Hi"));
  assert.equal(emails.length, 1);
  assert.match(emails[0].body, /could NOT be delivered \(Kapso down\)/);
});

test("paused numbers are recorded but not answered; admin commands pause and resume", async () => {
  const { handler, sent, store, agentCalls } = setup();
  await handler.handle(msg("/pause +91 98765 43210", "919999999999"));
  assert.match(sent.at(-1)!.body, /Paused the bot for \+919876543210/);
  await handler.handle(msg("Are you there?"));
  assert.equal(agentCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.equal((await store.getConversation("919876543210")).turns.length, 1);

  await handler.handle(msg("/status", "919999999999"));
  assert.match(sent.at(-1)!.body, /919876543210/);

  await handler.handle(msg("/resume 919876543210", "919999999999"));
  await handler.handle(msg("Hello again"));
  assert.equal(agentCalls.length, 1);
  // The bot sees what was said while a human was handling it.
  assert.equal(agentCalls[0].turns.length, 2);
});

test("slash messages from non-admins go to Claude, not the command handler", async () => {
  const { handler, agentCalls } = setup();
  await handler.handle(msg("/pause 919999999999"));
  assert.equal(agentCalls.length, 1);
});

test("messages from one number are processed in order", async () => {
  const order: string[] = [];
  const { handler } = setup(async (c) => {
    const last = c.turns.at(-1)!.text;
    await new Promise((r) => setTimeout(r, last === "first" ? 30 : 0));
    order.push(last);
    return decision();
  });
  await Promise.all([handler.handle(msg("first")), handler.handle(msg("second"))]);
  assert.deepEqual(order, ["first", "second"]);
});

test("parseKapsoWebhook handles single, batched, outbound and media payloads", () => {
  const event = (id: string, extra: object = {}) => ({
    message: { id, type: "text", text: { body: "Hello" }, kapso: { direction: "inbound" }, ...extra },
    conversation: { phone_number: "+91 98765 43210", phone_number_id: "pnid", kapso: { contact_name: "Ravi" } },
    phone_number_id: "pnid",
  });
  assert.deepEqual(parseKapsoWebhook(event("a")), [
    { messageId: "a", phoneNumberId: "pnid", from: "919876543210", contactName: "Ravi", text: "Hello" },
  ]);
  assert.equal(parseKapsoWebhook({ data: [event("a"), event("b")] }).length, 2);
  assert.equal(parseKapsoWebhook([event("a")]).length, 1);
  assert.equal(parseKapsoWebhook(event("a", { kapso: { direction: "outbound" } })).length, 0);
  const media = parseKapsoWebhook(event("c", { type: "image", text: undefined, kapso: { direction: "inbound" } }));
  assert.match(media[0].text, /image message/);
});

const webhookBody = JSON.stringify({
  message: { id: "wamid.sig", type: "text", text: { body: "Hi" }, kapso: { direction: "inbound" } },
  conversation: { phone_number: "+15551234567", phone_number_id: "pnid" },
  phone_number_id: "pnid",
});

test("webhook route checks the Kapso signature, acknowledges, and hands the work to waitUntil", async () => {
  const { handler, store, sent } = setup();
  const secret = "s3cret";
  const background: Promise<unknown>[] = [];
  const app: App = { handler, store, cfg: { ...config, kapsoWebhookSecret: secret }, waitUntil: (p) => void background.push(p) };
  const sig = crypto.createHmac("sha256", secret).update(webhookBody).digest("hex");
  const post = (headers: Record<string, string>, url = "https://bot.example/webhooks/kapso") =>
    route(new Request(url, { method: "POST", body: webhookBody, headers }), app);

  assert.equal((await post({ "x-webhook-signature": "nope" })).status, 401);
  assert.equal(background.length, 0);

  // Vercel delivers every path as /api?path=<original path>.
  const ok = await post(
    { "x-webhook-signature": sig, "x-webhook-event": "whatsapp.message.received" },
    "https://bot.example/api?path=webhooks/kapso",
  );
  assert.equal(ok.status, 200);
  assert.equal(background.length, 1);
  await Promise.all(background);
  assert.equal(sent[0]?.to, "15551234567");
  assert.equal(verifyKapsoSignature(secret, Buffer.from(webhookBody), sig.toUpperCase()), true);
});

test("admin routes need the token and pause/resume a number", async () => {
  const { handler, store } = setup();
  const app: App = { handler, store, cfg: { ...config, adminToken: "t0k" }, waitUntil: () => {} };
  const call = (method: string, path: string, token = "t0k") =>
    route(new Request(`https://bot.example${path}`, { method, headers: { authorization: `Bearer ${token}` } }), app);
  assert.equal((await call("POST", "/admin/pause/919876543210", "wrong")).status, 401);
  assert.equal(((await (await call("POST", "/admin/pause/+91%2098765%2043210")).json()) as Conversation).paused, true);
  assert.equal(await store.isPaused("919876543210"), true);
  await call("POST", "/admin/resume/919876543210");
  assert.equal(await store.isPaused("919876543210"), false);
  assert.equal((await call("GET", "/admin/nope")).status, 404);
});

test("local server serves the same routes over node:http", async () => {
  const { handler, store, sent } = setup();
  const app: App = { handler, store, cfg: { ...config, kapsoWebhookSecret: "" }, waitUntil: () => {} };
  const server = createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/webhooks/kapso`, { method: "POST", body: webhookBody })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent[0]?.to, "15551234567");
  } finally {
    server.close();
  }
});
