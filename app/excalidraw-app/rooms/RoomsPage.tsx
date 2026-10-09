import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  LinkIcon,
  PlusIcon,
  TrashIcon,
  copyIcon,
  share,
  LoadIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";
import { CaptureUpdateAction, zoomToFitBounds } from "@excalidraw/excalidraw";
import { getCommonBounds } from "@excalidraw/element";
import { useExcalidrawContainer } from "@excalidraw/excalidraw/components/App";
import { restoreAppState } from "@excalidraw/excalidraw/data/restore";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { APP_NAME, KEYS } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getCollaborationLink, getCollaborationLinkData } from "../data";
import {
  deleteRoom,
  deleteRoomFolder,
  moveRoomToFolder,
  renameRoom,
  saveRoomFolder,
  type RoomFolder,
  type ServerRoomEntry,
} from "../data/rooms";

import { JoinRoom } from "../share/JoinRoom";
import { appJotaiStore, useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";

import { closeRoomsPage, getRoomPageLink } from "./roomsRoute";
import { RoomExplorer } from "./RoomExplorer";
import {
  FolderContextMenu,
  FolderMoreMenu,
  RoomContextMenu,
  RoomMoreMenu,
} from "./RoomMenu";
import { RoomTile } from "./RoomTile";
import { getFolderDescendantIds, getFolderTree } from "./folderTree";
import { useRoomRegistry } from "./useRoomRegistry";
import "./RoomsPage.scss";

import type { ComponentProps } from "react";

import type { CollabAPI } from "../collab/Collab";

import type { FolderMenuActions, RoomMenuActions } from "./RoomMenu";

const ActionButton = ({
  label,
  className,
  ...props
}: ComponentProps<"button"> & { label: string }) => (
  <button
    type="button"
    className={`RoomsPage__actionButton${className ? ` ${className}` : ""}`}
    aria-label={label}
    title={label}
    {...props}
  />
);

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

  const {
    rooms: {
      value: rooms,
      setValue: setRooms,
      loading,
      refresh: refreshRoomList,
    },
    folders: {
      value: folders,
      setValue: setFolders,
      loading: foldersLoading,
      refresh: refreshFolderList,
    },
  } = useRoomRegistry(ownerWindow);
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
  const [selectedFolderId, setSelectedFolderId] = useState("all");
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

  useEffect(
    () => () => {
      if (copiedTimer.current) {
        ownerWindow.clearTimeout(copiedTimer.current);
      }
    },
    [ownerWindow],
  );

  const refreshRooms = async () => {
    await Promise.all([
      refreshRoomList(),
      refreshFolderList().then((folderResult) => {
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
  const folderConfirmOpen = confirmingDeleteFolder && folders !== null;
  const deleteConfirmOpen = !!roomToDelete || folderConfirmOpen;
  const folderTree = getFolderTree(folders ?? []);
  const folderOptions = [
    { value: "", label: t("myRooms.unfiled") },
    ...folderTree.map(({ folder, path, depth }) => ({
      value: folder.id,
      label: path,
      depth,
    })),
  ];
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

  const currentEntry: ServerRoomEntry | null =
    collaborating && currentRoom
      ? rooms?.find((room) => room.roomId === currentRoom.roomId) ?? {
          roomId: currentRoom.roomId,
          key: currentRoom.roomKey,
          createdAt: 0,
          lastActiveAt: Date.now(),
          hasScene: false,
        }
      : null;

  const startRoomDelete = (room: ServerRoomEntry) => {
    setEditingRoomId(null);
    setActionError(null);
    setConfirmingDeleteFolder(false);
    setConfirmingDeleteRoomId(room.roomId);
  };

  const roomMenuActions: RoomMenuActions = {
    folderOptions: folders?.length ? folderOptions : [],
    busy: folderBusy || transitioning || deletingRoom,
    canOpen: !!collabAPI && !!excalidrawAPI,
    onOpen: (room) => openRoom({ roomId: room.roomId, roomKey: room.key }),
    onRename: (room) => {
      setConfirmingDeleteRoomId(null);
      setEditingRoomId(room.roomId);
    },
    onShare: toggleShare,
    onMove: moveRoom,
    onDelete: startRoomDelete,
  };

  const renderSharePanel = (room: ServerRoomEntry) => (
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
          value={shareCodeLoading ? "…" : shareCode ?? t("myRooms.shareError")}
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
  );

  const folderMenuActions: FolderMenuActions = {
    busy: folderBusy || transitioning,
    onCreate: (folder) => createFolder(folder.id),
    onRename: editFolder,
    onDelete: (folder) => {
      setActionError(null);
      setConfirmingDeleteRoomId(null);
      selectFolder(folder.id);
      setConfirmingDeleteFolder(true);
    },
  };

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
        <header className="RoomsPage__header">
          <div className="RoomsPage__headerRow">
            <h2 className="RoomsPage__title">{t("myRooms.listTitle")}</h2>
            <div className="RoomsPage__actions">
              <button
                type="button"
                className="RoomsPage__newRoom"
                onClick={createRoom}
                disabled={transitioning || !collabAPI || !excalidrawAPI}
              >
                {PlusIcon}
                <span>{t("myRooms.newRoom")}</span>
              </button>
              <ActionButton
                label={t("myRooms.newFolder")}
                disabled={folderBusy || transitioning || loading}
                onClick={() => createFolder("")}
              >
                {LoadIcon}
                <span className="RoomsPage__iconPlus" aria-hidden="true">
                  {PlusIcon}
                </span>
              </ActionButton>
              <ActionButton
                className={
                  joinVisible ? "RoomsPage__actionButton--active" : undefined
                }
                label={t("myRooms.joinTitle")}
                aria-expanded={joinVisible}
                onClick={() => setJoinVisible((current) => !current)}
              >
                {LinkIcon}
              </ActionButton>
            </div>
          </div>
          <div className="RoomsPage__search">
            <span className="RoomsPage__searchIcon" aria-hidden="true">
              {searchIcon}
            </span>
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
          </div>
        </header>

        {actionError && !folderEditor && !deleteConfirmOpen && (
          <div className="RoomsPage__error" role="alert">
            {actionError}
          </div>
        )}

        {joinVisible && (
          <div className="RoomsPage__join">
            <JoinRoom onJoin={openRoom} disabled={transitioning} />
          </div>
        )}

        {currentEntry && (
          <section
            className="RoomsPage__current"
            aria-label={t("myRooms.currentRoom")}
          >
            <div className="RoomsPage__currentHead">
              <RoomTile
                roomId={currentEntry.roomId}
                name={currentEntry.name}
                size="large"
              />
              <div className="RoomsPage__currentText">
                <span className="RoomsPage__currentName">
                  {currentEntry.name || t("myRooms.untitled")}
                </span>
                <span className="RoomsPage__live">{t("myRooms.live")}</span>
              </div>
            </div>
            <div className="RoomsPage__currentActions">
              <button
                type="button"
                className={`RoomsPage__pill${
                  sharingRoomId === currentEntry.roomId
                    ? " RoomsPage__pill--active"
                    : ""
                }`}
                aria-expanded={sharingRoomId === currentEntry.roomId}
                disabled={transitioning || deletingRoom}
                onClick={() => toggleShare(currentEntry)}
              >
                {share}
                <span>{t("myRooms.share")}</span>
              </button>
              <button
                type="button"
                className="RoomsPage__pill RoomsPage__pill--quiet"
                disabled={transitioning}
                onClick={leaveSession}
              >
                {t("myRooms.leaveSession")}
              </button>
            </div>
            {sharingRoomId === currentEntry.roomId &&
              renderSharePanel(currentEntry)}
          </section>
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
              aria-busy={deletingRoom}
              onKeyDown={(event) => {
                if (event.key === KEYS.ESCAPE && !deletingRoom) {
                  event.stopPropagation();
                  setConfirmingDeleteRoomId(null);
                  setActionError(null);
                }
              }}
            >
              <div className="RoomsPage__confirmHead">
                <span className="RoomsPage__confirmIcon" aria-hidden="true">
                  {TrashIcon}
                </span>
                <span className="RoomsPage__confirmTitle">
                  {t("myRooms.delete")}
                </span>
                <span
                  className="RoomsPage__confirmTarget"
                  title={roomToDelete.name || roomToDelete.roomId}
                >
                  {roomToDelete.name || roomToDelete.roomId}
                </span>
              </div>
              <p id="rooms-delete-message">
                {t("myRooms.confirmDeleteRoom", {
                  name: roomToDelete.name || roomToDelete.roomId,
                })}
              </p>
              {actionError && (
                <div className="RoomsPage__confirmError" role="alert">
                  {actionError}
                </div>
              )}
              <div className="RoomsPage__confirmActions">
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
              {folderConfirmOpen && (
                <div
                  className="RoomsPage__deleteConfirmation"
                  ref={folderDeleteConfirmationRef}
                  role="alertdialog"
                  aria-modal="false"
                  aria-label={t("myRooms.deleteFolder")}
                  aria-describedby="rooms-delete-folder-message"
                  aria-busy={folderBusy}
                  onKeyDown={(event) => {
                    if (event.key === KEYS.ESCAPE && !folderBusy) {
                      event.stopPropagation();
                      setConfirmingDeleteFolder(false);
                      setActionError(null);
                    }
                  }}
                >
                  <div className="RoomsPage__confirmHead">
                    <span className="RoomsPage__confirmIcon" aria-hidden="true">
                      {TrashIcon}
                    </span>
                    <span className="RoomsPage__confirmTitle">
                      {t("myRooms.deleteFolder")}
                    </span>
                    {selectedFolder && (
                      <span
                        className="RoomsPage__confirmTarget"
                        title={selectedFolder.name}
                      >
                        {selectedFolder.name}
                      </span>
                    )}
                  </div>
                  <p id="rooms-delete-folder-message">
                    {t("myRooms.confirmDeleteFolder")}
                  </p>
                  {actionError && (
                    <div className="RoomsPage__confirmError" role="alert">
                      {actionError}
                    </div>
                  )}
                  <div className="RoomsPage__confirmActions">
                    <FilledButton
                      label={t("myRooms.deleteFolder")}
                      color="danger"
                      disabled={folderBusy}
                      onClick={() => removeFolder()}
                    />
                    <FilledButton
                      label={t("myRooms.cancelFolder")}
                      variant="outlined"
                      disabled={folderBusy}
                      onClick={() => {
                        setConfirmingDeleteFolder(false);
                        setActionError(null);
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
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
              renderFolderActions={(folder) => (
                <FolderMoreMenu
                  folder={folder}
                  actions={folderMenuActions}
                  disabled={folderBusy || transitioning}
                />
              )}
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
              renderContextMenu={({ folder, room }) =>
                room ? (
                  <RoomContextMenu room={room} actions={roomMenuActions} />
                ) : folder ? (
                  <FolderContextMenu
                    folder={folder}
                    actions={folderMenuActions}
                  />
                ) : null
              }
              renderRoom={(room) => {
                const isActive = currentRoom?.roomId === room.roomId;
                const isEditing = editingRoomId === room.roomId;
                const isConfirmingDelete =
                  confirmingDeleteRoomId === room.roomId;
                const isSharing =
                  sharingRoomId === room.roomId &&
                  currentEntry?.roomId !== room.roomId;
                const lastActive = formatLastActive(room.lastActiveAt);
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
                    <RoomTile roomId={room.roomId} name={room.name} />
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
                          aria-label={room.name || room.roomId}
                          title={`${room.name || room.roomId}\n${t(
                            "myRooms.lastActive",
                          )} ${lastActive}`}
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
                          <span
                            className={`RoomsPage__rowName${
                              room.name ? "" : " RoomsPage__rowName--untitled"
                            }`}
                          >
                            {room.name || t("myRooms.untitled")}
                          </span>
                          <span className="RoomsPage__rowMeta">
                            {isActive ? (
                              <span className="RoomsPage__live">
                                {t("myRooms.live")}
                              </span>
                            ) : (
                              <span>{lastActive}</span>
                            )}
                          </span>
                        </button>
                      )}
                    </div>
                    {!isEditing && (
                      <div className="RoomsPage__rowActions">
                        <ActionButton
                          className={
                            isSharing
                              ? "RoomsPage__actionButton--active"
                              : undefined
                          }
                          label={t("myRooms.share")}
                          aria-expanded={isSharing}
                          disabled={transitioning || folderBusy || deletingRoom}
                          onClick={() => toggleShare(room)}
                        >
                          {share}
                        </ActionButton>
                        <RoomMoreMenu
                          room={room}
                          actions={roomMenuActions}
                          disabled={transitioning || deletingRoom}
                        />
                      </div>
                    )}
                    {isSharing && renderSharePanel(room)}
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
