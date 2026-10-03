defmodule Whiteboard.Store do
  import Ecto.Query
  alias Whiteboard.{Record, Repo}

  def get(kind, id) do
    case Repo.get(Record, "#{kind}:#{id}") do
      nil -> nil
      record -> record.value
    end
  end

  def all(kind) do
    Repo.all(from(record in Record, where: record.kind == ^kind))
    |> Map.new(fn record -> {String.replace_prefix(record.id, "#{kind}:", ""), record.value} end)
  end

  def put(kind, id, value) do
    Repo.insert!(%Record{id: "#{kind}:#{id}", kind: kind, value: value},
      on_conflict: [set: [value: value]],
      conflict_target: [:id]
    )

    value
  end

  def delete(kind, id) do
    Repo.delete_all(from(record in Record, where: record.id == ^"#{kind}:#{id}"))
  end

  def transaction(function) do
    {:ok, result} = Repo.transaction(function)
    result
  end
end
