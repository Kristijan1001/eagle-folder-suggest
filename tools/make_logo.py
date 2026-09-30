"""Draw plugin/logo.png (256x256) and store/icon-512.png: a folder with an arrow into it and a sparkle.

    python tools/make_logo.py
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # background: rounded square, diagonal teal -> blue
    grad = Image.new('RGB', (S, S))
    top, bottom = (20, 184, 166), (59, 110, 246)
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(top, bottom, y / S))
    grad = grad.rotate(-20, resample=Image.BICUBIC, expand=False, fillcolor=bottom)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=230, fill=255)
    img.paste(grad, (0, 0), mask)

    # soft shadow under the folder
    shadow = Image.new('L', (S, S), 0)
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((200, 350, 830, 800), radius=70, fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    img = Image.composite(Image.new('RGBA', (S, S), (10, 30, 70, 255)), img, ImageChops.multiply(shadow, mask))

    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)
    # folder: tab + body
    d.rounded_rectangle((190, 290, 470, 400), radius=48, fill=white)
    d.rounded_rectangle((190, 340, 834, 780), radius=64, fill=white)
    # arrow into the folder (teal, like the gradient top)
    arrow = (22, 160, 160, 255)
    d.rounded_rectangle((330, 540, 610, 596), radius=28, fill=arrow)
    d.polygon([(590, 470), (700, 568), (590, 666)], fill=arrow)
    # sparkle top right
    cx, cy, r = 812, 238, 118
    sp = [(cx, cy - r), (cx + r * 0.26, cy - r * 0.26), (cx + r, cy), (cx + r * 0.26, cy + r * 0.26),
          (cx, cy + r), (cx - r * 0.26, cy + r * 0.26), (cx - r, cy), (cx - r * 0.26, cy - r * 0.26)]
    d.polygon(sp, fill=white)
    return img


def main():
    img = draw()
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, 'plugin', 'logo.png'))
    os.makedirs(os.path.join(ROOT, 'store'), exist_ok=True)
    img.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, 'store', 'icon-512.png'))
    print('wrote plugin/logo.png and store/icon-512.png')


if __name__ == '__main__':
    main()
