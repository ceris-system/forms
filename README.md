# Mother's Wonderland Request Portal

The portal keeps staff usage simple: sign in, choose Release & Request, Transfer, Pull Out, or Purchase Order, add products, and submit. The Master Admin connects one shared Google workbook and assigns each account its own output tab. The product catalog and dropdown lists are shared by everyone.

Supabase stores accounts, departments, spreadsheet assignments, and sequence counters. Submitted forms and their item data are written directly to Google Sheets and are not saved in Supabase. The `google-sheets-api` Supabase Edge Function uses a server-side Google service account to read and write Sheets. Staff do not enter Google URLs or authorize Google.

## One-time setup

### 1. Configure Google Sheets access

1. In Google Cloud, select the project containing the dedicated MW service account and enable the **Google Sheets API**.
2. Create a service-account JSON key and keep the file private. Never upload it to the website, repository, Cloud Shell, or chat.
3. Open the JSON file locally and copy only `client_email` and `private_key`. In Supabase **Project Settings → Edge Functions → Secrets**, add:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: the JSON file's `client_email`.
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: the complete `private_key` value, including its `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Keep this secret private.
4. Share the common Google workbook with that service-account email as an **Editor**.
5. Keep the shared lookup lists in these tabs:
   - Product catalog tab, read from row 2 onward and shown in this order: SKU Code from column A, Product Description from B, UOM from C, Cost from H, SRP from I, Expiration Date from D, Onhand from E, and Total Onhand from F. Column G contains the associated outgoing department; Add Product only shows rows whose G value matches the selected outgoing department. Rows without both a SKU Code and Product Description are skipped.
   - Outgoing department names are derived from unique non-empty values in column G of the configured Products tab, from row 2 onward.
   - Each staff member's department (set by the Master Admin) is automatically used as their Incoming Department.
   - Supplier tab, with supplier names in column B.
6. The Master Admin will paste the common spreadsheet URL and configure each lookup tab name in the portal. Each user's output tab is created automatically the first time a request is copied there.

### 2. Configure Supabase

1. Create/select a Supabase project. From **Project Settings → API Keys**, copy the Project URL and **publishable key** (or legacy anon key).
2. In **SQL Editor**, run [`supabase/schema.sql`](./supabase/schema.sql). If the existing request schema is already installed, apply any missing migrations in order: [`supabase/migrations/202610150001_user_sheet_assignments.sql`](./supabase/migrations/202610150001_user_sheet_assignments.sql), [`supabase/migrations/202610150002_lookup_tab_settings.sql`](./supabase/migrations/202610150002_lookup_tab_settings.sql), [`supabase/migrations/202610150003_request_number_reservations.sql`](./supabase/migrations/202610150003_request_number_reservations.sql), [`supabase/migrations/202610150004_user_departments_and_status.sql`](./supabase/migrations/202610150004_user_departments_and_status.sql), [`supabase/migrations/202610150005_assign_request_numbers_on_submit.sql`](./supabase/migrations/202610150005_assign_request_numbers_on_submit.sql), [`supabase/migrations/202610160001_reset_request_history.sql`](./supabase/migrations/202610160001_reset_request_history.sql), [`supabase/migrations/202610160002_direct_sheet_request_saves.sql`](./supabase/migrations/202610160002_direct_sheet_request_saves.sql), and [`supabase/migrations/202610160003_disable_supabase_request_saves.sql`](./supabase/migrations/202610160003_disable_supabase_request_saves.sql). Migration 006 lets the Master Admin clear legacy request data and reset sequences; migration 007 provides atomic sequence allocation for direct-to-Sheets submissions; migration 008 removes the old Supabase request-saving RPC. Then deploy the updated `portal-admin` and `google-sheets-api` functions and publish the portal files.
3. Create the Master Admin account in **Authentication → Users** and confirm it. Map its username and grant Master Admin access in **SQL Editor**, replacing the example email:

   ```sql
   insert into public.login_usernames (username, user_id)
   select 'admin', id
   from auth.users
   where email = 'admin@example.com';

   insert into public.mw_portal_admins (user_id)
   select id
   from auth.users
   where email = 'admin@example.com';
   ```

   Confirm each statement inserts exactly one row. After setup, the Master Admin creates staff accounts from the dashboard; only the Master Admin can assign their output tabs.
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

Publish `index.html`, `app.js`, `styles.css`, `assets/`, and `supabase/` together to a static HTTPS host such as GitHub Pages. The publishable/anon key is designed for browser use with RLS enabled. **Never use a `service_role` key, `sb_secret_` key, or Google private key in the website.**

## Master Admin setup in the portal

1. Sign in using the account granted access through `public.mw_portal_admins`.
2. Expand **Master Admin settings**.
3. Paste the shared Google spreadsheet URL and choose **Save spreadsheet**.
4. Enter the Products, Outgoing Departments, Incoming Departments, and Suppliers tab names under **Spreadsheet setup**, then choose **Save spreadsheet settings**.
5. Set each user's department once when creating the account, then enter a distinct output tab in **Assign a tab to each user**. Choose **Save user** to save the tab; the department is retained automatically and preselected as Incoming Department. The portal creates the output tab on the user's first request.
6. Assign a tab to the Master Admin account too if the Master Admin will submit requests.

Lookup tabs are read-only for portal users. Release & Request submissions are appended to the shared workbook's `TRANSFER` tab; other forms are written to each user's assigned tab, with a **Form Type** column identifying the type. Each row includes the full **Request Number** (for example, `RRF-0000001`), numeric **Sequence Number**, and portal username in **Submitted By**; no request details or Supabase request ID are written to Supabase. Supabase atomically allocates sequence numbers to avoid duplicates during concurrent submissions. The next number is previewed after an outgoing department is selected; another user's submission may advance it before final save. If writing to Sheets fails after a number is allocated, the portal reports the failure; a sequence number may be skipped. To reset after clearing request rows in Sheets, use **Reset all form sequences** in Master Admin settings and confirm with `RESET`; this also removes any legacy requests still stored in Supabase, but leaves spreadsheet contents and user accounts unchanged.

## Staff use

Open the portal, select **Sign in**, enter the username and password from the administrator, choose a form, select departments (and a supplier for Purchase Order), add products, and submit.

## Adding a staff account

1. Sign in as Master Admin and use **Add a user** to enter a username, department, temporary password, and status. The dashboard creates and confirms the Supabase Auth account and maps the username. Since Supabase Auth requires an email, it generates a non-deliverable internal address from the username; no email is sent or needed.
2. Assign the new user a unique output tab under **Assign a tab to each user**; the department was saved during account creation.
3. Give the staff member their username and temporary password through a secure channel. The portal accepts uppercase username input by converting it to lowercase.

Usernames must contain 3–32 letters, numbers, periods, underscores, or hyphens. Passwords must be at least 6 characters and should be delivered privately. A new user created with **Default** status must change the temporary password at first sign-in. After changing it, the account becomes **Active**. The assigned department is preselected as the user's Incoming Department on request forms, but they can change it.

## Run locally

Open `index.html` in a modern browser with internet access. For sign-in and data access, the Supabase schema and Edge Functions must be configured. A user needs an assigned output tab to submit requests; lookup data can be loaded without one. Approval routing is not implemented.
