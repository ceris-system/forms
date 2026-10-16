const FORM_TYPES = [
  { id: "release-request", name: "Release & Request Form", shortName: "Release & Request", prefix: "RRF", description: "Request or release inventory between departments.", symbol: "↗" },
  { id: "transfer", name: "Transfer Form", shortName: "Transfer", prefix: "TRF", description: "Record stock transfers between departments.", symbol: "⇄" },
  { id: "pull-out", name: "Pull Out Form", shortName: "Pull Out", prefix: "PUF", description: "Document items being pulled out of inventory.", symbol: "↙" },
  { id: "purchase-order", name: "Purchase Order Form", shortName: "Purchase Order", prefix: "POF", description: "Record purchase order requests.", symbol: "▧" },
];

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
let catalogRows = [];
let selectedCatalogRows = new Set();
let supabaseClient = null;
let currentSession = null;
let currentUserProfile = { username: "", department: "", status: "active", mustChangePassword: false };
let authSubscription = null;
let isMasterAdmin = false;
let profileUserId = "";
let adminStatusUserId = "";
let lookupCache = null;
let activePageId = "";
const workflowLoadIds = new Map();

function getLocalDate() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
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
    <span class="open-form-button">Open form <span aria-hidden="true">→</span></span>`;
  return card;
}

function openRequestForm(form) {
  if (!currentSession) {
    if (!supabaseClient) {
      saveStatus.textContent = "The portal is not connected yet. Contact your administrator.";
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
        <p><span>DATE:</span><strong>${new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase()}</strong></p>
      </div>
    </div>
    <div class="request-sheet-actions">
      <button class="button add-product-button" type="button" data-add-item disabled><span aria-hidden="true">＋</span> Select products</button>
      <button class="button button-primary submit-request-button" type="submit">▣ Submit</button>
    </div>
    <p class="request-inline-notice" role="status" aria-live="polite"></p>
    <div class="approval-status"><strong>STATUS</strong><span>Pending → Approved → Released → Received. Master Admin approves; matching departments release and receive.</span></div>
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
  remove.textContent = "×";
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
  return data;
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
      mustChangePassword: profile.status === "default",
    };
    const incomingDepartment = requestFormBody.querySelector("#incoming-department");
    if (incomingDepartment) {
      incomingDepartment.replaceChildren(new Option(profile.department || "Department not assigned", profile.department || ""));
      incomingDepartment.disabled = !profile.department;
    }
    updateSessionUi(session, false);
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
    currentUserProfile = { username: "", department: "", status: "active", mustChangePassword: false };
    profileUserId = "";
    adminStatusUserId = "";
    isMasterAdmin = false;
    lookupCache = null;
    document.body.classList.remove("admin-mode");
  }
  currentSession = session;
  const signedIn = Boolean(session);
  document.body.classList.toggle("signed-out", !signedIn);
  const metadata = session?.user?.user_metadata || {};
  if (signedIn && !currentUserProfile.username) {
    currentUserProfile = {
      username: metadata.portal_username || "",
      department: metadata.department || "",
      status: metadata.must_change_password ? "default" : "active",
      mustChangePassword: Boolean(metadata.must_change_password),
    };
  }
  if (!signedIn) currentUserProfile = { username: "", department: "", status: "active", mustChangePassword: false };
  const accountName = signedIn ? currentUserProfile.username || "Signed-in user" : "Guest";
  document.body.classList.add("user-mode");
  document.querySelector("#toggle-user-mode").textContent = signedIn ? "Sign out" : "Sign in";
  document.querySelector("#account-avatar").textContent = signedIn ? accountName.slice(0, 1).toUpperCase() : "G";
  document.querySelector("#account-name").textContent = accountName;
  document.querySelector("#account-role").textContent = signedIn ? currentUserProfile.department || "Signed-in user" : "Request portal";
  document.querySelector("#account-badge").textContent = signedIn ? "USER" : "GUEST";
  document.querySelector("#session-status").textContent = signedIn ? "Signed in" : supabaseClient ? "Ready to sign in" : "Setup needed";
  if (!signedIn && catalogDialog.open) catalogDialog.close();
  if (!signedIn && requestDialog.open) requestDialog.close();
  if (!signedIn || currentUserProfile.mustChangePassword) {
    isMasterAdmin = false;
    adminStatusUserId = "";
    document.body.classList.remove("admin-mode");
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
    const requestedPage = navigate ? "user-forms" : location.hash.slice(1) || activePageId || "user-forms";
    const validPages = new Set(["user-forms", "my-requests", "approvals", "pending-release", "pending-received"]);
    activatePortalPage(validPages.has(requestedPage) ? requestedPage : "user-forms", false);
  }
}

function unsubscribeFromAuthChanges() {
  authSubscription?.data?.subscription?.unsubscribe();
  authSubscription = null;
}

function renderUserForms() {
  for (const form of FORM_TYPES) userFormGrid.append(makeUserFormButton(form));
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
    supabaseClient = window.supabase.createClient(settings.supabase.url, settings.supabase.key);
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
  document.body.classList.remove("admin-mode");
  try {
    const access = await callPortalAdmin({ action: "status" });
    if (currentSession?.user.id !== userId) return;
    if (!access.is_master_admin) return;
    isMasterAdmin = true;
    document.body.classList.add("admin-mode");
    panel.hidden = false;
    await loadAdminState();
  } catch (error) {
    if (currentSession?.user.id === userId) adminStatusUserId = "";
    console.error("Unable to verify Master Admin access.", error);
    saveStatus.textContent = `Master Admin access could not be checked: ${error.message || "Check the portal-admin function deployment."}`;
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
    const result = await callPortalAdmin({
      action: "create_user",
      username: document.querySelector("#new-user-username").value.trim().toLowerCase(),
      department: document.querySelector("#new-user-department").value.trim(),
      password: document.querySelector("#new-user-password").value,
      status: document.querySelector("#new-user-status").value,
    });
    form.reset();
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
      mustChangePassword: Boolean(data.must_change_password),
    };
    const { error: sessionError } = await supabaseClient.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
    if (sessionError) throw sessionError;
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
  activatePortalPage("user-forms");
}

function activatePortalPage(pageId, refresh = true) {
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
  };
  document.querySelector("#breadcrumb-page").textContent = pageNames[pageId];
  if (location.hash !== `#${pageId}`) history.replaceState(null, "", `#${pageId}`);
  activePageId = pageId;
  if (!pageChanged && !refresh) return;
  const loaders = {
    "my-requests": loadMyRequests,
    approvals: loadApprovalQueue,
    "pending-release": loadPendingRelease,
    "pending-received": loadPendingReceived,
  };
  if (loaders[pageId]) void loaders[pageId]();
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
    status.textContent = requests.length
      ? `${requests.length} request${requests.length === 1 ? "" : "s"}.`
      : `${emptyMessage}: none found.`;
    renderWorkflowRequests(list, requests, action);
  } catch (error) {
    if (workflowLoadIds.get(action) !== loadId) return;
    console.error(`Unable to load ${emptyMessage.toLocaleLowerCase()}.`, error);
    status.textContent = `Could not load requests: ${error.message || "Request failed."}`;
  }
}

function renderWorkflowRequests(container, requests, action) {
  container.replaceChildren();
  for (const form of FORM_TYPES) {
    const categoryRequests = requests.filter(request => request.form_type_id === form.id);
    if (!categoryRequests.length) continue;
    const category = document.createElement("details");
    category.className = "approval-category";
    const categoryHeading = document.createElement("summary");
    categoryHeading.className = "approval-category-title";
    categoryHeading.textContent = `${form.name} (${categoryRequests.length})`;
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
  ]) {
    if (!value && label === "Supplier") continue;
    const pair = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value || "—";
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
      cell.textContent = item[field] || "—";
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
  approvalCaption.textContent = "APPROVAL SIGNATURE";
  approved.append(signature, approver, signatureLine, approvalLabel, approvalCaption);
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
  const nameSpace = imageSpace.cloneNode();
  const line = document.createElement("span");
  line.className = "release-signature-line";
  const title = document.createElement("strong");
  title.textContent = label;
  const caption = document.createElement("small");
  caption.textContent = "SIGNATURE OVER PRINTED NAME";
  signature.append(imageSpace, nameSpace, line, title, caption);
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
    @page { size: A4 landscape; margin: 12mm; }
    * { box-sizing: border-box; font-family: Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; color: #171719; }
    .release-form-sheet { width: 100%; padding: 0; }
    .release-form-header { display: grid; justify-items: center; gap: 5px; margin-bottom: 22px; text-align: center; }
    .release-form-header img { width: 150px; max-height: 42px; object-fit: contain; }
    .release-form-header h2 { margin: 0; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; }
    .release-form-header > strong { font-size: 11px; }
    .release-form-details { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 20px; margin: 0 0 14px; }
    .release-form-details > div { min-width: 0; }
    .release-form-details dt { margin-bottom: 4px; font-size: 8px; font-weight: 700; text-transform: uppercase; }
    .release-form-details dd { margin: 0; overflow-wrap: anywhere; font-size: 10px; }
    .release-form-status { margin: 0 0 8px; font-size: 9px; font-weight: 700; }
    .release-form-items { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .release-form-items thead { display: table-header-group; }
    .release-form-items tr { break-inside: avoid; }
    .release-form-items th { padding: 7px 4px; border: 0; background-color: #171719 !important; color: white !important; font-size: 7px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .release-form-items td { padding: 7px 4px; border-bottom: 1px solid #d9ddd9; font-size: 8px; overflow-wrap: anywhere; }
    .release-form-items th:nth-child(1) { width: 8%; }
    .release-form-items th:nth-child(2) { width: 22%; }
    .release-form-items th:nth-child(3) { width: 5%; }
    .release-form-items th:nth-child(4), .release-form-items th:nth-child(5) { width: 7%; }
    .release-form-items th:nth-child(6) { width: 8%; }
    .release-form-items th:nth-child(7), .release-form-items th:nth-child(8) { width: 7%; }
    .release-form-items th:nth-child(9), .release-form-items th:nth-child(10) { width: 8%; }
    .release-form-items th:nth-child(11) { width: 15%; }
    .release-form-signatures { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; gap: 20px; margin-top: 38px; break-inside: avoid; }
    .release-form-signatures > div { display: grid; min-height: 110px; grid-template-rows: 72px 16px 1px 11px 11px; gap: 4px; text-align: center; }
    .release-form-signatures strong, .release-form-signatures b { align-self: end; font-size: 8px; }
    .release-form-signatures .release-signature-line { height: 1px; border-top: 1px solid #171719; background: transparent; }
    .release-form-unsigned-signature .release-signature-space { background: transparent; }
    .release-form-signatures small { font-size: 7px; font-weight: 600; }
    .release-form-approved-signature img { justify-self: center; width: 112px; height: 72px; max-width: 100%; object-fit: cover; object-position: center 55%; }
    .release-form-approved-signature strong { overflow-wrap: anywhere; font-size: 8px; }
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
  ]) {
    const pair = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value || "—";
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
  if (request.approved_by) {
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
      await requestSheetData("workflow_action", payload);
      card.remove();
      const refresh = action === "approval_queue" ? loadApprovalQueue
        : action === "pending_release" ? loadPendingRelease : loadPendingReceived;
      await refresh();
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
    setRequestNotice(`Request ${result.request_number} was saved to Google Sheets.`);
  } catch (error) {
    console.error("Unable to submit request.", error);
    setRequestNotice(`Request was not saved to Google Sheets: ${error.message || "Request failed."}`);
  } finally {
    submitButton.disabled = false;
  }
}

renderUserForms();
setActiveNavigation();
configureSupabase(buildSettings());
document.querySelector("#save-workbook").addEventListener("click", saveWorkbook);
document.querySelector("#reset-request-history").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = window.prompt(
    "This permanently deletes legacy requests and their items from Supabase. It does not change Google Sheets or user accounts. New sequence numbers are recalculated from the matching Sheets tab. Type RESET to confirm.",
  );
  if (confirmation !== "RESET") return;

  button.disabled = true;
  document.querySelector("#admin-status").textContent = "Deleting legacy Supabase requests…";
  try {
    const result = await callPortalAdmin({ action: "reset_request_history" });
    document.querySelector("#admin-status").textContent =
      `Deleted ${result.deleted_requests} legacy request(s). Sequences continue to follow the request rows in Google Sheets.`;
  } catch (error) {
    console.error("Unable to reset request history.", error);
    document.querySelector("#admin-status").textContent =
      `Could not reset request history: ${error.message || "Request failed."}`;
  } finally {
    button.disabled = false;
  }
});
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
requestFormBody.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "text") {
    const start = event.target.selectionStart;
    const end = event.target.selectionEnd;
    event.target.value = event.target.value.toLocaleUpperCase();
    if (start !== null && end !== null) event.target.setSelectionRange(start, end);
  }
});
document.querySelector("#add-user-form").addEventListener("submit", addUser);
document.querySelector("#password-change-form").addEventListener("submit", changeTemporaryPassword);
passwordChangeDialog.addEventListener("cancel", event => event.preventDefault());
