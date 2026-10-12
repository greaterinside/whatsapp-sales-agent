-- WhatsApp agent storage. Run once in Supabase: SQL Editor -> New query -> paste this file -> Run.
-- Safe to re-run. Tables are prefixed wa_ so they can share a project with other apps.
-- The bot only calls the wa_* functions below, using the service role key (server side only).

create table if not exists wa_conversations (
  phone             text primary key,          -- digits only, e.g. 919876543210
  contact_name      text,                      -- WhatsApp profile name
  lead_name         text not null default '',  -- only what the customer actually said
  lead_company      text not null default '',
  lead_requirement  text not null default '',
  turns             jsonb not null default '[]'::jsonb,  -- [{role, text, at}]
  last_escalated_at timestamptz,
  paused            boolean not null default false,      -- a human is handling this number
  paused_at         timestamptz,
  updated_at        timestamptz not null default now()
);

create table if not exists wa_processed_messages (
  id text primary key,  -- WhatsApp message id; stops webhook retries being answered twice
  at timestamptz not null default now()
);
create index if not exists wa_processed_messages_at on wa_processed_messages (at);

create table if not exists wa_locks (
  phone      text primary key,  -- one customer's messages are answered one at a time
  token      text not null,
  expires_at timestamptz not null
);

-- No policies: only the service role (which bypasses RLS) can read or write these tables.
alter table wa_conversations enable row level security;
alter table wa_processed_messages enable row level security;
alter table wa_locks enable row level security;

create or replace function wa_get_conversation(p_phone text) returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'phone', p_phone,
    'contactName', c.contact_name,
    'turns', coalesce(c.turns, '[]'::jsonb),
    'lead', jsonb_build_object(
      'name', coalesce(c.lead_name, ''),
      'company', coalesce(c.lead_company, ''),
      'requirement', coalesce(c.lead_requirement, '')),
    'paused', coalesce(c.paused, false),
    'pausedAt', c.paused_at,
    'lastEscalatedAt', c.last_escalated_at))
  from (select p_phone) as p(phone)
  left join wa_conversations c on c.phone = p.phone
$$;

-- Saves history, lead and escalation time. Never touches paused, so saving a reply can't undo a pause.
create or replace function wa_save_conversation(p jsonb) returns void language sql as $$
  insert into wa_conversations as c
    (phone, contact_name, lead_name, lead_company, lead_requirement, turns, last_escalated_at, updated_at)
  values (
    p->>'phone', p->>'contactName',
    coalesce(p->'lead'->>'name', ''), coalesce(p->'lead'->>'company', ''), coalesce(p->'lead'->>'requirement', ''),
    coalesce(p->'turns', '[]'::jsonb), (p->>'lastEscalatedAt')::timestamptz, now())
  on conflict (phone) do update set
    contact_name = excluded.contact_name,
    lead_name = excluded.lead_name,
    lead_company = excluded.lead_company,
    lead_requirement = excluded.lead_requirement,
    turns = excluded.turns,
    last_escalated_at = excluded.last_escalated_at,
    updated_at = now()
$$;

create or replace function wa_list_conversations() returns setof jsonb language sql stable as $$
  select wa_get_conversation(phone) from wa_conversations order by updated_at desc
$$;

create or replace function wa_set_paused(p_phone text, p_paused boolean) returns jsonb language sql as $$
  insert into wa_conversations as c (phone, paused, paused_at)
  values (p_phone, p_paused, case when p_paused then now() end)
  on conflict (phone) do update set paused = excluded.paused, paused_at = excluded.paused_at;
  select wa_get_conversation(p_phone);
$$;

create or replace function wa_paused_phones() returns setof text language sql stable as $$
  select phone from wa_conversations where paused order by paused_at
$$;

-- True the first time a message id is seen. Also forgets ids older than 7 days.
create or replace function wa_mark_processed(p_id text) returns boolean language plpgsql as $$
begin
  delete from wa_processed_messages where at < now() - interval '7 days';
  insert into wa_processed_messages (id) values (p_id) on conflict (id) do nothing;
  return found;
end
$$;

-- True if this caller now holds the lock (free, or the previous holder's lock expired).
create or replace function wa_acquire_lock(p_phone text, p_token text, p_ttl_ms integer) returns boolean
language plpgsql as $$
begin
  insert into wa_locks as l (phone, token, expires_at)
  values (p_phone, p_token, now() + p_ttl_ms * interval '1 millisecond')
  on conflict (phone) do update set token = excluded.token, expires_at = excluded.expires_at
    where l.expires_at < now();
  return found;
end
$$;

create or replace function wa_release_lock(p_phone text, p_token text) returns void language sql as $$
  delete from wa_locks where phone = p_phone and token = p_token
$$;

-- Only the server (service role) may use these; not the public anon key. Granted explicitly so it works
-- even when the project has "Automatically expose new tables" turned off.
do $$
declare f text;
begin
  if exists (select from pg_roles where rolname = 'service_role') then
    revoke all on wa_conversations, wa_processed_messages, wa_locks from anon, authenticated;
    grant select, insert, update, delete on wa_conversations, wa_processed_messages, wa_locks to service_role;
    foreach f in array array[
      'wa_get_conversation(text)', 'wa_save_conversation(jsonb)', 'wa_list_conversations()',
      'wa_set_paused(text, boolean)', 'wa_paused_phones()', 'wa_mark_processed(text)',
      'wa_acquire_lock(text, text, integer)', 'wa_release_lock(text, text)'
    ] loop
      execute format('revoke execute on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end
$$;
