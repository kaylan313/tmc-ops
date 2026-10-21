/**
 * Auto-files signed client contracts and employee agreements into Google
 * Drive, so nobody has to manually download + re-upload them.
 *
 * How it fires:
 *  - fileClientContractToDrive: watches clients/{clientId}. The moment
 *    contractHtml goes from empty to populated (a client just signed via
 *    saveClientAgreement in the app), it finds-or-creates a folder named
 *    after the client inside CLIENTS_FOLDER_ID, uploads the signed
 *    agreement as a Google Doc, then clears contractHtml/
 *    contractSignatureDataUrl from Firestore and stores the Drive link —
 *    the same cleanup the manual "Downloaded — remove from app" button
 *    does, just automatic.
 *  - fileEmployeeAgreementToDrive: watches settings/access (a single doc
 *    holding the whole assistants array). Diffs before/after to find any
 *    assistant whose agreementHtml just got set, then does the same
 *    find-or-create-folder + upload + clear dance under
 *    EMPLOYEES_FOLDER_ID.
 *
 * Both functions only clear the Firestore copy AFTER a successful Drive
 * upload — if Drive isn't reachable (folder not shared yet, API not
 * enabled, etc.) the error is logged and the signed doc stays in Firestore
 * untouched, so the manual download/delete buttons in the app remain a
 * working fallback.
 *
 * Auth: uses Application Default Credentials — the Cloud Function's own
 * runtime service account — so no key file is ever committed anywhere.
 * That service account's email needs Editor access on both Drive folders
 * (see README notes in the project root for the exact setup steps).
 */
const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const crypto = require("crypto");

admin.initializeApp();

const CLIENTS_FOLDER_ID = defineString("CLIENTS_FOLDER_ID");
const EMPLOYEES_FOLDER_ID = defineString("EMPLOYEES_FOLDER_ID");
// Empty-string defaults so a deploy succeeds before real credentials
// exist (Firebase would otherwise prompt interactively for a missing
// param with no default, which blocks a non-interactive deploy). The
// functions themselves will simply fail against Intuit's API with these
// placeholders — that's fine, since nobody can click "Connect QuickBooks"
// successfully until real values are set anyway. See CLAUDE.md for setup.
const QB_CLIENT_ID = defineString("QB_CLIENT_ID", { default: "" });
const QB_CLIENT_SECRET = defineString("QB_CLIENT_SECRET", { default: "" });
// Points at the quickBooksOAuthCallback Cloud Function below (a real
// server-side redirect endpoint), not a static Hosting page — see that
// function's doc comment for why this matters for Intuit's security
// review ("sensitive info in URL params" requirement).
const QB_REDIRECT_URI = defineString("QB_REDIRECT_URI", { default: "https://us-central1-modern-co-dashboard.cloudfunctions.net/quickBooksOAuthCallback" });
const QB_ENVIRONMENT = defineString("QB_ENVIRONMENT", { default: "sandbox" }); // "sandbox" or "production"
// Base64-encoded 256-bit key, generated once with
// `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
// and stored only in functions/.env.modern-co-dashboard (gitignored) — per
// Intuit's OAuth token management requirement: refresh tokens (and, here,
// access tokens too) must be encrypted at rest with the key kept in a
// separate configuration file, not alongside the encrypted data itself.
const QB_TOKEN_ENCRYPTION_KEY = defineString("QB_TOKEN_ENCRYPTION_KEY", { default: "" });

// Gmail OAuth (separate Google OAuth client from the Drive integration
// above, which uses the Cloud Function's own service account via
// Application Default Credentials and can't send mail "as" a real mailbox).
// Same encryption key/pattern as the QuickBooks tokens above — reused for
// consistency, not because Google requires it the way Intuit's security
// review does.
const GMAIL_CLIENT_ID = defineString("GMAIL_CLIENT_ID", { default: "" });
const GMAIL_CLIENT_SECRET = defineString("GMAIL_CLIENT_SECRET", { default: "" });
const GMAIL_REDIRECT_URI = defineString("GMAIL_REDIRECT_URI", { default: "https://us-central1-modern-co-dashboard.cloudfunctions.net/gmailOAuthCallback" });

async function getDrive() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const client = await auth.getClient();
  return google.drive({ version: "v3", auth: client });
}

// Escaping single quotes is the only sanitization Drive's query language
// needs for a plain equality match on `name`.
function escapeForDriveQuery(name) {
  return String(name || "").replace(/'/g, "\\'");
}

async function findOrCreateFolder(drive, parentId, name) {
  const safeName = escapeForDriveQuery(name);
  const q = `'${parentId}' in parents and name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const existing = await drive.files.list({ q, fields: "files(id,name)", spaces: "drive" });
  if (existing.data.files && existing.data.files.length) {
    return existing.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  return created.data.id;
}

// Uploading HTML with a target mimeType of application/vnd.google-apps.document
// tells Drive to convert it into a native, readable Google Doc instead of
// just storing the raw .html file.
async function uploadHtmlAsDoc(drive, folderId, title, html) {
  const res = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.document", parents: [folderId] },
    media: { mimeType: "text/html", body: html },
    fields: "id, webViewLink",
  });
  return res.data;
}

exports.fileClientContractToDrive = onDocumentUpdated("clients/{clientId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  if (!after.contractHtml || after.contractHtml === before.contractHtml) return;

  let driveLink = null;
  try {
    const drive = await getDrive();
    const folderId = await findOrCreateFolder(drive, CLIENTS_FOLDER_ID.value(), after.name || "Unnamed client");
    const dateStr = after.contractSignedDate || new Date().toISOString().slice(0, 10);
    const file = await uploadHtmlAsDoc(
      drive,
      folderId,
      `${after.name || "Client"} — Signed Service Agreement — ${dateStr}`,
      after.contractHtml
    );
    await event.data.after.ref.update({
      contractHtml: admin.firestore.FieldValue.delete(),
      contractSignatureDataUrl: admin.firestore.FieldValue.delete(),
      driveContractUrl: file.webViewLink,
    });
    driveLink = file.webViewLink;
    console.log(`Filed contract for ${after.name} to Drive: ${file.webViewLink}`);
  } catch (err) {
    console.error(`Drive upload failed for client ${event.params.clientId} (${after.name}):`, err);
  }

  // Heidi needs to know a signature just happened so she can download it
  // and charge the client — a separate manual step from the Drive filing
  // above, so this fires regardless of whether that succeeded. Uses
  // sendEmailViaGmail, defined further down in this file alongside the rest
  // of the Gmail notification setup — function declarations are hoisted,
  // so the earlier position of this trigger doesn't matter.
  const sent = await sendEmailViaGmail(
    "heidi@themodernconcierge.co",
    `${after.name || "A client"} signed their Service Agreement`,
    `${after.name || "A client"} just signed their Service Agreement in TMC Ops.\n\n` +
      (driveLink
        ? `Signed copy: ${driveLink}`
        : `It didn't get auto-filed to Drive this time — open their profile in TMC Ops to download it directly.`) +
      `\n\nDon't forget to charge them.`
  );
  console.log(`fileClientContractToDrive: signature notification for ${after.name} -> heidi@themodernconcierge.co -> ${sent ? "sent" : "not sent"}`);
});

exports.fileEmployeeAgreementToDrive = onDocumentUpdated("settings/access", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const beforeById = new Map((before.assistants || []).map((a) => [a.id, a]));
  const toFile = (after.assistants || []).filter((a) => {
    const prev = beforeById.get(a.id);
    return a.agreementHtml && (!prev || prev.agreementHtml !== a.agreementHtml);
  });
  if (!toFile.length) return;

  try {
    const drive = await getDrive();
    const updatedAssistants = await Promise.all(
      (after.assistants || []).map(async (a) => {
        const match = toFile.find((x) => x.id === a.id);
        if (!match) return a;
        const folderId = await findOrCreateFolder(drive, EMPLOYEES_FOLDER_ID.value(), a.name || "Unnamed employee");
        const dateStr = a.agreementSignedAt ? a.agreementSignedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
        const file = await uploadHtmlAsDoc(
          drive,
          folderId,
          `${a.name || "Employee"} — Signed Agreement — ${dateStr}`,
          a.agreementHtml
        );
        console.log(`Filed agreement for ${a.name} to Drive: ${file.webViewLink}`);
        return { ...a, agreementHtml: null, driveAgreementUrl: file.webViewLink };
      })
    );
    await event.data.after.ref.update({ assistants: updatedAssistants });
  } catch (err) {
    console.error("Drive upload failed for employee agreements:", err);
  }
});

/**
 * Server-side login. The app used to compare passcodes against data it had
 * already loaded client-side — which only works safely if Firestore itself
 * blocks outside reads, and it didn't (see the Sept 2026 security fix).
 * This function is the ONLY place a passcode/access code/portal code is
 * ever checked now: it runs with admin.firestore(), which bypasses
 * Firestore Rules entirely, so it can look up the real data without the
 * caller needing any read access first.
 *
 * On a match, it mints a custom auth token carrying exactly the claims
 * Firestore Rules need to scope that session: role, plus clientId or
 * assistantId. The app signs in with that token (signInWithCustomToken) —
 * same passcode UX as always, just validated in a place a browser console
 * can't reach.
 *
 * uid choices: "admin" is a fixed shared identity (matches the app's
 * existing single-shared-passcode model for that role). Team/client use
 * the real assistant/client document ID as the uid, so
 * request.auth.uid == the record's own ID lines up directly in rules.
 *
 * STATUS — reachable, not yet wired up. Confirmed working via direct curl
 * (Sept 2026) after manually setting "Allow public access" in the Cloud Run
 * console for this specific service. A separate, concurrent work session
 * on this repo hit a hard org-policy block trying to do the same for a
 * *different* function (viewReport, an onRequest endpoint) and also for a
 * Firebase Hosting rewrite proxy — see public/report.html and the
 * CLAUDE.md note. Those aren't necessarily the same restriction: this is a
 * callable (onCall) function invoked directly, not proxied through
 * Hosting, so it may simply not hit whatever the Hosting-rewrite policy
 * blocks. Re-curl before relying on this if it's been a while — Google's
 * org-policy enforcement can revoke a public IAM binding after the fact.
 */
exports.validateLogin = onCall(async (request) => {
  const { kind, code } = request.data || {};
  if (!kind || !code || typeof code !== "string") {
    throw new HttpsError("invalid-argument", "Missing login kind or code.");
  }
  const db = admin.firestore();

  if (kind === "admin") {
    const settingsSnap = await db.collection("settings").doc("access").get();
    const settings = settingsSnap.data() || {};
    if (code !== settings.adminPasscode) {
      throw new HttpsError("permission-denied", "Incorrect passcode.");
    }
    const token = await admin.auth().createCustomToken("admin", { role: "admin" });
    return { token };
  }

  if (kind === "team") {
    const settingsSnap = await db.collection("settings").doc("access").get();
    const settings = settingsSnap.data() || {};
    const match = (settings.assistants || []).find(
      (a) => a.active !== false && a.accessCode && a.accessCode === code
    );
    if (!match) {
      throw new HttpsError("permission-denied", "Access code not recognized.");
    }
    const token = await admin.auth().createCustomToken(match.id, {
      role: "team",
      assistantId: match.id,
      isContentCreator: !!match.isContentCreator,
    });
    return { token, assistantId: match.id };
  }

  if (kind === "client") {
    const clientsSnap = await db.collection("clients").where("portalCode", "==", code).limit(1).get();
    if (clientsSnap.empty) {
      throw new HttpsError("permission-denied", "Client code not recognized.");
    }
    const clientDoc = clientsSnap.docs[0];
    const token = await admin.auth().createCustomToken(clientDoc.id, {
      role: "client",
      clientId: clientDoc.id,
    });
    return { token, clientId: clientDoc.id };
  }

  throw new HttpsError("invalid-argument", "Unknown login kind: " + kind);
});

// Report viewing (reports/{id} -> a shareable link) is handled by
// public/report.html via the client-side Firestore SDK instead of a Cloud
// Function — this project's GCP org policy blocks granting a Cloud Run
// service (what a 2nd-gen Cloud Function runs as) invoker access to
// anything, including Firebase Hosting's own rewrite proxy, so a function
// endpoint can't be made reachable here at all. See the comment in
// public/report.html for the full explanation. validateLogin above (a
// callable, not proxied through Hosting) is unaffected by this specific
// restriction — see its own doc comment for why.

/**
 * QuickBooks Online integration — read-only. Pulls the actual
 * Profit & Loss (income, COGS/gross profit, expenses, payroll) into the
 * Scorecard tab, in place of the estimate computed from package prices.
 *
 * Three pieces:
 *  - exchangeQuickBooksCode: called once, right after the admin approves
 *    access on Intuit's site and gets redirected back to
 *    public/qb-callback.html with a one-time `code`. Exchanges it for an
 *    access/refresh token pair and stores them in qbTokens/main via the
 *    Admin SDK (bypasses Firestore Rules — this is the ONLY code path
 *    that ever touches that collection; see firestore.rules for why it's
 *    otherwise unreachable from any client).
 *  - refreshQuickBooksTokenIfNeeded: internal helper, not exported. QBO
 *    access tokens expire hourly; refresh tokens ROTATE on every use (the
 *    old one stops working the moment a new one is issued), so the
 *    refreshed pair is always re-saved in full, never just the access
 *    token half.
 *  - getQuickBooksSummary: called by the Scorecard tab on load. Returns
 *    {connected:false} if nothing's been connected yet, or the actual
 *    P&L totals for the requested date range, pulled via the Reports
 *    API's ProfitAndLoss endpoint (Accrual basis, matching what Heidi's
 *    own printed P&L uses) and walked with qbReportFind below — see that
 *    function's doc comment for why the row tree needs walking rather
 *    than reading a few fixed keys.
 */
function qbApiBase() {
  return QB_ENVIRONMENT.value() === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}
// AES-256-GCM (authenticated encryption — tampering is detectable, not
// just confidentiality) for tokens at rest, per Intuit's OAuth token
// management requirement. The key never lives in this file or in
// Firestore; it's a separate, gitignored config value (see
// QB_TOKEN_ENCRYPTION_KEY above). Each value gets its own random IV, so
// encrypting the same token twice never produces the same ciphertext.
function encryptSecret(plaintext) {
  const key = Buffer.from(QB_TOKEN_ENCRYPTION_KEY.value(), "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}
function decryptSecret(encoded) {
  const key = Buffer.from(QB_TOKEN_ENCRYPTION_KEY.value(), "base64");
  const data = Buffer.from(encoded, "base64");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
// Intuit's OAuth 2.0 discovery document — fetched once per warm function
// instance and cached in memory, rather than hardcoding the token endpoint
// URL. Per Intuit's own guidance: if they ever change an endpoint, an app
// using the discovery document keeps working automatically; a hardcoded
// URL would just start failing.
let _qbDiscoveryCache = null;
async function qbDiscoveryDocument() {
  if (_qbDiscoveryCache) return _qbDiscoveryCache;
  const url = QB_ENVIRONMENT.value() === "production"
    ? "https://developer.api.intuit.com/.well-known/openid_configuration"
    : "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration";
  const res = await fetch(url);
  if (!res.ok) {
    // Fall back to the known-correct hardcoded endpoint rather than
    // failing outright — the discovery doc being briefly unreachable
    // shouldn't take the whole integration down with it.
    console.warn(`QuickBooks discovery document fetch failed (${res.status}) — falling back to hardcoded token endpoint.`);
    return { token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer" };
  }
  _qbDiscoveryCache = await res.json();
  return _qbDiscoveryCache;
}
// True specifically for OAuth-level failures (expired/revoked refresh
// token, invalid grant) as opposed to a transient network/server blip.
// This distinction matters: an auth failure means the stored token is
// permanently dead and the user needs to reconnect; a transient failure
// means it's worth just retrying the same request once.
function isQuickBooksAuthError(err) {
  return err && err.qbAuthError === true;
}
async function qbTokenRequest(params) {
  const { token_endpoint } = await qbDiscoveryDocument();
  const basicAuth = Buffer.from(`${QB_CLIENT_ID.value()}:${QB_CLIENT_SECRET.value()}`).toString("base64");
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    // intuit_tid identifies this exact request in Intuit's own systems —
    // capturing it is what lets their support team actually look up what
    // happened, rather than us describing an error with no way to trace it.
    const intuitTid = res.headers.get("intuit_tid");
    const err = new Error(`QuickBooks token request failed: ${res.status} intuit_tid=${intuitTid} ${JSON.stringify(data)}`);
    // 400/401 with an OAuth error body means the grant itself is bad
    // (expired/revoked refresh token, invalid_grant, etc.) — not a
    // network issue a retry would fix.
    if ((res.status === 400 || res.status === 401) && data && data.error) {
      err.qbAuthError = true;
    }
    throw err;
  }
  return data;
}
async function storeQuickBooksTokens(realmId, tokenData) {
  const now = Date.now();
  await admin.firestore().collection("qbTokens").doc("main").set({
    realmId,
    accessToken: encryptSecret(tokenData.access_token),
    refreshToken: encryptSecret(tokenData.refresh_token),
    accessTokenExpiresAt: now + tokenData.expires_in * 1000,
    refreshTokenExpiresAt: now + tokenData.x_refresh_token_expires_in * 1000,
    connectedAt: new Date().toISOString(),
  });
}
// 5-minute safety margin before the real expiry, so a token that's about
// to expire mid-request gets refreshed proactively instead of failing.
// Returns tokens already DECRYPTED and ready to use — callers never touch
// the encrypted form directly.
//
// If the refresh itself fails with an auth error (expired/revoked refresh
// token — QBO refresh tokens are good for ~100 days, so this happens
// eventually if nobody's opened the Scorecard in a while), the stored
// token is deleted outright rather than left sitting there failing
// forever. The Scorecard tab reads {connected:false} from that and shows
// "Connect QuickBooks" again — the correct behavior when reconnection is
// genuinely required, versus a transient error where retrying makes sense.
async function refreshQuickBooksTokenIfNeeded(tokenDoc) {
  const data = tokenDoc.data();
  if (data.accessTokenExpiresAt > Date.now() + 5 * 60 * 1000) {
    return { ...data, accessToken: decryptSecret(data.accessToken), refreshToken: decryptSecret(data.refreshToken) };
  }
  let tokenData;
  try {
    tokenData = await qbTokenRequest({
      grant_type: "refresh_token",
      refresh_token: decryptSecret(data.refreshToken),
    });
  } catch (err) {
    if (isQuickBooksAuthError(err)) {
      console.warn("QuickBooks refresh token is no longer valid — clearing stored connection so the app prompts to reconnect.");
      await tokenDoc.ref.delete();
    }
    throw err;
  }
  const now = Date.now();
  const updated = {
    ...data,
    accessToken: encryptSecret(tokenData.access_token),
    refreshToken: encryptSecret(tokenData.refresh_token),
    accessTokenExpiresAt: now + tokenData.expires_in * 1000,
    refreshTokenExpiresAt: now + tokenData.x_refresh_token_expires_in * 1000,
  };
  await tokenDoc.ref.set(updated);
  return { ...updated, accessToken: tokenData.access_token, refreshToken: tokenData.refresh_token };
}
// One automatic retry for a transient failure (network blip, momentary 5xx
// from Intuit) — never retries an auth error, since retrying the exact
// same bad grant just fails the same way again instantly.
async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isQuickBooksAuthError(err)) throw err;
    console.warn("QuickBooks request failed, retrying once:", err.message);
    return await fn();
  }
}
async function qbReport(accessToken, realmId, reportName, params) {
  const qs = new URLSearchParams({ minorversion: "65", ...params }).toString();
  const url = `${qbApiBase()}/v3/company/${realmId}/reports/${reportName}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const data = await res.json();
  if (!res.ok) {
    const intuitTid = res.headers.get("intuit_tid");
    const err = new Error(`QuickBooks report request failed: ${res.status} intuit_tid=${intuitTid} ${JSON.stringify(data)}`);
    if (res.status === 401) err.qbAuthError = true;
    throw err;
  }
  return data;
}
// Finds an account/category by label anywhere in a report's Row tree and
// returns its total — whether QuickBooks represents it as a Section (has
// its own Summary line, e.g. when it currently has active sub-accounts)
// or as a plain Data leaf (a flat line with no sub-accounts). Which shape
// a given account comes back as can change from one report to the next
// as sub-accounts gain/lose activity in the requested date range — e.g.
// "Payroll expenses" had a nested "Wages" sub-account as of Sept 16, 2026
// (came back as a Section) but not as of Sept 23 (came back as a flat
// Data row) — so both shapes must be checked, not just one.
function qbReportFind(rows, label) {
  const target = label.trim().toLowerCase();
  for (const row of rows || []) {
    if (row.type === "Data" && row.ColData && row.ColData[0]) {
      const rowLabel = (row.ColData[0].value || "").trim().toLowerCase();
      if (rowLabel === target) {
        const amountCol = row.ColData[row.ColData.length - 1];
        return amountCol ? parseFloat(amountCol.value) || 0 : 0;
      }
    } else if (row.type === "Section") {
      const headerLabel = row.Header && row.Header.ColData && row.Header.ColData[0] && row.Header.ColData[0].value;
      if (headerLabel && headerLabel.trim().toLowerCase() === target && row.Summary && row.Summary.ColData) {
        const amountCol = row.Summary.ColData[row.Summary.ColData.length - 1];
        return amountCol ? parseFloat(amountCol.value) || 0 : 0;
      }
      const nested = row.Rows && row.Rows.Row;
      const found = qbReportFind(nested, label);
      if (found !== null) return found;
    }
  }
  return null;
}
exports.getQuickBooksSummary = onCall(async (request) => {
  const { startDate, endDate } = request.data || {};
  if (!startDate || !endDate) {
    throw new HttpsError("invalid-argument", "Missing startDate or endDate (YYYY-MM-DD).");
  }
  const tokenRef = admin.firestore().collection("qbTokens").doc("main");
  const tokenDoc = await tokenRef.get();
  if (!tokenDoc.exists) {
    return { connected: false };
  }
  try {
    const tokenData = await refreshQuickBooksTokenIfNeeded(tokenDoc);
    // A real Profit & Loss report, not raw transaction queries — this
    // groups by the actual Chart of Accounts (see the P&L Kaylan shared,
    // Sept 2026), the same categories Heidi charts transactions into.
    // Only aggregated dollar totals ever leave this function — never raw
    // transaction records — per Intuit's "QuickBooks data usage"
    // requirement that an app not store/export data beyond its own
    // functional use.
    // Cash, not Accrual — confirmed directly against a real exported report
    // (Sept 2026 "Profit and Loss Detail," printed "Cash Basis" on every
    // page): this app was requesting Accrual this whole time, which is a
    // genuinely different set of numbers than what Kaylan's own QuickBooks
    // reports show for the same date range. That mismatch alone explains a
    // meaningful chunk of every "why doesn't this match QuickBooks" gap
    // reported against this function — nothing about the math below was
    // wrong, it was asking QuickBooks the wrong question.
    const report = await withOneRetry(() => qbReport(tokenData.accessToken, tokenData.realmId, "ProfitAndLoss", {
      start_date: startDate,
      end_date: endDate,
      accounting_method: "Cash",
    }));
    const rows = (report.Rows && report.Rows.Row) || [];
    // Total Income — every income account combined (Services, Client
    // Service Revenue, Billable Expense Income, etc.). This is THE revenue
    // figure to show as "Revenue" — it's already deduplicated and
    // transfer-free by construction, since a real P&L report only ever
    // reflects Income/Expense accounts: a Sales Receipt is recognized once,
    // right here, whether it initially lands in Undeposited Funds or a bank
    // account, and moving money BETWEEN those two is an Asset-to-Asset
    // transfer that never touches the P&L at all. Nothing extra to filter.
    const income = qbReportFind(rows, "Income") || 0;
    // One specific income account within the total above (membership/
    // service revenue, specifically) — kept for anyone wanting that
    // narrower breakdown, but Total Income is the real "Revenue" figure.
    // null (not 0) if QuickBooks has no account by this exact name.
    const servicesIncome = qbReportFind(rows, "Services");
    // QuickBooks' "Expenses" section = Operating Expenses in the P&L
    // waterfall (COGS already broken out separately, below). Same
    // Asset-transfer/Equity-draw reasoning as Income above means owner
    // draws and account-to-account transfers are already excluded here —
    // they're Equity/Asset entries, never Expense accounts, so a real P&L
    // report never includes them to begin with.
    const expenses = qbReportFind(rows, "Expenses") || 0;
    // Only present in a period with actual COGS activity (client service
    // costs, subcontractor expenses) — absent entirely in a period with
    // none, same shape-varies-by-period caveat as qbReportFind's own doc
    // comment above. grossProfit is Income minus this, matching exactly
    // what QuickBooks' own P&L prints as its "Gross Profit" line.
    const cogs = qbReportFind(rows, "Cost of Goods Sold") || 0;
    const grossProfit = income - cogs;
    // "Other Income"/"Other Expense" — QuickBooks' own separate section
    // below Net Ordinary Income (things outside normal day-to-day
    // operations). Needed to compute netProfit the same way QuickBooks'
    // own P&L does: Net Ordinary Income (Gross Profit − Expenses) + Net
    // Other Income (Other Income − Other Expense) = Net Income.
    const otherIncome = qbReportFind(rows, "Other Income") || 0;
    const otherExpense = qbReportFind(rows, "Other Expense") || 0;
    const netOrdinaryIncome = grossProfit - expenses;
    const netProfit = netOrdinaryIncome + (otherIncome - otherExpense);
    // QuickBooks' own actual payroll figure — informational only (to compare
    // against the app's separately-tracked estimated labor cost), NOT used
    // to derive expenses/netProfit above. It's already inside "expenses"
    // (Operating Expenses) by definition, so subtracting it again anywhere
    // would double-count it. "Payroll expenses" (inside Expenses — may or
    // may not have a nested Wages sub-account depending on the period) plus
    // the standalone "payroll" line under Other Expenses, when present —
    // per Kaylan's own account structure, both count as payroll.
    const payroll = (qbReportFind(rows, "Payroll expenses") || 0) + (qbReportFind(rows, "payroll") || 0);
    return { connected: true, income, servicesIncome, expenses, cogs, grossProfit, otherIncome, otherExpense, netProfit, payroll, startDate, endDate };
  } catch (err) {
    console.error("getQuickBooksSummary failed:", err);
    if (isQuickBooksAuthError(err)) {
      // The underlying token was invalid (expired refresh token, revoked
      // access, invalid_grant) — refreshQuickBooksTokenIfNeeded already
      // deleted the dead token doc above. Tell the client explicitly so
      // the Scorecard shows "Connect QuickBooks" instead of a generic
      // error the user can't act on.
      await tokenRef.delete().catch(() => {});
      return { connected: false, reauthRequired: true };
    }
    throw new HttpsError("internal", "Could not reach QuickBooks — try again shortly.");
  }
});
// Mints a random, single-use CSRF state value and stores it server-side
// (qbTokens/pendingState, 10-minute expiry) instead of trusting a value
// the browser alone generated and never had verified against anything —
// the previous version generated `state` client-side and never checked it
// on the way back in, which is exactly the CSRF gap Intuit's security
// review tests for. quickBooksOAuthCallback below is the only code that
// ever reads/consumes this value.
exports.getQuickBooksAuthConfig = onCall(async () => {
  const state = crypto.randomBytes(24).toString("base64url");
  await admin.firestore().collection("qbTokens").doc("pendingState").set({
    state,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return { clientId: QB_CLIENT_ID.value(), redirectUri: QB_REDIRECT_URI.value(), state };
});
exports.disconnectQuickBooks = onCall(async () => {
  await admin.firestore().collection("qbTokens").doc("main").delete();
  return { connected: false };
});

/**
 * The actual OAuth redirect_uri Intuit sends the admin's browser back to
 * after they approve access. This REPLACES the old approach (a static
 * public/qb-callback.html page that read `code`/`realmId` from the URL,
 * did the exchange via a client-side call, and just left that sensitive
 * URL sitting in the address bar/history the whole time).
 *
 * Why the rewrite: Intuit's security review explicitly requires that
 * "web application endpoints that receive sensitive customer information
 * and/or authentication tokens in URL parameters must not return HTML
 * content via an HTTP Response Body... implement a 302 Found redirect
 * instead." A one-time OAuth `code` in the URL is exactly the case this
 * is about. This function does the whole exchange server-side in one
 * request and IMMEDIATELY 302-redirects to a clean confirmation page with
 * no sensitive params at all — the code/state never end up as the
 * "current page" a browser could screenshot, bookmark, cache, or send
 * onward in a Referer header.
 *
 * Also does the real CSRF check getQuickBooksAuthConfig set up: rejects
 * the callback outright if `state` doesn't match the single-use value
 * stored there, and deletes it either way so it can't be replayed.
 */
exports.quickBooksOAuthCallback = onRequest(async (req, res) => {
  const { code, realmId, state, error } = req.query;
  const redirectTo = (ok) => res.redirect(302, `https://modern-co-dashboard.web.app/qb-connected.html?ok=${ok ? "1" : "0"}`);

  if (error) {
    console.warn("QuickBooks OAuth callback received an error param:", error);
    return redirectTo(false);
  }
  if (!code || !realmId || !state) {
    console.warn("QuickBooks OAuth callback missing code/realmId/state.");
    return redirectTo(false);
  }

  const pendingRef = admin.firestore().collection("qbTokens").doc("pendingState");
  const pendingSnap = await pendingRef.get();
  const pending = pendingSnap.exists ? pendingSnap.data() : null;
  // Always delete on the way out (valid or not) — single-use, can't be replayed.
  await pendingRef.delete().catch(() => {});
  if (!pending || pending.state !== state || pending.expiresAt < Date.now()) {
    console.warn("QuickBooks OAuth callback: state mismatch or expired — possible CSRF attempt or stale link.");
    return redirectTo(false);
  }

  try {
    const tokenData = await qbTokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: QB_REDIRECT_URI.value(),
    });
    await storeQuickBooksTokens(realmId, tokenData);
    return redirectTo(true);
  } catch (err) {
    console.error("quickBooksOAuthCallback token exchange failed:", err);
    return redirectTo(false);
  }
});

/**
 * QuickBooks' "Disconnect URL" webhook — required as a field on the Intuit
 * app's config page, called BY INTUIT'S SERVERS (not from inside this app)
 * if someone disconnects this app from their QuickBooks account settings
 * (My Apps > Disconnect) instead of clicking Disconnect inside TMC Ops.
 * Without this, that path would leave a stale, silently-broken token
 * sitting in qbTokens/main with no way for the app to know it stopped
 * working.
 *
 * This has to be a plain onRequest function (not onCall) since Intuit's
 * servers can't attach a Firebase Auth token — it's a real
 * server-to-server call, not a request from inside this app. Per the org
 * policy note elsewhere in this file, the automatic IAM-invoker step at
 * deploy time is expected to fail here too; fix it the same way as the
 * other functions (Cloud Run console → this service → Security →
 * "Allow public access" → Redeploy).
 *
 * Intuit's exact payload for this webhook isn't something I could verify
 * with full certainty at build time, so this is written defensively: it
 * tries to read a realmId from the query string or JSON body if present,
 * but since this app only ever supports ONE connected QuickBooks company
 * at a time anyway (qbTokens/main, not one doc per realm), it just clears
 * that single doc regardless of whether a realmId was found or matched.
 * Always responds 200 so Intuit's system doesn't treat this as a failure
 * and retry/alert on it.
 */
exports.quickBooksDisconnectWebhook = onRequest(async (req, res) => {
  try {
    const realmId = (req.query && req.query.realmId) || (req.body && req.body.realmId) || null;
    console.log("QuickBooks disconnect webhook called" + (realmId ? ` for realmId ${realmId}` : " (no realmId in request)"));
    await admin.firestore().collection("qbTokens").doc("main").delete();
  } catch (err) {
    // Still respond 200 below even on error — Intuit doesn't need to know
    // our cleanup failed, and the stored token will simply fail to
    // refresh next time it's used, surfacing as "not connected" in the app.
    console.error("quickBooksDisconnectWebhook error:", err);
  }
  res.status(200).send("OK");
});

/**
 * Automatic email notifications — the app has no other way to reach an
 * assistant outside the browser (no push/SMS), so this sends real email
 * from support@themodernconcierge.co the moment something happens that
 * shouldn't wait for someone to notice it on the Dashboard:
 *  - a client submits a request through the portal (notifyAssistantOnClientRequest)
 *  - a vendor gives a schedule/availability on a ticket an assistant
 *    submitted (notifyAssistantOnVendorScheduled)
 *
 * Uses the googleapis OAuth2 client (already a dependency, for Drive
 * above) rather than hand-rolling the token exchange/refresh the way the
 * QuickBooks integration does — google.auth.OAuth2 already knows how to
 * refresh an expired access token given a stored refresh_token, so none of
 * that needs reimplementing here.
 */
async function getValidGmailOAuth2Client() {
  const tokenRef = admin.firestore().collection("gmailTokens").doc("main");
  const tokenDoc = await tokenRef.get();
  if (!tokenDoc.exists) return null;
  const data = tokenDoc.data();
  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID.value(),
    GMAIL_CLIENT_SECRET.value(),
    GMAIL_REDIRECT_URI.value()
  );
  oauth2Client.setCredentials({
    refresh_token: decryptSecret(data.refreshToken),
    access_token: data.accessToken ? decryptSecret(data.accessToken) : undefined,
    expiry_date: data.accessTokenExpiresAt || undefined,
  });
  // Fires whenever the library actually refreshes the access token (and,
  // rarely, if Google rotates the refresh token too) — persist it back so
  // the NEXT send doesn't have to hit the refresh endpoint again
  // unnecessarily. Fire-and-forget: a failure here just means one extra
  // refresh call next time, not a failed send.
  oauth2Client.on("tokens", (tokens) => {
    const update = {};
    if (tokens.access_token) update.accessToken = encryptSecret(tokens.access_token);
    if (tokens.expiry_date) update.accessTokenExpiresAt = tokens.expiry_date;
    if (tokens.refresh_token) update.refreshToken = encryptSecret(tokens.refresh_token);
    if (Object.keys(update).length) {
      tokenRef.set(update, { merge: true }).catch((e) => console.warn("Failed to persist refreshed Gmail token:", e));
    }
  });
  return oauth2Client;
}
function encodeMimeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(String(text || ""), "utf8").toString("base64")}?=`;
}
function buildRawEmail(to, subject, bodyText) {
  const message = [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    bodyText,
  ].join("\r\n");
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Never throws — a failed/unconfigured notification shouldn't break
// whatever Firestore write triggered it. Returns true/false for whether it
// actually sent, purely for the caller's own logging.
async function sendEmailViaGmail(to, subject, bodyText) {
  if (!to) return false;
  let oauth2Client;
  try {
    oauth2Client = await getValidGmailOAuth2Client();
  } catch (err) {
    console.error("sendEmailViaGmail: couldn't load Gmail credentials:", err);
    return false;
  }
  if (!oauth2Client) {
    console.warn("sendEmailViaGmail: no Gmail connection configured yet — skipped notification to", to);
    return false;
  }
  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    await gmail.users.messages.send({ userId: "me", requestBody: { raw: buildRawEmail(to, subject, bodyText) } });
    return true;
  } catch (err) {
    console.error("sendEmailViaGmail failed for", to, err);
    return false;
  }
}

// Mirrors DEFAULT_NOTIFY_PREFS in index.html — keep both in sync. An
// assistant who has never touched the toggle has no notifyPrefs field at
// all, so every key here defaults to "on" (preserves the always-on behavior
// these notifications had before the toggle existed).
const DEFAULT_NOTIFY_PREFS = { clientRequest: true, vendorScheduled: true, comments: true };
function assistantWantsNotification(assistant, key) {
  const prefs = (assistant && assistant.notifyPrefs) || {};
  return prefs[key] !== undefined ? !!prefs[key] : DEFAULT_NOTIFY_PREFS[key];
}

exports.getGmailAuthConfig = onCall(async () => {
  const state = crypto.randomBytes(24).toString("base64url");
  await admin.firestore().collection("gmailTokens").doc("pendingState").set({
    state,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return { clientId: GMAIL_CLIENT_ID.value(), redirectUri: GMAIL_REDIRECT_URI.value(), state };
});
exports.getGmailConnectionStatus = onCall(async () => {
  const doc = await admin.firestore().collection("gmailTokens").doc("main").get();
  return { connected: doc.exists };
});
exports.disconnectGmailNotifications = onCall(async () => {
  await admin.firestore().collection("gmailTokens").doc("main").delete();
  return { connected: false };
});
// Same "redirect to a clean page with no sensitive params" pattern as
// quickBooksOAuthCallback above, for the same reason (an auth code sitting
// in a URL that could be bookmarked/cached/sent in a Referer header).
exports.gmailOAuthCallback = onRequest(async (req, res) => {
  const { code, state, error } = req.query;
  const redirectTo = (ok) => res.redirect(302, `https://modern-co-dashboard.web.app/gmail-connected.html?ok=${ok ? "1" : "0"}`);

  if (error) {
    console.warn("Gmail OAuth callback received an error param:", error);
    return redirectTo(false);
  }
  if (!code || !state) {
    console.warn("Gmail OAuth callback missing code/state.");
    return redirectTo(false);
  }
  const pendingRef = admin.firestore().collection("gmailTokens").doc("pendingState");
  const pendingSnap = await pendingRef.get();
  const pending = pendingSnap.exists ? pendingSnap.data() : null;
  await pendingRef.delete().catch(() => {});
  if (!pending || pending.state !== state || pending.expiresAt < Date.now()) {
    console.warn("Gmail OAuth callback: state mismatch or expired — possible CSRF attempt or stale link.");
    return redirectTo(false);
  }
  try {
    const oauth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID.value(), GMAIL_CLIENT_SECRET.value(), GMAIL_REDIRECT_URI.value());
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      // Google only issues a refresh_token on first consent, or when the
      // request includes prompt=consent — if this ever comes back missing,
      // the connect button is sending the wrong params, not a one-off fluke.
      console.error("Gmail OAuth callback: no refresh_token in response — connect flow must include access_type=offline&prompt=consent.");
      return redirectTo(false);
    }
    await admin.firestore().collection("gmailTokens").doc("main").set({
      refreshToken: encryptSecret(tokens.refresh_token),
      accessToken: tokens.access_token ? encryptSecret(tokens.access_token) : null,
      accessTokenExpiresAt: tokens.expiry_date || null,
      connectedAt: new Date().toISOString(),
    });
    return redirectTo(true);
  } catch (err) {
    console.error("gmailOAuthCallback token exchange failed:", err);
    return redirectTo(false);
  }
});

// Fires the moment a vendor gives a schedule or availability window on a
// ticket for the FIRST time (requested -> scheduled, see vendorTicketStage
// in index.html) — the earliest real sign they've seen and accepted the
// job, and exactly the moment the assistant needs to know to follow up
// with the client.
exports.notifyAssistantOnVendorScheduled = onDocumentUpdated("vendors/{vendorId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const beforeById = new Map((before.tickets || []).map((t) => [t.id, t]));
  const newlyScheduled = (after.tickets || []).filter((t) => {
    const prev = beforeById.get(t.id);
    const wasScheduled = !!(prev && (prev.scheduledAt || prev.availableTimesNote));
    const nowScheduled = !!(t.scheduledAt || t.availableTimesNote);
    return !wasScheduled && nowScheduled && t.requestedByAssistantId;
  });
  if (!newlyScheduled.length) return;
  const settingsDoc = await admin.firestore().collection("settings").doc("access").get();
  const assistants = (settingsDoc.exists && settingsDoc.data().assistants) || [];
  for (const ticket of newlyScheduled) {
    const assistant = assistants.find((a) => a.id === ticket.requestedByAssistantId);
    if (!assistant || !assistant.email || !assistantWantsNotification(assistant, "vendorScheduled")) continue;
    const when = ticket.scheduledAt
      ? `scheduled for ${new Date(ticket.scheduledAt).toLocaleString("en-US")}`
      : `available: "${ticket.availableTimesNote}"`;
    const sent = await sendEmailViaGmail(
      assistant.email,
      `${after.name || "A vendor"} responded: ${ticket.title || "vendor request"}`,
      `${after.name || "The vendor"} is ${when} for "${ticket.title || "this request"}".\n\nOpen TMC Ops -> Vendor Requests to follow up with the client.`
    );
    console.log(`notifyAssistantOnVendorScheduled: ticket ${ticket.id} -> ${assistant.email} -> ${sent ? "sent" : "not sent"}`);
  }
});

// Fires the moment a client submits a new request through the portal
// (requestedByClient, status "Pending approval") — previously surfaced
// ONLY on the Dashboard's "Client requests awaiting review" card, with
// nothing pushing it to anyone until they happened to check that tab.
exports.notifyAssistantOnClientRequest = onDocumentCreated("tasks/{taskId}", async (event) => {
  const task = event.data.data();
  if (!task || !task.requestedByClient || task.status !== "Pending approval") return;
  const assigneeIds = task.assignees || [];
  if (!assigneeIds.length) return;
  const [settingsDoc, clientDoc] = await Promise.all([
    admin.firestore().collection("settings").doc("access").get(),
    task.clientId ? admin.firestore().collection("clients").doc(task.clientId).get() : Promise.resolve(null),
  ]);
  const assistants = (settingsDoc.exists && settingsDoc.data().assistants) || [];
  const clientName = (clientDoc && clientDoc.exists && clientDoc.data().name) || "A client";
  const toNotify = assistants.filter((a) => assigneeIds.includes(a.id) && a.email && assistantWantsNotification(a, "clientRequest"));
  for (const assistant of toNotify) {
    const sent = await sendEmailViaGmail(
      assistant.email,
      `New request from ${clientName}: ${task.title || "(no title)"}`,
      `${clientName} submitted a new request: "${task.title || "(no title)"}"` +
        (task.clientRequestNote ? `\n\n"${task.clientRequestNote}"` : "") +
        `\n\nOpen TMC Ops -> Task Board to accept or decline it.`
    );
    console.log(`notifyAssistantOnClientRequest: task ${event.params.taskId} -> ${assistant.email} -> ${sent ? "sent" : "not sent"}`);
  }
});

// Fires whenever a NEW comment lands on a task's discussion thread (another
// assistant, a client, or the content creator) — previously the only way to
// notice was happening to see "Recent comments on your tasks" on the
// Dashboard. discussion entries are only ever appended, never edited or
// reordered (see addTaskComment/addClientTaskComment in index.html), so any
// length increase is exactly the set of new comments, in order.
exports.notifyAssistantsOnTaskComment = onDocumentUpdated("tasks/{taskId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const beforeDiscussion = before.discussion || [];
  const afterDiscussion = after.discussion || [];
  if (afterDiscussion.length <= beforeDiscussion.length) return;
  const newComments = afterDiscussion.slice(beforeDiscussion.length);
  const assigneeIds = after.assignees || [];
  if (!assigneeIds.length) return;
  const settingsDoc = await admin.firestore().collection("settings").doc("access").get();
  const assistants = (settingsDoc.exists && settingsDoc.data().assistants) || [];
  for (const comment of newComments) {
    // Never notify someone about their own comment. Client/content-creator
    // comments have no authorAssistantId, so this only ever excludes the
    // assistant who actually wrote it.
    const recipients = assistants.filter(
      (a) => assigneeIds.includes(a.id) && a.email && a.id !== comment.authorAssistantId && assistantWantsNotification(a, "comments")
    );
    for (const assistant of recipients) {
      const sent = await sendEmailViaGmail(
        assistant.email,
        `${comment.author || "Someone"} commented on: ${after.title || "(no title)"}`,
        `${comment.author || "Someone"} commented on "${after.title || "this task"}":\n\n"${comment.text || ""}"\n\nOpen TMC Ops -> Task Board to reply.`
      );
      console.log(`notifyAssistantsOnTaskComment: task ${event.params.taskId} -> ${assistant.email} -> ${sent ? "sent" : "not sent"}`);
    }
  }
});
