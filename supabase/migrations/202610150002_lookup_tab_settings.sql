alter table public.mw_google_settings
  add column if not exists products_tab text not null default 'data',
  add column if not exists outgoing_departments_tab text not null default 'area',
  add column if not exists incoming_departments_tab text not null default 'area',
  add column if not exists suppliers_tab text not null default 'dd';
