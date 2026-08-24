-- Meteor projects — Supabase table with prefix meteor_
-- Run this in Supabase Dashboard > SQL Editor
-- https://app.supabase.com/project/ikjugnimawkoatkbvpgk/sql/new

create table if not exists public.meteor_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  folder_path text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_message text,
  preview text,
  message_count integer default 0
);

alter table public.meteor_projects enable row level security;

drop policy if exists "Users manage own projects" on public.meteor_projects;
create policy "Users manage own projects"
  on public.meteor_projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_meteor_projects_user_updated
  on public.meteor_projects(user_id, updated_at desc);

-- Optional: messages per project (file fallback also works if this table missing)
create table if not exists public.meteor_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null, -- references meteor_projects.id
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system','tool')),
  content text,
  tool_calls jsonb,
  tool_call_id text,
  order_index integer default 0,
  created_at timestamptz default now()
);

alter table public.meteor_messages enable row level security;

drop policy if exists "Users manage own messages" on public.meteor_messages;
create policy "Users manage own messages"
  on public.meteor_messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_meteor_messages_chat_order
  on public.meteor_messages(chat_id, order_index);
