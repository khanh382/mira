export class UpdateProfileAdvancedDto {
  uname?: string;
  email?: string;
  /** Verification code sent to current email. */
  code?: string;
}
