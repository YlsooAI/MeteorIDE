-- ==============================================================================
-- Meteor Supabase Database Schema
-- All tables are strictly prefixed with "meteor_"
-- Run this in your Supabase Dashboard > SQL Editor:
-- https://supabase.com/dashboard/project/_/sql/new
-- ==============================================================================

-- Enable UUID extension if not already available
create extension if not exists "pgcrypto";

-- ==============================================================================
-- 1. METEOR_PROFILES TABLE (User profiles synced with Supabase Auth)
-- ==============================================================================
create table if not exists public.meteor_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  full_name text,
  avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.meteor_profiles enable row level security;

drop policy if exists "Meteor profiles are viewable by everyone or authenticated users" on public.meteor_profiles;
create policy "Meteor profiles are viewable by everyone or authenticated users"
  on public.meteor_profiles for select
  using (true);

drop policy if exists "Users can insert their own meteor profile" on public.meteor_profiles;
create policy "Users can insert their own meteor profile"
  on public.meteor_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update their own meteor profile" on public.meteor_profiles;
create policy "Users can update their own meteor profile"
  on public.meteor_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Trigger to automatically populate meteor_profiles when a user signs up
create or replace function public.handle_meteor_new_user()
returns trigger as $$
begin
  insert into public.meteor_profiles (id, email, username, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'avatar_url', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    avatar_url = coalesce(nullif(excluded.avatar_url, ''), public.meteor_profiles.avatar_url),
    full_name = coalesce(nullif(excluded.full_name, ''), public.meteor_profiles.full_name);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created_meteor on auth.users;
create trigger on_auth_user_created_meteor
  after insert on auth.users
  for each row execute function public.handle_meteor_new_user();

-- ==============================================================================
-- 2. METEOR_PROJECTS TABLE
-- ==============================================================================
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

drop policy if exists "Users manage own meteor projects" on public.meteor_projects;
create policy "Users manage own meteor projects"
  on public.meteor_projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_meteor_projects_user_updated
  on public.meteor_projects(user_id, updated_at desc);

-- ==============================================================================
-- 3. METEOR_MESSAGES TABLE (Chat history per project)
-- ==============================================================================
create table if not exists public.meteor_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.meteor_projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text,
  tool_calls jsonb,
  tool_call_id text,
  order_index integer default 0,
  created_at timestamptz default now()
);

alter table public.meteor_messages enable row level security;

drop policy if exists "Users manage own meteor messages" on public.meteor_messages;
create policy "Users manage own meteor messages"
  on public.meteor_messages for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_meteor_messages_chat_order
  on public.meteor_messages(chat_id, order_index);

-- ==============================================================================
-- 4. METEOR_USER_QUOTAS TABLE (1 Million tokens / 5 hours window)
-- ==============================================================================
create table if not exists public.meteor_user_quotas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tokens_used bigint not null default 0,
  window_start timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  total_tokens_lifetime bigint not null default 0
);

alter table public.meteor_user_quotas enable row level security;

drop policy if exists "Users can view own meteor quota" on public.meteor_user_quotas;
create policy "Users can view own meteor quota"
  on public.meteor_user_quotas for select
  using (auth.uid() = user_id);

drop policy if exists "Users can modify own meteor quota" on public.meteor_user_quotas;
create policy "Users can modify own meteor quota"
  on public.meteor_user_quotas for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Stored procedure to atomically check and consume token quota in the 5-hour window
create or replace function public.consume_meteor_tokens(
  p_tokens integer,
  p_max_limit bigint default 1000000,
  p_window_hours integer default 5
)
returns jsonb as $$
declare
  v_uid uuid := auth.uid();
  v_rec record;
  v_now timestamptz := now();
  v_window_interval interval := (p_window_hours || ' hours')::interval;
  v_allowed boolean;
  v_new_used bigint;
  v_window_start timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'error', 'Unauthenticated');
  end if;

  -- Lock user quota row for atomic update, or insert default if new
  insert into public.meteor_user_quotas (user_id, tokens_used, window_start, last_used_at, total_tokens_lifetime)
  values (v_uid, 0, v_now, v_now, 0)
  on conflict (user_id) do nothing;

  select * into v_rec from public.meteor_user_quotas
  where user_id = v_uid for update;

  -- Check if 5-hour window has expired; reset if true
  if (v_now - v_rec.window_start) >= v_window_interval then
    v_window_start := v_now;
    v_new_used := 0;
  else
    v_window_start := v_rec.window_start;
    v_new_used := v_rec.tokens_used;
  end if;

  -- Check limit
  if (v_new_used + p_tokens) <= p_max_limit then
    v_allowed := true;
    v_new_used := v_new_used + p_tokens;

    update public.meteor_user_quotas
    set
      tokens_used = v_new_used,
      window_start = v_window_start,
      last_used_at = v_now,
      total_tokens_lifetime = total_tokens_lifetime + p_tokens
    where user_id = v_uid;
  else
    v_allowed := false;
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'tokens_used', v_new_used,
    'limit', p_max_limit,
    'remaining', greatest(0, p_max_limit - v_new_used),
    'reset_at', v_window_start + v_window_interval,
    'window_start', v_window_start
  );
end;
$$ language plpgsql security definer;
