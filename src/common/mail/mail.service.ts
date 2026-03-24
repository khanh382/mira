import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST', '');
    const port = this.configService.get<number>('SMTP_PORT', 587);
    const user = this.configService.get<string>('SMTP_USER', '');
    const pass = this.configService.get<string>('SMTP_PASS', '');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(`Mail service ready (${host}:${port})`);
    } else {
      this.logger.warn(
        'SMTP not configured — emails will be logged to console only.',
      );
    }
  }

  async sendLoginCode(to: string, code: string): Promise<void> {
    const from =
      this.configService.get<string>('SMTP_FROM') ||
      this.configService.get<string>('SMTP_USER', 'noreply@example.com');

    const subject = 'Your login verification code';
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Login Verification</h2>
        <p>Use the code below to complete your login. It expires in <strong>10 minutes</strong>.</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;padding:16px 0">${code}</div>
        <p style="color:#888;font-size:12px">If you did not request this, please ignore this email.</p>
      </div>
    `;

    if (!this.transporter) {
      this.logger.log(`[DEV] Login code for ${to}: ${code}`);
      return;
    }

    await this.transporter.sendMail({ from, to, subject, html });
  }

  async sendResetPasswordCode(to: string, code: string): Promise<void> {
    const from =
      this.configService.get<string>('SMTP_FROM') ||
      this.configService.get<string>('SMTP_USER', 'noreply@example.com');

    const subject = 'Your password reset code';
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Password Reset</h2>
        <p>Use the code below to reset your password. It expires in <strong>10 minutes</strong>.</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;padding:16px 0">${code}</div>
        <p style="color:#888;font-size:12px">If you did not request this, please ignore this email.</p>
      </div>
    `;

    if (!this.transporter) {
      this.logger.log(`[DEV] Reset password code for ${to}: ${code}`);
      return;
    }

    await this.transporter.sendMail({ from, to, subject, html });
  }

  async sendAdvancedProfileUpdateCode(to: string, code: string): Promise<void> {
    const from =
      this.configService.get<string>('SMTP_FROM') ||
      this.configService.get<string>('SMTP_USER', 'noreply@example.com');

    const subject = 'Your profile update verification code';
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Profile Update Verification</h2>
        <p>Use the code below to confirm profile changes. It expires in <strong>10 minutes</strong>.</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;padding:16px 0">${code}</div>
        <p style="color:#888;font-size:12px">If you did not request this, please ignore this email.</p>
      </div>
    `;

    if (!this.transporter) {
      this.logger.log(`[DEV] Advanced profile code for ${to}: ${code}`);
      return;
    }

    await this.transporter.sendMail({ from, to, subject, html });
  }

  async sendGeneric(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const from =
      this.configService.get<string>('SMTP_FROM') ||
      this.configService.get<string>('SMTP_USER', 'noreply@example.com');

    if (!this.transporter) {
      this.logger.log(`[DEV] Email to ${to} | ${subject}`);
      return;
    }

    await this.transporter.sendMail({ from, to, subject, html });
  }
}
