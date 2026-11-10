#!/usr/bin/env python3
"""Bake auto layout into absolute positions.

usage: flatten_layout.py <scene.rml in> <scene.rml out>

Some runtimes (Webflow's Rive element, for one) lay out nested flex boxes differently and lose their content.
This turns every child that sits in a flex flow into an absolutely placed, fixed-size child at the position the
flow would give it, so the picture no longer depends on the runtime's layout engine.

What it handles: row/column, the nine alignments, gaps, paddings, fixed/fill/hug (the size Figma gave each box is
already on the element). A box that holds text is left as it is, since text sits inside its box by its own rules.
"""
import math, re, sys
import xml.etree.ElementTree as ET


def fnum(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def num(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return s if s not in ('', '-0') else '0'


def style_of(el):
    for c in el:
        if c.tag == 'LayoutComponentStyle':
            return c
    return None


def is_absolute(el):
    st = style_of(el)
    return st is not None and st.get('positionTypeValue') == 'absolute'


def part_of(el):
    for c in el:
        if c.tag == 'LayoutParticipant':
            return c
    return None


def shape_size(shape, inner_w, inner_h):
    """size a shape asks for inside a flow: its participant (fill = the container's inner size), else its path"""
    lp = part_of(shape)
    w = fnum(lp.get('width'), -1) if lp is not None else -1
    h = fnum(lp.get('height'), -1) if lp is not None else -1
    if lp is not None and w < 0 and lp.get('layoutWidthScaleType') == 'fill':
        w = inner_w
    if lp is not None and h < 0 and lp.get('layoutHeightScaleType') == 'fill':
        h = inner_h
    for c in shape:
        if c.tag in ('Rectangle', 'Ellipse'):
            w = w if w >= 0 else fnum(c.get('width'))
            h = h if h >= 0 else fnum(c.get('height'))
    return max(w, 0.0), max(h, 0.0)


def flow_children(container):
    """(element, kind) in document order; kind is 'layout' or 'shape'. Skips absolute ones."""
    out = []
    for c in container:
        if c.tag == 'LayoutComponent' and not is_absolute(c):
            out.append((c, 'layout'))
        elif c.tag in ('Shape', 'Text') and part_of(c) is not None:
            out.append((c, c.tag.lower()))
    return out


def holds_text(container):
    for c in container.iter():
        if c is not container and c.tag == 'Text' and part_of(c) is not None:
            return True
    return False


def align_parts(a):
    v = 'top' if a.startswith('top') else 'bottom' if a.startswith('bottom') else 'center'
    h = 'left' if a.endswith('Left') else 'right' if a.endswith('Right') else 'center'
    if a == 'center':
        v = h = 'center'
    if a == 'centerLeft':
        v, h = 'center', 'left'
    if a == 'centerRight':
        v, h = 'center', 'right'
    return v, h


def place(container, stats):
    st = style_of(container)
    if st is None:
        return
    kids = flow_children(container)
    if not kids:
        return
    texts = [el for el, kind in kids if kind == 'text']
    if any(t_.get('sizingValue') == 'fixed' for t_ in texts):      # a text that already has its fixed box stays in the flow as it is
        return
    if texts:
        # texts have no known width: place them only when nothing after them depends on it
        row_ = st.get('flexDirectionValue', 'row') in ('row', 'rowReverse')
        main_ = st.get('layoutAlignmentType', 'topLeft')
        last_ok = kids[-1][1] == 'text' and len(texts) == 1
        sole = len(kids) == 1
        left_main = main_ in ('topLeft', 'centerLeft', 'bottomLeft') if row_ else main_.startswith('top')
        if not ((last_ok and left_main) or (sole and main_ in ('center', 'centerLeft', 'topLeft'))):
            return
    cw, ch = fnum(container.get('width')), fnum(container.get('height'))
    pl, pr = fnum(st.get('paddingLeft')), fnum(st.get('paddingRight'))
    pt, pb = fnum(st.get('paddingTop')), fnum(st.get('paddingBottom'))
    row = st.get('flexDirectionValue', 'row') in ('row', 'rowReverse')
    gap = fnum(st.get('gapHorizontal' if row else 'gapVertical'))
    algn = st.get('layoutAlignmentType', 'topLeft')
    between = algn.startswith('spaceBetween')
    if between:      # items spread along the main axis; the suffix sets the cross-axis alignment
        cross = algn[len('spaceBetween'):]
        v, h = ('top', 'left') if row and cross == 'Start' else ('center', 'left') if row and cross == 'Center' else ('bottom', 'left') if row else ('top', 'left') if cross == 'Start' else ('top', 'center') if cross == 'Center' else ('top', 'right')
    else:
        v, h = align_parts(algn)
    inner_w, inner_h = cw - pl - pr, ch - pt - pb
    sizes = []
    for el, kind in kids:
        if kind == 'layout':
            sizes.append((fnum(el.get('width')), fnum(el.get('height'))))
        elif kind == 'text':
            paint = next((c for c in el if c.tag == 'TextStylePaint'), None)
            sizes.append((0.0, fnum(paint.get('lineHeight') if paint is not None else None, fnum(paint.get('fontSize') if paint is not None else 16))))
        else:
            sizes.append(shape_size(el, inner_w, inner_h))
    inner_w, inner_h = cw - pl - pr, ch - pt - pb
    # boxes that fill the main axis share what is left; boxes that fill the cross axis take all of it
    grow = [i for i, (el, kind) in enumerate(kids) if kind == 'layout' and style_of(el) is not None and style_of(el).get('layoutWidthScaleType' if row else 'layoutHeightScaleType') == 'fill']
    if grow:
        used = sum((z[0] if row else z[1]) for i, z in enumerate(sizes) if i not in grow) + gap * (len(kids) - 1)
        share = max(0.0, ((inner_w if row else inner_h) - used) / len(grow))
        for i in grow:
            sizes[i] = (share, sizes[i][1]) if row else (sizes[i][0], share)
    for i, (el, kind) in enumerate(kids):
        if kind == 'layout' and style_of(el) is not None and style_of(el).get('layoutHeightScaleType' if row else 'layoutWidthScaleType') == 'fill':
            sizes[i] = (sizes[i][0], inner_h) if row else (inner_w, sizes[i][1])
    for i, (el, kind) in enumerate(kids):
        if kind == 'layout':
            el.set('width', num(sizes[i][0])); el.set('height', num(sizes[i][1]))
    main_total = sum((s[0] if row else s[1]) for s in sizes) + gap * (len(kids) - 1)
    if between and len(kids) > 1:
        gap = max(0.0, ((inner_w if row else inner_h) - sum((z[0] if row else z[1]) for z in sizes)) / (len(kids) - 1))
        main_total = sum((z[0] if row else z[1]) for z in sizes) + gap * (len(kids) - 1)
    main_room = inner_w if row else inner_h
    main_align = h if row else v
    cross_align = v if row else h
    start = {'left': 0, 'top': 0, 'center': (main_room - main_total) / 2, 'right': main_room - main_total, 'bottom': main_room - main_total}[main_align]
    pos = (pl if row else pt) + start
    moved = []
    for (el, kind), (w, hh) in zip(kids, sizes):
        cross_room = inner_h if row else inner_w
        csize = hh if row else w
        co = {'left': 0, 'top': 0, 'center': (cross_room - csize) / 2, 'right': cross_room - csize, 'bottom': cross_room - csize}[cross_align]
        cpos = (pt if row else pl) + co
        left, top = (pos, cpos) if row else (cpos, pos)
        if kind == 'text':
            el.remove(part_of(el))
            if len(kids) == 1 and main_align == 'center':        # a lone, centred text keeps itself centred
                el.set('x', num(pl + inner_w / 2)); el.set('y', num(pt + inner_h / 2)); el.set('originX', '0.5'); el.set('originY', '0.5')
                el.set('alignValue', 'center')
            else:
                el.set('x', num(left)); el.set('y', num(top))
            moved.append(el)
        elif kind == 'layout':
            est = style_of(el)
            est.set('positionTypeValue', 'absolute')
            for k, val in (('positionLeft', left), ('positionTop', top)):
                est.set(k, num(val)); est.set(k + 'UnitsValue', 'points')
            est.set('layoutWidthScaleType', 'fixed'); est.set('layoutHeightScaleType', 'fixed')
        else:
            el.set('x', num(left + w / 2)); el.set('y', num(top + hh / 2))
            el.remove(part_of(el))
            moved.append(el)
            for pth in el:            # a rectangle or ellipse takes the size the flow gave it
                if pth.tag in ('Rectangle', 'Ellipse'):
                    pth.set('width', num(w)); pth.set('height', num(hh))
        stats['placed'] += 1
        pos += (w if row else hh) + gap
    if moved:      # free shapes sit in a Node (as the converter does for icons), or the layout would still stretch them
        at = list(container).index(moved[0])
        wrap = ET.Element('Node', {'name': '%s (Flat)' % container.get('name', 'box')})
        for el in moved:
            container.remove(el)
            wrap.append(el)
        container.insert(at, wrap)


PAINT_STACKS = False


def _mat(x, y, rot, sx, sy):
    c, s_ = math.cos(rot), math.sin(rot)
    return (c * sx, s_ * sx, -s_ * sy, c * sy, x, y)          # a b c d e f : [a c e; b d f]


def _mul(m, n):
    return (m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5])


def _node_mat(e):
    return _mat(fnum(e.get('x')), fnum(e.get('y')), fnum(e.get('rotation')), fnum(e.get('scaleX'), 1), fnum(e.get('scaleY'), 1))


def _paint_stack_to_ellipse(g):
    """A round, rotated box whose paint lives on it and on same-sized round boxes inside it (shadows, a gradient,
    inner shadows) becomes one Ellipse shape carrying all those paints, so the box holds only shapes."""
    w, h = fnum(g.get('width')), fnum(g.get('height'))
    paints = [c for c in g if c.tag in ('Fill', 'Stroke')]
    boxes = [c for c in g if c.tag == 'LayoutComponent']
    if not paints and not boxes:
        return
    def round_full(b):
        st = style_of(b)
        return (st is not None and st.get('cornerRadiusTL') and abs(fnum(b.get('width')) - w) < 1 and abs(fnum(b.get('height')) - h) < 1
                and abs(fnum(st.get('rotation')) ) < 1e-6)
    collected, hoisted = list(paints), []
    th_ = fnum(g.get('rotation'))
    kept = []
    clipboxes = []
    def walk(b):
        for c in list(b):
            if c.tag == 'LayoutComponent' and (c.get('name') or '') == 'Inner Shadow' and c.get('clip') == 'true' and round_full(c):
                # an inner shadow needs its clip: it stays a box, with its offsets turned the way the rotation would turn them
                for f in c.iter('Feather'):
                    ox, oy = fnum(f.get('offsetX')), fnum(f.get('offsetY'))
                    f.set('offsetX', num(ox * math.cos(th_) - oy * math.sin(th_))); f.set('offsetY', num(ox * math.sin(th_) + oy * math.cos(th_)))
                kept.append(c)
            elif c.tag == 'LayoutComponent' and b is g and c.get('clip') == 'true' and round_full(c) and any(k.tag in ('Node', 'Shape') for k in c):
                # the frame that clips the artwork stays (its paint moves to the ball); its inner shadow turns with the rotation
                for k in list(c):
                    if k.tag in ('Fill', 'Stroke'):
                        collected.append(k)
                    elif k.tag == 'LayoutComponent' and (k.get('name') or '') == 'Inner Shadow':
                        for f in k.iter('Feather'):
                            ox, oy = fnum(f.get('offsetX')), fnum(f.get('offsetY'))
                            f.set('offsetX', num(ox * math.cos(th_) - oy * math.sin(th_))); f.set('offsetY', num(ox * math.sin(th_) + oy * math.cos(th_)))
                    elif k.tag == 'LayoutComponent':
                        raise ValueError('frame holds more boxes')
                c.set('bakeInto', '1'); clipboxes.append(c)
            elif c.tag in ('Fill', 'Stroke') and b is not g:
                collected.append(c)
            elif c.tag == 'LayoutComponent' and round_full(c):
                walk(c)
            elif c.tag in ('Node', 'Shape'):
                hoisted.append(c)
            elif c.tag == 'LayoutComponent':
                raise ValueError('not a plain paint stack')
    try:
        if not all(round_full(b) for b in boxes):
            return
        walk(g)
    except ValueError:
        return
    ball = ET.Element('Shape', {'x': num(w / 2), 'y': num(h / 2), 'name': '%s (Ball)' % (g.get('name') or 'box')})
    ET.SubElement(ball, 'Ellipse', {'width': num(w), 'height': num(h), 'name': 'Path'})
    for f in collected:
        for gr in f.iter():
            if gr.tag in ('RadialGradient', 'LinearGradient'):
                for k_, off in (('startX', w / 2), ('endX', w / 2), ('startY', h / 2), ('endY', h / 2)):
                    if gr.get(k_) is not None:
                        gr.set(k_, num(fnum(gr.get(k_)) - off))
        ball.append(f)
    for cb in clipboxes:
        for k in list(cb):
            if k in collected and k.tag in ('Fill', 'Stroke'):
                cb.remove(k)
    for p_ in paints:
        if p_ in g: g.remove(p_)
    for b in boxes:
        if b not in clipboxes:
            g.remove(b)
    for k in kept:
        k.set('keepInBake', '1')
        g.insert(len([c for c in g if c.tag in ('LayoutComponentStyle', 'ComponentOrigin')]), k)
    # the first child draws on top, so the ball goes last, below the hoisted pieces
    for hz in hoisted:
        g.append(hz)
    g.append(ball)


def bake_rotated_groups(root):
    """Webflow's runtime ignores rotation on a layout box. A rotated box that holds only shapes (and Nodes) gets its
    rotation moved into the shapes, which do rotate, and the animation keys of their position are moved with them."""
    parents = {c: p for p in root.iter() for c in p}
    done = 0
    for g in list(root.iter('LayoutComponent'))[::-1]:        # inner boxes first
        th = fnum(g.get('rotation'))
        if abs(th) < 1e-6:
            continue
        if PAINT_STACKS:
            _paint_stack_to_ellipse(g)      # experimental: round logo stacks; the clip frame is not handled yet
        ok, shapes, owners = True, [], []
        def collect(e, chain, owner=None):
            nonlocal ok
            owner = owner if owner is not None else g
            for c in e:
                if c.tag in ('LayoutComponentStyle', 'ComponentOrigin', 'Fill', 'Stroke'):
                    if c.tag in ('Fill', 'Stroke') and e is g:
                        ok = False          # the box has its own paint: leave it
                    continue
                if c.tag == 'Node':
                    collect(c, _mul(chain, _node_mat(c)), owner)
                elif c.tag == 'Shape':
                    shapes.append((c, chain, owner))
                elif c.tag == 'LayoutComponent' and c.get('keepInBake'):
                    pass
                elif c.tag == 'LayoutComponent' and c.get('bakeInto'):
                    cst = style_of(c)
                    owners.append(c)
                    collect(c, _mul(chain, (1, 0, 0, 1, fnum(cst.get('positionLeft')) if cst is not None else 0, fnum(cst.get('positionTop')) if cst is not None else 0)), c)
                elif c.tag == 'LayoutComponent' and not any(k.tag in ('Fill', 'Stroke') for k in c) and abs(fnum(c.get('rotation'))) < 1e-6:
                    cst = style_of(c)       # a plain, unpainted, unrotated box (already baked): its shapes take its offset
                    collect(c, _mul(chain, (1, 0, 0, 1, fnum(cst.get('positionLeft')) if cst is not None else 0, fnum(cst.get('positionTop')) if cst is not None else 0)))
                else:
                    ok = False
        collect(g, (1, 0, 0, 1, 0, 0))
        if not ok or not shapes:
            continue
        w, h = fnum(g.get('width')), fnum(g.get('height'))
        org = next((c for c in g if c.tag == 'ComponentOrigin'), None)
        px, py = (fnum(org.get('originX')) * w, fnum(org.get('originY')) * h) if org is not None else (0.0, 0.0)
        rot_about = _mul(_mat(px, py, 0, 1, 1), _mul(_mat(0, 0, th, 1, 1), _mat(-px, -py, 0, 1, 1)))
        for sh, chain, owner in shapes:
            m = _mul(rot_about, _mul(chain, _node_mat(sh)))
            a, b, c_, d, e_, f_ = m
            sx = math.hypot(a, b); sy = (a * d - b * c_) / (sx or 1)
            sh.set('x', num(e_)); sh.set('y', num(f_)); sh.set('rotation', num(math.atan2(b, a)))
            if abs(sx - 1) > 1e-6: sh.set('scaleX', num(sx))
            if abs(sy - 1) > 1e-6: sh.set('scaleY', num(sy))
            # animation keys of the shape's x / y follow the same move
            sid = sh.get('id')
            for ko in root.iter('KeyedObject'):
                if ko.get('objectId') != sid:
                    continue
                props = {kp.get('property'): kp for kp in ko if kp.tag == 'KeyedProperty'}
                if 'x' in props and 'y' in props:
                    kx = [k for k in props['x'] if k.tag == 'KeyFrameDouble']; ky = [k for k in props['y'] if k.tag == 'KeyFrameDouble']
                    for k1, k2 in zip(kx, ky):
                        px_, py_ = _mul(rot_about, _mul(chain, (1, 0, 0, 1, fnum(k1.get('value')), fnum(k2.get('value')))))[4:]
                        k1.set('value', num(px_)); k2.set('value', num(py_))
        parents = {c: p_ for p_ in root.iter() for c in p_}      # fresh: inner boxes were rebuilt
        for sh, chain, owner in shapes:
            parents[sh].remove(sh)
        for ow in [g] + owners:
            for c in [c for c in ow if c.tag == 'Node' or (c.tag == 'LayoutComponent' and not c.get('keepInBake') and not c.get('bakeInto'))]:
                ow.remove(c)
            for c in ow:
                for flag in ('keepInBake', 'bakeInto'):
                    if c.get(flag):
                        del c.attrib[flag]
            node = ET.SubElement(ow, 'Node', {'name': '%s (Baked)' % (ow.get('name') or 'box')})
            for sh, chain, owner in shapes:
                if owner is ow:
                    node.append(sh)
        del g.attrib['rotation']
        done += 1
    return done


def bake_half_turn(root):
    """A round layout box turned by 180 degrees (Kit 05's logo) that still holds paint after bake_rotated_groups:
    drop the rotation and turn what it carries instead - gradient points and shadow offsets of its boxes are mirrored
    through the centre, and the Nodes with the artwork are rotated 180 degrees about the centre."""
    n = 0
    for g in list(root.iter('LayoutComponent')):
        if abs(abs(fnum(g.get('rotation'))) - math.pi) > 1e-2:
            continue
        w, h = fnum(g.get('width')), fnum(g.get('height'))
        def mirror(box):
            for f in box:
                if f.tag in ('Fill', 'Stroke'):
                    for gr in f.iter():
                        if gr.tag in ('RadialGradient', 'LinearGradient'):
                            for k_, c_ in (('startX', w), ('endX', w), ('startY', h), ('endY', h)):
                                if gr.get(k_) is not None:
                                    gr.set(k_, num(c_ - fnum(gr.get(k_))))
                    for fe in f.iter('Feather'):
                        for k_ in ('offsetX', 'offsetY'):
                            if fe.get(k_) is not None:
                                fe.set(k_, num(-fnum(fe.get(k_))))
            for c in box:
                if c.tag == 'LayoutComponent':
                    mirror(c)
        mirror(g)
        turn = _mul(_mat(w / 2, h / 2, 0, 1, 1), _mul(_mat(0, 0, math.pi, 1, 1), _mat(-w / 2, -h / 2, 0, 1, 1)))
        def turn_nodes(box):
            for c in box:
                if c.tag == 'Node':
                    a, b, c_, d, e_, f_ = _mul(turn, _node_mat(c))
                    sx = math.hypot(a, b); sy = (a * d - b * c_) / (sx or 1)
                    c.set('x', num(e_)); c.set('y', num(f_)); c.set('rotation', num(math.atan2(b, a)))
                    c.set('scaleX', num(sx)); c.set('scaleY', num(sy))
                elif c.tag == 'LayoutComponent':
                    turn_nodes(c)
        turn_nodes(g)
        del g.attrib['rotation']
        n += 1
    return n


def bake_flipped_nodes(root):
    """Webflow's runtime places artwork under a mirrored Node (the converter's flip wrappers) differently. A Node with a
    negative scale that holds only Nodes, shapes and plain unpainted layout boxes, and is not animated, is replaced by a
    plain Node whose shapes carry the whole transform."""
    keyed = {ko.get('objectId') for ko in root.iter('KeyedObject')}
    parents = {c: p for p in root.iter() for c in p}
    n = 0
    def plain(e):
        for c in e:
            if c.tag in ('LayoutComponentStyle', 'ComponentOrigin'):
                continue
            if c.tag == 'Shape':
                continue
            if c.tag == 'Node' and plain(c):
                continue
            if c.tag == 'LayoutComponent' and not any(k.tag in ('Fill', 'Stroke') for k in c) and not c.get('rotation') and plain(c):
                continue
            return False
        return True
    def collect(e, chain, out):
        for c in e:
            if c.tag == 'Node':
                collect(c, _mul(chain, _node_mat(c)), out)
            elif c.tag == 'LayoutComponent':
                st = style_of(c)
                collect(c, _mul(chain, (1, 0, 0, 1, fnum(st.get('positionLeft')) if st is not None else 0, fnum(st.get('positionTop')) if st is not None else 0)), out)
            elif c.tag == 'Shape':
                out.append((c, chain))
    for nd in list(root.iter('Node')):
        if fnum(nd.get('scaleX'), 1) >= 0 and fnum(nd.get('scaleY'), 1) >= 0:
            continue
        if nd not in parents or parents[nd].tag != 'LayoutComponent':
            continue
        if any(x.get('id') in keyed for x in nd.iter()) or not plain(nd):
            continue
        out = []
        collect(nd, _node_mat(nd), out)
        if not out:
            continue
        for sh, chain in out:
            a, b, c_, d, e_, f_ = _mul(chain, _node_mat(sh))
            sx = math.hypot(a, b); sy = (a * d - b * c_) / (sx or 1)
            sh.set('x', num(e_)); sh.set('y', num(f_)); sh.set('rotation', num(math.atan2(b, a)))
            sh.set('scaleX', num(sx)); sh.set('scaleY', num(sy))
        par = parents[nd]
        at = list(par).index(nd)
        par.remove(nd)
        free = ET.Element('Node', {'name': '%s (Free)' % (nd.get('name') or 'art')})
        for sh, chain in out:
            free.append(sh)
        par.insert(at, free)
        n += 1
    return n


def wrap_loose_shapes(root):
    """Shapes and texts that sit straight under a layout box (no layout participant) are treated as flow items by
    Webflow's runtime and get stretched. Put each run of them in a plain Node, which keeps them free."""
    n = 0
    for box in list(root.iter('LayoutComponent')):
        run = []
        for c in list(box) + [None]:
            if c is not None and c.tag in ('Shape', 'Text') and part_of(c) is None:
                run.append(c); continue
            if run:
                at = list(box).index(run[0])
                node = ET.Element('Node', {'name': '%s (Free)' % (box.get('name') or 'box')})
                for el in run:
                    box.remove(el); node.append(el)
                box.insert(at, node); n += 1; run = []
    return n


def nodes_to_layouts(root):
    """Webflow's Rive runtime (2.35) does not lay out a LayoutComponent that sits inside a plain Node.
    The converter wraps every layout's children in `<Node name='X (Wrapper)'>`; turn each such wrapper into a fixed,
    absolutely placed LayoutComponent the size of its parent, so every box has a layout parent."""
    n = 0
    def walk(el):
        nonlocal n
        for i, c in enumerate(list(el)):
            walk(c)
            if (c.tag == 'Node' and el.tag == 'LayoutComponent' and any(k.tag == 'LayoutComponent' for k in c)
                    and not any(abs(fnum(c.get(a), d)) > 1e-6 for a, d in (('x', 0), ('y', 0), ('rotation', 0))) and fnum(c.get('scaleX'), 1) == 1 and fnum(c.get('scaleY'), 1) == 1):      # (a file pulled from Rive has no names on its nodes)
                w, h = el.get('width', '0'), el.get('height', '0')
                box = ET.Element('LayoutComponent', {'width': w, 'height': h, 'clip': 'false', 'name': c.get('name') or '%s (Box)' % (el.get('name') or 'box')})
                if c.get('id'):
                    box.set('id', c.get('id'))
                st = ET.SubElement(box, 'LayoutComponentStyle', {
                    'layoutWidthScaleType': 'fixed', 'layoutHeightScaleType': 'fixed', 'positionTypeValue': 'absolute',
                    'positionLeft': '0', 'positionLeftUnitsValue': 'points', 'positionTop': '0', 'positionTopUnitsValue': 'points',
                    'name': (c.get('name') or '%s (Box)' % (el.get('name') or 'box')) + ' Style'})
                pst = style_of(el)      # the box takes over the parent's flow settings, because the Node was transparent to them
                if pst is not None:
                    for key, val in pst.attrib.items():
                        if key.startswith(('flex', 'gap', 'padding', 'layoutAlignment')) or key == 'flexWrapValue':
                            st.set(key, val)
                for k in list(c):
                    box.append(k)
                el.remove(c); el.insert(i, box)
                n += 1
    walk(root)
    return n


def fix_lone_text(root):
    """A text that is the only child of a centred fixed box (the 'AI' ball) is measured differently by older runtimes
    and lands off-centre. Give it the box's full width and its own line height, centred, so nothing depends on the measure."""
    n = 0
    for box in root.iter('LayoutComponent'):
        st = style_of(box)
        if st is None or st.get('layoutAlignmentType') != 'center':
            continue
        if fnum(box.get('width')) < 80:      # only the big round 'AI' ball; small pills keep their own measure
            continue
        flow = [c for c in box if (c.tag == 'LayoutComponent' and not is_absolute(c)) or (c.tag == 'Text' and part_of(c) is not None)]
        if len(flow) != 1 or flow[0].tag != 'Text':
            continue
        txt, lp = flow[0], part_of(flow[0])
        if lp.get('layoutWidthScaleType') != 'hug':
            continue
        paint = next((c for c in txt if c.tag == 'TextStylePaint'), None)
        lh = fnum(paint.get('lineHeight') if paint is not None else None, fnum(paint.get('fontSize') if paint is not None else 16))
        w = fnum(box.get('width')) - fnum(st.get('paddingLeft')) - fnum(st.get('paddingRight'))
        lp.set('layoutWidthScaleType', 'fixed'); lp.set('layoutHeightScaleType', 'fixed')
        lp.set('width', num(w)); lp.set('height', num(lh))
        txt.set('sizingValue', 'fixed'); txt.set('alignValue', 'center'); txt.set('verticalAlignValue', 'middle')
        n += 1
    return n


def flatten(text):
    # the file is a fragment with one root element
    root = ET.fromstring(text)
    stats = {'placed': 0}
    nodes_to_layouts(root)
    wrap_loose_shapes(root)
    fix_lone_text(root)
    for el in list(root.iter('LayoutComponent')):      # a list: placing a box adds wrapper nodes, which must not disturb the walk
        place(el, stats)
    out = ET.tostring(root, encoding='unicode')
    return out, stats['placed']


if __name__ == '__main__':
    src = open(sys.argv[1]).read()
    out, n = flatten(src)
    open(sys.argv[2], 'w').write(out)
    print('placed', n, 'children')
