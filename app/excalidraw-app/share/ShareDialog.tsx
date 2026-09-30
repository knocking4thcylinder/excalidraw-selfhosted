import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  copyIcon,
  playerPlayIcon,
  share,
  shareIOS,
  shareWindows,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { KEYS, getFrame } from "@excalidraw/common";
import { useEffect, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { atom, useAtom, useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";

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
  excalidrawAPI: ExcalidrawImperativeAPI | null;
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
    setRoomCode(null);
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
      onCopy();
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
      return;
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
          variant="icon"
          label={t("buttons.copyLink")}
          icon={copyIcon}
          status={copyStatus}
          onClick={copyRoomLink}
        />
      </div>

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
        <p className="ShareDialog__roomCodeHint">
          {t("roomDialog.roomCodeHint")}
        </p>
      )}

      <details className="ShareDialog__more">
        <summary>{t("shareDialog.moreOptions")}</summary>
        <TextField
          defaultValue={collabAPI.getUsername()}
          placeholder="Your name"
          label="Your name"
          onChange={collabAPI.setUsername}
          onKeyDown={(event) => event.key === KEYS.ENTER && handleClose()}
        />
        <QRCode value={activeRoomLink} />
      </details>
    </>
  );
};

const ShareDialogPicker = (props: ShareDialogProps) => {
  const { t } = useI18n();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);

  const { collabAPI } = props;

  // Picker does one job: start a session. Everything else (join by
  // link/code, room list, leaving) lives on the Rooms page (hamburger menu,
  // command palette) — not duplicated here.
  const startCollabJSX = collabAPI ? (
    <>
      <div className="ShareDialog__picker__header">
        {t("labels.liveCollaboration").replace(/\./g, "")}
      </div>

      <div className="ShareDialog__picker__description">
        {t("roomDialog.desc_intro")}
      </div>

      <div className="ShareDialog__picker__button">
        <FilledButton
          size="large"
          label={t("roomDialog.shareDrawing")}
          icon={playerPlayIcon}
          disabled={starting}
          status={starting ? "loading" : null}
          onClick={async () => {
            if (startingRef.current) {
              return;
            }
            startingRef.current = true;
            setStarting(true);
            setError(null);
            trackEvent("share", "room creation", `ui (${getFrame()})`);
            try {
              await collabAPI.startCollaboration(null);
              if (!collabAPI.isCollaborating()) {
                setError(t("myRooms.createError"));
              }
            } catch {
              setError(t("myRooms.createError"));
            } finally {
              startingRef.current = false;
              setStarting(false);
            }
          }}
        />
      </div>
      {error && <div role="alert">{error}</div>}
    </>
  ) : null;

  return <>{startCollabJSX}</>;
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
  excalidrawAPI: ExcalidrawImperativeAPI | null;
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
      excalidrawAPI={props.excalidrawAPI}
      onExportToBackend={props.onExportToBackend}
      type={shareDialogState.type}
    />
  );
};
