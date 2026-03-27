import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Response, Request } from 'express';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { UsersService } from './users.service';
import { UserCodesService } from './user-codes.service';
import { MailService } from '../../common/mail/mail.service';
import { BtcIdentifierService } from './btc-identifier.service';
import { UserWorkspaceBootstrapService } from './user-workspace-bootstrap.service';
import { User, UserLevel, UserStatus } from './entities/user.entity';
import { UserCodeType, UserCodePlace } from './entities/user-code.entity';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserByOwnerDto } from './dto/update-user-by-owner.dto';
import { UpdateProfileAdvancedDto } from './dto/update-profile-advanced.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../../common/auth-cookies';

const ACCESS_MAX_AGE_MS = 30 * 60 * 1000;
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const ADVANCED_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const MIN_PASSWORD_LENGTH = 6;

export type PublicUser = {
  uid: number;
  identifier: string;
  uname: string;
  email: string;
  level: string;
  status: string;
  activeEmail: boolean;
  useGgauth: boolean;
  telegramId: string | null;
  discordId: string | null;
  zaloId: string | null;
  slackId: string | null;
  createdAt: Date;
  updateAt: Date;
};

@Injectable()
export class UsersAuthService {
  private readonly refreshSecret: string;
  private readonly loginCodeLastSentAt = new Map<number, number>();
  private readonly resetCodeLastSentAt = new Map<number, number>();
  private readonly advancedCodeLastSentAt = new Map<number, number>();

  constructor(
    private readonly usersService: UsersService,
    private readonly userCodesService: UserCodesService,
    private readonly mailService: MailService,
    private readonly btcIdentifierService: BtcIdentifierService,
    private readonly userWorkspaceBootstrapService: UserWorkspaceBootstrapService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    const base = this.configService.get<string>('JWT_SECRET', 'default_secret');
    this.refreshSecret = createHash('sha256')
      .update(`refresh:${base}`)
      .digest('hex');
  }

  toPublicUser(user: User): PublicUser {
    return {
      uid: user.uid,
      identifier: user.identifier,
      uname: user.uname,
      email: user.email,
      level: user.level,
      status: user.status,
      activeEmail: user.activeEmail,
      useGgauth: user.useGgauth,
      telegramId: user.telegramId ?? null,
      discordId: user.discordId ?? null,
      zaloId: user.zaloId ?? null,
      slackId: user.slackId ?? null,
      createdAt: user.createdAt,
      updateAt: user.updateAt,
    };
  }

  private cookieBaseOpts() {
    const secure =
      String(
        this.configService.get<string>('COOKIE_SECURE', ''),
      ).toLowerCase() === 'true' ||
      this.configService.get<string>('NODE_ENV') === 'production';
    return {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
    };
  }

  setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    const base = this.cookieBaseOpts();
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...base,
      maxAge: ACCESS_MAX_AGE_MS,
    });
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE_MS,
    });
  }

  clearAuthCookies(res: Response) {
    const base = this.cookieBaseOpts();
    res.clearCookie(ACCESS_TOKEN_COOKIE, base);
    res.clearCookie(REFRESH_TOKEN_COOKIE, base);
  }

  private signAccessToken(user: User): string {
    return this.jwtService.sign(
      {
        sub: user.uid,
        uid: user.uid,
        identifier: user.identifier,
      },
      { expiresIn: '30m' },
    );
  }

  private signRefreshToken(user: User): string {
    return this.jwtService.sign(
      {
        sub: user.uid,
        uid: user.uid,
        type: 'refresh',
      },
      {
        secret: this.refreshSecret,
        expiresIn: '30d',
      },
    );
  }

  private canResendLoginCode(userId: number): boolean {
    const lastSent = this.loginCodeLastSentAt.get(userId);
    if (!lastSent) return true;
    return Date.now() - lastSent >= LOGIN_CODE_RESEND_COOLDOWN_MS;
  }

  private getLoginCodeRetryAfterSec(userId: number): number {
    const lastSent = this.loginCodeLastSentAt.get(userId);
    if (!lastSent) return 0;
    const remainMs = LOGIN_CODE_RESEND_COOLDOWN_MS - (Date.now() - lastSent);
    return remainMs > 0 ? Math.ceil(remainMs / 1000) : 0;
  }

  /** Bước 1: kiểm tra credentials → gửi code về email. */
  async login(dto: LoginDto) {
    const { email, identifier, uname } = dto;
    if (!dto.password?.length) {
      throw new BadRequestException('password is required');
    }
    if (dto.password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (!email?.trim() && !identifier?.trim() && !uname?.trim()) {
      throw new BadRequestException('email or identifier or uname is required');
    }

    const user = await this.usersService.findByLoginKey({ email, identifier, uname });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Account is blocked');
    }

    let ok = false;
    try {
      ok = await bcrypt.compare(dto.password, user.password);
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const { code, expiresAt } = await this.userCodesService.getActiveCodeOrCreate(
      user.uid,
      UserCodeType.LOGIN,
      UserCodePlace.EMAIL,
    );
    const emailSent = this.canResendLoginCode(user.uid);
    if (emailSent) {
      await this.mailService.sendLoginCode(user.email, code);
      this.loginCodeLastSentAt.set(user.uid, Date.now());
    }

    return {
      message: emailSent
        ? 'Verification code sent to your email.'
        : 'A valid verification code already exists. Please wait before requesting another email.',
      emailSent,
      retryAfterSec: this.getLoginCodeRetryAfterSec(user.uid),
      expiresAt,
    };
  }

  /** Bước 2: xác minh code → cấp JWT cookie. */
  async verifyLogin(
    dto: { email?: string; identifier?: string; uname?: string; code: string },
    res: Response,
  ) {
    if (!dto.code?.trim()) {
      throw new BadRequestException('code is required');
    }
    if (!dto.email?.trim() && !dto.identifier?.trim() && !dto.uname?.trim()) {
      throw new BadRequestException('email or identifier or uname is required');
    }

    const user = await this.usersService.findByLoginKey(dto);

    if (!user || user.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Invalid request');
    }

    const valid = await this.userCodesService.verifyCode(
      user.uid,
      UserCodeType.LOGIN,
      dto.code.trim(),
    );

    if (!valid) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    const accessToken = this.signAccessToken(user);
    const refreshToken = this.signRefreshToken(user);
    this.setAuthCookies(res, accessToken, refreshToken);
    this.userWorkspaceBootstrapService.ensureDefaultWorkspace(user.identifier);

    return { user: this.toPublicUser(user) };
  }

  async refresh(req: Request, res: Response) {
    const raw = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!raw || typeof raw !== 'string') {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: { sub?: number; uid?: number; type?: string };
    try {
      payload = this.jwtService.verify(raw, {
        secret: this.refreshSecret,
      }) as { sub?: number; uid?: number; type?: string };
    } catch {
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const uid = payload.uid ?? payload.sub;
    if (uid == null || !Number.isFinite(Number(uid))) {
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.usersService.findById(Number(uid));
    if (!user || user.status === UserStatus.BLOCK) {
      this.clearAuthCookies(res);
      throw new UnauthorizedException('User not found or blocked');
    }

    const accessToken = this.signAccessToken(user);
    const refreshToken = this.signRefreshToken(user);
    this.setAuthCookies(res, accessToken, refreshToken);

    return { user: this.toPublicUser(user) };
  }

  /**
   * Bước 1 quên mật khẩu: tìm user → gửi code reset về email.
   * Luôn trả về thành công dù email không tồn tại (tránh user enumeration).
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const { email, identifier, uname } = dto;
    if (!email?.trim() && !identifier?.trim() && !uname?.trim()) {
      throw new BadRequestException('email or identifier or uname is required');
    }

    const user = await this.usersService.findByLoginKey({ email, identifier, uname });

    if (user && user.status !== UserStatus.BLOCK) {
      const { code, expiresAt } = await this.userCodesService.getActiveCodeOrCreate(
        user.uid,
        UserCodeType.RESET_PASSWORD,
        UserCodePlace.EMAIL,
      );

      const lastSent = this.resetCodeLastSentAt.get(user.uid);
      const cooldownPassed =
        !lastSent || Date.now() - lastSent >= RESET_CODE_RESEND_COOLDOWN_MS;

      if (cooldownPassed) {
        await this.mailService.sendResetPasswordCode(user.email, code);
        this.resetCodeLastSentAt.set(user.uid, Date.now());
      }

      const retryAfterSec = (() => {
        const last = this.resetCodeLastSentAt.get(user.uid);
        if (!last) return 0;
        const remain = RESET_CODE_RESEND_COOLDOWN_MS - (Date.now() - last);
        return remain > 0 ? Math.ceil(remain / 1000) : 0;
      })();

      return {
        message: cooldownPassed
          ? 'Reset code sent to your email.'
          : 'A valid reset code already exists. Please wait before requesting another email.',
        emailSent: cooldownPassed,
        expiresAt,
        retryAfterSec,
      };
    }

    return {
      message: 'If an account with that credential exists, a reset code has been sent.',
      emailSent: false,
    };
  }

  /**
   * Bước 2 quên mật khẩu: xác minh code → đặt mật khẩu mới.
   */
  async resetPassword(dto: ResetPasswordDto) {
    if (!dto.code?.trim()) {
      throw new BadRequestException('code is required');
    }
    if (!dto.newPassword || dto.newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (!dto.email?.trim() && !dto.identifier?.trim() && !dto.uname?.trim()) {
      throw new BadRequestException('email or identifier or uname is required');
    }

    const user = await this.usersService.findByLoginKey(dto);
    if (!user || user.status === UserStatus.BLOCK) {
      throw new BadRequestException('Invalid request');
    }

    const valid = await this.userCodesService.verifyCode(
      user.uid,
      UserCodeType.RESET_PASSWORD,
      dto.code.trim(),
    );
    if (!valid) {
      throw new BadRequestException('Invalid or expired reset code');
    }

    const hashed = await bcrypt.hash(dto.newPassword, 10);
    await this.usersService.update(user.uid, { password: hashed });

    return { message: 'Password has been reset successfully.' };
  }

  async changePassword(userId: number, dto: ChangePasswordDto) {
    const currentPassword = dto.current_password;
    const newPassword = dto.new_password;

    if (!currentPassword?.trim()) {
      throw new BadRequestException('current_password is required');
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `new_password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }

    const user = await this.usersService.findById(userId);
    if (!user || user.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Invalid request');
    }

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const sameAsOld = await bcrypt.compare(newPassword, user.password);
    if (sameAsOld) {
      throw new BadRequestException(
        'new_password must be different from current_password',
      );
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.usersService.update(user.uid, { password: hashed });

    return { message: 'Password changed successfully.' };
  }

  async createUserByOwner(ownerUid: number, dto: CreateUserDto) {
    const owner = await this.usersService.findById(ownerUid);
    if (!owner || owner.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Invalid request');
    }
    if (owner.level !== 'owner') {
      throw new ForbiddenException('Only owner can create users');
    }

    const username = dto.username?.trim();
    const email = dto.email?.trim();
    const password = dto.password;
    const level = dto.level;

    if (!username) {
      throw new BadRequestException('username is required');
    }
    if (!email) {
      throw new BadRequestException('email is required');
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(
        `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (level !== 'colleague' && level !== 'client') {
      throw new BadRequestException('level must be colleague or client');
    }

    if (await this.usersService.findByEmail(email)) {
      throw new BadRequestException('email already exists');
    }
    if (await this.usersService.findByUname(username)) {
      throw new BadRequestException('username already exists');
    }
    this.btcIdentifierService.validateConfig();

    const hashedPassword = await bcrypt.hash(password, 10);
    const userLevel =
      level === 'colleague' ? UserLevel.COLLEAGUE : UserLevel.CLIENT;
    const created = await this.usersService.create({
      uname: username,
      identifier: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      email,
      password: hashedPassword,
      level: userLevel,
      activeEmail: false,
      useGgauth: false,
      status: UserStatus.ACTIVE,
    });

    const btcIdentifier = await this.btcIdentifierService.deriveIdentifierByUid(
      created.uid,
    );
    const updated = await this.usersService.update(created.uid, {
      identifier: btcIdentifier,
    });

    return {
      message: 'User created successfully.',
      user: this.toPublicUser(updated),
    };
  }

  async updateUserByOwner(
    ownerUid: number,
    targetUid: number,
    dto: UpdateUserByOwnerDto,
  ) {
    const owner = await this.usersService.findById(ownerUid);
    if (!owner || owner.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Invalid request');
    }
    if (owner.level !== UserLevel.OWNER) {
      throw new ForbiddenException('Only owner can update users');
    }

    const target = await this.usersService.findById(targetUid);
    if (!target) {
      throw new BadRequestException('Target user not found');
    }
    if (target.level === UserLevel.OWNER) {
      throw new ForbiddenException('Owner cannot update another owner');
    }

    const patch: Partial<User> = {};
    if (dto.level !== undefined) {
      if (dto.level === 'colleague') patch.level = UserLevel.COLLEAGUE;
      else if (dto.level === 'client') patch.level = UserLevel.CLIENT;
      else throw new BadRequestException('level must be colleague or client');
    }
    if (dto.status !== undefined) {
      if (dto.status === 'active') patch.status = UserStatus.ACTIVE;
      else if (dto.status === 'block') patch.status = UserStatus.BLOCK;
      else throw new BadRequestException('status must be active or block');
    }
    if (dto.password !== undefined && dto.password.length >= MIN_PASSWORD_LENGTH) {
      patch.password = await bcrypt.hash(dto.password, 10);
    }

    if (Object.keys(patch).length > 0) {
      await this.usersService.update(targetUid, patch);
    }

    const updated = await this.usersService.findById(targetUid);
    return {
      message: 'User updated successfully.',
      user: this.toPublicUser(updated as User),
      passwordUpdated:
        dto.password !== undefined && dto.password.length >= MIN_PASSWORD_LENGTH,
    };
  }

  async updateProfileAdvanced(userUid: number, dto: UpdateProfileAdvancedDto) {
    const user = await this.usersService.findById(userUid);
    if (!user || user.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Invalid request');
    }

    const nextUname = dto.uname?.trim();
    const nextEmail = dto.email?.trim();
    if (!nextUname && !nextEmail) {
      throw new BadRequestException('uname or email is required');
    }

    if (!dto.code?.trim()) {
      const { code, expiresAt } = await this.userCodesService.getActiveCodeOrCreate(
        user.uid,
        UserCodeType.ADVANCED,
        UserCodePlace.EMAIL,
      );

      const lastSent = this.advancedCodeLastSentAt.get(user.uid);
      const canResend =
        !lastSent || Date.now() - lastSent >= ADVANCED_CODE_RESEND_COOLDOWN_MS;
      if (canResend) {
        await this.mailService.sendAdvancedProfileUpdateCode(user.email, code);
        this.advancedCodeLastSentAt.set(user.uid, Date.now());
      }

      const retryAfterSec = (() => {
        const last = this.advancedCodeLastSentAt.get(user.uid);
        if (!last) return 0;
        const remain = ADVANCED_CODE_RESEND_COOLDOWN_MS - (Date.now() - last);
        return remain > 0 ? Math.ceil(remain / 1000) : 0;
      })();

      return {
        message: canResend
          ? 'Verification code sent to your current email.'
          : 'A valid verification code already exists. Please wait before requesting another email.',
        emailSent: canResend,
        expiresAt,
        retryAfterSec,
      };
    }

    const valid = await this.userCodesService.verifyCode(
      user.uid,
      UserCodeType.ADVANCED,
      dto.code.trim(),
    );
    if (!valid) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const patch: Partial<User> = {};
    if (nextUname && nextUname !== user.uname) {
      if (await this.usersService.findByUname(nextUname)) {
        throw new BadRequestException('uname already exists');
      }
      patch.uname = nextUname;
    }
    if (nextEmail && nextEmail !== user.email) {
      if (await this.usersService.findByEmail(nextEmail)) {
        throw new BadRequestException('email already exists');
      }
      patch.email = nextEmail;
      patch.activeEmail = false;
    }

    if (Object.keys(patch).length === 0) {
      return { message: 'Nothing to update.' };
    }

    const updated = await this.usersService.update(user.uid, patch);
    return {
      message: 'Profile updated successfully.',
      user: this.toPublicUser(updated),
    };
  }

  async updateProfile(dto: UpdateProfileDto) {
    const uid = Number(dto.uid);
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new BadRequestException('uid must be a positive integer');
    }

    const user = await this.usersService.findById(uid);
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const patch: Partial<User> = {};
    const telegramId = dto.telegram_id?.trim();
    const zaloId = dto.zalo_id?.trim();
    const discordId = dto.discord_id?.trim();
    const slackId = dto.slack_id?.trim();
    const facebookId = dto.facebook_id?.trim();

    if (telegramId !== undefined && telegramId !== '') patch.telegramId = telegramId;
    if (zaloId !== undefined && zaloId !== '') patch.zaloId = zaloId;
    if (discordId !== undefined && discordId !== '') patch.discordId = discordId;
    if (slackId !== undefined && slackId !== '') patch.slackId = slackId;
    if (facebookId !== undefined && facebookId !== '') patch.facebookId = facebookId;

    if (Object.keys(patch).length === 0) {
      return { message: 'Nothing to update.' };
    }

    const updated = await this.usersService.update(uid, patch);
    return {
      message: 'Profile updated successfully.',
      user: this.toPublicUser(updated),
    };
  }

  async listUsersByOwner(ownerUid: number) {
    const owner = await this.usersService.findById(ownerUid);
    if (!owner || owner.status === UserStatus.BLOCK) {
      throw new UnauthorizedException('Invalid request');
    }
    if (owner.level !== UserLevel.OWNER) {
      throw new ForbiddenException('Only owner can view users list');
    }

    const users = await this.usersService.listAll();
    return {
      items: users.map((u) => this.toPublicUser(u)),
      total: users.length,
    };
  }

  logout(res: Response) {
    this.clearAuthCookies(res);
    return { ok: true };
  }
}
