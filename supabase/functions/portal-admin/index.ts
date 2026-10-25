import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const allowedFormTypes = ["release-request", "transfer", "pull-out", "purchase-order"];

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
    const [adminResult, profileResult] = await Promise.all([
      adminClient.from("mw_portal_admins")
        .select("user_id")
        .eq("user_id", authData.user.id)
        .maybeSingle(),
      adminClient.from("login_usernames")
        .select("username, department, status, role, allowed_form_types")
        .eq("user_id", authData.user.id)
        .maybeSingle(),
    ]);
    if (adminResult.error) throw adminResult.error;
    if (profileResult.error) throw profileResult.error;
    const admin = adminResult.data;
    const currentProfile = profileResult.data;
    const isMasterAdmin = Boolean(admin);
    const isAdmin = isMasterAdmin || String(currentProfile?.role || "").toLocaleLowerCase() === "admin";

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Enter a valid administration request." }, 400);
    }

    if (body.action === "status") return respond({ is_master_admin: isMasterAdmin, is_admin: isAdmin });
    if (body.action === "profile") {
      if (!currentProfile) return respond({ error: "Your account profile could not be found." }, 404);
      return respond({
        ...currentProfile,
        is_admin: isAdmin,
        is_master_admin: isMasterAdmin,
        allowed_form_types: isAdmin ? allowedFormTypes : currentProfile.allowed_form_types,
      });
    }
    if (body.action === "notifications_count") {
      const { count, error } = await adminClient.from("mw_form_notifications")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", authData.user.id)
        .eq("is_read", false);
      if (error) throw error;
      return respond({ unread_count: count || 0 });
    }
    if (body.action === "notifications_list") {
      const requestedOffset = Number(body.offset ?? 0);
      if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 100_000) {
        return respond({ error: "The notification page is invalid." }, 400);
      }
      const [notificationsResult, unreadResult] = await Promise.all([
        adminClient.from("mw_form_notifications")
          .select("id, request_number, form_type, event, title, message, destination_page, is_read, created_at")
          .eq("recipient_id", authData.user.id)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(requestedOffset, requestedOffset + 50),
        adminClient.from("mw_form_notifications")
          .select("id", { count: "exact", head: true })
          .eq("recipient_id", authData.user.id)
          .eq("is_read", false),
      ]);
      if (notificationsResult.error) throw notificationsResult.error;
      if (unreadResult.error) throw unreadResult.error;
      return respond({
        notifications: (notificationsResult.data || []).slice(0, 50),
        has_more: (notificationsResult.data || []).length > 50,
        unread_count: unreadResult.count || 0,
      });
    }
    if (body.action === "notification_mark_read") {
      const notificationId = typeof body.notification_id === "string" ? body.notification_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(notificationId)) {
        return respond({ error: "Choose a valid notification." }, 400);
      }
      const { data: notification, error } = await adminClient
        .from("mw_form_notifications")
        .update({ is_read: true })
        .eq("id", notificationId)
        .eq("recipient_id", authData.user.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!notification) return respond({ error: "That notification was not found in your inbox." }, 404);
      return respond({ ok: true });
    }
    if (body.action === "notification_delete") {
      const notificationId = typeof body.notification_id === "string" ? body.notification_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(notificationId)) {
        return respond({ error: "Choose a valid notification." }, 400);
      }
      const { data: notification, error } = await adminClient
        .from("mw_form_notifications")
        .delete()
        .eq("id", notificationId)
        .eq("recipient_id", authData.user.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!notification) return respond({ error: "That notification was not found in your inbox." }, 404);
      return respond({ ok: true });
    }
    if (body.action === "notifications_mark_all_read") {
      const { error } = await adminClient
        .from("mw_form_notifications")
        .update({ is_read: true })
        .eq("recipient_id", authData.user.id)
        .eq("is_read", false);
      if (error) throw error;
      return respond({ ok: true });
    }
    if (body.action === "activity_log_create") {
      const action = typeof body.activity === "string" ? body.activity.trim() : "";
      const details = typeof body.details === "string" ? body.details.trim() : "";
      const sessionId = typeof body.session_id === "string" ? body.session_id : "";
      if (!action || action.length > 120) return respond({ error: "Activity name must be 1–120 characters." }, 400);
      if (details.length > 500) return respond({ error: "Activity details must be 500 characters or fewer." }, 400);
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return respond({ error: "The activity session is invalid." }, 400);
      const { error } = await adminClient.from("mw_user_activity_logs").insert({
        user_id: authData.user.id,
        username: String(currentProfile?.username || authData.user.user_metadata?.portal_username || "Unknown user"),
        department: String(currentProfile?.department || authData.user.user_metadata?.department || ""),
        session_id: sessionId,
        action,
        details,
        succeeded: true,
      });
      if (error) throw error;
      return respond({ ok: true });
    }
    if (body.action === "activity_logs_read") {
      if (!isMasterAdmin) return respond({ error: "Only the Master Admin can view user activity logs." }, 403);
      const requestedOffset = Number(body.offset ?? 0);
      const requestedLimit = Number(body.limit ?? 100);
      const requestedUserId = typeof body.user_id === "string" ? body.user_id : "";
      if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 100_000) {
        return respond({ error: "The activity log page is invalid." }, 400);
      }
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1000) {
        return respond({ error: "The activity log page size is invalid." }, 400);
      }
      if (requestedUserId && !/^[0-9a-f-]{36}$/i.test(requestedUserId)) {
        return respond({ error: "Choose a valid user filter." }, 400);
      }
      let logsQuery = adminClient.from("mw_user_activity_logs")
        .select("id, user_id, username, department, session_id, action, details, succeeded, occurred_at")
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false });
      let userOptionsQuery = adminClient.from("mw_user_activity_logs")
        .select("user_id, username")
        .order("occurred_at", { ascending: false })
        .limit(2000);
      if (requestedUserId) logsQuery = logsQuery.eq("user_id", requestedUserId);
      const userOptionsPromise = requestedLimit > 100
        ? Promise.resolve({ data: [], error: null })
        : userOptionsQuery;
      const [logsResult, userOptionsResult] = await Promise.all([
        logsQuery.range(requestedOffset, requestedOffset + requestedLimit),
        userOptionsPromise,
      ]);
      if (logsResult.error) throw logsResult.error;
      if (userOptionsResult.error) throw userOptionsResult.error;
      const seenUsers = new Set<string>();
      const users = (userOptionsResult.data || []).flatMap(entry => {
        const userId = String(entry.user_id || "");
        if (!userId || seenUsers.has(userId)) return [];
        seenUsers.add(userId);
        return [{ user_id: userId, username: String(entry.username || "Unknown user") }];
      });
      const logs = logsResult.data || [];
      return respond({
        logs: logs.slice(0, requestedLimit),
        users,
        has_more: logs.length > requestedLimit,
      });
    }
    if (body.action === "activity_logs_delete") {
      if (!isMasterAdmin) return respond({ error: "Only the Master Admin can delete user activity logs." }, 403);
      if (!Array.isArray(body.log_ids) || body.log_ids.length < 1 || body.log_ids.length > 500) {
        return respond({ error: "Select between 1 and 500 activity logs to delete." }, 400);
      }
      const logIds = [...new Set(body.log_ids.map(value => String(value)))];
      if (logIds.some(id => !/^[1-9]\d{0,18}$/.test(id))) {
        return respond({ error: "The selected activity log IDs are invalid." }, 400);
      }
      const { data, error } = await adminClient
        .from("mw_user_activity_logs")
        .delete()
        .in("id", logIds)
        .select("id");
      if (error) throw error;
      return respond({
        ok: true,
        deleted_count: (data || []).length,
        deleted_ids: (data || []).map(entry => String(entry.id)),
      });
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
    if (!isAdmin) return respond({ error: "Admin access is required." }, 403);
    if ([
      "reset_request_history",
      "state",
      "create_user",
      "update_user",
      "delete_user",
      "save_workbook",
      "save_assignment",
    ].includes(String(body.action)) && !isMasterAdmin) {
      return respond({ error: "Only the Master Admin can manage users, roles, and portal settings." }, 403);
    }

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
      const [settingsResult, usersResult, assignmentsResult, masterAdminsResult] = await Promise.all([
        adminClient.from("mw_google_settings")
          .select("spreadsheet_url, products_tab, outgoing_departments_tab, incoming_departments_tab, suppliers_tab")
          .eq("singleton", true)
          .maybeSingle(),
        adminClient.from("login_usernames")
          .select("user_id, username, department, status, role, allowed_form_types")
          .order("username"),
        adminClient.from("mw_sheet_assignments").select("user_id, output_tab"),
        adminClient.from("mw_portal_admins").select("user_id, admin_type"),
      ]);
      if (settingsResult.error) throw settingsResult.error;
      if (usersResult.error) throw usersResult.error;
      if (assignmentsResult.error) throw assignmentsResult.error;
      if (masterAdminsResult.error) throw masterAdminsResult.error;
      const masterAdminTypes = new Map<string, string>(
        (masterAdminsResult.data || []).map(account => [
          String(account.user_id),
          String(account.admin_type || "master_admin"),
        ] as const),
      );
      return respond({
        spreadsheet_url: settingsResult.data?.spreadsheet_url || "",
        products_tab: settingsResult.data?.products_tab || "data",
        outgoing_departments_tab: settingsResult.data?.outgoing_departments_tab || "area",
        incoming_departments_tab: settingsResult.data?.incoming_departments_tab || "area",
        suppliers_tab: settingsResult.data?.suppliers_tab || "dd",
        users: (usersResult.data || []).map(account => ({
          ...account,
          is_master_admin: masterAdminTypes.has(String(account.user_id)),
          is_admin_user: masterAdminTypes.get(String(account.user_id)) === "admin_user",
        })),
        assignments: assignmentsResult.data || [],
      });
    }

    if (body.action === "create_user") {
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const department = typeof body.department === "string" ? body.department.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const status = body.status === "active" ? "active" : body.status === "default" ? "default" : "";
      const requestedRole = body.role === "admin" || body.role === "master_admin"
        ? body.role
        : body.role === "user" ? "user" : "";
      const isNewMasterAdmin = requestedRole === "master_admin";
      const role = isNewMasterAdmin ? "admin" : requestedRole;
      const requestedForms = Array.isArray(body.allowed_form_types)
        ? [...new Set(body.allowed_form_types.filter((value): value is string => typeof value === "string"))]
        : [];
      const formTypes = role === "admin" ? allowedFormTypes : requestedForms;
      if (!role) return respond({ error: "Choose a valid account role." }, 400);
      if (role === "admin" && !isMasterAdmin) {
        return respond({ error: "Only a Master Admin can grant Admin access." }, 403);
      }
      if (formTypes.length < 1 || formTypes.some(formType => !allowedFormTypes.includes(formType))) {
        return respond({ error: "Select at least one valid form for this user." }, 400);
      }
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
          role,
          allowed_form_types: formTypes,
          must_change_password: status === "default",
        },
      });
      if (createError) throw createError;
      if (!created.user) throw new Error("Supabase did not return the created user account.");

      const { error: mappingError } = await adminClient
        .from("login_usernames")
        .insert({ username, user_id: created.user.id, department, status, role, allowed_form_types: formTypes });
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

      if (isNewMasterAdmin) {
        const { error: masterAdminError } = await adminClient
          .from("mw_portal_admins")
          .insert({ user_id: created.user.id, admin_type: "admin_user" });
        if (masterAdminError) {
          const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
          if (cleanupError) {
            throw new Error(`The account was created but Master Admin access could not be saved (${masterAdminError.message}); automatic account cleanup failed (${cleanupError.message}). Remove the new account manually.`);
          }
          throw new Error(`Master Admin access could not be saved, so the new account was removed: ${masterAdminError.message}`);
        }
      }

      return respond({
        ok: true,
        username,
        department,
        status,
        role: isNewMasterAdmin ? "master_admin" : role,
        allowed_form_types: formTypes,
        user_id: created.user.id,
      }, 201);
    }

    if (body.action === "update_user") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return respond({ error: "Choose a valid user account." }, 400);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const department = typeof body.department === "string" ? body.department.trim() : "";
      const status = body.status === "active" ? "active" : body.status === "default" ? "default" : "";
      const requestedRole = body.role === "admin" ? "admin" : body.role === "user" ? "user" : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!department || department.length > 100) return respond({ error: "Choose a valid department." }, 400);
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return respond({ error: "Username must be 3–32 letters, numbers, periods, underscores, or hyphens." }, 400);
      }
      if (!status) return respond({ error: "Choose Active or Default status." }, 400);
      if (!requestedRole) return respond({ error: "Choose a valid account role." }, 400);
      if (password && (password.length < 8 || password.length > 256)) {
        return respond({ error: "New password must be between 8 and 256 characters." }, 400);
      }

      const { data: target, error: targetError } = await adminClient
        .from("login_usernames")
        .select("user_id, username, role, allowed_form_types")
        .eq("user_id", userId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target) return respond({ error: "That user account could not be found." }, 404);
      const { data: targetMasterAdmin, error: targetAdminError } = await adminClient
        .from("mw_portal_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (targetAdminError) throw targetAdminError;
      if (targetMasterAdmin && requestedRole !== "admin") {
        return respond({ error: "A Master Admin account cannot be changed to the User role." }, 409);
      }
      if (targetMasterAdmin && username !== target.username) {
        return respond({ error: "A Master Admin account's username cannot be changed here." }, 409);
      }
      if (targetMasterAdmin && (status !== "active" || password)) {
        return respond({ error: "A Master Admin account's status or password cannot be changed here." }, 409);
      }
      if (username !== target.username) {
        const { data: existingUsername, error: usernameError } = await adminClient
          .from("login_usernames")
          .select("user_id")
          .eq("username", username)
          .maybeSingle();
        if (usernameError) throw usernameError;
        if (existingUsername) return respond({ error: "That username is already in use." }, 409);
      }

      const requestedForms = Array.isArray(body.allowed_form_types)
        ? [...new Set(body.allowed_form_types.filter((value): value is string => typeof value === "string"))]
        : [];
      const formTypes = targetMasterAdmin || requestedRole === "admin" ? allowedFormTypes : requestedForms;
      if (formTypes.length < 1 || formTypes.some(formType => !allowedFormTypes.includes(formType))) {
        return respond({ error: "Select at least one valid form for this user." }, 400);
      }

      const role = targetMasterAdmin ? "admin" : requestedRole;
      const { error: updateError } = await adminClient
        .from("login_usernames")
        .update({ username, department, status, role, allowed_form_types: formTypes })
        .eq("user_id", userId);
      if (updateError) throw updateError;

      const authUpdate: {
        password?: string;
        user_metadata: Record<string, unknown>;
      } = {
        user_metadata: {
          portal_username: username,
          department,
          role,
          allowed_form_types: formTypes,
          must_change_password: status === "default",
        },
      };
      if (password) authUpdate.password = password;
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authUpdate);
      return respond({
        ok: true,
        username,
        department,
        status,
        role,
        allowed_form_types: formTypes,
        ...(authUpdateError
          ? { warning: `Account details were saved, but authentication settings could not be fully synchronized: ${authUpdateError.message}` }
          : {}),
      });
    }

    if (body.action === "delete_user") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return respond({ error: "Choose a valid user account." }, 400);
      if (userId === authData.user.id) {
        return respond({ error: "You cannot delete your own signed-in Master Admin account." }, 409);
      }
      const { data: target, error: targetError } = await adminClient
        .from("login_usernames")
        .select("user_id, username")
        .eq("user_id", userId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target) return respond({ error: "That user account could not be found." }, 404);
      const { data: targetMasterAdmin, error: targetAdminError } = await adminClient
        .from("mw_portal_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (targetAdminError) throw targetAdminError;
      if (targetMasterAdmin) {
        const { count, error: countError } = await adminClient
          .from("mw_portal_admins")
          .select("user_id", { count: "exact", head: true });
        if (countError) throw countError;
        if ((count || 0) <= 1) {
          return respond({ error: "The last remaining Master Admin account cannot be deleted." }, 409);
        }
      }
      const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
      if (deleteError) throw deleteError;
      return respond({ ok: true, username: target.username });
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
