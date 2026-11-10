#!/usr/bin/env python3
"""Add a calm, premium motion set to a converted kit: entrance, looping idle, hover on cards and icons.

usage: animate_kit.py <project dir with scene.rml> <config.json>

The scene must come straight from the Figma to Rive converter (no animation yet). The script is idempotent: it always
starts from scene.base.txt (a copy it makes the first time), so it can be run again after changing the config.
"""
import json, math, os, re, shutil, sys

proj, cfgp = sys.argv[1], sys.argv[2]
cfg = json.load(open(cfgp))
scene, base = os.path.join(proj, 'scene.rml'), os.path.join(proj, 'scene.base.txt')
if not os.path.exists(base):
    shutil.copy(scene, base)
src = open(base).read()
if cfg.get('flatten'):          # bake auto layout into absolute positions (see flatten_layout.py)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import flatten_layout
    src, _placed = flatten_layout.flatten(src)

_n = [0]
def nid():
    _n[0] += 1
    return '9:%d' % _n[0]

def num(v):
    return ('%.4f' % v).rstrip('0').rstrip('.') if abs(v) > 1e-9 else '0'

# ---- easing (CSS cubic-bezier numbers) --------------------------------------------------------------------------
OUT = (0.16, 1, 0.3, 1)          # long, soft landing: the entrance
INOUT = (0.45, 0, 0.55, 1)       # breathing
def cubic(e):
    return '<CubicEaseInterpolator x1="%s" y1="%s" x2="%s" y2="%s"/>' % tuple(num(v) for v in e)
def kf(value, frame, ease=None):
    if ease is None:
        return '<KeyFrameDouble value="%s" frame="%d" interpolationType="linear"/>' % (num(value), frame)
    return '<KeyFrameDouble value="%s" frame="%d" interpolationType="cubic">%s</KeyFrameDouble>' % (num(value), frame, cubic(ease))
def prop(name, keys):
    return '<KeyedProperty property="%s">%s</KeyedProperty>' % (name, ''.join(keys))
def obj(oid, *props):
    return '<KeyedObject objectId="%s">%s</KeyedObject>' % (oid, ''.join(props))

def hold_then(frame0_value, start, end_value, end, ease=OUT):
    """value sits at frame0_value until `start`, then eases to end_value by `end`"""
    ks = [kf(frame0_value, 0)]
    if start > 0:
        ks.append(kf(frame0_value, start, ease))
    else:
        ks[0] = kf(frame0_value, 0, ease)
    ks.append(kf(end_value, end))
    return ks

# ---- the parts ----------------------------------------------------------------------------------------------
items = cfg['items']   # each: id, role (hero|line|dot|ring|card|icon|pill), name, [styleId, top], [hover], [delay]
anim_xml = []
need_origin = []

# ---------------- Entrance ----------------
ent = []
last = 0
conn_trims = {}
ent_dash, dash_last = [], 0     # parts in group 'dash' play in their own Dash layer, so they are timed apart from the cards
def bump(x, it):
    global last, dash_last
    if it.get('group') == 'dash':
        dash_last = max(dash_last, x)
    else:
        last = max(last, x)
ent_end = {}   # frame at which each part's own entrance is done
pops = []      # (id, name, from, start, end): the scale-in of a hoverable part lives in its own layer, so hover can take the scale over the moment it lands
def scale_in(oid, it, v0, start, end):
    if it.get('hover'):
        if it['role'] == 'hero' or it.get('popIn'):     # these keep a scale-in; hover opens when it lands
            v0 = it.get('popFrom', v0); end = start + it.get('popLen', end - start)
            pops.append((oid, it['name'], v0, start, end)); pop_end[oid] = end
        else:                        # cards and icons: no scale-in at all, so hover works from the moment they start to appear
            pop_end[oid] = start
        return ''
    return prop('scaleX', hold_then(v0, start, 1, end)) + prop('scaleY', hold_then(v0, start, 1, end))
pop_end = {}
for it in items:
    role = it['role']; oid = it['id']; d = it.get('delay', 0)
    T = ent_dash if it.get('group') == 'dash' else ent
    if role == 'hero':
        scale_in(oid, it, .88, 0, 44)      # the hover pop layer is kept; the Entrance below is the AI motion as tuned in Rive
        T.append(obj(oid, prop('opacity', hold_then(0, 0, 1, 40, OUT)), prop('scaleX', hold_then(.88, 0, 1, 66)), prop('scaleY', hold_then(.88, 0, 1, 66))))   # fade over 40 frames, scale .88 -> 1 over 66
        bump(66, it); ent_end[oid] = 66; need_origin.append(oid)
    elif role == 'line':
        T.append(obj(oid, prop('opacity', hold_then(0, d or 14, 1, (d or 14) + 40, OUT))))
        bump((d or 14) + 40, it); ent_end[oid] = (d or 14) + 40
    elif role == 'dot':
        s = d or 46
        T.append(obj(oid, prop('opacity', hold_then(0, s, 1, s + 20)), prop('scaleX', hold_then(.5, s, 1, s + 30)), prop('scaleY', hold_then(.5, s, 1, s + 30))))
        bump(s + 30, it); ent_end[oid] = s + 30
    elif role == 'ring':
        s = d or 28
        T.append(obj(oid, prop('opacity', hold_then(0, s, 1, s + 50)), prop('scaleX', hold_then(.94, s, 1, s + 66)), prop('scaleY', hold_then(.94, s, 1, s + 66))))
        bump(s + 66, it); ent_end[oid] = s + 66
    elif role == 'connector':      # a dashed line that draws itself from its start point
        s = d or 26; dur = it.get('dur', 72); tid = nid(); conn_trims[oid] = tid
        if it.get('reverse'):      # the path starts at the far end: draw it from its END by pulling the trim start back
            T.append(obj(tid, prop('start', hold_then(1, s, 0, s + dur, (0.33, 0, 0.2, 1)))))
        else:
            T.append(obj(tid, prop('end', hold_then(0, s, 1, s + dur, (0.33, 0, 0.2, 1)))))
        bump(s + dur, it); ent_end[oid] = s + dur
    elif role == 'fade':
        s = d; dur = it.get('dur', 40)
        T.append(obj(oid, prop('opacity', hold_then(0, s, 1, s + dur))))
        bump(s + dur, it); ent_end[oid] = s + dur
    elif role == 'card':
        s = d or 36
        T.append(obj(oid, prop('opacity', hold_then(0, s, 1, s + 40)), scale_in(oid, it, .97, s, s + 34)))
        T.append(obj(it['styleId'], prop('positionTop', hold_then(it['top'] + 16, s, it['top'], s + 52))))
        bump(s + 54, it); ent_end[oid] = s + 54; need_origin.append(oid)
    else:  # icon, pill
        s = d
        T.append(obj(oid, prop('opacity', hold_then(0, s, 1, s + 28)), scale_in(oid, it, .82, s, s + 30)))
        if not it.get('noSlide'):      # (cursor tags: their position belongs to the Cursors loop from the very first frame)
            T.append(obj(it['styleId'], prop('positionTop', hold_then(it['top'] + 10, s, it['top'], s + 44))))
        bump(s + 44, it); ent_end[oid] = s + 44; need_origin.append(oid)
pop_layers = []
for oid, nm, v0, st, en in pops:
    aid, sid_, lid = nid(), nid(), nid()
    anim_xml.append('<LinearAnimation duration="%d" name="Pop %s" id="%s">%s</LinearAnimation>' % (en + 2, nm, aid, obj(oid, prop('scaleX', hold_then(v0, st, 1, en)), prop('scaleY', hold_then(v0, st, 1, en)))))
    pop_layers.append('<StateMachineLayer name="Pop %s" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                      '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState><AnimationState x="200" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nm, lid, sid_, aid, sid_))
ENT_ID = nid()
anim_xml.append('<LinearAnimation duration="%d" name="Entrance" id="%s">%s</LinearAnimation>' % (last + 6, ENT_ID, ''.join(ent)))

# ---------------- Idle (loops) ----------------
IDLE = 720   # 12 s: every loop below (4 s pulse, 4 s burst, 3 s blink) divides it evenly
idle = []
dash_idle, streak_idle, cursor_idle, spoke_idle, spoke_trim_base, orbit_idle = [], [], [], [], {}, []
def float_keys(top, amp, phase):
    base = math.sin(2 * math.pi * phase)      # two bobs per loop (6 s each)
    return [kf(top + amp * (math.sin(2 * math.pi * (2 * f / IDLE + phase)) - base), f) for f in range(0, IDLE + 1, 20)]
for it in items:
    role = it['role']; oid = it['id']
    if role == 'hero':     # floats (not scales) so the hover scale is free
        idle.append(obj(it['styleId'], prop('positionTop', float_keys(it['top'], it.get('amp', 2), it.get('phase', 0.0)))))
    elif role in ('ring', 'connector') and it.get('dashId'):
        (dash_idle if it.get('group') == 'dash' else idle).append(obj(it['dashId'], prop('offset', [kf(0, 0), kf(it.get('dashDir', -1) * it['dashPeriod'] * it.get('dashTurns', IDLE // 60), IDLE)])))
    elif role == 'card':
        idle.append(obj(it['styleId'], prop('positionTop', float_keys(it['top'], it.get('amp', 1.5), it.get('phase', 0.0)))))
    elif role in ('icon', 'pill') and not it.get('noFloat'):
        idle.append(obj(it['styleId'], prop('positionTop', float_keys(it['top'], it.get('amp', 3), it.get('phase', 0.0)))))

# ---- micro loops (per-kit, from cfg['micro']) ----
T4 = 240
SPL = cfg.get('spokeLoop', T4)     # the Spokes loop has its own length
def cycles(period):
    return range(0, IDLE, period)
extra_xml = {}           # id -> list of source edits done later
trims = {}               # shape id -> trim id
for mc in cfg.get('micro', []):
    ty = mc['type']
    if ty == 'gear':
        idle.append(obj(mc['id'], prop('rotation', [kf(0, 0), kf(2 * math.pi * mc.get('turns', 1), IDLE)])))
        if mc.get('layout'):
            need_origin.append(mc['id'])
    elif ty == 'needle':
        keys = []
        for b in cycles(T4):
            pts = [(0, 0), (-0.9, 70), (-0.35, 120), (0.4, 170)]
            keys += [kf(v, b + f, INOUT) for v, f in pts]
        keys.append(kf(0, IDLE))
        idle.append(obj(mc['id'], prop('rotation', keys)))
    elif ty == 'blink':
        keys = []
        at = mc.get('at', 150)      # where in the 3 s cycle the blink happens
        for b in cycles(180):
            keys += [kf(1, b, INOUT), kf(1, b + at, INOUT), kf(0.08, b + at + 10, INOUT), kf(1, b + at + 22, INOUT)]
        keys.append(kf(1, IDLE))
        for oid in mc['ids']:
            idle.append(obj(oid, prop('scaleY', list(keys))))
    elif ty == 'runline':      # a solid line whose bright streak runs along it again and again
        tid = nid(); trims[mc['id']] = tid
        st, en = [kf(0, 0)], [kf(0, 0)]
        for b in cycles(T4):
            t = b + mc.get('start', 20)
            st += [kf(0, t + 30, (0.3, 0, 0.5, 1)), kf(1, t + 100), kf(1, t + 101), kf(0, t + 102)]
            en += [kf(0, t, (0.3, 0, 0.5, 1)), kf(1, t + 70), kf(1, t + 101), kf(0, t + 102)]
        st.append(kf(0, IDLE)); en.append(kf(0, IDLE))
        idle.append(obj(tid, prop('start', st), prop('end', en)))
    elif ty == 'press':        # cursor presses, the click marks flash
        ck, rk = [], []
        for b in cycles(T4):
            t = b + mc.get('at', 60)
            ck += [kf(1, t, INOUT), kf(.84, t + 8, INOUT), kf(1, t + 28, INOUT)]
            rk += [kf(1, t, INOUT), kf(.15, t + 10, INOUT), kf(1, t + 44, INOUT)]
        ck.append(kf(1, IDLE)); rk.append(kf(1, IDLE))
        idle.append(obj(mc['cursor'], prop('scaleX', ck), prop('scaleY', list(ck))))
        for oid in mc['rays']:
            idle.append(obj(oid, prop('opacity', list(rk))))
    elif ty == 'layers':       # the stack opens up a little and closes
        top, bot = [], []
        for b in cycles(T4):
            t = b + mc.get('at', 50)
            top += [kf(mc['topY'], t, INOUT), kf(mc['topY'] - 1.6, t + 36, INOUT), kf(mc['topY'], t + 84, INOUT)]
            bot += [kf(mc['botY'], t, INOUT), kf(mc['botY'] + 1.6, t + 36, INOUT), kf(mc['botY'], t + 84, INOUT)]
        top.insert(0, kf(mc['topY'], 0)); bot.insert(0, kf(mc['botY'], 0)); top.append(kf(mc['topY'], IDLE)); bot.append(kf(mc['botY'], IDLE))
        idle.append(obj(mc['top'], prop('y', top))); idle.append(obj(mc['bot'], prop('y', bot)))
    elif ty == 'twinkle':      # quarter turn with a soft swell (a four-point star looks the same after a quarter turn)
        rk, sk = [], []
        for b in cycles(T4):
            t = b + mc.get('at', 40)
            rk += [kf(0, t, INOUT), kf(math.pi / 2, t + 90)]
            sk += [kf(1, t, INOUT), kf(1.18, t + 45, INOUT), kf(1, t + 90)]
        rk.insert(0, kf(0, 0)); sk.insert(0, kf(1, 0)); rk.append(kf(0, IDLE)); sk.append(kf(1, IDLE))
        idle.append(obj(mc['id'], prop('rotation', rk), prop('scaleX', sk), prop('scaleY', list(sk))))
    elif ty == 'wander':       # a collaborator cursor that roams like a person: eased moves, pauses, now and then a click
        import random
        rnd = random.Random(mc.get('seed', 1)); R = mc.get('radius', 16); nstops = mc.get('stops', 5)
        pts = [(0.0, 0.0)]
        for _ in range(nstops - 1):
            while True:
                ang, rad = rnd.uniform(0, 2 * math.pi), rnd.uniform(.45, 1) * R
                q = (rad * math.cos(ang), rad * math.sin(ang))
                if math.hypot(q[0] - pts[-1][0], q[1] - pts[-1][1]) > R * .45:
                    break
            pts.append(q)
        pts.append((0.0, 0.0))
        clicks = set(mc.get('clicks', [1, 3]))
        pauses = [rnd.randint(*mc.get('pause', (14, 24))) + (16 if i in clicks else 0) for i in range(nstops)]
        w = [rnd.uniform(.8, 1.25) for _ in range(nstops)]
        moves = [(IDLE - sum(pauses)) * x / sum(w) for x in w]
        kx, ky, kc = [], [], []
        t = 0.0
        for i in range(nstops):
            a_, l_ = int(round(t)), int(round(t + pauses[i]))
            for lst, ax, ease in ((kx, 0, (0.3, 0.05, 0.25, 1)), (ky, 1, (0.4, 0, 0.3, 1))):
                base = mc['left'] if ax == 0 else mc['top']
                lst += [kf(base + pts[i][ax], a_), kf(base + pts[i][ax], l_, ease)]
            if i in clicks and mc.get('cursor'):
                kc += [kf(1, a_ + 4, INOUT), kf(.8, a_ + 11, INOUT), kf(1, a_ + 24, INOUT)]
            t += pauses[i] + moves[i]
        kx.append(kf(mc['left'], IDLE)); ky.append(kf(mc['top'], IDLE))
        (cursor_idle if cfg.get('cursorLayer') else idle).append(obj(mc['styleId'], prop('positionLeft', kx), prop('positionTop', ky)))
        if kc:
            kc.insert(0, kf(1, 0)); kc.append(kf(1, IDLE))
            (cursor_idle if cfg.get('cursorLayer') else idle).append(obj(mc['cursor'], prop('scaleX', kc), prop('scaleY', list(kc))))
    elif ty == 'bars':         # equalizer: bars grow and shrink from their bottom edge
        for bi, bar in enumerate(mc['bars']):
            sk, yk = [], []
            for f in range(0, IDLE + 1, 20):
                sc = 0.74 + 0.26 * math.sin(2 * math.pi * (f / 240.0 + bar.get('phase', 0)))
                sk.append(kf(sc, f)); yk.append(kf(bar['y'] + bar['half'] * (1 - sc), f))
            idle.append(obj(bar['id'], prop('scaleY', sk), prop('y', yk)))
    elif ty == 'pulse':        # a quick double pulse (a zap)
        keys = []
        for b in cycles(T4):
            t = b + mc.get('at', 40)
            keys += [kf(1, t, INOUT), kf(mc.get('peak', 1.2), t + 6, INOUT), kf(1, t + 16, INOUT), kf(mc.get('peak', 1.2) - .06, t + 26, INOUT), kf(1, t + 40, INOUT)]
        keys.insert(0, kf(1, 0)); keys.append(kf(1, IDLE))
        for oid in mc['ids']:
            idle.append(obj(oid, prop('scaleX', list(keys)), prop('scaleY', list(keys))))
    elif ty == 'hit':          # the arrow taps the target and the rings answer
        xk, yk, rk = [], [], []
        for b in cycles(T4):
            t = b + mc.get('at', 80)
            xk += [kf(mc['x'], t, INOUT), kf(mc['x'] + mc['dx'], t + 12, INOUT), kf(mc['x'], t + 44, INOUT)]
            yk += [kf(mc['y'], t, INOUT), kf(mc['y'] + mc['dy'], t + 12, INOUT), kf(mc['y'], t + 44, INOUT)]
            rk += [kf(1, t + 10, INOUT), kf(1.1, t + 18, INOUT), kf(1, t + 46, INOUT)]
        xk.insert(0, kf(mc['x'], 0)); yk.insert(0, kf(mc['y'], 0)); rk.insert(0, kf(1, 0))
        xk.append(kf(mc['x'], IDLE)); yk.append(kf(mc['y'], IDLE)); rk.append(kf(1, IDLE))
        idle.append(obj(mc['id'], prop('x', xk), prop('y', yk)))
        for oid in mc['rings']:
            idle.append(obj(oid, prop('scaleX', list(rk)), prop('scaleY', list(rk))))
    elif ty == 'bob':          # a small nod
        hk, sk = [], []
        for b in cycles(T4):
            t = b + mc.get('at', 120)
            hk += [kf(mc['y'], t, INOUT), kf(mc['y'] - mc.get('amp', 1.8), t + 22, INOUT), kf(mc['y'], t + 48, INOUT)]
            sk += [kf(1, t + 4, INOUT), kf(1.07, t + 26, INOUT), kf(1, t + 52, INOUT)]
        hk.insert(0, kf(mc['y'], 0)); hk.append(kf(mc['y'], IDLE)); sk.insert(0, kf(1, 0)); sk.append(kf(1, IDLE))
        idle.append(obj(mc['id'], prop('y', hk)))
        if mc.get('body'):
            idle.append(obj(mc['body'], prop('scaleX', list(sk)), prop('scaleY', list(sk))))
    elif ty == 'dashflow':     # dashes slide along a set of dashed shapes (the shapes themselves stay still)
        mc['_dash_ids'] = {}
        for sid_ in mc['ids']:
            did = nid(); mc['_dash_ids'][sid_] = did
            if mc.get('saw'):      # one pattern period per tooth: the pattern marches forever but the offset never wanders far
                N = mc['saw']; ks = []
                for k in range(IDLE // N):
                    ks += [kf(0, k * N), kf(mc.get('dir', -1) * mc['period'], (k + 1) * N - 1)]
                ks.append(kf(0, IDLE))
                (orbit_idle if mc.get('layer') else idle).append(obj(did, prop('offset', ks)))
            else:
                (orbit_idle if mc.get('layer') else idle).append(obj(did, prop('offset', [kf(0, 0), kf(mc.get('dir', -1) * mc['period'] * mc.get('turns', 16), IDLE)])))
    elif ty == 'spoke':        # a dot rides the head of a line from its icon to the core; at the end the line trims out and both fade
        def shape_(oid):
            return re.search(r'<Shape x="([\d.\-]+)" y="([\d.\-]+)"(?: rotation="([\d.\-]+)")?[^>]*\bid="%s"[^>]*>\s*(?:<PointsPath[^>]*>((?:<StraightVertex[^>]*/>)+))?' % re.escape(oid), src)
        L_, D_ = shape_(mc['line']), shape_(mc['dot'])
        vs = re.findall(r'<StraightVertex x="([\d.\-]+)" y="([\d.\-]+)"', L_.group(4))
        lx, ly, lr = float(L_.group(1)), float(L_.group(2)), float(L_.group(3) or 0)
        def pt(v):
            vx, vy = float(v[0]), float(v[1])
            return (lx + vx * math.cos(lr) - vy * math.sin(lr), ly + vx * math.sin(lr) + vy * math.cos(lr))
        S_, E_ = pt(vs[0]), pt(vs[-1])
        A_ = (float(D_.group(1)), float(D_.group(2)))
        if mc.get('invert'):       # run the other way: start at the end the dot does NOT sit on
            dd = lambda q: math.hypot(q[0] - A_[0], q[1] - A_[1])
            A_ = E_ if dd(E_) > dd(S_) else S_
        d_ = lambda q: math.hypot(q[0] - A_[0], q[1] - A_[1])
        fwd = d_(S_) <= d_(E_)                         # the path starts at the icon end
        B0_ = E_ if fwd else S_
        len_ = math.hypot(B0_[0] - A_[0], B0_[1] - A_[1]) or 1.0
        fr_ = max(0.5, 1 - mc.get('inset', 0) / len_)       # stop short of the far end, so the dot never sits on the icon's edge
        B_ = (A_[0] + (B0_[0] - A_[0]) * fr_, A_[1] + (B0_[1] - A_[1]) * fr_)
        t0, TRAVEL, OUTL = mc.get('start', 84), mc.get('travel', 100), 30
        ease_ = (0.3, 0, 0.5, 1)
        sv = [(0, 0, None), (0, t0, None), (0, t0 + TRAVEL, ease_), (fr_, t0 + TRAVEL + OUTL, None), (0, t0 + TRAVEL + OUTL + 1, None), (0, SPL, None)]
        ev = [(0, 0, None), (0, t0, ease_), (fr_, t0 + TRAVEL, None), (fr_, t0 + TRAVEL + OUTL, None), (0, t0 + TRAVEL + OUTL + 1, None), (0, SPL, None)]
        if not fwd:
            sv, ev = [(1 - v, f, e) for v, f, e in ev], [(1 - v, f, e) for v, f, e in sv]
        tid = nid(); trims[mc['line']] = tid; spoke_trim_base[tid] = True
        tr = obj(tid, prop('start', [kf(v, f, e) for v, f, e in sv]), prop('end', [kf(v, f, e) for v, f, e in ev]))
        fade = [kf(0, 0), kf(0, t0 - 1), kf(1, t0), kf(1, t0 + TRAVEL), kf(0, t0 + TRAVEL + int(OUTL * .55), INOUT), kf(0, SPL)]   # gone before the trimmed tail gets short, so no stray tick is left by the icon
        px = [kf(A_[0], 0), kf(A_[0], t0, ease_), kf(B_[0], t0 + TRAVEL), kf(B_[0], t0 + TRAVEL + OUTL), kf(A_[0], t0 + TRAVEL + OUTL + 1), kf(A_[0], SPL)]
        py = [kf(A_[1], 0), kf(A_[1], t0, ease_), kf(B_[1], t0 + TRAVEL), kf(B_[1], t0 + TRAVEL + OUTL), kf(A_[1], t0 + TRAVEL + OUTL + 1), kf(A_[1], SPL)]
        sc = [kf(1, 0), kf(1, t0), kf(1, t0 + int(TRAVEL * .7), INOUT), kf(.35, t0 + TRAVEL), kf(.35, t0 + TRAVEL + OUTL), kf(1, t0 + TRAVEL + OUTL + 1), kf(1, SPL)]   # it shrinks as it arrives
        spoke_idle.append(tr + obj(mc['line'], prop('opacity', list(fade))) + obj(mc['dot'], prop('opacity', list(fade)), prop('x', px), prop('y', py), prop('scaleX', sc), prop('scaleY', list(sc))))
    elif ty == 'breathe':      # a slow swell with a hint of tilt (for an icon that is one shape)
        sk, rk = [], []
        for f in range(0, IDLE + 1, 20):
            ph = 2 * math.pi * (f / 240.0 + mc.get('phase', 0))
            sk.append(kf(1 + mc.get('amp', .06) * (math.sin(ph) + 1) / 2, f)); rk.append(kf(mc.get('tilt', .03) * math.sin(ph + 1.2), f))
        for oid in mc['ids']:
            idle.append(obj(oid, prop('scaleX', list(sk)), prop('scaleY', list(sk)), prop('rotation', list(rk))))
    elif ty == 'sun':          # the sun drifts and swells; the mountain barely breathes
        xk, yk, sk, mk = [], [], [], []
        for f in range(0, IDLE + 1, 20):
            ph = 2 * math.pi * (f / 240.0 + mc.get('phase', 0))
            xk.append(kf(mc['x'] + mc.get('dx', 3.2) * math.sin(ph), f)); yk.append(kf(mc['y'] + mc.get('dy', 2.2) * math.sin(ph * 2 + .6), f))
            sk.append(kf(1 + .22 * (math.sin(ph * 2 + 1.4) + 1) / 2, f)); mk.append(kf(1 + .03 * (math.sin(ph - .8) + 1) / 2, f))
        idle.append(obj(mc['sun'], prop('x', xk), prop('y', yk), prop('scaleX', sk), prop('scaleY', list(sk))))
        idle.append(obj(mc['mountain'], prop('scaleY', mk)))
    elif ty == 'trimcheck':
        tid = nid(); trims[mc['id']] = tid
        st, en = [kf(0, 0)], [kf(1, 0)]
        for b in cycles(T4):
            st += [kf(0, b + 150, INOUT), kf(1, b + 176), kf(0, b + 177)]
            en += [kf(1, b + 150), kf(1, b + 176), kf(0, b + 177), kf(0, b + 190, INOUT), kf(1, b + 225)]
        st.append(kf(0, IDLE)); en.append(kf(1, IDLE))
        idle.append(obj(tid, prop('start', st), prop('end', en)))

# ---- travelling pulse along the line (a new ellipse under the hero) ----
pulse_xml = ''
pulse_layers = []
if cfg.get('pulse'):
    pc = cfg['pulse']; pid = nid()
    px, ox, oy, os_ = [], [], [], []
    px.append(kf(pc['fromX'], 0))
    ox.append(kf(0, 0))
    ppath = pc.get('path')      # a polyline: the pulse follows it instead of a straight x run
    if ppath:
        cum = [0.0]
        for q0, q1 in zip(ppath, ppath[1:]):
            cum.append(cum[-1] + math.hypot(q1[0] - q0[0], q1[1] - q0[1]))
        def along(u):
            d_ = u * cum[-1]
            for k_ in range(1, len(cum)):
                if d_ <= cum[k_]:
                    r_ = (d_ - cum[k_ - 1]) / ((cum[k_] - cum[k_ - 1]) or 1)
                    return (ppath[k_ - 1][0] + (ppath[k_][0] - ppath[k_ - 1][0]) * r_, ppath[k_ - 1][1] + (ppath[k_][1] - ppath[k_ - 1][1]) * r_)
            return tuple(ppath[-1])
    TR = 150     # slow, nearly even glide with a long fade in and out along the line
    for b in cycles(T4):
        t = b + 24
        px += [kf(pc['fromX'], t, (0.3, 0, 0.7, 1)), kf(pc['toX'], t + TR), kf(pc['fromX'], t + TR + 1)]
        ox += [kf(0, t, INOUT), kf(0, t + 53, INOUT), kf(1, t + 84, INOUT), kf(1, t + 132, INOUT), kf(0, t + TR)]   # fades in mid-line, fades out as it reaches the dot
        os_ += [kf(1, t, INOUT), kf(1.8, t + 75, INOUT), kf(1, t + TR)]
    px.append(kf(pc['fromX'], IDLE)); ox.append(kf(0, IDLE)); os_.insert(0, kf(1, 0)); os_.append(kf(1, IDLE))
    if pc.get('start') is not None:     # its own loop, begun right after the line has drawn instead of after the whole entrance
        px, ox, os_ = [kf(pc['fromX'], 0)], [kf(0, 0)], [kf(1, 0)]
        t = 24
        py_ = []
        if ppath:
            px = [kf(ppath[0][0], 0)]; py_ = [kf(ppath[0][1], 0)]
            for f_ in range(0, TR + 1, 5):
                sx_ = f_ / TR; u_ = 0.5 * sx_ + 0.5 * (3 * sx_ ** 2 - 2 * sx_ ** 3)
                qx, qy = along(u_)
                px.append(kf(qx, t + f_)); py_.append(kf(qy, t + f_))
            px += [kf(ppath[0][0], t + TR + 1), kf(ppath[0][0], T4)]; py_ += [kf(ppath[0][1], t + TR + 1), kf(ppath[0][1], T4)]
        else:
            px += [kf(pc['fromX'], t, (0.3, 0, 0.7, 1)), kf(pc['toX'], t + TR), kf(pc['fromX'], t + TR + 1), kf(pc['fromX'], T4)]
        ox += [kf(0, t, INOUT), kf(0, t + 53, INOUT), kf(1, t + 84, INOUT), kf(1, t + 132, INOUT), kf(0, t + TR), kf(0, T4)]
        os_ += [kf(1, t, INOUT), kf((1.35 if ppath else 1.8), t + 75, INOUT), kf(1, t + TR), kf(1, T4)]
        PA, PW, ps1, ps2 = nid(), nid(), nid(), nid()
        anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Pulse" id="%s">%s</LinearAnimation>' % (T4, PA, obj(pid, prop('x', px), *( [prop('y', py_)] if py_ else [] ), prop('opacity', ox), prop('scaleX', os_), *( [prop('scaleY', list(os_))] if py_ else [] ))))
        anim_xml.append('<LinearAnimation duration="%d" name="Pulse wait" id="%s">%s</LinearAnimation>' % (max(1, pc['start']), PW, obj(pid, prop('opacity', [kf(0, 0)]))))
        pulse_layers.append('<StateMachineLayer name="Pulse" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                            '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                            '<AnimationState x="200" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="0" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/></AnimationState>'
                            '<AnimationState x="420" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nid(), ps1, PW, ps1, ps2, PA, ps2))
    else:
        idle.append(obj(pid, prop('x', px), prop('opacity', ox), prop('scaleX', os_)))
    pulse_xml = ('<Shape x="%s" y="%s" opacity="0" name="Pulse" id="%s"><Ellipse width="%s" height="%s" name="Path"/>'
                 '<Fill fillRule="clockwise" name="Glow"><SolidColor colorValue="992152DB" name="Color"/><Feather strength="8" offsetX="0" offsetY="0" name="Feather"/></Fill>'
                 '<Fill name="Fill"><SolidColor colorValue="FF2152DB" name="Color"/></Fill></Shape>') % (num(pc['path'][0][0] if pc.get('path') else pc['fromX']), num(pc['path'][0][1] if pc.get('path') else pc['y']), pid, pc.get('size', 8), pc.get('size', 8))

# ---- burst of short lines around a badge ----
burst_xml = ''
if cfg.get('burst'):
    bc = cfg['burst']; parts = []
    for i, ang in enumerate(bc['angles']):
        sid, tid = nid(), nid()
        st, en = [kf(0, 0)], [kf(0, 0)]
        for b in cycles(T4):
            t = b + bc.get('start', 90) + i * 2
            st += [kf(0, t + 8, OUT), kf(1, t + 30), kf(1, t + 31), kf(0, t + 32)]
            en += [kf(0, t, OUT), kf(1, t + 10), kf(1, t + 31), kf(0, t + 32)]
        st.append(kf(0, IDLE)); en.append(kf(0, IDLE))
        idle.append(obj(tid, prop('start', st), prop('end', en)))
        parts.append('<Shape x="%s" y="%s" rotation="%s" name="Burst %d" id="%s"><PointsPath isClosed="false" name="Path">'
                     '<StraightVertex x="%s" y="0"/><StraightVertex x="%s" y="0"/></PointsPath>'
                     '<Stroke thickness="%s" cap="round" join="round" name="Stroke"><SolidColor colorValue="%s" name="Color"/>'
                     '<TrimPath start="0" end="0" modeValue="1" name="Trim" id="%s"/></Stroke></Shape>'
                     % (num(bc['cx']), num(bc['cy']), num(math.radians(ang)), i + 1, sid, num(bc['r0']), num(bc['r1']), bc.get('thickness', 2.5), bc['color'], tid))
    burst_xml = ''.join(parts)


# ---- bright streaks that run down every connector, fading toward the card ----
streaks = []     # (connector id, xml)
for n, it in enumerate([i for i in items if i.get('streak')]):
    sid, tid = nid(), nid()
    rev = it.get('reverse')
    sv, ev = [(0, 0, None)], [(0, 0, None)]
    sx, ex = (0.3, 0, 0.5, 1), (0.3, 0, 0.5, 1)
    for b in cycles(cfg.get('streakPeriod', T4)):
        t = b + it.get('streakStart', 110) + (0 if it.get('streakExact') else n * 6)
        t = min(t, b + cfg.get('streakPeriod', T4) - 165)      # a run must finish inside its own cycle, or the loop seam pops
        sv += [(0, t + 40, sx), (1, t + 160, None), (1, t + 161, None), (0, t + 162, None)]
        ev += [(0, t, ex), (1, t + 120, None), (1, t + 161, None), (0, t + 162, None)]
    sv.append((0, IDLE, None)); ev.append((0, IDLE, None))
    def tup_(lst, flip):
        return [((1 - v) if flip else v, f, e) for v, f, e in lst]
    if rev:     # mirror: what runs from the start now runs from the end
        S_t, E_t = tup_(ev, True), tup_(sv, True)
    else:
        S_t, E_t = tup_(sv, False), tup_(ev, False)
    st = [kf(v, f, e) for v, f, e in S_t]; en = [kf(v, f, e) for v, f, e in E_t]
    objs = [obj(tid, prop('start', st), prop('end', en))]
    extras = []
    if cfg.get('streakTaper'):     # thinner strokes lengthen the streak at both ends, so it narrows toward its tips
        T0 = cfg.get('streakThickness', 1.5); m = cfg.get('taperLen', .035)
        for k, frac in ((1, .62), (2, .32)):
            tk, sk = nid(), nid()
            clamp = lambda v: max(0.0, min(1.0, v))
            sk_keys = [kf(clamp(v - k * m), f, e) for v, f, e in S_t]; ek_keys = [kf(clamp(v + k * m), f, e) for v, f, e in E_t]
            th = [kf(0, 0)]
            for b in cycles(cfg.get('streakPeriod', T4)):
                t = b + it.get('streakStart', 110) + (0 if it.get('streakExact') else n * 6)
                t = min(t, b + cfg.get('streakPeriod', T4) - 165)
                th += [kf(0, t - 1), kf(T0 * frac, t), kf(T0 * frac, t + 161), kf(0, t + 162)]
            th.append(kf(0, IDLE))
            objs += [obj(tk, prop('start', sk_keys), prop('end', ek_keys)), obj(sk, prop('thickness', th))]
            extras.append((tk, sk))
    (streak_idle if cfg.get('dashLayer') else idle).append(''.join(objs))
    streaks.append((it['id'], sid, tid, n, bool(rev), extras))

for it in items:       # shapes that only exist for the entrance: idle holds them at 0 (the 500 ms hand-over blends it)
    if it.get('hideAfterEntrance'):
        idle.append(obj(it['id'], prop('opacity', [kf(0, 0), kf(0, IDLE)])))
IDLE_ID = nid()
anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Idle" id="%s">%s</LinearAnimation>' % (IDLE, IDLE_ID, ''.join(idle)))

# ---------------- Dash layer (parts that draw/run along the connectors) ----------------
dash_layers = []
if ent_dash:
    ED, SL, DL = nid(), nid(), nid()
    anim_xml.append('<LinearAnimation duration="%d" name="Entrance dash" id="%s">%s</LinearAnimation>' % (dash_last + 6, ED, ''.join(ent_dash)))
    anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Dash Line Streak" id="%s">%s</LinearAnimation>' % (IDLE, SL, ''.join(streak_idle)))
    anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Dash Line" id="%s">%s</LinearAnimation>' % (IDLE, DL, ''.join(dash_idle)))
    a1, a2, a3 = nid(), nid(), nid()
    dash_layers.append('<StateMachineLayer name="Dash" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                       '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                       '<AnimationState x="200" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="0" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/></AnimationState>'
                       '<AnimationState x="420" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nid(), a1, ED, a1, a2, SL, a2))
    dash_layers.append('<StateMachineLayer name="Dash Line" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                       '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                       '<AnimationState x="200" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nid(), a3, DL, a3))

# ---------------- Cursors: one loop on its own layer, running from the first frame ----------------
cursor_layers = []
if cursor_idle:
    CA, cs1 = nid(), nid()
    anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Cursors" id="%s">%s</LinearAnimation>' % (IDLE, CA, ''.join(cursor_idle)))
    cursor_layers.append('<StateMachineLayer name="Cursors" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                         '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                         '<AnimationState x="200" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nid(), cs1, CA, cs1))

# ---------------- Orbit: the dash motion on its own looping layer, so it also runs during the entrance ----------------
orbit_layers = []
if orbit_idle:
    OA, os1 = nid(), nid()
    anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Orbit" id="%s">%s</LinearAnimation>' % (IDLE, OA, ''.join(orbit_idle)))
    orbit_layers.append('<StateMachineLayer name="Orbit" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                        '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                        '<AnimationState x="200" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nid(), os1, OA, os1))

# ---------------- Spokes: one loop on its own layer ----------------
spoke_layers = []
if spoke_idle:
    SA, ss1 = nid(), nid()
    anim_xml.append('<LinearAnimation loopValue="loop" duration="%d" name="Spokes" id="%s">%s</LinearAnimation>' % (SPL, SA, ''.join(spoke_idle)))
    spoke_layers.append('<StateMachineLayer name="Spokes" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                        '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                        '<AnimationState x="200" y="0" animationId="%s" id="%s"/></StateMachineLayer>' % (nid(), ss1, SA, ss1))

# ---------------- Hover (cards and icons only) ----------------
VM_ID, VM_INST = nid(), nid()
hovers = [it for it in items if it.get('hover')]
props = {it['name']: nid() for it in hovers}
hover_layers, listeners = [], []
glow_ids = {}
for it in hovers:
    sc = it.get('hoverScale', 1.08 if it['role'] == 'icon' else 1.015)
    rest_id, hov_id = nid(), nid()
    g_rest = g_hov = ''
    if it.get('glow'):
        gid = nid(); glow_ids[it['id']] = gid
        g_rest = obj(gid, prop('opacity', [kf(0, 0)]), prop('scaleX', [kf(.86, 0)]), prop('scaleY', [kf(.86, 0)]))
        g_hov = obj(gid, prop('opacity', [kf(1, 0)]), prop('scaleX', [kf(1, 0)]), prop('scaleY', [kf(1, 0)]))
    anim_xml.append('<LinearAnimation duration="1" name="Rest %s" id="%s">%s%s</LinearAnimation>' % (it['name'], rest_id, obj(it['id'], prop('scaleX', [kf(1, 0)]), prop('scaleY', [kf(1, 0)])), g_rest))
    wait_id = nid()      # holds off the hover until this part has landed (no scale keys, so its pop-in plays untouched)
    wait_keys = g_rest or obj(it['id'], prop('opacity', [kf(1, 0)]))
    anim_xml.append('<LinearAnimation duration="%d" name="Wait %s" id="%s">%s</LinearAnimation>' % (it.get('unlock', pop_end.get(it['id'], ent_end.get(it['id'], last)) + 2), it['name'], wait_id, wait_keys))
    anim_xml.append('<LinearAnimation duration="1" name="Hover %s" id="%s">%s%s</LinearAnimation>' % (it['name'], hov_id, obj(it['id'], prop('scaleX', [kf(sc, 0)]), prop('scaleY', [kf(sc, 0)])), g_hov))
    pid = props[it['name']]
    def cond(value):
        return ('<TransitionViewModelCondition><TransitionPropertyViewModelComparator><BindablePropertyBoolean>'
                '<DataBindContext sourcePathIds="%s-%s" propertyKey="634"/></BindablePropertyBoolean></TransitionPropertyViewModelComparator>'
                '<TransitionValueBooleanComparator value="%s"/></TransitionViewModelCondition>') % (VM_ID, pid, value)
    ease = '<CubicEaseInterpolator x1="0.25" y1="0.1" x2="0.25" y2="1"/>'
    s_rest, s_hov, s_wait = nid(), nid(), nid()
    hover_layers.append(
        '<StateMachineLayer name="Hover %s" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
        '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
        '<AnimationState x="120" y="120" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="0" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/></AnimationState>'
        '<AnimationState x="200" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="240" interpolationType="cubic">%s%s</StateTransition></AnimationState>'
        '<AnimationState x="420" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="380" interpolationType="cubic">%s%s</StateTransition></AnimationState>'
        '</StateMachineLayer>' % (it['name'], nid(), s_wait, wait_id, s_wait, s_rest, rest_id, s_rest, s_hov, ease, cond('true'), hov_id, s_hov, s_rest, ease, cond('false')))
    for kind, val in (('enter', 'true'), ('exit', 'false')):
        listeners.append(
            '<StateMachineListenerSingle targetId="%s" listenerTypeValue="%s" name="%s %s" id="%s"><ListenerViewModelChange>'
            '<BindablePropertyBoolean propertyValue="%s"><DataBindContext sourcePathIds="%s-%s" propertyKey="634" direction="true"/></BindablePropertyBoolean>'
            '</ListenerViewModelChange></StateMachineListenerSingle>' % (it.get('listenTo', it['id']), kind, it['name'], kind, nid(), val, VM_ID, pid))

# ---------------- drag: grab an item and move it; on release it eases back ----------------
# The item is wrapped in a plain Node (added below); the drag moves that Node, a layer eases the Node back to 0 on release.
dprops, drag_nodes, drag_layers = {}, {}, []
for it in items:
    if not it.get('drag'):
        continue
    dn, pid = nid(), nid()
    dprops[it['name']] = pid; drag_nodes[it['id']] = dn
    def dcond(value, pid=pid):
        return ('<TransitionViewModelCondition><TransitionPropertyViewModelComparator><BindablePropertyBoolean>'
                '<DataBindContext sourcePathIds="%s-%s" propertyKey="634"/></BindablePropertyBoolean></TransitionPropertyViewModelComparator>'
                '<TransitionValueBooleanComparator value="%s"/></TransitionViewModelCondition>') % (VM_ID, pid, value)
    free_id, back_id = nid(), nid()
    anim_xml.append('<LinearAnimation duration="1" name="Drag free %s" id="%s">%s</LinearAnimation>' % (it['name'], free_id, obj(dn, prop('opacity', [kf(1, 0)]))))
    anim_xml.append('<LinearAnimation duration="1" name="Drag back %s" id="%s">%s</LinearAnimation>' % (it['name'], back_id, obj(dn, prop('x', [kf(0, 0)]), prop('y', [kf(0, 0)]))))
    s_free, s_back = nid(), nid()
    ease_ = '<CubicEaseInterpolator x1="0.45" y1="0" x2="0.55" y2="1"/>'     # gentle at both ends, so the glide back is easy to follow
    drag_layers.append('<StateMachineLayer name="Drag %s" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
                       '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
                       '<AnimationState x="200" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="0">%s</StateTransition></AnimationState>'
                       '<AnimationState x="420" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="%d" interpolationType="cubic">%s%s</StateTransition></AnimationState>'
                       '</StateMachineLayer>' % (it['name'], nid(), s_back, back_id, s_back, s_free, dcond('true'), free_id, s_free, s_back, it.get('dragBack', 1800), ease_, dcond('false')))
    for kind, val in (('down', 'true'), ('up', 'false')):
        listeners.append('<StateMachineListenerSingle targetId="%s" listenerTypeValue="%s" name="%s drag %s" id="%s"><ListenerViewModelChange>'
                         '<BindablePropertyBoolean propertyValue="%s"><DataBindContext sourcePathIds="%s-%s" propertyKey="634" direction="true"/></BindablePropertyBoolean>'
                         '</ListenerViewModelChange></StateMachineListenerSingle>' % (it.get('listenTo', it['id']), kind, it['name'], kind, nid(), val, VM_ID, pid))
    listeners.append('<StateMachineListenerSingle targetId="%s" listenerTypeValue="drag" name="Drag %s" id="%s"><ListenerAlignTarget targetId="%s" preserveOffset="true"/></StateMachineListenerSingle>'
                     % (it.get('listenTo', it['id']), it['name'], nid(), dn))

# ---------------- state machine ----------------
SM_ID = nid()
intro_a, intro_b = nid(), nid()
intro = ('<StateMachineLayer name="Intro" id="%s"><AnyState x="200" y="-120"/><ExitState x="400" y="-120"/>'
         '<EntryState x="0" y="0"><StateTransition stateToId="%s"/></EntryState>'
         '<AnimationState x="200" y="0" animationId="%s" id="%s"><StateTransition stateToId="%s" duration="500" enableExitTime="true" exitTimeIsPercetange="true" exitTime="100"/></AnimationState>'
         '<AnimationState x="420" y="0" animationId="%s" id="%s"/>'
         '</StateMachineLayer>') % (nid(), intro_a, ENT_ID, intro_a, intro_b, IDLE_ID, intro_b)
# Hover layers come FIRST: a later layer wins when two animate the same property, and the entrance must win while it plays.
sm = '<StateMachine name="State Machine 1" id="%s">%s%s%s%s%s%s%s%s%s%s</StateMachine>' % (SM_ID, ''.join(listeners), ''.join(pop_layers), ''.join(hover_layers), intro, ''.join(dash_layers), ''.join(pulse_layers), ''.join(cursor_layers), ''.join(drag_layers), ''.join(spoke_layers), ''.join(orbit_layers))

# ---------------- write into the scene ----------------
ab_name = cfg['artboard']
m = re.search(r'(<Artboard\s[^>]*name="%s"[^>]*>)([\s\S]*?)(</Artboard>)' % re.escape(ab_name), src)
open_tag, body, close = m.group(1), m.group(2), m.group(3)
body = re.sub(r'<StateMachine\b[\s\S]*?</StateMachine>', '', body)      # drop the empty one from the converter
open_tag = re.sub(r'defaultStateMachineId="[^"]*"', 'defaultStateMachineId="%s" viewModelId="%s" viewModelInstanceId="%s"' % (SM_ID, VM_ID, VM_INST), open_tag)
body += sm + ''.join(anim_xml)
src = src[:m.start()] + open_tag + body + close + src[m.end():]

if cfg.get('transparentBg'):       # hide the artboard's own background fill, so the page behind shows through
    mm = re.search(r'(<Artboard\s[^>]*name="%s"[^>]*>\s*<LayoutComponentStyle[^>]*/>\s*)<Fill name="Fill"' % re.escape(cfg['artboard']), src)
    if mm:
        src = src[:mm.end(1)] + '<Fill isVisible="false" name="Fill"' + src[mm.end():]

# ViewModel (a root element) goes before the closing </Rive>
vm = ('<ViewModel defaultInstanceId="%s" name="%s" id="%s">%s<ViewModelInstance exports="true" name="Default" id="%s">%s</ViewModelInstance></ViewModel>'
      % (VM_INST, cfg.get('viewModelName', 'Hover'), VM_ID,
         ''.join('<ViewModelPropertyBoolean name="hover%s" id="%s"/>' % (k, v) for k, v in props.items()) + ''.join('<ViewModelPropertyBoolean name="drag%s" id="%s"/>' % (k, v) for k, v in dprops.items()), VM_INST,
         ''.join('<ViewModelInstanceBoolean propertyValue="false" viewModelPropertyId="%s"/>' % v for v in list(props.values()) + list(dprops.values()))))
src = re.sub(r'\s*</Rive>\s*$', '\n    ' + vm + '\n</Rive>\n', src)

def end_of(text, start):
    """index just after the element that opens at `start`"""
    depth = 0
    for mm in re.finditer(r'<(/?)([A-Za-z]\w*)[^<>]*?(/?)>', text[start:]):
        if mm.group(3) == '/':
            if depth == 0:
                return start + mm.end()
            continue
        depth += -1 if mm.group(1) else 1
        if depth == 0:
            return start + mm.end()
    raise SystemExit('unbalanced element')

def insert_after(oid, xml):
    global src
    mm = re.search(r'<(LayoutComponent|Shape)\b[^>]*\bid="%s"[^>]*>' % re.escape(oid), src)
    if not mm:
        print('WARN: cannot find', oid); return
    e = end_of(src, mm.start())
    src = src[:e] + xml + src[e:]

for oid, dn in drag_nodes.items():      # wrap the draggable item in a plain Node that the drag moves
    mm = re.search(r'<LayoutComponent\b[^>]*\bid="%s"[^>]*>' % re.escape(oid), src)
    e = end_of(src, mm.start())
    src = src[:mm.start()] + '<Node name="Drag node" id="%s">' % dn + src[mm.start():e] + '</Node>' + src[e:]

for sp in cfg.get('splitShapes', []):     # one shape holding two paths -> a fixed-size layout box with two shapes, so each part can move
    mm = re.search(r'<Shape\b[^>]*\bid="%s"[^>]*>' % re.escape(sp['id']), src)
    e = end_of(src, mm.start())
    shp = src[mm.start():e]
    lp = re.search(r'<LayoutParticipant[^>]*\bwidth="([^"]*)" height="([^"]*)"[^>]*/>', shp)
    w_, h_ = float(lp.group(1)), float(lp.group(2))
    paths = re.findall(r'<PointsPath[^>]*>[\s\S]*?</PointsPath>', shp)
    rest = shp[shp.rindex('</PointsPath>') + len('</PointsPath>'):-len('</Shape>')]
    def one(path, name, sid_):
        return '<Shape x="%s" y="%s" name="%s" id="%s">%s%s</Shape>' % (num(w_ / 2), num(h_ / 2), name, sid_, path, rest)
    box = ('<LayoutComponent width="%s" height="%s" styleId="%s" clip="false" name="Image icon" id="%s">'
           '<LayoutComponentStyle layoutWidthScaleType="fixed" layoutHeightScaleType="fixed" name="Image icon Style" id="%s"/>'
           '<Node name="Image icon (Wrapper)">%s%s</Node></LayoutComponent>') % (num(w_), num(h_), sp['styleId'], sp['wrapperId'], sp['styleId'],
              one(paths[0], 'Sun', sp['sunId']), one(paths[1], 'Mountain', sp['mountainId']))
    src = src[:mm.start()] + box + src[e:]

if cfg.get('fixedSizes'):      # hug/fill sizes -> fixed, using the size Figma gave each box (older runtimes mis-compute hug/fill and lose the content)
    def fixsz(m_):
        el, st = m_.group(1), m_.group(2)
        st = re.sub(r'layout(Width|Height)ScaleType="(?:fill|hug)"', r'layout\1ScaleType="fixed"', st)
        return el + st
    src = re.sub(r'(<LayoutComponent\b[^>]*>\s*)(<LayoutComponentStyle\b[^>]*/>)', fixsz, src)

for ov in cfg.get('overlayShapes', []):    # lift one path of a shape out into its own free-standing shape (no new layout box), drawn above `before`
    mm = re.search(r'<Shape\b[^>]*\bid="%s"[^>]*>' % re.escape(ov['shapeId']), src)
    e = end_of(src, mm.start()); shp = src[mm.start():e]
    paths = re.findall(r'<PointsPath[^>]*>[\s\S]*?</PointsPath>', shp)
    fill = re.search(r'<Fill\b[\s\S]*?</Fill>', shp).group(0)
    src = src[:mm.start()] + shp.replace(paths[ov.get('pathIndex', 0)], '', 1) + src[e:]
    xml = '<Shape x="%s" y="%s" name="%s" id="%s"><Ellipse width="%s" height="%s" name="Path"/>%s</Shape>' % (num(ov['x']), num(ov['y']), ov['name'], ov['id'], num(ov['size']), num(ov['size']), fill)
    bm = re.search(r'<(LayoutComponent|Shape)\b[^>]*\bid="%s"[^>]*>' % re.escape(ov['before']), src)
    src = src[:bm.start()] + xml + src[bm.start():]

for gid in cfg.get('unrotate', []):       # bake a rotated layout group's rotation into its children (some runtimes place a rotated layout differently)
    mm = re.search(r'<LayoutComponent\b([^>]*)\bid="%s"([^>]*)>\s*<LayoutComponentStyle([^>]*)/>' % re.escape(gid), src)
    if not mm:
        print('WARN: no group', gid); continue
    attrs = mm.group(1) + mm.group(2)
    th = float(re.search(r'\brotation="([^"]*)"', attrs).group(1)); w_ = float(re.search(r'\bwidth="([^"]*)"', attrs).group(1)); h_ = float(re.search(r'\bheight="([^"]*)"', attrs).group(1))
    sty = mm.group(3)
    gl = float(re.search(r'positionLeft="([^"]*)"', sty).group(1)); gt = float(re.search(r'positionTop="([^"]*)"', sty).group(1))
    cx, cy = gl + w_ / 2, gt + h_ / 2
    e = end_of(src, mm.start()); grp = src[mm.start():e]
    def fix_shape(m_):
        x, y = float(m_.group(1)), float(m_.group(2)); rot = float(m_.group(3) or 0)
        dx, dy = x - w_ / 2, y - h_ / 2
        nx = cx + dx * math.cos(th) - dy * math.sin(th); ny = cy + dx * math.sin(th) + dy * math.cos(th)
        return '<Shape x="%s" y="%s" rotation="%s"' % (num(nx), num(ny), num(rot + th))
    grp2 = re.sub(r'<Shape x="([\d.\-]+)" y="([\d.\-]+)"(?: rotation="([\d.\-]+)")?', fix_shape, grp)
    grp2 = re.sub(r'(<LayoutComponent\b[^>]*?) rotation="[^"]*"', r'\1', grp2, 1)
    grp2 = grp2.replace('positionLeft="%s"' % re.search(r'positionLeft="([^"]*)"', sty).group(1), 'positionLeft="0"', 1).replace('positionTop="%s"' % re.search(r'positionTop="([^"]*)"', sty).group(1), 'positionTop="0"', 1)
    grp2 = re.sub(r'<ComponentOrigin[^>]*/>', '', grp2, 1)
    src = src[:mm.start()] + grp2 + src[e:]

# a straight connector that crosses behind a card is split at its middle into two paths that both run outward
for it in items:
    if not it.get('split'):
        continue
    mm = re.search(r'<Shape\b[^>]*\bid="%s"[^>]*>' % re.escape(it['id']), src)
    e = end_of(src, mm.start())
    shp = src[mm.start():e]
    pp = re.search(r'<PointsPath[^>]*>[\s\S]*?</PointsPath>', shp)
    L = max(abs(float(v)) for v in re.findall(r'<StraightVertex x="([\d.\-]+)"', pp.group(0)))
    head = pp.group(0)[:pp.group(0).index('>') + 1]
    def half(x):
        return head + '<StraightVertex x="0" y="0"/><StraightVertex x="%s" y="0"/></PointsPath>' % num(x)
    a_ = shp.replace(pp.group(0), half(L))
    b_ = shp.replace(pp.group(0), half(-L)).replace(' id="%s"' % it['id'], ' id="%s"' % it['splitId'], 1)
    b_ = re.sub(r'(<Shape\b[^>]*?) name="([^"]*)"', lambda m_: '%s name="%s B"' % (m_.group(1), m_.group(2)), b_, 1)
    src = src[:mm.start()] + a_ + b_ + src[e:]

for cid, sid, tid, n, rev, extras in streaks:
    mm = re.search(r'<Shape x="([\d.\-]+)" y="([\d.\-]+)"[^>]*\bid="%s"[^>]*>\s*(<PointsPath[\s\S]*?</PointsPath>)' % re.escape(cid), src)
    xs = [float(v) for v in re.findall(r'<\w*Vertex x="([\d.\-]+)"', mm.group(3))]
    rot = re.search(r'<Shape\b[^>]*\brotation="([^"]*)"[^>]*\bid="%s"' % re.escape(cid), src)   # a rotated connector needs a rotated streak
    rot_attr = ' rotation="%s"' % rot.group(1) if rot else ''
    g0, g1 = num(xs[-1] if rev else xs[0]), num(xs[0] if rev else xs[-1])
    def stroke_(th, trim_id, stroke_id=None):
        return ('<Stroke thickness="%s" cap="round" join="round" name="Stroke"%s>'
                '<LinearGradient startX="%s" startY="0" endX="%s" endY="0" name="Gradient"><GradientStop colorValue="FF2152DB" position="0"/>'
                '<GradientStop colorValue="FF99AFEE" position="1"/></LinearGradient>'
                '<TrimPath start="0" end="0" modeValue="1" name="Trim" id="%s"/></Stroke>') % (th, (' id="%s"' % stroke_id) if stroke_id else '', g0, g1, trim_id)
    strokes = ''.join(stroke_(0, tk, sk) for tk, sk in extras) + stroke_(cfg.get('streakThickness', 1.5), tid)
    xml = '<Shape x="%s" y="%s"%s name="Streak %d" id="%s">%s%s</Shape>' % (mm.group(1), mm.group(2), rot_attr, n + 1, sid, mm.group(3), strokes)
    at = re.search(r'<Shape\b[^>]*\bid="%s"[^>]*>' % re.escape(cid), src).start()
    src = src[:at] + xml + src[at:]     # first child draws on top, so inserting before puts the streak above the dashes
for it in items:           # hover glows sit just under their target
    g = it.get('glow')
    if g and it['id'] in glow_ids:
        insert_after(it['id'], '<Shape x="%s" y="%s" opacity="0" name="Hover glow %s" id="%s"><Ellipse width="%s" height="%s" name="Path"/>'
                     '<Fill fillRule="clockwise" name="Fill"><SolidColor colorValue="%s" name="Color"/><Feather strength="%s" name="Feather"/></Fill></Shape>'
                     % (num(g['x']), num(g['y']), it['name'], glow_ids[it['id']], num(g['w']), num(g['h']), g['color'], g.get('blur', 30)))
if pulse_xml and cfg['pulse'].get('before'):
    mm = re.search(r'<(LayoutComponent|Shape)\b[^>]*\bid="%s"[^>]*>' % re.escape(cfg['pulse']['before']), src)
    src = src[:mm.start()] + pulse_xml + src[mm.start():]
elif pulse_xml:
    insert_after(cfg['pulse']['after'], pulse_xml)
if burst_xml and cfg['burst'].get('before'):      # the badge sits straight in the artboard: put the burst just above it in the draw order
    mm = re.search(r'<LayoutComponent\b[^>]*\bid="%s"[^>]*>' % re.escape(cfg['burst']['before']), src)
    src = src[:mm.start()] + burst_xml + src[mm.start():]
elif burst_xml:
    mm = re.search(r'<LayoutComponent\b[^>]*\bid="%s"[^>]*>' % re.escape(cfg['burst']['parent']), src)
    nn = re.compile(r'<Node\b[^>]*>').search(src, mm.end())
    src = src[:nn.end()] + burst_xml + src[nn.end():]
for sid, tid in list(trims.items()) + [(k, v) for k, v in conn_trims.items()]:
    mm = re.search(r'<Shape\b[^>]*\bid="%s"[^>]*>[\s\S]*?</Stroke>' % re.escape(sid), src)
    seg = mm.group(0)
    trim_xml = '<TrimPath start="0" end="%d" modeValue="1" name="Trim" id="%s"/>' % (0 if tid in spoke_trim_base else 1, tid)
    if '<DashPath' in seg:          # trim first, then dash: the other order starts the draw somewhere in the middle of a dashed line
        seg = seg.replace('<DashPath', trim_xml + '<DashPath', 1)
        src = src[:mm.start()] + seg + src[mm.end():]
    else:
        src = src[:mm.start()] + seg[:-len('</Stroke>')] + trim_xml + '</Stroke>' + src[mm.end():]
for mc in cfg.get('micro', []):   # needle: move the shape origin onto the pivot so it turns around the hub
    if mc['type'] != 'needle':
        continue
    mm = re.search(r'<Shape x="([\d.\-]+)" y="([\d.\-]+)"([^>]*\bid="%s"[^>]*>)([\s\S]*?)</PointsPath>' % re.escape(mc['id']), src)
    sx, sy = float(mm.group(1)), float(mm.group(2)); dx, dy = sx - mc['pivot'][0], sy - mc['pivot'][1]
    pts = re.sub(r'<StraightVertex x="([\d.\-]+)" y="([\d.\-]+)"/>', lambda v: '<StraightVertex x="%s" y="%s"/>' % (num(float(v.group(1)) + dx), num(float(v.group(2)) + dy)), mm.group(4))
    src = src[:mm.start()] + '<Shape x="%s" y="%s"%s%s</PointsPath>' % (num(mc['pivot'][0]), num(mc['pivot'][1]), mm.group(3), pts) + src[mm.end():]

for rid in cfg.get('remove', []):    # shapes deleted from the design (e.g. a static line the streaks replace)
    mm = re.search(r'<Shape\b[^>]*\bid="%s"[^>]*>' % re.escape(rid), src)
    if mm:
        src = src[:mm.start()] + src[end_of(src, mm.start()):]

for mc in cfg.get('micro', []):
    if mc['type'] == 'dashflow':
        for sid_, did in mc['_dash_ids'].items():
            src = re.sub(r'(<Shape\b[^>]*\bid="%s"[^>]*>[\s\S]*?)<DashPath name="Dashes">' % re.escape(sid_), lambda mm: mm.group(1) + '<DashPath name="Dashes" id="%s">' % did, src, 1)

for mc in cfg.get('micro', []):      # a dashed line that is trimmed shows stray dash pieces ahead of the trim; spokes run as solid lines
    if mc['type'] == 'spoke' and mc.get('noDash'):
        src = re.sub(r'(<Shape\b[^>]*\bid="%s"[^>]*>[\s\S]*?)<DashPath[^>]*>[\s\S]*?</DashPath>' % re.escape(mc['line']), r'\1', src, 1)

# scale around the centre: give every animated layout box a centre origin; give the ring's dash an id
for oid in need_origin:
    pat = re.compile(r'(<LayoutComponent\b[^>]*\bid="%s"[^>]*>\s*<LayoutComponentStyle\b[^>]*/>)' % re.escape(oid))
    if not pat.search(src):
        print('WARN: no layout box for', oid); continue
    src = pat.sub(lambda mm: mm.group(1) + '<ComponentOrigin originX="0.5" originY="0.5" name="Origin"/>', src, 1)
for it in items:
    if it['role'] in ('ring', 'connector') and it.get('dashId'):
        src = re.sub(r'(<Shape\b[^>]*\bid="%s"[^>]*>[\s\S]*?)<DashPath name="Dashes">' % re.escape(it['id']),
                     lambda mm: mm.group(1) + '<DashPath name="Dashes" id="%s">' % it['dashId'], src, 1)
open(scene, 'w').write(src)
print('animations: Entrance %d frames, Idle %d frames, hover on %s' % (last + 6, IDLE, ', '.join(props)))
