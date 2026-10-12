// Local server (npm run dev / npm start): the same routes as Vercel, on plain node:http.
import http from "node:http";
import { config } from "./config.js";
import { buildApp, route, type App } from "./http.js";

/** Bridges node:http to the web-standard route() used on Vercel. */
export function createServer(app: App): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await route(request, app);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error("[server]", err);
      res.writeHead(500).end();
    }
  });
}

// Started directly (npm start / npm run dev), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = ["KAPSO_API_KEY", "ANTHROPIC_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  if (!config.kapsoWebhookSecret) console.warn("[server] KAPSO_WEBHOOK_SECRET not set: webhook signatures are NOT checked");

  // A long-running process keeps background work alive on its own.
  const app = buildApp((work) => void work);
  createServer(app).listen(config.port, () => {
    console.log(`WhatsApp agent listening on :${config.port}  (webhook: POST /webhooks/kapso)`);
  });
}
