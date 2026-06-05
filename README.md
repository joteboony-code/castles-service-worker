# castles-service-worker

Cloudflare Worker สำหรับเช็กงาน Service Castle และแจ้งเตือน Telegram พร้อมหน้าเว็บ Dashboard สำหรับดูข้อมูล เปิด/ปิดระบบ และกำหนดรอบตรวจงานได้เอง

## สิ่งที่เพิ่มใน Dashboard

- เปิดหน้าเว็บที่ `/` หรือ `/dashboard`
- ใส่ `ADMIN_KEY` เพื่อเข้าใช้งาน
- ดูสถานะระบบว่าเปิด/ปิดอยู่
- ดูจำนวนงานทั้งหมดและงานจังหวัดชลบุรีที่ระบบจำไว้ใน KV
- ดูงานล่าสุดที่ระบบเคยตรวจพบ
- ตั้งรอบตรวจงานได้จากหน้าเว็บ เช่น 1, 3, 5, 10, 15, 30, 60 นาที หรือกำหนดเอง
- ดูเวลาตรวจล่าสุดและรอบตรวจถัดไป
- กดเปิดระบบ: cron จะตรวจงานตามรอบที่ตั้งไว้
- กดปิดระบบ: cron จะหยุดตั้งแต่ก่อน login เข้า Castle และไม่ส่ง Telegram
- กดตรวจงานตอนนี้
- กด Reset งานที่จำไว้
- ทดสอบ Telegram และ Login Debug

## Environment / Secrets ที่ต้องตั้ง

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler secret put CASTLE_USERNAME
npx wrangler secret put CASTLE_PASSWORD
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

ตั้งค่าเพิ่มเติมได้ถ้าจำเป็น:

```bash
npx wrangler secret put SLA_ALERT_MINUTES
npx wrangler secret put CHECK_INTERVAL_MINUTES
npx wrangler secret put CASTLE_LOGIN_URL
npx wrangler secret put CASTLE_USER_FIELD
npx wrangler secret put CASTLE_PASS_FIELD
```

ค่าเริ่มต้นของ `SLA_ALERT_MINUTES` คือ `360,180,60,30,10`

ค่าเริ่มต้นของ `CHECK_INTERVAL_MINUTES` คือ `5` นาที แต่สามารถเปลี่ยนจากหน้าเว็บ Dashboard ได้ โดยระบบจะบันทึกค่าลง KV

## Deploy

```bash
npx wrangler deploy
```

## URL ใช้งาน

หลัง deploy แล้วให้เปิด Worker URL เช่น:

```txt
https://serviceeast.<your-subdomain>.workers.dev/
```

หรือเข้าแบบส่ง key ครั้งแรก:

```txt
https://serviceeast.<your-subdomain>.workers.dev/?key=<ADMIN_KEY>
```

หน้าเว็บจะย้าย key ไปเก็บใน `sessionStorage` ของ browser และลบ key ออกจาก URL ให้เอง

## หมายเหตุ

- Entry point ตอนนี้คือ `dashboard-worker.js`
- โค้ดเช็กงานเดิมยังอยู่ใน `worker.js`
- Cron ใน `wrangler.toml` ปลุกทุก 1 นาที แต่ระบบจะตรวจงานจริงเฉพาะเมื่อถึงรอบที่ตั้งไว้ใน Dashboard
- ถ้าตั้งรอบตรวจ 10 นาที cron จะตื่นทุกนาทีแต่จะเข้า Castle จริงประมาณทุก 10 นาที
- สถานะเปิด/ปิดระบบเก็บใน KV key: `castle_system_control_v1`
- รอบตรวจงานเก็บใน KV key: `castle_schedule_config_v1`
- ผลรอบตรวจอัตโนมัติเก็บใน KV key: `castle_schedule_run_v1`
- ผลการตรวจล่าสุดของ Dashboard เก็บใน KV key: `castle_dashboard_last_run_v1`
