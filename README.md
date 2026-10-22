# Mother's Wonderland Request Portal

The portal keeps staff usage simple: sign in, choose Release & Request, Transfer, Pull Out, or Purchase Order, select products, and submit. The Master Admin connects one shared Google workbook. Requests are saved to fixed form-specific tabs, and the product catalog and dropdown lists are shared by everyone.

Supabase stores accounts, departments, and sequence counters. Submitted forms and their item data are written directly to Google Sheets and are not saved in Supabase. The `google-sheets-api` Supabase Edge Function uses a server-side Google service account to read and write Sheets. Staff do not enter Google URLs or authorize Google.

The current portal does not call the legacy [`google-apps-script/Code.gs`](./google-apps-script/Code.gs) endpoint; form submissions use the `google-sheets-api` Edge Function.

Dates displayed in request forms, inventory, approvals, and history use the `MONTH DAY, YEAR` format (for example, `SEPTEMBER 26, 2026`); stored sheet values remain unchanged.

## One-time setup

### 1. Configure Google Sheets access

1. In Google Cloud, select the project containing the dedicated MW service account and enable the **Google Sheets API** and **Google Drive API**.
2. Create a service-account JSON key and keep the file private. Never upload it to the website, repository, Cloud Shell, or chat.
3. Open the JSON file locally and copy only `client_email` and `private_key`. In Supabase **Project Settings → Edge Functions → Secrets**, add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: the JSON file's `client_email`.
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: the complete `private_key` value, including its `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Keep this secret private.
4. Share the common Google workbook with that service-account email as an **Editor**. Share the dedicated `MW_PORTAL_SALES_ARCHIVE` Drive folder with the same email as a **Viewer**; the service account only reads the completed archives.
5. Keep the shared lookup lists in these tabs:
   - Product catalog tab, read from row 2 onward and loaded only when **Select products** is opened. It is shown in this order: SKU Code from column A, Product Description from B, UOM from C, Cost from H, SRP from I, Expiration Date from D, Onhand from E, and Total Onhand from F. Column G contains the associated outgoing department; **Select products** only shows rows whose G value matches the selected outgoing department. Rows without both a SKU Code and Product Description are skipped.
   - The outgoing-department dropdown is loaded from unique non-empty values in `AREA!A1:A`. Product selection still matches the chosen department against Products column G.
   - User account department choices come from non-empty values in `AREA!A1:A`.
   - Each staff member's department (set by the Master Admin) is automatically used as their Incoming Department.
   - Supplier tab, with supplier names in column B.
6. The Master Admin will paste the common spreadsheet URL and configure each lookup tab name in the portal. The request tabs are created automatically as needed.

### 2. Configure Supabase

1. Create/select a Supabase project. From **Project Settings → API Keys**, copy the Project URL and **publishable key** (or legacy anon key).
2. In **SQL Editor**, run [`supabase/schema.sql`](./supabase/schema.sql), then apply all migrations in timestamp order: [`supabase/migrations/202610150001_user_sheet_assignments.sql`](./supabase/migrations/202610150001_user_sheet_assignments.sql), [`supabase/migrations/202610150002_lookup_tab_settings.sql`](./supabase/migrations/202610150002_lookup_tab_settings.sql), [`supabase/migrations/202610150003_request_number_reservations.sql`](./supabase/migrations/202610150003_request_number_reservations.sql), [`supabase/migrations/202610150004_user_departments_and_status.sql`](./supabase/migrations/202610150004_user_departments_and_status.sql), [`supabase/migrations/202610150005_assign_request_numbers_on_submit.sql`](./supabase/migrations/202610150005_assign_request_numbers_on_submit.sql), [`supabase/migrations/202610160001_reset_request_history.sql`](./supabase/migrations/202610160001_reset_request_history.sql), [`supabase/migrations/202610160002_direct_sheet_request_saves.sql`](./supabase/migrations/202610160002_direct_sheet_request_saves.sql), [`supabase/migrations/202610160003_disable_supabase_request_saves.sql`](./supabase/migrations/202610160003_disable_supabase_request_saves.sql), [`supabase/migrations/202610160004_sheet_status_and_sequence_sync.sql`](./supabase/migrations/202610160004_sheet_status_and_sequence_sync.sql), [`supabase/migrations/202610160005_form_notifications.sql`](./supabase/migrations/202610160005_form_notifications.sql), [`supabase/migrations/202610160006_user_roles_and_form_access.sql`](./supabase/migrations/202610160006_user_roles_and_form_access.sql), [`supabase/migrations/202610160007_master_admin_full_access.sql`](./supabase/migrations/202610160007_master_admin_full_access.sql), and [`supabase/migrations/202610170001_user_activity_logs.sql`](./supabase/migrations/202610170001_user_activity_logs.sql). These migrations add the sheet-synchronized sequence locks, status workflow, saved notifications, role/form access controls, full access for Master Admin accounts, and Supabase-backed user activity logs. The activity logs do not need a Google Sheets tab. Deploy the updated `portal-admin` and `google-sheets-api` functions and publish the portal files.
3. Create the Master Admin account in **Authentication → Users** and confirm it. Map its username and grant Master Admin access in **SQL Editor**, replacing the example email:

   ```sql
   insert into public.login_usernames (username, user_id, role, allowed_form_types)
   select 'admin', id, 'admin', array['release-request', 'transfer', 'pull-out', 'purchase-order']
   from auth.users
   where email = 'admin@example.com';

   insert into public.mw_portal_admins (user_id)
   select id
   from auth.users
   where email = 'admin@example.com';
   ```

   Confirm each statement inserts exactly one row. After setup, the Master Admin creates staff accounts from the dashboard; no per-user output tab assignment is required.
4. Deploy the Supabase functions from this project folder:

   ```sh
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy username-login --no-verify-jwt
   supabase functions deploy portal-admin
   supabase functions deploy google-sheets-api
   ```

   The project ref is the part before `.supabase.co` in the Project URL. `username-login` is public because its job is to create the user's session. The admin and Google Sheets functions require a valid signed-in user.
5. Configure the archive folder ID as an Edge Function secret, using the ID from its Drive folder link:

   ```sh
   supabase secrets set GOOGLE_SALES_ARCHIVE_FOLDER_ID=YOUR_ARCHIVE_FOLDER_ID
   supabase functions deploy google-sheets-api
   ```

### 3. Publish the portal

Set the public Supabase Project URL and publishable/anon key in `DEPLOYMENT_SETTINGS` near the top of [`app.js`](./app.js):

```js
const DEPLOYMENT_SETTINGS = {
  supabase: {
    url: "https://YOUR_PROJECT_REF.supabase.co",
    key: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
  },
};
```

Publish `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, `SIG.png`, `assets/`, and `supabase/` together to a static HTTPS host such as GitHub Pages. Keep the service worker and manifest at the portal root and publish all generated `assets/app-icon-*.png` icons. The publishable/anon key is designed for browser use with RLS enabled. **Never use a `service_role` key, `sb_secret_` key, or Google private key in the website.**

The portal is installable as a Progressive Web App (PWA) on supported devices. Open the published HTTPS portal and use **Install app** in the login screen or workspace header. In Safari on iPhone or iPad, use **Share → Add to Home Screen**. On desktop browsers that do not show the install prompt, use the browser menu's **Install page** option. Cached app-shell assets are served immediately and refreshed in the background; page navigation and live portal data remain network-first. The app shell can load from cache when offline, but sign-in, Google Sheets, and other live portal data require an internet connection.

Signed-in sessions are stored for the current browser tab, automatically sign out after 10 minutes without activity, and are cleared when the tab or installed app is closed.

The Master Admin's **User Logs History** page is available from **Reports & History** and is stored in Supabase, independently of the Google workbook. It records successful sign-ins, pages viewed, successful portal actions, and sign-outs, with the user's department, session, and full local timestamp. Use **Filter by user**, **Refresh logs**, and **Load more activity** to review them. Select individual rows or all currently loaded rows to delete logs, and use **Save logs** to download all history matching the current user filter as a CSV named with the current date. Activity is recorded after the migration is applied; it is not retroactive.

The Admin-only **Report Summary** includes Daily Sales vs Last Week, Top Rank, Month vs Last Month, Critical Stock, Out of Stock, Stock Availability, Near Expiration, Expired Items, Aging per Description, and Historical Data. Daily Sales, Top Rank, Month vs Last Month, and Historical Data read actual values from the `Sales` tab; the other sections use request history and the configured products tab. Month vs Last Month compares the current month's dated `QTY RELEASED` and `SALES` columns with the same days of the previous month, and also shows the previous month's full total. Historical Data lists dated Sales-sheet entries by month and SKU, with actual quantity and `SALES` values; it does not use released-request estimates. Stock reports use configured-products-tab columns F (on hand), G (department), J (last received), and N (expiry), with expiration dates from column D. Near Expiration, Expired Items, and Aging show the quantity from `data!Y2:Y` beside the expiration date, matched by SKU and department. Critical/low/out/in-stock lists use status values from `data!M2:M`, matched to inventory rows by SKU and department; they do not infer status from quantity thresholds. Aging uses the last-received date.

## Master Admin setup in the portal

1. Sign in using the account granted access through `public.mw_portal_admins`.
2. Expand **Master Admin settings**.
3. Paste the shared Google spreadsheet URL and choose **Save spreadsheet**.
4. Enter the Products, Outgoing Departments, Incoming Departments, and Suppliers tab names under **Spreadsheet setup**, then choose **Save spreadsheet settings**.
5. Set each user's department once when creating the account. It is automatically used as Incoming Department for forms that request one; for regular Users submitting a Pull Out, it sets the Outgoing Department. Admins choose the Pull Out Outgoing Department from the dropdown. No per-user output tab assignment is needed.

Lookup tabs are read-only for portal users. Requests are saved to the fixed tabs `TRANSFER` (Release & Request), `REQUEST` (Transfer), `RTV` (Pull Out), and `P.O REQUEST` (Purchase Order). Each row includes the full **Request Number** (for example, `RRF-0000001`), numeric **Sequence Number**, the portal username in **Submitted By**, and a **Status** value. Status begins as **Pending** and advances through **Approved** and **Released**; forms with an Incoming Department can also advance to **Received**. Workflow columns save the corresponding action dates. Request text fields and saved request text are uppercased; usernames and passwords used for sign-in are not changed.

Requests are written to the first free row after the last occupied row in their destination tab. The **Approvals** page is Admin-only and groups Pending requests into separate expandable buttons by form category. Admins can edit each item's approved quantity and approve the request; approved quantities must be zero or greater and may exceed the originally requested quantity. The approving username is recorded in **Approved By** and displayed as the approval signature. The requestor can see their own status and approval signature under **My requests**.

After approval, a request appears under **Pending to release** for a signed-in user whose saved department matches its Outgoing Department. The full form, including all item details, approved quantities, the `SIG.png` approval signature, and the Approved Date, is shown there and can be printed before marking it Released. Each workflow action saves its date in the request tab: Approved Date, Released Date, and Received Date. Requests with an Incoming Department then appear under **Pending to received** for a user whose saved department matches that value; that user can mark them Received. Pull Out requests have no Incoming Department and are complete when marked Released. Admins can see and authorize requests across all departments in both queues. The backend checks department membership for Users, Admin access for overrides, assigned form types, and the current status when applying each action. Approval names are shown above the approval-signature label in the categorized request cards and in the requestor's **My requests** view.

The **Notifications** inbox keeps form-specific updates for the signed-in user. New submissions notify Admins and Master Admins; approval notifies the requester and outgoing department; release notifies the requester and incoming department, except Pull Out completion, which notifies the requester and outgoing department; receipt notifies the requester and outgoing department. Notifications show the request number and form type, link to the relevant workflow page and request, can be marked read individually or all at once, and can be deleted individually from the signed-in user's inbox. The unread badge checks for changes every minute without reloading the dashboard; inbox history is paginated.

The Admin-only **Report Summary** is displayed directly in its workspace and uses the page scroll rather than nested report scroll areas. Its Daily Sales view reads actual daily quantities and sales amounts from the `Sales` tab. The first two rows contain product/date and `QTY RELEASED`/`SALES` headers; product details are in columns A:F, with item rows beginning at row 3. Daily quantities and sales amounts are summed from columns G and H respectively, grouped by SKU code. Month vs Last Month sums the dated `QTY RELEASED`/`SALES` column pairs for each month, groups the results by department and SKU code, and compares month-to-date against the matching days of the previous month. When a completed-month archive exists, the comparison uses that archived month for its previous-month totals; otherwise it uses the matching dated columns still present on the live sheet. Historical Data lists the actual Sales values for a selected month, preferring the saved archive for completed months. The chart and totals use actual `SALES` values and do not estimate sales from request history. To keep the page responsive, report sections load Sales, request history, and product details only as needed.

### Automatic Sales history archive

The bound Apps Script file [`google-apps-script/SalesArchive.gs`](./google-apps-script/SalesArchive.gs) saves a JSON snapshot of each completed month into the dedicated `MW_PORTAL_SALES_ARCHIVE` Drive folder. To install it, open the Sales workbook, select **Extensions → Apps Script**, add a separate script file named `SalesArchive`, and paste in that file's code. Keep any existing Apps Script files. Select `installSalesArchiveTrigger` and run it once, then approve the requested spreadsheet and Drive permissions. This creates a daily trigger around midnight in the spreadsheet's timezone that copies `Sales!G3:H` into the `QTY RELEASED` / `SALES` column pair whose row 1 date matches that day. It leaves `G3:H` unchanged. It also creates a monthly trigger for 2 a.m. on day 1 in the spreadsheet's timezone; this archives the preceding month as `sales-YYYY-MM.json`. Run `installSalesArchiveTrigger` again after updating the script so both triggers are installed. Triggers run as the account that installed them, which must be able to edit the workbook and archive folder. The service account needs Viewer access to the archive folder for the portal to read files. The first archive is created by the next monthly trigger run; previous months are not backfilled automatically. To archive the immediately preceding month manually, run `archivePreviousMonthSales` from Apps Script.

The **Inventory** dashboard reads department tabs from row 8 onward, using `AREA!A1:A` for department choices and `DD!A1:A` for adjustment categories. Admins can choose any listed department; regular Users are restricted to their assigned department. The item drawer reads and updates expiration batch 1 date/quantity in columns H/I, batch 2 in J/K, and batch 3 in L/M for the selected row; adjustments write category, quantity, and remarks to columns R:T when provided. The server validates the department, category, batch values, and selected SKU row. Stock received, latest received date, and total available quantity are read-only values from the sheet. The **Inventory Form** can be refreshed and printed; it loads its first expiration-batch quantity from column Y of the `data` tab, matched by SKU and department, while expiration dates and ending quantities remain blank for manual entry.

The **Request and Released History**, **Transfer History**, **Pull Out History**, and **P.O History** dashboards read from `TRANSFER`, `REQUEST`, `RTV`, and `P.O REQUEST`, respectively. They include only rows whose saved status is not Pending, are searchable and refreshable, and follow the same department selector and assigned-department restrictions as Inventory. History access also respects each User's assigned form types. The Received Qty column displays the saved Approved Qty.

## Roles and form access

Only the Master Admin can create accounts, assign the **Admin** or **User** role, choose a User's assigned forms, and change workbook or portal settings. The Master Admin's **User accounts** directory can edit usernames, departments, roles, form access, and account status; it can also set a new password or delete a non-Master Admin account. Master Admin accounts are protected from deletion, password resets, username changes, and role demotion. Admins can review and approve requests, handle all departments, and see every request in **Reports & History**, but cannot manage accounts or settings. Master Admin access remains controlled by `public.mw_portal_admins`.

For a regular User, select the department from the **AREA** tab's column A and one or more form types when creating the account. The user can submit and view queues only for those forms and sees inventory for the assigned department. **Reports & History** is read-only for request history and shows requests for the assigned form types where the user's department is the outgoing or incoming department. Existing accounts keep access to all four forms after applying the role migration. The backend enforces role, form assignment, and department rules for every read and workflow action; hiding a page or form in the browser is not the security boundary.

The Approvals, Pending to release, and Pending to received navigation buttons show current pending-request counts. Navigation emoji animate subtly on hover and the motion is disabled for users who prefer reduced motion.

The portal keeps the selected dashboard page in the URL hash so it can be restored after a reload or session refresh. Lookup lists are briefly cached in the signed-in browser session, and workflow requests for the separate form tabs are fetched concurrently.

The next sequence number is recalculated from the matching sheet when the form preview loads and again at submit. Deleting request rows therefore resets numbering to 1 when the corresponding tab has no remaining request rows, or resumes after the highest remaining request number. A per-form lock prevents simultaneous requests from reusing a number during the sheet write. If writing to Sheets fails after allocation, the portal reports the failure; the next preview reconciles the counter with the sheet. Request tabs store status as plain text (without a dropdown) and are resized to the header and request rows in use, without reserving extra blank rows.

## Staff use

Open the portal's sign-in screen, enter the username and password from the administrator (use **Show** to reveal the password if needed), choose a form, select departments (and a supplier for Purchase Order), select products after choosing the outgoing department, and submit. Use **My requests** to follow your request statuses and **Notifications** to review form-specific updates. Master Admins use **Approvals** to review and approve; the matching outgoing and incoming departments use **Pending to release** and **Pending to received** to complete their respective steps.

## Adding and managing a staff account

1. Sign in as Master Admin and use **Add a user** to enter a username, department, role, allowed forms, temporary password, and status. The dashboard creates and confirms the Supabase Auth account and maps the username. Since Supabase Auth requires an email, it generates a non-deliverable internal address from the username; no email is sent or needed.
2. Give the staff member their username and temporary password through a secure channel. The portal accepts uppercase username input by converting it to lowercase.

Use **User accounts** to edit a username, department, role, allowed forms, or status. Enter a new password only when you want to reset it; passwords set here must be at least 8 characters. Deleting an account removes its sign-in access and saved notification inbox, and cannot be undone. Master Admin accounts cannot be deleted or demoted from this directory.

Usernames must contain 3–32 letters, numbers, periods, underscores, or hyphens. Initial passwords must be at least 6 characters and should be delivered privately. A new user created with **Default** status must change the temporary password at first sign-in. After changing it, the account becomes **Active**. The saved department is preselected as the user's Incoming Department on request forms.

## Run locally

Open `index.html` in a modern browser with internet access. For sign-in and data access, the Supabase schema and Edge Functions must be configured. Status changes are managed in the Google Sheets request tabs; the portal writes each new row as **Pending**.
