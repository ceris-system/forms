create table if not exists public.mw_form_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  request_number text not null,
  form_type text not null check (form_type in ('release-request', 'transfer', 'pull-out', 'purchase-order')),
  event text not null check (event in ('submitted', 'approved', 'released', 'received')),
  title text not null,
  message text not null,
  destination_page text not null check (
    destination_page in ('approvals', 'pending-release', 'pending-received', 'my-requests')
  ),
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists mw_form_notifications_recipient_created_idx
  on public.mw_form_notifications (recipient_id, created_at desc);

create index if not exists mw_form_notifications_recipient_unread_idx
  on public.mw_form_notifications (recipient_id, is_read, created_at desc);

alter table public.mw_form_notifications enable row level security;
revoke all on public.mw_form_notifications from public, anon, authenticated;
grant all on public.mw_form_notifications to service_role;
