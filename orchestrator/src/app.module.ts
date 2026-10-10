import { DynamicModule, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { createLlmProvider, LlmProvider } from '../../agents/llm';
import { AgentRuntime } from './agent_runtime';
import { ApiKeyGuard } from './api/api_key.guard';
import { DebatesController } from './api/debates.controller';
import { HealthController } from './api/health.controller';
import { EVENT_BUS, EventBus } from './bus/event_bus';
import { MemoryBus } from './bus/memory_bus';
import { RedisStreamsBus } from './bus/redis_bus';
import { AppConfig, loadConfig } from './config';
import { DebateService } from './debate/debate_service';
import { Metrics } from './debate/metrics';
import { MemoryStore } from './store/memory_store';
import { PgStore } from './store/pg_store';
import { DebateStore, STORE } from './store/store';
import { CONFIG, LLM } from './tokens';

export interface AppDeps {
  bus?: EventBus;
  store?: DebateStore;
  llm?: LlmProvider;
}

class Lifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(STORE) private readonly store: DebateStore,
    private readonly owns: boolean,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    if (!this.owns) return;
    await this.bus.close();
    await this.store.close();
  }
}

@Module({})
export class AppModule {
  /** `deps` permite inyectar bus/almacén/LLM (tests); sin ellos se construyen desde la configuración. */
  static register(overrides: Partial<AppConfig> = {}, deps: AppDeps = {}): DynamicModule {
    const config = loadConfig(process.env, overrides);
    const owns = !deps.bus && !deps.store;
    return {
      module: AppModule,
      controllers: [DebatesController, HealthController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: EVENT_BUS, useFactory: () => deps.bus ?? (config.busBackend === 'redis' ? new RedisStreamsBus(config.redisUrl) : new MemoryBus()) },
        {
          provide: STORE,
          useFactory: async () => {
            const store = deps.store ?? (config.databaseUrl ? PgStore.fromUrl(config.databaseUrl) : new MemoryStore());
            await store.init();
            return store;
          },
        },
        { provide: LLM, useFactory: () => deps.llm ?? createLlmProvider(config.env) },
        ApiKeyGuard,
        AgentRuntime,
        DebateService,
        Metrics,
        { provide: Lifecycle, useFactory: (bus: EventBus, store: DebateStore) => new Lifecycle(bus, store, owns), inject: [EVENT_BUS, STORE] },
      ],
    };
  }
}
