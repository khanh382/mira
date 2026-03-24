import { OpenclawAgentStatus } from '../entities/openclaw-agent.entity';

export interface CreateOpenclawAgentDto {
  name: string;
  domain: string;
  /** Cổng dạng string, ví dụ "18789". */
  port: string;
  useTls?: boolean;
  chatPath?: string | null;
  gatewayToken?: string | null;
  gatewayPassword?: string | null;
  expertise?: string | null;
}

export interface UpdateOpenclawAgentDto {
  name?: string;
  domain?: string;
  port?: string;
  useTls?: boolean;
  chatPath?: string | null;
  /** Truyền chuỗi rỗng "" để xoá token. */
  gatewayToken?: string | null;
  /** Truyền chuỗi rỗng "" để xoá password. */
  gatewayPassword?: string | null;
  expertise?: string | null;
  status?: OpenclawAgentStatus;
}

/** Shape trả về API — không bao gồm gatewayToken và gatewayPassword. */
export interface PublicOpenclawAgent {
  id: number;
  name: string;
  ownerUserId: number;
  domain: string;
  port: string;
  useTls: boolean;
  chatPath: string | null;
  expertise: string | null;
  status: OpenclawAgentStatus;
  lastHealthAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** true nếu gatewayToken đang được lưu (không lộ giá trị). */
  hasGatewayToken: boolean;
  /** true nếu gatewayPassword đang được lưu (không lộ giá trị). */
  hasGatewayPassword: boolean;
}

export interface ListOpenclawSessionsQuery {
  agentId?: number;
  chatThreadId?: string;
}

export interface SwitchOpenclawSessionDto {
  /** Thread WEB muốn gắn với session OpenClaw đã có. */
  chatThreadId: string;
}

export interface NewOpenclawSessionDto {
  /** Thread WEB hiện tại. */
  chatThreadId: string;
  /**
   * Nếu truyền thì ưu tiên agent này.
   * Nếu không truyền, dùng activeOpenclawAgentId của chat thread.
   */
  agentId?: number;
}
