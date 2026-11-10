#!/usr/bin/env node
// Local helper for the Figma plugin. Listens on 127.0.0.1 only.
//   POST /export  {name, rml, yaml, fonts:[{file}]}  -> writes Exports/<name>/, adds fonts, runs `rive --verify`
//   POST /push    {name}                              -> runs `rive push` for that export (only when you click Push)
//   GET  /status                                      -> versions, config
// Every request needs the token printed at startup (x-token header).
// It runs two fixed commands (`rive <dir> --verify`, `rive push`); it never executes anything the plugin sends.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = +process.env.PORT || 4747;
const RIVE = process.env.RIVE_BIN || path.join(os.homedir(), '.rive', 'bin', 'rive');
const CONFIG = path.join(ROOT, 'config.json');
const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
// Exports and the fonts library live NEXT TO the plugin folder (not inside it), so the plugin folder holds only code and
// is safe to put on GitHub. Change them in config.json with "exportsDir" / "fontsDir" (absolute, or relative to this folder).
const EXPORTS = path.resolve(ROOT, cfg.exportsDir || '../Exports');
const FONTS = path.resolve(ROOT, cfg.fontsDir || 'Fonts Library');
fs.mkdirSync(EXPORTS, { recursive: true }); fs.mkdirSync(FONTS, { recursive: true });
// projectId: the Rive project new files are created in. Run `rive ls --plain` to list yours.

const tokenFile = path.join(ROOT, '.token');
const TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : (() => {
  const t = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(tokenFile, t, { mode: 0o600 }); return t;
})();

function safeName(n) { return String(n || 'figma-import').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'figma-import'; }
function run(args, cwd) {
  return new Promise(res => execFile(RIVE, args, { cwd, timeout: 180000, maxBuffer: 8e6 }, (err, so, se) =>
    res({ ok: !err, output: (so + '\n' + se).replace(/\x1b\[[0-9;]*m/g, '').trim() })));
}
function writeImages(dir, images) {
  const written = [];
  for (const im of images || []) {
    const base = path.basename(String(im.file));
    if (!/^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i.test(base)) continue;
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', base), Buffer.from(String(im.base64), 'base64'));
    written.push(base);
  }
  return written;
}
function standInFont() {
  const v = path.join(os.homedir(), '.rive', 'versions');
  for (const d of fs.existsSync(v) ? fs.readdirSync(v) : []) {
    const f = path.join(v, d, 'samples', 'text_island', 'Inter.ttf');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// ---- add the import to an existing Rive file ------------------------------
// Pull the live file, append the imported artboards (ids moved to a free namespace so
// nothing collides), keep what is already there. Nothing is removed from the file.
// Rive can leave pieces of a deleted artboard (dashes, state machine states) loose at the top level of the file. They are not part of
// anything, and a loose dash stops the file from building. Remove them.
function sweepOrphans(text) {
  let out = text;
  out = out.replace(/\n {4}<DashPath\b[\s\S]*?<\/DashPath>/g, '');
  out = out.replace(/\n {4}<(EntryState|ExitState|AnyState)\b[^>]*\/>/g, '');
  return out;
}
// Keep component artboards in a row of their own below the main artboards. Only moves them when one is not in that row yet.
function tidyStage(text) {
  const tags = [...text.matchAll(/<Artboard\s[^>]*>/g)].map(m => m[0]);
  const num = (t, k) => +((t.match(new RegExp('\\s' + k + '="(-?[\\d.]+)"')) || [])[1] || 0), isC = t => /\sisComponent="true"/.test(t);
  const mains = tags.filter(t => !isC(t)), comps = tags.filter(isC);
  const rowY = mains.reduce((m, t) => Math.max(m, num(t, 'height')), 0) + 200;
  const overlap = comps.some((a, i) => comps.slice(i + 1).some(b => num(a, 'x') < num(b, 'x') + num(b, 'width') && num(b, 'x') < num(a, 'x') + num(a, 'width') && num(a, 'y') < num(b, 'y') + num(b, 'height') && num(b, 'y') < num(a, 'y') + num(a, 'height')));
  if (!comps.length || (!overlap && comps.every(t => num(t, 'y') >= rowY))) return text;
  const order = comps.slice().sort((a, b) => num(a, 'x') - num(b, 'x'));
  let x = 0; const where = new Map();
  for (const t of order) { where.set(t, x); x += num(t, 'width') + 120; }
  let out = text;
  for (const t of comps) out = out.replace(t, t.replace(/\s(x|y)="[^"]*"/g, '').replace(/<Artboard /, '<Artboard x="' + where.get(t) + '" y="' + rowY + '" '));
  return out;
}
// Cut one artboard (and its component entry) out of a scene by name. Returns its old stage position too.
function cutArtboard(text, name) {
  const re = f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = text.match(new RegExp('<Artboard(?=\\s)[^>]*?\\sname="' + re(xmlAttr(name)) + '"[^>]*>[\\s\\S]*?</Artboard>'));
  if (!hit) return { found: false, text };
  const tag = hit[0].match(/^<Artboard\s[^>]*>/)[0], aid = (tag.match(/\sid="([^"]+)"/) || [])[1];
  let out = text.replace(hit[0], '');
  if (aid) out = out.replace(new RegExp('<ComponentAsset [^>]*artboardId="' + re(aid) + '"[^>]*/>\\s*'), '');
  const n = k => +((tag.match(new RegExp('\\s' + k + '="(-?[\\d.]+)"')) || [])[1] || 0);
  return { found: true, aid, text: out, x: String(n('x')), y: String(n('y')), w: n('width'), h: n('height'), comp: /\sisComponent="true"/.test(tag) };
}
const xmlAttr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function mergeIntoExisting(existing, incoming, replace) {
  const escRe = f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // "Replace" mode: swap an artboard that is already in the file for its new version (even if the frame was renamed),
  // in the same spot on the stage. Its component entry goes too. Only artboards named in `replace` are touched.
  const replaced = [], slots = {}, cutIds = {};
  for (const pr of replace || []) {
    const cut = cutArtboard(existing, pr.old);
    if (!cut.found) continue;
    slots[xmlAttr(pr.new)] = { x: cut.x, y: cut.y, w: cut.w, h: cut.h, comp: cut.comp };
    existing = cut.text; if (cut.aid) cutIds[pr.old] = cut.aid;
    replaced.push(pr.old);
  }
  const used = [...existing.matchAll(/"(\d+):\d+"/g)].map(m => +m[1]);
  const ns = (used.length ? Math.max(...used) : 0) + 1;
  const inc = incoming.replace(/((?:id|Id|Ids)=")0:(\d+)"/g, (_, a, n) => a + ns + ':' + n + '"');
  const body = inc.replace(/^[\s\S]*?<Rive[^>]*>/, '').replace(/<\/Rive>\s*$/, '');
  let artboards = body.match(/<Artboard[\s\S]*?<\/Artboard>/g) || [];
  // Reuse fonts / images the file already has (same file path) instead of adding a second copy.
  const remap = [];   // [[attrName, from, to]]
  const keepAssets = [];
  const esc = f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [tag, ref] of [['FontAsset', 'fontAssetId'], ['ImageAsset', 'assetId']]) {
    for (const ax of body.match(new RegExp('<' + tag + ' [^>]*\\/>', 'g')) || []) {
      const file = (ax.match(/file="([^"]+)"/) || [])[1], mine = (ax.match(/ id="([^"]+)"/) || [])[1];
      const hit = file && existing.match(new RegExp('<' + tag + ' [^>]*file="' + esc(file) + '"[^>]* id="([^"]+)"'));
      if (hit) remap.push([ref, mine, hit[1]]); else keepAssets.push(ax);
    }
  }
  let compAssets = body.match(/<ComponentAsset [^>]*\/>/g) || [];
  const names = new Set([...existing.matchAll(/<Artboard [^>]*name="([^"]*)"/g)].map(m => m[1]));
  // Main artboards go in one row at the top of the stage; component artboards in a row of their own below, so they never overlap.
  const num = (t, k) => +((t.match(new RegExp('\\s' + k + '="(-?[\\d.]+)"')) || [])[1] || 0), isCompTag = t => /\sisComponent="true"/.test(t);
  let maxH = 0, mainEdge = -120;
  for (const m of existing.matchAll(/<Artboard\s[^>]*>/g)) if (!isCompTag(m[0])) { maxH = Math.max(maxH, num(m[0], 'height')); mainEdge = Math.max(mainEdge, num(m[0], 'x') + num(m[0], 'width')); }
  for (const a of artboards) { const t = (a.match(/<Artboard\s[^>]*>/) || [''])[0]; if (!isCompTag(t)) maxH = Math.max(maxH, num(t, 'height')); }
  for (const k of Object.keys(slots)) if (!slots[k].comp) { maxH = Math.max(maxH, slots[k].h); mainEdge = Math.max(mainEdge, +slots[k].x + slots[k].w); }
  const rowY = maxH + 200;
  let compEdge = -120;
  for (const k of Object.keys(slots)) if (slots[k].comp && +slots[k].y >= rowY) compEdge = Math.max(compEdge, +slots[k].x + slots[k].w);
  for (const m of existing.matchAll(/<Artboard\s[^>]*>/g)) if (isCompTag(m[0]) && num(m[0], 'y') >= rowY) compEdge = Math.max(compEdge, num(m[0], 'x') + num(m[0], 'width'));
  let cursor = mainEdge + 120, compCursor = compEdge + 120;
  const added = [];
  artboards = artboards.map(a => {
    const w = +((a.match(/<Artboard\s[^>]*?\swidth="([\d.]+)"/) || [])[1] || 0);
    // Drop the converter's own stage position; place it after what is already in the file.
    const nm0 = (a.match(/<Artboard [^>]*?name="([^"]*)"/) || [])[1], isC = isCompTag((a.match(/<Artboard\s[^>]*>/) || [''])[0]);
    let slot = slots[nm0];
    if (slot && isC && +slot.y < rowY) slot = null; // an old component sitting among the main artboards moves down to the component row
    const px = slot ? slot.x : (isC ? compCursor : cursor), py = slot ? slot.y : (isC ? rowY : 0);
    a = a.replace(/<Artboard\s[^>]*>/, tag => tag.replace(/\s(x|y)="[^"]*"/g, '')).replace(/<Artboard /, '<Artboard x="' + px + '" y="' + py + '" ');
    if (!slot) { if (isC) compCursor += w + 120; else cursor += w + 120; }
    remap.forEach(([ref, from, to]) => { a = a.split(ref + '="' + from + '"').join(ref + '="' + to + '"'); });
    a = a.replace(/(<Artboard [^>]*?name=")([^"]*)(")/, (m, pre, nm, post) => {
      // Re-importing the same frame: the new artboard is called "<name> - updated" (then "- updated 2" ...) and the old one is kept.
      let n = nm, i = 1; while (names.has(n)) n = nm + ' - updated' + (i++ > 1 ? ' ' + (i - 1) : '');
      names.add(n); added.push(n);
      const aid = (a.match(/<Artboard [^>]*? id="([^"]+)"/) || [])[1];
      if (n !== nm && aid) compAssets = compAssets.map(c => c.includes('artboardId="' + aid + '"') ? c.replace(/name="[^"]*"/, 'name="' + n + '"') : c);
      return pre + n + post;
    });
    return a;
  });
  // A component artboard that was swapped for a new one has a new id: point every nested instance still in the file at it.
  for (const nm of Object.keys(cutIds)) {
    const ca = compAssets.find(c => c.includes(' name="' + xmlAttr(nm) + '"')), newId = ca && (ca.match(/artboardId="([^"]+)"/) || [])[1];
    if (newId) existing = existing.split('artboardId="' + cutIds[nm] + '"').join('artboardId="' + newId + '"');
  }
  const merged = existing.replace(/<\/Rive>\s*$/, artboards.join('\n    ') + '\n    ' + keepAssets.join('\n    ') + '\n    ' + compAssets.join('\n    ') + '\n</Rive>\n');
  return { merged: tidyStage(merged), added, replaced, namespace: ns };
}

// ---- inbox: a design report Claude can read ---------------------------------
const INBOX = path.resolve(ROOT, cfg.inboxDir || 'claude-inbox');
function summaryMd(name, rep, previews) {
  const sevName = { error: 'Fix before importing', warning: 'Will look different', info: 'Tips' };
  let md = '# Design report: ' + name + '\n\n';
  md += 'Sent: ' + new Date().toISOString() + '\n\n';
  md += '**' + rep.verdict + '** (score ' + rep.score + '): ' + rep.counts.error + ' to fix, ' + rep.counts.warning + ' differences, ' + rep.counts.info + ' tips.\n';
  md += rep.stats.nodes + ' layers, ' + rep.stats.frames + ' frames, ' + rep.stats.autoLayoutFrames + ' with auto layout, ' + rep.stats.texts + ' text, ' + rep.stats.images + ' images.\n\n';
  for (const sev of ['error', 'warning', 'info']) {
    const g = rep.issues.filter(i => i.severity === sev);
    if (!g.length) continue;
    md += '## ' + sevName[sev] + '\n\n';
    for (const i of g) {
      md += '- **' + i.title + '**' + (i.count > 1 ? ' x' + i.count : '') + ': ' + i.why + '\n';
      md += '  - Fix: ' + i.fix + '\n';
      if (i.nodes.length) md += '  - Layers: ' + i.nodes.slice(0, 10).map(n => n.name + ' (' + n.id + ')').join(', ') + (i.count > 10 ? ', and ' + (i.count - 10) + ' more' : '') + '\n';
    }
    md += '\n';
  }
  if (rep.fonts && rep.fonts.length) md += '## Fonts needed\n\n' + rep.fonts.map(f => '- ' + f.family + ' ' + f.style + ' -> ' + f.file).join('\n') + '\n\n';
  md += '## Files\n\n- `report.json`: this report as data\n- `snapshot.json`: the full design data (large; open only for specific layers)\n' + previews.map(p => '- `' + p + '`: preview image').join('\n') + '\n';
  return md;
}
function doInbox(body) {
  const name = safeName(body.name), dir = path.join(INBOX, name);
  fs.rmSync(dir, { recursive: true, force: true });   // our own previous report for this design only
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(body.report, null, 1));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(body.snapshot));
  const saved = [];
  (body.previews || []).forEach((p, i) => {
    const f = 'preview-' + (i + 1) + '-' + safeName(p.name).replace(/\s+/g, '-').slice(0, 30) + '.png';
    fs.writeFileSync(path.join(dir, f), Buffer.from(String(p.base64), 'base64')); saved.push(f);
  });
  const md = summaryMd(name, body.report, saved);
  fs.writeFileSync(path.join(dir, 'summary.md'), md);
  fs.mkdirSync(INBOX, { recursive: true });
  fs.writeFileSync(path.join(INBOX, 'latest.md'), md + '\nFolder: `' + dir + '`\n');
  return { ok: true, dir, summary: path.join(INBOX, 'latest.md'), previews: saved.length };
}

// The plugin just keeps the selected frame's name here so Claude can read it when you ask for something.
function doFrame(body) {
  fs.mkdirSync(INBOX, { recursive: true });
  const rec = {
    name: safeName(body.name), frames: (body.names || []).slice(0, 8), types: (body.types || []).slice(0, 8), ids: (body.ids || []).slice(0, 8),
    sizes: (body.sizes || []).slice(0, 8), page: String(body.page || '').slice(0, 80), file: String(body.file || '').slice(0, 80), savedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(INBOX, 'current-frame.json'), JSON.stringify(rec, null, 1));
  fs.writeFileSync(path.join(INBOX, 'current-frame.md'), '# Current frame\n\n**' + rec.name + '**  (artboard and Rive file name)\n\n' +
    rec.frames.map((f, i) => '- ' + f + ' [' + rec.types[i] + ', ' + (rec.sizes[i] || []).join('x') + ', ' + rec.ids[i] + ']').join('\n') +
    '\n\nFigma file: ' + rec.file + ', page: ' + rec.page + '\nSaved: ' + rec.savedAt + '\n');
  return { ok: true, name: rec.name };
}

async function doExport(body) {
  if (body.fileId) return doExportExisting(body);
  const name = safeName(body.name), dir = path.join(EXPORTS, name);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene.rml'), String(body.rml));
  // Keep the push link (rive.yaml `push:`) across re-exports so a re-send updates the same file.
  const yamlPath = path.join(dir, 'rive.yaml');
  const prev = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf8') : '';
  const push = prev.match(/^push:[\s\S]*$/m);
  fs.writeFileSync(yamlPath, String(body.yaml).replace(/\s*$/, '\n') + (push ? push[0] + '\n' : ''));
  writeImages(dir, body.images);
  const stand = standInFont(), real = [], standIn = [], missing = [];
  for (const f of body.fonts || []) {
    const base = path.basename(String(f.file));
    const dest = path.join(dir, 'fonts', base), lib = path.join(FONTS, base);
    if (fs.existsSync(lib)) { fs.copyFileSync(lib, dest); real.push(base); }
    else if (fs.existsSync(dest)) real.push(base);
    else if (stand) { fs.copyFileSync(stand, dest); standIn.push(base); }
    else missing.push(base);
  }
  const verify = await run([dir, '--verify'], dir);
  return { dir, name, verify, fonts: { real, standIn, missing }, linked: !!push };
}

async function doExportExisting(body) {
  const fileId = String(body.fileId).replace(/\D/g, '');
  if (!fileId) throw new Error('That is not a Rive file id or link.');
  const dir = path.join(EXPORTS, 'file-' + fileId);
  const linked = fs.existsSync(path.join(dir, 'rive.yaml'));
  // Always start from the live file so editor changes since last time are kept.
  const dl = linked ? await run(['pull', dir, '--yes'], ROOT) : await run(['create', dir, '--from-remote-file=' + fileId], ROOT);
  if (!dl.ok) return { dir, name: 'file-' + fileId, mode: 'existing', verify: { ok: false, output: 'Could not download your Rive file ' + fileId + ':\n' + dl.output }, fonts: { real: [], standIn: [], missing: [] }, added: [] };
  const scenePath = path.join(dir, 'scene.rml');
  { const raw = fs.readFileSync(scenePath, 'utf8'), swept = sweepOrphans(raw); if (swept !== raw) fs.writeFileSync(scenePath, swept); } // loose leftovers from deleted artboards
  const before = await run([dir, '--verify'], dir);
  if (!before.ok) return { dir, name: 'file-' + fileId, mode: 'existing', verify: { ok: false, output: 'Your file does not verify on its own, so I did not touch it:\n' + before.output }, fonts: { real: [], standIn: [], missing: [] }, added: [] };
  const existing = fs.readFileSync(scenePath, 'utf8');
  // Backup of the file as it is now. Kept OUTSIDE the project folder: the CLI compiles every .rml
  // it finds in there, and ships any other file type as an asset.
  fs.mkdirSync(path.join(EXPORTS, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(EXPORTS, 'backups', 'file-' + fileId + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.rml'), existing);
  const rep = (Array.isArray(body.replace) ? body.replace : []).slice(0, 200).filter(p => p && typeof p.old === 'string' && typeof p.new === 'string');
  const m = mergeIntoExisting(existing, String(body.rml), rep);
  fs.writeFileSync(scenePath, m.merged);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  writeImages(dir, body.images);
  const stand = standInFont(), real = [], standIn = [], missing = [];
  for (const f of body.fonts || []) {
    const base = path.basename(String(f.file)), dest = path.join(dir, 'fonts', base), lib = path.join(FONTS, base);
    if (fs.existsSync(lib)) { fs.copyFileSync(lib, dest); real.push(base); }
    else if (fs.existsSync(dest)) real.push(base);
    else if (stand) { fs.copyFileSync(stand, dest); standIn.push(base); }
    else missing.push(base);
  }
  const verify = await run([dir, '--verify'], dir);
  if (!verify.ok) fs.writeFileSync(scenePath, existing); // never leave a broken merge behind
  return { dir, name: 'file-' + fileId, mode: 'existing', fileId, added: m.added, replaced: m.replaced, verify, fonts: { real, standIn, missing }, linked: true };
}

// Delete ONE artboard from the Rive file an export is linked to: pull the live file, cut the artboard, verify, push.
async function doDeleteArtboard(body) {
  const name = safeName(body.name), dir = path.join(EXPORTS, name), ab = String(body.artboard || '').trim();
  const yamlPath = path.join(dir, 'rive.yaml');
  if (!ab) return { ok: false, output: 'No artboard name given.' };
  if (!fs.existsSync(yamlPath) || !/^push:/m.test(fs.readFileSync(yamlPath, 'utf8'))) return { ok: false, output: 'This export is not linked to a Rive file, so there is nothing in Rive to delete.' };
  const dl = await run(['pull', dir, '--yes'], ROOT);
  if (!dl.ok) return { ok: false, output: 'Could not download your Rive file:\n' + dl.output };
  const scenePath = path.join(dir, 'scene.rml'), existing = sweepOrphans(fs.readFileSync(scenePath, 'utf8'));
  if ((existing.match(/<Artboard(?=\s)/g) || []).length <= 1) return { ok: false, output: 'That is the only artboard in the file, so I did not delete it.' };
  const cut = cutArtboard(existing, ab);
  if (!cut.found) return { ok: false, gone: true, output: 'There is no artboard called "' + ab + '" in the Rive file (already deleted or renamed).' };
  fs.mkdirSync(path.join(EXPORTS, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(EXPORTS, 'backups', 'before-delete-' + name + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.rml'), existing);
  fs.writeFileSync(scenePath, cut.text);
  const verify = await run([dir, '--verify'], dir);
  if (!verify.ok) { fs.writeFileSync(scenePath, existing); return { ok: false, output: 'The file would not build without it, so nothing was deleted:\n' + verify.output }; }
  const push = await run(['push', dir, '--yes', '--name=Removed artboard ' + ab], dir);
  if (!push.ok) fs.writeFileSync(scenePath, existing);
  return { ok: push.ok, output: push.output };
}

async function doPush(body) {
  const name = String(body.name).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 70) || 'figma-import', dir = path.join(EXPORTS, name);
  if (!fs.existsSync(path.join(dir, 'scene.rml'))) return { ok: false, output: 'Nothing exported yet for "' + name + '".' };
  const args = ['push', dir, '--yes', '--name=' + (body.label || 'Figma import')];
  if (!/^push:/m.test(fs.readFileSync(path.join(dir, 'rive.yaml'), 'utf8'))) {
    const pid = (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {}).projectId; // re-read, so a changed project needs no restart
    if (!pid) return { ok: false, output: 'No Rive project chosen. Close and double-click Start Helper.command again to pick one.' };
    args.push('--project=' + pid);
  }
  const r = await run(args, dir);
  const m = r.output.match(/file (\d+) updated/) || r.output.match(/created file (\d+)/);
  return { ok: r.ok, output: r.output, fileId: m && m[1], url: m && 'https://editor.rive.app/file/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '/' + m[1] };
}

function handler(req, res) {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const send = (code, obj) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, h)); res.end(JSON.stringify(obj)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  if (req.headers['x-token'] !== TOKEN) return send(401, { error: 'bad token' });
  let data = '';
  req.on('data', c => { data += c; if (data.length > 30e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = data ? JSON.parse(data) : {};
      if (req.method === 'GET' && req.url === '/status') {
        const v = await run(['--version'], ROOT);
        return send(200, { ok: v.ok, rive: v.output, projectId: cfg.projectId || null, realFonts: fs.readdirSync(FONTS).filter(f => /\.(ttf|otf)$/i.test(f)) });
      }
      if (req.method === 'GET' && req.url === '/files') {
        // Every file in your Rive account's projects right now, so the plugin always matches the account.
        const pid = (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {}).projectId;
        const rows = o => o.split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
        let ws = [];
        if (pid) { const probe = await run(['ls', String(pid), '--json'], ROOT), m = probe.output.match(/workspace [^(]*\((\d+)\)/); if (m) ws = ['--workspace=' + m[1]]; }
        const plist = await run(['ls', '--json'].concat(ws), ROOT);
        const projects = rows(plist.output).filter(r => r.kind === 'project').map(r => r.projectId);
        if (pid && projects.indexOf(+pid) < 0) projects.push(+pid);
        const files = [];
        for (const prj of projects) for (const r of rows((await run(['ls', String(prj), '--all', '--json'].concat(ws), ROOT)).output)) if (r.kind === 'file') files.push({ id: r.fileId, name: r.name, projectId: prj });
        return send(200, { ok: plist.ok || files.length > 0, files });
      }
      if (req.method === 'GET' && req.url.startsWith('/artboards?fileId=')) {
        // The artboards that are in a Rive file right now (pulled fresh), so the plugin can list them project by project.
        const fid = (req.url.split('fileId=')[1] || '').split('&')[0].replace(/\D/g, ''), dir = path.join(EXPORTS, 'file-' + fid);
        if (!fid) return send(400, { error: 'bad file id' });
        const linked = fs.existsSync(path.join(dir, 'rive.yaml'));
        const dl = linked ? await run(['pull', dir, '--yes'], ROOT) : await run(['create', dir, '--from-remote-file=' + fid], ROOT);
        if (!dl.ok) return send(200, { ok: false, error: dl.output.slice(-300), artboards: [] });
        const text = fs.readFileSync(path.join(dir, 'scene.rml'), 'utf8');
        const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        const artboards = [...text.matchAll(/<Artboard\s[^>]*>/g)].map(m => ({ name: dec((m[0].match(/\sname="([^"]*)"/) || [])[1] || ''), component: /\sisComponent="true"/.test(m[0]) }));
        return send(200, { ok: true, artboards });
      }
      if (req.method === 'GET' && req.url.startsWith('/artboards')) {
        // Artboard names in an export's scene, so older Recent entries can fill their Artboards tab.
        const nm = safeName(decodeURIComponent((req.url.split('name=')[1] || '').split('&')[0])), f = path.join(EXPORTS, nm, 'scene.rml');
        const names = fs.existsSync(f) ? [...fs.readFileSync(f, 'utf8').matchAll(/<Artboard\s[^>]*?name="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')) : [];
        return send(200, { names });
      }
      if (req.method === 'POST' && req.url === '/frame') return send(200, doFrame(body));
      if (req.method === 'POST' && req.url === '/inbox') return send(200, doInbox(body));
      if (req.method === 'POST' && req.url === '/export') return send(200, await doExport(body));
      if (req.method === 'POST' && req.url === '/delete-artboard') return send(200, await doDeleteArtboard(body));
      if (req.method === 'POST' && req.url === '/push') return send(200, await doPush(body));
      send(404, { error: 'not found' });
    } catch (e) { send(500, { error: String(e.message || e) }); }
  });
}
// "localhost" can resolve to IPv4 or IPv6, so answer on both loopbacks (never on the network).
['127.0.0.1', '::1'].forEach(host => {
  const srv = http.createServer(handler);
  srv.on('error', e => { if (host === '127.0.0.1') { console.error(e.message); process.exit(1); } });
  srv.listen(PORT, host, () => {
    if (host === '127.0.0.1') {
      console.log('Figma to Rive helper on http://localhost:' + PORT);
      console.log('Token (paste into the plugin once): ' + TOKEN);
      console.log('Real fonts go in: ' + FONTS);
    }
  });
});
