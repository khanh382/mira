import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UsersAuthService } from './users-auth.service';
import { LoginDto } from './dto/login.dto';
import { VerifyLoginDto } from './dto/verify-login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserByOwnerDto } from './dto/update-user-by-owner.dto';
import { UpdateProfileAdvancedDto } from './dto/update-profile-advanced.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly usersAuthService: UsersAuthService,
  ) {}

  /** Bước 1 — kiểm tra credentials và gửi code xác minh về email. */
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto) {
    return this.usersAuthService.login(body);
  }

  /** Bước 2 — xác minh code, nhận JWT cookie nếu hợp lệ. */
  @Post('verify-login')
  @HttpCode(200)
  async verifyLogin(
    @Body() body: VerifyLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.usersAuthService.verifyLogin(body, res);
  }

  /** Bước 1 quên mật khẩu — gửi code reset về email. */
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.usersAuthService.forgotPassword(body);
  }

  /** Bước 2 quên mật khẩu — xác minh code và đặt mật khẩu mới. */
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.usersAuthService.resetPassword(body);
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @Req() req: { user: { uid: number } },
    @Body() body: ChangePasswordDto,
  ) {
    return this.usersAuthService.changePassword(req.user.uid, body);
  }

  @Post('create')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async createUser(
    @Req() req: { user: { uid: number } },
    @Body() body: CreateUserDto,
  ) {
    return this.usersAuthService.createUserByOwner(req.user.uid, body);
  }

  @Post('update/:uid')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async updateUserByOwner(
    @Req() req: { user: { uid: number } },
    @Param('uid', ParseIntPipe) uid: number,
    @Body() body: UpdateUserByOwnerDto,
  ) {
    return this.usersAuthService.updateUserByOwner(req.user.uid, uid, body);
  }

  @Post('update-profile-advanced')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async updateProfileAdvanced(
    @Req() req: { user: { uid: number } },
    @Body() body: UpdateProfileAdvancedDto,
  ) {
    return this.usersAuthService.updateProfileAdvanced(req.user.uid, body);
  }

  @Post('update-profile')
  @HttpCode(200)
  async updateProfile(@Body() body: UpdateProfileDto) {
    return this.usersAuthService.updateProfile(body);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Res({ passthrough: true }) res: Response) {
    return this.usersAuthService.logout(res);
  }

  @Post('refresh-token')
  @HttpCode(200)
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.usersAuthService.refresh(req, res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: { user: { uid: number } }) {
    const user = await this.usersService.findById(req.user.uid);
    if (!user) {
      throw new NotFoundException();
    }
    return this.usersAuthService.toPublicUser(user);
  }

  @Get('list')
  @UseGuards(JwtAuthGuard)
  async listUsers(@Req() req: { user: { uid: number } }) {
    return this.usersAuthService.listUsersByOwner(req.user.uid);
  }
}
