// Core flow, independent of HTTP: inbound message -> (admin command | paused | Claude) -> reply (+ escalation email).
import { FALLBACK_REPLY, type Agent, type AgentDecision } from "./agent.js";
import type { Mailer, Sender } from "./channels.js";
import { normalizePhone } from "./config.js";
import type { Conversation, Store } from "./store.js";

export interface InboundMessage {
  messageId: string;
  phoneNumberId: string;
  from: string; // digits only
  contactName?: string;
  text: string;
}

/**
 * Pull inbound customer messages out of a Kapso `whatsapp.message.received` webhook (v2 payload).
 * Handles both single events and buffered batches.
 */
export function parseKapsoWebhook(body: unknown): InboundMessage[] {
  const b = body as any;
  const events: any[] = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : [b];
  const out: InboundMessage[] = [];
  for (const e of events) {
    const m = e?.message;
    if (!m?.id || m.kapso?.direction === "outbound") continue;
    const from = normalizePhone(e.conversation?.phone_number ?? m.from ?? "");
    const phoneNumberId = e.phone_number_id ?? e.conversation?.phone_number_id;
    if (!from || !phoneNumberId) continue;
    const text: string = m.text?.body ?? m.kapso?.content ?? "";
    out.push({
      messageId: m.id,
      phoneNumberId,
      from,
      contactName: e.conversation?.kapso?.contact_name,
      text: text.trim() || `[The customer sent a ${m.type ?? "non-text"} message with no readable text.]`,
    });
  }
  return out;
}

export class Handler {
  constructor(
    private deps: { store: Store; agent: Agent; sender: Sender; mailer: Mailer; adminPhones: string[] },
  ) {}

  /** Messages from one number are handled strictly in order (store lock); different numbers run in parallel. */
  async handle(msg: InboundMessage): Promise<void> {
    try {
      if (!(await this.deps.store.markProcessed(msg.messageId))) return; // webhook retry
      await this.deps.store.withLock(msg.from, () => this.process(msg));
    } catch (err) {
      console.error(`[handler] ${msg.from}:`, err);
    }
  }

  private async process(msg: InboundMessage): Promise<void> {
    const { store, sender } = this.deps;

    if (this.deps.adminPhones.includes(msg.from) && msg.text.startsWith("/")) {
      await sender.sendText(msg.phoneNumberId, msg.from, await this.adminCommand(msg.text));
      return;
    }

    const convo = await store.getConversation(msg.from);
    if (msg.contactName) convo.contactName = msg.contactName;
    convo.turns.push({ role: "user", text: msg.text, at: new Date().toISOString() });
    await store.saveConversation(convo);

    if (convo.paused) {
      console.log(`[handler] ${msg.from} is paused (human handling); not replying`);
      return;
    }

    sender.markRead(msg.phoneNumberId, msg.messageId).catch((err) => console.warn("[handler] markRead failed:", err.message));

    let decision: AgentDecision;
    try {
      decision = await this.deps.agent.decide(convo);
    } catch (err) {
      console.error(`[handler] agent failed for ${msg.from}:`, err);
      decision = {
        reply: FALLBACK_REPLY,
        topic: "other",
        escalate: true,
        escalation_reason: `The AI assistant could not answer automatically (${(err as Error).message}).`,
        summary_for_team: `Latest customer message: "${msg.text}"`,
        lead: convo.lead,
      };
    }

    // Re-check: someone may have paused this number while Claude was thinking.
    if (await store.isPaused(msg.from)) return;

    convo.lead = mergeLead(convo.lead, decision.lead);
    convo.turns.push({ role: "assistant", text: decision.reply, at: new Date().toISOString() });
    await store.saveConversation(convo);
    try {
      await sender.sendText(msg.phoneNumberId, msg.from, decision.reply);
    } catch (err) {
      // The customer heard nothing back, so a human has to pick this up.
      console.error(`[handler] WhatsApp send failed for ${msg.from}:`, err);
      decision.escalate = true;
      decision.escalation_reason =
        `${decision.escalation_reason} The bot's WhatsApp reply could NOT be delivered (${(err as Error).message}).`.trim();
    }

    if (decision.escalate) {
      convo.lastEscalatedAt = new Date().toISOString();
      await store.saveConversation(convo);
      await this.deps.mailer
        .send(escalationSubject(convo, decision), escalationBody(convo, decision))
        .catch((err) => console.error(`[handler] escalation email failed for ${msg.from}:`, err));
    }
  }

  private async adminCommand(text: string): Promise<string> {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const phone = normalizePhone(rest.join("")); // "+91 98765 43210" is one number
    switch (cmd.toLowerCase()) {
      case "/pause":
        if (!phone) return "Usage: /pause <number with country code>";
        await this.setPaused(phone, true);
        return `Paused the bot for +${phone}. You can reply to them yourself now. Send /resume ${phone} to hand back.`;
      case "/resume":
        if (!phone) return "Usage: /resume <number with country code>";
        await this.setPaused(phone, false);
        return `Bot is answering +${phone} again.`;
      case "/status": {
        const paused = await Promise.all((await this.deps.store.pausedPhones()).map((p) => this.deps.store.getConversation(p)));
        return paused.length
          ? `Paused numbers:\n${paused.map((c) => `+${c.phone}${c.contactName ? ` (${c.contactName})` : ""}`).join("\n")}`
          : "The bot is answering everyone. No numbers paused.";
      }
      default:
        return "Commands:\n/pause <number> - stop the bot for a customer\n/resume <number> - hand back to the bot\n/status - list paused numbers";
    }
  }

  setPaused(phone: string, paused: boolean): Promise<Conversation> {
    return this.deps.store.setPaused(normalizePhone(phone), paused);
  }
}

function mergeLead(old: Conversation["lead"], next: Conversation["lead"] | undefined): Conversation["lead"] {
  return {
    name: next?.name?.trim() || old.name,
    company: next?.company?.trim() || old.company,
    requirement: next?.requirement?.trim() || old.requirement,
  };
}

function escalationSubject(convo: Conversation, d: AgentDecision): string {
  const who = convo.lead.name || convo.contactName || `+${convo.phone}`;
  return `[WhatsApp] ${who} needs a follow-up (${d.topic})`;
}

function escalationBody(convo: Conversation, d: AgentDecision): string {
  const transcript = convo.turns
    .slice(-20)
    .map((t) => `${t.role === "user" ? "Customer" : "Bot"}: ${t.text}`)
    .join("\n");
  return [
    `A customer on the Greater Inside WhatsApp number needs a team member.`,
    ``,
    `Why: ${d.escalation_reason || "(not given)"}`,
    ``,
    `Customer: +${convo.phone}  (WhatsApp: https://wa.me/${convo.phone})`,
    `WhatsApp name: ${convo.contactName || "-"}`,
    `Name: ${convo.lead.name || "-"}`,
    `Company: ${convo.lead.company || "-"}`,
    `Requirement: ${convo.lead.requirement || "-"}`,
    ``,
    `Summary:`,
    d.summary_for_team,
    ``,
    `To reply yourself on WhatsApp, first pause the bot for this number: send "/pause ${convo.phone}" to the bot from an admin phone.`,
    ``,
    `Recent conversation:`,
    transcript,
  ].join("\n");
}
