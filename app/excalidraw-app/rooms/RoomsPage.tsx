import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  LinkIcon,
  PlusIcon,
  TrashIcon,
  copyIcon,
  pencilIcon,
  playerStopFilledIcon,
  share,
  LoadIcon,
  chevronDownIcon,
} from "@excalidraw/excalidraw/components/icons";
import { CaptureUpdateAction, zoomToFitBounds } from "@excalidraw/excalidraw";
import { getCommonBounds } from "@excalidraw/element";
import { useExcalidrawContainer } from "@excalidraw/excalidraw/components/App";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { APP_NAME, KEYS } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "radix-ui";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getCollaborationLink, getCollaborationLinkData } from "../data";
import {
  deleteRoom,
  deleteRoomFolder,
  fetchRoomFolders,
  fetchRooms,
  moveRoomToFolder,
  renameRoom,
  saveRoomFolder,
  type RoomFolder,
  type ServerRoomEntry,
} from "../data/rooms";

import { JoinRoom } from "../share/JoinRoom";
import { appJotaiStore, useAtom, useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";
import {
  cacheFolders,
  cacheRooms,
  readCachedFolders,
  readCachedRooms,
} from "../data/roomCache";

import { closeRoomsPage, getRoomPageLink } from "./roomsRoute";
import { FolderMenu } from "./FolderMenu";
import { RoomExplorer } from "./RoomExplorer";
import { getFolderDescendantIds, getFolderTree } from "./folderTree";
import { roomFoldersAtom, roomsRegistryAtom } from "./explorerState";
import "./RoomsPage.scss";

import type { CollabAPI } from "../collab/Collab";

export const RoomsPage = ({
  collabAPI,
  excalidrawAPI,
  onClose,
}: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  const { container } = useExcalidrawContainer();
  const ownerWindow = container?.ownerDocument.defaultView ?? window;

  const [rooms, setRooms] = useAtom(roomsRegistryAtom, {
    store: appJotaiStore,
  });
  const [loading, setLoading] = useState(true);
  const filterRef = useRef<HTMLInputElement>(null);
  const [joinVisible, setJoinVisible] = useState(false);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [confirmingDeleteRoomId, setConfirmingDeleteRoomId] = useState<
    string | null
  >(null);
  const [deletingRoom, setDeletingRoom] = useState(false);
  const roomDeletionInFlight = useRef(false);
  const deleteConfirmationRef = useRef<HTMLDivElement>(null);
  const [sharingRoomId, setSharingRoomId] = useState<string | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [shareCodeLoading, setShareCodeLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const copiedTimer = useRef<number>(0);
  const shareRequest = useRef(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const transitionRef = useRef(false);
  const [transitioning, setTransitioning] = useState(false);
  const [search, setSearch] = useState("");
  const [folders, setFolders] = useAtom(roomFoldersAtom, {
    store: appJotaiStore,
  });
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState("all");
  useEffect(() => {
    if (rooms) {
      void cacheRooms(rooms);
    }
  }, [rooms]);
  useEffect(() => {
    if (folders) {
      void cacheFolders(folders);
    }
  }, [folders]);
  const [folderEditor, setFolderEditor] = useState<"create" | "rename" | null>(
    null,
  );
  const [folderName, setFolderName] = useState("");
  const [folderParentId, setFolderParentId] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderSubmission = useRef(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [confirmingDeleteFolder, setConfirmingDeleteFolder] = useState(false);
  const folderDeleteConfirmationRef = useRef<HTMLDivElement>(null);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);

  useEffect(() => {
    if (confirmingDeleteRoomId) {
      deleteConfirmationRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    }
  }, [confirmingDeleteRoomId]);

  useEffect(() => {
    if (confirmingDeleteFolder) {
      folderDeleteConfirmationRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    }
  }, [confirmingDeleteFolder]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) {
      return;
    }
    const previousFocus = page.ownerDocument
      .activeElement as HTMLElement | null;
    const requests = shareRequest;
    filterRef.current?.focus();
    return () => {
      requests.current++;
      if (
        previousFocus?.isConnected &&
        (page.contains(page.ownerDocument.activeElement) ||
          page.ownerDocument.activeElement === page.ownerDocument.body)
      ) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const controller = new ownerWindow.AbortController();
    const timeout = ownerWindow.setTimeout(() => controller.abort(), 10_000);
    void readCachedRooms().then((cached) => {
      if (alive && cached) {
        setRooms((current) => current ?? cached);
      }
    });
    void readCachedFolders().then((cached) => {
      if (alive && cached) {
        setFolders((current) => current ?? cached);
      }
    });
    const roomRequest = fetchRooms(controller.signal).then((result) => {
      if (alive) {
        setRooms((current) => result ?? current);
        setLoading(false);
      }
    });
    const folderRequest = fetchRoomFolders(controller.signal).then((result) => {
      if (alive) {
        setFolders((current) => result ?? current);
        setFoldersLoading(false);
      }
    });
    Promise.all([roomRequest, folderRequest]).finally(() =>
      ownerWindow.clearTimeout(timeout),
    );
    return () => {
      alive = false;
      controller.abort();
      ownerWindow.clearTimeout(timeout);
    };
  }, [ownerWindow, setRooms, setFolders]);

  useEffect(
    () => () => {
      if (copiedTimer.current) {
        ownerWindow.clearTimeout(copiedTimer.current);
      }
    },
    [ownerWindow],
  );

  const refreshRooms = async () => {
    setLoading(true);
    setFoldersLoading(true);
    const controller = new ownerWindow.AbortController();
    const timeout = ownerWindow.setTimeout(() => controller.abort(), 10_000);
    try {
      await Promise.all([
        fetchRooms(controller.signal).then((result) => {
          setRooms((current) => result ?? current);
          setLoading(false);
        }),
        fetchRoomFolders(controller.signal).then((folderResult) => {
          setFolders((current) => folderResult ?? current);
          setFoldersLoading(false);
          if (folderResult) {
            setSelectedFolderId((current) =>
              current === "all" ||
              current === "unfiled" ||
              folderResult.some((folder) => folder.id === current)
                ? current
                : "all",
            );
          }
        }),
      ]);
    } finally {
      ownerWindow.clearTimeout(timeout);
    }
  };

  const cancelFolder = () => {
    folderSubmission.current = true;
    setFolderEditor(null);
    setActionError(null);
    ownerWindow.requestAnimationFrame(() => {
      const target = pageRef.current?.querySelector<HTMLElement>(
        '[role="treeitem"][tabindex="0"]',
      );
      (target ?? filterRef.current)?.focus();
    });
  };

  const createFolder = (parentId: string) => {
    folderSubmission.current = false;
    setActionError(null);
    setSearch("");
    setSelectedFolderId(parentId || "all");
    setFolderEditor("create");
    setFolderName("");
    setFolderParentId(parentId);
    setConfirmingDeleteFolder(false);
  };

  const submitFolder = async () => {
    if (!folderEditor || folderSubmission.current || !folderName.trim()) {
      return;
    }
    folderSubmission.current = true;
    setFolderBusy(true);
    setActionError(null);
    const folder = await saveRoomFolder(
      folderName.trim(),
      folderEditor === "rename" ? selectedFolderId : undefined,
      folderParentId || null,
    );
    if (folder) {
      setFolders((current) => [
        ...(current ?? []).filter((entry) => entry.id !== folder.id),
        folder,
      ]);
      setSelectedFolderId(folder.id);
      setFolderEditor(null);
      setFolderName("");
    } else {
      setActionError(t("myRooms.folderSaveError"));
      folderSubmission.current = false;
      ownerWindow.requestAnimationFrame(() => folderInputRef.current?.focus());
    }
    setFolderBusy(false);
  };

  const removeFolder = async () => {
    setFolderBusy(true);
    setActionError(null);
    const deletedIds = getFolderDescendantIds(folders ?? [], selectedFolderId);
    if (await deleteRoomFolder(selectedFolderId)) {
      setFolders(
        (current) =>
          current?.filter((folder) => !deletedIds.has(folder.id)) ?? null,
      );
      setRooms(
        (current) =>
          current?.map((room) =>
            room.folderId && deletedIds.has(room.folderId)
              ? { ...room, folderId: undefined }
              : room,
          ) ?? null,
      );
      setSelectedFolderId("unfiled");
      setConfirmingDeleteFolder(false);
      setFolderEditor(null);
    } else {
      setActionError(t("myRooms.folderDeleteError"));
    }
    setFolderBusy(false);
  };

  const moveRoom = async (room: ServerRoomEntry, folderId: string) => {
    setFolderBusy(true);
    setActionError(null);
    if (await moveRoomToFolder(room, folderId || null)) {
      setRooms(
        (current) =>
          current?.map((entry) =>
            entry.roomId === room.roomId
              ? { ...entry, folderId: folderId || undefined }
              : entry,
          ) ?? null,
      );
    } else {
      setActionError(t("myRooms.moveError"));
    }
    setFolderBusy(false);
  };

  const moveFolder = async (folder: RoomFolder, parentId: string) => {
    if (getFolderDescendantIds(folders ?? [], folder.id).has(parentId)) {
      return;
    }
    setFolderBusy(true);
    setActionError(null);
    const updated = await saveRoomFolder(
      folder.name,
      folder.id,
      parentId || null,
    );
    if (updated) {
      setFolders(
        (current) =>
          current?.map((entry) =>
            entry.id === updated.id ? updated : entry,
          ) ?? null,
      );
      setSelectedFolderId(updated.id);
      setFolderEditor(null);
      setConfirmingDeleteFolder(false);
    } else {
      setActionError(t("myRooms.folderSaveError"));
    }
    setFolderBusy(false);
  };

  const editFolder = (folder: RoomFolder) => {
    folderSubmission.current = false;
    setActionError(null);
    setSearch("");
    setSelectedFolderId(folder.id);
    setFolderEditor("rename");
    setFolderName(folder.name);
    setFolderParentId(folder.parentId ?? "");
    setConfirmingDeleteFolder(false);
  };

  const flashCopied = (key: string) => {
    setCopied(key);
    if (copiedTimer.current) {
      ownerWindow.clearTimeout(copiedTimer.current);
    }
    copiedTimer.current = ownerWindow.setTimeout(() => setCopied(null), 1500);
  };

  const close = () => {
    closeRoomsPage(ownerWindow);
    onClose();
  };

  const stopSilently = () => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.stopCollaboration(false);
    }
  };

  // Paint a freshly joined room. startCollaboration() only resolves the
  // scene — unlike the initial boot path, nothing applies it to the canvas
  // for us (pushState doesn't fire hashchange, so App's handler never runs).
  const paintScene = (
    api: ExcalidrawImperativeAPI,
    scene: Awaited<ReturnType<NonNullable<CollabAPI>["startCollaboration"]>>,
  ) => {
    if (scene) {
      const currentElements = api.getSceneElementsIncludingDeleted();
      const nextElements = scene.elements;
      const alreadyInstalled =
        nextElements != null &&
        nextElements.length === currentElements.length &&
        nextElements.every(
          (element, index) => element === currentElements[index],
        );
      const currentState = api.getAppState();
      const restoredAppState = restoreAppState(scene.appState, currentState);
      const visibleElements = nextElements?.filter(
        (element) => !element.isDeleted,
      );
      const appState =
        scene.scrollToContent && visibleElements?.length
          ? zoomToFitBounds({
              appState: { ...currentState, ...restoredAppState },
              bounds: getCommonBounds(visibleElements),
              fit: "contain",
            }).appState
          : restoredAppState;
      if (
        alreadyInstalled &&
        Object.entries(scene.appState ?? {}).every(([key, value]) =>
          key === "zoom"
            ? currentState.zoom.value === appState.zoom.value
            : currentState[key as keyof typeof currentState] === value,
        ) &&
        currentState.scrollX === appState.scrollX &&
        currentState.scrollY === appState.scrollY &&
        currentState.zoom.value === appState.zoom.value
      ) {
        return;
      }
      api.updateScene({
        ...(alreadyInstalled ? {} : { elements: nextElements }),
        appState,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
  };

  const openRoom = async (room: { roomId: string; roomKey: string }) => {
    if (
      !collabAPI ||
      !excalidrawAPI ||
      transitionRef.current ||
      roomDeletionInFlight.current
    ) {
      return;
    }
    transitionRef.current = true;
    setTransitioning(true);
    setActionError(null);
    const previousElements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const previousState = excalidrawAPI.getAppState();
    const previousFiles = excalidrawAPI.getFiles();
    const previousURL = ownerWindow.location.href;
    try {
      // Hash navigation alone can't switch: startCollaboration() early-returns
      // while the old socket exists, so tear it down first (no confirm).
      stopSilently();
      // Clear the old room's canvas up front: the join below preserves
      // unsynced canvas content for offline recovery, which must never leak
      // across rooms.
      excalidrawAPI.updateScene({ elements: [] });
      ownerWindow.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId: room.roomId, roomKey: room.roomKey }),
      );
      const scene = await collabAPI.startCollaboration({
        roomId: room.roomId,
        roomKey: room.roomKey,
      });
      if (scene?.appState?.errorMessage) {
        throw new Error(t("roomDialog.error_network"));
      }
      paintScene(excalidrawAPI, scene);
      if (!collabAPI.isCollaborating()) {
        throw new Error(t("roomDialog.error_network"));
      }
      closeRoomsPage(ownerWindow);
      void refreshRooms();
    } catch {
      stopSilently();
      ownerWindow.history.replaceState({}, APP_NAME, previousURL);
      excalidrawAPI.addFiles(Object.values(previousFiles));
      excalidrawAPI.updateScene({
        elements: previousElements,
        appState: previousState,
      });
      setActionError(t("roomDialog.error_network"));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  };

  const createRoom = async () => {
    if (
      !collabAPI ||
      !excalidrawAPI ||
      transitionRef.current ||
      roomDeletionInFlight.current
    ) {
      return;
    }
    if (
      excalidrawAPI.getSceneElements().length > 0 &&
      !ownerWindow.confirm(t("myRooms.confirmEmptyRoom"))
    ) {
      return;
    }
    transitionRef.current = true;
    setTransitioning(true);
    const previousElements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const previousState = excalidrawAPI.getAppState();
    const previousFiles = excalidrawAPI.getFiles();
    const previousURL = ownerWindow.location.href;
    try {
      setActionError(null);
      stopSilently();
      // A new room starts empty, never as a copy of the current canvas:
      // startCollaboration(null) would otherwise seed the room from whatever
      // is on screen. Same wipe-before-switch as openRoom above (a previous
      // room's content survives on the server snapshot, solo work stays in
      // local browser storage).
      excalidrawAPI.updateScene({ elements: [] });
      await collabAPI.startCollaboration(null);
      if (collabAPI.isCollaborating()) {
        closeRoomsPage(ownerWindow);
        await refreshRooms();
      } else {
        throw new Error(t("myRooms.createError"));
      }
    } catch {
      stopSilently();
      ownerWindow.history.replaceState({}, APP_NAME, previousURL);
      excalidrawAPI.addFiles(Object.values(previousFiles));
      excalidrawAPI.updateScene({
        elements: previousElements,
        appState: previousState,
      });
      setActionError(t("myRooms.createError"));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  };

  const leaveSession = () => {
    stopSilently();
  };

  const submitRename = async (room: ServerRoomEntry, value: string) => {
    setEditingRoomId(null);
    if (await renameRoom(room.roomId, room.key, value.trim())) {
      refreshRooms();
    } else {
      setActionError(t("myRooms.renameError"));
    }
  };

  const confirmDelete = async (room: ServerRoomEntry) => {
    if (roomDeletionInFlight.current) {
      return;
    }
    roomDeletionInFlight.current = true;
    setDeletingRoom(true);
    setActionError(null);
    try {
      if (await deleteRoom(room.roomId, room.key)) {
        setConfirmingDeleteRoomId(null);
        setRooms(
          (current) =>
            current?.filter((entry) => entry.roomId !== room.roomId) ?? null,
        );
        const activeLink = appJotaiStore.get(activeRoomLinkAtom);
        if (
          activeLink &&
          getCollaborationLinkData(activeLink)?.roomId === room.roomId
        ) {
          stopSilently();
          ownerWindow.history.replaceState(
            {},
            APP_NAME,
            `${ownerWindow.location.pathname}${ownerWindow.location.search}`,
          );
        }
        if (sharingRoomId === room.roomId) {
          setSharingRoomId(null);
          setShareCode(null);
        }
      } else {
        setActionError(t("myRooms.deleteError"));
      }
    } finally {
      roomDeletionInFlight.current = false;
      setDeletingRoom(false);
    }
  };

  const toggleShare = async (room: ServerRoomEntry) => {
    const request = ++shareRequest.current;
    if (sharingRoomId === room.roomId) {
      setSharingRoomId(null);
      setShareCode(null);
      return;
    }
    setSharingRoomId(room.roomId);
    setShareCode(null);
    setShareCodeLoading(true);
    try {
      const resp = await fetch("/api/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: getRoomPageLink(ownerWindow, room) }),
      });
      const data = resp.ok ? await resp.json() : null;
      if (request !== shareRequest.current) {
        return;
      }
      if (resp.ok) {
        setShareCode(typeof data?.code === "string" ? data.code : null);
      } else {
        setShareCode(null);
      }
    } catch {
      if (request === shareRequest.current) {
        setShareCode(null);
      }
    } finally {
      if (request === shareRequest.current) {
        setShareCodeLoading(false);
      }
    }
  };

  const copyLink = async (room: ServerRoomEntry) => {
    try {
      await copyTextToSystemClipboard(getRoomPageLink(ownerWindow, room));
      flashCopied(`link:${room.roomId}`);
    } catch {
      setActionError(t("myRooms.copyError"));
    }
  };

  const copyCode = async (room: ServerRoomEntry) => {
    if (!shareCode) {
      return;
    }
    try {
      await copyTextToSystemClipboard(shareCode);
      flashCopied(`code:${room.roomId}`);
    } catch {
      setActionError(t("myRooms.copyError"));
    }
  };

  const currentRoom = activeRoomLink
    ? getCollaborationLinkData(activeRoomLink)
    : null;
  const collaborating = !!collabAPI?.isCollaborating();
  const selectedFolder = folders?.find(
    (folder) => folder.id === selectedFolderId,
  );
  const roomToDelete = rooms?.find(
    (room) => room.roomId === confirmingDeleteRoomId,
  );
  const folderTree = getFolderTree(folders ?? []);
  const selectFolder = (id: string) => {
    setSelectedFolderId(id);
    setFolderEditor(null);
    setConfirmingDeleteFolder(false);
  };
  const formatLastActive = (timestamp: number) => {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 1) {
      return t("myRooms.timeAgo.justNow");
    }
    if (minutes < 60) {
      return t("myRooms.timeAgo.minutes", { count: minutes });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
      return t("myRooms.timeAgo.hours", { count: hours });
    }
    return t("myRooms.timeAgo.days", { count: Math.floor(hours / 24) });
  };

  const explorerToolbar = (
    <>
      <button
        type="button"
        className="RoomsPage__explorerRoot"
        onClick={() => selectFolder("all")}
        aria-label={t("myRooms.allRooms")}
        title={
          selectedFolder
            ? folderTree.find((entry) => entry.folder.id === selectedFolder.id)
                ?.path
            : t("myRooms.allRooms")
        }
      >
        {chevronDownIcon}
        <span className="RoomsPage__workspaceName">
          {selectedFolder
            ? folderTree.find((entry) => entry.folder.id === selectedFolder.id)
                ?.path
            : t("myRooms.listTitle")}
        </span>
        <span className="RoomsPage__treeCount">{rooms?.length ?? 0}</span>
      </button>
      <button
        type="button"
        className="RoomsPage__actionButton"
        aria-label={t("myRooms.newFolder")}
        title={t("myRooms.newFolder")}
        disabled={folderBusy || transitioning || loading}
        onClick={() => createFolder(selectedFolder?.id ?? "")}
      >
        {LoadIcon}
        <span className="RoomsPage__iconPlus">+</span>
      </button>
      {selectedFolder && (
        <>
          <button
            type="button"
            className="RoomsPage__actionButton"
            aria-label={t("myRooms.renameFolder")}
            title={t("myRooms.renameFolder")}
            disabled={folderBusy || transitioning}
            onClick={() => editFolder(selectedFolder)}
          >
            {pencilIcon}
          </button>
          <button
            type="button"
            className="RoomsPage__actionButton"
            aria-label={t("myRooms.deleteFolder")}
            title={t("myRooms.deleteFolder")}
            disabled={folderBusy || transitioning}
            onClick={() => {
              setConfirmingDeleteFolder(true);
              setFolderEditor(null);
            }}
          >
            {TrashIcon}
          </button>
        </>
      )}
    </>
  );

  return (
    <div
      ref={pageRef}
      className="RoomsPage"
      role="complementary"
      aria-label={t("myRooms.title")}
      aria-busy={transitioning || folderBusy}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === KEYS.ESCAPE) {
          close();
        }
      }}
    >
      <div className="RoomsPage__inner" id="rooms-sidebar-content">
        <div className="RoomsPage__header">
          <h2 className="RoomsPage__title">{t("myRooms.explorer")}</h2>
          <div className="RoomsPage__actions">
            <button
              type="button"
              className="RoomsPage__actionButton"
              aria-label={t("myRooms.newEmptyRoom")}
              title={t("myRooms.newEmptyRoom")}
              onClick={createRoom}
              disabled={transitioning || !collabAPI || !excalidrawAPI}
            >
              {PlusIcon}
            </button>
            <button
              type="button"
              className="RoomsPage__actionButton"
              aria-label={t("myRooms.joinTitle")}
              title={t("myRooms.joinTitle")}
              aria-expanded={joinVisible}
              onClick={() => setJoinVisible((current) => !current)}
            >
              {LinkIcon}
            </button>
            {collaborating && (
              <button
                type="button"
                className="RoomsPage__actionButton"
                aria-label={t("myRooms.leaveSession")}
                title={t("myRooms.leaveSession")}
                onClick={leaveSession}
              >
                {playerStopFilledIcon}
              </button>
            )}
          </div>
        </div>

        {actionError && !folderEditor && (
          <div className="RoomsPage__error" role="alert">
            {actionError}
          </div>
        )}

        {joinVisible && (
          <div className="RoomsPage__join">
            <JoinRoom onJoin={openRoom} disabled={transitioning} />
          </div>
        )}

        <div className="RoomsPage__section">
          {roomToDelete && (
            <div
              className="RoomsPage__deleteConfirmation"
              ref={deleteConfirmationRef}
              role="alertdialog"
              aria-modal="false"
              aria-label={t("myRooms.delete")}
              aria-describedby="rooms-delete-message"
              onKeyDown={(event) => {
                if (event.key === KEYS.ESCAPE && !deletingRoom) {
                  event.stopPropagation();
                  setConfirmingDeleteRoomId(null);
                }
              }}
            >
              <p id="rooms-delete-message">
                {t("myRooms.confirmDeleteRoom", {
                  name: roomToDelete.name || roomToDelete.roomId,
                })}
              </p>
              <div className="RoomsPage__actions">
                <FilledButton
                  label={t("myRooms.delete")}
                  color="danger"
                  disabled={deletingRoom}
                  onClick={() => confirmDelete(roomToDelete)}
                />
                <FilledButton
                  label={t("myRooms.cancelFolder")}
                  variant="outlined"
                  disabled={deletingRoom}
                  onClick={() => {
                    setConfirmingDeleteRoomId(null);
                    setActionError(null);
                  }}
                />
              </div>
            </div>
          )}
          {!foldersLoading && folders === null && (
            <div className="RoomsPage__error" role="alert">
              {t("myRooms.foldersLoadingError")}
              <FilledButton label={t("myRooms.retry")} onClick={refreshRooms} />
            </div>
          )}
          {folders !== null && (
            <>
              {confirmingDeleteFolder && (
                <div
                  className="RoomsPage__folderToolbar"
                  ref={folderDeleteConfirmationRef}
                  role="alertdialog"
                  aria-modal="false"
                  aria-label={t("myRooms.deleteFolder")}
                  aria-describedby="rooms-delete-folder-message"
                  onKeyDown={(event) => {
                    if (event.key === KEYS.ESCAPE && !folderBusy) {
                      event.stopPropagation();
                      setConfirmingDeleteFolder(false);
                    }
                  }}
                >
                  <span id="rooms-delete-folder-message">
                    {t("myRooms.confirmDeleteFolder")}
                  </span>
                  <FilledButton
                    label={t("myRooms.deleteFolder")}
                    color="danger"
                    disabled={folderBusy}
                    onClick={removeFolder}
                  />
                  <FilledButton
                    label={t("myRooms.cancelFolder")}
                    variant="outlined"
                    disabled={folderBusy}
                    onClick={() => setConfirmingDeleteFolder(false)}
                  />
                </div>
              )}
            </>
          )}
          <input
            ref={filterRef}
            className="RoomsPage__filter"
            aria-label={t("myRooms.search")}
            placeholder={t("myRooms.search")}
            type="search"
            value={search}
            disabled={folderBusy}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          {loading && rooms === null && (
            <div className="RoomsPage__empty" role="status">
              {t("myRooms.loading")}
            </div>
          )}
          {!loading && rooms === null && (
            <div className="RoomsPage__error" role="alert">
              {t("myRooms.loadingError")}
              <FilledButton label={t("myRooms.retry")} onClick={refreshRooms} />
            </div>
          )}
          {rooms !== null && (
            <RoomExplorer
              toolbar={explorerToolbar}
              activeRoomId={currentRoom?.roomId}
              folderDraft={
                folderEditor === "create"
                  ? { parentId: folderParentId || undefined }
                  : undefined
              }
              editingFolderId={
                folderEditor === "rename" ? selectedFolderId : undefined
              }
              renderFolderEditor={() => (
                <div className="RoomsPage__folderEdit">
                  <input
                    ref={folderInputRef}
                    className="RoomsPage__editInput"
                    aria-label={t("myRooms.folderName")}
                    aria-invalid={!!actionError}
                    aria-describedby={
                      actionError ? "rooms-folder-error" : undefined
                    }
                    maxLength={64}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    disabled={folderBusy}
                    value={folderName}
                    onChange={(event) => {
                      setFolderName(event.currentTarget.value);
                      setActionError(null);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === KEYS.ENTER) {
                        event.preventDefault();
                        submitFolder();
                      } else if (event.key === KEYS.ESCAPE) {
                        event.preventDefault();
                        cancelFolder();
                      }
                    }}
                    onBlur={() => {
                      if (folderSubmission.current) {
                        return;
                      }
                      if (folderName.trim()) {
                        submitFolder();
                      } else {
                        cancelFolder();
                      }
                    }}
                  />
                  {actionError && (
                    <div
                      className="RoomsPage__folderEditError"
                      id="rooms-folder-error"
                      role="alert"
                    >
                      {actionError}
                    </div>
                  )}
                </div>
              )}
              folders={folders ?? []}
              rooms={rooms}
              search={search}
              selectedFolderId={selectedFolderId}
              disabled={
                folderBusy ||
                transitioning ||
                (loading && rooms === null) ||
                deletingRoom
              }
              onSelectFolder={selectFolder}
              onMoveRoom={moveRoom}
              onMoveFolder={moveFolder}
              onRenameFolder={editFolder}
              onRenameRoom={(room) => setEditingRoomId(room.roomId)}
              onOpenRoom={(room) => {
                if (currentRoom?.roomId !== room.roomId) {
                  openRoom({ roomId: room.roomId, roomKey: room.key });
                }
              }}
              renderContextMenu={({ folder, room }) => (
                <ContextMenu.Content
                  className="RoomsPage__contextMenu"
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {folder && (
                    <>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={folderBusy || transitioning}
                        onSelect={() => createFolder(folder.id)}
                      >
                        {t("myRooms.newFolder")}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={folderBusy || transitioning}
                        onSelect={() => editFolder(folder)}
                      >
                        {t("myRooms.renameFolder")}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={folderBusy || transitioning}
                        onSelect={() => {
                          selectFolder(folder.id);
                          setConfirmingDeleteFolder(true);
                        }}
                      >
                        {t("myRooms.deleteFolder")}
                      </ContextMenu.Item>
                    </>
                  )}
                  {room && (
                    <>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={transitioning || !collabAPI || !excalidrawAPI}
                        onSelect={() =>
                          openRoom({ roomId: room.roomId, roomKey: room.key })
                        }
                      >
                        {t("myRooms.open")}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={folderBusy || transitioning}
                        onSelect={() => setEditingRoomId(room.roomId)}
                      >
                        {t("myRooms.rename")}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={folderBusy || transitioning}
                        onSelect={() => toggleShare(room)}
                      >
                        {t("myRooms.share")}
                      </ContextMenu.Item>
                      <ContextMenu.Sub>
                        <ContextMenu.SubTrigger
                          className="RoomsPage__contextItem"
                          disabled={folderBusy || transitioning}
                        >
                          {t("myRooms.moveToFolder", {
                            name: room.name || room.roomId,
                          })}
                        </ContextMenu.SubTrigger>
                        <ContextMenu.SubContent className="RoomsPage__contextMenu">
                          <ContextMenu.Item
                            className="RoomsPage__contextItem"
                            onSelect={() => moveRoom(room, "")}
                          >
                            {t("myRooms.unfiled")}
                          </ContextMenu.Item>
                          {folderTree.map(({ folder: target, path }) => (
                            <ContextMenu.Item
                              key={target.id}
                              className="RoomsPage__contextItem"
                              onSelect={() => moveRoom(room, target.id)}
                            >
                              {path}
                            </ContextMenu.Item>
                          ))}
                        </ContextMenu.SubContent>
                      </ContextMenu.Sub>
                      <ContextMenu.Item
                        className="RoomsPage__contextItem"
                        disabled={folderBusy || transitioning}
                        onSelect={() => {
                          setEditingRoomId(null);
                          setConfirmingDeleteRoomId(room.roomId);
                        }}
                      >
                        {t("myRooms.delete")}
                      </ContextMenu.Item>
                    </>
                  )}
                </ContextMenu.Content>
              )}
              renderRoom={(room) => {
                const isActive = currentRoom?.roomId === room.roomId;
                const isEditing = editingRoomId === room.roomId;
                const isConfirmingDelete =
                  confirmingDeleteRoomId === room.roomId;
                const isSharing = sharingRoomId === room.roomId;
                return (
                  <div
                    key={room.roomId}
                    className={`RoomsPage__row${
                      isActive ? " RoomsPage__row--active" : ""
                    }${
                      isEditing || isConfirmingDelete || isSharing
                        ? " RoomsPage__row--busy"
                        : ""
                    }`}
                  >
                    <div className="RoomsPage__rowMain">
                      {isEditing ? (
                        <input
                          className="RoomsPage__editInput"
                          defaultValue={room.name ?? ""}
                          placeholder={t("myRooms.renamePlaceholder")}
                          aria-label={t("myRooms.renamePlaceholder")}
                          autoFocus
                          onKeyDown={(event) => {
                            if (event.key === KEYS.ENTER) {
                              submitRename(room, event.currentTarget.value);
                            } else if (event.key === KEYS.ESCAPE) {
                              event.stopPropagation();
                              setEditingRoomId(null);
                            }
                          }}
                          onBlur={(event) =>
                            submitRename(room, event.target.value)
                          }
                        />
                      ) : (
                        <button
                          type="button"
                          className="RoomsPage__rowLabel"
                          tabIndex={-1}
                          title={room.name || room.roomId}
                          disabled={transitioning}
                          onClick={() => {
                            if (!isActive) {
                              openRoom({
                                roomId: room.roomId,
                                roomKey: room.key,
                              });
                            }
                          }}
                        >
                          <span className="RoomsPage__rowId">
                            {room.name || room.roomId}
                          </span>
                        </button>
                      )}
                      <span className="RoomsPage__rowMeta">
                        {room.name && (
                          <span className="RoomsPage__rowSubId">
                            {room.roomId} ·{" "}
                          </span>
                        )}
                        {t("myRooms.lastActive")}{" "}
                        {formatLastActive(room.lastActiveAt)}
                        {room.hasScene && (
                          <span className="RoomsPage__badge">
                            {t("myRooms.hasScene")}
                          </span>
                        )}
                        {isActive && (
                          <span className="RoomsPage__badge RoomsPage__badge--active">
                            {t("myRooms.active")}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="RoomsPage__rowActions">
                      {folders !== null && folders.length > 0 && (
                        <FolderMenu
                          compact
                          label={t("myRooms.moveToFolder", {
                            name: room.name || room.roomId,
                          })}
                          value={room.folderId ?? ""}
                          disabled={folderBusy || transitioning || loading}
                          onChange={(value) => moveRoom(room, value)}
                          options={[
                            { value: "", label: t("myRooms.unfiled") },
                            ...folderTree.map(({ folder, path, depth }) => ({
                              value: folder.id,
                              label: path,
                              depth,
                            })),
                          ]}
                        />
                      )}
                      {!isEditing && (
                        <button
                          type="button"
                          className="RoomsPage__actionButton"
                          title={t("myRooms.rename")}
                          aria-label={t("myRooms.rename")}
                          disabled={transitioning || folderBusy}
                          onClick={() => {
                            setConfirmingDeleteRoomId(null);
                            setEditingRoomId(room.roomId);
                          }}
                        >
                          {pencilIcon}
                        </button>
                      )}
                      <button
                        type="button"
                        className="RoomsPage__actionButton"
                        title={t("myRooms.share")}
                        aria-label={t("myRooms.share")}
                        disabled={transitioning || folderBusy || deletingRoom}
                        onClick={() => toggleShare(room)}
                      >
                        {share}
                      </button>
                      <button
                        type="button"
                        className={`RoomsPage__actionButton RoomsPage__actionButton--delete${
                          isConfirmingDelete
                            ? " RoomsPage__actionButton--confirm"
                            : ""
                        }`}
                        title={t("myRooms.delete")}
                        aria-label={t("myRooms.delete")}
                        disabled={transitioning || folderBusy || deletingRoom}
                        onClick={() => {
                          setEditingRoomId(null);
                          setConfirmingDeleteRoomId(room.roomId);
                        }}
                      >
                        {TrashIcon}
                      </button>
                    </div>
                    {isSharing && (
                      <div className="RoomsPage__sharePanel">
                        <div className="RoomsPage__shareRow">
                          <TextField
                            label={t("myRooms.linkLabel")}
                            readonly
                            fullWidth
                            value={getRoomPageLink(ownerWindow, room)}
                          />
                          <FilledButton
                            size="large"
                            variant="icon"
                            label={
                              copied === `link:${room.roomId}`
                                ? t("myRooms.copied")
                                : t("myRooms.copyLink")
                            }
                            icon={copyIcon}
                            onClick={() => copyLink(room)}
                          />
                        </div>
                        <div className="RoomsPage__shareRow">
                          <TextField
                            label={t("myRooms.codeLabel")}
                            readonly
                            fullWidth
                            value={
                              shareCodeLoading
                                ? "…"
                                : shareCode ?? t("myRooms.shareError")
                            }
                          />
                          <FilledButton
                            size="large"
                            variant="icon"
                            label={
                              copied === `code:${room.roomId}`
                                ? t("myRooms.copied")
                                : t("myRooms.copyCode")
                            }
                            icon={LinkIcon}
                            onClick={() => copyCode(room)}
                            disabled={shareCodeLoading || !shareCode}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
