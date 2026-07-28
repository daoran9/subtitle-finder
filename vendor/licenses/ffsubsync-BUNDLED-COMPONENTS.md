# ffsubsync 0.5.1 bundled components

SubtitleFinder redistributes the official `windows-x86_64.zip` release asset from ffsubsync 0.5.1 without modifying `ffsubsync.exe`.

- Release: https://github.com/smacke/ffsubsync/releases/tag/0.5.1
- Source commit: https://github.com/smacke/ffsubsync/tree/de310ac6944b8260431a48ee741e7063cec49b0f
- Build workflow run: https://github.com/smacke/ffsubsync/actions/runs/30068040997
- Archive SHA-256: `fa97d6923bb3444e61fb2d01ff649089f733798e01939bd5fa4c25a409323683`

The official Windows executable is a PyInstaller one-file application built with Python 3.11. The build log records these runtime packages. Their licenses remain with their respective projects.

| Component | Version in official build | License | Project |
| --- | --- | --- | --- |
| Python | 3.11.9 | PSF License | https://www.python.org/ |
| auditok | 0.1.5 | MIT | https://github.com/amsehili/auditok |
| chardet | 7.4.3 | 0BSD | https://github.com/chardet/chardet |
| charset-normalizer | 3.4.9 | MIT | https://github.com/jawah/charset_normalizer |
| faust-cchardet | 2.2.1 | MPL-1.1 or GPL-2.0-or-later or LGPL-2.1-or-later | https://github.com/faust-streaming/cChardet |
| ffmpeg-python | 0.2.0 | Apache-2.0 | https://github.com/kkroening/ffmpeg-python |
| future | 1.0.0 | MIT | https://github.com/PythonCharmers/python-future |
| markdown-it-py | 4.2.0 | MIT | https://github.com/executablebooks/markdown-it-py |
| mdurl | 0.1.2 | MIT | https://github.com/executablebooks/mdurl |
| numpy | 2.4.6 | BSD-3-Clause and bundled notices | https://github.com/numpy/numpy |
| pygments | 2.20.0 | BSD-2-Clause | https://github.com/pygments/pygments |
| pysubs2 | 1.8.1 | MIT | https://github.com/tkarabela/pysubs2 |
| rich | 15.0.0 | MIT | https://github.com/Textualize/rich |
| srt | 3.5.3 | MIT | https://github.com/cdown/srt |
| tqdm | 4.69.0 | MPL-2.0 and MIT | https://github.com/tqdm/tqdm |
| typing-extensions | 4.16.0 | PSF-2.0 | https://github.com/python/typing_extensions |
| webrtcvad-wheels | 2.0.14 | MIT, bundled WebRTC notices | https://github.com/daanzu/py-webrtcvad-wheels |
| colorama | 0.4.6 | BSD-3-Clause | https://github.com/tartley/colorama |

PyInstaller 6.21.0 was used as the packager. Its bootloader exception permits distribution of applications built with PyInstaller. Source and license: https://github.com/pyinstaller/pyinstaller/tree/v6.21.0

This inventory describes the official upstream executable. SubtitleFinder does not separately link these Python packages into its Electron code.
