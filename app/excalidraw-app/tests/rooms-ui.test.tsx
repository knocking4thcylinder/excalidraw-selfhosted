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
import {
  deleteRoomFolder,
  fetchRoomFolders,
  fetchRooms,
  moveRoomToFolder,
  saveRoomFolder,
} from "../data/rooms";
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
  fetchRoomFolders: vi.fn(),
  saveRoomFolder: vi.fn(),
  deleteRoomFolder: vi.fn(),
  moveRoomToFolder: vi.fn(),
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

const chooseFolder = async (label: string, option: string) => {
  fireEvent.keyDown(await screen.findByRole("button", { name: label }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: option }));
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
};

beforeEach(() => {
  vi.mocked(fetchRooms).mockResolvedValue(rooms);
  vi.mocked(fetchRoomFolders).mockResolvedValue([]);
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
  it("filters folders and applies search inside the selected folder", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
      rooms[1],
    ]);
    mountRooms();
    await chooseFolder("Folders", "School (1)");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Physics" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Physics" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("No rooms match");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    await chooseFolder("Folders", "Unfiled (1)");
    expect(screen.getByRole("button", { name: "Physics" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Algebra" }),
    ).not.toBeInTheDocument();
  });

  it("creates an empty folder and keeps it after remounting", async () => {
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "School",
    });
    const { unmount } = mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const name = screen.getByRole("textbox", { name: "Folder name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: " School " } });
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Folders" })).toHaveTextContent(
        "School (0)",
      ),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("School", undefined);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No rooms in this folder yet",
    );
    unmount();
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    mountRooms();
    await chooseFolder("Folders", "School (0)");
    expect(screen.getByRole("button", { name: "Folders" })).toHaveTextContent(
      "School (0)",
    );
  });

  it("renames a folder without changing room membership", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
    ]);
    vi.mocked(saveRoomFolder).mockResolvedValue({
      id: "school",
      name: "Classes",
    });
    mountRooms();
    await chooseFolder("Folders", "School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Rename folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "Classes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Folders" })).toHaveTextContent(
        "Classes (1)",
      ),
    );
    expect(saveRoomFolder).toHaveBeenCalledWith("Classes", "school");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
  });

  it("moves rooms to folders and back to Unfiled", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(true);
    mountRooms();
    const move = await screen.findByRole("button", {
      name: "Move Algebra to folder",
    });
    await chooseFolder("Move Algebra to folder", "School");
    await waitFor(() => expect(move).toHaveTextContent("School"));
    expect(moveRoomToFolder).toHaveBeenCalledWith(rooms[0], "school");
    await chooseFolder("Move Algebra to folder", "Unfiled");
    await waitFor(() => expect(move).toHaveTextContent("Unfiled"));
    expect(moveRoomToFolder).toHaveBeenLastCalledWith(
      { ...rooms[0], folderId: "school" },
      null,
    );
  });

  it("keeps the room in place when moving fails", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(moveRoomToFolder).mockResolvedValue(false);
    mountRooms();
    const move = await screen.findByRole("button", {
      name: "Move Algebra to folder",
    });
    await chooseFolder("Move Algebra to folder", "School");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't move the room",
    );
    expect(move).toHaveTextContent("Unfiled");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
  });

  it("confirms folder deletion and preserves its rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    vi.mocked(fetchRooms).mockResolvedValue([
      { ...rooms[0], folderId: "school" },
    ]);
    vi.mocked(deleteRoomFolder).mockResolvedValue(true);
    mountRooms();
    await chooseFolder("Folders", "School (1)");
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    expect(
      screen.getByText(/Its rooms will move to Unfiled/),
    ).toBeInTheDocument();
    expect(deleteRoomFolder).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Delete folder" })[1],
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Folders" })).toHaveTextContent(
        "Unfiled (1)",
      ),
    );
    expect(deleteRoomFolder).toHaveBeenCalledWith("school");
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Folders" }), {
      key: "ArrowDown",
    });
    expect(
      screen.queryByRole("menuitemradio", { name: "School (1)" }),
    ).not.toBeInTheDocument();
  });

  it("shows failed folder saves without losing the input", async () => {
    vi.mocked(saveRoomFolder).mockResolvedValue(null);
    mountRooms();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), {
      target: { value: "School" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save the folder",
    );
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue(
      "School",
    );
  });

  it("retries failed folder loads without hiding rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValueOnce(null);
    mountRooms();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load folders",
    );
    expect(screen.getByRole("button", { name: "Algebra" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Folders" }),
    ).toBeInTheDocument();
  });

  it("uses an in-app menu and closes it on Escape without closing rooms", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    const { onClose } = mountRooms();
    const trigger = await screen.findByRole("button", { name: "Folders" });
    expect(document.querySelector(".RoomsPage select")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Folders" });
    expect(
      screen.getByRole("menuitemradio", { name: "All rooms (2)" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("selects folders with keyboard navigation inside the page", async () => {
    vi.mocked(fetchRoomFolders).mockResolvedValue([
      { id: "school", name: "School" },
    ]);
    mountRooms();
    const trigger = await screen.findByRole("button", { name: "Folders" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("menuitemradio", {
      name: "All rooms (2)",
    });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "End" });
    const school = screen.getByRole("menuitemradio", { name: "School (0)" });
    await waitFor(() => expect(school).toHaveFocus());
    fireEvent.keyDown(school, { key: "Enter" });
    await waitFor(() => expect(trigger).toHaveTextContent("School (0)"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dismisses the folder menu when clicking outside it", async () => {
    mountRooms();
    const trigger = await screen.findByRole("button", { name: "Folders" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        screen.getByRole("menuitemradio", { name: "All rooms (2)" }),
      ).toHaveFocus(),
    );
    fireEvent.pointerDown(
      screen.getByRole("searchbox", { name: "Search rooms" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("dialog", { name: "My rooms" }),
    ).toBeInTheDocument();
  });

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
