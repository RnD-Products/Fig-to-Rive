/* Webflow-safe pass for the converter's RML.
 *
 * Webflow's Rive element (runtime 2.35) differs from the Rive editor in ways that break converted files:
 *   - a layout box inside a plain Node is not drawn,
 *   - rotation (and mirroring) of a layout box is ignored,
 *   - hug-sized text is measured differently and lands off-centre,
 *   - shapes sitting straight under a layout box are stretched,
 *   - scale on a layout box is ignored (not handled here: it only matters for animation).
 * This pass rewrites the structure so the picture comes out the same in both. It works on the RML text, so the same
 * file runs in the plugin UI and in Node. It is the JavaScript twin of Projects/tools/webflow_patch.py and flatten_layout.py.
 *
 * WebflowSafe.apply(rmlText) -> rmlText
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebflowSafe = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- a tiny XML tree (RML is plain, well-formed XML; attribute text is kept as written) ----
  function parse(text) {
    var re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.\-:]*)((?:\s+[\w.\-:]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
    var stack = [], rootEl = null, m;
    while ((m = re.exec(text))) {
      if (m[0].charAt(1) === '!' || m[0].charAt(1) === '?') continue;
      if (m[1]) { stack.pop(); continue; }
      var el = { tag: m[2], attrs: {}, children: [] };
      var ar = /([\w.\-:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, a;
      while ((a = ar.exec(m[3]))) el.attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
      if (stack.length) stack[stack.length - 1].children.push(el); else rootEl = el;
      if (!m[4]) stack.push(el);
    }
    return rootEl;
  }
  function ser(el, out) {
    out.push('<' + el.tag);
    for (var k in el.attrs) out.push(' ' + k + '="' + el.attrs[k] + '"');
    if (!el.children.length) { out.push('/>'); return; }
    out.push('>');
    el.children.forEach(function (c) { ser(c, out); });
    out.push('</' + el.tag + '>');
  }
  function mk(tag, attrs) { return { tag: tag, attrs: attrs || {}, children: [] }; }
  function get(e, k) { return e.attrs[k]; }
  function set(e, k, v) { e.attrs[k] = String(v); }
  function del(e, k) { delete e.attrs[k]; }
  function iter(e, tag, out) { out = out || []; if (!tag || e.tag === tag) out.push(e); e.children.forEach(function (c) { iter(c, tag, out); }); return out; }
  function parentMap(root) { var m = new Map(); (function w(e) { e.children.forEach(function (c) { m.set(c, e); w(c); }); })(root); return m; }
  function removeChild(p, c) { var i = p.children.indexOf(c); if (i >= 0) p.children.splice(i, 1); }
  function f(v, d) { var n = parseFloat(v); return isNaN(n) ? (d === undefined ? 0 : d) : n; }
  function num(v) { var s = (Math.round(v * 10000) / 10000).toString(); return s === '-0' ? '0' : s; }
  function styleOf(e) { for (var i = 0; i < e.children.length; i++) if (e.children[i].tag === 'LayoutComponentStyle') return e.children[i]; return null; }
  function partOf(e) { for (var i = 0; i < e.children.length; i++) if (e.children[i].tag === 'LayoutParticipant') return e.children[i]; return null; }
  function isAbs(e) { var s = styleOf(e); return !!s && get(s, 'positionTypeValue') === 'absolute'; }
  function name(e) { return get(e, 'name') || ''; }

  // ---- 2x3 matrices [a b c d e f] ----
  function mat(x, y, rot, sx, sy) { var c = Math.cos(rot), s = Math.sin(rot); return [c * sx, s * sx, -s * sy, c * sy, x, y]; }
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function nodeMat(e) { return mat(f(get(e, 'x')), f(get(e, 'y')), f(get(e, 'rotation')), f(get(e, 'scaleX'), 1), f(get(e, 'scaleY'), 1)); }
  function applyMat(sh, m) {
    var sx = Math.hypot(m[0], m[1]), sy = (m[0] * m[3] - m[1] * m[2]) / (sx || 1);
    set(sh, 'x', num(m[4])); set(sh, 'y', num(m[5])); set(sh, 'rotation', num(Math.atan2(m[1], m[0])));
    if (Math.abs(sx - 1) > 1e-6) set(sh, 'scaleX', num(sx)); else del(sh, 'scaleX');
    if (Math.abs(sy - 1) > 1e-6) set(sh, 'scaleY', num(sy)); else del(sh, 'scaleY');
  }

  // ---- 1. rotated layout boxes that hold only shapes: the rotation moves into the shapes ----
  function bakeRotatedGroups(root) {
    var done = 0, boxes = iter(root, 'LayoutComponent').reverse();
    boxes.forEach(function (g) {
      var th = f(get(g, 'rotation'));
      if (Math.abs(th) < 1e-6) return;
      var ok = true, shapes = [];
      (function collect(e, chain) {
        e.children.forEach(function (c) {
          if (c.tag === 'LayoutComponentStyle' || c.tag === 'ComponentOrigin') return;
          if (c.tag === 'Fill' || c.tag === 'Stroke') { if (e === g) ok = false; return; }
          if (c.tag === 'Node') collect(c, mul(chain, nodeMat(c)));
          else if (c.tag === 'Shape') shapes.push({ sh: c, chain: chain });
          else if (c.tag === 'LayoutComponent' && !c.children.some(function (k) { return k.tag === 'Fill' || k.tag === 'Stroke'; }) && Math.abs(f(get(c, 'rotation'))) < 1e-6) {
            var cs = styleOf(c);
            collect(c, mul(chain, [1, 0, 0, 1, cs ? f(get(cs, 'positionLeft')) : 0, cs ? f(get(cs, 'positionTop')) : 0]));
          } else ok = false;
        });
      })(g, [1, 0, 0, 1, 0, 0]);
      if (!ok || !shapes.length) return;
      var w = f(get(g, 'width')), h = f(get(g, 'height'));
      var org = g.children.filter(function (c) { return c.tag === 'ComponentOrigin'; })[0];
      var px = org ? f(get(org, 'originX')) * w : 0, py = org ? f(get(org, 'originY')) * h : 0;
      var about = mul(mat(px, py, 0, 1, 1), mul(mat(0, 0, th, 1, 1), mat(-px, -py, 0, 1, 1)));
      shapes.forEach(function (s) { applyMat(s.sh, mul(about, mul(s.chain, nodeMat(s.sh)))); });
      var par = parentMap(root);
      shapes.forEach(function (s) { removeChild(par.get(s.sh), s.sh); });
      g.children = g.children.filter(function (c) { return c.tag !== 'Node' && c.tag !== 'LayoutComponent'; });
      var node = mk('Node', { name: (get(g, 'name') || 'box') + ' (Baked)' });
      shapes.forEach(function (s) { node.children.push(s.sh); });
      g.children.push(node);
      del(g, 'rotation');
      done++;
    });
    return done;
  }

  // ---- 2. a round layout box turned 180 degrees that still carries paint ----
  function bakeHalfTurn(root) {
    var n = 0;
    iter(root, 'LayoutComponent').forEach(function (g) {
      if (Math.abs(Math.abs(f(get(g, 'rotation'))) - Math.PI) > 1e-2) return;
      var w = f(get(g, 'width')), h = f(get(g, 'height'));
      (function mirror(box) {
        box.children.forEach(function (c) {
          if (c.tag === 'Fill' || c.tag === 'Stroke') {
            iter(c).forEach(function (gr) {
              if (gr.tag === 'RadialGradient' || gr.tag === 'LinearGradient') {
                [['startX', w], ['endX', w], ['startY', h], ['endY', h]].forEach(function (p) { if (get(gr, p[0]) !== undefined) set(gr, p[0], num(p[1] - f(get(gr, p[0])))); });
              }
              if (gr.tag === 'Feather') ['offsetX', 'offsetY'].forEach(function (k) { if (get(gr, k) !== undefined) set(gr, k, num(-f(get(gr, k)))); });
            });
          } else if (c.tag === 'LayoutComponent') mirror(c);
        });
      })(g);
      var turn = mul(mat(w / 2, h / 2, 0, 1, 1), mul(mat(0, 0, Math.PI, 1, 1), mat(-w / 2, -h / 2, 0, 1, 1)));
      (function turnNodes(box) {
        box.children.forEach(function (c) {
          if (c.tag === 'Node') applyMatNode(c, mul(turn, nodeMat(c)));
          else if (c.tag === 'LayoutComponent') turnNodes(c);
        });
      })(g);
      del(g, 'rotation');
      n++;
    });
    return n;
  }
  function applyMatNode(nd, m) {
    var sx = Math.hypot(m[0], m[1]), sy = (m[0] * m[3] - m[1] * m[2]) / (sx || 1);
    set(nd, 'x', num(m[4])); set(nd, 'y', num(m[5])); set(nd, 'rotation', num(Math.atan2(m[1], m[0]))); set(nd, 'scaleX', num(sx)); set(nd, 'scaleY', num(sy));
  }

  // ---- 3. mirrored Nodes (the converter's flip wrappers): the whole transform goes into the shapes ----
  function bakeFlippedNodes(root) {
    var n = 0, par = parentMap(root);
    function plain(e) {
      return e.children.every(function (c) {
        if (c.tag === 'LayoutComponentStyle' || c.tag === 'ComponentOrigin' || c.tag === 'Shape') return true;
        if (c.tag === 'Node') return plain(c);
        if (c.tag === 'LayoutComponent') return !c.children.some(function (k) { return k.tag === 'Fill' || k.tag === 'Stroke'; }) && !get(c, 'rotation') && plain(c);
        return false;
      });
    }
    function collect(e, chain, out) {
      e.children.forEach(function (c) {
        if (c.tag === 'Node') collect(c, mul(chain, nodeMat(c)), out);
        else if (c.tag === 'LayoutComponent') { var s = styleOf(c); collect(c, mul(chain, [1, 0, 0, 1, s ? f(get(s, 'positionLeft')) : 0, s ? f(get(s, 'positionTop')) : 0]), out); }
        else if (c.tag === 'Shape') out.push({ sh: c, chain: chain });
      });
    }
    iter(root, 'Node').forEach(function (nd) {
      if (f(get(nd, 'scaleX'), 1) >= 0 && f(get(nd, 'scaleY'), 1) >= 0) return;
      var p = par.get(nd);
      if (!p || p.tag !== 'LayoutComponent' || !plain(nd)) return;
      var out = []; collect(nd, nodeMat(nd), out);
      if (!out.length) return;
      out.forEach(function (o) { applyMat(o.sh, mul(o.chain, nodeMat(o.sh))); set(o.sh, 'scaleX', get(o.sh, 'scaleX') || '1'); set(o.sh, 'scaleY', get(o.sh, 'scaleY') || '1'); });
      var free = mk('Node', { name: (get(nd, 'name') || 'art') + ' (Free)' });
      out.forEach(function (o) { free.children.push(o.sh); });
      p.children[p.children.indexOf(nd)] = free;
      n++;
    });
    return n;
  }

  // ---- 4. Node wrappers around layout boxes become layout boxes ----
  function nodesToLayouts(root) {
    var n = 0;
    (function walk(el) {
      el.children.slice().forEach(function (c, i) {
        walk(c);
        if (c.tag === 'Node' && el.tag === 'LayoutComponent' && c.children.some(function (k) { return k.tag === 'LayoutComponent'; }) &&
            !['x', 'y', 'rotation'].some(function (a) { return Math.abs(f(get(c, a))) > 1e-6; }) && f(get(c, 'scaleX'), 1) === 1 && f(get(c, 'scaleY'), 1) === 1) {
          var nm = get(c, 'name') || ((get(el, 'name') || 'box') + ' (Box)');
          var box = mk('LayoutComponent', { width: get(el, 'width') || '0', height: get(el, 'height') || '0', clip: 'false', name: nm });
          if (get(c, 'id')) set(box, 'id', get(c, 'id'));
          var st = mk('LayoutComponentStyle', { layoutWidthScaleType: 'fixed', layoutHeightScaleType: 'fixed', positionTypeValue: 'absolute', positionLeft: '0', positionLeftUnitsValue: 'points', positionTop: '0', positionTopUnitsValue: 'points', name: nm + ' Style' });
          var pst = styleOf(el);
          if (pst) for (var k in pst.attrs) if (/^(flex|gap|padding|layoutAlignment)/.test(k)) set(st, k, pst.attrs[k]);
          box.children.push(st);
          c.children.forEach(function (k) { box.children.push(k); });
          el.children[el.children.indexOf(c)] = box;
          n++;
        }
      });
    })(root);
    return n;
  }

  // ---- 5. shapes and texts straight under a layout box (no layout participant) go into a plain Node ----
  function wrapLooseShapes(root) {
    var n = 0;
    iter(root, 'LayoutComponent').forEach(function (box) {
      var out = [], run = [];
      box.children.concat([null]).forEach(function (c) {
        if (c && (c.tag === 'Shape' || c.tag === 'Text') && !partOf(c)) { run.push(c); return; }
        if (run.length) { var nd = mk('Node', { name: (get(box, 'name') || 'box') + ' (Free)' }); nd.children = run; out.push(nd); run = []; n++; }
        if (c) out.push(c);
      });
      box.children = out;
    });
    return n;
  }

  // ---- 6. the big centred text (the AI ball) gets a fixed box ----
  function fixLoneText(root) {
    var n = 0;
    iter(root, 'LayoutComponent').forEach(function (box) {
      var st = styleOf(box);
      if (!st || get(st, 'layoutAlignmentType') !== 'center' || f(get(box, 'width')) < 80) return;
      var flow = box.children.filter(function (c) { return (c.tag === 'LayoutComponent' && !isAbs(c)) || (c.tag === 'Text' && partOf(c)); });
      if (flow.length !== 1 || flow[0].tag !== 'Text') return;
      var txt = flow[0], lp = partOf(txt);
      if (get(lp, 'layoutWidthScaleType') !== 'hug') return;
      var paint = txt.children.filter(function (c) { return c.tag === 'TextStylePaint'; })[0];
      var lh = f(paint && get(paint, 'lineHeight'), f(paint && get(paint, 'fontSize'), 16));
      set(lp, 'layoutWidthScaleType', 'fixed'); set(lp, 'layoutHeightScaleType', 'fixed');
      set(lp, 'width', num(f(get(box, 'width')) - f(get(st, 'paddingLeft')) - f(get(st, 'paddingRight')))); set(lp, 'height', num(lh));
      set(txt, 'sizingValue', 'fixed'); set(txt, 'alignValue', 'center'); set(txt, 'verticalAlignValue', 'middle');
      n++;
    });
    return n;
  }

  // ---- 7. auto layout baked into absolute positions ----
  function flowChildren(c) {
    var out = [];
    c.children.forEach(function (k) {
      if (k.tag === 'LayoutComponent' && !isAbs(k)) out.push({ el: k, kind: 'layout' });
      else if ((k.tag === 'Shape' || k.tag === 'Text') && partOf(k)) out.push({ el: k, kind: k.tag.toLowerCase() });
    });
    return out;
  }
  function shapeSize(sh, iw, ih) {
    var lp = partOf(sh), w = lp ? f(get(lp, 'width'), -1) : -1, h = lp ? f(get(lp, 'height'), -1) : -1;
    if (lp && w < 0 && get(lp, 'layoutWidthScaleType') === 'fill') w = iw;
    if (lp && h < 0 && get(lp, 'layoutHeightScaleType') === 'fill') h = ih;
    sh.children.forEach(function (c) { if (c.tag === 'Rectangle' || c.tag === 'Ellipse') { if (w < 0) w = f(get(c, 'width')); if (h < 0) h = f(get(c, 'height')); } });
    return [Math.max(w, 0), Math.max(h, 0)];
  }
  function alignParts(a) {
    var v = a.indexOf('top') === 0 ? 'top' : a.indexOf('bottom') === 0 ? 'bottom' : 'center';
    var h = /Left$/.test(a) ? 'left' : /Right$/.test(a) ? 'right' : 'center';
    if (a === 'center') { v = 'center'; h = 'center'; }
    if (a === 'centerLeft') { v = 'center'; h = 'left'; }
    if (a === 'centerRight') { v = 'center'; h = 'right'; }
    return [v, h];
  }
  function place(cont, stats) {
    var st = styleOf(cont);
    if (!st) return;
    var kids = flowChildren(cont);
    if (!kids.length) return;
    var texts = kids.filter(function (k) { return k.kind === 'text'; }).map(function (k) { return k.el; });
    if (texts.some(function (t) { return get(t, 'sizingValue') === 'fixed'; })) return;
    var row = ['row', 'rowReverse'].indexOf(get(st, 'flexDirectionValue') || 'row') >= 0;
    var algn = get(st, 'layoutAlignmentType') || 'topLeft';
    if (texts.length) {
      var lastOk = kids[kids.length - 1].kind === 'text' && texts.length === 1, sole = kids.length === 1;
      var leftMain = row ? ['topLeft', 'centerLeft', 'bottomLeft'].indexOf(algn) >= 0 : algn.indexOf('top') === 0;
      if (!((lastOk && leftMain) || (sole && ['center', 'centerLeft', 'topLeft'].indexOf(algn) >= 0))) return;
    }
    var cw = f(get(cont, 'width')), ch = f(get(cont, 'height'));
    var pl = f(get(st, 'paddingLeft')), pr = f(get(st, 'paddingRight')), pt = f(get(st, 'paddingTop')), pb = f(get(st, 'paddingBottom'));
    var gap = f(get(st, row ? 'gapHorizontal' : 'gapVertical'));
    var between = algn.indexOf('spaceBetween') === 0, v, h;
    if (between) {
      var cross = algn.slice('spaceBetween'.length);
      if (row) { v = cross === 'Start' ? 'top' : cross === 'Center' ? 'center' : 'bottom'; h = 'left'; }
      else { v = 'top'; h = cross === 'Start' ? 'left' : cross === 'Center' ? 'center' : 'right'; }
    } else { var ap = alignParts(algn); v = ap[0]; h = ap[1]; }
    var iw = cw - pl - pr, ih = ch - pt - pb, sizes = [];
    kids.forEach(function (k) {
      if (k.kind === 'layout') sizes.push([f(get(k.el, 'width')), f(get(k.el, 'height'))]);
      else if (k.kind === 'text') { var p = k.el.children.filter(function (c) { return c.tag === 'TextStylePaint'; })[0]; sizes.push([0, f(p && get(p, 'lineHeight'), f(p && get(p, 'fontSize'), 16))]); }
      else sizes.push(shapeSize(k.el, iw, ih));
    });
    var fillOf = function (k, a) { var s = k.kind === 'layout' ? styleOf(k.el) : null; return s && get(s, a) === 'fill'; };
    var grow = [];
    kids.forEach(function (k, i) { if (fillOf(k, row ? 'layoutWidthScaleType' : 'layoutHeightScaleType')) grow.push(i); });
    if (grow.length) {
      var used = gap * (kids.length - 1);
      sizes.forEach(function (z, i) { if (grow.indexOf(i) < 0) used += row ? z[0] : z[1]; });
      var share = Math.max(0, ((row ? iw : ih) - used) / grow.length);
      grow.forEach(function (i) { if (row) sizes[i][0] = share; else sizes[i][1] = share; });
    }
    kids.forEach(function (k, i) { if (fillOf(k, row ? 'layoutHeightScaleType' : 'layoutWidthScaleType')) { if (row) sizes[i][1] = ih; else sizes[i][0] = iw; } });
    kids.forEach(function (k, i) { if (k.kind === 'layout') { set(k.el, 'width', num(sizes[i][0])); set(k.el, 'height', num(sizes[i][1])); } });
    var sum = function () { return sizes.reduce(function (a, z) { return a + (row ? z[0] : z[1]); }, 0); };
    if (between && kids.length > 1) gap = Math.max(0, ((row ? iw : ih) - sum()) / (kids.length - 1));
    var total = sum() + gap * (kids.length - 1), room = row ? iw : ih, mainAlign = row ? h : v, crossAlign = row ? v : h;
    var off = function (al, free) { return al === 'center' ? free / 2 : (al === 'right' || al === 'bottom') ? free : 0; };
    var pos = (row ? pl : pt) + off(mainAlign, room - total), moved = [];
    kids.forEach(function (k, i) {
      var w = sizes[i][0], hh = sizes[i][1], crossRoom = row ? ih : iw, csize = row ? hh : w;
      var cpos = (row ? pt : pl) + off(crossAlign, crossRoom - csize);
      var left = row ? pos : cpos, top = row ? cpos : pos, e = k.el;
      if (k.kind === 'text') {
        removeChild(e, partOf(e));
        if (kids.length === 1 && mainAlign === 'center') { set(e, 'x', num(pl + iw / 2)); set(e, 'y', num(pt + ih / 2)); set(e, 'originX', '0.5'); set(e, 'originY', '0.5'); set(e, 'alignValue', 'center'); }
        else { set(e, 'x', num(left)); set(e, 'y', num(top)); }
        moved.push(e);
      } else if (k.kind === 'layout') {
        var es = styleOf(e);
        set(es, 'positionTypeValue', 'absolute'); set(es, 'positionLeft', num(left)); set(es, 'positionLeftUnitsValue', 'points'); set(es, 'positionTop', num(top)); set(es, 'positionTopUnitsValue', 'points');
        set(es, 'layoutWidthScaleType', 'fixed'); set(es, 'layoutHeightScaleType', 'fixed');
      } else {
        set(e, 'x', num(left + w / 2)); set(e, 'y', num(top + hh / 2)); removeChild(e, partOf(e)); moved.push(e);
        e.children.forEach(function (p) { if (p.tag === 'Rectangle' || p.tag === 'Ellipse') { set(p, 'width', num(w)); set(p, 'height', num(hh)); } });
      }
      stats.placed++;
      pos += (row ? w : hh) + gap;
    });
    if (moved.length) {
      var at = cont.children.indexOf(moved[0]), wrap = mk('Node', { name: (get(cont, 'name') || 'box') + ' (Flat)' });
      moved.forEach(function (e) { removeChild(cont, e); wrap.children.push(e); });
      cont.children.splice(at, 0, wrap);
    }
  }

  // ---- 8. blend modes Webflow cannot draw: a plain gradient in the same colours ----
  function plainBlends(root) {
    var n = 0, par = parentMap(root);
    iter(root, 'Shape').forEach(function (sh) {
      if (get(sh, 'blendModeValue') !== 'hue') return;
      del(sh, 'blendModeValue');
      iter(sh, 'GradientStop').forEach(function (gs, i) {
        var c = (get(gs, 'colorValue') || '').toUpperCase();
        if (c === 'E5FF00AA') set(gs, 'colorValue', '9CFFA8D4');
        else if (c === 'E5FFFFFF') set(gs, 'colorValue', '00FFC8E4');
        else if (c.length === 8) set(gs, 'colorValue', Math.round(parseInt(c.slice(0, 2), 16) * 0.6).toString(16).toUpperCase().padStart(2, '0') + c.slice(2));
      });
      n++;
    });
    iter(root, 'Fill').forEach(function (fl) {
      if (get(fl, 'blendModeValue') !== 'additive') return;
      var stops = iter(fl, 'GradientStop').map(function (g) { return (get(g, 'colorValue') || '').toUpperCase(); });
      var p = par.get(fl);
      if (stops.join() === '80000DFF,80666666' && p) {      // the picture-box gradient: one opaque gradient replaces the white fill and the additive one
        var prev = p.children[p.children.indexOf(fl) - 1];
        if (prev && prev.tag === 'Fill') removeChild(p, prev);
        del(fl, 'blendModeValue');
        iter(fl, 'GradientStop').forEach(function (g, i) { set(g, 'colorValue', i === 0 ? 'FFDCE4FF' : 'FFF1F7FF'); });
      } else del(fl, 'blendModeValue');
      n++;
    });
    return n;
  }

  function apply(rml) {
    var rootEl = parse(rml);
    if (!rootEl) return rml;
    var stats = { placed: 0 };
    bakeRotatedGroups(rootEl);
    bakeHalfTurn(rootEl);
    bakeFlippedNodes(rootEl);
    nodesToLayouts(rootEl);
    wrapLooseShapes(rootEl);
    fixLoneText(rootEl);
    iter(rootEl, 'LayoutComponent').forEach(function (b) { place(b, stats); });
    plainBlends(rootEl);
    var out = [];
    ser(rootEl, out);
    return out.join('');
  }

  return { apply: apply, parse: parse, serialize: function (e) { var o = []; ser(e, o); return o.join(''); } };
});
