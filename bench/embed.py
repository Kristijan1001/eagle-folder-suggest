"""Fingerprint every test-set thumbnail with one model; saves data/emb_<model>.npz.

    python embed.py pixai     # EVA02-L body + PixAI v0.9 head: 1024-d fingerprint + 3721 character scores
    python embed.py dinov2    # the Duplicate Finder's DINOv2-small int8 ONNX: 384-d fingerprint (baseline)

Run with a Python that has torch + timm (pixai) or onnxruntime (dinov2).
"""
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
DATA = os.path.join(PROJECT, 'data')
PIXAI_DIR = os.path.join(PROJECT, 'models', 'pixai-tagger-v0.9')
DINO_ONNX = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'VDF for Eagle', 'ai', 'dinov2-small-int8.onnx')


def to_rgb(img):
    """PixAI handler.pil_to_rgb: transparency becomes white."""
    if img.mode == 'P':
        img = img.convert('RGBA')
    if img.mode == 'RGBA':
        bg = Image.new('RGB', img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        return bg
    return img.convert('RGB')


def load_items():
    with open(os.path.join(DATA, 'dataset.json'), encoding='utf-8') as fh:
        return json.load(fh)['items']


def run_pixai(items):
    import timm
    import torch

    class TaggingHead(torch.nn.Module):  # handler.py TaggingHead
        def __init__(self, dim, n):
            super().__init__()
            self.head = torch.nn.Sequential(torch.nn.Linear(dim, n))

        def forward(self, x):
            return torch.sigmoid(self.head(x))

    tags = json.load(open(os.path.join(PIXAI_DIR, 'tags_v0.9_13k.json'), encoding='utf-8'))
    n_gen = tags['tag_split']['gen_tag_count']
    n_char = tags['tag_split']['character_tag_count']
    encoder = timm.create_model('hf_hub:SmilingWolf/wd-eva02-large-tagger-v3', pretrained=False)
    encoder.reset_classifier(0)
    model = torch.nn.Sequential(encoder, TaggingHead(1024, n_gen + n_char))
    model.load_state_dict(torch.load(os.path.join(PIXAI_DIR, 'model_v0.9.pth'), map_location='cpu', weights_only=True))
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = model.to(dev).eval().half()

    def prep(path):  # Resize((448, 448)) + ToTensor + Normalize(0.5, 0.5)
        img = to_rgb(Image.open(path)).resize((448, 448), Image.BILINEAR)
        return (np.asarray(img, dtype=np.float32) / 255.0 - 0.5) / 0.5

    feats, chars = [], []
    batch = 32
    t0 = time.time()
    with torch.inference_mode():
        for s in range(0, len(items), batch):
            x = np.stack([prep(os.path.join(DATA, it['thumb'])) for it in items[s:s + batch]]).transpose(0, 3, 1, 2)
            x = torch.from_numpy(x).to(dev).half()
            f = model[0](x)
            p = model[1](f)
            feats.append(f.float().cpu().numpy())
            chars.append(p[:, n_gen:].float().cpu().numpy().astype(np.float16))
            if (s // batch) % 50 == 0:
                print(f'  {s + len(x)}/{len(items)} ({time.time() - t0:.0f}s)')
        total = time.time() - t0
        # latency for ONE image, the plugin's case (model already loaded, image already decoded)
        x1 = torch.from_numpy(prep(os.path.join(DATA, items[0]['thumb'])).transpose(2, 0, 1)[None]).to(dev).half()
        for _ in range(3):
            model(x1)
        torch.cuda.synchronize()
        t1 = time.time()
        for _ in range(20):
            model(x1)
        torch.cuda.synchronize()
        single_ms = (time.time() - t1) / 20 * 1000
    return {'feat': np.concatenate(feats), 'char': np.concatenate(chars)}, total, single_ms


def run_dinov2(items):
    import onnxruntime as ort
    sess = ort.InferenceSession(DINO_ONNX, providers=['CPUExecutionProvider'])
    out_name = 'pooler_output' if 'pooler_output' in [o.name for o in sess.get_outputs()] else sess.get_outputs()[0].name
    in_name = sess.get_inputs()[0].name
    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)

    def prep(path):  # the Duplicate Finder: 224x224 squash, ImageNet mean/std
        img = to_rgb(Image.open(path)).resize((224, 224), Image.BICUBIC)
        return (np.asarray(img, dtype=np.float32) / 255.0 - mean) / std

    feats = []
    t0 = time.time()
    for s in range(0, len(items), 32):
        x = np.stack([prep(os.path.join(DATA, it['thumb'])) for it in items[s:s + 32]]).transpose(0, 3, 1, 2)
        f = sess.run([out_name], {in_name: x})[0]
        if f.ndim == 3:
            f = f[:, 0]
        feats.append(f)
    total = time.time() - t0
    x1 = prep(os.path.join(DATA, items[0]['thumb'])).transpose(2, 0, 1)[None]
    t1 = time.time()
    for _ in range(20):
        sess.run([out_name], {in_name: x1})
    single_ms = (time.time() - t1) / 20 * 1000
    return {'feat': np.concatenate(feats).astype(np.float32)}, total, single_ms


def main():
    which = sys.argv[1]
    items = load_items()
    arrays, total, single_ms = {'pixai': run_pixai, 'dinov2': run_dinov2}[which](items)
    np.savez(os.path.join(DATA, f'emb_{which}.npz'), ids=np.array([it['id'] for it in items]), **arrays)
    print(f'{which}: {len(items)} images in {total:.0f}s ({len(items) / total:.0f}/s batched), '
          f'one image {single_ms:.1f} ms')
    with open(os.path.join(DATA, f'timing_{which}.json'), 'w') as fh:
        json.dump({'images': len(items), 'seconds': total, 'single_ms': single_ms}, fh)


if __name__ == '__main__':
    main()
