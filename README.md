# FFmpeg Source for Neonvix IPTV Player

Neonvix IPTV Player for Windows is distributed through the
[Microsoft Store](https://apps.microsoft.com/detail/9NMT6305CGSH). It includes an
unmodified FFmpeg build (BtbN `win64-lgpl-shared`), which is licensed under the
GNU Lesser General Public License version 3 or later.

This repository publishes the **complete corresponding source** for that FFmpeg
build. Each [release](https://github.com/xbabak/neonvix-ffmpeg-source/releases)
matches one Neonvix version and contains:

- `neonvix-ffmpeg-source-<version>.tar.gz`: the exact FFmpeg source snapshot,
  the BtbN build scripts and patches, the source of every library built into it,
  and a `SOURCE_MANIFEST.json` listing each file with its SHA-256 hash.
- `ffmpeg-<version>-win64-lgpl-shared-<branch>.zip`: the exact FFmpeg runtime
  archive that Neonvix ships.
- `.sha256` checksum files for both archives.

Neonvix's own application code is proprietary and is not published here. It runs
FFmpeg as a separate program and does not modify FFmpeg.

Questions: [support@neonvix.com](mailto:support@neonvix.com)

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.