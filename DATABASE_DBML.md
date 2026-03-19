# Database Schema (DBDiagram / DBML)

> Schema duoc trich tu cac entity hien tai trong `backend/src`.
> Ban co the copy khoi DBML ben duoi vao [dbdiagram.io](https://dbdiagram.io).

```dbml
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

Table chat_threads {
  thread_id uuid [pk]
  uid integer [ref: > users.uid]
  platform enum('web', 'telegram', 'zalo', 'discord', 'slack', 'facebook') [default: 'web']
  title varchar [null]
  is_active boolean [default: true]
  created_at timestamp
  updated_at timestamp
}

Table chat_messages {
  msg_id uuid [pk]
  thread_id uuid [ref: > chat_threads.thread_id]
  uid integer [ref: > users.uid]
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
```

## Ghi chu

- Bang `config` la global singleton (thuc te thuong chi co 1 dong).
- `skills_registry.min_model_tier` map theo enum code: `cheap | skill | processor | expert`.
- `scheduled_tasks.max_model_tier` hien dang de `varchar` trong entity (chua enum cứng).
