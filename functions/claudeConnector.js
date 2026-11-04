"use strict";
/**
 * Claude connector — lets ONE assistant's own Claude account read and
 * update THEIR OWN corner of TMC Ops (tasks assigned to them, builds
 * assigned to them, their Goals page, their deadlines) and nothing else.
 *
 * Shape: a remote MCP server (JSON-RPC over HTTP, "Streamable HTTP" with
 * plain JSON responses) plus the minimal OAuth 2.1 authorization server
 * Claude's custom connectors expect (metadata discovery, dynamic client
 * registration, PKCE authorization code, rotating refresh tokens).
 *
 * Scoping is enforced HERE, server-side, by construction: every tool loads
 * data by the assistantId bound to the access token and only ever returns
 * an allow-listed set of fields. There is no tool that takes another
 * person's id, and no tool that touches payroll, QuickBooks, billing,
 * contracts, access codes, vendors, card purchases, settings, or anyone
 * else's records. Writes only change the specific allow-listed fields.
 *
 * Who can connect: an assistant whose record in settings/access has
 * claudeConnectorEnabled === true (admin switch on the Team tab), is
 * active, and signs in with their own access code. Turning the switch off
 * cuts off any existing connection on its very next request.
 *
 * Storage (all Cloud-Functions-only, denied in firestore.rules):
 *   connectorClients/{clientId}      dynamically registered OAuth clients
 *   connectorCodes/{sha256(code)}    single-use auth codes (5 min)
 *   connectorTokens/{sha256(token)}  access (1 h) / refresh (30 d) tokens
 *   connectorLoginAttempts/{sha(ip)} wrong-code lockout counter
 * Readable by the app (admin Team tab shows it):
 *   connectorLog/{assistantId}/entries/*  one entry per change Claude made
 *
 * Kept free of firebase-admin / firebase-functions imports so it can be
 * exercised locally against an in-memory fake (see scratch tests).
 */
const crypto = require("crypto");

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// Only Claude's own OAuth callback may receive auth codes.
const ALLOWED_REDIRECT_ORIGINS = ["https://claude.ai", "https://claude.com"];
// Task statuses Claude may set. "Pending approval" / "Needs Client Review"
// drive client-facing workflow (client requests, client review emails),
// so those stay manual in the app.
const CLAUDE_TASK_STATUSES = ["To do", "Researching", "In progress", "Paused", "Done"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
const newId = (prefix) => `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }
function addDaysYMD(ymd, days) {
  const d = new Date(ymd.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function redirectAllowed(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && ALLOWED_REDIRECT_ORIGINS.includes(u.origin);
  } catch (e) { return false; }
}
class ToolError extends Error {}

function createClaudeConnector({ getDb, now = () => Date.now(), log = console }) {
  // ---------- helpers ----------
  function baseUrl(req) {
    const host = req.get("x-forwarded-host") || req.get("host");
    // On the shared cloudfunctions.net host the function name is part of
    // the path; on the function's own run.app URL it isn't. The run.app URL
    // is the one to give Claude (root-level /.well-known discovery works).
    return `https://${host}${/cloudfunctions\.net$/.test(host) ? "/claudeConnector" : ""}`;
  }
  async function loadSettings(db) {
    const snap = await db.collection("settings").doc("access").get();
    return snap.exists ? snap.data() : {};
  }
  function eligibleAssistant(settings, assistantId) {
    const a = (settings.assistants || []).find((x) => x.id === assistantId);
    if (!a || a.active === false || a.claudeConnectorEnabled !== true) return null;
    return a;
  }
  async function logChange(db, assistantId, tool, summary) {
    try {
      await db.collection("connectorLog").doc(assistantId).collection("entries")
        .add({ tool, summary: clip(summary, 500), at: new Date(now()).toISOString() });
    } catch (e) { log.warn("claudeConnector: couldn't write activity log:", e.message); }
  }
  function sendJson(res, status, body, headers) {
    res.status(status);
    res.set("Cache-Control", "no-store");
    if (headers) Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    res.json(body);
  }
  function oauthError(res, status, error, description) {
    sendJson(res, status, { error, error_description: description });
  }

  // ---------- OAuth metadata ----------
  function resourceMetadata(base) {
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "TMC Ops — my portal",
    };
  }
  function authServerMetadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["portal"],
    };
  }

  // ---------- Dynamic client registration ----------
  async function handleRegister(req, res) {
    const db = getDb();
    const body = req.body || {};
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
    if (!uris.length || !uris.every(redirectAllowed)) {
      log.warn("claudeConnector: rejected client registration with redirect_uris", uris);
      return oauthError(res, 400, "invalid_redirect_uri", "Only Claude's own redirect URIs are allowed.");
    }
    const clientId = "tmc_" + randomToken(18);
    const issuedAt = Math.floor(now() / 1000);
    const record = { redirect_uris: uris, client_name: clip(body.client_name || "Claude", 100), createdAt: new Date(now()).toISOString() };
    await db.collection("connectorClients").doc(clientId).set(record);
    sendJson(res, 201, {
      client_id: clientId, client_id_issued_at: issuedAt, redirect_uris: uris, client_name: record.client_name,
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
  }

  // ---------- Authorization (sign in with your access code) ----------
  async function validateAuthorizeParams(db, p) {
    if (!p.client_id) return { fatal: "Missing client_id." };
    const client = await db.collection("connectorClients").doc(String(p.client_id)).get();
    if (!client.exists) return { fatal: "Unknown client. Remove the connector in Claude and add it again." };
    if (!p.redirect_uri || !(client.data().redirect_uris || []).includes(p.redirect_uri)) return { fatal: "That redirect address isn't registered for this client." };
    if (p.response_type !== "code") return { redirectError: "unsupported_response_type" };
    if (!p.code_challenge || p.code_challenge_method !== "S256") return { redirectError: "invalid_request" };
    return {};
  }
  function redirectWithError(res, p, error) {
    const u = new URL(p.redirect_uri);
    u.searchParams.set("error", error);
    if (p.state) u.searchParams.set("state", p.state);
    res.redirect(302, u.toString());
  }
  function loginPage(base, p, message) {
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"]
      .map((k) => (p[k] ? `<input type="hidden" name="${k}" value="${escHtml(p[k])}">` : "")).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Claude to TMC Ops</title>
<style>
  :root{--brown:#3b2b26;--brown-dark:#241a17;--cream:#f6efe6;--rose:#c9a3a0;--rose-dark:#a97f7c;--danger:#b23a3a;}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--cream);font-family:Jost,-apple-system,"Segoe UI",sans-serif;color:#2c211d;padding:16px;}
  .box{background:#fff;border-radius:14px;box-shadow:0 2px 10px rgba(36,26,23,.08);padding:32px;width:380px;max-width:100%;}
  h1{font-family:"Playfair Display",Georgia,serif;font-size:22px;margin:0 0 6px;color:var(--brown-dark);}
  p{font-size:14px;line-height:1.5;margin:0 0 14px;color:#5a4a44;}
  ul{font-size:13px;color:#5a4a44;margin:0 0 16px;padding-left:18px;line-height:1.5;}
  label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--brown-dark);}
  input[type=text]{width:100%;font-size:20px;letter-spacing:2px;text-align:center;padding:10px;border:1px solid #d9cbbd;border-radius:8px;}
  button{width:100%;border:0;border-radius:8px;padding:12px;font-size:15px;cursor:pointer;margin-top:12px;background:var(--brown);color:var(--cream);}
  .link{background:none;color:var(--rose-dark);text-decoration:underline;font-size:13px;padding:4px;margin-top:6px;}
  .err{color:var(--danger);font-size:14px;margin:0 0 12px;}
</style></head><body><div class="box">
<h1>Connect Claude to TMC Ops</h1>
<p>This lets <strong>your own</strong> Claude account read and update your own things in TMC Ops:</p>
<ul><li>Tasks assigned to you</li><li>Builds assigned to you (no dollar amounts)</li><li>Your Goals page</li><li>Your deadlines</li></ul>
<p>It can't see anyone else's records, payroll, QuickBooks or billing.</p>
${message ? `<p class="err">${escHtml(message)}</p>` : ""}
<form method="post" action="${escHtml(base)}/authorize" autocomplete="off">
${hidden}
<label for="code">Your TMC Ops access code</label>
<input id="code" name="access_code" type="text" inputmode="numeric" pattern="[0-9]*" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required>
<button type="button" class="link" id="kb">Use full keyboard (ABC)</button>
<button type="submit">Connect</button>
</form>
<script>
  (function(){var i=document.getElementById("code"),b=document.getElementById("kb"),full=false;
  b.addEventListener("click",function(){full=!full;i.setAttribute("inputmode",full?"text":"numeric");if(full)i.removeAttribute("pattern");else i.setAttribute("pattern","[0-9]*");b.textContent=full?"Use number keypad (123)":"Use full keyboard (ABC)";i.blur();i.focus();});})();
</script>
</div></body></html>`;
  }
  async function loginLockedOut(db, ipKey) {
    const snap = await db.collection("connectorLoginAttempts").doc(ipKey).get();
    if (!snap.exists) return false;
    const d = snap.data();
    return d.windowStart > now() - LOGIN_WINDOW_MS && d.count >= LOGIN_MAX_FAILS;
  }
  async function recordLoginFail(db, ipKey) {
    const ref = db.collection("connectorLoginAttempts").doc(ipKey);
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : null;
    if (!d || d.windowStart <= now() - LOGIN_WINDOW_MS) await ref.set({ count: 1, windowStart: now() });
    else await ref.set({ count: d.count + 1, windowStart: d.windowStart });
  }
  async function handleAuthorize(req, res) {
    const db = getDb();
    const base = baseUrl(req);
    const p = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const v = await validateAuthorizeParams(db, p);
    res.set("Cache-Control", "no-store");
    res.set("X-Frame-Options", "DENY");
    if (v.fatal) return res.status(400).type("html").send(`<p style="font-family:sans-serif;padding:24px;">${escHtml(v.fatal)}</p>`);
    if (v.redirectError) return redirectWithError(res, p, v.redirectError);
    if (req.method !== "POST") return res.status(200).type("html").send(loginPage(base, p));

    const ipKey = sha256("ip:" + (req.ip || req.get("x-forwarded-for") || "unknown"));
    if (await loginLockedOut(db, ipKey)) {
      return res.status(429).type("html").send(loginPage(base, p, "Too many wrong codes. Wait 15 minutes and try again."));
    }
    const code = String(p.access_code || "").trim();
    const settings = await loadSettings(db);
    const match = code ? (settings.assistants || []).find((a) => a.accessCode && a.active !== false && safeEqual(a.accessCode, code)) : null;
    if (!match) {
      await recordLoginFail(db, ipKey);
      return res.status(401).type("html").send(loginPage(base, p, "That access code isn't right. Check it and try again."));
    }
    if (match.claudeConnectorEnabled !== true) {
      return res.status(403).type("html").send(loginPage(base, p, "The Claude connector isn't switched on for your account. Ask Kaylan to turn it on in the Team tab."));
    }
    if (match.mustChangeCode) {
      return res.status(403).type("html").send(loginPage(base, p, "Log in to TMC Ops and finish setting a new access code first, then connect Claude."));
    }
    const authCode = randomToken(32);
    await db.collection("connectorCodes").doc(sha256(authCode)).set({
      assistantId: match.id, clientId: String(p.client_id), redirectUri: p.redirect_uri,
      codeChallenge: String(p.code_challenge), expiresAt: now() + CODE_TTL_MS,
    });
    await logChange(db, match.id, "connect", "Signed in to connect Claude");
    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", authCode);
    if (p.state) u.searchParams.set("state", p.state);
    res.redirect(302, u.toString());
  }

  // ---------- Token endpoint ----------
  async function issueTokens(db, assistantId, clientId) {
    const access = randomToken(32), refresh = randomToken(32);
    await db.collection("connectorTokens").doc(sha256(access)).set({ type: "access", assistantId, clientId, expiresAt: now() + ACCESS_TTL_MS });
    await db.collection("connectorTokens").doc(sha256(refresh)).set({ type: "refresh", assistantId, clientId, expiresAt: now() + REFRESH_TTL_MS });
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: "portal" };
  }
  async function handleToken(req, res) {
    const db = getDb();
    const p = req.body || {};
    if (p.grant_type === "authorization_code") {
      if (!p.code || !p.code_verifier || !p.client_id) return oauthError(res, 400, "invalid_request", "Missing code, code_verifier or client_id.");
      const ref = db.collection("connectorCodes").doc(sha256(p.code));
      const snap = await ref.get();
      await ref.delete().catch(() => {}); // single use, even on failure
      const c = snap.exists ? snap.data() : null;
      if (!c || c.expiresAt < now() || c.clientId !== String(p.client_id) || (p.redirect_uri && p.redirect_uri !== c.redirectUri)) {
        return oauthError(res, 400, "invalid_grant", "Code is invalid or expired.");
      }
      if (!safeEqual(b64url(crypto.createHash("sha256").update(String(p.code_verifier)).digest()), c.codeChallenge)) {
        return oauthError(res, 400, "invalid_grant", "PKCE check failed.");
      }
      if (!eligibleAssistant(await loadSettings(db), c.assistantId)) return oauthError(res, 400, "invalid_grant", "Connector is switched off for this account.");
      return sendJson(res, 200, await issueTokens(db, c.assistantId, c.clientId));
    }
    if (p.grant_type === "refresh_token") {
      if (!p.refresh_token) return oauthError(res, 400, "invalid_request", "Missing refresh_token.");
      const ref = db.collection("connectorTokens").doc(sha256(p.refresh_token));
      const snap = await ref.get();
      const t = snap.exists ? snap.data() : null;
      if (!t || t.type !== "refresh" || t.expiresAt < now() || (p.client_id && t.clientId !== String(p.client_id))) {
        return oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
      }
      await ref.delete(); // rotate
      if (!eligibleAssistant(await loadSettings(db), t.assistantId)) return oauthError(res, 400, "invalid_grant", "Connector is switched off for this account.");
      return sendJson(res, 200, await issueTokens(db, t.assistantId, t.clientId));
    }
    return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  // ---------- Data access (always scoped to ctx.assistant) ----------
  async function clientNames(db) {
    const snap = await db.collection("clients").get();
    const out = {};
    snap.forEach((d) => { const c = d.data(); out[d.id] = { name: c.name || "Client", status: c.clientStatus || "active", addOns: c.addOns || [] }; });
    return out;
  }
  async function myTaskRef(db, ctx, taskId) {
    if (!taskId || typeof taskId !== "string") throw new ToolError("task_id is required.");
    const ref = db.collection("tasks").doc(taskId);
    const snap = await ref.get();
    if (!snap.exists || !(snap.data().assignees || []).includes(ctx.assistant.id)) {
      throw new ToolError("No task with that id is assigned to you.");
    }
    return ref;
  }
  function taskView(id, t, clients) {
    const client = clients[t.clientId];
    return {
      task_id: id,
      number: t.taskNumber || null,
      title: t.title || "",
      status: t.status || "",
      client: t.clientId === "internal" ? "Internal (TMC)" : (client ? client.name : ""),
      category: t.category || "",
      due_date: t.dueDate || null,
      description: clip(t.description || "", 2000),
      subtasks: (t.subtasks || []).map((s, i) => ({ index: i, text: s.text || "", done: !!s.done })),
      recent_comments: (t.discussion || []).slice(-10).map((c) => ({ author: c.author || "", text: clip(c.text || "", 1000), date: c.date || "" })),
      completed_at: t.completedAt || null,
    };
  }
  function myBuilds(clients, assistantId) {
    const out = [];
    Object.entries(clients).forEach(([clientId, c]) => {
      c.addOns.forEach((a) => {
        if (a.buildAssistantId !== assistantId) return;
        const start = YMD_RE.test(String(a.buildStartDate || "").slice(0, 10)) ? String(a.buildStartDate).slice(0, 10) : null;
        out.push({
          client_id: clientId, client: c.name, build_id: a.id, build: a.label || "Build", status: a.status || "",
          day_one: start,
          todos: (a.buildTodos || []).map((t) => ({
            todo_id: t.id, phase: t.phase || "", text: t.text || "", done: !!t.done,
            due: start && t.dueDayOffset != null && !isNaN(Number(t.dueDayOffset)) ? addDaysYMD(start, Number(t.dueDayOffset)) : null,
          })),
        });
      });
    });
    return out;
  }
  // Goals: the Dev Director's Goals page (settings/access.devGoals for its
  // own year, devGoalYears[year] for others) — same storage the app uses.
  function goalSectionLabel(s) {
    if (/^M\d+$/.test(s)) return MONTHS[Number(s.slice(1)) - 1] || s;
    if (/^Q[1-4]$/.test(s)) return s;
    return s === "year" ? "Annual goals" : s === "personal" ? "Personal goals" : s;
  }
  const GOAL_SECTIONS = [...MONTHS.map((_, i) => "M" + (i + 1)), "Q1", "Q2", "Q3", "Q4", "year", "personal"];
  function requireGoalsAccess(ctx) {
    if (!ctx.assistant.isDevDirector) throw new ToolError("You don't have a Goals page in TMC Ops.");
  }
  function resolveGoalYear(settings, year) {
    const main = settings.devGoals;
    if (!main) throw new ToolError("Your goals haven't been set up yet — open the Goals tab in TMC Ops once, then try again.");
    const y = year == null ? main.year : Number(year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new ToolError("year must be a 4-digit year.");
    return { y, isMain: y === main.year };
  }
  function goalsForYear(settings, y, isMain) {
    if (isMain) return settings.devGoals;
    return (settings.devGoalYears || {})[y] || { year: y, targets: { Q1: { website: 0, software: 0 }, Q2: { website: 0, software: 0 }, Q3: { website: 0, software: 0 }, Q4: { website: 0, software: 0 } }, items: [], wins: [] };
  }
  async function mutateGoals(db, ctx, year, fn) {
    requireGoalsAccess(ctx);
    const ref = db.collection("settings").doc("access");
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const settings = snap.exists ? snap.data() : {};
      const { y, isMain } = resolveGoalYear(settings, year);
      const current = goalsForYear(settings, y, isMain);
      const { goals, result } = fn({ ...current, items: [...(current.items || [])], wins: [...(current.wins || [])] });
      if (isMain) tx.update(ref, { devGoals: goals });
      else tx.update(ref, { devGoalYears: { ...(settings.devGoalYears || {}), [y]: goals } });
      return { year: y, ...result };
    });
  }

  // ---------- Tools ----------
  const str = (description) => ({ type: "string", description });
  const TOOLS = [
    {
      name: "list_my_tasks",
      description: "List Task Board tasks assigned to me (the signed-in TMC Ops assistant), with client name, status, due date, subtasks and recent comments. Only my own tasks are ever returned.",
      inputSchema: { type: "object", properties: {
        include_done: { type: "boolean", description: "Include tasks already marked Done (default false)." },
        status: { type: "string", enum: ["To do", "Researching", "In progress", "Paused", "Pending approval", "Needs Client Review", "Done"], description: "Only tasks with this status." },
      }, additionalProperties: false },
      annotations: { title: "List my tasks", readOnlyHint: true },
      async run(db, ctx, a) {
        const [snap, clients] = await Promise.all([db.collection("tasks").where("assignees", "array-contains", ctx.assistant.id).get(), clientNames(db)]);
        const tasks = [];
        snap.forEach((d) => {
          const t = d.data();
          if (a.status && t.status !== a.status) return;
          if (!a.status && !a.include_done && t.status === "Done") return;
          tasks.push(taskView(d.id, t, clients));
        });
        tasks.sort((x, y) => (x.due_date || "9999") < (y.due_date || "9999") ? -1 : (x.due_date || "9999") > (y.due_date || "9999") ? 1 : x.title.localeCompare(y.title));
        return { count: tasks.length, tasks: tasks.slice(0, 200) };
      },
    },
    {
      name: "update_my_task",
      description: `Change the status and/or due date of one of MY tasks. Allowed statuses: ${CLAUDE_TASK_STATUSES.join(", ")}. ("Pending approval" and "Needs Client Review" are set in the app only.)`,
      inputSchema: { type: "object", properties: {
        task_id: str("The task_id from list_my_tasks."),
        status: { type: "string", enum: CLAUDE_TASK_STATUSES },
        due_date: { type: "string", description: "New due date as YYYY-MM-DD, or an empty string to clear it." },
      }, required: ["task_id"], additionalProperties: false },
      annotations: { title: "Update my task", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        if (a.status === undefined && a.due_date === undefined) throw new ToolError("Give a status and/or a due_date to change.");
        if (a.status !== undefined && !CLAUDE_TASK_STATUSES.includes(a.status)) throw new ToolError(`status must be one of: ${CLAUDE_TASK_STATUSES.join(", ")}.`);
        if (a.due_date !== undefined && a.due_date !== "" && !YMD_RE.test(a.due_date)) throw new ToolError("due_date must be YYYY-MM-DD (or empty to clear).");
        const ref = await myTaskRef(db, ctx, a.task_id);
        const out = await db.runTransaction(async (tx) => {
          const t = (await tx.get(ref)).data();
          if (!(t.assignees || []).includes(ctx.assistant.id)) throw new ToolError("No task with that id is assigned to you.");
          if (a.status !== undefined && ["Pending approval", "Needs Client Review"].includes(t.status) && a.status !== t.status) {
            // Moving OUT of these is fine in the app, but it's a client-facing step — keep it there.
            throw new ToolError(`This task is "${t.status}" (a client-facing step) — change it in the app instead.`);
          }
          const patch = {};
          if (a.status !== undefined) {
            patch.status = a.status;
            if (a.status === "Done" && t.status !== "Done") patch.completedAt = new Date(now()).toISOString();
            if (a.status !== "Done") patch.completedAt = null;
          }
          if (a.due_date !== undefined) patch.dueDate = a.due_date;
          tx.update(ref, patch);
          return { title: t.title || "", before: { status: t.status, due_date: t.dueDate || null }, after: { status: patch.status !== undefined ? patch.status : t.status, due_date: patch.dueDate !== undefined ? (patch.dueDate || null) : (t.dueDate || null) } };
        });
        await logChange(db, ctx.assistant.id, "update_my_task", `"${out.title}": ${a.status !== undefined ? `status ${out.before.status} → ${out.after.status}` : ""}${a.status !== undefined && a.due_date !== undefined ? "; " : ""}${a.due_date !== undefined ? `due ${out.before.due_date || "none"} → ${out.after.due_date || "none"}` : ""}`);
        return { ok: true, task_id: a.task_id, ...out };
      },
    },
    {
      name: "set_my_subtask",
      description: "Check or uncheck one subtask on one of MY tasks.",
      inputSchema: { type: "object", properties: {
        task_id: str("The task_id from list_my_tasks."),
        subtask_index: { type: "integer", minimum: 0, description: "The subtask's index from list_my_tasks." },
        done: { type: "boolean" },
      }, required: ["task_id", "subtask_index", "done"], additionalProperties: false },
      annotations: { title: "Check off my subtask", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        const ref = await myTaskRef(db, ctx, a.task_id);
        const out = await db.runTransaction(async (tx) => {
          const t = (await tx.get(ref)).data();
          const subtasks = (t.subtasks || []).slice();
          if (!Number.isInteger(a.subtask_index) || !subtasks[a.subtask_index]) throw new ToolError("No subtask at that index.");
          subtasks[a.subtask_index] = { ...subtasks[a.subtask_index], done: !!a.done };
          tx.update(ref, { subtasks });
          return { title: t.title || "", subtask: subtasks[a.subtask_index].text || "" };
        });
        await logChange(db, ctx.assistant.id, "set_my_subtask", `"${out.title}": ${a.done ? "checked" : "unchecked"} "${out.subtask}"`);
        return { ok: true, ...out, done: !!a.done };
      },
    },
    {
      name: "add_task_comment",
      description: "Post a comment on one of MY tasks, as me. Others on the task may get an email about it, so confirm the wording with me first.",
      inputSchema: { type: "object", properties: {
        task_id: str("The task_id from list_my_tasks."),
        text: str("The comment text."),
      }, required: ["task_id", "text"], additionalProperties: false },
      annotations: { title: "Comment on my task", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(db, ctx, a) {
        const text = String(a.text || "").trim();
        if (!text) throw new ToolError("Comment text is empty.");
        if (text.length > 4000) throw new ToolError("Comment is too long (max 4000 characters).");
        const ref = await myTaskRef(db, ctx, a.task_id);
        const title = await db.runTransaction(async (tx) => {
          const t = (await tx.get(ref)).data();
          const discussion = [...(t.discussion || []), { id: newId("comment"), author: ctx.assistant.name || "", authorAssistantId: ctx.assistant.id, text, date: new Date(now()).toISOString() }];
          tx.update(ref, { discussion });
          return t.title || "";
        });
        await logChange(db, ctx.assistant.id, "add_task_comment", `Commented on "${title}": ${text}`);
        return { ok: true, task: title };
      },
    },
    {
      name: "create_task",
      description: "Create a new Task Board task, assigned to ME only. Omit client_id for an internal (non-client) TMC task.",
      inputSchema: { type: "object", properties: {
        title: str("The task title."),
        client_id: str("An existing active client's id (see list_my_builds, or ask me for it). Omit for an internal TMC task."),
        category: { type: "string", enum: ["Home", "Business"], description: "Defaults to Business." },
        description: str("Optional description."),
        due_date: str("YYYY-MM-DD, optional."),
        priority: { type: "boolean", description: "Flag as priority." },
      }, required: ["title"], additionalProperties: false },
      annotations: { title: "Create a task", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        const title = String(a.title || "").trim();
        if (!title) throw new ToolError("title is required.");
        const category = a.category || "Business";
        if (!["Home", "Business"].includes(category)) throw new ToolError("category must be Home or Business.");
        const dueDate = a.due_date || "";
        if (dueDate && !YMD_RE.test(dueDate)) throw new ToolError("due_date must be YYYY-MM-DD.");
        let clientId = a.client_id || "internal", clientLabel = "Internal (TMC)";
        if (clientId !== "internal") {
          const clients = await clientNames(db);
          const c = clients[clientId];
          if (!c || c.status !== "active") throw new ToolError("No active client with that client_id. Omit client_id for an internal task.");
          clientLabel = c.name;
        }
        const taskId = newId("task");
        const counterRef = db.collection("settings").doc("taskCounter");
        const taskRef = db.collection("tasks").doc(taskId);
        const taskNumber = await db.runTransaction(async (tx) => {
          const snap = await tx.get(counterRef);
          const next = (snap.exists ? (snap.data().value || 0) : 0) + 1;
          tx.set(counterRef, { value: next }, { merge: true });
          tx.set(taskRef, {
            title, clientId, category, status: "To do",
            description: clip(String(a.description || "").trim(), 2000), privateNotes: "",
            dueDate, priority: !!a.priority, goodForContent: false, goodForContentNote: "",
            taskNumber: next, assignees: [ctx.assistant.id],
            assignmentAcks: [{ assistantId: ctx.assistant.id, ackedAt: new Date(now()).toISOString() }],
            subtasks: [], discussion: [], completedAt: null,
            createdAt: new Date(now()).toISOString(),
          });
          return next;
        });
        await logChange(db, ctx.assistant.id, "create_task", `Created "${title}"${clientId !== "internal" ? ` for ${clientLabel}` : ""} (#${taskNumber})`);
        return { ok: true, task_id: taskId, number: taskNumber, title, client: clientLabel, category, status: "To do", due_date: dueDate || null };
      },
    },
    {
      name: "list_my_builds",
      description: "List builds assigned to me, with each to-do, its phase, done state and due date (from the build's Day 1). No financial details are included.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List my builds", readOnlyHint: true },
      async run(db, ctx) {
        const builds = myBuilds(await clientNames(db), ctx.assistant.id);
        return { count: builds.length, builds };
      },
    },
    {
      name: "set_build_todo",
      description: "Check or uncheck a to-do on one of MY builds.",
      inputSchema: { type: "object", properties: {
        client_id: str("client_id from list_my_builds."),
        build_id: str("build_id from list_my_builds."),
        todo_id: str("todo_id from list_my_builds."),
        done: { type: "boolean" },
      }, required: ["client_id", "build_id", "todo_id", "done"], additionalProperties: false },
      annotations: { title: "Check off my build to-do", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        if (!a.client_id || typeof a.client_id !== "string") throw new ToolError("client_id is required.");
        const ref = db.collection("clients").doc(a.client_id);
        const out = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) throw new ToolError("No build with those ids is assigned to you.");
          const c = snap.data();
          let found = null;
          const addOns = (c.addOns || []).map((addOn) => {
            if (addOn.id !== a.build_id || addOn.buildAssistantId !== ctx.assistant.id) return addOn;
            const todos = (addOn.buildTodos || []).map((t) => {
              if (t.id !== a.todo_id) return t;
              found = { build: addOn.label || "Build", todo: t.text || "" };
              return { ...t, done: !!a.done, doneAt: a.done ? new Date(now()).toISOString() : "" };
            });
            return { ...addOn, buildTodos: todos };
          });
          if (!found) throw new ToolError("No build to-do with those ids is assigned to you.");
          tx.update(ref, { addOns });
          return { client: c.name || "Client", ...found };
        });
        await logChange(db, ctx.assistant.id, "set_build_todo", `${out.client} — ${out.build}: ${a.done ? "checked" : "unchecked"} "${out.todo}"`);
        return { ok: true, ...out, done: !!a.done };
      },
    },
    {
      name: "list_my_deadlines",
      description: "My open deadlines (build to-dos and task due dates), overdue first, then upcoming.",
      inputSchema: { type: "object", properties: {
        days_ahead: { type: "integer", minimum: 1, maximum: 366, description: "How many days ahead to include (default 30)." },
      }, additionalProperties: false },
      annotations: { title: "List my deadlines", readOnlyHint: true },
      async run(db, ctx, a) {
        const [snap, clients] = await Promise.all([db.collection("tasks").where("assignees", "array-contains", ctx.assistant.id).get(), clientNames(db)]);
        const today = new Date(now()).toISOString().slice(0, 10);
        const until = addDaysYMD(today, a.days_ahead || 30);
        const items = [];
        snap.forEach((d) => {
          const t = d.data();
          const due = String(t.dueDate || "").slice(0, 10);
          if (!YMD_RE.test(due) || t.status === "Done" || due > until) return;
          const c = clients[t.clientId];
          if (c && c.status !== "active") return;
          items.push({ kind: "task", due, overdue: due < today, title: t.title || "", client: c ? c.name : "", task_id: d.id, status: t.status });
        });
        myBuilds(clients, ctx.assistant.id).forEach((b) => b.todos.forEach((t) => {
          if (t.done || !t.due || t.due > until) return;
          items.push({ kind: "build", due: t.due, overdue: t.due < today, title: t.text, client: b.client, build: b.build, phase: t.phase });
        }));
        items.sort((x, y) => (x.due < y.due ? -1 : x.due > y.due ? 1 : 0));
        return { today, through: until, count: items.length, deadlines: items };
      },
    },
    {
      name: "list_my_goals",
      description: "My Goals page for a year: monthly (January–December), quarterly (Q1–Q4), annual and personal goals, plus my recent wins.",
      inputSchema: { type: "object", properties: { year: { type: "integer", description: "Year (defaults to the main goals year)." } }, additionalProperties: false },
      annotations: { title: "List my goals", readOnlyHint: true },
      async run(db, ctx, a) {
        requireGoalsAccess(ctx);
        const settings = await loadSettings(db);
        const { y, isMain } = resolveGoalYear(settings, a.year);
        const g = goalsForYear(settings, y, isMain);
        const years = [settings.devGoals.year, ...Object.keys(settings.devGoalYears || {}).map(Number)].filter((n, i, arr) => arr.indexOf(n) === i).sort();
        return {
          year: y, years_with_goals: years,
          sections: GOAL_SECTIONS.map((s) => ({ section: s, label: goalSectionLabel(s), goals: (g.items || []).filter((i) => i.section === s).map((i) => ({ goal_id: i.id, text: i.text, done: !!i.done, done_at: i.doneAt || null })) }))
            .filter((s) => s.goals.length || ["year", "personal"].includes(s.section) || /^Q/.test(s.section)),
          wins: (g.wins || []).slice(0, 25).map((w) => ({ date: w.date, text: w.text })),
        };
      },
    },
    {
      name: "add_goal",
      description: "Add a goal to my Goals page. section is M1–M12 (a month), Q1–Q4, year (annual) or personal.",
      inputSchema: { type: "object", properties: {
        section: { type: "string", enum: GOAL_SECTIONS },
        text: str("The goal."),
        year: { type: "integer", description: "Year (defaults to the main goals year)." },
      }, required: ["section", "text"], additionalProperties: false },
      annotations: { title: "Add a goal", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        const text = String(a.text || "").trim();
        if (!text) throw new ToolError("Goal text is empty.");
        if (!GOAL_SECTIONS.includes(a.section)) throw new ToolError("Unknown section.");
        const out = await mutateGoals(db, ctx, a.year, (g) => {
          const item = { id: newId("goal"), section: a.section, text: clip(text, 500), done: false, doneAt: "" };
          return { goals: { ...g, items: [...g.items, item] }, result: { goal_id: item.id } };
        });
        await logChange(db, ctx.assistant.id, "add_goal", `${out.year} ${goalSectionLabel(a.section)}: added "${text}"`);
        return { ok: true, ...out, section: goalSectionLabel(a.section), text };
      },
    },
    {
      name: "update_goal",
      description: "Check off, reword, or move one of my goals (to another section).",
      inputSchema: { type: "object", properties: {
        goal_id: str("goal_id from list_my_goals."),
        done: { type: "boolean" },
        text: str("New wording."),
        section: { type: "string", enum: GOAL_SECTIONS, description: "Move to this section." },
        year: { type: "integer", description: "Year the goal is in (defaults to the main goals year)." },
      }, required: ["goal_id"], additionalProperties: false },
      annotations: { title: "Update a goal", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        if (a.done === undefined && a.text === undefined && a.section === undefined) throw new ToolError("Nothing to change — give done, text and/or section.");
        if (a.text !== undefined && !String(a.text).trim()) throw new ToolError("Goal text can't be blank.");
        const out = await mutateGoals(db, ctx, a.year, (g) => {
          const idx = g.items.findIndex((i) => i.id === a.goal_id);
          if (idx < 0) throw new ToolError("No goal with that id in that year.");
          const before = g.items[idx];
          const after = { ...before };
          if (a.done !== undefined) { after.done = !!a.done; after.doneAt = a.done ? new Date(now()).toISOString() : ""; }
          if (a.text !== undefined) after.text = clip(String(a.text).trim(), 500);
          if (a.section !== undefined) after.section = a.section;
          const items = g.items.slice(); items[idx] = after;
          return { goals: { ...g, items }, result: { before: { text: before.text, done: !!before.done, section: goalSectionLabel(before.section) }, after: { text: after.text, done: !!after.done, section: goalSectionLabel(after.section) } } };
        });
        await logChange(db, ctx.assistant.id, "update_goal", `${out.year}: "${out.before.text}"${a.done !== undefined ? ` ${a.done ? "checked off" : "unchecked"}` : ""}${a.text !== undefined ? ` → reworded "${out.after.text}"` : ""}${a.section !== undefined ? ` → moved to ${out.after.section}` : ""}`);
        return { ok: true, ...out };
      },
    },
    {
      name: "add_win",
      description: "Add an entry to my Wins log on the Goals page.",
      inputSchema: { type: "object", properties: {
        text: str("The win."),
        date: str("YYYY-MM-DD (defaults to today)."),
        year: { type: "integer", description: "Goals year (defaults to the main goals year)." },
      }, required: ["text"], additionalProperties: false },
      annotations: { title: "Log a win", readOnlyHint: false, destructiveHint: false },
      async run(db, ctx, a) {
        const text = String(a.text || "").trim();
        if (!text) throw new ToolError("Win text is empty.");
        if (a.date !== undefined && !YMD_RE.test(a.date)) throw new ToolError("date must be YYYY-MM-DD.");
        const date = a.date || new Date(now()).toISOString().slice(0, 10);
        const out = await mutateGoals(db, ctx, a.year, (g) => ({ goals: { ...g, wins: [{ id: newId("win"), date, text: clip(text, 500) }, ...g.wins] }, result: {} }));
        await logChange(db, ctx.assistant.id, "add_win", `${out.year} win: "${text}"`);
        return { ok: true, year: out.year, date, text };
      },
    },
  ];
  const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

  // ---------- MCP (JSON-RPC) ----------
  async function authenticate(db, req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    if (!m) return null;
    const snap = await db.collection("connectorTokens").doc(sha256(m[1].trim())).get();
    const t = snap.exists ? snap.data() : null;
    if (!t || t.type !== "access" || t.expiresAt < now()) return null;
    const assistant = eligibleAssistant(await loadSettings(db), t.assistantId);
    return assistant ? { assistant } : null;
  }
  async function handleRpc(db, ctx, msg) {
    const isNotification = msg && msg.id === undefined;
    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id === undefined ? null : msg.id, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tmc-ops-portal", version: "1.0.0" },
          instructions: `You're connected to the TMC Ops portal of ${ctx.assistant.name || "this assistant"} (The Modern Concierge). These tools only reach their own tasks, builds, goals and deadlines. Confirm with them before posting comments, since teammates may be emailed.`,
        });
      }
      case "ping": return reply({});
      case "tools/list":
        return reply({ tools: TOOLS.filter((t) => ctx.assistant.isDevDirector || !/goal|win/.test(t.name)).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        const tool = TOOL_BY_NAME[name];
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        const args = (msg.params && msg.params.arguments) || {};
        try {
          const result = await tool.run(db, ctx, args);
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
        } catch (err) {
          if (!(err instanceof ToolError)) log.error(`claudeConnector tool ${name} failed:`, err);
          return reply({ content: [{ type: "text", text: err instanceof ToolError ? err.message : "Something went wrong on the TMC Ops side — try again in a minute." }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }
  async function handleMcp(req, res) {
    const db = getDb();
    const base = baseUrl(req);
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return res.status(405).send("Method Not Allowed");
    }
    const ctx = await authenticate(db, req);
    if (!ctx) {
      return sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, {
        "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
    }
    const body = req.body;
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    const replies = [];
    for (const m of msgs) {
      const r = await handleRpc(db, ctx, m);
      if (r) replies.push(r);
    }
    if (!replies.length) return res.status(202).end();
    sendJson(res, 200, batch ? replies : replies[0]);
  }

  // ---------- router ----------
  return async function claudeConnector(req, res) {
    try {
      const path = (req.path || "/").replace(/\/+$/, "") || "/";
      const base = baseUrl(req);
      if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) return sendJson(res, 200, resourceMetadata(base));
      if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration")) return sendJson(res, 200, authServerMetadata(base));
      if (path === "/register" && req.method === "POST") return await handleRegister(req, res);
      if (path === "/authorize" && (req.method === "GET" || req.method === "POST")) return await handleAuthorize(req, res);
      if (path === "/token" && req.method === "POST") return await handleToken(req, res);
      if (path === "/mcp" || path === "/") return await handleMcp(req, res);
      res.status(404).send("Not found");
    } catch (err) {
      log.error("claudeConnector failed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "server_error" });
    }
  };
}

module.exports = { createClaudeConnector, CLAUDE_TASK_STATUSES };
