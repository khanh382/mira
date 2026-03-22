# System Commands Catalog

Tai lieu nay liet ke cac lenh thuc thi hien co trong he thong backend (slash command, tool/skill command, hook event).

## 1) Slash Commands (chat command)

Nguon: `src/gateway/gateway.service.ts`

- `/new_session` (chap nhan bien the typo `/new_sesssion`, va suffix Telegram `@BotName`)
  - Tao thread moi, reset session hien tai.
- `/stop`
  - Dung cac tac vu cua chinh user hien tai.
- `/resume`
  - Bat lai tac vu cho user hien tai.
- `/stopall`
  - Dung toan bo he thong (owner/colleague).
- `/resumeall`
  - Bat lai he thong sau stopall (owner).
- `/menu`
  - Tom tat lenh he thong + gợi ý (cung noi dung menu bot).
- `/agents` (cung `/oa list`)
  - **Chi chu bot:** liet ke agent **system** va cac OpenClaw da dang ky (`openclaw_agents`). Dung `/oa use <oa_id>` de chon OpenClaw, `/oa use system` ve pipeline noi bo. Chi tiet trong noi dung `/menu`.

### 1.0 Menu tren Telegram / Discord / Zalo

Nguon: `src/modules/bot-users/bot-platform-menu.ts`, `BotDeliveryService`, `BotBootstrapService`

- **Telegram:** Sau khi `setWebhook` (va dinh ky bot sync), backend goi `setMyCommands` — user go `/` trong chat se thay cac lenh (menu, agents, list_skills, list_other_skills, new_session, brain_tree, stop, resume, stopall, resumeall). **Khong** co `list_tools` tren menu (trung lap voi `/list_skills`; van go duoc `/list_tools` trong chat). Doc file trong brain user: `/brain_read <duong dan>` (xem `/menu`).
  - **Album (nhieu anh/video/file):** Telegram gui nhieu update cung `media_group_id`. Backend gom (debounce ~450ms), tai tat ca file, goi **mot lan** `handleMessage` voi `mediaPaths[]` + caption (neu co). Mot tin don le (khong album) van la mot file nhu truoc.
- **Discord:** Dang ky **slash command** toan cuc (`PUT /applications/{id}/commands`), gom `/agents`. Interaction slash duoc map thanh `/ten_lenh` truoc khi vao gateway (giong go lenh trong chat).
- **Zalo:** Khong co API tuong duong `setMyCommands`. User go `menu`, `lenh`, `help`, `lệnh` hoac `/menu` — tra loi noi dung `/menu` + **quick reply** (nut) cho mot so lenh (neu OA API chap nhan `quick_replies`). Nut gom `/agents` (dau tien), `/list_skills`, `/list_other_skills`, `/new_session`, `/stop`.

### 1.1 Command-first parser (uu tien chay lenh truoc agent loop)

Nguon: `src/gateway/gateway.service.ts` (`tryHandleCommandFirst`)

- `/brain_tree`
  - **Mot cap** tu goc user (chi muc truc tiep duoi goc; xem sau hon dung `/brain_read`). Khong sua file.
- `/brain_read` hoac `/brain_read <duong_dan>`
  - **Thu muc** (hoac bo trong = goc user): liet ke **mot cap** file/con + goi y lenh `/brain_read ...` tiep.
  - **File**: noi dung UTF-8 (toi da ~2MB, ~48k ky tu hoi dap; cat neu dai). Chan `..` thoat khoi thu muc user.
- `/clean_media_incoming`
  - (Khong tren menu bot) Xoa noi dung `media/incoming` cua tai khoan dang chat.
- `/list_tools`
  - Liet ke **mã tool code** dang ky trong backend (`@RegisterSkill`), giong `/list_skills`.
- `/list_skills`
  - Giong `/list_tools`.
- `/list_other_skills` (alias go nham: `/list_orther_skills`)
  - Liet ke skill package tren dia duoi `heart/_shared/skills/<skill_code>/` (goi `skills_registry_manage` + `list_registry`). Owner-only nhu tool do.
- `/run_skill <skillCode> <params>`
  - Chay shared skill qua `skills_registry_manage`.
  - `params` ho tro:
    - JSON: `{"content":"Xin chao"}`
    - hoac key=value: `content="Xin chao" delayMs=2000`
- `/delete_skill <skillCode>`
  - Owner: xoa package `heart/_shared/skills/<skillCode>/` (hoac file legacy `.skill.json`) qua `skills_registry_manage` + `delete_skill` + `confirmDelete=true`.
- `/update_skill <skillCode> <patch>`
  - Owner: merge `patch` vao `skill.json` (JSON object hoac key=value nhu `/run_skill`). Vi du: `/update_skill facebook_post_personal_v2 {"executionNotes":"..."}`
- `/tool_<toolCode> <jsonParams>` (khuyen nghi — **khong** co khoang trang giua `tool` va ten `toolCode`)
  - Chay **truc tiep** code tool (bat buoc JSON object).
  - Vi du: `/tool_browser {"action":"navigate","url":"https://example.com"}`
- `/tool <toolCode> <jsonParams>` (dang legacy)
  - Tuong tu `tool_<toolCode>` nhung co khoang trang giua `tool` va ten `toolCode`.

### 1.2 Gợi ý tool trong câu (agent pipeline)

Nguon: `src/gateway/gateway.service.ts` (`collectToolHintsFromText` + `buildPipelineUserContent`)

- Trong **bat ky** cho nao trong tin nhan (khong can o dau dong), token `/<tool_code>` hoac `@<tool_code>` voi `tool_code` dang **mot token** (chi `a-zA-Z0-9_`, vi du: `/web_search`, `/open_x`, **khong** viet `/web search` hay `/open x`).
- Neu khop voi mot code skill da dang ky trong registry, he thong se:
  - Them dong `[Hệ thống] Người dùng chỉ định dùng tool: ...` vao prompt cho LLM.
  - Truyen `skills` vao pipeline (route tier) — **khong** chay `executeSkill` truc tiep tu gateway.
- Tu `browser` hoac `web_search` **khong** co `/` hoac `@` dung truoc: la **van ban thuong** — model tu phan tich, khong co goi y tool tu khoa dong.
- `/` trong URL (sau chu/so) bi bo qua de tranh nham.
- `/list_tools`, `/run_skill`, `tool` (segment rieng) ... vẫn la command hoac khong map sang tool goi y.

## 2) Tool/Skill Commands (function tools)

Nguon: `src/agent/skills/built-in/**`

### 2.1 Danh sach tool code

- `browser`
- `browser_debug_cleanup`
- `skills_registry_manage`
- `task_memory`
- `google_workspace`
- `google_auth_setup`
- `cron_manage`
- `exec`
- `file_read`
- `web_fetch`
- `web_search`
- `bot_access_manage`
- `message_send`
- `threads_list`
- `thread_history`
- `memory_get`
- `memory_search`
- `memory_write`
- `image_understand`
- `tts`
- `pdf_read`

### 2.2 Tool co action/mode quan trong

- `browser`
  - `action`: `navigate`, `screenshot`, `snapshot`, `snapshot_save`, `click`, `type`, `scroll`, `evaluate`, `pdf`, `status`, `cookies_load`, `cookies_save`
- `skills_registry_manage`
  - `action`: `suggest`, `create`, `bootstrap_skill`, `list_registry`, `find_candidates`, `select_candidate`, `run_selected`, `run_skill`, **`delete_skill`**, **`update_skill`**
  - **Owner-only** (như toàn bộ tool này). Xóa / sửa package dưới `heart/_shared/skills/`:
    - **`delete_skill`**: `skillCode` + **`confirmDelete`: true** — xóa cả thư mục `<skill_code>/` hoặc file legacy `<skill_code>.skill.json`.
    - **`update_skill`**: `skillCode` + **`confirmUpdate`: true** + **`patch`**: object merge vào `skill.json` (bước `steps`, `executionNotes`, `description`, …); tùy chọn `regenerateReadme` (mặc định true) để ghi lại `README.md` trong package.
- `task_memory`
  - `action`: `read`, `append_note`, `set_status`, `list_tasks`
- `bot_access_manage`
  - `action`: `create`, `approve_code`, `revoke`, `list`
- `cron_manage`
  - `action`: `list`, `add`, `remove`, `pause`, `resume`, `status`, `set_global_rules`
- `google_workspace`
  - Param bat buoc: `service` + `action`
  - `service`: `gmail`, `calendar`, `drive`, `sheets`, `docs`, `slides`, `contacts`, `tasks`, `forms`, `chat`, `keep`, `auth`
- `google_auth_setup`
  - `mode`: `remote_step1`, `remote_step2`, `manual`
- `browser_debug_cleanup`
  - Param dieu khien: `groupId` hoac `deleteAll=true`, ho tro `dryRun`

## 3) Hook Events (pipeline hooks)

Nguon: `src/agent/hooks/enums/hook-events.enum.ts`

### 3.1 Internal hooks

- `message.received`
- `message.transcribed`
- `message.preprocessed`
- `message.sent`
- `command.new`
- `command.reset`
- `command.stop`
- `agent.bootstrap`
- `gateway.startup`
- `gateway.shutdown`
- `session.compact.before`
- `session.compact.after`

### 3.2 Plugin hooks

- `before_model_resolve`
- `before_prompt_build`
- `before_agent_start`
- `llm_input`
- `llm_output`
- `agent_end`
- `before_compaction`
- `after_compaction`
- `before_reset`
- `message_received`
- `message_sending`
- `message_sent`
- `before_tool_call`
- `after_tool_call`
- `tool_result_persist`
- `before_message_write`
- `session_start`
- `session_end`
- `subagent_spawning`
- `subagent_spawned`
- `subagent_ended`

## 4) Vi du command thuc thi

- Tao session moi:
  - `/new_session`
- Chay shared skill:
  - `/run_skill facebook_post_status_v2 {"content":"Xin chao"}`
- Don browser debug:
  - Tool: `browser_debug_cleanup`
  - Payload:
    - `deleteAll=true`
- Chay tool bat ky:
  - `/tool skills_registry_manage {"action":"list_registry"}`

## 5) Gợi ý từ phía agent (sau tác vụ phức tạp)

- System prompt có khối hướng dẫn (inject trong `WorkspaceService.buildAgentSystemContext`): model nên thêm mục **Gợi ý bước tiếp theo** kèm câu lệnh copy được (`/tool_<code>`, `/run_skill`, hoặc `/browser` / `/web_search` trong câu).
- Xem thêm `heart/_shared/AGENTS.md` mục "Gợi ý bước tiếp theo".

