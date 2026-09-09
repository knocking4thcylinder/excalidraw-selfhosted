#!/bin/bash
# Reproducible APK builder (no gradle). Uses Android SDK cmdline-tools.
# Usage: ./build.sh   → build/Excalidraw.apk (signed)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

SDK_PREFIX=34              # build-tools/platform version
SDK_ROOT="$HERE/sdk"
BT="$SDK_ROOT/build-tools/34.0.0"
PLAT="$SDK_ROOT/platforms/android-34"

# --- fetch Android SDK pieces if missing ---
if [ ! -x "$BT/aapt2" ]; then
  echo "== downloading Android cmdline-tools (one-time) =="
  mkdir -p "$SDK_ROOT/cmdline-tools"
  ZIP="$SDK_ROOT/cmdline-tools.zip"
  curl -L -o "$ZIP" https://dl.google.com/android/repository/commandlinetools-mac-13114758_latest.zip
  unzip -q -o "$ZIP" -d "$SDK_ROOT/cmdline-tools"
  rm "$ZIP"
  TOOLS="$SDK_ROOT/cmdline-tools/cmdline-tools"
  yes | "$TOOLS/bin/sdkmanager" --sdk_root="$SDK_ROOT" --licenses >/dev/null
  "$TOOLS/bin/sdkmanager" --sdk_root="$SDK_ROOT" "platform-tools" \
      "build-tools;34.0.0" "platforms;android-$SDK_PREFIX" >/dev/null 2>&1 || true
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

echo "== compile =="
"$BT/aapt2" compile --dir "$APP/src/main/res" -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" \
  --min-sdk-version 21 --target-sdk-version 34 \
  --manifest "$APP/src/main/AndroidManifest.xml" \
  -I "$PLAT/android.jar" "$OUT/res.zip" --java "$OUT/src"
javac --release 11 -classpath "$PLAT/android.jar" \
  "$OUT/src/com/k4c/excalidraw/R.java" \
  "$APP/src/main/java/com/k4c/excalidraw/MainActivity.java" \
  -d "$OUT/classes"
mkdir -p "$OUT/dex"
"$BT/d8" --min-api 21 $(find "$OUT/classes" -name '*.class') --output "$OUT/dex" >/dev/null
cd "$OUT/dex" && zip -qjuX ../base.apk classes.dex && cd "$HERE"

echo "== sign =="
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks excalidraw.keystore \
  --ks-pass pass:excalidraw --key-pass pass:excalidraw \
  --out build/Excalidraw.apk "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs build/Excalidraw.apk | head -3
echo "== done: build/Excalidraw.apk =="
