/* Figma snapshot -> Rive RML.
 *
 * Pure function, no Figma API: it takes the plain-JSON snapshot that code.js
 * extracts, so the same file runs inside the plugin UI and in Node for tests.
 *
 * The two rules this plugin exists for:
 *   1. Auto layout is never flattened. An auto layout frame becomes a
 *      LayoutComponent (+ LayoutComponentStyle); children that sit in the flow
 *      get a LayoutParticipant. Gap, padding, alignment, wrap, hug/fill/fixed and
 *      absolute positioning all carry over as layout properties.
 *   2. Text is never outlined. A TEXT node always becomes Text + TextStylePaint +
 *      TextValueRun, and the font it needs is reported, never baked into paths.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FigmaToRive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Figma keeps the layers inside a group positioned relative to the group's PARENT frame, not to the group.
  // Rive groups are their own space, so move each group's children into group-local coordinates first.
  function mulT(A, B) {
    return [[A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
      [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]]];
  }
  function invT(T) {
    var a = T[0][0], c = T[0][1], tx = T[0][2], b = T[1][0], d = T[1][1], ty = T[1][2], det = a * d - c * b;
    if (Math.abs(det) < 1e-9) return null;
    return [[d / det, -c / det, (c * ty - d * tx) / det], [-b / det, a / det, (b * tx - a * ty) / det]];
  }
  function rebaseGroups(node) {
    var T = node.relativeTransform, out = Object.assign({}, node);
    if (node.children) {
      out.children = node.children.map(function (c) {
        var cT = c.relativeTransform, kid = rebaseGroups(c), inv = (node.type === 'GROUP' && T && cT) ? invT(T) : null;
        if (inv) { var m = mulT(inv, cT); kid.relativeTransform = m; kid.x = m[0][2]; kid.y = m[1][2]; }
        return kid;
      });
    }
    return out;
  }

  function convert(snapshot, options) {
    snapshot = Object.assign({}, snapshot, { nodes: (snapshot.nodes || []).map(rebaseGroups), components: (snapshot.components || []).map(rebaseGroups) });
    options = options || {};
    var warnings = [];
    var fonts = {}; // key -> {family, style, file, assetId}
    var nextId = 100;
    var fontAssetIds = {};
    var imageAssets = {};   // hash -> {file, id, hash, ext}
    var notes = [];
    var detached = 0;
    var seenWarn = {};
    var frameAsLayout = options.frameMode === 'layout';
    var componentArtboards = options.componentArtboards !== false;

    function id() { return '0:' + nextId++; }
    function warn(node, msg) {
      var k = msg + '|' + (node && node.type);
      var line = (node ? '"' + node.name + '" (' + node.type + '): ' : '') + msg;
      if (seenWarn[line]) return;
      seenWarn[line] = true;
      warnings.push(line);
    }
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;');
    }
    function num(v) { return String(Math.round(v * 1000) / 1000); }
    function attr(name, v) { return v === undefined || v === null ? '' : ' ' + name + '="' + esc(v) + '"'; }

    // ---- colour -------------------------------------------------------
    function hex2(v) { var s = Math.max(0, Math.min(255, Math.round(v * 255))).toString(16); return s.length < 2 ? '0' + s : s; }
    function colorHex(c, opacity) {
      var a = (c.a === undefined ? 1 : c.a) * (opacity === undefined ? 1 : opacity);
      return (hex2(a) + hex2(c.r) + hex2(c.g) + hex2(c.b)).toUpperCase();
    }

    // ---- paint --------------------------------------------------------
    function invert(t) { // 2x3 affine [[a,c,e],[b,d,f]]
      var a = t[0][0], c = t[0][1], e = t[0][2], b = t[1][0], d = t[1][1], f = t[1][2];
      var det = a * d - b * c;
      if (!det) return [[1, 0, 0], [0, 1, 0]];
      return [[d / det, -c / det, (c * f - d * e) / det], [-b / det, a / det, (b * e - a * f) / det]];
    }
    function apply(t, x, y) { return [t[0][0] * x + t[0][1] * y + t[0][2], t[1][0] * x + t[1][1] * y + t[1][2]]; }

    // centered: the paint belongs to a Shape, whose local origin is its centre. A layout box (and the artboard) measures from its top-left.
    function paintBody(paint, node, w, h, extraOpacity, centered) {
      var gx = centered ? w / 2 : 0, gy = centered ? h / 2 : 0;
      var op = (paint.opacity === undefined ? 1 : paint.opacity) * (extraOpacity === undefined ? 1 : extraOpacity);
      if (paint.type === 'SOLID') {
        return '<SolidColor colorValue="' + colorHex(paint.color, op) + '" name="Color"/>';
      }
      if (paint.type === 'GRADIENT_LINEAR' && paint.gradientTransform && paint.gradientStops) {
        var inv = invert(paint.gradientTransform);
        var s = apply(inv, 0, 0.5), e = apply(inv, 1, 0.5);
        var stops = paint.gradientStops.map(function (st) {
          return '<GradientStop colorValue="' + colorHex(st.color, op) + '" position="' + num(st.position) + '"/>';
        }).join('');
        return '<LinearGradient startX="' + num(s[0] * w - gx) + '" startY="' + num(s[1] * h - gy) + '" endX="' + num(e[0] * w - gx) +
          '" endY="' + num(e[1] * h - gy) + '" name="Gradient">' + stops + '</LinearGradient>';
      }
      if (paint.type === 'GRADIENT_RADIAL' && paint.gradientTransform && paint.gradientStops) {
        // Figma's gradient space has the centre at (0.5,0.5) and the radius running to (1,0.5).
        var invR = invert(paint.gradientTransform);
        var c0 = apply(invR, 0.5, 0.5), c1 = apply(invR, 1, 0.5), c2 = apply(invR, 0.5, 1);
        var rx = Math.hypot((c1[0] - c0[0]) * w, (c1[1] - c0[1]) * h), ry = Math.hypot((c2[0] - c0[0]) * w, (c2[1] - c0[1]) * h);
        if (Math.abs(rx - ry) > Math.max(rx, ry) * 0.12) warn(node, 'elliptical radial gradient imported as a circular one');
        var rstops = paint.gradientStops.map(function (st) {
          return '<GradientStop colorValue="' + colorHex(st.color, op) + '" position="' + num(st.position) + '"/>';
        }).join('');
        var cx0 = c0[0] * w - gx, cy0 = c0[1] * h - gy;
        // Rive's radial gradient is a circle. For an elliptical one, pick the circle that best matches the ellipse over the area the shape covers.
        var rrad = (rx + ry) / 2;
        if (options.ellipseRadial !== 'average' && Math.abs(rx - ry) > Math.max(rx, ry) * 0.12) {
          var Ax = (c1[0] - c0[0]) * w, Ay = (c1[1] - c0[1]) * h, Bx = (c2[0] - c0[0]) * w, By = (c2[1] - c0[1]) * h, det = Ax * By - Ay * Bx;
          if (Math.abs(det) > 1e-6) {
            var pts = [], gi, gj;
            for (gj = 0; gj < 8; gj++) for (gi = 0; gi < 16; gi++) {
              var px = ((gi + 0.5) / 16) * w - cx0 - gx, py = ((gj + 0.5) / 8) * h - cy0 - gy;
              if (!centered) { px = ((gi + 0.5) / 16) * w - cx0; py = ((gj + 0.5) / 8) * h - cy0; }
              var uu = (px * By - py * Bx) / det, vv = (Ax * py - Ay * px) / det;
              pts.push([Math.min(1, Math.hypot(uu, vv)), Math.hypot(px, py)]);
            }
            var best = rrad, bestErr = Infinity, R, k;
            for (R = Math.min(rx, ry) * 0.5; R <= Math.max(rx, ry) * 1.2; R += Math.max(0.5, Math.min(rx, ry) / 60)) {
              var err = 0; for (k = 0; k < pts.length; k++) { var d = pts[k][0] - Math.min(1, pts[k][1] / R); err += d * d; }
              if (err < bestErr) { bestErr = err; best = R; }
            }
            rrad = best;
          }
        }
        return '<RadialGradient startX="' + num(cx0) + '" startY="' + num(cy0) + '" endX="' + num(cx0 + rrad) + '" endY="' + num(cy0) +
          '" name="Gradient">' + rstops + '</RadialGradient>';
      }
      if (paint.type.indexOf('GRADIENT') === 0) {
        warn(node, paint.type + ' fill is not converted yet; using its first stop as a solid colour');
        var st0 = paint.gradientStops && paint.gradientStops[0];
        return st0 ? '<SolidColor colorValue="' + colorHex(st0.color, op) + '" name="Color"/>' : null;
      }
      return null; // IMAGE paints are placed as Image drawables, not as a paint
    }
    function visiblePaints(list) {
      return (list || []).filter(function (p) { return p.visible !== false && p.opacity !== 0; });
    }
    function findImage(node) {
      var imgs = visiblePaints(node.fills).filter(function (p) { return p.type === 'IMAGE'; });
      return imgs.length ? imgs[imgs.length - 1] : null;
    }
    // Plain fills only (artboard background).
    function plainFills(node, w, h) {
      return visiblePaints(node.fills).filter(function (p) { return p.type !== 'IMAGE'; }).map(function (p) {
        var body = paintBody(p, node, w, h);
        return body ? '<Fill' + paintBlend(p, node) + ' name="Fill">' + body + '</Fill>' : '';
      }).join('');
    }

    // All the paints of one shape / layout box, in Rive's draw order (later paints draw on top):
    //   drop shadows (feathered fills) -> outside stroke -> fills -> inner shadows -> strokes
    // Shadows and layer blur use Feather; INSIDE strokes are a 2x stroke the caller clips to the shape.
    function paintsXml(node, w, h, o) {
      o = o || {};
      var fx = (node.effects || []).filter(function (e) { return e.visible !== false; });
      var drops = fx.filter(function (e) { return e.type === 'DROP_SHADOW'; });
      var inners = fx.filter(function (e) { return e.type === 'INNER_SHADOW'; });
      var blur = fx.filter(function (e) { return e.type === 'LAYER_BLUR'; })[0];
      if (fx.some(function (e) { return e.type === 'BACKGROUND_BLUR'; })) warn(node, 'background blur is not supported');
      var fills = o.lineOnly ? [] : visiblePaints(node.fills).filter(function (p) { return p.type !== 'IMAGE'; });
      var strokes = visiblePaints(node.strokes);
      var sw = typeof node.strokeWeight === 'number' ? node.strokeWeight : 0;
      var hasStroke = strokes.length && sw > 0;
      var surface = fills.length || hasStroke || o.hasImage;
      var blurFx = blur ? '<Feather strength="' + num(blur.radius) + '" name="Feather"/>' : '';
      if (blur && o.hasChildren) warn(node, 'layer blur only blurs this box\'s own paint, not the things inside it');

      function featherFill(e, inner) {
        if (e.spread && !(o.splitShadow && !o.flowShadow && !inner)) warn(node, 'shadow spread is ignored');
        // An inner shadow cannot spread further than the shape is wide; huge blur values (Figma allows them) would just wash
        // everything out when drawn over the contents, so the strength is capped relative to the shape's smaller side.
        var strength = e.radius;
        if (inner && o.splitInner) strength = Math.min(e.radius * (options.innerShadowScale || 1), (options.innerShadowCap || 0.7) * Math.min(w, h));
        return '<Fill fillRule="clockwise"' + (options.effectBlendModes === false ? '' : paintBlend(e, node)) + ' name="' + (inner ? 'Inner Shadow' : 'Shadow') + '"><SolidColor colorValue="' + colorHex(e.color) +
          '" name="Color"/><Feather strength="' + num(strength) + '" offsetX="' + num(e.offset ? e.offset.x : 0) + '" offsetY="' +
          num(e.offset ? e.offset.y : 0) + '"' + (inner ? ' inner="true"' : '') + ' name="Feather"/></Fill>';
      }
      var dashFx = '';
      // Figma's dash lengths are the VISIBLE lengths, round ends included. Rive's round caps add half the stroke width to each end of a dash,
      // so shorten the dashes and lengthen the gaps by the stroke width to look the same.
      function buildDash(round) {
        var dp = node.dashPattern.length % 2 ? node.dashPattern.concat(node.dashPattern) : node.dashPattern, sw0 = node.strokeWeight || 1;
        return '<DashPath name="Dashes">' + dp.map(function (d, i) {
          var v = round ? (i % 2 ? d + sw0 : Math.max(0.05, d - sw0)) : d;
          return '<Dash length="' + num(v) + '" name="' + (i % 2 ? 'Gap' : 'Dash') + '"/>';
        }).join('') + '</DashPath>';
      }
      if (node.dashPattern && node.dashPattern.length) dashFx = buildDash(false);
      // Stroke ends and corners follow Figma. Old snapshots do not carry them: keep the previous round look, except for
      // dashed strokes where round ends would swallow the gaps.
      var CAP = { NONE: 'butt', ROUND: 'round', SQUARE: 'square' }, JOIN = { MITER: 'miter', ROUND: 'round', BEVEL: 'bevel' };
      // A dashed line whose ends carry caps (dots, arrows) has round dash ends in Figma, like a line whose cap is Round.
      var dashRound = dashFx && !node.strokeCap && node.endCaps && node.endCaps.length;
      var capV = CAP[node.strokeCap] || (dashRound ? 'round' : (dashFx ? 'butt' : 'round')), joinV = JOIN[node.strokeJoin] || (o.forceCenter ? 'miter' : 'round');
      if (dashFx && capV === 'round') dashFx = buildDash(true);
      if (node.strokeCap && !CAP[node.strokeCap] && node.strokeCap !== 'ARROW_LINES') warn(node, 'stroke end "' + node.strokeCap + '" (arrows) is drawn as a plain end');
      // Rive has no angular (sweep) gradient. On a ring, draw it as many short arcs, each in the colour the sweep has there.
      function angularStrokes(p, thickness) {
        var inv = invert(p.gradientTransform), c0 = apply(inv, 0.5, 0.5), cx = apply(inv, 1, 0.5), cy = apply(inv, 0.5, 1);
        var xd = [(cx[0] - c0[0]) * w, (cx[1] - c0[1]) * h], yd = [(cy[0] - c0[0]) * w, (cy[1] - c0[1]) * h];
        var a0 = Math.atan2(xd[1], xd[0]), dir = (xd[0] * yd[1] - xd[1] * yd[0]) >= 0 ? 1 : -1;
        var stops = p.gradientStops.slice().sort(function (a, b) { return a.position - b.position; });
        function at(t) {
          var lo = stops[0], hi = stops[stops.length - 1], i;
          for (i = 0; i < stops.length - 1; i++) if (t >= stops[i].position && t <= stops[i + 1].position) { lo = stops[i]; hi = stops[i + 1]; break; }
          var span = hi.position - lo.position, f = span > 1e-9 ? Math.min(1, Math.max(0, (t - lo.position) / span)) : 0;
          if (t <= stops[0].position) return stops[0].color; if (t >= stops[stops.length - 1].position) return stops[stops.length - 1].color;
          var m = function (k) { return (lo.color[k] === undefined ? 1 : lo.color[k]) * (1 - f) + (hi.color[k] === undefined ? 1 : hi.color[k]) * f; };
          return { r: m('r'), g: m('g'), b: m('b'), a: m('a') };
        }
        var N = 48, out = '', op = p.opacity === undefined ? 1 : p.opacity;
        for (var i = 0; i < N; i++) {
          var t0 = i / N, t1 = (i + 1) / N, col = at((t0 + t1) / 2);
          if ((col.a === undefined ? 1 : col.a) * op < 0.01) continue;
          // where this slice sits on Rive's ring, which starts at the top and runs clockwise (0..1 of the way round)
          var u = (((a0 + dir * 2 * Math.PI * (dir > 0 ? t0 : t1) + Math.PI / 2) / (2 * Math.PI)) % 1 + 1) % 1;
          out += '<Stroke thickness="' + num(thickness) + '" cap="butt" join="' + (JOIN[node.strokeJoin] || 'miter') + '" name="Stroke">' +
            '<SolidColor colorValue="' + colorHex(col, op) + '" name="Color"/>' + dashFx +
            '<TrimPath start="0" end="' + num(1 / N + 0.0008) + '" offset="' + num(u) + '" modeValue="1" name="Arc"/></Stroke>';
        }
        return out;
      }
      // Frosted-glass cards: Figma draws their gradient border (one that fades to a transparent white) as a clear, near-white line all the way
      // round, whatever the stop alphas and paint opacity say. Measured on two real designs: about 85% white. Match that.
      var glassBlur = (node.effects || []).some(function (e) { return e.visible !== false && e.type === 'BACKGROUND_BLUR'; });
      function glassBorder(p) {
        if (!glassBlur || p.type !== 'GRADIENT_LINEAR' || !p.gradientStops || !p.gradientStops.some(function (g) { return (g.color.a === undefined ? 1 : g.color.a) < 0.05; })) return p;
        return { type: 'SOLID', visible: true, opacity: 1, color: { r: 1, g: 1, b: 1, a: 0.85 } };
      }
      function strokesAt(thickness) {
        return strokes.map(function (p0) {
          var p = glassBorder(p0);
          if (options.angularRings === 'strokes' && p.type === 'GRADIENT_ANGULAR' && node.type === 'ELLIPSE' && p.gradientTransform && p.gradientStops && p.gradientStops.length) return angularStrokes(p, thickness);
          var body = paintBody(p, node, w, h, undefined, o.centered);
          return body ? '<Stroke thickness="' + num(thickness) + '" cap="' + capV + '" join="' + joinV + '"' + paintBlend(p, node) + ' name="Stroke">' + body + dashFx + blurFx + (node.__arc ? '<TrimPath start="0" end="' + num(node.__arc.len) + '" offset="' + num(node.__arc.offset) + '" modeValue="1" name="Arc"/>' : '') + '</Stroke>' : '';
        }).join('');
      }

      var out = '', shadowed = false, clip = false, tail = '', shadowOut = '', shadowBoxes = '', innerOut = '';
      if (surface) drops.forEach(function (e) {
        var f = featherFill(e, false);
        if (o.splitShadow && !o.flowShadow && e.spread && Math.abs(e.spread) > 0.01) {
          // Spread grows or shrinks the shadow's shape. The wrapper does not clip, so cast the shadow from a box of that size.
          var sp = e.spread, ssid = id(), bw = Math.max(1, w + 2 * sp), bh = Math.max(1, h + 2 * sp);
          shadowBoxes += '<LayoutComponent width="' + num(bw) + '" height="' + num(bh) + '" styleId="' + ssid + '" clip="false" name="Shadow" id="' + id() + '">' +
            '<LayoutComponentStyle layoutWidthScaleType="fixed" layoutHeightScaleType="fixed" positionTypeValue="absolute" positionLeft="' + num(-sp) + '" positionLeftUnitsValue="points" positionTop="' + num(-sp) + '" positionTopUnitsValue="points"' +
            radiusAttrs(radii(node).map(function (v) { return Math.max(0, v + sp); })) + ' name="Shadow Style" id="' + ssid + '"/>' + f + '</LayoutComponent>';
        } else if (o.splitShadow) shadowOut += f; else out += f;
        shadowed = true;
      });
      var shadowBlocksClip = shadowed && !o.splitShadow;
      var align = o.forceCenter ? 'CENTER' : (node.strokeAlign || 'CENTER');
      if (hasStroke) {
        // An opaque fill (solid, or a gradient with no see-through stops) hides the inner half of a double-width stroke, leaving a true outside stroke.
        var opaque = fills.some(function (p) {
          if (p.opacity !== undefined && p.opacity < 0.99) return false;
          if (p.type === 'SOLID') return p.color.a === undefined || p.color.a >= 0.99;
          if (p.type.indexOf('GRADIENT') === 0 && p.gradientStops && p.gradientStops.length) return p.gradientStops.every(function (g) { return g.color.a === undefined || g.color.a >= 0.99; });
          return false;
        });
        if (align === 'INSIDE' && !shadowBlocksClip && !o.noClip) { tail += strokesAt(sw * 2); clip = true; }
        else if (align === 'OUTSIDE' && o.splitShadow && !o.flowShadow) {
          // The wrapper does not clip, so an outline box slightly larger than the frame, stroked on its centre line, gives a true outside stroke
          // whatever the fill is (a double-width stroke would show through a see-through fill).
          var osid = id();
          shadowBoxes += '<LayoutComponent width="' + num(w + sw) + '" height="' + num(h + sw) + '" styleId="' + osid + '" clip="false" name="Outside Stroke" id="' + id() + '">' +
            '<LayoutComponentStyle layoutWidthScaleType="fixed" layoutHeightScaleType="fixed" positionTypeValue="absolute" positionLeft="' + num(-sw / 2) + '" positionLeftUnitsValue="points" positionTop="' + num(-sw / 2) + '" positionTopUnitsValue="points"' +
            radiusAttrs(radii(node).map(function (v) { return v > 0 ? v + sw / 2 : 0; })) + ' name="Outside Stroke Style" id="' + osid + '"/>' + strokesAt(sw) + '</LayoutComponent>';
        }
        else if (align === 'OUTSIDE' && opaque) { if (o.splitShadow) shadowOut += strokesAt(sw * 2); else out += strokesAt(sw * 2); } // with a shadow wrapper the stroke goes on the wrapper, which does not clip
        else {
          if (align !== 'CENTER') warn(node, 'stroke is ' + align + ' but ' + (align === 'INSIDE' ? 'it also has a shadow that cannot be separated here' : 'the fill is not opaque') + '; it is drawn centred instead');
          tail += strokesAt(sw);
        }
      }
      fills.forEach(function (p) {
        var body = paintBody(p, node, w, h, undefined, o.centered);
        if (body) out += '<Fill' + (blur ? ' fillRule="clockwise"' : node.__evenOdd ? ' fillRule="evenOdd"' : '') + paintBlend(p, node) + ' name="Fill">' + body + blurFx + '</Fill>';
      });
      if (surface) inners.forEach(function (e) { var f = featherFill(e, true); if (o.splitInner) innerOut += f; else out += f; });
      return { xml: out + tail, shadowXml: shadowOut, shadowBoxXml: shadowBoxes, innerXml: innerOut, clip: clip, shadowed: shadowed };
    }

    // ---- blend modes --------------------------------------------------
    var BLEND = { LINEAR_DODGE: 'additive', SCREEN: 'screen', MULTIPLY: 'multiply', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten',
      COLOR_DODGE: 'colorDodge', COLOR_BURN: 'colorBurn', HARD_LIGHT: 'hardLight', SOFT_LIGHT: 'softLight', DIFFERENCE: 'difference',
      EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity' };
    // A single fill or stroke can have its own blend mode too (Figma: the blend icon in the paint popover).
    function paintBlend(paint, node) {
      var b = paint && paint.blendMode;
      if (!b || b === 'NORMAL' || b === 'PASS_THROUGH') return '';
      if (BLEND[b]) return ' blendModeValue="' + BLEND[b] + '"';
      warn(node, 'a fill or stroke uses the ' + b + ' blend mode, which Rive does not have; drawn normally');
      return '';
    }
    function blendAttr(node) {
      var b = node.blendMode;
      if (!b || b === 'NORMAL' || b === 'PASS_THROUGH') return '';
      if (BLEND[b]) return ' blendModeValue="' + BLEND[b] + '"';
      warn(node, 'blend mode ' + b + ' has no Rive equivalent; drawn normally');
      return '';
    }

    // ---- placement (position + rotation) ------------------------------
    // Figma gives x,y of the rotated node's top-left corner; Rive rotates about a centre point.
    function place(node) {
      var w = node.width, h = node.height, m = node.relativeTransform;
      if (m) {
        var a = m[0][0], c = m[0][1], tx = m[0][2], b = m[1][0], d = m[1][1], ty = m[1][2];
        var cx = tx + a * w / 2 + c * h / 2, cy = ty + b * w / 2 + d * h / 2;
        var rot = Math.atan2(b, a);
        if (Math.abs(rot) < 1e-4) rot = 0;
        return { cx: cx, cy: cy, x: cx - w / 2, y: cy - h / 2, rot: rot, flip: a * d - c * b < 0 };
      }
      var r = node.rotation ? -node.rotation * Math.PI / 180 : 0;
      return { cx: node.x + w / 2, cy: node.y + h / 2, x: node.x, y: node.y, rot: r };
    }
    function rotAttr(p) { return p.rot ? ' rotation="' + num(p.rot) + '"' : ''; }
    // A mirrored frame (negative determinant): rotate by atan2(b, a) as usual, and what is left is a top-to-bottom flip of its own contents.
    function flipAttr(p) { return ''; } // a LayoutComponent cannot be mirrored directly; its contents are (see the wrapper Node)

    // ---- corner radius -----------------------------------------------
    function radii(node) {
      if (node.topLeftRadius !== undefined) {
        return [node.topLeftRadius || 0, node.topRightRadius || 0, node.bottomLeftRadius || 0, node.bottomRightRadius || 0];
      }
      var r = typeof node.cornerRadius === 'number' ? node.cornerRadius : 0;
      return [r, r, r, r];
    }
    function radiusAttrs(r) {
      if (!r[0] && !r[1] && !r[2] && !r[3]) return '';
      return ' cornerRadiusTL="' + num(r[0]) + '" cornerRadiusTR="' + num(r[1]) + '" cornerRadiusBL="' + num(r[2]) + '" cornerRadiusBR="' + num(r[3]) + '"';
    }

    // ---- layout -------------------------------------------------------
    var SCALE = { FIXED: 'fixed', HUG: 'hug', FILL: 'fill' };
    function hasAutoLayout(n) { return n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL'; }

    function sizing(node, parentLayoutMode) {
      var h = node.layoutSizingHorizontal, v = node.layoutSizingVertical;
      if (!h || !v) { // older snapshots: derive from grow/align
        var row = parentLayoutMode === 'HORIZONTAL';
        h = h || ((row ? node.layoutGrow : node.layoutAlign === 'STRETCH') ? 'FILL' : 'FIXED');
        v = v || ((row ? node.layoutAlign === 'STRETCH' : node.layoutGrow) ? 'FILL' : 'FIXED');
      }
      return { h: SCALE[h] || 'fixed', v: SCALE[v] || 'fixed' };
    }

    function alignment(node) {
      var row = node.layoutMode === 'HORIZONTAL';
      var prim = node.primaryAxisAlignItems || 'MIN';
      var cnt = node.counterAxisAlignItems || 'MIN';
      if (cnt === 'BASELINE') cnt = 'MIN';
      var map = { MIN: 0, CENTER: 1, MAX: 2 };
      if (prim === 'SPACE_BETWEEN') {
        return 'spaceBetween' + ['Start', 'Center', 'End'][map[cnt]];
      }
      var hor, ver;
      if (row) { hor = map[prim]; ver = map[cnt]; } else { ver = map[prim]; hor = map[cnt]; }
      var names = [['topLeft', 'topCenter', 'topRight'], ['centerLeft', 'center', 'centerRight'], ['bottomLeft', 'bottomCenter', 'bottomRight']];
      return names[ver][hor];
    }

    function styleXml(node, o) {
      // o: {styleId, name, w, h, sizing:{h,v}|null, abs:{x,y,w,h,parent}|null, isArtboard}
      var a = '';
      if (hasAutoLayout(node)) {
        a += attr('flexDirectionValue', node.layoutMode === 'HORIZONTAL' ? 'row' : 'column');
        a += attr('layoutAlignmentType', alignment(node));
        var wrap = node.layoutWrap === 'WRAP';
        if (wrap) a += attr('flexWrapValue', 'wrap');
        var row = node.layoutMode === 'HORIZONTAL';
        var gap = node.itemSpacing || 0, cgap = node.counterAxisSpacing;
        if (cgap === undefined || cgap === null) cgap = gap;
        var gh = row ? gap : (wrap ? cgap : 0), gv = row ? (wrap ? cgap : 0) : gap;
        if (gh) a += ' gapHorizontal="' + num(gh) + '" gapHorizontalUnitsValue="points"';
        if (gv) a += ' gapVertical="' + num(gv) + '" gapVerticalUnitsValue="points"';
        var pads = [['paddingLeft', node.paddingLeft], ['paddingRight', node.paddingRight], ['paddingTop', node.paddingTop], ['paddingBottom', node.paddingBottom]];
        pads.forEach(function (p) { if (p[1]) a += ' ' + p[0] + '="' + num(p[1]) + '" ' + p[0] + 'UnitsValue="points"'; });
      }
      if (o.sizing) {
        a += attr('layoutWidthScaleType', o.sizing.h) + attr('layoutHeightScaleType', o.sizing.v);
      } else {
        a += attr('layoutWidthScaleType', 'fixed') + attr('layoutHeightScaleType', 'fixed');
      }
      if (node.minWidth) a += ' minWidth="' + num(node.minWidth) + '"';
      if (node.maxWidth) a += ' maxWidth="' + num(node.maxWidth) + '"';
      if (node.minHeight) a += ' minHeight="' + num(node.minHeight) + '"';
      if (node.maxHeight) a += ' maxHeight="' + num(node.maxHeight) + '"';
      if (o.pinned) {
        var p = o.pinned;
        a += ' positionTypeValue="absolute"';
        a += ' positionLeft="' + num(p.x) + '" positionLeftUnitsValue="points"';
        a += ' positionTop="' + num(p.y) + '" positionTopUnitsValue="points"';
      }
      if (!o.isArtboard) a += radiusAttrs(radii(node));
      return '<LayoutComponentStyle' + a + ' name="' + esc(o.name) + ' Style" id="' + o.styleId + '"/>';
    }

    // ---- images -------------------------------------------------------
    function registerImage(paint, node) {
      var info = snapshot.images && snapshot.images[paint.imageHash];
      if (!info) { warn(node, 'image fill has no image data (open the plugin from a file you can read)'); return null; }
      if (!imageAssets[paint.imageHash]) {
        imageAssets[paint.imageHash] = { hash: paint.imageHash, ext: info.ext, file: 'images/' + paint.imageHash + '.' + info.ext, id: id() };
      }
      return imageAssets[paint.imageHash].id;
    }
    // The image sits in a fixed, pinned, clipping box the size of its parent, drawn last (underneath).
    function imageWrapper(node, paint, w, h) {
      var aid = registerImage(paint, node);
      if (!aid) return '';
      if (paint.scaleMode === 'CROP' || paint.scaleMode === 'TILE') warn(node, 'image mode ' + paint.scaleMode + ' is shown as "fill"');
      var fit = paint.scaleMode === 'FIT' ? 'contain' : 'cover';
      var sid = id();
      var op = (paint.opacity !== undefined && paint.opacity < 1) ? ' opacity="' + num(paint.opacity) + '"' : '';
      return '<LayoutComponent width="' + num(w) + '" height="' + num(h) + '" styleId="' + sid + '" clip="true" name="Image Fill" id="' + id() + '">' +
        '<LayoutComponentStyle layoutWidthScaleType="fixed" layoutHeightScaleType="fixed" positionTypeValue="absolute" ' +
        'positionLeft="0" positionLeftUnitsValue="points" positionTop="0" positionTopUnitsValue="points"' + radiusAttrs(radii(node)) +
        ' name="Image Fill Style" id="' + sid + '"/>' +
        '<Image assetId="' + aid + '" fit="' + fit + '"' + op + ' name="' + esc(node.name) + ' Image" id="' + id() + '">' +
        '<LayoutParticipant layoutWidthScaleType="fill" layoutHeightScaleType="fill" name="Image Layout"/></Image></LayoutComponent>';
    }

    // ---- fonts / text -------------------------------------------------
    function fontFile(family, style) {
      var safe = function (s) { return String(s).replace(/[^A-Za-z0-9]+/g, ''); };
      return 'fonts/' + safe(family) + '-' + safe(style) + '.ttf';
    }
    function fontAsset(family, style) {
      var key = family + '|' + style;
      if (!fontAssetIds[key]) {
        fontAssetIds[key] = id();
        fonts[key] = { family: family, style: style, file: fontFile(family, style), assetId: fontAssetIds[key] };
      }
      return fontAssetIds[key];
    }

    function textXml(node, ctx) {
      var segs = node.segments && node.segments.length ? node.segments : [{
        characters: node.characters || '', fontSize: node.fontSize, fontName: node.fontName,
        letterSpacing: node.letterSpacing, lineHeight: node.lineHeight, fills: node.fills
      }];
      var styles = '', runs = '';
      segs.forEach(function (s, i) {
        var fn = s.fontName || { family: 'Inter', style: 'Regular' };
        var fid = fontAsset(fn.family, fn.style);
        var sid = id();
        var size = s.fontSize || 14;
        var ls = 0;
        if (s.letterSpacing && s.letterSpacing.unit === 'PIXELS') ls = s.letterSpacing.value;
        else if (s.letterSpacing && s.letterSpacing.unit === 'PERCENT') ls = s.letterSpacing.value / 100 * size;
        var lh = -1;
        if (s.lineHeight && s.lineHeight.unit === 'PIXELS') lh = s.lineHeight.value;
        else if (s.lineHeight && s.lineHeight.unit === 'PERCENT') lh = s.lineHeight.value / 100 * size;
        var paint = visiblePaints(s.fills)[0];
        var body = paint ? paintBody(paint, node, node.width, node.height, node.opacity) : null;
        if (!body) body = '<SolidColor colorValue="FF000000" name="Color"/>';
        styles += '<TextStylePaint fontSize="' + num(size) + '" fontAssetId="' + fid + '" familyName="' + esc(fn.family) +
          '" styleName="' + esc(fn.style) + '"' + (lh > 0 ? ' lineHeight="' + num(lh) + '"' : '') +
          (ls ? ' letterSpacing="' + num(ls) + '"' : '') + ' name="Style ' + (i + 1) + '" id="' + sid + '"><Fill name="Fill">' + body + '</Fill></TextStylePaint>';
        runs += '<TextValueRun styleId="' + sid + '" text="' + esc(s.characters) + '" name="Run ' + (i + 1) + '"/>';
      });
      var align = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'left' }[node.textAlignHorizontal || 'LEFT'];
      if (node.textAlignHorizontal === 'JUSTIFIED') warn(node, 'justified text is left-aligned');
      var vAlign = { TOP: 'top', CENTER: 'middle', BOTTOM: 'bottom' }[node.textAlignVertical || 'TOP'];
      var sz = ctx.inLayout ? ctx.sizing : null;
      var auto = node.textAutoResize || 'NONE';
      var sizingValue = auto === 'WIDTH_AND_HEIGHT' ? 'autoWidth' : auto === 'HEIGHT' ? 'autoHeight' : 'fixed';
      var a = attr('sizingValue', sizingValue) + attr('alignValue', align) + attr('verticalAlignValue', vAlign);
      if (sizingValue !== 'autoWidth') a += ' width="' + num(node.width) + '"';
      if (sizingValue === 'fixed') a += ' height="' + num(node.height) + '"';
      var pl = place(node);
      if ((node.effects || []).some(function (e) { return e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' || e.type === 'LAYER_BLUR'); })) {
        warn(node, 'shadow/blur on text is not converted');
      }
      if (!ctx.inLayout) {
        if (pl.rot) a += ' originX="0.5" originY="0.5" x="' + num(pl.cx) + '" y="' + num(pl.cy) + '"';
        else a += ' x="' + num(pl.x) + '" y="' + num(pl.y) + '"';
      }
      a += rotAttr(pl) + blendAttr(node);
      if (node.opacity !== undefined && node.opacity < 1) a += ' opacity="' + num(node.opacity) + '"';
      var part = '';
      if (ctx.inLayout) {
        part = '<LayoutParticipant layoutWidthScaleType="' + sz.h + '" layoutHeightScaleType="' + sz.v + '"' +
          (sz.h === 'fixed' ? ' width="' + num(node.width) + '"' : '') + (sz.v === 'fixed' ? ' height="' + num(node.height) + '"' : '') +
          ' name="' + esc(node.name) + ' Layout"/>';
      }
      return '<Text' + a + ' name="' + esc(node.name) + '" id="' + id() + '">' + part + styles + runs + '</Text>';
    }

    // ---- leaf shapes --------------------------------------------------
    // SVG path data (M L H V C Q Z, absolute or relative) -> contours of anchors with bezier handles.
    function parsePath(d) {
      var toks = String(d || '').match(/[MmLlHhVvCcSsQqTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
      var contours = [], cur = null, i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lastC = false;
      function n() { return parseFloat(toks[i++]); }
      function start(px, py) { cur = { pts: [{ x: px, y: py, inx: 0, iny: 0, outx: 0, outy: 0 }], closed: false }; contours.push(cur); }
      function line(px, py) { cur.pts.push({ x: px, y: py, inx: 0, iny: 0, outx: 0, outy: 0 }); }
      function cubic(c1x, c1y, c2x, c2y, px, py) {
        var p0 = cur.pts[cur.pts.length - 1];
        // A curve whose handles lie on the straight line between its ends is just a line (lets corner radius apply).
        var ex = px - p0.x, ey = py - p0.y, el = Math.hypot(ex, ey) || 1;
        if (Math.abs((c1x - p0.x) * ey - (c1y - p0.y) * ex) / el < 1e-3 && Math.abs((c2x - p0.x) * ey - (c2y - p0.y) * ex) / el < 1e-3) { line(px, py); return; }
        p0.outx = c1x - p0.x; p0.outy = c1y - p0.y;
        cur.pts.push({ x: px, y: py, inx: c2x - px, iny: c2y - py, outx: 0, outy: 0 });
      }
      while (i < toks.length) {
        if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
        var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), dx = rel ? x : 0, dy = rel ? y : 0;
        if (C === 'M') { x = n() + dx; y = n() + dy; start(x, y); sx = x; sy = y; cmd = rel ? 'l' : 'L'; lastC = false; }
        else if (C === 'L') { x = n() + dx; y = n() + dy; line(x, y); lastC = false; }
        else if (C === 'H') { x = n() + dx; line(x, y); lastC = false; }
        else if (C === 'V') { y = n() + dy; line(x, y); lastC = false; }
        else if (C === 'C') { var a1 = n() + dx, a2 = n() + dy, a3 = n() + dx, a4 = n() + dy, a5 = n() + dx, a6 = n() + dy; cubic(a1, a2, a3, a4, a5, a6); lcx = a3; lcy = a4; x = a5; y = a6; lastC = true; }
        else if (C === 'S') { var b3 = n() + dx, b4 = n() + dy, b5 = n() + dx, b6 = n() + dy; var rx = lastC ? 2 * x - lcx : x, ry = lastC ? 2 * y - lcy : y; cubic(rx, ry, b3, b4, b5, b6); lcx = b3; lcy = b4; x = b5; y = b6; lastC = true; }
        else if (C === 'Q') { var q1 = n() + dx, q2 = n() + dy, q3 = n() + dx, q4 = n() + dy; cubic(x + 2 / 3 * (q1 - x), y + 2 / 3 * (q2 - y), q3 + 2 / 3 * (q1 - q3), q4 + 2 / 3 * (q2 - q4), q3, q4); x = q3; y = q4; lastC = false; }
        else if (C === 'Z') {
          cur.closed = true; x = sx; y = sy; lastC = false;
          // Figma repeats the first point at the end of a closed contour: fold it into the first anchor.
          var f = cur.pts[0], l = cur.pts[cur.pts.length - 1];
          if (cur.pts.length > 1 && Math.abs(f.x - l.x) < 1e-3 && Math.abs(f.y - l.y) < 1e-3) { f.inx = l.inx; f.iny = l.iny; cur.pts.pop(); }
          cmd = '';
        } else { i++; }
      }
      return contours;
    }
    function vertexXml(p, cx, cy, radius) {
      var X = num(p.x - cx), Y = num(p.y - cy);
      var inD = Math.hypot(p.inx, p.iny), outD = Math.hypot(p.outx, p.outy);
      if (inD < 1e-3 && outD < 1e-3) return '<StraightVertex x="' + X + '" y="' + Y + '"' + (radius > 0 ? ' radius="' + num(radius) + '"' : '') + '/>';
      return '<CubicDetachedVertex x="' + X + '" y="' + Y + '" inRotation="' + num(Math.atan2(p.iny, p.inx)) + '" inDistance="' + num(inD) +
        '" outRotation="' + num(Math.atan2(p.outy, p.outx)) + '" outDistance="' + num(outD) + '"/>';
    }
    function pathsXml(node) {
      var out = '';
      (node.vectorPaths || []).forEach(function (vp) {
        if (vp.windingRule === 'EVENODD') node.__evenOdd = true;
        parsePath(vp.data).forEach(function (c) {
          if (c.pts.length < 2) return;
          // A mirrored layer (negative determinant) is its own shape mirrored top-to-bottom, about its centre, once the rotation is taken out.
          var m = node.relativeTransform;
          if (m && m[0][0] * m[1][1] - m[0][1] * m[1][0] < 0) {
            c.pts.forEach(function (p) { p.y = node.height - p.y; p.iny = -p.iny; p.outy = -p.outy; });
          }
          // Figma's corner radius on a vector rounds its corner points (not the two ends of an open path).
          var cr = (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) ? node.cornerRadius : 0;
          var area = 0;
          c.pts.forEach(function (p, k) { var q = c.pts[(k + 1) % c.pts.length]; area += p.x * q.y - q.x * p.y; });
          out += '<PointsPath isClosed="' + (c.closed ? 'true' : 'false') + '" isClockwise="' + (area >= 0 ? 'true' : 'false') + '" name="Path">' +
            c.pts.map(function (p, k) { return vertexXml(p, node.width / 2, node.height / 2, cr && (c.closed || (k > 0 && k < c.pts.length - 1)) ? cr : 0); }).join('') + '</PointsPath>';
        });
      });
      return out;
    }

    function geometryXml(node) {
      switch (node.type) {
        case 'RECTANGLE':
          return '<Rectangle width="' + num(node.width) + '" height="' + num(node.height) + '"' + radiusAttrs(radii(node)) + ' name="Path"/>';
        case 'ELLIPSE':
          return '<Ellipse width="' + num(node.width) + '" height="' + num(node.height) + '" name="Path"/>';
        case 'LINE':
          return '<PointsPath name="Path"><StraightVertex x="' + num(-node.width / 2) + '" y="0"/><StraightVertex x="' + num(node.width / 2) + '" y="0"/></PointsPath>';
        case 'VECTOR': case 'STAR': case 'POLYGON': case 'BOOLEAN_OPERATION': {
          var xml = pathsXml(node);
          return xml || null;
        }
      }
      return null;
    }

    // INSIDE / OUTSIDE strokes on a plain rectangle or ellipse: draw the shape smaller (inside) or larger (outside) by the
    // stroke width and stroke it centred. The stroke then covers exactly the same pixels as in Figma, with no clipping,
    // a true centre line for dashes, and no conflict with shadows. Falls back to the clipped 2x stroke when a translucent
    // stroke would sit on a fill (the fill would show a gap), or when shadows/blur are involved.
    function tightStroke(node) {
      if (options.exactStrokes === false) return null;
      if (node.type !== 'RECTANGLE' && node.type !== 'ELLIPSE') return null;
      var strokes = visiblePaints(node.strokes), sw = node.strokeWeight;
      if (!strokes.length || !(sw > 0)) return null;
      var al = node.strokeAlign;
      if (al !== 'INSIDE' && al !== 'OUTSIDE') return null;
      if ((node.effects || []).some(function (e) { return e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' || e.type === 'LAYER_BLUR'); })) return null;
      var allFills = visiblePaints(node.fills);
      if (allFills.some(function (p) { return p.type === 'IMAGE'; })) return null;
      function solid(p) {
        if (p.opacity !== undefined && p.opacity < 0.99) return false;
        if (p.type === 'SOLID') return p.color.a === undefined || p.color.a >= 0.99;
        return (p.gradientStops || []).every(function (st) { return st.color.a === undefined || st.color.a >= 0.99; });
      }
      if (allFills.length && !strokes.every(solid)) return null;
      var d = al === 'INSIDE' ? -sw : sw;
      if (node.width + d <= 0 || node.height + d <= 0) return null;
      return { d: d };
    }
    function adjustedGeometry(node, d) {
      var g = Object.assign({}, node, { width: node.width + d, height: node.height + d });
      var r = radii(node).map(function (v) { return v > 0 ? Math.max(0, v + d / 2) : 0; });
      g.topLeftRadius = r[0]; g.topRightRadius = r[1]; g.bottomLeftRadius = r[2]; g.bottomRightRadius = r[3];
      return g;
    }

    function shapeXml(node, ctx) {
      var tight = tightStroke(node);
      if (tight && ctx.inLayout) {
        // In a layout flow the shape must still occupy its Figma size, so it sits in a fixed slot of that size.
        var plS = place(node), sidS = id(), sz0 = ctx.sizing;
        var inner = shapeXml(Object.assign({}, node, { relativeTransform: null, rotation: 0, x: 0, y: 0 }), { inLayout: false });
        inner = inner.replace(/ x="[^"]*" y="[^"]*"/, ' x="' + num(node.width / 2) + '" y="' + num(node.height / 2) + '"');
        return '<LayoutComponent width="' + num(node.width) + '" height="' + num(node.height) + '"' + rotAttr(plS) + flipAttr(plS) + ' styleId="' + sidS + '" clip="false" name="' + esc(node.name) + ' Slot" id="' + id() + '">' +
          '<LayoutComponentStyle layoutWidthScaleType="' + sz0.h + '" layoutHeightScaleType="' + sz0.v + '" name="' + esc(node.name) + ' Slot Style" id="' + sidS + '"/>' +
          ((plS.rot || plS.flip) ? '<ComponentOrigin originX="0.5" originY="0.5" name="Origin"/>' : '') + '<Node name="Art">' + inner + '</Node></LayoutComponent>';
      }
      var geo = geometryXml(tight ? adjustedGeometry(node, tight.d) : node);
      if (!geo) { warn(node, 'unsupported node type skipped'); return ''; }
      if (findImage(node)) warn(node, 'image fills on vector shapes are not converted');
      var sid = id();
      var pl = place(node);
      var paints = paintsXml(node, node.width, node.height, { lineOnly: node.type === 'LINE', centered: true, forceCenter: !!tight });
      if (!paints.xml) { warn(node, 'has no visible fill or stroke; skipped'); return ''; }
      var a = '';
      if (!ctx.inLayout) a += ' x="' + num(pl.cx) + '" y="' + num(pl.cy) + '"';
      a += rotAttr(pl) + blendAttr(node);
      if (node.opacity !== undefined && node.opacity < 1) a += ' opacity="' + num(node.opacity) + '"';
      var part = '';
      if (ctx.inLayout) {
        var sz = ctx.sizing;
        part = '<LayoutParticipant layoutWidthScaleType="' + sz.h + '" layoutHeightScaleType="' + sz.v + '"' +
          (sz.h === 'fixed' ? ' width="' + num(node.width) + '"' : '') + (sz.v === 'fixed' ? ' height="' + num(node.height) + '"' : '') +
          ' name="' + esc(node.name) + ' Layout"/>';
      }
      // An inside stroke is a 2x stroke clipped to the shape's own outline.
      var clip = paints.clip ? '<ClippingShape sourceId="' + sid + '" name="Inside Stroke Clip"/>' : '';
      return '<Shape' + a + ' name="' + esc(node.name) + '" id="' + sid + '">' + part + geo + paints.xml + clip + '</Shape>';
    }

    // ---- containers ---------------------------------------------------
    var CONTAINERS = { FRAME: 1, GROUP: 1, COMPONENT: 1, INSTANCE: 1, COMPONENT_SET: 1 };

    function childrenXml(node, parentIsAL) {
      var list = (node.children || []).filter(function (c) { return c.visible !== false; });
      // Figma lists bottom-to-top and Rive's first sibling draws on top, so
      // free-placed children are reversed. Inside auto layout the declaration
      // order is also the flow order, so it is kept as designed.
      if (!parentIsAL) list = list.slice().reverse();
      return list.map(function (c) { return nodeXml(c, node, parentIsAL); }).join('');
    }

    function nodeXml(node, parent, parentIsAL) {
      var inFlow = parentIsAL && node.layoutPositioning !== 'ABSOLUTE';
      var sz = sizing(node, parent && parent.layoutMode);
      if (CONTAINERS[node.type]) return containerXml(node, parent, parentIsAL, inFlow, sz);
      if (node.type === 'TEXT') return textXml(node, { inLayout: inFlow, sizing: sz });
      if (node.type === 'SLICE' || node.type === 'STICKY' || node.type === 'SECTION') { warn(node, 'unsupported node type skipped'); return ''; }
      // Rectangles and ellipses with an image fill become a clipping box holding the image.
      if ((node.type === 'RECTANGLE' || node.type === 'ELLIPSE') && findImage(node)) {
        var syn = Object.assign({}, node, { type: 'FRAME', layoutMode: 'NONE', clipsContent: true, children: [] });
        if (node.type === 'ELLIPSE') {
          var r = Math.min(node.width, node.height) / 2;
          syn.cornerRadius = r; delete syn.topLeftRadius; delete syn.topRightRadius; delete syn.bottomLeftRadius; delete syn.bottomRightRadius;
          if (Math.abs(node.width - node.height) > 0.5) warn(node, 'image in a non-circular ellipse is clipped to a rounded box');
        }
        return containerXml(syn, parent, parentIsAL, inFlow, sz);
      }
      if (parentIsAL && !inFlow) {
        // An absolutely positioned leaf inside auto layout needs its own pinned box.
        var pl = place(node), styleId = id();
        var plain = Object.assign({}, node, { relativeTransform: null, rotation: 0, x: 0, y: 0 });
        var inner = shapeXml(plain, { inLayout: false });
        inner = inner.replace(/ x="[^"]*" y="[^"]*"/, ' x="' + num(node.width / 2) + '" y="' + num(node.height / 2) + '"');
        return '<LayoutComponent width="' + num(node.width) + '" height="' + num(node.height) + '"' + rotAttr(pl) + flipAttr(pl) + ' styleId="' + styleId + '" name="' + esc(node.name) + ' Pin" id="' + id() + '">' +
          styleXml({}, { styleId: styleId, name: node.name + ' Pin', sizing: { h: 'fixed', v: 'fixed' }, pinned: { x: pl.x, y: pl.y } }) +
          ((pl.rot || pl.flip) ? '<ComponentOrigin originX="0.5" originY="0.5" name="Origin"/>' : '') +
          '<Node name="Art">' + inner + '</Node></LayoutComponent>';
      }
      var ringArcs = angularRingShapes(node, inFlow, sz);
      if (ringArcs) return ringArcs;
      return endCapsXml(node, inFlow) + shapeXml(node, { inLayout: inFlow, sizing: sz });
    }

    // A ring with an angular (sweep) gradient stroke: Rive has no such gradient, so draw it as many short arcs, one shape each.
    function angularRingShapes(node, inFlow, sz) {
      if ((options.angularRings === undefined ? 'shapes' : options.angularRings) !== 'shapes' || node.type !== 'ELLIPSE' || inFlow) return null; // on by default: tested to survive a push and pull-back
      var p = visiblePaints(node.strokes).filter(function (q) { return q.type === 'GRADIENT_ANGULAR' && q.gradientTransform && q.gradientStops && q.gradientStops.length; })[0];
      if (!p || visiblePaints(node.strokes).length !== 1) return null;
      var w = node.width, h = node.height, inv = invert(p.gradientTransform), c0 = apply(inv, 0.5, 0.5), cx = apply(inv, 1, 0.5), cy = apply(inv, 0.5, 1);
      var xd = [(cx[0] - c0[0]) * w, (cx[1] - c0[1]) * h], yd = [(cy[0] - c0[0]) * w, (cy[1] - c0[1]) * h];
      var a0 = Math.atan2(xd[1], xd[0]), dir = (xd[0] * yd[1] - xd[1] * yd[0]) >= 0 ? 1 : -1;
      var stops = p.gradientStops.slice().sort(function (a, b) { return a.position - b.position; });
      function at(t) {
        if (t <= stops[0].position) return stops[0].color;
        if (t >= stops[stops.length - 1].position) return stops[stops.length - 1].color;
        for (var i = 0; i < stops.length - 1; i++) if (t >= stops[i].position && t <= stops[i + 1].position) {
          var span = stops[i + 1].position - stops[i].position, f = span > 1e-9 ? (t - stops[i].position) / span : 0, lo = stops[i].color, hi = stops[i + 1].color;
          var m = function (k) { return (lo[k] === undefined ? 1 : lo[k]) * (1 - f) + (hi[k] === undefined ? 1 : hi[k]) * f; };
          return { r: m('r'), g: m('g'), b: m('b'), a: m('a') };
        }
        return stops[0].color;
      }
      var N = 36, out = '', op = p.opacity === undefined ? 1 : p.opacity;
      for (var i = 0; i < N; i++) {
        var t0 = i / N, t1 = (i + 1) / N, col = at((t0 + t1) / 2);
        if ((col.a === undefined ? 1 : col.a) * op < 0.01) continue;
        var u = (((a0 + dir * 2 * Math.PI * (dir > 0 ? t0 : t1) + Math.PI / 2) / (2 * Math.PI)) % 1 + 1) % 1;
        out += shapeXml(Object.assign({}, node, { name: node.name + ' arc ' + (i + 1), strokes: [{ type: 'SOLID', visible: true, opacity: op, color: col }], fills: i === 0 ? node.fills : [], effects: i === 0 ? node.effects : [], __arc: { offset: u, len: 1 / N + 0.0008 } }), { inLayout: false, sizing: sz });
      }
      return out;
    }

    // Figma's "dot" stroke end (CIRCLE_FILLED) has no Rive equivalent: draw a small filled circle at that end, above the line.
    // An open arrowhead (two short strokes meeting at the tip) at one end of a line. dirX/dirY point OUT of the line.
    function arrowXml(node, m, tx, ty, dirX, dirY, stroke, sw) {
      var len = Math.hypot(dirX, dirY); if (len < 1e-6) return '';
      // direction into parent space (linear part only), tip into parent space (full transform)
      var dx = m[0][0] * dirX + m[0][1] * dirY, dy = m[1][0] * dirX + m[1][1] * dirY, dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      var ax = m[0][2] + m[0][0] * tx + m[0][1] * ty, ay = m[1][2] + m[1][0] * tx + m[1][1] * ty;
      var L = Math.max(3, 5 * sw), ang = Math.PI / 4, c = Math.cos(ang), s = Math.sin(ang);
      // the two wings point back from the tip, 45 degrees either side of the line
      var bx = -dx, by = -dy, w1 = [L * (bx * c - by * s), L * (bx * s + by * c)], w2 = [L * (bx * c + by * s), L * (-bx * s + by * c)];
      var col = stroke.type === 'SOLID' ? stroke.color : ((stroke.gradientStops || [])[0] || {}).color;
      if (!col) return '';
      var op = (stroke.opacity === undefined ? 1 : stroke.opacity) * (node.opacity === undefined ? 1 : node.opacity);
      return '<Shape x="' + num(ax) + '" y="' + num(ay) + '" name="' + esc(node.name) + ' arrow" id="' + id() + '"><PointsPath isClosed="false" name="Path">' +
        '<StraightVertex x="' + num(w1[0]) + '" y="' + num(w1[1]) + '"/><StraightVertex x="0" y="0"/><StraightVertex x="' + num(w2[0]) + '" y="' + num(w2[1]) + '"/></PointsPath>' +
        '<Stroke thickness="' + num(sw) + '" cap="round" join="round" name="Stroke"><SolidColor colorValue="' + colorHex(col, op) + '" name="Color"/></Stroke></Shape>';
    }
    function lineEnds(node) {
      var cs = (node.vectorPaths && node.vectorPaths[0]) ? parsePath(node.vectorPaths[0].data) : [];
      var c = cs[0]; if (!c || c.pts.length < 2 || c.closed) return null;
      var a = c.pts[0], a1 = c.pts[1], z = c.pts[c.pts.length - 1], z1 = c.pts[c.pts.length - 2];
      var out0 = Math.hypot(a.outx, a.outy) > 1e-3 ? [a.x - (a.x + a.outx), a.y - (a.y + a.outy)] : [a.x - a1.x, a.y - a1.y];
      var out1 = Math.hypot(z.inx, z.iny) > 1e-3 ? [-z.inx, -z.iny] : [z.x - z1.x, z.y - z1.y];
      return { start: { x: a.x, y: a.y, dx: out0[0], dy: out0[1] }, end: { x: z.x, y: z.y, dx: out1[0], dy: out1[1] } };
    }
    function endCapsXml(node, inFlow) {
      if (inFlow || !node.relativeTransform) return '';
      var stroke0 = visiblePaints(node.strokes)[0];
      if (!stroke0) return '';
      var arrows = '';
      // Arrowheads: one cap for the whole line, or a different cap per end.
      var ends = (node.type === 'VECTOR' && (node.strokeCap === 'ARROW_LINES' || (node.endCaps || []).some(function (c) { return c.cap === 'ARROW_LINES'; }))) ? lineEnds(node) : null;
      if (ends) {
        var sw0 = node.strokeWeight || 1;
        if (node.strokeCap === 'ARROW_LINES') { arrows += arrowXml(node, node.relativeTransform, ends.start.x, ends.start.y, ends.start.dx, ends.start.dy, stroke0, sw0) + arrowXml(node, node.relativeTransform, ends.end.x, ends.end.y, ends.end.dx, ends.end.dy, stroke0, sw0); }
        else (node.endCaps || []).forEach(function (c) {
          if (c.cap !== 'ARROW_LINES') return;
          var e = (Math.hypot(c.x - ends.start.x, c.y - ends.start.y) <= Math.hypot(c.x - ends.end.x, c.y - ends.end.y)) ? ends.start : ends.end;
          arrows += arrowXml(node, node.relativeTransform, e.x, e.y, e.dx, e.dy, stroke0, sw0);
        });
      }
      if (!node.endCaps || !node.endCaps.length) return arrows;
      var stroke = stroke0;
      var m = node.relativeTransform, sw = node.strokeWeight || 1, d = Math.max(3, 5.5 * sw), out = arrows;
      node.endCaps.forEach(function (c) {
        if (c.cap === 'ARROW_LINES') return;
        if (c.cap !== 'CIRCLE_FILLED') { warn(node, 'stroke end "' + c.cap + '" is drawn as a plain end'); return; }
        var ax = m[0][2] + m[0][0] * c.x + m[0][1] * c.y, ay = m[1][2] + m[1][0] * c.x + m[1][1] * c.y;
        out += shapeXml({ id: node.id + ':cap', name: node.name + ' end dot', type: 'ELLIPSE', visible: true, x: ax - d / 2, y: ay - d / 2, width: d, height: d, opacity: node.opacity === undefined ? 1 : node.opacity,
          rotation: 0, relativeTransform: null, fills: [stroke], strokes: [], effects: [] }, { inLayout: false });
      });
      return out;
    }

    function containerXml(node, parent, parentIsAL, inFlow, sz) {
      if (node.type === 'INSTANCE' && linkComponents && node.mainComponentId && compIds[node.mainComponentId]) {
        // A live link: the instance becomes a sized slot holding a nested artboard of its component.
        // Only when it looks the same as its component; an instance with its own colours, text or size stays plain layout.
        var cmp = compById[node.mainComponentId];
        var look = function (v) { return JSON.stringify(v, function (k, x) { return k === 'boundVariables' ? undefined : (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x); }); };
        var sig = function (n) { return [n.type, Math.round(n.width), Math.round(n.height), n.characters || '', look(n.fills || []), look(n.strokes || []), look(n.effects || []), n.visible !== false, n.opacity, (n.children || []).map(sig).join('|')].join('~'); };
        var kids = function (n) { return (n.children || []).map(sig).join('|'); };
        var same = kids(node) === kids(cmp) && Math.abs(node.width - cmp.width) <= 0.5 && Math.abs(node.height - cmp.height) <= 0.5;
        if (same) {
          linkedInst++;
          node = Object.assign({}, node, { type: 'FRAME', fills: [], strokes: [], effects: [], children: [], layoutMode: 'NONE', clipsContent: false, cornerRadius: 0, topLeftRadius: undefined, topRightRadius: undefined, bottomLeftRadius: undefined, bottomRightRadius: undefined, __nested: compIds[node.mainComponentId], __nestedName: cmp.name });
        } else changedInst++;
      }
      if (node.type === 'INSTANCE') detached++;
      var al = hasAutoLayout(node);
      var w = node.width, h = node.height;
      var pl = place(node);
      var img = findImage(node);
      var hasDrop = (node.effects || []).some(function (e) { return e.visible !== false && e.type === 'DROP_SHADOW'; });
      var insideStroke = visiblePaints(node.strokes).length && node.strokeWeight > 0 && node.strokeAlign === 'INSIDE';
      // A clipping box also clips its own shadow. So when a frame clips AND casts a shadow, the shadow is drawn by a
      // wrapper that does not clip, and the frame itself (clip on) sits inside it.
      var wrapShadow = hasDrop && (node.clipsContent || insideStroke) && !!(visiblePaints(node.fills).length || visiblePaints(node.strokes).length || img);
      var paints = paintsXml(node, w, h, { hasImage: !!img, hasChildren: (node.children || []).length > 0, splitShadow: wrapShadow, flowShadow: !!(parentIsAL && inFlow), splitInner: options.innerShadowOverChildren !== false && (node.children || []).some(function (c) { return c.visible !== false; }) });
      var o = { styleId: id(), name: node.name, sizing: parentIsAL && inFlow ? sz : { h: 'fixed', v: 'fixed' } };
      // A frame without auto layout has free-placed children that Rive cannot
      // measure, so "hug" would collapse it to nothing. Keep the drawn size.
      if (!al && o.sizing.h === 'hug') o.sizing = { h: 'fixed', v: o.sizing.v };
      if (!al && o.sizing.v === 'hug') o.sizing = { h: o.sizing.h, v: 'fixed' };
      // A layout box joins its parent's flow, so anything free-placed (absolute in
      // auto layout, or inside a plain frame) is pinned to its position.
      var pinned = (parent && ((parentIsAL && !inFlow) || !parentIsAL)) ? { x: pl.x, y: pl.y } : null;
      var clip = wrapShadow ? true : ((node.clipsContent && !paints.shadowed) || paints.clip);
      if (!wrapShadow && node.clipsContent && paints.shadowed) warn(node, 'clip content is turned off so its shadow can show');
      if (wrapShadow && !node.clipsContent) warn(node, 'clip content is on for this frame so its inside stroke can be drawn (its shadow still shows)');
      var inner = node.__nested ? '<NestedArtboardLeaf artboardId="' + node.__nested + '" fit="contain" name="' + esc(String(node.__nestedName).trim()) + '"/>' : al ? childrenXml(node, true) : '<Node' + (pl.flip ? ' y="' + num(h) + '" scaleY="-1"' : '') + ' name="' + esc(String(node.name).trim()) + ' (Wrapper)">' + childrenXml(node, false) + '</Node>';
      var imgXml = img ? imageWrapper(node, img, w, h) : '';
      // In Figma an inner shadow also shades the layers inside the frame, so it is drawn on an overlay ABOVE the contents
      // (first sibling = on top), clipped to the frame's rounded shape.
      var overlay = '';
      if (paints.innerXml) {
        var osid = id();
        overlay = '<LayoutComponent width="' + num(w) + '" height="' + num(h) + '" styleId="' + osid + '" clip="true" name="Inner Shadow" id="' + id() + '">' +
          '<LayoutComponentStyle layoutWidthScaleType="fixed" layoutHeightScaleType="fixed" positionTypeValue="absolute" positionLeft="0" positionLeftUnitsValue="points" positionTop="0" positionTopUnitsValue="points"' +
          radiusAttrs(radii(node)) + ' name="Inner Shadow Style" id="' + osid + '"/>' + paints.innerXml + '</LayoutComponent>';
      }
      var origin = (pl.rot || pl.flip) ? '<ComponentOrigin originX="0.5" originY="0.5" name="Origin"/>' : '';
      var opac = (node.opacity !== undefined && node.opacity < 1) ? ' opacity="' + num(node.opacity) + '"' : '';

      if (!wrapShadow) {
        o.pinned = pinned;
        var attrs = ' width="' + num(w) + '" height="' + num(h) + '"' + rotAttr(pl) + flipAttr(pl) + blendAttr(node) + ' styleId="' + o.styleId + '" clip="' + (clip ? 'true' : 'false') + '"' + opac;
        return '<LayoutComponent' + attrs + ' name="' + esc(node.name) + '" id="' + id() + '">' +
          styleXml(node, o) + origin + paints.xml + overlay + inner + imgXml + '</LayoutComponent>';
      }

      // wrapper (shadow, position, rotation, opacity, outer sizing) + inner frame (clip, fills, strokes, children, layout)
      var wrapStyleId = id(), innerStyleId = o.styleId;
      var radiusNode = {}; ['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (k) { if (node[k] !== undefined) radiusNode[k] = node[k]; });
      var outer = { styleId: wrapStyleId, name: node.name + ' Shadow', sizing: o.sizing, pinned: pinned };
      var innerSizing = { h: o.sizing.h === 'hug' ? 'hug' : 'fill', v: o.sizing.v === 'hug' ? 'hug' : 'fill' };
      var innerO = { styleId: innerStyleId, name: node.name, sizing: innerSizing };
      var wrapAttrs = ' width="' + num(w) + '" height="' + num(h) + '"' + rotAttr(pl) + flipAttr(pl) + blendAttr(node) + ' styleId="' + wrapStyleId + '" clip="false"' + opac;
      var innerAttrs = ' width="' + num(w) + '" height="' + num(h) + '" styleId="' + innerStyleId + '" clip="true"';
      return '<LayoutComponent' + wrapAttrs + ' name="' + esc(node.name) + ' Shadow" id="' + id() + '">' +
        styleXml(radiusNode, outer) + origin + paints.shadowXml +
        '<LayoutComponent' + innerAttrs + ' name="' + esc(node.name) + '" id="' + id() + '">' +
        styleXml(node, innerO) + paints.xml + overlay + inner + imgXml + '</LayoutComponent>' +
        // Rive draws the first child on top, so the shadow and outside-stroke boxes go AFTER the frame to sit behind it.
        paints.shadowBoxXml + '</LayoutComponent>';
    }

    var componentAssets = [];
    var compIds = {}, compById = {}, linkedInst = 0, changedInst = 0;
    var linkComponents = options.linkComponents !== false && componentArtboards;
    function artboardXml(node, isComponent) {
      var styleId = id();
      var smId = id(), layerId = id();
      var style, bg, inner;
      if (frameAsLayout) {
        // The frame stays a layout box inside a plain artboard of the same size.
        style = styleXml({}, { styleId: styleId, name: 'Artboard', sizing: null, isArtboard: true });
        bg = '';
        var top = Object.assign({}, node, { relativeTransform: null, rotation: 0 });
        inner = containerXml(top, null, false, false, null);
      } else {
        // The frame's own properties become the artboard's.
        var al = hasAutoLayout(node), img = findImage(node);
        style = styleXml(node, { styleId: styleId, name: 'Artboard', sizing: null, isArtboard: true });
        bg = plainFills(node, node.width, node.height);
        inner = (al ? childrenXml(node, true) : childrenXml(node, false)) + (img ? imageWrapper(node, img, node.width, node.height) : '');
      }
      var sm = '<StateMachine name="State Machine 1" id="' + smId + '"><StateMachineLayer name="Layer 1" id="' + layerId + '">' +
        '<AnyState x="200" y="-120"/><ExitState x="400" y="-120"/><EntryState/></StateMachineLayer></StateMachine>';
      var abId = compIds[node.id] || id();
      if (isComponent) componentAssets.push({ artboardId: abId, name: String(node.name).trim() });
      return '<Artboard' + (isComponent ? ' isComponent="true"' : '') + ' defaultStateMachineId="' + smId + '" width="' + num(node.width) + '" height="' + num(node.height) +
        '" styleId="' + styleId + '" clip="' + (node.clipsContent === false ? 'false' : 'true') + '" name="' + esc(String(node.name).trim()) + '" id="' + abId + '">' +
        style + bg + inner + sm + '</Artboard>';
    }

    // ---- assemble -----------------------------------------------------
    var frames = (snapshot.nodes || []).filter(function (n) { return CONTAINERS[n.type]; });
    if (!frames.length) warnings.push('Select at least one frame, component or group.');
    // Variants of a component set are named like "Style=Stroke, Type=Standard". Import them as "<set>-Stroke-Standard".
    var instName = {};
    (function walkInst(list) { (list || []).forEach(function (n) { if (n.type === 'INSTANCE' && n.mainComponentId && !instName[n.mainComponentId]) instName[n.mainComponentId] = n.name; walkInst(n.children); }); })((snapshot.nodes || []).concat(snapshot.components || []));
    var VARIANT = /^\s*[^=,]+=[^,]*(,\s*[^=,]+=[^,]*)*\s*$/;
    function variantRename(c) {
      if (!VARIANT.test(String(c.name))) return c;
      var vals = String(c.name).split(',').map(function (p) { return p.slice(p.indexOf('=') + 1).trim(); });
      // Every part starts with a capital: user + Stroke + Standard -> User-Stroke-Standard.
      var nm = [c.setName || instName[c.id] || ''].concat(vals).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('-');
      return Object.assign({}, c, { name: nm });
    }
    var compNodes = componentArtboards ? (snapshot.components || []).filter(function (c) {
      return !frames.some(function (f) { return f.id === c.id; });
    }).map(variantRename) : [];
    // Component artboards get their ids up front, so instances placed earlier in the file can point at them.
    frames.forEach(function (f) { if (f.type === 'COMPONENT' && componentArtboards) { compIds[f.id] = id(); compById[f.id] = f; } });
    compNodes.forEach(function (c) { compIds[c.id] = id(); compById[c.id] = c; });
    // Side by side on the editor's stage, so they do not overlap when opened.
    var stageX = 0;
    // Main artboards sit in one row; component artboards get a row of their own below, so they never overlap.
    var compX = 0, rowY = 200 + frames.filter(function (f) { return !(f.type === 'COMPONENT' && componentArtboards); }).reduce(function (m, f) { return Math.max(m, f.height); }, 0);
    function onStage(node, isComponent) {
      var xml = artboardXml(node, isComponent).replace('<Artboard', '<Artboard x="' + (isComponent ? compX : stageX) + '" y="' + (isComponent ? rowY : 0) + '"');
      if (isComponent) compX += node.width + 120; else stageX += node.width + 120;
      return xml;
    }
    var artboards = frames.map(function (f) { return onStage(f, f.type === 'COMPONENT' && componentArtboards); })
      .concat(compNodes.map(function (c) { return onStage(c, true); })).join('\n    ');
    if (linkedInst) notes.push(linkedInst + ' component instance(s) are live links to their component artboard.');
    if (detached) notes.push(detached + ' component instance(s) were detached and imported as plain layout.');
    if (compNodes.length) notes.push(compNodes.length + ' main component(s) added as Rive component artboards: ' + compNodes.map(function (c) { return c.name; }).join(', '));
    var fontList = Object.keys(fonts).map(function (k) { return fonts[k]; });
    var fontXml = fontList.map(function (f) {
      return '<FontAsset file="' + esc(f.file) + '" name="' + esc(f.family + ' ' + f.style) + '" id="' + f.assetId + '"/>';
    }).join('\n    ');
    var imageList = Object.keys(imageAssets).map(function (k) { return imageAssets[k]; });
    var imageXml = imageList.map(function (im) {
      return '<ImageAsset file="' + esc(im.file) + '" name="' + esc('image ' + im.hash.slice(0, 8)) + '" id="' + im.id + '"/>';
    }).join('\n    ');
    var compXml = componentAssets.map(function (c) {
      return '<ComponentAsset artboardId="' + c.artboardId + '" name="' + esc(c.name) + '"/>';
    }).join('\n    ');

    var rml = '<Rive version="1" kind="fragment">\n    ' + artboards + '\n    ' + fontXml + '\n    ' + imageXml + '\n    ' + compXml + '\n</Rive>\n';
    var yaml = 'name: ' + (options.name || 'figma-import').replace(/[^A-Za-z0-9 _-]/g, '') + '\n';
    return { componentNames: compNodes.map(function (c) { return String(c.name).trim(); }), rml: rml, yaml: yaml, fonts: fontList, images: imageList, warnings: warnings, notes: notes };
  }

  return { convert: convert };
});
