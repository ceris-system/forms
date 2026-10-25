alter table public.mw_google_settings
  drop constraint if exists mw_google_settings_updated_by_fkey;

alter table public.mw_sheet_assignments
  drop constraint if exists mw_sheet_assignments_updated_by_fkey;
