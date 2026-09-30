# Third-party notices

Folder Suggest's own code is under the MIT License (`LICENSE`). It ships with, or downloads, the following.

## Downloaded on first use (not inside the plugin package)

**pixai-v0.9-fingerprint-fp16.onnx** - a modified version of PixAI Tagger v0.9 (PixAI, Apache License 2.0),
itself built on WD EVA02-Large Tagger v3 (SmilingWolf, Apache License 2.0) and EVA-02 (BAAI, MIT License).
The changes (tag head removed, pre-processing built in, converted to ONNX in half precision) and credits are
in `model/MODEL_CARD.md`; the Apache License 2.0 text is in `model/LICENSE-APACHE-2.0.txt`. Both files are
in this repository (model/).

## Bundled in plugin/node_modules

| Package | Version | Licence |
|---|---|---|
| onnxruntime-node, onnxruntime-common (ONNX Runtime, Microsoft) | 1.30.0 | MIT |
| DirectML.dll, dxcompiler.dll, dxil.dll (shipped inside onnxruntime-node) | - | Microsoft redistributables under their own terms (DirectML, DirectX Shader Compiler) |
| node-webpmux (libwebp compiled to WebAssembly) | 3.2.1 | LGPL-3.0-or-later; unmodified, with its source and `COPYING.LESSER`, and replaceable in `node_modules/node-webpmux` |
| pngjs | 7.0.0 | MIT |

### MIT License (ONNX Runtime)

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

### MIT License (EVA-02)

Copyright (c) the EVA-02 authors (BAAI). Same MIT terms as above.

pngjs: Copyright (c) 2015 Luke Page & Original Contributors; derived work Copyright (c) 2012 Kuba Niegowski.
MIT License (full text in `node_modules/pngjs/LICENSE`).
