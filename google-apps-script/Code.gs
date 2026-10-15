const REQUEST_HEADERS = Object.freeze([
  "Request Number",
  "Form Type",
  "Request Date",
  "Outgoing Department",
  "Incoming Department",
  "Supplier",
  "Submitted By",
  "SKU Code",
  "Product Description",
  "UOM",
  "Expiration Date",
  "Onhand",
  "Total Onhand",
  "Cost",
  "SRP",
  "Transfer Qty",
  "Remarks",
  "Sequence Number",
]);

function doPost(event) {
  const parameters = event && event.parameter ? event.parameter : {};
  const nonce = String(parameters.nonce || "");
  try {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(nonce)) throw new Error("Invalid request confirmation.");
    const settings = validateSupabaseSettings(parameters);
    const user = verifySupabaseUser(settings, String(parameters.access_token || ""));
    const context = getUserContext(settings, parameters.access_token, settings.apiKey);
    let result;

    if (parameters.action === "lookup") {
      result = { ok: true, data: lookupLists(context.spreadsheet_id) };
    } else if (parameters.action === "submit") {
      const submission = parseSubmission(parameters.submission);
      result = { ok: true, data: appendSavedSubmission(settings, parameters.access_token, user, context, submission) };
    } else {
      throw new Error("Unknown spreadsheet action.");
    }

    return postMessagePage({ nonce, ...result });
  } catch (error) {
    console.error("Portal spreadsheet request failed.", error);
    return postMessagePage({
      nonce: /^[A-Za-z0-9_-]{16,100}$/.test(nonce) ? nonce : "",
      ok: false,
      error: error && error.message ? error.message : "Could not access Google Sheets.",
    });
  }
}

function validateSupabaseSettings(parameters) {
  const projectUrl = String(parameters.supabase_url || "").replace(/\/+$/, "");
  const apiKey = String(parameters.api_key || "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(projectUrl)) {
    throw new Error("The configured Supabase Project URL is invalid.");
  }
  if (!apiKey || /service[_-]?role|secret/i.test(apiKey)) {
    throw new Error("A Supabase publishable or anon key is required.");
  }
  return { projectUrl, apiKey };
}

function verifySupabaseUser(settings, accessToken) {
  if (accessToken.length < 20 || accessToken.length > 8192) {
    throw new Error("Your sign-in session is missing or invalid.");
  }
  const response = UrlFetchApp.fetch(settings.projectUrl + "/auth/v1/user", {
    method: "get",
    headers: {
      apikey: settings.apiKey,
      Authorization: "Bearer " + accessToken,
    },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error("Supabase could not verify your sign-in. Please sign in again.");
  }
  const user = JSON.parse(response.getContentText());
  if (!user.id || !user.email) throw new Error("Supabase returned an invalid user.");
  return user;
}

function getUserContext(settings, accessToken, apiKey) {
  const response = UrlFetchApp.fetch(settings.projectUrl + "/functions/v1/portal-admin", {
    method: "post",
    contentType: "application/json",
    headers: {
      apikey: apiKey,
      Authorization: "Bearer " + accessToken,
    },
    payload: JSON.stringify({ action: "sheets_context" }),
    muteHttpExceptions: true,
  });
  const result = JSON.parse(response.getContentText() || "{}");
  if (response.getResponseCode() !== 200) {
    throw new Error(result.error || "Could not load your spreadsheet assignment.");
  }
  if (!result.spreadsheet_id || !result.output_tab) {
    throw new Error("The Master Admin has not connected a spreadsheet and assigned a tab to your account.");
  }
  return result;
}

function lookupLists(spreadsheetId) {
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  return {
    products: getProducts(spreadsheet),
    departments: getColumnValues(spreadsheet, "area", 1),
    suppliers: getColumnValues(spreadsheet, "dd", 2),
  };
}

function getProducts(spreadsheet) {
  const sheet = spreadsheet.getSheetByName("data");
  if (!sheet) throw new Error("The data tab was not found.");
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(normalizeHeader);
  const column = (aliases, required) => {
    const index = headers.findIndex(header => aliases.includes(header));
    if (required && index < 0) throw new Error("The data tab is missing a required product column: " + aliases[0] + ".");
    return index;
  };
  const sku = column(["skucode"], true);
  const description = column(["productdescription", "productdedscription"], true);
  const uom = column(["uom"], false);
  const expiration = column(["expirationdate"], false);
  const onhand = column(["qtyonhand"], false);
  const totalOnhand = column(["totalqtyonhand", "totalonhand"], false);
  const cost = column(["cost"], false);
  const srp = column(["srp"], false);
  const text = (row, index) => index < 0 ? "" : cellText(row[index]);

  return values.slice(1)
    .filter(row => row[sku] && row[description])
    .map(row => ({
      "SKU CODE": String(row[sku]),
      "PRODUCT DESCRIPTION": String(row[description]),
      UOM: text(row, uom),
      "EXPIRATION DATE": text(row, expiration),
      "QTY ONHAND": text(row, onhand),
      "TOTAL QTY ONHAND": text(row, totalOnhand),
      COST: text(row, cost),
      SRP: text(row, srp),
    }));
}

function getColumnValues(spreadsheet, tabName, column) {
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) throw new Error("The " + tabName + " tab was not found.");
  const lastRow = sheet.getLastRow();
  if (!lastRow) return [];
  return [...new Set(sheet.getRange(1, column, lastRow, 1).getDisplayValues()
    .flat()
    .map(value => value.trim())
    .filter(Boolean))];
}

function appendSavedSubmission(settings, accessToken, user, context, submission) {
  if (!/^(RRF|TRF|PUF|POF)-\d{7,}$/.test(String(submission.request_number || ""))) {
    throw new Error("The request number is invalid.");
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(submission.request_id || ""))) {
    throw new Error("The Supabase request ID is invalid.");
  }
  const request = fetchSupabaseRows(settings, accessToken, "requests", {
    select: "id,user_id,form_type,request_number,outgoing_department,incoming_department,supplier,created_at",
    id: submission.request_id,
    user_id: user.id,
  })[0];
  if (!request) throw new Error("The saved request could not be found for your account.");
  if (request.request_number !== submission.request_number) throw new Error("The saved request number does not match.");
  const sequenceMatch = String(request.request_number).match(/^(?:RRF|TRF|PUF|POF)-(\d{7,})$/);
  if (!sequenceMatch) throw new Error("The saved request number is invalid.");
  const sequenceNumber = Number(sequenceMatch[1]);
  const account = fetchSupabaseRows(settings, accessToken, "login_usernames", {
    select: "username",
    user_id: user.id,
  })[0];
  const submittedBy = requiredText(account && account.username, "Portal username");

  const savedItems = fetchSupabaseRows(settings, accessToken, "request_items", {
    select: "sku_code,product_description,uom,expiration_date,qty_onhand,total_qty_onhand,cost,srp,transfer_qty,remarks",
    request_id: submission.request_id,
    order: "id.asc",
  });
  if (!savedItems.length) throw new Error("The saved request has no item rows.");
  const items = validateSavedItems(savedItems, submission.items);
  const formType = requiredText(request.form_type, "Form type");
  if (!["release-request", "transfer", "pull-out", "purchase-order"].includes(formType)) {
    throw new Error("Unknown request form type.");
  }
  const outgoing = requiredText(request.outgoing_department, "Outgoing department");
  const incoming = requiredText(request.incoming_department, "Incoming department");
  const supplier = String(request.supplier || "").trim();
  if (formType === "purchase-order" && !supplier) throw new Error("A supplier is required for purchase orders.");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.openById(context.spreadsheet_id);
    const sheet = spreadsheet.getSheetByName(context.output_tab) || spreadsheet.insertSheet(context.output_tab);
    ensureHeaders(sheet);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const copiedNumbers = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat();
      const existingCount = copiedNumbers.filter(number => number === request.request_number).length;
      if (existingCount) {
        if (existingCount !== items.length) {
          throw new Error("A partial copy of this request already exists. Contact your administrator before retrying.");
        }
        return { alreadyCopied: true };
      }
    }

    const rows = items.map(item => [
      request.request_number,
      formType,
      Utilities.formatDate(new Date(request.created_at), Session.getScriptTimeZone(), "yyyy-MM-dd"),
      outgoing,
      incoming,
      supplier,
      submittedBy,
      item.sku_code,
      item.product_description,
      item.uom,
      item.expiration_date,
      numberOrBlank(item.qty_onhand),
      numberOrBlank(item.total_qty_onhand),
      numberOrBlank(item.cost),
      numberOrBlank(item.srp),
      numberOrBlank(item.transfer_qty),
      item.remarks,
      sequenceNumber,
    ]);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, REQUEST_HEADERS.length).setValues(rows);
    return { alreadyCopied: false };
  } finally {
    lock.releaseLock();
  }
}

function fetchSupabaseRows(settings, accessToken, table, filters) {
  const query = Object.keys(filters)
    .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(
      key === "order" ? filters[key] : "eq." + filters[key],
    ))
    .join("&");
  const response = UrlFetchApp.fetch(settings.projectUrl + "/rest/v1/" + table + "?" + query, {
    method: "get",
    headers: {
      apikey: settings.apiKey,
      Authorization: "Bearer " + accessToken,
    },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error("Could not verify the saved request details in Supabase.");
  }
  const result = JSON.parse(response.getContentText());
  if (!Array.isArray(result)) throw new Error("Supabase returned invalid saved request data.");
  return result;
}

function validateSavedItems(savedItems, submittedItems) {
  if (!Array.isArray(submittedItems) || savedItems.length !== submittedItems.length) {
    throw new Error("The submitted items do not match the saved request.");
  }
  const signature = item => JSON.stringify([
    String(item.sku_code || ""),
    String(item.product_description || ""),
    String(item.uom || ""),
    String(item.expiration_date || ""),
    numberOrBlank(item.qty_onhand),
    numberOrBlank(item.total_qty_onhand),
    numberOrBlank(item.cost),
    numberOrBlank(item.srp),
    numberOrBlank(item.transfer_qty),
    String(item.remarks || ""),
  ]);
  const saved = savedItems.map(signature).sort();
  const submitted = submittedItems.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("A submitted request item is invalid.");
    return signature(item);
  }).sort();
  if (saved.some((value, index) => value !== submitted[index])) {
    throw new Error("The submitted items do not match the saved request.");
  }
  return savedItems.map(item => ({
    sku_code: requiredText(item.sku_code, "SKU code"),
    product_description: requiredText(item.product_description, "Product description"),
    uom: String(item.uom || ""),
    expiration_date: String(item.expiration_date || ""),
    qty_onhand: item.qty_onhand,
    total_qty_onhand: item.total_qty_onhand,
    cost: item.cost,
    srp: item.srp,
    transfer_qty: item.transfer_qty,
    remarks: String(item.remarks || ""),
  }));
}

function parseSubmission(value) {
  let submission;
  try {
    submission = JSON.parse(value || "{}");
  } catch {
    throw new Error("The submitted request details are invalid.");
  }
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
    throw new Error("The submitted request details are invalid.");
  }
  return submission;
}

function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, REQUEST_HEADERS.length).setValues([REQUEST_HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }
  const current = sheet.getRange(1, 1, 1, Math.max(REQUEST_HEADERS.length + 1, sheet.getLastColumn())).getDisplayValues()[0];
  if (REQUEST_HEADERS.slice(0, 17).some((header, index) => current[index] !== header)) {
    throw new Error("The '" + sheet.getName() + "' tab already has different columns. Ask the administrator to choose an empty tab.");
  }
  if (current[17] === "Supabase Request ID") {
    const lastRow = Math.max(sheet.getLastRow(), 1);
    sheet.getRange(1, 18, lastRow, 2).clearContent();
    const sequenceColumn = [[REQUEST_HEADERS[17]]];
    if (lastRow > 1) {
      const requestNumbers = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
      sequenceColumn.push(...requestNumbers.map(([requestNumber]) => {
        const match = String(requestNumber).match(/^(?:RRF|TRF|PUF|POF)-(\d{7,})$/);
        return [match ? Number(match[1]) : ""];
      }));
    }
    sheet.getRange(1, 18, sequenceColumn.length, 1).setValues(sequenceColumn);
    return;
  }
  if (current[17] && current[17] !== REQUEST_HEADERS[17]) {
    throw new Error("The '" + sheet.getName() + "' tab already has different columns. Ask the administrator to choose an empty tab.");
  }
  if (current[18]) {
    throw new Error("The '" + sheet.getName() + "' tab already has different columns. Ask the administrator to choose an empty tab.");
  }
  if (!current[17]) {
    const sequenceColumn = [[REQUEST_HEADERS[17]]];
    if (sheet.getLastRow() > 1) {
      const requestNumbers = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
      sequenceColumn.push(...requestNumbers.map(([requestNumber]) => {
        const match = String(requestNumber).match(/^(?:RRF|TRF|PUF|POF)-(\d{7,})$/);
        return [match ? Number(match[1]) : ""];
      }));
    }
    sheet.getRange(1, 18, sequenceColumn.length, 1).setValues(sequenceColumn);
  }
}

function numberOrBlank(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("A quantity or price is not a valid number.");
  return number;
}

function requiredText(value, label) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) throw new Error(label + " is required.");
  return text;
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(value);
}

function postMessagePage(message) {
  const json = JSON.stringify(message).replace(/</g, "\\u003c");
  const html = "<!doctype html><html><body><script>window.parent.postMessage(" +
    json + ", '*');</script></body></html>";
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
