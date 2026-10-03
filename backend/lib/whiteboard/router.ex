defmodule Whiteboard.Router do
  use Plug.Router
  require Logger
  alias Whiteboard.{API, Store}

  plug(:match)
  plug(:dispatch)

  match _ do
    conn = fetch_query_params(conn)

    case read_payload(conn) do
      {:ok, payload, conn} ->
        {status, body, headers} =
          Store.transaction(fn ->
            API.dispatch(
              conn.method,
              conn.path_info,
              payload,
              conn.query_params,
              Map.new(conn.req_headers)
            )
          end)

        Logger.info("API #{conn.method} #{conn.request_path} -> #{status}")

        conn =
          Enum.reduce(headers, put_resp_header(conn, "cache-control", "no-store"), fn
            {name, value}, conn -> put_resp_header(conn, name, value)
          end)

        encoded = if is_nil(body), do: "", else: Jason.encode!(body)

        conn
        |> put_resp_content_type("application/json")
        |> put_resp_header("content-length", Integer.to_string(byte_size(encoded)))
        |> send_resp(status, if(conn.method == "HEAD", do: "", else: encoded))

      {:error, status, conn} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(status, Jason.encode!(%{error: "invalid or oversized JSON body"}))
    end
  end

  defp read_payload(conn) when conn.method in ["POST", "PATCH", "DELETE"] do
    read_payload(conn, "", 0)
  end

  defp read_payload(conn), do: {:ok, %{}, conn}

  defp read_payload(conn, body, size) do
    case read_body(conn, length: 5 * 1024 * 1024, read_length: 64 * 1024) do
      {state, chunk, conn} when state in [:ok, :more] ->
        size = size + byte_size(chunk)

        cond do
          size > 5 * 1024 * 1024 ->
            {:error, 413, conn}

          state == :more ->
            read_payload(conn, body <> chunk, size)

          body <> chunk == "" ->
            {:ok, %{}, conn}

          true ->
            case Jason.decode(body <> chunk) do
              {:ok, payload} when is_map(payload) -> {:ok, payload, conn}
              _ -> {:error, 400, conn}
            end
        end

      {:error, _reason} ->
        {:error, 400, conn}
    end
  end
end
