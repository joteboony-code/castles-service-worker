import castleWorker from "./worker.js";

const STATE_KEY = "castle_seen_jobs_v6_new_sla_alert";
const CONTROL_KEY = "castle_system_control_v1";
const LAST_RUN_KEY = "castle_dashboard_last_run_v1";
const SCHEDULE_KEY = "castle_schedule_config_v1";
const SCHEDULE_RUN_KEY = "castle_schedule_run_v1";
const NOTIFICATION_CONFIG_KEY = "castle_notification_config_v1";
const DEFAULT_CHECK_INTERVAL_MINUTES = 5;
const MIN_CHECK_INTERVAL_MINUTES = 1;
const MAX_CHECK_INTERVAL_MINUTES = 1440;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return html(renderDashboardHtml(), 200);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!checkAdminRequest(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      if (url.pathname === "/api/status") {
        return json(await getDashboardStatus(env));
      }

      if (url.pathname === "/api/toggle") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
        const body = await readJsonBody(request);
        const enabled = Boolean(body.enabled);
        const control = {
          enabled,
          updatedAt: new Date().toISOString(),
          updatedBy: "dashboard"
        };
        await env.CASTLE_KV.put(CONTROL_KEY, JSON.stringify(control));
        return json({ ok: true, control, status: await getDashboardStatus(env) });
      }

      if (url.pathname === "/api/schedule") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
        const body = await readJsonBody(request);
        const intervalMinutes = normalizeIntervalMinutes(body.intervalMinutes, null);

        if (!intervalMinutes) {
          return json({
            ok: false,
            error: `รอบตรวจต้องเป็นตัวเลข ${MIN_CHECK_INTERVAL_MINUTES}-${MAX_CHECK_INTERVAL_MINUTES} นาที`
          }, 400);
        }

        const schedule = {
          intervalMinutes,
          updatedAt: new Date().toISOString(),
          updatedBy: "dashboard"
        };

        await env.CASTLE_KV.put(SCHEDULE_KEY, JSON.stringify(schedule));

        const runState = await readJsonKv(env, SCHEDULE_RUN_KEY, {});
        await env.CASTLE_KV.put(SCHEDULE_RUN_KEY, JSON.stringify({
          ...runState,
          nextCheckAt: getNextCheckAt(runState.lastCheckedAt || "", intervalMinutes, new Date()).toISOString(),
          intervalMinutes,
          updatedAt: new Date().toISOString(),
          updatedBy: "schedule_change"
        }));

        return json({ ok: true, schedule, status: await getDashboardStatus(env) });
      }

      if (url.pathname === "/api/notification-config") {
        if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
        const body = await readJsonBody(request);
        const notificationConfig = normalizeNotificationConfig({
          ...body,
          updatedAt: new Date().toISOString(),
          updatedBy: "dashboard"
        });

        await env.CASTLE_KV.put(NOTIFICATION_CONFIG_KEY, JSON.stringify(notificationConfig));

        return json({
          ok: true,
          notificationConfig,
          status: await getDashboardStatus(env)
        });
      }

      if (url.pathname === "/api/check") {
        const control = await getControl(env);
        if (!control.enabled) {
          const result = {
            ok: true,
            skipped: true,
            reason: "system_disabled",
            message: "ระบบปิดอยู่ จึงไม่เข้าไปตรวจงานและไม่ส่งแจ้งเตือน",
            checkedAt: new Date().toISOString()
          };
          await env.CASTLE_KV.put(LAST_RUN_KEY, JSON.stringify(result));
          return json(result);
        }

        const result = await callOldWorkerJson(request, env, ctx, "/check");
        await env.CASTLE_KV.put(LAST_RUN_KEY, JSON.stringify({
          ...result,
          checkedAt: new Date().toISOString(),
          source: "dashboard_manual_check"
        }));
        return json(result);
      }

      if (url.pathname === "/api/reset") {
        const result = await callOldWorkerJson(request, env, ctx, "/reset");
        await env.CASTLE_KV.put(LAST_RUN_KEY, JSON.stringify({
          ...result,
          checkedAt: new Date().toISOString(),
          source: "dashboard_reset"
        }));
        return json(result);
      }

      if (url.pathname === "/api/ping") {
        return json(await callOldWorkerJson(request, env, ctx, "/ping"));
      }

      if (url.pathname === "/api/debug") {
        return json(await callOldWorkerJson(request, env, ctx, "/debug"));
      }

      if (url.pathname === "/api/login-debug") {
        return json(await callOldWorkerJson(request, env, ctx, "/login-debug"));
      }

      return json({ ok: false, error: "Not found" }, 404);
    }

    return castleWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const control = await getControl(env);
    if (!control.enabled) {
      return;
    }

    const now = new Date();
    const schedule = await getSchedule(env);
    const runState = await readJsonKv(env, SCHEDULE_RUN_KEY, {});
    const due = getScheduleDue(runState.lastCheckedAt || "", schedule.intervalMinutes, now);

    if (!due.due) {
      return;
    }

    let waitUntilPromise = null;
    const passthroughCtx = {
      waitUntil(promise) {
        waitUntilPromise = promise;
        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(promise);
        }
      }
    };

    const startedAt = new Date().toISOString();
    try {
      await castleWorker.scheduled(controller, env, passthroughCtx);
      if (waitUntilPromise) {
        await waitUntilPromise;
      }

      const finishedAt = new Date();
      const result = {
        ok: true,
        source: "scheduled_check",
        intervalMinutes: schedule.intervalMinutes,
        startedAt,
        checkedAt: finishedAt.toISOString(),
        lastCheckedAt: finishedAt.toISOString(),
        nextCheckAt: getNextCheckAt(finishedAt.toISOString(), schedule.intervalMinutes, finishedAt).toISOString()
      };

      await env.CASTLE_KV.put(SCHEDULE_RUN_KEY, JSON.stringify(result));
      await env.CASTLE_KV.put(LAST_RUN_KEY, JSON.stringify(result));
    } catch (err) {
      const finishedAt = new Date();
      const result = {
        ok: false,
        source: "scheduled_check",
        intervalMinutes: schedule.intervalMinutes,
        startedAt,
        checkedAt: finishedAt.toISOString(),
        lastCheckedAt: finishedAt.toISOString(),
        nextCheckAt: getNextCheckAt(finishedAt.toISOString(), schedule.intervalMinutes, finishedAt).toISOString(),
        error: err.message || String(err)
      };

      await env.CASTLE_KV.put(SCHEDULE_RUN_KEY, JSON.stringify(result));
      await env.CASTLE_KV.put(LAST_RUN_KEY, JSON.stringify(result));
      throw err;
    }
  }
};

function checkAdminRequest(request, env) {
  if (!env.ADMIN_KEY) return false;

  const url = new URL(request.url);
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const headerKey = (request.headers.get("x-admin-key") || "").trim();
  const queryKey = (url.searchParams.get("key") || "").trim();

  return headerKey === env.ADMIN_KEY || bearer === env.ADMIN_KEY || queryKey === env.ADMIN_KEY;
}

async function getControl(env) {
  const raw = await env.CASTLE_KV.get(CONTROL_KEY);
  if (!raw) {
    return {
      enabled: true,
      updatedAt: "",
      updatedBy: "default"
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      updatedAt: parsed.updatedAt || "",
      updatedBy: parsed.updatedBy || "unknown"
    };
  } catch {
    return {
      enabled: true,
      updatedAt: "",
      updatedBy: "fallback"
    };
  }
}

async function getSchedule(env) {
  const raw = await env.CASTLE_KV.get(SCHEDULE_KEY);
  const defaultInterval = getDefaultIntervalMinutes(env);

  if (!raw) {
    return {
      intervalMinutes: defaultInterval,
      updatedAt: "",
      updatedBy: "default"
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      intervalMinutes: normalizeIntervalMinutes(parsed.intervalMinutes, defaultInterval),
      updatedAt: parsed.updatedAt || "",
      updatedBy: parsed.updatedBy || "unknown"
    };
  } catch {
    return {
      intervalMinutes: defaultInterval,
      updatedAt: "",
      updatedBy: "fallback"
    };
  }
}

function getDefaultIntervalMinutes(env) {
  return normalizeIntervalMinutes(env.CHECK_INTERVAL_MINUTES, DEFAULT_CHECK_INTERVAL_MINUTES);
}

function normalizeIntervalMinutes(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < MIN_CHECK_INTERVAL_MINUTES || rounded > MAX_CHECK_INTERVAL_MINUTES) return fallback;
  return rounded;
}

async function getNotificationConfig(env) {
  return normalizeNotificationConfig(await readJsonKv(env, NOTIFICATION_CONFIG_KEY, getDefaultNotificationConfig()));
}

function getDefaultNotificationConfig() {
  return {
    provinceNotifications: [
      { province: "ชลบุรี", enabled: true },
      { province: "ระยอง", enabled: true }
    ],
    mentionRules: [
      {
        username: "@joteboony",
        province: "ชลบุรี",
        districts: ["เมืองชลบุรี", "เมือง", "พนัสนิคม", "พานทอง", "บ้านบึง", "เกาะจันทร์", "บ่อทอง", "หนองใหญ่"],
        enabled: true,
        tag: true
      },
      {
        username: "@VERz1590",
        province: "ชลบุรี",
        districts: ["บางละมุง", "เกาะสีชัง"],
        enabled: true,
        tag: true
      },
      {
        username: "@ORTzxc",
        province: "ชลบุรี",
        districts: ["ศรีราชา", "สัตหีบ"],
        enabled: true,
        tag: true
      }
    ],
    updatedAt: "",
    updatedBy: "default"
  };
}

function normalizeNotificationConfig(config) {
  const fallback = getDefaultNotificationConfig();
  const provinceNotifications = Array.isArray(config && config.provinceNotifications)
    ? config.provinceNotifications
      .map(rule => ({
        province: cleanText(rule && rule.province),
        enabled: rule && rule.enabled !== false
      }))
      .filter(rule => rule.province)
    : fallback.provinceNotifications;

  const mentionRules = Array.isArray(config && config.mentionRules)
    ? config.mentionRules
      .map(rule => ({
        username: normalizeTelegramUsername(rule && rule.username),
        province: cleanText(rule && rule.province),
        districts: normalizeDistrictList(rule && rule.districts),
        enabled: rule && rule.enabled !== false,
        tag: !(rule && rule.tag === false)
      }))
      .filter(rule => rule.username && rule.province)
    : fallback.mentionRules;

  return {
    provinceNotifications,
    mentionRules,
    updatedAt: cleanText(config && config.updatedAt),
    updatedBy: cleanText(config && config.updatedBy) || "unknown"
  };
}

function normalizeTelegramUsername(value) {
  const text = cleanText(value || "");
  if (!text) return "";
  return text.startsWith("@") ? text : `@${text}`;
}

function normalizeDistrictList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,;\n]/);
  return [...new Set(items.map(item => cleanText(item).replace(/\s+/g, "")).filter(Boolean))];
}

function getScheduleDue(lastCheckedAt, intervalMinutes, now = new Date()) {
  if (!lastCheckedAt) {
    return {
      due: true,
      nextCheckAt: now
    };
  }

  const last = new Date(lastCheckedAt);
  if (Number.isNaN(last.getTime())) {
    return {
      due: true,
      nextCheckAt: now
    };
  }

  const next = new Date(last.getTime() + intervalMinutes * 60 * 1000);
  return {
    due: now.getTime() >= next.getTime(),
    nextCheckAt: next
  };
}

function getNextCheckAt(lastCheckedAt, intervalMinutes, now = new Date()) {
  if (!lastCheckedAt) return now;
  const last = new Date(lastCheckedAt);
  if (Number.isNaN(last.getTime())) return now;
  return new Date(last.getTime() + intervalMinutes * 60 * 1000);
}

async function getDashboardStatus(env) {
  const control = await getControl(env);
  const schedule = await getSchedule(env);
  const notificationConfig = await getNotificationConfig(env);
  const scheduleRun = await readJsonKv(env, SCHEDULE_RUN_KEY, {});
  const state = await readJsonKv(env, STATE_KEY, {});
  const lastRun = await readJsonKv(env, LAST_RUN_KEY, null);
  const jobs = Object.values(state.jobs || {});
  const dueInfo = getScheduleDue(scheduleRun.lastCheckedAt || "", schedule.intervalMinutes, new Date());

  const chonburiJobs = jobs.filter(job => cleanText(job.province || "") === "ชลบุรี");
  const latestJobs = [...jobs]
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
    .slice(0, 20)
    .map(job => ({
      jobNumber: job.jobNumber || "",
      terminalId: job.terminalId || "",
      merchantName: job.merchantName || "",
      province: job.province || "",
      district: job.district || "",
      status: job.status || "",
      slaDate: job.slaDate || "",
      lastSeenAt: job.lastSeenAt || "",
      link: job.link || ""
    }));

  return {
    ok: true,
    now: new Date().toISOString(),
    control,
    schedule: {
      ...schedule,
      minIntervalMinutes: MIN_CHECK_INTERVAL_MINUTES,
      maxIntervalMinutes: MAX_CHECK_INTERVAL_MINUTES,
      lastCheckedAt: scheduleRun.lastCheckedAt || scheduleRun.checkedAt || "",
      nextCheckAt: dueInfo.nextCheckAt ? dueInfo.nextCheckAt.toISOString() : "",
      dueNow: dueInfo.due,
      lastScheduledResult: scheduleRun || null
    },
    config: {
      hasAdminKey: Boolean(env.ADMIN_KEY),
      hasCastleUsername: Boolean(env.CASTLE_USERNAME),
      hasCastlePassword: Boolean(env.CASTLE_PASSWORD),
      hasTelegramToken: Boolean(env.TELEGRAM_BOT_TOKEN),
      hasTelegramChatId: Boolean(env.TELEGRAM_CHAT_ID),
      hasKv: Boolean(env.CASTLE_KV),
      slaAlertMinutes: env.SLA_ALERT_MINUTES || "360,180,60,30,10"
    },
    notificationConfig,
    state: {
      updatedAt: state.updatedAt || "",
      totalJobs: jobs.length,
      chonburiJobs: chonburiJobs.length,
      latestJobs
    },
    lastRun
  };
}

async function callOldWorkerJson(request, env, ctx, path) {
  const internalUrl = new URL(path, request.url);
  internalUrl.searchParams.set("key", env.ADMIN_KEY || "");

  const resp = await castleWorker.fetch(new Request(internalUrl.href, { method: "GET" }), env, ctx);
  const text = await resp.text();

  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: resp.ok,
      status: resp.status,
      body: text
    };
  }
}

async function readJsonKv(env, key, fallback) {
  const raw = await env.CASTLE_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Castle Service Dashboard</title>
  <style>
    :root { color-scheme: light; --bg:#f5f7fb; --card:#ffffff; --text:#172033; --muted:#6b7280; --line:#e5e7eb; --green:#0f9f6e; --red:#dc2626; --blue:#2563eb; --amber:#d97706; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    .wrap { max-width:1120px; margin:0 auto; padding:18px; }
    .hero { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px; }
    h1 { margin:0; font-size:28px; }
    .sub { color:var(--muted); margin-top:6px; }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:12px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:16px; box-shadow:0 10px 28px rgba(15,23,42,.05); }
    .wide { grid-column: 1 / -1; }
    .half { grid-column: span 2; }
    .label { font-size:13px; color:var(--muted); margin-bottom:8px; }
    .value { font-size:28px; font-weight:800; }
    .badge { display:inline-flex; align-items:center; gap:8px; border-radius:999px; padding:8px 12px; font-weight:800; border:1px solid var(--line); background:#fff; }
    .dot { width:10px; height:10px; border-radius:999px; background:var(--muted); }
    .on .dot { background:var(--green); } .off .dot { background:var(--red); }
    .on { color:var(--green); } .off { color:var(--red); }
    .buttons { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; }
    button { border:0; border-radius:14px; padding:12px 16px; font-weight:800; cursor:pointer; color:white; font-size:15px; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .btn-on { background:var(--green); } .btn-off { background:var(--red); } .btn-main { background:var(--blue); } .btn-warn { background:var(--amber); } .btn-dark { background:#111827; }
    input, select { width:100%; border:1px solid var(--line); border-radius:14px; padding:13px 14px; font-size:16px; background:#fff; }
    .inline-form { display:grid; grid-template-columns: minmax(120px, 1fr) auto; gap:10px; align-items:center; margin-top:10px; }
    .rule-form { display:grid; grid-template-columns: 1fr 1fr 2fr auto auto; gap:10px; align-items:center; margin-top:10px; }
    .checkline { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:14px; }
    .checkline input { width:auto; }
    .province-list { display:flex; flex-wrap:wrap; gap:10px; margin:10px 0; }
    .pill { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--line); border-radius:999px; padding:8px 12px; background:#fff; }
    .pill input { width:auto; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { padding:10px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:var(--muted); font-weight:700; }
    .muted { color:var(--muted); }
    .ok { color:var(--green); font-weight:800; } .bad { color:var(--red); font-weight:800; }
    pre { white-space:pre-wrap; word-break:break-word; background:#0b1020; color:#e5e7eb; border-radius:14px; padding:14px; max-height:360px; overflow:auto; }
    .hide { display:none; }
    @media (max-width: 800px) { .hero { display:block; } .grid { grid-template-columns: 1fr 1fr; } .half { grid-column:1 / -1; } h1 { font-size:23px; } }
    @media (max-width: 900px) { .rule-form { grid-template-columns: 1fr; } }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } .card { border-radius:14px; } .inline-form { grid-template-columns: 1fr; } table { font-size:12px; } th, td { padding:8px 6px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>Castle Service Dashboard</h1>
        <div class="sub">ดูสถานะงาน เปิด/ปิดระบบ ตั้งรอบตรวจ และสั่งตรวจงานจากหน้าเว็บ</div>
      </div>
      <div id="systemBadge" class="badge"><span class="dot"></span><span>ยังไม่ได้โหลด</span></div>
    </div>

    <div id="loginCard" class="card wide">
      <div class="label">Admin Key</div>
      <input id="adminKey" type="password" placeholder="ใส่ ADMIN_KEY เพื่อเข้า Dashboard" autocomplete="current-password" />
      <div class="buttons">
        <button class="btn-main" onclick="saveKey()">เข้าสู่ระบบ</button>
      </div>
      <p class="muted">ระบบจะเก็บ key ไว้เฉพาะใน browser เครื่องนี้ด้วย sessionStorage ไม่ได้บันทึกลง Worker</p>
    </div>

    <div id="dashboard" class="hide">
      <div class="grid">
        <div class="card">
          <div class="label">งานทั้งหมดที่จำไว้</div>
          <div id="totalJobs" class="value">-</div>
        </div>
        <div class="card">
          <div class="label">งานจังหวัดชลบุรี</div>
          <div id="chonburiJobs" class="value">-</div>
        </div>
        <div class="card">
          <div class="label">อัปเดตล่าสุด</div>
          <div id="updatedAt" class="value" style="font-size:18px">-</div>
        </div>
        <div class="card">
          <div class="label">รอบตรวจงาน</div>
          <div id="intervalText" class="value" style="font-size:18px">-</div>
        </div>

        <div class="card half">
          <div class="label">ควบคุมระบบ</div>
          <div id="controlText" class="value" style="font-size:22px">-</div>
          <div class="buttons">
            <button id="enableBtn" class="btn-on" onclick="toggleSystem(true)">เปิดระบบ</button>
            <button id="disableBtn" class="btn-off" onclick="toggleSystem(false)">ปิดระบบ</button>
            <button id="checkBtn" class="btn-main" onclick="checkNow()">ตรวจงานตอนนี้</button>
            <button class="btn-warn" onclick="resetSeen()">Reset งานที่จำไว้</button>
          </div>
          <p class="muted">เมื่อปิดระบบ cron จะหยุดก่อน login เข้า Castle และจะไม่ส่ง Telegram</p>
        </div>

        <div class="card half">
          <div class="label">ตั้งเวลาตรวจงาน</div>
          <div class="inline-form">
            <select id="intervalPreset" onchange="applyPresetInterval()">
              <option value="1">ทุก 1 นาที</option>
              <option value="3">ทุก 3 นาที</option>
              <option value="5">ทุก 5 นาที</option>
              <option value="10">ทุก 10 นาที</option>
              <option value="15">ทุก 15 นาที</option>
              <option value="30">ทุก 30 นาที</option>
              <option value="60">ทุก 1 ชั่วโมง</option>
              <option value="custom">กำหนดเอง</option>
            </select>
            <button class="btn-main" onclick="saveSchedule()">บันทึกรอบตรวจ</button>
          </div>
          <div style="margin-top:10px">
            <input id="intervalMinutes" type="number" min="1" max="1440" step="1" placeholder="จำนวนนาที เช่น 5" />
          </div>
          <p class="muted">
            ตรวจล่าสุด: <span id="lastScheduledAt">-</span><br>
            รอบถัดไป: <span id="nextScheduledAt">-</span>
          </p>
        </div>

        <div class="card half">
          <div class="label">การตั้งค่า Secret</div>
          <div id="secretList" class="muted">-</div>
          <div class="buttons">
            <button class="btn-dark" onclick="pingTelegram()">ทดสอบ Telegram</button>
            <button class="btn-dark" onclick="loginDebug()">Login Debug</button>
          </div>
        </div>

        <div class="card half">
          <div class="label">SLA Alert</div>
          <div id="slaAlert" class="value" style="font-size:18px">-</div>
          <p class="muted">ใช้สำหรับแจ้งเตือนก่อนหมด SLA ตามนาทีที่ตั้งไว้ใน Secret</p>
        </div>

        <div class="card wide">
          <div class="label">ตั้งค่าพื้นที่แจ้งเตือน / Tag User</div>
          <p class="muted">
            จังหวัดที่เปิดไว้จะส่งแจ้งเตือนเข้าแชท ส่วนตารางด้านล่างใช้กำหนดว่าอำเภอไหนต้อง tag user คนไหน
          </p>
          <div id="provinceRules" class="province-list"></div>
          <div class="rule-form">
            <input id="ruleUsername" placeholder="@username เช่น @ORTzxc" />
            <input id="ruleProvince" placeholder="จังหวัด เช่น ชลบุรี" />
            <input id="ruleDistricts" placeholder="อำเภอ เช่น ศรีราชา, สัตหีบ (ว่าง = ทั้งจังหวัด)" />
            <label class="checkline"><input id="ruleTag" type="checkbox" checked /> tag</label>
            <button class="btn-main" onclick="addMentionRule()">เพิ่ม</button>
          </div>
          <div style="overflow:auto; margin-top:12px">
            <table>
              <thead><tr><th>User</th><th>จังหวัด</th><th>อำเภอ</th><th>Tag</th><th>สถานะ</th><th></th></tr></thead>
              <tbody id="mentionRulesBody"><tr><td colspan="6" class="muted">ยังไม่มี rule</td></tr></tbody>
            </table>
          </div>
          <div class="buttons">
            <button class="btn-main" onclick="saveNotificationConfig()">บันทึกพื้นที่แจ้งเตือน</button>
            <button class="btn-dark" onclick="resetNotificationForm()">คืนค่า default</button>
          </div>
          <p class="muted">ค่า default: ชลบุรีและระยองแจ้งเตือน, ระยองไม่ tag, @ORTzxc สำหรับศรีราชา/สัตหีบ</p>
        </div>

        <div class="card wide">
          <div class="label">รายการงานล่าสุด</div>
          <div style="overflow:auto">
            <table>
              <thead><tr><th>Job</th><th>Terminal</th><th>Merchant</th><th>พื้นที่</th><th>Status</th><th>SLA</th></tr></thead>
              <tbody id="jobsBody"><tr><td colspan="6" class="muted">ยังไม่มีข้อมูล</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card wide">
          <div class="label">ผลลัพธ์ล่าสุด</div>
          <pre id="lastResult">-</pre>
        </div>
      </div>
    </div>
  </div>

<script>
  var adminKey = sessionStorage.getItem('castleAdminKey') || '';
  var notificationConfig = null;
  var defaultNotificationConfig = {
    provinceNotifications: [
      { province: 'ชลบุรี', enabled: true },
      { province: 'ระยอง', enabled: true }
    ],
    mentionRules: [
      { username: '@joteboony', province: 'ชลบุรี', districts: ['เมืองชลบุรี', 'เมือง', 'พนัสนิคม', 'พานทอง', 'บ้านบึง', 'เกาะจันทร์', 'บ่อทอง', 'หนองใหญ่'], enabled: true, tag: true },
      { username: '@VERz1590', province: 'ชลบุรี', districts: ['บางละมุง', 'เกาะสีชัง'], enabled: true, tag: true },
      { username: '@ORTzxc', province: 'ชลบุรี', districts: ['ศรีราชา', 'สัตหีบ'], enabled: true, tag: true }
    ]
  };
  var urlKey = new URL(location.href).searchParams.get('key');
  if (urlKey) {
    adminKey = urlKey;
    sessionStorage.setItem('castleAdminKey', adminKey);
    history.replaceState(null, '', location.pathname);
  }

  function el(id) { return document.getElementById(id); }

  function saveKey() {
    adminKey = el('adminKey').value.trim();
    if (!adminKey) return alert('กรุณาใส่ ADMIN_KEY');
    sessionStorage.setItem('castleAdminKey', adminKey);
    loadStatus();
  }

  async function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers['x-admin-key'] = adminKey;
    if (options.body && typeof options.body !== 'string') {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    options.headers = headers;
    var resp = await fetch(path, options);
    var text = await resp.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { data = { ok: resp.ok, body: text }; }
    if (resp.status === 401) {
      sessionStorage.removeItem('castleAdminKey');
      el('loginCard').classList.remove('hide');
      el('dashboard').classList.add('hide');
      throw new Error('Unauthorized');
    }
    if (!resp.ok) throw new Error(data.error || text || 'Request failed');
    return data;
  }

  function fmtTime(value) {
    if (!value) return '-';
    try { return new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }); } catch (e) { return value; }
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function(ch) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[ch];
    });
  }

  function cloneConfig(config) {
    return JSON.parse(JSON.stringify(config || defaultNotificationConfig));
  }

  function splitDistricts(value) {
    return String(value || '').split(/[,;\\n]/).map(function(x) {
      return x.trim().replace(/\\s+/g, '');
    }).filter(Boolean);
  }

  function normalizeUsername(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    return text.charAt(0) === '@' ? text : '@' + text;
  }

  function renderNotificationConfig(config) {
    notificationConfig = cloneConfig(config);
    notificationConfig.provinceNotifications = notificationConfig.provinceNotifications || [];
    notificationConfig.mentionRules = notificationConfig.mentionRules || [];

    var provinces = ['ชลบุรี', 'ระยอง'];
    notificationConfig.provinceNotifications.forEach(function(rule) {
      if (rule.province && provinces.indexOf(rule.province) === -1) provinces.push(rule.province);
    });

    el('provinceRules').innerHTML = provinces.map(function(province) {
      var rule = notificationConfig.provinceNotifications.find(function(item) { return item.province === province; });
      var checked = !rule || rule.enabled !== false;
      return '<label class="pill"><input type="checkbox" data-province="' + escapeHtml(province) + '" ' + (checked ? 'checked' : '') + '> แจ้งเตือน จ.' + escapeHtml(province) + '</label>';
    }).join('');

    var rows = notificationConfig.mentionRules.map(function(rule, index) {
      var districts = (rule.districts || []).length ? rule.districts.join(', ') : 'ทั้งจังหวัด';
      return '<tr>' +
        '<td>' + escapeHtml(rule.username) + '</td>' +
        '<td>' + escapeHtml(rule.province) + '</td>' +
        '<td>' + escapeHtml(districts) + '</td>' +
        '<td>' + (rule.tag === false ? 'ไม่ tag' : 'tag') + '</td>' +
        '<td>' + (rule.enabled === false ? '<span class="bad">ปิด</span>' : '<span class="ok">เปิด</span>') + '</td>' +
        '<td><button class="btn-warn" onclick="removeMentionRule(' + index + ')">ลบ</button></td>' +
      '</tr>';
    }).join('');
    el('mentionRulesBody').innerHTML = rows || '<tr><td colspan="6" class="muted">ยังไม่มี rule</td></tr>';
  }

  function collectProvinceNotifications() {
    var boxes = document.querySelectorAll('#provinceRules input[data-province]');
    var result = [];
    boxes.forEach(function(box) {
      result.push({ province: box.getAttribute('data-province'), enabled: box.checked });
    });
    return result;
  }

  function addMentionRule() {
    var username = normalizeUsername(el('ruleUsername').value);
    var province = el('ruleProvince').value.trim();
    var districts = splitDistricts(el('ruleDistricts').value);
    var tag = el('ruleTag').checked;
    if (!username) return alert('กรุณาใส่ username เช่น @ORTzxc');
    if (!province) return alert('กรุณาใส่จังหวัด');

    notificationConfig = notificationConfig || cloneConfig(defaultNotificationConfig);
    notificationConfig.mentionRules = notificationConfig.mentionRules || [];
    notificationConfig.mentionRules.push({
      username: username,
      province: province,
      districts: districts,
      enabled: true,
      tag: tag
    });

    el('ruleUsername').value = '';
    el('ruleProvince').value = '';
    el('ruleDistricts').value = '';
    el('ruleTag').checked = true;
    renderNotificationConfig(notificationConfig);
  }

  function removeMentionRule(index) {
    if (!notificationConfig || !notificationConfig.mentionRules) return;
    notificationConfig.mentionRules.splice(index, 1);
    renderNotificationConfig(notificationConfig);
  }

  function resetNotificationForm() {
    if (!confirm('คืนค่าพื้นที่แจ้งเตือนเป็น default? ยังไม่บันทึกจนกว่าจะกดบันทึก')) return;
    renderNotificationConfig(defaultNotificationConfig);
  }

  async function saveNotificationConfig() {
    notificationConfig = notificationConfig || cloneConfig(defaultNotificationConfig);
    notificationConfig.provinceNotifications = collectProvinceNotifications();
    var data = await api('/api/notification-config', {
      method: 'POST',
      body: notificationConfig
    });
    renderStatus(data.status);
    el('lastResult').textContent = JSON.stringify(data.notificationConfig, null, 2);
    alert('บันทึกพื้นที่แจ้งเตือนแล้ว');
  }

  function applyPresetInterval() {
    var value = el('intervalPreset').value;
    if (value !== 'custom') {
      el('intervalMinutes').value = value;
    }
  }

  function syncPreset(intervalMinutes) {
    var preset = String(intervalMinutes || '');
    var select = el('intervalPreset');
    var found = false;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === preset) found = true;
    }
    select.value = found ? preset : 'custom';
  }

  function renderStatus(data) {
    el('loginCard').classList.add('hide');
    el('dashboard').classList.remove('hide');

    var enabled = data.control && data.control.enabled;
    var schedule = data.schedule || {};
    var badge = el('systemBadge');
    badge.className = 'badge ' + (enabled ? 'on' : 'off');
    badge.querySelector('span:last-child').textContent = enabled ? 'ระบบเปิดอยู่' : 'ระบบปิดอยู่';

    el('totalJobs').textContent = data.state.totalJobs || 0;
    el('chonburiJobs').textContent = data.state.chonburiJobs || 0;
    el('updatedAt').textContent = fmtTime(data.state.updatedAt);
    el('slaAlert').textContent = data.config.slaAlertMinutes;
    el('intervalText').textContent = 'ทุก ' + (schedule.intervalMinutes || '-') + ' นาที';
    el('intervalMinutes').value = schedule.intervalMinutes || 5;
    syncPreset(schedule.intervalMinutes || 5);
    el('lastScheduledAt').textContent = fmtTime(schedule.lastCheckedAt);
    el('nextScheduledAt').textContent = enabled ? fmtTime(schedule.nextCheckAt) : 'ระบบปิดอยู่';
    el('controlText').textContent = enabled ? 'เปิดระบบ: ตรวจงานตามรอบที่ตั้งไว้' : 'ปิดระบบ: ไม่เข้าไปตรวจงาน';
    el('controlText').className = 'value ' + (enabled ? 'ok' : 'bad');
    el('enableBtn').disabled = enabled;
    el('disableBtn').disabled = !enabled;
    el('checkBtn').disabled = !enabled;
    renderNotificationConfig(data.notificationConfig || defaultNotificationConfig);

    var c = data.config || {};
    var items = [
      ['ADMIN_KEY', c.hasAdminKey],
      ['CASTLE_USERNAME', c.hasCastleUsername],
      ['CASTLE_PASSWORD', c.hasCastlePassword],
      ['TELEGRAM_BOT_TOKEN', c.hasTelegramToken],
      ['TELEGRAM_CHAT_ID', c.hasTelegramChatId],
      ['CASTLE_KV', c.hasKv]
    ];
    el('secretList').innerHTML = items.map(function(item) {
      return '<div><b>' + item[0] + '</b>: ' + (item[1] ? '<span class="ok">พร้อม</span>' : '<span class="bad">ยังไม่ตั้ง</span>') + '</div>';
    }).join('');

    var rows = (data.state.latestJobs || []).map(function(job) {
      var area = [job.district ? 'อ.' + job.district : '', job.province ? 'จ.' + job.province : ''].filter(Boolean).join(' ');
      var jobText = job.link ? '<a href="' + escapeHtml(job.link) + '" target="_blank" rel="noreferrer">' + escapeHtml(job.jobNumber) + '</a>' : escapeHtml(job.jobNumber);
      return '<tr><td>' + jobText + '</td><td>' + escapeHtml(job.terminalId) + '</td><td>' + escapeHtml(job.merchantName) + '</td><td>' + escapeHtml(area || '-') + '</td><td>' + escapeHtml(job.status || '-') + '</td><td>' + escapeHtml(job.slaDate || '-') + '</td></tr>';
    }).join('');
    el('jobsBody').innerHTML = rows || '<tr><td colspan="6" class="muted">ยังไม่มีข้อมูล</td></tr>';
    el('lastResult').textContent = JSON.stringify(data.lastRun || data, null, 2);
  }

  async function loadStatus() {
    if (!adminKey) {
      el('adminKey').value = '';
      el('loginCard').classList.remove('hide');
      el('dashboard').classList.add('hide');
      return;
    }
    el('adminKey').value = adminKey;
    var data = await api('/api/status');
    renderStatus(data);
  }

  async function toggleSystem(enabled) {
    var msg = enabled ? 'ยืนยันเปิดระบบตรวจงาน?' : 'ยืนยันปิดระบบ? เมื่อปิด cron จะไม่เข้าไปตรวจงานและไม่ส่งแจ้งเตือน';
    if (!confirm(msg)) return;
    var data = await api('/api/toggle', { method: 'POST', body: { enabled: enabled } });
    renderStatus(data.status);
  }

  async function saveSchedule() {
    var minutes = Number(el('intervalMinutes').value);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      return alert('กรุณาใส่รอบตรวจ 1-1440 นาที');
    }
    if (!confirm('ต้องการเปลี่ยนรอบตรวจเป็นทุก ' + Math.floor(minutes) + ' นาที?')) return;
    var data = await api('/api/schedule', { method: 'POST', body: { intervalMinutes: Math.floor(minutes) } });
    renderStatus(data.status);
  }

  async function checkNow() {
    el('lastResult').textContent = 'กำลังตรวจงาน...';
    var data = await api('/api/check', { method: 'POST' });
    el('lastResult').textContent = JSON.stringify(data, null, 2);
    await loadStatus();
  }

  async function resetSeen() {
    if (!confirm('Reset งานที่จำไว้? ครั้งถัดไปจะถือว่าเป็นรอบเริ่มต้นใหม่')) return;
    var data = await api('/api/reset', { method: 'POST' });
    el('lastResult').textContent = JSON.stringify(data, null, 2);
    await loadStatus();
  }

  async function pingTelegram() {
    var data = await api('/api/ping', { method: 'POST' });
    el('lastResult').textContent = JSON.stringify(data, null, 2);
  }

  async function loginDebug() {
    el('lastResult').textContent = 'กำลังทดสอบ login...';
    var data = await api('/api/login-debug', { method: 'POST' });
    el('lastResult').textContent = JSON.stringify(data, null, 2);
  }

  loadStatus().catch(function(err) {
    if (String(err.message) !== 'Unauthorized') alert(err.message || err);
  });
</script>
</body>
</html>`;
}
