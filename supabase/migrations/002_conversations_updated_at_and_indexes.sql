-- Add updated_at to conversations (queried by dashboard for "last active")
alter table public.conversations
  add column updated_at timestamptz not null default now();

-- Keep updated_at current whenever a message is inserted
create or replace function public.touch_conversation_updated_at()
returns trigger language plpgsql as $$
begin
  update public.conversations
     set updated_at = now()
   where id = NEW.conversation_id;
  return NEW;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute procedure public.touch_conversation_updated_at();

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

-- conversations looked up by site (dashboard list, stats count)
create index conversations_site_id_idx
  on public.conversations (site_id, created_at desc);

-- messages looked up by conversation (history load on every chat request)
create index messages_conversation_id_idx
  on public.messages (conversation_id, created_at asc);

-- agent_actions looked up by site + success (past-actions context injection)
create index agent_actions_site_id_success_idx
  on public.agent_actions (site_id, success, created_at desc);
