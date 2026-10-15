alter table public.login_usernames
  add column if not exists department text not null default '',
  add column if not exists status text not null default 'active'
    check (status in ('active', 'default'));
