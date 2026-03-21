# PROCESSES.md — Registry tiến trình xử lý (ưu tiên đúng ý user)

Tài liệu này mô tả **khi nào dùng tool/hành vi nào**, theo **ý định** chứ không theo từ khóa cứng. Agent đọc phần này trước khi chọn tool.

## Quy tắc chung

1. **Khớp theo ý nghĩa** yêu cầu user (ngữ cảnh, mục tiêu), không chỉ vì có từ “search”, “browser”, “skill” trong câu.
   - **Bộ nhớ tác vụ phức tạp (task memory):** Với intent tool / reasoning / dữ liệu lớn (hoặc tag `[task:complex]`), hệ thống gắn **một `taskId` riêng** mỗi luồng từ một tin user, lưu dưới `$BRAIN_DIR/<user>/sessions/<threadId>/tasks/` — không trộn với tác vụ khác. **Tiếp tục cùng task** (giữ `failedRunStreak`, không tạo task mới): prefix `[task:task-xxx]`, hoặc câu kiểu “tiếp / thử lại / bước tiếp theo / làm nốt / chưa xong / theo đề xuất trên”, hoặc nhắc **`draftGroupId` / đường `browser_debug/…` / `skill_draft`**. Ghi chú/đóng task: tool `task_memory` (`append_note`, `set_status`, `list_tasks`).
   - **Giới hạn hỏi user (cùng một vấn đề):** `failedRunStreak` trong task memory tích lũy mỗi lần tool `success=false` (reset khi cả lượt đều thành công). Khi streak **&lt; 50**: **ưu tiên tự gọi tool** — **không** hỏi kiểu “chọn 1/2/3 / bạn muốn A hay B” để trì hoãn. Khi streak **≥ 50** vẫn chưa xong: **được** hỏi user hướng tiếp hoặc thông tin thiếu (cookie, secret…). Ngoại lệ: thiếu dữ liệu **không thể** suy ra thì hỏi ngay (không cần chờ 50).
2. **Nhiều tiến trình đều hợp lý** → **mặc định chọn hướng hợp lý nhất + gọi tool** (theo PROCESSES + task memory). Chỉ **liệt kê và hỏi user chọn** khi **(a)** streak ≥ 50 trong task memory mà vẫn kẹt, hoặc **(b)** sai lệch rủi ro cao và không có tiêu chí tự chọn an toàn.
3. **Chưa chắc** → **thử một hướng có lý + tool** trước; chỉ hỏi làm rõ khi **không thể** bước tiếp (thiếu secret) hoặc đã đủ **50** lần lỗi tích lũy (streak) cho cùng vấn đề.
4. **Cấm** chỉ trả về khối JSON mô phỏng lệnh gọi tool — phải gọi function tool thật qua API. (Backend: nếu model vẫn in khối fenced JSON với `run_skill` kèm dấu hiệu “sẽ chạy / đang thực thi” mà không emit tool, pipeline có thể **parse và thực thi** `skills_registry_manage` rồi tiếp vòng agent.)

---

## Tiến trình theo mục đích

### A. Chạy skill dùng chung (`$BRAIN_DIR/_shared/skills/`)

- **Kiến trúc (quan trọng):** Package skill (`$BRAIN_DIR/_shared/skills/<skill_code>/skill.json`) **có thể đã tồn tại trên đĩa**, nhưng backend **không** đăng ký mỗi skill đó thành một function tool riêng cho LLM. Danh sách tool function-calling chỉ gồm các **code skill** (`@RegisterSkill`); skill dùng chung chỉ chạy qua **`skills_registry_manage`**. Vì vậy “có folder skill rồi” vẫn **bắt buộc** một lần gọi tool đúng: `action=run_skill` + `skillCode` + `runtimeParams` — không có shortcut tên tool = `skillCode`.
- **Khi nào:** User muốn **thực thi** quy trình đã có: “chạy / run / thực thi / sử dụng skill …”, có **skillCode** và tham số (vd. nội dung bài đăng).
- **Tool:** `skills_registry_manage` — **`action=run_skill`** + `skillCode` + `runtimeParams` (vd. `{"content":"..."}`).
- **CẤM nhầm:** Không gọi `bootstrap_skill` khi user chỉ muốn chạy — sẽ báo **trùng thư mục** nếu skill đã tồn tại.
- **Không nhầm với:** “Mở Facebook xem” → `browser`; “tìm hiểu cách đăng” → `web_search`. Khi còn mơ hồ: **ưu tiên** `web_search` hoặc suy luận từ ngữ cảnh; **chỉ hỏi** khi streak ≥ 50 (task memory) hoặc rủi ro nhầm rất cao.
- **Khi lỗi + giữ `browser_debug`:** Sau khi snapshot/`skill_draft.json` được lưu, backend có thể **gộp nền** các `usedSelector` (và URL) từ log vào **`$BRAIN_DIR/<identifier>/browser_dom_presets/<domain>.json`** — **song song**, không chặn luồng `bootstrap_skill` hay tạo skill.
- **Trả lời sau `run_skill`:** Chỉ mô tả kết quả đúng **`data.run.steps`** (và `success` tổng). Không khẳng định user “đã thấy bài trên Facebook” nếu không có bằng chứng từ tool (hoặc nếu có `verifyReason` / lỗi bước đăng).
- **Lượt sau khi `run_skill` lỗi / có `skillTune`:** Pipeline có thể **gợi ý nền** + **thu hẹp** chỉ còn tool `skills_registry_manage` (và thử ép `tool_choice` hai lần) để agent **gọi lại** `run_skill` hoặc `bootstrap_skill` — không thay cho việc model phải emit đúng function call.
- **Cùng lượt user: vừa bootstrap xong nhưng user đã yêu cầu chạy skill:** Nếu `bootstrap_skill` thành công trong khi tin nhắn user là kiểu “chạy skill … / với nội dung …”, pipeline **giữ strict** và buộc bước tiếp **`run_skill`** (không kết thúc bằng văn bản + JSON giả).

### B. Tạo mới / ghi đè skill dùng chung

- **Khi nào:** Tạo package lần đầu, hoặc **sửa định nghĩa** và ghi lại disk (`draftGroupId`, bootstrap sau khi debug, …).
- **Tool:** `skills_registry_manage` — `action=bootstrap_skill` + **`confirmCreate=true`**.
- **Thư mục đã tồn tại:** thêm **`overwriteExisting=true`** để xóa package cũ rồi ghi mới. **Không** dùng khi user chỉ muốn chạy skill — dùng `run_skill` (mục A). Chi tiết: TOOLS.md.
- **Quy trình dài / tiêu chí thành công:** Truyền **`executionNotes`** (hoặc ghi vào `skill_draft.json` các key `executionNotes` / `successCriteria` / `operatorInstructions` / `userRequest`) để lưu vào `skill.json` + README — tránh sót bước (vd. “chờ thấy bài trên Newsfeed mới tính xong”).

### C. Trình duyệt tự do (Playwright)

- **Khi nào:** Mở trang, thao tác cụ thể trên site, chụp snapshot, luồng **chưa** gói thành shared skill — hoặc user muốn **điều khiển trình duyệt** linh hoạt.
- **Tool:** `browser` (các action navigate, click, type, …).

### D. Tìm kiếm thông tin công khai / thời tiết

- **Khi nào:** Tra cứu nhanh, tóm tắt kết quả tìm kiếm, thời tiết, tin tức — **không** cần đăng nhập site hay thao tác DOM phức tạp.
- **Tool:** `web_search` (ưu tiên khi chỉ cần kết quả tìm kiếm).
- **Khi nào cả `browser` và `web_search` đều được:** Nếu user **không** nói rõ — **mặc định** dùng `web_search` cho tra cứu nhanh; pipeline cũng có thể thu hẹp sẵn như vậy. **Hỏi** browser vs search chủ yếu khi **failedRunStreak ≥ 50** trong task memory mà vẫn mơ hồ, hoặc user **yêu cầu** mở trang/đăng nhập (khi đó `browser`).

### E. Google Workspace (Gmail, Drive, Sheets, …)

- **Khi nào:** Mail, Drive, Sheets, Calendar, xóa vĩnh viễn / dọn thùng rác Drive (kèm ngữ cảnh Google), thao tác qua **gog**.
- **Tool:** `google_workspace`. **Không** dùng để “kết nối OAuth lần đầu” — xem mục F.

### F. Kết nối / auth Google (gog)

- **Khi nào:** Setup auth, remote OAuth, “làm cho gog chạy được”.
- **Tool:** `google_auth_setup` (không thay bằng `google_workspace`).

### G. Quyền guest / duyệt mã bot

- **Khi nào:** Tạo mã, duyệt mã, thu hồi quyền, danh sách user được cấp.
- **Tool:** `bot_access_manage`.

### H. Xóa file nháp / debug browser trong `$BRAIN_DIR/.../browser_debug`

- **Khi nào:** User muốn dọn snapshot/HTML/skill_draft trong thư mục browser debug (không nhầm với xóa file Drive).
- **Tool:** `browser_debug_cleanup` (vd. `deleteAll=true`) — **không** dùng `exec` rm tùy tiện cho mục này.

### I. Shell / script trên server

- **Khi nào:** Chạy lệnh, kiểm tra binary, script một lần — khi phù hợp và user có quyền (owner theo cấu hình).
- **Tool:** `exec`.

### J. Bộ nhớ / ghi chú workspace

- **Khi nào:** Ghi nhớ dài hạn, file memory theo ngày — theo quy ước AGENTS/SOUL.
- **Tool:** các skill `memory_*` nếu có trong danh sách tool.

---

## Trùng ý thường gặp (nên hỏi lại)

| User có thể muốn | Các hướng khác nhau |
|------------------|---------------------|
| “Đăng bài Facebook” | (A) `run_skill` packaged **hoặc** (C) `browser` tay **hoặc** chỉ (D) tìm hiểu |
| “Tìm … trên mạng” | (D) `web_search` **hoặc** (C) `browser` mở trang |
| “Google” | (E) thao tác workspace **hoặc** (F) auth setup |

---

## Ghi chú

- Danh sách tool thực tế và schema nằm trong request LLM; file này là **hướng dẫn chọn lựa**.
- Cập nhật file này khi thêm tiến trình/tool mới — **không cần** thêm regex từ khóa trong code nếu có thể mô tả rõ ở đây.
- Các file markdown dùng chung chỉ nằm dưới **`$BRAIN_DIR/_shared/`** (`PROCESSES.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`, `SOUL.md`; `BRAIN_DIR` trong `.env`). **Chỉ owner** cập nhật qua chat: bắt buộc **`memory_write`** với `action=read_shared_file` và `sharedFilename` đúng tên file (với PROCESSES có thể dùng alias `read_shared_processes`) — đọc toàn bộ file từ đĩa + `contentSha256`, kết hợp yêu cầu user trong suy luận, rồi `write_file` hoặc `append_file` với `filename` cùng tên (ở root, không subpath) và `ifMatchSha256` trùng `contentSha256` vừa đọc (khóa lạc quan).
