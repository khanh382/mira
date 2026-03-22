# Browser DOM presets (per domain)

Mỗi **một hostname logic** = **một file** `<domain>.json` (vd. `facebook.com.json`).

- **Không trùng tên file** = không trùng domain; thêm site = file mới; sửa DOM = sửa file tương ứng (không cần deploy backend nếu chỉ đổi `$BRAIN_DIR/`).
- **Ưu tiên user:** `$BRAIN_DIR/<identifier>/browser_dom_presets/<domain>.json` **ghi đè** `$BRAIN_DIR/_shared/browser_dom_presets/<domain>.json` khi tồn tại — tiện khi mount `$BRAIN_DIR/` ở volume riêng.
- **Chỉ đọc file khớp URL:** thử hậu tố hostname (vd. `m.facebook.com` → `facebook.com.json`), không đọc gộp mọi domain.

## Các khối JSON (tùy chọn)

| Khối | Mục đích |
|------|----------|
| `click` / `type` | Mảng selector Playwright cho auto-retry khi click/type lỗi |
| `scrollAssistBeforeRetry` | `true` = nudge scroll nhẹ trước khi retry |
| `publishVerification` | Sau khi bấm “đăng bài”: chuỗi cần có trong body/live region, selector dialog composer, `pollDelaysMs`, `enabled: false` để tắt hẳn |
| `loginSuccess` | `sessionCookiePattern` (regex trên `document.cookie`), `domSelectors` (mảng CSS) — dùng cho auto-save cookie sau navigate |
| `retryGuards` | `composerOpenSubstrings`, `composerStepDenyCandidatePatterns` (regex), `publishIntentSelectorPatterns` (regex) — tránh nhầm bước mở composer vs đăng |

Tên file domain: `[a-z0-9.-]+` (vd. `facebook.com`).

Xem ví dụ đầy đủ: `facebook.com.json`.
