import { CronExpressionParser } from 'cron-parser';

/**
 * Quyết định có nên enqueue lần chạy cron hay không (tick mỗi phút).
 * Tránh bắn trùng: chỉ fire khi slot lịch gần đây và lastCronAt chưa bao phủ slot đó.
 */
export function shouldFireCron(
  cronExpr: string,
  lastCronAt: Date | null,
  now: Date = new Date(),
): boolean {
  try {
    const interval = CronExpressionParser.parse(cronExpr, { currentDate: now });
    const prev = interval.prev().toDate();
    if (now.getTime() - prev.getTime() > 90_000) {
      return false;
    }
    if (!lastCronAt) {
      return true;
    }
    return lastCronAt.getTime() < prev.getTime();
  } catch {
    return false;
  }
}
