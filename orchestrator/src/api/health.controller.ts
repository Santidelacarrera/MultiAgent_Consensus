import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { DASHBOARD_HTML } from './dashboard.html';
import { Metrics } from '../debate/metrics';
import { ApiKeyGuard } from './api_key.guard';

@Controller()
export class HealthController {
  constructor(private readonly metrics: Metrics) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'multiagent-consensus-orchestrator' };
  }

  /** HTML estático sin datos; los datos se piden a /v1/debates/recent con la API key. */
  @Get('dashboard')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
  dashboard() {
    return DASHBOARD_HTML;
  }

  @Get('metrics')
  @UseGuards(ApiKeyGuard)
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  prometheus() {
    return this.metrics.render();
  }
}
