// Conversation history, paused numbers, leads and processed message ids.
// FileStore: one JSON file, for local runs and tests. SupabaseStore: Postgres tables, for Vercel,
// where the disk is temporary and every request can land on a different instance.
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

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

// ---- Supabase (Vercel) ------------------------------------------------------------------

/** The one supabase-js call we use; all logic lives in the SQL functions in supabase/schema.sql. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

const LOCK_TTL_MS = 120_000; // longer than one Claude call + reply
const LOCK_WAIT_MS = 90_000;

export class SupabaseStore implements Store {
  constructor(
    private db: RpcClient,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (what Vercel's Supabase integration sets). */
  static fromEnv(): SupabaseStore {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  }

  private async call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new Error(`Supabase ${fn}: ${error.message}`);
    return data as T;
  }

  getConversation(phone: string) {
    return this.call<Conversation>("wa_get_conversation", { p_phone: phone });
  }

  saveConversation(c: Conversation) {
    return this.call<void>("wa_save_conversation", { p: c });
  }

  listConversations() {
    return this.call<Conversation[]>("wa_list_conversations");
  }

  async isPaused(phone: string) {
    return (await this.getConversation(phone)).paused;
  }

  setPaused(phone: string, paused: boolean) {
    return this.call<Conversation>("wa_set_paused", { p_phone: phone, p_paused: paused });
  }

  pausedPhones() {
    return this.call<string[]>("wa_paused_phones");
  }

  markProcessed(messageId: string) {
    return this.call<boolean>("wa_mark_processed", { p_id: messageId });
  }

  async withLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const token = crypto.randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;
    while (!(held = await this.call<boolean>("wa_acquire_lock", { p_phone: phone, p_token: token, p_ttl_ms: LOCK_TTL_MS }))) {
      if (Date.now() > deadline) {
        console.warn(`[store] lock for ${phone} not released after ${LOCK_WAIT_MS}ms; continuing without it`);
        break;
      }
      await this.sleep(500);
    }
    try {
      return await fn();
    } finally {
      if (held) await this.call<void>("wa_release_lock", { p_phone: phone, p_token: token }).catch(() => {});
    }
  }
}
