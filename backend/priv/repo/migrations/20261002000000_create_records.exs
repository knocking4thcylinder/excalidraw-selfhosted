defmodule Whiteboard.Repo.Migrations.CreateRecords do
  use Ecto.Migration

  def change do
    create table(:records, primary_key: false) do
      add(:id, :text, primary_key: true)
      add(:kind, :text, null: false)
      add(:value, :map, null: false)
    end

    create(index(:records, [:kind]))
  end
end
