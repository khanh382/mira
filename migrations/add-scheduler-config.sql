-- Thêm cột quy tắc chung cho scheduler/heartbeat (owner thiết lập)
-- Chạy: psql -U user -d database -f migrations/add-scheduler-config.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='cof_scheduler_max_retries_per_tick') THEN
    ALTER TABLE config ADD COLUMN cof_scheduler_max_retries_per_tick INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='config' AND column_name='cof_scheduler_max_consecutive_failed_ticks') THEN
    ALTER TABLE config ADD COLUMN cof_scheduler_max_consecutive_failed_ticks INTEGER;
  END IF;
END $$;
