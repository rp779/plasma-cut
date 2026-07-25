-- Plasma Cut public leaderboard
-- Run in the Supabase SQL editor for your project.

create table if not exists public.scores (
  nickname text primary key,
  score integer not null check (score >= 0),
  level integer not null check (level >= 1 and level <= 12),
  updated_at timestamptz not null default now()
);

create index if not exists scores_score_desc_idx on public.scores (score desc);

alter table public.scores enable row level security;

-- No direct client access; Netlify Functions use the service role key.
-- Optional read-only policy if you ever query from the browser with the anon key:
-- create policy "Public read scores" on public.scores for select using (true);
