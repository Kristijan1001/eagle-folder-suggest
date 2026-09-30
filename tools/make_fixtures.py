"""Synthetic Eagle library for the UI harness and screenshots (nothing from a real library).

Six "character" folders, each a coloured shape on varied backgrounds, plus an Inbox of unsorted videos.
Thumbnails are WebP files named *_thumbnail.png, exactly like Eagle 4 writes them.

    python tools/make_fixtures.py   ->  test/fixtures/library/  (+ items.json)
"""
import json
import math
import os
import random
import shutil

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'test', 'fixtures')
LIB = os.path.join(OUT, 'library')

CHARS = [
    ('F_RED', 'Red Circle - RC', 'circle', (230, 70, 70), ['Red Circle']),
    ('F_BLUE', 'Blue Square - BS', 'square', (60, 120, 235), ['Blue Square']),
    ('F_GREEN', 'Green Triangle - GT', 'triangle', (60, 190, 110), ['Green Triangle']),
    ('F_YELLOW', 'Yellow Star', 'star', (240, 200, 50), ['Yellow Star']),
    ('F_PURPLE', 'Purple Ring', 'ring', (160, 90, 220), ['Purple Ring']),
    ('F_ORANGE', 'Orange Cross', 'cross', (245, 140, 40), ['Orange Cross']),
]
FOLDERS = [
    {'id': 'F_SHAPES', 'name': 'Shapes', 'tags': ['Shapes'], 'children': [
        {'id': cid, 'name': name, 'tags': tags, 'children': []} for cid, name, _, _, tags in CHARS
    ]},
    {'id': 'F_INBOX', 'name': 'Inbox', 'tags': [], 'children': []},
    {'id': 'F_FAV', 'name': 'Favourites', 'tags': ['Favourite'], 'children': []},
]


def shape(d, kind, cx, cy, r, color):
    if kind == 'circle':
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)
    elif kind == 'square':
        d.rectangle((cx - r, cy - r, cx + r, cy + r), fill=color)
    elif kind == 'triangle':
        d.polygon([(cx, cy - r), (cx + r, cy + r * 0.8), (cx - r, cy + r * 0.8)], fill=color)
    elif kind == 'star':
        pts = []
        for i in range(10):
            a = math.pi / 2 + i * math.pi / 5
            rr = r if i % 2 == 0 else r * 0.45
            pts.append((cx + rr * math.cos(a), cy - rr * math.sin(a)))
        d.polygon(pts, fill=color)
    elif kind == 'ring':
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=max(8, int(r * 0.3)))
    elif kind == 'cross':
        w = r * 0.35
        d.rectangle((cx - w, cy - r, cx + w, cy + r), fill=color)
        d.rectangle((cx - r, cy - w, cx + r, cy + w), fill=color)


def thumb(kind, color, rnd):
    bg = tuple(rnd.randint(20, 90) for _ in range(3))
    img = Image.new('RGB', (711, 400), bg)
    d = ImageDraw.Draw(img)
    for _ in range(rnd.randint(3, 7)):      # background clutter
        x, y = rnd.randint(0, 711), rnd.randint(0, 400)
        s = rnd.randint(20, 120)
        c = tuple(min(255, v + rnd.randint(10, 60)) for v in bg)
        d.rectangle((x, y, x + s, y + s // 2), fill=c)
    r = rnd.randint(70, 130)
    cx, cy = rnd.randint(r + 20, 711 - r - 20), rnd.randint(r + 10, 400 - r - 10)
    jitter = tuple(max(0, min(255, v + rnd.randint(-25, 25))) for v in color)
    shape(d, kind, cx, cy, r, jitter)
    return img.filter(ImageFilter.GaussianBlur(rnd.choice([0, 0, 0.8, 1.5])))


def main():
    rnd = random.Random(7)
    images = os.path.join(LIB, 'images')
    os.makedirs(images, exist_ok=True)
    for name in os.listdir(images):        # empty it in place (the folder itself may be open elsewhere)
        shutil.rmtree(os.path.join(images, name), ignore_errors=True)
    items = []
    n = 0

    def add(name, kind, color, folders, tags):
        nonlocal n
        n += 1
        iid = f'FX{n:011d}'
        d = os.path.join(LIB, 'images', f'{iid}.info')
        os.makedirs(d)
        thumb(kind, color, rnd).save(os.path.join(d, f'{name}_thumbnail.png'), 'WEBP', quality=82)
        items.append({'id': iid, 'name': name, 'ext': 'mp4', 'folders': folders, 'tags': tags})

    for cid, fname, kind, color, tags in CHARS:
        base = fname.split(' - ')[0]
        for i in range(12):
            name = f'{base} scene {i + 1}' if i % 3 == 0 else f'clip_{rnd.randint(1000, 9999)}'
            add(name, kind, color, [cid], ['Shapes'] + tags)
    inbox_names = ['Red Circle night', 'untitled_0041', 'clip_7781', 'Purple Ring party', 'render_final', 'untitled_0107',
                   'Blue Square beach', 'clip_2231', 'vid_003', 'Orange Cross 4K', 'clip_5512', 'render_v2', 'untitled_0200', 'clip_9001']
    for i, name in enumerate(inbox_names):
        cid, fname, kind, color, tags = CHARS[i % len(CHARS)]
        add(name, kind, color, ['F_INBOX'], [])
    items.append({'id': 'FXIMAGE00001', 'name': 'a photo', 'ext': 'jpg', 'folders': ['F_FAV'], 'tags': ['Favourite']})
    os.makedirs(os.path.join(LIB, 'images', 'FXIMAGE00001.info'))
    Image.new('RGB', (400, 300), (200, 200, 210)).save(os.path.join(LIB, 'images', 'FXIMAGE00001.info', 'a photo.jpg'))

    with open(os.path.join(LIB, 'metadata.json'), 'w', encoding='utf-8') as fh:
        json.dump({'folders': FOLDERS, 'smartFolders': [], 'quickAccess': [], 'tagsGroups': [], 'modificationTime': 0, 'applicationVersion': '4.0.0'}, fh, indent=1)
    with open(os.path.join(OUT, 'items.json'), 'w', encoding='utf-8') as fh:
        json.dump(items, fh, indent=1)
    print(f'{len(items)} items in {LIB}')


if __name__ == '__main__':
    main()
