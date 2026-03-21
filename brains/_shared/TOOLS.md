# TOOLS.md — Ghi chú về tools & môi trường

Ghi chú riêng cho từng môi trường (server, thiết bị, API endpoints...).
File này dùng chung, mỗi user có thể override trong workspace riêng.

**Chọn tool theo ý user:** đọc **`PROCESSES.md`**. Hỏi user **ít** thôi: tự gọi tool trước; chỉ hỏi khi thiếu secret / streak ≥ 50 (task memory) hoặc hành động không hoàn tác. TOOLS.md: tham số & intent map.

## Khả năng backend (quan trọng — đừng bịa giới hạn)

Nền tảng **có** function tools (LLM gọi qua API). Khi user cần thao tác thực tế, **ưu tiên gọi tool** thay vì khẳng định “không chạy được shell/CLI”.

- **`exec`**: chạy lệnh shell trên **máy chủ backend** qua `/bin/bash -c` (có timeout, owner-only theo cấu hình skill). Dùng khi cần script, kiểm tra binary, v.v.
- **`google_workspace`**: Gmail/Drive/Sheets/… qua binary **`gog`** (gogcli), **không** phải “chỉ chạy trên máy user”. Nếu tool báo lỗi, hãy trích đúng lỗi từ kết quả tool (vd. chưa cài `gog`, chưa auth Google), **không** suy ra chung chung là “cấm shell”.
- **Lưu ý Drive xóa file**: `drive delete <id>` => vào Trash; chỉ “xóa vĩnh viễn” khi thêm `--permanent`.
- **`bot_access_manage`**: quản lý quyền guest cho bot (chuẩn OpenClaw manual-approve):
  - `create`: tạo mã 6 ký tự cho `platformUserId`, hiệu lực 24 giờ.
  - `approve_code`: owner duyệt thủ công mã để kích hoạt user.
  - `revoke`: ngắt quyền user đã/đang được cấp.
  - `list`: xem danh sách grants.
- **`google_auth_setup`**: setup auth cho gog (Google Workspace) dựa trên JSON đã lưu trong workspace. Có thể tự suy ra `email`; hỗ trợ `remote_step1/remote_step2` để chạy auth trên server không cần stdin.
- Các skill khác: `web_fetch`, `web_search`, `browser`, `memory_*`, … xem danh sách tool trong request.
- **`browser` auto-retry / verify / login heuristics:** **`$BRAIN_DIR/_shared/browser_dom_presets/<domain>.json`** (ghi đè: **`$BRAIN_DIR/<identifier>/browser_dom_presets/`**). Trong JSON: `click`/`type`, `publishVerification`, `loginSuccess`, `retryGuards`, … — sửa khi site đổi UI mà không cần deploy. Facebook có fallback selector trong code nếu thiếu file.

**Cấm** trả lời kiểu “hệ thống không bao giờ chạy shell/exec/gog vì bảo mật” nếu chưa thử tool hoặc chưa có kết quả tool từ lượt hiện tại.

## Shared skills — `$BRAIN_DIR/_shared/skills/` (bắt buộc gọi tool, cấm bịa “đã lưu”)

**Kiến trúc:** Skill đóng gói trên đĩa (`<skill_code>/skill.json`) **không** xuất hiện như một function `name` riêng trong request LLM; chỉ có tool **`skills_registry_manage`** (xem `SkillsService.getToolDefinitionsForLLM` — chỉ code skills). Để **chạy** package đã có: luôn **`action=run_skill`** + `skillCode` + `runtimeParams`. Đừng nhầm “đã có thư mục skill” với “model đã có tool tên đó”.

Khi user muốn **lưu skill dùng chung**, **tạo template**, **đóng gói quy trình**, **tối ưu skill để dùng lại**, **bootstrap skill**, hoặc nhắc tới `$BRAIN_DIR/_shared/skills`:

1. **Phải gọi tool** `skills_registry_manage` — **không** được chỉ mô tả JSON hay hứa “đã lưu vào thư mục …”.
2. **Ghi file thật** (tạo `skill.json`, `README.md`, `run.example.json`): `action=bootstrap_skill` + **`confirmCreate=true`**. Kèm `skillCode`, `skillName`, `description`, `parametersSchema`; tùy `draftGroupId`. **Cùng skillCode đã tồn tại:** thêm **`overwriteExisting=true`**.
   - **Quy trình / tiêu chí thành công (không được sót):** truyền **`executionNotes`** (chuỗi nhiều dòng) mô tả đủ bước (vd. sau khi bấm Đăng phải **chờ thấy bài mới trên Newsfeed** mới tính thành công; tránh nhầm nút lên lịch; cookie/login…). Giá trị được lưu vào **`skill.json`** (`executionNotes`) và **`README.md`** (mục “Tiêu chí thành công & yêu cầu vận hành”). Có thể **gộp** với nội dung trong `$BRAIN_DIR/<identifier>/browser_debug/<draftGroupId>/skill_draft.json` nếu file đó có các key `executionNotes`, `successCriteria`, `operatorInstructions`, `userRequestedSteps`, `userRequest`. Khi **`list_registry`** / **`find_candidates`**: trường `description` trả về **đã nối thêm** khối `[executionNotes]` (preview tối đa ~800 ký tự) để AI luôn thấy tiêu chí mà không cần mở README.
3. **Chỉ được nói “đã tạo / đã lưu”** sau khi tool trả về **success** và (nếu có) đường dẫn từ kết quả tool — không được suy đoán đường dẫn.
4. **Chạy skill đã có** (“chạy / run / thực thi / sử dụng skill …”): **`action=run_skill`** + `skillCode` + `runtimeParams` khớp schema — **không** dùng `bootstrap_skill` (sẽ lỗi duplicate nếu thư mục đã có). **Sau `run_skill` (browser / Facebook):** căn cứ **`data.run.steps`** (success/error/`verifyReason` từng bước). **Cấm** khẳng định “đã thấy bài trên timeline / trang cá nhân” nếu tool không `success` hoặc bước đăng lỗi / verify lỗi; không bịa chi tiết hiển thị bài viết.
5. **Ghi đè skill đã tồn tại** (bootstrap/create): thêm **`overwriteExisting=true`** + `confirmCreate=true`.
6. **Liệt kê**: `action=list_registry`.
7. **Khi `run_skill` / `run_selected` lỗi** (mặc định `persistArtifactsOnFailure=true`): hệ thống **chép** snapshot/HTML vào `$BRAIN_DIR/<identifier>/browser_debug/<draftGroupId>/`, ghi `skill_draft.json`. Bước tiếp: `bootstrap_skill` + `confirmCreate=true` + `draftGroupId` + (nếu cùng `skillCode` đã có) **`overwriteExisting=true`**. Tắt persist: `persistArtifactsOnFailure=false`.

Nếu không gọi tool khi **tạo/ghi** package: **không** được khẳng định “đã lưu” dù câu trả lời có vẻ hoàn chỉnh. (Skill có thể **đã** có sẵn trên disk từ lần trước; khi đó vẫn phải gọi `run_skill` để **thực thi**, không suy ra từ văn bản.)

**Task memory:** `failedRunStreak` — **&lt; 50** thì ưu tiên **tự gọi tool**, không hỏi chọn A/B/C để trì hoãn; **≥ 50** (cùng vấn đề vẫn lỗi) mới ưu tiên **hỏi** hướng tiếp. **`browser` vs `web_search` mơ hồ:** pipeline **mặc định `web_search`**; chỉ **hỏi** chọn khi streak ≥ 50 trong task memory.

## Intent map cho quyền bot (bắt buộc dùng tool)

Khi user nói các ý sau, **phải gọi `bot_access_manage`**, không trả lời lý thuyết:

- "duyệt mã ABCDEF", "kích hoạt mã ABCDEF", "approve code ABCDEF"
  - Gọi: `action=approve_code`, `platform=telegram`, `code=ABCDEF`
- "tạo mã cho user 870...", "cho phép user 870... chat"
  - Gọi: `action=create`, `platform=telegram`, `platformUserId=<id>`
- "thu hồi/ngắt quyền user 870..."
  - Gọi: `action=revoke`, `platform=telegram`, `platformUserId=<id>`
- "danh sách user được cấp quyền"
  - Gọi: `action=list`, `platform=telegram`

Quy tắc phản hồi:
- Nếu tool thành công: trả kết quả ngắn gọn, đúng dữ liệu thật từ tool.
- Nếu tool thất bại: nêu lỗi thật từ tool (ví dụ mã hết hạn 3 phút / không tồn tại), không bịa.

## Intent map cho Google Auth (bắt buộc dùng tool)

Khi user nói các ý như "kết nối google", "authenticate google", "setup google workspace", "làm cho gog auth hoạt động", thì:
- Gọi `google_auth_setup` với `mode=remote_step1` (ưu tiên).
- Nếu cần bước hoàn tất: khi tool trả về `authUrl`/hướng dẫn lấy redirect URL từ bước remote_step1, hãy gọi lại `google_auth_setup` với `mode=remote_step2` và `authUrl=<redirect_url>`.

## Lưu ý chung
- Lệnh qua `exec` có timeout (mặc định 30s), chạy trong ngữ cảnh process backend
- Browser skill dùng Playwright headless Chromium
- TTS dùng OpenAI TTS API (voice: alloy)

## Quy ước phong cách phản hồi
- Hạn chế icon/emoji: không lạm dụng; không dùng quá thường xuyên.
- Quy tắc nhanh:
  - Tối đa 1 icon/emoji cho mỗi đoạn (paragraph), và tối đa 3 icon/emoji cho cả một tin nhắn.
  - Chỉ dùng cho trường hợp thật sự cần nhấn mạnh như: cảnh báo/lỗi/STOP/xác nhận thành công/yêu cầu xác nhận.
- Tránh dùng icon cho mọi dòng/bullet; nếu cần liệt kê thì dùng văn bản thuần.
