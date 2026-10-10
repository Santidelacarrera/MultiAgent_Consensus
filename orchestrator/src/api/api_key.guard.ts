import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { AppConfig } from '../config';
import { CONFIG } from '../tokens';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.config.apiKey) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const header = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const given = Buffer.from(String(Array.isArray(header) ? header[0] : header ?? ''));
    const expected = Buffer.from(this.config.apiKey);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException('API key inválida');
    return true;
  }
}
