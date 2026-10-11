defmodule Whiteboard.Repo.Migrations.CreateRoomFiles do
  use Ecto.Migration

  def change do
    create table(:room_files, primary_key: false) do
      add(:room_id, :text, primary_key: true)
      add(:file_id, :text, primary_key: true)
      add(:data, :binary, null: false)
    end
  end
end
