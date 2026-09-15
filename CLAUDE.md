# The Modern Concierge — Internal Ops Platform

## Purpose

Internal operations platform for The Modern Concierge (TMC), a virtual assistant agency owned by Kaylan. Manages assistants, clients, tasks, and time tracking — replacing ClickUp as the team's operational hub.

## Team & Clients

- ~9 assistants: Alex, Victoria Haas (Tori), Heidi Jo Peaden, Cherish Campbell, Livia Goree, Shae Trahan, Victoria Oser, Olivia Vanderhoeven, Rachel Morvant
- ~20 active clients, each assigned to a primary assistant; some clients shared across multiple assistants
- Each client has an hour package (e.g., "20hr/month") and an independent billing period, computed from a renewal-date anchor + cycle type (monthly/quarterly/annual)
- Payroll runs on a separate, shared biweekly period across all employees — do not conflate billing periods with payroll periods

## Brand

- Palette: dark brown (#3b2b26) / cream (#f6efe6) / dusty rose (#c9a3a0)
- Headings: Playfair Display
- Body: Jost
- Logo: embedded as base64 in the HTML file (not yet added to this rebuild — original had it inline)

## Current Stack

- Single HTML file (`index.html`), vanilla JavaScript, no framework
- App state is Firestore-backed (collections: `clients`, `tasks`, `timeEntries`, `settings/access`) instead of localStorage, to avoid the data-reset issue the original build had
- Firebase init is wrapped defensively — if the SDK fails to load or `firebaseConfig` is still a placeholder, the app renders in a local-only demo mode with a visible warning banner instead of going blank
- Firebase Firestore integration: syncs completed home-orientation submissions from Kaylan's Netlify-hosted onboarding dashboard (collection `orientationClients`, trigger `done.visit === true`) into the matching client's notes log
- ClickUp MCP used historically for one-time data migration (not a live integration)

## Setup Still Needed

1. Replace the placeholder `firebaseConfig` object near the top of the `<script>` in `index.html` with the real project config (same Firebase project as the orientation sync).
2. Set a real admin passcode and per-assistant access codes — either edit `SEED_SETTINGS` in the file before first run, or log in as Admin and use the Team tab afterward (writes to Firestore `settings/access`).
3. Client portal codes (`portalCode` field per client) need to be set per client via the Membership tab before clients can log in.
4. Renewal dates were not available from ClickUp historically and require manual entry per client — preserve these if migrating old data in.

## Core Modules (current build)

**Time tracking:** per-task clock-in/out, live timer on the dashboard, stale-clock warning past 8 hours, editable clock-out time, 30-minute browser notification reminders (requires Notification permission).

**Client CRM:** per-client page with Tasks / Notes / Membership sub-tabs; notes (manual + auto-synced from orientation); special dates, vendors, and inspections are rendered from the client record if present (no dedicated editor UI yet — add one as a follow-up).

**Kanban task board:** five statuses (To do, Researching, In progress, Pending approval, Done); subtasks with checkboxes; Home/Business category badges; multi-assignee selection.

**Hour-usage tier alerts:** computed at 50% / 75% / 90% / 100% of package hours against the current billing period, surfaced on the dashboard, clients list, and each client's page.

**Onboarding hub:** a static checklist for new team members. Currently local-only (not wired to Firestore) — a good next task if you want it to persist per assistant.

**Roles:**
- Admin — passcode-based, full oversight, plus a Team tab to manage assistant access codes and the admin passcode
- Team member — personal access code, full task/client access, clock-in
- Client — view-only (hours used vs. package, open tasks with subtask counts, activity log)

## Key Design Principles

- Tasks are not period-stamped — open tasks carry forward automatically on client renewal without manual migration. This is intentional; don't "fix" it.
- Reassigning a client should move all its open tasks in bulk but never modify existing time entries (not yet implemented as a bulk action — currently reassignment would be manual).
- Internal TMC work (team meetings, admin tasks) is tracked under a dedicated `internal` pseudo-client (`INTERNAL_CLIENT_ID` in the code) so hours count toward payroll without being billed to any real client.

## ClickUp Data Migration Notes (historical reference, not live)

- Workspace hierarchy: each Space = one assistant; client folder names embed the hour package (e.g., "Josh Stine - 20hr")
- The workspace-wide assignee filter (`assignee: ['any']`) reliably errors out — query per-user with individual ClickUp user IDs instead
- `clickup_filter_tasks` with `list_ids` arrays and `include_closed: True`, paginating pages 0–3, is the reliable pattern
- Previously imported: 10 team members, ~20 clients, 169 tasks (filtered to the last two 30-day periods via status date-range labels), ~127 hours of logged time matched via ClickUp task IDs embedded in task notes

## Backend (Cloud Functions)

- `functions/` — the one exception to "single-file app": auto-files signed client contracts and employee agreements into Google Drive so nobody has to manually download + re-upload them. See `functions/index.js` for the two triggers (`fileClientContractToDrive`, `fileEmployeeAgreementToDrive`) and their doc comments for exactly how/when they fire.
- Requires the Blaze (pay-as-you-go) Firebase plan, the Drive API enabled, and the Cloud Function's runtime service account shared as Editor on the "Clients" and "TMC Employees" Drive folders.
- Config (`CLIENTS_FOLDER_ID`, `EMPLOYEES_FOLDER_ID`) lives in `functions/.env.modern-co-dashboard` (gitignored, not committed — folder IDs aren't secret but there's no reason to hardcode them in source).
- Deploy with `firebase deploy --only functions` from the `tmc-ops/` root (requires `firebase login` once, interactively, on whichever machine deploys).
- If Drive is unreachable for any reason, the functions log the error and leave the signed doc in Firestore untouched — the manual Download / "Downloaded — remove from app" buttons in the app remain a working fallback.
- **This project's GCP org policy blocks PUBLIC (unauthenticated) invocation of Cloud Functions/Cloud Run** — confirmed by deploying a plain `onRequest` function (`viewReport`, since removed) and getting `Failed to set the IAM Policy on the Service` on every attempt, including via `invoker:"public"` and via a Firebase Hosting rewrite (Hosting's own rewrite-to-function proxy also got a 403). If you need something reachable at a URL without the caller being logged into the ops app at all, don't reach for an HTTP-triggered Cloud Function — instead build a static page under `public/` that reads Firestore directly via the client-side SDK with the same anonymous-auth pattern the main app uses (see `public/report.html`, `public/qb-callback.html`). Firestore reads are governed by `firestore.rules`, not Cloud Run IAM, so they aren't subject to this restriction.
  - **This does NOT block `onCall` callable functions invoked from inside the app itself.** `validateLogin`, `getQuickBooksAuthConfig`, `getQuickBooksSummary`, `exchangeQuickBooksCode`, and `disconnectQuickBooks` are all callable functions hit via `firebase.functions().httpsCallable(...)` from an anonymously-authenticated session — confirmed working via direct testing (Sept 2026). The org policy specifically blocks *public/unauthenticated* invocation; a request carrying a valid Firebase Auth token (even an anonymous one) is a different code path and isn't affected.
- `validateLogin` exists in source (see below the Drive functions in `functions/index.js`) and is confirmed deployed and reachable, but **is not yet wired into the app's actual login flow** — `index.html` still validates passcodes client-side. Wiring it in (rewriting `tryAdminLogin`/`tryTeamLogin`/`tryClientLogin` to call it and sign in with the returned custom token, then rewriting `firestore.rules` to check `request.auth.token.role`) is the real fix for the "Known remaining gap" in Security below — a bigger, deliberate follow-up project, not something to do incidentally while touching something else.
- If `fileClientContractToDrive` / `fileEmployeeAgreementToDrive` (Firestore-triggered, `onDocumentUpdated`) ever fail to deploy with "Changing from an HTTPS function to a background triggered function is not allowed," delete the existing function first (`firebase functions:delete <name>`) to force a clean recreate, then redeploy — this has happened before from a stale/orphaned prior deployment of the same function name.

## Security

- **Fixed (Sept 2026):** the entire Firestore database — every client's PII, payment info embedded in signed-but-not-yet-filed contracts, the admin passcode, and every employee's access code — was readable by anyone on the internet with zero authentication, confirmed via a raw unauthenticated REST request against the live database. Root cause: login here is a plain string comparison done client-side (`accessCode===code`), which only stays safe if Firestore's own rules block outside reads — and they didn't.
- **Current fix:** `firestore.rules` requires `request.auth != null` on every read/write to the app's normal collections. The app signs in anonymously (invisible, no extra login step — see `boot()`) before touching Firestore, purely so rules have something to check. The Anonymous provider must stay enabled in Firebase Console → Authentication → Sign-in method, or the whole app loses Firestore access.
- **Known remaining gap:** this blocks raw outside/bot access but does NOT scope what an authenticated session can see per role — a client's browser console can still, in principle, read another client's document, since there's no per-user identity tied to the app's own admin/team/client roles. The real fix is moving passcode validation server-side and minting Firebase custom-auth tokens per role/assistantId/clientId — `validateLogin` already does the server-side half (see Backend section above) but isn't wired into the app's login flow yet. Not urgent-urgent, but a real gap.
- **`firestore.rules` is per-collection, not one `{document=**}` wildcard — this matters, don't "simplify" it back.** Firestore combines multiple matching `match` blocks with OR logic: if ANY matching rule allows a request, it's allowed, full stop. A specific `allow: if false` for one collection does NOT override a broader wildcard rule that also matches that same path and returns true. This means a single catch-all rule makes it structurally impossible to ever wall off one sensitive collection later. `qbTokens` (QuickBooks OAuth tokens, see below) relies entirely on this: it has no matching client-side rule at all, so it defaults to fully denied — the moment anyone reintroduces a `{document=**}` wildcard, that protection silently disappears.
- Deploy rule changes with `firebase deploy --only firestore:rules` from the `tmc-ops/` root.

## QuickBooks Integration (read-only)

- Pulls actual revenue (Payments received) and expenses (Purchases + BillPayments) into the Scorecard tab's "Actual Revenue/Expenses (QuickBooks)" rows, replacing nothing else — every other Scorecard metric is computed from app data regardless of whether QuickBooks is connected.
- **Setup still needed (Kaylan/business-owner step, not something I can do from here):** register an app at [developer.intuit.com](https://developer.intuit.com) under "QuickBooks Online API," get a Client ID + Client Secret, and set the app's Redirect URI to `https://modern-co-dashboard.web.app/qb-callback.html`. Once that exists, set `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI`, and `QB_ENVIRONMENT` (`sandbox` or `production`) in `functions/.env.modern-co-dashboard` and redeploy functions.
- Three callable functions handle it end to end: `getQuickBooksAuthConfig` (returns the public Client ID + redirect URI so the app can build the OAuth link — the Client ID is not secret, same as Firebase's own `apiKey`), `exchangeQuickBooksCode` (called once by `public/qb-callback.html` right after Intuit redirects back with a one-time code; exchanges it for tokens and stores them), and `getQuickBooksSummary` (called by the Scorecard tab; refreshes the access token if it's within 5 minutes of expiring — QBO refresh tokens *rotate* on every use, so the full pair is always re-saved, never just the access token half).
- Tokens live in Firestore's `qbTokens/main` document, readable/writable ONLY via the Cloud Functions' Admin SDK (which bypasses Firestore Rules entirely) — see the per-collection rules note above for why no client-side code can ever reach this collection, by design. This is deliberately more locked down than everything else in the database: a QuickBooks refresh token grants ongoing access to the entire accounting system, not just one client's data.
- Uses cash-basis numbers (Payments/Purchases, "money that actually moved") rather than the Reports API's accrual-basis Profit & Loss endpoint, which is simpler to query but returns a nested row/summary structure that has to be parsed to extract anything.

## Working Conventions

- This is a single-file app — keep it that way unless explicitly asked to split it up.
- Test changes by opening `index.html` directly in a real desktop browser (not an in-app preview pane, which may sandbox scripts) after each edit.
- Commit after each working change (`git add -A && git commit -m "..."`) so there's always a rollback point.
- Firebase writes (`upsert`/`remove`) fail silently with a console warning if Firebase isn't connected — check the browser console if changes don't seem to save.
