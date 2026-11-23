#!/bin/bash
# Start the dedicated local test device, install the current APK and open RoomCanvas.
set -eu

ROOMCANVAS_PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOMCANVAS_SDK_ROOT="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ROOMCANVAS_AVD_NAME="RoomCanvas_API_34"
ROOMCANVAS_EMULATOR_PORT="${ROOMCANVAS_EMULATOR_PORT:-5580}"
ROOMCANVAS_DEVICE="emulator-$ROOMCANVAS_EMULATOR_PORT"
ROOMCANVAS_ADB="$ROOMCANVAS_SDK_ROOT/platform-tools/adb"
ROOMCANVAS_APK="$ROOMCANVAS_PROJECT_DIR/output/android/RoomCanvas-Mobile-0.2.0-debug.apk"
ROOMCANVAS_LOG_DIR="$HOME/Library/Logs/RoomCanvas"

if [ ! -x "$ROOMCANVAS_SDK_ROOT/emulator/emulator" ] || [ ! -x "$ROOMCANVAS_ADB" ]; then
  echo "未找到 Android Emulator：$ROOMCANVAS_SDK_ROOT" >&2
  exit 1
fi
if [ ! -f "$ROOMCANVAS_APK" ]; then
  echo "未找到安装包：$ROOMCANVAS_APK" >&2
  exit 1
fi

"$ROOMCANVAS_ADB" start-server
if "$ROOMCANVAS_ADB" -s "$ROOMCANVAS_DEVICE" get-state >/dev/null 2>&1; then
  ROOMCANVAS_RUNNING_AVD="$("$ROOMCANVAS_ADB" -s "$ROOMCANVAS_DEVICE" emu avd name | tr -d '\r' | head -1)"
  if [ "$ROOMCANVAS_RUNNING_AVD" != "$ROOMCANVAS_AVD_NAME" ]; then
    echo "端口 $ROOMCANVAS_EMULATOR_PORT 已被其他虚拟设备使用，请设置 ROOMCANVAS_EMULATOR_PORT。" >&2
    exit 1
  fi
else
  mkdir -p "$ROOMCANVAS_LOG_DIR"
  nohup "$ROOMCANVAS_SDK_ROOT/emulator/emulator" -avd "$ROOMCANVAS_AVD_NAME" \
    -port "$ROOMCANVAS_EMULATOR_PORT" -memory 2048 -cores 2 -gpu auto \
    -no-boot-anim -no-snapshot-save -camera-back none -camera-front none \
    >"$ROOMCANVAS_LOG_DIR/emulator.log" 2>&1 </dev/null &
  ROOMCANVAS_EMULATOR_PID=$!
fi

echo "正在启动 Android 14 虚拟设备…"
ROOMCANVAS_DEADLINE=$((SECONDS + 180))
until [ "$("$ROOMCANVAS_ADB" -s "$ROOMCANVAS_DEVICE" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  if [ "$SECONDS" -ge "$ROOMCANVAS_DEADLINE" ]; then
    echo "启动超时，请查看 $ROOMCANVAS_LOG_DIR/emulator.log" >&2
    exit 1
  fi
  sleep 1
done
"$ROOMCANVAS_ADB" -s "$ROOMCANVAS_DEVICE" install -r "$ROOMCANVAS_APK"
"$ROOMCANVAS_ADB" -s "$ROOMCANVAS_DEVICE" shell am start -n com.hausen3d.arviewer/.VrWalkthroughActivity
echo "RoomCanvas 已打开。若出现 AR Engine 提示，请选择“仅用方向键”。"
if [ -n "${ROOMCANVAS_EMULATOR_PID:-}" ]; then
  echo "关闭模拟器窗口后，本次启动任务将结束。"
  wait "$ROOMCANVAS_EMULATOR_PID"
fi
