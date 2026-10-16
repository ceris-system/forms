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
    <div class="approval-status"><strong>STATUS</strong><span>Pending · update to Approved, then Received, in the spreadsheet.</span></div>
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
    const result = await requestSheetData("lookup");
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
    console.error("Unable to load products from Google Sheets.", error);
    catalogStatus.textContent = `Could not load products: ${error.message || "Google Sheets returned an unexpected error."}`;
    catalogRows = [];
  }
}

async function requestSheetData(action, payload) {
  if (!supabaseClient || !currentSession) throw new Error("Sign in before accessing the assigned Google spreadsheet.");
  const { data, error } = await supabaseClient.functions.invoke("google-sheets-api", {
    body: { action, ...(action === "submit" ? { submission: payload } : payload || {}) },
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
    const result = await requestSheetData("lookup");
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
  document.querySelector("#breadcrumb-page").textContent = "My forms";
  document.querySelector("#session-status").textContent = signedIn ? "Signed in" : supabaseClient ? "Ready to sign in" : "Setup needed";
  if (!signedIn && catalogDialog.open) catalogDialog.close();
  if (!signedIn && requestDialog.open) requestDialog.close();
  if (!signedIn || currentUserProfile.mustChangePassword) {
    document.querySelector("#supabase-connection").hidden = true;
    if (requestDialog.open) requestDialog.close();
    if (catalogDialog.open) catalogDialog.close();
    if (signedIn && !passwordChangeDialog.open) passwordChangeDialog.showModal();
    if (!signedIn && passwordChangeDialog.open) passwordChangeDialog.close();
  } else {
    if (passwordChangeDialog.open) passwordChangeDialog.close();
    void refreshAdminTools();
  }
  if (navigate) location.hash = "user-forms";
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
      if (session && event !== "SIGNED_OUT") {
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
  panel.hidden = true;
  if (!supabaseClient || !currentSession) return;
  const userId = currentSession.user.id;
  try {
    const access = await callPortalAdmin({ action: "status" });
    if (!access.is_master_admin || currentSession?.user.id !== userId) return;
    panel.hidden = false;
    await loadAdminState();
  } catch (error) {
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
    document.querySelector("#auth-password").value = "";
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
  const links = document.querySelectorAll(".nav-link");
  const sections = [...links].map((link) => document.querySelector(link.getAttribute("href")));
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    for (const link of links) link.classList.toggle("active", link.getAttribute("href") === `#${visible.target.id}`);
  }, { rootMargin: "-15% 0px -70% 0px" });
  for (const section of sections) if (section) observer.observe(section);
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
