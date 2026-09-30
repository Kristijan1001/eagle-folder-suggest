"""A small classifier trained on the fingerprints of already-sorted videos (the plugin could retrain it in
seconds after every move). Compared with plain fingerprint voting, alone and combined with the title.

    python probe.py [pixai|dinov2]
"""
import json
import os
import sys

import numpy as np
import torch

import evaluate as ev

sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def train_probe(x, y, n_lab, epochs=300, wd=1e-4):
    torch.manual_seed(0)
    xt, yt = torch.from_numpy(x).cuda(), torch.from_numpy(y).long().cuda()
    head = torch.nn.Linear(x.shape[1], n_lab).cuda()
    opt = torch.optim.AdamW(head.parameters(), lr=3e-3, weight_decay=wd)
    for _ in range(epochs):
        opt.zero_grad()
        loss = torch.nn.functional.cross_entropy(head(xt) * 20, yt, label_smoothing=0.1)
        loss.backward()
        opt.step()
    return head


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else 'pixai'
    items = json.load(open(os.path.join(ev.DATA, 'dataset.json'), encoding='utf-8'))['items']
    folders = {}
    for it in items:
        folders.setdefault(it['folder'], ev.folder_base(it['path']))
    fids = sorted(folders)
    fidx = {f: i for i, f in enumerate(fids)}
    lab = np.array([fidx[it['folder']] for it in items])
    is_test = np.array([it['split'] == 'test' for it in items])
    truth = lab[is_test]
    f = np.load(os.path.join(ev.DATA, f'emb_{model}.npz'))['feat'].astype(np.float32)
    f /= np.linalg.norm(f, axis=1, keepdims=True)

    import time
    t0 = time.time()
    head = train_probe(f[~is_test], lab[~is_test], len(fids))
    print(f'trained on {(~is_test).sum()} videos in {time.time() - t0:.1f}s')
    with torch.no_grad():
        p = torch.softmax(head(torch.from_numpy(f[is_test]).cuda()) * 20, 1).cpu().numpy()
    ev.report(f'{model} trained classifier', p, truth)
    knn = ev.knn_scores(f[is_test], f[~is_test], lab[~is_test], len(fids), k=10)
    mix = (p + knn) / 2
    ev.report(f'{model} classifier + fingerprint vote', mix, truth)

    tpred = []
    for it in np.array(items)[is_test]:
        m = ev.title_match(it['name'], folders)
        tpred.append(fidx[m] if m else -1)
    tpred = np.array(tpred)
    for name, s in (('title, then classifier', p), ('title, then classifier + vote', mix)):
        s = s.copy()
        rows = tpred >= 0
        s[rows] = s[rows] * 0.5          # title first, but keep the model's runners-up as picks 2 and 3
        s[rows, tpred[rows]] = 1
        s /= s.sum(1, keepdims=True)
        ev.report(name, s, truth)


if __name__ == '__main__':
    main()
