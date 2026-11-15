# Handoff: Automatic Friday weekly recap emails

**Requested by:** Hannah (Director of Software & Design Builds), from Heidi's idea
**Owner / deploys:** Kaylan
**Branch:** `hannah-auto-weekly-recaps` (based on `main` as of 2026-11-10, commit `d31e03f`)
**Status:** Mostly built and tested with mocked data. Never deployed. Paused until Kaylan picks it up.

---

## What Heidi and Hannah want

Every **Friday at 4:00pm Central**, each active Membership client automatically gets their weekly recap email. The assistants no longer have to remember to send it.

| | |
|---|---|
| **From** | The client's **primary (Main) assistant's** own email |
| **To** | The client |
| **CC** | **Kaylan** and **Tori** |
| **BCC** | **support@** (support@themodernconcierge.co) |
| **Attachments** | Receipt photos from purchases the assistant made on the client's card that week |
| **Report content** | Same Sat–Fri recap as the existing "Copy message" button. Tasks still clocked in at 4pm show under **In progress**. Unfinished work carries into next week's report. |

- **The secondary assistant is internal only.** They are never CC'd, and the client never sees them anywhere.
- **Heidi will set the primary assistant on every client** using the Main assistant dropdown, which is already live (see below).
- **The assistants just need their tasks and time in by 4pm Friday.** Tasks don't have to be finished.

---

## What already exists

**On `main` (live):**
- **Main / Secondary assistant dropdowns** (commit `72eae05`). These are in the client editor and in Membership tab → Reassign.
  - `client.assistantIds` is ordered `[main, secondary, ...older extras]`.
  - The client portal shows only the main assistant.
- **Vendor request receipts** can now be uploaded by the team (`d31e03f`). This is unrelated to the recaps, but it's live.

**On `hannah-auto-weekly-recaps` (not deployed), commit `1025b7e`.** Read the "Automatic Friday weekly recaps" section of CLAUDE.md on this branch first.
- **`functions/weeklyReports.js`** holds the server-side report builder. It's a port of `buildClientReport` / `clientReportHtml` / `clientReportCoverNote` from `index.html`, marked **KEEP IN SYNC**. It also has the sender, the skip rules and the run log.
- **In `functions/index.js`:**
  - `sendWeeklyClientReports` is the scheduled function: `onSchedule`, `"0 16 * * 5"`, `America/Chicago`.
  - `getReportGmailAuthConfig`, `getReportGmailStatus` and `disconnectReportGmail` are callables. Each assistant connects their own **send-only Gmail** (`gmail.send`) from their Team tab.
  - The Gmail connection reuses the Calendar OAuth client and the `googleCalendarOAuthCallback` redirect URI, branching on `purpose:"reportGmail"` in the state doc. So there's no new redirect URI. Tokens are encrypted in `reportGmailTokens/{assistantId}`.
  - `sendWeeklyReportTest` is a callable that lets admin send a test copy to a team email only.
- **Fallback:** if an assistant hasn't connected their Gmail, the email is sent from support@ with Reply-To set to the assistant.
- **Receipts:** that week's `cardPurchases` receipt photos are attached as real MIME attachments, sent through Gmail's media upload, capped at about 17MB. Task receipts are also included when the client has "include receipts" on, and are cleared from the tasks after sending, the same as Copy message.
- **Skip rules:** inactive clients, the internal client, Software-only clients, no email, opted-out clients (`autoWeeklyReport:false`), clients already sent that week (`weeklyRecapSentForWeek`, which a manual "Copy message" also sets), and weeks with no time, no completed tasks and no purchases.
- **Run log:** `weeklyReportRuns/{fridayYMD}`, shown on the admin Team tab.
- **Off by default.** Admin Team tab → "Automatic Friday recaps" card has an on/off switch, a BCC field, who's connected, Send test, and the last run.
- **Client page:** each client's Email Templates tab → Weekly Recap shows the status and the per-client switch.
- **In-app report:** `buildClientReport` now puts still-clocked-in tasks under In progress, to match the server.
- **Rules:** `firestore.rules` denies all access to `reportGmailTokens` and makes `weeklyReportRuns` read-only.

**How it was tested:**
- The whole Friday run was tested on Node with fake clients and mocked Firestore and Gmail. It checked:
  - the right sender, and the support@ fallback with Reply-To
  - the BCC
  - the receipt attached with a readable filename
  - the clocked-in task showing under In progress
  - each skip reason
  - a second run sending nothing
- The app screens were checked in `?preview`.
- **Not tested:** real Gmail OAuth and the real scheduler. Those only exist after deploying.

---

## What still needs building (the CC/BCC change)

The branch currently BCCs **one** address (`settings/access.weeklyReportBcc`, falling back to `adminNotifyEmail`). Change it to Heidi's spec:

1. **Settings:** replace `weeklyReportBcc` with:
   - `weeklyReportCc`: a list of emails, for Kaylan and Tori.
   - `weeklyReportBccSupport`: a single email, defaulting to support@themodernconcierge.co.

   Ideally let admin pick Tori from the assistants list, so her email stays current.
2. **`functions/weeklyReports.js`:**
   - `buildMimeMessage`: add a `Cc:` header (comma-joined, run through `oneLine` on each address). Keep `Bcc:` for support@.
   - `sendOne`: pass cc and bcc for real sends. Test sends must stay **To only, no CC/BCC**.
   - Rename `bccFor`, and record cc/bcc in the run log.
3. **Avoid a duplicate when falling back to support@:** if an assistant isn't connected, the email already comes *from* support@. Drop support@ from the BCC in that case, since Gmail already keeps a copy in Sent.
4. **`sendWeeklyReportTest` allow-list** (in `functions/index.js`): include the CC addresses.
5. **Admin card** (`renderWeeklyRecapAdminCard` in `index.html`): CC field(s) plus the support@ BCC field. Update the help text from "BCC'd to the address below".
6. **Sign-off:** optionally sign the cover note with the main assistant's first name instead of "The Modern Concierge Team", since it comes from them. Hannah offered this but hasn't decided, so ask her.
7. **CLAUDE.md:** update the recap section to say CC Kaylan + Tori, BCC support@.

---

## Deploying (Kaylan, one time)

1. **Google Cloud Console** (`modern-co-dashboard`) → OAuth consent screen: make sure `https://www.googleapis.com/auth/gmail.send` is listed. support@ may already use it. If the app is External/Testing, add every assistant's Google address as a test user, or set the app to Internal.
2. **Deploy:** `firebase deploy --only functions,firestore:rules,hosting` from `tmc-ops/`, on the machine with `functions/.env.modern-co-dashboard`. The first deploy of a scheduled function enables Cloud Scheduler, so accept if prompted.
3. **Cloud Run Invoker:** grant `allUsers` the **Cloud Run Invoker** role on `getreportgmailauthconfig`, `getreportgmailstatus`, `disconnectreportgmail` and `sendweeklyreporttest`, the same as for the calendar callables. `sendweeklyclientreports` stays private.
4. **In the app:**
   1. Heidi sets each client's **Main assistant** (Membership tab → Reassign).
   2. Each assistant clicks **Connect my Gmail** on their Team tab.
   3. Set CC (Kaylan, Tori) and BCC (support@).
   4. **Send test** to yourself for a few clients.
   5. Then tick **Auto-send weekly recaps**.

## Before turning it on, check

- [ ] Every active Membership client has the right Main assistant and an email on file.
- [ ] The test emails look right: sender, CC, attachments, and In progress items.
- [ ] Clients who shouldn't get automatic recaps are switched off on their Email Templates tab.
- [ ] Tell the team the Friday 4pm deadline for getting tasks and time in.
