/**
 * liff-medium — 凝聚 LIFF 預約流程的伺服器端轉換回報
 *
 * Fillout 表單送出 → Webhook 打到 POST /webhooks/fillout?key=<WEBHOOK_KEY>
 *   → Meta Conversions API：Schedule
 *   → LINE Conversion API：Conversion
 *
 * 使用者自己把預約訊息傳到 LINE 的流程完全不受影響；這裡只負責在背後回報轉換。
 * 電話：Meta 以 SHA-256 雜湊傳送；LINE 依其規格傳含國碼號碼（HTTPS）。不寫進任何網址或日誌。
 */
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.text('liff-medium ok'));

app.post('/webhooks/fillout', async (c) => {
  const env = c.env;
  if (!env.WEBHOOK_KEY || c.req.query('key') !== env.WEBHOOK_KEY) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  let body;
  try { body = await c.req.json(); } catch (e) { return c.json({ error: 'invalid json' }, 400); }

  const booking = parseFillout(body);
  if (!booking.submissionId) return c.json({ error: 'no submission' }, 400);

  // 先回 200 給 Fillout，轉換回報在背景完成（避免 Fillout 逾時重送）
  const work = Promise.allSettled([sendMeta(env, booking), sendLine(env, booking)]).then((rs) => {
    const [meta, line] = rs.map((r) => (r.status === 'fulfilled' ? r.value : 'error: ' + r.reason));
    console.log(JSON.stringify({ submission: booking.submissionId, meta, line }));
  });
  let ctx = null;
  try { ctx = c.executionCtx; } catch (e) { /* 本機測試沒有 ExecutionContext */ }
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return c.json({ ok: true });
});

export default app;

// ---------------------------------------------------------------------------
// Fillout payload → booking
// Webhook 送來的格式與 /submissions 的單筆相同：
//   { submissionId, submissionTime, questions:[{name,type,value}], urlParameters:[{name,value}] }
// 有些設定會包一層 { submission: {...} }，兩種都接受。
// ---------------------------------------------------------------------------
export function parseFillout(body) {
  const s = (body && body.submission) || body || {};
  const url = {};
  (s.urlParameters || []).forEach((p) => { if (p && p.name && p.value) url[p.name] = String(p.value); });

  const qs = s.questions || [];
  const phoneQ = qs.find((q) => q.type === 'PhoneNumber' && q.value)
    || qs.find((q) => /電話|手機|phone/i.test(q.name || '') && q.value);
  const storeQ = qs.find((q) => /門市|地點|分店|location|store/i.test(q.name || '') && q.value);

  const t = Date.parse(s.submissionTime || '') || Date.now();
  return {
    submissionId: s.submissionId,
    time: Math.floor(t / 1000),
    timeMs: t,
    phone: phoneQ ? String(phoneQ.value) : '',
    store: storeQ ? String(storeQ.value) : '',
    url,
  };
}

// 台灣手機號碼 → E.164（0912345678 → +886912345678）
export function toE164(phone) {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d;
  if (d.startsWith('886')) return '+' + d;
  if (d.startsWith('0')) return '+886' + d.slice(1);
  return '+886' + d;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Meta Conversions API
// ---------------------------------------------------------------------------
async function sendMeta(env, b) {
  if (!env.META_CAPI_TOKEN || !env.META_PIXEL_ID) return 'skipped (no token)';
  const u = b.url;
  const user_data = {};
  const e164 = toE164(b.phone);
  if (e164) user_data.ph = [await sha256(e164.replace('+', ''))];      // Meta：數字、含國碼、不含 +
  const ext = [u.vid, u.userid].filter(Boolean);
  if (ext.length) user_data.external_id = await Promise.all(ext.map((x) => sha256(x.trim().toLowerCase())));
  if (u.fbc) user_data.fbc = u.fbc;
  else if (u.fbclid) user_data.fbc = `fb.1.${b.timeMs}.${u.fbclid}`;
  if (u.fbp) user_data.fbp = u.fbp;
  if (u.ua) user_data.client_user_agent = u.ua;

  const payload = {
    data: [{
      event_name: 'Schedule',
      event_time: b.time,
      event_id: 'booking_' + b.submissionId,
      action_source: 'website',
      event_source_url: env.EVENT_SOURCE_URL,
      user_data,
      custom_data: {
        value: Number(env.BOOKING_VALUE || 0), currency: env.CURRENCY || 'TWD',
        content_name: '一對一首次體驗',
        ...(u.utm_campaign ? { utm_campaign: u.utm_campaign } : {}),
        ...(u.cta ? { cta_location: u.cta } : {}),
      },
    }],
  };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  const v = env.META_API_VERSION || 'v21.0';
  const res = await fetch(`https://graph.facebook.com/${v}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return `${res.status} ${(await res.text()).slice(0, 200)}`;
}

// ---------------------------------------------------------------------------
// LINE Conversion API (https://conversion-api-docs.linebiz.com/en/)
// ---------------------------------------------------------------------------
async function sendLine(env, b) {
  if (!env.LINE_TAG_ACCESS_TOKEN || !env.LINE_TAG_ID) return 'skipped (no token)';
  const u = b.url;
  const user = {};
  if (u.userid && /^U[0-9a-f]{32}$/.test(u.userid)) user.line_uid = u.userid;
  const e164 = toE164(b.phone);
  if (e164) user.phone = e164;   // LINE 規格接受含國碼的號碼（+886…），由 LINE 端雜湊比對
  if (u.vid) user.external_id = u.vid;
  if (!Object.keys(user).length) return 'skipped (no user match key)';

  const event = [{
    event: {
      event_type: 'conversion',
      event_name: 'Conversion',
      source_type: 'web',
      deduplication_key: 'booking_' + b.submissionId,
      event_timestamp: b.time,
    },
    user,
    web: { url: env.EVENT_SOURCE_URL, ...(u.ua ? { user_agent: u.ua } : {}) },
    custom: { value: Number(env.BOOKING_VALUE || 0), currency: env.CURRENCY || 'TWD' },
  }];

  const headers = { 'Content-Type': 'application/json', 'X-Line-TagAccessToken': env.LINE_TAG_ACCESS_TOKEN };
  if (user.line_uid && env.LINE_CHANNEL_ID) headers['X-Line-ChannelID'] = env.LINE_CHANNEL_ID;
  // body 用字串送出（固定長度），LINE 會拒絕 chunked 傳輸
  const res = await fetch(`https://conversion-api.tr.line.me/v1/${env.LINE_TAG_ID}/events`, {
    method: 'POST', headers, body: JSON.stringify(event),
  });
  return `${res.status} ${(await res.text()).slice(0, 200)}`;
}
