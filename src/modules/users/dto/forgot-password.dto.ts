export class ForgotPasswordDto {
  /** Email, identifier, hoặc uname — ít nhất 1 trường. */
  email?: string;
  identifier?: string;
  uname?: string;
}
