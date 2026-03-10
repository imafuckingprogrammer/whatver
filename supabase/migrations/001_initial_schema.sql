-- Enable required extensions
create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

create table public.sites (
  id         uuid        primary key default uuid_generate_v4(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  name       text        not null,
  domain     text        not null,
  site_key   text        not null unique default encode(gen_random_bytes(16), 'hex'),
  config     jsonb       not null default '{}',
  created_at timestamptz not null default now()
);

create table public.conversations (
  id             uuid        primary key default uuid_generate_v4(),
  site_id        uuid        not null references public.sites(id) on delete cascade,
  visitor_id     text        not null,
  status         text        not null default 'active',
  created_at     timestamptz not null default now()
);

create table public.messages (
  id              uuid        primary key default uuid_generate_v4(),
  conversation_id uuid        not null references public.conversations(id) on delete cascade,
  role            text        not null check (role in ('user', 'assistant', 'action')),
  content         text        not null,
  metadata        jsonb       not null default '{}',
  created_at      timestamptz not null default now()
);

create table public.agent_actions (
  id               uuid        primary key default uuid_generate_v4(),
  site_id          uuid        not null references public.sites(id) on delete cascade,
  task_description text        not null,
  steps            jsonb       not null,
  success          boolean     not null,
  created_at       timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────

alter table public.sites           enable row level security;
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.agent_actions   enable row level security;

-- sites: owner full access
create policy "sites: owner select"
  on public.sites for select
  using (auth.uid() = user_id);

create policy "sites: owner insert"
  on public.sites for insert
  with check (auth.uid() = user_id);

create policy "sites: owner update"
  on public.sites for update
  using (auth.uid() = user_id);

create policy "sites: owner delete"
  on public.sites for delete
  using (auth.uid() = user_id);

-- conversations: accessible if the parent site belongs to the user
create policy "conversations: owner select"
  on public.conversations for select
  using (
    exists (
      select 1 from public.sites
      where sites.id = conversations.site_id
        and sites.user_id = auth.uid()
    )
  );

create policy "conversations: owner insert"
  on public.conversations for insert
  with check (
    exists (
      select 1 from public.sites
      where sites.id = conversations.site_id
        and sites.user_id = auth.uid()
    )
  );

create policy "conversations: owner update"
  on public.conversations for update
  using (
    exists (
      select 1 from public.sites
      where sites.id = conversations.site_id
        and sites.user_id = auth.uid()
    )
  );

create policy "conversations: owner delete"
  on public.conversations for delete
  using (
    exists (
      select 1 from public.sites
      where sites.id = conversations.site_id
        and sites.user_id = auth.uid()
    )
  );

-- messages: accessible if the parent conversation's site belongs to the user
create policy "messages: owner select"
  on public.messages for select
  using (
    exists (
      select 1
      from public.conversations c
      join public.sites s on s.id = c.site_id
      where c.id = messages.conversation_id
        and s.user_id = auth.uid()
    )
  );

create policy "messages: owner insert"
  on public.messages for insert
  with check (
    exists (
      select 1
      from public.conversations c
      join public.sites s on s.id = c.site_id
      where c.id = messages.conversation_id
        and s.user_id = auth.uid()
    )
  );

-- agent_actions: accessible if the parent site belongs to the user
create policy "agent_actions: owner select"
  on public.agent_actions for select
  using (
    exists (
      select 1 from public.sites
      where sites.id = agent_actions.site_id
        and sites.user_id = auth.uid()
    )
  );

create policy "agent_actions: owner insert"
  on public.agent_actions for insert
  with check (
    exists (
      select 1 from public.sites
      where sites.id = agent_actions.site_id
        and sites.user_id = auth.uid()
    )
  );
