defmodule Whiteboard.Application do
  use Application

  def start(_type, _args) do
    database = Application.fetch_env!(:whiteboard, Whiteboard.Repo)[:database]
    File.mkdir_p!(Path.dirname(database))

    http = Application.fetch_env!(:whiteboard, :http)

    server =
      if http[:server],
        do: [{Bandit, plug: Whiteboard.Router, ip: http[:ip], port: http[:port]}],
        else: []

    children =
      [
        Whiteboard.Repo,
        {Ecto.Migrator, repos: [Whiteboard.Repo]},
        Whiteboard.Bootstrap
      ] ++ server

    Supervisor.start_link(children, strategy: :one_for_one, name: Whiteboard.Supervisor)
  end
end

defmodule Whiteboard.Bootstrap do
  use GenServer

  def start_link(options), do: GenServer.start_link(__MODULE__, options)

  def init(_options) do
    if directory = Application.get_env(:whiteboard, :legacy_data_dir) do
      Whiteboard.Import.run!(directory)
    end

    {:ok, nil}
  end
end
