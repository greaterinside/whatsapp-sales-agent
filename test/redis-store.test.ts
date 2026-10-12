import assert from "node:assert/strict";
import { test } from "node:test";
import { RedisStore, type RedisLike } from "../src/store.js";

/** In-memory stand-in for the Upstash commands RedisStore uses (JSON round-trip like Upstash). */
class FakeRedis implements RedisLike {
  kv = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async get<T>(key: string) {
    const v = this.kv.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async set(key: string, value: unknown, opts?: { nx?: true; px?: number; ex?: number }) {
    if (opts?.nx && this.kv.has(key)) return null;
    this.kv.set(key, JSON.stringify(value));
    return "OK";
  }
  async del(key: string) {
    return this.kv.delete(key) ? 1 : 0;
  }
  private set_(key: string) {
    return this.sets.get(key) ?? this.sets.set(key, new Set()).get(key)!;
  }
  async sadd(key: string, m: string) {
    this.set_(key).add(m);
    return 1;
  }
  async srem(key: string, m: string) {
    this.set_(key).delete(m);
    return 1;
  }
  async smembers(key: string) {
    return [...this.set_(key)];
  }
  async sismember(key: string, m: string) {
    return this.set_(key).has(m) ? 1 : 0;
  }
}

const store = () => new RedisStore(new FakeRedis(), () => new Promise((r) => setTimeout(r, 1)));

test("conversations round-trip and are listed", async () => {
  const s = store();
  const c = await s.getConversation("911");
  assert.equal(c.turns.length, 0);
  c.turns.push({ role: "user", text: "Hi", at: "t" });
  await s.saveConversation(c);
  assert.equal((await s.getConversation("911")).turns[0].text, "Hi");
  assert.deepEqual((await s.listConversations()).map((x) => x.phone), ["911"]);
});

test("saving a conversation can't undo a pause made in the meantime", async () => {
  const s = store();
  const c = await s.getConversation("911"); // read before the pause, as the handler does
  await s.setPaused("911", true);
  c.turns.push({ role: "assistant", text: "reply", at: "t" });
  await s.saveConversation(c);
  assert.equal(await s.isPaused("911"), true);
  assert.deepEqual(await s.pausedPhones(), ["911"]);
  await s.setPaused("911", false);
  assert.equal((await s.getConversation("911")).paused, false);
});

test("markProcessed is true once per message id", async () => {
  const s = store();
  assert.equal(await s.markProcessed("wamid.1"), true);
  assert.equal(await s.markProcessed("wamid.1"), false);
});

test("withLock runs one customer's work strictly one after another", async () => {
  const s = store();
  const order: string[] = [];
  const job = (name: string, ms: number) =>
    s.withLock("911", async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
    });
  await Promise.all([job("a", 20), job("b", 0)]);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});
