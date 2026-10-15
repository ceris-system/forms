import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Username login function is missing required Supabase secrets.");
    return jsonResponse({ error: "Username sign-in is not configured. Contact your administrator." }, 500);
  }

  let username = "";
  let password = "";
  try {
    const body = await request.json();
    username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return jsonResponse({ error: "Enter a valid username and password." }, 400);
  }
  if (!/^[a-z0-9._-]{3,32}$/.test(username) || password.length < 1 || password.length > 256) {
    return jsonResponse({ error: "Enter a valid username and password." }, 400);
  }

  try {
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: account, error: lookupError } = await adminClient
      .from("login_usernames")
      .select("user_id, department, status")
      .eq("username", username)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (!account) {
      await authClient.auth.signInWithPassword({
        email: "unknown-user@invalid.invalid",
        password,
      });
      return jsonResponse({ error: "Invalid username or password." }, 401);
    }
    if (account.status !== "active" && account.status !== "default") {
      return jsonResponse({ error: "This portal account is not active. Contact your administrator." }, 403);
    }

    const { data, error } = await authClient.auth.signInWithPassword({
      email: await getAccountEmail(adminClient, account.user_id),
      password,
    });
    if (error || !data.session) return jsonResponse({ error: "Invalid username or password." }, 401);

    return jsonResponse({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      username,
      department: account.department || "",
      must_change_password: account.status === "default",
    });
  } catch (error) {
    console.error("Username sign-in failed.", error);
    return jsonResponse({ error: "Username sign-in is temporarily unavailable. Contact your administrator." }, 500);
  }
});

async function getAccountEmail(client: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await client.auth.admin.getUserById(userId);
  if (error || !data.user?.email) throw error || new Error("The username is not linked to an email account.");
  return data.user.email;
}
