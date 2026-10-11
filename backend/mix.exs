defmodule Whiteboard.MixProject do
  use Mix.Project

  def project do
    [app: :whiteboard, version: "0.1.0", elixir: "~> 1.18", deps: deps()]
  end

  def application do
    [extra_applications: [:logger, :crypto], mod: {Whiteboard.Application, []}]
  end

  defp deps do
    [
      {:plug, "~> 1.16"},
      {:bandit, "~> 1.6"},
      {:ecto_sql, "~> 3.14"},
      {:ecto_sqlite3, "~> 0.25.0"},
      {:jason, "~> 1.4"}
    ]
  end
end
