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

// The route only opens the sidebar (bookmarks, shortcuts); closing it drops
// the hash. Callers that already navigated elsewhere are left alone.
export const closeRoomsPage = (ownerWindow: Window) => {
  if (isRoomsHash(ownerWindow.location.hash)) {
    ownerWindow.location.hash = "";
  }
};

export const getRoomPageLink = (
  ownerWindow: Window,
  room: { roomId: string; key: string },
) =>
  `${ownerWindow.location.origin}${ownerWindow.location.pathname}#room=${room.roomId},${room.key}`;
