# RoomCanvas Android 漫游

把电脑上摆好的房间带到手机，横屏走一圈。扫码导入成功后，即使离开电脑所在的 Wi-Fi，也能重新打开上次的房间。

## 安装与导入

安装按下文构建的调试 APK；本仓库的 App 版本为 0.2.0，支持 Android API 26 及以上的 ARM 设备。已有安装的签名不同时，使用原签名构建更新可以保留本地房间。

| 我手上有…… | 怎么打开 |
| --- | --- |
| 电脑编辑器里的一份布置 | 先确认或取消当前调整，点“在手机中打开” → “生成二维码”。手机连接同一 Wi-Fi，扫码后选“在 Android App 中打开”。App 下载并校验完成后，点“开始漫游”。 |
| 一个房间模型文件 | 把自包含的 `.glb` 文件传到手机，在 App 中点“选择房间模型”，从文件选择器打开。电脑编辑器的“在手机中打开”也可直接下载房间 GLB。 |
| 已导入的分享 | 重新打开 App，点“开始漫游”。手机已保存的版本可以离线使用。 |

扫码后也可选“在浏览器中体验”。分享链接打不开时，先确认电脑服务仍在运行、手机与电脑同网，再检查弹窗里选的 Wi-Fi 地址。[手机分享与导入详解](../docs/MOBILE_HANDOFF.md)

## 在房间里走动

- 按左下方向键移动，在右半屏滑动转向。方向键正上方的“升／降”调节视点高度。速度可切换 0.5×、1×、2×，右上菜单可回到起点或结束漫游。
- 手动导入的 GLB 如果带有支持的开合动画，可以点柜门、窗或门试开合。电脑编辑器分享的是静态布置，门窗按关闭状态导出。
- 兼容设备可用华为 AR Engine 采集位姿。当前版本用方向键移动、滑屏转向，实际走动或转动手机不会改变漫游视角。拒绝相机权限后可直接用触屏漫游。若 AR Engine 服务未就绪，可在提示框中选“仅用方向键”继续。

## 从源码构建

| 项目 | 构建配置 |
| --- | --- |
| JDK | 使用 **JDK 21** 运行 Gradle。SceneView 依赖使用 Java 21 字节码；本项目的 Java 源码、目标字节码和 Kotlin JVM 目标均为 17。 |
| Android SDK | 安装平台 35 和 Build Tools 35.0.1。compileSdk 为 35，targetSdk 为 34，minSdk 为 26。 |
| Gradle | 使用仓库自带的 Wrapper，版本为 8.11.1。 |
| 支持的 ABI | arm64-v8a、armeabi-v7a。 |

配置好 JDK 和 SDK 后，从仓库根目录执行：

```bash
cd android-app
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

调试 APK 位于 `android-app/app/build/outputs/apk/debug/app-debug.apk`（相对仓库根目录）。连接已开启 USB 调试的设备后，可以在 `android-app/` 运行：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

构建版本见 [App 配置](app/build.gradle.kts)和 [Gradle Wrapper 配置](gradle/wrapper/gradle-wrapper.properties)。

## 房间照明与回归验证

可识别的房间使用顶灯、窗光和 HDR 环境。窗户按模型中的父子层级归组，独立窗帘、百叶、窗边座椅和室外背景不参与窗户包围盒；整扇窗的复合窗框不会仅因名字带 `Blind` 被排除。有窗时，局部灯预算至少留一个窗光名额。活动室仍使用原来的三盏顶灯和一盏窗光。

找不到可用灯具、HDR 尚未就绪或加载失败时，保留原主光、环境光和曝光；加载顺序不会改变最终照明。切换回无法识别的模型也会恢复原照明。模型自带的 glTF 灯保持由模型持有，不被自动灯清理。

JVM 测试覆盖窗户归组、遮帘排除和灯数预算。真实 Filament 测试还覆盖灯光／曝光恢复、两种加载顺序、带变换的 GLB 层级以及无模型 Activity 的加载行为。连接 ARM64 模拟器或设备后，在 `android-app/` 运行：

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:connectedDebugAndroidTest
```

2026-11-24 在 Android 14 ARM64 模拟器上通过 26 项 JVM 测试和 7 项照明 JNI 测试，与资源清理修复组合后的 15 项 JNI 测试也通过。最新活动室模型按层级合并后的窗框包围盒与原包围盒一致，灯光位置和功率保持不变。模拟器验证不能替代真机上对靠窗处和房间深处的亮度检查；不同房间的视觉标定仍需在目标设备确认。

## 在本机模拟器上调试

1. 在 macOS 的 Android SDK 中安装 Emulator 和 Platform Tools，准备名为 `RoomCanvas_API_34` 的 Android 14 ARM64 虚拟设备。使用自定义 SDK 路径时设置 `ANDROID_HOME`。
2. 首次使用时从仓库根目录创建 `output/android/`。每次要测试新构建时，先用下面的 `cp` 命令更新该目录中的 APK，再运行启动脚本。
3. 启动后若提示需要华为 AR Engine 服务，选“仅用方向键”。导入房间后点“开始漫游”。用鼠标按方向键或拖动右半屏，与触屏操作对应。

```bash
mkdir -p output/android
cp android-app/app/build/outputs/apk/debug/app-debug.apk output/android/RoomCanvas-Mobile-0.2.0-debug.apk
./scripts/start_android_emulator.command
```

测试扫码导入时，保持电脑服务运行，在模拟器浏览器打开分享链接，把电脑 IP 换为 `10.0.2.2`，保留分享端口（默认 7881）和 `/s/<分享标识>/`。真机使用电脑的局域网 IP。[启动脚本](../scripts/start_android_emulator.command) · [模拟器验证与真机边界](../docs/MOBILE_HANDOFF.md#本地-android-模拟器2026-11-23)
