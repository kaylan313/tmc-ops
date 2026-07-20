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
3. Set Firestore security rules — the app currently assumes permissive rules for the passcode-gated collections during development. Tightening this is a good first task.
4. Client portal codes (`portalCode` field per client) need to be set per client via the Membership tab before clients can log in.
5. Renewal dates were not available from ClickUp historically and require manual entry per client — preserve these if migrating old data in.

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

## Working Conventions

- This is a single-file app — keep it that way unless explicitly asked to split it up.
- Test changes by opening `index.html` directly in a real desktop browser (not an in-app preview pane, which may sandbox scripts) after each edit.
- Commit after each working change (`git add -A && git commit -m "..."`) so there's always a rollback point.
- Firebase writes (`upsert`/`remove`) fail silently with a console warning if Firebase isn't connected — check the browser console if changes don't seem to save.
