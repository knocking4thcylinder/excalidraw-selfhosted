import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { ExcalidrawContainerContext } from "@excalidraw/excalidraw/components/App";
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
import { getCommonBounds, getVisibleSceneBounds } from "@excalidraw/element";
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
  AppState,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
  UserToFollow,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import { readRoomBackup } from "../data/sceneStorage";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
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
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import {
  isSavedToServer,
  clearRoomSceneCache,
  loadRoomFromServer,
  registerRoom,
  saveRoomToServer,
} from "../data/rooms";

import { resetBrowserStateVersions } from "../data/tabSync";
import {
  cacheRoomFiles,
  getRoomCacheGeneration,
  getRoomFileCacheGeneration,
  getRoomChanges,
  readCachedRoomFiles,
  readCachedRoomScene,
  readRoomDraft,
  saveRoomDraft,
} from "../data/roomCache";
import {
  downloadRoomFiles,
  loadRoomFiles,
  uploadRoomFiles,
} from "../data/roomFiles";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import type { RoomSaveOutcome } from "../data/rooms";

import type { ContextType } from "react";
import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(false);
export const roomValidationPendingAtom = atom(false);
// Set when a room join finds no server (offline boot): the canvas keeps
// local-only work and local persistence resumes. Silent — no banner.
// Cleared on the first successful server contact.
export const offlineRoomPendingAtom = atom<{
  roomId: string;
  roomKey: string;
} | null>(null);

// Unsynced room work: the per-room draft, or the legacy single-slot backup
// for a room last edited before drafts existed.
const readLocalRoomScene = async (
  roomId: string,
  roomKey: string,
): Promise<readonly SyncableExcalidrawElement[] | null> =>
  (await readRoomDraft(roomId, roomKey)) ??
  (await readRoomBackup(localStorage, roomId));

// Local work over a saved scene, element by element, with the same rules as
// live collaboration: the higher version wins and ties break by versionNonce.
const mergeLocalWork = (
  local: readonly SyncableExcalidrawElement[],
  saved: readonly SyncableExcalidrawElement[],
  appState: AppState,
) =>
  reconcileElements(
    restoreElements(local, null, { repairBindings: true }),
    saved as unknown as readonly RemoteExcalidrawElement[],
    appState,
  );

interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
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
  fetchImageFiles: CollabInstance["fetchImageFiles"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
  setUserToFollow: CollabInstance["setUserToFollow"];
}

interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

type PreparedRoomScene = {
  elements: readonly OrderedExcalidrawElement[];
  viewport: Pick<AppState, "scrollX" | "scrollY" | "zoom">;
  baseline: readonly SyncableExcalidrawElement[] | null | undefined;
  files: BinaryFileData[];
  fileGeneration: number;
  generation: number;
};

class Collab extends PureComponent<CollabProps, CollabState> {
  static contextType = ExcalidrawContainerContext;
  declare context: ContextType<typeof ExcalidrawContainerContext>;
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private roomLoadController: AbortController | null = null;
  // True while the canvas holds local room work — a cached preview, the
  // room draft, or strokes drawn offline — that has not been merged with the
  // server scene yet. Server saves wait (they would overwrite the snapshot
  // with a partial scene) and a late server scene is merged into the canvas
  // instead of replacing it. Cleared once merged, or when leaving the room.
  private localWorkPending = false;
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
  private pendingSceneRoomKey: string | null = null;
  private roomStartGeneration = 0;
  private preparedRoomScenes = new Map<string, PreparedRoomScene>();
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();
  /** the socket ids of the users following the current user */
  private followedBy = new Set<SocketId>();

  private isPortalCurrent(
    socket: Portal["socket"],
    roomId: Portal["roomId"],
    roomKey: Portal["roomKey"],
  ) {
    return (
      this.portal.socket === socket &&
      this.portal.roomId === roomId &&
      this.portal.roomKey === roomKey
    );
  }

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
    };
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      getFiles: async (fileIds) => {
        const { roomId, roomKey, socket } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const result = await loadRoomFiles({
          roomId,
          roomKey,
          fileIds,
          skipCache: this.excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .filter(isInitializedImageElement)
            .filter((element) => element.status !== "saved")
            .map((element) => element.fileId),
          download: (missing) => downloadRoomFiles(roomId, roomKey, missing),
          onCachedFiles: (files) => {
            if (this.isPortalCurrent(socket, roomId, roomKey)) {
              this.excalidrawAPI.addFiles(files);
            }
          },
        });
        if (!this.isPortalCurrent(socket, roomId, roomKey)) {
          throw new AbortError();
        }
        return result;
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        await cacheRoomFiles(roomId, roomKey, [...addedFiles.values()]);
        const { savedFiles, erroredFiles } = await uploadRoomFiles({
          roomId,
          roomKey,
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
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityRetry);
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
      fetchImageFiles: this.fetchImageFiles,
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
  // The confirmed scene the pending local work started from; only changes
  // against it are merged, so shapes removed on the server stay removed.
  private localWorkBaseline: readonly SyncableExcalidrawElement[] | null = null;

  private onVisibilityRetry = () => {
    if (this.context.container?.ownerDocument.visibilityState === "visible") {
      this.preparedRoomScenes.clear();
      clearRoomSceneCache();
    }
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
      this.saveCollabRoom(
        getSyncableElements(this.getSceneElementsIncludingDeleted()),
      );
    }
  };

  private saveRoomDraftThrottled = throttle(
    async (
      roomId: string,
      roomKey: string,
      elements: readonly SyncableExcalidrawElement[],
    ) => {
      if (!elements.length) {
        return;
      }
      try {
        const savingDraft = saveRoomDraft(roomId, roomKey, elements);
        if (this.portal.roomId === roomId && this.portal.roomKey === roomKey) {
          await cacheRoomFiles(
            roomId,
            roomKey,
            Object.values(this.excalidrawAPI.getFiles()),
          );
        }
        await savingDraft;
      } catch (error) {
        console.error("room draft save failed", error);
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
          method: "HEAD",
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
    this.saveRoomDraftThrottled.flush();
    this.saveRoomDraftThrottled.cancel();
    this.queueBroadcastAllElements.cancel();
    this.queueSaveRoom.cancel();
    this.loadImageFiles.cancel();
    this.destroySocketClient({ isUnload: true });
    if (
      appJotaiStore.get(collabAPIAtom)?.startCollaboration ===
      this.startCollaboration
    ) {
      this.clearLocalWorkPending();
      this.setIsCollaborating(false);
      appJotaiStore.set(collabAPIAtom, null);
    }
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
    // Best-effort crash/kill persistence: start the throttled draft write now
    // so the last strokes have a chance to land even if the 1s window hadn't
    // fired yet. Server flush rides in beforeUnload + keepalive.
    this.saveRoomDraftThrottled.flush();
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
        !isSavedToServer(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoom(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  saveCollabRoom = (syncableElements: readonly SyncableExcalidrawElement[]) => {
    // While local work is pending, the canvas holds state the server
    // hasn't seen merged yet — pushing it now would overwrite the
    // good snapshot with a partial one. The merged scene saves itself once
    // merged (plus the empty-overwrite guards still apply).
    if (this.localWorkPending || !this.portal.socketInitialized) {
      return;
    }
    syncableElements = cloneJSON(syncableElements);
    // Fire-and-forget: a failed save never blocks collab, but it does show
    // the collab error indicator until the next successful save.
    const { socket, roomId, roomKey } = this.portal;
    const saving = saveRoomToServer(this.portal, syncableElements, {
      onConflict: (latest, baseline) => {
        if (
          !this.isPortalCurrent(socket, roomId, roomKey) ||
          this.localWorkPending
        ) {
          return;
        }
        const reconciled = reconcileElements(
          restoreElements(latest, null, { repairBindings: true }),
          toBrandedType<readonly RemoteExcalidrawElement[]>(
            getRoomChanges(
              baseline,
              getSyncableElements(this.getSceneElementsIncludingDeleted()),
            ),
          ),
          this.excalidrawAPI.getAppState(),
        );
        this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(latest));
        this.handleRemoteSceneUpdate(reconciled);
        this.syncElements(reconciled);
      },
    });
    void this.reportRoomSave(saving, socket, roomId, roomKey);
  };

  private reportRoomSave = async (
    saving: Promise<RoomSaveOutcome>,
    socket: Portal["socket"],
    roomId: Portal["roomId"],
    roomKey: Portal["roomKey"],
  ) => {
    const outcome = await saving;
    if (!this.isPortalCurrent(socket, roomId, roomKey)) {
      return;
    }
    if (outcome === "saved") {
      this.resetErrorIndicator();
    } else if (outcome === "failed") {
      this.setErrorIndicator(t("errors.collabSaveFailed"));
    }
  };

  stopCollaboration = (keepRemoteState = true) => {
    // Leaving abandons any pending local-work merge for the old room.
    // Persist the old room's last strokes before tearing down, so a quick
    // room switch doesn't drop them from its draft.
    this.saveRoomDraftThrottled.flush();
    this.saveRoomDraftThrottled.cancel();
    this.rememberPreparedRoom();
    this.queueBroadcastAllElements.cancel();
    this.queueSaveRoom.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoom(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );
    this.clearLocalWorkPending();

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
    this.roomStartGeneration++;
    this.roomLoadController?.abort();
    this.roomLoadController = null;
    window.clearTimeout(this.socketInitializationTimer);
    this.pendingScenePromise?.resolve(null);
    this.pendingScenePromise = null;
    this.pendingSceneRoomId = null;
    this.pendingSceneRoomKey = null;
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

  private fetchImageFiles = async (opts: {
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

    try {
      return await this.fileManager.getFiles(unfetchedImages);
    } catch (error) {
      if (error instanceof AbortError) {
        return { loadedFiles: [], erroredFiles: new Map<FileId, true>() };
      }
      throw error;
    }
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

    if (
      this.pendingScenePromise &&
      existingRoomLinkData &&
      this.pendingSceneRoomId === existingRoomLinkData.roomId &&
      this.pendingSceneRoomKey === existingRoomLinkData.roomKey
    ) {
      return this.pendingScenePromise;
    }
    if (this.portal.socket) {
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
    this.pendingSceneRoomKey = existingRoomLinkData?.roomKey ?? null;
    const clearPendingScene = () => {
      if (this.pendingScenePromise === scenePromise) {
        this.pendingScenePromise = null;
        this.pendingSceneRoomId = null;
        this.pendingSceneRoomKey = null;
      }
    };

    this.setIsCollaborating(true);
    // Room canvases never go to the personal local scene: local persistence
    // stays paused for the whole session (destroySocketClient resumes it).
    // Room work is persisted as the per-room draft instead (syncElements).
    LocalData.pauseSave("collaboration");

    const generation = ++this.roomStartGeneration;
    this.portal.roomId = roomId;
    this.portal.roomKey = roomKey;
    this.setActiveRoomLink(window.location.href);
    if (existingRoomLinkData && !this.localWorkPending) {
      this.resetRoomScene();
    }
    const cachedPreview = existingRoomLinkData
      ? this.restoreCachedRoom(
          existingRoomLinkData,
          generation,
          scenePromise,
        ).catch((error) => console.error("Cached room preview failed", error))
      : Promise.resolve();
    void this.startRoomConnection({
      roomId,
      roomKey,
      existingRoomLinkData,
      scenePromise,
      generation,
      cachedPreview,
    })
      .catch((error) => {
        if (this.roomStartGeneration !== generation) {
          return;
        }
        console.error("Room connection failed", error);
        this.enterOfflineRoomMode({ roomId, roomKey });
        scenePromise.resolve(null);
      })
      .finally(clearPendingScene);
    return scenePromise;
  };

  private restoreCachedRoom = async (
    room: { roomId: string; roomKey: string },
    generation: number,
    scenePromise: NonNullable<Collab["pendingScenePromise"]>,
  ) => {
    if (this.localWorkPending) {
      return;
    }
    const cacheKey = JSON.stringify([room.roomId, room.roomKey]);
    const prepared = this.preparedRoomScenes.get(cacheKey);
    let restored: readonly OrderedExcalidrawElement[];
    let viewport: PreparedRoomScene["viewport"] | undefined;
    let preparedFiles: BinaryFileData[] | undefined;
    if (
      prepared &&
      prepared.baseline !== undefined &&
      prepared.generation === getRoomCacheGeneration(room.roomId, room.roomKey)
    ) {
      this.preparedRoomScenes.delete(cacheKey);
      this.preparedRoomScenes.set(cacheKey, prepared);
      this.localWorkBaseline = prepared.baseline;
      restored = prepared.elements;
      viewport = prepared.viewport;
      if (
        prepared.fileGeneration ===
        getRoomFileCacheGeneration(room.roomId, room.roomKey)
      ) {
        preparedFiles = prepared.files;
      }
    } else {
      viewport = prepared?.viewport;
      this.preparedRoomScenes.delete(cacheKey);
      const [cached, local] = await Promise.all([
        readCachedRoomScene(room.roomId, room.roomKey),
        readLocalRoomScene(room.roomId, room.roomKey),
      ]);
      if (
        this.roomStartGeneration !== generation ||
        (!cached && !local?.length)
      ) {
        return;
      }
      this.localWorkBaseline = cached?.elements ?? null;
      restored = reconcileElements(
        mergeLocalWork(
          local ?? [],
          cached?.elements ?? [],
          this.excalidrawAPI.getAppState(),
        ),
        this.excalidrawAPI.getSceneElementsIncludingDeleted() as readonly RemoteExcalidrawElement[],
        this.excalidrawAPI.getAppState(),
      );
      const visibleElements = restored.filter((element) => !element.isDeleted);
      if (!viewport && visibleElements.length) {
        const fitted = zoomToFitBounds({
          appState: this.excalidrawAPI.getAppState(),
          bounds: getCommonBounds(visibleElements),
          fit: "contain",
        }).appState;
        viewport = {
          scrollX: fitted.scrollX,
          scrollY: fitted.scrollY,
          zoom: fitted.zoom,
        };
      }
    }
    if (this.roomStartGeneration !== generation) {
      return;
    }
    this.localWorkPending = true;
    appJotaiStore.set(roomValidationPendingAtom, true);
    this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(restored));
    this.excalidrawAPI.updateScene({
      elements: restored,
      appState: viewport,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    scenePromise.resolve({
      elements: restored,
      appState: viewport,
      scrollToContent: false,
    });
    const fileIds = restored
      .filter(isInitializedImageElement)
      .filter((element) => !element.isDeleted)
      .map((element) => element.fileId);
    const files =
      preparedFiles ??
      (await readCachedRoomFiles(room.roomId, room.roomKey, fileIds));
    if (this.roomStartGeneration === generation) {
      const existingFiles = this.excalidrawAPI.getFiles();
      const missingFiles = files.filter(
        (file) =>
          existingFiles[file.id]?.dataURL !== file.dataURL ||
          existingFiles[file.id]?.mimeType !== file.mimeType,
      );
      if (missingFiles.length) {
        this.excalidrawAPI.addFiles(missingFiles);
      }
    }
  };

  private rememberPreparedRoom = () => {
    const { roomId, roomKey } = this.portal;
    if (
      !roomId ||
      !roomKey ||
      (!this.localWorkPending && !this.portal.socketInitialized)
    ) {
      return;
    }
    const elements = [...this.excalidrawAPI.getSceneElementsIncludingDeleted()];
    void saveRoomDraft(roomId, roomKey, getSyncableElements(elements));
    const { scrollX, scrollY, zoom } = this.excalidrawAPI.getAppState();
    const currentFiles = this.excalidrawAPI.getFiles();
    const fileIds = new Set(
      elements
        .filter(isInitializedImageElement)
        .map((element) => element.fileId),
    );
    const snapshot: PreparedRoomScene = {
      elements,
      viewport: { scrollX, scrollY, zoom },
      baseline: undefined,
      files: [...fileIds].flatMap((fileId) =>
        currentFiles[fileId] ? [{ ...currentFiles[fileId] }] : [],
      ),
      generation: getRoomCacheGeneration(roomId, roomKey),
      fileGeneration: getRoomFileCacheGeneration(roomId, roomKey),
    };
    const cacheKey = JSON.stringify([roomId, roomKey]);
    this.preparedRoomScenes.delete(cacheKey);
    this.preparedRoomScenes.set(cacheKey, snapshot);
    while (
      this.preparedRoomScenes.size > 8 ||
      [...this.preparedRoomScenes.values()].reduce(
        (total, room) => total + room.elements.length,
        0,
      ) > 20_000 ||
      [...this.preparedRoomScenes.values()].reduce(
        (total, room) =>
          total +
          room.files.reduce(
            (bytes, file) => bytes + file.dataURL.length * 2,
            0,
          ),
        0,
      ) >
        64 * 1024 * 1024
    ) {
      this.preparedRoomScenes.delete(
        this.preparedRoomScenes.keys().next().value!,
      );
    }
    void Promise.all([
      readCachedRoomScene(roomId, roomKey),
      readRoomDraft(roomId, roomKey),
    ]).then(([cached, draft]) => {
      if (this.preparedRoomScenes.get(cacheKey) !== snapshot) {
        return;
      }
      if (
        draft === null ||
        snapshot.generation !== getRoomCacheGeneration(roomId, roomKey)
      ) {
        this.preparedRoomScenes.delete(cacheKey);
        return;
      }
      snapshot.baseline = cached?.elements ?? null;
    });
  };

  private startRoomConnection = async ({
    roomId,
    roomKey,
    existingRoomLinkData,
    scenePromise,
    generation,
    cachedPreview,
  }: {
    roomId: string;
    roomKey: string;
    existingRoomLinkData: { roomId: string; roomKey: string } | null;
    scenePromise: NonNullable<Collab["pendingScenePromise"]>;
    generation: number;
    cachedPreview: Promise<void>;
  }) => {
    // The socket client is a lazily-loaded chunk. Offline (or a not-yet
    // precached chunk) it never resolves — enter offline mode instead of
    // hanging the boot with local saves paused.
    let socketIOClient: typeof import("socket.io-client").default;
    try {
      ({ default: socketIOClient } = await import(
        /* webpackChunkName: "socketIoClient" */ "socket.io-client"
      ));
    } catch (error: any) {
      await cachedPreview;
      if (this.roomStartGeneration !== generation) {
        return null;
      }
      console.error("socket.io chunk failed to load", error);
      this.enterOfflineRoomMode({ roomId, roomKey });
      scenePromise.resolve(null);
      return null;
    }

    if (this.roomStartGeneration !== generation) {
      return null;
    }

    let roomInitialization: ReturnType<Collab["initializeRoom"]> | null = null;
    let peerInitializationStarted = false;
    const loadSavedSceneImmediately = !!existingRoomLinkData;
    const fallbackInitializationHandler = () => {
      roomInitialization ??= this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
        cachedPreview,
        onCachedScene: (scene) => scenePromise.resolve(scene),
      });
      return roomInitialization
        .then((scene) => {
          if (!peerInitializationStarted) {
            scenePromise.resolve(scene);
          }
        })
        .catch((error) => {
          if (!this.isPortalCurrent(roomSocket, roomId, roomKey)) {
            return;
          }
          console.error("Room snapshot load failed", error);
          this.enterOfflineRoomMode({ roomId, roomKey });
          scenePromise.resolve({
            elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
            appState: { errorMessage: t("roomDialog.error_network") },
          });
        });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      this.portal.socket = this.portal.open(
        // Empty in production builds: the room server sits behind the same
        // Caddy origin as the app (/socket.io/*).
        socketIOClient(
          import.meta.env.VITE_APP_WS_SERVER_URL || window.location.origin,
          {
            transports: ["websocket", "polling"],
          },
        ),
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
      await cachedPreview;
      if (this.roomStartGeneration !== generation) {
        return null;
      }
      console.error(error);
      this.setErrorDialog(error.message);
      this.enterOfflineRoomMode({ roomId, roomKey });
      scenePromise.resolve(null);
      return null;
    }

    // register/touch the room in the self-hosted registry (both "start
    // session" and "join" paths converge here). Unconditional,
    // fire-and-forget.
    registerRoom(roomId, roomKey);

    if (!existingRoomLinkData) {
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

      this.saveCollabRoom(getSyncableElements(elements));
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );
    const roomSocket = this.portal.socket;

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        if (
          this.portal.socket !== roomSocket ||
          this.portal.roomKey !== roomKey
        ) {
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          roomKey,
        );
        if (
          this.portal.socket !== roomSocket ||
          this.portal.roomKey !== roomKey
        ) {
          return;
        }

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            if (loadSavedSceneImmediately) {
              this.handleRemoteSceneUpdate(
                this._reconcileElements(
                  toBrandedType<readonly RemoteExcalidrawElement[]>(
                    decryptedData.payload.elements,
                  ),
                ),
              );
              break;
            }
            if (!this.portal.socketInitialized) {
              peerInitializationStarted = true;
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
                if (this.portal.socket !== roomSocket) {
                  return;
                }
                if (savedElements?.length) {
                  this.setLastBroadcastedOrReceivedSceneVersion(
                    getSceneVersion(savedElements),
                  );
                  await this.mergeLocalWorkIntoServerScene(savedElements);
                  this.clearLocalWorkPending();
                  scenePromise.resolve({
                    elements: savedElements,
                    scrollToContent: true,
                  });
                  break;
                }
              }
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via the saved snapshot
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

    this.portal.socket.on("first-in-room", () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      fallbackInitializationHandler();
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

    if (loadSavedSceneImmediately) {
      fallbackInitializationHandler();
    }

    return scenePromise;
  };

  private resetRoomScene = () => {
    const { openSidebar, defaultSidebarDockedPreference } =
      this.excalidrawAPI.getAppState();
    this.excalidrawAPI.resetScene();
    this.excalidrawAPI.updateScene({
      appState: { openSidebar, defaultSidebarDockedPreference },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };

  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
    onCachedScene,
    cachedPreview,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
        cachedPreview?: Promise<void>;
        onCachedScene?: (
          scene: ImportedDataState & {
            elements: readonly OrderedExcalidrawElement[];
          },
        ) => void;
      }
    | {
        fetchScene: false;
        roomLinkData?: null;
        onCachedScene?: never;
        cachedPreview?: never;
      }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      const socket = this.portal.socket;
      const wasInitialized = this.portal.socketInitialized;
      const isCurrentRoom = () =>
        this.isPortalCurrent(socket, roomLinkData.roomId, roomLinkData.roomKey);
      // Offline-first: load first, then decide wipe vs merge. resetScene()
      // upfront would destroy offline-drawn strokes that no server copy
      // holds yet; the explicit switch paths (Rooms open, hashchange) wipe
      // the canvas themselves before starting.
      const loadFromServerFirst = async () => {
        // A missing snapshot resolves to null, in which case other peers will
        // sync us the scene.
        const ownerWindow = this.context.container?.ownerDocument.defaultView;
        const controller = ownerWindow
          ? new ownerWindow.AbortController()
          : null;
        this.roomLoadController = controller;
        let timeout: number | undefined;
        const onProgress = () => {
          ownerWindow?.clearTimeout(timeout);
          timeout = ownerWindow?.setTimeout(() => controller?.abort(), 20_000);
        };
        onProgress();
        try {
          return await loadRoomFromServer(
            roomLinkData.roomId,
            roomLinkData.roomKey,
            socket,
            { signal: controller?.signal, throwOnError: true, onProgress },
          );
        } finally {
          ownerWindow?.clearTimeout(timeout);
          if (this.roomLoadController === controller) {
            this.roomLoadController = null;
          }
        }
      };

      const serverScenePromise = loadFromServerFirst().then(
        (elements) => ({ status: "fulfilled" as const, elements }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (cachedPreview) {
        await cachedPreview;
        if (!isCurrentRoom()) {
          return null;
        }
      }
      if (!cachedPreview && !wasInitialized && !this.localWorkPending) {
        const [cached, local] = await Promise.all([
          readCachedRoomScene(roomLinkData.roomId, roomLinkData.roomKey),
          readLocalRoomScene(roomLinkData.roomId, roomLinkData.roomKey),
        ]);
        if (!isCurrentRoom() || this.portal.socketInitialized) {
          return null;
        }
        if (cached || local?.length) {
          this.localWorkBaseline = cached?.elements ?? null;
          const preview = reconcileElements(
            mergeLocalWork(
              local ?? [],
              cached?.elements ?? [],
              this.excalidrawAPI.getAppState(),
            ),
            this.excalidrawAPI.getSceneElementsIncludingDeleted() as readonly RemoteExcalidrawElement[],
            this.excalidrawAPI.getAppState(),
          );
          this.localWorkPending = true;
          appJotaiStore.set(roomValidationPendingAtom, true);
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(preview),
          );
          this.excalidrawAPI.updateScene({
            elements: preview,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          this.loadImageFiles();
          onCachedScene?.({ elements: preview, scrollToContent: true });
        }
      }
      const result = await serverScenePromise;
      if (result.status === "rejected") {
        throw result.error;
      }
      const elements = result.elements;
      if (
        !isCurrentRoom() ||
        (!wasInitialized && this.portal.socketInitialized)
      ) {
        return null;
      }
      // Unsynced local work (draft or legacy backup) is already on the canvas
      // as the preview, with localWorkPending set; mergeLocalWorkIntoServerScene
      // merges it over the server scene below.
      this.portal.socketInitialized = true;
      if (elements) {
        let merged = elements as readonly SyncableExcalidrawElement[];
        if (!wasInitialized && !this.localWorkPending) {
          merged = getSyncableElements(
            reconcileElements(
              restoreElements(merged, null, { repairBindings: true }),
              this.excalidrawAPI.getSceneElementsIncludingDeleted() as readonly RemoteExcalidrawElement[],
              this.excalidrawAPI.getAppState(),
            ),
          );
        }
        // Set before any paint: updateScene synchronously fires onChange,
        // and without this the freshly loaded scene would rebroadcast to
        // the room as if it were a local edit (same reason _reconcileElements
        // sets the version before updating).
        this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(merged));
        // The local-work merge reads the canvas below, so the wipe must wait:
        // reset only when no local work is pending; the merge paints the
        // result itself via mergeLocalWorkIntoServerScene. The clean path
        // paints directly too (not just via the return value) so late
        // retries after boot — which ignore the return — still reach the
        // canvas; on boot the initialData application of the same content
        // is a harmless second paint.
        if (!this.localWorkPending) {
          this.resetRoomScene();
          const restored = restoreElements(merged, null, {
            repairBindings: true,
          });
          this.excalidrawAPI.updateScene({
            elements: restored,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
        const recoveredChanges =
          this.localWorkPending &&
          (!this.localWorkBaseline ||
            getRoomChanges(
              this.localWorkBaseline,
              getSyncableElements(this.getSceneElementsIncludingDeleted()),
            ).length > 0);
        await this.mergeLocalWorkIntoServerScene(merged);
        merged = getSyncableElements(
          this.excalidrawAPI.getSceneElementsIncludingDeleted(),
        );
        this.loadImageFiles();
        this.clearLocalWorkPending();
        if (recoveredChanges) {
          this.portal.broadcastScene(WS_SUBTYPES.UPDATE, merged, true);
        }
        return {
          elements: merged,
          scrollToContent: true,
        };
      }

      // Load failed. If the socket never connected, the server is
      // unreachable: enter offline mode instead of resolving to an empty
      // canvas that would read as "room is empty". Local work (already on
      // the canvas as the preview) keeps accumulating, persisted as the room
      // draft, and merges on recovery.
      if (this.localWorkBaseline || !this.portal.socket.connected) {
        this.enterOfflineRoomMode(roomLinkData);
        return null;
      }
      // Connected but no snapshot: a genuinely empty room — unless local
      // work is pending (draft preview or offline strokes). Never wipe
      // those: keep them and push to the server instead.
      if (this.localWorkPending) {
        this.clearLocalWorkPending();
        this.queueSaveRoom();
        return null;
      }
      this.resetRoomScene();
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
    this.localWorkPending = true;
    appJotaiStore.set(roomValidationPendingAtom, false);
    appJotaiStore.set(offlineRoomPendingAtom, { ...roomLinkData });
  }

  private clearLocalWorkPending() {
    this.localWorkPending = false;
    this.localWorkBaseline = null;
    appJotaiStore.set(roomValidationPendingAtom, false);
    appJotaiStore.set(offlineRoomPendingAtom, null);
  }

  // Merges pending local work (changes against localWorkBaseline, or the
  // whole canvas without one) over a server scene and paints the result
  // directly, so a scene arriving after the initial promise resolved still
  // reaches the canvas. No-op unless local work is pending.
  private async mergeLocalWorkIntoServerScene(
    elements: readonly SyncableExcalidrawElement[],
  ): Promise<void> {
    if (!this.localWorkPending) {
      return;
    }
    const baseline = this.localWorkBaseline;
    this.clearLocalWorkPending();
    // Syncable and Remote share structure; only the brand differs, and the
    // reconciler immediately restores + rebrands anyway.
    const merged = baseline
      ? reconcileElements(
          restoreElements(elements, null, { repairBindings: true }),
          getRoomChanges(
            baseline,
            getSyncableElements(this.getSceneElementsIncludingDeleted()),
          ) as unknown as readonly RemoteExcalidrawElement[],
          this.excalidrawAPI.getAppState(),
        )
      : this._reconcileElements(
          elements as unknown as readonly RemoteExcalidrawElement[],
        );
    this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(merged));
    this.excalidrawAPI.updateScene({
      elements: merged,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

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
    const { roomId, roomKey, socket } = this.portal;
    const isCurrentRoom = () => this.isPortalCurrent(socket, roomId, roomKey);
    if (!roomId || !roomKey) {
      return;
    }
    const fileIds = this.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .filter(isInitializedImageElement)
      .filter((element) => !element.isDeleted)
      .map((element) => element.fileId);
    const cachedFiles = await readCachedRoomFiles(roomId, roomKey, fileIds);
    if (!isCurrentRoom()) {
      return;
    }
    this.excalidrawAPI.addFiles(cachedFiles);
    try {
      const { loadedFiles, erroredFiles } = await this.fetchImageFiles({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

      if (!isCurrentRoom()) {
        return;
      }
      this.excalidrawAPI.addFiles(loadedFiles);

      updateStaleImageStatuses({
        excalidrawAPI: this.excalidrawAPI,
        erroredFiles,
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });
    } catch (error) {
      if (!(error instanceof AbortError)) {
        console.error(error);
      }
    }
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
    this.queueSaveRoom();
    // Crash-safety: persist every edit as the room draft. It restores after
    // a crash or offline stretch even if the server snapshot lags behind.
    if (this.portal.roomId && this.portal.roomKey) {
      this.saveRoomDraftThrottled(
        this.portal.roomId,
        this.portal.roomKey,
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

  queueSaveRoom = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoom(
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
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => appJotaiStore.get(activeRoomLinkAtom);

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
