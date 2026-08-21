import { lazy, Suspense, useEffect, useState } from "react";
import type {
  HuntRecord,
  HuntOverview,
  PuzzleStatus,
  ExtractionTableRecord,
} from "@asterism/shared";
import {
  ApiRequestError,
  listHunts,
  getHuntOverview,
  updatePuzzle,
  logout,
  getExtractionTable,
  createExtractionTable,
} from "../api.js";

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

export function HuntScreen({
  huntId: initialHuntId,
  onUnauthorized,
}: {
  huntId?: string;
  onUnauthorized: () => void;
}) {
  const [hunts, setHunts] = useState<HuntRecord[]>([]);
  const [overview, setOverview] = useState<HuntOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategoryTable, setActiveCategoryTable] = useState<{
    id: string;
    name: string;
    record: ExtractionTableRecord;
  } | null>(null);
  const [tableModalLoading, setTableModalLoading] = useState(false);

  useEffect(() => {
    listHunts()
      .then(setHunts)
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 401) {
          onUnauthorized();
        } else {
          setError("基础数据加载失败。");
        }
      })
      .finally(() => {
        if (!initialHuntId) setLoading(false);
      });
  }, [onUnauthorized, initialHuntId]);

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

  const handleOpenCategoryTable = async (categoryId: string, categoryName: string) => {
    setTableModalLoading(true);
    try {
      let record = await getExtractionTable("category", categoryId);
      if (!record) {
        record = await createExtractionTable("category", categoryId);
      }
      setActiveCategoryTable({ id: categoryId, name: categoryName, record });
    } catch (err) {
      console.error("Failed to open category extraction table:", err);
    } finally {
      setTableModalLoading(false);
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
              <option value="">选择 Hunt (Server)...</option>
              {hunts.map(h => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>
        </div>

        {loading && <p className="muted">正在加载…</p>}
        {error && <p className="form-error">{error}</p>}

        {overview ? (
          <div className="hunt-overview">
            <div className="overview-header">
              <h1>{overview.hunt.name}</h1>
            </div>

            {overview.categories.map(({ category, puzzles }) => (
              <section key={category ? category.id : "unassigned"} className="round-section">
                <div className="round-header">
                  <h2>{category ? category.name : "无分组"}</h2>
                  {category && (
                    <div className="round-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => handleOpenCategoryTable(category.id, category.name)}
                      >
                        📊 大题提取表
                      </button>
                    </div>
                  )}
                </div>
                
                {puzzles.length > 0 ? (
                  <table className="puzzle-table">
                    <thead>
                      <tr>
                        <th className="col-title">题目</th>
                        <th className="col-status">状态</th>
                        <th className="col-answer">答案</th>
                        <th className="col-board">白板</th>
                        <th className="col-notes">备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {puzzles.map(puzzle => (
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
                            {puzzle.boardId ? (
                              <a href={`/puzzles/${puzzle.id}`} className="board-link" target="_blank" rel="noreferrer">进入白板 ↗</a>
                            ) : (
                              <span className="muted">(未创建白板)</span>
                            )}
                          </td>
                          <td>
                            <textarea
                              rows={1}
                              defaultValue={puzzle.notes}
                              onBlur={(e) => e.target.value !== puzzle.notes && handleUpdatePuzzle(puzzle.id, { notes: e.target.value })}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted" style={{ padding: '1rem' }}>该分组下无小题。</p>
                )}
              </section>
            ))}
          </div>
        ) : (
          !loading && <div className="empty-state">请选择一个 Hunt。</div>
        )}

        {(activeCategoryTable || tableModalLoading) && (
          <div className="modal-overlay" onClick={() => setActiveCategoryTable(null)}>
            <div
              className="modal-card category-table-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="modal-header">
                <h2>{activeCategoryTable ? `${activeCategoryTable.name} — 大题提取表` : "加载提取表中…"}</h2>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setActiveCategoryTable(null)}
                >
                  ✕ 关闭
                </button>
              </div>

              <div className="modal-body">
                {tableModalLoading ? (
                  <p className="muted">正在加载…</p>
                ) : activeCategoryTable ? (
                  <Suspense fallback={<p className="muted">正在加载电子表格…</p>}>
                    <UniverSheet key={activeCategoryTable.record.id} tableRecord={activeCategoryTable.record} />
                  </Suspense>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
