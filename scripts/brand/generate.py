"""Offline brand compiler. Python fonttools==4.60.1, cairosvg==2.8.2.
Source: google/fonts b31870aff700ab7a1d74fa0c6887d95beb9e0037, ofl/manrope.
Only this build-time script reads the OFL font; the website receives SVG paths.
"""
from pathlib import Path
from hashlib import sha256
import json
import shutil
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import cairosvg

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/web/public/brand'
FONT = Path(__file__).parent / 'source/Manrope[wght].ttf'
NAVY, GOLD, STONE = '#0F2D3D', '#E0B468', '#F5F7F4'
PATH = 'M8 52 L20 22 L32 40 L44 14 L56 52'

def svg(body, box='0 0 64 64'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}">{body}</svg>\n'

def mark(color=NAVY, mono=False, small=False, icon=False):
    # 16px favicon: heavier stroke; move sun upward to retain >=3 units gap.
    return (f'<path d="{PATH}" fill="none" stroke="{color}" stroke-width="{11 if small else 8}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="{57 if small or icon else 56}" cy="{5 if small else 9 if icon else 11}" r="{5.5 if small else 5}" fill="{color if mono else GOLD}"/>')

def save(name, content):
    (OUT / name).write_text(content)

save('finmichi-mark.svg', svg(mark()))
save('finmichi-mark-mono.svg', svg(mark(mono=True)))
save('finmichi-mark-reversed.svg', svg(mark('#FFFFFF')))
app = svg(f'<rect width="64" height="64" rx="14" fill="{NAVY}"/><g transform="translate(9.14 9.14) scale(0.714)">{mark("#FFFFFF", icon=True)}</g>')
favicon = svg(f'<rect width="64" height="64" rx="12" fill="{NAVY}"/><g transform="translate(5.76 5.76) scale(0.82)">{mark("#FFFFFF", small=True)}</g>')
maskable = svg(f'<rect width="64" height="64" fill="{NAVY}"/><g transform="translate(11.2 11.2) scale(0.65)">{mark("#FFFFFF", icon=True)}</g>')
save('app-icon.svg', app)
save('favicon.svg', favicon)
save('maskable-icon.svg', maskable)
font = instantiateVariableFont(TTFont(FONT), {'wght': 800}, inplace=True)
glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
x, letters, gold_dot = 0, [], None
for index, char in enumerate('FinMichi'):
    glyph = glyphs[cmap[ord(char)]]
    recording = RecordingPen()
    glyph.draw(recording)
    contours, contour = [], []
    for op, args in recording.value:
        contour.append((op, args))
        if op in ('closePath', 'endPath'):
            contours.append(contour)
            contour = []
    pen = SVGPathPen(glyphs)
    for contour in contours:
        bounds = BoundsPen(glyphs)
        for op, args in contour:
            getattr(bounds, op)(*args)
        left, bottom, right, top = bounds.bounds
        if index == 4 and bottom > 1080:  # Only the first i in Michi: replace dot.
            assert gold_dot is None
            gold_dot = (x + (left + right) / 2, (bottom + top) / 2, 136)
        else:
            for op, args in contour:
                getattr(pen, op)(*args)
    letters.append(f'<path data-letter="{index}" transform="translate({x} 0)" d="{pen.getCommands()}"/>')
    x += glyph.width - 20  # -0.01em, same tracking as the approved direction.
assert gold_dot is not None
width = x + 20

def wordmark(color):
    cx, cy, radius = gold_dot
    return (f'<g transform="translate(0 1520) scale(1 -1)" fill="{color}">'
            + ''.join(letters) + f'<circle id="michi-first-i-dot" cx="{cx}" cy="{cy}" r="{radius}" fill="{GOLD}"/></g>')
for name, color in [('finmichi-wordmark.svg', NAVY), ('finmichi-wordmark-reversed.svg', '#FFFFFF')]:
    save(name, svg(wordmark(color), f'0 0 {width} 1580'))
for size in (16, 32, 180, 192, 512):
    source = favicon if size <= 32 else app
    filename = f'icon-{size}.png' if size != 180 else 'apple-touch-icon.png'
    cairosvg.svg2png(bytestring=source.encode(), write_to=str(OUT / filename), output_width=size, output_height=size)
# Existing installed manifests can still request the original icon URLs.
for size in (192, 512):
    shutil.copyfile(OUT / f'icon-{size}.png', OUT.parent / 'icons' / f'icon-{size}.png')
cairosvg.svg2png(bytestring=maskable.encode(), write_to=str(OUT / 'maskable-512.png'), output_width=512, output_height=512)
# Sharing card contains only the symbol and outlined name, never financial data.
og = svg(f'<rect width="1200" height="630" fill="{STONE}"/><g transform="translate(492 110) scale(3.375)">{mark()}</g><g transform="translate({(1200-width*0.06)/2} 365) scale(0.06)">{wordmark(NAVY)}</g>', '0 0 1200 630')
save('og-image.svg', og)
cairosvg.svg2png(bytestring=og.encode(), write_to=str(OUT / 'og-image.png'), output_width=1200, output_height=630)
print(json.dumps({'fontSha256': sha256(FONT.read_bytes()).hexdigest(), 'wordmarkWidth': width, 'goldDot': gold_dot, 'pngSizes': [16,32,180,192,512]}, indent=2))
