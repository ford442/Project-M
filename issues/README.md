# GitHub Issues for projectM + External Player Audio Bridge

These two files contain fully formatted, ready-to-paste GitHub issue content.

## How to Use

1. Go to https://github.com/projectM-visualizer/projectm/issues/new
2. Copy the entire contents of one of the files below into the issue body.
3. The title is already on the first line (GitHub will use it as the issue title when you paste).
4. Add appropriate labels, assignees, etc. after creation.

## Issues

- [01-flac-player-pcm-bridge.md](./01-flac-player-pcm-bridge.md)
  - For the existing (but broken) FLAC player sender.

- [02-mod-player-pcm-bridge.md](./02-mod-player-pcm-bridge.md)
  - For the MOD/XM player, which currently has no bridge at all.

## Supporting Materials (in this worktree)

- `patches/flac-player-bridge-upgrade-to-postmessage.diff`
- `patches/mod-player-projectm-audio-bridge-recommendation.md`
- `DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md` (full root cause + live bundle analysis)
- `html/projectm-core.html` (already contains the improved receiver + test helpers)

These were produced during the `diagnose-mod-flac` investigation.