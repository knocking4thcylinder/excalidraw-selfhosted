import { DropdownMenu } from "radix-ui";

import {
  checkIcon,
  chevronDownIcon,
} from "@excalidraw/excalidraw/components/icons";

export const FolderMenu = ({
  label,
  value,
  options,
  disabled,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; depth?: number }[];
  disabled: boolean;
  onChange: (value: string) => void;
  compact?: boolean;
}) => (
  <DropdownMenu.Root modal={false}>
    <DropdownMenu.Trigger
      type="button"
      className={`RoomsPage__select${
        compact ? " RoomsPage__select--move" : ""
      }`}
      aria-label={label}
      disabled={disabled}
    >
      <span>{options.find((option) => option.value === value)?.label}</span>
      {chevronDownIcon}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      className="RoomsPage__folderMenu"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      aria-label={label}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
        {options.map((option) => (
          <DropdownMenu.RadioItem
            key={option.value}
            value={option.value}
            className="RoomsPage__folderOption"
            style={{
              paddingInlineStart: `${
                0.5 + Math.min(option.depth ?? 0, 6) * 0.75
              }rem`,
            }}
          >
            <span className="RoomsPage__folderCheck">
              <DropdownMenu.ItemIndicator>
                {checkIcon}
              </DropdownMenu.ItemIndicator>
            </span>
            <span>{option.label}</span>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
);
