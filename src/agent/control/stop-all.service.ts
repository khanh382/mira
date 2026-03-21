import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StopAllService {
  private readonly logger = new Logger(StopAllService.name);

  private stopped = false;
  private stoppedAt: Date | null = null;
  private stoppedByUserId: number | null = null;
  private reason: string | null = null;
  private readonly userStops = new Map<
    number,
    { stoppedAt: Date; reason: string | null }
  >();

  activateStop(byUserId: number, reason = '/stopall'): void {
    this.stopped = true;
    this.stoppedAt = new Date();
    this.stoppedByUserId = byUserId;
    this.reason = reason;
    this.logger.warn(
      `GLOBAL STOP activated by user=${byUserId}, reason=${reason}, at=${this.stoppedAt.toISOString()}`,
    );
  }

  resume(byUserId: number): void {
    this.logger.warn(
      `GLOBAL STOP cleared by user=${byUserId}, previousStopBy=${this.stoppedByUserId ?? 'unknown'}`,
    );
    this.stopped = false;
    this.stoppedAt = null;
    this.stoppedByUserId = null;
    this.reason = null;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  activateUserStop(userId: number, reason = '/stop'): void {
    const now = new Date();
    this.userStops.set(userId, { stoppedAt: now, reason });
    this.logger.warn(
      `USER STOP activated for user=${userId}, reason=${reason}, at=${now.toISOString()}`,
    );
  }

  resumeUser(userId: number): void {
    if (this.userStops.has(userId)) {
      this.logger.warn(`USER STOP cleared for user=${userId}`);
    }
    this.userStops.delete(userId);
  }

  isStoppedForUser(userId: number): boolean {
    return this.stopped || this.userStops.has(userId);
  }

  getUserState(userId: number): {
    stopped: boolean;
    stoppedAt: Date | null;
    reason: string | null;
    scope: 'global' | 'user' | 'none';
  } {
    if (this.stopped) {
      return {
        stopped: true,
        stoppedAt: this.stoppedAt,
        reason: this.reason,
        scope: 'global',
      };
    }

    const userStop = this.userStops.get(userId);
    if (userStop) {
      return {
        stopped: true,
        stoppedAt: userStop.stoppedAt,
        reason: userStop.reason,
        scope: 'user',
      };
    }

    return {
      stopped: false,
      stoppedAt: null,
      reason: null,
      scope: 'none',
    };
  }

  getState(): {
    stopped: boolean;
    stoppedAt: Date | null;
    stoppedByUserId: number | null;
    reason: string | null;
  } {
    return {
      stopped: this.stopped,
      stoppedAt: this.stoppedAt,
      stoppedByUserId: this.stoppedByUserId,
      reason: this.reason,
    };
  }
}
