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
- **Setup still needed (Kaylan/business-owner step, not something I can do from here):** register an app at [developer.intuit.com](https://developer.intuit.com) under "QuickBooks Online API," get a Client ID + Client Secret, and set the app's Redirect URI in Intuit's own settings to match `QB_REDIRECT_URI` below exactly — the two must always match. Then set `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI`, `QB_ENVIRONMENT` (`sandbox` or `production`), and `QB_TOKEN_ENCRYPTION_KEY` in `functions/.env.modern-co-dashboard` and redeploy functions.
- **Flow (Sept 2026, rewritten for Intuit's App Store security review):**
  - `getQuickBooksAuthConfig` (callable) — mints a random, single-use CSRF `state` value, stores it server-side (`qbTokens/pendingState`, 10-min expiry), and returns it plus the public Client ID/redirect URI so the app can build the OAuth authorize link.
  - `quickBooksOAuthCallback` (plain HTTP function, NOT callable — this is the actual Redirect URI registered with Intuit) — Intuit's servers redirect the admin's browser here with `code`/`realmId`/`state`. Validates `state` against the stored value (real CSRF protection, not just cosmetic), exchanges the code for tokens, encrypts and stores them, then immediately issues a 302 redirect to `public/qb-connected.html?ok=1` (or `?ok=0` on any failure) — no sensitive code/token value is ever the content of a rendered page or lingers in the address bar/history. This directly satisfies Intuit's requirement that endpoints receiving auth tokens in URL params redirect rather than render HTML.
  - `getQuickBooksSummary` (callable) — called by the Scorecard tab; decrypts the stored tokens, refreshes if within 5 minutes of expiring (QBO refresh tokens *rotate* on every use — the full encrypted pair is always re-saved, never just the access token half), queries Payments/Purchases/BillPayments, and returns ONLY the aggregated dollar totals — never raw transaction records.
  - `disconnectQuickBooks` (callable) — admin clicks Disconnect in the app.
  - `quickBooksDisconnectWebhook` (plain HTTP function) — Intuit's own "Disconnect URL" webhook, called by Intuit's servers if the connection is revoked from the QuickBooks side instead of ours.
- Tokens live in Firestore's `qbTokens/main` document, **encrypted at rest with AES-256-GCM** (key in `QB_TOKEN_ENCRYPTION_KEY`, never alongside the ciphertext), readable/writable ONLY via the Cloud Functions' Admin SDK (which bypasses Firestore Rules entirely) — see the per-collection rules note above for why no client-side code can ever reach this collection, by design.
- Uses cash-basis numbers (Payments/Purchases, "money that actually moved") rather than the Reports API's accrual-basis Profit & Loss endpoint, which is simpler to query but returns a nested row/summary structure that has to be parsed to extract anything.
- **`public/qb-callback.html` no longer exists** — replaced by the `quickBooksOAuthCallback` function + `public/qb-connected.html` (a clean, no-sensitive-params landing page). If you see references to the old file anywhere, they're stale.

### Intuit App Store security review — status (Sept 2026)

Checked against Intuit's published security requirements for App Store listing:

- **Already compliant / not applicable to this architecture:**
  - No user QuickBooks credentials or QB financial data ever appear in `console.log`/`console.error` calls (audited).
  - No SQL/XML injection surface — Firestore (NoSQL), no XML parsing anywhere in this integration.
  - No third-party sharing of QuickBooks data; only aggregated dollar totals are stored, never raw transaction records (see `getQuickBooksSummary` above).
  - No custom session cookies (Secure/HttpOnly N/A) — auth is Firebase's own SDK-managed token storage, not cookie-based.
  - No QuickBooks *login credentials* are ever stored (OAuth means this app never sees the user's actual QuickBooks username/password) — the "User Credentials" / password-hashing requirement doesn't apply.
  - OS/web-server/TLS patching is Google's/Netlify's responsibility as the managed hosting providers, not something this app configures directly.
- **Fixed as part of this review (Sept 2026):**
  - OAuth tokens now encrypted at rest (were plain text in Firestore before).
  - Real CSRF `state` validation added (was generated client-side and never actually checked before).
  - OAuth callback rewritten to redirect immediately instead of rendering a page at a URL carrying the auth code.
  - `Cache-Control: no-cache, no-store` (plus `X-Content-Type-Options`/`X-Frame-Options`) added to all Firebase Hosting responses via `firebase.json`.
- **Explicitly NOT done, and worth knowing about:**
  - No app-wide XSS/session-management penetration test has been run — this review only covered the QuickBooks integration surface, not the whole ~7,000-line app. The existing "Known remaining gap" under Security above (no per-role server-side access control) is the biggest related item.
  - Committing to Intuit's ongoing obligations (allowing vulnerability scans within 2 weeks of request, completing a security affidavit, annual re-review once published or over 500 connections) is a business decision for Kaylan, not something resolved by code.

## Calendar tab + Google Calendar (per-assistant, two-way)

- **Calendar tab** (Work section, admin + every team member): month view of build to-do deadlines (computed live from each build's Day 1 via `buildTodoDueDate`) and Task Board due dates. Nothing is stored for this — a new build or task shows up the moment it exists. Admin sees everyone (with an assistant filter) but never anyone's Google Calendar.
- **Toggles:** Builds / Tasks / Google Calendar, plus one per Google calendar. Saved on the assistant record as `calendarPrefs` (same pattern as `notifyPrefs`); admin's are per-browser (localStorage).
- **Google side** (`functions/index.js`, "Google Calendar — per-assistant"): each assistant connects their OWN Google account. Their events are read on demand (`getGoogleCalendarEvents`); their open deadlines are written to a separate **"TMC Deadlines"** calendar the app creates, kept in sync by `syncCalendarOnTaskWrite` / `syncCalendarOnClientWrite` triggers (plus a "Sync deadlines now" button). Assistants can also **add events** (title, date, all-day or start/end time, notes) to any of their Google calendars they can edit, and **delete events** — always behind an "are you sure?" confirm, one occurrence at a time for repeating events (`createGoogleCalendarEvent` / `deleteGoogleCalendarEvent`; both refuse the app-managed TMC Deadlines calendar). Scopes: `calendar.readonly` + `calendar.events` + `calendar.app.created`. Tokens in `calendarTokens/{assistantId}` (encrypted, rules-denied); OAuth CSRF states in `calendarOAuthStates`.
- **Setup still needed (Kaylan, one time) before Connect works:**
  1. Google Cloud Console (project `modern-co-dashboard`) → enable **Google Calendar API**.
  2. The OAuth client already used for Gmail (`GMAIL_CLIENT_ID`) → add Authorized redirect URI `https://us-central1-modern-co-dashboard.cloudfunctions.net/googleCalendarOAuthCallback`.
  3. OAuth consent screen → add the three calendar scopes above. If the app is "External/Testing", add each assistant's Google address as a test user (or set it to Internal if everyone is on the themodernconcierge.co Workspace).
  4. `firebase deploy --only functions,firestore:rules,hosting` from `tmc-ops/` on the machine with `functions/.env.modern-co-dashboard` (hosting = `public/calendar-connected.html`).
- Same per-role gap as everything else: the callables trust the `assistantId` the app sends (see Security → Known remaining gap).
- **Cloud Run Invoker:** after the first deploy, the 7 calendar HTTP/callable services needed `allUsers` → Cloud Run Invoker set by hand (the deploy didn't set it). The two Firestore-trigger functions (`synccalendaronclientwrite`, `synccalendarontaskwrite`) must stay private.

## Claude connector (per-assistant, own data only)

- `functions/claudeConnector.js`, exported as `claudeConnector` (an `onRequest` function). It's a remote MCP server plus the small OAuth 2.1 server Claude's custom connectors need (metadata discovery, dynamic client registration limited to claude.ai/claude.com redirect URIs, PKCE codes, 1-hour access tokens, rotating 30-day refresh tokens).
- **Scope is enforced server-side, by construction.** Every tool loads by the assistantId bound to the token: tasks assigned to them, builds where `buildAssistantId` is them (no money fields), their Goals page (Dev Director only), their deadlines. There's no tool for other people, payroll, QuickBooks, billing, contracts, codes, vendors, card purchases or settings. Writes touch only allow-listed fields. Claude can set task status to To do / Researching / In progress / Paused / Done only; "Pending approval" and "Needs Client Review" stay manual.
- **Who can connect:** admin ticks **Claude connector** in that person's Roles on the Team tab (`claudeConnectorEnabled`). They sign in once on the connector's page with their own access code (8 wrong tries per IP = 15-minute lockout; the admin passcode is never accepted). Unticking cuts access on the next request.
- **Activity:** every change is logged to `connectorLog/{assistantId}/entries`, shown under **Claude activity** on the Team tab.
- **Storage:** `connectorClients`, `connectorCodes`, `connectorTokens` (stored as sha256 hashes) and `connectorLoginAttempts` are rules-denied; `connectorLog` is read-only to the app.
- **Goals and concurrency:** settings/access is loaded once at boot, so app goal edits go through `mutateActiveGoals(fn)`, which re-reads the latest goals in a transaction before saving. That keeps connector edits from being overwritten by a stale browser. The Goals tab also refetches goals at most every 30s.
- **Setup (after deploying functions + rules):** (1) grant `allUsers` the **Cloud Run Invoker** role on the `claudeconnector` Cloud Run service; (2) tick Claude connector for the person; (3) in Claude: Settings → Connectors → Add custom connector, URL = the function's **run.app** URL + `/mcp` (from the deploy output or Cloud Run). Not the cloudfunctions.net URL, because OAuth discovery needs `/.well-known/…` at the host root. On a Team/Enterprise Claude plan, an owner may need to add it for the workspace first.

## Membership vs Software clients (Nov 2026)

- A client can be **Membership** (hour package), **Software** (software/website build = `client.addOns`), or both. `isMembershipClient` (`membershipClient!==false`) and `isSoftwareClient` (`softwareClient` if set, else "has a non-cancelled add-on"). Set per client on the Software Build tab → Client categories. No migration: unset flags fall back to those defaults.
- Clients tab has Membership / Software views; dual clients appear in both with "Also a … client →" links.
- **Who sees Software:** the admin login and the Director of Development only (`canViewSoftware()`; Kaylan's call, Nov 2026). **UI-only** — addOns live inside each client doc, which every session can read. Real enforcement = the per-role auth project (Security → Known remaining gap) plus moving addOns to their own collection with rules.
- **Build phases:** `addOn.phases` (optional) + `payment.phaseId`; a payment without a phaseId is Phase 1, so old schedules need no migration. Payments stay one flat `addOn.payments` list, so alerts/emails/payroll/revenue cover every phase. Phase 1 uses the build's `flatFee`/`buildStartDate`; later phases carry their own `fee`/`startDate`/`basisAmount` (`buildAssistantCut` is per phase).
- **Maintenance Mark paid** (`markMaintenanceFeePaid`): Dashboard alert + build card; stamps `paidDate`/`paidBy`.
- **Maintenance every 30 days:** set "First maintenance fee due" on the build (`maintenanceStartDate`) and the fee is due then and every 30 days after; rows are keyed by `dueDate` (YYYY-MM-DD). Builds with no start date keep the old calendar-month rows (`month`, due on the 1st). Cycles before `MAINT_CYCLES_TRACKED_FROM` (2026-11-01) are ignored so back-dating a start date doesn't flood the Dashboard.

## Main vs secondary assistant (Nov 2026)

- A client's `assistantIds` is ordered `[main, secondary, ...older extras]`, set with two dropdowns (client editor + Reassign on the Membership tab). The client portal shows only the main assistant; the secondary has the same internal access (tasks, "My clients") but is never shown to the client.
## Automatic Friday weekly recaps (Nov 2026)

- `functions/weeklyReports.js`, scheduled as `sendWeeklyClientReports` (every **Friday 4:00pm Central**). For each active Membership client with an email, it builds the same Sat–Fri recap as the "Copy message" button, saves it to `reports/`, and emails the cover note + link **from the client's main assistant's own Gmail** (`assistantIds[0]`, set with the Main assistant dropdown), **BCC'd** to `settings/access.weeklyReportBcc` (falls back to `adminNotifyEmail`).
- **Receipts:** photos from that week's `cardPurchases` for the client are attached to the email (plus task receipts if the client has "include receipts" on; those get cleared from the tasks after sending, same as Copy message). ~17MB cap per email; extras are mentioned in the email.
- **Still clocked in at send time = In progress** on the report (both the app's `buildClientReport` and the function — the report code is duplicated in `weeklyReports.js`, marked KEEP IN SYNC).
- **Off by default.** Admin Team tab → "Automatic Friday recaps": on/off switch, BCC, who's connected, "Send test" (team emails only, never the client), last run log (`weeklyReportRuns/{friday}`). Per-client opt-out on the client's Email Templates tab (`autoWeeklyReport:false`).
- **Skips:** inactive, internal, Software-only, no email, already sent that week (`weeklyRecapSentForWeek`, also set by a manual "Copy message"), and weeks with no time, completed tasks or card purchases.
- **Assistant Gmail:** each assistant clicks **Connect my Gmail** on their Team tab (send-only scope `gmail.send`). Tokens in `reportGmailTokens/{assistantId}` (encrypted, rules-denied). It reuses the Calendar OAuth client and the `googleCalendarOAuthCallback` redirect URI (state doc has `purpose:"reportGmail"`), so there's no new redirect URI to register. Not connected → sent from support@ with Reply-To the assistant.
- **Setup still needed (Kaylan, one time):**
  1. Google Cloud Console (`modern-co-dashboard`) → OAuth consent screen → add scope `https://www.googleapis.com/auth/gmail.send` if it isn't already listed (support@ uses it). If the app is External/Testing, every assistant's Google address must be a test user, or set it to Internal.
  2. `firebase deploy --only functions,firestore:rules,hosting` from `tmc-ops/` (hosting = updated `public/gmail-connected.html`). The first deploy of a scheduled function enables Cloud Scheduler; accept if prompted.
  3. Cloud Run → grant `allUsers` the **Cloud Run Invoker** role on `getreportgmailauthconfig`, `getreportgmailstatus`, `disconnectreportgmail`, `sendweeklyreporttest` (same as the calendar callables). `sendweeklyclientreports` stays private.
  4. In the app: set the BCC, have each assistant connect, set each client's Main assistant (Membership tab → Reassign), send yourself a test, then tick **Auto-send weekly recaps**.

## Working Conventions

- This is a single-file app — keep it that way unless explicitly asked to split it up.
- Test changes by opening `index.html` directly in a real desktop browser (not an in-app preview pane, which may sandbox scripts) after each edit.
- Commit after each working change (`git add -A && git commit -m "..."`) so there's always a rollback point.
- Firebase writes (`upsert`/`remove`) fail silently with a console warning if Firebase isn't connected — check the browser console if changes don't seem to save.

## Design Preview Mode (`?preview`)

- Open `index.html?preview` (locally: `file:///C:/Users/suppo/tmc-ops/index.html?preview`) to see the whole app on **fake data** with no login. Firebase is never initialized in this mode, so no real client, payroll, or QuickBooks data loads, and nothing saves — edits live in memory until the page reloads.
- A floating bar at the bottom switches between Admin, Assistant, New hire (shows the onboarding gate screens), Client, Vendor, and the Login screen.
- Fake data comes from `seedPreviewData()` (built on `seedDemoData()`). If a new feature/tab looks empty in preview, add fake records for it there — never copy real data in.
- Server-only features (QuickBooks/Gmail connect, file uploads to Firebase, direct deposit) don't work in preview; report "View" falls back to downloading the HTML.

## Working With Hannah (design edits)

Hannah makes changes from this same terminal. She'll identify herself at the start of a session ("This is Hannah"); Kaylan (the owner) will say "This is Kaylan". If nobody says, ask who you're working with before doing anything.

When working with Hannah:

- She can make, commit, and push changes on her own — no approval from Kaylan needed.
- She must NOT see real data, especially financials. Check every change in preview mode (`index.html?preview`) — never log into the admin side, never read the live Firestore database, and never pull real client/payroll/QuickBooks data for her in any other way.
- If she asks for something that needs real data (e.g. "why does client X show these hours"), tell her that's one for Kaylan.
- This is a working agreement, not a lock — she's using Kaylan's own computer and GitHub login, so it can't be technically enforced from here.

When working with Kaylan: no restrictions beyond the rest of this file.
