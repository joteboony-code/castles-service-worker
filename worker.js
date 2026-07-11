const BASE_URL = "https://www.castles-th.com";
const JOB_PAGE = "https://www.castles-th.com/showarea/3";
const STATE_KEY = "castle_seen_jobs_v6_new_sla_alert";
const NOTIFICATION_CONFIG_KEY = "castle_notification_config_v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      if (!checkAdmin(url, env)) return new Response("Unauthorized", { status: 401 });
      await sendTelegram(env, "✅ ทดสอบแจ้งเตือน Telegram จาก Worker สำเร็จ");
      return json({ ok: true, message: "telegram sent" });
    }

    if (url.pathname === "/login-debug") {
      if (!checkAdmin(url, env)) return new Response("Unauthorized", { status: 401 });
      return json(await loginDebug(env));
    }

    if (url.pathname === "/debug") {
      if (!checkAdmin(url, env)) return new Response("Unauthorized", { status: 401 });
      return json(await debugCastle(env));
    }

    if (url.pathname === "/check") {
      if (!checkAdmin(url, env)) return new Response("Unauthorized", { status: 401 });
      return json(await checkCastleJobs(env, { manual: true }));
    }

    if (url.pathname === "/reset") {
      if (!checkAdmin(url, env)) return new Response("Unauthorized", { status: 401 });
      await env.CASTLE_KV.delete(STATE_KEY);
      return json({ ok: true, message: "reset seen jobs complete" });
    }

    return new Response(
      [
        "Castle Service Telegram Checker is running.",
        "",
        "Use:",
        "/ping?key=ADMIN_KEY",
        "/login-debug?key=ADMIN_KEY",
        "/debug?key=ADMIN_KEY",
        "/check?key=ADMIN_KEY",
        "/reset?key=ADMIN_KEY"
      ].join("\n"),
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(checkCastleJobs(env, { manual: false }));
  }
};

function checkAdmin(url, env) {
  return env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
}

async function loginDebug(env) {
  const jar = new CookieJar();

  const resp = await fetchWithCookies(env.CASTLE_LOGIN_URL || `${BASE_URL}/login`, {
    method: "GET",
    headers: { "user-agent": "Mozilla/5.0 CastleChecker/1.0" }
  }, jar);

  const html = await resp.text();

  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map((m, i) => {
    const formHtml = m[0];
    const action = extractFormAction(formHtml) || "";
    const method = (formHtml.match(/method=["']([^"']+)["']/i)?.[1] || "GET").toUpperCase();

    const inputs = [...formHtml.matchAll(/<input[^>]*>/gi)].map(x => {
      const tag = x[0];
      return {
        type: getAttr(tag, "type") || "",
        name: getAttr(tag, "name") || "",
        id: getAttr(tag, "id") || "",
        valuePreview: (getAttr(tag, "value") || "").slice(0, 30)
      };
    });

    return { index: i, action, method, inputs };
  });

  return {
    ok: true,
    status: resp.status,
    title: getTitle(html),
    cookieNames: jar.names(),
    forms
  };
}

async function debugCastle(env) {
  const loginResult = await loginCastle(env);

  if (!loginResult.ok) {
    return {
      ok: false,
      step: "login",
      error: loginResult.error,
      debug: loginResult.debug || null
    };
  }

  const jar = loginResult.jar;

  const pageResp = await fetchWithCookies(JOB_PAGE, {
    method: "GET",
    headers: {
      "user-agent": "Mozilla/5.0 CastleChecker/1.0",
      "referer": BASE_URL
    }
  }, jar);

  const html = await pageResp.text();
  const clean = cleanText(stripTags(html));

  const jobs = /SERV\d+/i.test(html) ? parseJobs(html) : [];

  let sampleDetail = null;
  if (jobs.length && jobs[0].link && jobs[0].link !== JOB_PAGE) {
    sampleDetail = await fetchJobDetail(jobs[0], jar);
  }

  const state = await getState(env);

  return {
    ok: true,
    login: "passed",
    jobPageStatus: pageResp.status,
    jobPageUrl: pageResp.url,
    redirectedLocation: pageResp.headers.get("location") || "",
    cookieNames: jar.names(),
    hasSERV: /SERV\d+/i.test(html),
    hasShowDisplayLink: /showdisplayca\/\d+/i.test(html),
    hasLoginText: /login|username|password|sign in|เข้าสู่ระบบ/i.test(html),
    hasTable: /<table/i.test(html),
    hasAjax: /ajax|datatable|axios|fetch|showarea|api/i.test(html),
    parsedJobs: jobs.length,
    slaAlertMinutes: getSlaAlertMinutes(env),
    stateUpdatedAt: state.updatedAt || "",
    sampleJobs: jobs.slice(0, 3),
    sampleDetail,
    title: getTitle(html),
    sampleText: clean.slice(0, 2500),
    sampleHtml: html.slice(0, 2500)
  };
}

async function checkCastleJobs(env, options = {}) {
  try {
    const loginResult = await loginCastle(env);

    if (!loginResult.ok) {
      const msg = `❌ Castle Login ไม่สำเร็จ\n\nรายละเอียด: ${loginResult.error}`;
      await safeSendTelegram(env, msg);
      return {
        ok: false,
        step: "login",
        error: loginResult.error,
        debug: loginResult.debug || null
      };
    }

    const jar = loginResult.jar;

    const pageResp = await fetchWithCookies(JOB_PAGE, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 CastleChecker/1.0",
        "referer": BASE_URL
      }
    }, jar);

    const html = await pageResp.text();

    if (!/SERV\d+/i.test(html)) {
      const message = "⚠️ เช็ก Service Castle แล้ว แต่ไม่พบข้อมูลงาน หรือหน้าเว็บอาจเปลี่ยนรูปแบบ";
      await safeSendTelegram(env, message);

      return {
        ok: false,
        step: "fetch_jobs",
        error: "No SERV job found in page",
        status: pageResp.status,
        url: pageResp.url,
        title: getTitle(html),
        hasLoginText: /login|username|password|sign in|เข้าสู่ระบบ/i.test(html),
        sampleText: cleanText(stripTags(html)).slice(0, 1500)
      };
    }

    const jobs = parseJobs(html);

    if (!jobs.length) {
      const message = "⚠️ พบคำว่า SERV ในหน้า Castle แต่แยกข้อมูลงานจากตารางไม่ได้";
      await safeSendTelegram(env, message);

      return {
        ok: false,
        step: "parse_jobs",
        error: "Found SERV but parsed jobs = 0",
        sampleText: cleanText(stripTags(html)).slice(0, 1500)
      };
    }

    const oldState = await getState(env);
    const oldJobs = oldState.jobs || {};

    const firstRun = !oldState.updatedAt;
    const newJobs = [];
    const slaAlerts = [];
    let changedStatusCount = 0;

    const now = new Date();
    const slaAlertMinutes = getSlaAlertMinutes(env);

    for (const job of jobs) {
      const old = oldJobs[job.jobNumber];

      if (!old) {
        if (!firstRun) {
          const detail = await fetchJobDetail(job, jar);

          job.district = detail.district || job.district || "";
          job.province = detail.province || job.province || "";
          job.address = detail.address || "";
          job.problem = detail.problem || job.problem || "";
          job.contactName = detail.contactName || job.contactName || "";
          job.contactPhone = detail.contactPhone || job.contactPhone || "";

          newJobs.push(job);
          await sleep(200);
        }

        oldJobs[job.jobNumber] = {
          ...job,
          slaNotified: {},
          lastSeenAt: new Date().toISOString()
        };

        continue;
      }

      if ((old.status || "") !== (job.status || "")) {
        changedStatusCount++;
      }

      const mergedJob = {
        ...old,
        ...job,
        slaNotified: old.slaNotified || {},
        lastSeenAt: new Date().toISOString()
      };

      if (!firstRun) {
        const alert = getDueSlaAlert(mergedJob, slaAlertMinutes, now);

        if (alert) {
          const detail = await fetchJobDetail(mergedJob, jar);

          mergedJob.district = detail.district || mergedJob.district || "";
          mergedJob.province = detail.province || mergedJob.province || "";
          mergedJob.address = detail.address || "";
          mergedJob.problem = detail.problem || mergedJob.problem || "";
          mergedJob.contactName = detail.contactName || mergedJob.contactName || "";
          mergedJob.contactPhone = detail.contactPhone || mergedJob.contactPhone || "";

          slaAlerts.push({
            job: mergedJob,
            alert
          });

          mergedJob.slaNotified = {
            ...(mergedJob.slaNotified || {}),
            [alert.key]: new Date().toISOString()
          };

          await sleep(200);
        }
      }

      oldJobs[job.jobNumber] = mergedJob;
    }

    await env.CASTLE_KV.put(
      STATE_KEY,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        jobs: oldJobs
      })
    );

    if (firstRun) {
      await safeSendTelegram(
        env,
        [
          "✅ เริ่มระบบเช็ก Service Castle แล้ว",
          "",
          `พบงานในหน้าปัจจุบัน: ${jobs.length} รายการ`,
          "ระบบจะเริ่มแจ้งเฉพาะเมื่องานใหม่เข้า และแจ้งเตือน SLA ใกล้หมด",
          "",
          `SLA Alert: ${slaAlertMinutes.map(formatAlertMinuteLabel).join(", ")}`,
          "",
          "หมายเหตุ: ครั้งแรกระบบจะบันทึกงานเดิมไว้ก่อน เพื่อกันแจ้งซ้ำทั้งหมด"
        ].join("\n")
      );

      return {
        ok: true,
        firstRun: true,
        totalJobs: jobs.length,
        newJobs: 0,
        slaAlerts: 0,
        changedStatus: changedStatusCount,
        notified: 1,
        sampleJobs: jobs.slice(0, 3)
      };
    }

    let notifyCount = 0;

    const notificationConfig = await getNotificationConfig(env);

    for (const job of newJobs) {
      if (!shouldNotifySupportedProvince(job, notificationConfig)) continue;

      await safeSendTelegram(env, formatNewJobMessage(job, notificationConfig), makeOpenJobKeyboard(job));
      notifyCount++;
      await sleep(450);
    }

    for (const item of slaAlerts) {
      if (!shouldNotifySupportedProvince(item.job, notificationConfig)) continue;

      await safeSendTelegram(env, formatSlaAlertMessage(item.job, item.alert, notificationConfig), makeOpenJobKeyboard(item.job));
      notifyCount++;
      await sleep(450);
    }

    if (options.manual && notifyCount === 0) {
      await safeSendTelegram(
        env,
        [
          "✅ เช็ก Service Castle แล้ว",
          "",
          "ไม่พบงานใหม่/แจ้งเตือน SLA สำหรับจังหวัดชลบุรีและระยอง",
          `งานในหน้าปัจจุบัน: ${jobs.length} รายการ`
        ].join("\n")
      );
    }

    return {
      ok: true,
      totalJobs: jobs.length,
      newJobs: newJobs.length,
      slaAlerts: slaAlerts.length,
      changedStatus: changedStatusCount,
      notified: notifyCount,
      slaAlertMinutes,
      sampleNewJobs: newJobs.slice(0, 3),
      sampleSlaAlerts: slaAlerts.slice(0, 3),
      sampleJobs: jobs.slice(0, 3)
    };
  } catch (err) {
    const message = `❌ Worker เช็ก Castle ผิดพลาด\n\n${err.message || String(err)}`;
    await safeSendTelegram(env, message);

    return {
      ok: false,
      step: "exception",
      error: err.message || String(err)
    };
  }
}

function getSlaAlertMinutes(env) {
  const raw = env.SLA_ALERT_MINUTES || "360,180,60,30,10";

  const values = String(raw)
    .split(",")
    .map(x => Number(String(x).trim()))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a);

  return values.length ? values : [360, 180, 60, 30, 10];
}

function getDueSlaAlert(job, alertMinutes, now = new Date()) {
  const slaDate = parseThaiDateTime(job.slaDate);
  if (!slaDate) return null;

  const diffMs = slaDate.getTime() - now.getTime();
  const diffMinutes = Math.ceil(diffMs / 60000);

  if (diffMinutes <= 0) return null;

  const notified = job.slaNotified || {};

  // เลือกระดับแจ้งเตือนที่ใกล้เวลาจริงที่สุดเท่านั้น
  // เช่น เหลือ 113 นาที → เลือก 180 นาที ไม่ใช่ 360 นาที
  const sortedAsc = [...alertMinutes].sort((a, b) => a - b);
  const matchedThreshold = sortedAsc.find(threshold => diffMinutes <= threshold);

  if (!matchedThreshold) return null;

  const key = `before_${matchedThreshold}`;
  if (notified[key]) return null;

  return {
    key,
    threshold: matchedThreshold,
    diffMinutes,
    slaDate
  };
}

function parseThaiDateTime(value) {
  const text = cleanText(value || "");

  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;

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
    return null;
  }

  // ใช้เวลาไทย GMT+7 โดยสร้างจาก UTC
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute, 0));
}

function formatRemainingTime(minutes) {
  const m = Math.max(0, Math.ceil(minutes));
  const h = Math.floor(m / 60);
  const mm = m % 60;

  if (h > 0 && mm > 0) return `${h} ชั่วโมง ${mm} นาที`;
  if (h > 0) return `${h} ชั่วโมง`;
  return `${mm} นาที`;
}

function formatAlertMinuteLabel(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60} ชม.`;
  }
  if (minutes > 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h} ชม. ${m} นาที`;
  }
  return `${minutes} นาที`;
}

function formatSlaAlertMessage(job, alert, notificationConfig = null) {
  const remainingText = formatRemainingTime(alert.diffMinutes);

  return [
    `⏰ SLA เหลือเวลา ${remainingText}`,
    "",
    formatMentionLine(job, notificationConfig),
    `Terminal ID: ${job.terminalId || "-"}`,
    `Merchant: ${job.merchantName || "-"}`,
    formatAreaLine(job),
    `ชื่อผู้ติดต่อ: ${job.contactName || "-"}`,
    `เบอร์ผู้ติดต่อ: ${job.contactPhone || "-"}`,
    `SLA: ${job.slaDate || "-"}`,
    `Service: ${job.serviceCode || "-"}`,
    `ปัญหา: ${job.problem || cleanProblemText(job.serviceCode)}`
  ].filter(Boolean).join("\n");
}



function extractContactFromHtmlOrText(html, text) {
  const fromTable = extractContactFromTableCells(html);
  const fromText = extractContactFromText(text);

  return {
    contactName: fromTable.contactName || fromText.contactName || "",
    contactPhone: fromTable.contactPhone || fromText.contactPhone || ""
  };
}

function extractContactFromTableCells(html) {
  const rows = [...String(html || "").matchAll(/<tr[\s\S]*?<\/tr>/gi)];
  const nameCandidates = [];
  const phoneCandidates = [];

  for (const rowMatch of rows) {
    const rowHtml = rowMatch[0];
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi)]
      .map(m => cleanText(stripTags(m[0])))
      .filter(Boolean);

    for (let i = 0; i < cells.length; i++) {
      const label = cells[i].replace(/\s+/g, " ").replace(/[:：]\s*$/, "").trim();
      const value = cells[i + 1] || "";

      // จาก HTML จริง:
      // <td>ชื่อผู้ติดต่อ :</td><td>...</td>
      // <td>เบอร์ผู้ติดต่อ:</td><td>...</td>
      if (label === "ชื่อผู้ติดต่อ" || /^Contact Name$/i.test(label)) {
        nameCandidates.push({
          value: cleanupContactValue(value),
          score: 300
        });
      }

      if (label === "เบอร์ผู้ติดต่อ" || label === "เบอร์ติดต่อ" || /^Contact Phone$/i.test(label)) {
        phoneCandidates.push({
          value: cleanupPhoneValue(value),
          score: 300
        });
      }
    }
  }

  const text = cleanText(stripTags(html));
  const fromText = extractContactFromText(text);
  if (fromText.contactName) nameCandidates.push({ value: fromText.contactName, score: 50 });
  if (fromText.contactPhone) phoneCandidates.push({ value: fromText.contactPhone, score: 50 });

  return {
    contactName: chooseBestContactName(nameCandidates),
    contactPhone: chooseBestPhone(phoneCandidates)
  };
}

function chooseBestContactName(candidates) {
  const cleaned = candidates
    .map(c => ({
      value: cleanupContactValue(typeof c === "string" ? c : c.value),
      score: typeof c === "string" ? 0 : c.score || 0
    }))
    .filter(c => c.value)
    .filter(c => isGoodContactName(c.value));

  if (!cleaned.length) return "";

  cleaned.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const slashA = (a.value.match(/\//g) || []).length;
    const slashB = (b.value.match(/\//g) || []).length;
    if (slashA !== slashB) return slashA - slashB;

    return a.value.length - b.value.length;
  });

  return cleaned[0].value;
}

function chooseBestPhone(candidates) {
  const cleaned = candidates
    .map(c => ({
      value: cleanupPhoneValue(typeof c === "string" ? c : c.value),
      score: typeof c === "string" ? 0 : c.score || 0
    }))
    .filter(c => c.value);

  if (!cleaned.length) return "";

  cleaned.sort((a, b) => b.score - a.score);
  return cleaned[0].value;
}

function isGoodContactName(value) {
  const s = cleanText(value || "");
  if (!s) return false;
  if (s.length > 80) return false;

  if (/(เบอร์|โทร|Tel|Phone|Mobile|รายละเอียด|ปัญหา|วิธีการแก้ไข|เวลาเปิดทำการ|SLA|Service|Job|Ticket|Category)/i.test(s)) {
    return false;
  }

  const slashCount = (s.match(/\//g) || []).length;
  if (slashCount >= 4) return false;

  return true;
}

function extractContactFromText(text) {
  const raw = cleanText(text || "");

  let contactName = "";
  let contactPhone = "";

  const namePatterns = [
    /ชื่อผู้ติดต่อ\s*[:：]?\s*([ก-๙A-Za-z0-9 ._\-\/]{2,80}?)(?=\s*(?:เบอร์ผู้ติดต่อ|เบอร์ติดต่อ|โทร|รายละเอียดปัญหา|วิธีการแก้ไข|ปัญหา|Service SLA|SLA|$))/i,
    /Contact Name\s*[:：]?\s*([ก-๙A-Za-z0-9 ._\-\/]{2,80}?)(?=\s*(?:Tel|Phone|Mobile|Problem|Issue|Service SLA|SLA|$))/i
  ];

  for (const pattern of namePatterns) {
    const m = raw.match(pattern);
    if (m && m[1]) {
      contactName = cleanupContactValue(m[1]);
      break;
    }
  }

  const phonePatterns = [
    /เบอร์ผู้ติดต่อ\s*[:：]?\s*([0-9+\-\s/]{8,50})/i,
    /เบอร์ติดต่อ\s*[:：]?\s*([0-9+\-\s/]{8,50})/i,
    /Tel\s*[:：]?\s*([0-9+\-\s/]{8,50})/i,
    /Phone\s*[:：]?\s*([0-9+\-\s/]{8,50})/i,
    /Mobile\s*[:：]?\s*([0-9+\-\s/]{8,50})/i
  ];

  for (const pattern of phonePatterns) {
    const m = raw.match(pattern);
    if (m && m[1]) {
      contactPhone = cleanupPhoneValue(m[1]);
      break;
    }
  }

  return {
    contactName,
    contactPhone
  };
}

function cleanupContactValue(value) {
  let s = cleanText(value || "");

  s = s
    .replace(/เบอร์ผู้ติดต่อ.*$/i, "")
    .replace(/เบอร์ติดต่อ.*$/i, "")
    .replace(/โทร.*$/i, "")
    .replace(/Tel.*$/i, "")
    .replace(/Phone.*$/i, "")
    .replace(/Mobile.*$/i, "")
    .replace(/รายละเอียด.*$/i, "")
    .replace(/ปัญหา.*$/i, "")
    .replace(/วิธีการแก้ไข.*$/i, "")
    .replace(/เวลาเปิดทำการ.*$/i, "")
    .trim();

  s = s.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();

  if (s.length > 80) s = s.slice(0, 80).trim();

  return s;
}

function cleanupPhoneValue(value) {
  let s = cleanText(value || "");
  const m = s.match(/[0-9+\-\s]{8,30}/);
  if (!m) return "";

  s = m[0].replace(/\s+/g, "").trim();

  return s;
}


async function fetchJobDetail(job, jar) {
  try {
    if (!job.link || job.link === JOB_PAGE) {
      return {
        ok: false,
        reason: "no detail link",
        district: job.district || "",
        province: job.province || "",
        problem: job.problem || "",
        contactName: job.contactName || "",
        contactPhone: job.contactPhone || ""
      };
    }

    const resp = await fetchWithCookies(job.link, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 CastleChecker/1.0",
        "referer": JOB_PAGE
      }
    }, jar);

    const html = await resp.text();
    const text = cleanText(stripTags(html));

    const location = extractLocationFromText(text);
    const contact = extractContactFromHtmlOrText(html, text);
    const problem = extractProblemFromText(text);

    return {
      ok: true,
      status: resp.status,
      title: getTitle(html),
      district: location.district || "",
      province: location.province || "",
      address: location.address || "",
      problem: problem || "",
      contactName: contact.contactName || "",
      contactPhone: contact.contactPhone || "",
      sampleText: text.slice(0, 1200)
    };
  } catch (err) {
    return {
      ok: false,
      reason: err.message || String(err),
      district: job.district || "",
      province: job.province || "",
      problem: job.problem || "",
      contactName: job.contactName || "",
      contactPhone: job.contactPhone || ""
    };
  }
}

async function loginCastle(env) {
  try {
    if (!env.CASTLE_USERNAME || !env.CASTLE_PASSWORD) {
      return { ok: false, error: "Missing CASTLE_USERNAME or CASTLE_PASSWORD" };
    }

    const jar = new CookieJar();

    const loginPageUrl = env.CASTLE_LOGIN_URL || `${BASE_URL}/login`;

    const loginPageResp = await fetchWithCookies(loginPageUrl, {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0 CastleChecker/1.0" }
    }, jar);

    const loginHtml = await loginPageResp.text();

    const formAction = extractFormAction(loginHtml) || loginPageUrl;
    const loginPostUrl = new URL(formAction, loginPageUrl).href;

    const hiddenFields = extractHiddenInputs(loginHtml);
    const form = new URLSearchParams();

    for (const [k, v] of Object.entries(hiddenFields)) {
      form.set(k, v);
    }

    const usernameField = env.CASTLE_USER_FIELD || "user_name";
    const passwordField = env.CASTLE_PASS_FIELD || "password";

    form.set(usernameField, env.CASTLE_USERNAME);
    form.set(passwordField, env.CASTLE_PASSWORD);

    const loginResp = await fetchWithCookies(loginPostUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 CastleChecker/1.0",
        "referer": loginPageUrl,
        "origin": BASE_URL
      },
      body: form.toString()
    }, jar);

    const loginRespText = await loginResp.clone().text();

    const jobResp = await fetchWithCookies(JOB_PAGE, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 CastleChecker/1.0",
        "referer": loginPostUrl
      }
    }, jar);

    const jobHtml = await jobResp.clone().text();

    const stillLogin =
      /username|password|sign in|login|เข้าสู่ระบบ/i.test(jobHtml) &&
      !/SERV\d+/i.test(jobHtml);

    const error500NoUser =
      jobResp.status >= 500 &&
      /user_role|non-object|เกิดข้อผิดพลาด/i.test(jobHtml);

    if (stillLogin || error500NoUser) {
      return {
        ok: false,
        error: error500NoUser
          ? "ล็อกอินแล้ว session ยังไม่สมบูรณ์ เว็บขึ้น user_role of non-object"
          : "ล็อกอินแล้ว แต่ยังถูกส่งกลับหน้า Login",
        debug: {
          loginPageUrl,
          loginPostUrl,
          usernameField,
          passwordField,
          loginStatus: loginResp.status,
          jobPageStatus: jobResp.status,
          jobPageUrl: jobResp.url,
          loginTitle: getTitle(loginRespText),
          jobTitle: getTitle(jobHtml),
          jobSampleText: cleanText(stripTags(jobHtml)).slice(0, 1200),
          cookieNames: jar.names()
        }
      };
    }

    return {
      ok: true,
      jar,
      debug: {
        loginPageUrl,
        loginPostUrl,
        usernameField,
        passwordField,
        loginStatus: loginResp.status,
        jobPageStatus: jobResp.status,
        cookieNames: jar.names()
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err)
    };
  }
}

async function fetchWithCookies(input, init = {}, jar, maxRedirects = 8) {
  let url = input;
  let opts = { ...init };

  for (let i = 0; i <= maxRedirects; i++) {
    const headers = new Headers(opts.headers || {});
    const cookieHeader = jar.header();

    if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }

    const resp = await fetch(url, {
      ...opts,
      headers,
      redirect: "manual"
    });

    jar.addFromResponse(resp);

    if (![301, 302, 303, 307, 308].includes(resp.status)) {
      return resp;
    }

    const location = resp.headers.get("location");

    if (!location) {
      return resp;
    }

    url = new URL(location, url).href;

    if (resp.status === 303 || resp.status === 301 || resp.status === 302) {
      opts = {
        method: "GET",
        headers: opts.headers || {}
      };
    }
  }

  throw new Error("Too many redirects");
}

function parseJobs(html) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const jobs = [];

  for (const row of rows) {
    if (!/SERV\d+/i.test(row)) continue;

    const cells = extractCells(row);
    const text = cleanText(stripTags(row));

    const jobNumberMatch = text.match(/SERV\d+/i);
    const jobNumber = jobNumberMatch ? jobNumberMatch[0].toUpperCase() : "";

    if (!jobNumber) continue;

    const terminalId = findTerminalId(cells);
    const link = findBestLink(row, jobNumber) || JOB_PAGE;
    const internalJobId = extractInternalJobId(link);

    const jobIndex = cells.findIndex(c => c.includes(jobNumber));

    const merchantName = jobIndex > 0 ? cells[jobIndex - 1] : "";
    const openDate = jobIndex >= 0 && cells[jobIndex + 1] ? cells[jobIndex + 1] : "";
    const slaDate = jobIndex >= 0 && cells[jobIndex + 2] ? cells[jobIndex + 2] : "";
    const status = jobIndex >= 0 && cells[jobIndex + 3] ? cells[jobIndex + 3] : "";
    const serviceCode = jobIndex >= 0 && cells[jobIndex + 4] ? cells[jobIndex + 4] : "";

    const province = extractProvinceFromJob({ merchantName, serviceCode }, cells);
    const district = extractDistrictFromJob({ merchantName, serviceCode }, cells);

    jobs.push({
      terminalId,
      merchantName,
      province,
      district,
      jobNumber,
      internalJobId,
      openDate,
      slaDate,
      status,
      serviceCode,
      contactName: "",
      contactPhone: "",
      problem: "",
      link
    });
  }

  const unique = {};
  for (const job of jobs) {
    unique[job.jobNumber] = job;
  }

  return Object.values(unique);
}

function extractCells(rowHtml) {
  const matches = rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];

  return matches
    .map(cell => cleanText(stripTags(cell)))
    .filter(Boolean);
}

function findBestLink(rowHtml, jobNumber) {
  const html = String(rowHtml || "");

  const directShowDisplay = html.match(/(?:href=["']|["'])(\/showdisplayca\/\d+)(?:["'])/i);
  if (directShowDisplay && directShowDisplay[1]) {
    return new URL(directShowDisplay[1], BASE_URL).href;
  }

  const fullShowDisplay = html.match(/https:\/\/www\.castles-th\.com\/showdisplayca\/\d+/i);
  if (fullShowDisplay && fullShowDisplay[0]) {
    return fullShowDisplay[0];
  }

  const anyShowDisplay = html.match(/showdisplayca\/(\d+)/i);
  if (anyShowDisplay && anyShowDisplay[1]) {
    return `${BASE_URL}/showdisplayca/${anyShowDisplay[1]}`;
  }

  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)]
    .map(m => m[1])
    .filter(Boolean);

  if (links.length) {
    const showDisplayLink =
      links.find(h => /showdisplayca\/\d+/i.test(h)) ||
      links.find(h => h.includes(jobNumber)) ||
      links.find(h => /job|serv|detail|edit|view|show/i.test(h)) ||
      links[0];

    try {
      return new URL(showDisplayLink, BASE_URL).href;
    } catch {
      return JOB_PAGE;
    }
  }

  return JOB_PAGE;
}

function extractInternalJobId(link) {
  const m = String(link || "").match(/showdisplayca\/(\d+)/i);
  return m ? m[1] : "";
}

function extractProvinceFromJob(job, cells = []) {
  const text = [
    job.merchantName || "",
    job.serviceCode || "",
    ...(cells || [])
  ].join(" ");

  return extractProvinceFromText(text);
}

function extractDistrictFromJob(job, cells = []) {
  const text = [
    job.merchantName || "",
    job.serviceCode || "",
    ...(cells || [])
  ].join(" ");

  return extractLocationFromText(text).district || "";
}

function extractLocationFromText(text) {
  const raw = cleanText(text || "");

  let address = "";

  const addressPatterns = [
    /Site Address\s*[:：]?\s*(.{5,500}?)(?:Service SLA|SLA|Job No|Request Date|Plan Date|S\/N|$)/i,
    /ที่อยู่\s*[:：]?\s*(.{5,500}?)(?:Service SLA|SLA|หมายเลขงาน|Job No|Request Date|Plan Date|$)/i,
    /Address\s*[:：]?\s*(.{5,500}?)(?:Service SLA|SLA|Job No|Request Date|Plan Date|$)/i
  ];

  for (const pattern of addressPatterns) {
    const m = raw.match(pattern);
    if (m && m[1]) {
      address = cleanText(m[1]);
      break;
    }
  }

  if (!address) {
    address = raw;
  }

  const province = extractProvinceFromText(address) || extractProvinceFromText(raw);
  const district = extractDistrictFromAddress(address, province);

  return {
    district,
    province,
    address
  };
}

function extractDistrictFromAddress(address, province = "") {
  const text = cleanText(address || "");

  // เน้นจับอำเภอจากรูปแบบจริงในเว็บ Castle เช่น "ต.นาเกลือ อ.บางละมุง จ.ชลบุรี"
  // ต้องมี "อ." หรือ "อำเภอ" และตัดก่อน "จ." / "จังหวัด"
  const strictPatterns = [
    /(?:^|\s|[ก-๙A-Za-z0-9])(?:อำเภอ|อ\.)\s*([ก-๙A-Za-z0-9 .\-]{1,50}?)(?=\s*(?:จ\.|จังหวัด|Service SLA|SLA|$))/i,
    /(?:^|\s|[ก-๙A-Za-z0-9])(?:เขต)\s*([ก-๙A-Za-z0-9 .\-]{1,50}?)(?=\s*(?:จ\.|จังหวัด|กรุงเทพ|Service SLA|SLA|$))/i,
    /(?:^|\s)(?:District|Amphoe|Amphur|Khet)\s*[:：\-]?\s*([A-Za-z0-9 .\-]{1,50}?)(?=\s*(?:Province|Service SLA|SLA|$))/i
  ];

  for (const pattern of strictPatterns) {
    const m = text.match(pattern);
    if (m && m[1]) {
      const cleaned = cleanupLocationValue(m[1], province);
      if (isValidDistrict(cleaned)) return cleaned;
    }
  }

  // ถ้ามีหลาย "อ." ให้เอาตัวท้ายสุด เพราะมักเป็นอำเภอจริงหลังตำบล
  const allDistricts = [...text.matchAll(/(?:^|\s|[ก-๙A-Za-z0-9])(?:อำเภอ|อ\.)\s*([ก-๙A-Za-z0-9 .\-]{1,50})/gi)];
  for (let i = allDistricts.length - 1; i >= 0; i--) {
    const cleaned = cleanupLocationValue(allDistricts[i][1], province);
    if (isValidDistrict(cleaned)) return cleaned;
  }

  return "";
}

function isValidDistrict(value) {
  const s = cleanText(value || "");
  if (!s) return false;
  if (s.length > 30) return false;

  // กันกรณีจับยาวผิดเป็นชื่อห้าง/ชั้น/ห้อง/ตำบลแทนอำเภอ
  if (/(ต\.|ตำบล|แขวง|หมู่|ถนน|ถ\.|ซอย|ซ\.|ห้อง|ชั้น|ช\.|TERMINAL|เทอร์มินอล|BUILDING|FLOOR|ROOM)/i.test(s)) {
    return false;
  }

  return true;
}

function cleanupLocationValue(value, province = "") {
  let s = cleanText(value || "");

  s = s
    .replace(/^(อำเภอ|อ\.|เขต|AMPHOE|AMPHUR|DISTRICT|KHET)\s*/i, "")
    .replace(/(?:จ\.|จังหวัด)\s*[ก-๙A-Za-z .\-]+.*$/i, "")
    .replace(/\s+(?:ต\.|ตำบล|แขวง)\s+.*$/i, "")
    .replace(/\s+(?:Service SLA|SLA|Service|Job No|Request Date|Plan Date).*$/i, "")
    .replace(/\s+\d{5}.*$/i, "")
    .trim();

  if (province) {
    s = s.replace(new RegExp(province, "i"), "").trim();
  }

  s = s.replace(/[:：\-]+$/g, "").trim();

  if (s.length > 30) {
    s = s.slice(0, 30).trim();
  }

  return s;
}

function extractProvinceFromText(text) {
  const raw = String(text || "");
  const upper = raw.toUpperCase();

  const provinceMap = [
    ["กรุงเทพมหานคร", "กรุงเทพ", "BANGKOK"],
    ["ชลบุรี", "CHONBURI", "CHON BURI"],
    ["ระยอง", "RAYONG"],
    ["จันทบุรี", "CHANTHABURI", "CHANTHAB"],
    ["ตราด", "TRAT"],
    ["ฉะเชิงเทรา", "CHACHOENGSAO"],
    ["ปราจีนบุรี", "PRACHINBURI", "PRACHIN BURI"],
    ["สระแก้ว", "SA KAEO", "SAKAEW"],
    ["นครนายก", "NAKHON NAYOK"],
    ["นครราชสีมา", "NAKHON RATCHASIMA", "KORAT"],
    ["บุรีรัมย์", "BURIRAM"],
    ["สุรินทร์", "SURIN"],
    ["ศรีสะเกษ", "SI SA KET", "SISAKET"],
    ["อุบลราชธานี", "UBON"],
    ["อุดรธานี", "UDON"],
    ["ขอนแก่น", "KHON KAEN"],
    ["เชียงใหม่", "CHIANG MAI"],
    ["เชียงราย", "CHIANG RAI"],
    ["ลำพูน", "LAMPHUN"],
    ["ลำปาง", "LAMPANG"],
    ["พิษณุโลก", "PHITSANULOK"],
    ["นครสวรรค์", "NAKHON SAWAN"],
    ["อยุธยา", "AYUTTHAYA"],
    ["ปทุมธานี", "PATHUM THANI"],
    ["นนทบุรี", "NONTHABURI"],
    ["สมุทรปราการ", "SAMUT PRAKAN"],
    ["สมุทรสาคร", "SAMUT SAKHON"],
    ["นครปฐม", "NAKHON PATHOM"],
    ["ราชบุรี", "RATCHABURI"],
    ["กาญจนบุรี", "KANCHANABURI"],
    ["เพชรบุรี", "PHETCHABURI"],
    ["ประจวบคีรีขันธ์", "PRACHUAP"],
    ["สุราษฎร์ธานี", "SURAT"],
    ["ภูเก็ต", "PHUKET"],
    ["สงขลา", "SONGKHLA"],
    ["หาดใหญ่", "HATYAI", "HAT YAI"],
    ["ยะลา", "YALA"],
    ["ปัตตานี", "PATTANI"],
    ["นราธิวาส", "NARATHIWAT"]
  ];

  for (const item of provinceMap) {
    const provinceThai = item[0];
    const keywords = item.slice(1);

    if (raw.includes(provinceThai)) {
      return provinceThai;
    }

    for (const keyword of keywords) {
      if (upper.includes(keyword.toUpperCase())) {
        return provinceThai;
      }
    }
  }

  return "";
}



function extractProblemFromText(text) {
  const raw = cleanText(text || "");

  const patterns = [
    /ปัญหา\s*[:：]\s*(.{2,500}?)(?:วิธีการแก้ไข|เวลาเปิดทำการ|หมายเหตุ|Service SLA|SLA|Solution|Remark|$)/i,
    /Problem\s*[:：]\s*(.{2,500}?)(?:Solution|Remark|Service SLA|SLA|$)/i,
    /Issue\s*[:：]\s*(.{2,500}?)(?:Solution|Remark|Service SLA|SLA|$)/i
  ];

  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (m && m[1]) return cleanProblemText(m[1]);
  }

  return "";
}

function cleanProblemText(text) {
  let s = cleanText(text || "");

  // ถ้ามีคำว่า "ปัญหา:" ให้เอาเฉพาะข้อความหลังคำนี้
  const problemMatch = s.match(/ปัญหา\s*[:：]\s*(.*)/i);
  if (problemMatch && problemMatch[1]) {
    s = problemMatch[1];
  }

  // ตัดข้อความตั้งแต่หัวข้ออื่น ๆ เป็นต้นไป
  s = s
    .replace(/วิธีการแก้ไข\s*[:：]?.*$/i, "")
    .replace(/เวลาเปิดทำการ\s*[:：]?.*$/i, "")
    .replace(/หมายเหตุ\s*[:：]?.*$/i, "")
    .replace(/Solution\s*[:：]?.*$/i, "")
    .replace(/Remark\s*[:：]?.*$/i, "")
    .replace(/Service SLA\s*[:：]?.*$/i, "")
    .trim();

  return s || "-";
}



function getDefaultNotificationConfig() {
  return {
    provinceNotifications: [
      { province: "ชลบุรี", enabled: true },
      { province: "ระยอง", enabled: true },
      { province: "ฉะเชิงเทรา", enabled: false },
      { province: "ปราจีนบุรี", enabled: false },
      { province: "สระแก้ว", enabled: false },
      { province: "จันทบุรี", enabled: false },
      { province: "ตราด", enabled: false }
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

async function getNotificationConfig(env) {
  const raw = await env.CASTLE_KV.get(NOTIFICATION_CONFIG_KEY);
  if (!raw) return getDefaultNotificationConfig();

  try {
    return normalizeNotificationConfig(JSON.parse(raw));
  } catch {
    return getDefaultNotificationConfig();
  }
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
        districts: Array.isArray(rule && rule.districts)
          ? rule.districts.map(normalizeThaiAreaName).filter(Boolean)
          : splitAreaList(rule && rule.districts),
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

function splitAreaList(value) {
  return String(value || "")
    .split(/[,;\n]/)
    .map(normalizeThaiAreaName)
    .filter(Boolean);
}

function normalizeTelegramUsername(value) {
  const text = cleanText(value || "");
  if (!text) return "";
  return text.startsWith("@") ? text : `@${text}`;
}

function shouldNotifySupportedProvince(job, notificationConfig = null) {
  const config = notificationConfig || getDefaultNotificationConfig();
  const province = cleanText(job.province || "").replace(/\s+/g, "");
  if (!province) return false;

  const provinceRule = (config.provinceNotifications || [])
    .find(rule => normalizeThaiAreaName(rule.province) === province);
  if (provinceRule && provinceRule.enabled !== false) return true;

  return (config.mentionRules || []).some(rule => {
    if (!rule || rule.enabled === false) return false;
    if (normalizeThaiAreaName(rule.province) !== province) return false;
    return ruleMatchesDistrict(rule, job);
  });
}


function getMentionForChonburiDistrict(job, notificationConfig = null) {
  const config = notificationConfig || getDefaultNotificationConfig();
  const province = cleanText(job.province || "").replace(/\s+/g, "");
  const district = normalizeThaiAreaName(job.district || inferDistrictFromKnownArea(job));
  const mentions = [];

  for (const rule of config.mentionRules || []) {
    if (!rule || rule.enabled === false || rule.tag === false) continue;
    if (normalizeThaiAreaName(rule.province) !== province) continue;
    if (!ruleMatchesDistrict(rule, { ...job, district })) continue;
    if (!mentions.includes(rule.username)) mentions.push(rule.username);
  }

  return mentions.join(" ");
}

function ruleMatchesDistrict(rule, job) {
  const districts = (rule.districts || []).map(normalizeThaiAreaName).filter(Boolean);
  if (!districts.length) return true;

  const district = normalizeThaiAreaName(job.district || inferDistrictFromKnownArea(job));
  return district && districts.includes(district);
}

function normalizeThaiAreaName(value) {
  return cleanText(value || "")
    .replace(/^อ\./, "")
    .replace(/^อำเภอ/, "")
    .replace(/\s+/g, "")
    .trim();
}

function formatMentionLine(job, notificationConfig = null) {
  const mention = getMentionForChonburiDistrict(job, notificationConfig);
  return mention ? `แจ้ง: ${mention}` : "";
}

function formatAreaLine(job) {
  const district = cleanText(job.district || inferDistrictFromKnownArea(job));
  const province = cleanText(job.province || "");

  if (district && province) return `พื้นที่: อ.${district} จ.${province}`;
  if (district) return `พื้นที่: อ.${district}`;
  if (province) return `พื้นที่: จ.${province}`;
  return "พื้นที่: -";
}

function inferDistrictFromKnownArea(job = {}) {
  const province = cleanText(job.province || "");
  const text = cleanText([
    job.merchantName || "",
    job.serviceCode || "",
    job.address || "",
    job.problem || ""
  ].join(" ")).toUpperCase();

  if (province === "ชลบุรี" || text.includes("CHONBURI") || text.includes("CHON BURI")) {
    if (/BSRC|SRIRACHA|SRI RACHA|ศรีราชา/.test(text)) return "ศรีราชา";
    if (/PATTAYA|พัทยา|บางละมุง/.test(text)) return "บางละมุง";
    if (/LAEM CHABANG|แหลมฉบัง/.test(text)) return "ศรีราชา";
    if (/AMATA|อมตะ|พานทอง/.test(text)) return "พานทอง";
    if (/BAN BUENG|บ้านบึง/.test(text)) return "บ้านบึง";
    if (/MUEANG CHONBURI|เมืองชลบุรี/.test(text)) return "เมืองชลบุรี";
  }

  return "";
}

function formatNewJobMessage(job, notificationConfig = null) {
  return [
    "🔔 มีงานใหม่ใน Service Castle",
    "",
    formatMentionLine(job, notificationConfig),
    `Terminal ID: ${job.terminalId || "-"}`,
    `Merchant: ${job.merchantName || "-"}`,
    formatAreaLine(job),
    `ชื่อผู้ติดต่อ: ${job.contactName || "-"}`,
    `เบอร์ผู้ติดต่อ: ${job.contactPhone || "-"}`,
    `Job Open: ${job.openDate || "-"}`,
    `SLA: ${job.slaDate || "-"}`,
    `Service: ${job.serviceCode || "-"}`,
    `ปัญหา: ${job.problem || cleanProblemText(job.serviceCode)}`
  ].filter(Boolean).join("\n");
}

function makeOpenJobKeyboard(job) {
  const url = job && job.link ? job.link : JOB_PAGE;

  return {
    inline_keyboard: [
      [
        {
          text: "🔗 เปิดงาน",
          url
        }
      ]
    ]
  };
}

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanText(text) {
  return decodeHtml(String(text || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function findTerminalId(cells) {
  for (const cell of cells) {
    if (/^\d{6,12}$/.test(cell)) return cell;
  }
  return "";
}

function extractHiddenInputs(html) {
  const result = {};
  const inputs = String(html || "").match(/<input[^>]+>/gi) || [];

  for (const input of inputs) {
    const type = (getAttr(input, "type") || "").toLowerCase();

    if (type && type !== "hidden") continue;

    const name = getAttr(input, "name");
    const value = getAttr(input, "value") || "";

    if (name) result[name] = value;
  }

  return result;
}

function extractFormAction(html) {
  const formMatch = String(html || "").match(/<form[^>]*action=["']([^"']+)["'][^>]*>/i);
  return formMatch ? formMatch[1] : "";
}

function getAttr(tag, attr) {
  const re = new RegExp(`${attr}=["']([^"']*)["']`, "i");
  const m = String(tag || "").match(re);
  return m ? m[1] : "";
}

function getTitle(html) {
  return cleanText(
    String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
  );
}

async function getState(env) {
  const raw = await env.CASTLE_KV.get(STATE_KEY);
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function safeSendTelegram(env, text, replyMarkup = null) {
  try {
    return await sendTelegram(env, text, replyMarkup);
  } catch (err) {
    console.log("Telegram send failed:", err.message || String(err));
    return null;
  }
}

async function sendTelegram(env, text, replyMarkup = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  }

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram error ${resp.status}: ${body}`);
  }

  return await resp.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CookieJar {
  constructor() {
    this.cookies = {};
  }

  addFromResponse(resp) {
    const values = getSetCookieHeaders(resp.headers);

    for (const header of values) {
      const cookieParts = splitSetCookie(header);

      for (const part of cookieParts) {
        const first = part.split(";")[0];
        const eq = first.indexOf("=");

        if (eq <= 0) continue;

        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();

        if (name) {
          this.cookies[name] = value;
        }
      }
    }
  }

  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  names() {
    return Object.keys(this.cookies);
  }
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    const arr = headers.getSetCookie();
    if (arr && arr.length) return arr;
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function splitSetCookie(header) {
  return String(header || "").split(/,(?=\s*[^;,\s]+=)/g);
}
