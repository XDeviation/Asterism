export type PuzzleStatus = "new" | "in_progress" | "stuck" | "solved";

export interface HuntRecord {
  id: string;
  guildId: string;
  name: string;
  createdAt: string;
}

export interface CategoryRecord {
  id: string;
  huntId: string;
  guildCategoryId: string;
  name: string;
  boardId: string | null;
  createdAt: string;
}

export interface PuzzleRecord {
  id: string;
  huntId: string;
  categoryId: string | null;
  boardId: string | null;
  title: string;
  status: PuzzleStatus;
  answer: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface HuntOverview {
  hunt: HuntRecord;
  categories: Array<{ category: CategoryRecord | null; puzzles: PuzzleRecord[] }>;
}

export interface PuzzleDetail {
  puzzle: PuzzleRecord;
  category: CategoryRecord | null;
  hunt: HuntRecord;
}

export interface BoardIdentity {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  categoryId: string | null;
  categoryName: string | null;
}

export interface BoardRecord extends BoardIdentity {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  lastSyncedMessageId: string | null;
}

export interface CanvasScene {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export interface CanvasSnapshot {
  revision: number;
  scene: CanvasScene;
  updatedAt: string;
}

export interface CollaborationRoom {
  roomId: string;
  roomKey: string;
}

export interface CanvasDocument extends CanvasSnapshot {
  collaboration: CollaborationRoom;
}

export interface SaveCanvasRequest {
  baseRevision: number;
  clientId: string;
  scene: CanvasScene;
}

export interface SaveCanvasResponse {
  revision: number;
  updatedAt: string;
}

export interface SyncedImage {
  id: string;
  filename: string;
  contentType: string;
  width: number | null;
  height: number | null;
  url: string;
  urlExpiresAt: string | null;
}

export interface SyncedMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  authorIsBot: boolean;
  content: string;
  replyToId: string | null;
  replySummary: string | null;
  createdAt: string;
  editedAt: string | null;
  images: SyncedImage[];
}

export interface MessageRecord extends SyncedMessage {
  boardId: string;
}

export interface EnsureBoardRequest extends BoardIdentity {}

export interface EnsureBoardResponse {
  board: BoardRecord;
  boardUrl: string;
  created: boolean;
}

export interface MessageBatchRequest {
  messages: SyncedMessage[];
}

export interface RefreshCandidate extends SyncedImage {
  boardId: string;
  messageId: string;
  channelId: string;
}

export interface RefreshImagesRequest {
  messageId: string;
  images: SyncedImage[];
}

export interface BoardPage {
  board: BoardRecord;
  messages: MessageRecord[];
  nextBefore: string | null;
}

export interface BoardSummary extends BoardRecord {
  messageCount: number;
}

export interface ApiError {
  error: string;
}

export type BoardEvent =
  | { type: "message.upsert"; message: MessageRecord }
  | { type: "message.delete"; messageId: string }
  | {
      type: "canvas.update";
      clientId: string;
      revision: number;
      scene: CanvasScene;
      updatedAt: string;
    }
  | { type: "board.update"; board: BoardRecord };

export function isDiscordSnowflake(value: string): boolean {
  return /^\d{16,22}$/.test(value);
}

export function maxSnowflake(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return BigInt(left) >= BigInt(right) ? left : right;
}

export type ExtractionTargetType = "puzzle" | "category" | "board";

export interface ExtractionColumn {
  id: string;
  name: string;
  width?: number;
}

export interface ExtractionRow {
  id: string;
  cells: Record<string, string>;
}

export interface ExtractionTableRecord {
  id: string;
  targetType: ExtractionTargetType;
  targetId: string;
  columns: ExtractionColumn[];
  rows: ExtractionRow[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateExtractionTableRequest {
  targetType: ExtractionTargetType;
  targetId: string;
  columns?: ExtractionColumn[];
  rows?: ExtractionRow[];
}

export interface UpdateExtractionTableRequest {
  columns?: ExtractionColumn[];
  rows?: ExtractionRow[];
}
