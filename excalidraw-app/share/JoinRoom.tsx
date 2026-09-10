import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { LinkIcon } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { KEYS } from "@excalidraw/common";
import { useState } from "react";

import { getCollaborationLinkData } from "../data";

// Accepts a full room link or a short code (resolved via /api/resolve).
// Reused by the Share dialog and the standalone Rooms page.
export const JoinRoom = ({
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
