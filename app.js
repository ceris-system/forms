const FORM_TYPES = [
  { id: "release-request", name: "Release & Request Form", shortName: "Release & Request", prefix: "RRF", description: "Request or release inventory between departments.", symbol: "📤" },
  { id: "transfer", name: "Transfer Form", shortName: "Transfer", prefix: "TRF", description: "Record stock transfers between departments.", symbol: "🔄" },
  { id: "pull-out", name: "Pull Out Form", shortName: "Pull Out", prefix: "PUF", description: "Document items being pulled out of inventory.", symbol: "📦" },
  { id: "purchase-order", name: "Purchase Order Form", shortName: "Purchase Order", prefix: "POF", description: "Record purchase order requests.", symbol: "🛒" },
];

const HISTORY_FORM_TYPES = {
  "request-history": "release-request",
  "transfer-history": "transfer",
  "pullout-history": "pull-out",
  "po-history": "purchase-order",
};

const DEPLOYMENT_SETTINGS = {
  supabase: {
    url: "https://kwxdjrnhkfgtpnxvygxu.supabase.co",
    key: "sb_publishable_pCmaI5bEX7uOTgXGRdgE2Q_wOiYsZkH",
  },
};
const ITEM_FIELDS = ["SKU Code", "Product Description", "UOM", "Cost", "SRP", "Expiration Date", "Onhand", "Total Onhand", "Transfer Qty", "Remarks"];
const CATALOG_FIELDS = ["SKU CODE", "PRODUCT DESCRIPTION", "UOM", "COST", "SRP", "EXPIRATION DATE", "QTY ONHAND", "TOTAL QTY ONHAND"];
const userFormGrid = document.querySelector("#user-form-grid");
const saveStatus = document.querySelector("#save-status");
const requestDialog = document.querySelector("#request-dialog");
const requestFormBody = document.querySelector("#request-form-body");
const catalogDialog = document.querySelector("#catalog-dialog");
const catalogProducts = document.querySelector("#catalog-products");
const catalogStatus = document.querySelector("#catalog-status");
const passwordChangeDialog = document.querySelector("#password-change-dialog");
const installAppButtons = [...document.querySelectorAll(".install-app-button")];
let catalogRows = [];
let selectedCatalogRows = new Set();
let supabaseClient = null;
let currentSession = null;
let currentUserProfile = {
  username: "",
  department: "",
  status: "active",
  role: "user",
  allowedFormTypes: [],
  mustChangePassword: false,
};
let authSubscription = null;
let isMasterAdmin = false;
let isAdmin = false;
let profileUserId = "";
let adminStatusUserId = "";
let lookupCache = null;
let activePageId = "";
let activitySessionId = "";
let activitySessionUserId = "";
let endedActivitySessionId = "";
let notificationCountLoadId = 0;
let notificationOffset = 0;
let notificationRequestToReveal = null;
let notificationRefreshTimer = null;
let currentUnreadNotificationCount = 0;
let adminUserAccounts = [];
let activityLogs = [];
let activityLogOffset = 0;
let activityLogsHaveMore = false;
let activityLogLoadId = 0;
let pendingInstallPrompt = null;
const workflowLoadIds = new Map();
const IDLE_SIGN_OUT_DELAY = 10 * 60 * 1000;
let idleSignOutTimer = null;
let inventoryRows = [];
let inventoryCategories = [];
let inventoryDepartment = "";
let selectedInventoryRow = null;
const inventoryLoadIds = new Map();
const historyRows = new Map();
const historyDepartments = new Map();
const historyLoadIds = new Map();

function resetIdleSignOutTimer() {
  clearTimeout(idleSignOutTimer);
  idleSignOutTimer = null;
  if (!currentSession || !supabaseClient) return;
  idleSignOutTimer = setTimeout(async () => {
    const userId = currentSession?.user.id;
    if (!userId) return;
    try {
      await logActivitySessionEnd("Signed out after 10 minutes of inactivity.");
      const { error } = await supabaseClient.auth.signOut({ scope: "local" });
      if (error) throw error;
      if (!currentSession) saveStatus.textContent = "You were signed out after 10 minutes of inactivity.";
    } catch (error) {
      console.error("Automatic sign-out after inactivity failed.", error);
      saveStatus.textContent = `Automatic sign-out failed: ${error.message || "Request failed."}`;
      resetIdleSignOutTimer();
    }
  }, IDLE_SIGN_OUT_DELAY);
}

async function signOutOnPageExit() {
  if (!currentSession || !supabaseClient) return;
  try {
    await logActivitySessionEnd("Signed out when leaving the portal.");
    const { error } = await supabaseClient.auth.signOut({ scope: "local" });
    if (error) throw error;
  } catch (error) {
    console.error("Sign-out while leaving the page failed.", error);
  }
}

for (const eventName of ["pointerdown", "pointermove", "keydown", "scroll", "touchstart", "click"]) {
  document.addEventListener(eventName, resetIdleSignOutTimer, { passive: true });
}
window.addEventListener("pagehide", () => void signOutOnPageExit());

function setInstallButtonsVisible(visible) {
  for (const button of installAppButtons) button.hidden = !visible;
}

function showInstallMessage(message) {
  saveStatus.textContent = message;
  document.querySelector("#install-app-status").textContent = message;
}

async function installPortalApp() {
  if (!pendingInstallPrompt) {
    const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    showInstallMessage(isAppleMobile
      ? "To install, tap Share in Safari, then choose Add to Home Screen."
      : "To install, use your browser's Install app option or choose Install page from its menu.");
    return;
  }
  for (const button of installAppButtons) button.disabled = true;
  try {
    await pendingInstallPrompt.prompt();
    const choice = await pendingInstallPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setInstallButtonsVisible(false);
      showInstallMessage("Installing MW FORM…");
    } else {
      showInstallMessage("Installation was cancelled. You can install the app later from this button.");
    }
    pendingInstallPrompt = null;
  } catch (error) {
    console.error("Unable to start app installation.", error);
    showInstallMessage(`Could not start app installation: ${error.message || "Use your browser's Install app menu."}`);
  } finally {
    for (const button of installAppButtons) button.disabled = false;
  }
}

function getLocalDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

function formatDisplayDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, year, month, day] = match;
  } else {
    match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) [, month, day, year] = match;
  }

  let date;
  if (match) {
    date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() !== Number(year)
      || date.getUTCMonth() !== Number(month) - 1
      || date.getUTCDate() !== Number(day)
    ) return text;
  } else {
    date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date).toLocaleUpperCase();
}

function makeUserFormButton(form) {
  const card = document.createElement("button");
  card.className = "user-form-card";
  card.type = "button";
  card.dataset.openForm = form.id;
  card.innerHTML = `
    <span class="form-symbol" aria-hidden="true">${form.symbol}</span>
    <span class="form-name">${form.name}</span>
    <span class="form-description">${form.description}</span>
    <span class="open-form-button">Open form <span aria-hidden="true">➡️</span></span>`;
  return card;
}

function openRequestForm(form) {
  if (!currentSession) {
    if (!supabaseClient) {
      saveStatus.textContent = "The portal is not connected yet. Contact your administrator.";
      return;
    }
    if (!isAdmin && !currentUserProfile.allowedFormTypes.includes(form.id)) {
      saveStatus.textContent = "Your account is not assigned access to this form. Contact an administrator.";
      return;
    }
    saveStatus.textContent = "Sign in with your invited user account to open and submit forms.";
    document.querySelector("#auth-username").focus();
    return;
  }
  document.querySelector("#form-dialog-title").textContent = form.name;
  requestFormBody.innerHTML = `
    <div class="request-sheet-top">
      <div class="request-department-field">
        <label for="outgoing-department">OUTGOING DEPARTMENT:<small>(REQUESTED FROM)</small></label>
        <select id="outgoing-department" required disabled><option value="">Loading departments…</option></select>
      </div>
      <div class="request-department-field">
        <label for="incoming-department">INCOMING DEPARTMENT:<small>(REQUESTING)</small></label>
        <select id="incoming-department" required disabled><option value="">Loading departments…</option></select>
      </div>
      ${form.id === "purchase-order" ? `
      <div class="request-department-field request-supplier-field">
        <label for="request-supplier">SUPPLIER:</label>
        <select id="request-supplier" required disabled><option value="">Loading suppliers…</option></select>
      </div>
      ` : ""}
      <div class="request-number-date">
        <p><span>SEQUENCE NO.:</span><strong class="request-number" aria-live="polite">Select outgoing department</strong></p>
        <p><span>DATE:</span><strong>${formatDisplayDate(getLocalDate())}</strong></p>
      </div>
    </div>
    <div class="request-sheet-actions">
      <button class="button add-product-button" type="button" data-add-item disabled><span aria-hidden="true">➕</span> Select products</button>
      <button class="button button-primary submit-request-button" type="submit"><span aria-hidden="true">📤</span> Submit</button>
    </div>
    <p class="request-inline-notice" role="status" aria-live="polite"></p>
    <div class="approval-status"><strong>STATUS</strong><span>Pending ➡️ Approved ➡️ Released ➡️ Received. Master Admin approves; matching departments release and receive.</span></div>
    <div class="request-sheet-items">
      <p class="request-info-label">REQUEST INFORMATION</p>
      <div class="request-table-scroll">
        <table class="request-items-table">
          <thead><tr>${ITEM_FIELDS.map((field) => `<th scope="col">${field === "Expiration Date" ? "EXP. DATE" : field.toUpperCase()}</th>`).join("")}<th scope="col" aria-label="Row actions"></th></tr></thead>
          <tbody class="request-items-list"></tbody>
        </table>
      </div>
    </div>`;
  requestFormBody.querySelector(".request-items-list").append(makeRequestItemRow(1));
  const outgoingDepartment = requestFormBody.querySelector("#outgoing-department");
  const addProductButton = requestFormBody.querySelector("[data-add-item]");
  outgoingDepartment.addEventListener("change", () => {
    addProductButton.disabled = !outgoingDepartment.value;
    void loadSequencePreview(form.id, outgoingDepartment.value);
  });
  document.querySelector(".request-form-notice").textContent = `Signed in as ${currentUserProfile.username || "user"}.`;
  requestDialog.dataset.formType = form.id;
  requestDialog.showModal();
  loadRequestLookups(form.id);
}

function setRequestNotice(message) {
  document.querySelector(".request-form-notice").textContent = message;
  const inlineNotice = requestFormBody.querySelector(".request-inline-notice");
  if (inlineNotice) inlineNotice.textContent = message;
}

function makeRequestItemRow(number, product = {}) {
  const row = document.createElement("tr");
  row.className = "request-item-row";
  for (const field of ITEM_FIELDS) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.type = field === "Expiration Date" ? "date" : ["Onhand", "Total Onhand", "Cost", "SRP", "Transfer Qty"].includes(field) ? "number" : "text";
    if (["Cost", "SRP"].includes(field)) input.step = "0.01";
    if (["Onhand", "Total Onhand", "Transfer Qty"].includes(field)) input.step = "any";
    if (!["Transfer Qty", "Remarks"].includes(field)) input.disabled = true;
    input.setAttribute("aria-label", `Item ${number} ${field}`);
    input.placeholder = field;
    input.value = product[field] || "";
    cell.append(input);
    row.append(cell);
  }
  const actions = document.createElement("td");
  const remove = document.createElement("button");
  remove.className = "remove-item-button";
  remove.type = "button";
  remove.dataset.removeItem = "";
  remove.setAttribute("aria-label", `Remove item ${number}`);
  remove.textContent = "🗑️";
  actions.append(remove);
  row.append(actions);
  return row;
}

async function openProductCatalog() {
  const outgoingDepartment = requestFormBody.querySelector("#outgoing-department").value.trim();
  if (!outgoingDepartment) {
    requestFormBody.querySelector("[data-add-item]").disabled = true;
    setRequestNotice("Select an outgoing department before adding products.");
    return;
  }
  catalogProducts.replaceChildren();
  selectedCatalogRows.clear();
  updateCatalogSelection();
  document.querySelector("#catalog-search").value = "";
  catalogRows = [];
  catalogStatus.textContent = "Loading products from the spreadsheet…";
  catalogDialog.showModal();

  try {
    const result = await loadLookupData();
    const selectedDepartment = outgoingDepartment.toLocaleLowerCase();
    catalogRows = result.products.filter(product =>
      String(product["OUTGOING DEPARTMENT"] || "").trim().toLocaleLowerCase() === selectedDepartment
    );
    if (!catalogRows.length) {
      catalogStatus.textContent = `No products in "${result.products_tab || "Products"}" match outgoing department "${outgoingDepartment}". Check column G from row 2 onward.`;
      return;
    }
    renderCatalogRows();
  } catch (error) {
    profileUserId = "";
    console.error("Unable to load products from Google Sheets.", error);
    catalogStatus.textContent = `Could not load products: ${error.message || "Google Sheets returned an unexpected error."}`;
    catalogRows = [];
  }
}

async function loadLookupData() {
  const userId = currentSession?.user.id;
  if (!userId) throw new Error("Sign in before loading spreadsheet lists.");
  if (lookupCache?.userId === userId && lookupCache.expiresAt > Date.now()) {
    return lookupCache.promise;
  }
  const cacheEntry = {
    userId,
    expiresAt: Date.now() + 30_000,
    promise: requestSheetData("lookup"),
  };
  lookupCache = cacheEntry;
  try {
    const result = await cacheEntry.promise;
    cacheEntry.expiresAt = Date.now() + 30_000;
    return result;
  } catch (error) {
    if (lookupCache === cacheEntry) lookupCache = null;
    throw error;
  }
}

async function requestSheetData(action, payload) {
  if (!supabaseClient || !currentSession) throw new Error("Sign in before accessing the assigned Google spreadsheet.");
  const { data, error } = await supabaseClient.functions.invoke("google-sheets-api", {
    body: {
      action,
      ...(action === "submit" ? { submission: payload } : action === "workflow_action" ? { workflow: payload } : payload || {}),
    },
  });
  if (error) throw new Error(await edgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  const activity = describeSuccessfulSheetAction(action, payload, data);
  if (activity) await recordUserActivity(activity.action, activity.details);
  return data;
}

function createActivitySessionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    return (character === "x" ? random : (random & 3 | 8)).toString(16);
  });
}

function ensureActivitySession(userId) {
  if (activitySessionUserId === userId && activitySessionId) return activitySessionId;
  const key = `mw-activity-session:${userId}`;
  const stored = sessionStorage.getItem(key);
  activitySessionId = stored && /^[0-9a-f-]{36}$/i.test(stored) ? stored : createActivitySessionId();
  sessionStorage.setItem(key, activitySessionId);
  activitySessionUserId = userId;
  endedActivitySessionId = "";
  return activitySessionId;
}

async function recordUserActivity(activity, details = "") {
  if (!supabaseClient || !currentSession?.user.id) return false;
  const sessionId = ensureActivitySession(currentSession.user.id);
  try {
    const { data, error } = await supabaseClient.functions.invoke("portal-admin", {
      body: { action: "activity_log_create", session_id: sessionId, activity, details },
    });
    if (error) throw new Error(await edgeFunctionErrorMessage(error));
    if (data?.error) throw new Error(data.error);
    return true;
  } catch (error) {
    console.error(`Could not record user activity "${activity}".`, error);
    const status = document.querySelector("#activity-log-status");
    if (status) status.textContent = `Activity logging error: ${error.message || "Request failed."}`;
    else saveStatus.textContent = `Activity logging error: ${error.message || "Request failed."}`;
    return false;
  }
}

async function logActivitySessionEnd(details) {
  const userId = currentSession?.user.id;
  if (!userId) return;
  const sessionId = ensureActivitySession(userId);
  if (endedActivitySessionId === sessionId) return;
  const logged = await recordUserActivity("Signed out", details);
  if (logged) endedActivitySessionId = sessionId;
}

function describeSuccessfulSheetAction(action, payload, result) {
  if (action === "submit") {
    const form = FORM_TYPES.find(item => item.id === payload?.form_type)?.shortName || "request form";
    return {
      action: `Submitted ${form}`,
      details: [
        result?.request_number ? `Request ${result.request_number}` : "",
        payload?.outgoing_department && payload?.incoming_department
          ? `${payload.outgoing_department} to ${payload.incoming_department}`
          : "",
      ].filter(Boolean).join(" · "),
    };
  }
  if (action === "workflow_action") {
    const actionName = {
      approve: "Approved",
      release: "Marked released",
      receive: "Marked received",
    }[payload?.action] || "Updated workflow";
    return {
      action: `${actionName} request`,
      details: String(payload?.request_number || ""),
    };
  }
  if (action === "inventory_adjustment_update") {
    return {
      action: "Updated inventory",
      details: [String(result?.department || payload?.department || ""), String(payload?.sku_code || "")]
        .filter(Boolean).join(" · "),
    };
  }
  return null;
}

function setInventoryDepartmentOptions(departments) {
  for (const id of ["inventory-department", "inventory-form-department"]) {
    const select = document.querySelector(`#${id}`);
    const selected = inventoryDepartment;
    select.replaceChildren(new Option("Select department…", ""));
    for (const department of departments) select.add(new Option(department, department));
    select.value = departments.find(value => value.toLocaleLowerCase() === selected.toLocaleLowerCase()) || "";
    select.disabled = departments.length === 0;
  }
  for (const id of ["inventory-assigned-department", "inventory-form-assigned-department"]) {
    document.querySelector(`#${id}`).textContent = inventoryDepartment || currentUserProfile.department || "Not assigned";
  }
}

function renderInventoryRows() {
  const search = document.querySelector("#inventory-search").value.trim().toLocaleLowerCase();
  const filtered = inventoryRows.filter(row =>
    [row.sku_code, row.description, row.uom, row.cost, row.srp, row.near_expiration, row.on_hand, row.total_on_hand, row.department]
      .some(value => String(value || "").toLocaleLowerCase().includes(search))
  );
  const body = document.querySelector("#inventory-rows");
  body.replaceChildren();
  for (const row of filtered) {
    const tr = document.createElement("tr");
    const values = [row.sku_code, row.description, row.uom, row.cost, row.srp, row.near_expiration, row.on_hand, row.total_on_hand, row.department];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.textContent = index === 5 ? formatDisplayDate(value) : value == null ? "" : String(value);
      tr.append(cell);
    }
    const actionCell = document.createElement("td");
    const view = document.createElement("button");
    view.type = "button";
    view.className = "button button-secondary inventory-view-button";
    view.dataset.inventoryRow = String(row.sheet_row);
    view.textContent = "View";
    actionCell.append(view);
    tr.append(actionCell);
    body.append(tr);
  }
  const status = document.querySelector("#inventory-status");
  if (inventoryRows.length) status.textContent = `${filtered.length} of ${inventoryRows.length} inventory items${inventoryDepartment ? ` · ${inventoryDepartment}` : ""}.`;
  else if (inventoryDepartment) status.textContent = `No inventory items were found for ${inventoryDepartment}.`;
  else status.textContent = "Select a department to load its inventory.";
}

function renderInventoryFormRows() {
  const body = document.querySelector("#inventory-form-rows");
  body.replaceChildren();
  for (const row of inventoryRows) {
    const tr = document.createElement("tr");
    const values = [
      row.sku_code, row.description, row.uom, row.expiration_2, row.total_on_hand,
      row.expiration_1, row.qty_1, row.expiration_2, row.qty_2,
      row.expiration_3, row.qty_3, row.total_on_hand,
    ];
    for (const [index, value] of values.entries()) {
      const cell = document.createElement("td");
      cell.textContent = [3, 5, 7, 9].includes(index)
        ? formatDisplayDate(value)
        : value == null ? "" : String(value);
      tr.append(cell);
    }
    body.append(tr);
  }
}

async function loadInventoryPage(pageId, refresh = false) {
  const isInventoryForm = pageId === "inventory-form";
  const loadId = (inventoryLoadIds.get(pageId) || 0) + 1;
  const userId = currentSession?.user.id;
  inventoryLoadIds.set(pageId, loadId);
  const status = document.querySelector(isInventoryForm ? "#inventory-form-status" : "#inventory-status");
  const departmentSelect = document.querySelector(isInventoryForm ? "#inventory-form-department" : "#inventory-department");
  const requestedDepartment = isAdmin
    ? departmentSelect.value || inventoryDepartment
    : currentUserProfile.department;
  inventoryRows = [];
  if (isInventoryForm) renderInventoryFormRows();
  else renderInventoryRows();
  if (isAdmin && !requestedDepartment) {
    inventoryDepartment = "";
    setInventoryDepartmentOptions([]);
    status.textContent = "Loading departments from AREA!A1:A…";
  } else {
    status.textContent = refresh ? "Refreshing inventory…" : "Loading inventory…";
  }
  try {
    const result = await requestSheetData("inventory_load", { department: requestedDepartment });
    if (inventoryLoadIds.get(pageId) !== loadId || activePageId !== pageId || currentSession?.user.id !== userId) return false;
    inventoryCategories = result.categories || [];
    inventoryDepartment = result.department || "";
    setInventoryDepartmentOptions(result.departments || []);
    inventoryRows = result.rows || [];
    if (!inventoryDepartment) {
      if (isInventoryForm) renderInventoryFormRows();
      else renderInventoryRows();
      return true;
    }
    if (isInventoryForm) renderInventoryFormRows();
    else renderInventoryRows();
    return true;
  } catch (error) {
    if (inventoryLoadIds.get(pageId) !== loadId || activePageId !== pageId || currentSession?.user.id !== userId) return false;
    console.error("Unable to load department inventory.", error);
    status.textContent = `Could not load inventory: ${error.message || "Request failed."}`;
    return false;
  }
}

function renderRequestHistory(pageId) {
  const section = document.querySelector(`#${pageId}`);
  const rows = historyRows.get(pageId) || [];
  const search = section.querySelector("[data-history-search]").value.trim().toLocaleLowerCase();
  const filtered = rows.filter(row =>
    Object.values(row).some(value => String(value ?? "").toLocaleLowerCase().includes(search))
  );
  const body = section.querySelector("[data-history-rows]");
  body.replaceChildren();
  const fields = [
    "serial_number",
    ...(pageId === "po-history" ? ["supplier"] : []),
    "outgoing_department", "sku_code", "product_description", "uom",
    "expiration_date", "on_hand", "total_on_hand", "cost", "srp", "approved_transfer_qty",
    "second_expiration_date", "received_qty", "remarks", "incoming_department", "request_date", "received_date",
  ];
  for (const row of filtered) {
    const tr = document.createElement("tr");
    for (const field of fields) {
      const cell = document.createElement("td");
      cell.textContent = ["expiration_date", "second_expiration_date", "request_date", "received_date"].includes(field)
        ? formatDisplayDate(row[field])
        : row[field] == null ? "" : String(row[field]);
      tr.append(cell);
    }
    body.append(tr);
  }
  const department = historyDepartments.get(pageId) || "";
  const status = section.querySelector("[data-history-status]");
  status.textContent = rows.length
    ? `${filtered.length} of ${rows.length} non-pending history rows${department ? ` · ${department}` : ""}.`
    : department ? `No non-pending history was found for ${department}.` : "Select a department to load history.";
}

function setHistoryDepartmentOptions(section, departments, selected) {
  const select = section.querySelector("[data-history-department]");
  select.replaceChildren(new Option("Select department…", ""));
  for (const department of departments) select.add(new Option(department, department));
  select.value = departments.find(value => value.toLocaleLowerCase() === selected.toLocaleLowerCase()) || "";
  select.disabled = departments.length === 0;
  section.querySelector("[data-history-assigned-department]").textContent =
    selected || currentUserProfile.department || "Not assigned";
}

async function loadRequestHistory(pageId, refresh = false) {
  const section = document.querySelector(`#${pageId}`);
  const formType = HISTORY_FORM_TYPES[pageId];
  if (!section || !formType) return;
  const loadId = (historyLoadIds.get(pageId) || 0) + 1;
  const userId = currentSession?.user.id;
  historyLoadIds.set(pageId, loadId);
  const status = section.querySelector("[data-history-status]");
  const departmentSelect = section.querySelector("[data-history-department]");
  const selectedDepartment = isAdmin
    ? departmentSelect.value || historyDepartments.get(pageId) || ""
    : currentUserProfile.department;
  historyDepartments.set(pageId, selectedDepartment);
  historyRows.set(pageId, []);
  renderRequestHistory(pageId);
  status.textContent = refresh ? "Refreshing history…" : "Loading history…";
  try {
    const result = await requestSheetData("request_history_load", {
      form_type: formType,
      department: selectedDepartment,
    });
    if (historyLoadIds.get(pageId) !== loadId || activePageId !== pageId || currentSession?.user.id !== userId) return;
    historyDepartments.set(pageId, result.department || "");
    setHistoryDepartmentOptions(section, result.departments || [], result.department || "");
    historyRows.set(pageId, result.rows || []);
    renderRequestHistory(pageId);
  } catch (error) {
    if (historyLoadIds.get(pageId) !== loadId || activePageId !== pageId || currentSession?.user.id !== userId) return;
    console.error("Unable to load request history.", error);
    status.textContent = `Could not load history: ${error.message || "Request failed."}`;
  }
}

function showInventoryItem(sheetRow) {
  selectedInventoryRow = inventoryRows.find(row => Number(row.sheet_row) === sheetRow);
  if (!selectedInventoryRow) return;
  const row = selectedInventoryRow;
  const detailFields = {
    "inventory-item-sku": row.sku_code,
    "inventory-item-description": row.description,
    "inventory-item-cost": row.cost,
    "inventory-item-srp": row.srp,
    "inventory-item-received-qty": row.received_qty,
    "inventory-item-latest-received": formatDisplayDate(row.latest_received),
    "inventory-item-total": row.total_on_hand,
  };
  for (const [id, value] of Object.entries(detailFields)) {
    document.querySelector(`#${id}`).textContent = value == null ? "" : String(value);
  }
  const batches = document.querySelector("#inventory-item-batches");
  batches.replaceChildren();
  for (const [index, date, qty] of [
    [1, row.expiration_1, row.qty_1],
    [2, row.expiration_2, row.qty_2],
    [3, row.expiration_3, row.qty_3],
  ]) {
    const batchLabel = ["1ST", "2ND", "3RD"][index - 1];
    const batch = document.createElement("div");
    batch.className = "inventory-batch-editor-row";
    const dateLabel = document.createElement("label");
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.id = `inventory-batch-${index}-date`;
    dateInput.dataset.inventoryBatchDate = String(index);
    dateInput.value = toDateInputValue(String(date ?? ""));
    dateLabel.htmlFor = dateInput.id;
    dateLabel.append(document.createTextNode(`EXPIRATION DATE ${batchLabel}`), dateInput);

    const qtyLabel = document.createElement("label");
    const qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.step = "any";
    qtyInput.min = "0";
    qtyInput.id = `inventory-batch-${index}-qty`;
    qtyInput.dataset.inventoryBatchQty = String(index);
    qtyInput.value = qty == null ? "" : String(qty);
    qtyLabel.htmlFor = qtyInput.id;
    qtyLabel.append(document.createTextNode("QTY"), qtyInput);
    batch.append(dateLabel, qtyLabel);
    batches.append(batch);
  }
  const category = document.querySelector("#inventory-adjustment-category");
  category.replaceChildren(new Option("Select category…", ""));
  for (const value of inventoryCategories) category.add(new Option(value, value));
  category.value = inventoryCategories.find(value =>
    value.toLocaleLowerCase() === String(row.adjustment_category || "").toLocaleLowerCase()
  ) || "";
  category.disabled = inventoryCategories.length === 0;
  document.querySelector("#inventory-adjustment-qty").value = row.adjustment_qty || "";
  document.querySelector("#inventory-adjustment-remarks").value = row.adjustment_remarks || "";
  document.querySelector("#inventory-adjustment-status").textContent = "";
  document.querySelector("#inventory-item-dialog").showModal();
}

async function saveInventoryAdjustment(event) {
  event.preventDefault();
  if (!selectedInventoryRow) return;
  const button = document.querySelector("#update-inventory-adjustment");
  const status = document.querySelector("#inventory-adjustment-status");
  const progress = document.querySelector("#inventory-save-progress");
  const skuCode = selectedInventoryRow.sku_code;
  const requestedDepartment = isAdmin
    ? inventoryDepartment
    : currentUserProfile.department;
  const originalButtonText = button.textContent;
  button.disabled = true;
  button.textContent = "Updating…";
  progress.hidden = false;
  status.textContent = `Saving changes to ${requestedDepartment || "your department"} sheet…`;
  try {
    const result = await requestSheetData("inventory_adjustment_update", {
      department: requestedDepartment,
      sheet_row: selectedInventoryRow.sheet_row,
      sku_code: skuCode,
      batches: [...document.querySelectorAll("[data-inventory-batch-date]")].map(dateInput => {
        const index = dateInput.dataset.inventoryBatchDate;
        const qtyInput = document.querySelector(`[data-inventory-batch-qty="${index}"]`);
        return { date: dateInput.value, qty: qtyInput.value };
      }),
      category: document.querySelector("#inventory-adjustment-category").value,
      qty: document.querySelector("#inventory-adjustment-qty").value,
      remarks: document.querySelector("#inventory-adjustment-remarks").value,
    });
    const savedDepartment = String(result.department || "").trim();
    if (!savedDepartment || savedDepartment.toLocaleLowerCase() !== requestedDepartment.toLocaleLowerCase()) {
      throw new Error(`The server confirmed a write to ${savedDepartment || "an unknown department"}, not ${requestedDepartment}.`);
    }
    status.textContent = `Saved to ${savedDepartment}. Reloading the latest inventory…`;
    const refreshed = await loadInventoryPage("inventory", true);
    if (!refreshed) {
      status.textContent = `Saved to ${savedDepartment}, but the inventory table could not be reloaded. Refresh the table to verify the latest data.`;
      return;
    }
    document.querySelector("#inventory-item-dialog").close();
    document.querySelector("#inventory-status").textContent = `Inventory updated for ${skuCode} in ${savedDepartment}.`;
  } catch (error) {
    console.error("Unable to update inventory adjustment.", error);
    status.textContent = `Could not update adjustment: ${error.message || "Request failed."}`;
  } finally {
    progress.hidden = true;
    button.disabled = false;
    button.textContent = originalButtonText;
  }
}

async function loadSequencePreview(formType, outgoingDepartment) {
  const number = requestFormBody.querySelector(".request-number");
  const outgoing = requestFormBody.querySelector("#outgoing-department");
  const requestId = Number(requestDialog.dataset.sequenceRequest || 0) + 1;
  requestDialog.dataset.sequenceRequest = String(requestId);
  if (!outgoingDepartment) {
    number.textContent = "Select outgoing department";
    return;
  }
  number.textContent = "Loading…";
  try {
    const result = await requestSheetData("sequence_preview", { form_type: formType });
    if (!requestDialog.open
      || requestDialog.dataset.formType !== formType
      || requestDialog.dataset.sequenceRequest !== String(requestId)
      || outgoing.value !== outgoingDepartment) return;
    const prefix = FORM_TYPES.find((form) => form.id === formType)?.prefix;
    if (!prefix) throw new Error("The selected form has no request number prefix.");
    number.textContent = `${prefix}-${String(result.sequence_number).padStart(7, "0")}`;
  } catch (error) {
    console.error("Unable to preview the next request sequence.", error);
    if (requestDialog.open
      && requestDialog.dataset.formType === formType
      && requestDialog.dataset.sequenceRequest === String(requestId)
      && outgoing.value === outgoingDepartment) {
      number.textContent = "Unavailable";
      setRequestNotice(`Could not preview the next sequence number: ${error.message || "Request failed."}`);
    }
  }
}

async function edgeFunctionErrorMessage(error) {
  if (error?.context instanceof Response) {
    try {
      const response = await error.context.clone().json();
      if (typeof response?.error === "string" && response.error) return response.error;
    } catch {
      return error.message || "The server request failed.";
    }
  }
  return error?.message || "The server request failed.";
}

async function refreshUserProfile(session) {
  if (!supabaseClient || currentSession?.user.id !== session.user.id) return;
  if (profileUserId === session.user.id) return;
  profileUserId = session.user.id;
  try {
    const profile = await callPortalAdmin({ action: "profile" });
    if (currentSession?.user.id !== session.user.id) return;
    currentUserProfile = {
      username: profile.username,
      department: profile.department,
      status: profile.status,
      role: profile.role || "user",
      allowedFormTypes: Array.isArray(profile.allowed_form_types) ? profile.allowed_form_types : [],
      mustChangePassword: profile.status === "default",
    };
    const incomingDepartment = requestFormBody.querySelector("#incoming-department");
    if (incomingDepartment) {
      incomingDepartment.replaceChildren(new Option(profile.department || "Department not assigned", profile.department || ""));
      incomingDepartment.disabled = !profile.department;
    }
    renderUserForms();
    updateSessionUi(session, false);
    if (activePageId === "inventory" || activePageId === "inventory-form") {
      void loadInventoryPage(activePageId);
    } else if (HISTORY_FORM_TYPES[activePageId]) {
      void loadRequestHistory(activePageId);
    }
  } catch (error) {
    console.error("Unable to load the signed-in user's profile.", error);
    if (currentSession?.user.id === session.user.id) {
      profileUserId = "";
      saveStatus.textContent = `Could not load your saved account details: ${error.message || "Request failed."}`;
    }
  }
}

function populateSelect(select, values, label) {
  select.replaceChildren(new Option(`Select ${label.toLowerCase()}…`, ""));
  for (const value of values) select.add(new Option(value, value));
  select.disabled = values.length === 0;
  if (!values.length) select.replaceChildren(new Option(`No ${label.toLowerCase()} found`, ""));
}

async function loadRequestLookups(formType) {
  const outgoing = document.querySelector("#outgoing-department");
  const incoming = document.querySelector("#incoming-department");
  const supplier = document.querySelector("#request-supplier");
  incoming.replaceChildren(new Option(currentUserProfile.department || "Department not assigned", currentUserProfile.department || ""));
  incoming.disabled = !currentUserProfile.department;
  setRequestNotice(`Signed in as ${currentUserProfile.username || "your account"}. Loading outgoing departments…`);
  try {
    const result = await loadLookupData();
    if (!requestDialog.open || requestDialog.dataset.formType !== formType) return;
    populateSelect(outgoing, result.outgoing_departments || [], "department");
    if (supplier) populateSelect(supplier, result.suppliers || [], "supplier");
    setRequestNotice(`Signed in as ${currentUserProfile.username || "your account"}.`);
  } catch (error) {
    console.error("Unable to load form lists from Google Sheets.", error);
    if (!requestDialog.open || requestDialog.dataset.formType !== formType) return;
    outgoing.replaceChildren(new Option("Could not load outgoing departments", ""));
    incoming.replaceChildren(new Option(currentUserProfile.department || "Department not assigned", currentUserProfile.department || ""));
    incoming.disabled = !currentUserProfile.department;
    if (supplier) supplier.replaceChildren(new Option("Could not load suppliers", ""));
    setRequestNotice(`Could not load form lists: ${error.message}`);
  }
}

function renderCatalogRows() {
  const search = document.querySelector("#catalog-search").value.trim().toLowerCase();
  const filtered = catalogRows
    .map((product, index) => ({ product, index }))
    .filter(({ product }) => `${product["SKU CODE"]} ${product["PRODUCT DESCRIPTION"]}`.toLowerCase().includes(search));
  catalogProducts.replaceChildren();
  for (const { product, index } of filtered) {
    const row = document.createElement("tr");
    const checkboxCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedCatalogRows.has(index);
    checkbox.dataset.catalogIndex = String(index);
    checkbox.setAttribute("aria-label", `Select ${product["SKU CODE"]} ${product["PRODUCT DESCRIPTION"]}`);
    checkboxCell.append(checkbox);
    row.append(checkboxCell);
    for (const field of CATALOG_FIELDS) {
      const cell = document.createElement("td");
      cell.textContent = String(product[field]);
      row.append(cell);
    }
    catalogProducts.append(row);
  }
  catalogStatus.textContent = `${filtered.length} of ${catalogRows.length} products${selectedCatalogRows.size ? ` · ${selectedCatalogRows.size} selected` : ""}.`;
  document.querySelector("#select-all-products").checked = filtered.length > 0 && filtered.every(({ index }) => selectedCatalogRows.has(index));
  updateCatalogSelection();
}

function updateCatalogSelection() {
  document.querySelector("#add-selected-products").disabled = selectedCatalogRows.size === 0;
}

function updateCatalogSelectionStatus() {
  const search = document.querySelector("#catalog-search").value.trim().toLowerCase();
  const filtered = catalogRows
    .map((product, index) => ({ product, index }))
    .filter(({ product }) => `${product["SKU CODE"]} ${product["PRODUCT DESCRIPTION"]}`.toLowerCase().includes(search));
  document.querySelector("#select-all-products").checked = filtered.length > 0 && filtered.every(({ index }) => selectedCatalogRows.has(index));
  catalogStatus.textContent = `${filtered.length} of ${catalogRows.length} products${selectedCatalogRows.size ? ` · ${selectedCatalogRows.size} selected` : ""}.`;
  updateCatalogSelection();
}

function addSelectedProductsToRequest() {
  const items = requestFormBody.querySelector(".request-items-list");
  if (items.children.length === 1 && [...items.firstElementChild.querySelectorAll("input")].every((input) => !input.value)) {
    items.replaceChildren();
  }
  for (const index of selectedCatalogRows) {
    const product = catalogRows[index];
    if (!product) continue;
    items.append(makeRequestItemRow(items.children.length + 1, {
      "SKU Code": product["SKU CODE"],
      "Product Description": product["PRODUCT DESCRIPTION"],
      UOM: product.UOM,
      "Expiration Date": toDateInputValue(String(product["EXPIRATION DATE"])),
      Onhand: product["QTY ONHAND"],
      "Total Onhand": product["TOTAL QTY ONHAND"],
      Cost: product.COST,
      SRP: product.SRP,
    }));
  }
  catalogDialog.close();
}

function toDateInputValue(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function updateSessionUi(session, navigate = true) {
  const previousUserId = currentSession?.user.id || "";
  const nextUserId = session?.user.id || "";
  if (previousUserId !== nextUserId) {
    inventoryDepartment = "";
    inventoryRows = [];
    inventoryCategories = [];
    selectedInventoryRow = null;
    historyRows.clear();
    historyDepartments.clear();
    currentUserProfile = {
      username: "",
      department: "",
      status: "active",
      role: "user",
      allowedFormTypes: [],
      mustChangePassword: false,
    };
    profileUserId = "";
    adminStatusUserId = "";
    isMasterAdmin = false;
    isAdmin = false;
    lookupCache = null;
    setNotificationCount(0);
    document.body.classList.remove("admin-mode");
    document.body.classList.remove("master-admin-mode");
  }
  currentSession = session;
  if (nextUserId) {
    ensureActivitySession(nextUserId);
  } else if (previousUserId) {
    sessionStorage.removeItem(`mw-activity-session:${previousUserId}`);
    activitySessionId = "";
    activitySessionUserId = "";
    endedActivitySessionId = "";
  }
  if (previousUserId !== nextUserId) resetIdleSignOutTimer();
  const signedIn = Boolean(session);
  document.body.classList.toggle("signed-out", !signedIn);
  const metadata = session?.user?.user_metadata || {};
  if (signedIn && !currentUserProfile.username) {
    currentUserProfile = {
      username: metadata.portal_username || "",
      department: metadata.department || "",
      status: metadata.must_change_password ? "default" : "active",
      role: "user",
      allowedFormTypes: [],
      mustChangePassword: Boolean(metadata.must_change_password),
    };
  }
  if (!signedIn) {
    currentUserProfile = {
      username: "",
      department: "",
      status: "active",
      role: "user",
      allowedFormTypes: [],
      mustChangePassword: false,
    };
  }
  updateNotificationPolling(Boolean(signedIn && !currentUserProfile.mustChangePassword));
  const accountName = signedIn ? currentUserProfile.username || "Signed-in user" : "Guest";
  document.body.classList.add("user-mode");
  document.querySelector("#toggle-user-mode").textContent = signedIn ? "Sign out" : "Sign in";
  document.querySelector("#account-avatar").textContent = signedIn ? accountName.slice(0, 1).toUpperCase() : "G";
  document.querySelector("#account-name").textContent = accountName;
  document.querySelector("#account-role").textContent = signedIn
    ? [isMasterAdmin ? "Master Admin" : isAdmin ? "Admin" : "", currentUserProfile.department].filter(Boolean).join(" · ") || "Signed-in user"
    : "Request portal";
  document.querySelector("#account-badge").textContent = signedIn
    ? isMasterAdmin ? "MASTER ADMIN" : isAdmin ? "ADMIN" : "USER"
    : "GUEST";
  document.querySelector("#session-status").textContent = signedIn ? "Signed in" : supabaseClient ? "Ready to sign in" : "Setup needed";
  if (!signedIn && catalogDialog.open) catalogDialog.close();
  if (!signedIn && requestDialog.open) requestDialog.close();
  if (!signedIn || currentUserProfile.mustChangePassword) {
    isMasterAdmin = false;
    isAdmin = false;
    adminStatusUserId = "";
    document.body.classList.remove("admin-mode");
    document.body.classList.remove("master-admin-mode");
    document.querySelector("#supabase-connection").hidden = true;
    if (requestDialog.open) requestDialog.close();
    if (catalogDialog.open) catalogDialog.close();
    if (signedIn && !passwordChangeDialog.open) passwordChangeDialog.showModal();
    if (!signedIn && passwordChangeDialog.open) passwordChangeDialog.close();
  } else {
    if (passwordChangeDialog.open) passwordChangeDialog.close();
    void refreshAdminTools();
  }
  if (signedIn && !currentUserProfile.mustChangePassword) {
    void refreshNotificationCount();
    const requestedPage = navigate && previousUserId !== nextUserId
      ? "user-forms"
      : location.hash.slice(1) || activePageId || "user-forms";
    const validPages = new Set(["user-forms", "my-requests", "approvals", "pending-release", "pending-received", "notifications", "reports-history", "inventory", "inventory-form", ...Object.keys(HISTORY_FORM_TYPES)]);
    activatePortalPage(validPages.has(requestedPage) ? requestedPage : "user-forms", false);
    void refreshWorkflowCounts();
  }
}

function unsubscribeFromAuthChanges() {
  authSubscription?.data?.subscription?.unsubscribe();
  authSubscription = null;
}

function renderUserForms() {
  userFormGrid.replaceChildren();
  const forms = isAdmin ? FORM_TYPES : FORM_TYPES.filter(form => currentUserProfile.allowedFormTypes.includes(form.id));
  for (const form of forms) userFormGrid.append(makeUserFormButton(form));
  document.querySelector("#assigned-form-count").textContent = `${forms.length} ASSIGNED FORM${forms.length === 1 ? "" : "S"}`;
  document.querySelector("#assigned-forms-empty").hidden = forms.length > 0;
}

function buildSettings() {
  return DEPLOYMENT_SETTINGS;
}

async function configureSupabase(settings) {
  unsubscribeFromAuthChanges();
  if (!settings.supabase.url || !settings.supabase.key) {
    supabaseClient = null;
    document.querySelector("#session-status").textContent = "Setup needed";
    updateSessionUi(null, false);
    document.querySelector("#auth-status").textContent = "The portal administrator must add the Supabase URL and publishable key to app.js before publishing.";
    return;
  }
  if (!window.supabase?.createClient) {
    supabaseClient = null;
    document.querySelector("#session-status").textContent = "Connection error";
    updateSessionUi(null, false);
    document.querySelector("#auth-status").textContent = "Could not load the sign-in service. Check your internet connection and reload.";
    return;
  }
  try {
    supabaseClient = window.supabase.createClient(settings.supabase.url, settings.supabase.key, {
      auth: { storage: window.sessionStorage },
    });
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    document.querySelector("#session-status").textContent = "Ready to sign in";
    updateSessionUi(data.session, false);
    authSubscription = supabaseClient.auth.onAuthStateChange((event, session) => {
      updateSessionUi(session, event === "SIGNED_IN" || event === "SIGNED_OUT");
      if (session && ["INITIAL_SESSION", "SIGNED_IN", "USER_UPDATED"].includes(event)) {
        setTimeout(() => void refreshUserProfile(session), 0);
      }
    });
    saveStatus.textContent = "Sign in with your username to start a request.";
  } catch (error) {
    supabaseClient = null;
    document.querySelector("#session-status").textContent = "Connection error";
    updateSessionUi(null, false);
    document.querySelector("#auth-status").textContent = `Sign-in service connection failed: ${error.message || "Check the Project URL and public key."}`;
  }
}

async function callPortalAdmin(body) {
  if (!supabaseClient || !currentSession) throw new Error("Sign in to continue.");
  const { data, error } = await supabaseClient.functions.invoke("portal-admin", { body });
  if (error) throw new Error(await edgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

async function refreshAdminTools() {
  const panel = document.querySelector("#supabase-connection");
  if (!supabaseClient || !currentSession) return;
  const userId = currentSession.user.id;
  if (adminStatusUserId === userId) return;
  adminStatusUserId = userId;
  panel.hidden = true;
  isMasterAdmin = false;
  isAdmin = false;
  document.body.classList.remove("admin-mode");
  document.body.classList.remove("master-admin-mode");
  try {
    const access = await callPortalAdmin({ action: "status" });
    if (currentSession?.user.id !== userId) return;
    isMasterAdmin = Boolean(access.is_master_admin);
    isAdmin = Boolean(access.is_admin);
    if (!isAdmin) return;
    document.body.classList.add("admin-mode");
    if (!isMasterAdmin) {
      renderUserForms();
      document.querySelector("#account-role").textContent =
        ["Admin", currentUserProfile.department].filter(Boolean).join(" · ");
      document.querySelector("#account-badge").textContent = "ADMIN";
      if (activePageId === "inventory" || activePageId === "inventory-form") {
        void loadInventoryPage(activePageId);
      } else if (HISTORY_FORM_TYPES[activePageId]) {
        void loadRequestHistory(activePageId);
      }
      return;
    }
    document.body.classList.add("master-admin-mode");
    panel.hidden = false;
    const adminRoleOption = document.querySelector(".master-admin-only-option");
    adminRoleOption.hidden = !isMasterAdmin;
    adminRoleOption.disabled = !isMasterAdmin;
    await loadAdminState();
    renderUserForms();
    document.querySelector("#account-role").textContent =
      [isMasterAdmin ? "Master Admin" : "Admin", currentUserProfile.department].filter(Boolean).join(" · ");
    document.querySelector("#account-badge").textContent = isMasterAdmin ? "MASTER ADMIN" : "ADMIN";
    if (activePageId === "inventory" || activePageId === "inventory-form") {
      void loadInventoryPage(activePageId);
    } else if (HISTORY_FORM_TYPES[activePageId]) {
      void loadRequestHistory(activePageId);
    }
  } catch (error) {
    if (currentSession?.user.id === userId) adminStatusUserId = "";
    console.error("Unable to verify administrator access.", error);
    saveStatus.textContent = `Administrator access could not be checked: ${error.message || "Check the portal-admin function deployment."}`;
    document.querySelector("#session-status").textContent = "Admin setup error";
  }
}

async function loadAdminState() {
  const state = await callPortalAdmin({ action: "state" });
  document.querySelector("#shared-workbook-url").value = state.spreadsheet_url || "";
  document.querySelector("#products-tab").value = state.products_tab || "data";
  document.querySelector("#outgoing-departments-tab").value = state.outgoing_departments_tab || "area";
  document.querySelector("#incoming-departments-tab").value = state.incoming_departments_tab || "area";
  document.querySelector("#suppliers-tab").value = state.suppliers_tab || "dd";
  adminUserAccounts = Array.isArray(state.users) ? state.users : [];
  await loadAccountDepartmentOptions();
  renderUserAccounts();
}

async function loadAccountDepartmentOptions() {
  const select = document.querySelector("#new-user-department");
  const editSelect = document.querySelector("#edit-user-department");
  const status = document.querySelector("#add-user-status");
  select.disabled = true;
  select.replaceChildren(new Option("Loading departments from AREA!A1:A…", ""));
  editSelect.disabled = true;
  editSelect.replaceChildren(new Option("Loading departments from AREA!A1:A…", ""));
  try {
    const lookups = await loadLookupData();
    const departments = Array.isArray(lookups.account_departments) ? lookups.account_departments : [];
    populateSelect(select, departments, "department");
    populateSelect(editSelect, departments, "department");
    select.disabled = departments.length === 0;
    editSelect.disabled = departments.length === 0;
    if (departments.length === 0) {
      status.textContent = "No departments were found in the AREA sheet's column A.";
    } else {
      status.textContent = "";
    }
  } catch (error) {
    console.error("Unable to load account departments from the AREA sheet.", error);
    select.replaceChildren(new Option("Could not load departments from AREA!A1:A", ""));
    editSelect.replaceChildren(new Option("Could not load departments from AREA!A1:A", ""));
    status.textContent = `Could not load departments from the AREA sheet: ${error.message || "Request failed."}`;
  }
}

function updateUserFormAccess(
  roleSelectId = "new-user-role",
  formAccessId = "new-user-form-access",
  checkboxName = "allowed-form-types",
) {
  const role = document.querySelector(`#${roleSelectId}`).value;
  const formAccess = document.querySelector(`#${formAccessId}`);
  const isUnrestrictedAdmin = role === "admin";
  formAccess.disabled = isUnrestrictedAdmin;
  if (isUnrestrictedAdmin) {
    for (const checkbox of formAccess.querySelectorAll(`input[name="${checkboxName}"]`)) checkbox.checked = true;
  }
}

function renderUserAccounts() {
  const list = document.querySelector("#user-accounts-list");
  const status = document.querySelector("#user-accounts-status");
  list.replaceChildren();
  if (adminUserAccounts.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No user accounts found.";
    row.append(cell);
    list.append(row);
    status.textContent = "No portal accounts are available to manage.";
    return;
  }

  status.textContent = `${adminUserAccounts.length} account${adminUserAccounts.length === 1 ? "" : "s"}.`;
  for (const account of adminUserAccounts) {
    const row = document.createElement("tr");
    const fields = [
      account.username,
      account.department || "—",
      account.is_master_admin ? "Master Admin" : account.role === "admin" ? "Admin" : "User",
      account.role === "admin"
        ? "All forms"
        : FORM_TYPES.filter(form => (account.allowed_form_types || []).includes(form.id))
          .map(form => form.shortName)
          .join(", ") || "No forms",
      account.status === "default" ? "Password change required" : "Active",
    ];
    for (const value of fields) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const actionsCell = document.createElement("td");
    actionsCell.className = "user-account-actions";
    const editButton = document.createElement("button");
    editButton.className = "button button-secondary";
    editButton.type = "button";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => openAccountEditor(account));
    actionsCell.append(editButton);
    if (!account.is_master_admin) {
      const deleteButton = document.createElement("button");
      deleteButton.className = "button button-danger";
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => void deleteUserAccount(account));
      actionsCell.append(deleteButton);
    }
    row.append(actionsCell);
    list.append(row);
  }
}

function formatActivityTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const day = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date).toLocaleLowerCase();
  return `${day} at ${time}`;
}

function renderActivityLogs() {
  const list = document.querySelector("#activity-log-list");
  list.replaceChildren();
  if (!activityLogs.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "No user activity logs found.";
    row.append(cell);
    list.append(row);
  } else {
    for (const entry of activityLogs) {
      const row = document.createElement("tr");
      const values = [
        entry.username,
        entry.department || "—",
        entry.action,
        entry.details || "—",
        entry.succeeded ? "Success" : "Failed",
        formatActivityTimestamp(entry.occurred_at),
        String(entry.session_id || "").slice(0, 8),
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = String(value ?? "");
        row.append(cell);
      }
      list.append(row);
    }
  }
  document.querySelector("#load-more-activity-logs").hidden = !activityLogsHaveMore;
}

function updateActivityUserOptions(logUsers) {
  const select = document.querySelector("#activity-user-filter");
  const selected = select.value;
  const users = new Map();
  for (const user of [...(logUsers || []), ...adminUserAccounts]) {
    if (user.user_id && user.username) users.set(user.user_id, user.username);
  }
  select.replaceChildren(new Option("All users", ""));
  for (const [userId, username] of [...users.entries()].sort((left, right) => left[1].localeCompare(right[1]))) {
    select.add(new Option(username, userId));
  }
  select.value = users.has(selected) ? selected : "";
}

async function loadActivityLogs(append = false) {
  const loadId = ++activityLogLoadId;
  const status = document.querySelector("#activity-log-status");
  const button = document.querySelector("#refresh-activity-logs");
  const selectedUserId = document.querySelector("#activity-user-filter").value;
  if (!append) {
    activityLogOffset = 0;
    activityLogs = [];
  }
  button.disabled = true;
  status.textContent = append ? "Loading more activity…" : "Loading user activity logs…";
  try {
    const result = await callPortalAdmin({
      action: "activity_logs_read",
      user_id: selectedUserId,
      offset: activityLogOffset,
    });
    if (loadId !== activityLogLoadId || selectedUserId !== document.querySelector("#activity-user-filter").value) return;
    updateActivityUserOptions(result.users || []);
    activityLogs = append ? [...activityLogs, ...(result.logs || [])] : result.logs || [];
    activityLogOffset += (result.logs || []).length;
    activityLogsHaveMore = Boolean(result.has_more);
    renderActivityLogs();
    status.textContent = `${activityLogs.length} activity log${activityLogs.length === 1 ? "" : "s"} loaded${selectedUserId ? ` for ${document.querySelector("#activity-user-filter").selectedOptions[0]?.textContent || "selected user"}` : ""}.`;
  } catch (error) {
    if (loadId !== activityLogLoadId) return;
    console.error("Unable to load user activity logs.", error);
    status.textContent = `Could not load user activity logs: ${error.message || "Request failed."}`;
  } finally {
    if (loadId === activityLogLoadId) button.disabled = false;
  }
}

function openAccountEditor(account) {
  const dialog = document.querySelector("#account-edit-dialog");
  document.querySelector("#account-edit-form").reset();
  document.querySelector("#edit-user-id").value = account.user_id;
  document.querySelector("#account-edit-title").textContent = `Edit ${account.is_master_admin ? "Master Admin" : "user"} account`;
  document.querySelector("#account-edit-username").textContent = account.username;
  const usernameInput = document.querySelector("#edit-user-login");
  usernameInput.value = account.username;
  usernameInput.disabled = Boolean(account.is_master_admin);
  document.querySelector("#edit-user-department").value = account.department || "";
  const role = account.is_master_admin ? "admin" : account.role === "admin" ? "admin" : "user";
  document.querySelector("#edit-user-role").value = role;
  document.querySelector("#edit-user-status").value = account.status === "default" ? "default" : "active";
  for (const checkbox of document.querySelectorAll('input[name="edit-allowed-form-types"]')) {
    checkbox.checked = account.is_master_admin
      || role === "admin"
      || (account.allowed_form_types || []).includes(checkbox.value);
  }
  const roleSelect = document.querySelector("#edit-user-role");
  roleSelect.disabled = Boolean(account.is_master_admin);
  document.querySelector("#edit-user-status").disabled = Boolean(account.is_master_admin);
  updateUserFormAccess("edit-user-role", "edit-user-form-access", "edit-allowed-form-types");
  document.querySelector("#edit-user-status").disabled = Boolean(account.is_master_admin);
  document.querySelector("#edit-user-password").disabled = Boolean(account.is_master_admin);
  document.querySelector("#edit-user-password").value = "";
  document.querySelector("#account-edit-status").textContent = account.is_master_admin
    ? "Master Admin accounts are protected from role changes, password resets, and deletion."
    : "";
  document.querySelector("#save-account-edit").disabled = false;
  dialog.showModal();
}

async function refreshUserAccounts() {
  const button = document.querySelector("#refresh-user-accounts");
  button.disabled = true;
  document.querySelector("#user-accounts-status").textContent = "Refreshing user accounts…";
  try {
    const state = await callPortalAdmin({ action: "state" });
    adminUserAccounts = Array.isArray(state.users) ? state.users : [];
    renderUserAccounts();
  } catch (error) {
    console.error("Unable to refresh user accounts.", error);
    document.querySelector("#user-accounts-status").textContent =
      `Could not load user accounts: ${error.message || "Request failed."}`;
  } finally {
    button.disabled = false;
  }
}

async function saveUserAccount(event) {
  event.preventDefault();
  const button = document.querySelector("#save-account-edit");
  const status = document.querySelector("#account-edit-status");
  button.disabled = true;
  status.textContent = "Saving account changes…";
  try {
    const role = document.querySelector("#edit-user-role").value;
    const allowedFormTypes = [...document.querySelectorAll('input[name="edit-allowed-form-types"]:checked')]
      .map(input => input.value);
    if (role === "user" && !allowedFormTypes.length) throw new Error("Select at least one form for this user.");
    const result = await callPortalAdmin({
      action: "update_user",
      user_id: document.querySelector("#edit-user-id").value,
      username: document.querySelector("#edit-user-login").value.trim().toLowerCase(),
      department: document.querySelector("#edit-user-department").value,
      role,
      allowed_form_types: role === "admin" ? FORM_TYPES.map(form => form.id) : allowedFormTypes,
      status: document.querySelector("#edit-user-status").value,
      password: document.querySelector("#edit-user-password").value,
    });
    await refreshUserAccounts();
    status.textContent = result.warning || "Account updated.";
    if (!result.warning) document.querySelector("#account-edit-dialog").close();
  } catch (error) {
    console.error("Unable to update user account.", error);
    status.textContent = `Could not update account: ${error.message || "Request failed."}`;
  } finally {
    button.disabled = false;
  }
}

async function deleteUserAccount(account) {
  const confirmation = window.confirm(
    `Delete the "${account.username}" account? The user will lose portal access, and their saved notifications will be removed. This cannot be undone.`,
  );
  if (!confirmation) return;
  const status = document.querySelector("#user-accounts-status");
  status.textContent = `Deleting "${account.username}"…`;
  try {
    const result = await callPortalAdmin({ action: "delete_user", user_id: account.user_id });
    adminUserAccounts = adminUserAccounts.filter(item => item.user_id !== account.user_id);
    renderUserAccounts();
    status.textContent = `Account "${result.username}" deleted.`;
  } catch (error) {
    console.error("Unable to delete user account.", error);
    status.textContent = `Could not delete account: ${error.message || "Request failed."}`;
  }
}

async function saveWorkbook() {
  const input = document.querySelector("#shared-workbook-url");
  const button = document.querySelector("#save-workbook");
  button.disabled = true;
  document.querySelector("#admin-status").textContent = "Saving spreadsheet and lookup tab settings…";
  try {
    const result = await callPortalAdmin({
      action: "save_workbook",
      spreadsheet_url: input.value.trim(),
      products_tab: document.querySelector("#products-tab").value.trim(),
      outgoing_departments_tab: document.querySelector("#outgoing-departments-tab").value.trim(),
      incoming_departments_tab: document.querySelector("#incoming-departments-tab").value.trim(),
      suppliers_tab: document.querySelector("#suppliers-tab").value.trim(),
    });
    input.value = result.spreadsheet_url;
    lookupCache = null;
    document.querySelector("#admin-status").textContent = "Spreadsheet and lookup tabs saved. Make sure the workbook is shared with the Google service account as an Editor.";
  } catch (error) {
    console.error("Unable to save the shared spreadsheet.", error);
    document.querySelector("#admin-status").textContent = `Could not save spreadsheet: ${error.message || "Request failed."}`;
  } finally {
    button.disabled = false;
  }
}

async function addUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector("#add-user-button");
  const status = document.querySelector("#add-user-status");
  button.disabled = true;
  status.textContent = "Creating portal account…";
  try {
    const role = document.querySelector("#new-user-role").value;
    const allowedFormTypes = [...document.querySelectorAll('input[name="allowed-form-types"]:checked')].map(input => input.value);
    if (role === "user" && !allowedFormTypes.length) throw new Error("Select at least one form for this user.");
    const result = await callPortalAdmin({
      action: "create_user",
      username: document.querySelector("#new-user-username").value.trim().toLowerCase(),
      department: document.querySelector("#new-user-department").value.trim(),
      role,
      allowed_form_types: role === "admin"
        ? FORM_TYPES.map(form => form.id)
        : allowedFormTypes,
      password: document.querySelector("#new-user-password").value,
      status: document.querySelector("#new-user-status").value,
    });
    form.reset();
    updateUserFormAccess();
    await refreshUserAccounts();
    status.textContent = `User "${result.username}" added. Give the username and temporary password privately.`;
  } catch (error) {
    console.error("Unable to create a portal user.", error);
    status.textContent = `Could not add user: ${error.message || "Request failed."}`;
  } finally {
    button.disabled = false;
  }
}

async function signIn(event) {
  event.preventDefault();
  const button = document.querySelector("#submit-auth");
  const status = document.querySelector("#auth-status");
  if (!supabaseClient) {
    status.textContent = "Supabase is not configured. Ask your admin to save the project URL and public key.";
    return;
  }
  button.disabled = true;
  status.textContent = "Signing in…";
  try {
    const username = document.querySelector("#auth-username").value.trim().toLowerCase();
    const password = document.querySelector("#auth-password").value;
    const { data, error } = await supabaseClient.functions.invoke("username-login", {
      body: { username, password },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    if (!data?.access_token || !data?.refresh_token) throw new Error("Username sign-in returned an incomplete session.");
    currentUserProfile = {
      username: data.username || username,
      department: data.department || "",
      status: data.must_change_password ? "default" : "active",
      role: "user",
      allowedFormTypes: [],
      mustChangePassword: Boolean(data.must_change_password),
    };
    const { error: sessionError } = await supabaseClient.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
    if (sessionError) throw sessionError;
    await recordUserActivity("Signed in", "Successfully signed in to the portal.");
    document.querySelector("#auth-username").value = "";
    const passwordInput = document.querySelector("#auth-password");
    passwordInput.value = "";
    passwordInput.type = "password";
    const passwordToggle = document.querySelector("#toggle-login-password");
    passwordToggle.textContent = "Show";
    passwordToggle.setAttribute("aria-label", "Show password");
    passwordToggle.setAttribute("aria-pressed", "false");
    status.textContent = "";
  } catch (error) {
    console.error("Supabase sign-in failed.", error);
    status.textContent = error.message || "Sign-in failed. Check your username and password.";
  } finally {
    button.disabled = false;
  }
}

async function changeTemporaryPassword(event) {
  event.preventDefault();
  const button = document.querySelector("#save-new-password");
  const status = document.querySelector("#password-change-status");
  const password = document.querySelector("#new-password").value;
  const confirmation = document.querySelector("#confirm-new-password").value;
  if (password.length < 8) {
    status.textContent = "Choose a password with at least 8 characters.";
    return;
  }
  if (password !== confirmation) {
    status.textContent = "The passwords do not match.";
    return;
  }
  button.disabled = true;
  status.textContent = "Updating password…";
  try {
    await callPortalAdmin({ action: "complete_password_change", password });
    const { data, error } = await supabaseClient.auth.getUser();
    if (error) throw error;
    currentSession = { ...currentSession, user: data.user };
    currentUserProfile.mustChangePassword = false;
    currentUserProfile.status = "active";
    document.querySelector("#password-change-form").reset();
    passwordChangeDialog.close();
    status.textContent = "";
    updateSessionUi(currentSession, false);
    saveStatus.textContent = "Password updated. You can now use the portal.";
  } catch (error) {
    console.error("Unable to update the temporary password.", error);
    status.textContent = `Could not finish password update: ${error.message || "Request failed."}`;
  } finally {
    button.disabled = false;
  }
}

function setActiveNavigation() {
  document.querySelector(".nav-list").addEventListener("click", (event) => {
    const link = event.target.closest("[data-page]");
    if (!link) return;
    event.preventDefault();
    activatePortalPage(link.dataset.page);
  });
  document.querySelector(".report-menu-grid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-report-target]");
    if (button) activatePortalPage(button.dataset.reportTarget);
  });
  document.querySelectorAll("[data-back-to-reports]").forEach(button => {
    button.addEventListener("click", () => activatePortalPage("reports-history"));
  });
  activatePortalPage("user-forms");
}

function activatePortalPage(pageId, refresh = true) {
  if (pageId === "approvals" && !isAdmin) pageId = "user-forms";
  const selectedPage = document.querySelector(`[data-page-section]#${CSS.escape(pageId)}`);
  if (!selectedPage || !currentSession) return;
  const pageChanged = activePageId !== pageId;
  document.querySelectorAll("[data-page-section]").forEach((section) => {
    section.hidden = section !== selectedPage;
  });
  document.querySelectorAll(".nav-link[data-page]").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === pageId);
  });
  const pageNames = {
    "user-forms": "My forms",
    "my-requests": "My requests",
    approvals: "Approvals",
    "pending-release": "Pending to release",
    "pending-received": "Pending to received",
    notifications: "Notifications",
    "reports-history": "Reports & History",
    inventory: "Inventory",
    "inventory-form": "Inventory Form",
    "request-history": "Request and Released History",
    "transfer-history": "Transfer History",
    "pullout-history": "Pull Out History",
    "po-history": "P.O History",
  };
  document.querySelector("#breadcrumb-page").textContent = pageNames[pageId];
  if (location.hash !== `#${pageId}`) history.replaceState(null, "", `#${pageId}`);
  activePageId = pageId;
  if (pageChanged) void recordUserActivity("Viewed page", pageNames[pageId]);
  if (!pageChanged && !refresh) return;
  const loaders = {
    "my-requests": loadMyRequests,
    approvals: loadApprovalQueue,
    "pending-release": loadPendingRelease,
    "pending-received": loadPendingReceived,
    notifications: loadNotifications,
    inventory: () => loadInventoryPage("inventory"),
    "inventory-form": () => loadInventoryPage("inventory-form"),
    ...Object.fromEntries(Object.keys(HISTORY_FORM_TYPES).map(pageId => [pageId, () => loadRequestHistory(pageId)])),
  };
  void refreshNotificationCount();
  if (loaders[pageId]) void loaders[pageId]();
}

function setNotificationCount(count) {
  const badge = document.querySelector("#notification-nav-count");
  const unreadCount = Math.max(0, Number(count) || 0);
  currentUnreadNotificationCount = unreadCount;
  badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  badge.hidden = unreadCount === 0;
  badge.setAttribute("aria-label", unreadCount === 1 ? "1 unread notification" : `${unreadCount} unread notifications`);
  document.querySelector("#mark-all-notifications-read").disabled = unreadCount === 0;
}

function updateNotificationPolling(enabled) {
  if (enabled && !notificationRefreshTimer) {
    notificationRefreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshNotificationCount();
        void refreshWorkflowCounts();
      }
    }, 60_000);
  } else if (!enabled && notificationRefreshTimer) {
    window.clearInterval(notificationRefreshTimer);
    notificationRefreshTimer = null;
  }
}

function setWorkflowCount(selector, count) {
  const badge = document.querySelector(selector);
  const value = Math.max(0, Number(count) || 0);
  badge.textContent = value > 99 ? "99+" : String(value);
  badge.hidden = value === 0;
  badge.setAttribute("aria-label", `${value} pending request${value === 1 ? "" : "s"}`);
}

async function refreshWorkflowCounts() {
  if (!currentSession || currentUserProfile.mustChangePassword) {
    setWorkflowCount("#approval-nav-count", 0);
    setWorkflowCount("#release-nav-count", 0);
    setWorkflowCount("#receive-nav-count", 0);
    return;
  }
  try {
    const result = await requestSheetData("workflow_counts");
    setWorkflowCount("#approval-nav-count", result.approval_count);
    setWorkflowCount("#release-nav-count", result.release_count);
    setWorkflowCount("#receive-nav-count", result.receive_count);
  } catch (error) {
    console.error("Unable to refresh workflow queue counts.", error);
  }
}

async function refreshNotificationCount() {
  const userId = currentSession?.user.id;
  if (!userId) {
    setNotificationCount(0);
    return;
  }
  const loadId = ++notificationCountLoadId;
  try {
    const result = await callPortalAdmin({ action: "notifications_count" });
    if (currentSession?.user.id !== userId || loadId !== notificationCountLoadId) return;
    const previousCount = currentUnreadNotificationCount;
    setNotificationCount(result.unread_count);
    if (activePageId === "notifications" && result.unread_count > previousCount) void loadNotifications();
  } catch (error) {
    if (currentSession?.user.id !== userId || loadId !== notificationCountLoadId) return;
    console.error("Unable to refresh the unread notification count.", error);
  }
}

async function loadNotifications(append = false) {
  const status = document.querySelector("#notification-list-status");
  const list = document.querySelector("#notification-list");
  const loadMoreButton = document.querySelector("#load-more-notifications");
  const userId = currentSession?.user.id;
  if (!userId) return;
  if (!append) notificationOffset = 0;
  status.textContent = append ? "Loading older updates…" : list.childElementCount ? "Refreshing your inbox…" : "Loading your inbox…";
  loadMoreButton.disabled = true;
  try {
    const result = await callPortalAdmin({ action: "notifications_list", offset: notificationOffset });
    if (currentSession?.user.id !== userId || activePageId !== "notifications") return;
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    renderNotifications(list, notifications, append);
    notificationOffset += notifications.length;
    loadMoreButton.hidden = !result.has_more;
    loadMoreButton.disabled = false;
    setNotificationCount(result.unread_count);
    status.textContent = notificationOffset
      ? `Showing ${notificationOffset} form update${notificationOffset === 1 ? "" : "s"}.`
      : "Your inbox is clear. New form updates will appear here.";
  } catch (error) {
    if (currentSession?.user.id !== userId) return;
    console.error("Unable to load form notifications.", error);
    status.textContent = `Could not load notifications: ${error.message || "Request failed."}`;
    loadMoreButton.disabled = false;
  }
}

function renderNotifications(container, notifications, append = false) {
  if (!append) container.replaceChildren();
  for (const notification of notifications) {
    const card = document.createElement("article");
    card.className = "notification-card";
    if (!notification.is_read) card.classList.add("notification-unread");

    const main = document.createElement("div");
    main.className = "notification-card-main";
    const top = document.createElement("div");
    top.className = "notification-card-top";
    const title = document.createElement("h2");
    title.textContent = notification.title;
    const state = document.createElement("span");
    state.className = "notification-state";
    state.textContent = notification.is_read ? "Read" : "New";
    top.append(title, state);

    const message = document.createElement("p");
    message.textContent = notification.message;
    const metadata = document.createElement("p");
    metadata.className = "notification-card-meta";
    const eventNames = { submitted: "Submitted", approved: "Approved", released: "Released", received: "Received" };
    const formNames = {
      "release-request": "Release & Request",
      transfer: "Transfer",
      "pull-out": "Pull Out",
      "purchase-order": "Purchase Order",
    };
    const createdAt = new Date(notification.created_at);
    const dateText = Number.isNaN(createdAt.getTime())
      ? ""
      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(createdAt);
    metadata.textContent = [formNames[notification.form_type], eventNames[notification.event], dateText]
      .filter(Boolean)
      .join(" · ");
    main.append(top, message, metadata);

    const actions = document.createElement("div");
    actions.className = "notification-card-actions";
    const openButton = document.createElement("button");
    openButton.className = "button button-primary";
    openButton.type = "button";
    openButton.textContent = "Open related page";
    openButton.addEventListener("click", () => void openNotification(notification));
    actions.append(openButton);
    if (!notification.is_read) {
      const readButton = document.createElement("button");
      readButton.className = "button button-secondary";
      readButton.type = "button";
      readButton.textContent = "Mark as read";
      readButton.addEventListener("click", () => void markNotificationRead(notification.id));
      actions.append(readButton);
    }
    card.append(main, actions);
    container.append(card);
  }
}

async function markNotificationRead(notificationId) {
  try {
    await callPortalAdmin({ action: "notification_mark_read", notification_id: notificationId });
    await loadNotifications();
  } catch (error) {
    console.error("Unable to mark the notification as read.", error);
    window.alert(`Could not update this notification: ${error.message || "Request failed."}`);
  }
}

async function markAllNotificationsRead() {
  const button = document.querySelector("#mark-all-notifications-read");
  button.disabled = true;
  try {
    await callPortalAdmin({ action: "notifications_mark_all_read" });
    await loadNotifications();
  } catch (error) {
    console.error("Unable to mark all notifications as read.", error);
    window.alert(`Could not update your notifications: ${error.message || "Request failed."}`);
    button.disabled = false;
  }
}

async function openNotification(notification) {
  try {
    if (!notification.is_read) {
      await callPortalAdmin({ action: "notification_mark_read", notification_id: notification.id });
      notification.is_read = true;
      await refreshNotificationCount();
    }
    const validPages = new Set(["approvals", "pending-release", "pending-received", "my-requests"]);
    if (!validPages.has(notification.destination_page)) throw new Error("This notification has an invalid destination.");
    notificationRequestToReveal = {
      requestNumber: notification.request_number,
      destinationPage: notification.destination_page,
    };
    activatePortalPage(notification.destination_page);
  } catch (error) {
    console.error("Unable to open the related form page.", error);
    window.alert(`Could not open this notification: ${error.message || "Request failed."}`);
  }
}

async function loadApprovalQueue() {
  await loadWorkflowQueue("approval_queue", "approval-list", "approval-list-status", "Pending requests");
}

async function loadMyRequests() {
  await loadWorkflowQueue("my_requests", "my-requests-list", "my-requests-status", "Your requests");
}

async function loadPendingRelease() {
  await loadWorkflowQueue("pending_release", "pending-release-list", "pending-release-status", "Requests ready to release");
}

async function loadPendingReceived() {
  await loadWorkflowQueue("pending_received", "pending-received-list", "pending-received-status", "Requests ready to receive");
}

async function loadWorkflowQueue(action, listId, statusId, emptyMessage) {
  const list = document.querySelector(`#${listId}`);
  const status = document.querySelector(`#${statusId}`);
  const loadId = (workflowLoadIds.get(action) || 0) + 1;
  workflowLoadIds.set(action, loadId);
  status.textContent = list.childElementCount ? "Refreshing requests…" : "Loading requests…";
  try {
    const result = await requestSheetData(action);
    if (workflowLoadIds.get(action) !== loadId) return;
    const requests = Array.isArray(result.requests) ? result.requests : [];
    if (action === "approval_queue") setWorkflowCount("#approval-nav-count", requests.length);
    if (action === "pending_release") setWorkflowCount("#release-nav-count", requests.length);
    if (action === "pending_received") setWorkflowCount("#receive-nav-count", requests.length);
    status.textContent = requests.length
      ? `${requests.length} request${requests.length === 1 ? "" : "s"}.`
      : `${emptyMessage}: none found.`;
    renderWorkflowRequests(list, requests, action);
    const notificationTarget = notificationRequestToReveal;
    const destinationActions = {
      approvals: "approval_queue",
      "pending-release": "pending_release",
      "pending-received": "pending_received",
      "my-requests": "my_requests",
      "reports-history": "reports_history",
    };
    if (notificationTarget && destinationActions[notificationTarget.destinationPage] === action) {
      const targetCard = [...list.querySelectorAll("[data-request-number]")]
        .find(card => card.dataset.requestNumber === notificationTarget.requestNumber);
      if (targetCard) {
        const category = targetCard.closest(".approval-category");
        if (category) category.open = true;
        targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      notificationRequestToReveal = null;
    }
  } catch (error) {
    if (workflowLoadIds.get(action) !== loadId) return;
    console.error(`Unable to load ${emptyMessage.toLocaleLowerCase()}.`, error);
    status.textContent = `Could not load requests: ${error.message || "Request failed."}`;
  }
}

function renderWorkflowRequests(container, requests, action) {
  const openCategories = new Set(
    [...container.querySelectorAll(".approval-category[open] .approval-category-title")]
      .map(heading => heading.textContent.replace(/\s+\(\d+\)$/, "")),
  );
  container.replaceChildren();
  for (const form of FORM_TYPES) {
    const categoryRequests = requests.filter(request => request.form_type_id === form.id);
    if (!categoryRequests.length) continue;
    const category = document.createElement("details");
    category.className = "approval-category";
    const categoryHeading = document.createElement("summary");
    categoryHeading.className = "approval-category-title";
    categoryHeading.textContent = `${form.name} (${categoryRequests.length})`;
    category.open = openCategories.has(form.name);
    category.append(categoryHeading);
    const categoryList = document.createElement("div");
    categoryList.className = "approval-category-list";
    for (const request of categoryRequests) categoryList.append(makeWorkflowRequestCard(request, action));
    category.append(categoryList);
    container.append(category);
  }
}

function makeReleaseFormSheet(request) {
  const form = FORM_TYPES.find(candidate => candidate.id === request.form_type_id);
  const sheet = document.createElement("section");
  sheet.className = "release-form-sheet";

  const header = document.createElement("header");
  header.className = "release-form-header";
  const logo = document.createElement("img");
  logo.src = new URL("assets/mothers-wonderland-logo.png", document.baseURI).href;
  logo.alt = "Mother's Wonderland";
  const title = document.createElement("h2");
  title.textContent = form?.name || request.form_type || "Request Form";
  const number = document.createElement("strong");
  number.textContent = request.request_number || "";
  header.append(logo, title, number);
  sheet.append(header);

  const details = document.createElement("dl");
  details.className = "release-form-details";
  for (const [label, value] of [
    ["Request date", request.request_date],
    ["Outgoing department (requested from)", request.outgoing_department],
    ["Incoming department (requesting)", request.incoming_department],
    ["Supplier", request.supplier],
    ["Submitted by", request.submitted_by],
    ["Approved date", request.approved_date],
    ["Released date", request.released_date],
    ["Received date", request.received_date],
  ]) {
    if (!value && label === "Supplier") continue;
    const pair = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = ["Request date", "Approved date", "Released date", "Received date"].includes(label)
      ? formatDisplayDate(value) || "—"
      : value || "—";
    pair.append(term, description);
    details.append(pair);
  }
  sheet.append(details);

  const status = document.createElement("p");
  status.className = "release-form-status";
  status.textContent = `STATUS: ${String(request.status || "APPROVED").toLocaleUpperCase()}`;
  sheet.append(status);

  const table = document.createElement("table");
  table.className = "release-form-items";
  const columns = [
    ["SKU CODE", "sku_code"],
    ["PRODUCT DESCRIPTION", "product_description"],
    ["UOM", "uom"],
    ["COST", "cost"],
    ["SRP", "srp"],
    ["EXP. DATE", "expiration_date"],
    ["ONHAND", "qty_onhand"],
    ["TOTAL ONHAND", "total_qty_onhand"],
    ["TRANSFER QTY", "transfer_qty"],
    ["APPROVED QTY", "approved_qty"],
    ["REMARKS", "remarks"],
  ];
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const [label] of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const item of request.items || []) {
    const row = document.createElement("tr");
    for (const [, field] of columns) {
      const cell = document.createElement("td");
      cell.textContent = field === "expiration_date"
        ? formatDisplayDate(item[field]) || "—"
        : item[field] || "—";
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  sheet.append(table);

  const signatures = document.createElement("div");
  signatures.className = "release-form-signatures";
  const released = makeUnsignedReleaseSignature("RELEASED BY: / DESIGNATION");
  const approved = document.createElement("div");
  approved.className = "release-form-approved-signature";
  const approvalName = document.createElement("div");
  approvalName.className = "release-approval-name";
  const signature = document.createElement("img");
  signature.src = new URL("SIG.png", document.baseURI).href;
  signature.alt = "Approver's signature";
  const approver = document.createElement("strong");
  approver.textContent = request.approved_by || "APPROVED BY";
  const signatureLine = document.createElement("span");
  signatureLine.className = "release-signature-line";
  const approvalLabel = document.createElement("b");
  approvalLabel.textContent = "APPROVED BY";
  const approvalCaption = document.createElement("small");
  approvalCaption.textContent = "SIGNATURE OVER PRINTED NAME";
  approvalName.append(signature, approver);
  approved.append(approvalName, signatureLine, approvalLabel, approvalCaption);
  const received = makeUnsignedReleaseSignature("RECEIVED BY: / DESIGNATION");
  signatures.append(released, approved, received);
  sheet.append(signatures);
  return sheet;
}

function makeUnsignedReleaseSignature(label) {
  const signature = document.createElement("div");
  signature.className = "release-form-unsigned-signature";
  const imageSpace = document.createElement("span");
  imageSpace.className = "release-signature-space";
  imageSpace.setAttribute("aria-hidden", "true");
  const line = document.createElement("span");
  line.className = "release-signature-line";
  const title = document.createElement("strong");
  title.textContent = label;
  const caption = document.createElement("small");
  caption.textContent = "SIGNATURE OVER PRINTED NAME";
  signature.append(imageSpace, line, title, caption);
  return signature;
}

function printReleaseForm(sheet, requestNumber) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    window.alert("Allow pop-ups for this portal to print the request form.");
    return;
  }
  printWindow.document.title = `Request ${requestNumber}`;
  const style = printWindow.document.createElement("style");
  style.textContent = `
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; font-family: Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; color: #171719; }
    .release-form-sheet { width: 100%; padding: 0; }
    .release-form-header { display: grid; justify-items: center; gap: 5px; margin-bottom: 18px; text-align: center; }
    .release-form-header img { width: 150px; max-height: 42px; object-fit: contain; }
    .release-form-header h2 { margin: 0; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; }
    .release-form-header > strong { font-size: 11px; }
    .release-form-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin: 0 0 12px; }
    .release-form-details > div { min-width: 0; }
    .release-form-details dt { margin-bottom: 4px; font-size: 8px; font-weight: 700; text-transform: uppercase; }
    .release-form-details dd { margin: 0; overflow-wrap: anywhere; font-size: 10px; }
    .release-form-status { margin: 0 0 8px; font-size: 9px; font-weight: 700; }
    .release-form-items { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .release-form-items thead { display: table-header-group; }
    .release-form-items tr { break-inside: avoid; }
    .release-form-items th { padding: 6px 3px; border: 1px solid #171719; background: #171719 !important; background-color: #171719 !important; box-shadow: inset 0 0 0 1000px #171719; color: #fff !important; font-size: 6px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .release-form-items td { padding: 5px 3px; border-bottom: 1px solid #d9ddd9; font-size: 7px; overflow-wrap: anywhere; }
    .release-form-items td:nth-child(n+3):nth-child(-n+11) { text-align: center; }
    .release-form-items th:nth-child(1) { width: 12%; }
    .release-form-items th:nth-child(2) { width: 22%; }
    .release-form-items th:nth-child(3) { width: 4%; }
    .release-form-items th:nth-child(4), .release-form-items th:nth-child(5) { width: 5%; }
    .release-form-items th:nth-child(6) { width: 7%; }
    .release-form-items th:nth-child(7), .release-form-items th:nth-child(8) { width: 6%; }
    .release-form-items th:nth-child(9), .release-form-items th:nth-child(10) { width: 7%; }
    .release-form-items th:nth-child(11) { width: 19%; }
    .release-form-signatures { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; gap: 16px; margin-top: 28px; break-inside: avoid; }
    .release-form-signatures > div { display: grid; min-height: 100px; grid-template-rows: 64px 1px 11px 11px; gap: 4px; text-align: center; }
    .release-approval-name { display: grid; grid-template-rows: 52px auto; align-content: end; justify-items: center; min-width: 0; }
    .release-form-signatures strong, .release-form-signatures b { align-self: end; font-size: 8px; }
    .release-form-signatures .release-signature-line { height: 1px; border-top: 1px solid #171719; background: transparent; }
    .release-form-unsigned-signature .release-signature-space { background: transparent; }
    .release-form-signatures small { font-size: 7px; font-weight: 600; }
    .release-form-approved-signature img { width: 32px; height: 52px; max-width: 100%; object-fit: contain; mix-blend-mode: multiply; }
    .release-form-approved-signature strong { max-width: 100%; overflow-wrap: anywhere; font-size: 8px; }
    @media screen { body { padding: 20px; } }
  `;
  printWindow.document.head.append(style);
  printWindow.document.body.append(printWindow.document.importNode(sheet, true));
  const images = [...printWindow.document.images];
  Promise.all(images.map(image => image.decode())).then(() => {
    printWindow.focus();
    printWindow.print();
  }).catch(error => {
    console.error("Could not load images for the printable request.", error);
    printWindow.close();
    window.alert("The form or approver signature image could not be loaded. Check that SIG.png is published with the portal.");
  });
}

function makeWorkflowRequestCard(request, action) {
  const card = document.createElement("article");
  card.className = "approval-card";
  card.dataset.requestNumber = request.request_number;
  if (action === "pending_release") {
    card.classList.add("release-form-card");
    const sheet = makeReleaseFormSheet(request);
    card.append(sheet);
    const actions = document.createElement("div");
    actions.className = "approval-card-actions release-form-actions";
    const printButton = document.createElement("button");
    printButton.className = "button button-secondary";
    printButton.type = "button";
    printButton.textContent = "Print form";
    printButton.addEventListener("click", () => printReleaseForm(sheet, request.request_number));
    actions.append(printButton, makeWorkflowActionButton(request, action, card));
    card.append(actions);
    return card;
  }
  const heading = document.createElement("div");
  heading.className = "approval-card-heading";
  const title = document.createElement("h3");
  title.textContent = request.request_number;
  const badge = document.createElement("span");
  badge.className = "approval-pending-badge";
  badge.textContent = String(request.status || "PENDING").toLocaleUpperCase();
  heading.append(title, badge);

  const details = document.createElement("dl");
  details.className = "approval-request-details";
  for (const [label, value] of [
    ["Date", request.request_date],
    ["Outgoing", request.outgoing_department],
    ["Incoming", request.incoming_department],
    ["Supplier", request.supplier || "—"],
    ["Submitted by", request.submitted_by],
    ...(action === "reports_history" ? [
      ["Approved by", request.approved_by || "—"],
      ["Approved date", request.approved_date || "—"],
      ["Released by", request.released_by || "—"],
      ["Released date", request.released_date || "—"],
      ["Received by", request.received_by || "—"],
      ["Received date", request.received_date || "—"],
    ] : []),
  ]) {
    const pair = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = /date$/i.test(label)
      ? formatDisplayDate(value) || "—"
      : value || "—";
    pair.append(term, description);
    details.append(pair);
  }

  const tableScroll = document.createElement("div");
  tableScroll.className = "approval-items-scroll";
  const table = document.createElement("table");
  table.className = "approval-items-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["SKU", "Product", "Transfer Qty", "Approved Qty", "Remarks"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const [index, item] of (request.items || []).entries()) {
    const row = document.createElement("tr");
    for (const value of [item.sku_code, item.product_description, item.transfer_qty]) {
      const cell = document.createElement("td");
      cell.textContent = value || "—";
      row.append(cell);
    }
    const approvedCell = document.createElement("td");
    if (action === "approval_queue") {
      const input = document.createElement("input");
      input.className = "approved-quantity-input";
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.value = item.transfer_qty || "";
      input.required = true;
      input.dataset.approvedQuantity = String(index);
      input.setAttribute("aria-label", `Approved quantity for ${item.sku_code}`);
      approvedCell.append(input);
    } else {
      approvedCell.textContent = item.approved_qty || "—";
    }
    row.append(approvedCell);
    const remarks = document.createElement("td");
    remarks.textContent = item.remarks || "—";
    row.append(remarks);
    body.append(row);
  }
  table.append(head, body);
  tableScroll.append(table);
  card.append(heading, details);
  if (request.approved_by && action === "pending_release") {
    const signature = document.createElement("div");
    signature.className = "approval-signature";
    const name = document.createElement("strong");
    name.textContent = request.approved_by;
    const label = document.createElement("span");
    label.textContent = "APPROVED BY · APPROVAL SIGNATURE";
    signature.append(name, label);
    card.append(signature);
  }
  card.append(tableScroll);

  if (action === "approval_queue" || action === "pending_received") {
    const actions = document.createElement("div");
    actions.className = "approval-card-actions";
    actions.append(makeWorkflowActionButton(request, action, card));
    card.append(actions);
  }
  return card;
}

function makeWorkflowActionButton(request, action, card) {
  const button = document.createElement("button");
  button.className = "button button-primary";
  button.type = "button";
  button.textContent = action === "approval_queue" ? "Approve form" : action === "pending_release" ? "Mark released" : "Mark received";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const payload = {
      action: action === "approval_queue" ? "approve" : action === "pending_release" ? "release" : "receive",
      request_number: request.request_number,
    };
    if (action === "approval_queue") {
      const inputs = [...card.querySelectorAll("[data-approved-quantity]")];
      if (inputs.some(input => !input.reportValidity())) {
        button.disabled = false;
        return;
      }
      payload.approved_quantities = inputs.map(input => input.value);
    }
    try {
      const result = await requestSheetData("workflow_action", payload);
      card.remove();
      const refresh = action === "approval_queue" ? loadApprovalQueue
        : action === "pending_release" ? loadPendingRelease : loadPendingReceived;
      await refresh();
      void refreshWorkflowCounts();
      if (result.notification_warning) window.alert(result.notification_warning);
    } catch (error) {
      console.error("Unable to update request workflow status.", error);
      window.alert(`Could not update ${request.request_number}: ${error.message || "Request failed."}`);
      button.disabled = false;
    }
  });
  return button;
}

async function submitRequest(event) {
  event.preventDefault();
  const submitButton = document.querySelector(".submit-request-button");
  if (!currentSession || !supabaseClient) {
    setRequestNotice("You must be signed in to submit a request.");
    return;
  }
  const items = [...requestFormBody.querySelectorAll(".request-item-row")].map((row) => {
    const values = Object.fromEntries([...row.querySelectorAll("input")].map((input) => [
      input.getAttribute("aria-label").replace(/^Item \d+ /, ""),
      input.value.trim(),
    ]));
    return {
      sku_code: values["SKU Code"],
      product_description: values["Product Description"],
      uom: values.UOM || null,
      expiration_date: values["Expiration Date"] || null,
      qty_onhand: values.Onhand || null,
      total_qty_onhand: values["Total Onhand"] || null,
      cost: values.Cost || null,
      srp: values.SRP || null,
      transfer_qty: values["Transfer Qty"] || null,
      remarks: values.Remarks || null,
    };
  });
  if (items.some((item) => !item.sku_code || !item.product_description)) {
    setRequestNotice("Select a catalog product for each item before submitting.");
    return;
  }
  const formType = String(requestDialog.dataset.formType || "").trim();
  const outgoingDepartment = document.querySelector("#outgoing-department");
  const incomingDepartment = document.querySelector("#incoming-department");
  if (outgoingDepartment.disabled || !outgoingDepartment.value) {
    setRequestNotice("Select an outgoing department before submitting. If the list could not load, check the Products tab's column G values and reload the form.");
    outgoingDepartment.focus();
    return;
  }
  if (incomingDepartment.disabled || !incomingDepartment.value) {
    setRequestNotice("Your Incoming Department is not assigned. Ask the Master Admin to set your department, then sign out and back in.");
    incomingDepartment.focus();
    return;
  }
  const supplier = document.querySelector("#request-supplier")?.value.trim() || "";
  if (formType === "purchase-order" && !supplier) {
    setRequestNotice("Select a supplier from the dd tab before submitting this purchase order.");
    return;
  }
  submitButton.disabled = true;
  setRequestNotice("Submitting request directly to Google Sheets…");
  try {
    const result = await requestSheetData("submit", {
      form_type: formType,
      request_date: getLocalDate(),
      outgoing_department: outgoingDepartment.value.trim(),
      incoming_department: incomingDepartment.value.trim(),
      supplier: supplier || null,
      items,
    });
    if (!result?.request_number) throw new Error("Google Sheets did not return the saved request number.");
    requestFormBody.querySelector(".request-number").textContent = result.request_number;
    setRequestNotice(result.notification_warning
      ? `Request ${result.request_number} was saved to Google Sheets. ${result.notification_warning}`
      : `Request ${result.request_number} was saved to Google Sheets.`);
  } catch (error) {
    console.error("Unable to submit request.", error);
    setRequestNotice(`Request was not saved to Google Sheets: ${error.message || "Request failed."}`);
  } finally {
    submitButton.disabled = false;
  }
}

renderUserForms();
setActiveNavigation();
void registerPortalServiceWorker();
configureSupabase(buildSettings());
document.querySelector("#save-workbook").addEventListener("click", saveWorkbook);
document.querySelector("#toggle-user-mode").addEventListener("click", async () => {
  if (!currentSession) {
    if (!supabaseClient) {
      saveStatus.textContent = "The portal is not connected yet. Contact your administrator.";
      return;
    }
    document.querySelector("#auth-username").focus();
    return;
  }
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  } catch (error) {
    console.error("Supabase sign-out failed.", error);
    saveStatus.textContent = `Sign-out failed: ${error.message || "Supabase returned an unexpected error."}`;
  }
});
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  pendingInstallPrompt = event;
  setInstallButtonsVisible(true);
});
window.addEventListener("appinstalled", () => {
  pendingInstallPrompt = null;
  setInstallButtonsVisible(false);
  showInstallMessage("MW FORM is installed on this device.");
});
installAppButtons.forEach(button => button.addEventListener("click", installPortalApp));
async function registerPortalServiceWorker() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register(new URL("sw.js", document.baseURI));
    await navigator.serviceWorker.ready;
    if (!window.matchMedia("(display-mode: standalone)").matches && !navigator.standalone) {
      setInstallButtonsVisible(true);
    }
  } catch (error) {
    console.error("Unable to register the request portal app shell.", error);
    setInstallButtonsVisible(false);
    showInstallMessage(`The app could not be prepared for installation: ${error.message || "Service worker registration failed."}`);
  }
}
userFormGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-form]");
  if (!button) return;
  const form = FORM_TYPES.find((candidate) => candidate.id === button.dataset.openForm);
  if (form) openRequestForm(form);
});
requestFormBody.addEventListener("click", (event) => {
  if (event.target.closest("[data-add-item]")) {
    if (!requestFormBody.querySelector("#outgoing-department").value) return;
    openProductCatalog();
  }
  if (event.target.closest("[data-remove-item]")) {
    const items = requestFormBody.querySelector(".request-items-list");
    if (items.children.length > 1) {
      event.target.closest(".request-item-row").remove();
      for (const [index, row] of [...items.children].entries()) {
        row.querySelectorAll("input").forEach((input) => {
          const field = ITEM_FIELDS.find((itemField) => input.getAttribute("aria-label").endsWith(itemField));
          input.setAttribute("aria-label", `Item ${index + 1} ${field}`);
        });
        row.querySelector("[data-remove-item]").setAttribute("aria-label", `Remove item ${index + 1}`);
      }
    }
  }
});
document.querySelector("#catalog-search").addEventListener("input", renderCatalogRows);
catalogProducts.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-catalog-index]");
  if (!checkbox) return;
  const index = Number(checkbox.dataset.catalogIndex);
  if (checkbox.checked) selectedCatalogRows.add(index);
  else selectedCatalogRows.delete(index);
  updateCatalogSelectionStatus();
});
document.querySelector("#select-all-products").addEventListener("change", (event) => {
  const search = document.querySelector("#catalog-search").value.trim().toLowerCase();
  catalogRows.forEach((product, index) => {
    if (`${product["SKU CODE"]} ${product["PRODUCT DESCRIPTION"]}`.toLowerCase().includes(search)) {
      if (event.target.checked) selectedCatalogRows.add(index);
      else selectedCatalogRows.delete(index);
    }
  });
  renderCatalogRows();
});
document.querySelector("#add-selected-products").addEventListener("click", addSelectedProductsToRequest);
document.querySelector("#close-catalog-dialog").addEventListener("click", () => catalogDialog.close());
document.querySelector("#cancel-catalog").addEventListener("click", () => catalogDialog.close());
document.querySelector("#close-request-dialog").addEventListener("click", () => requestDialog.close());
document.querySelector("#request-form").addEventListener("submit", submitRequest);
document.querySelector("#auth-form").addEventListener("submit", signIn);
document.querySelector("#toggle-login-password").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const password = document.querySelector("#auth-password");
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  button.textContent = visible ? "Hide" : "Show";
  button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  button.setAttribute("aria-pressed", String(visible));
});
document.querySelector("#refresh-approvals").addEventListener("click", loadApprovalQueue);
document.querySelector("#refresh-my-requests").addEventListener("click", loadMyRequests);
document.querySelector("#refresh-pending-release").addEventListener("click", loadPendingRelease);
document.querySelector("#refresh-pending-received").addEventListener("click", loadPendingReceived);
document.querySelector("#refresh-notifications").addEventListener("click", loadNotifications);
document.querySelector("#load-more-notifications").addEventListener("click", () => void loadNotifications(true));
document.querySelector("#mark-all-notifications-read").addEventListener("click", markAllNotificationsRead);
document.querySelector("#refresh-inventory").addEventListener("click", () => void loadInventoryPage("inventory", true));
document.querySelector("#refresh-inventory-form").addEventListener("click", () => void loadInventoryPage("inventory-form", true));
document.querySelector("#inventory-department").addEventListener("change", event => {
  inventoryDepartment = event.target.value;
  setInventoryDepartmentOptions([...event.target.options].slice(1).map(option => option.value));
  void loadInventoryPage("inventory", true);
});
document.querySelector("#inventory-form-department").addEventListener("change", event => {
  inventoryDepartment = event.target.value;
  setInventoryDepartmentOptions([...event.target.options].slice(1).map(option => option.value));
  void loadInventoryPage("inventory-form", true);
});
document.querySelectorAll(".history-page").forEach(section => {
  const pageId = section.id;
  section.querySelector("[data-history-refresh]").addEventListener("click", () => void loadRequestHistory(pageId, true));
  section.querySelector("[data-history-department]").addEventListener("change", event => {
    historyDepartments.set(pageId, event.target.value);
    void loadRequestHistory(pageId, true);
  });
  section.querySelector("[data-history-search]").addEventListener("input", () => renderRequestHistory(pageId));
});
document.querySelector("#inventory-search").addEventListener("input", renderInventoryRows);
document.querySelector("#inventory-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-inventory-row]");
  if (button) showInventoryItem(Number(button.dataset.inventoryRow));
});
document.querySelector("#inventory-adjustment-form").addEventListener("submit", saveInventoryAdjustment);
document.querySelector("#close-inventory-item").addEventListener("click", () => document.querySelector("#inventory-item-dialog").close());
document.querySelector("#print-inventory-form").addEventListener("click", () => {
  const department = inventoryDepartment || currentUserProfile.department;
  document.querySelector("#inventory-print-department").textContent = department ? `Department: ${department}` : "Department: Not selected";
  document.body.classList.add("print-inventory");
  window.print();
});
window.addEventListener("afterprint", () => document.body.classList.remove("print-inventory"));
requestFormBody.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "text") {
    const start = event.target.selectionStart;
    const end = event.target.selectionEnd;
    event.target.value = event.target.value.toLocaleUpperCase();
    if (start !== null && end !== null) event.target.setSelectionRange(start, end);
  }
});
document.querySelector("#add-user-form").addEventListener("submit", addUser);
document.querySelector("#new-user-role").addEventListener("change", updateUserFormAccess);
document.querySelector("#refresh-user-accounts").addEventListener("click", refreshUserAccounts);
document.querySelector("#account-edit-form").addEventListener("submit", saveUserAccount);
document.querySelector("#edit-user-role").addEventListener("change", () =>
  updateUserFormAccess("edit-user-role", "edit-user-form-access", "edit-allowed-form-types"));
document.querySelector("#close-account-edit").addEventListener("click", () =>
  document.querySelector("#account-edit-dialog").close());
document.querySelector("#cancel-account-edit").addEventListener("click", () =>
  document.querySelector("#account-edit-dialog").close());
document.querySelector("#password-change-form").addEventListener("submit", changeTemporaryPassword);
passwordChangeDialog.addEventListener("cancel", event => event.preventDefault());
