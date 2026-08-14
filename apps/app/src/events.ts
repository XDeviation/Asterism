import { EventEmitter } from "node:events";
import type { BoardEvent } from "@asterism/shared";

export class BoardEventHub {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(1_000);
  }

  publish(boardId: string, event: BoardEvent): void {
    this.#emitter.emit(boardId, event);
  }

  subscribe(boardId: string, listener: (event: BoardEvent) => void): () => void {
    this.#emitter.on(boardId, listener);
    return () => this.#emitter.off(boardId, listener);
  }
}

