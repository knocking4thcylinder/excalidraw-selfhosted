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
