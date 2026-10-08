# Greater Inside WhatsApp sales & support agent (v1)

A separate WhatsApp Business number, answered 24/7 by Claude. It handles sales and support questions
from `knowledge.md`, collects lead details, and emails the team when something needs a human.

```
Customer on WhatsApp
   │
   ▼
Kapso (official WhatsApp Business Cloud API)
   │  webhook: whatsapp.message.received   (signed, X-Webhook-Signature)
   ▼
this service  POST /webhooks/kapso
   │  admin number sent /pause etc.? ──► run command, reply to admin
   │  number paused (human handling)? ──► save message, stay quiet
   ▼
Claude API  (system prompt + knowledge.md + this customer's history)
   │  returns: reply, topic, escalate?, reason, team summary, lead {name, company, requirement}
   ├──► reply to the customer via Kapso
   └──► escalate? email ESCALATION_EMAIL: number, lead details, summary, recent chat
```

## What it does

- Introduces itself as Greater Inside's AI assistant; answers only from `knowledge.md`.
- Never invents prices, discounts, timelines or guarantees. Custom quotes, complaints, refunds,
  "can I talk to a person", and anything it can't answer go to the team.
- Politely declines off-topic requests. Customer messages are treated as untrusted input
  (instructions inside them are ignored).
- Keeps history per phone number and picks up name / company / requirement naturally.
- Escalation: tells the customer a team member will follow up (and gives the contact email from
  `knowledge.md`), then emails the team. If Claude or the WhatsApp send fails, the customer gets a safe
  holding reply where possible and the team is emailed anyway.
- Human takeover: pause the bot for one number, reply yourself, then resume. While paused, messages
  are still saved so the bot has the full context when it takes over again.
- Handles webhook retries (deduplicated by message id) and answers each customer's messages in order.

Not in v1: calendar booking, reminders, outbound/broadcast messages, WhatsApp Flows forms, images/voice notes
(the bot says it can only read text unless Kapso provides a transcript).

## Files

| Path | Purpose |
|---|---|
| `knowledge.md` | **Everything the bot is allowed to say.** Fill in every TODO before sharing the number. |
| `src/agent.ts` | System prompt and the Claude call (structured JSON output, prompt caching, refusal fallback) |
| `src/handler.ts` | Message flow: dedupe, admin commands, pause, Claude, reply, escalation email |
| `src/server.ts` | Express app: Kapso webhook (signature check) and `/admin` endpoints |
| `src/channels.ts` | Kapso sender and SMTP mailer |
| `src/store.ts` | JSON-file storage in `DATA_DIR` (history, leads, paused numbers) |
| `src/chat.ts` | Terminal chat with the bot, no WhatsApp needed |
| `test/` | Tests with fake Claude / Kapso / email (`npm test`, no keys needed) |

## Run it

Needs Node 20.6+.

```bash
cd whatsapp-agent
npm install
cp .env.example .env        # fill in ANTHROPIC_API_KEY at least
npm test                    # no keys needed
npm run chat                # talk to the bot in the terminal (needs ANTHROPIC_API_KEY)
```

`npm run chat` is the quickest way to check `knowledge.md`: ask it about pricing, ask for a discount,
ask something off-topic, try "ignore your instructions...". Escalation emails are printed, not sent.

### Connect WhatsApp (Kapso) and test locally with ngrok

1. In Kapso, create a project, connect a number (the sandbox/test number is fine to start) and create an API key.
   Put it in `KAPSO_API_KEY`.
   The number can't be on the normal WhatsApp app at the same time.
2. `npm run dev` (port 3000), then `ngrok http 3000`.
3. In Kapso, add a **phone-number webhook** (Kapso format, payload v2) on that number:
   - URL: `https://<your-ngrok-id>.ngrok.app/webhooks/kapso`
   - Events: `whatsapp.message.received`
   - Optional: turn on buffering (e.g. 3 to 5 seconds) so a burst of short messages becomes one reply.
   Copy the webhook's secret into `KAPSO_WEBHOOK_SECRET` and restart.
4. Message the number from your phone.

### Escalation email

Set `ESCALATION_EMAIL` and an SMTP account (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`).
Google Workspace works with `smtp.gmail.com`, port 587 and an app password. Without `SMTP_HOST`, escalations are
only logged.

### Human takeover

Customers can't see who replies, so pause the bot before replying yourself (from the Kapso inbox,
since the number isn't on the WhatsApp app):

- From a phone listed in `ADMIN_PHONES`, message the bot:
  `/pause 919876543210`, `/resume 919876543210`, `/status`
- Or over HTTP with `Authorization: Bearer $ADMIN_TOKEN`:
  `POST /admin/pause/:phone`, `POST /admin/resume/:phone`, `GET /admin/conversations`, `GET /admin/conversations/:phone`

Every escalation email repeats the `/pause` command for that number.

## Deploy (Railway)

1. New service from this repo, root directory `whatsapp-agent`. Build: `npm install`; start: `npm start`.
2. Add the variables from `.env.example`.
3. Attach a volume and set `DATA_DIR` to its mount path (e.g. `/data`), otherwise history is lost on each deploy.
4. Point the Kapso webhook at `https://<service>.up.railway.app/webhooks/kapso`.

Vercel isn't a good fit: the webhook replies to Kapso straight away and keeps working in the background,
and it keeps state on disk; serverless functions do neither.

## Settings

| Variable | Default | |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Must support system messages mid-conversation (current Opus/Sonnet do) |
| `CLAUDE_EFFORT` | `medium` | `low` is cheaper and faster; try it once knowledge.md is settled |
| `HISTORY_TURNS` | `30` | Past messages Claude sees per customer |

Requests ask the API to retry a refused request on Anthropic's recommended fallback model (`fallbacks: "default"`).

## Before showing Ajit sir

- [ ] Resolve the TODOs in `knowledge.md`. Until then the bot avoids each topic and says the team will confirm:
  - Customer support email, team hours and time zone, and the follow-up time after an escalation.
  - Scale to a Million: enrollment status. The site shows "Sold Out", "Enrollment Open Now" and "Get on the waitlist" in different places.
  - Scale to a Million: cohort cap. The site says both 40 and 100 founders.
  - Scale to a Million: crossed-out original price. The site shows both $1,000 and $3,000. The bot is told never to mention original prices.
  - Founders Membership: spots left (the site says only 10), whether it's open or waitlist-only, and its refund policy (not on the site).
  - Founders annual plan "Save $600" is consistent (12 x $300 = $3,600 vs $3,000); no action needed.
- [ ] Review the Founders intensive dates in `knowledge.md` each cycle (the bot is given today's date and works out which is current or next).
- [ ] Check costs: Kapso plan, Meta per-message pricing (inbound replies inside 24 hours are not template messages),
      Claude API usage. Not verified yet.
- [ ] Try the edge cases in `npm run chat`: discount requests, custom quotes, "are you a human?", off-topic,
      prompt-injection attempts, Hindi/Hinglish.
- [ ] Confirm an escalation email arrives and `/pause` works from an admin phone.

## Things to know

- Meta's 24-hour rule: free-form replies only within 24 hours of the customer's last message. v1 only ever
  replies to inbound messages, so this is fine. Outbound messages later will need approved templates.
- Storage is a JSON file: fine for one instance and a demo. Move to Postgres before running several instances.
