import { atom } from "../app-jotai";

import type { RoomFolder, ServerRoomEntry } from "../data/rooms";

export const roomsRegistryAtom = atom<ServerRoomEntry[] | null>(null);
export const roomFoldersAtom = atom<RoomFolder[] | null>(null);
