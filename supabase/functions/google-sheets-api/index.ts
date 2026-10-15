import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const requestHeaders = [
  "Request Number", "Form Type", "Request Date", "Outgoing Department",
  "Incoming Department", "Supplier", "Submitted By", "SKU Code",
  "Product Description", "UOM", "Expiration Date", "Onhand",
  "Total Onhand", "Cost", "SRP", "Transfer Qty", "Remarks", "Supabase Request ID",
  "Sequence Number",
];

function respond(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodePrivateKey(pem: string): Uint8Array {
  const encoded = pem.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

let cachedGoogleToken = "";
let googleTokenExpiresAt = 0;

async function getGoogleAccessToken(): Promise<string> {
  if (cachedGoogleToken && Date.now() < googleTokenExpiresAt - 60_000) return cachedGoogleToken;
  const email = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  if (!email || !privateKey) throw new Error("Google service account is not configured in Supabase secrets.");

  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  }))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePrivateKey(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.error_description || "Google service-account authorization failed.");
  }
  cachedGoogleToken = result.access_token;
  googleTokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  return cachedGoogleToken;
}

async function googleRequest(path: string, options: RequestInit = {}): Promise<Record<string, any>> {
  const token = await getGoogleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "Google Sheets request failed.");
  return result;
}

function safeTabName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100 || /[:\\/?*\[\]\r\n]/.test(name)) {
    throw new Error("The assigned Google Sheets tab name is invalid.");
  }
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function range(tab: string, cells: string): string {
  return encodeURIComponent(`${safeTabName(tab)}!${cells}`).replace(/'/g, "%27");
}

async function readValues(spreadsheetId: string, tab: string, cells: string): Promise<unknown[][]> {
  const result = await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${range(tab, cells)}?valueRenderOption=FORMATTED_VALUE`,
  );
  return Array.isArray(result.values) ? result.values : [];
}

function lookupProductRows(rows: unknown[][]): Record<string, string>[] {
  const text = (row: unknown[], index: number): string => String(row[index] ?? "").trim();
  return rows.filter(row => text(row, 0) && text(row, 1)).map(row => ({
    "SKU CODE": text(row, 0),
    "PRODUCT DESCRIPTION": text(row, 1),
    UOM: text(row, 2),
    "OUTGOING DEPARTMENT": text(row, 6),
    "EXPIRATION DATE": text(row, 3),
    "QTY ONHAND": text(row, 4),
    "TOTAL QTY ONHAND": text(row, 5),
    COST: text(row, 7),
    SRP: text(row, 8),
  }));
}

async function lookupLists(
  spreadsheetId: string,
  tabs: {
    products_tab: string;
    outgoing_departments_tab: string;
    incoming_departments_tab: string;
    suppliers_tab: string;
  },
): Promise<Record<string, unknown>> {
  const [productValues, suppliers] = await Promise.all([
    readValues(spreadsheetId, tabs.products_tab, "A2:I"),
    readValues(spreadsheetId, tabs.suppliers_tab, "B:B"),
  ]);
  const uniqueColumn = (rows: unknown[][]): string[] => [
    ...new Set(rows.map(row => String(row[0] ?? "").trim()).filter(Boolean)),
  ];
  return {
    products_tab: tabs.products_tab,
    products: lookupProductRows(productValues),
    outgoing_departments: uniqueColumn(productValues.map(row => [row[6]])),
    incoming_departments: [],
    suppliers: uniqueColumn(suppliers),
  };
}

async function ensureOutputTab(spreadsheetId: string, tabName: string): Promise<string> {
  const metadata = await googleRequest(`spreadsheets/${spreadsheetId}?fields=sheets.properties.title`);
  const existingSheet = (metadata.sheets || []).find((sheet: Record<string, any>) =>
    String(sheet.properties?.title || "").toLocaleLowerCase() === tabName.toLocaleLowerCase()
  );
  if (existingSheet) return existingSheet.properties.title;
  await googleRequest(`spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  });
  return tabName;
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function numberOrBlank(value: unknown): string | number {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("A quantity or price is not a valid number.");
  return number;
}

function normalizeSavedItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    sku_code: requiredText(item.sku_code, "SKU code"),
    product_description: requiredText(item.product_description, "Product description"),
    uom: typeof item.uom === "string" ? item.uom : "",
    expiration_date: typeof item.expiration_date === "string" ? item.expiration_date : "",
    qty_onhand: numberOrBlank(item.qty_onhand),
    total_qty_onhand: numberOrBlank(item.total_qty_onhand),
    cost: numberOrBlank(item.cost),
    srp: numberOrBlank(item.srp),
    transfer_qty: numberOrBlank(item.transfer_qty),
    remarks: typeof item.remarks === "string" ? item.remarks : "",
  };
}

async function appendSubmission(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  submittedBy: string,
  spreadsheetId: string,
  assignedOutputTab: string,
  value: unknown,
): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved request details are missing.");
  const submission = value as Record<string, unknown>;
  const requestId = requiredText(submission.request_id, "Supabase request ID");
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("The Supabase request ID is invalid.");
  const { data: request, error: requestError } = await adminClient
    .from("requests")
    .select("id, user_id, form_type, request_number, outgoing_department, incoming_department, supplier, created_at")
    .eq("id", requestId)
    .eq("user_id", userId)
    .maybeSingle();
  if (requestError) throw requestError;
  if (!request) throw new Error("The saved request could not be found for your account.");
  const formType = requiredText(request.form_type, "Form type");
  if (!["release-request", "transfer", "pull-out", "purchase-order"].includes(formType)) {
    throw new Error("Unknown request form type.");
  }
  const outputTab = formType === "release-request"
    ? "TRANSFER"
    : requiredText(assignedOutputTab, "Assigned output tab");
  const requestNumber = requiredText(request.request_number, "Request number");
  if (!/^(RRF|TRF|PUF|POF)-\d{7,}$/.test(requestNumber)) throw new Error("The request number is invalid.");
  const sequenceNumber = Number(requestNumber.match(/-(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(sequenceNumber)) throw new Error("The request sequence number is invalid.");
  const outgoing = requiredText(request.outgoing_department, "Outgoing department");
  const incoming = requiredText(request.incoming_department, "Incoming department");
  const supplier = typeof request.supplier === "string" ? request.supplier.trim() : "";
  if (formType === "purchase-order" && !supplier) throw new Error("A supplier is required for purchase orders.");

  const { data: savedItems, error: itemsError } = await adminClient
    .from("request_items")
    .select("sku_code, product_description, uom, expiration_date, qty_onhand, total_qty_onhand, cost, srp, transfer_qty, remarks")
    .eq("request_id", requestId)
    .order("id");
  if (itemsError) throw itemsError;
  if (!savedItems?.length) throw new Error("The saved request has no item rows.");
  if (savedItems.length > 200) throw new Error("A request cannot have more than 200 items.");
  const items = savedItems.map((item: Record<string, unknown>) => normalizeSavedItem(item));
  const requestDate = requiredText(submission.request_date, "Request date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) throw new Error("The request date is invalid.");

  const actualOutputTab = await ensureOutputTab(spreadsheetId, outputTab);
  const current = await readValues(spreadsheetId, actualOutputTab, "A:S");
  if (current.length) {
    const existingHeaders = current[0].map(value => String(value ?? ""));
    if (requestHeaders.slice(0, 18).some((header, index) => existingHeaders[index] !== header)) {
      throw new Error(`The "${actualOutputTab}" tab already has different columns from the portal's request format. The request is saved in the portal but was not copied to Sheets.`);
    }
    if (existingHeaders[18] && existingHeaders[18] !== requestHeaders[18]) {
      throw new Error(`The "${actualOutputTab}" tab already has different columns from the portal's request format. The request is saved in the portal but was not copied to Sheets.`);
    }
    if (!existingHeaders[18]) {
      const sequenceColumn = [
        [requestHeaders[18]],
        ...current.slice(1).map(row => {
          const match = String(row[0] ?? "").match(/^(?:RRF|TRF|PUF|POF)-(\d+)$/);
          return [match ? Number(match[1]) : ""];
        }),
      ];
      await googleRequest(`spreadsheets/${spreadsheetId}/values/${range(actualOutputTab, `S1:S${current.length}`)}?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values: sequenceColumn }),
      });
    }
    const existingCount = current.slice(1).filter(row => String(row[17] ?? "") === requestId).length;
    if (existingCount) {
      if (existingCount !== items.length) {
        throw new Error("A partial copy of this request already exists. Contact your administrator before retrying.");
      }
      return;
    }
  } else {
    await googleRequest(`spreadsheets/${spreadsheetId}/values/${range(actualOutputTab, "A1:S1")}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [requestHeaders] }),
    });
  }

  const rows = items.map(item => [
    requestNumber, formType, requestDate, outgoing, incoming, supplier, submittedBy,
    item.sku_code, item.product_description, item.uom, item.expiration_date,
    item.qty_onhand, item.total_qty_onhand, item.cost, item.srp, item.transfer_qty,
    item.remarks, requestId, sequenceNumber,
  ]);
  const tab = safeTabName(actualOutputTab);
  await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab)}!A:S:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) },
  );
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Google Sheets function is missing required Supabase secrets.");
    return respond({ error: "Google Sheets access is not configured by the administrator." }, 500);
  }
  const token = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!token) return respond({ error: "Sign in to continue." }, 401);

  try {
    const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user?.email) {
      return respond({ error: "Your sign-in session is invalid. Sign in again." }, 401);
    }
    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const [{ data: assignment, error: assignmentError }, { data: settings, error: settingsError }] = await Promise.all([
      adminClient.from("mw_sheet_assignments").select("output_tab").eq("user_id", authData.user.id).maybeSingle(),
      adminClient.from("mw_google_settings")
        .select("spreadsheet_id, products_tab, outgoing_departments_tab, incoming_departments_tab, suppliers_tab")
        .eq("singleton", true)
        .maybeSingle(),
    ]);
    if (assignmentError) throw assignmentError;
    if (settingsError) throw settingsError;
    if (!settings?.spreadsheet_id) return respond({ error: "The Master Admin has not connected the shared spreadsheet yet." }, 409);

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Enter a valid spreadsheet request." }, 400);
    }
    if (body.action === "lookup") return respond(await lookupLists(settings.spreadsheet_id, {
      products_tab: settings.products_tab || "data",
      outgoing_departments_tab: settings.outgoing_departments_tab || "area",
      incoming_departments_tab: settings.incoming_departments_tab || "area",
      suppliers_tab: settings.suppliers_tab || "dd",
    }));
    if (body.action === "submit") {
      await appendSubmission(
        adminClient,
        authData.user.id,
        authData.user.user_metadata?.portal_username || authData.user.email,
        settings.spreadsheet_id,
        assignment?.output_tab || "",
        body.submission,
      );
      return respond({ ok: true });
    }
    return respond({ error: "Unknown spreadsheet action." }, 400);
  } catch (error) {
    console.error("Google Sheets request failed.", error);
    return respond({ error: error instanceof Error ? error.message : "Google Sheets request failed." }, 500);
  }
});
