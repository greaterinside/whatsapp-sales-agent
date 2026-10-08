import crypto from "node:crypto";
import express from "express";
import { ClaudeAgent } from "./agent.js";
import { KapsoSender, SmtpMailer } from "./channels.js";
import { config } from "./config.js";
import { Handler, parseKapsoWebhook } from "./handler.js";
import { Store } from "./store.js";

/** Kapso signs the raw body: X-Webhook-Signature = hex(HMAC-SHA256(secret, body)). */
export function verifyKapsoSignature(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApp(handler: Handler, store: Store, cfg = config) {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/webhooks/kapso", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (cfg.kapsoWebhookSecret && !verifyKapsoSignature(cfg.kapsoWebhookSecret, raw, req.header("x-webhook-signature"))) {
      res.status(401).end();
      return;
    }
    const event = req.header("x-webhook-event");
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).end();
      return;
    }
    // Kapso wants a 200 within 10 seconds; Claude can take longer, so acknowledge first.
    res.status(200).end();
    if (event && event !== "whatsapp.message.received") return;
    for (const msg of parseKapsoWebhook(body)) void handler.handle(msg);
  });

  // ---- Admin (Bearer ADMIN_TOKEN) --------------------------------------------------
  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!cfg.adminToken || req.header("authorization") !== `Bearer ${cfg.adminToken}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  admin.post("/pause/:phone", (req, res) => {
    res.json(summary(handler.setPaused(req.params.phone, true)));
  });
  admin.post("/resume/:phone", (req, res) => {
    res.json(summary(handler.setPaused(req.params.phone, false)));
  });
  admin.get("/conversations", (_req, res) => {
    res.json(store.all().map(summary));
  });
  admin.get("/conversations/:phone", (req, res) => {
    res.json(store.conversation(req.params.phone.replace(/\D/g, "")));
  });
  app.use("/admin", admin);

  return app;
}

function summary(c: ReturnType<Store["conversation"]>) {
  return {
    phone: c.phone,
    contactName: c.contactName,
    lead: c.lead,
    paused: c.paused,
    messages: c.turns.length,
    lastMessageAt: c.turns.at(-1)?.at,
    lastEscalatedAt: c.lastEscalatedAt,
  };
}

// Started directly (npm start / npm run dev), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = ["KAPSO_API_KEY", "ANTHROPIC_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  if (!config.kapsoWebhookSecret) console.warn("[server] KAPSO_WEBHOOK_SECRET not set: webhook signatures are NOT checked");

  const store = new Store(config.dataDir);
  const handler = new Handler({
    store,
    agent: new ClaudeAgent({
      model: config.claudeModel,
      effort: config.claudeEffort,
      historyTurns: config.historyTurns,
      knowledgePath: config.knowledgePath,
    }),
    sender: new KapsoSender(config),
    mailer: new SmtpMailer(config),
    adminPhones: config.adminPhones,
  });
  createApp(handler, store).listen(config.port, () => {
    console.log(`WhatsApp agent listening on :${config.port}  (webhook: POST /webhooks/kapso)`);
  });
}
