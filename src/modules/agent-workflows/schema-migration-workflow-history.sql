-- Bổ sung lịch sử / snapshot sở trường agent (chạy thủ công trên DB đã tạo bảng cũ).

ALTER TABLE agent_workflow_runs
  ADD COLUMN IF NOT EXISTS wr_summary TEXT NULL;

ALTER TABLE agent_workflow_run_steps
  ADD COLUMN IF NOT EXISTS oa_name_snapshot VARCHAR(255) NULL;

ALTER TABLE agent_workflow_run_steps
  ADD COLUMN IF NOT EXISTS oa_expertise_snapshot TEXT NULL;

ALTER TABLE agent_workflow_run_steps
  ADD COLUMN IF NOT EXISTS wrs_metadata JSONB NULL;
