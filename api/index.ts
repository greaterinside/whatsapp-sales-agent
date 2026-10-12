// Vercel entry point. vercel.json rewrites every path here as /api?path=<original path>.
import { waitUntil } from "@vercel/functions";
import { buildApp, route, type App } from "../src/http.js";

let app: App | undefined; // reused while the instance stays warm

function handle(req: Request): Promise<Response> {
  app ??= buildApp(waitUntil);
  return route(req, app);
}

export const GET = handle;
export const POST = handle;
