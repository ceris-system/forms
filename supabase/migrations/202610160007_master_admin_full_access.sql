update public.login_usernames as profile
set
  role = 'admin',
  allowed_form_types = array[
    'release-request',
    'transfer',
    'pull-out',
    'purchase-order'
  ]::text[]
from public.mw_portal_admins as master_admin
where master_admin.user_id = profile.user_id;
