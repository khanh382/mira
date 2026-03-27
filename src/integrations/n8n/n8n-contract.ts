export type N8nDispatchWorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT';

export interface IN8nDispatchRequestBody {
  dispatchId: string;
  workflowKey: string;
  idempotencyKey: string;
  userContext: {
    userId: number;
    identifier?: string;
    level?: string;
  };
  threadContext: {
    threadId: string;
    platform?: string;
  };
  payload: Record<string, unknown>;
  callback: {
    url: string;
  };
}

export interface IN8nCallbackBody {
  dispatchId: string;
  workflowKey?: string;
  executionId?: string;
  status: N8nDispatchWorkflowStatus;
  result?: unknown;
  error?: string;
  metrics?: Record<string, unknown>;
}

