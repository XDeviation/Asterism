import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import argon2 from "argon2";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { buildServer } from "./server.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("App HTTP API", () => {
  it("protects browser routes and keeps board creation idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "asterism-server-test-"));
    temporaryDirectories.push(directory);
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      databasePath: join(directory, "database.sqlite"),
      publicUrl: "https://board.example.com",
      sitePasswordHash: await argon2.hash("hunt-password"),
      sessionSecret: "s".repeat(32),
      serviceToken: "t".repeat(32),
      cookieSecure: false,
      trustProxy: false,
      webDistDir: join(directory, "missing-web-dist"),
    };
    const app = await buildServer(config);

    expect((await app.inject({ method: "GET", url: "/api/boards" })).statusCode)
      .toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "hunt-password" },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    expect(cookie).toContain("asterism_session=");

    const identity = {
      guildId: "10000000000000001",
      guildName: "Team",
      channelId: "20000000000000001",
      channelName: "puzzle",
      categoryId: null,
      categoryName: null,
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/internal/boards/ensure",
      headers: { authorization: `Bearer ${config.serviceToken}` },
      payload: identity,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/internal/boards/ensure",
      headers: { authorization: `Bearer ${config.serviceToken}` },
      payload: identity,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    expect(second.json().created).toBe(false);
    expect(second.json().board.id).toBe(first.json().board.id);

    const boards = await app.inject({
      method: "GET",
      url: "/api/boards",
      headers: { cookie: cookie! },
    });
    expect(boards.statusCode).toBe(200);
    expect(boards.json().boards).toHaveLength(1);

    const boardId = first.json().board.id as string;
    const initialCanvas = await app.inject({
      method: "GET",
      url: `/api/boards/${boardId}/canvas`,
      headers: { cookie: cookie! },
    });
    expect(initialCanvas.statusCode).toBe(200);
    expect(initialCanvas.json().revision).toBe(0);
    expect(initialCanvas.json().collaboration).toMatchObject({ roomId: boardId });
    expect(initialCanvas.json().collaboration.roomKey).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const savedCanvas = await app.inject({
      method: "PUT",
      url: `/api/boards/${boardId}/canvas`,
      headers: { cookie: cookie! },
      payload: {
        baseRevision: 0,
        clientId: "browser-a",
        scene: {
          elements: [{ id: "shape-1", type: "rectangle" }],
          appState: { viewBackgroundColor: "#ffffff" },
          files: {},
        },
      },
    });
    expect(savedCanvas.statusCode).toBe(200);
    expect(savedCanvas.json().revision).toBe(1);

    const savedFile = await app.inject({
      method: "PUT",
      url: `/api/boards/${boardId}/canvas/files/image-1`,
      headers: { cookie: cookie! },
      payload: {
        file: {
          id: "image-1",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AA==",
          created: 1,
        },
      },
    });
    expect(savedFile.statusCode).toBe(200);

    const loadedFile = await app.inject({
      method: "GET",
      url: `/api/boards/${boardId}/canvas/files/image-1`,
      headers: { cookie: cookie! },
    });
    expect(loadedFile.statusCode).toBe(200);
    expect(loadedFile.json().file).toMatchObject({ id: "image-1" });

    const sceneOnlyCanvas = await app.inject({
      method: "GET",
      url: `/api/boards/${boardId}/canvas?sceneOnly=1`,
      headers: { cookie: cookie! },
    });
    expect(sceneOnlyCanvas.statusCode).toBe(200);
    expect(sceneOnlyCanvas.json().scene.files).toEqual({});

    const compatibleCanvas = await app.inject({
      method: "GET",
      url: `/api/boards/${boardId}/canvas`,
      headers: { cookie: cookie! },
    });
    expect(compatibleCanvas.statusCode).toBe(200);
    expect(compatibleCanvas.json().scene.files["image-1"]).toMatchObject({ id: "image-1" });

    const crossOriginSave = await app.inject({
      method: "PUT",
      url: `/api/boards/${boardId}/canvas`,
      headers: { cookie: cookie!, origin: "https://attacker.example" },
      payload: {
        baseRevision: 1,
        clientId: "browser-a",
        scene: { elements: [], appState: {}, files: {} },
      },
    });
    expect(crossOriginSave.statusCode).toBe(403);

    const concurrentSave = await app.inject({
      method: "PUT",
      url: `/api/boards/${boardId}/canvas`,
      headers: { cookie: cookie! },
      payload: {
        baseRevision: 0,
        clientId: "browser-b",
        scene: { elements: [], appState: {}, files: {} },
      },
    });
    expect(concurrentSave.statusCode).toBe(200);
    expect(concurrentSave.json().revision).toBe(2);

    const authCheck = await app.inject({
      method: "GET",
      url: "/api/auth/check",
      headers: { cookie: cookie! },
    });
    expect(authCheck.statusCode).toBe(204);

    await app.close();
  });
});
