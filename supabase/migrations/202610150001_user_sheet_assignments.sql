create table if not exists public.mw_portal_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.mw_google_settings (
  singleton boolean primary key default true check (singleton),
  spreadsheet_id text not null,
  spreadsheet_url text not null,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.mw_sheet_assignments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  output_tab text not null check (
    length(trim(output_tab)) between 1 and 100
    and output_tab !~ '[:\\/?*\[\]\r\n]'
  ),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists mw_sheet_assignments_output_tab_unique
  on public.mw_sheet_assignments (lower(output_tab));

alter table public.mw_portal_admins enable row level security;
alter table public.mw_google_settings enable row level security;
alter table public.mw_sheet_assignments enable row level security;

revoke all on public.mw_portal_admins, public.mw_google_settings, public.mw_sheet_assignments
  from public, anon, authenticated;
grant all on public.mw_portal_admins, public.mw_google_settings, public.mw_sheet_assignments
  to service_role;
