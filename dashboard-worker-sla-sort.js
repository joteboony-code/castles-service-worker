import dashboardWorker from "./dashboard-worker.js";

const STATE_KEY = "castle_seen_jobs_v6_new_sla_alert";
const CURRENT_RUN_WINDOW_MS = 2 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      const resp = await dashboardWorker.fetch(request, env, ctx);
      const text = await resp.text();

      if (!resp.ok || !String(resp.headers.get("content-type") || "").includes("text/html")) {
        return new Response(text, {
          status: resp.status,
          headers: resp.headers
        });
      }

      return html(patchDashboardHtml(text), resp.status);
    }

    if (url.pathname === "/api/status") {
      const resp = await dashboardWorker.fetch(request, env, ctx);
      const text = await resp.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return new Response(text, {
          status: resp.status,
          headers: resp.headers
        });
      }

      if (resp.ok && data && data.state) {
        const state = await readJsonKv(env, STATE_KEY, {});
        const jobs = Object.values(state.jobs || {});
        const currentActiveJobs = getCurrentRunJobs(jobs, state)
          .filter(job => !isQcStatus(job.status));

        data.state.latestJobs = currentActiveJobs
          .sort((a, b) => {
            const diff = parseCastleSlaTime(b.slaDate) - parseCastleSlaTime(a.slaDate);
            if (diff !== 0) return diff;
            return String(b.jobNumber || "").localeCompare(String(a.jobNumber || ""));
          })
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
      }

      return json(data, resp.status);
    }

    return dashboardWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return dashboardWorker.scheduled(controller, env, ctx);
  }
};

function patchDashboardHtml(text) {
  let htmlText = String(text || "");

  htmlText = htmlText.replace(
    '<div id="systemBadge" class="badge"><span class="dot"></span><span>ยังไม่ได้โหลด</span></div>',
    '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap"><button id="logoutBtn" class="btn-dark" style="display:none" onclick="logoutDashboard()">ออกระบบ</button><div id="systemBadge" class="badge"><span class="dot"></span><span>ยังไม่ได้โหลด</span></div></div>'
  );

  htmlText = htmlText.replace(
    'ระบบจะเก็บ key ไว้เฉพาะใน browser เครื่องนี้ด้วย sessionStorage ไม่ได้บันทึกลง Worker',
    'ระบบจะใช้ key เฉพาะตอนเปิดหน้านี้เท่านั้น ไม่บันทึกลง browser และไม่บันทึกลง Worker'
  );

  htmlText = htmlText.replace(
    "var adminKey = sessionStorage.getItem('castleAdminKey') || '';",
    "var adminKey = '';"
  );

  htmlText = htmlText.replace(
    "    sessionStorage.setItem('castleAdminKey', adminKey);\n    history.replaceState(null, '', location.pathname);",
    "    history.replaceState(null, '', location.pathname);"
  );

  htmlText = htmlText.replace(
    "    sessionStorage.setItem('castleAdminKey', adminKey);\n    loadStatus();",
    "    loadStatus();"
  );

  htmlText = htmlText.replace(
    "      sessionStorage.removeItem('castleAdminKey');\n      el('loginCard').classList.remove('hide');",
    "      adminKey = '';\n      el('loginCard').classList.remove('hide');"
  );

  htmlText = htmlText.replace(
    'function renderStatus(data) {',
    'function renderStatus(data) {\n    var logoutBtn = document.getElementById(\'logoutBtn\');\n    if (logoutBtn) logoutBtn.style.display = \'inline-block\';'
  );

  htmlText = htmlText.replace(
    '  async function api(path, options) {',
    `  var adminKeyInput = document.getElementById('adminKey');
  if (adminKeyInput) {
    adminKeyInput.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveKey();
      }
    });
  }

  async function api(path, options) {`
  );

  htmlText = htmlText.replace(
    '  loadStatus().catch(function(err) {',
    `  function logoutDashboard() {
    if (!confirm('ออกจากระบบ Dashboard?')) return;
    adminKey = '';
    el('adminKey').value = '';
    el('loginCard').classList.remove('hide');
    el('dashboard').classList.add('hide');
    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'none';
    var badge = el('systemBadge');
    if (badge) {
      badge.className = 'badge';
      badge.querySelector('span:last-child').textContent = 'ยังไม่ได้โหลด';
    }
  }

  loadStatus().catch(function(err) {`
  );

  return htmlText;
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

function getCurrentRunJobs(jobs, state) {
  if (state.currentRunId) {
    return jobs.filter(job => job.currentRunId === state.currentRunId);
  }

  const stateUpdatedAt = parseIsoTime(state.updatedAt);
  if (!stateUpdatedAt) {
    return jobs;
  }

  const minSeenAt = stateUpdatedAt - CURRENT_RUN_WINDOW_MS;
  return jobs.filter(job => {
    const lastSeenAt = parseIsoTime(job.lastSeenAt);
    return lastSeenAt && lastSeenAt >= minSeenAt;
  });
}

function isQcStatus(value) {
  return String(value || "").trim().toUpperCase() === "QC";
}

function parseIsoTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function parseCastleSlaTime(value) {
  const text = String(value || "").trim();
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return 0;

  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);

  if (year > 2400) year -= 543;

  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return 0;
  }

  return Date.UTC(year, month - 1, day, hour - 7, minute, 0);
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
