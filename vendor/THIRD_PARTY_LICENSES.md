# Third-party notices

SubtitleFinder is licensed separately under the license in the repository root. The components and reference project below retain their own licenses.

## ffsubsync

- Project: https://github.com/smacke/ffsubsync
- Version: 0.5.1
- Source commit: `de310ac6944b8260431a48ee741e7063cec49b0f`
- License: MIT
- Use in SubtitleFinder: Windows subtitle synchronization
- Distribution: unmodified official `windows-x86_64.zip` executable
- Full text: repository `vendor/licenses/ffsubsync-LICENSE.txt`; packaged Windows app `resources/licenses/third-party/ffsubsync-LICENSE.txt`
- Official executable dependency inventory: repository `vendor/licenses/ffsubsync-BUNDLED-COMPONENTS.md`; packaged Windows app `resources/licenses/third-party/ffsubsync-BUNDLED-COMPONENTS.md`

## FFmpeg / BtbN FFmpeg Builds

- FFmpeg project: https://ffmpeg.org/
- FFmpeg source commit: `2aefd64d4840a8555016a59dd7ac826974a307fc`
- Build project: https://github.com/BtbN/FFmpeg-Builds
- Build tag: `autobuild-2026-07-27-14-00`
- Build tag commit: `8c736b2d6fe5da2a10a8896d01e53bfb0ca4f665`
- Variant: `win64-lgpl-shared-7.1`
- License: GNU LGPL version 3 or later; build scripts are MIT
- Use in SubtitleFinder: audio and subtitle-stream access for Windows synchronization
- Full FFmpeg license in the repository: `vendor/sync-tools/win32-x64/FFmpeg-LICENSE.txt`
- Full FFmpeg license in a packaged Windows app: `resources/sync-tools/FFmpeg-LICENSE.txt`
- Required GPLv3 companion text in the repository: `vendor/sync-tools/win32-x64/FFmpeg-GPLv3.txt`
- Required GPLv3 companion text in a packaged Windows app: `resources/sync-tools/FFmpeg-GPLv3.txt`
- Exact FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/2aefd64d4840a8555016a59dd7ac826974a307fc.tar.gz
- Exact build-scripts archive: https://github.com/BtbN/FFmpeg-Builds/archive/8c736b2d6fe5da2a10a8896d01e53bfb0ca4f665.tar.gz
- Build-script license in the repository: `vendor/licenses/BtbN-FFmpeg-Builds-LICENSE.txt`
- Build-script license in a packaged Windows app: `resources/licenses/third-party/BtbN-FFmpeg-Builds-LICENSE.txt`
- Replacement: the EXE and DLL files under `resources/sync-tools/ffmpeg-bin` are separate shared components and can be replaced with an interface-compatible LGPL build

## 7z-wasm / 7zz.wasm

- Project: https://github.com/use-strict/7z-wasm
- Package version: 1.2.0
- License: GNU LGPL 2.1 or later, plus the unRAR restriction
- Use in SubtitleFinder: list and extract 7z subtitle archives
- Full texts: repository `vendor/licenses/7z-wasm-LICENSE.txt` and `vendor/licenses/7z-wasm-unRAR-LICENSE.txt`; packaged app `resources/licenses/third-party/`

## node-unrar-js / unrar.wasm

- Project: https://github.com/YuJianrong/node-unrar.js
- Package version: 2.0.2
- JavaScript wrapper license: MIT
- Embedded unRAR restriction: the unRAR sources cannot be used to recreate the proprietary RAR compression algorithm
- Use in SubtitleFinder: list RAR entries and extract an existing subtitle file
- Full text: repository `vendor/licenses/node-unrar-js-LICENSE.md`; packaged app `resources/licenses/third-party/node-unrar-js-LICENSE.md`

## mediainfo.js

- Project: https://github.com/buzz/mediainfo.js
- Package version: 0.3.7
- License: BSD 2-Clause
- Use in SubtitleFinder: detect embedded subtitle tracks in local videos on Windows
- Full text: repository `vendor/licenses/mediainfo.js-LICENSE.txt`; packaged app `resources/licenses/third-party/mediainfo.js-LICENSE.txt`

## ChineseSubFinder

- Project: https://github.com/ChineseSubFinder/ChineseSubFinder
- Reference commit: `3335a9c95eec8e1664b7ab29368c34ce10f13575`
- License: MIT
- Referenced designs: Shooter four-part MD5 fingerprint, Xunlei three-part SHA-1 CID, media-library subtitle naming and batch matching workflow
- Full text: repository `vendor/licenses/ChineseSubFinder-LICENSE.txt`; packaged app `resources/licenses/third-party/ChineseSubFinder-LICENSE.txt`

## opencc-js / opencc-data

- Project: https://github.com/nk2028/opencc-js
- Package version: 1.4.1
- License: MIT and Apache-2.0 for bundled dictionary data
- Use in SubtitleFinder: convert subtitle text between Simplified and Traditional Chinese
- Full texts: repository `vendor/licenses/opencc-js-LICENSE.txt` and `vendor/licenses/opencc-js-THIRD_PARTY_LICENSES.md`; packaged app `resources/licenses/third-party/`

## fast-xml-parser

- Project: https://github.com/NaturalIntelligence/fast-xml-parser
- Package version: 5.10.1
- License: MIT
- Use in SubtitleFinder: parse local NFO metadata files
- Full text: repository `vendor/licenses/fast-xml-parser-LICENSE.txt`; packaged app `resources/licenses/third-party/fast-xml-parser-LICENSE.txt`

## iconv-lite / safer-buffer

- Project: https://github.com/ashtuchkin/iconv-lite
- Package version: 0.6.3
- License: MIT
- Use in SubtitleFinder: decode legacy GBK, Big5, UTF-16 and Japanese subtitle text; normalize downloaded subtitles to UTF-8
- Dependency: `safer-buffer` 2.1.2, MIT
- Full texts: repository `vendor/licenses/iconv-lite-LICENSE.md` and `vendor/licenses/safer-buffer-LICENSE.md`; packaged app `resources/licenses/third-party/`
