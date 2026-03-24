export class ResetPasswordDto {
  /** Email, identifier, hoặc uname — ít nhất 1 trường. */
  email?: string;
  identifier?: string;
  uname?: string;
  /** Code 6 số nhận qua email. */
  code: string;
  /** Mật khẩu mới (tối thiểu 6 ký tự). */
  newPassword: string;
}
