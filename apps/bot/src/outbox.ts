import { AppApiClient, AppApiError } from "./api.js";
import { BotDatabase } from "./database.js";

export class OutboxProcessor {
  #timer: NodeJS.Timeout | null = null;
  #draining = false;

  constructor(
    private readonly database: BotDatabase,
    private readonly api: AppApiClient,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.drain(), 1_000);
    this.#timer.unref();
    void this.drain();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      for (let processed = 0; processed < 100; processed += 1) {
        const item = this.database.nextOutboxItem();
        if (!item) break;
        try {
          await this.api.request(item.method, item.path, item.body);
          this.database.completeOutboxItem(item.id);
        } catch (error) {
          const attempts = item.attempts + 1;
          if (
            error instanceof AppApiError &&
            [400, 409].includes(error.status)
          ) {
            console.error("Dropping invalid outbox event", {
              id: item.id,
              path: item.path,
              error: error.message,
            });
            this.database.completeOutboxItem(item.id);
            continue;
          }
          console.error("App delivery failed; event remains queued", {
            id: item.id,
            path: item.path,
            attempts,
            error,
          });
          this.database.retryOutboxItem(item.id, attempts);
          break;
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}
