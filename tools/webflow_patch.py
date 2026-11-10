#!/usr/bin/env python3
"""Make a project pulled from Rive load correctly in Webflow's Rive runtime (2.35).

usage: webflow_patch.py <project dir with scene.rml> [id of a rotated group to bake, ...]

It keeps everything the file has (animations, state machines, edits) and only rewrites layout:
  - a Node that wraps layout boxes becomes a layout box (2.35 does not lay out boxes inside a Node),
  - the big centred "AI" text gets a fixed box,
  - auto layout is baked into absolute positions (flatten_layout.place),
  - a rotated group named on the command line has its rotation baked into its shapes.
"""
import math, os, sys
import xml.etree.ElementTree as ET
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flatten_layout as F

live_dir, unrot = sys.argv[1], sys.argv[2:]
path = os.path.join(live_dir, 'scene.rml')
root = ET.fromstring(open(path).read())


def style(e):
    return next((c for c in e if c.tag == 'LayoutComponentStyle'), None)


n_un = 0
for gid in unrot:
    g = next((e for e in root.iter('LayoutComponent') if e.get('id') == gid), None)
    if g is None or not g.get('rotation'):
        continue
    th = float(g.get('rotation')); w, h = float(g.get('width')), float(g.get('height')); st = style(g)
    gl, gt = float(st.get('positionLeft')), float(st.get('positionTop')); cx, cy = gl + w / 2, gt + h / 2
    for sh in g.iter('Shape'):
        x, y, r = float(sh.get('x', 0)), float(sh.get('y', 0)), float(sh.get('rotation', 0))
        dx, dy = x - w / 2, y - h / 2
        sh.set('x', F.num(cx + dx * math.cos(th) - dy * math.sin(th)))
        sh.set('y', F.num(cy + dx * math.sin(th) + dy * math.cos(th)))
        sh.set('rotation', F.num(r + th))
    del g.attrib['rotation']; st.set('positionLeft', '0'); st.set('positionTop', '0')
    for c in list(g):
        if c.tag == 'ComponentOrigin':
            g.remove(c)
    n_un += 1
b_ = F.bake_rotated_groups(root)
b_ += F.bake_half_turn(root)
b_ += F.bake_flipped_nodes(root)
k = F.nodes_to_layouts(root)
w_ = F.wrap_loose_shapes(root)
m = F.fix_lone_text(root)
stats = {'placed': 0}
for el in list(root.iter('LayoutComponent')):
    F.place(el, stats)
open(path, 'w').write(ET.tostring(root, encoding='unicode'))
print('baked rotated groups', b_, 'unrotated', n_un, 'wrappers->layouts', k, 'free-shape nodes', w_, 'text fixed', m, 'placed', stats['placed'])
