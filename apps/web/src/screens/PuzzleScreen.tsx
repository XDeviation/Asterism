import { lazy, Suspense, useEffect, useState } from "react";
import type {
  BoardEvent,
  CanvasDocument,
  CanvasSnapshot,
  ExtractionTableRecord,
  PuzzleDetail,
  PuzzleStatus,
} from "@asterism/shared";
import {
  ApiRequestError,
  getPuzzle,
  getCanvas,
  updatePuzzle,
  getExtractionTable,
  createExtractionTable,
} from "../api.js";
import { ExcalidrawBoard } from "../components/ExcalidrawBoard.js";
import { MessageSidebar } from "../components/MessageSidebar.js";

const UniverSheet = lazy(() =>
  import("../components/UniverSheet.js").then((module) => ({
    default: module.UniverSheet,
  })),
);

const STATUS_LABELS: Record<PuzzleStatus, string> = {
  new: "新题",
  in_progress: "进行中",
  stuck: "卡住",
  solved: "已解出",
};

export function PuzzleScreen({
  puzzleId,
  onUnauthorized,
}: {
  puzzleId: string;
  onUnauthorized: () => void;
}) {
  const [detail, setDetail] = useState<PuzzleDetail | null>(null);
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [legacyIncoming, setLegacyIncoming] = useState<{
    snapshot: CanvasSnapshot;
    sequence: number;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<"canvas" | "table">("canvas");
  const [extractionTable, setExtractionTable] = useState<ExtractionTableRecord | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPuzzle(puzzleId)
      .then((puzzleDetail) => {
        setDetail(puzzleDetail);
        if (puzzleDetail.puzzle.boardId) {
          getCanvas(puzzleDetail.puzzle.boardId)
            .then(setCanvas)
            .catch((requestError: unknown) => {
              if (requestError instanceof ApiRequestError && requestError.status === 401) {
                onUnauthorized();
              } else {
                setError("白板加载失败。");
              }
            });
        }
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          onUnauthorized();
        } else {
          setError(requestError instanceof ApiRequestError && requestError.status === 404
            ? "题目不存在。"
            : "加载失败。");
        }
      });

    setTableLoading(true);
    getExtractionTable("puzzle", puzzleId)
      .then((table) => setExtractionTable(table))
      .catch((err) => console.error("Failed to load extraction table:", err))
      .finally(() => setTableLoading(false));
  }, [puzzleId, onUnauthorized]);

  useEffect(() => {
    if (!detail?.puzzle.boardId || !canvas) return;
    const boardId = detail.puzzle.boardId;
    const source = new EventSource(`/api/boards/${encodeURIComponent(boardId)}/events`);
    source.onmessage = (event) => {
      const update = JSON.parse(event.data) as BoardEvent;
      if (update.type === "canvas.update") {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(update.clientId)) {
          setLegacyIncoming((current) => ({
            snapshot: {
              revision: update.revision,
              scene: update.scene,
              updatedAt: update.updatedAt,
            },
            sequence: (current?.sequence ?? 0) + 1,
          }));
        }
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically
    };
    return () => source.close();
  }, [detail?.puzzle.boardId, Boolean(canvas)]);

  const handleUpdate = async (updates: Parameters<typeof updatePuzzle>[1]) => {
    if (!detail) return;
    try {
      const updatedPuzzle = await updatePuzzle(detail.puzzle.id, updates);
      setDetail((current) => current ? { ...current, puzzle: updatedPuzzle } : null);
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateExtractionTable = async () => {
    setTableLoading(true);
    try {
      const created = await createExtractionTable("puzzle", puzzleId);
      setExtractionTable(created);
    } catch (err) {
      console.error("Failed to create extraction table:", err);
    } finally {
      setTableLoading(false);
    }
  };

  if (error) return <main className="center-card"><h1>{error}</h1><a href="/">返回首页</a></main>;
  if (!detail) return <div className="loading">正在加载题目信息…</div>;

  return (
    <main className={`board-shell ${collapsed ? "chat-collapsed" : ""}`}>
      <header className="board-toolbar puzzle-toolbar">
        <div className="toolbar-left">
          <a href={`/hunts/${detail.puzzle.huntId}`} className="back-link">
            ← 返回看板
          </a>
          <span className="toolbar-separator">|</span>
          <div className="puzzle-title-display">
            {detail.category ? `${detail.category.name} / ` : ""}
            <input
              type="text"
              className="title-input"
              defaultValue={detail.puzzle.title}
              onBlur={(e) => e.target.value !== detail.puzzle.title && handleUpdate({ title: e.target.value })}
            />
          </div>
        </div>

        <div className="puzzle-meta-inputs">
          <div className="tab-switcher">
            <button
              type="button"
              className={`tab-btn ${activeTab === "canvas" ? "active" : ""}`}
              onClick={() => setActiveTab("canvas")}
            >
              🎨 白板
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === "table" ? "active" : ""}`}
              onClick={() => setActiveTab("table")}
            >
              📊 提取表
            </button>
          </div>

          <div className="meta-item">
            <span className="meta-label">状态</span>
            <select
              className="flat-select"
              value={detail.puzzle.status}
              onChange={(e) => handleUpdate({ status: e.target.value as PuzzleStatus })}
            >
              {(Object.keys(STATUS_LABELS) as PuzzleStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="meta-item">
            <span className="meta-label">答案</span>
            <input
              type="text"
              className="flat-input answer-input"
              placeholder="ANSWER"
              defaultValue={detail.puzzle.answer ?? ""}
              onBlur={(e) => e.target.value !== (detail.puzzle.answer ?? "") && handleUpdate({ answer: e.target.value || null })}
            />
          </div>

          <div className="meta-item">
            <span className="meta-label">备注</span>
            <input
              type="text"
              className="flat-input notes-input"
              placeholder="备注"
              defaultValue={detail.puzzle.notes}
              onBlur={(e) => e.target.value !== detail.puzzle.notes && handleUpdate({ notes: e.target.value })}
            />
          </div>
        </div>

        <button
          className="ghost-button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "显示消息" : "隐藏消息"}
        </button>
      </header>

      {activeTab === "canvas" ? (
        detail.puzzle.boardId ? (
          canvas ? (
            <ExcalidrawBoard
              boardId={detail.puzzle.boardId}
              initialCanvas={canvas}
              legacyIncoming={legacyIncoming}
              onUnauthorized={onUnauthorized}
            />
          ) : (
            <div className="canvas-loading">正在加载画布…</div>
          )
        ) : (
          <div className="canvas-loading">该题目未关联白板。</div>
        )
      ) : tableLoading ? (
        <div className="canvas-loading">正在加载提取表…</div>
      ) : extractionTable ? (
        <Suspense fallback={<div className="canvas-loading">正在加载电子表格…</div>}>
          <UniverSheet
            key={extractionTable.id}
            tableRecord={extractionTable}
            collaborationRoom={canvas?.collaboration}
            onUnauthorized={onUnauthorized}
          />
        </Suspense>
      ) : (
        <div className="empty-extraction-table-prompt">
          <h3>本题暂未创建提取表</h3>
          <p className="muted">提取表可以方便多名队员整理比对提取信息、字母、线索等。</p>
          <button
            type="button"
            className="primary-button"
            onClick={handleCreateExtractionTable}
          >
            ➕ 为本题创建提取表
          </button>
        </div>
      )}

      {!collapsed && detail.puzzle.boardId && (
        <MessageSidebar boardId={detail.puzzle.boardId} onUnauthorized={onUnauthorized} />
      )}
    </main>
  );
}
