# pixai-v0.9-fingerprint-fp16.onnx

The image model used by [Folder Suggest for Eagle](https://github.com/Kristijan1001/eagle-folder-suggest)
to fingerprint videos (from their Eagle thumbnails). It is a modified version of
[PixAI Tagger v0.9](https://huggingface.co/pixai-labs/pixai-tagger-v0.9) by PixAI, redistributed under
the Apache License 2.0 (`LICENSE-APACHE-2.0.txt`).

| | |
|---|---|
| File | `pixai-v0.9-fingerprint-fp16.onnx` |
| Size | 620,746,839 bytes |
| SHA-256 | `409d1f83ae8604c347893627dc096e2e17e36b345aabb42cf8885acad1d4c1eb` |
| Input | `image`: uint8 `[N, 448, 448, 3]`, RGB, already resized to 448x448 |
| Output | `fingerprint`: float32 `[N, 1024]`, L2-normalised |

## Changes made to the original

PixAI Tagger v0.9 (`model_v0.9.pth`) is an EVA02-Large image encoder with a 13,461-tag head. For this file:

1. **The tag head was removed.** Only the encoder's 1024-number image features are output, then scaled to
   unit length.
2. **Pre-processing is built in:** the model takes raw 0-255 RGB pixels and applies PixAI's
   normalisation (`x / 127.5 - 1`) itself.
3. **Converted to ONNX** (opset 17, PyTorch TorchScript exporter) with the weights in **half precision
   (fp16)**.

Made with `tools/export_onnx.py` in the Folder Suggest repository. On 64 test images its outputs match the
original PyTorch model to a median cosine similarity of 0.9998.

## Credits and licences

- **PixAI Tagger v0.9** - PixAI (pixai-labs), Apache License 2.0. Trained on a Danbooru snapshot
  (posts 1-8,600,750, January 2025). From its model card: "Danbooru content has its own licenses."
- **WD EVA02-Large Tagger v3** - SmilingWolf, Apache License 2.0; the architecture and starting weights
  PixAI Tagger v0.9 was built on.
- **EVA-02** - BAAI, MIT License; the EVA02-Large backbone.

This file is not made or endorsed by PixAI or SmilingWolf.

## Intended use

Visual similarity between (mostly anime / 3D-rendered) character images, as input to a small classifier
that learns a user's own folders. Not suitable for moderation, age verification or identifying real people.
