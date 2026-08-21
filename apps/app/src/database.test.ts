import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { AppDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

function database(): AppDatabase {
  const directory = mkdtempSync(join(tmpdir(), "asterism-app-test-"));
  temporaryDirectories.push(directory);
  return new AppDatabase(join(directory, "database.sqlite"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AppDatabase", () => {
  it("creates only one board for a Discord channel", () => {
    const db = database();
    const identity = {
      guildId: "1",
      guildName: "Team",
      channelId: "2",
      channelName: "puzzle",
      categoryId: null,
      categoryName: null,
    };
    const first = db.ensureBoard(identity);
    const second = db.ensureBoard({ ...identity, channelName: "renamed" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.board.id).toBe(first.board.id);
    expect(second.board.channelName).toBe("renamed");
    db.close();
  });

  it("keeps creating boards in databases migrated from WBO", () => {
    const directory = mkdtempSync(join(tmpdir(), "asterism-app-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "database.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        wbo_board_name TEXT NOT NULL UNIQUE,
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
      )
    `);
    legacy.close();

    const db = new AppDatabase(path);
    const created = db.ensureBoard({
      guildId: "1",
      guildName: "Team",
      channelId: "2",
      channelName: "puzzle",
      categoryId: null,
      categoryName: null,
    });
    expect(created.created).toBe(true);
    expect(db.getCanvas(created.board.id)?.revision).toBe(0);
    db.close();
  });

  it("persists Excalidraw scenes and merges concurrent element versions", () => {
    const db = database();
    const { board } = db.ensureBoard({
      guildId: "1",
      guildName: "Team",
      channelId: "2",
      channelName: "puzzle",
      categoryId: null,
      categoryName: null,
    });
    expect(db.getCanvas(board.id)?.revision).toBe(0);
    const saved = db.saveCanvas(board.id, 0, {
      elements: [{ id: "shape-1", type: "rectangle", version: 2, versionNonce: 10 }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {
        image: {
          id: "image",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AA==",
          created: 1,
        },
      },
    });
    expect(saved.saved).toBe(true);
    expect(db.getCanvas(board.id)).toMatchObject({
      revision: 1,
      scene: {
        elements: [{ id: "shape-1", type: "rectangle", version: 2, versionNonce: 10 }],
        files: { image: { id: "image" } },
      },
    });
    expect(db.getCanvas(board.id, false)?.scene.files).toEqual({});
    expect(db.getCanvasFile(board.id, "image")).toMatchObject({
      id: "image",
      mimeType: "image/png",
    });
    expect(db.saveCanvasFile(board.id, "image-2", {
      id: "image-2",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AQ==",
      created: 2,
    })).toBe(true);
    expect(db.getCanvasFile(board.id, "image-2")).toMatchObject({ id: "image-2" });
    expect(db.saveCanvasFile("missing", "image", {})).toBe(false);
    const concurrent = db.saveCanvas(board.id, 0, {
      elements: [
        { id: "shape-1", type: "rectangle", version: 2, versionNonce: 20 },
        { id: "shape-2", type: "ellipse", version: 1, versionNonce: 30 },
      ],
      appState: {},
      files: {},
    });
    expect(concurrent).toMatchObject({ saved: true, revision: 2 });
    expect(db.getCanvas(board.id)?.scene.elements).toEqual([
      { id: "shape-1", type: "rectangle", version: 2, versionNonce: 10 },
      { id: "shape-2", type: "ellipse", version: 1, versionNonce: 30 },
    ]);
    const room = db.getCollaborationRoom(board.id);
    expect(room?.roomId).toBe(board.id);
    expect(room?.roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(db.getCollaborationRoom(board.id)).toEqual(room);
    db.close();
  });

  it("upserts messages and removes their images on deletion", () => {
    const db = database();
    const { board } = db.ensureBoard({
      guildId: "1",
      guildName: "Team",
      channelId: "20000000000000001",
      channelName: "puzzle",
      categoryId: null,
      categoryName: null,
    });
    db.upsertMessages(board.id, [{
      id: "30000000000000001",
      channelId: board.channelId,
      authorId: "4",
      authorName: "Solver",
      authorAvatarUrl: null,
      authorIsBot: false,
      content: "first",
      replyToId: null,
      replySummary: null,
      createdAt: "2026-08-14T12:00:00.000Z",
      editedAt: null,
      images: [{
        id: "5",
        filename: "grid.png",
        contentType: "image/png",
        width: 100,
        height: 100,
        url: "https://cdn.example/grid.png",
        urlExpiresAt: "2026-08-15T00:00:00.000Z",
      }],
    }]);
    db.upsertMessages(board.id, [{
      id: "30000000000000001",
      channelId: board.channelId,
      authorId: "4",
      authorName: "Solver",
      authorAvatarUrl: null,
      authorIsBot: false,
      content: "edited",
      replyToId: null,
      replySummary: null,
      createdAt: "2026-08-14T12:00:00.000Z",
      editedAt: "2026-08-14T12:01:00.000Z",
      images: [],
    }]);
    const page = db.getBoardPage(board.id, null)!;
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.content).toBe("edited");
    expect(page.messages[0]?.images).toEqual([]);
    expect(db.deleteMessage(board.id, "30000000000000001")).toBe(true);
    expect(db.getBoardPage(board.id, null)?.messages).toEqual([]);
    db.close();
  });

  it("manages hunts, categories, and puzzles", () => {
    const db = database();
    const hunt = db.ensureHunt("10001", "MH 2026");
    expect(hunt.name).toBe("MH 2026");
    expect(hunt.guildId).toBe("10001");
    expect(db.listHunts()).toHaveLength(1);
    expect(db.getHunt(hunt.id)).toEqual(hunt);

    const category = db.ensureCategory(hunt.id, "20001", "Category 1");
    expect(category.name).toBe("Category 1");
    expect(category.guildCategoryId).toBe("20001");

    const puzzle = db.ensurePuzzle(hunt.id, category.id, "30001", null, "Puzzle A");
    expect(puzzle.title).toBe("Puzzle A");
    expect(puzzle.status).toBe("new");

    const updated = db.updatePuzzle(puzzle.id, {
      status: "solved",
      answer: "ANSWER",
      notes: "some notes",
    });
    expect(updated?.status).toBe("solved");
    expect(updated?.answer).toBe("ANSWER");
    expect(updated?.notes).toBe("some notes");

    expect(() => {
      db.updatePuzzle(puzzle.id, { status: "invalid" as any });
    }).toThrow("invalid_status");

    const overview = db.getHuntOverview(hunt.id);
    expect(overview?.hunt.id).toBe(hunt.id);
    expect(overview?.categories).toHaveLength(1);
    expect(overview?.categories[0]?.category?.id).toBe(category.id);
    expect(overview?.categories[0]?.puzzles).toHaveLength(1);
    expect(overview?.categories[0]?.puzzles[0]?.title).toBe("Puzzle A");

    expect(db.deletePuzzle(puzzle.id)).toBe(true);
    expect(db.deleteCategory(category.id)).toBe(true);
    db.close();
  });
});
