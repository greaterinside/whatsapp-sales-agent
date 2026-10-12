// Conversation history, paused numbers, leads and processed message ids.
// FileStore: one JSON file, for local runs and tests. RedisStore: Upstash Redis, for Vercel,
// where the disk is temporary and every request can land on a different instance.
import fs from "node:fs";
import path from "node:path";
import { Redis } from "@upstash/redis";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface Lead {
  name: string;
  company: string;
  requirement: string;
}

export interface Conversation {
  phone: string;
  contactName?: string;
  turns: Turn[];
  lead: Lead;
  paused: boolean;
  pausedAt?: string;
  lastEscalatedAt?: string;
}

export interface Store {
  getConversation(phone: string): Promise<Conversation>;
  /** Saves history, lead and escalation time. The paused flag is only changed by setPaused. */
  saveConversation(convo: Conversation): Promise<void>;
  listConversations(): Promise<Conversation[]>;
  isPaused(phone: string): Promise<boolean>;
  setPaused(phone: string, paused: boolean): Promise<Conversation>;
  pausedPhones(): Promise<string[]>;
  /** Returns false if this message id was already handled (webhook retries). */
  markProcessed(messageId: string): Promise<boolean>;
  /** Runs fn while holding this number's lock, so one customer's messages are answered in order. */
  withLock<T>(phone: string, fn: () => Promise<T>): Promise<T>;
}

export function newConversation(phone: string): Conversation {
  return { phone, turns: [], lead: { name: "", company: "", requirement: "" }, paused: false };
}

// ---- File (local) ---------------------------------------------------------------------

interface FileState {
  conversations: Record<string, Conversation>;
  processedIds: string[];
}

const MAX_PROCESSED_IDS = 5000;

export class FileStore implements Store {
  private state: FileState = { conversations: {}, processedIds: [] };
  private processed = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();
  private file: string | null;

  /** Pass null for an in-memory store (tests, npm run chat). */
  constructor(dataDir: string | null) {
    this.file = dataDir ? path.join(dataDir, "state.json") : null;
    if (this.file && fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.processed = new Set(this.state.processedIds);
    }
  }

  private convo(phone: string): Conversation {
    return (this.state.conversations[phone] ??= newConversation(phone));
  }

  async getConversation(phone: string): Promise<Conversation> {
    return structuredClone(this.convo(phone));
  }

  async saveConversation(c: Conversation) {
    const { paused, pausedAt } = this.convo(c.phone);
    this.state.conversations[c.phone] = { ...structuredClone(c), paused, pausedAt };
    this.persist();
  }

  async listConversations() {
    return structuredClone(Object.values(this.state.conversations));
  }

  async isPaused(phone: string) {
    return this.convo(phone).paused;
  }

  async setPaused(phone: string, paused: boolean) {
    const c = this.convo(phone);
    c.paused = paused;
    c.pausedAt = paused ? new Date().toISOString() : undefined;
    this.persist();
    return structuredClone(c);
  }

  async pausedPhones() {
    return Object.values(this.state.conversations).filter((c) => c.paused).map((c) => c.phone);
  }

  async markProcessed(messageId: string) {
    if (this.processed.has(messageId)) return false;
    this.processed.add(messageId);
    this.state.processedIds.push(messageId);
    if (this.state.processedIds.length > MAX_PROCESSED_IDS) {
      const dropped = this.state.processedIds.splice(0, this.state.processedIds.length - MAX_PROCESSED_IDS);
      dropped.forEach((id) => this.processed.delete(id));
    }
    this.persist();
    return true;
  }

  withLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(phone) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(phone, run);
    void run.finally(() => {
      if (this.locks.get(phone) === run) this.locks.delete(phone);
    }).catch(() => {});
    return run;
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ---- Redis (Vercel) ---------------------------------------------------------------------

/** The few Redis commands we use; satisfied by @upstash/redis and by the fake in tests. */
export interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { nx?: true; px?: number; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  sismember(key: string, member: string): Promise<number>;
}

const LOCK_TTL_MS = 120_000; // longer than one Claude call + reply
const LOCK_WAIT_MS = 90_000;
const PROCESSED_TTL_S = 7 * 24 * 3600;

export class RedisStore implements Store {
  constructor(
    private redis: RedisLike,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Uses UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN (what Vercel's Upstash integration sets). */
  static fromEnv(): RedisStore {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
    if (!url || !token) throw new Error("Redis is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    return new RedisStore(new Redis({ url, token }) as unknown as RedisLike);
  }

  async getConversation(phone: string): Promise<Conversation> {
    const [c, paused] = await Promise.all([this.redis.get<Conversation>(`convo:${phone}`), this.isPaused(phone)]);
    return { ...(c ?? newConversation(phone)), paused };
  }

  async saveConversation(c: Conversation) {
    const { paused: _paused, pausedAt: _pausedAt, ...rest } = c;
    await this.redis.set(`convo:${c.phone}`, rest);
    await this.redis.sadd("convos", c.phone);
  }

  async listConversations() {
    const phones = await this.redis.smembers("convos");
    return Promise.all(phones.map((p) => this.getConversation(p)));
  }

  async isPaused(phone: string) {
    return (await this.redis.sismember("paused", phone)) === 1;
  }

  async setPaused(phone: string, paused: boolean) {
    // Separate from the conversation document, so a reply being saved can't undo a pause.
    if (paused) await this.redis.sadd("paused", phone);
    else await this.redis.srem("paused", phone);
    const c = await this.getConversation(phone);
    return { ...c, pausedAt: paused ? new Date().toISOString() : undefined };
  }

  pausedPhones() {
    return this.redis.smembers("paused");
  }

  async markProcessed(messageId: string) {
    return (await this.redis.set(`msg:${messageId}`, 1, { nx: true, ex: PROCESSED_TTL_S })) === "OK";
  }

  async withLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const key = `lock:${phone}`;
    const token = crypto.randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (!(held = (await this.redis.set(key, token, { nx: true, px: LOCK_TTL_MS })) === "OK")) {
      if (Date.now() > deadline) {
        console.warn(`[store] lock for ${phone} not released after ${LOCK_WAIT_MS}ms; continuing without it`);
        break;
      }
      await this.sleep(500);
    }
    try {
      return await fn();
    } finally {
      if (held && (await this.redis.get<string>(key)) === token) await this.redis.del(key);
    }
  }
}
