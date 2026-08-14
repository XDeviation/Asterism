import type {
  BoardRecord,
  EnsureBoardRequest,
  EnsureBoardResponse,
  RefreshCandidate,
} from "@asterism/shared";

export class AppApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`App API returned HTTP ${status}: ${responseBody.slice(0, 300)}`);
  }
}

export class AppApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.serviceToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(20_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new AppApiError(response.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  ensureBoard(identity: EnsureBoardRequest): Promise<EnsureBoardResponse> {
    return this.request("POST", "/api/internal/boards/ensure", identity);
  }

  async listBoards(): Promise<BoardRecord[]> {
    const response = await this.request<{ boards: BoardRecord[] }>(
      "GET",
      "/api/internal/boards",
    );
    return response.boards;
  }

  async listRefreshCandidates(): Promise<RefreshCandidate[]> {
    const before = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const response = await this.request<{ images: RefreshCandidate[] }>(
      "GET",
      `/api/internal/images/refresh-needed?before=${encodeURIComponent(before)}&limit=500`,
    );
    return response.images;
  }
}
