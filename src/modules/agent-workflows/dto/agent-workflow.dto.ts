/** Bước trong body tạo/cập nhật workflow — không dùng class-validator (chưa có trong project). */
export interface AgentWorkflowStepInputDto {
  stepOrder: number;
  oaId: number;
  inputText: string;
}

export interface CreateAgentWorkflowDto {
  name: string;
  description?: string | null;
  enabled?: boolean;
  cronExpression?: string | null;
  cronEnabled?: boolean;
  steps: AgentWorkflowStepInputDto[];
}

export interface UpdateAgentWorkflowDto {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  cronExpression?: string | null;
  cronEnabled?: boolean;
}

export interface ReplaceAgentWorkflowStepsDto {
  steps: AgentWorkflowStepInputDto[];
}
