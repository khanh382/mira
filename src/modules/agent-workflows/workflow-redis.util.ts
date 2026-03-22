import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

export function getWorkflowRedisConnection(config: ConfigService): {
  host: string;
  port: number;
  password?: string;
} {
  return {
    host: config.get<string>('REDIS_HOST', '127.0.0.1'),
    port: Number(config.get<string>('REDIS_PORT', '6379')),
    ...(config.get<string>('REDIS_PASSWORD')
      ? { password: config.get<string>('REDIS_PASSWORD') }
      : {}),
  };
}

/** Ping nhanh — không giữ kết nối. Dùng để quyết định BullMQ hay fallback RAM. */
export async function pingWorkflowRedis(
  config: ConfigService,
): Promise<boolean> {
  if (config.get<string>('WORKFLOW_FORCE_MEMORY', 'false') === 'true') {
    return false;
  }
  const { host, port, password } = getWorkflowRedisConnection(config);
  const client = createClient({
    socket: {
      host,
      port,
      connectTimeout: 2000,
    },
    ...(password ? { password } : {}),
  });
  try {
    await client.connect();
    const pong = await client.ping();
    await client.quit();
    return pong === 'PONG';
  } catch {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    return false;
  }
}
