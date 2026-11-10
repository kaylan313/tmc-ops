/**
 * Automatic weekly client recaps — every Friday at 4:00pm Central.
 *
 * What it does, per client:
 *  1. Builds the same Saturday–Friday "End-of-Week Recap" the app's
 *     "Copy message" / "View report" buttons build (ported below from
 *     index.html — see "KEEP IN SYNC").
 *  2. Saves it to reports/{id} so the link opens via public/report.html,
 *     exactly like a manually copied report.
 *  3. Emails the cover note + link to the client FROM the client's assigned
 *     assistant's own Gmail (each assistant connects theirs once on the
 *     Team tab — reportGmailTokens/{assistantId}). If that assistant hasn't
 *     connected yet, it falls back to the shared support@ connection with
 *     Reply-To set to the assistant, so the client still gets it.
 *     Receipt photos for purchases the assistant logged on the client's
 *     card that week (cardPurchases) are ATTACHED to the email, plus any
 *     task receipts if the client has "include receipts" on.
 *  4. CCs Kaylan + Tori (settings/access.weeklyReportCc emails plus
 *     weeklyReportCcAssistantIds, so a team member's current email is used)
 *     and BCCs support@ (weeklyReportBccSupport). When the email already
 *     goes out FROM support@ (assistant not connected) the BCC is dropped —
 *     support@'s Sent folder has the copy. Test sends get no CC/BCC.
 *  5. Marks the client weeklyRecapSentForWeek = <that Friday> so a retry,
 *     the test button, or a manual "Copy message" never double-sends.
 *
 * Off until admin turns on "Auto-send weekly recaps" (settings/access
 * .weeklyReportAutoSend). Each client can opt out (autoWeeklyReport:false).
 * Skipped: inactive clients, the internal pseudo-client, Software-only
 * clients, no client email, already sent this week, and weeks with no time
 * logged and nothing completed. Every run is logged to
 * weeklyReportRuns/{fridayYMD}, shown on the admin Team tab.
 *
 * Dates: the app does all its date math in the browser's local time
 * (Central). Cloud Functions run in UTC, so the handlers set TZ first —
 * each v2 function runs in its own container, so this can't leak into
 * other functions.
 */
const REPORT_TZ = "America/Chicago";
const REPORT_VIEWER_URL = "https://modern-co-dashboard.web.app/report.html";
const INTERNAL_CLIENT_ID = "internal";
const OVERAGE_RATE = 50;
const MAX_REPORT_RECEIPT_BYTES = 650000;
const REPORT_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

// ================= KEEP IN SYNC with index.html =================
// Ported from the "8. Billing period" and "8c. Weekly client report"
// sections of index.html. If the report's layout or math changes there,
// change it here too, or the automatic Friday email and the manual button
// will disagree.
function parseYMD(str) {
  if (!str) return null;
  const parts = String(str).slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return new Date(str);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}
function ymdLocal(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function currentBillingPeriod(client, refDate) {
  if (!client.renewalDate) return null;
  const anchor = parseYMD(client.renewalDate);
  const cycle = client.cycleType || "monthly";
  const now = refDate || new Date();
  let periodStart = new Date(anchor);
  const advance = (d) => {
    const nd = new Date(d);
    if (cycle === "biweekly") nd.setDate(nd.getDate() + 14);
    else if (cycle === "quarterly") nd.setMonth(nd.getMonth() + 3);
    else if (cycle === "annual") nd.setFullYear(nd.getFullYear() + 1);
    else nd.setDate(nd.getDate() + 30);
    return nd;
  };
  while (advance(periodStart) <= now) periodStart = advance(periodStart);
  return { start: periodStart, end: advance(periodStart) };
}
function effectivePackageHours(client, period) {
  let total = client.packageHours || 0;
  const p = period || currentBillingPeriod(client);
  if (!p) return total;
  const periodStartDate = p.start.toISOString().slice(0, 10);
  if (client.rolloverHours && client.rolloverPeriodStart === periodStartDate) total += client.rolloverHours;
  (client.extraHours || []).forEach((e) => {
    if (e.paid && e.periodStart === periodStartDate) total += (e.hours || 0);
  });
  return total;
}
function currentReportWeek(refDate) {
  const now = refDate || new Date();
  const daysSinceFriday = (now.getDay() - 5 + 7) % 7;
  const friday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceFriday);
  const start = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() - 6);
  const end = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 1);
  return { start, end, friday };
}
function entryDurationHours(entry) {
  const start = new Date(entry.clockIn);
  const end = entry.clockOut ? new Date(entry.clockOut) : new Date();
  return (end - start) / 3600000;
}
function formatHoursMinutes(hrs) {
  const totalMinutes = Math.round(Math.max(0, hrs) * 60);
  return Math.floor(totalMinutes / 60) + "h " + (totalMinutes % 60) + "m";
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function receiptsInWindow(tasks, window) {
  const receipts = [];
  tasks.forEach((t) => {
    (t.attachments || []).forEach((a) => {
      const uploaded = new Date(a.uploadedAt);
      if (uploaded >= window.start && uploaded < window.end) receipts.push({ ...a, taskId: t.id, taskTitle: t.title });
    });
  });
  return receipts.sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));
}
// data = { tasks: [...this client's tasks], entries: [...this client's time entries] }
function buildWeeklyReport(client, data, window) {
  const tasks = data.tasks;
  const windowEntries = data.entries.filter((e) => { const d = new Date(e.clockIn); return d >= window.start && d < window.end; });
  const windowHoursByTask = new Map();
  windowEntries.forEach((e) => windowHoursByTask.set(e.taskId, (windowHoursByTask.get(e.taskId) || 0) + entryDurationHours(e)));
  const hoursThisWindow = windowEntries.reduce((s, e) => s + entryDurationHours(e), 0);
  const completed = tasks.filter((t) => {
    if (t.status !== "Done" || !t.completedAt) return false;
    const d = new Date(t.completedAt);
    return d >= window.start && d < window.end;
  });
  const completedIds = new Set(completed.map((t) => t.id));
  // Still clocked in when the report goes out = In progress, not "worked on".
  const runningIds = new Set(data.entries.filter((e) => !e.clockOut).map((e) => e.taskId));
  const workedOn = tasks.filter((t) => !completedIds.has(t.id) && !runningIds.has(t.id) && (windowHoursByTask.get(t.id) || 0) > 0);
  const workedOnIds = new Set(workedOn.map((t) => t.id));
  const taskIds = new Set(tasks.map((t) => t.id));
  const otherHours = windowEntries.filter((e) => !taskIds.has(e.taskId)).reduce((s, e) => s + entryDurationHours(e), 0);
  const inProgress = tasks.filter((t) => !completedIds.has(t.id) && !workedOnIds.has(t.id) && (t.status === "In progress" || runningIds.has(t.id)));
  const inProgressIds = new Set(inProgress.map((t) => t.id));
  const researching = tasks.filter((t) => t.status === "Researching" && !workedOnIds.has(t.id) && !inProgressIds.has(t.id));
  const todo = tasks.filter((t) => t.status === "To do" && !workedOnIds.has(t.id) && !inProgressIds.has(t.id));
  const period = currentBillingPeriod(client);
  const used = data.entries
    .filter((t) => !period || (new Date(t.clockIn) >= period.start && new Date(t.clockIn) < period.end))
    .reduce((sum, t) => sum + entryDurationHours(t), 0);
  const pkg = effectivePackageHours(client);
  const overHours = Math.max(0, used - pkg);
  return {
    kind: "week", client, week: window, inProgress, researching, todo, completed, workedOn,
    windowHoursByTask, hoursThisWindow, otherHours,
    hoursUsed: used, packageHours: pkg,
    hoursRemaining: Math.max(0, pkg - used),
    overHours, overageAmount: overHours * OVERAGE_RATE,
    billingPeriod: period,
    signerName: "The Modern Concierge Team",
    receipts: client.includeReceiptsInReport ? receiptsInWindow(tasks, window) : [],
  };
}
function renderReportReceipts(receipts) {
  if (!receipts || !receipts.length) return "";
  let usedBytes = 0;
  const rows = receipts.map((r) => {
    const size = r.dataUrl ? r.dataUrl.length : 0;
    const meta = `<div class="item-hours" style="margin-bottom:6px;">${r.taskTitle} &middot; ${new Date(r.uploadedAt).toLocaleDateString()}</div>`;
    if (usedBytes + size > MAX_REPORT_RECEIPT_BYTES) {
      return `<div style="margin-bottom:14px;">${meta}<div class="small">${escHtml(r.name || "Receipt")} — too large to include inline; ask your assistant for a copy if you need it.</div></div>`;
    }
    usedBytes += size;
    return `<div style="margin-bottom:14px;">${meta}${r.type && r.type.startsWith("image/")
      ? `<img src="${r.dataUrl}" style="max-width:100%;border-radius:6px;display:block;">`
      : `<a href="${r.dataUrl}" download="${r.name}" style="color:var(--rose-dark);">${r.name}</a>`}</div>`;
  }).join("");
  return `<hr><div class="section-label">Receipts (${receipts.length})</div>${rows}`;
}
function clientReportHtml(report) {
  const { client, week, inProgress, todo, completed, workedOn } = report;
  const span = "this week";
  const noActivity = !completed.length && !workedOn.length && !report.otherHours;
  const fmt = (d) => new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const fmtShort = (d) => (d.getMonth() + 1) + "/" + d.getDate();
  const dateRange = fmt(week.start) + " – " + fmt(new Date(week.end.getTime() - 1));
  const pkg = report.packageHours || 0;
  const pct = pkg ? Math.min(100, Math.round((report.hoursUsed / pkg) * 100)) : 0;
  const item = (t, itemKind) => `
    <div class="item ${itemKind === "progress" ? "progress" : ""}${itemKind === "researching" ? "researching" : ""}${itemKind === "todo" ? "todo" : ""}">
      <div class="item-label">${(t.title || "").toUpperCase()}</div>
      <div class="item-body">${(t.description || t.title || "").trim()}</div>
      ${itemKind !== "todo" && report.windowHoursByTask.get(t.id) ? `<div class="item-hours">${formatHoursMinutes(report.windowHoursByTask.get(t.id))} logged ${span}</div>` : ""}
    </div>`;
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${client.name} — Weekly Recap</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Jost:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{ --brown:#3b2b26; --brown-dark:#241a17; --cream:#f6efe6; --cream-dark:#ece2d3; --rose:#c9a3a0; --rose-dark:#a97f7c; --ok:#4c7a5e; --text:#2c211d; }
    *{box-sizing:border-box;}
    body{margin:0;background:#fff;font-family:'Jost',Arial,sans-serif;color:var(--text);}
    .wrap{max-width:640px;margin:0 auto;}
    .header{background:var(--brown-dark);color:var(--cream);width:100%;border-collapse:collapse;}
    .header td{padding:20px;vertical-align:top;}
    .header td.right{text-align:right;}
    .header .brand-mc{font-family:'Playfair Display',serif;font-size:28px;font-weight:700;line-height:1;}
    .header .brand-sub{font-size:11px;letter-spacing:2px;margin-top:6px;opacity:.85;}
    .header .recap-label{font-size:11px;letter-spacing:2px;opacity:.85;}
    .header .recap-date{font-family:'Playfair Display',serif;font-size:19px;font-weight:600;margin-top:4px;line-height:1.3;}
    @media screen and (max-width:420px){
      .header td{padding:16px 14px;}
      .header .brand-mc{font-size:22px;}
      .header .recap-date{font-size:15px;}
    }
    .body{padding:30px 32px;}
    .eyebrow{font-size:11px;letter-spacing:2px;color:var(--rose-dark);font-weight:600;margin-bottom:8px;}
    .client-name{font-family:'Playfair Display',serif;font-size:32px;font-weight:700;color:var(--brown-dark);margin:0 0 12px 0;}
    .divider-accent{width:60px;height:3px;background:var(--rose-dark);margin-bottom:12px;}
    .sub-meta{color:#8a7a72;font-size:14px;margin-bottom:20px;}
    hr{border:none;border-top:1px solid var(--cream-dark);margin:24px 0;}
    .section-label{font-size:11px;letter-spacing:2px;color:var(--rose-dark);font-weight:600;margin-bottom:12px;text-transform:uppercase;}
    .item{background:var(--cream);border-left:4px solid var(--ok);padding:14px 16px;margin-bottom:10px;}
    .item.progress{border-left-color:var(--rose-dark);}
    .item.researching{border-left-color:#8a6d9c;}
    .item.todo{border-left-color:#8a7a72;}
    .item-label{font-size:12px;letter-spacing:1px;font-weight:600;color:var(--ok);margin-bottom:4px;}
    .item.progress .item-label{color:var(--rose-dark);}
    .item.researching .item-label{color:#8a6d9c;}
    .item.todo .item-label{color:#8a7a72;}
    .item-body{font-size:15px;color:var(--text);}
    .item-hours{font-size:12px;color:#8a7a72;margin-top:6px;letter-spacing:0.5px;}
    .hours-box{background:var(--brown-dark);color:var(--cream);border-radius:4px;padding:24px 28px;}
    .hours-box .caption{font-size:11px;letter-spacing:2px;opacity:.85;margin-bottom:16px;text-transform:uppercase;}
    .hours-row{display:flex;}
    .hours-stat{flex:1;text-align:center;}
    .hours-stat + .hours-stat{border-left:1px solid rgba(246,239,230,0.25);}
    .hours-stat .num{font-family:'Playfair Display',serif;font-size:26px;font-weight:600;}
    .hours-stat .label{font-size:10px;letter-spacing:1.5px;opacity:.8;margin-top:4px;}
    .bar-track{background:rgba(246,239,230,0.2);height:6px;border-radius:3px;margin:20px 0 8px;overflow:hidden;}
    .bar-fill{background:var(--rose);height:100%;}
    .bar-ends{display:flex;justify-content:space-between;font-size:11px;opacity:.75;}
    .bar-pct{text-align:center;font-size:12px;opacity:.85;margin-top:6px;}
    .renews{text-align:center;font-style:italic;font-size:13px;opacity:.85;margin-top:14px;}
    .closing{padding:0 32px 30px;font-size:15px;line-height:1.6;}
    .sig-name{font-family:'Playfair Display',serif;font-size:20px;font-weight:700;margin-top:20px;}
    .sig-rule{width:50px;border-top:2px dashed var(--rose-dark);margin:6px 0;}
    .sig-sub{font-size:11px;letter-spacing:1.5px;color:#8a7a72;}
    .footer{background:var(--brown-dark);color:var(--cream);padding:18px 32px;display:flex;justify-content:space-between;align-items:center;}
    .footer .foot-brand{font-family:'Playfair Display',serif;font-size:17px;font-weight:600;}
    .footer .foot-tag{font-size:11px;letter-spacing:2px;opacity:.85;}
  </style></head>
  <body>
  <div class="wrap">
    <table class="header" role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td><div class="brand-mc">MC</div><div class="brand-sub">MODERN CO.</div></td>
      <td class="right"><div class="recap-label">END-OF-WEEK RECAP</div><div class="recap-date">${dateRange}</div></td>
    </tr></table>
    <div class="body">
      <div class="eyebrow">PREPARED FOR</div>
      <div class="client-name">${client.name}</div>
      <div class="divider-accent"></div>
      <div class="sub-meta">End-of-Week Recap &middot; ${dateRange}</div>
      <hr>

      <div class="section-label">Time Logged This Week</div>
      <div class="item-body" style="margin-bottom:16px;font-size:20px;font-family:'Playfair Display',serif;font-weight:600;">${formatHoursMinutes(report.hoursThisWindow)}</div>

      ${noActivity ? `<div class="item-body" style="margin-bottom:16px;">No work logged ${span}.</div>` : `
      ${completed.length ? `
      <div class="section-label">Completed This Week</div>
      ${completed.map((t) => item(t, "done")).join("")}` : ""}
      ${workedOn.length || report.otherHours ? `
      <div class="section-label" style="margin-top:18px;">Worked On This Week</div>
      ${workedOn.map((t) => item(t, "progress")).join("")}
      ${report.otherHours ? `<div class="item progress"><div class="item-label">ADDITIONAL WORK</div><div class="item-hours">${formatHoursMinutes(report.otherHours)} logged ${span}</div></div>` : ""}` : ""}
      `}

      <hr>

      <div class="section-label">In Progress</div>
      ${inProgress.length ? inProgress.map((t) => item(t, "progress")).join("") : `<div class="item-body" style="margin-bottom:16px;">Nothing in progress right now.</div>`}

      ${report.researching && report.researching.length ? `
      <hr>
      <div class="section-label">Researching</div>
      ${report.researching.map((t) => item(t, "researching")).join("")}` : ""}

      ${todo && todo.length ? `
      <hr>
      <div class="section-label">On Our List</div>
      ${todo.map((t) => item(t, "todo")).join("")}` : ""}

      ${renderReportReceipts(report.receipts)}

      <hr>

      <div class="section-label">Membership Hours — Billing Period</div>
      <div class="hours-box">
        <div class="caption">${pkg}-Hour Membership — Current Usage</div>
        <div class="hours-row">
          <div class="hours-stat"><div class="num">${formatHoursMinutes(report.hoursUsed)}</div><div class="label">HOURS USED</div></div>
          <div class="hours-stat"><div class="num">${formatHoursMinutes(report.hoursRemaining)}</div><div class="label">HOURS REMAINING</div></div>
          <div class="hours-stat"><div class="num">${pkg}h</div><div class="label">TOTAL INCLUDED</div></div>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;"></div></div>
        <div class="bar-ends"><span>0h</span><span>${pkg}h</span></div>
        <div class="bar-pct">${pct}% used</div>
        ${report.overHours > 0 ? `<div class="renews" style="color:#e8b4a8;font-style:normal;">${formatHoursMinutes(report.overHours)} over package — $${report.overageAmount.toFixed(2)} overage at $${OVERAGE_RATE}/hr</div>` : ""}
        ${report.billingPeriod ? `<div class="renews">Billing period ends ${fmtShort(new Date(report.billingPeriod.end.getTime() - 1))}</div>` : ""}
      </div>
    </div>
    <div class="closing">
      <p>Please don't hesitate to reach out should you have any questions or require additional information. We appreciate your continued trust and partnership.</p>
      <div class="sig-name">${report.signerName}</div>
      <div class="sig-rule"></div>
      <div class="sig-sub">THE MODERN CONCIERGE</div>
    </div>
    <div class="footer">
      <div class="foot-brand">The Modern Concierge</div>
      <div class="foot-tag">WEEKLY RECAP REPORT</div>
    </div>
  </div>
  </body></html>`;
}
function clientReportCoverNote(report, reportUrl, attachedCount) {
  const firstName = (report.client.name || "").split(" ")[0] || report.client.name;
  const endDate = report.billingPeriod ? new Date(report.billingPeriod.end.getTime() - 1).toLocaleDateString("en-US") : null;
  const receiptsLine = report.receipts && report.receipts.length
    ? " This week's receipts (" + report.receipts.length + ") are included in the report." : "";
  const overageLine = report.overHours > 0
    ? " You went over your package by " + formatHoursMinutes(report.overHours) + " this week"
      + " — that's a $" + report.overageAmount.toFixed(2) + " overage at $" + OVERAGE_RATE + "/hr." : "";
  return "Hi " + firstName + ",\n\n"
    + "Your weekly report is ready to view here: " + reportUrl
    + " We logged " + formatHoursMinutes(report.hoursThisWindow) + " of work for you this week."
    + " You have used " + formatHoursMinutes(report.hoursUsed)
    + " and have " + formatHoursMinutes(report.hoursRemaining) + " left" + (endDate ? " in your period ending on " + endDate : "") + "." + overageLine + receiptsLine + "\n\n"
    + (attachedCount ? "I've attached " + (attachedCount === 1 ? "the receipt" : "the " + attachedCount + " receipts") + " from this week's purchases.\n\n" : "")
    + "Please let me know if you have any questions regarding this report.\n\n"
    + "The Modern Concierge Team";
}
// ================= end KEEP IN SYNC =================

function isMembershipClient(c) { return c.membershipClient !== false; }

function encodeMimeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(String(text || ""), "utf8").toString("base64")}?=`;
}
// Header values come from our own settings/client records, but strip CR/LF
// anyway so a stray newline in a name can't inject extra headers.
function oneLine(s) { return String(s || "").replace(/[\r\n]+/g, " ").trim(); }
// Plain RFC 822 message (not base64url) — sent through Gmail's media
// upload endpoint so receipt photos can go past the 5MB JSON-body limit.
function wrap76(b64) { return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd(); }
function addressList(list) {
  return (Array.isArray(list) ? list : [list]).map(oneLine).filter(Boolean).join(", ");
}
function buildMimeMessage({ from, to, replyTo, cc, bcc, subject, bodyText, attachments }) {
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${oneLine(to)}`);
  if (replyTo) lines.push(`Reply-To: ${oneLine(replyTo)}`);
  const ccLine = cc ? addressList(cc) : "";
  if (ccLine) lines.push(`Cc: ${ccLine}`);
  const bccLine = bcc ? addressList(bcc) : "";
  if (bccLine) lines.push(`Bcc: ${bccLine}`);
  lines.push(`Subject: ${encodeMimeHeader(subject)}`, "MIME-Version: 1.0");
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(bodyText, "utf8").toString("base64"))];
  if (!attachments || !attachments.length) return [...lines, ...textPart].join("\r\n");
  const boundary = "tmc_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const out = [...lines, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...textPart];
  attachments.forEach((a) => {
    const name = oneLine(a.filename).replace(/"/g, "'");
    out.push(`--${boundary}`, `Content-Type: ${a.mimeType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64", "", wrap76(a.base64));
  });
  out.push(`--${boundary}--`, "");
  return out.join("\r\n");
}
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString("base64") };
}
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp", "application/pdf": "pdf" };
function safeName(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60); }
// Gmail allows 25MB per message after base64 (~33% bigger) — keep the raw
// attachments under ~17MB; anything beyond is still in the linked report
// (task receipts) or noted in the email (card purchases).
const MAX_ATTACH_BYTES = 17 * 1024 * 1024;
const DEFAULT_SUPPORT_BCC = "support@themodernconcierge.co";
const normEmail = (e) => String(e || "").trim().toLowerCase();
const looksLikeEmail = (e) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(String(e || "").trim());
// CC list for every real recap: typed emails (Kaylan) + team members picked
// by id (Tori), so a changed team email is picked up automatically. Never
// set yet = the admin notify email, so Kaylan is CC'd out of the box.
function recapCcList(settings) {
  const typed = Array.isArray(settings.weeklyReportCc) ? settings.weeklyReportCc
    : (settings.weeklyReportCc === undefined && settings.adminNotifyEmail ? [settings.adminNotifyEmail] : []);
  const ids = Array.isArray(settings.weeklyReportCcAssistantIds) ? settings.weeklyReportCcAssistantIds : [];
  const fromTeam = (settings.assistants || []).filter((a) => ids.includes(a.id) && a.active !== false).map((a) => a.email);
  const seen = new Set(), out = [];
  [...typed, ...fromTeam].forEach((e) => { const t = String(e || "").trim(); if (looksLikeEmail(t) && !seen.has(normEmail(t))) { seen.add(normEmail(t)); out.push(t); } });
  return out;
}
// Never set = support@; cleared on purpose (empty string) = no BCC.
function recapBccSupport(settings) {
  const v = settings.weeklyReportBccSupport === undefined ? DEFAULT_SUPPORT_BCC : String(settings.weeklyReportBccSupport || "").trim();
  return looksLikeEmail(v) ? v : "";
}
function receiptAttachments(cardPurchases, report) {
  const list = [];
  cardPurchases.forEach((p) => {
    const parsed = parseDataUrl(p.receiptPhotoDataUrl);
    if (!parsed) return;
    const day = String(p.submittedAt || "").slice(0, 10);
    list.push({ ...parsed, filename: `Receipt - ${safeName(p.store) || "Purchase"} - ${day}${p.amount ? " - $" + Number(p.amount).toFixed(2) : ""}.${EXT[parsed.mimeType] || "jpg"}` });
  });
  (report.receipts || []).forEach((r) => {
    const parsed = parseDataUrl(r.dataUrl);
    if (!parsed) return;
    const base = safeName(r.name) || `Receipt - ${safeName(r.taskTitle)}`;
    list.push({ ...parsed, filename: /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + "." + (EXT[parsed.mimeType] || "jpg") });
  });
  let used = 0;
  const attached = [], skipped = [];
  list.forEach((a) => {
    const bytes = Math.floor(a.base64.length * 3 / 4);
    if (used + bytes > MAX_ATTACH_BYTES) { skipped.push(a); return; }
    used += bytes; attached.push(a);
  });
  return { attached, skipped };
}

module.exports = function createWeeklyReports(deps) {
  const { admin, google, encryptSecret, decryptSecret, newOAuthClient, getSupportGmailClient } = deps;
  const db = () => admin.firestore();
  const tokenRef = (assistantId) => db().collection("reportGmailTokens").doc(assistantId);

  async function getAssistantGmail(assistantId) {
    if (!assistantId) return null;
    const ref = tokenRef(assistantId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const data = snap.data();
    const client = newOAuthClient();
    client.setCredentials({
      refresh_token: decryptSecret(data.refreshToken),
      access_token: data.accessToken ? decryptSecret(data.accessToken) : undefined,
      expiry_date: data.accessTokenExpiresAt || undefined,
    });
    client.on("tokens", (tokens) => {
      const update = {};
      if (tokens.access_token) update.accessToken = encryptSecret(tokens.access_token);
      if (tokens.expiry_date) update.accessTokenExpiresAt = tokens.expiry_date;
      if (tokens.refresh_token) update.refreshToken = encryptSecret(tokens.refresh_token);
      if (Object.keys(update).length) ref.set(update, { merge: true }).catch((e) => console.warn("Failed to persist refreshed report Gmail token:", e));
    });
    return { client, email: data.email || null };
  }

  // Called from googleCalendarOAuthCallback when the OAuth state says
  // purpose:"reportGmail" (one shared redirect URI for both connections).
  async function saveConnection(assistantId, tokens, email) {
    await tokenRef(assistantId).set({
      refreshToken: encryptSecret(tokens.refresh_token),
      accessToken: tokens.access_token ? encryptSecret(tokens.access_token) : null,
      accessTokenExpiresAt: tokens.expiry_date || null,
      email: email || null,
      connectedAt: new Date().toISOString(),
    });
  }

  async function loadData(sinceDays) {
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
    const [settingsSnap, clientsSnap, tasksSnap, entriesSnap, purchasesSnap] = await Promise.all([
      db().collection("settings").doc("access").get(),
      db().collection("clients").get(),
      db().collection("tasks").get(),
      db().collection("timeEntries").where("clockIn", ">=", since).get(),
      db().collection("cardPurchases").where("submittedAt", ">=", new Date(Date.now() - 10 * 86400000).toISOString()).get(),
    ]);
    const cardPurchases = purchasesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const clients = clientsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const tasks = tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const entries = entriesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Same client resolution as entriesByClientMap() in index.html: the
    // task's CURRENT client wins over the entry's clock-in snapshot.
    const taskClient = new Map(tasks.map((t) => [t.id, t.clientId]));
    const entriesByClient = new Map();
    entries.forEach((e) => {
      const cid = (e.taskId && taskClient.has(e.taskId)) ? taskClient.get(e.taskId) : e.clientId;
      if (!entriesByClient.has(cid)) entriesByClient.set(cid, []);
      entriesByClient.get(cid).push(e);
    });
    return { settings, clients, tasks, entriesByClient, cardPurchases };
  }

  // Builds + saves the report and sends it. `override` (test sends) swaps
  // the recipient and drops CC and BCC — a test never reaches anyone else.
  async function sendOne(client, ctx, window, override) {
    const { settings } = ctx;
    const data = {
      tasks: ctx.tasks.filter((t) => t.clientId === client.id),
      entries: ctx.entriesByClient.get(client.id) || [],
    };
    const report = buildWeeklyReport(client, data, window);
    const assistantId = (client.assistantIds || [])[0] || null;
    const assistant = (settings.assistants || []).find((a) => a.id === assistantId) || null;

    const docRef = db().collection("reports").doc();
    await docRef.set({
      html: clientReportHtml(report),
      type: "clientRecap",
      title: client.name + " — week report",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      autoSent: true,
    });
    const url = REPORT_VIEWER_URL + "?id=" + docRef.id;
    const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const subject = (override ? "[TEST] " : "") + "Your weekly recap — " + fmt(window.start) + " – " + fmt(new Date(window.end.getTime() - 1));
    const weekPurchases = ctx.cardPurchases.filter((p) => p.clientId === client.id && new Date(p.submittedAt) >= window.start && new Date(p.submittedAt) < window.end);
    const { attached, skipped } = receiptAttachments(weekPurchases, report);
    let bodyText = clientReportCoverNote(report, url, attached.length);
    if (skipped.length) bodyText = bodyText.replace("The Modern Concierge Team", "(" + skipped.length + " more receipt" + (skipped.length === 1 ? " was" : "s were") + " too large to attach — just reply and I'll send " + (skipped.length === 1 ? "it" : "them") + " separately.)\n\nThe Modern Concierge Team");
    const to = override ? override.to : client.email;
    // CC: Kaylan + Tori, minus the client (and, below, minus whoever is
    // sending it). BCC: support@ (dropped below when support@ is the sender).
    const cc = override ? [] : recapCcList(settings).filter((e) => normEmail(e) !== normEmail(to));
    const bccSupport = override ? "" : recapBccSupport(settings);

    let sentFrom = null, via = null, sentCc = [], sentBcc = null;
    const own = await getAssistantGmail(assistantId).catch((e) => { console.error("weekly report: assistant Gmail load failed", assistantId, e); return null; });
    if (own) {
      const from = own.email ? `${encodeMimeHeader(oneLine(assistant && assistant.name ? assistant.name + " – The Modern Concierge" : "The Modern Concierge"))} <${oneLine(own.email)}>` : null;
      const ccHere = cc.filter((e) => normEmail(e) !== normEmail(own.email));
      const bcc = bccSupport && normEmail(bccSupport) !== normEmail(own.email) ? bccSupport : "";
      await google.gmail({ version: "v1", auth: own.client }).users.messages.send({
        userId: "me", requestBody: {}, media: { mimeType: "message/rfc822", body: buildMimeMessage({ from, to, cc: ccHere, bcc, subject, bodyText, attachments: attached }) },
      });
      sentFrom = own.email || "assistant"; via = "assistant"; sentCc = ccHere; sentBcc = bcc || null;
    } else {
      const support = await getSupportGmailClient();
      if (!support) throw new Error("No Gmail connected for " + (assistant ? assistant.name : "this client's assistant") + ", and support@ isn't connected either");
      const replyTo = assistant && assistant.email ? assistant.email : null;
      // Sent FROM support@ already, so its Sent folder holds the copy — no
      // BCC back to itself.
      await google.gmail({ version: "v1", auth: support }).users.messages.send({
        userId: "me", requestBody: {}, media: { mimeType: "message/rfc822", body: buildMimeMessage({ to, replyTo, cc, subject, bodyText, attachments: attached }) },
      });
      sentFrom = "support@"; via = "support"; sentCc = cc; sentBcc = null;
    }
    return { report, url, sentFrom, via, assistantName: assistant ? assistant.name : null, receiptsAttached: attached.length, receiptsTooLarge: skipped.length, cc: sentCc, bcc: sentBcc };
  }

  // After a real send: same follow-ups copyReportCoverNote does in the app.
  async function afterSend(client, ctx, window, report) {
    const update = { weeklyRecapSentForWeek: ymdLocal(window.friday) };
    await db().collection("clients").doc(client.id).set(update, { merge: true });
    if (client.includeReceiptsInReport && report.receipts.length) {
      const idsByTask = {};
      report.receipts.forEach((r) => { (idsByTask[r.taskId] = idsByTask[r.taskId] || []).push(r.id); });
      for (const [taskId, ids] of Object.entries(idsByTask)) {
        const task = ctx.tasks.find((t) => t.id === taskId);
        if (!task) continue;
        await db().collection("tasks").doc(taskId).set({ attachments: (task.attachments || []).filter((a) => !ids.includes(a.id)) }, { merge: true });
      }
    }
  }

  function skipReason(client, ctx, window) {
    if (client.id === INTERNAL_CLIENT_ID) return null; // not listed at all
    if (client.clientStatus && client.clientStatus !== "active") return null;
    if (!isMembershipClient(client)) return null;
    if (client.autoWeeklyReport === false) return "Auto-send turned off for this client";
    if (!String(client.email || "").trim()) return "No client email on file";
    if (client.weeklyRecapSentForWeek === ymdLocal(window.friday)) return "Already sent this week";
    const entries = ctx.entriesByClient.get(client.id) || [];
    const hasHours = entries.some((e) => { const d = new Date(e.clockIn); return d >= window.start && d < window.end; });
    const hasCompleted = ctx.tasks.some((t) => t.clientId === client.id && t.status === "Done" && t.completedAt && new Date(t.completedAt) >= window.start && new Date(t.completedAt) < window.end);
    const hasPurchases = ctx.cardPurchases.some((p) => p.clientId === client.id && new Date(p.submittedAt) >= window.start && new Date(p.submittedAt) < window.end);
    if (!hasHours && !hasCompleted && !hasPurchases) return "No time logged, tasks completed or purchases this week";
    return "";
  }

  async function runWeekly({ force = false } = {}) {
    process.env.TZ = REPORT_TZ;
    const ctx = await loadData(400);
    const window = currentReportWeek();
    const runId = ymdLocal(window.friday);
    const runRef = db().collection("weeklyReportRuns").doc(runId);
    if (!ctx.settings.weeklyReportAutoSend && !force) {
      await runRef.set({ ranAt: new Date().toISOString(), disabled: true, results: [] });
      return { disabled: true };
    }
    const results = [];
    for (const client of ctx.clients) {
      const reason = skipReason(client, ctx, window);
      if (reason === null) continue;
      if (reason) { results.push({ clientId: client.id, clientName: client.name, status: "skipped", reason }); continue; }
      try {
        const out = await sendOne(client, ctx, window, null);
        await afterSend(client, ctx, window, out.report);
        results.push({ clientId: client.id, clientName: client.name, status: "sent", to: client.email, sentFrom: out.sentFrom, via: out.via, assistantName: out.assistantName, receiptsAttached: out.receiptsAttached, receiptsTooLarge: out.receiptsTooLarge, cc: out.cc, bcc: out.bcc });
      } catch (err) {
        console.error("weekly report failed for", client.id, err);
        results.push({ clientId: client.id, clientName: client.name, status: "failed", reason: String((err && err.message) || err).slice(0, 300) });
      }
    }
    await runRef.set({ ranAt: new Date().toISOString(), disabled: false, cc: recapCcList(ctx.settings), bccSupport: recapBccSupport(ctx.settings) || null, results });
    return { sent: results.filter((r) => r.status === "sent").length, results };
  }

  // Admin "Send me a test": builds this week's report for one client and
  // emails it ONLY to `to` (never the client, no CC/BCC, not marked as sent).
  async function sendTest(clientId, to) {
    process.env.TZ = REPORT_TZ;
    const ctx = await loadData(400);
    const client = ctx.clients.find((c) => c.id === clientId);
    if (!client) throw new Error("Unknown client");
    const out = await sendOne(client, ctx, currentReportWeek(), { to });
    return { sentFrom: out.sentFrom, via: out.via, url: out.url, receiptsAttached: out.receiptsAttached };
  }

  async function statusFor(assistantId) {
    const snap = await tokenRef(assistantId).get();
    return snap.exists ? { connected: true, email: snap.data().email || null } : { connected: false };
  }
  async function disconnect(assistantId) {
    const ref = tokenRef(assistantId);
    const snap = await ref.get();
    if (snap.exists) {
      try { await newOAuthClient().revokeToken(decryptSecret(snap.data().refreshToken)); } catch (e) { /* already revoked */ }
      await ref.delete();
    }
    return { connected: false };
  }

  return { runWeekly, sendTest, saveConnection, statusFor, disconnect, recapCcList, recapBccSupport, REPORT_GMAIL_SCOPE, REPORT_TZ,
    // exported for local testing only
    _test: { buildWeeklyReport, clientReportHtml, clientReportCoverNote, currentReportWeek, buildMimeMessage, receiptAttachments } };
};
