import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  copyIcon,
  LinkIcon,
  playerPlayIcon,
  playerStopFilledIcon,
  share,
  shareIOS,
  shareWindows,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useExcalidrawContainer } from "@excalidraw/excalidraw/components/App";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { APP_NAME, KEYS, getFrame } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import { atom, useAtom, useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";
import { getCollaborationLinkData } from "../data";
import { fetchRooms, type ServerRoomEntry } from "../data/rooms";

import "./ShareDialog.scss";
import { QRCode } from "./QRCode";

import type { CollabAPI } from "../collab/Collab";

type OnExportToBackend = () => void;
type ShareDialogType = "share" | "collaborationOnly";

export const shareDialogStateAtom = atom<
  { isOpen: false } | { isOpen: true; type: ShareDialogType }
>({ isOpen: false });

const getShareIcon = () => {
  const navigator = window.navigator as any;
  const isAppleBrowser = /Apple/.test(navigator.vendor);
  const isWindowsBrowser = navigator.appVersion.indexOf("Win") !== -1;

  if (isAppleBrowser) {
    return shareIOS;
  } else if (isWindowsBrowser) {
    return shareWindows;
  }

  return share;
};

export type ShareDialogProps = {
  collabAPI: CollabAPI | null;
  handleClose: () => void;
  onExportToBackend: OnExportToBackend;
  type: ShareDialogType;
};

const ActiveRoomDialog = ({
  collabAPI,
  activeRoomLink,
  handleClose,
}: {
  collabAPI: CollabAPI;
  activeRoomLink: string;
  handleClose: () => void;
}) => {
  const { t } = useI18n();
  const [, setJustCopied] = useState(false);
  const timerRef = useRef<number>(0);
  const ref = useRef<HTMLInputElement>(null);
  const isShareSupported = "share" in navigator;
  const { onCopy, copyStatus } = useCopyStatus();
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const codeCopyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: activeRoomLink }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => alive && setRoomCode(d.code))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeRoomLink]);

  const copyRoomCode = async () => {
    if (!roomCode) {
      return;
    }
    try {
      await copyTextToSystemClipboard(roomCode);
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
    }
    codeCopyRef.current?.select();
  };

  const copyRoomLink = async () => {
    try {
      await copyTextToSystemClipboard(activeRoomLink);
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
    }

    setJustCopied(true);

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setJustCopied(false);
    }, 3000);

    ref.current?.select();
  };

  const shareRoomLink = async () => {
    try {
      await navigator.share({
        title: t("roomDialog.shareTitle"),
        text: t("roomDialog.shareTitle"),
        url: activeRoomLink,
      });
    } catch (error: any) {
      // Just ignore.
    }
  };

  return (
    <>
      <h3 className="ShareDialog__active__header">
        {t("labels.liveCollaboration").replace(/\./g, "")}
      </h3>
      <TextField
        defaultValue={collabAPI.getUsername()}
        placeholder="Your name"
        label="Your name"
        onChange={collabAPI.setUsername}
        onKeyDown={(event) => event.key === KEYS.ENTER && handleClose()}
      />
      <div className="ShareDialog__active__linkRow">
        <TextField
          ref={ref}
          label="Link"
          readonly
          fullWidth
          value={activeRoomLink}
        />
        {isShareSupported && (
          <FilledButton
            size="large"
            variant="icon"
            label="Share"
            icon={getShareIcon()}
            className="ShareDialog__active__share"
            onClick={shareRoomLink}
          />
        )}
        <FilledButton
          size="large"
          label={t("buttons.copyLink")}
          icon={copyIcon}
          status={copyStatus}
          onClick={() => {
            copyRoomLink();
            onCopy();
          }}
        />
      </div>
      <QRCode value={activeRoomLink} />

      {roomCode && (
        <div className="ShareDialog__roomCode">
          <TextField
            ref={codeCopyRef}
            label={t("roomDialog.roomCode")}
            readonly
            fullWidth
            value={roomCode}
          />
          <FilledButton
            size="large"
            variant="icon"
            label={t("roomDialog.roomCodeCopyAria")}
            icon={copyIcon}
            onClick={copyRoomCode}
          />
        </div>
      )}
      {roomCode && (
        <div className="ShareDialog__active__description">
          <p className="ShareDialog__roomCodeHint">
            {t("roomDialog.roomCodeHint")}
          </p>
        </div>
      )}

      <div className="ShareDialog__active__description">
        <p>
          <span
            role="img"
            aria-hidden="true"
            className="ShareDialog__active__description__emoji"
          >
            🔒{" "}
          </span>
          {t("roomDialog.desc_privacy")}
        </p>
        <p>{t("roomDialog.desc_exitSession")}</p>
      </div>

      <div className="ShareDialog__separator">
        <span>{t("myRooms.title")}</span>
      </div>

      <MyRooms />

      <div className="ShareDialog__active__actions">
        <FilledButton
          size="large"
          variant="outlined"
          color="danger"
          label={t("roomDialog.button_stopSession")}
          icon={playerStopFilledIcon}
          onClick={() => {
            trackEvent("share", "room closed");
            collabAPI.stopCollaboration();
            if (!collabAPI.isCollaborating()) {
              handleClose();
            }
          }}
        />
      </div>
    </>
  );
};

const ShareDialogPicker = (props: ShareDialogProps) => {
  const { t } = useI18n();

  const { collabAPI } = props;

  const startCollabJSX = collabAPI ? (
    <>
      <div className="ShareDialog__picker__header">
        {t("labels.liveCollaboration").replace(/\./g, "")}
      </div>

      <div className="ShareDialog__picker__description">
        <div style={{ marginBottom: "1em" }}>{t("roomDialog.desc_intro")}</div>
        {t("roomDialog.desc_privacy")}
      </div>

      <div className="ShareDialog__picker__button">
        <FilledButton
          size="large"
          label={t("roomDialog.button_startSession")}
          icon={playerPlayIcon}
          onClick={() => {
            trackEvent("share", "room creation", `ui (${getFrame()})`);
            collabAPI.startCollaboration(null);
          }}
        />
      </div>

      <div className="ShareDialog__separator">
        <span>{t("shareDialog.or")}</span>
      </div>

      <div className="ShareDialog__picker__description">
        {t("roomDialog.desc_joinIntro")}
      </div>

      <div className="ShareDialog__picker__button">
        <JoinRoom
          onJoin={(linkData) => {
            trackEvent("share", "room join", `ui (${getFrame()})`);
            window.history.pushState(
              {},
              APP_NAME,
              `${window.location.origin}${window.location.pathname}#room=${linkData.roomId},${linkData.roomKey}`,
            );
            collabAPI.startCollaboration(linkData);
            props.handleClose();
          }}
        />
      </div>

      <div className="ShareDialog__separator">
        <span>{t("myRooms.title")}</span>
      </div>

      <MyRooms />

      {props.type === "share" && (
        <div className="ShareDialog__separator">
          <span>{t("shareDialog.or")}</span>
        </div>
      )}
    </>
  ) : null;

  return (
    <>
      {startCollabJSX}

      {props.type === "share" && (
        <>
          <div className="ShareDialog__picker__header">
            {t("exportDialog.link_title")}
          </div>
          <div className="ShareDialog__picker__description">
            {t("exportDialog.link_details")}
          </div>

          <div className="ShareDialog__picker__button">
            <FilledButton
              size="large"
              label={t("exportDialog.link_button")}
              icon={LinkIcon}
              onClick={async () => {
                await props.onExportToBackend();
                props.handleClose();
              }}
            />
          </div>
        </>
      )}
    </>
  );
};

const JoinRoom = ({
  onJoin,
}: {
  onJoin: (linkData: { roomId: string; roomKey: string }) => void;
}) => {
  const { t } = useI18n();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isShortCode = (s: string) =>
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$|^[A-Z0-9]{6,10}$/i.test(s.trim());

  const join = async () => {
    if (!link.trim()) {
      setError(t("roomDialog.error_emptyLink"));
      return;
    }
    // Short code (e.g. "ABCD-EFGH") — resolve via /api/resolve (a fetch, NOT a
    // page navigation: the service worker would swallow a navigation-based
    // redirect and land on a blank canvas).
    if (isShortCode(link)) {
      try {
        const resp = await fetch(
          `${window.location.origin}/api/resolve/${link.trim().toUpperCase()}`,
          { cache: "no-store" },
        );
        if (!resp.ok) {
          setError(t("roomDialog.error_unknownCode"));
          return;
        }
        const data = await resp.json();
        const linkData = getCollaborationLinkData(data.url);
        if (!linkData) {
          setError(t("roomDialog.error_invalidLink"));
          return;
        }
        onJoin(linkData);
        return;
      } catch {
        setError(t("roomDialog.error_network"));
        return;
      }
    }
    try {
      const linkData = getCollaborationLinkData(link.trim());
      if (!linkData) {
        setError(t("roomDialog.error_invalidLink"));
        return;
      }
      onJoin(linkData);
    } catch {
      setError(t("roomDialog.error_invalidLink"));
    }
  };

  return (
    <div>
      <TextField
        label={t("roomDialog.joinLinkLabel")}
        fullWidth
        value={link}
        placeholder={t("roomDialog.joinLinkPlaceholder")}
        onChange={(value) => {
          setLink(value);
          setError(null);
        }}
        onKeyDown={(event) => event.key === KEYS.ENTER && join()}
      />
      {error && (
        <div style={{ color: "#e33", fontSize: "0.85em", marginTop: "0.4em" }}>
          {error}
        </div>
      )}
      <div className="ShareDialog__picker__button">
        <FilledButton
          size="large"
          label={t("roomDialog.button_joinSession")}
          icon={LinkIcon}
          onClick={join}
        />
      </div>
    </div>
  );
};

const MyRooms = () => {
  const { t } = useI18n();
  const { container } = useExcalidrawContainer();
  const [rooms, setRooms] = useState<ServerRoomEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  // the dialog unmounts when closed, so mounting == dialog opened
  useEffect(() => {
    let alive = true;
    fetchRooms().then((result) => {
      if (!alive) {
        return;
      }
      setRooms(result);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const ownerWindow = container?.ownerDocument.defaultView ?? window;
  const currentRoom = getCollaborationLinkData(ownerWindow.location.href);

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

  if (loading) {
    return <div className="ShareDialog__myRoomsEmpty">…</div>;
  }
  if (rooms === null) {
    return (
      <div className="ShareDialog__myRoomsError">
        {t("myRooms.loadingError")}
      </div>
    );
  }
  if (rooms.length === 0) {
    return (
      <div className="ShareDialog__myRoomsEmpty">{t("myRooms.empty")}</div>
    );
  }

  return (
    <div className="ShareDialog__myRoomsList">
      {rooms.map((room) => {
        const isActive = currentRoom?.roomId === room.roomId;
        return (
          <div
            key={room.roomId}
            title={room.roomId}
            className={`ShareDialog__myRoomsRow${
              isActive ? " ShareDialog__myRoomsRow--active" : ""
            }`}
            onClick={() => {
              if (isActive) {
                return;
              }
              ownerWindow.location.href = `${ownerWindow.location.origin}/#room=${room.roomId},${room.key}`;
            }}
          >
            <span className="ShareDialog__myRoomsRow__id">{room.roomId}</span>
            <span className="ShareDialog__myRoomsRow__meta">
              {t("myRooms.lastActive")} {formatLastActive(room.lastActiveAt)}
              {room.hasScene && (
                <span className="ShareDialog__myRoomsBadge">
                  {t("myRooms.hasScene")}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const ShareDialogInner = (props: ShareDialogProps) => {
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);

  return (
    <Dialog size="small" onCloseRequest={props.handleClose} title={false}>
      <div className="ShareDialog">
        {props.collabAPI && activeRoomLink ? (
          <ActiveRoomDialog
            collabAPI={props.collabAPI}
            activeRoomLink={activeRoomLink}
            handleClose={props.handleClose}
          />
        ) : (
          <ShareDialogPicker {...props} />
        )}
      </div>
    </Dialog>
  );
};

export const ShareDialog = (props: {
  collabAPI: CollabAPI | null;
  onExportToBackend: OnExportToBackend;
}) => {
  const [shareDialogState, setShareDialogState] = useAtom(shareDialogStateAtom);

  const { openDialog } = useUIAppState();

  useEffect(() => {
    if (openDialog) {
      setShareDialogState({ isOpen: false });
    }
  }, [openDialog, setShareDialogState]);

  if (!shareDialogState.isOpen) {
    return null;
  }

  return (
    <ShareDialogInner
      handleClose={() => setShareDialogState({ isOpen: false })}
      collabAPI={props.collabAPI}
      onExportToBackend={props.onExportToBackend}
      type={shareDialogState.type}
    />
  );
};
