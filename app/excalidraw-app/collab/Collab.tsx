import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, cloneJSON, EVENT, toBrandedType } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
  type ResolvablePromise,
} from "@excalidraw/common";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import { bumpElementVersions } from "@excalidraw/excalidraw/data/restore";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
  UserToFollow,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
  ROOM_SNAPSHOT_INTERVAL_MS,
  WS_EVENTS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import {
  isSavedToServer,
  loadRoomFromServer,
  registerRoom,
  saveRoomToServer,
} from "../data/rooms";
import { resetBrowserStateVersions } from "../data/tabSync";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);
// Set when a room join finds no server (offline boot): the canvas keeps
// local-only work and local persistence resumes. Silent — no banner.
// Cleared on the first successful server contact.
export const offlineRoomPendingAtom = atom<{
  roomId: string;
  roomKey: string;
} | null>(null);

// Crash-safety: single-slot per-device backup of the last-touched room,
// written on every edit (throttled) and restored on boot when the room
// matches. One slot bounds localStorage use; a crash always reloads the
// same URL, so the last room is the one that matters.
const ROOM_BACKUP_KEY = "excalidraw-room-backup";

type RoomBackup = {
  roomId: string;
  elements: readonly SyncableExcalidrawElement[];
  updatedAt: number;
};

const readRoomBackup = (
  roomId: string,
): readonly SyncableExcalidrawElement[] | null => {
  try {
    const raw = localStorage.getItem(ROOM_BACKUP_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<RoomBackup>;
    if (parsed?.roomId !== roomId || !Array.isArray(parsed.elements)) {
      return null;
    }
    return parsed.elements as readonly SyncableExcalidrawElement[];
  } catch {
    return null;
  }
};

// Union by id, last-writer-wins per element (higher version wins, ties go
// to the local backup which holds the unsynced crash/offline strokes).
const mergeBackupWithServer = (
  backup: readonly SyncableExcalidrawElement[],
  server: readonly SyncableExcalidrawElement[],
): SyncableExcalidrawElement[] => {
  const byId = new Map<
    string,
    SyncableExcalidrawElement & { version: number }
  >();
  for (const el of server as (SyncableExcalidrawElement & {
    version: number;
  })[]) {
    byId.set(el.id, el);
  }
  for (const el of backup as (SyncableExcalidrawElement & {
    version: number;
  })[]) {
    const prev = byId.get(el.id);
    if (!prev || (el.version ?? 0) >= (prev.version ?? 0)) {
      byId.set(el.id, el);
    }
  }
  return [...byId.values()];
};

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);
export const userToFollowAtom = atom<UserToFollow | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
  setUserToFollow: CollabInstance["setUserToFollow"];
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  // True while the initial scene promise is already spent (empty) but an
  // offline canvas may still receive its scene late: late arrivals must
  // paint directly instead of relying on resolve(). Set on offline entry,
  // cleared on the first successful load/save/stop.
  private offlineRecoveryPending = false;
  // Scene load shared with a second startCollaboration() racing the first
  // (double-mount/double-effect on boot): while set, a newcomer to the SAME
  // room awaits it instead of resolving null instantly and winning the race
  // with a permanently empty canvas (incident 2026-09-11).
  // NOTE: the room is captured separately because portal.roomId is only set
  // later inside portal.open() — the race happens earlier, while the shared
  // socket.io import is still loading.
  private pendingScenePromise: ResolvablePromise<
    | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
    | null
  > | null = null;
  private pendingSceneRoomId: string | null = null;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();
  /** the socket ids of the users following the current user */
  private followedBy = new Set<SocketId>();

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  private onUmmount: (() => void) | null = null;

  private offlineRetryTimer?: number;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusToggle);
    window.addEventListener("offline", this.onOfflineStatusToggle);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);
    // Silent reconnect: navigator.onLine events are unreliable (WebView,
    // tailnet drops where the OS still reports "online"), so poll while a
    // room is pending plus retry when the app becomes visible again.
    this.offlineRetryTimer = window.setInterval(() => {
      if (appJotaiStore.get(offlineRoomPendingAtom)) {
        this.retryOfflineJoin();
      }
    }, 4000);
    document.addEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityRetry,
    );
    window.addEventListener("focus", this.onVisibilityRetry);

    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.setUserToFollow(
        payload.action === "FOLLOW" ? payload.userToFollow : null,
      );
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();

    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
      setUserToFollow: this.setUserToFollow,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  onOfflineStatusToggle = () => {
    const wasOffline = appJotaiStore.get(isOfflineAtom);
    const online = window.navigator.onLine;
    appJotaiStore.set(isOfflineAtom, !online);
    // Coming back online with a room pending (entered offline mode with no
    // usable socket): retry the join so local work merges and syncs without
    // any manual reopen. No-op when already healthy.
    if (online && wasOffline) {
      this.retryOfflineJoin();
    }
  };

  private offlineRejoinInFlight = false;

  private onVisibilityRetry = () => {
    if (
      document.visibilityState === "visible" &&
      appJotaiStore.get(offlineRoomPendingAtom)
    ) {
      this.retryOfflineJoin();
    }
  };

  private onSocketDisconnect = () => {
    // Silent: just flag it for logic; there is no banner anymore.
    appJotaiStore.set(isOfflineAtom, true);
  };

  private onSocketConnect = () => {
    appJotaiStore.set(isOfflineAtom, false);
    // Mid-session drop with no pending room: socket.io auto-reconnected.
    // Silently push the live canvas at once (solo work since the drop would
    // otherwise wait for the next throttled autosave). Gated on a completed
    // initial load so the boot-time connect doesn't push an empty canvas.
    if (
      !appJotaiStore.get(offlineRoomPendingAtom) &&
      this.portal.socketInitialized
    ) {
      this.saveCollabRoomToFirebase(
        getSyncableElements(this.getSceneElementsIncludingDeleted()),
      );
    }
  };

  // Crash-safety backup: every edit lands in localStorage (throttled) so a
  // tablet crash loses at most ~1s. Failures are silent. Empty canvases are
  // never written: boot resets fire onChange with [], which must not clobber
  // the backup holding pre-crash work (a real clear goes through delete and
  // keeps tombstones server-side; rooms empty for real via delete).
  private saveRoomBackupThrottled = throttle(
    (roomId: string, elements: readonly SyncableExcalidrawElement[]) => {
      if (!elements.length) {
        return;
      }
      try {
        const backup: RoomBackup = {
          roomId,
          elements,
          updatedAt: Date.now(),
        };
        localStorage.setItem(ROOM_BACKUP_KEY, JSON.stringify(backup));
      } catch (error) {
        console.error("room backup save failed", error);
      }
    },
    1000,
  );

  // Cheap reachability probe so the 4s poll doesn't churn dead sockets
  // (and wipe nothing) while truly offline: only restart the join when the
  // host actually answers. Fast-fail, silent.
  private checkServerReachable = async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3000);
      try {
        const resp = await fetch("/api/rooms", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        // Any HTTP answer (even 4xx/5xx) means the host is reachable;
        // only network failure keeps us offline.
        return !!resp;
      } finally {
        window.clearTimeout(timer);
      }
    } catch {
      return false;
    }
  };

  private retryOfflineJoin = async () => {
    if (this.offlineRejoinInFlight) {
      return;
    }
    const pending = appJotaiStore.get(offlineRoomPendingAtom);
    if (!pending) {
      return;
    }
    this.offlineRejoinInFlight = true;
    try {
      // A dead husk may have auto-reconnected on its own (socket.io
      // retries in the background): then just load + merge over the live
      // socket instead of tearing it down.
      if (this.portal.socket?.connected) {
        try {
          await this.initializeRoom({
            fetchScene: true,
            roomLinkData: { ...pending },
          });
        } catch (error) {
          console.error("offline retry load failed", error);
        }
        return;
      }
      if (!(await this.checkServerReachable())) {
        return;
      }
      if (this.portal.socket) {
        // Drop the dead husk so the fresh start below isn't early-returned.
        this.portal.close();
      }
      await this.startCollaboration({ ...pending });
    } finally {
      this.offlineRejoinInFlight = false;
    }
  };

  componentWillUnmount() {
    window.removeEventListener("online", this.onOfflineStatusToggle);
    window.removeEventListener("offline", this.onOfflineStatusToggle);
    if (this.offlineRetryTimer) {
      window.clearInterval(this.offlineRetryTimer);
      this.offlineRetryTimer = undefined;
    }
    document.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityRetry,
    );
    window.removeEventListener("focus", this.onVisibilityRetry);
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();
  }

  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    // Best-effort crash/kill persistence: flush the throttled local backup
    // synchronously so the last strokes survive even if the 1s window
    // hadn't fired yet. Server flush rides in beforeUnload + keepalive.
    try {
      (this.saveRoomBackupThrottled as { flush?: () => void }).flush?.();
    } catch {
      // ignore — backup is best-effort
    }
    LocalData.flushSave();
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        (!isSavedToFirebase(this.portal, syncableElements) &&
          !isSavedToServer(this.portal, syncableElements)))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    // While an offline recovery is pending, the canvas holds state the
    // server hasn't seen merged yet — pushing it now would overwrite the
    // good snapshot with a partial one. The merged scene saves itself once
    // recovery paints (plus the empty-overwrite guards still apply).
    if (this.offlineRecoveryPending) {
      return;
    }
    syncableElements = cloneJSON(syncableElements);
    // self-hosted fork: mirror every save to the /api/rooms registry (always
    // on, unlike the env-gated firebase save below). Fire-and-forget —
    // failures are console-only and must never block collab.
    saveRoomToServer(this.portal, syncableElements);
    try {
      const storedElements = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();

      if (this.isCollaborating() && storedElements) {
        this.handleRemoteSceneUpdate(this._reconcileElements(storedElements));
      }
    } catch (error: any) {
      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      if (
        !this.state.dialogNotifiedErrors[errorMessage] ||
        !this.isCollaborating()
      ) {
        this.setErrorDialog(errorMessage);
        this.setState({
          dialogNotifiedErrors: {
            ...this.state.dialogNotifiedErrors,
            [errorMessage]: true,
          },
        });
      }

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }

      console.error(error);
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    // Leaving abandons any pending offline recovery for the old room.
    this.clearOfflinePending();
    // Persist the old room's last strokes before tearing down, so a quick
    // room switch doesn't drop them from the crash backup.
    try {
      (this.saveRoomBackupThrottled as { flush?: () => void }).flush?.();
    } catch {
      // ignore — backup is best-effort
    }
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    this.followedBy = new Set();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      appJotaiStore.set(userToFollowAtom, null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  private decryptPayload = async (
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    if (!this.state.username) {
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    if (this.portal.socket) {
      if (
        this.pendingScenePromise &&
        existingRoomLinkData &&
        this.pendingSceneRoomId === existingRoomLinkData.roomId
      ) {
        return this.pendingScenePromise;
      }
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<
      | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
      | null
    >();

    // Publish the in-flight load so a racing second call to the same room
    // shares it (see pendingScenePromise). Cleared on settle; later calls
    // fall back to the historical null behavior.
    this.pendingScenePromise = scenePromise;
    this.pendingSceneRoomId = existingRoomLinkData?.roomId ?? null;
    const clearPendingScene = () => {
      if (this.pendingScenePromise === scenePromise) {
        this.pendingScenePromise = null;
        this.pendingSceneRoomId = null;
      }
    };
    scenePromise.then(clearPendingScene, clearPendingScene);

    this.setIsCollaborating(true);
    // Pause local persistence BEFORE any await: a room boot must never
    // persist its (still empty) canvas over local work, and offline work
    // must survive from the first millisecond.
    LocalData.pauseSave("collaboration");

    // The socket client is a lazily-loaded chunk. Offline (or a not-yet
    // precached chunk) it never resolves — enter offline mode instead of
    // hanging the boot with local saves paused.
    let socketIOClient: typeof import("socket.io-client").default;
    try {
      ({ default: socketIOClient } = await import(
        /* webpackChunkName: "socketIoClient" */ "socket.io-client"
      ));
    } catch (error: any) {
      console.error("socket.io chunk failed to load", error);
      this.enterOfflineRoomMode({ roomId, roomKey });
      return null;
    }

    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      this.portal.socket = this.portal.open(
        socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, {
          transports: ["websocket", "polling"],
        }),
        roomId,
        roomKey,
      );

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
      // Silent link-state tracking: socket.io auto-reconnects on its own;
      // these only flip the (now invisible) offline flag and push local
      // work after a mid-session drop. No banners, no prompts.
      this.portal.socket.on("disconnect", this.onSocketDisconnect);
      this.portal.socket.on("connect", this.onSocketConnect);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      return null;
    }

    // register/touch the room in the self-hosted registry (both "start
    // session" and "join" paths converge here). Unconditional,
    // fire-and-forget.
    registerRoom(roomId, roomKey);

    if (existingRoomLinkData) {
      // Joining a room starts blank — except when this is a background
      // retry while offline work is pending: resetting would wipe the very
      // strokes the retry is trying to sync. (Explicit room switches wipe
      // the canvas themselves before starting, with pending cleared.)
      if (!this.offlineRecoveryPending) {
        this.excalidrawAPI.resetScene();
      }
    } else {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
      // A freshly created room owns its canvas seed: local saves resume at
      // once so the seed itself is crash-safe from the first second.
      LocalData.resumeSave("collaboration");
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        if (!this.portal.roomKey) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              const remoteElements = toBrandedType<
                readonly RemoteExcalidrawElement[]
              >(decryptedData.payload.elements);
              const reconciledElements =
                this._reconcileElements(remoteElements);
              // Self-hosted rooms: an empty INIT from idle peers camped in
              // the room must not hide the stored snapshot (incident
              // 2026-09-11: ghosts with empty scenes made every joiner render
              // empty while the server held 1281 strokes). Live non-empty
              // content still wins; only an empty INIT falls back.
              if (
                !reconciledElements.length &&
                roomId &&
                roomKey &&
                this.portal.socket
              ) {
                const savedElements = await loadRoomFromServer(
                  roomId,
                  roomKey,
                  this.portal.socket,
                );
                if (savedElements?.length) {
                  this.setLastBroadcastedOrReceivedSceneVersion(
                    getSceneVersion(savedElements),
                  );
                  await this.paintOfflineRecovery(savedElements);
                  this.clearOfflinePending();
                  scenePromise.resolve({
                    elements: savedElements,
                    scrollToContent: true,
                  });
                  break;
                }
              }
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
            }
            break;
          }
          case WS_SUBTYPES.UPDATE:
            this.handleRemoteSceneUpdate(
              this._reconcileElements(
                toBrandedType<readonly RemoteExcalidrawElement[]>(
                  decryptedData.payload.elements,
                ),
              ),
            );
            break;
          case WS_SUBTYPES.MOUSE_LOCATION: {
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            this.updateCollaborator(socketId, {
              pointer,
              button,
              selectedElementIds,
              username,
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            const { sceneBounds, socketId } = decryptedData.payload;

            const userToFollow = appJotaiStore.get(userToFollowAtom);

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (this.followedBy.has(userToFollow.socketId)) {
              return;
            }

            const appState = this.excalidrawAPI.getAppState();

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fit: "contain",
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          default: {
            assertNever(decryptedData, null);
          }
        }
      },
    );

    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });
      scenePromise.resolve(sceneData);
    });

    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.followedBy = new Set(followedBy);

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      // Offline-first: load first, then decide wipe vs merge. resetScene()
      // upfront would destroy offline-drawn strokes that no server copy
      // holds yet; the explicit switch paths (Rooms open, hashchange) wipe
      // the canvas themselves before starting.
      const loadFromServerFirst = async () => {
        try {
          const elements = await loadFromFirebase(
            roomLinkData.roomId,
            roomLinkData.roomKey,
            this.portal.socket,
          );
          if (elements) {
            return elements;
          }
        } catch (error: any) {
          // log the error and move on. other peers will sync us the scene.
          console.error(error);
        } finally {
          this.portal.socketInitialized = true;
        }

        // self-hosted fork: fall back to the /api/rooms snapshot when
        // firebase has nothing (or is disabled). Returns null on any
        // failure, in which case other peers will sync us the scene.
        return await loadRoomFromServer(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
      };

      const elements = await loadFromServerFirst();
      // Crash-safety: unsynced strokes from before a crash/offline stretch
      // live in the room backup. Merge them over the server snapshot so a
      // reload never drops work the server hasn't seen yet. Room-scoped, so
      // nothing leaks across rooms.
      const backup = readRoomBackup(roomLinkData.roomId);
      if (elements) {
        const merged =
          backup?.length &&
          !this.elementsEqualIds(
            backup,
            elements as readonly SyncableExcalidrawElement[],
          )
            ? mergeBackupWithServer(backup, elements)
            : (elements as readonly SyncableExcalidrawElement[]);
        // Set before any paint: updateScene synchronously fires onChange,
        // and without this the freshly loaded scene would rebroadcast to
        // the room as if it were a local edit (same reason _reconcileElements
        // sets the version before updating).
        this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(merged));
        // Offline recovery reads the canvas below, so the wipe must wait:
        // reset only the clean (non-recovery) path. Recovery paints the
        // merged scene itself via paintOfflineRecovery. The clean path
        // paints directly too (not just via the return value) so late
        // retries after boot — which ignore the return — still reach the
        // canvas; on boot the initialData application of the same content
        // is a harmless second paint.
        if (!this.offlineRecoveryPending) {
          this.excalidrawAPI.resetScene();
          const restored = restoreElements(merged, null, {
            repairBindings: true,
          });
          this.excalidrawAPI.updateScene({
            elements: restored,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
        await this.paintOfflineRecovery(merged);
        this.clearOfflinePending();
        // Online and healthy: local saves resume so every later edit is
        // crash-safe (the boot pause only guarded the empty-canvas window).
        LocalData.resumeSave("collaboration");

        return {
          elements: merged,
          scrollToContent: true,
        };
      }

      // Load failed. If the socket never connected, the server is
      // unreachable: enter offline mode instead of resolving to an empty
      // canvas that would reads as "room is empty". Local work keeps
      // accumulating in the canvas (persisted via resumed local save) and
      // merges on recovery. A crash backup for the same room paints
      // immediately so a crash + offline boot still restores.
      if (!this.portal.socket.connected) {
        this.enterOfflineRoomMode(roomLinkData);
        if (backup?.length) {
          const restored = restoreElements(backup, null, {
            repairBindings: true,
          });
          this.excalidrawAPI.updateScene({
            elements: restored,
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          return {
            elements: restored,
            scrollToContent: true,
          };
        }
        return null;
      }
      // Connected socket with no snapshot: empty/new room — but a crash
      // backup for the SAME room still wins over blank (e.g. created offline,
      // crashed before the first server save).
      if (backup?.length) {
        const restored = restoreElements(backup, null, {
          repairBindings: true,
        });
        this.setLastBroadcastedOrReceivedSceneVersion(
          getSceneVersion(restored),
        );
        this.excalidrawAPI.updateScene({
          elements: restored,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        LocalData.resumeSave("collaboration");
        return {
          elements: restored,
          scrollToContent: true,
        };
      }
      // Connected but no snapshot and no backup: a genuinely empty room —
      // unless an offline recovery is still pending, in which case the canvas
      // may hold strokes the throttled backup hasn't flushed yet. Never wipe
      // those: keep them and push to the server instead.
      LocalData.resumeSave("collaboration");
      if (this.offlineRecoveryPending) {
        this.clearOfflinePending();
        this.queueSaveToFirebase();
        return null;
      }
      this.excalidrawAPI.resetScene();
    } else {
      this.portal.socketInitialized = true;
    }
    return null;
  };

  // Offline-first support (tablet without network). Called when a room join
  // finds no reachable server: keep the canvas (it may hold offline work),
  // persist locally, and flag the pending state for silent background
  // recovery. No UI: offline is invisible by design.
  private enterOfflineRoomMode(roomLinkData: {
    roomId: string;
    roomKey: string;
  }) {
    this.offlineRecoveryPending = true;
    appJotaiStore.set(offlineRoomPendingAtom, { ...roomLinkData });
    LocalData.resumeSave("collaboration");
  }

  private clearOfflinePending() {
    this.offlineRecoveryPending = false;
    appJotaiStore.set(offlineRoomPendingAtom, null);
  }

  // A late-arriving scene after the initial promise already resolved (empty)
  // must still reach the canvas: resolve() would be a noop. Merges with
  // whatever was drawn offline and paints directly. No-op unless an offline
  // recovery is actually pending.
  private async paintOfflineRecovery(
    elements: readonly SyncableExcalidrawElement[],
  ): Promise<void> {
    if (!this.offlineRecoveryPending) {
      return;
    }
    this.clearOfflinePending();
    // Syncable and Remote share structure; only the brand differs, and the
    // reconciler immediately restores + rebrands anyway.
    const merged = this._reconcileElements(
      elements as unknown as readonly RemoteExcalidrawElement[],
    );
    this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(merged));
    this.excalidrawAPI.updateScene({
      elements: merged,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  // Cheap identity check so we skip the backup merge when both sides
  // already hold the same ids (the common healthy-join case).
  private elementsEqualIds = (
    a: readonly { id: string }[],
    b: readonly { id: string }[],
  ): boolean => {
    if (a.length !== b.length) {
      return false;
    }
    const ids = new Set(a.map((el) => el.id));
    if (ids.size !== a.length) {
      return false;
    }
    for (const el of b) {
      if (!ids.has(el.id)) {
        return false;
      }
    }
    return true;
  };

  private _reconcileElements = (
    remoteElements: readonly RemoteExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const appState = this.excalidrawAPI.getAppState();

    const existingElements = this.getSceneElementsIncludingDeleted();

    // NOTE ideally we restore _after_ reconciliation but we can't do that
    // as we'd regenerate even elements such as appState.newElement which would
    // break the state
    remoteElements = restoreElements(remoteElements, existingElements);

    let reconciledElements = reconcileElements(
      existingElements,
      remoteElements,
      appState,
    );

    reconciledElements = bumpElementVersions(
      reconciledElements,
      existingElements,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromFirebase({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      const isCurrentUser = socketId === this.portal.socket?.id;
      collaborators.set(
        socketId,
        Object.assign(
          // we never receive our own broadcasts, so we need to seed
          // our own collaborator entry with the local username
          isCurrentUser ? { username: this.state.username } : {},
          this.collaborators.get(socketId),
          { isCurrentUser },
        ),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });

    // unfollow if the followed user left the room
    const userToFollow = appJotaiStore.get(userToFollowAtom);
    if (userToFollow && !collaborators.has(userToFollow.socketId)) {
      this.setUserToFollow(null);
    }
  }

  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const isCurrentUser = socketId === this.portal.socket?.id;
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      // we never receive our own broadcasts, so we need to seed
      // our own collaborator entry with the local username
      isCurrentUser ? { username: this.state.username } : {},
      collaborators.get(socketId),
      updates,
      { isCurrentUser },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    if (this.portal.socket && (this.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(this.excalidrawAPI.getAppState()),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    this.broadcastElements(elements);
    this.queueSaveToFirebase();
    // Crash-safety: persist every edit locally, even while collaborating.
    // The roomId is stable for the session; the backup restores after a
    // crash even if the server snapshot lags behind.
    if (this.portal.roomId) {
      this.saveRoomBackupThrottled(
        this.portal.roomId,
        getSyncableElements(elements),
      );
    }
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    ROOM_SNAPSHOT_INTERVAL_MS,
    { leading: false },
  );

  setUserToFollow = (userToFollow: UserToFollow | null) => {
    const prev = appJotaiStore.get(userToFollowAtom) ?? null;

    if (prev?.socketId !== userToFollow?.socketId && this.portal.socket) {
      // leave the previous user's follow room before joining the next one
      if (prev) {
        this.portal.broadcastUserFollowed({
          userToFollow: prev,
          action: "UNFOLLOW",
        });
      }
      if (userToFollow) {
        this.portal.broadcastUserFollowed({
          userToFollow,
          action: "FOLLOW",
        });
      }
    }

    appJotaiStore.set(userToFollowAtom, userToFollow);
  };

  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);

    // keep our own collaborator entry in sync
    const socketId = this.portal.socket?.id as SocketId | undefined;
    if (socketId && this.collaborators.has(socketId)) {
      this.updateCollaborator(socketId, { username });
    }
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
