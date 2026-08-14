import { useEffect, useMemo, useState } from "react";
import type { BoardSummary } from "@asterism/shared";
import { ApiRequestError, listBoards, logout } from "../api.js";

export function HomeScreen({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBoards()
      .then(setBoards)
      .catch((requestError: unknown) => {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          onUnauthorized();
        } else {
          setError("画布列表加载失败。");
        }
      })
      .finally(() => setLoading(false));
  }, [onUnauthorized]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const visible = boards.filter((board) =>
      board.channelName.toLocaleLowerCase().includes(needle),
    );
    const grouped = new Map<string, BoardSummary[]>();
    for (const board of visible) {
      const category = board.categoryName ?? "未分类";
      grouped.set(category, [...(grouped.get(category) ?? []), board]);
    }
    return grouped;
  }, [boards, filter]);

  const signOut = async () => {
    await logout();
    onUnauthorized();
  };

  return (
    <main className="home-shell">
      <header className="topbar">
        <a href="/" className="brand"><span>✦</span> Asterism</a>
        <button className="ghost-button" onClick={() => void signOut()}>退出</button>
      </header>
      <section className="home-content">
        <div className="home-heading">
          <div><p className="eyebrow">PUZZLE HUNT</p><h1>队伍白板</h1></div>
          <input
            className="board-filter"
            type="search"
            placeholder="筛选频道…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="筛选频道"
          />
        </div>
        {loading && <p className="muted">正在加载…</p>}
        {error && <p className="form-error">{error}</p>}
        {!loading && boards.length === 0 && (
          <div className="empty-state">
            <h2>还没有白板</h2>
            <p>在 Discord 文字频道中执行 <code>/board</code> 创建第一张。</p>
          </div>
        )}
        {[...groups.entries()].map(([category, categoryBoards]) => (
          <section className="board-group" key={category}>
            <h2>{category}</h2>
            <div className="board-grid">
              {categoryBoards.map((board) => (
                <a className="board-card" href={`/boards/${board.id}`} key={board.id}>
                  <div className="channel-icon">#</div>
                  <div>
                    <h3>{board.channelName}</h3>
                    <p>{board.messageCount} 条消息 · {relativeTime(board.lastActivityAt)}</p>
                  </div>
                  <span className="card-arrow">→</span>
                </a>
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}

function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "刚刚活跃";
  if (minutes < 60) return `${minutes} 分钟前活跃`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前活跃`;
  return `${Math.floor(hours / 24)} 天前活跃`;
}
