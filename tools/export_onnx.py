"""Convert PixAI Tagger v0.9's image body (EVA02-Large) into the ONNX model the plugin runs.

    python tools/export_onnx.py [--fp32]

In:  models/pixai-tagger-v0.9/model_v0.9.pth (gated download, see README)
Out: models/pixai-v0.9-fingerprint-fp16.onnx
     input  "image"       uint8   [N, 448, 448, 3]  RGB, already resized to 448x448
     output "fingerprint" float32 [N, 1024]         L2-normalised
The tag head is dropped: the plugin only uses the fingerprint (its names were unreliable on 3D renders).
Needs torch + timm (the Comfy Desktop venv works: run it with -s).
"""
import argparse
import os
import sys

import numpy as np
import timm
import torch

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIXAI = os.path.join(PROJECT, 'models', 'pixai-tagger-v0.9')


class Fingerprint(torch.nn.Module):
    def __init__(self, encoder, half):
        super().__init__()
        self.encoder = encoder
        self.half = half

    def forward(self, image):
        x = image.permute(0, 3, 1, 2).float() / 127.5 - 1.0     # handler.py: ToTensor + Normalize(0.5, 0.5)
        if self.half:
            x = x.half()
        f = self.encoder(x).float()
        return f / f.norm(dim=1, keepdim=True).clamp_min(1e-6)


def load_encoder():
    encoder = timm.create_model('hf_hub:SmilingWolf/wd-eva02-large-tagger-v3', pretrained=False)
    encoder.reset_classifier(0)
    state = torch.load(os.path.join(PIXAI, 'model_v0.9.pth'), map_location='cpu', weights_only=True)
    enc_state = {k[2:]: v for k, v in state.items() if k.startswith('0.')}
    encoder.load_state_dict(enc_state)
    return encoder.eval()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fp32', action='store_true')
    a = ap.parse_args()
    half = not a.fp32
    dev = 'cuda'
    enc = load_encoder().to(dev)
    if half:
        enc = enc.half()
    model = Fingerprint(enc, half).eval()
    out = os.path.join(PROJECT, 'models', f'pixai-v0.9-fingerprint-{"fp16" if half else "fp32"}.onnx')
    dummy = torch.zeros(2, 448, 448, 3, dtype=torch.uint8, device=dev)
    with torch.inference_mode():
        torch.onnx.export(model, (dummy,), out, input_names=['image'], output_names=['fingerprint'],
                          dynamic_axes={'image': {0: 'n'}, 'fingerprint': {0: 'n'}}, opset_version=17,
                          dynamo=False)
    print('saved', out, f'{os.path.getsize(out) / 1e6:.0f} MB')


if __name__ == '__main__':
    main()
