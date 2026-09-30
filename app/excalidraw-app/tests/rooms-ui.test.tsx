import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore, Provider } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";
import { fetchRooms } from "../data/rooms";
import { RoomsPage } from "../rooms/RoomsPage";
import { JoinRoom } from "../share/JoinRoom";
import { ShareDialog, shareDialogStateAtom } from "../share/ShareDialog";

import type { CollabAPI } from "../collab/Collab";

vi.mock("@excalidraw/excalidraw/components/App", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@excalidraw/excalidraw/components/App")
  >()),
  useExcalidrawContainer: () => ({ container: document.body }),
}));

vi.mock("../collab/Collab", async () => {
  const { atom } = await import("../app-jotai");
  return { activeRoomLinkAtom: atom<string | null>(null) };
});

vi.mock("@excalidraw/excalidraw/i18n", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@excalidraw/excalidraw/i18n")
  >();
  return { ...actual, useI18n: () => ({ t: actual.t, langCode: "en" }) };
});

vi.mock("../data/rooms", () => ({
  fetchRooms: vi.fn(),
  renameRoom: vi.fn(),
  deleteRoom: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock(
  "@excalidraw/excalidraw/context/ui-appState",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@excalidraw/excalidraw/context/ui-appState")
    >()),
    useUIAppState: () => ({ openDialog: null }),
  }),
);

const rooms = [
  {
    roomId: "room-a",
    key: "key-a",
    name: "Algebra",
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    hasScene: true,
  },
  {
    roomId: "room-b",
    key: "key-b",
    name: "Physics",
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    hasScene: false,
  },
];

const mountRooms = (props: Partial<Parameters<typeof RoomsPage>[0]> = {}) => {
  const onClose = vi.fn();
  return {
    ...render(
      <RoomsPage
        collabAPI={null}
        excalidrawAPI={null}
        onClose={onClose}
        {...props}
      />,
    ),
    onClose,
  };
};

beforeEach(() => {
  vi.mocked(fetchRooms).mockResolvedValue(rooms);
  appJotaiStore.set(activeRoomLinkAtom, null);
  appJotaiStore.set(shareDialogStateAtom, { isOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("rooms UI", () => {
  it("focuses the overlay, traps Tab, closes on Escape, and restores focus", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { onClose, unmount } = mountRooms();
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    await screen.findByRole("button", { name: "Physics" });
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(
      screen.getAllByRole("button", { name: "Delete" }).at(-1),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("filters rooms by name and shows a no-results state", async () => {
    mountRooms();
    await screen.findByRole("button", { name: "Physics" });
    const search = screen.getByRole("searchbox", { name: "Search rooms" });
    fireEvent.change(search, { target: { value: "ALG" } });
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Physics" }),
    ).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByRole("status")).toHaveTextContent("No rooms match");
  });

  it("retries failed room-list loads", async () => {
    vi.mocked(fetchRooms).mockResolvedValueOnce(null);
    mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Algebra" }),
    ).toBeInTheDocument();
  });

  it("ignores share-code responses for a previously selected room", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: "BBBB-2222" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    mountRooms();
    await screen.findByRole("button", { name: "Algebra" });
    const shareButtons = screen.getAllByRole("button", { name: "Share" });
    fireEvent.click(shareButtons[0]);
    fireEvent.click(shareButtons[1]);
    expect(await screen.findByDisplayValue("BBBB-2222")).toBeInTheDocument();
    await act(async () => {
      resolveFirst({
        ok: true,
        json: async () => ({ code: "AAAA-1111" }),
      } as Response);
    });
    expect(screen.getByDisplayValue("BBBB-2222")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("AAAA-1111")).not.toBeInTheDocument();
  });

  it("restores the previous drawing when empty-room creation fails", async () => {
    const elements = [{ id: "local-drawing" }];
    const updateScene = vi.fn();
    const startCollaboration = vi
      .fn()
      .mockRejectedValue(new Error("unreachable"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mountRooms({
      collabAPI: {
        startCollaboration,
        isCollaborating: () => false,
      } as unknown as CollabAPI,
      excalidrawAPI: {
        getSceneElements: () => elements,
        getSceneElementsIncludingDeleted: () => elements,
        getAppState: () => ({}),
        getFiles: () => ({}),
        addFiles: vi.fn(),
        updateScene,
      } as unknown as ExcalidrawImperativeAPI,
    });
    await screen.findByRole("button", { name: "Algebra" });
    fireEvent.click(screen.getByRole("button", { name: "New empty room" }));
    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith({ elements, appState: {} }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't create the room",
    );
  });

  it("does not replace the drawing when empty-room creation is cancelled", async () => {
    const startCollaboration = vi.fn();
    const updateScene = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mountRooms({
      collabAPI: {
        startCollaboration,
        isCollaborating: () => false,
      } as unknown as CollabAPI,
      excalidrawAPI: {
        getSceneElements: () => [{ id: "local" }],
        updateScene,
      } as unknown as ExcalidrawImperativeAPI,
    });
    fireEvent.click(screen.getByRole("button", { name: "New empty room" }));
    await screen.findByRole("button", { name: "Algebra" });
    expect(startCollaboration).not.toHaveBeenCalled();
    expect(updateScene).not.toHaveBeenCalled();
  });
});

describe("join form", () => {
  it("labels its input and associates validation errors", () => {
    render(<JoinRoom onJoin={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Room link or code" });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("alert").id,
    );
  });

  it("blocks repeated requests while resolving a short code", async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<JoinRoom onJoin={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Room link or code" });
    fireEvent.change(input, { target: { value: "AAAA-1111" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Join room" })).toBeDisabled();
    await act(async () => {
      resolveRequest({ ok: false } as Response);
    });
    expect(
      screen.getByRole("button", { name: "Join room" }),
    ).not.toBeDisabled();
  });
});

describe("sharing the current drawing", () => {
  it("starts collaboration without clearing the existing canvas", async () => {
    const startCollaboration = vi.fn().mockResolvedValue(null);
    const updateScene = vi.fn();
    appJotaiStore.set(shareDialogStateAtom, { isOpen: true, type: "share" });
    render(
      <Provider store={appJotaiStore}>
        <ShareDialog
          collabAPI={
            {
              startCollaboration,
              isCollaborating: () => true,
            } as unknown as CollabAPI
          }
          excalidrawAPI={{ updateScene } as unknown as ExcalidrawImperativeAPI}
          onExportToBackend={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share this drawing" }));
    await waitFor(() => expect(startCollaboration).toHaveBeenCalledWith(null));
    expect(updateScene).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Share this drawing" }),
      ).not.toBeDisabled(),
    );
  });

  it("shows an error without clearing the canvas when starting fails", async () => {
    const startCollaboration = vi
      .fn()
      .mockRejectedValue(new Error("unreachable"));
    const updateScene = vi.fn();
    appJotaiStore.set(shareDialogStateAtom, { isOpen: true, type: "share" });
    render(
      <Provider store={appJotaiStore}>
        <ShareDialog
          collabAPI={
            {
              startCollaboration,
              isCollaborating: () => false,
            } as unknown as CollabAPI
          }
          excalidrawAPI={{ updateScene } as unknown as ExcalidrawImperativeAPI}
          onExportToBackend={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share this drawing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't create the room",
    );
    expect(updateScene).not.toHaveBeenCalled();
  });
});
