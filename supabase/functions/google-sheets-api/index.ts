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
  "Total Onhand", "Cost", "SRP", "Transfer Qty", "Remarks", "Sequence Number", "Status",
  "Approved Qty", "Approved By", "Released By", "Received By",
  "Approved Date", "Released Date", "Received Date",
];
const requestPrefixes: Record<string, string> = {
  "release-request": "RRF",
  transfer: "TRF",
  "pull-out": "PUF",
  "purchase-order": "POF",
};
const requestTabs: Record<string, string> = {
  "release-request": "TRANSFER",
  transfer: "REQUEST",
  "pull-out": "RTV",
  "purchase-order": "P.O REQUEST",
};
const requestStatuses = ["Pending", "Approved", "Released", "Received"];

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
const googleReadCache = new Map<string, { expiresAt: number; promise: Promise<unknown[][][]> }>();

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
  if (!response.ok) {
    const error = new Error(result.error?.message || "Google Sheets request failed.") as Error & { status?: number; reason?: string };
    error.status = response.status;
    error.reason = String(result.error?.errors?.[0]?.reason || result.error?.status || "");
    throw error;
  }
  return result;
}

function safeTabName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100 || /[:\\/?*\[\]\r\n]/.test(name)) {
    throw new Error("The assigned Google Sheets tab name is invalid.");
  }
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function a1Range(tab: string, cells: string): string {
  return `${safeTabName(tab)}!${cells}`;
}

function range(tab: string, cells: string): string {
  return encodeURIComponent(a1Range(tab, cells)).replace(/'/g, "%27");
}

async function readValues(spreadsheetId: string, tab: string, cells: string): Promise<unknown[][]> {
  const result = await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${range(tab, cells)}?valueRenderOption=FORMATTED_VALUE`,
  );
  return Array.isArray(result.values) ? result.values : [];
}

async function readValuesBatch(spreadsheetId: string, ranges: string[]): Promise<unknown[][][]> {
  const cacheKey = `${spreadsheetId}:${ranges.join("|")}`;
  const cached = googleReadCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const query = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE" });
    ranges.forEach(value => query.append("ranges", value));
    let result: Record<string, any>;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await googleRequest(`spreadsheets/${spreadsheetId}/values:batchGet?${query}`);
        break;
      } catch (error) {
        const apiError = error as Error & { status?: number; reason?: string };
        const quotaExceeded = apiError.status === 429
          || (apiError.status === 403 && /quota|rate.?limit/i.test(`${apiError.reason || ""} ${apiError.message}`));
        if (!quotaExceeded) throw error;
        if (attempt >= 2) {
          throw new InventoryRequestError(
            "Google Sheets is temporarily limiting read requests. Wait about a minute, then refresh.",
            429,
          );
        }
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    const valueRanges = Array.isArray(result.valueRanges) ? result.valueRanges : [];
    return ranges.map((_, index) => Array.isArray(valueRanges[index]?.values) ? valueRanges[index].values : []);
  })();
  googleReadCache.set(cacheKey, { expiresAt: Date.now() + 10_000, promise });
  try {
    return await promise;
  } catch (error) {
    googleReadCache.delete(cacheKey);
    throw error;
  }
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
  const [productValues, suppliers, accountDepartments] = await Promise.all([
    readValues(spreadsheetId, tabs.products_tab, "A2:I"),
    readValues(spreadsheetId, tabs.suppliers_tab, "B:B"),
    readValues(spreadsheetId, "AREA", "A1:A"),
  ]);
  const uniqueColumn = (rows: unknown[][]): string[] => [
    ...new Set(rows.map(row => String(row[0] ?? "").trim()).filter(Boolean)),
  ];
  return {
    products_tab: tabs.products_tab,
    products: lookupProductRows(productValues),
    outgoing_departments: uniqueColumn(productValues.map(row => [row[6]])),
    account_departments: uniqueColumn(accountDepartments),
    incoming_departments: [],
    suppliers: uniqueColumn(suppliers),
  };
}

type InventoryUser = {
  department: string;
  isAdmin: boolean;
};

class InventoryRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "InventoryRequestError";
  }
}

function uniqueValues(rows: unknown[][]): string[] {
  return [...new Set(rows.map(row => String(row[0] ?? "").trim()).filter(Boolean))];
}

async function loadInventoryValues(spreadsheetId: string): Promise<{ departments: string[]; categories: string[] }> {
  const [areaValues, categoryValues] = await Promise.all([
    readValues(spreadsheetId, "AREA", "A1:A"),
    readValues(spreadsheetId, "DD", "A1:A"),
  ]);
  return {
    departments: uniqueValues(areaValues),
    categories: uniqueValues(categoryValues),
  };
}

function resolveInventoryDepartment(user: InventoryUser, requested: unknown, departments: string[]): string {
  const requestedDepartment = user.isAdmin
    ? typeof requested === "string" ? requested.trim() : ""
    : user.department.trim();
  if (!requestedDepartment) {
    if (user.isAdmin) return "";
    throw new InventoryRequestError("Your account has no department assigned. Ask an administrator to set your department.", 403);
  }
  const department = departments.find(value => value.toLocaleLowerCase() === requestedDepartment.toLocaleLowerCase());
  if (!department) {
    throw new InventoryRequestError(
      user.isAdmin ? "The selected department is not listed in AREA!A1:A." : "Your assigned department is not listed in AREA!A1:A.",
      user.isAdmin ? 400 : 403,
    );
  }
  if (!user.isAdmin && department.toLocaleLowerCase() !== user.department.trim().toLocaleLowerCase()) {
    throw new InventoryRequestError("You can only access inventory for your assigned department.", 403);
  }
  return department;
}

function inventoryRow(row: unknown[], index: number): Record<string, unknown> {
  const cell = (column: number): string => String(row[column] ?? "").trim();
  return {
    sheet_row: index + 8,
    sku_code: cell(0),
    description: cell(1),
    uom: cell(3),
    cost: cell(4),
    srp: cell(5),
    expiration_1: cell(6),
    qty_1: cell(7),
    expiration_2: cell(8),
    qty_2: cell(9),
    expiration_3: cell(10),
    qty_3: cell(11),
    latest_received: cell(14),
    received_qty: cell(15),
    adjustment_category: cell(16),
    adjustment_qty: cell(17),
    adjustment_remarks: cell(18),
    total_on_hand: cell(19),
    near_expiration: cell(20),
    on_hand: cell(21),
    department: cell(22),
  };
}

async function loadInventory(
  spreadsheetId: string,
  user: InventoryUser,
  requestedDepartment: unknown,
): Promise<Record<string, unknown>> {
  const { departments, categories } = await loadInventoryValues(spreadsheetId);
  const department = resolveInventoryDepartment(user, requestedDepartment, departments);
  if (!department) return { department, departments, categories, rows: [] };
  const values = await readValues(spreadsheetId, department, "B8:X");
  const rows = values
    .map((row, index) => inventoryRow(row, index))
    .filter(row => row.sku_code);
  return { department, departments, categories, rows };
}

async function updateInventoryAdjustment(
  spreadsheetId: string,
  user: InventoryUser,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { departments, categories } = await loadInventoryValues(spreadsheetId);
  const department = resolveInventoryDepartment(user, body.department, departments);
  if (!department) throw new InventoryRequestError("Select a department before updating an inventory adjustment.", 400);
  const sheetRow = Number(body.sheet_row);
  if (!Number.isSafeInteger(sheetRow) || sheetRow < 8) {
    throw new InventoryRequestError("The selected inventory row is invalid.", 400);
  }
  const requestedCategory = typeof body.category === "string" ? body.category.trim() : "";
  const category = categories.find(value => value.toLocaleLowerCase() === requestedCategory.toLocaleLowerCase());
  if (!category) throw new InventoryRequestError("Select a valid adjustment category from DD!A1:A.", 400);
  const qtyText = String(body.qty ?? "").trim();
  const qty = Number(qtyText);
  if (!qtyText || !Number.isFinite(qty)) throw new InventoryRequestError("Enter a valid adjustment quantity.", 400);
  const remarks = typeof body.remarks === "string" ? body.remarks.trim() : "";
  if (remarks.length > 500) throw new InventoryRequestError("Adjustment remarks must be 500 characters or fewer.", 400);
  const skuValues = await readValues(spreadsheetId, department, `B${sheetRow}:B${sheetRow}`);
  const actualSku = String(skuValues[0]?.[0] ?? "").trim();
  const requestedSku = typeof body.sku_code === "string" ? body.sku_code.trim() : "";
  if (!actualSku || actualSku !== requestedSku) {
    throw new InventoryRequestError("The selected inventory item changed or no longer exists. Refresh the inventory and try again.", 409);
  }
  await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${range(department, `R${sheetRow}:T${sheetRow}`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [[category, qty, remarks]] }) },
  );
  return { ok: true, department, sheet_row: sheetRow, category, qty, remarks };
}

async function loadRequestHistory(
  spreadsheetId: string,
  user: Awaited<ReturnType<typeof getPortalUserContext>>,
  formType: unknown,
  requestedDepartment: unknown,
): Promise<Record<string, unknown>> {
  if (typeof formType !== "string" || !requestTabs[formType]) {
    throw new InventoryRequestError("Choose a valid request history type.", 400);
  }
  if (!user.isAdmin && !user.allowedFormTypes.includes(formType)) {
    throw new InventoryRequestError("Your account is not assigned access to this form history.", 403);
  }
  const tabName = requestTabs[formType];
  if (!user.isAdmin && !user.department.trim()) {
    throw new InventoryRequestError("Your account has no department assigned. Ask an administrator to set your department.", 403);
  }
  if (user.isAdmin && (typeof requestedDepartment !== "string" || !requestedDepartment.trim())) {
    const [areaValues] = await readValuesBatch(spreadsheetId, [a1Range("AREA", "A1:A")]);
    return { department: "", departments: uniqueValues(areaValues), rows: [] };
  }
  const [areaValues, values] = await readValuesBatch(spreadsheetId, [
    a1Range("AREA", "A1:A"),
    a1Range(tabName, "A:Z"),
  ]);
  const departments = uniqueValues(areaValues);
  const department = resolveInventoryDepartment(user, requestedDepartment, departments);
  if (!values.length) return { department, departments, rows: [] };
  const headers = values[0].map(value => String(value ?? "").trim());
  if (requestHeaders.some((header, index) => headers[index] !== header)) {
    throw new Error(`The "${tabName}" sheet headers do not match the request history format.`);
  }
  const normalizedDepartment = department.toLocaleLowerCase();
  const rows = values.slice(1).flatMap(row => {
    const status = String(row[18] ?? "").trim();
    const normalizedStatus = status.toLocaleLowerCase();
    if (!row[0] || !status || normalizedStatus === "pending") return [];
    const outgoingDepartment = String(row[3] ?? "");
    const incomingDepartment = String(row[4] ?? "");
    if (incomingDepartment.trim().toLocaleLowerCase() !== normalizedDepartment) return [];
    return [{
      serial_number: String(row[0] ?? ""),
      supplier: String(row[5] ?? ""),
      outgoing_department: outgoingDepartment,
      sku_code: String(row[7] ?? ""),
      product_description: String(row[8] ?? ""),
      uom: String(row[9] ?? ""),
      expiration_date: String(row[10] ?? ""),
      on_hand: String(row[11] ?? ""),
      total_on_hand: String(row[12] ?? ""),
      cost: String(row[13] ?? ""),
      srp: String(row[14] ?? ""),
      approved_transfer_qty: String(row[19] ?? ""),
      second_expiration_date: String(row[10] ?? ""),
      received_qty: String(row[19] ?? ""),
      remarks: String(row[16] ?? ""),
      incoming_department: incomingDepartment,
      request_date: String(row[2] ?? ""),
      received_date: String(row[25] ?? ""),
      status,
    }];
  });
  if (formType === "purchase-order") {
    rows.sort((left, right) => {
      const leftSupplier = String(left.supplier ?? "").trim();
      const rightSupplier = String(right.supplier ?? "").trim();
      if (!leftSupplier) return rightSupplier ? 1 : 0;
      if (!rightSupplier) return -1;
      return leftSupplier.localeCompare(rightSupplier, undefined, { sensitivity: "base" });
    });
  }
  return { department, departments, rows };
}

async function getSheetMetadata(spreadsheetId: string): Promise<Record<string, any>> {
  return googleRequest(`spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`);
}

async function ensureOutputTab(
  spreadsheetId: string,
  tabName: string,
  knownMetadata?: Record<string, any>,
): Promise<string> {
  const metadata = knownMetadata || await getSheetMetadata(spreadsheetId);
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

async function compactRequestTab(
  spreadsheetId: string,
  tabName: string,
  usedRows: number,
  knownMetadata?: Record<string, any>,
  compactRows = true,
): Promise<void> {
  let metadata = knownMetadata || await getSheetMetadata(spreadsheetId);
  let sheet = (metadata.sheets || []).find((item: Record<string, any>) =>
    String(item.properties?.title || "").toLocaleLowerCase() === tabName.toLocaleLowerCase()
  );
  if (!sheet && knownMetadata) {
    metadata = await getSheetMetadata(spreadsheetId);
    sheet = (metadata.sheets || []).find((item: Record<string, any>) =>
      String(item.properties?.title || "").toLocaleLowerCase() === tabName.toLocaleLowerCase()
    );
  }
  if (!sheet?.properties?.sheetId) throw new Error(`Could not find the "${tabName}" request tab.`);
  const sheetId = Number(sheet.properties.sheetId);
  const rowCount = Math.max(usedRows, 1);
  const requests: Record<string, unknown>[] = [];
  if (compactRows && Number(sheet.properties.gridProperties?.rowCount) !== rowCount) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { rowCount } },
        fields: "gridProperties.rowCount",
      },
    });
  }
  requests.push({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: 18, endColumnIndex: 19 },
    },
  });
  await googleRequest(`spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function uppercaseText(value: unknown, label: string): string {
  return requiredText(value, label).toLocaleUpperCase();
}

function numberOrBlank(value: unknown): string | number {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("A quantity or price is not a valid number.");
  return number;
}

function normalizeSubmittedItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    sku_code: uppercaseText(item.sku_code, "SKU code"),
    product_description: uppercaseText(item.product_description, "Product description"),
    uom: typeof item.uom === "string" ? item.uom.toLocaleUpperCase() : "",
    expiration_date: typeof item.expiration_date === "string" ? item.expiration_date : "",
    qty_onhand: numberOrBlank(item.qty_onhand),
    total_qty_onhand: numberOrBlank(item.total_qty_onhand),
    cost: numberOrBlank(item.cost),
    srp: numberOrBlank(item.srp),
    transfer_qty: numberOrBlank(item.transfer_qty),
    remarks: typeof item.remarks === "string" ? item.remarks.toLocaleUpperCase() : "",
  };
}

async function writeRequestColumns(
  spreadsheetId: string,
  tabName: string,
  values: unknown[][],
): Promise<void> {
  await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${range(tabName, `R1:Z${values.length}`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values }) },
  );
}

async function ensureRequestHeaders(
  spreadsheetId: string,
  tabName: string,
  knownMetadata?: Record<string, any>,
  additionalRows = 0,
  compactRows = true,
): Promise<unknown[][]> {
  let current = await readValues(spreadsheetId, tabName, "A:Z");
  if (!current.length) {
    await googleRequest(`spreadsheets/${spreadsheetId}/values/${range(tabName, "A1:Z1")}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [requestHeaders] }),
    });
    current = await readValues(spreadsheetId, tabName, "A:Z");
  }
  const headers = current[0].map(value => String(value ?? ""));
  if (requestHeaders.slice(0, 17).some((header, index) => headers[index] !== header)) {
    throw new Error(`The "${tabName}" tab has different columns from the request format. No request data was saved.`);
  }
  if (headers.slice(requestHeaders.length).some(Boolean)) {
    throw new Error(`The "${tabName}" tab has extra columns after Received By. No request data was saved.`);
  }
  if (headers[17] && headers[17] !== "Sequence Number" && headers[17] !== "Supabase Request ID") {
    throw new Error(`The "${tabName}" tab has different columns from the request format. No request data was saved.`);
  }
  const hasLegacyId = headers[17] === "Supabase Request ID";
  if (!hasLegacyId && headers[18] && headers[18] !== "Status") {
    throw new Error(`The "${tabName}" tab has different columns from the request format. No request data was saved.`);
  }
  if (!hasLegacyId && headers.slice(19, requestHeaders.length).some((header, index) =>
    header && header !== requestHeaders[index + 19]
  )) {
    throw new Error(`The "${tabName}" tab has unexpected approval workflow columns.`);
  }

  const rows = current.slice(1).map(row => {
    const requestNumber = String(row[0] ?? "");
    const numberMatch = requestNumber.match(/^(?:RRF|TRF|PUF|POF)-(\d+)$/);
    const storedSequence = !hasLegacyId && headers[17] === "Sequence Number" ? row[17] : "";
    const sequence = storedSequence !== "" && Number.isSafeInteger(Number(storedSequence))
      ? Number(storedSequence)
      : numberMatch ? Number(numberMatch[1]) : "";
    const storedStatus = !hasLegacyId && headers[18] === "Status" ? String(row[18] ?? "").trim() : "";
    let status = "";
    if (requestNumber) {
      if (!storedStatus) {
        status = "Pending";
      } else {
        const canonicalStatus = requestStatuses.find(value => value.toLocaleLowerCase() === storedStatus.toLocaleLowerCase());
        if (!canonicalStatus) throw new Error(`The "${tabName}" tab has an invalid status "${storedStatus}". Use Pending, Approved, Released, or Received.`);
        status = canonicalStatus;
      }
    }
    return [
      sequence,
      status,
      hasLegacyId ? "" : row[19] ?? "",
      hasLegacyId ? "" : row[20] ?? "",
      hasLegacyId ? "" : row[21] ?? "",
      hasLegacyId ? "" : row[22] ?? "",
      hasLegacyId ? "" : row[23] ?? "",
      hasLegacyId ? "" : row[24] ?? "",
      hasLegacyId ? "" : row[25] ?? "",
    ];
  });
  const workflowHeadersChanged = requestHeaders.slice(17).some((header, index) => headers[index + 17] !== header);
  const workflowValuesChanged = rows.some((values, rowIndex) =>
    requestHeaders.slice(17).some((_, columnIndex) =>
      String(current[rowIndex + 1]?.[columnIndex + 17] ?? "") !== String(values[columnIndex] ?? "")
    )
  );
  if (workflowHeadersChanged || workflowValuesChanged) {
    await writeRequestColumns(spreadsheetId, tabName, [
      requestHeaders.slice(17),
      ...rows,
    ]);
    current = await readValues(spreadsheetId, tabName, "A:Z");
  }
  await compactRequestTab(
    spreadsheetId,
    tabName,
    current.length + additionalRows,
    knownMetadata,
    compactRows,
  );
  return current;
}

function getMaximumSequence(rows: unknown[][], prefix: string): number {
  if (!rows.length) return 0;
  const header = rows[0].map(value => String(value ?? ""));
  if (requestHeaders.slice(0, 17).some((value, index) => header[index] !== value)) {
    throw new Error("The request tab headers do not match the request format.");
  }
  let maximum = 0;
  for (const row of rows.slice(1)) {
    const match = String(row[0] ?? "").match(new RegExp(`^${prefix}-(\\d+)$`));
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) maximum = Math.max(maximum, value);
  }
  return maximum;
}

async function setCounterFromSheet(
  adminClient: ReturnType<typeof createClient>,
  formType: string,
  lastValue: number,
): Promise<void> {
  const { error } = await adminClient.rpc("set_request_counter_from_sheet", {
    p_form_type: formType,
    p_last_value: lastValue,
  });
  if (error) throw error;
}

async function withRequestSequenceLock<T>(
  adminClient: ReturnType<typeof createClient>,
  formType: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockId = crypto.randomUUID();
  const { data: acquired, error: acquireError } = await adminClient.rpc("acquire_request_sequence_lock", {
    p_form_type: formType,
    p_lock_id: lockId,
  });
  if (acquireError) throw acquireError;
  if (!acquired) throw new Error("Another request of this form is being saved. Wait a moment and try again.");
  try {
    return await action();
  } finally {
    const { error: releaseError } = await adminClient.rpc("release_request_sequence_lock", {
      p_form_type: formType,
      p_lock_id: lockId,
    });
    if (releaseError) throw releaseError;
  }
}

async function previewRequestSequence(
  adminClient: ReturnType<typeof createClient>,
  spreadsheetId: string,
  formType: string,
): Promise<number> {
  const prefix = requestPrefixes[formType];
  const tabName = requestTabs[formType];
  if (!prefix || !tabName) throw new Error("Unknown request form type.");
  return withRequestSequenceLock(adminClient, formType, async () => {
    const metadata = await getSheetMetadata(spreadsheetId);
    const actualTab = await ensureOutputTab(spreadsheetId, tabName, metadata);
    const rows = await ensureRequestHeaders(spreadsheetId, actualTab, metadata);
    const maximum = getMaximumSequence(rows, prefix);
    await setCounterFromSheet(adminClient, formType, maximum);
    return maximum + 1;
  });
}

async function loadWorkflowRequests(
  spreadsheetId: string,
  filter: "pending" | "approved" | "released" | "mine" | "department" | "all",
  department = "",
  username = "",
  allDepartments = false,
  allowedFormTypes: string[] = Object.keys(requestTabs),
): Promise<Record<string, unknown>[]> {
  const metadata = await getSheetMetadata(spreadsheetId);
  const availableTabs = new Map<string, string>(
    (metadata.sheets || []).map((sheet: Record<string, any>) => [
      String(sheet.properties?.title || "").toLocaleLowerCase(),
      String(sheet.properties?.title || ""),
    ]),
  );
  const rowsByTab = await Promise.all(Object.entries(requestTabs).map(async ([formType, tabName]) => {
    if (!allowedFormTypes.includes(formType)) return [];
    const actualTab = availableTabs.get(tabName.toLocaleLowerCase());
    if (!actualTab) return [];
    const rows = await ensureRequestHeaders(spreadsheetId, actualTab, metadata, 0, false);
    return rows.slice(1).map(row => ({ formType, row }));
  }));
  const requests = new Map<string, Record<string, unknown>>();

  for (const tabRows of rowsByTab) {
    for (const { formType, row } of tabRows) {
      const requestNumber = String(row[0] ?? "").trim();
      const status = String(row[18] ?? "").trim().toLocaleLowerCase();
      if (!requestNumber) continue;
      const outgoing = String(row[3] || "");
      const incoming = String(row[4] || "");
      const submittedBy = String(row[6] || "");
      const matches = filter === "pending"
        ? status === "pending"
        : filter === "approved"
        ? status === "approved" && (allDepartments || outgoing.toLocaleLowerCase() === department.toLocaleLowerCase())
        : filter === "released"
        ? status === "released" && (allDepartments || incoming.toLocaleLowerCase() === department.toLocaleLowerCase())
        : filter === "mine"
        ? submittedBy.toLocaleLowerCase() === username.toLocaleLowerCase()
        : filter === "department"
        ? outgoing.toLocaleLowerCase() === department.toLocaleLowerCase()
          || incoming.toLocaleLowerCase() === department.toLocaleLowerCase()
        : true;
      if (!matches) continue;

      let request = requests.get(requestNumber);
      if (!request) {
        request = {
          request_number: requestNumber,
          form_type: String(row[1] || formType.replaceAll("-", " ")).toLocaleUpperCase(),
          request_date: String(row[2] || ""),
          outgoing_department: String(row[3] || ""),
          incoming_department: String(row[4] || ""),
          supplier: String(row[5] || ""),
          submitted_by: submittedBy,
          status: String(row[18] || "Pending"),
          approved_by: String(row[20] || ""),
          released_by: String(row[21] || ""),
          received_by: String(row[22] || ""),
          approved_date: String(row[23] ?? ""),
          released_date: String(row[24] ?? ""),
          received_date: String(row[25] ?? ""),
          form_type_id: formType,
          items: [],
        };
        requests.set(requestNumber, request);
      }
      (request.items as Record<string, string>[]).push({
        sku_code: String(row[7] ?? ""),
        product_description: String(row[8] ?? ""),
        uom: String(row[9] ?? ""),
        expiration_date: String(row[10] ?? ""),
        qty_onhand: String(row[11] ?? ""),
        total_qty_onhand: String(row[12] ?? ""),
        cost: String(row[13] ?? ""),
        srp: String(row[14] ?? ""),
        transfer_qty: String(row[15] ?? ""),
        remarks: String(row[16] ?? ""),
        approved_qty: String(row[19] ?? ""),
      });
    }
  }

  return [...requests.values()].sort((left, right) =>
    String(right.request_number).localeCompare(String(left.request_number))
  );
}

async function getPortalUsername(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<string> {
  const { data: profile, error } = await adminClient
    .from("login_usernames")
    .select("username")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!profile?.username) throw new Error("The signed-in account does not have a portal username.");
  return profile.username;
}

async function getPortalUserContext(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<{
  userId: string;
  username: string;
  department: string;
  isMasterAdmin: boolean;
  isAdmin: boolean;
  allowedFormTypes: string[];
}> {
  const [{ data: profile, error: profileError }, { data: admin, error: adminError }] = await Promise.all([
    adminClient.from("login_usernames")
      .select("username, department, role, allowed_form_types")
      .eq("user_id", userId)
      .maybeSingle(),
    adminClient.from("mw_portal_admins")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (profileError) throw profileError;
  if (adminError) throw adminError;
  if (!profile?.username) throw new Error("The signed-in account does not have a portal profile.");
  return {
    userId,
    username: profile.username,
    department: String(profile.department || ""),
    isMasterAdmin: Boolean(admin),
    isAdmin: Boolean(admin) || String(profile.role || "").toLocaleLowerCase() === "admin",
    allowedFormTypes: Array.isArray(profile.allowed_form_types)
      ? profile.allowed_form_types.map((value: unknown) => String(value))
      : Object.keys(requestTabs),
  };
}

type FormNotificationEvent = "submitted" | "approved" | "released" | "received";

async function createFormNotifications(
  adminClient: ReturnType<typeof createClient>,
  details: {
    event: FormNotificationEvent;
    formType: string;
    requestNumber: string;
    submittedBy: string;
    outgoingDepartment: string;
    incomingDepartment: string;
  },
): Promise<void> {
  const formNames: Record<string, string> = {
    "release-request": "Release & Request Form",
    transfer: "Transfer Form",
    "pull-out": "Pull Out Form",
    "purchase-order": "Purchase Order Form",
  };
  const destinationPages: Record<FormNotificationEvent, string> = {
    submitted: "approvals",
    approved: "pending-release",
    released: "pending-received",
    received: "my-requests",
  };
  const messages: Record<FormNotificationEvent, string> = {
    submitted: "A new request is pending approval.",
    approved: "The request was approved and is ready for release.",
    released: "The request was released and is ready to receive.",
    received: "The request was marked as received.",
  };
  const formName = formNames[details.formType];
  if (!formName) throw new Error("Cannot notify users about an unknown form type.");

  let recipientIds: string[] = [];
  if (details.event === "submitted") {
    const [masterAdmins, admins] = await Promise.all([
      adminClient.from("mw_portal_admins").select("user_id"),
      adminClient.from("login_usernames").select("user_id").eq("role", "admin"),
    ]);
    if (masterAdmins.error) throw masterAdmins.error;
    if (admins.error) throw admins.error;
    recipientIds = [...new Set([
      ...(masterAdmins.data || []).map(admin => String(admin.user_id)),
      ...(admins.data || []).map(admin => String(admin.user_id)),
    ])];
  } else {
    const targetDepartment = details.event === "approved" || details.event === "received"
      ? details.outgoingDepartment
      : details.incomingDepartment;
    const [requesterResult, departmentResult] = await Promise.all([
      adminClient.from("login_usernames").select("user_id").eq("username", details.submittedBy.trim().toLocaleLowerCase()).maybeSingle(),
      adminClient.from("login_usernames").select("user_id, department, role, allowed_form_types"),
    ]);
    if (requesterResult.error) throw requesterResult.error;
    if (departmentResult.error) throw departmentResult.error;
    recipientIds = [
      ...(requesterResult.data ? [String(requesterResult.data.user_id)] : []),
      ...(departmentResult.data || [])
        .filter(profile =>
          String(profile.department || "").trim().toLocaleLowerCase() === targetDepartment.trim().toLocaleLowerCase()
          && (
            String(profile.role || "").toLocaleLowerCase() === "admin"
            || !Array.isArray(profile.allowed_form_types)
            || profile.allowed_form_types.includes(details.formType)
          )
        )
        .map(profile => String(profile.user_id)),
    ];
  }

  const uniqueRecipientIds = [...new Set(recipientIds)];
  if (!uniqueRecipientIds.length) throw new Error("No users are configured to receive this form notification.");
  const { error } = await adminClient.from("mw_form_notifications").insert(uniqueRecipientIds.map(recipientId => ({
    recipient_id: recipientId,
    request_number: details.requestNumber,
    form_type: details.formType,
    event: details.event,
    title: formName,
    message: `${details.requestNumber}: ${messages[details.event]}`,
    destination_page: destinationPages[details.event],
  })));
  if (error) throw error;
}

async function notifyAfterSheetWrite(
  adminClient: ReturnType<typeof createClient>,
  details: Parameters<typeof createFormNotifications>[1],
): Promise<string | undefined> {
  try {
    await createFormNotifications(adminClient, details);
    return undefined;
  } catch (error) {
    console.error(`Google Sheets saved ${details.requestNumber}, but its notification could not be recorded.`, error);
    return "The form update was saved, but its notification could not be recorded. Contact a Master Admin if it is missing from the inbox.";
  }
}

function formTypeFromRequestNumber(requestNumber: string): string {
  const match = requestNumber.match(/^(RRF|TRF|PUF|POF)-\d{7,}$/);
  const formType = match
    ? Object.entries(requestPrefixes).find(([, prefix]) => prefix === match[1])?.[0]
    : "";
  if (!formType) throw new Error("The request number is invalid.");
  return formType;
}

async function applyWorkflowAction(
  adminClient: ReturnType<typeof createClient>,
  spreadsheetId: string,
  user: {
    userId: string;
    username: string;
    department: string;
    isMasterAdmin: boolean;
    isAdmin: boolean;
    allowedFormTypes: string[];
  },
  value: unknown,
): Promise<{ notification_warning?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The workflow action is invalid.");
  }
  const body = value as Record<string, unknown>;
  const action = requiredText(body.action, "Workflow action");
  const requestNumber = requiredText(body.request_number, "Request number");
  const formType = formTypeFromRequestNumber(requestNumber);
  if (action === "approve" && !user.isAdmin) {
    throw new Error("Admin access is required to approve requests.");
  }
  if (action !== "approve" && action !== "release" && action !== "receive") {
    throw new Error("Unknown request workflow action.");
  }
  if (!user.isAdmin && !user.allowedFormTypes.includes(formType)) {
    throw new Error("Your account is not assigned access to this form.");
  }
  if (action !== "approve" && !user.isAdmin && !user.department) {
    throw new Error("Your account has no department assigned. Ask the Master Admin to update your account.");
  }

  const requestDetails = await withRequestSequenceLock(adminClient, formType, async () => {
    const tabName = requestTabs[formType];
    const metadata = await getSheetMetadata(spreadsheetId);
    const actualTab = await ensureOutputTab(spreadsheetId, tabName, metadata);
    const rows = await ensureRequestHeaders(spreadsheetId, actualTab, metadata);
    const matchingRows = rows
      .map((row, index) => ({ row, sheetRow: index + 1 }))
      .filter(({ row }) => String(row[0] || "").trim() === requestNumber);
    if (!matchingRows.length) throw new Error("That request could not be found in its form tab.");

    const expectedStatus = action === "approve" ? "Pending" : action === "release" ? "Approved" : "Released";
    if (matchingRows.some(({ row }) => String(row[18] || "").trim().toLocaleLowerCase() !== expectedStatus.toLocaleLowerCase())) {
      throw new Error(`This request is no longer ${expectedStatus}. Refresh the list and try again.`);
    }
    if (action === "release" && !user.isAdmin && matchingRows.some(({ row }) =>
      String(row[3] || "").trim().toLocaleLowerCase() !== user.department.trim().toLocaleLowerCase()
    )) {
      throw new Error("Only the request's outgoing department can release it.");
    }
    if (action === "receive" && !user.isAdmin && matchingRows.some(({ row }) =>
      String(row[4] || "").trim().toLocaleLowerCase() !== user.department.trim().toLocaleLowerCase()
    )) {
      throw new Error("Only the request's incoming department can receive it.");
    }

    let approvedQuantities: number[] = [];
    if (action === "approve") {
      if (!Array.isArray(body.approved_quantities) || body.approved_quantities.length !== matchingRows.length) {
        throw new Error("Enter an approved quantity for each request item.");
      }
      approvedQuantities = body.approved_quantities.map(value => {
        if (value === "" || value === null || value === undefined) throw new Error("Approved quantity is required for every item.");
        const quantity = Number(value);
        if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Approved quantities must be zero or greater.");
        return quantity;
      });
    }

    const updatedStatus = action === "approve" ? "Approved" : action === "release" ? "Released" : "Received";
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const valueRanges = matchingRows.map(({ row, sheetRow }, index) => {
      const updated = [...row];
      updated[18] = updatedStatus;
      if (action === "approve") {
        updated[19] = approvedQuantities[index];
        updated[20] = user.username;
        updated[23] = today;
      } else if (action === "release") {
        updated[21] = user.username;
        updated[24] = today;
      } else {
        updated[22] = user.username;
        updated[25] = today;
      }
      return {
        range: a1Range(actualTab, `S${sheetRow}:Z${sheetRow}`),
        values: [[...updated.slice(18, 26)]],
      };
    });
    await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "RAW", data: valueRanges }),
    });
    return {
      submittedBy: String(matchingRows[0].row[6] || ""),
      outgoingDepartment: String(matchingRows[0].row[3] || ""),
      incomingDepartment: String(matchingRows[0].row[4] || ""),
    };
  });
  const event = action === "approve" ? "approved" : action === "release" ? "released" : "received";
  const notificationWarning = await notifyAfterSheetWrite(adminClient, {
    event,
    formType,
    requestNumber,
    ...requestDetails,
  });
  return notificationWarning ? { notification_warning: notificationWarning } : {};
}

async function saveSubmissionDirect(
  adminClient: ReturnType<typeof createClient>,
  submittedBy: string,
  spreadsheetId: string,
  value: unknown,
): Promise<{ requestNumber: string; notificationWarning?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The submitted request details are missing.");
  const submission = value as Record<string, unknown>;
  const formType = requiredText(submission.form_type, "Form type");
  const prefix = requestPrefixes[formType];
  if (!prefix) {
    throw new Error("Unknown request form type.");
  }
  const outputTab = requestTabs[formType];
  const outgoing = uppercaseText(submission.outgoing_department, "Outgoing department");
  const incoming = uppercaseText(submission.incoming_department, "Incoming department");
  const supplier = typeof submission.supplier === "string" ? submission.supplier.trim().toLocaleUpperCase() : "";
  if (formType === "purchase-order" && !supplier) throw new Error("A supplier is required for purchase orders.");
  const requestDate = requiredText(submission.request_date, "Request date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) throw new Error("The request date is invalid.");
  if (!Array.isArray(submission.items) || !submission.items.length || submission.items.length > 200) {
    throw new Error("A request must contain between 1 and 200 items.");
  }
  const items = submission.items.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("A submitted request item is invalid.");
    }
    return normalizeSubmittedItem(item as Record<string, unknown>);
  });

  const requestNumber = await withRequestSequenceLock(adminClient, formType, async () => {
    const metadata = await getSheetMetadata(spreadsheetId);
    const actualOutputTab = await ensureOutputTab(spreadsheetId, outputTab, metadata);
    let current = await ensureRequestHeaders(spreadsheetId, actualOutputTab, metadata, items.length);
    const maximumSequence = getMaximumSequence(current, prefix);
    await setCounterFromSheet(adminClient, formType, maximumSequence);

    const { data: sequenceNumber, error: sequenceError } = await adminClient.rpc("allocate_request_number", {
      p_form_type: formType,
    });
    if (sequenceError) throw sequenceError;
    const allocatedSequence = Number(sequenceNumber);
    if (!Number.isSafeInteger(allocatedSequence) || allocatedSequence < 1) {
      throw new Error("The request sequence allocator returned an invalid number.");
    }
    const requestNumber = `${prefix}-${String(allocatedSequence).padStart(7, "0")}`;
    if (current.slice(1).some(row => String(row[0] ?? "") === requestNumber)) {
      throw new Error("The request number already exists in the destination sheet. No request data was saved.");
    }
    const rows = items.map(item => [
      requestNumber, formType.replaceAll("-", " ").toLocaleUpperCase(), requestDate, outgoing, incoming, supplier,
      submittedBy.toLocaleUpperCase(), item.sku_code, item.product_description, item.uom, item.expiration_date,
      item.qty_onhand, item.total_qty_onhand, item.cost, item.srp, item.transfer_qty, item.remarks,
      allocatedSequence, "Pending", "", "", "", "",
    ]);
    const firstRow = current.length + 1;
    const lastRow = firstRow + rows.length - 1;
    await googleRequest(
      `spreadsheets/${spreadsheetId}/values/${range(actualOutputTab, `A${firstRow}:W${lastRow}`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: rows }) },
    );
    return requestNumber;
  });
  const notificationWarning = await notifyAfterSheetWrite(adminClient, {
    event: "submitted",
    formType,
    requestNumber,
    submittedBy: submittedBy.toLocaleUpperCase(),
    outgoingDepartment: outgoing,
    incomingDepartment: incoming,
  });
  if (notificationWarning) return { requestNumber, notificationWarning };
  return { requestNumber };
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
    const { data: settings, error: settingsError } = await adminClient.from("mw_google_settings")
        .select("spreadsheet_id, products_tab, outgoing_departments_tab, incoming_departments_tab, suppliers_tab")
        .eq("singleton", true)
        .maybeSingle();
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
    if (
      body.action === "inventory_load"
      || body.action === "inventory_adjustment_update"
      || body.action === "request_history_load"
    ) {
      const user = await getPortalUserContext(adminClient, authData.user.id);
      if (body.action === "inventory_load") {
        return respond(await loadInventory(settings.spreadsheet_id, user, body.department));
      }
      if (body.action === "request_history_load") {
        return respond(await loadRequestHistory(settings.spreadsheet_id, user, body.form_type, body.department));
      }
      return respond(await updateInventoryAdjustment(settings.spreadsheet_id, user, body));
    }
    if (body.action === "sequence_preview") {
      const formType = requiredText(body.form_type, "Form type");
      const user = await getPortalUserContext(adminClient, authData.user.id);
      if (!user.isAdmin && !user.allowedFormTypes.includes(formType)) {
        return respond({ error: "Your account is not assigned access to this form." }, 403);
      }
      const sequenceNumber = await previewRequestSequence(adminClient, settings.spreadsheet_id, formType);
      if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
        throw new Error("The next request sequence number is invalid.");
      }
      return respond({ sequence_number: sequenceNumber });
    }
    if (body.action === "approval_queue"
      || body.action === "my_requests"
      || body.action === "pending_release"
      || body.action === "pending_received"
      || body.action === "reports_history"
      || body.action === "workflow_counts"
      || body.action === "workflow_action") {
      const user = await getPortalUserContext(adminClient, authData.user.id);
      if (body.action === "approval_queue") {
        if (!user.isAdmin) return respond({ error: "Admin access is required to review and approve requests." }, 403);
        return respond({
          requests: await loadWorkflowRequests(settings.spreadsheet_id, "pending", "", "", true, Object.keys(requestTabs)),
        });
      }
      if (body.action === "my_requests") {
        return respond({
          requests: await loadWorkflowRequests(
            settings.spreadsheet_id,
            "mine",
            "",
            user.username,
            false,
            user.isAdmin ? Object.keys(requestTabs) : user.allowedFormTypes,
          ),
        });
      }
      if (body.action === "pending_release") {
        return respond({
          requests: await loadWorkflowRequests(
            settings.spreadsheet_id,
            "approved",
            user.department,
            "",
            user.isAdmin,
            user.isAdmin ? Object.keys(requestTabs) : user.allowedFormTypes,
          ),
        });
      }
      if (body.action === "pending_received") {
        return respond({
          requests: await loadWorkflowRequests(
            settings.spreadsheet_id,
            "released",
            user.department,
            "",
            user.isAdmin,
            user.isAdmin ? Object.keys(requestTabs) : user.allowedFormTypes,
          ),
        });
      }
      if (body.action === "reports_history") {
        return respond({
          requests: await loadWorkflowRequests(
            settings.spreadsheet_id,
            user.isAdmin ? "all" : "department",
            user.department,
            user.username,
            user.isAdmin,
            user.isAdmin ? Object.keys(requestTabs) : user.allowedFormTypes,
          ),
        });
      }
      if (body.action === "workflow_counts") {
        const requests = await loadWorkflowRequests(
          settings.spreadsheet_id,
          "all",
          "",
          "",
          true,
          user.isAdmin ? Object.keys(requestTabs) : user.allowedFormTypes,
        );
        return respond({
          approval_count: user.isAdmin ? requests.filter(request => String(request.status).toLocaleLowerCase() === "pending").length : 0,
          release_count: requests.filter(request =>
            String(request.status).toLocaleLowerCase() === "approved"
            && (user.isAdmin || String(request.outgoing_department).trim().toLocaleLowerCase() === user.department.trim().toLocaleLowerCase())
          ).length,
          receive_count: requests.filter(request =>
            String(request.status).toLocaleLowerCase() === "released"
            && (user.isAdmin || String(request.incoming_department).trim().toLocaleLowerCase() === user.department.trim().toLocaleLowerCase())
          ).length,
        });
      }
      const workflowAction = body.workflow && typeof body.workflow === "object"
        ? body.workflow as Record<string, unknown>
        : null;
      if (workflowAction?.action === "approve" && !user.isAdmin) {
        return respond({ error: "Admin access is required to approve requests." }, 403);
      }
      const result = await applyWorkflowAction(adminClient, settings.spreadsheet_id, user, body.workflow);
      return respond({ ok: true, ...result });
    }
    if (body.action === "submit") {
      const user = await getPortalUserContext(adminClient, authData.user.id);
      const submission = body.submission && typeof body.submission === "object"
        ? body.submission as Record<string, unknown>
        : {};
      const formType = typeof submission.form_type === "string" ? submission.form_type : "";
      if (!user.isAdmin && !user.allowedFormTypes.includes(formType)) {
        return respond({ error: "Your account is not assigned access to this form." }, 403);
      }
      const result = await saveSubmissionDirect(
        adminClient,
        user.username,
        settings.spreadsheet_id,
        body.submission,
      );
      return respond({
        ok: true,
        request_number: result.requestNumber,
        ...(result.notificationWarning ? { notification_warning: result.notificationWarning } : {}),
      });
    }
    return respond({ error: "Unknown spreadsheet action." }, 400);
  } catch (error) {
    console.error("Google Sheets request failed.", error);
    if (error instanceof InventoryRequestError) {
      return respond({ error: error.message }, error.status);
    }
    return respond({ error: error instanceof Error ? error.message : "Google Sheets request failed." }, 500);
  }
});
