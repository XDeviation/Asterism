import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiRequestError, getSession, getPuzzleIdByBoard } from "./api.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import "./styles.css";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "/";

const BoardScreen = lazy(async () => ({
  default: (await import("./screens/BoardScreen.js")).BoardScreen,
}));

const HuntScreen = lazy(async () => ({
  default: (await import("./screens/HuntScreen.js")).HuntScreen,
}));

const PuzzleScreen = lazy(async () => ({
  default: (await import("./screens/PuzzleScreen.js")).PuzzleScreen,
}));

function BoardRoute({ boardId, onUnauthorized }: { boardId: string; onUnauthorized: () => void }) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPuzzleIdByBoard(boardId)
      .then((puzzleId) => {
        if (puzzleId) {
          window.location.replace(`/puzzles/${puzzleId}`);
        } else {
          setLoading(false);
        }
      })
      .catch((error) => {
        if (error instanceof ApiRequestError && error.status === 401) {
          onUnauthorized();
        } else {
          setLoading(false);
        }
      });
  }, [boardId, onUnauthorized]);

  if (loading) return <div className="loading">正在加载…</div>;

  return (
    <Suspense fallback={<div className="loading">正在加载画布组件…</div>}>
      <BoardScreen boardId={boardId} onUnauthorized={onUnauthorized} />
    </Suspense>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    getSession()
      .then(setAuthenticated)
      .catch((error: unknown) => {
        setFatalError(error instanceof Error ? error.message : "无法连接服务器");
      });
  }, []);

  if (fatalError) {
    return <main className="center-card"><h1>连接失败</h1><p>{fatalError}</p></main>;
  }
  if (authenticated === null) return <div className="loading">正在连接…</div>;
  if (!authenticated) return <LoginScreen onAuthenticated={() => setAuthenticated(true)} />;

  const boardMatch = /^\/boards\/([^/]+)$/.exec(window.location.pathname);
  if (boardMatch?.[1]) {
    return (
      <BoardRoute
        boardId={decodeURIComponent(boardMatch[1])}
        onUnauthorized={() => setAuthenticated(false)}
      />
    );
  }
  const puzzleMatch = /^\/puzzles\/([^/]+)$/.exec(window.location.pathname);
  if (puzzleMatch?.[1]) {
    return (
      <Suspense fallback={<div className="loading">正在加载题目白板组件…</div>}>
        <PuzzleScreen
          puzzleId={decodeURIComponent(puzzleMatch[1])}
          onUnauthorized={() => setAuthenticated(false)}
        />
      </Suspense>
    );
  }
  const huntMatch = /^\/hunts(?:\/([^/]+))?$/.exec(window.location.pathname);
  if (huntMatch) {
    return (
      <Suspense fallback={<div className="loading">正在加载 Hunt 看板…</div>}>
        <HuntScreen
          {...(huntMatch[1] ? { huntId: decodeURIComponent(huntMatch[1]) } : {})}
          onUnauthorized={() => setAuthenticated(false)}
        />
      </Suspense>
    );
  }
  return <HomeScreen onUnauthorized={() => setAuthenticated(false)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
