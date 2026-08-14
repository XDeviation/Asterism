import { useEffect, useRef, useState } from "react";
import type {
  BoardEvent,
  BoardPage,
  CanvasDocument,
  CanvasSnapshot,
  MessageRecord,
} from "@asterism/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiRequestError, getBoard, getCanvas } from "../api.js";
import {
  ExcalidrawBoard,
} from "../components/ExcalidrawBoard.js";

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
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageList = useRef<HTMLDivElement>(null);

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
        setPage((current) => current ? reconcileLatest(current, latest) : latest);
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
      setPage((current) => current ? applyEvent(current, update) : current);
    };
    source.onerror = () => {
      // EventSource reconnects automatically; the visual state can remain usable.
    };
    return () => source.close();
  }, [boardId, Boolean(page), Boolean(canvas)]);

  useEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [page?.messages.length]);

  const loadOlder = async () => {
    if (!page?.nextBefore) return;
    const older = await getBoard(boardId, page.nextBefore);
    setPage((current) => current ? {
      ...current,
      messages: [...older.messages, ...current.messages],
      nextBefore: older.nextBefore,
    } : current);
  };

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
        <aside className="chat-panel">
          <div className="chat-heading"><h2>Discord 消息</h2><span>只读同步</span></div>
          <div className="message-list" ref={messageList}>
            {page.nextBefore && (
              <button className="load-older" onClick={() => void loadOlder()}>加载更早消息</button>
            )}
            {page.messages.length === 0 && <p className="empty-chat">还没有同步消息。</p>}
            {page.messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                onImageClick={setSelectedImage}
              />
            ))}
          </div>
        </aside>
      )}
      {selectedImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setSelectedImage(null)}>
          <button aria-label="关闭图片">×</button>
          <img src={selectedImage} alt="Discord 图片原图" onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </main>
  );
}

function MessageItem({
  message,
  onImageClick,
}: {
  message: MessageRecord;
  onImageClick: (url: string) => void;
}) {
  return (
    <article className="message">
      {message.authorAvatarUrl ? (
        <img className="avatar" src={message.authorAvatarUrl} alt="" loading="lazy" />
      ) : (
        <div className="avatar avatar-fallback">{message.authorName.slice(0, 1)}</div>
      )}
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.authorName}</strong>
          {message.authorIsBot && <span className="bot-badge">BOT</span>}
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          {message.editedAt && <span title={message.editedAt}>（已编辑）</span>}
        </div>
        {message.replySummary && <div className="reply-preview">↪ {message.replySummary}</div>}
        {message.content && (
          <div className="message-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ node: _node, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer noopener" />
                ),
                img: ({ node: _node, src, alt }) => (
                  <a href={src} target="_blank" rel="noreferrer noopener">
                    {alt || src || "外部图片链接"}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {message.images.length > 0 && (
          <div className="image-grid">
            {message.images.map((image) => (
              <button key={image.id} onClick={() => onImageClick(image.url)}>
                <img src={image.url} alt={image.filename} loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function applyEvent(page: BoardPage, event: BoardEvent): BoardPage {
  if (event.type === "board.update") return { ...page, board: event.board };
  if (event.type === "canvas.update") return page;
  if (event.type === "message.delete") {
    return { ...page, messages: page.messages.filter((message) => message.id !== event.messageId) };
  }
  const index = page.messages.findIndex((message) => message.id === event.message.id);
  if (index === -1) {
    return {
      ...page,
      messages: [...page.messages, event.message].sort((left, right) =>
        BigInt(left.id) < BigInt(right.id)
          ? -1
          : BigInt(left.id) > BigInt(right.id) ? 1 : 0,
      ),
    };
  }
  const messages = [...page.messages];
  messages[index] = event.message;
  return { ...page, messages };
}

function reconcileLatest(current: BoardPage, latest: BoardPage): BoardPage {
  const cutoff = latest.messages[0]?.id;
  const older = cutoff
    ? current.messages.filter((message) => BigInt(message.id) < BigInt(cutoff))
    : current.messages;
  const byId = new Map(
    [...older, ...latest.messages].map((message) => [message.id, message]),
  );
  return {
    board: latest.board,
    messages: [...byId.values()].sort((left, right) =>
      BigInt(left.id) < BigInt(right.id)
        ? -1
        : BigInt(left.id) > BigInt(right.id) ? 1 : 0,
    ),
    nextBefore: current.nextBefore ?? latest.nextBefore,
  };
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
