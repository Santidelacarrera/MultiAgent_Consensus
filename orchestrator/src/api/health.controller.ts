import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { Metrics } from '../debate/metrics';
import { ApiKeyGuard } from './api_key.guard';

@Controller()
export class HealthController {
  constructor(private readonly metrics: Metrics) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'multiagent-consensus-orchestrator' };
  }

  @Get('metrics')
  @UseGuards(ApiKeyGuard)
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  prometheus() {
    return this.metrics.render();
  }
}
