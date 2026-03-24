import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Workflow } from './workflow.entity';
import { Task } from '../../tasks/entities/task.entity';

export enum WfTaskOnFailure {
  STOP = 'stop',
  SKIP = 'skip',
  CONTINUE = 'continue',
}

@Entity('workflow_tasks')
export class WorkflowTask {
  @PrimaryGeneratedColumn({ name: 'wt_id' })
  id: number;

  @Column({ name: 'wf_id' })
  workflowId: number;

  @ManyToOne(() => Workflow, (w) => w.workflowTasks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wf_id' })
  workflow: Workflow;

  @Column({ name: 'task_id' })
  taskId: number;

  @ManyToOne(() => Task, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @Column({ name: 'task_order' })
  taskOrder: number;

  @Column({
    name: 'on_failure',
    type: 'enum',
    enum: WfTaskOnFailure,
    default: WfTaskOnFailure.STOP,
  })
  onFailure: WfTaskOnFailure;
}
