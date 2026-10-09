import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { appJotaiStore } from "../app-jotai";
import {
  cacheFolders,
  cacheRooms,
  readCachedFolders,
  readCachedRooms,
} from "../data/roomCache";
import { fetchRoomFolders, fetchRooms } from "../data/rooms";
import { roomFoldersAtom, roomsRegistryAtom } from "../rooms/explorerState";
import { useRoomRegistry } from "../rooms/useRoomRegistry";

import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

vi.mock("../data/rooms", () => ({
  fetchRooms: vi.fn(),
  fetchRoomFolders: vi.fn(),
}));
vi.mock("../data/roomCache", () => ({
  cacheFolders: vi.fn(),
  cacheRooms: vi.fn(),
  readCachedFolders: vi.fn(),
  readCachedRooms: vi.fn(),
}));

const room = (roomId: string): ServerRoomEntry => ({
  roomId,
  key: "key",
  createdAt: 1,
  lastActiveAt: 1,
  hasScene: false,
});

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

beforeEach(() => {
  appJotaiStore.set(roomsRegistryAtom, null);
  appJotaiStore.set(roomFoldersAtom, null);
  vi.mocked(fetchRooms).mockResolvedValue([]);
  vi.mocked(fetchRoomFolders).mockResolvedValue([]);
  vi.mocked(readCachedRooms).mockResolvedValue(null);
  vi.mocked(readCachedFolders).mockResolvedValue(null);
  vi.mocked(cacheRooms).mockResolvedValue();
  vi.mocked(cacheFolders).mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("room registry lifecycle", () => {
  it("hydrates cached collections before replacing them with server results", async () => {
    const rooms = deferred<ServerRoomEntry[] | null>();
    const folders = deferred<RoomFolder[] | null>();
    const cachedRooms = [room("cached")];
    const cachedFolders = [{ id: "cached", name: "Cached" }];
    vi.mocked(readCachedRooms).mockResolvedValue(cachedRooms);
    vi.mocked(readCachedFolders).mockResolvedValue(cachedFolders);
    vi.mocked(fetchRooms).mockReturnValue(rooms.promise);
    vi.mocked(fetchRoomFolders).mockReturnValue(folders.promise);
    const { result } = renderHook(() => useRoomRegistry(window));

    await waitFor(() =>
      expect(result.current.rooms.value).toEqual(cachedRooms),
    );
    expect(result.current.folders.value).toEqual(cachedFolders);
    expect(result.current.rooms.loading).toBe(true);
    await act(async () => {
      rooms.resolve([room("server")]);
      folders.resolve([]);
    });
    expect(result.current.rooms.value).toEqual([room("server")]);
    expect(result.current.folders.value).toEqual([]);
    expect(result.current.rooms.loading).toBe(false);
    expect(result.current.folders.loading).toBe(false);
    expect(cacheRooms).toHaveBeenLastCalledWith([room("server")]);
    expect(cacheFolders).toHaveBeenLastCalledWith([]);
  });

  it("does not overwrite a populated registry with a late cache read", async () => {
    const cached = deferred<ServerRoomEntry[] | null>();
    vi.mocked(readCachedRooms).mockReturnValue(cached.promise);
    const { result } = renderHook(() => useRoomRegistry(window));
    await waitFor(() => expect(result.current.rooms.loading).toBe(false));
    await act(async () => cached.resolve([room("stale")]));
    expect(result.current.rooms.value).toEqual([]);
  });

  it("skips preloading collections that are already populated", async () => {
    appJotaiStore.set(roomsRegistryAtom, [room("current")]);
    appJotaiStore.set(roomFoldersAtom, []);
    const { result } = renderHook(() => useRoomRegistry(window, true));
    await waitFor(() => expect(result.current.rooms.loading).toBe(false));
    expect(fetchRooms).not.toHaveBeenCalled();
    expect(fetchRoomFolders).not.toHaveBeenCalled();
    expect(result.current.rooms.value).toEqual([room("current")]);
  });

  it("does not replace a local edit with a stale preload response", async () => {
    const rooms = deferred<ServerRoomEntry[] | null>();
    vi.mocked(fetchRooms).mockReturnValue(rooms.promise);
    vi.mocked(readCachedRooms).mockResolvedValue([room("cached")]);
    const { result } = renderHook(() => useRoomRegistry(window, true));
    await waitFor(() =>
      expect(result.current.rooms.value).toEqual([room("cached")]),
    );
    act(() => result.current.rooms.setValue([room("edited")]));
    await act(async () => rooms.resolve([room("stale")]));
    expect(result.current.rooms.value).toEqual([room("edited")]);
  });

  it("allows a preload response to replace its own cached hydration", async () => {
    const rooms = deferred<ServerRoomEntry[] | null>();
    vi.mocked(fetchRooms).mockReturnValue(rooms.promise);
    vi.mocked(readCachedRooms).mockResolvedValue([room("cached")]);
    const { result } = renderHook(() => useRoomRegistry(window, true));
    await waitFor(() =>
      expect(result.current.rooms.value).toEqual([room("cached")]),
    );
    await act(async () => rooms.resolve([room("server")]));
    expect(result.current.rooms.value).toEqual([room("server")]);
    expect(cacheRooms).not.toHaveBeenCalled();
  });

  it("waits for the mounted document's window before loading", async () => {
    const { result, rerender } = renderHook(
      ({ mounted }) => useRoomRegistry(mounted ? window : null),
      { initialProps: { mounted: false } },
    );
    expect(fetchRooms).not.toHaveBeenCalled();
    expect(fetchRoomFolders).not.toHaveBeenCalled();
    rerender({ mounted: true });
    await waitFor(() => expect(result.current.rooms.loading).toBe(false));
    expect(fetchRooms).toHaveBeenCalledTimes(1);
    expect(fetchRoomFolders).toHaveBeenCalledTimes(1);
  });

  it("retains collections when refresh fails and returns fresh folder results", async () => {
    const { result } = renderHook(() => useRoomRegistry(window));
    await waitFor(() => expect(result.current.rooms.loading).toBe(false));
    act(() => result.current.rooms.setValue([room("local")]));
    vi.mocked(fetchRooms).mockResolvedValue(null);
    vi.mocked(fetchRoomFolders).mockResolvedValue([{ id: "new", name: "New" }]);
    await act(async () => {
      const [, folders] = await Promise.all([
        result.current.rooms.refresh(),
        result.current.folders.refresh(),
      ]);
      expect(folders).toEqual([{ id: "new", name: "New" }]);
    });
    expect(result.current.rooms.value).toEqual([room("local")]);
    expect(result.current.folders.value).toEqual([{ id: "new", name: "New" }]);
    expect(result.current.rooms.loading).toBe(false);
  });

  it("aborts timed-out requests while retaining cached data", async () => {
    vi.useFakeTimers();
    vi.mocked(readCachedRooms).mockResolvedValue([room("cached")]);
    vi.mocked(fetchRooms).mockImplementation(
      (signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(null));
        }),
    );
    const { result } = renderHook(() => useRoomRegistry(window));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(vi.mocked(fetchRooms).mock.calls[0][0]?.aborted).toBe(true);
    expect(result.current.rooms.value).toEqual([room("cached")]);
    expect(result.current.rooms.loading).toBe(false);
  });

  it("cancels unmounted requests and ignores their late results", async () => {
    const rooms = deferred<ServerRoomEntry[] | null>();
    vi.mocked(fetchRooms).mockReturnValue(rooms.promise);
    const { unmount } = renderHook(() => useRoomRegistry(window));
    const signal = vi.mocked(fetchRooms).mock.calls[0][0];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => rooms.resolve([room("stale")]));
    expect(appJotaiStore.get(roomsRegistryAtom)).toBeNull();
  });
});
