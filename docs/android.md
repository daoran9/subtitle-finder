# Android 版构建说明

Android 版基于 Capacitor 3 和 `capacitor-nodejs`。前端仍使用 `public/`，服务端由 `scripts/sync-mobile-nodejs.mjs` 打包成 Node 12.19 可运行的 `server.cjs`。

## 本机依赖

- JDK 11：建议放在非 C 盘目录，例如 `E:\Java\jdk-11`
- Android SDK：建议放在非 C 盘目录，例如 `E:\Android\Sdk`
- Gradle 缓存：建议放在仓库内的 `.gradle-cache`

本项目不要求把 SDK 或 Gradle 缓存放到 C 盘。

## 构建流程

先同步移动端 Node 服务和 Capacitor 资源：

```powershell
npm run sync:android
```

再构建 APK。

调试包：

```powershell
$env:JAVA_HOME='E:\Java\jdk-11'
$env:ANDROID_SDK_ROOT='E:\Android\Sdk'
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_USER_HOME='E:\Android\.android'
$env:GRADLE_USER_HOME='<仓库根目录>\.gradle-cache'
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_SDK_ROOT\platform-tools;$env:ANDROID_SDK_ROOT\cmdline-tools\latest\bin;$env:Path"

cd <仓库根目录>\android
.\gradlew.bat assembleDebug
```

生成文件：

```text
android\app\build\outputs\apk\debug\app-debug.apk
```

正式发布包：

```powershell
npm run build:android:release
```

生成文件：

```text
android\app\build\outputs\apk\release\app-release.apk
```

## 发布签名

正式 APK 需要本地签名文件。签名文件和密码不要提交到仓库。

本项目读取：

```text
android\keystore.properties
android\keystores\subtitle-finder-release.jks
```

仓库只保留 `android\keystore.properties.example`，真实 `keystore.properties` 和 `keystores` 目录已被忽略。

## 兼容范围

- Android 5.1 及以上。
- 包内包含 `armeabi-v7a`、`arm64-v8a`、`x86`、`x86_64` 原生库。
- 手机需要允许安装未知来源应用。
- 搜索、预览、下载依赖网络访问字幕源。
- 下载字幕前需要在系统弹窗里选择保存文件夹。
- 扫描本地视频前需要在系统弹窗里选择视频文件夹。
- 目录访问使用 Android Storage Access Framework，不申请全盘存储权限。

## 本机测试注意

debug 包和 release 包签名不同，不能互相覆盖安装。

如果手机已经安装过 debug 包，再测试 release 包，需要先卸载旧包。卸载会清掉应用数据，但已经保存到用户目录里的字幕文件不会随应用一起删除。

## 当前限制

- Android 版依赖系统文件夹授权。不同手机文件管理器界面可能不同。
- 调试 APK 使用调试签名，不适合直接给普通用户安装。
- `capacitor-nodejs` 内置 Node 12.19，所以服务端要先打包成 `public\nodejs\server.cjs`。
