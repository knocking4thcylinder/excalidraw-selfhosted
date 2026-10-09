const SWATCH_COUNT = 8;
const TILTS = [-2.5, -1.5, -0.5, 1, 2];

// FNV-1a: stable across sessions and devices, so a room keeps its swatch.
const hash = (value: string) => {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
};

export const RoomTile = ({
  roomId,
  name,
  size = "regular",
}: {
  roomId: string;
  name?: string;
  size?: "regular" | "large";
}) => {
  const value = hash(roomId);
  const initial = name?.trim() ? Array.from(name.trim())[0] : "#";
  return (
    <span
      className={`RoomsPage__tile RoomsPage__tile--${size}`}
      data-swatch={value % SWATCH_COUNT}
      style={{ rotate: `${TILTS[(value >>> 3) % TILTS.length]}deg` }}
      aria-hidden="true"
    >
      {initial.toLocaleUpperCase()}
    </span>
  );
};
