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

/** Thêm 1 task vào workflow tại vị trí chỉ định. */
export interface AddWorkflowTaskDto {
  taskId: number;
  /** Chèn sau task có taskOrder này. Không truyền = thêm vào cuối. */
  insertAfterOrder?: number;
  onFailure?: WfTaskOnFailure;
}

/** Cập nhật thuộc tính của 1 workflow-task entry (có thể đổi task, đổi thứ tự, đổi onFailure). */
export interface PatchWorkflowTaskDto {
  /** Đổi sang task khác (swap). */
  taskId?: number;
  /** Di chuyển đến vị trí order mới (drag-drop reorder). */
  taskOrder?: number;
  onFailure?: WfTaskOnFailure;
}
