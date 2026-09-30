"""Closed-form classifiers the plugin can compute without PyTorch, against the trained one (probe.py).

Ridge: W = (X'X + lam*I)^-1 X'Y with one-hot Y (+ bias via a constant column). X'X is 1024x1024, so it is
cheap to keep up to date as videos move and to solve in JavaScript in about a second.

    python ridge.py
"""
import json
import os
import sys

import numpy as np

import evaluate as ev

sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def ridge(x, y, n_lab, lam, balance):
    xb = np.hstack([x, np.ones((len(x), 1), np.float32)])
    yo = np.zeros((len(x), n_lab), np.float32)
    yo[np.arange(len(x)), y] = 1
    if balance:   # weight each video by 1/sqrt(videos in its folder) so big folders do not swamp small ones
        cnt = np.bincount(y, minlength=n_lab)
        w = 1 / np.sqrt(cnt[y])
        xb_w = xb * w[:, None]
        g = xb_w.T @ xb
        r = xb_w.T @ yo
    else:
        g = xb.T @ xb
        r = xb.T @ yo
    g[np.diag_indices_from(g)] += lam
    return np.linalg.solve(g, r)


def to_probs(s, temp):
    e = np.exp((s - s.max(1, keepdims=True)) / temp)
    return e / e.sum(1, keepdims=True)


def main():
    items = json.load(open(os.path.join(ev.DATA, 'dataset.json'), encoding='utf-8'))['items']
    folders = {}
    for it in items:
        folders.setdefault(it['folder'], ev.folder_base(it['path']))
    fids = sorted(folders)
    fidx = {f: i for i, f in enumerate(fids)}
    lab = np.array([fidx[it['folder']] for it in items])
    is_test = np.array([it['split'] == 'test' for it in items])
    truth = lab[is_test]
    f = np.load(os.path.join(ev.DATA, 'emb_pixai.npz'))['feat'].astype(np.float32)
    f /= np.linalg.norm(f, axis=1, keepdims=True)
    tr, te = f[~is_test], f[is_test]
    tpred = []
    for it in np.array(items)[is_test]:
        m = ev.title_match(it['name'], folders)
        tpred.append(fidx[m] if m else -1)
    tpred = np.array(tpred)

    def with_title(p):
        p = p.copy()
        rows = tpred >= 0
        p[rows] *= 0.5
        p[rows, tpred[rows]] = 1
        return p / p.sum(1, keepdims=True)

    for balance in (False, True):
        for lam in (0.01, 0.1, 1.0):
            w = ridge(tr, lab[~is_test], len(fids), lam, balance)
            s = np.hstack([te, np.ones((len(te), 1), np.float32)]) @ w
            p = to_probs(s, 0.05)
            tag = f'ridge lam={lam}{" balanced" if balance else ""}'
            ev.report(tag, p, truth)
            ev.report(tag + ' + title', with_title(p), truth)


if __name__ == '__main__':
    main()
