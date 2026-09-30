# Folder Suggest for Eagle

An Eagle plugin that learns how you sort videos into folders and suggests the right folder for any
video while you browse. One click in Eagle's sidebar (or one key on the Sort page) moves it there,
with the folders' auto-tags swapped and Undo always available.

## How it works

1. **Fingerprints.** Each video's Eagle thumbnail goes through the image body of
   [PixAI Tagger v0.9](https://huggingface.co/pixai-labs/pixai-tagger-v0.9) (EVA02-Large, trained on
   anime/3D character art) on the GPU through DirectML: a 1024-number fingerprint, 44 ms per video.
   Fingerprints are stored per library (1 KB each).
2. **Learning.** A weighted ridge classifier over the fingerprints of the videos already in your
   folders, solved in closed form in about two seconds, relearned after moves.
3. **Title check.** When a video's title names one of the folders ("Tifa Lockhart - FF" → "tifa
   lockhart"), that folder goes first; the model orders the rest.
4. **"Sure".** A tenth of every folder is held back while learning to measure how often the first pick
   is right, and to pick the confidence at which suggestions are right at least 90% of the time
   (Settings). Green = sure.
5. **Already-sorted videos** are judged by the rest of the library (exact leave-one-out), so the panel
   can also say "looks right" or point at a better folder while you browse sorted videos.

## Using it

- **Sidebar panel (Inspector).** Select a video in Eagle: the Folder Suggest panel shows the top
  folders. Click one (or press 1-5 / Enter while the panel has focus) to move the video. The last move
  can be undone from the panel.
- **Sort page.** One video at a time from "waiting to be sorted" (outside the learned folders), "might
  be misplaced" (sorted videos the plugin would put in another folder; `S` keeps one where it is and it
  is not listed again), a folder, or the Eagle selection. `1`-`5` move, `Enter` first suggestion, `S`/`→` skip, `←` back,
  `Z` undo, `Space` play, `F` search any folder. **Move all sure** moves every sure suggestion in the
  list at once, undone in one step.
- **Guide.** A plain-language walkthrough of every part, inside the plugin window.
- **Settings.** Tick the folders to learn from (untick staging folders), how many videos a folder
  needs, the "sure" target, move behaviour (leave all folders or keep unlearned ones), auto-tag swap,
  GPU and model file.

## Accuracy (model test, 2026-09-30)

9,537 videos from 373 character folders; 1,903 held back and asked about as if unsorted.

| Method | First pick right | Right folder in top 3 |
|---|---|---|
| DINOv2-small (the Duplicate Finder's model) + title | 67% | 75% |
| **PixAI v0.9 fingerprint + ridge + title (this plugin)** | **77.5%** | **85.3%** |

The plugin's own engine reproduced the Python test exactly (tools/validate-engine.js). "Sure"
suggestions covered 60% of the held-back videos and were right 92.5% of the time.

## Install

1. Download `Folder-Suggest-1.1.0-win-x64.eagleplugin` from the
   [latest release](https://github.com/Kristijan1001/eagle-folder-suggest/releases/latest) and double-click it
   (or drag it onto Eagle). Windows x64, Eagle 4.
2. Open **Folder Suggest** from Eagle's Plugins panel and press **Download the model** on the Overview page.
   The model (592 MB, `pixai-v0.9-fingerprint-fp16.onnx`, also attached to the release) is downloaded once
   and checked against its SHA-256 before use.
3. Untick your staging folders under Settings → Folders to learn. Fingerprinting runs in the background;
   suggestions start as soon as a few hundred sorted videos are done.

It is a background ("service") plugin: it starts with Eagle and its window opens from the Plugins panel.

## Building from source

1. `cd plugin && npm install` (onnxruntime-node 1.30 with DirectML, node-webpmux, pngjs).
2. The model: `python tools/export_onnx.py` converts the gated PixAI download
   (`models/pixai-tagger-v0.9/model_v0.9.pth`) to ONNX (needs torch + timm). Details in `model/MODEL_CARD.md`.
3. Eagle: Plugins → Developer options → Import Local Project → the `plugin` folder. A development checkout
   finds the model in `models/` next to `plugin/`.
4. `node tools/pack.js` builds `dist/Folder Suggest <version> (win-x64).eagleplugin`.

## What it touches

- **Library:** only through Eagle's plugin API, when you move or undo (folders and tags of that video).
  `metadata.json` is read (folder auto-tags are not in the API), never written.
- **Its data:** `%LOCALAPPDATA%\Folder Suggest\` - `settings.json`, `engine.json` (local port + token for
  the sidebar panel), `models\`, `libraries\<library>\fingerprints.bin` and `moves.json` (Undo history).
- **Network:** only the one-time model download from the GitHub release, after you agree. The engine listens on 127.0.0.1 only, and every request needs its random token.
- **Processes:** one background engine, Eagle's own runtime as Node (`Eagle.exe`,
  `ELECTRON_RUN_AS_NODE=1`), which runs ONNX Runtime. The model holds ~1 GB of video memory while
  loaded and is released after 2 idle minutes.

## Development

```bash
node tools/run-tests.js                 # unit + engine end-to-end tests, on Eagle's own Node
node tools/validate-engine.js           # the engine against the model test (needs data/ from bench/)
python tools/make_fixtures.py           # synthetic library for the harness
npx electron@22 tools/ui-harness/main.js [--inspector=<itemId>]   # UI against a mock Eagle
node tools/ui-harness/ctl.js eval "<js>" | shot out.png             # drive it (WIN=inspector for the panel)
```

`bench/` holds the model test (dataset.py, embed.py, evaluate.py, probe.py, ridge.py) that picked the
model and the classifier; it reads the library read-only through Eagle's local API. `tools/` also has
the ONNX export, the parity check against PyTorch (parity.js) and the DirectML speed test.
