"""Write the first N PyTorch fingerprints of the test set (data/emb_pixai.npz) for the JS parity test.

    python tools/dump_reference.py [N]   ->  data/reference.json (+ .bin, float32, L2-normalised)
"""
import json
import os
import sys

import numpy as np

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(PROJECT, 'data')

n = int(sys.argv[1]) if len(sys.argv) > 1 else 64
e = np.load(os.path.join(DATA, 'emb_pixai.npz'))
items = {it['id']: it for it in json.load(open(os.path.join(DATA, 'dataset.json'), encoding='utf-8'))['items']}
f = e['feat'][:n].astype(np.float32)
f /= np.linalg.norm(f, axis=1, keepdims=True)
f.tofile(os.path.join(DATA, 'reference.bin'))
json.dump([os.path.join(DATA, items[i]['thumb']) for i in e['ids'][:n]], open(os.path.join(DATA, 'reference.json'), 'w'))
print('wrote', n)
