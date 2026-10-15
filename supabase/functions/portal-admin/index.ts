import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function spreadsheetIdFromUrl(value: unknown): { id: string; url: string } {
  const urlText = typeof value === "string" ? value.trim() : "";
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Enter a valid Google Sheets spreadsheet URL.");
  }
  const match = url.hostname === "docs.google.com"
    ? url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)
    : null;
  if (url.protocol !== "https:" || !match) {
    throw new Error("Use the full HTTPS URL of a Google Sheets spreadsheet.");
  }
  return { id: match[1], url: `https://docs.google.com/spreadsheets/d/${match[1]}/edit` };
}

function validOutputTab(value: unknown): string {
  const tab = typeof value === "string" ? value.trim() : "";
  if (!tab || tab.length > 100 || /[:\\/?*\[\]\r\n]/.test(tab)) {
    throw new Error("Enter a valid Google Sheets tab name (1–100 characters).");
  }
  return tab;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Portal admin function is missing required Supabase secrets.");
    return respond({ error: "Portal administration is not configured." }, 500);
  }

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!token) return respond({ error: "Sign in to continue." }, 401);

  try {
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return respond({ error: "Your sign-in session is invalid. Sign in again." }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: admin, error: adminError } = await adminClient
      .from("mw_portal_admins")
      .select("user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();
    if (adminError) throw adminError;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Enter a valid administration request." }, 400);
    }

    if (body.action === "status") return respond({ is_master_admin: Boolean(admin) });
    if (body.action === "profile") {
      const { data: profile, error } = await adminClient
        .from("login_usernames")
        .select("username, department, status")
        .eq("user_id", authData.user.id)
        .maybeSingle();
      if (error) throw error;
      if (!profile) return respond({ error: "Your account profile could not be found." }, 404);
      return respond(profile);
    }
    if (body.action === "complete_password_change") {
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8 || password.length > 256) {
        return respond({ error: "New password must be between 8 and 256 characters." }, 400);
      }
      if (authData.user.user_metadata?.must_change_password !== false) {
        const { error: passwordError } = await adminClient.auth.admin.updateUserById(authData.user.id, {
          password,
          user_metadata: { ...authData.user.user_metadata, must_change_password: false },
        });
        if (passwordError) throw passwordError;
      }
      const { error: statusError } = await adminClient
        .from("login_usernames")
        .update({ status: "active" })
        .eq("user_id", authData.user.id);
      if (statusError) throw statusError;
      return respond({ ok: true });
    }
    if (!admin) return respond({ error: "Master Admin access is required." }, 403);

    if (body.action === "reset_request_history") {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: deletedRequests, error } = await userClient.rpc("reset_request_history");
      if (error) throw error;
      return respond({ ok: true, deleted_requests: Number(deletedRequests) });
    }

    if (body.action === "state") {
      const [settingsResult, usersResult, assignmentsResult] = await Promise.all([
        adminClient.from("mw_google_settings")
          .select("spreadsheet_url, products_tab, outgoing_departments_tab, incoming_departments_tab, suppliers_tab")
          .eq("singleton", true)
          .maybeSingle(),
        adminClient.from("login_usernames").select("user_id, username, department, status").order("username"),
        adminClient.from("mw_sheet_assignments").select("user_id, output_tab"),
      ]);
      if (settingsResult.error) throw settingsResult.error;
      if (usersResult.error) throw usersResult.error;
      if (assignmentsResult.error) throw assignmentsResult.error;
      return respond({
        spreadsheet_url: settingsResult.data?.spreadsheet_url || "",
        products_tab: settingsResult.data?.products_tab || "data",
        outgoing_departments_tab: settingsResult.data?.outgoing_departments_tab || "area",
        incoming_departments_tab: settingsResult.data?.incoming_departments_tab || "area",
        suppliers_tab: settingsResult.data?.suppliers_tab || "dd",
        users: usersResult.data || [],
        assignments: assignmentsResult.data || [],
      });
    }

    if (body.action === "create_user") {
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const department = typeof body.department === "string" ? body.department.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const status = body.status === "active" ? "active" : body.status === "default" ? "default" : "";
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return respond({ error: "Username must be 3–32 letters, numbers, periods, underscores, or hyphens." }, 400);
      }
      if (!department || department.length > 100) return respond({ error: "Enter a department (up to 100 characters)." }, 400);
      if (!status) return respond({ error: "Choose Active or Default status." }, 400);
      if (password.length < 6 || password.length > 256) {
        return respond({ error: "Initial password must be between 6 and 256 characters." }, 400);
      }

      const { data: existingUsername, error: usernameError } = await adminClient
        .from("login_usernames")
        .select("user_id")
        .eq("username", username)
        .maybeSingle();
      if (usernameError) throw usernameError;
      if (existingUsername) return respond({ error: "That username is already in use." }, 409);

      const email = `${username}@mw-f-v2.invalid`;
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          portal_username: username,
          department,
          must_change_password: status === "default",
        },
      });
      if (createError) throw createError;
      if (!created.user) throw new Error("Supabase did not return the created user account.");

      const { error: mappingError } = await adminClient
        .from("login_usernames")
        .insert({ username, user_id: created.user.id, department, status });
      if (mappingError) {
        const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
        if (cleanupError) {
          throw new Error(`The account was created but its username could not be saved (${mappingError.message}); automatic account cleanup failed (${cleanupError.message}). Remove the new Auth user manually.`);
        }
        if (mappingError.code === "23505") {
          return respond({ error: "That username or email is already linked to another portal account." }, 409);
        }
        throw new Error(`The portal username could not be saved, so the new Auth account was removed: ${mappingError.message}`);
      }

      return respond({ ok: true, username, department, status, user_id: created.user.id }, 201);
    }

    if (body.action === "save_workbook") {
      const spreadsheet = spreadsheetIdFromUrl(body.spreadsheet_url);
      const productsTab = validOutputTab(body.products_tab);
      const outgoingDepartmentsTab = validOutputTab(body.outgoing_departments_tab);
      const incomingDepartmentsTab = validOutputTab(body.incoming_departments_tab);
      const suppliersTab = validOutputTab(body.suppliers_tab);
      const { error } = await adminClient.from("mw_google_settings").upsert({
        singleton: true,
        spreadsheet_id: spreadsheet.id,
        spreadsheet_url: spreadsheet.url,
        products_tab: productsTab,
        outgoing_departments_tab: outgoingDepartmentsTab,
        incoming_departments_tab: incomingDepartmentsTab,
        suppliers_tab: suppliersTab,
        updated_by: authData.user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "singleton" });
      if (error) throw error;
      return respond({
        ok: true,
        spreadsheet_url: spreadsheet.url,
        products_tab: productsTab,
        outgoing_departments_tab: outgoingDepartmentsTab,
        incoming_departments_tab: incomingDepartmentsTab,
        suppliers_tab: suppliersTab,
      });
    }

    if (body.action === "save_assignment") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return respond({ error: "Choose a valid user account." }, 400);
      const { data: account, error: accountError } = await adminClient
        .from("login_usernames").select("user_id, username, department").eq("user_id", userId).maybeSingle();
      if (accountError) throw accountError;
      if (!account) return respond({ error: "That account has no portal username." }, 404);

      const outputTab = typeof body.output_tab === "string" ? body.output_tab.trim() : "";
      if (!outputTab) {
        const { error } = await adminClient.from("mw_sheet_assignments").delete().eq("user_id", userId);
        if (error) throw error;
        return respond({ ok: true, department: account.department || "", output_tab: "" });
      }
      const tab = validOutputTab(outputTab);
      const { error } = await adminClient.from("mw_sheet_assignments").upsert({
        user_id: userId,
        output_tab: tab,
        updated_by: authData.user.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error?.code === "23505") return respond({ error: "That output tab is already assigned to another user." }, 409);
      if (error) throw error;
      return respond({ ok: true, department: account.department || "", output_tab: tab });
    }

    return respond({ error: "Unknown administration action." }, 400);
  } catch (error) {
    console.error("Portal administration request failed.", error);
    return respond({ error: error instanceof Error ? error.message : "Portal administration failed." }, 500);
  }
});
