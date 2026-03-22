-- PostgreSQL — chạy thủ công khi thêm module (TypeORM synchronize: false).
-- OpenClaw Gateway: https://github.com/openclaw/openclaw

CREATE TYPE openclaw_agent_status AS ENUM ('active', 'disabled');

CREATE TYPE openclaw_message_role AS ENUM ('system', 'user', 'assistant', 'tool');

CREATE TABLE openclaw_agents (
  oa_id SERIAL PRIMARY KEY,
  oa_name VARCHAR NOT NULL,
  oa_uid INTEGER NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  oa_domain VARCHAR NOT NULL,
  oa_port VARCHAR(16) NOT NULL,
  oa_use_tls BOOLEAN NOT NULL DEFAULT FALSE,
  oa_chat_path VARCHAR NULL,
  oa_token_gateway VARCHAR NULL,
  oa_password_gateway VARCHAR NULL,
  oa_expertise TEXT NULL,
  oa_status openclaw_agent_status NOT NULL DEFAULT 'active',
  oa_last_health_at TIMESTAMPTZ NULL,
  oa_last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_openclaw_agents_oa_uid ON openclaw_agents (oa_uid);

CREATE TABLE openclaw_threads (
  oct_id UUID PRIMARY KEY,
  uid INTEGER NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  oa_id INTEGER NOT NULL REFERENCES openclaw_agents (oa_id) ON DELETE CASCADE,
  chat_thread_id UUID NULL REFERENCES chat_threads (thread_id) ON DELETE SET NULL,
  openclaw_session_key VARCHAR NULL,
  platform VARCHAR NOT NULL DEFAULT 'web',
  telegram_id VARCHAR NULL,
  zalo_id VARCHAR NULL,
  discord_id VARCHAR NULL,
  title VARCHAR NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_openclaw_threads_uid_oa ON openclaw_threads (uid, oa_id);
CREATE INDEX idx_openclaw_threads_chat_thread ON openclaw_threads (chat_thread_id);

CREATE TABLE openclaw_messages (
  ocm_id UUID PRIMARY KEY,
  oct_id UUID NOT NULL REFERENCES openclaw_threads (oct_id) ON DELETE CASCADE,
  uid INTEGER NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  role openclaw_message_role NOT NULL,
  content TEXT NOT NULL,
  oa_display_name VARCHAR NULL,
  extra JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_openclaw_messages_oct_created ON openclaw_messages (oct_id, created_at);

-- Bảng đã tồn tại: thêm cột định tuyến OpenClaw trên thread chat hệ thống
-- ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS active_openclaw_oa_id INTEGER NULL REFERENCES openclaw_agents (oa_id) ON DELETE SET NULL;
