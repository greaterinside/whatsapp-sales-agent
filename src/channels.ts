// Outbound side effects: WhatsApp replies via Kapso, escalation emails via SMTP.
import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.js";

export interface Sender {
  sendText(phoneNumberId: string, to: string, body: string): Promise<void>;
  markRead(phoneNumberId: string, messageId: string): Promise<void>;
}

export interface Mailer {
  send(subject: string, body: string): Promise<void>;
}

export class KapsoSender implements Sender {
  private client: WhatsAppClient;

  constructor(cfg: Config) {
    this.client = new WhatsAppClient({ baseUrl: cfg.kapsoBaseUrl, kapsoApiKey: cfg.kapsoApiKey });
  }

  async sendText(phoneNumberId: string, to: string, body: string): Promise<void> {
    await this.client.messages.sendText({ phoneNumberId, to, body });
  }

  /** Blue ticks + "typing..." while Claude thinks. Best effort. */
  async markRead(phoneNumberId: string, messageId: string): Promise<void> {
    await this.client.messages.markRead({ phoneNumberId, messageId, typingIndicator: { type: "text" } });
  }
}

export class SmtpMailer implements Mailer {
  private transport: Transporter | null;

  constructor(private cfg: Config) {
    this.transport =
      cfg.smtpHost && cfg.escalationEmail
        ? nodemailer.createTransport({
            host: cfg.smtpHost,
            port: cfg.smtpPort,
            secure: cfg.smtpPort === 465,
            auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
          })
        : null;
    if (!this.transport) console.warn("[email] SMTP_HOST or ESCALATION_EMAIL not set: escalations will only be logged");
  }

  async send(subject: string, body: string): Promise<void> {
    if (!this.transport) {
      console.log(`[email:dry-run] ${subject}\n${body}`);
      return;
    }
    await this.transport.sendMail({
      from: this.cfg.emailFrom || this.cfg.smtpUser,
      to: this.cfg.escalationEmail,
      subject,
      text: body,
    });
  }
}
