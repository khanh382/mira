-- Bổ sung vùng nhớ tạm điều phối (JSON) trên mỗi lần chạy workflow.

ALTER TABLE agent_workflow_runs
  ADD COLUMN IF NOT EXISTS wr_context JSONB NULL;
