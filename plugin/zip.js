// Minimal store-only (no compression) ZIP writer, so the plugin needs no libraries.
function makeZip(files) {
  var table = (function () { var t = [], c, n, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  var enc = new TextEncoder(), parts = [], central = [], offset = 0;
  function u16(v) { return [v & 255, (v >>> 8) & 255]; }
  function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  files.forEach(function (f) {
    var name = enc.encode(f.path), crc = crc32(f.data), size = f.data.length;
    var local = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0));
    parts.push(new Uint8Array(local), name, f.data);
    central.push({ name: name, crc: crc, size: size, offset: offset });
    offset += local.length + name.length + size;
  });
  var cdStart = offset, cdSize = 0;
  central.forEach(function (c) {
    var h = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset));
    parts.push(new Uint8Array(h), c.name); cdSize += h.length + c.name.length;
  });
  parts.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0))));
  var total = parts.reduce(function (n, p) { return n + p.length; }, 0), out = new Uint8Array(total), pos = 0;
  parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
  return out;
}
if (typeof module === 'object' && module.exports) module.exports = { makeZip: makeZip };
