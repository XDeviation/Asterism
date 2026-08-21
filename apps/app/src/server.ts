import { existsSync } from "node:fs";
import { join } from "node:path";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type {
  BoardIdentity,
  CanvasScene,
  MessageBatchRequest,
  RefreshImagesRequest,
  SyncedImage,
  SyncedMessage,
  PuzzleStatus,
  ExtractionColumn,
  ExtractionRow,
  ExtractionTargetType,
} from "@asterism/shared";
import {
  clearSessionCookie,
  createSessionToken,
  hasSession,
  safeTokenEqual,
  setSessionCookie,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { BoardEventHub } from "./events.js";

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function requireBrowserSession(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  if (
    hasSession(
      request,
      config.sitePasswordHash,
      config.sessionSecret,
      config.cookieSecure,
    )
  ) {
    return true;
  }
  void reply.code(401).send({ error: "authentication_required" });
  return false;
}

function requireServiceToken(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  if (safeTokenEqual(bearerToken(request), config.serviceToken)) return true;
  void reply.code(401).send({ error: "invalid_service_token" });
  return false;
}

function requireSameOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  const origin = request.headers.origin;
  if (!origin || origin === new URL(config.publicUrl).origin) return true;
  void reply.code(403).send({ error: "invalid_origin" });
  return false;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, name);
}

function parseBoardIdentity(body: unknown): BoardIdentity {
  if (!body || typeof body !== "object") throw new Error("invalid_body");
  const input = body as Record<string, unknown>;
  return {
    guildId: requiredString(input.guildId, "guild_id"),
    guildName: requiredString(input.guildName, "guild_name"),
    channelId: requiredString(input.channelId, "channel_id"),
    channelName: requiredString(input.channelName, "channel_name"),
    categoryId: nullableString(input.categoryId, "category_id"),
    categoryName: nullableString(input.categoryName, "category_name"),
  };
}

function parseImage(value: unknown): SyncedImage {
  if (!value || typeof value !== "object") throw new Error("invalid_image");
  const input = value as Record<string, unknown>;
  const width = input.width;
  const height = input.height;
  return {
    id: requiredString(input.id, "image_id"),
    filename: requiredString(input.filename, "image_filename"),
    contentType: requiredString(input.contentType, "image_content_type"),
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
    url: requiredString(input.url, "image_url"),
    urlExpiresAt: nullableString(input.urlExpiresAt, "image_expiry"),
  };
}

function parseMessage(value: unknown): SyncedMessage {
  if (!value || typeof value !== "object") throw new Error("invalid_message");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.images)) throw new Error("invalid_images");
  return {
    id: requiredString(input.id, "message_id"),
    channelId: requiredString(input.channelId, "channel_id"),
    authorId: requiredString(input.authorId, "author_id"),
    authorName: requiredString(input.authorName, "author_name"),
    authorAvatarUrl: nullableString(input.authorAvatarUrl, "avatar_url"),
    authorIsBot: input.authorIsBot === true,
    content: typeof input.content === "string" ? input.content : "",
    replyToId: nullableString(input.replyToId, "reply_to_id"),
    replySummary: nullableString(input.replySummary, "reply_summary"),
    createdAt: requiredString(input.createdAt, "created_at"),
    editedAt: nullableString(input.editedAt, "edited_at"),
    images: input.images.map(parseImage),
  };
}

function parseCanvasFile(fileId: string, value: unknown): Record<string, unknown> {
  if (fileId.length === 0 || fileId.length > 100) {
    throw new Error("invalid_canvas_file_id");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_canvas_file");
  }
  const file = value as Record<string, unknown>;
  if (
    file.id !== fileId ||
    typeof file.mimeType !== "string" ||
    !file.mimeType.startsWith("image/")
  ) {
    throw new Error("invalid_canvas_file");
  }
  if (
    typeof file.dataURL !== "string" ||
    !file.dataURL.startsWith(`data:${file.mimeType}`)
  ) {
    throw new Error("invalid_canvas_file_data");
  }
  if (typeof file.created !== "number" || !Number.isFinite(file.created)) {
    throw new Error("invalid_canvas_file_created");
  }
  return file;
}

function parseCanvasScene(value: unknown): CanvasScene {
  if (!value || typeof value !== "object") throw new Error("invalid_canvas_scene");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.elements)) throw new Error("invalid_canvas_elements");
  if (!input.appState || typeof input.appState !== "object" || Array.isArray(input.appState)) {
    throw new Error("invalid_canvas_app_state");
  }
  if (!input.files || typeof input.files !== "object" || Array.isArray(input.files)) {
    throw new Error("invalid_canvas_files");
  }

  const appStateInput = input.appState as Record<string, unknown>;
  const appState: Record<string, unknown> = {};
  if (typeof appStateInput.viewBackgroundColor === "string") {
    appState.viewBackgroundColor = appStateInput.viewBackgroundColor;
  }
  for (const key of ["gridSize", "gridStep"] as const) {
    if (typeof appStateInput[key] === "number" && Number.isFinite(appStateInput[key])) {
      appState[key] = appStateInput[key];
    }
  }
  if (typeof appStateInput.gridModeEnabled === "boolean") {
    appState.gridModeEnabled = appStateInput.gridModeEnabled;
  }

  const files: Record<string, unknown> = {};
  for (const [fileId, value] of Object.entries(input.files as Record<string, unknown>)) {
    files[fileId] = parseCanvasFile(fileId, value);
  }

  return { elements: input.elements, appState, files };
}

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: config.trustProxy });
  const database = new AppDatabase(config.databasePath);
  const events = new BoardEventHub();

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.addHook("onRequest", async (request, reply) => {
    reply.headers({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    });
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; frame-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob:; form-action 'self'",
    );
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const password = (request.body as { password?: unknown } | null)?.password;
      if (typeof password !== "string") {
        return reply.code(400).send({ error: "password_required" });
      }
      if (!(await argon2.verify(config.sitePasswordHash, password))) {
        return reply.code(401).send({ error: "invalid_password" });
      }
      setSessionCookie(
        reply,
        createSessionToken(config.sitePasswordHash, config.sessionSecret),
        config.cookieSecure,
      );
      return { authenticated: true };
    },
  );

  app.get("/api/auth/session", async (request) => ({
    authenticated: hasSession(
      request,
      config.sitePasswordHash,
      config.sessionSecret,
      config.cookieSecure,
    ),
  }));

  app.get("/api/auth/check", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    return reply.code(204).send();
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply, config.cookieSecure);
    return { authenticated: false };
  });

  app.get("/api/boards", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    return { boards: database.listBoards() };
  });

  app.get("/api/boards/:boardId", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { boardId } = request.params as { boardId: string };
    const { before, limit } = request.query as { before?: string; limit?: string };
    const page = database.getBoardPage(
      boardId,
      before ?? null,
      Number.parseInt(limit ?? "50", 10),
    );
    if (!page) return reply.code(404).send({ error: "board_not_found" });
    return page;
  });

  app.get("/api/boards/:boardId/canvas", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { boardId } = request.params as { boardId: string };
    const { sceneOnly } = request.query as { sceneOnly?: string };
    const canvas = database.getCanvas(boardId, sceneOnly !== "1");
    if (!canvas) return reply.code(404).send({ error: "board_not_found" });
    const collaboration = database.getCollaborationRoom(boardId);
    if (!collaboration) return reply.code(404).send({ error: "board_not_found" });
    return { ...canvas, collaboration };
  });

  app.get("/api/boards/:boardId/canvas/files/:fileId", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { boardId, fileId } = request.params as { boardId: string; fileId: string };
    if (fileId.length === 0 || fileId.length > 100) {
      return reply.code(400).send({ error: "invalid_canvas_file_id" });
    }
    if (!database.getBoard(boardId)) {
      return reply.code(404).send({ error: "board_not_found" });
    }
    const file = database.getCanvasFile(boardId, fileId);
    if (!file) return reply.code(404).send({ error: "canvas_file_not_found" });
    reply.header("Cache-Control", "private, max-age=86400");
    return { file };
  });

  app.put(
    "/api/boards/:boardId/canvas/files/:fileId",
    { bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      if (!requireBrowserSession(request, reply, config)) return;
      if (!requireSameOrigin(request, reply, config)) return;
      const { boardId, fileId } = request.params as { boardId: string; fileId: string };
      const body = request.body as { file?: unknown } | null;
      const file = parseCanvasFile(fileId, body?.file);
      if (!database.saveCanvasFile(boardId, fileId, file)) {
        return reply.code(404).send({ error: "board_not_found" });
      }
      return { stored: true };
    },
  );

  app.put(
    "/api/boards/:boardId/canvas",
    { bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      if (!requireBrowserSession(request, reply, config)) return;
      if (!requireSameOrigin(request, reply, config)) return;
      const { boardId } = request.params as { boardId: string };
      const body = request.body as Record<string, unknown> | null;
      if (!body || !Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
        return reply.code(400).send({ error: "invalid_canvas_revision" });
      }
      const clientId = requiredString(body.clientId, "canvas_client_id");
      if (clientId.length > 100) {
        return reply.code(400).send({ error: "invalid_canvas_client_id" });
      }
      const scene = parseCanvasScene(body.scene);
      const result = database.saveCanvas(
        boardId,
        body.baseRevision as number,
        scene,
      );
      if (!result.saved) return reply.code(404).send({ error: "board_not_found" });
      events.publish(boardId, {
        type: "canvas.update",
        clientId,
        revision: result.revision,
        scene,
        updatedAt: result.updatedAt,
      });
      return { revision: result.revision, updatedAt: result.updatedAt };
    },
  );

  app.get("/api/boards/:boardId/events", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { boardId } = request.params as { boardId: string };
    if (!database.getBoard(boardId)) {
      return reply.code(404).send({ error: "board_not_found" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("event: ready\ndata: {}\n\n");
    const unsubscribe = events.subscribe(boardId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 25_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/hunts", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    return { hunts: database.listHunts() };
  });

  app.get("/api/hunts/:huntId", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { huntId } = request.params as { huntId: string };
    const overview = database.getHuntOverview(huntId);
    if (!overview) return reply.code(404).send({ error: "hunt_not_found" });
    return overview;
  });

  app.get("/api/internal/puzzles/by-board/:boardId", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { boardId } = request.params as { boardId: string };
    const puzzle = database.getPuzzleByBoardId(boardId);
    if (!puzzle) return reply.code(404).send({ error: "puzzle_not_found" });
    return { puzzleId: puzzle.id };
  });

  app.get("/api/puzzles/:puzzleId", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { puzzleId } = request.params as { puzzleId: string };
    const puzzle = database.getPuzzle(puzzleId);
    if (!puzzle) return reply.code(404).send({ error: "puzzle_not_found" });
    const category = puzzle.categoryId ? database.getCategory(puzzle.categoryId) : null;
    const hunt = database.getHunt(puzzle.huntId);
    if (!hunt) return reply.code(404).send({ error: "puzzle_not_found" });
    return { puzzle, category, hunt };
  });

  app.patch("/api/puzzles/:puzzleId", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { puzzleId } = request.params as { puzzleId: string };
    if (!database.getPuzzle(puzzleId)) {
      return reply.code(404).send({ error: "puzzle_not_found" });
    }
    const body = request.body as Record<string, unknown> | null;
    const updates: {
      title?: string;
      status?: import("@asterism/shared").PuzzleStatus;
      answer?: string | null;
      notes?: string;
    } = {};

    if (body?.title !== undefined) {
      updates.title = requiredString(body.title, "title");
    }
    if (body?.status !== undefined) {
      const status = requiredString(body.status, "status") as import("@asterism/shared").PuzzleStatus;
      if (!["new", "in_progress", "stuck", "solved"].includes(status)) {
        return reply.code(400).send({ error: "invalid_status" });
      }
      updates.status = status;
    }
    if (body?.answer !== undefined) {
      updates.answer = nullableString(body.answer, "answer");
    }
    if (body?.notes !== undefined) {
      updates.notes = typeof body.notes === "string" ? body.notes : "";
    }

    const puzzle = database.updatePuzzle(puzzleId, updates);
    if (!puzzle) return reply.code(404).send({ error: "puzzle_not_found" });
    return { puzzle };
  });

  app.get("/api/extraction-tables", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { targetType, targetId } = request.query as {
      targetType?: string;
      targetId?: string;
    };
    if (
      !targetType ||
      !["puzzle", "category", "board"].includes(targetType) ||
      !targetId
    ) {
      return reply.code(400).send({ error: "invalid_extraction_table_query" });
    }
    const table = database.getExtractionTable(
      targetType as ExtractionTargetType,
      targetId,
    );
    return { table };
  });

  app.get("/api/extraction-tables/:id", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    const { id } = request.params as { id: string };
    const table = database.getExtractionTableById(id);
    if (!table) return reply.code(404).send({ error: "extraction_table_not_found" });
    return { table };
  });

  app.post("/api/extraction-tables", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    if (!requireSameOrigin(request, reply, config)) return;
    const body = request.body as Record<string, unknown> | null;
    const targetType = requiredString(body?.targetType, "target_type");
    if (!["puzzle", "category", "board"].includes(targetType)) {
      return reply.code(400).send({ error: "invalid_target_type" });
    }
    const targetId = requiredString(body?.targetId, "target_id");
    const columns = Array.isArray(body?.columns)
      ? (body.columns as ExtractionColumn[])
      : undefined;
    const rows = Array.isArray(body?.rows)
      ? (body.rows as ExtractionRow[])
      : undefined;

    const table = database.createExtractionTable(
      targetType as ExtractionTargetType,
      targetId,
      columns,
      rows,
    );
    return { table };
  });

  app.put("/api/extraction-tables/:id", async (request, reply) => {
    if (!requireBrowserSession(request, reply, config)) return;
    if (!requireSameOrigin(request, reply, config)) return;
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | null;
    const columns = Array.isArray(body?.columns)
      ? (body.columns as ExtractionColumn[])
      : undefined;
    const rows = Array.isArray(body?.rows)
      ? (body.rows as ExtractionRow[])
      : undefined;

    const updates: { columns?: ExtractionColumn[]; rows?: ExtractionRow[] } = {};
    if (columns !== undefined) updates.columns = columns;
    if (rows !== undefined) updates.rows = rows;

    const table = database.updateExtractionTable(id, updates);
    if (!table) return reply.code(404).send({ error: "extraction_table_not_found" });
    return { table };
  });

  app.post("/api/internal/sync/guild", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const body = request.body as Record<string, unknown> | null;
    const guildId = requiredString(body?.guildId, "guild_id");
    const guildName = requiredString(body?.guildName, "guild_name");
    const hunt = database.ensureHunt(guildId, guildName);
    return { hunt };
  });

  app.post("/api/internal/sync/category", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const body = request.body as Record<string, unknown> | null;
    const guildId = requiredString(body?.guildId, "guild_id");
    const guildCategoryId = requiredString(body?.guildCategoryId, "guild_category_id");
    const name = requiredString(body?.name, "name");
    
    let hunt = database.listHunts().find(h => h.guildId === guildId);
    if (!hunt) {
      hunt = database.ensureHunt(guildId, "Unknown Guild");
    }

    const category = database.ensureCategory(hunt.id, guildCategoryId, name);
    return { category };
  });

  app.post("/api/internal/sync/channel", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const body = request.body as Record<string, unknown> | null;
    const guildId = requiredString(body?.guildId, "guild_id");
    const guildCategoryId = nullableString(body?.guildCategoryId, "guild_category_id");
    const channelId = requiredString(body?.channelId, "channel_id");
    const boardId = nullableString(body?.boardId, "board_id");
    const title = requiredString(body?.title, "title");
    const categoryName = nullableString(body?.categoryName, "category_name");

    let hunt = database.listHunts().find(h => h.guildId === guildId);
    if (!hunt) {
      hunt = database.ensureHunt(guildId, "Unknown Guild");
    }

    let categoryId: string | null = null;
    if (guildCategoryId) {
      const dbCategory = database.ensureCategory(hunt.id, guildCategoryId, categoryName ?? "Unknown Category");
      categoryId = dbCategory.id;
    }

    const puzzle = database.ensurePuzzle(hunt.id, categoryId, channelId, boardId, title);
    return { puzzle };
  });

  app.post("/api/internal/boards/ensure", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const identity = parseBoardIdentity(request.body);
    const result = database.ensureBoard(identity);
    events.publish(result.board.id, { type: "board.update", board: result.board });
    return {
      ...result,
      boardUrl: `${config.publicUrl}/boards/${result.board.id}`,
    };
  });

  app.get("/api/internal/boards", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    return { boards: database.listBoards() };
  });

  app.put("/api/internal/boards/:boardId/messages", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const { boardId } = request.params as { boardId: string };
    const body = request.body as Partial<MessageBatchRequest> | null;
    if (!body || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: "messages_required" });
    }
    try {
      const records = database.upsertMessages(boardId, body.messages.map(parseMessage));
      for (const message of records) {
        events.publish(boardId, { type: "message.upsert", message });
      }
      return { accepted: records.length };
    } catch (error) {
      if (error instanceof Error && error.message === "board_not_found") {
        return reply.code(404).send({ error: "board_not_found" });
      }
      if (error instanceof Error && error.message === "channel_mismatch") {
        return reply.code(409).send({ error: "channel_mismatch" });
      }
      throw error;
    }
  });

  app.delete(
    "/api/internal/boards/:boardId/messages/:messageId",
    async (request, reply) => {
      if (!requireServiceToken(request, reply, config)) return;
      const { boardId, messageId } = request.params as {
        boardId: string;
        messageId: string;
      };
      const deleted = database.deleteMessage(boardId, messageId);
      if (deleted) events.publish(boardId, { type: "message.delete", messageId });
      return { deleted };
    },
  );

  app.get("/api/internal/images/refresh-needed", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const { before, limit } = request.query as { before?: string; limit?: string };
    const cutoff = before ?? new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString();
    return {
      images: database.listRefreshCandidates(
        cutoff,
        Number.parseInt(limit ?? "200", 10),
      ),
    };
  });

  app.put("/api/internal/images/:messageId", async (request, reply) => {
    if (!requireServiceToken(request, reply, config)) return;
    const { messageId } = request.params as { messageId: string };
    const body = request.body as Partial<RefreshImagesRequest> | null;
    if (!body || !Array.isArray(body.images)) {
      return reply.code(400).send({ error: "images_required" });
    }
    database.refreshImages(messageId, body.images.map(parseImage));
    return { updated: body.images.length };
  });

  if (existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const message = error instanceof Error ? error.message : "unknown_error";
    const clientError = message.startsWith("invalid_");
    void reply.code(clientError ? 400 : 500).send({
      error: clientError ? message : "internal_server_error",
    });
  });

  app.addHook("onClose", async () => database.close());
  return app;
}
