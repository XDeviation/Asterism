import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { BoardRecord } from "@asterism/shared";

interface MappingRow {
  guild_id: string;
  channel_id: string;
  board_id: string;
}

export interface OutboxItem {
  id: number;
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body: unknown;
  attempts: number;
  availableAt: number;
}

interface OutboxRow {
  id: number;
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body_json: string | null;
  attempts: number;
  available_at: number;
}

export class BotDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS board_mappings (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        body_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  saveMapping(board: Pick<BoardRecord, "guildId" | "channelId" | "id">): void {
    this.db.prepare(`
      INSERT INTO board_mappings (guild_id, channel_id, board_id)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET board_id = excluded.board_id
    `).run(board.guildId, board.channelId, board.id);
  }

  getBoardId(guildId: string, channelId: string): string | null {
    const row = this.db.prepare(`
      SELECT board_id FROM board_mappings WHERE guild_id = ? AND channel_id = ?
    `).get(guildId, channelId) as Pick<MappingRow, "board_id"> | undefined;
    return row?.board_id ?? null;
  }

  enqueue(
    dedupeKey: string,
    method: OutboxItem["method"],
    path: string,
    body?: unknown,
  ): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO outbox (
        dedupe_key, method, path, body_json, attempts, available_at, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        method = excluded.method,
        path = excluded.path,
        body_json = excluded.body_json,
        attempts = 0,
        available_at = excluded.available_at
    `).run(dedupeKey, method, path, body === undefined ? null : JSON.stringify(body), now, now);
  }

  nextOutboxItem(now = Date.now()): OutboxItem | null {
    const row = this.db.prepare("SELECT * FROM outbox ORDER BY id LIMIT 1").get() as
      | OutboxRow
      | undefined;
    if (!row || row.available_at > now) return null;
    return {
      id: row.id,
      method: row.method,
      path: row.path,
      body: row.body_json === null ? undefined : JSON.parse(row.body_json),
      attempts: row.attempts,
      availableAt: row.available_at,
    };
  }

  completeOutboxItem(id: number): void {
    this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }

  retryOutboxItem(id: number, attempts: number): void {
    const delay = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));
    const jitter = Math.floor(Math.random() * Math.min(delay / 4, 5_000));
    this.db.prepare(`
      UPDATE outbox SET attempts = ?, available_at = ? WHERE id = ?
    `).run(attempts, Date.now() + delay + jitter, id);
  }
}

