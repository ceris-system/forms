revoke all on function public.submit_request(text, text, text, text, jsonb)
  from public, anon, authenticated;

drop function public.submit_request(text, text, text, text, jsonb);

notify pgrst, 'reload schema';
