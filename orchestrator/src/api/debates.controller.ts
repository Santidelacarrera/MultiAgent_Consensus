import {
  Body, ConflictException, Controller, Get, Header, HttpCode, NotFoundException, Param, Post, Query, UseGuards, BadRequestException,
} from '@nestjs/common';
import { InvalidPrInput, parsePullRequest, parseRepoSettings } from '../debate/pr_input';
import { ConflictError, DebateService, NotFoundError, ValidationError } from '../debate/debate_service';
import { DebateRecord } from '../types';
import { ApiKeyGuard } from './api_key.guard';

/** Vista pública: sin los registros por ronda salvo `full=true`. */
export function toView(rec: DebateRecord, full = false) {
  const { result, ...rest } = rec;
  return {
    ...rest,
    verdict: result?.verdict ?? (rec.status === 'running' ? 'PENDING' : rec.status === 'error' ? 'ERROR' : null),
    summary: result
      ? {
          finalVotes: result.finalVotes,
          conditions: result.conditions,
          convergence: result.convergence,
          openFindings: result.openFindings.map((f) => ({ id: f.id, agent: f.agent, severity: f.severity, title: f.title })),
          mitigatedRisks: result.mitigatedRisks.length,
          resolution: result.resolution ?? null,
          quorum: result.rounds[result.rounds.length - 1]?.evaluation.quorum ?? null,
          approvals: result.rounds[result.rounds.length - 1]?.evaluation.approvals ?? null,
          hardBlockers: result.rounds[result.rounds.length - 1]?.evaluation.hardBlockers ?? [],
          blockingDissent: result.rounds[result.rounds.length - 1]?.evaluation.blockingDissent ?? [],
        }
      : null,
    ...(full ? { result } : {}),
  };
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof NotFoundError) throw new NotFoundException(e.message);
    if (e instanceof ConflictError) throw new ConflictException(e.message);
    if (e instanceof ValidationError || e instanceof InvalidPrInput) throw new BadRequestException(e.message);
    throw e;
  });
}

@Controller('v1/debates')
@UseGuards(ApiKeyGuard)
export class DebatesController {
  constructor(private readonly debates: DebateService) {}

  @Post()
  @HttpCode(202)
  submit(@Body() body: { pr?: unknown; force?: boolean; settings?: unknown }) {
    return wrap(async () => {
      const pr = parsePullRequest(body?.pr);
      const settings = parseRepoSettings(body?.settings);
      return toView(await this.debates.submit(pr, { force: body?.force === true, settings }));
    });
  }

  @Get()
  list(@Query('prId') prId?: string) {
    return wrap(async () => {
      if (!prId) throw new ValidationError('prId es obligatorio');
      return (await this.debates.history(prId)).map((r) => toView(r));
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @Query('waitMs') waitMs?: string, @Query('full') full?: string) {
    return wrap(async () => toView(await this.debates.get(id, Number(waitMs) || 0), full === 'true'));
  }

  @Get(':id/minutes')
  @Header('content-type', 'text/markdown; charset=utf-8')
  minutes(@Param('id') id: string) {
    return wrap(() => this.debates.minutes(id));
  }

  @Get(':id/events')
  events(@Param('id') id: string) {
    return wrap(() => this.debates.events(id));
  }

  @Get(':id/metrics')
  metrics(@Param('id') id: string) {
    return wrap(() => this.debates.metrics(id));
  }

  @Post(':id/resolution')
  resolve(@Param('id') id: string, @Body() body: { reviewer?: unknown; decision?: unknown; rationale?: unknown }) {
    return wrap(async () => toView(await this.debates.resolve(id, body ?? {})));
  }
}
