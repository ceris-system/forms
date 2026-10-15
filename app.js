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
const authDialog = document.querySelector("#auth-dialog");
const passwordChangeDialog = document.querySelector("#password-change-dialog");
let catalogRows = [];
let selectedCatalogRows = new Set();
let supabaseClient = null;
let currentSession = null;
let currentUserProfile = { username: "", department: "", status: "active", mustChangePassword: false };
let authSubscription = null;
let pendingSheetSync = null;
let adminAccounts = [];
let accountAssignments = new Map();

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
    authDialog.showModal();
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
        <p><span>NO.:</span><strong class="request-number">Assigned on submit</strong></p>
        <p><span>DATE:</span><strong>${new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase()}</strong></p>
      </div>
    </div>
    <div class="request-sheet-actions">
      <button class="button add-product-button" type="button" data-add-item disabled><span aria-hidden="true">＋</span> Add product</button>
      <button class="button button-primary submit-request-button" type="submit">▣ Submit</button>
    </div>
    <p class="request-inline-notice" role="status" aria-live="polite"></p>
    <div class="approval-status"><strong>PENDING APPROVALS</strong><span>Awaiting approval workflow setup</span></div>
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
  });
  document.querySelector(".request-form-notice").textContent = `Signed in as ${currentSession.user.email}.`;
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

async function requestSheetData(action, submission) {
  if (!supabaseClient || !currentSession) throw new Error("Sign in before accessing the assigned Google spreadsheet.");
  const { data, error } = await supabaseClient.functions.invoke("google-sheets-api", {
    body: { action, ...(submission ? { submission } : {}) },
  });
  if (error) throw new Error(await edgeFunctionErrorMessage(error));
  if (data?.error) throw new Error(data.error);
  return data;
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
  setRequestNotice(`Signed in as ${currentUserProfile.username || currentSession.user.email}. Loading outgoing departments…`);
  try {
    const result = await requestSheetData("lookup");
    if (!requestDialog.open || requestDialog.dataset.formType !== formType) return;
    populateSelect(outgoing, result.outgoing_departments || [], "department");
    if (supplier) populateSelect(supplier, result.suppliers || [], "supplier");
    setRequestNotice(`Signed in as ${currentUserProfile.username || currentSession.user.email}.`);
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
  const accountName = signedIn ? currentUserProfile.username || session.user.email : "Guest";
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
    saveStatus.textContent = "The portal administrator must add the Supabase URL and publishable key to app.js before publishing.";
    return;
  }
  if (!window.supabase?.createClient) {
    supabaseClient = null;
    document.querySelector("#session-status").textContent = "Connection error";
    updateSessionUi(null, false);
    saveStatus.textContent = "Could not load the Supabase client library. Check your internet connection and reload.";
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
    saveStatus.textContent = `Supabase connection failed: ${error.message || "Check the Project URL and public key."}`;
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
  adminAccounts = Array.isArray(state.users) ? state.users : [];
  accountAssignments = new Map((state.assignments || []).map(assignment => [assignment.user_id, assignment.output_tab]));
  renderAssignments();
}

function renderAssignments() {
  const list = document.querySelector("#assignment-list");
  list.replaceChildren();
  if (!adminAccounts.length) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "No username accounts exist yet. Create accounts and username mappings before assigning tabs.";
    list.append(empty);
    return;
  }
  for (const account of adminAccounts) {
    const row = document.createElement("div");
    row.className = "assignment-row";
    const username = document.createElement("strong");
    username.textContent = `${account.username} · ${account.status || "active"}`;
    const departmentInput = document.createElement("input");
    departmentInput.type = "text";
    departmentInput.maxLength = 100;
    departmentInput.placeholder = "User department";
    departmentInput.value = account.department || "";
    departmentInput.setAttribute("aria-label", `Department for ${account.username}`);
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 100;
    input.placeholder = "Output tab name";
    input.value = accountAssignments.get(account.user_id) || "";
    input.setAttribute("aria-label", `Output tab for ${account.username}`);
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.type = "button";
    button.textContent = "Save user";
    button.addEventListener("click", async () => {
      button.disabled = true;
      document.querySelector("#admin-status").textContent = `Saving department and tab for ${account.username}…`;
      try {
        const result = await callPortalAdmin({
          action: "save_assignment",
          user_id: account.user_id,
          department: departmentInput.value.trim(),
          output_tab: input.value.trim(),
        });
        account.department = result.department;
        if (currentSession?.user.id === account.user_id) {
          currentUserProfile.department = result.department;
          document.querySelector("#account-role").textContent = result.department || "Signed-in user";
        }
        if (result.output_tab) accountAssignments.set(account.user_id, result.output_tab);
        else accountAssignments.delete(account.user_id);
        username.textContent = `${account.username} · ${account.status || "active"}`;
        document.querySelector("#admin-status").textContent = result.output_tab
          ? `${account.username}'s department and output tab "${result.output_tab}" are saved.`
          : `${account.username}'s department is saved; no output tab is assigned.`;
      } catch (error) {
        console.error("Unable to save a user sheet assignment.", error);
        document.querySelector("#admin-status").textContent = `Could not save ${account.username}'s department and tab: ${error.message || "Request failed."}`;
      } finally {
        button.disabled = false;
      }
    });
    row.append(username, departmentInput, input, button);
    list.append(row);
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
    adminAccounts = [...adminAccounts, {
      user_id: result.user_id,
      username: result.username,
      department: result.department,
      status: result.status,
    }]
      .sort((left, right) => left.username.localeCompare(right.username));
    renderAssignments();
    status.textContent = `User "${result.username}" added. Assign an output tab below, then give the username and temporary password privately.`;
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
    authDialog.close();
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
    setRequestNotice("You must be signed in to Supabase to submit a request.");
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
  document.querySelector("#retry-sheet-sync").hidden = true;
  setRequestNotice("Submitting request…");
  try {
    const { data, error } = await supabaseClient.rpc("submit_request", {
      p_form_type: formType,
      p_outgoing_department: outgoingDepartment.value.trim(),
      p_incoming_department: incomingDepartment.value.trim(),
      p_supplier: supplier || null,
      p_items: items,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.request_number) throw new Error("The database saved the request but did not return its request number.");
    requestFormBody.querySelector(".request-number").textContent = result.request_number;
    pendingSheetSync = {
      request_id: result.request_id,
      request_number: result.request_number,
      form_type: formType,
      request_date: getLocalDate(),
      outgoing_department: outgoingDepartment.value.trim(),
      incoming_department: incomingDepartment.value.trim(),
      supplier,
      items,
    };
    await syncPendingSheetSubmission();
  } catch (error) {
    console.error("Unable to submit request.", error);
    const errorMessage = error?.code === "PGRST202"
      ? "The database is missing the latest submit_request function. Run migration 202610150005_assign_request_numbers_on_submit.sql in Supabase, then try again."
      : error.message || "Supabase returned an unexpected error.";
    if (pendingSheetSync) {
      setRequestNotice(`Request ${pendingSheetSync.request_number} is saved in Supabase, but its Google Sheets copy failed: ${errorMessage}`);
      document.querySelector("#retry-sheet-sync").hidden = false;
    } else {
      setRequestNotice(`Request was not submitted: ${errorMessage}`);
    }
  } finally {
    submitButton.disabled = Boolean(pendingSheetSync);
  }
}

async function syncPendingSheetSubmission() {
  if (!pendingSheetSync || !currentSession || !supabaseClient) throw new Error("Sign in again before syncing the request to Google Sheets.");
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  if (!data.session?.access_token) throw new Error("Your sign-in session expired. Sign in again before syncing to Google Sheets.");
  await requestSheetData("submit", pendingSheetSync);
  setRequestNotice(`Request ${pendingSheetSync.request_number} saved in Supabase and copied to Google Sheets.`);
  document.querySelector("#retry-sheet-sync").hidden = true;
  pendingSheetSync = null;
  document.querySelector(".submit-request-button").disabled = false;
}

renderUserForms();
setActiveNavigation();
configureSupabase(buildSettings());
document.querySelector("#save-workbook").addEventListener("click", saveWorkbook);
document.querySelector("#retry-sheet-sync").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await syncPendingSheetSubmission();
  } catch (error) {
    console.error("Unable to retry Google Sheets sync.", error);
    setRequestNotice(`Request ${pendingSheetSync?.request_number || ""} is still saved in Supabase, but Google Sheets sync failed: ${error.message}`);
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
    document.querySelector("#auth-status").textContent = "";
    authDialog.showModal();
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
document.querySelector("#add-user-form").addEventListener("submit", addUser);
document.querySelector("#password-change-form").addEventListener("submit", changeTemporaryPassword);
passwordChangeDialog.addEventListener("cancel", event => event.preventDefault());
document.querySelector("#close-auth-dialog").addEventListener("click", () => authDialog.close());
document.querySelector("#cancel-auth").addEventListener("click", () => authDialog.close());
