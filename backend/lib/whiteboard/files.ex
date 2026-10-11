defmodule Whiteboard.Files do
  @moduledoc "Encrypted image blobs for collab rooms, stored as opaque bytes."
  import Ecto.Query
  alias Whiteboard.{Repo, RoomFile}

  def get(room_id, file_id) do
    Repo.one(
      from(file in RoomFile,
        where: file.room_id == ^room_id and file.file_id == ^file_id,
        select: file.data
      )
    )
  end

  def put(room_id, file_id, data) do
    Repo.insert!(%RoomFile{room_id: room_id, file_id: file_id, data: data},
      on_conflict: [set: [data: data]],
      conflict_target: [:room_id, :file_id]
    )
  end

  def delete_room(room_id) do
    Repo.delete_all(from(file in RoomFile, where: file.room_id == ^room_id))
  end
end
