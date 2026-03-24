import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  UserCode,
  UserCodeType,
  UserCodePlace,
} from './entities/user-code.entity';

/** Code hết hạn sau 10 phút */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Độ dài code số */
const CODE_LENGTH = 6;

@Injectable()
export class UserCodesService {
  constructor(
    @InjectRepository(UserCode)
    private readonly codeRepo: Repository<UserCode>,
  ) {}

  /** Sinh code ngẫu nhiên N chữ số. */
  generateCode(length = CODE_LENGTH): string {
    const max = Math.pow(10, length);
    const min = Math.pow(10, length - 1);
    return String(Math.floor(min + Math.random() * (max - min)));
  }

  /**
   * Tạo code mới — tự động hủy các code cùng loại còn sống của user đó
   * để tránh nhiều code hợp lệ cùng lúc.
   */
  async createCode(
    userId: number,
    type: UserCodeType,
    place: UserCodePlace | null = UserCodePlace.EMAIL,
  ): Promise<string> {
    await this.codeRepo.update(
      { ucUserId: userId, ucType: type, ucLife: true },
      { ucLife: false },
    );

    const code = this.generateCode();
    const expiredAt = new Date(Date.now() + CODE_TTL_MS);
    const entry = this.codeRepo.create({
      ucValue: code,
      ucType: type,
      ucPlace: place,
      ucExpiredTime: expiredAt,
      ucLife: true,
      ucUserId: userId,
    });
    await this.codeRepo.save(entry);
    return code;
  }

  /**
   * Lấy code còn hiệu lực (uc_life=true và chưa quá uc_expired_time).
   * Nếu không có, tự tạo code mới.
   */
  async getActiveCodeOrCreate(
    userId: number,
    type: UserCodeType,
    place: UserCodePlace | null = UserCodePlace.EMAIL,
  ): Promise<{ code: string; expiresAt: Date; reused: boolean }> {
    const record = await this.codeRepo.findOne({
      where: { ucUserId: userId, ucType: type, ucLife: true },
      order: { ucId: 'DESC' },
    });

    if (record) {
      if (record.ucExpiredTime.getTime() > Date.now()) {
        return {
          code: record.ucValue,
          expiresAt: record.ucExpiredTime,
          reused: true,
        };
      }

      record.ucLife = false;
      await this.codeRepo.save(record);
    }

    const code = await this.createCode(userId, type, place);
    return {
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      reused: false,
    };
  }

  /**
   * Xác minh code. Trả về `true` nếu hợp lệ và chưa hết hạn.
   * Sau khi xác minh thành công, tự động vô hiệu hoá code đó.
   */
  async verifyCode(
    userId: number,
    type: UserCodeType,
    code: string,
  ): Promise<boolean> {
    const record = await this.codeRepo.findOne({
      where: { ucUserId: userId, ucType: type, ucValue: code, ucLife: true },
    });

    if (!record) return false;

    if (Date.now() > record.ucExpiredTime.getTime()) {
      record.ucLife = false;
      await this.codeRepo.save(record);
      return false;
    }

    record.ucLife = false;
    await this.codeRepo.save(record);
    return true;
  }

  /** Dọn dẹp các code đã hết hạn (có thể gọi từ cron). */
  async purgeExpired(): Promise<void> {
    await this.codeRepo.delete({
      ucLife: false,
      ucExpiredTime: LessThan(new Date()),
    });
  }
}
