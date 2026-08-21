import { useEffect, useState } from "react";
import type {
  HuntRecord,
  HuntOverview,
  PuzzleRecord,
  PuzzleStatus,
  BoardSummary,
} from "@asterism/shared";
import {
  ApiRequestError,
  listHunts,
  createHunt,
  getHuntOverview,
  deleteHunt,
  createRound,
  deleteRound,
  renameRound,
  createPuzzle,
  updatePuzzle,
  deletePuzzle,
  listBoards,
  logout,
} from "../api.js";

const STATUS_LABELS: Record<PuzzleStatus, string> = {
  new: "新题",
  in_progress: "进行中",
  stuck: "卡住",
  solved: "已解出",
};

export function HuntScreen({
  huntId: initialHuntId,
  onUnauthorized,
}: {
  huntId?: string;
  onUnauthorized: () => void;
}) {
  const [hunts, setHunts] = useState<HuntRecord[]>([]);
  const [overview, setOverview] = useState<HuntOverview | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listHunts(), listBoards()])
      .then(([huntsList, boardsList]) => {
        setHunts(huntsList);
        setBoards(boardsList);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 401) {
          onUnauthorized();
        } else {
          setError("基础数据加载失败。");
        }
      })
      .finally(() => setLoading(false));
  }, [onUnauthorized]);

  useEffect(() => {
    if (initialHuntId) {
      setLoading(true);
      getHuntOverview(initialHuntId)
        .then(setOverview)
        .catch((err: unknown) => {
          if (err instanceof ApiRequestError && err.status === 401) {
            onUnauthorized();
          } else {
            setError("Hunt 详情加载失败。");
          }
        })
        .finally(() => setLoading(false));
    } else {
      setOverview(null);
    }
  }, [initialHuntId, onUnauthorized]);

  const handleCreateHunt = async () => {
    const name = prompt("请输入 Hunt 名称：");
    if (!name) return;
    try {
      const hunt = await createHunt(name);
      setHunts([hunt, ...hunts]);
      window.location.href = `/hunts/${hunt.id}`;
    } catch (err) {
      alert("创建失败。");
    }
  };

  const handleDeleteHunt = async (id: string) => {
    if (!confirm("确定删除整个 Hunt 吗？")) return;
    try {
      await deleteHunt(id);
      setHunts(hunts.filter((h) => h.id !== id));
      if (initialHuntId === id) window.location.href = "/hunts";
    } catch (err) {
      alert("删除失败。");
    }
  };

  const handleCreateRound = async () => {
    if (!initialHuntId) return;
    const name = prompt("请输入 Round 名称：");
    if (!name) return;
    try {
      await createRound(initialHuntId, name);
      const updated = await getHuntOverview(initialHuntId);
      setOverview(updated);
    } catch (err) {
      alert("创建 Round 失败。");
    }
  };

  const handleDeleteRound = async (roundId: string) => {
    if (!confirm("确定删除该 Round 吗？")) return;
    try {
      await deleteRound(roundId);
      if (initialHuntId) {
        const updated = await getHuntOverview(initialHuntId);
        setOverview(updated);
      }
    } catch (err) {
      alert("删除 Round 失败。");
    }
  };

  const handleCreatePuzzle = async (roundId: string) => {
    const title = prompt("请输入题目名称：");
    if (!title) return;
    try {
      await createPuzzle(roundId, title);
      if (initialHuntId) {
        const updated = await getHuntOverview(initialHuntId);
        setOverview(updated);
      }
    } catch (err) {
      alert("创建题目失败。");
    }
  };

  const handleUpdatePuzzle = async (puzzleId: string, updates: Parameters<typeof updatePuzzle>[1]) => {
    try {
      await updatePuzzle(puzzleId, updates);
      if (initialHuntId) {
        const updated = await getHuntOverview(initialHuntId);
        setOverview(updated);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeletePuzzle = async (puzzleId: string) => {
    if (!confirm("确定删除该题目吗？")) return;
    try {
      await deletePuzzle(puzzleId);
      if (initialHuntId) {
        const updated = await getHuntOverview(initialHuntId);
        setOverview(updated);
      }
    } catch (err) {
      alert("删除题目失败。");
    }
  };

  const signOut = async () => {
    await logout();
    onUnauthorized();
  };

  return (
    <main className="hunt-shell">
      <header className="topbar">
        <div className="brand-group">
          <a href="/" className="brand"><span>✦</span> Asterism</a>
          <span className="separator">/</span>
          <a href="/hunts" className="nav-link">Hunt 看板</a>
        </div>
        <button className="ghost-button" onClick={() => void signOut()}>退出</button>
      </header>

      <section className="hunt-content">
        <div className="hunt-header">
          <div className="hunt-selector">
            <select
              value={initialHuntId ?? ""}
              onChange={(e) => window.location.href = e.target.value ? `/hunts/${e.target.value}` : "/hunts"}
            >
              <option value="">选择 Hunt...</option>
              {hunts.map(h => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
            <button className="ghost-button" onClick={handleCreateHunt}>新建 Hunt</button>
          </div>
          {overview && (
            <button className="danger-button" onClick={() => handleDeleteHunt(overview.hunt.id)}>删除 Hunt</button>
          )}
        </div>

        {loading && <p className="muted">正在加载…</p>}
        {error && <p className="form-error">{error}</p>}

        {overview ? (
          <div className="hunt-overview">
            <div className="overview-header">
              <h1>{overview.hunt.name}</h1>
              <button className="ghost-button" onClick={handleCreateRound}>+ 新建 Round</button>
            </div>

            {overview.rounds.map(round => (
              <section key={round.id} className="round-section">
                <div className="round-header">
                  <h2>{round.name}</h2>
                  <div className="round-actions">
                    <button className="icon-button" onClick={() => {
                      const name = prompt("重命名 Round：", round.name);
                      if (name) renameRound(round.id, name).then(() => { if (initialHuntId) return getHuntOverview(initialHuntId).then(setOverview); });
                    }}>✎</button>
                    <button className="icon-button" onClick={() => handleDeleteRound(round.id)}>✕</button>
                  </div>
                </div>
                
                <table className="puzzle-table">
                  <thead>
                    <tr>
                      <th className="col-title">题目</th>
                      <th className="col-status">状态</th>
                      <th className="col-answer">答案</th>
                      <th className="col-board">白板</th>
                      <th className="col-notes">备注</th>
                      <th className="col-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {round.puzzles.map(puzzle => (
                      <tr key={puzzle.id} className={`puzzle-row status-${puzzle.status}`}>
                        <td>
                          <input
                            type="text"
                            defaultValue={puzzle.title}
                            onBlur={(e) => e.target.value !== puzzle.title && handleUpdatePuzzle(puzzle.id, { title: e.target.value })}
                          />
                        </td>
                        <td>
                          <select
                            value={puzzle.status}
                            onChange={(e) => handleUpdatePuzzle(puzzle.id, { status: e.target.value as PuzzleStatus })}
                          >
                            {(Object.keys(STATUS_LABELS) as PuzzleStatus[]).map(s => (
                              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="ANSWER"
                            defaultValue={puzzle.answer ?? ""}
                            onBlur={(e) => e.target.value !== (puzzle.answer ?? "") && handleUpdatePuzzle(puzzle.id, { answer: e.target.value || null })}
                          />
                        </td>
                        <td>
                          <select
                            value={puzzle.boardId ?? ""}
                            onChange={(e) => handleUpdatePuzzle(puzzle.id, { boardId: e.target.value || null })}
                          >
                            <option value="">(无)</option>
                            {boards.map(b => (
                              <option key={b.id} value={b.id}>{b.channelName}</option>
                            ))}
                          </select>
                          {puzzle.boardId && (
                            <a href={`/boards/${puzzle.boardId}`} className="board-link" target="_blank" rel="noreferrer">↗</a>
                          )}
                        </td>
                        <td>
                          <textarea
                            rows={1}
                            defaultValue={puzzle.notes}
                            onBlur={(e) => e.target.value !== puzzle.notes && handleUpdatePuzzle(puzzle.id, { notes: e.target.value })}
                          />
                        </td>
                        <td>
                          <button className="icon-button danger" onClick={() => handleDeletePuzzle(puzzle.id)}>✕</button>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={6}>
                        <button className="add-puzzle-button" onClick={() => handleCreatePuzzle(round.id)}>+ 新建题目</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        ) : (
          !loading && <div className="empty-state">请选择或新建一个 Hunt。</div>
        )}
      </section>
    </main>
  );
}
