# Mother's Wonderland Request Portal

The portal keeps staff usage simple: sign in, choose Release & Request, Transfer, Pull Out, or Purchase Order, select products, and submit. The Master Admin connects one shared Google workbook. Requests are saved to fixed form-specific tabs, and the product catalog and dropdown lists are shared by everyone.

Supabase stores accounts, departments, and sequence counters. Submitted forms and their item data are written directly to Google Sheets and are not saved in Supabase. The `google-sheets-api` Supabase Edge Function uses a server-side Google service account to read and write Sheets. Staff do not enter Google URLs or authorize Google.

The current portal does not call the legacy [`google-apps-script/Code.gs`](./google-apps-script/Code.gs) endpoint; form submissions use the `google-sheets-api` Edge Function.

## One-time setup

### 1. Configure Google Sheets access

1. In Google Cloud, select the project containing the dedicated MW service account and enable the **Google Sheets API**.
2. Create a service-account JSON key and keep the file private. Never upload it to the website, repository, Cloud Shell, or chat.
3. Open the JSON file locally and copy only `client_email` and `private_key`. In Supabase **Project Settings → Edge Functions → Secrets**, add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: the JSON file's `client_email`.
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: the complete `private_key` value, including its `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Keep this secret private.
4. Share the common Google workbook with that service-account email as an **Editor**.
5. Keep the shared lookup lists in these tabs:
   - Product catalog tab, read from row 2 onward and shown in this order: SKU Code from column A, Product Description from B, UOM from C, Cost from H, SRP from I, Expiration Date from D, Onhand from E, and Total Onhand from F. Column G contains the associated outgoing department; **Select products** only shows rows whose G value matches the selected outgoing department. Rows without both a SKU Code and Product Description are skipped.
   - Outgoing department names are derived from unique non-empty values in column G of the configured Products tab, from row 2 onward.
   - Each staff member's department (set by the Master Admin) is automatically used as their Incoming Department.
   - Supplier tab, with supplier names in column B.
6. The Master Admin will paste the common spreadsheet URL and configure each lookup tab name in the portal. The request tabs are created automatically as needed.

### 2. Configure Supabase

1. Create/select a Supabase project. From **Project Settings → API Keys**, copy the Project URL and **publishable key** (or legacy anon key).
2. In **SQL Editor**, run [`supabase/schema.sql`](./supabase/schema.sql), then apply all migrations in timestamp order: [`supabase/migrations/202610150001_user_sheet_assignments.sql`](./supabase/migrations/202610150001_user_sheet_assignments.sql), [`supabase/migrations/202610150002_lookup_tab_settings.sql`](./supabase/migrations/202610150002_lookup_tab_settings.sql), [`supabase/migrations/202610150003_request_number_reservations.sql`](./supabase/migrations/202610150003_request_number_reservations.sql), [`supabase/migrations/202610150004_user_departments_and_status.sql`](./supabase/migrations/202610150004_user_departments_and_status.sql), [`supabase/migrations/202610150005_assign_request_numbers_on_submit.sql`](./supabase/migrations/202610150005_assign_request_numbers_on_submit.sql), [`supabase/migrations/202610160001_reset_request_history.sql`](./supabase/migrations/202610160001_reset_request_history.sql), [`supabase/migrations/202610160002_direct_sheet_request_saves.sql`](./supabase/migrations/202610160002_direct_sheet_request_saves.sql), [`supabase/migrations/202610160003_disable_supabase_request_saves.sql`](./supabase/migrations/202610160003_disable_supabase_request_saves.sql), [`supabase/migrations/202610160004_sheet_status_and_sequence_sync.sql`](./supabase/migrations/202610160004_sheet_status_and_sequence_sync.sql), [`supabase/migrations/202610160005_form_notifications.sql`](./supabase/migrations/202610160005_form_notifications.sql), [`supabase/migrations/202610160006_user_roles_and_form_access.sql`](./supabase/migrations/202610160006_user_roles_and_form_access.sql), and [`supabase/migrations/202610160007_master_admin_full_access.sql`](./supabase/migrations/202610160007_master_admin_full_access.sql). These migrations add the sheet-synchronized sequence locks, status workflow, saved notifications, role/form access controls, and full access for Master Admin accounts. Deploy the updated `portal-admin` and `google-sheets-api` functions and publish the portal files.
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

Publish `index.html`, `app.js`, `styles.css`, `SIG.png`, `assets/`, and `supabase/` together to a static HTTPS host such as GitHub Pages. The publishable/anon key is designed for browser use with RLS enabled. **Never use a `service_role` key, `sb_secret_` key, or Google private key in the website.**

## Master Admin setup in the portal

1. Sign in using the account granted access through `public.mw_portal_admins`.
2. Expand **Master Admin settings**.
3. Paste the shared Google spreadsheet URL and choose **Save spreadsheet**.
4. Enter the Products, Outgoing Departments, Incoming Departments, and Suppliers tab names under **Spreadsheet setup**, then choose **Save spreadsheet settings**.
5. Set each user's department once when creating the account; it is retained and automatically used as Incoming Department. No per-user output tab assignment is needed.

Lookup tabs are read-only for portal users. Requests are saved to the fixed tabs `TRANSFER` (Release & Request), `REQUEST` (Transfer), `RTV` (Pull Out), and `P.O REQUEST` (Purchase Order). Each row includes the full **Request Number** (for example, `RRF-0000001`), numeric **Sequence Number**, the portal username in **Submitted By**, and a **Status** value. Status begins as **Pending** and advances through **Approved**, **Released**, and **Received** through the portal workflow. Workflow columns also save **Approved Date**, **Released Date**, and **Received Date** when each action is completed. Request text fields and saved request text are uppercased; usernames and passwords used for sign-in are not changed.

Requests are written to the first free row after the last occupied row in their destination tab. The **Approvals** page is Admin-only and groups Pending requests into separate expandable buttons by form category. Admins can edit each item's approved quantity and approve the request; approved quantities must be zero or greater and may exceed the originally requested quantity. The approving username is recorded in **Approved By** and displayed as the approval signature. The requestor can see their own status and approval signature under **My requests**.

After approval, a request appears under **Pending to release** for a signed-in user whose saved department matches its Outgoing Department. The full form, including all item details, approved quantities, the `SIG.png` approval signature, and the Approved Date, is shown there and can be printed before marking it Released. Each workflow action saves its date in the request tab: Approved Date, Released Date, and Received Date. The request then appears under **Pending to received** for a user whose saved department matches its Incoming Department; that user can mark it Received. Admins can see and authorize requests across all departments in both queues. The backend checks department membership for Users, Admin access for overrides, assigned form types, and the current status when applying each action. Approval names are shown above the approval-signature label in the categorized request cards and in the requestor's **My requests** view.

The **Notifications** inbox keeps form-specific updates for the signed-in user. New submissions notify Admins and Master Admins; approval notifies the requester and outgoing department; release notifies the requester and incoming department; receipt notifies the requester and outgoing department. Notifications show the request number and form type, link to the relevant workflow page and request, and can be marked read individually or all at once. The unread badge checks for changes every minute without reloading the dashboard; inbox history is paginated.

## Roles and form access

The Master Admin creates accounts with either the **Admin** or **User** role. Admins can manage users, review and approve requests, handle all departments, change workbook settings, and see every request in **Reports & History**. Only a Master Admin can grant Admin status. Master Admin access remains controlled by `public.mw_portal_admins`.

For a regular User, select one or more form types when creating the account. The user can submit and view queues only for those forms. **Reports & History** is read-only and shows requests for the assigned form types where the user's department is the outgoing or incoming department. Existing accounts keep access to all four forms after applying the role migration. The backend enforces role, form assignment, and department rules for every read and workflow action; hiding a page or form in the browser is not the security boundary.

The Approvals, Pending to release, and Pending to received navigation buttons show current pending-request counts. Navigation emoji animate subtly on hover and the motion is disabled for users who prefer reduced motion.

The portal keeps the selected dashboard page in the URL hash so it can be restored after a reload or session refresh. Lookup lists are briefly cached in the signed-in browser session, and workflow requests for the separate form tabs are fetched concurrently.

The next sequence number is recalculated from the matching sheet when the form preview loads and again at submit. Deleting request rows therefore resets numbering to 1 when the corresponding tab has no remaining request rows, or resumes after the highest remaining request number. A per-form lock prevents simultaneous requests from reusing a number during the sheet write. If writing to Sheets fails after allocation, the portal reports the failure; the next preview reconciles the counter with the sheet. Request tabs store status as plain text (without a dropdown) and are resized to the header and request rows in use, without reserving extra blank rows.

## Staff use

Open the portal's sign-in screen, enter the username and password from the administrator (use **Show** to reveal the password if needed), choose a form, select departments (and a supplier for Purchase Order), select products after choosing the outgoing department, and submit. Use **My requests** to follow your request statuses and **Notifications** to review form-specific updates. Master Admins use **Approvals** to review and approve; the matching outgoing and incoming departments use **Pending to release** and **Pending to received** to complete their respective steps.

## Adding a staff account

1. Sign in as Master Admin and use **Add a user** to enter a username, department, temporary password, and status. The dashboard creates and confirms the Supabase Auth account and maps the username. Since Supabase Auth requires an email, it generates a non-deliverable internal address from the username; no email is sent or needed.
2. Give the staff member their username and temporary password through a secure channel. The portal accepts uppercase username input by converting it to lowercase.

Usernames must contain 3–32 letters, numbers, periods, underscores, or hyphens. Passwords must be at least 6 characters and should be delivered privately. A new user created with **Default** status must change the temporary password at first sign-in. After changing it, the account becomes **Active**. The saved department is preselected as the user's Incoming Department on request forms.

## Run locally

Open `index.html` in a modern browser with internet access. For sign-in and data access, the Supabase schema and Edge Functions must be configured. Status changes are managed in the Google Sheets request tabs; the portal writes each new row as **Pending**.
