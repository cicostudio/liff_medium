// Local test: simulate a Fillout webhook and capture the outgoing Meta / LINE requests.
import app, { toE164, parseFillout } from '../src/index.js';

const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true}', { status: 200 }); };

const env = {
  WEBHOOK_KEY: 'k', META_CAPI_TOKEN: 'META_T', LINE_TAG_ACCESS_TOKEN: 'LINE_T',
  META_PIXEL_ID: '800186701890749', LINE_TAG_ID: 'da896487-a669-425e-be02-3dc3afbd3638', LINE_CHANNEL_ID: '2001467446',
  BOOKING_VALUE: '1999', CURRENCY: 'TWD', EVENT_SOURCE_URL: 'https://example.test/', META_API_VERSION: 'v21.0',
};
const payload = {
  submissionId: 'sub_abc123', submissionTime: '2026-10-22T06:00:00.000Z',
  questions: [
    { id: 'q1', name: '姓名', type: 'ShortAnswer', value: 'Amy' },
    { id: 'q2', name: '手機號碼', type: 'PhoneNumber', value: '0912-345-678' },
    { id: 'q3', name: '預約門市', type: 'MultipleChoice', value: '台北旗艦店' },
  ],
  urlParameters: [
    { id: 'u1', name: 'userid', value: 'U' + 'a'.repeat(32) },
    { id: 'u2', name: 'utm_campaign', value: 'liff_check' },
    { id: 'u3', name: 'fbclid', value: 'FBCLID1' },
    { id: 'u4', name: 'fbp', value: 'fb.1.1.2' },
    { id: 'u5', name: 'vid', value: 'V1' },
    { id: 'u6', name: 'ua', value: 'Mozilla/5.0 (iPhone)' },
    { id: 'u7', name: 'cta', value: 'price' },
  ],
};
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };

ok(toE164('0912-345-678') === '+886912345678', 'phone → E.164');
ok(parseFillout({ submission: payload }).submissionId === 'sub_abc123', 'wrapped payload parsed');

let r = await app.fetch(new Request('https://w/webhooks/fillout?key=bad', { method: 'POST', body: '{}' }), env);
ok(r.status === 401, 'wrong key rejected');

r = await app.fetch(new Request('https://w/webhooks/fillout?key=k', { method: 'POST', body: JSON.stringify(payload) }), env);
ok(r.status === 200, 'webhook accepted');
const meta = calls.find((c) => c.url.includes('graph.facebook.com'));
const line = calls.find((c) => c.url.includes('conversion-api.tr.line.me'));
const mb = JSON.parse(meta.init.body).data[0];
ok(mb.event_name === 'Schedule' && mb.event_id === 'booking_sub_abc123', 'meta event + dedupe id');
ok(/^[0-9a-f]{64}$/.test(mb.user_data.ph[0]) && mb.user_data.external_id.length === 2, 'meta hashed phone + external ids');
ok(mb.user_data.fbc.startsWith('fb.1.') && mb.user_data.fbp === 'fb.1.1.2' && mb.user_data.client_user_agent, 'meta fbc/fbp/ua');
ok(!meta.init.body.includes('912345678') && !meta.init.body.includes('Amy'), 'no plain phone/name to Meta');
const lb = JSON.parse(line.init.body)[0];
ok(line.init.headers['X-Line-TagAccessToken'] === 'LINE_T' && line.init.headers['X-Line-ChannelID'] === '2001467446', 'line headers');
ok(lb.event.event_type === 'conversion' && lb.event.event_name === 'Conversion' && lb.event.deduplication_key === 'booking_sub_abc123', 'line event');
ok(lb.user.line_uid && lb.user.phone === '+886912345678', 'line user match keys');
console.log('\nMeta body:', JSON.stringify(mb).slice(0, 300));
console.log('LINE body:', JSON.stringify(lb).slice(0, 300));
