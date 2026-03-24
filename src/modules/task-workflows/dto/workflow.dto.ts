import { WfTaskOnFailure } from '../entities/workflow-task.entity';

export interface WorkflowTaskInputDto {
  taskId: number;
  taskOrder: number;
  onFailure?: WfTaskOnFailure;
}

export interface CreateWorkflowDto {
  name: string;
  description?: string | null;
  enabled?: boolean;
  tasks: WorkflowTaskInputDto[];
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string | null;
  enabled?: boolean;
}

export interface ReplaceWorkflowTasksDto {
  tasks: WorkflowTaskInputDto[];
}
