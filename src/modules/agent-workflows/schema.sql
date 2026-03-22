-- PostgreSQL — chạy thủ công khi thêm module (TypeORM synchronize: false).
-- Tiến trình OpenClaw nối tiếp: định nghĩa + lịch sử chạy + hàng đợi BullMQ.

CREATE TYPE agent_workflow_run_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed'
);

CREATE TYPE agent_workflow_run_trigger AS ENUM ('manual', 'cron');

CREATE TYPE agent_workflow_run_step_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
);

CREATE TABLE agent_workflows (
  wf_id SERIAL PRIMARY KEY,
  wf_uid INTEGER NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  wf_name VARCHAR(255) NOT NULL,
  wf_description TEXT NULL,
  wf_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  wf_cron_expression VARCHAR(128) NULL,
  wf_cron_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  wf_last_cron_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_workflows_wf_uid ON agent_workflows (wf_uid);

CREATE TABLE agent_workflow_steps (
  wfs_id SERIAL PRIMARY KEY,
  wf_id INTEGER NOT NULL REFERENCES agent_workflows (wf_id) ON DELETE CASCADE,
  wfs_order INTEGER NOT NULL,
  oa_id INTEGER NOT NULL REFERENCES openclaw_agents (oa_id) ON DELETE RESTRICT,
  wfs_input_text TEXT NOT NULL,
  CONSTRAINT uq_agent_workflow_steps_order UNIQUE (wf_id, wfs_order)
);

CREATE INDEX idx_agent_workflow_steps_wf ON agent_workflow_steps (wf_id);

CREATE TABLE agent_workflow_runs (
  wr_id UUID PRIMARY KEY,
  wf_id INTEGER NOT NULL REFERENCES agent_workflows (wf_id) ON DELETE CASCADE,
  wr_uid INTEGER NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  wr_status agent_workflow_run_status NOT NULL DEFAULT 'pending',
  wr_current_step INTEGER NOT NULL DEFAULT 0,
  wr_error TEXT NULL,
  wr_summary TEXT NULL,
  wr_context JSONB NULL,
  wr_trigger agent_workflow_run_trigger NOT NULL DEFAULT 'manual',
  wr_started_at TIMESTAMPTZ NULL,
  wr_finished_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_workflow_runs_wf ON agent_workflow_runs (wf_id, created_at DESC);
CREATE INDEX idx_agent_workflow_runs_uid ON agent_workflow_runs (wr_uid, created_at DESC);

CREATE TABLE agent_workflow_run_steps (
  wrs_id UUID PRIMARY KEY,
  wr_id UUID NOT NULL REFERENCES agent_workflow_runs (wr_id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  oa_id INTEGER NOT NULL REFERENCES openclaw_agents (oa_id) ON DELETE RESTRICT,
  wrs_status agent_workflow_run_step_status NOT NULL DEFAULT 'pending',
  wrs_input TEXT NOT NULL,
  wrs_output TEXT NULL,
  wrs_error TEXT NULL,
  oa_name_snapshot VARCHAR(255) NULL,
  oa_expertise_snapshot TEXT NULL,
  wrs_metadata JSONB NULL,
  wrs_started_at TIMESTAMPTZ NULL,
  wrs_finished_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_agent_workflow_run_steps UNIQUE (wr_id, step_index)
);

CREATE INDEX idx_agent_workflow_run_steps_wr ON agent_workflow_run_steps (wr_id, step_index);
