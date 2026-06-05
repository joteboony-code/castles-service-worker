import dashboardWorker from "./dashboard-worker.js";

const STATE_KEY = "castle_seen_jobs_v6_new_sla_alert";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

        data.state.latestJobs = jobs
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

async function readJsonKv(env, key, fallback) {
  const raw = await env.CASTLE_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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
