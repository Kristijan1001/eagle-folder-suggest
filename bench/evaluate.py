"""Score every way of suggesting a folder on the held-back videos.

    python evaluate.py            # uses whichever data/emb_*.npz exist

Per method: top-1 (first suggestion right), top-3 (right folder among three), and the trade-off between
how often it answers and how often that answer is right (sorted by the method's own confidence).
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

import numpy as np

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
DATA = os.path.join(PROJECT, 'data')
PIXAI_DIR = os.path.join(PROJECT, 'models', 'pixai-tagger-v0.9')


def norm(s):
    s = s.lower().replace('_', ' ')
    s = re.sub(r"[^a-z0-9. ]+", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def folder_base(path):
    """'Animations/Final Fantasy/Tifa Lockhart - FF' -> ('tifa lockhart', 'final fantasy', 'ff')"""
    parts = path.split('/')
    bits = re.split(r'\s+-\s+', parts[-1].strip())
    franchise = parts[1] if len(parts) > 2 else ''
    return norm(bits[0]), norm(franchise), norm(bits[-1]) if len(bits) > 1 else ''


def tag_base(tag):
    """'d.va_(overwatch)' -> ('d.va', 'overwatch')"""
    m = re.match(r'^(.*?)(?:_\(([^)]*)\))?$', tag)
    return norm(m.group(1)), norm(m.group(2) or '')


# ── name signal: PixAI character tags -> folders ──

def map_tags_to_folders(folders):
    """{char_index: [folder_id]} for character tags that name one of the label folders."""
    tags = json.load(open(os.path.join(PIXAI_DIR, 'tags_v0.9_13k.json'), encoding='utf-8'))
    ipmap = json.load(open(os.path.join(PIXAI_DIR, 'char_ip_map.json'), encoding='utf-8'))
    n_gen = tags['tag_split']['gen_tag_count']
    inv = {v: k for k, v in tags['tag_map'].items()}
    out = defaultdict(list)
    for ci in range(tags['tag_split']['character_tag_count']):
        tag = inv[n_gen + ci]
        tb, qual = tag_base(tag)
        ttok = tb.split()
        ips = [x for x in [norm(x) for x in ipmap.get(tag, [])] + [qual] if x]
        for fid, (fb, fr, suffix) in folders.items():
            if fr == 'custom chars':        # artists' own characters: no tagger knows them
                continue
            ftok = fb.split()
            name = fb == tb or (len(ftok) > 1 and sorted(ftok) == sorted(ttok)) or \
                (len(ftok) == 1 and len(ttok) > 1 and ftok[0] in (ttok[0], ttok[-1]))
            if not name:
                continue
            if ips:     # the tag says which series it is from: the folder's franchise must agree
                keys = [k for k in (fr, suffix) if k]
                ok = any(k == ip or (len(k) > 3 and k in ip) or (len(ip) > 3 and ip in k) for k in keys for ip in ips)
            else:       # no series info: trust only a full two-word name
                ok = len(ftok) > 1 and fb == tb
            if ok:
                out[ci].append(fid)
    return out, inv, n_gen


def title_match(name, folders):
    """Folder whose base name appears in the title as whole words (longest wins; ties = no answer)."""
    t = ' ' + norm(name) + ' '
    hits = [(len(fb), fid) for fid, (fb, *_) in folders.items() if len(fb) >= 2 and f' {fb} ' in t]
    if not hits:
        return None
    hits.sort(reverse=True)
    if len(hits) > 1 and hits[0][0] == hits[1][0]:
        return None
    return hits[0][1]


# ── scoring helpers ──

def knn_scores(test, train, train_lab, n_lab, k=10, temp=0.07):
    sims = test @ train.T
    idx = np.argpartition(-sims, k, axis=1)[:, :k]
    out = np.zeros((len(test), n_lab), np.float32)
    for r in range(len(test)):
        s = sims[r, idx[r]]
        w = np.exp((s - s.max()) / temp)
        np.add.at(out[r], train_lab[idx[r]], w)
        out[r] /= out[r].sum()
    return out


def centroid_scores(test, train, train_lab, n_lab):
    cent = np.zeros((n_lab, train.shape[1]), np.float32)
    np.add.at(cent, train_lab, train)
    cent /= np.linalg.norm(cent, axis=1, keepdims=True) + 1e-9
    sims = test @ cent.T
    e = np.exp((sims - sims.max(1, keepdims=True)) / 0.03)
    return e / e.sum(1, keepdims=True)


def report(name, scores, truth, answered=None):
    """scores: (n, n_lab) or None rows for 'no answer'. Prints top-1/top-3 and precision at coverage."""
    n = len(truth)
    if answered is None:
        answered = np.ones(n, bool)
    order = np.argsort(-scores, axis=1)[:, :3]
    top1 = (order[:, 0] == truth) & answered
    top3 = (order == truth[:, None]).any(1) & answered
    conf = np.where(answered, np.sort(scores, axis=1)[:, -1], -1)
    ranked = np.argsort(-conf)
    cov95 = cov90 = 0.0
    hits = 0
    for i, r in enumerate(ranked, 1):
        if not answered[r]:
            break
        hits += top1[r]
        if hits / i >= 0.95:
            cov95 = i / n
        if hits / i >= 0.90:
            cov90 = i / n
    print(f'{name:<34} answers {answered.mean():6.1%}  top-1 {top1.mean():6.1%}  top-3 {top3.mean():6.1%}  '
          f'| right 95% of the time on {cov95:6.1%}, 90% on {cov90:6.1%}')
    return {'answers': float(answered.mean()), 'top1': float(top1.mean()), 'top3': float(top3.mean()),
            'cov95': cov95, 'cov90': cov90}


def main():
    ds = json.load(open(os.path.join(DATA, 'dataset.json'), encoding='utf-8'))
    items = ds['items']
    folders = {}
    for it in items:
        folders.setdefault(it['folder'], folder_base(it['path']))
    fids = sorted(folders)
    fidx = {f: i for i, f in enumerate(fids)}
    lab = np.array([fidx[it['folder']] for it in items])
    is_test = np.array([it['split'] == 'test' for it in items])
    truth = lab[is_test]
    n_lab = len(fids)
    print(f'{len(items)} videos in {n_lab} folders; {is_test.sum()} held back for testing '
          f'({(~is_test).sum()} known examples)\n')

    results = {}
    embs = {m: np.load(os.path.join(DATA, f'emb_{m}.npz')) for m in ('dinov2', 'pixai')
            if os.path.exists(os.path.join(DATA, f'emb_{m}.npz'))}
    knn = {}
    for m, e in embs.items():
        assert list(e['ids']) == [it['id'] for it in items]
        f = e['feat'].astype(np.float32)
        f /= np.linalg.norm(f, axis=1, keepdims=True) + 1e-9
        tr, te = f[~is_test], f[is_test]
        for k in (1, 5, 10, 20):
            s = knn_scores(te, tr, lab[~is_test], n_lab, k=k)
            results[f'{m} fingerprint k={k}'] = report(f'{m} fingerprint match (k={k})', s, truth)
            if k == 10:
                knn[m] = s
        results[f'{m} centroid'] = report(f'{m} folder average', centroid_scores(te, tr, lab[~is_test], n_lab), truth)
        print()

    # title
    tpred = np.array([fidx.get(title_match(it['name'], folders), -1) if title_match(it['name'], folders) else -1
                      for it in np.array(items)[is_test]])
    ts = np.zeros((len(truth), n_lab), np.float32)
    ts[tpred >= 0, tpred[tpred >= 0]] = 1
    results['title'] = report('title contains folder name', ts, truth, answered=tpred >= 0)

    if 'pixai' in embs:
        tag2f, inv, n_gen = map_tags_to_folders(folders)
        mapped = sum(1 for f in fids if any(f in v for v in tag2f.values()))
        print(f'\nPixAI names {mapped} of your {n_lab} test folders ({len(tag2f)} character tags mapped)')
        char = embs['pixai']['char'].astype(np.float32)[is_test]
        ns = np.zeros((len(truth), n_lab), np.float32)
        for ci, fl in tag2f.items():
            for f in fl:
                ns[:, fidx[f]] = np.maximum(ns[:, fidx[f]], char[:, ci])
        for thr in (0.85, 0.6, 0.4):
            answered = ns.max(1) >= thr
            results[f'name {thr}'] = report(f'PixAI character name (>= {thr})', ns, truth, answered=answered)
        # what the unmapped folders get named as (to improve the mapping)
        fused = knn['pixai'] + ns
        print()
        results['fused'] = report('fingerprint + name', fused / fused.sum(1, keepdims=True), truth)
        tf = fused.copy()
        tf[tpred >= 0] = 0
        tf[tpred >= 0, tpred[tpred >= 0]] = 1
        rows = tpred >= 0
        tf[~rows] = tf[~rows] / tf[~rows].sum(1, keepdims=True)
        results['fused+title'] = report('title, then fingerprint + name', tf, truth)

        # per-folder view of the combined method, worst first
        order = np.argsort(-tf, axis=1)
        per = defaultdict(lambda: [0, 0])
        confusion = defaultdict(Counter)
        for r, t in enumerate(truth):
            per[t][1] += 1
            per[t][0] += order[r, 0] == t
            if order[r, 0] != t:
                confusion[t][order[r, 0]] += 1
        worst = sorted(per.items(), key=lambda kv: kv[1][0] / kv[1][1])[:15]
        print('\nweakest folders (combined method): right / tested, most common wrong pick')
        for t, (ok, tot) in worst:
            wrong = confusion[t].most_common(1)
            wp = '/'.join(folders_path(items, fids[wrong[0][0]]).split('/')[1:]) if wrong else ''
            print(f'  {ok}/{tot}  {"/".join(folders_path(items, fids[t]).split("/")[1:])}  -> {wp}')

    with open(os.path.join(DATA, 'results.json'), 'w', encoding='utf-8') as fh:
        json.dump(results, fh, indent=1)


def folders_path(items, fid):
    return next(it['path'] for it in items if it['folder'] == fid)


if __name__ == '__main__':
    main()
