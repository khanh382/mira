# Quyền truy cập tool (code skill) theo user

Tài liệu mô tả **skill chạy code** đăng ký bằng `@RegisterSkill` trong `src/agent/skills/built-in/`.  
**Không** gồm: skill chỉ-prompt (Clawhub / `SKILL.md`), hay gói trên đĩa `_shared/skills/` trừ khi gọi qua `skills_registry_manage`.

**Cập nhật:** khi thêm/sửa skill, đồng bộ lại bằng cách tìm `ownerOnly` trong `src/agent/skills/built-in/`.

---

## User level trên database (`users.level`)

| Giá trị      | Ý nghĩa ngắn gọn                          |
| ------------ | ----------------------------------------- |
| `owner`      | Chủ bot / quyền cao nhất trong hệ thống   |
| `colleague`  | User nội bộ (routing model khác `client`) |
| `client`     | User thường / khách — **không** được gọi bất kỳ code skill nào (chỉ chat qua agent; xem mục 1) |

Enum: `src/modules/users/entities/user.entity.ts` (`UserLevel`).

---

## 1. User `client`: không tool code (LLM + `executeSkill`)

Với `users.level === client`:

- **Agent loop** (`agent-run.step.ts`): danh sách function-calling gửi LLM là **rỗng** — model chỉ trả lời chữ, không gọi tool.
- **`SkillsService.executeSkill`** (`skills.service.ts`): mọi lệnh gọi skill code (kể cả `/tool_*`, `/run_skill` → registry, v.v.) trả về lỗi ngay, **không** chạy `runner.execute`.
- **Task memory** (`task-memory.service.ts`): **không** gắn task / **không** ghi checkpoint dưới `sessions/.../tasks/` — chỉ hội thoại, không lưu lịch sử tác vụ trên đĩa.

Các lệnh gateway chỉ đọc/ghi workspace qua `WorkspaceService` (vd. `/brain_tree`, `/brain_read`) **không** đi qua `executeSkill` — nhưng **user `client` bị từ chối** khi gọi `/menu`, `/brain_tree`, `/brain_read` (chỉ chat). Owner/colleague vẫn dùng được; chi tiết `gateway.service.ts` / `SYSTEM_COMMANDS.md`.

---

## 2. Tool `ownerOnly: true` (chỉ owner trong luồng LLM)

Các skill này có `ownerOnly: true` trong định nghĩa. Trong **agent loop**, user **không** phải owner sẽ **không** thấy tool trong danh sách function-calling (`getToolDefinitionsForLLM` + `excludeOwnerOnly` trong `agent-run.step.ts`). **User `client`** không có tool nào (mục 1).

| Mã tool (`code`)           | Mô tả ngắn |
| -------------------------- | ---------- |
| `browser`                  | Điều khiển Playwright, cookie, snapshot… |
| `browser_debug_cleanup`    | Xóa/dọn `browser_debug` dưới brain user |
| `skills_registry_manage`   | Registry gói skill dùng chung `_shared/skills/`, `run_skill`, bootstrap… |
| `cron_manage`              | Cron / tác vụ lên lịch |
| `exec`                     | Chạy lệnh shell |

**Lưu ý:** Gọi trực tiếp `/tool_<code>` từ chat **vẫn** gọi `executeSkill` — không qua bộ lọc LLM. User **`client`** bị chặn ở `executeSkill` trước khi vào từng runner (mục 1). Với **owner/colleague**, các skill trên phần lớn có **kiểm tra thêm trong `execute()`** (mục 3–4). Riêng `exec` / `cron_manage` **chỉ** dựa `ownerOnly` cho LLM + chặn `client` toàn cục; **colleague** gọi trực tiếp `/tool_exec` vẫn có thể chạy — nếu cần siết thêm, bổ sung check trong từng skill.

---

## 3. Kiểm tra `UserLevel.OWNER` bên trong `execute()`

Dù tool có trong danh sách hay gọi trực tiếp, các hành vi sau **chặn non-owner** bằng `usersService.findById` + `user.level`:

| Mã tool                    | Phần bị chặn với non-owner |
| -------------------------- | --------------------------- |
| `skills_registry_manage`   | **Toàn bộ** action (kể cả `run_skill`) |
| `memory_write`             | Chỉ các thao tác lên `$BRAIN_DIR/_shared/*.md` đặc biệt: `read_shared_file`, `read_shared_processes`, và `write_file` / `append_file` khi `filename` là một trong các file root được whitelist (PROCESSES, AGENTS, HEARTBEAT, TOOLS, SOUL — xem `owner-shared-markdown.config.ts`) |

---

## 4. Ràng buộc theo Telegram ID (không thay thế `UserLevel`)

| Mã tool              | Điều kiện |
| -------------------- | --------- |
| `bot_access_manage`  | Action `create`, `approve_code`, `revoke`: yêu cầu `actorTelegramId` trùng `users.telegram_id` của user bot (chủ workspace). `list` không cần khớp Telegram. |
| `google_auth_setup`  | Nếu có `actorTelegramId` trong context: chỉ chạy khi trùng `users.telegram_id` của user đó (bảo vệ kênh Telegram). |

---

## 5. Tool **không** `ownerOnly` — **owner & colleague** (trong LLM + `executeSkill`)

User **`client` không** dùng được bảng dưới (mục 1). **Owner & colleague**: có trong danh sách tool LLM (sau khi trừ `ownerOnly` cho non-owner) và gọi được qua `executeSkill`.

Phạm vi thực tế **theo `userId` / `identifier`** (workspace, session, Google token riêng, v.v.).

| Mã tool              | Ghi chú |
| -------------------- | ------- |
| `web_search`         |         |
| `web_fetch`          |         |
| `memory_write`       | Ghi workspace / memory / daily; **không** ghi `_shared` như mục 3 nếu không phải owner |
| `memory_get`         |         |
| `memory_search`      |         |
| `task_memory`        |         |
| `file_read`          | Đường dẫn local — cần cẩn trọng với quyền OS / path server |
| `threads_list`       |         |
| `thread_history`     |         |
| `google_workspace`   | Theo OAuth đã cấu hình cho `userId` |
| `google_auth_setup`  | Thêm ràng buộc Telegram nếu có `actorTelegramId` (mục 4) |
| `message_send`       |         |
| `bot_access_manage`  | Ràng buộc Telegram cho một số action (mục 4) |
| `tts`                |         |
| `image_understand`   |         |
| `pdf_read`           |         |

---

## 6. Liên quan: chọn model (không phải tắt tool)

`model-router.service.ts` dùng `users.level` để **hạ bậc** tier model (ví dụ `client` không lên `EXPERT` trong một số luồng). Đây là **chi phí / chất lượng model**. Việc **tắt tool** với `client` do `agent-run.step.ts` + `executeSkill` (mục 1), không phải do model-router.

---

## 7. Slash command / gateway

Một số lệnh trong `gateway.service.ts` gọi thẳng `skills_registry_manage` hoặc kiểm tra `user.level === OWNER` cho tính năng khác (vd. session note). Chi tiết: `brains/_shared/SYSTEM_COMMANDS.md`.

---

## Kiểm tra nhanh trong repo

```bash
rg "ownerOnly" src/agent/skills/built-in -g '*.ts'
rg "UserLevel\.OWNER" src/agent/skills/built-in -g '*.ts'
rg "UserLevel\.CLIENT" src/agent/skills/skills.service.ts src/agent/pipeline/steps/agent-run.step.ts
```
