import { useEffect, useState } from "react";
import type {
  BoardEvent,
  BoardPage,
  CanvasDocument,
  CanvasSnapshot,
} from "@asterism/shared";
import { ApiRequestError, getBoard, getCanvas } from "../api.js";
import { ExcalidrawBoard } from "../components/ExcalidrawBoard.js";
import { MessageSidebar } from "../components/MessageSidebar.js";

export function BoardScreen({
  boardId,
  onUnauthorized,
}: {
  boardId: string;
  onUnauthorized: () => void;
}) {
  const [page, setPage] = useState<BoardPage | null>(null);
  const [canvas, setCanvas] = useState<CanvasDocument | null>(null);
  const [legacyIncoming, setLegacyIncoming] = useState<{
    snapshot: CanvasSnapshot;
    sequence: number;
  } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getBoard(boardId), getCanvas(boardId)])
      .then(([boardPage, canvasSnapshot]) => {
        setPage(boardPage);
        setCanvas(canvasSnapshot);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          onUnauthorized();
        } else {
          setError(requestError instanceof ApiRequestError && requestError.status === 404
            ? "白板不存在。"
            : "白板加载失败。");
        }
      });
  }, [boardId, onUnauthorized]);

  useEffect(() => {
    if (!page || !canvas) return;
    const source = new EventSource(`/api/boards/${encodeURIComponent(boardId)}/events`);
    source.onopen = () => {
      void getBoard(boardId).then((latest) => {
        setPage((current) => current ? { ...current, board: latest.board } : latest);
      }).catch(() => {
        // The stream will retry; keep the last usable page visible.
      });
    };
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
        return;
      }
      if (update.type === "board.update") {
        setPage((current) => current ? { ...current, board: update.board } : current);
      }
    };
    source.onerror = () => {
      // EventSource reconnects automatically; the visual state can remain usable.
    };
    return () => source.close();
  }, [boardId, Boolean(page), Boolean(canvas)]);

  if (error) return <main className="center-card"><h1>{error}</h1><a href="/">返回首页</a></main>;
  if (!page) return <div className="loading">正在打开白板…</div>;

  return (
    <main className={`board-shell ${collapsed ? "chat-collapsed" : ""}`}>
      <header className="board-toolbar">
        <a href="/" className="brand"><span>✦</span> Asterism</a>
        <div className="board-title"><span>#</span>{page.board.channelName}</div>
        <button
          className="ghost-button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "显示消息" : "隐藏消息"}
        </button>
      </header>
      {canvas ? (
        <ExcalidrawBoard
          boardId={boardId}
          initialCanvas={canvas}
          legacyIncoming={legacyIncoming}
          onUnauthorized={onUnauthorized}
        />
      ) : (
        <div className="canvas-loading">正在加载画布…</div>
      )}
      {!collapsed && (
        <MessageSidebar boardId={boardId} onUnauthorized={onUnauthorized} />
      )}
    </main>
  );
}
