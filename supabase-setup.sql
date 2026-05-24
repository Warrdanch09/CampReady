-- ============================================================
-- CampReady — Supabase Setup
-- Run this in your Supabase project's SQL Editor.
-- Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- 1. Create the user_data table
--    Each user gets one row. All app state is stored as JSONB.
create table if not exists public.user_data (
  id          uuid        references auth.users on delete cascade primary key,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 2. Enable Row Level Security so users only see their own data
alter table public.user_data enable row level security;

-- 3. RLS policies
create policy "Users can read their own data"
  on public.user_data for select
  using (auth.uid() = id);

create policy "Users can insert their own data"
  on public.user_data for insert
  with check (auth.uid() = id);

create policy "Users can update their own data"
  on public.user_data for update
  using (auth.uid() = id);

create policy "Users can delete their own data"
  on public.user_data for delete
  using (auth.uid() = id);

-- 4. Auto-update the updated_at timestamp on every write
create or replace function public.handle_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.user_data;
create trigger set_updated_at
  before update on public.user_data
  for each row execute function public.handle_updated_at();

-- ============================================================
-- Done. Your Supabase project is ready for CampReady.
-- ============================================================
