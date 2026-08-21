import type {
  BoardPage,
  BoardSummary,
  CanvasDocument,
  CanvasScene,
  SaveCanvasResponse,
  HuntRecord,
  PuzzleRecord,
  PuzzleStatus,
  HuntOverview,
} from "@asterism/shared";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      body.error ?? `HTTP ${response.status}`,
      body as Record<string, unknown>,
    );
  }
  return body as T;
}

export async function getSession(): Promise<boolean> {
  const result = await request<{ authenticated: boolean }>("/api/auth/session");
  return result.authenticated;
}

export async function login(password: string): Promise<void> {
  await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

export async function listBoards(): Promise<BoardSummary[]> {
  const result = await request<{ boards: BoardSummary[] }>("/api/boards");
  return result.boards;
}

export async function getBoard(
  boardId: string,
  before?: string,
): Promise<BoardPage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  return request<BoardPage>(`/api/boards/${encodeURIComponent(boardId)}${query}`);
}

export async function getCanvas(boardId: string): Promise<CanvasDocument> {
  return request<CanvasDocument>(
    `/api/boards/${encodeURIComponent(boardId)}/canvas?sceneOnly=1`,
  );
}

export async function getCanvasFile(boardId: string, fileId: string): Promise<unknown> {
  const result = await request<{ file: unknown }>(
    `/api/boards/${encodeURIComponent(boardId)}/canvas/files/${encodeURIComponent(fileId)}`,
  );
  return result.file;
}

export async function saveCanvasFile(
  boardId: string,
  fileId: string,
  file: unknown,
): Promise<void> {
  await request(
    `/api/boards/${encodeURIComponent(boardId)}/canvas/files/${encodeURIComponent(fileId)}`,
    {
      method: "PUT",
      body: JSON.stringify({ file }),
    },
  );
}

export async function saveCanvas(
  boardId: string,
  baseRevision: number,
  clientId: string,
  scene: CanvasScene,
): Promise<SaveCanvasResponse> {
  return request<SaveCanvasResponse>(
    `/api/boards/${encodeURIComponent(boardId)}/canvas`,
    {
      method: "PUT",
      body: JSON.stringify({ baseRevision, clientId, scene }),
    },
  );
}

export async function listHunts(): Promise<HuntRecord[]> {
  const result = await request<{ hunts: HuntRecord[] }>("/api/hunts");
  return result.hunts;
}

export async function getHuntOverview(huntId: string): Promise<HuntOverview> {
  return request<HuntOverview>(`/api/hunts/${encodeURIComponent(huntId)}`);
}

export async function updatePuzzle(
  puzzleId: string,
  updates: {
    title?: string;
    status?: PuzzleStatus;
    answer?: string | null;
    notes?: string;
  },
): Promise<PuzzleRecord> {
  const result = await request<{ puzzle: PuzzleRecord }>(
    `/api/puzzles/${encodeURIComponent(puzzleId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
  return result.puzzle;
}
