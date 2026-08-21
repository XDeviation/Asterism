import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  maxSnowflake,
  type BoardIdentity,
  type BoardPage,
  type BoardRecord,
  type BoardSummary,
  type CanvasScene,
  type CanvasSnapshot,
  type CollaborationRoom,
  type MessageRecord,
  type RefreshCandidate,
  type SyncedImage,
  type SyncedMessage,
  type PuzzleStatus,
  type HuntRecord,
  type CategoryRecord,
  type PuzzleRecord,
  type HuntOverview,
} from "@asterism/shared";

type SqliteDatabase = Database.Database;

interface BoardRow {
  id: string;
  guild_id: string;
  guild_name: string;
  channel_id: string;
  channel_name: string;
  category_id: string | null;
  category_name: string | null;
  created_at: string;
  last_activity_at: string;
  last_synced_message_id: string | null;
}

interface MessageRow {
  id: string;
  board_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  author_avatar_url: string | null;
  author_is_bot: number;
  content: string;
  reply_to_id: string | null;
  reply_summary: string | null;
  created_at: string;
  edited_at: string | null;
}

interface ImageRow {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  width: number | null;
  height: number | null;
  url: string;
  url_expires_at: string | null;
}

interface CanvasRow {
  board_id: string;
  revision: number;
  scene_json: string;
  updated_at: string;
}

interface CanvasFileRow {
  file_id: string;
  file_json: string;
}

interface HuntRow {
  id: string;
  guild_id: string;
  name: string;
  created_at: string;
}

interface CategoryRow {
  id: string;
  hunt_id: string;
  guild_category_id: string;
  name: string;
  board_id: string | null;
  created_at: string;
}

interface PuzzleRow {
  id: string;
  hunt_id: string;
  category_id: string | null;
  channel_id: string | null;
  board_id: string | null;
  title: string;
  status: string;
  answer: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

const VALID_PUZZLE_STATUSES = new Set<PuzzleStatus>([
  "new",
  "in_progress",
  "stuck",
  "solved",
]);

function huntFromRow(row: HuntRow): HuntRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function categoryFromRow(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    huntId: row.hunt_id,
    guildCategoryId: row.guild_category_id,
    name: row.name,
    boardId: row.board_id,
    createdAt: row.created_at,
  };
}

function puzzleFromRow(row: PuzzleRow): PuzzleRecord {
  return {
    id: row.id,
    huntId: row.hunt_id,
    categoryId: row.category_id,
    boardId: row.board_id,
    title: row.title,
    status: row.status as PuzzleStatus,
    answer: row.answer,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function elementIdentity(value: unknown): { id: string; version: number; versionNonce: number } | null {
  if (!value || typeof value !== "object") return null;
  const element = value as Record<string, unknown>;
  if (typeof element.id !== "string") return null;
  return {
    id: element.id,
    version: typeof element.version === "number" ? element.version : 0,
    versionNonce: typeof element.versionNonce === "number"
      ? element.versionNonce
      : Number.MAX_SAFE_INTEGER,
  };
}

export function mergeCanvasElements(stored: unknown[], incoming: unknown[]): unknown[] {
  const storedById = new Map<string, unknown>();
  for (const element of stored) {
    const identity = elementIdentity(element);
    if (identity) storedById.set(identity.id, element);
  }

  const merged: unknown[] = [];
  const added = new Set<string>();
  for (const remote of incoming) {
    const remoteIdentity = elementIdentity(remote);
    if (!remoteIdentity || added.has(remoteIdentity.id)) continue;
    const local = storedById.get(remoteIdentity.id);
    const localIdentity = elementIdentity(local);
    const keepLocal = localIdentity && (
      localIdentity.version > remoteIdentity.version ||
      (localIdentity.version === remoteIdentity.version &&
        localIdentity.versionNonce <= remoteIdentity.versionNonce)
    );
    merged.push(keepLocal ? local : remote);
    added.add(remoteIdentity.id);
  }
  for (const local of stored) {
    const identity = elementIdentity(local);
    if (identity && !added.has(identity.id)) {
      merged.push(local);
      added.add(identity.id);
    }
  }
  return merged;
}

function boardFromRow(row: BoardRow): BoardRecord {
  return {
    id: row.id,
    guildId: row.guild_id,
    guildName: row.guild_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    lastSyncedMessageId: row.last_synced_message_id,
  };
}

function imageFromRow(row: ImageRow): SyncedImage {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    url: row.url,
    urlExpiresAt: row.url_expires_at,
  };
}

export class AppDatabase {
  readonly db: SqliteDatabase;
  readonly hasLegacyWboColumn: boolean;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    const boardColumns = this.db.pragma("table_info(boards)") as Array<{ name: string }>;
    this.hasLegacyWboColumn = boardColumns.some((column) => column.name === "wbo_board_name");
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        guild_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        category_id TEXT,
        category_name TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        last_synced_message_id TEXT,
        UNIQUE (guild_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        author_is_bot INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        reply_to_id TEXT,
        reply_summary TEXT,
        created_at TEXT NOT NULL,
        edited_at TEXT
      );

      CREATE INDEX IF NOT EXISTS messages_board_created
        ON messages(board_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        url TEXT NOT NULL,
        url_expires_at TEXT
      );

      CREATE INDEX IF NOT EXISTS images_expiration
        ON images(url_expires_at);

      CREATE TABLE IF NOT EXISTS canvases (
        board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0,
        scene_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canvas_files (
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        file_json TEXT NOT NULL,
        PRIMARY KEY (board_id, file_id)
      );

      CREATE TABLE IF NOT EXISTS collaboration_rooms (
        board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL UNIQUE,
        room_key TEXT NOT NULL
      );

      DROP TABLE IF EXISTS rounds;
      DROP TABLE IF EXISTS puzzles;
      DROP TABLE IF EXISTS categories;
      DROP TABLE IF EXISTS hunts;

      CREATE TABLE IF NOT EXISTS hunts (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        hunt_id TEXT NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        guild_category_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS puzzles (
        id TEXT PRIMARY KEY,
        hunt_id TEXT NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
        channel_id TEXT UNIQUE,
        board_id TEXT REFERENCES boards(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        answer TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO canvases (board_id, revision, scene_json, updated_at)
      SELECT id, 0, '{"elements":[],"appState":{}}', created_at FROM boards;
    `);
  }

  ensureBoard(identity: BoardIdentity): { board: BoardRecord; created: boolean } {
    const existing = this.getBoardByChannel(identity.guildId, identity.channelId);
    const now = new Date().toISOString();
    if (existing) {
      this.db.prepare(`
        UPDATE boards SET
          guild_name = @guildName,
          channel_name = @channelName,
          category_id = @categoryId,
          category_name = @categoryName
        WHERE id = @id
      `).run({ ...identity, id: existing.id });
      return { board: this.getBoard(existing.id)!, created: false };
    }

    const id = randomUUID();
    if (this.hasLegacyWboColumn) {
      // Older installations retain this NOT NULL column. It is no longer read,
      // but must be populated until operators choose to rebuild their table.
      this.db.prepare(`
        INSERT INTO boards (
          id, wbo_board_name, guild_id, guild_name, channel_id, channel_name,
          category_id, category_name, created_at, last_activity_at
        ) VALUES (
          @id, @legacyName, @guildId, @guildName, @channelId, @channelName,
          @categoryId, @categoryName, @now, @now
        )
      `).run({ id, legacyName: randomUUID(), ...identity, now });
    } else {
      this.db.prepare(`
        INSERT INTO boards (
          id, guild_id, guild_name, channel_id, channel_name,
          category_id, category_name, created_at, last_activity_at
        ) VALUES (
          @id, @guildId, @guildName, @channelId, @channelName,
          @categoryId, @categoryName, @now, @now
        )
      `).run({ id, ...identity, now });
    }
    this.db.prepare(`
      INSERT INTO canvases (board_id, revision, scene_json, updated_at)
      VALUES (?, 0, '{"elements":[],"appState":{}}', ?)
    `).run(id, now);
    return { board: this.getBoard(id)!, created: true };
  }

  getCanvas(boardId: string, includeFiles = true): CanvasSnapshot | null {
    const row = this.db.prepare("SELECT * FROM canvases WHERE board_id = ?").get(boardId) as
      | CanvasRow
      | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.scene_json) as Omit<CanvasScene, "files">;
    const files = includeFiles
      ? Object.fromEntries(
        (this.db.prepare(`
          SELECT file_id, file_json FROM canvas_files
          WHERE board_id = ? ORDER BY file_id
        `).all(boardId) as CanvasFileRow[])
          .map((file) => [file.file_id, JSON.parse(file.file_json)]),
      )
      : {};
    return {
      revision: row.revision,
      scene: {
        elements: Array.isArray(stored.elements) ? stored.elements : [],
        appState: stored.appState && typeof stored.appState === "object"
          ? stored.appState
          : {},
        files,
      },
      updatedAt: row.updated_at,
    };
  }

  getCanvasFile(boardId: string, fileId: string): unknown | null {
    const row = this.db.prepare(`
      SELECT file_json FROM canvas_files
      WHERE board_id = ? AND file_id = ?
    `).get(boardId, fileId) as { file_json: string } | undefined;
    return row ? JSON.parse(row.file_json) : null;
  }

  saveCanvasFile(boardId: string, fileId: string, file: unknown): boolean {
    if (!this.getBoard(boardId)) return false;
    const updatedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO canvas_files (board_id, file_id, file_json)
        VALUES (?, ?, ?)
        ON CONFLICT(board_id, file_id) DO UPDATE SET file_json = excluded.file_json
      `).run(boardId, fileId, JSON.stringify(file));
      this.db.prepare(`
        UPDATE boards SET last_activity_at = ? WHERE id = ?
      `).run(updatedAt, boardId);
    })();
    return true;
  }

  getCollaborationRoom(boardId: string): CollaborationRoom | null {
    if (!this.getBoard(boardId)) return null;
    const existing = this.db.prepare(`
      SELECT room_id, room_key FROM collaboration_rooms WHERE board_id = ?
    `).get(boardId) as { room_id: string; room_key: string } | undefined;
    if (existing) return { roomId: existing.room_id, roomKey: existing.room_key };
    const room = {
      roomId: boardId,
      roomKey: randomBytes(16).toString("base64url"),
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO collaboration_rooms (board_id, room_id, room_key)
      VALUES (?, ?, ?)
    `).run(boardId, room.roomId, room.roomKey);
    const created = this.db.prepare(`
      SELECT room_id, room_key FROM collaboration_rooms WHERE board_id = ?
    `).get(boardId) as { room_id: string; room_key: string };
    return { roomId: created.room_id, roomKey: created.room_key };
  }

  saveCanvas(
    boardId: string,
    baseRevision: number,
    scene: CanvasScene,
  ): { saved: true; revision: number; updatedAt: string } | {
    saved: false;
    canvas: CanvasSnapshot | null;
  } {
    const updatedAt = new Date().toISOString();
    const upsertFile = this.db.prepare(`
      INSERT INTO canvas_files (board_id, file_id, file_json)
      VALUES (@boardId, @fileId, @fileJson)
      ON CONFLICT(board_id, file_id) DO UPDATE SET file_json = excluded.file_json
    `);
    const saved = this.db.transaction(() => {
      // Scene saves do not need to parse all image data. Images are stored and
      // fetched independently by file id.
      const current = this.getCanvas(boardId, false);
      if (!current) return null;
      const sceneJson = JSON.stringify({
        elements: mergeCanvasElements(current.scene.elements, scene.elements),
        appState: scene.appState,
      });
      this.db.prepare(`
        UPDATE canvases
        SET revision = revision + 1, scene_json = ?, updated_at = ?
        WHERE board_id = ?
      `).run(sceneJson, updatedAt, boardId);
      for (const [fileId, file] of Object.entries(scene.files)) {
        upsertFile.run({ boardId, fileId, fileJson: JSON.stringify(file) });
      }
      this.db.prepare(`
        UPDATE boards SET last_activity_at = ? WHERE id = ?
      `).run(updatedAt, boardId);
      return current.revision + 1;
    })();
    if (saved === null) return { saved: false, canvas: null };
    return { saved: true, revision: saved, updatedAt };
  }

  getBoard(id: string): BoardRecord | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as
      | BoardRow
      | undefined;
    return row ? boardFromRow(row) : null;
  }

  getBoardByChannel(guildId: string, channelId: string): BoardRecord | null {
    const row = this.db
      .prepare("SELECT * FROM boards WHERE guild_id = ? AND channel_id = ?")
      .get(guildId, channelId) as BoardRow | undefined;
    return row ? boardFromRow(row) : null;
  }

  listBoards(): BoardSummary[] {
    const rows = this.db.prepare(`
      SELECT boards.*, COUNT(messages.id) AS message_count
      FROM boards
      LEFT JOIN messages ON messages.board_id = boards.id
      GROUP BY boards.id
      ORDER BY COALESCE(category_name, ''), channel_name
    `).all() as Array<BoardRow & { message_count: number }>;
    return rows.map((row) => ({ ...boardFromRow(row), messageCount: row.message_count }));
  }

  private imagesForMessages(messageIds: string[]): Map<string, SyncedImage[]> {
    const result = new Map<string, SyncedImage[]>();
    if (messageIds.length === 0) return result;
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM images WHERE message_id IN (${placeholders}) ORDER BY id`)
      .all(...messageIds) as ImageRow[];
    for (const row of rows) {
      const images = result.get(row.message_id) ?? [];
      images.push(imageFromRow(row));
      result.set(row.message_id, images);
    }
    return result;
  }

  private messagesFromRows(rows: MessageRow[]): MessageRecord[] {
    const images = this.imagesForMessages(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      boardId: row.board_id,
      channelId: row.channel_id,
      authorId: row.author_id,
      authorName: row.author_name,
      authorAvatarUrl: row.author_avatar_url,
      authorIsBot: row.author_is_bot === 1,
      content: row.content,
      replyToId: row.reply_to_id,
      replySummary: row.reply_summary,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      images: images.get(row.id) ?? [],
    }));
  }

  upsertMessages(boardId: string, messages: SyncedMessage[]): MessageRecord[] {
    const board = this.getBoard(boardId);
    if (!board) throw new Error("board_not_found");
    const upsert = this.db.prepare(`
      INSERT INTO messages (
        id, board_id, channel_id, author_id, author_name, author_avatar_url,
        author_is_bot, content, reply_to_id, reply_summary, created_at, edited_at
      ) VALUES (
        @id, @boardId, @channelId, @authorId, @authorName, @authorAvatarUrl,
        @authorIsBot, @content, @replyToId, @replySummary, @createdAt, @editedAt
      ) ON CONFLICT(id) DO UPDATE SET
        author_name = excluded.author_name,
        author_avatar_url = excluded.author_avatar_url,
        content = excluded.content,
        reply_to_id = excluded.reply_to_id,
        reply_summary = excluded.reply_summary,
        edited_at = excluded.edited_at
    `);
    const deleteImages = this.db.prepare("DELETE FROM images WHERE message_id = ?");
    const insertImage = this.db.prepare(`
      INSERT INTO images (
        id, message_id, filename, content_type, width, height, url, url_expires_at
      ) VALUES (
        @id, @messageId, @filename, @contentType, @width, @height, @url, @urlExpiresAt
      ) ON CONFLICT(id) DO UPDATE SET
        filename = excluded.filename,
        content_type = excluded.content_type,
        width = excluded.width,
        height = excluded.height,
        url = excluded.url,
        url_expires_at = excluded.url_expires_at
    `);

    const transaction = this.db.transaction((items: SyncedMessage[]) => {
      let lastMessageId = board.lastSyncedMessageId;
      let lastActivityAt = board.lastActivityAt;
      for (const message of items) {
        if (message.channelId !== board.channelId) throw new Error("channel_mismatch");
        upsert.run({
          ...message,
          boardId,
          authorIsBot: message.authorIsBot ? 1 : 0,
        });
        deleteImages.run(message.id);
        for (const image of message.images) {
          insertImage.run({ ...image, messageId: message.id });
        }
        lastMessageId = maxSnowflake(lastMessageId, message.id);
        if (message.createdAt > lastActivityAt) lastActivityAt = message.createdAt;
      }
      this.db.prepare(`
        UPDATE boards
        SET last_synced_message_id = ?, last_activity_at = ?
        WHERE id = ?
      `).run(lastMessageId, lastActivityAt, boardId);
    });
    transaction(messages);

    if (messages.length === 0) return [];
    const placeholders = messages.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`)
      .all(...messages.map((message) => message.id)) as MessageRow[];
    const recordsById = new Map(
      this.messagesFromRows(rows).map((record) => [record.id, record]),
    );
    return messages.flatMap((message) => {
      const record = recordsById.get(message.id);
      return record ? [record] : [];
    });
  }

  deleteMessage(boardId: string, messageId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM messages WHERE board_id = ? AND id = ?")
      .run(boardId, messageId);
    return result.changes > 0;
  }

  getBoardPage(boardId: string, before: string | null, limit = 50): BoardPage | null {
    const board = this.getBoard(boardId);
    if (!board) return null;
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const rows = (before
      ? this.db.prepare(`
          SELECT * FROM messages
          WHERE board_id = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER)
          ORDER BY CAST(id AS INTEGER) DESC LIMIT ?
        `).all(boardId, before, boundedLimit + 1)
      : this.db.prepare(`
          SELECT * FROM messages
          WHERE board_id = ?
          ORDER BY CAST(id AS INTEGER) DESC LIMIT ?
        `).all(boardId, boundedLimit + 1)) as MessageRow[];
    const hasMore = rows.length > boundedLimit;
    const pageRows = rows.slice(0, boundedLimit);
    const nextBefore = hasMore && pageRows.length > 0 ? pageRows.at(-1)!.id : null;
    return {
      board,
      messages: this.messagesFromRows(pageRows).reverse(),
      nextBefore,
    };
  }

  listRefreshCandidates(before: string, limit: number): RefreshCandidate[] {
    const rows = this.db.prepare(`
      SELECT images.*, messages.board_id, messages.channel_id
      FROM images
      JOIN messages ON messages.id = images.message_id
      WHERE images.url_expires_at IS NOT NULL AND images.url_expires_at <= ?
      ORDER BY images.url_expires_at
      LIMIT ?
    `).all(before, Math.min(Math.max(limit, 1), 500)) as Array<
      ImageRow & { board_id: string; channel_id: string }
    >;
    return rows.map((row) => ({
      ...imageFromRow(row),
      boardId: row.board_id,
      messageId: row.message_id,
      channelId: row.channel_id,
    }));
  }

  refreshImages(messageId: string, images: SyncedImage[]): void {
    const update = this.db.prepare(`
      UPDATE images SET
        filename = @filename,
        content_type = @contentType,
        width = @width,
        height = @height,
        url = @url,
        url_expires_at = @urlExpiresAt
      WHERE id = @id AND message_id = @messageId
    `);
    this.db.transaction((items: SyncedImage[]) => {
      for (const image of items) update.run({ ...image, messageId });
    })(images);
  }

  ensureHunt(guildId: string, name: string): HuntRecord {
    const existing = this.db.prepare("SELECT * FROM hunts WHERE guild_id = ?").get(guildId) as HuntRow | undefined;
    if (existing) {
      if (existing.name !== name) {
        this.db.prepare("UPDATE hunts SET name = ? WHERE id = ?").run(name, existing.id);
        existing.name = name;
      }
      return huntFromRow(existing);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO hunts (id, guild_id, name, created_at) VALUES (?, ?, ?, ?)"
    ).run(id, guildId, name, createdAt);
    return { id, guildId, name, createdAt };
  }

  listHunts(): HuntRecord[] {
    const rows = this.db.prepare("SELECT * FROM hunts ORDER BY created_at DESC").all() as HuntRow[];
    return rows.map(huntFromRow);
  }

  getHunt(id: string): HuntRecord | null {
    const row = this.db.prepare("SELECT * FROM hunts WHERE id = ?").get(id) as HuntRow | undefined;
    return row ? huntFromRow(row) : null;
  }

  getCategory(id: string): CategoryRecord | null {
    const row = this.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
    return row ? categoryFromRow(row) : null;
  }

  getHuntOverview(huntId: string): HuntOverview | null {
    const hunt = this.getHunt(huntId);
    if (!hunt) return null;

    const categoryRows = this.db.prepare(
      "SELECT * FROM categories WHERE hunt_id = ? ORDER BY created_at ASC"
    ).all(huntId) as CategoryRow[];

    const puzzleRows = this.db.prepare(
      "SELECT * FROM puzzles WHERE hunt_id = ? ORDER BY created_at ASC"
    ).all(huntId) as PuzzleRow[];

    const puzzlesByCategory = new Map<string | null, PuzzleRecord[]>();
    for (const pRow of puzzleRows) {
      const p = puzzleFromRow(pRow);
      const key = p.categoryId;
      const list = puzzlesByCategory.get(key) ?? [];
      list.push(p);
      puzzlesByCategory.set(key, list);
    }

    const categories: Array<{ category: CategoryRecord | null; puzzles: PuzzleRecord[] }> = categoryRows.map((cRow) => {
      const category = categoryFromRow(cRow);
      return {
        category,
        puzzles: puzzlesByCategory.get(category.id) ?? [],
      };
    });

    const unassignedPuzzles = puzzlesByCategory.get(null) ?? [];
    if (unassignedPuzzles.length > 0) {
      categories.push({ category: null, puzzles: unassignedPuzzles });
    }

    return { hunt, categories };
  }

  ensureCategory(huntId: string, guildCategoryId: string, name: string): CategoryRecord {
    const existing = this.db.prepare(
      "SELECT * FROM categories WHERE guild_category_id = ?"
    ).get(guildCategoryId) as CategoryRow | undefined;
    if (existing) {
      if (existing.name !== name || existing.hunt_id !== huntId) {
        this.db.prepare("UPDATE categories SET name = ?, hunt_id = ? WHERE id = ?").run(name, huntId, existing.id);
        existing.name = name;
        existing.hunt_id = huntId;
      }
      return categoryFromRow(existing);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(
      "INSERT INTO categories (id, hunt_id, guild_category_id, name, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, huntId, guildCategoryId, name, createdAt);
    return { id, huntId, guildCategoryId, name, boardId: null, createdAt };
  }

  updateCategory(id: string, updates: { name?: string; boardId?: string | null }): CategoryRecord | null {
    const existing = this.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
    if (!existing) return null;
    const name = updates.name ?? existing.name;
    const boardId = updates.boardId !== undefined ? updates.boardId : existing.board_id;
    this.db.prepare("UPDATE categories SET name = ?, board_id = ? WHERE id = ?").run(name, boardId, id);
    return categoryFromRow({ ...existing, name, board_id: boardId });
  }

  deleteCategory(id: string): boolean {
    const result = this.db.prepare("DELETE FROM categories WHERE id = ?").run(id);
    return result.changes > 0;
  }

  ensurePuzzle(huntId: string, categoryId: string | null, channelId: string, boardId: string | null, title: string): PuzzleRecord {
    const existing = this.db.prepare(
      "SELECT * FROM puzzles WHERE channel_id = ?"
    ).get(channelId) as PuzzleRow | undefined;
    
    const now = new Date().toISOString();
    if (existing) {
      if (existing.title !== title || existing.hunt_id !== huntId || existing.category_id !== categoryId || existing.board_id !== boardId) {
        this.db.prepare(
          "UPDATE puzzles SET title = ?, hunt_id = ?, category_id = ?, board_id = ?, updated_at = ? WHERE id = ?"
        ).run(title, huntId, categoryId, boardId, now, existing.id);
      }
      return puzzleFromRow({ ...existing, title, hunt_id: huntId, category_id: categoryId, board_id: boardId, updated_at: now });
    }
    
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO puzzles (id, hunt_id, category_id, channel_id, board_id, title, status, answer, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', NULL, '', ?, ?)"
    ).run(id, huntId, categoryId, channelId, boardId, title, now, now);
    
    return puzzleFromRow({
      id, hunt_id: huntId, category_id: categoryId, channel_id: channelId, board_id: boardId,
      title, status: "new", answer: null, notes: "", created_at: now, updated_at: now
    });
  }

  getPuzzle(id: string): PuzzleRecord | null {
    const row = this.db.prepare("SELECT * FROM puzzles WHERE id = ?").get(id) as PuzzleRow | undefined;
    return row ? puzzleFromRow(row) : null;
  }

  updatePuzzle(
    id: string,
    updates: {
      title?: string;
      status?: PuzzleStatus;
      answer?: string | null;
      notes?: string;
      categoryId?: string | null;
      boardId?: string | null;
    }
  ): PuzzleRecord | null {
    const existing = this.getPuzzle(id);
    if (!existing) return null;

    if (updates.status !== undefined && !VALID_PUZZLE_STATUSES.has(updates.status)) {
      throw new Error("invalid_status");
    }

    const title = updates.title ?? existing.title;
    const status = updates.status ?? existing.status;
    const answer = updates.answer !== undefined ? updates.answer : existing.answer;
    const notes = updates.notes ?? existing.notes;
    const categoryId = updates.categoryId !== undefined ? updates.categoryId : existing.categoryId;
    const boardId = updates.boardId !== undefined ? updates.boardId : existing.boardId;
    const updatedAt = new Date().toISOString();

    this.db.prepare(
      "UPDATE puzzles SET title = ?, status = ?, answer = ?, notes = ?, category_id = ?, board_id = ?, updated_at = ? WHERE id = ?"
    ).run(title, status, answer, notes, categoryId, boardId, updatedAt, id);

    return this.getPuzzle(id);
  }

  deletePuzzle(id: string): boolean {
    const result = this.db.prepare("DELETE FROM puzzles WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
