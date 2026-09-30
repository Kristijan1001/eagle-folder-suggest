"""Build the test set: videos already sorted into character folders, labelled by their folder.

Read-only. Talks to Eagle's local API (the library must be open in Eagle) and copies each chosen item's
Eagle thumbnail into data/thumbs so the models read from the SSD instead of the library drive.

    python dataset.py [--root Animations] [--min 6] [--cap 40] [--seed 7]
"""
import argparse
import json
import os
import random
import shutil
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'data')
API = 'http://localhost:41595/api'
VIDEO_EXT = {'mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts'}
# Mixed catch-all folders: their items are not one character, so they cannot serve as labels.
SKIP_NAMES = {'others', 'custom chars'}


def get(path, **params):
    url = f'{API}/{path}' + ('?' + urllib.parse.urlencode(params) if params else '')
    r = json.load(urllib.request.urlopen(url, timeout=120))
    if r.get('status') != 'success':
        raise RuntimeError(f'{path}: {r}')
    return r['data']


def label_folders(root):
    """Leaf folders under root that hold one character each: [(id, 'Root/Franchise/Char')]."""
    out = []

    def walk(f, path):
        kids = f.get('children') or []
        name = f['name'].strip()
        if not kids:
            if not name.startswith(('.', '_')) and name.lower() not in SKIP_NAMES:
                out.append((f['id'], path))
            return
        for c in kids:
            walk(c, f'{path}/{c["name"]}')

    walk(root, root['name'])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='Animations', help='top-level folder whose character folders are the labels')
    ap.add_argument('--min', type=int, default=6, help='skip folders with fewer videos than this')
    ap.add_argument('--cap', type=int, default=40, help='at most this many videos per folder')
    ap.add_argument('--test', type=float, default=0.2, help='share of each folder held back for testing')
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()

    lib = get('library/info')
    root = next(f for f in lib['folders'] if f['name'] == a.root)
    folders = label_folders(root)
    print(f'{len(folders)} candidate character folders under {a.root}')

    rng = random.Random(a.seed)
    chosen, kept_folders = [], 0
    t0 = time.time()
    for fid, path in folders:
        items = get('item/list', folders=fid, limit=100000)
        items = [x for x in items if x.get('ext', '').lower() in VIDEO_EXT and x.get('folders') == [fid]
                 and not x.get('isDeleted')]
        if len(items) < a.min:
            continue
        kept_folders += 1
        rng.shuffle(items)
        items = items[:a.cap]
        n_test = max(1, round(len(items) * a.test))
        for i, x in enumerate(items):
            chosen.append({'id': x['id'], 'name': x['name'], 'folder': fid, 'path': path,
                           'split': 'test' if i < n_test else 'train'})
    print(f'{kept_folders} folders with >= {a.min} videos, {len(chosen)} videos chosen '
          f'({sum(c["split"] == "test" for c in chosen)} test) in {time.time() - t0:.0f}s')

    thumbs = os.path.join(DATA, 'thumbs')
    os.makedirs(thumbs, exist_ok=True)

    def fetch(c):
        dst = os.path.join(thumbs, c['id'] + '.png')
        if not os.path.exists(dst):
            src = get('item/thumbnail', id=c['id'])
            src = urllib.parse.unquote(src)
            shutil.copyfile(src, dst + '.tmp')
            os.replace(dst + '.tmp', dst)
        c['thumb'] = os.path.relpath(dst, DATA)
        return c

    t0 = time.time()
    done, failed = [], 0
    with ThreadPoolExecutor(4) as pool:
        for n, c in enumerate(pool.map(lambda c: _safe(fetch, c), chosen), 1):
            if c is None:
                failed += 1
            else:
                done.append(c)
            if n % 1000 == 0:
                print(f'  thumbnails {n}/{len(chosen)} ({time.time() - t0:.0f}s)')
    print(f'{len(done)} thumbnails copied, {failed} failed, {time.time() - t0:.0f}s')

    with open(os.path.join(DATA, 'dataset.json'), 'w', encoding='utf-8') as fh:
        json.dump({'root': a.root, 'library': lib['library']['path'], 'items': done}, fh, ensure_ascii=False, indent=1)


def _safe(fn, c):
    try:
        return fn(c)
    except Exception as e:  # a missing thumbnail must not stop the run
        print(f'  skip {c["id"]} {c["name"][:40]}: {e}')
        return None


if __name__ == '__main__':
    main()
