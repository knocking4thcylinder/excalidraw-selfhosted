#!/bin/bash
# Reproducible APK builder (no gradle). Uses Android SDK cmdline-tools.
# Usage: APP_HOST=<deck>.<tailnet>.ts.net ./build.sh   → build/Excalidraw.apk (signed)
#   APP_HOST is remembered in .app-host, so later builds can omit it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

SDK_PREFIX=34              # build-tools/platform version
SDK_ROOT="$HERE/sdk"
BT="$SDK_ROOT/build-tools/35.0.0"
PLAT="$SDK_ROOT/platforms/android-34"

APP_HOST=${APP_HOST:-$(cat "$HERE/.app-host" 2>/dev/null || true)}
[[ "$APP_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "set APP_HOST to the Deck's MagicDNS name, e.g. APP_HOST=steamdeck.example.ts.net ./build.sh" >&2
  exit 1
}
echo "$APP_HOST" > "$HERE/.app-host"

# --- fetch Android SDK pieces if missing ---
if [ ! -x "$BT/aapt2" ]; then
  echo "== downloading Android cmdline-tools (one-time) =="
  mkdir -p "$SDK_ROOT/cmdline-tools"
  ZIP="$SDK_ROOT/cmdline-tools.zip"
  case "$(uname -s)" in
    Darwin) TOOLS_OS=mac ;;
    Linux)  TOOLS_OS=linux ;;
    *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  curl -fL -o "$ZIP" "https://dl.google.com/android/repository/commandlinetools-$TOOLS_OS-13114758_latest.zip"
  unzip -q -o "$ZIP" -d "$SDK_ROOT/cmdline-tools"
  rm "$ZIP"
  TOOLS="$SDK_ROOT/cmdline-tools/cmdline-tools"
  { yes || true; } | "$TOOLS/bin/sdkmanager" --sdk_root="$SDK_ROOT" --licenses >/dev/null
  "$TOOLS/bin/sdkmanager" --sdk_root="$SDK_ROOT" "platform-tools" \
      "build-tools;35.0.0" "platforms;android-$SDK_PREFIX" >/dev/null
fi

# --- signing key (generated once, kept local) ---
if [ ! -f "$HERE/excalidraw.keystore" ]; then
  keytool -genkeypair -keystore excalidraw.keystore -alias excalidraw \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass excalidraw -keypass excalidraw \
    -dname "CN=Excalidraw Selfhosted, O=k4c"
fi

APP="$HERE/app"
OUT="$HERE/build"
mkdir -p "$OUT"

echo "== compile for $APP_HOST =="
# the app is pinned to one origin; stamp it into the manifest and MainActivity
GEN="$OUT/gen"
mkdir -p "$GEN"
sed "s/@APP_HOST@/$APP_HOST/g" "$APP/src/main/AndroidManifest.xml" > "$GEN/AndroidManifest.xml"
sed "s/@APP_HOST@/$APP_HOST/g" "$APP/src/main/java/com/k4c/excalidraw/MainActivity.java" > "$GEN/MainActivity.java"
"$BT/aapt2" compile --dir "$APP/src/main/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" \
  --min-sdk-version 21 --target-sdk-version 34 \
  --manifest "$GEN/AndroidManifest.xml" \
  -I "$PLAT/android.jar" "$OUT/res.zip" --java "$OUT/src"
javac --release 8 -classpath "$PLAT/android.jar" \
  "$OUT/src/com/k4c/excalidraw/R.java" \
  "$GEN/MainActivity.java" \
  "$APP/src/main/java/com/k4c/excalidraw/BlobSaver.java" \
  -d "$OUT/classes"
mkdir -p "$OUT/dex"
cd "$OUT/classes" && zip -qr ../classes.jar . && cd "$HERE"
# primary: d8; fallback: dx from build-tools 30.0.3 (d8 8.2.2-dev has an NPE bug on
# classes carrying the NestHost attribute — dexer-level, not a code problem)
if ! "$BT/d8" --min-api 21 --lib "$PLAT/android.jar" "$OUT/classes.jar" --output "$OUT/dex" >/dev/null 2>>/tmp/d8err.log; then
  echo "== d8 failed (see /tmp/d8err.log), falling back to dx =="
  if [ ! -x "$SDK_ROOT/build-tools/30.0.3/dx" ]; then
    "$SDK_ROOT/cmdline-tools/cmdline-tools/bin/sdkmanager" --sdk_root="$SDK_ROOT" "build-tools;30.0.3" >/dev/null 2>&1
  fi
  "$SDK_ROOT/build-tools/30.0.3/dx" --min-sdk-version=21 --dex \
    --output="$OUT/dex/classes.dex" "$OUT/classes.jar"
fi
cd "$OUT/dex" && zip -qjuX ../base.apk classes.dex && cd "$HERE"

echo "== sign =="
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks excalidraw.keystore \
  --ks-pass pass:excalidraw --key-pass pass:excalidraw \
  --out build/Excalidraw.apk "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs build/Excalidraw.apk | head -3
echo "== done: build/Excalidraw.apk =="
