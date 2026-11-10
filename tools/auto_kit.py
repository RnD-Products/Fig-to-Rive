#!/usr/bin/env python3
"""One command from a converted kit to an animated, verified, previewed Rive file.

usage: auto_kit.py <project dir> [--webflow] [--push [--project=ID]] [--name "File name"]

The project dir comes from the Figma to Rive plugin (or `rive create <dir> --from-remote-file=ID`) and holds scene.rml.
What it does:
  1. keeps the untouched scene as scene.base.txt,
  2. reads the scene and writes motion.json by rules (see classify() below) unless one already exists,
  3. runs animate_kit.py (entrance, idle float, hover + glow, connector draw + streaks, dots, rings),
  4. verifies, renders preview frames (build/preview-*.png),
  5. with --push: pushes to Rive.
Edit motion.json afterwards for anything the rules got wrong and run it again: an existing motion.json is kept.

--webflow also bakes the layout for Webflow's runtime (same fixes as the plugin's Safe layout switch). Skip it when the plugin
already did that on import.

The rules, in short: the part named AI is the hero; shapes named "Glow" fade in; dashed lines draw themselves and get a
travelling streak; small round shapes are dots; boxes are cards (large), icons (small and square) or pills (flat);
cards and icons get a hover glow. Motion that needs a human decision (cursors, drag, micro animations of icons) is
not guessed: add it to motion.json by hand (see Projects/*/motion.json for examples).
"""
import json, math, os, re, shutil, subprocess, sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
def _rive():
    p = os.environ.get('RIVE_BIN') or os.path.expanduser('~/.rive/bin/rive' + ('.exe' if os.name == 'nt' else ''))
    return p if os.path.exists(p) else (shutil.which('rive') or 'rive')
RIVE = _rive()
PALETTE = ['502ABD76', '504D75E2', '50FF8A4D', '508B6BFF', '50E060F0', '50F0A040']


def fnum(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def style_of(e):
    for c in e:
        if c.tag == 'LayoutComponentStyle':
            return c


def main_artboard(root):
    for a in root.iter('Artboard'):
        if a.get('isComponent') != 'true' and a.get('y') in (None, '0'):
            return a
    return next(root.iter('Artboard'))


def stage(ab):
    """the element whose children are the pieces of the picture: the first one with several absolute children or shapes"""
    best = ab
    def score(e):
        return sum(1 for c in e if (c.tag == 'LayoutComponent' and (style_of(c) is not None and style_of(c).get('positionTypeValue') == 'absolute')) or c.tag == 'Shape')
    queue = [ab]
    while queue:
        e = queue.pop(0)
        if score(e) >= 4:
            return e
        for c in e:
            if c.tag in ('LayoutComponent', 'Node'):
                queue.append(c)
    return best


def has_dash(shape):
    return any(d.tag == 'DashPath' for d in shape.iter())


def dash_period(shape):
    return sum(fnum(d.get('length')) for d in shape.iter('Dash')) or 6.0


def classify(root):
    ab = main_artboard(root)
    st = stage(ab)
    items, pulse = [], None
    n_dash, n_glow, n_card, n_icon = 0, 0, 0, 0
    for c in st:
        nm = (c.get('name') or '')
        if c.tag == 'Shape':
            if nm.lower().startswith('glow'):
                if nm.lower().startswith('glow / ai') or 'ai' in nm.lower().split('/')[-1].split():
                    items.append(dict(id=c.get('id'), role='fade', name='AI glow', delay=0, dur=50))
                else:
                    n_glow += 1
                    items.append(dict(id=c.get('id'), role='fade', name='Glow %d' % n_glow, delay=70 + 8 * n_glow, dur=40))
                continue
            ell = next((k for k in c if k.tag == 'Ellipse'), None)
            if ell is not None and fnum(ell.get('width')) <= 12 and not has_dash(c):
                items.append(dict(id=c.get('id'), role='dot', name='Dot %s' % c.get('id'), delay=60 + 6 * len(items)))
                continue
            if ell is not None and has_dash(c):
                items.append(dict(id=c.get('id'), role='ring', name='Orbit', dashId='9:%d' % (900 + n_dash), dashPeriod=dash_period(c), delay=28))
                n_dash += 1
                continue
            if any(k.tag == 'PointsPath' for k in c) and any(k.tag == 'Stroke' for k in c):
                if has_dash(c):
                    items.append(dict(id=c.get('id'), role='connector', name='Line %d' % n_dash, delay=40 + 10 * n_dash, dur=60, group='dash',
                                      dashId='9:%d' % (900 + n_dash), dashPeriod=dash_period(c), dashTurns=12, dashDir=-1, streak=True, streakStart=60 + 20 * n_dash))
                    n_dash += 1
                else:
                    items.append(dict(id=c.get('id'), role='connector', name='Line', delay=14, dur=50))
            continue
        if c.tag == 'NestedArtboardLeaf':
            continue
        if c.tag != 'LayoutComponent':
            continue
        s = style_of(c)
        if s is None or s.get('positionTypeValue') != 'absolute':
            continue
        w, h = fnum(c.get('width')), fnum(c.get('height'))
        left, top = fnum(s.get('positionLeft')), fnum(s.get('positionTop'))
        is_ai = nm.strip() == 'AI' or any(k.tag == 'NestedArtboardLeaf' for k in c) or any(t.tag == 'Text' for t in c.iter()) and w >= 100 and abs(w - h) < 2 and w <= 160
        if is_ai:
            items.append(dict(id=c.get('id'), styleId=s.get('id'), top=top, role='hero', name='AI', hover=True, hoverScale=1.05, unlock=16))
            continue
        if h <= 26 and w > h:
            items.append(dict(id=c.get('id'), styleId=s.get('id'), top=top, role='pill', name='Pill %s' % c.get('id'), delay=90 + 8 * len(items), amp=1))
        elif w >= 120 or h >= 110:
            n_card += 1
            items.append(dict(id=c.get('id'), styleId=s.get('id'), top=top, role='card', name='Card %d' % n_card, hover=True, hoverScale=1.03, delay=50 + 8 * n_card, amp=1.2,
                              glow=dict(x=left + w / 2, y=top + h / 2, w=w * 1.1, h=h * 1.1, color=PALETTE[(n_card - 1) % len(PALETTE)], blur=40)))
        else:
            n_icon += 1
            items.append(dict(id=c.get('id'), styleId=s.get('id'), top=top, role='icon', name='Icon %d' % n_icon, hover=True, hoverScale=1.1, delay=100 + 8 * n_icon, amp=1.2,
                              glow=dict(x=left + w / 2, y=top + h / 2, w=w * 1.5, h=h * 1.5, color=PALETTE[(n_icon + 1) % len(PALETTE)], blur=28)))
    return ab, items


def run(cmd, cwd, quiet=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode and not quiet:
        print(r.stdout[-600:], r.stderr[-600:])
    return r


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(1)
    proj = os.path.abspath(args[0])
    flags = args[1:]
    scene, base, motion = (os.path.join(proj, n) for n in ('scene.rml', 'scene.base.txt', 'motion.json'))
    if not os.path.exists(scene) and not os.path.exists(base):
        sys.exit('no scene.rml in %s' % proj)
    if not os.path.exists(base):
        shutil.copy(scene, base)
    root = ET.fromstring(open(base).read())
    ab, items = classify(root)
    if not os.path.exists(motion):
        cfg = dict(artboard=ab.get('name'), viewModelName=(ab.get('name') or 'Kit') + ' hover', items=items, dashLayer=True, transparentBg=True,
                   streakThickness=3, streakTaper=True, streakPeriod=240)
        if '--webflow' in flags:
            cfg['flatten'] = True
        json.dump(cfg, open(motion, 'w'), indent=1)
        print('wrote motion.json with %d items' % len(items))
    else:
        print('keeping the existing motion.json')
    r = run([sys.executable, os.path.join(HERE, 'animate_kit.py'), proj, motion], proj, quiet=False)
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-300:])
    v = run([RIVE, '.', '--verify'], proj)
    print((v.stdout + v.stderr).strip().splitlines()[-1])
    os.makedirs(os.path.join(proj, 'build'), exist_ok=True)
    for frames in (60, 140, 330):
        run([RIVE, '.', '--screenshot=build/preview-%d.png' % frames, '--advance=%d' % frames], proj)
    run([RIVE, '.', '--once'], proj)
    print('previews: build/preview-60.png, -140.png, -330.png')
    if '--push' in flags:
        pr = [f for f in flags if f.startswith('--project=')]
        cmd = [RIVE, 'push', '--yes', '--name=auto kit'] + pr
        out = run(cmd, proj)
        print((out.stdout + out.stderr).strip().splitlines()[-1])


if __name__ == '__main__':
    main()
