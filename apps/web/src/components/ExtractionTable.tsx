import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CollaborationRoom,
  ExtractionColumn,
  ExtractionRow,
  ExtractionTableRecord,
} from "@asterism/shared";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import * as Y from "yjs";
import { io, type Socket } from "socket.io-client";
import { updateExtractionTable } from "../api.js";

type SyncStatus = "saved" | "saving" | "error";

interface ExtractionTableProps {
  tableRecord: ExtractionTableRecord;
  collaborationRoom?: CollaborationRoom | null | undefined;
  onUnauthorized?: () => void;
}

interface TableMessage {
  type: "EXTRACTION_TABLE_YJS_UPDATE" | "EXTRACTION_TABLE_YJS_INIT";
  payload: { update: string };
}

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
  message: TableMessage,
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
): Promise<TableMessage> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    await cryptoKey(roomKey, "decrypt"),
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as TableMessage;
}

export function ExtractionTable({
  tableRecord,
  collaborationRoom,
  onUnauthorized,
}: ExtractionTableProps) {
  const [columns, setColumns] = useState<ExtractionColumn[]>(tableRecord.columns);
  const [rows, setRows] = useState<ExtractionRow[]>(tableRecord.rows);
  const [status, setStatus] = useState<SyncStatus>("saved");
  const [showAddColModal, setShowAddColModal] = useState(false);
  const [newColName, setNewColName] = useState("");
  const [editingColId, setEditingColId] = useState<string | null>(null);
  const [editingColName, setEditingColName] = useState("");

  const ydocRef = useRef<Y.Doc | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);

  // Initialize Yjs document
  if (!ydocRef.current) {
    const doc = new Y.Doc();
    const yColumns = doc.getArray<ExtractionColumn>("columns");
    const yRows = doc.getArray<ExtractionRow>("rows");

    if (yColumns.length === 0 && tableRecord.columns.length > 0) {
      yColumns.push(tableRecord.columns);
    }
    if (yRows.length === 0 && tableRecord.rows.length > 0) {
      yRows.push(tableRecord.rows);
    }
    ydocRef.current = doc;
  }

  const ydoc = ydocRef.current;
  const yColumns = ydoc.getArray<ExtractionColumn>("columns");
  const yRows = ydoc.getArray<ExtractionRow>("rows");

  // Save to REST API
  const flushSave = useCallback(async () => {
    if (isSavingRef.current || !isDirtyRef.current) return;
    isDirtyRef.current = false;
    isSavingRef.current = true;
    setStatus("saving");

    try {
      const currentCols = yColumns.toArray();
      const currentRows = yRows.toArray();
      await updateExtractionTable(tableRecord.id, {
        columns: currentCols,
        rows: currentRows,
      });
      setStatus("saved");
    } catch (err) {
      console.error("Failed to auto-save extraction table:", err);
      isDirtyRef.current = true;
      setStatus("error");
    } finally {
      isSavingRef.current = false;
      if (isDirtyRef.current) {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => void flushSave(), 1000);
      }
    }
  }, [tableRecord.id, yColumns, yRows]);

  const scheduleSave = useCallback(() => {
    isDirtyRef.current = true;
    setStatus("saving");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void flushSave(), 800);
  }, [flushSave]);

  // Handle Yjs local/remote updates
  useEffect(() => {
    const handleYjsUpdate = (_update: Uint8Array, origin: unknown) => {
      setColumns(yColumns.toArray());
      setRows(yRows.toArray());

      if (origin !== "remote") {
        scheduleSave();

        // Broadcast update via socket if room available
        if (socketRef.current?.connected && collaborationRoom) {
          const updateBase64 = uint8ArrayToBase64(_update);
          const message: TableMessage = {
            type: "EXTRACTION_TABLE_YJS_UPDATE",
            payload: { update: updateBase64 },
          };
          void (async () => {
            try {
              const { encrypted, iv } = await encryptRoomMessage(
                collaborationRoom.roomKey,
                message,
              );
              socketRef.current?.emit(
                "server-broadcast",
                collaborationRoom.roomId,
                encrypted,
                iv,
              );
            } catch (err) {
              console.error("Failed to encrypt/broadcast Yjs update:", err);
            }
          })();
        }
      }
    };

    ydoc.on("update", handleYjsUpdate);
    return () => {
      ydoc.off("update", handleYjsUpdate);
    };
  }, [ydoc, yColumns, yRows, collaborationRoom, scheduleSave]);

  // Setup Socket.IO Collaboration
  useEffect(() => {
    if (!collaborationRoom) return;

    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on("init-room", () => {
      socket.emit("join-room", collaborationRoom.roomId);
    });

    socket.on("first-in-room", () => {
      // Send full initial state vector update
      const fullUpdate = Y.encodeStateAsUpdate(ydoc);
      if (fullUpdate.length > 0) {
        const message: TableMessage = {
          type: "EXTRACTION_TABLE_YJS_INIT",
          payload: { update: uint8ArrayToBase64(fullUpdate) },
        };
        void (async () => {
          try {
            const { encrypted, iv } = await encryptRoomMessage(
              collaborationRoom.roomKey,
              message,
            );
            socket.emit("server-broadcast", collaborationRoom.roomId, encrypted, iv);
          } catch (err) {
            console.error("Failed to send initial room state:", err);
          }
        })();
      }
    });

    socket.on("new-user", () => {
      const fullUpdate = Y.encodeStateAsUpdate(ydoc);
      if (fullUpdate.length > 0) {
        const message: TableMessage = {
          type: "EXTRACTION_TABLE_YJS_INIT",
          payload: { update: uint8ArrayToBase64(fullUpdate) },
        };
        void (async () => {
          try {
            const { encrypted, iv } = await encryptRoomMessage(
              collaborationRoom.roomKey,
              message,
            );
            socket.emit("server-broadcast", collaborationRoom.roomId, encrypted, iv);
          } catch (err) {
            console.error("Failed to broadcast room state to new user:", err);
          }
        })();
      }
    });

    socket.on("client-broadcast", async (encrypted: ArrayBuffer, iv: Uint8Array) => {
      try {
        const message = await decryptRoomMessage(collaborationRoom.roomKey, encrypted, iv);
        if (
          message.type === "EXTRACTION_TABLE_YJS_UPDATE" ||
          message.type === "EXTRACTION_TABLE_YJS_INIT"
        ) {
          const updateBytes = base64ToUint8Array(message.payload.update);
          Y.applyUpdate(ydoc, updateBytes, "remote");
        }
      } catch {
        // Ignore messages encrypted with a different key
      }
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [collaborationRoom, ydoc]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Yjs mutations
  const handleCellChange = useCallback(
    (rowId: string, colId: string, value: string) => {
      ydoc.transact(() => {
        const currentRows = yRows.toArray();
        const index = currentRows.findIndex((r) => r.id === rowId);
        if (index !== -1) {
          const oldRow = yRows.get(index);
          const updatedRow: ExtractionRow = {
            ...oldRow,
            cells: { ...oldRow.cells, [colId]: value },
          };
          yRows.delete(index, 1);
          yRows.insert(index, [updatedRow]);
        }
      });
    },
    [ydoc, yRows],
  );

  const handleAddRow = useCallback(() => {
    ydoc.transact(() => {
      const newRowId = `row_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const currentCols = yColumns.toArray();
      const cells: Record<string, string> = {};
      for (const col of currentCols) {
        cells[col.id] = col.id === "col_index" ? String(yRows.length + 1) : "";
      }
      yRows.push([{ id: newRowId, cells }]);
    });
  }, [ydoc, yColumns, yRows]);

  const handleDeleteRow = useCallback(
    (rowId: string) => {
      ydoc.transact(() => {
        const currentRows = yRows.toArray();
        const index = currentRows.findIndex((r) => r.id === rowId);
        if (index !== -1) {
          yRows.delete(index, 1);
        }
      });
    },
    [ydoc, yRows],
  );

  const handleMoveRow = useCallback(
    (fromIndex: number, direction: -1 | 1) => {
      ydoc.transact(() => {
        const currentRows = yRows.toArray();
        const targetIndex = fromIndex + direction;
        if (targetIndex >= 0 && targetIndex < currentRows.length) {
          const item = currentRows[fromIndex]!;
          yRows.delete(fromIndex, 1);
          yRows.insert(targetIndex, [item]);
        }
      });
    },
    [ydoc, yRows],
  );

  const handleAddColumn = useCallback(() => {
    const trimmed = newColName.trim();
    if (!trimmed) return;
    ydoc.transact(() => {
      const colId = `col_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const newCol: ExtractionColumn = { id: colId, name: trimmed, width: 160 };
      yColumns.push([newCol]);
    });
    setNewColName("");
    setShowAddColModal(false);
  }, [newColName, ydoc, yColumns]);

  const handleRenameColumn = useCallback(
    (colId: string, currentName: string) => {
      setEditingColId(colId);
      setEditingColName(currentName);
    },
    [],
  );

  const saveColumnName = useCallback(() => {
    if (!editingColId) return;
    const trimmed = editingColName.trim();
    if (trimmed) {
      ydoc.transact(() => {
        const currentCols = yColumns.toArray();
        const index = currentCols.findIndex((c) => c.id === editingColId);
        if (index !== -1) {
          const oldCol = yColumns.get(index);
          yColumns.delete(index, 1);
          yColumns.insert(index, [{ ...oldCol, name: trimmed }]);
        }
      });
    }
    setEditingColId(null);
    setEditingColName("");
  }, [editingColId, editingColName, ydoc, yColumns]);

  const handleDeleteColumn = useCallback(
    (colId: string) => {
      if (columns.length <= 1) return;
      ydoc.transact(() => {
        const currentCols = yColumns.toArray();
        const index = currentCols.findIndex((c) => c.id === colId);
        if (index !== -1) {
          yColumns.delete(index, 1);
          // Remove cell values for deleted column
          const currentRows = yRows.toArray();
          yRows.delete(0, currentRows.length);
          const updatedRows = currentRows.map((r) => {
            const newCells = { ...r.cells };
            delete newCells[colId];
            return { ...r, cells: newCells };
          });
          if (updatedRows.length > 0) {
            yRows.push(updatedRows);
          }
        }
      });
    },
    [columns.length, ydoc, yColumns, yRows],
  );

  const handleRenumberIndex = useCallback(() => {
    ydoc.transact(() => {
      const hasIndexCol = yColumns.toArray().some((c) => c.id === "col_index");
      if (!hasIndexCol) return;
      const currentRows = yRows.toArray();
      yRows.delete(0, currentRows.length);
      const updatedRows = currentRows.map((r, idx) => ({
        ...r,
        cells: { ...r.cells, col_index: String(idx + 1) },
      }));
      if (updatedRows.length > 0) {
        yRows.push(updatedRows);
      }
    });
  }, [ydoc, yColumns, yRows]);

  // TanStack Table Column Definitions
  const columnDefs = useMemo<ColumnDef<ExtractionRow>[]>(() => {
    const defs: ColumnDef<ExtractionRow>[] = columns.map((col) => ({
      id: col.id,
      header: () => (
        <div className="table-header-cell">
          {editingColId === col.id ? (
            <input
              type="text"
              className="col-rename-input"
              value={editingColName}
              autoFocus
              onChange={(e) => setEditingColName(e.target.value)}
              onBlur={saveColumnName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveColumnName();
                if (e.key === "Escape") setEditingColId(null);
              }}
            />
          ) : (
            <span className="col-name" onClick={() => handleRenameColumn(col.id, col.name)}>
              {col.name}
            </span>
          )}
          <div className="col-actions">
            <button
              type="button"
              className="col-action-btn"
              title="重命名"
              onClick={() => handleRenameColumn(col.id, col.name)}
            >
              ✏️
            </button>
            {columns.length > 1 && (
              <button
                type="button"
                className="col-action-btn danger"
                title="删除列"
                onClick={() => handleDeleteColumn(col.id)}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ),
      accessorFn: (row) => row.cells[col.id] ?? "",
      cell: ({ row, getValue }) => (
        <input
          type="text"
          className={`table-cell-input ${col.id === "col_extract" ? "cell-extract" : ""}`}
          value={(getValue() as string) ?? ""}
          onChange={(e) => handleCellChange(row.original.id, col.id, e.target.value)}
        />
      ),
    }));

    // Action column
    defs.push({
      id: "_actions",
      header: () => <span className="col-name text-center">操作</span>,
      cell: ({ row }) => (
        <div className="row-actions">
          <button
            type="button"
            className="row-action-btn"
            title="向上移动"
            disabled={row.index === 0}
            onClick={() => handleMoveRow(row.index, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="row-action-btn"
            title="向下移动"
            disabled={row.index === rows.length - 1}
            onClick={() => handleMoveRow(row.index, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="row-action-btn danger"
            title="删除行"
            onClick={() => handleDeleteRow(row.original.id)}
          >
            ✕
          </button>
        </div>
      ),
    });

    return defs;
  }, [
    columns,
    rows.length,
    editingColId,
    editingColName,
    saveColumnName,
    handleRenameColumn,
    handleDeleteColumn,
    handleCellChange,
    handleMoveRow,
    handleDeleteRow,
  ]);

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="extraction-table-container">
      <div className="table-toolbar">
        <div className="toolbar-left">
          <button type="button" className="ghost-button" onClick={handleAddRow}>
            ➕ 添加行
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setShowAddColModal(true)}
          >
            ➕ 添加列
          </button>
          <button
            type="button"
            className="ghost-button"
            title="将序号列重新从 1 到 N 连续编号"
            onClick={handleRenumberIndex}
          >
            🔢 重新编号
          </button>
        </div>

        <div className="toolbar-right">
          <span className={`table-sync-badge status-${status}`}>
            {status === "saved"
              ? "🟢 已实时同步"
              : status === "saving"
                ? "🟡 正在保存…"
                : "🔴 保存异常，重试中"}
          </span>
        </div>
      </div>

      <div className="table-scroll-wrapper">
        <table className="extraction-table">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length + 1} className="empty-table-msg">
                  暂无数据，点击上方“添加行”开始记录提取信息。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAddColModal && (
        <div className="modal-overlay" onClick={() => setShowAddColModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>添加新列</h3>
            <p className="muted">请输入新列名称（如：中间转换、索引数字等）</p>
            <input
              type="text"
              className="flat-input"
              placeholder="列名"
              value={newColName}
              autoFocus
              onChange={(e) => setNewColName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddColumn();
                if (e.key === "Escape") setShowAddColModal(false);
              }}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowAddColModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={handleAddColumn}
                disabled={!newColName.trim()}
              >
                添加列
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
