// Small JSON-file store: conversation history, paused numbers, leads, processed message ids.
// Good enough for one instance and a demo; swap for Postgres/Redis if we scale out.
import fs from "node:fs";
import path from "node:path";

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

interface State {
  conversations: Record<string, Conversation>;
  processedIds: string[];
}

const MAX_PROCESSED_IDS = 5000;

export class Store {
  private state: State = { conversations: {}, processedIds: [] };
  private processed = new Set<string>();
  private file: string | null;

  /** Pass null for an in-memory store (tests). */
  constructor(dataDir: string | null) {
    this.file = dataDir ? path.join(dataDir, "state.json") : null;
    if (this.file && fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.processed = new Set(this.state.processedIds);
    }
  }

  conversation(phone: string): Conversation {
    return (this.state.conversations[phone] ??= {
      phone,
      turns: [],
      lead: { name: "", company: "", requirement: "" },
      paused: false,
    });
  }

  all(): Conversation[] {
    return Object.values(this.state.conversations);
  }

  /** Returns false if this message id was already handled (webhook retries). */
  markProcessed(messageId: string): boolean {
    if (this.processed.has(messageId)) return false;
    this.processed.add(messageId);
    this.state.processedIds.push(messageId);
    if (this.state.processedIds.length > MAX_PROCESSED_IDS) {
      const dropped = this.state.processedIds.splice(0, this.state.processedIds.length - MAX_PROCESSED_IDS);
      dropped.forEach((id) => this.processed.delete(id));
    }
    this.save();
    return true;
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
