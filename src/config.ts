// All settings come from the environment (.env locally, the host's variables in production).

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function list(name: string): string[] {
  return str(name)
    .split(",")
    .map((s) => normalizePhone(s))
    .filter(Boolean);
}

/** Digits only, so "+91 98765-43210" and "919876543210" compare equal. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export const config = {
  port: Number(str("PORT", "3000")),
  dataDir: str("DATA_DIR", "data"),
  knowledgePath: str("KNOWLEDGE_PATH", "knowledge.md"),

  // Claude
  claudeModel: str("CLAUDE_MODEL", "claude-opus-5-5"),
  claudeEffort: str("CLAUDE_EFFORT", "medium") as "low" | "medium" | "high",
  historyTurns: Number(str("HISTORY_TURNS", "30")),

  // Kapso
  kapsoApiKey: str("KAPSO_API_KEY"),
  kapsoBaseUrl: str("KAPSO_BASE_URL", "https://api.kapso.ai/meta/whatsapp"),
  kapsoWebhookSecret: str("KAPSO_WEBHOOK_SECRET"),

  // Escalation email (SMTP: Google Workspace app password, SES, Resend, Postmark...)
  escalationEmail: str("ESCALATION_EMAIL"),
  emailFrom: str("EMAIL_FROM"),
  smtpHost: str("SMTP_HOST"),
  smtpPort: Number(str("SMTP_PORT", "587")),
  smtpUser: str("SMTP_USER"),
  smtpPass: str("SMTP_PASS"),

  // Team members who can control the bot by messaging it (/pause, /resume, /status)
  adminPhones: list("ADMIN_PHONES"),
  // Bearer token for the HTTP admin endpoints
  adminToken: str("ADMIN_TOKEN"),
};

export type Config = typeof config;
