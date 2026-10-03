import { vi } from "vitest";

import { Excalidraw } from "@excalidraw/excalidraw";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  withExcalidrawDimensions,
} from "@excalidraw/excalidraw/tests/test-utils";

import { AppSidebar } from "../components/AppSidebar";
import { fetchRoomFolders, fetchRooms } from "../data/rooms";
import { appJotaiStore } from "../app-jotai";
import { roomFoldersAtom, roomsRegistryAtom } from "../rooms/explorerState";

vi.mock("../collab/Collab", async () => {
  const { atom } = await import("../app-jotai");
  return { activeRoomLinkAtom: atom<string | null>(null) };
});

vi.mock("../data/rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/rooms")>()),
  fetchRooms: vi.fn(),
  fetchRoomFolders: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw/i18n", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@excalidraw/excalidraw/i18n")
  >();
  return { ...actual, useI18n: () => ({ t: actual.t, langCode: "en" }) };
});

beforeEach(() => {
  appJotaiStore.set(roomsRegistryAtom, null);
  appJotaiStore.set(roomFoldersAtom, null);
  vi.mocked(fetchRooms).mockResolvedValue([
    {
      roomId: "algebra",
      key: "key",
      name: "Algebra",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      hasScene: false,
    },
  ]);
  vi.mocked(fetchRoomFolders).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Rooms Explorer in the native sidebar", () => {
  it("opens from the existing sidebar button and uses native pin and close controls", async () => {
    const onStateChange = vi.fn();
    const { container } = await render(
      <Excalidraw>
        <AppSidebar
          collabAPI={null}
          excalidrawAPI={null}
          onClose={vi.fn()}
          onStateChange={onStateChange}
        />
      </Excalidraw>,
    );
    expect(container.querySelector(".RoomsPage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rooms Explorer" }));
    expect(
      await screen.findByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".sidebar")).toHaveLength(1);
    expect(
      container.querySelector(".RoomsPage")?.closest(".default-sidebar"),
    ).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Rooms Explorer" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(container.querySelector(".RoomsPage__rail")).toBeNull();
    await withExcalidrawDimensions({ width: 1920, height: 1080 }, async () => {
      fireEvent.click(await screen.findByTestId("sidebar-dock"));
      await waitFor(() =>
        expect(container.querySelector(".sidebar")).toHaveClass(
          "sidebar--docked",
        ),
      );
      fireEvent.click(screen.getByTestId("sidebar-close"));
      await waitFor(() =>
        expect(container.querySelector(".sidebar")).toBeNull(),
      );
    });
    expect(onStateChange).toHaveBeenLastCalledWith(null);
    expect(
      screen.getByRole("button", { name: "Rooms Explorer" }),
    ).toBeInTheDocument();
  });

  it("opens through the native API while retaining the library and canvas-search tabs", async () => {
    const { container } = await render(
      <Excalidraw>
        <AppSidebar
          collabAPI={null}
          excalidrawAPI={null}
          onClose={vi.fn()}
          onStateChange={vi.fn()}
        />
      </Excalidraw>,
    );
    await act(() =>
      window.h.app.toggleSidebar({
        name: "default",
        tab: "rooms",
        force: true,
      }),
    );
    expect(
      await screen.findByRole("treeitem", { name: "Algebra" }),
    ).toBeInTheDocument();
    await act(() =>
      window.h.app.toggleSidebar({
        name: "default",
        tab: "library",
        force: true,
      }),
    );
    expect(container.querySelectorAll(".sidebar")).toHaveLength(1);
    expect(screen.getByTestId("library")).toBeInTheDocument();
    await act(() =>
      window.h.app.toggleSidebar({
        name: "default",
        tab: "search",
        force: true,
      }),
    );
    expect(screen.getByTestId("search")).toBeInTheDocument();
    expect(container.querySelectorAll(".sidebar")).toHaveLength(1);
  });
});
