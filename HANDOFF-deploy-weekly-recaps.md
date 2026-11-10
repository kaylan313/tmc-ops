# Handoff: Deploy the automatic weekly recaps (functions)

**From:** Kaylan, working with Claude on the support@ computer, 2026-11-10
**For:** Kaylan (or Claude) on the computer that has `functions/.env.modern-co-dashboard`
**Background:** `HANDOFF-auto-weekly-recaps.md` (Hannah's original handoff) and the "Automatic Friday weekly recaps" section of `CLAUDE.md`

---

## Where things stand

| Piece | Status |
|---|---|
| Code: Friday 4pm recap, CC/BCC, sign-off | **Merged to main.** PR #30 (recaps + CC Kaylan/Tori + BCC support@) and PR #31 (signed with the assistant's first name). main is at `490ff9f`. |
| App (Netlify) | **Live.** It deployed automatically when the PRs were merged. |
| Firestore rules + hosting | **Deployed 2026-11-10** from the support@ computer. |
| **Cloud Functions** | **NOT deployed.** It must be done from the computer with `functions/.env.modern-co-dashboard`. The support@ computer doesn't have that file. |
| Cloud Run public access | Not done. It can only be done after the functions are deployed. |
| In-app setup | Not done. |
| Auto-send | **Off.** No emails go to clients until admin ticks "Auto-send weekly recaps". |

Until the functions are deployed, the admin "Automatic Friday recaps" card says "not deployed yet" and **Connect my Gmail** doesn't work.

---

## 1. Deploy the functions (this computer)

In PowerShell, from this computer's `tmc-ops` folder:

```
git pull
git log --oneline -1
Test-Path functions\.env.modern-co-dashboard
```

- `git log` must show `490ff9f Merge pull request #31` or newer.
- `Test-Path` must print **True**. If it prints False, stop. **Never** make up or retype the values in that file. A wrong `QB_TOKEN_ENCRYPTION_KEY` makes every saved QuickBooks, Gmail and Calendar connection unreadable.

Then run:

```
firebase login --reauth
firebase use modern-co-dashboard
cd functions
npm install
cd ..
firebase deploy --only functions
```

- `firebase login` only works in a terminal you type into yourself. If Claude runs it, it fails with "non-interactive mode".
- Asked to enable **Cloud Scheduler**? Answer **Y**. It runs the Friday 4pm send.
- Asked to **delete** functions? Answer **N**.
- Asked to **type a value** like `GMAIL_CLIENT_ID`? Press **Ctrl+C**. That means the `.env` file isn't being read.
- A successful run ends with **"Deploy complete!"**

New functions in this deploy: `sendWeeklyClientReports` (scheduled), `getReportGmailAuthConfig`, `getReportGmailStatus`, `disconnectReportGmail` and `sendWeeklyReportTest`. Every existing function is redeployed too.

## 2. Make the new callables reachable (Cloud Run)

Go to https://console.cloud.google.com/run (project **modern-co-dashboard**). For each service below, open it, go to the **Security** tab, choose **Allow public access**, and click **Save**:

- `getreportgmailauthconfig`
- `getreportgmailstatus`
- `disconnectreportgmail`
- `sendweeklyreporttest`

**Leave `sendweeklyclientreports` private.**

Don't try to add an `allUsers` member. The org's Domain Restricted Sharing policy blocks it. "Allow public access" is how the Calendar functions were opened up.

**Then check that Calendar still connects in the app.** A functions deploy can lock the Calendar services again. If it broke, turn Allow public access back on for those services the same way. A healthy callable answers a bare POST with **401 "Sign in first"**, not 403.

## 3. Check the OAuth consent screen

In the Cloud Console, go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Data Access**). `https://www.googleapis.com/auth/gmail.send` must be listed under Scopes.

If the app's Audience is External/Testing, every assistant's Google address must be a test user. If it's Internal, there's nothing to add.

## 4. Set it up in the app (admin login)

1. **Heidi:** Membership tab → **Reassign** → set each client's **Main assistant**. The recap comes from the main assistant. The secondary assistant is never copied.
2. **Each assistant:** their own Team tab → **Connect my Gmail**, using their work Google account.
3. **Admin Team tab → Automatic Friday recaps:**
   1. **CC:** type Kaylan's email, and tick **Victoria (Tori)** under team members.
   2. **BCC:** leave it as support@themodernconcierge.co.
   3. **Send test** to yourself for a few clients. Check the sender, the CC, the attached receipts, the In progress items, and the "*First name* / The Modern Concierge" sign-off. Test emails go to that one address only.
   4. Switch off automatic recaps for any client who shouldn't get them (their Email Templates tab → Weekly Recap).
   5. Tick **Auto-send weekly recaps**.
4. Tell the team that tasks and time must be in by **Friday 4pm Central**.

## After the first Friday

The admin card's **Last run** shows each client as sent, skipped (with the reason) or failed, plus who was CC'd and BCC'd. A failed row's message usually means the assistant's Gmail connection or support@'s Gmail connection needs reconnecting.

## Reminders for Claude on this computer

- Follow `CLAUDE.md`. Ask who you're working with before doing anything. Hannah must not see real data. Kaylan has no extra restrictions.
- Never print, copy or commit the contents of `functions/.env.modern-co-dashboard`.
- Claude's own `gh pr merge` gets blocked. Give the user `! gh pr merge <n> --merge --repo kaylan313/tmc-ops`.
