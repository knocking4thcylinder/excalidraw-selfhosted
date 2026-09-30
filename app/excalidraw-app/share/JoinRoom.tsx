import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { LinkIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { KEYS } from "@excalidraw/common";
import { useId, useRef, useState } from "react";

import { getCollaborationLinkData } from "../data";

import "./JoinRoom.scss";

// Accepts a full room link or a short code (resolved via /api/resolve).
// Reused by the Share dialog and the standalone Rooms page.
export const JoinRoom = ({
  onJoin,
  disabled = false,
}: {
  onJoin: (linkData: {
    roomId: string;
    roomKey: string;
  }) => void | Promise<void>;
  disabled?: boolean;
}) => {
  const { t } = useI18n();
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const joiningRef = useRef(false);
  const errorId = useId();

  const isShortCode = (s: string) =>
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$|^[A-Z0-9]{6,10}$/i.test(s.trim());

  const join = async () => {
    if (disabled || joiningRef.current) {
      return;
    }
    if (!link.trim()) {
      setError(t("roomDialog.error_emptyLink"));
      return;
    }
    joiningRef.current = true;
    setJoining(true);
    setError(null);
    try {
      if (isShortCode(link)) {
        const resp = await fetch(`/api/resolve/${link.trim().toUpperCase()}`, {
          cache: "no-store",
        });
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
        await onJoin(linkData);
        return;
      }
      const linkData = getCollaborationLinkData(link.trim());
      if (!linkData) {
        setError(t("roomDialog.error_invalidLink"));
        return;
      }
      await onJoin(linkData);
    } catch {
      setError(t("roomDialog.error_network"));
    } finally {
      joiningRef.current = false;
      setJoining(false);
    }
  };

  return (
    <div className="JoinRoom">
      <div className="JoinRoom__field">
        <TextField
          label={t("roomDialog.joinLinkLabel")}
          fullWidth
          disabled={disabled || joining}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          value={link}
          placeholder={t("roomDialog.joinLinkPlaceholder")}
          onChange={(value) => {
            setLink(value);
            setError(null);
          }}
          onKeyDown={(event) => event.key === KEYS.ENTER && join()}
        />
      </div>
      <FilledButton
        size="large"
        label={t("roomDialog.button_joinSession")}
        icon={LinkIcon}
        onClick={join}
        disabled={disabled || joining}
        status={joining ? "loading" : null}
      />
      {error && (
        <div className="JoinRoom__error" id={errorId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
};
