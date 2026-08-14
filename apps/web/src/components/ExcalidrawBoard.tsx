import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDocument, CanvasScene, CanvasSnapshot } from "@asterism/shared";
import {
  CaptureUpdateAction,
  Excalidraw,
  getSceneVersion,
  newElementWith,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type {
  AppState,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/excalidraw/element/types";
import { io, type Socket } from "socket.io-client";
import {
  ApiRequestError,
  getCanvasFile,
  saveCanvas,
  saveCanvasFile,
} from "../api.js";

type SyncStatus = "connecting" | "saved" | "saving" | "error";
type SceneMessageType = "SCENE_INIT" | "SCENE_UPDATE";

interface LocalScene {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}

interface SceneMessage {
  type: SceneMessageType;
  payload: { elements: ExcalidrawElement[] };
}

interface PointerMessage {
  type: "MOUSE_LOCATION";
  payload: {
    socketId: string;
    pointer: NonNullable<Collaborator["pointer"]>;
    button: "up" | "down";
    selectedElementIds: AppState["selectedElementIds"];
    username: string;
  };
}

type RoomMessage = SceneMessage | PointerMessage;

function asInitialData(snapshot: CanvasDocument): ExcalidrawInitialDataState {
  return {
    elements: snapshot.scene.elements as ExcalidrawElement[],
    appState: snapshot.scene.appState as Partial<AppState>,
    files: snapshot.scene.files as unknown as BinaryFiles,
    scrollToContent: true,
  };
}

function sharedAppState(appState: Partial<AppState>): Record<string, unknown> {
  return {
    viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
    gridSize: appState.gridSize ?? 20,
    gridStep: appState.gridStep ?? 5,
    gridModeEnabled: appState.gridModeEnabled ?? false,
  };
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
  message: RoomMessage,
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
): Promise<RoomMessage> {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    await cryptoKey(roomKey, "decrypt"),
    encrypted,
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as RoomMessage;
}

function imageFileIds(elements: readonly ExcalidrawElement[]): string[] {
  return elements.flatMap((element) => {
    if (element.type !== "image") return [];
    const fileId = (element as ExcalidrawElement & { fileId?: string | null }).fileId;
    return fileId ? [fileId] : [];
  });
}

function markSavedImageElements(
  elements: readonly OrderedExcalidrawElement[],
  savedFileIds: ReadonlySet<string>,
): readonly OrderedExcalidrawElement[] {
  let changed = false;
  const updated = elements.map((element) => {
    if (
      element.type === "image" &&
      element.fileId &&
      element.status !== "saved" &&
      savedFileIds.has(element.fileId)
    ) {
      changed = true;
      return newElementWith(element, { status: "saved" });
    }
    return element;
  });
  return changed ? updated : elements;
}

export function ExcalidrawBoard({
  boardId,
  initialCanvas,
  legacyIncoming,
  onUnauthorized,
}: {
  boardId: string;
  initialCanvas: CanvasDocument;
  legacyIncoming: { snapshot: CanvasSnapshot; sequence: number } | null;
  onUnauthorized: () => void;
}) {
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [apiReady, setApiReady] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const latestScene = useRef<LocalScene | null>(null);
  const revision = useRef(initialCanvas.revision);
  const lastRoomSceneVersion = useRef(-1);
  const broadcastedVersions = useRef(new Map<string, number>());
  const knownServerFiles = useRef(new Set(Object.keys(initialCanvas.scene.files)));
  const fetchingImageFiles = useRef(new Set<string>());
  const pendingImageRetries = useRef(new Set<string>());
  const collaborators = useRef(new Map<SocketId, Collaborator>());
  const dirty = useRef(false);
  const saving = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const fullSyncTimer = useRef<number | null>(null);
  const imageRetryTimers = useRef(new Set<number>());
  const broadcastQueue = useRef(Promise.resolve());
  const flushSaveRef = useRef<() => Promise<void>>(async () => {});
  const lastPointerSentAt = useRef(0);
  const mounted = useRef(true);

  const initialData = useMemo(async (): Promise<ExcalidrawInitialDataState> => {
    const data = asInitialData(initialCanvas);
    const fileIds = [...new Set(imageFileIds(
      initialCanvas.scene.elements as ExcalidrawElement[],
    ))];
    if (fileIds.length === 0) return data;

    const results = await Promise.all(fileIds.map(async (fileId) => {
      try {
        const file = await getCanvasFile(boardId, fileId) as BinaryFiles[keyof BinaryFiles];
        return file;
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) onUnauthorized();
        return null;
      }
    }));
    const files: BinaryFiles = { ...(data.files ?? {}) };
    for (const file of results) {
      if (!file) continue;
      files[file.id] = file;
      knownServerFiles.current.add(file.id);
    }
    return { ...data, files };
  }, [boardId, initialCanvas, onUnauthorized]);
  const { roomId, roomKey } = initialCanvas.collaboration;

  const clearTimers = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    if (fullSyncTimer.current !== null) window.clearInterval(fullSyncTimer.current);
    for (const timer of imageRetryTimers.current) window.clearTimeout(timer);
    imageRetryTimers.current.clear();
    fetchingImageFiles.current.clear();
    pendingImageRetries.current.clear();
    saveTimer.current = null;
    retryTimer.current = null;
    fullSyncTimer.current = null;
  }, []);

  const sendEncrypted = useCallback((
    message: RoomMessage,
    volatile = false,
  ) => {
    broadcastQueue.current = broadcastQueue.current.then(async () => {
      const socket = socketRef.current;
      if (!socket?.connected) return;
      const { encrypted, iv } = await encryptRoomMessage(roomKey, message);
      socket.emit(
        volatile ? "server-volatile-broadcast" : "server-broadcast",
        roomId,
        encrypted,
        iv,
      );
    }).catch(() => {
      if (mounted.current) setStatus("error");
    });
  }, [roomId, roomKey]);

  const broadcastScene = useCallback((
    type: SceneMessageType,
    elements: readonly OrderedExcalidrawElement[],
    syncAll: boolean,
  ) => {
    const changed = elements.filter((element) => {
      const previous = broadcastedVersions.current.get(element.id);
      return syncAll || previous === undefined || element.version > previous;
    });
    if (changed.length === 0) return;
    for (const element of changed) {
      broadcastedVersions.current.set(element.id, element.version);
    }
    sendEncrypted({
      type,
      payload: { elements: changed as ExcalidrawElement[] },
    });
  }, [sendEncrypted]);

  const loadMissingImages = useCallback(async (
    elements: readonly ExcalidrawElement[],
    attempt = 0,
  ) => {
    const api = apiRef.current;
    if (!api) return;
    const missing = [...new Set(imageFileIds(elements))].filter((fileId) => (
      !api.getFiles()[fileId] &&
      !fetchingImageFiles.current.has(fileId) &&
      !pendingImageRetries.current.has(fileId)
    ));
    if (missing.length === 0) return;
    for (const fileId of missing) fetchingImageFiles.current.add(fileId);

    const results = await Promise.all(missing.map(async (fileId) => {
      try {
        const file = await getCanvasFile(boardId, fileId) as BinaryFiles[keyof BinaryFiles];
        return { fileId, file };
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 401) onUnauthorized();
        return { fileId, file: null };
      } finally {
        fetchingImageFiles.current.delete(fileId);
      }
    }));

    const found = results.flatMap(({ file }) => file ? [file] : []);
    if (found.length > 0 && apiRef.current === api) {
      api.addFiles(found);
      for (const file of found) knownServerFiles.current.add(file.id);
      const currentElements = api.getSceneElementsIncludingDeleted() as
        readonly OrderedExcalidrawElement[];
      const savedElements = markSavedImageElements(
        currentElements,
        new Set(found.map((file) => file.id)),
      );
      if (savedElements !== currentElements) {
        const appState = api.getAppState();
        lastRoomSceneVersion.current = Math.max(
          lastRoomSceneVersion.current,
          getSceneVersion(savedElements),
        );
        latestScene.current = { elements: savedElements, appState, files: api.getFiles() };
        api.updateScene({
          elements: savedElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        broadcastScene("SCENE_UPDATE", savedElements, false);
        dirty.current = true;
        if (mounted.current) setStatus("saving");
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          void flushSaveRef.current();
        }, 750);
      }
    }
    if (attempt < 5) {
      for (const { fileId, file } of results) {
        if (file) continue;
        pendingImageRetries.current.add(fileId);
        const timer = window.setTimeout(() => {
          imageRetryTimers.current.delete(timer);
          pendingImageRetries.current.delete(fileId);
          void loadMissingImages(elements, attempt + 1);
        }, 750 * (attempt + 1));
        imageRetryTimers.current.add(timer);
      }
    }
  }, [boardId, broadcastScene, onUnauthorized]);

  const flushSave = useCallback(async () => {
    if (saving.current || !dirty.current || !latestScene.current) return;
    const captured = latestScene.current;
    const newFiles = Object.fromEntries(
      Object.entries(captured.files).filter(([fileId]) => !knownServerFiles.current.has(fileId)),
    );
    let elementsToSave = captured.elements;
    dirty.current = false;
    saving.current = true;
    if (mounted.current) setStatus("saving");
    try {
      await Promise.all(Object.entries(newFiles).map(async ([fileId, file]) => {
        await saveCanvasFile(boardId, fileId, file);
        knownServerFiles.current.add(fileId);
      }));
      if (Object.keys(newFiles).length > 0) {
        const api = apiRef.current;
        const currentElements = (api?.getSceneElementsIncludingDeleted() ?? captured.elements) as
          readonly OrderedExcalidrawElement[];
        const savedElements = markSavedImageElements(
          currentElements,
          new Set(Object.keys(newFiles)),
        );
        if (savedElements !== currentElements && api) {
          const appState = api.getAppState();
          lastRoomSceneVersion.current = Math.max(
            lastRoomSceneVersion.current,
            getSceneVersion(savedElements),
          );
          latestScene.current = { elements: savedElements, appState, files: api.getFiles() };
          api.updateScene({
            elements: savedElements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          broadcastScene("SCENE_UPDATE", savedElements, false);
        }
        elementsToSave = savedElements;
      }
      const scene: CanvasScene = {
        elements: [...elementsToSave] as unknown[],
        appState: sharedAppState(captured.appState),
        files: {},
      };
      const response = await saveCanvas(
        boardId,
        revision.current,
        socketRef.current?.id ?? "offline",
        scene,
      );
      revision.current = Math.max(revision.current, response.revision);
      if (mounted.current) setStatus(dirty.current ? "saving" : "saved");
    } catch (error) {
      dirty.current = true;
      if (error instanceof ApiRequestError && error.status === 401) {
        onUnauthorized();
        return;
      }
      if (mounted.current) setStatus("error");
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null;
        void flushSave();
      }, 2_000);
    } finally {
      saving.current = false;
      if (dirty.current && retryTimer.current === null) {
        saveTimer.current = window.setTimeout(() => void flushSave(), 500);
      }
    }
  }, [boardId, broadcastScene, onUnauthorized]);

  flushSaveRef.current = flushSave;

  const scheduleSave = useCallback(() => {
    dirty.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flushSave();
    }, 750);
  }, [flushSave]);

  const applyRemoteElements = useCallback((remote: ExcalidrawElement[]) => {
    const api = apiRef.current;
    if (!api) return null;
    const local = api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[];
    const restored = restoreElements(remote, local);
    const elements = reconcileElements(
      local,
      restored as unknown as Parameters<typeof reconcileElements>[1],
      api.getAppState(),
    );
    lastRoomSceneVersion.current = Math.max(
      lastRoomSceneVersion.current,
      getSceneVersion(elements),
    );
    latestScene.current = {
      elements,
      appState: api.getAppState(),
      files: api.getFiles(),
    };
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    void loadMissingImages(elements);
    return elements;
  }, [loadMissingImages]);

  useEffect(() => {
    if (!apiReady || !legacyIncoming) return;
    const files = legacyIncoming.snapshot.scene.files as unknown as BinaryFiles;
    if (Object.keys(files).length > 0) {
      apiRef.current?.addFiles(Object.values(files));
      for (const fileId of Object.keys(files)) knownServerFiles.current.add(fileId);
    }
    const elements = applyRemoteElements(
      legacyIncoming.snapshot.scene.elements as ExcalidrawElement[],
    );
    if (elements) broadcastScene("SCENE_UPDATE", elements, true);
    revision.current = Math.max(revision.current, legacyIncoming.snapshot.revision);
  }, [
    apiReady,
    applyRemoteElements,
    broadcastScene,
    legacyIncoming,
    legacyIncoming?.sequence,
  ]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  useEffect(() => {
    const api = apiRef.current;
    if (!apiReady || !api) return;
    const elements = api.getSceneElementsIncludingDeleted() as readonly ExcalidrawElement[];
    void loadMissingImages(elements);
  }, [apiReady, loadMissingImages]);

  useEffect(() => {
    const api = apiRef.current;
    if (!apiReady || !api) return;
    const socket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      if (mounted.current) setStatus(dirty.current ? "saving" : "saved");
    });
    socket.on("connect_error", () => {
      if (mounted.current) setStatus("error");
    });
    socket.on("init-room", () => socket.emit("join-room", roomId));
    socket.on("first-in-room", () => {
      const elements = api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[];
      broadcastScene("SCENE_INIT", elements, true);
    });
    socket.on("new-user", () => {
      const elements = api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[];
      broadcastScene("SCENE_INIT", elements, true);
    });
    socket.on("room-user-change", (socketIds: string[]) => {
      const next = new Map<SocketId, Collaborator>();
      for (const id of socketIds) {
        const socketId = id as SocketId;
        next.set(socketId, {
          ...(collaborators.current.get(socketId) ?? {}),
          socketId,
          isCurrentUser: id === socket.id,
        });
      }
      collaborators.current = next;
      api.updateScene({ collaborators: next });
    });
    socket.on("client-broadcast", async (encrypted: ArrayBuffer, iv: Uint8Array) => {
      try {
        const message = await decryptRoomMessage(roomKey, encrypted, iv);
        if (message.type === "SCENE_INIT" || message.type === "SCENE_UPDATE") {
          applyRemoteElements(message.payload.elements);
          return;
        }
        if (message.type === "MOUSE_LOCATION") {
          const socketId = message.payload.socketId as SocketId;
          const next = new Map(collaborators.current);
          next.set(socketId, {
            ...(next.get(socketId) ?? {}),
            socketId,
            pointer: message.payload.pointer,
            button: message.payload.button,
            selectedElementIds: message.payload.selectedElementIds,
            username: message.payload.username,
          });
          collaborators.current = next;
          api.updateScene({ collaborators: next });
        }
      } catch {
        // A client without the room key cannot affect the local scene.
      }
    });

    fullSyncTimer.current = window.setInterval(() => {
      const elements = api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[];
      broadcastScene("SCENE_UPDATE", elements, true);
    }, 20_000);

    return () => {
      socket.removeAllListeners();
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
      if (fullSyncTimer.current !== null) window.clearInterval(fullSyncTimer.current);
      fullSyncTimer.current = null;
    };
  }, [apiReady, applyRemoteElements, broadcastScene, roomId, roomKey]);

  const handleChange = useCallback((
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    latestScene.current = { elements, appState, files };
    void loadMissingImages(elements);
    const version = getSceneVersion(elements);
    if (version <= lastRoomSceneVersion.current) return;
    lastRoomSceneVersion.current = version;
    broadcastScene("SCENE_UPDATE", elements, false);
    if (mounted.current) setStatus("saving");
    scheduleSave();
  }, [broadcastScene, loadMissingImages, scheduleSave]);

  const handlePointerUpdate = useCallback((payload: {
    pointer: NonNullable<Collaborator["pointer"]>;
    button: "down" | "up";
  }) => {
    const socket = socketRef.current;
    const now = performance.now();
    if (!socket?.id || now - lastPointerSentAt.current < 33) return;
    lastPointerSentAt.current = now;
    sendEncrypted({
      type: "MOUSE_LOCATION",
      payload: {
        socketId: socket.id,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: apiRef.current?.getAppState().selectedElementIds ?? {},
        username: "队友",
      },
    }, true);
  }, [sendEncrypted]);

  return (
    <div className="excalidraw-board">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          const elements = api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[];
          latestScene.current = {
            elements,
            appState: api.getAppState(),
            files: api.getFiles(),
          };
          lastRoomSceneVersion.current = getSceneVersion(elements);
          setApiReady(true);
          void loadMissingImages(elements);
        }}
        onChange={handleChange}
        onPointerUpdate={handlePointerUpdate}
        isCollaborating
        langCode="zh-CN"
        name="Asterism"
      />
      <div className={`canvas-sync-status ${status}`} aria-live="polite">
        {status === "saved"
          ? "已连接"
          : status === "connecting"
            ? "正在连接协作…"
            : status === "saving"
              ? "正在保存…"
              : "协作连接异常，正在重试…"}
      </div>
    </div>
  );
}
