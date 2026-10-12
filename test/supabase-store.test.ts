// Runs the real supabase/schema.sql in PGlite (Postgres in WASM) and calls its functions the way
// supabase-js .rpc() does, so the SQL itself is tested, not a mock.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { SupabaseStore, type RpcClient } from "../src/store.js";

const SETOF = new Set(["wa_list_conversations", "wa_paused_phones"]);

async function store() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
  const client: RpcClient = {
    async rpc(fn, args = {}) {
      try {
        const keys = Object.keys(args);
        const params = keys.map((k) => (typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
        const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
        const { rows } = await db.query<{ r: unknown }>(sql, params);
        return { data: SETOF.has(fn) ? rows.map((x) => x.r) : rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
  return { s: new SupabaseStore(client, () => new Promise((r) => setTimeout(r, 1))), db };
}

test("a new number gets an empty conversation; saves round-trip", async () => {
  const { s } = await store();
  const c = await s.getConversation("911");
  assert.equal(c.turns.length, 0);
  assert.deepEqual(c.lead, { name: "", company: "", requirement: "" });
  assert.equal(c.paused, false);
  c.contactName = "Ravi";
  c.turns.push({ role: "user", text: "Hi", at: "2026-10-12T10:00:00Z" });
  c.lead.name = "Ravi";
  c.lastEscalatedAt = "2026-10-12T10:01:00.000Z";
  await s.saveConversation(c);
  const back = await s.getConversation("911");
  assert.equal(back.contactName, "Ravi");
  assert.equal(back.turns[0].text, "Hi");
  assert.equal(back.lead.name, "Ravi");
  assert.ok(back.lastEscalatedAt);
  assert.deepEqual((await s.listConversations()).map((x) => x.phone), ["911"]);
});

test("saving a conversation can't undo a pause made in the meantime", async () => {
  const { s } = await store();
  const c = await s.getConversation("911"); // read before the pause, as the handler does
  await s.setPaused("911", true);
  c.turns.push({ role: "assistant", text: "reply", at: "t" });
  await s.saveConversation(c);
  assert.equal(await s.isPaused("911"), true);
  assert.deepEqual(await s.pausedPhones(), ["911"]);
  assert.equal((await s.getConversation("911")).turns.length, 1);
  const resumed = await s.setPaused("911", false);
  assert.equal(resumed.paused, false);
  assert.deepEqual(await s.pausedPhones(), []);
});

test("pausing a number that never wrote creates it paused", async () => {
  const { s } = await store();
  assert.equal((await s.setPaused("922", true)).paused, true);
});

test("markProcessed is true once per message id", async () => {
  const { s } = await store();
  assert.equal(await s.markProcessed("wamid.1"), true);
  assert.equal(await s.markProcessed("wamid.1"), false);
  assert.equal(await s.markProcessed("wamid.2"), true);
});

test("withLock runs one customer's work strictly one after another", async () => {
  const { s } = await store();
  const order: string[] = [];
  const job = (name: string, ms: number) =>
    s.withLock("911", async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
    });
  await Promise.all([job("a", 30), job("b", 0)]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

test("an expired lock can be taken over; a held one cannot", async () => {
  const { db } = await store();
  const take = async (token: string, ttl: number) =>
    (await db.query<{ r: boolean }>("select wa_acquire_lock('911', $1, $2) as r", [token, ttl])).rows[0].r;
  assert.equal(await take("a", 60_000), true);
  assert.equal(await take("b", 60_000), false);
  await db.query("update wa_locks set expires_at = now() - interval '1 second'");
  assert.equal(await take("b", 60_000), true);
});

test("database errors surface instead of being swallowed", async () => {
  const s = new SupabaseStore({ rpc: async () => ({ data: null, error: { message: "boom" } }) });
  await assert.rejects(s.getConversation("911"), /wa_get_conversation: boom/);
});
