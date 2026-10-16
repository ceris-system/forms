alter table public.login_usernames
  add column if not exists role text not null default 'user',
  add column if not exists allowed_form_types text[] not null default array[
    'release-request',
    'transfer',
    'pull-out',
    'purchase-order'
  ]::text[];

alter table public.login_usernames
  drop constraint if exists login_usernames_role_check;

alter table public.login_usernames
  add constraint login_usernames_role_check
  check (role in ('user', 'admin'));

alter table public.login_usernames
  drop constraint if exists login_usernames_allowed_form_types_check;

alter table public.login_usernames
  add constraint login_usernames_allowed_form_types_check
  check (
    cardinality(allowed_form_types) between 1 and 4
    and allowed_form_types <@ array[
      'release-request',
      'transfer',
      'pull-out',
      'purchase-order'
    ]::text[]
  );
