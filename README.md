# liff-medium

凝聚 LIFF 預約流程的伺服器端轉換回報（Cloudflare Worker + Hono）。

```
Fillout 表單送出 ──Webhook──▶ POST /webhooks/fillout?key=<WEBHOOK_KEY>
                                ├─▶ Meta Conversions API：Schedule
                                └─▶ LINE Conversion API：Conversion
```

使用者自己把預約訊息傳到 LINE 官方帳號的流程（first_visit）完全不變；這裡只在背後回報轉換。

## 部署

1. Cloudflare → Workers & Pages → Create → Import a repository → 選 `cicostudio/liff_medium`，直接 Deploy。
2. Worker → Settings → Variables and Secrets，新增三個 **Secret**：
   - `WEBHOOK_KEY`：自己訂一組長亂碼（例如 32 字元）
   - `META_CAPI_TOKEN`：Meta Events Manager → 資料集（Pixel 800186701890749）→ 設定 → Conversions API → 產生存取權杖
   - `LINE_TAG_ACCESS_TOKEN`：LINE 廣告後台（Business Manager）→ LINE Tag → Conversion API 存取權杖
3. Fillout → 表單 → Integrate → Webhook → 網址填
   `https://liff-medium.<你的子網域>.workers.dev/webhooks/fillout?key=<WEBHOOK_KEY>`

## Fillout 需要的隱藏欄位（URL parameters）

`userid`、`utm_source`、`utm_medium`、`utm_campaign`、`utm_content`、`fbclid`、`gclid`、`vid`、`gcid`、`cta`、`lp`、`ua`、`fbp`
（first_visit 會把這些參數帶到 Fillout 網址上，新增同名 hidden fields 就會收進每筆提交。）

電話題目請用 Fillout 的「Phone number」題型，或題目名稱含「電話／手機」。

## 測試

- 本機：`npm test`（模擬一筆 Fillout Webhook，檢查送給 Meta / LINE 的內容）
- 上線測試：在 `wrangler.toml` 打開 `META_TEST_EVENT_CODE`（填 Events Manager → 測試事件的代碼），送一筆表單，到 Events Manager 看是否收到 `Schedule`；確認後刪掉這行。
- 看紀錄：Cloudflare → Worker → Logs（每筆提交會記錄 Meta / LINE 的回應碼，不含個資）。

## 傳送的資料

| | Meta（Schedule） | LINE（Conversion） |
|---|---|---|
| 電話 | SHA-256 雜湊（886…） | 含國碼號碼（+886…，依 LINE 規格） |
| 其他比對 | vid、LINE userId（雜湊）、fbc、fbp、User-Agent | LINE userId、vid、User-Agent |
| 去重 | event_id = `booking_<submissionId>` | deduplication_key = `booking_<submissionId>` |
| 金額 | 1999 TWD | 1999 TWD |

姓名不會送出。
