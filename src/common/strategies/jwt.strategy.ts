import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ACCESS_TOKEN_COOKIE } from '../auth-cookies';

function accessTokenFromCookie(req: Request): string | null {
  const raw = req?.cookies?.[ACCESS_TOKEN_COOKIE];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Payload tối thiểu cho `JwtAuthGuard` — khớp `req.user.uid` ở gateway. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => accessTokenFromCookie(req),
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET', 'default_secret'),
    });
  }

  validate(payload: {
    uid?: number;
    sub?: number;
    identifier?: string;
    username?: string;
  }) {
    const uid = payload.uid ?? payload.sub;
    return {
      uid,
      identifier: payload.identifier ?? payload.username,
    };
  }
}
