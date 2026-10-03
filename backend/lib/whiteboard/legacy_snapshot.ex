defmodule Whiteboard.LegacySnapshot do
  def compact(scene, key) do
    if Map.get(scene, "patches", []) == [] do
      scene
    else
      secret = Base.url_decode64!(key, padding: false)
      elements = decrypt(scene, secret)
      unless is_list(elements), do: raise("invalid encrypted checkpoint")

      elements =
        Enum.reduce(scene["patches"], elements, fn patch, current ->
          apply_patch(current, decrypt(patch, secret))
        end)

      iv = :crypto.strong_rand_bytes(12)

      {ciphertext, tag} =
        :crypto.crypto_one_time_aead(:aes_128_gcm, secret, iv, Jason.encode!(elements), "", true)

      scene
      |> Map.delete("patches")
      |> Map.put("iv", Base.encode64(iv))
      |> Map.put("ciphertext", Base.encode64(ciphertext <> tag))
    end
  end

  defp decrypt(payload, secret) do
    iv = Base.decode64!(payload["iv"])
    encrypted = Base.decode64!(payload["ciphertext"])
    size = byte_size(encrypted) - 16
    if size < 0, do: raise("invalid encrypted scene")
    <<ciphertext::binary-size(size), tag::binary-size(16)>> = encrypted

    case :crypto.crypto_one_time_aead(:aes_128_gcm, secret, iv, ciphertext, "", tag, false) do
      :error -> raise("scene authentication failed during legacy export")
      plaintext -> Jason.decode!(plaintext)
    end
  end

  defp apply_patch(
         elements,
         %{"format" => 1, "upserts" => upserts, "removedIds" => removed} = patch
       )
       when is_list(upserts) and is_list(removed) do
    unless Enum.all?(elements ++ upserts, &(is_map(&1) && is_binary(&1["id"]))) &&
             Enum.all?(removed, &is_binary/1) &&
             length(Enum.uniq_by(upserts, & &1["id"])) == length(upserts) &&
             Enum.all?(upserts, &(&1["id"] not in removed)),
           do: raise("invalid encrypted scene patch")

    previous_ids = Enum.map(elements, & &1["id"])
    values = Map.new(elements ++ upserts, &{&1["id"], &1}) |> Map.drop(removed)

    order =
      Map.get(
        patch,
        "order",
        Enum.reject(previous_ids, &(&1 in removed)) ++
          (upserts |> Enum.map(& &1["id"]) |> Enum.reject(&(&1 in previous_ids)))
      )

    unless is_list(order) && Enum.all?(order, &is_binary/1) && length(order) == map_size(values) &&
             MapSet.new(order) == MapSet.new(Map.keys(values)),
           do: raise("invalid encrypted scene order")

    Enum.map(order, &Map.fetch!(values, &1))
  end

  defp apply_patch(_elements, _patch), do: raise("invalid encrypted scene patch")
end
