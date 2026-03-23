import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, LessThanOrEqual } from 'typeorm';
import { UserPreference } from '../../modules/users/entities/user-preference.entity';

const DECAY_FACTOR = 0.95;
const STALE_DAYS = 30;
const FORGET_DAYS = 90;
const FORGET_CONFIDENCE_THRESHOLD = 0.3;
const STABLE_MIN_EVIDENCE = 5;
const STABLE_MIN_CONFIDENCE = 0.8;

@Injectable()
export class PreferenceScoringService {
  private readonly logger = new Logger(PreferenceScoringService.name);

  constructor(
    @InjectRepository(UserPreference)
    private readonly prefRepo: Repository<UserPreference>,
  ) {}

  /**
   * Cron 3h sáng — sau memory compaction (2h) và daily consolidation (1h30).
   * 1. Decay preferences cũ > 30 ngày (trừ stable).
   * 2. Xóa preferences > 90 ngày + confidence < 0.3.
   * 3. Promote preferences đủ điều kiện thành stable.
   */
  @Cron('0 0 3 * * *', { name: 'preference_decay', timeZone: 'Asia/Ho_Chi_Minh' })
  async runScheduled(): Promise<void> {
    try {
      await this.decayStalePreferences();
      await this.forgetOldLowConfidence();
      await this.promoteStable();
    } catch (e) {
      this.logger.error(
        `Preference scoring cron failed: ${(e as Error).message}`,
      );
    }
  }

  private async decayStalePreferences(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - STALE_DAYS);

    const stale = await this.prefRepo.find({
      where: {
        lastSeenAt: LessThan(cutoff),
        isStable: false,
      },
    });

    if (!stale.length) return;

    for (const p of stale) {
      p.confidence = Math.max(0.05, p.confidence * DECAY_FACTOR);
    }

    await this.prefRepo.save(stale);
    this.logger.debug(`Decayed ${stale.length} stale preferences.`);
  }

  private async forgetOldLowConfidence(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - FORGET_DAYS);

    const result = await this.prefRepo.delete({
      lastSeenAt: LessThan(cutoff),
      confidence: LessThanOrEqual(FORGET_CONFIDENCE_THRESHOLD),
      isStable: false,
    });

    if (result.affected && result.affected > 0) {
      this.logger.debug(
        `Forgot ${result.affected} low-confidence old preferences.`,
      );
    }
  }

  private async promoteStable(): Promise<void> {
    const candidates = await this.prefRepo
      .createQueryBuilder('p')
      .where('p.is_stable = false')
      .andWhere('p.evidence_count >= :minEvidence', {
        minEvidence: STABLE_MIN_EVIDENCE,
      })
      .andWhere('p.confidence >= :minConf', {
        minConf: STABLE_MIN_CONFIDENCE,
      })
      .getMany();

    if (!candidates.length) return;

    for (const c of candidates) {
      c.isStable = true;
    }

    await this.prefRepo.save(candidates);
    this.logger.debug(`Promoted ${candidates.length} preferences to stable.`);
  }
}
