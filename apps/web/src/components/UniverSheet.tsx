import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CollaborationRoom,
  ExtractionColumn,
  ExtractionRow,
  ExtractionTableRecord,
} from "@asterism/shared";
import {
  BooleanNumber,
  CommandType,
  LocaleType,
  Univer,
} from "@univerjs/core";
import type {
  ICellData,
  IColumnData,
  IObjectArrayPrimitiveType,
  IObjectMatrixPrimitiveType,
  IWorkbookData,
} from "@univerjs/core";
import { FUniver } from "@univerjs/core/facade";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import { io, type Socket } from "socket.io-client";
import { ApiRequestError, updateExtractionTable } from "../api.js";

type SyncStatus = "saved" | "saving" | "error";

interface UniverSheetProps {
  tableRecord: ExtractionTableRecord;
  collaborationRoom?: CollaborationRoom | null | undefined;
  onUnauthorized?: () => void;
}

type SheetMessage =
  | {
      type: "EXTRACTION_TABLE_SNAPSHOT";
      payload: { snapshot: unknown };
    }
  | {
      type: "EXTRACTION_TABLE_SNAPSHOT_INIT";
      payload: { snapshot: unknown };
    };

function uint8ArrayToBase64(array: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < array.byteLength; i++) {
    binary += String.fromCharCode(array[i]!);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function cryptoKey(roomKey: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      alg: "A128GCM",
      ext: true,
      k: roomKey,
      key_ops: ["encrypt", "decrypt"],
      kty: "oct",
    },
    { name: "AES-GCM", length: 128 },
    false,
    [usage],
  );
}

async function encryptRoomMessage(
  roomKey: string,
  message: SheetMessage,
): Promise<{ encrypted: ArrayBuffer; iv: Uint8Array<ArrayBuffer> }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(message));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cryptoKey(roomKey, "encrypt"),
    encoded,
  );
  return { encrypted, iv };
}

async function decryptRoomMessage(
  roomKey: string,
  encrypted: ArrayBuffer,
  iv: Uint8Array,
): Promise<SheetMessage> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    await cryptoKey(roomKey, "decrypt"),
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as SheetMessage;
}

/**
 * Convert the legacy (一期) `columns`/`rows` model into a Univer workbook
 * snapshot. The first row holds column names (frozen as a header row) and the
 * remaining rows hold cell values keyed by column position.
 */
function legacyToSnapshot(
  columns: ExtractionColumn[],
  rows: ExtractionRow[],
  tableId: string,
): Partial<IWorkbookData> {
  const sheetId = "sheet-1";
  const cellData: IObjectMatrixPrimitiveType<ICellData> = {};
  const columnData: IObjectArrayPrimitiveType<Partial<IColumnData>> = {};

  const headerRow: IObjectArrayPrimitiveType<ICellData> = {};
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c]!;
    headerRow[c] = { v: column.name, s: { bl: BooleanNumber.TRUE } };
  }
  cellData[0] = headerRow;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const rowCells: IObjectArrayPrimitiveType<ICellData> = {};
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c]!;
      const value = row.cells[column.id];
      if (value !== undefined && value !== "") {
        rowCells[c] = { v: value };
      }
    }
    if (Object.keys(rowCells).length > 0) {
      cellData[r + 1] = rowCells;
    }
  }

  for (let c = 0; c < columns.length; c++) {
    const column = columns[c]!;
    columnData[c] = { w: column.width ?? 120 };
  }

  return {
    id: `extraction-${tableId}`,
    name: "提取表",
    locale: LocaleType.ZH_CN,
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: "提取表",
        rowCount: rows.length + 40,
        columnCount: columns.length + 5,
        cellData,
        columnData,
        freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
      },
    },
  };
}

function resolveSnapshot(record: ExtractionTableRecord): Partial<IWorkbookData> {
  const snapshot = record.snapshot;
  if (
    snapshot &&
    typeof snapshot === "object" &&
    !Array.isArray(snapshot) &&
    (snapshot as Record<string, unknown>).sheets &&
    Array.isArray((snapshot as Record<string, unknown>).sheetOrder)
  ) {
    return snapshot as Partial<IWorkbookData>;
  }
  return legacyToSnapshot(record.columns, record.rows, record.id);
}

export function UniverSheet({
  tableRecord,
  collaborationRoom,
  onUnauthorized,
}: UniverSheetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const univerRef = useRef<Univer | null>(null);
  const apiRef = useRef<FUniver | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const applyingRemoteRef = useRef(false);
  const [status, setStatus] = useState<SyncStatus>("saved");

  // Latest-value refs so the stable callbacks below always see fresh props
  // without forcing the Univer bootstrap effect to re-run.
  const collaborationRoomRef = useRef<CollaborationRoom | null | undefined>(collaborationRoom);
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => {
    collaborationRoomRef.current = collaborationRoom;
  }, [collaborationRoom]);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const applySnapshot = useCallback((snapshot: unknown) => {
    const api = apiRef.current;
    if (!api || typeof snapshot !== "object" || snapshot === null) return;
    applyingRemoteRef.current = true;
    try {
      const active = api.getActiveWorkbook();
      if (active) api.disposeUnit(active.getId());
      api.createWorkbook(snapshot as Partial<IWorkbookData>);
    } finally {
      applyingRemoteRef.current = false;
    }
  }, []);

  const broadcastSnapshot = useCallback(
    (type: SheetMessage["type"], snapshot: unknown) => {
      const socket = socketRef.current;
      const room = collaborationRoomRef.current;
      if (!socket?.connected || !room) return;
      const message: SheetMessage = { type, payload: { snapshot } };
      void (async () => {
        try {
          const { encrypted, iv } = await encryptRoomMessage(room.roomKey, message);
          socket.emit("server-broadcast", room.roomId, encrypted, iv);
        } catch (error) {
          console.error("Failed to broadcast extraction table snapshot:", error);
        }
      })();
    },
    [],
  );

  const flushSave = useCallback(async () => {
    const api = apiRef.current;
    if (!api || savingRef.current || !dirtyRef.current) return;
    const workbook = api.getActiveWorkbook();
    if (!workbook) return;

    dirtyRef.current = false;
    savingRef.current = true;
    setStatus("saving");

    try {
      const snapshot = workbook.save();
      await updateExtractionTable(tableRecord.id, { snapshot });
      setStatus("saved");
      broadcastSnapshot("EXTRACTION_TABLE_SNAPSHOT", snapshot);
    } catch (error) {
      dirtyRef.current = true;
      if (error instanceof ApiRequestError && error.status === 401) {
        onUnauthorizedRef.current?.();
        return;
      }
      console.error("Failed to save extraction table snapshot:", error);
      setStatus("error");
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        void flushSave();
      }, 2_000);
    } finally {
      savingRef.current = false;
      if (dirtyRef.current && retryTimerRef.current === null) {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          void flushSave();
        }, 800);
      }
    }
  }, [tableRecord.id, broadcastSnapshot]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    setStatus("saving");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 800);
  }, [flushSave]);

  // Bootstrap Univer and the initial workbook.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const univer = new Univer({
      darkMode: true,
      locale: LocaleType.ZH_CN,
      locales: { [LocaleType.ZH_CN]: zhCN },
    });
    const preset = UniverSheetsCorePreset({
      container,
      header: false,
      ribbonType: "simple",
    });
    for (const entry of preset.plugins) {
      if (Array.isArray(entry)) {
        univer.registerPlugin(entry[0], entry[1]);
      } else {
        univer.registerPlugin(entry);
      }
    }

    univerRef.current = univer;
    const univerAPI = FUniver.newAPI(univer);
    apiRef.current = univerAPI;

    univerAPI.createWorkbook(resolveSnapshot(tableRecord));

    const disposable = univerAPI.addEvent(
      univerAPI.Event.CommandExecuted,
      (event) => {
        if (applyingRemoteRef.current) return;
        if (event.type === CommandType.MUTATION) {
          scheduleSave();
        }
      },
    );

    return () => {
      disposable.dispose();
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      saveTimerRef.current = null;
      retryTimerRef.current = null;
      univer.dispose();
      univerRef.current = null;
      apiRef.current = null;
      // Univer may leave DOM behind; clear the mount point for a clean remount
      // (e.g. React StrictMode's double-invoked effects in development).
      container.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Room collaboration via Socket.IO (snapshot broadcast, not real-time Yjs).
  useEffect(() => {
    if (!collaborationRoom) return;

    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
    socketRef.current = socket;

    const sendInitSnapshot = () => {
      const api = apiRef.current;
      const workbook = api?.getActiveWorkbook();
      if (workbook) {
        broadcastSnapshot("EXTRACTION_TABLE_SNAPSHOT_INIT", workbook.save());
      }
    };

    socket.on("init-room", () => socket.emit("join-room", collaborationRoom.roomId));
    socket.on("first-in-room", sendInitSnapshot);
    socket.on("new-user", sendInitSnapshot);
    socket.on("client-broadcast", async (encrypted: ArrayBuffer, iv: Uint8Array) => {
      try {
        const message = await decryptRoomMessage(collaborationRoom.roomKey, encrypted, iv);
        if (
          message.type === "EXTRACTION_TABLE_SNAPSHOT" ||
          message.type === "EXTRACTION_TABLE_SNAPSHOT_INIT"
        ) {
          applySnapshot(message.payload.snapshot);
        }
      } catch {
        // Messages encrypted with a different room key cannot affect this sheet.
      }
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [collaborationRoom, applySnapshot, broadcastSnapshot]);

  return (
    <div className="univer-sheet-shell">
      <div ref={containerRef} className="univer-sheet-container" />
      <div className={`univer-sheet-sync status-${status}`} aria-live="polite">
        {status === "saved"
          ? "🟢 已保存"
          : status === "saving"
            ? "🟡 正在保存…"
            : "🔴 保存异常，重试中"}
      </div>
    </div>
  );
}
