defmodule Whiteboard.Repo do
  use Ecto.Repo, otp_app: :whiteboard, adapter: Ecto.Adapters.SQLite3
end

defmodule Whiteboard.Record do
  use Ecto.Schema

  @primary_key {:id, :string, autogenerate: false}
  schema "records" do
    field(:kind, :string)
    field(:value, :map)
  end
end

defmodule Whiteboard.RoomFile do
  use Ecto.Schema

  @primary_key false
  schema "room_files" do
    field(:room_id, :string, primary_key: true)
    field(:file_id, :string, primary_key: true)
    field(:data, :binary)
  end
end
