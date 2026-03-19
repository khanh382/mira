import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { BotAccessGrant, BotPlatform } from './entities/bot-access-grant.entity';
import { BotUser } from './entities/bot-user.entity';
import { UsersService } from '../users/users.service';

/**
 * BotAccessService — quản lý quyền truy cập bot per-platform.
 *
 * Quy tắc mặc định:
 *   Bot Telegram của user1 → chỉ telegram_id của user1 được tương tác.
 *   Bot Discord của user1 → chỉ discord_id của user1 được tương tác.
 *   ...
 *
 * Mở rộng:
 *   Owner có thể cấp quyền cho platform_id khác thông qua verification code.
 *   Flow: owner tạo grant → hệ thống sinh mã → guest nhắn mã vào bot → verified.
 */
@Injectable()
export class BotAccessService {
  private readonly logger = new Logger(BotAccessService.name);

  private readonly platformToUserField: Record<BotPlatform, string> = {
    [BotPlatform.TELEGRAM]: 'telegramId',
    [BotPlatform.DISCORD]: 'discordId',
    [BotPlatform.SLACK]: 'slackId',
    [BotPlatform.ZALO]: 'zaloId',
  };

  private readonly platformToBotTokenField: Record<BotPlatform, keyof BotUser> = {
    [BotPlatform.TELEGRAM]: 'telegramBotToken',
    [BotPlatform.DISCORD]: 'discordBotToken',
    [BotPlatform.SLACK]: 'slackBotToken',
    [BotPlatform.ZALO]: 'zaloBotToken',
  };

  constructor(
    @InjectRepository(BotAccessGrant)
    private readonly grantRepo: Repository<BotAccessGrant>,
    @InjectRepository(BotUser)
    private readonly botUserRepo: Repository<BotUser>,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Kiểm tra xem platformUserId có quyền tương tác với bot không.
   *
   * 1. Tìm BotUser theo bot token
   * 2. Lấy owner (User) của bot
   * 3. Kiểm tra: platformUserId === owner's platform_id? → OK
   * 4. Không phải owner → kiểm tra bot_access_grants đã verified
   */
  async checkAccess(
    botToken: string,
    platform: BotPlatform,
    platformUserId: string,
  ): Promise<{ allowed: boolean; botUser?: BotUser; ownerUid?: number }> {
    const tokenField = this.platformToBotTokenField[platform];
    const botUser = await this.botUserRepo.findOne({
      where: { [tokenField]: botToken } as any,
      relations: ['user'],
    });

    if (!botUser) {
      return { allowed: false };
    }

    const owner = botUser.user;
    const ownerPlatformId = owner[this.platformToUserField[platform]];

    if (ownerPlatformId === platformUserId) {
      return { allowed: true, botUser, ownerUid: owner.uid };
    }

    const grant = await this.grantRepo.findOne({
      where: {
        botUserId: botUser.id,
        platform,
        platformUserId,
        isVerified: true,
      },
    });

    if (grant) {
      return { allowed: true, botUser, ownerUid: owner.uid };
    }

    return { allowed: false, botUser, ownerUid: owner.uid };
  }

  /**
   * Tìm BotUser theo platform + bot token.
   */
  async findBotByToken(
    botToken: string,
    platform: BotPlatform,
  ): Promise<BotUser | null> {
    const tokenField = this.platformToBotTokenField[platform];
    return this.botUserRepo.findOne({
      where: { [tokenField]: botToken } as any,
      relations: ['user'],
    });
  }

  /**
   * Tạo lời mời truy cập bot — sinh verification code.
   */
  async createInvite(
    ownerUid: number,
    platform: BotPlatform,
    platformUserId: string,
  ): Promise<{ code: string; grantId: number }> {
    const botUser = await this.botUserRepo.findOne({
      where: { userId: ownerUid },
    });
    if (!botUser) {
      throw new Error('Bot not configured for this user');
    }

    const code = randomBytes(3).toString('hex').toUpperCase();

    const grant = this.grantRepo.create({
      botUserId: botUser.id,
      platform,
      platformUserId,
      grantedBy: ownerUid,
      verificationCode: code,
      isVerified: false,
    });
    const saved = await this.grantRepo.save(grant);

    this.logger.log(
      `Access invite created: bot ${botUser.id}, platform ${platform}, ` +
      `target ${platformUserId}, code ${code}`,
    );

    return { code, grantId: saved.id };
  }

  /**
   * Xác thực mã code — guest nhắn mã vào bot.
   * Nếu match → đánh dấu verified, trả về true.
   */
  async verifyCode(
    botToken: string,
    platform: BotPlatform,
    platformUserId: string,
    code: string,
  ): Promise<boolean> {
    const botUser = await this.findBotByToken(botToken, platform);
    if (!botUser) return false;

    const grant = await this.grantRepo.findOne({
      where: {
        botUserId: botUser.id,
        platform,
        platformUserId,
        verificationCode: code.toUpperCase().trim(),
        isVerified: false,
      },
    });

    if (!grant) return false;

    grant.isVerified = true;
    grant.verificationCode = null;
    await this.grantRepo.save(grant);

    this.logger.log(
      `Access verified: bot ${botUser.id}, platform ${platform}, user ${platformUserId}`,
    );

    return true;
  }

  /**
   * Thu hồi quyền truy cập.
   */
  async revokeAccess(grantId: number, ownerUid: number): Promise<boolean> {
    const result = await this.grantRepo.delete({
      id: grantId,
      grantedBy: ownerUid,
    });
    return result.affected > 0;
  }

  /**
   * Liệt kê tất cả grants cho bot của user.
   */
  async listGrants(ownerUid: number): Promise<BotAccessGrant[]> {
    const botUser = await this.botUserRepo.findOne({
      where: { userId: ownerUid },
    });
    if (!botUser) return [];

    return this.grantRepo.find({
      where: { botUserId: botUser.id },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Helper: tìm user (owner) của bot dựa trên platform + platformUserId.
   * Dùng trong webhook controllers khi cần resolve owner từ incoming message.
   */
  async resolveOwnerFromPlatformUser(
    platform: BotPlatform,
    platformUserId: string,
  ): Promise<{ user: any; botUser: BotUser } | null> {
    const userField = this.platformToUserField[platform];
    const user = await this.usersService.findByPlatformId(
      userField,
      platformUserId,
    );
    if (!user) return null;

    const botUser = await this.botUserRepo.findOne({
      where: { userId: user.uid },
    });
    if (!botUser) return null;

    return { user, botUser };
  }
}
