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
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();

const CLIENTS_FOLDER_ID = defineString("CLIENTS_FOLDER_ID");
const EMPLOYEES_FOLDER_ID = defineString("EMPLOYEES_FOLDER_ID");

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
    console.log(`Filed contract for ${after.name} to Drive: ${file.webViewLink}`);
  } catch (err) {
    console.error(`Drive upload failed for client ${event.params.clientId} (${after.name}):`, err);
  }
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
// public/report.html for the full explanation. (This is the same policy
// that makes validateLogin's reachability above an open question — see its
// doc comment.)
