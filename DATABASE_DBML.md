# Database Schema (DBDiagram / DBML)

> Schema trích từ các entity trong `src/**/*.entity.ts` (thêm các bảng `agent_workflows`, `agent_workflow_steps`, `agent_workflow_runs`, `agent_workflow_run_steps` cho tiến trình OpenClaw; DDL `src/modules/agent-workflows/schema.sql`).
> Có thể copy khối DBML vào [dbdiagram.io](https://dbdiagram.io).

```dbml
// Cấu hình API key và tham số scheduler toàn cục (thường một dòng).
Table config {
  cof_id integer [pk, increment]
  cof_openai_api_key varchar [null]
  cof_gemini_api_key varchar [null]
  cof_anthropic_api_key varchar [null]
  cof_openrouter_api_key varchar [null]
  cof_deepseek_api_key varchar [null]
  cof_kimi_api_key varchar [null]
  cof_zai_api_key varchar [null]
  cof_perplexity_api_key varchar [null]
  cof_brave_api_key varchar [null]
  cof_firecrawl_api_key varchar [null]
  cof_scheduler_max_retries_per_tick integer [null]
  cof_scheduler_max_consecutive_failed_ticks integer [null]
}

// Tài khoản người dùng: đăng nhập, kênh liên kết, vai trò (owner/colleague/client).
Table users {
  uid integer [pk, increment]
  identifier varchar [unique]
  uname varchar [unique]
  email varchar [unique]
  telegram_id varchar [unique, null]
  zalo_id varchar [unique, null]
  discord_id varchar [unique, null]
  slack_id varchar [unique, null]
  facebook_id varchar [unique, null]
  ggauth_token varchar [unique, null]
  password varchar
  active_email boolean [default: false]
  use_ggauth boolean [default: false]
  level enum('owner', 'colleague', 'client') [default: 'client']
  status enum('active', 'block') [default: 'active']
  created_at timestamp
  update_at timestamp
}

// Một user có thể có bot: token/cấu hình theo nền tảng (Telegram, Discord, …).
Table bot_users {
  bu_id integer [pk, increment]
  bu_uid integer [unique, ref: > users.uid]
  bu_telegram_bot_token varchar [null]
  bu_discord_bot_token varchar [null]
  bu_slack_bot_token varchar [null]
  bu_zalo_bot_token varchar [null]
  bu_google_console_cloud_json_path varchar [null]
  created_at timestamp
  update_at timestamp
}

// Cấp quyền user nền tảng (Telegram/Zalo/…) được phép dùng bot (verify, grant).
Table bot_access_grants {
  grant_id integer [pk, increment]
  bu_id integer [ref: > bot_users.bu_id]
  platform enum('telegram', 'discord', 'slack', 'zalo')
  platform_user_id varchar
  granted_by integer [ref: > users.uid]
  verification_code varchar [null]
  is_verified boolean [default: false]
  created_at timestamp
}

// Luồng hội thoại chat hệ thống (web hoặc bot): thread_id, kênh, tiêu đề, route OpenClaw tùy chọn.
Table chat_threads {
  thread_id uuid [pk]
  uid integer [ref: > users.uid]
  platform enum('web', 'telegram', 'zalo', 'discord', 'slack', 'facebook') [default: 'web']
  telegram_id varchar [null]
  zalo_id varchar [null]
  discord_id varchar [null]
  title varchar [null]
  is_active boolean [default: true]
  active_openclaw_oa_id integer [null]
  created_at timestamp
  updated_at timestamp
}

// Tin nhắn trong thread chat: role, nội dung, vector hóa / export.
Table chat_messages {
  msg_id uuid [pk]
  thread_id uuid [ref: > chat_threads.thread_id]
  uid integer [ref: > users.uid]
  telegram_id varchar [null]
  zalo_id varchar [null]
  discord_id varchar [null]
  role enum('system', 'user', 'assistant', 'tool')
  content text
  tokens_used integer [default: 0]
  is_vectorized boolean [default: false]
  is_exported boolean [default: false]
  created_at timestamp

  Indexes {
    (thread_id, created_at)
    (is_vectorized)
  }
}

// Đăng ký skill (tool) dùng trong pipeline: mã, mô tả, tier model tối thiểu.
Table skills_registry {
  skill_id integer [pk, increment]
  skill_code varchar [unique]
  skill_name varchar
  description text
  file_path varchar
  parameters_schema json [null]
  min_model_tier enum('cheap', 'skill', 'processor', 'expert') [default: 'cheap']
  is_active boolean [default: true]
  created_at timestamp
  updated_at timestamp
}

// Tác vụ theo lịch (cron) gắn user: prompt agent, skill cho phép, thống kê chạy.
Table scheduled_tasks {
  task_id integer [pk, increment]
  uid integer [ref: > users.uid]
  task_code varchar [unique]
  name varchar
  description text [null]
  cron_expression varchar
  agent_prompt text
  allowed_skills json [null]
  source enum('heartbeat', 'agent', 'manual') [default: 'agent']
  status enum('active', 'paused', 'disabled') [default: 'active']
  max_retries integer [default: 3]
  consecutive_failures integer [default: 0]
  total_failures integer [default: 0]
  total_successes integer [default: 0]
  auto_pause_on_max_retries boolean [default: true]
  max_tokens_per_run integer [default: 0]
  max_model_tier varchar [null]
  timeout_ms integer [default: 120000]
  last_run_at timestamp [null]
  last_success_at timestamp [null]
  last_error text [null]
  next_run_at timestamp [null]
  created_at timestamp
  updated_at timestamp
}

// Đăng ký OpenClaw Gateway do user tự host: domain/port, relay path, sở trường (expertise).
Table openclaw_agents {
  oa_id integer [pk, increment]
  oa_name varchar
  oa_uid integer [ref: > users.uid]
  oa_domain varchar
  oa_port varchar
  oa_use_tls boolean [default: false]
  oa_chat_path varchar [null]
  oa_token_gateway varchar [null]
  oa_password_gateway varchar [null]
  oa_expertise text [null]
  oa_status enum('active', 'disabled') [default: 'active']
  oa_last_health_at timestamp [null]
  oa_last_error text [null]
  created_at timestamp
  updated_at timestamp
}

// Định nghĩa tiến trình nối tiếp nhiều agent OpenClaw: tên, bật/tắt, cron tùy chọn.
Table agent_workflows {
  wf_id integer [pk, increment]
  wf_uid integer [ref: > users.uid]
  wf_name varchar
  wf_description text [null]
  wf_enabled boolean [default: true]
  wf_cron_expression varchar(128) [null]
  wf_cron_enabled boolean [default: false]
  wf_last_cron_at timestamptz [null]
  created_at timestamptz
  updated_at timestamptz
}

// Các bước trong một workflow: thứ tự, agent (oa_id), prompt/template đầu vào.
Table agent_workflow_steps {
  wfs_id integer [pk, increment]
  wf_id integer [ref: > agent_workflows.wf_id]
  wfs_order integer
  oa_id integer [ref: > openclaw_agents.oa_id]
  wfs_input_text text
}

// Một lần chạy workflow (thủ công hoặc cron): trạng thái, tóm tắt, lỗi; wr_context = nhớ tạm điều phối (JSON).
Table agent_workflow_runs {
  wr_id uuid [pk]
  wf_id integer [ref: > agent_workflows.wf_id]
  wr_uid integer [ref: > users.uid]
  wr_status varchar
  wr_current_step integer
  wr_error text [null]
  wr_summary text [null]
  wr_context jsonb [null]
  wr_trigger varchar
  wr_started_at timestamptz [null]
  wr_finished_at timestamptz [null]
  created_at timestamptz
}

// Chi tiết từng bước trong một lần chạy: input/output, snapshot tên & sở trường agent.
Table agent_workflow_run_steps {
  wrs_id uuid [pk]
  wr_id uuid [ref: > agent_workflow_runs.wr_id]
  step_index integer
  oa_id integer [ref: > openclaw_agents.oa_id]
  wrs_status varchar
  wrs_input text
  wrs_output text [null]
  wrs_error text [null]
  oa_name_snapshot varchar(255) [null]
  oa_expertise_snapshot text [null]
  wrs_metadata jsonb [null]
  wrs_started_at timestamptz [null]
  wrs_finished_at timestamptz [null]
}

// Phiên chat OpenClaw (tách khỏi chat_threads): session key, gắn thread UI tùy chọn.
Table openclaw_threads {
  oct_id uuid [pk]
  uid integer [ref: > users.uid]
  oa_id integer [ref: > openclaw_agents.oa_id]
  chat_thread_id uuid [ref: > chat_threads.thread_id, null]
  openclaw_session_key varchar [null]
  platform enum('web', 'telegram', 'zalo', 'discord', 'slack', 'facebook') [default: 'web']
  telegram_id varchar [null]
  zalo_id varchar [null]
  discord_id varchar [null]
  title varchar [null]
  created_at timestamp
  updated_at timestamp
}

// Tin nhắn trong phiên OpenClaw: role, nội dung, metadata JSON (extra).
Table openclaw_messages {
  ocm_id uuid [pk]
  oct_id uuid [ref: > openclaw_threads.oct_id]
  uid integer [ref: > users.uid]
  role enum('system', 'user', 'assistant', 'tool')
  content text
  oa_display_name varchar [null]
  extra jsonb [null]
  created_at timestamp
}
```

## Ghi chu

- Bảng `config` là global singleton (thực tế thường chỉ một dòng).
- `skills_registry.min_model_tier` map theo enum: `cheap | skill | processor | expert`.
- `scheduled_tasks.max_model_tier` trong entity là `varchar` (chưa enum cứng).
- `users.update_at` và `bot_users.update_at` (không phải `updated_at`) đúng tên cột TypeORM; `chat_threads` / `chat_messages` dùng `updated_at`.
- `chat_threads` / `chat_messages`: cột `telegram_id`, `zalo_id`, `discord_id` theo kênh (nullable).
- `chat_threads.active_openclaw_oa_id`: khi set, thread có thể proxy sang OpenClaw Gateway (xem `SYSTEM_COMMANDS.md`).
- OpenClaw (`src/modules/openclaw-agents/`): đăng ký Gateway do user tự host; `openclaw_threads` / `openclaw_messages` tách khỏi `chat_*`. Cột `openclaw_messages.extra` là **JSONB** trong PostgreSQL (entity `jsonb`). DDL: `schema.sql`.
- Tiến trình OpenClaw nối tiếp: `agent_workflow_runs.wr_summary`, **`wr_context`** (JSONB nhớ tạm điều phối); `agent_workflow_run_steps` lưu snapshot `oa_name_snapshot`, `oa_expertise_snapshot` và `wrs_metadata` (JSONB). Mô tả: `brains/_shared/WORKFLOW_RUN_HISTORY.md`.
