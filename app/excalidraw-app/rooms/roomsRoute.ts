// Hash-route helpers for the standalone Rooms page.
//
// The route is `#rooms`. It never collides with collab links: the collab
// matcher is anchored (^#room=<id>,<key>$), so "#rooms" never parses as
// a room and room links never parse as the route.
//
// Callers pass the relevant window explicitly (usually the canvas
// container's ownerDocument.defaultView) instead of using the global.
export const ROOMS_HASH = "#rooms";

export const isRoomsHash = (hash: string) => hash === ROOMS_HASH;

// Where to go back to when the page closes. Captured on open so Back/close
// restores the exact previous location (canvas or a room).
let returnHash: string | null = null;

export const openRoomsPage = (ownerWindow: Window) => {
  if (!isRoomsHash(ownerWindow.location.hash)) {
    returnHash = ownerWindow.location.hash;
  }
  if (!isRoomsHash(ownerWindow.location.hash)) {
    ownerWindow.location.hash = ROOMS_HASH;
  }
};

export const closeRoomsPage = (ownerWindow: Window) => {
  const fallback = returnHash;
  returnHash = null;
  // Only navigate when the page is still showing: callers that already moved
  // elsewhere (open/switch/create room) just drop the saved return hash.
  if (isRoomsHash(ownerWindow.location.hash)) {
    ownerWindow.location.hash =
      fallback && !isRoomsHash(fallback) ? fallback : "";
  }
};

export const getRoomPageLink = (
  ownerWindow: Window,
  room: { roomId: string; key: string },
) =>
  `${ownerWindow.location.origin}${ownerWindow.location.pathname}#room=${room.roomId},${room.key}`;
