// HTTP routes as web-standard Request -> Response, shared by Vercel (api/index.ts) and the local server.
import crypto from "node:crypto";
import { ClaudeAgent } from "./agent.js";
import { KapsoSender, SmtpMailer } from "./channels.js";
import { config, normalizePhone, type Config } from "./config.js";
import { Handler, parseKapsoWebhook } from "./handler.js";
import { FileStore, RedisStore, type Conversation, type Store } from "./store.js";

export interface App {
  handler: Handler;
  store: Store;
  cfg: Config;
  /** Keeps background work alive after the response (Vercel's waitUntil; a no-op locally). */
  waitUntil: (work: Promise<unknown>) => void;
}

/** Redis when it is configured (Vercel), otherwise the JSON file in DATA_DIR. */
export function buildApp(waitUntil: App["waitUntil"], cfg = config): App {
  const redisConfigured = Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL);
  if (process.env.VERCEL && !redisConfigured) {
    throw new Error("On Vercel, connect an Upstash Redis store to the project (Storage tab); the disk is not kept between requests");
  }
  const store = redisConfigured ? RedisStore.fromEnv() : new FileStore(cfg.dataDir);
  const handler = new Handler({
    store,
    agent: new ClaudeAgent({
      model: cfg.claudeModel,
      effort: cfg.claudeEffort,
      historyTurns: cfg.historyTurns,
      knowledgePath: cfg.knowledgePath,
    }),
    sender: new KapsoSender(cfg),
    mailer: new SmtpMailer(cfg),
    adminPhones: cfg.adminPhones,
  });
  return { handler, store, cfg, waitUntil };
}

/** Kapso signs the raw body: X-Webhook-Signature = hex(HMAC-SHA256(secret, body)). */
export function verifyKapsoSignature(secret: string, rawBody: Buffer, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function route(req: Request, app: App): Promise<Response> {
  const url = new URL(req.url);
  // On Vercel every path is rewritten to /api?path=<original path> (see vercel.json).
  const path = "/" + (url.searchParams.get("path") ?? url.pathname).replace(/^\/+/, "");

  if (path === "/health") return Response.json({ ok: true });
  if (path === "/webhooks/kapso" && req.method === "POST") return kapsoWebhook(req, app);
  if (path.startsWith("/admin/")) return admin(req, path.slice("/admin/".length).split("/"), app);
  return new Response("Not found", { status: 404 });
}

async function kapsoWebhook(req: Request, { handler, cfg, waitUntil }: App): Promise<Response> {
  const raw = Buffer.from(await req.arrayBuffer());
  if (cfg.kapsoWebhookSecret && !verifyKapsoSignature(cfg.kapsoWebhookSecret, raw, req.headers.get("x-webhook-signature"))) {
    return new Response(null, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return new Response(null, { status: 400 });
  }
  const event = req.headers.get("x-webhook-event");
  if (!event || event === "whatsapp.message.received") {
    // Kapso wants a 200 within 10 seconds; Claude can take longer, so reply now and keep working.
    waitUntil(Promise.all(parseKapsoWebhook(body).map((msg) => handler.handle(msg))));
  }
  return new Response(null, { status: 200 });
}

async function admin(req: Request, [action, phone = ""]: string[], { handler, store, cfg }: App): Promise<Response> {
  if (!cfg.adminToken || req.headers.get("authorization") !== `Bearer ${cfg.adminToken}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let digits: string;
  try {
    digits = normalizePhone(decodeURIComponent(phone)); // "+91%2098765..." must not read the "20"s as digits
  } catch {
    return Response.json({ error: "bad phone number" }, { status: 400 });
  }
  if (req.method === "POST" && (action === "pause" || action === "resume") && digits) {
    return Response.json(summary(await handler.setPaused(digits, action === "pause")));
  }
  if (req.method === "GET" && action === "conversations") {
    return digits
      ? Response.json(await store.getConversation(digits))
      : Response.json((await store.listConversations()).map(summary));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function summary(c: Conversation) {
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
