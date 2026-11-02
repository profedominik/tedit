/*!
 * tshirt-designer.js — the <tshirt-designer> web component
 *
 * Position, resize and rotate images on the front and back of a T-shirt,
 * set the shirt colour and the scene background, remove solid image
 * backgrounds, and export mockups (PNG / JPEG / WebP / SVG / PDF),
 * print-ready artwork, a ZIP bundle and a re-editable project file (JSON).
 *
 * - Zero dependencies, a single classic script (also works from file://).
 * - Shadow DOM: drop it inside any page or dashboard without CSS clashes.
 * - Public JS API + DOM events so a host application can drive it.
 *
 *   <script src="tshirt-designer.js"></script>
 *   <tshirt-designer style="height:720px"></tshirt-designer>
 *
 * @version 1.0.0
 */
(function (global) {
  'use strict';
  if (!global || !global.customElements || global.customElements.get('tshirt-designer')) return;

  /* ===================================================================== *
   * 1. Constants & small utilities
   * ===================================================================== */

  const VERSION = '1.0.0';
  const TAG = 'tshirt-designer';
  const FORMAT = 'tshirt-designer';
  const ART = 1000; // the artboard is ART x ART model units (square)
  const DEG = Math.PI / 180;
  const MIN_SIZE = 6; // minimum layer size in model units
  const MAX_HISTORY = 150;
  const SIDES = ['front', 'back'];
  const SAFE_CANVAS_AREA = 16777216; // 4096², the iOS Safari canvas limit

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let _uidCounter = 0;
  const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 8) + (++_uidCounter).toString(36);
  const roundTo = (v, d = 2) => { const f = 10 ** d; return Math.round(v * f) / f; };
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms) => {
    let t = 0;
    const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    f.cancel = () => clearTimeout(t);
    return f;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normDeg = (d) => { d = ((((d + 180) % 360) + 360) % 360) - 180; return d === -180 ? 180 : d; };
  const fileBase = (name) => String(name || 'image').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'image';
  const slug = (s) => String(s || 'design').trim().toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design';
  const isBlob = (v) => typeof Blob !== 'undefined' && v instanceof Blob;

  /* ---------- colour helpers ---------- */

  const BLACK = { r: 0, g: 0, b: 0 };
  const WHITE = { r: 255, g: 255, b: 255 };
  let _colorCtx = null;

  function parseColor(input) {
    if (input == null || input === '') return null;
    if (typeof input === 'object' && 'r' in input) return input;
    const s = String(input).trim();
    let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.replace(/./g, '$&$&');
      const n = parseInt(h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) return { r: clamp(+m[1], 0, 255), g: clamp(+m[2], 0, 255), b: clamp(+m[3], 0, 255) };
    if (!/^[a-z]+$/i.test(s)) return null;
    _colorCtx = _colorCtx || document.createElement('canvas').getContext('2d');
    _colorCtx.fillStyle = '#010203';
    _colorCtx.fillStyle = s;
    const v = _colorCtx.fillStyle;
    if (v === '#010203') return null;
    return v[0] === '#' ? parseColor(v) : null;
  }
  const toHex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const normHex = (input, fallback = null) => { const c = parseColor(input); return c ? toHex(c) : fallback; };
  const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  const luminance = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const rgba = (c, a = 1) => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${+(+a).toFixed(4)})`;

  /* ---------- presets ---------- */

  const SHIRT_COLORS = [
    ['White', '#ffffff'], ['Natural', '#efe9dc'], ['Ash', '#dcdcd8'], ['Heather Grey', '#a9aaa8'],
    ['Charcoal', '#45484d'], ['Black', '#1c1c1e'], ['Navy', '#1f2a44'], ['Royal Blue', '#2753a6'],
    ['Sky', '#8fbfe0'], ['Teal', '#127c80'], ['Kelly Green', '#1f8a4c'], ['Forest', '#25402f'],
    ['Olive', '#5d603d'], ['Gold', '#f2b42c'], ['Orange', '#e8641e'], ['Red', '#c8102e'],
    ['Maroon', '#5b1f2a'], ['Pink', '#f4a7c0'], ['Purple', '#4b2e83'], ['Sand', '#d6c4a2'],
  ];
  const BG_COLORS = ['#eef1f5', '#ffffff', '#f4efe6', '#e8f0e9', '#e3ecf7', '#f7e8ea', '#2a2e35', '#111316'];
  const PRINT_AREAS = [
    ['12x16', '12 × 16 in — standard'], ['10x12', '10 × 12 in — medium'], ['14x16', '14 × 16 in — large'],
    ['15x18', '15 × 18 in — oversize'], ['8x10', '8 × 10 in — small'],
  ];
  const BLEND_MODES = [
    ['normal', 'Normal'], ['multiply', 'Multiply — hide white areas'], ['screen', 'Screen — hide black areas'],
    ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ];
  const BLEND_OP = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten' };

  /* ===================================================================== *
   * 2. Icons (24×24 line icons, drawn for this component)
   * ===================================================================== */

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15.5l-5-5L5 20"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.6-4.6M11 8v6M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.6-4.6M8 11h6"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    guides: '<rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke-dasharray="3 2.4"/><path d="M12 7v10" opacity=".55"/>',
    clip: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.4"/><rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" fill-opacity=".25"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    save: '<path d="M5 3.5h11l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M8 3.5v5h7v-5M8 20.5v-6.5h8v6.5"/>',
    open: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    newDoc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    flipH: '<path d="M12 3v18" stroke-dasharray="2 2.2"/><path d="M9 7L3.5 17H9zM15 7l5.5 10H15z"/>',
    flipV: '<path d="M3 12h18" stroke-dasharray="2 2.2"/><path d="M7 9L17 3.5V9zM7 15l10 5.5V15z"/>',
    rotL: '<path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5"/><path d="M4 3.5v5h5"/>',
    rotR: '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 3.5v5h-5"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    unlock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.7"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.6M6.5 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.7-1.3"/><path d="M9.9 10a2.8 2.8 0 0 0 4 4"/>',
    toFront: '<path d="M12 20V9M7 13.5L12 8.5l5 5M5 4h14"/>',
    forward: '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/>',
    backward: '<path d="M12 5v13M6.5 12.5L12 18l5.5-5.5"/>',
    toBack: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    alignH: '<path d="M12 3v18"/><rect x="6" y="6.5" width="12" height="4.5" rx="1"/><rect x="8" y="13.5" width="8" height="4.5" rx="1"/>',
    alignV: '<path d="M3 12h18"/><rect x="6.5" y="6" width="4.5" height="12" rx="1"/><rect x="13.5" y="8" width="4.5" height="8" rx="1"/>',
    alignTop: '<path d="M4 4h16"/><rect x="6.5" y="7" width="4.5" height="12" rx="1"/><rect x="13.5" y="7" width="4.5" height="7.5" rx="1"/>',
    fitArea: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2.4"/><path d="M8 8h3M8 8v3M16 16h-3M16 16v-3M8 8l8 8"/>',
    eyedropper: '<path d="M17.2 3.6a2.2 2.2 0 0 1 3.2 3.2L18 9.2 14.8 6z"/><path d="M15.4 6.6l2 2-8.7 8.7-3 1 1-3z"/><path d="M4 20l1.7-1.7"/>',
    wand: '<path d="M4.5 19.5L15 9M13 7l4 4"/><path d="M18 3v3M16.5 4.5h3M20 13v3M18.5 14.5h3M7 3v2M6 4h2"/>',
    crop: '<path d="M6 2.5V16a2 2 0 0 0 2 2h13.5"/><path d="M18 21.5V8a2 2 0 0 0-2-2H2.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.5M12 17v.01"/>',
    grip: '<circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    unlink: '<path d="M15.5 13.5l3-3a4 4 0 0 0-5.7-5.7l-1 1M8.5 10.5l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M8 3v2M3 8h2M16 21v-2M21 16h-2"/>',
    swap: '<path d="M7 7.5h12l-3.5-3.5M17 16.5H5l3.5 3.5"/>',
    layers: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3 13.5l9 5 9-5"/>',
    shirt: '<path d="M8.5 3.5L3 6.5l2 5 2.5-1.2V20.5h9V10.3l2.5 1.2 2-5-5.5-3a3.5 3.5 0 0 1-7 0z"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warn: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.2v.01"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5"/><path d="M4 3.5v5h5"/>',
    upload: '<path d="M12 16V4M7 8.5l5-5 5 5M5 20h14"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  };
  const icon = (name, size = 18) =>
    `<svg class="i" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

  /* ===================================================================== *
   * 3. The T-shirt template (vector, flat-lay, front + back)
   *
   * Everything is expressed in model units on a 1000×1000 artboard
   * (26 units = 1 inch, i.e. a men's size L: ~22" chest, ~30" long).
   * "over" primitives are painted ON TOP of the artwork using only
   * black/white with alpha, so folds, seams and the collar shade the print
   * exactly like they shade the fabric — for any shirt colour.
   * ===================================================================== */

  function mirrorPathX(d) {
    let isX = true;
    return d.match(/[a-z]|-?\d*\.?\d+/gi).map((t) => {
      if (/[a-z]/i.test(t)) { isX = true; return t; }
      const n = parseFloat(t);
      const out = isX ? +(ART - n).toFixed(2) : n;
      isX = !isX;
      return out;
    }).join(' ');
  }
  function mirrorPrim(p) {
    const q = Object.assign({}, p);
    if (q.d) q.d = mirrorPathX(q.d);
    if (q.cx != null) q.cx = ART - q.cx;
    if (q.rot != null) q.rot = -q.rot;
    if (q.paint && q.paint.type === 'linear') q.paint = Object.assign({}, q.paint, { x1: ART - q.paint.x1, x2: ART - q.paint.x2 });
    return q;
  }
  const sym = (p) => [p, mirrorPrim(p)];

  function createTeeTemplate() {
    const SIL = 'M 403 102 C 352 108 296 120 242 136 C 178 158 110 196 54 246 L 144 402 C 170 386 192 372 213 360 C 220 520 204 720 207 888 C 400 898 600 898 793 888 C 796 720 780 520 787 360 C 808 372 830 386 856 402 L 946 246 C 890 196 822 158 758 136 C 704 120 648 108 597 102 C 568 110 535 113 500 113 C 465 113 432 110 403 102 Z';
    const BODY = 'M 242 136 C 230 200 219 290 213 360 C 220 520 204 720 207 888 C 400 898 600 898 793 888 C 796 720 780 520 787 360 C 781 290 770 200 758 136 C 704 120 648 108 597 102 C 568 110 535 113 500 113 C 465 113 432 110 403 102 C 352 108 296 120 242 136 Z';
    const SLEEVE_R = 'M 758 136 C 822 158 890 196 946 246 L 856 402 C 830 386 808 372 787 360 C 781 290 770 200 758 136 Z';
    const ARMHOLE_R = 'M 758 136 C 770 200 781 290 787 360';
    const STITCH = { color: 'line', alpha: 0.55, width: 1.2, dash: [5, 3.5] };

    const shading = [
      // the body reads as a soft cylinder
      { t: 'fill', d: BODY, paint: { type: 'linear', x1: 207, y1: 0, x2: 793, y2: 0, stops: [[0, '#000', 0.16], [0.09, '#000', 0.06], [0.28, '#000', 0], [0.72, '#000', 0], [0.91, '#000', 0.06], [1, '#000', 0.16]] } },
      // sleeves: along the arm, then across (lit top, shaded underside)
      ...sym({ t: 'fill', d: SLEEVE_R, paint: { type: 'linear', x1: 772, y1: 250, x2: 901, y2: 324, stops: [[0, '#000', 0.13], [0.22, '#000', 0.02], [0.8, '#000', 0], [1, '#000', 0.1]] } }),
      ...sym({ t: 'fill', d: SLEEVE_R, paint: { type: 'linear', x1: 830, y1: 175, x2: 790, y2: 390, stops: [[0, '#fff', 0.07], [0.45, '#fff', 0], [0.75, '#000', 0], [1, '#000', 0.1]] } }),
      // underarm folds
      ...sym({ t: 'blob', cx: 233, cy: 398, rx: 52, ry: 11, rot: 64, color: '#000', alpha: 0.14 }),
      ...sym({ t: 'blob', cx: 258, cy: 482, rx: 80, ry: 9, rot: 72, color: '#000', alpha: 0.07 }),
      ...sym({ t: 'blob', cx: 248, cy: 410, rx: 30, ry: 8, rot: 40, color: '#fff', alpha: 0.06 }),
      // gentle drag folds on the body
      { t: 'blob', cx: 335, cy: 650, rx: 120, ry: 9, rot: -14, color: '#000', alpha: 0.05 },
      { t: 'blob', cx: 345, cy: 664, rx: 110, ry: 6, rot: -14, color: '#fff', alpha: 0.05 },
      { t: 'blob', cx: 680, cy: 720, rx: 125, ry: 8, rot: 11, color: '#000', alpha: 0.045 },
      { t: 'blob', cx: 672, cy: 708, rx: 115, ry: 5, rot: 11, color: '#fff', alpha: 0.045 },
      { t: 'blob', cx: 470, cy: 812, rx: 150, ry: 7, rot: 3, color: '#000', alpha: 0.04 },
      // highlights
      { t: 'blob', cx: 500, cy: 430, rx: 240, ry: 320, rot: 0, color: '#fff', alpha: 0.05 },
      ...sym({ t: 'blob', cx: 300, cy: 175, rx: 80, ry: 26, rot: 12, color: '#fff', alpha: 0.06 }),
      // hem roll
      { t: 'fill', d: BODY, paint: { type: 'linear', x1: 0, y1: 846, x2: 0, y2: 896, stops: [[0, '#000', 0], [0.75, '#000', 0.05], [1, '#000', 0.13]] } },
      // armhole seams
      ...sym({ t: 'stroke', d: ARMHOLE_R, color: '#000', alpha: 0.08, width: 7 }),
      ...sym({ t: 'stroke', d: ARMHOLE_R, color: 'line', alpha: 0.5, width: 1.3 }),
      // sleeve hems
      ...sym(Object.assign({ t: 'stroke', d: 'M 941 231 L 841 404' }, STITCH)),
      ...sym(Object.assign({ t: 'stroke', d: 'M 935 228 L 835 401' }, STITCH)),
      ...sym({ t: 'stroke', d: 'M 948 249 L 858 405', color: '#000', alpha: 0.12, width: 9 }),
      // bottom hem
      Object.assign({ t: 'stroke', d: 'M 190 873 C 400 883 600 883 810 873' }, STITCH),
      Object.assign({ t: 'stroke', d: 'M 190 866 C 400 876 600 876 810 866' }, STITCH),
    ];
    const outline = { t: 'stroke', d: SIL, color: 'line', alpha: 0.55, width: 1.6, clip: false };

    const FRONT_BAND = 'M 403 102 C 408 160 452 192 500 192 C 548 192 592 160 597 102 L 578 106 C 572 152 538 172 500 172 C 462 172 428 152 422 106 Z';
    const NECK_HOLE = 'M 422 106 C 446 122 474 130 500 130 C 526 130 554 122 578 106 C 572 152 538 172 500 172 C 462 172 428 152 422 106 Z';
    const BACK_BAND_INSIDE = 'M 597 102 C 568 110 535 113 500 113 C 465 113 432 110 403 102 L 422 106 C 446 122 474 130 500 130 C 526 130 554 122 578 106 Z';
    const front = {
      label: 'Front',
      silhouette: SIL,
      printTop: 214,
      collarY: 192,
      over: [
        ...shading,
        { t: 'blob', cx: 500, cy: 204, rx: 125, ry: 18, rot: 0, color: '#000', alpha: 0.07 },
        { t: 'texture', d: SIL },
        // inside of the shirt seen through the neck opening
        { t: 'fill', d: NECK_HOLE, color: 'inside' },
        { t: 'fill', d: NECK_HOLE, paint: { type: 'linear', x1: 0, y1: 118, x2: 0, y2: 172, stops: [[0, '#000', 0.38], [0.5, '#000', 0.15], [1, '#000', 0.04]] } },
        { t: 'fill', d: BACK_BAND_INSIDE, color: 'bandBack' },
        { t: 'stroke', d: 'M 412 104 C 440 116 470 122 500 122 C 530 122 560 116 588 104', color: '#000', alpha: 0.08, width: 14, dash: [1.4, 2.2] },
        // rib-knit collar
        { t: 'fill', d: FRONT_BAND, color: 'band' },
        { t: 'stroke', d: 'M 412 104 C 418 156 457 182 500 182 C 543 182 582 156 588 104', color: '#000', alpha: 0.07, width: 18, dash: [1.4, 2.2] },
        { t: 'fill', d: FRONT_BAND, paint: { type: 'linear', x1: 0, y1: 102, x2: 0, y2: 192, stops: [[0, '#000', 0.06], [1, '#fff', 0.04]] } },
        { t: 'stroke', d: 'M 422 106 C 428 152 462 172 500 172 C 538 172 572 152 578 106', color: 'line', alpha: 0.45, width: 1.2 },
        { t: 'stroke', d: 'M 403 102 C 408 160 452 192 500 192 C 548 192 592 160 597 102', color: 'line', alpha: 0.4, width: 1.2 },
        { t: 'stroke', d: 'M 398 106 C 404 168 452 199 500 199 C 548 199 596 168 602 106', color: 'line', alpha: 0.5, width: 1.1, dash: [4, 3] },
        outline,
      ],
    };

    const BACK_BAND = 'M 597 102 C 568 110 535 113 500 113 C 465 113 432 110 403 102 C 428 120 462 134 500 134 C 538 134 572 120 597 102 Z';
    const back = {
      label: 'Back',
      silhouette: SIL,
      printTop: 176,
      collarY: 134,
      over: [
        ...shading,
        { t: 'blob', cx: 500, cy: 146, rx: 120, ry: 15, rot: 0, color: '#000', alpha: 0.07 },
        ...sym({ t: 'stroke', d: 'M 598 106 C 648 112 704 124 755 140', color: 'line', alpha: 0.3, width: 1.1 }),
        { t: 'texture', d: SIL },
        { t: 'fill', d: BACK_BAND, color: 'band' },
        { t: 'stroke', d: 'M 403 102 C 432 116 466 124 500 124 C 534 124 568 116 597 102', color: '#000', alpha: 0.07, width: 18, dash: [1.4, 2.2] },
        { t: 'fill', d: BACK_BAND, paint: { type: 'linear', x1: 0, y1: 104, x2: 0, y2: 134, stops: [[0, '#fff', 0.05], [1, '#000', 0.06]] } },
        { t: 'stroke', d: 'M 403 102 C 428 120 462 134 500 134 C 538 134 572 120 597 102', color: 'line', alpha: 0.45, width: 1.2 },
        { t: 'stroke', d: 'M 400 107 C 430 128 464 141 500 141 C 536 141 570 128 600 107', color: 'line', alpha: 0.5, width: 1.1, dash: [4, 3] },
        outline,
      ],
    };

    return { id: 'tee-crew', name: 'Crew neck T-shirt', width: ART, height: ART, pxPerInch: 26, sides: { front, back } };
  }
  const TEE = createTeeTemplate();

  /** Colours derived from the shirt colour, used by the template primitives. */
  function shirtPalette(hex) {
    const base = parseColor(hex) || WHITE;
    const L = luminance(base);
    return {
      base, L,
      inside: mix(base, BLACK, L > 0.5 ? 0.2 : 0.32),
      band: mix(base, BLACK, 0.03),
      bandBack: mix(base, BLACK, L > 0.5 ? 0.1 : 0.18),
      line: L < 0.1 ? mix(base, WHITE, 0.24) : mix(base, BLACK, 0.3),
      '#000': BLACK,
      '#fff': WHITE,
    };
  }
  const paintColor = (pal, c) => pal[c] || parseColor(c) || BLACK;

  /* ===================================================================== *
   * 4. Canvas renderer
   * ===================================================================== */

  const _pathCache = new Map();
  function path2d(d) {
    let p = _pathCache.get(d);
    if (!p) { p = new Path2D(d); _pathCache.set(d, p); }
    return p;
  }

  const NOISE_SIZE = 128;
  const NOISE_SCALE = 0.55; // one noise pixel = 0.55 model units
  let _noiseCanvas = null;
  let _noiseURL = null;
  /**
   * A deterministic, seamlessly tiling grain used as a subtle cotton texture.
   * The noise is softened with a small wrap-around blur: it reads as fabric
   * rather than sensor noise, and keeps exported PNGs compact.
   */
  function noiseTile() {
    if (_noiseCanvas) return _noiseCanvas;
    const N = NOISE_SIZE;
    let seed = 0x2f6b9d1;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    let a = new Float32Array(N * N);
    for (let i = 0; i < a.length; i++) a[i] = rnd() - 0.5;
    const blur = (src, horizontal) => {
      const out = new Float32Array(N * N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let sum = 0;
          for (let k = -1; k <= 1; k++) {
            const xx = horizontal ? (x + k + N) % N : x, yy = horizontal ? y : (y + k + N) % N;
            sum += src[yy * N + xx];
          }
          out[y * N + x] = sum / 3;
        }
      }
      return out;
    };
    a = blur(blur(a, true), false);
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]));
    const c = makeCanvas(N, N);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let i = 0, p = 0; i < a.length; i++, p += 4) {
      const v = a[i] / max; // -1..1
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v > 0 ? 255 : 0;
      img.data[p + 3] = Math.round(Math.abs(v) * 20);
    }
    ctx.putImageData(img, 0, 0);
    return (_noiseCanvas = c);
  }
  const noiseDataURL = () => _noiseURL || (_noiseURL = noiseTile().toDataURL('image/png'));

  const BLOB_STOPS = [[0, 1], [0.35, 0.72], [0.65, 0.32], [0.85, 0.1], [1, 0]];

  /**
   * Paint template primitives. `clipPath` is the shirt silhouette; every
   * primitive is clipped to it unless it says `clip:false`.
   */
  function drawPrims(ctx, prims, pal, clipPath, opts = {}) {
    const shading = opts.shading !== false;
    const deviceScale = opts.deviceScale || 1;
    let clipped = false;
    for (const p of prims) {
      if (!shading && (p.t === 'texture' || p.t === 'blob' || p.paint)) continue;
      const wantClip = p.clip !== false;
      if (wantClip !== clipped) {
        if (clipped) ctx.restore();
        if (wantClip) { ctx.save(); ctx.clip(clipPath); }
        clipped = wantClip;
      }
      ctx.save();
      if (p.t === 'fill') {
        if (p.paint) {
          const g = ctx.createLinearGradient(p.paint.x1, p.paint.y1, p.paint.x2, p.paint.y2);
          for (const [o, c, a] of p.paint.stops) g.addColorStop(o, rgba(paintColor(pal, c), a));
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = rgba(paintColor(pal, p.color), p.alpha == null ? 1 : p.alpha);
        }
        ctx.fill(path2d(p.d));
      } else if (p.t === 'stroke') {
        ctx.strokeStyle = rgba(paintColor(pal, p.color), p.alpha == null ? 1 : p.alpha);
        ctx.lineWidth = p.width || 1;
        ctx.lineCap = p.dash ? 'butt' : 'round';
        ctx.lineJoin = 'round';
        if (p.dash) ctx.setLineDash(p.dash);
        ctx.stroke(path2d(p.d));
      } else if (p.t === 'blob') {
        ctx.translate(p.cx, p.cy);
        if (p.rot) ctx.rotate(p.rot * DEG);
        ctx.scale(p.rx / 100, p.ry / 100);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 100);
        const c = paintColor(pal, p.color);
        for (const [o, f] of BLOB_STOPS) g.addColorStop(o, rgba(c, p.alpha * f));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, 100, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.t === 'texture') {
        const pat = ctx.createPattern(noiseTile(), 'repeat');
        if (pat) {
          const ns = Math.min(NOISE_SCALE, 1.25 / deviceScale);
          try { pat.setTransform(new DOMMatrix([ns, 0, 0, ns, 0, 0])); } catch (e) { /* older engines: unscaled grain */ }
          ctx.fillStyle = pat;
          ctx.fill(path2d(p.d));
        }
      }
      ctx.restore();
    }
    if (clipped) ctx.restore();
  }

  /** The flat shirt colour (plus a soft drop shadow on the background). */
  function drawShirtBase(ctx, sideDef, pal, deviceScale, opts = {}) {
    const sil = path2d(sideDef.silhouette);
    if (opts.shadow !== false) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.2)';
      ctx.shadowBlur = 26 * deviceScale;
      ctx.shadowOffsetY = 10 * deviceScale;
      ctx.fillStyle = rgba(pal.base);
      ctx.fill(sil);
      ctx.restore();
    }
    ctx.fillStyle = rgba(pal.base);
    ctx.fill(sil);
  }

  function drawShirtOver(ctx, sideDef, pal, opts = {}) {
    drawPrims(ctx, sideDef.over, pal, path2d(sideDef.silhouette), opts);
  }

  /** Scene background inside the rectangle (x, y, w, h) of the current transform. */
  function drawBackground(ctx, bg, x, y, w, h, bgImage) {
    if (!bg || bg.type === 'transparent') return;
    ctx.save();
    if (bg.type === 'image' && bgImage) {
      const iw = bgImage.naturalWidth || bgImage.width;
      const ih = bgImage.naturalHeight || bgImage.height;
      const k = Math.max(w / iw, h / ih);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bgImage, x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k);
    } else if (bg.type === 'gradient') {
      const c1 = parseColor(bg.color) || WHITE;
      const c2 = parseColor(bg.color2) || c1;
      const cx = x + w / 2, cy = y + h * 0.42;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) * 0.62);
      g.addColorStop(0, rgba(c1));
      g.addColorStop(1, rgba(c2));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.fillStyle = rgba(parseColor(bg.color) || WHITE);
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  /** Draw one artwork layer. `bmp` = { image, sx, sy, sw, sh }. */
  function drawLayerBitmap(ctx, L, bmp, opts = {}) {
    ctx.save();
    ctx.translate(L.x, L.y);
    if (L.rotation) ctx.rotate(L.rotation * DEG);
    if (L.flipX || L.flipY) ctx.scale(L.flipX ? -1 : 1, L.flipY ? -1 : 1);
    ctx.globalAlpha = clamp(L.opacity == null ? 1 : L.opacity, 0, 1) * (opts.alpha == null ? 1 : opts.alpha);
    if (!opts.ignoreBlend) ctx.globalCompositeOperation = BLEND_OP[L.blend] || 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(bmp.image, bmp.sx, bmp.sy, bmp.sw, bmp.sh, -L.w / 2, -L.h / 2, L.w, L.h);
    } catch (e) { /* not decodable (yet) — skip */ }
    ctx.restore();
  }

  /* ===================================================================== *
   * 5. SVG renderer (vector mockup export)
   * ===================================================================== */

  const xa = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sn = (v) => +(+v).toFixed(3);

  function svgPrims(prims, pal, nextId, clipId, shading) {
    const defs = [];
    const out = [];
    let clipped = false;
    for (const p of prims) {
      if (!shading && (p.t === 'texture' || p.t === 'blob' || p.paint)) continue;
      const wantClip = p.clip !== false;
      if (wantClip !== clipped) {
        if (clipped) out.push('</g>');
        if (wantClip) out.push(`<g clip-path="url(#${clipId})">`);
        clipped = wantClip;
      }
      if (p.t === 'fill') {
        if (p.paint) {
          const id = nextId();
          defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${p.paint.x1}" y1="${p.paint.y1}" x2="${p.paint.x2}" y2="${p.paint.y2}">` +
            p.paint.stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${toHex(paintColor(pal, c))}" stop-opacity="${a}"/>`).join('') + '</linearGradient>');
          out.push(`<path d="${p.d}" fill="url(#${id})"/>`);
        } else {
          const a = p.alpha == null ? 1 : p.alpha;
          out.push(`<path d="${p.d}" fill="${toHex(paintColor(pal, p.color))}"${a < 1 ? ` fill-opacity="${a}"` : ''}/>`);
        }
      } else if (p.t === 'stroke') {
        out.push(`<path d="${p.d}" fill="none" stroke="${toHex(paintColor(pal, p.color))}" stroke-opacity="${p.alpha == null ? 1 : p.alpha}" stroke-width="${p.width || 1}" stroke-linecap="${p.dash ? 'butt' : 'round'}" stroke-linejoin="round"${p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''}/>`);
      } else if (p.t === 'blob') {
        const id = nextId();
        const c = toHex(paintColor(pal, p.color));
        defs.push(`<radialGradient id="${id}">` + BLOB_STOPS.map(([o, f]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${sn(p.alpha * f)}"/>`).join('') + '</radialGradient>');
        out.push(`<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}"${p.rot ? ` transform="rotate(${p.rot} ${p.cx} ${p.cy})"` : ''} fill="url(#${id})"/>`);
      } else if (p.t === 'texture') {
        out.push(`<path d="${p.d}" fill="url(#tsd-noise)"/>`);
      }
    }
    if (clipped) out.push('</g>');
    return { defs: defs.join(''), body: out.join('') };
  }

  function svgLayer(L, im) {
    const t = `translate(${sn(L.x)} ${sn(L.y)})` + (L.rotation ? ` rotate(${sn(L.rotation)})` : '') +
      (L.flipX || L.flipY ? ` scale(${L.flipX ? -1 : 1} ${L.flipY ? -1 : 1})` : '');
    const op = L.opacity != null && L.opacity < 1 ? ` opacity="${sn(L.opacity)}"` : '';
    const style = L.blend && L.blend !== 'normal' ? ` style="mix-blend-mode:${xa(L.blend)}"` : '';
    const label = `<title>${xa(L.name || 'Image')}</title>`;
    const x = sn(-L.w / 2), y = sn(-L.h / 2), w = sn(L.w), h = sn(L.h);
    const full = im.sx <= 0.001 && im.sy <= 0.001 && Math.abs(im.sw - im.iw) < 0.01 && Math.abs(im.sh - im.ih) < 0.01;
    if (full) {
      return `<g transform="${t}"${op}${style}>${label}<image xlink:href="${xa(im.href)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"/></g>`;
    }
    return `<g transform="${t}"${op}${style}>${label}<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${sn(im.sx)} ${sn(im.sy)} ${sn(im.sw)} ${sn(im.sh)}" preserveAspectRatio="none" overflow="hidden"><image xlink:href="${xa(im.href)}" width="${sn(im.iw)}" height="${sn(im.ih)}"/></svg></g>`;
  }

  /**
   * Build a standalone SVG mockup. `o.sides` is ['front'] or ['front','back'];
   * `o.images` maps layer id → { href, iw, ih, sx, sy, sw, sh }.
   */
  function buildSVG(o) {
    const n = o.sides.length;
    const W = ART * n, H = ART;
    const pal = shirtPalette(o.shirtColor);
    let k = 0;
    const nextId = () => 'tsd-g' + (++k);
    const defs = [];
    const body = [];
    const tile = sn(NOISE_SIZE * NOISE_SCALE);
    defs.push(`<pattern id="tsd-noise" patternUnits="userSpaceOnUse" width="${tile}" height="${tile}"><image xlink:href="${noiseDataURL()}" width="${tile}" height="${tile}"/></pattern>`);
    defs.push('<filter id="tsd-shadow" x="-15%" y="-15%" width="130%" height="135%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="13"/><feOffset dy="10" result="b"/><feFlood flood-color="#000" flood-opacity="0.2"/><feComposite in2="b" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    const bg = o.background || { type: 'transparent' };
    if (!o.transparent && bg.type !== 'transparent') {
      if (bg.type === 'image' && o.bgHref) {
        body.push(`<image xlink:href="${xa(o.bgHref)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
      } else if (bg.type === 'gradient') {
        const id = nextId();
        defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${W / 2}" cy="${H * 0.42}" r="${sn(Math.hypot(W, H) * 0.62)}"><stop offset="0" stop-color="${normHex(bg.color, '#ffffff')}"/><stop offset="1" stop-color="${normHex(bg.color2, normHex(bg.color, '#ffffff'))}"/></radialGradient>`);
        body.push(`<rect width="${W}" height="${H}" fill="url(#${id})"/>`);
      } else {
        body.push(`<rect width="${W}" height="${H}" fill="${normHex(bg.color, '#ffffff')}"/>`);
      }
    }
    o.sides.forEach((side, i) => {
      const sd = o.tpl.sides[side];
      const clipId = `tsd-clip-${side}`;
      defs.push(`<clipPath id="${clipId}"><path d="${sd.silhouette}"/></clipPath>`);
      body.push(`<g id="${side}" transform="translate(${i * ART} 0)">`);
      body.push(`<path d="${sd.silhouette}" fill="${toHex(pal.base)}" filter="url(#tsd-shadow)"/>`);
      body.push(`<g clip-path="url(#${clipId})">`);
      const pc = o.printClip && o.printClip[side];
      if (pc) {
        defs.push(`<clipPath id="tsd-pc-${side}"><rect x="${sn(pc.x)}" y="${sn(pc.y)}" width="${sn(pc.w)}" height="${sn(pc.h)}"/></clipPath>`);
        body.push(`<g clip-path="url(#tsd-pc-${side})">`);
      }
      for (const L of o.layers[side] || []) {
        const im = o.images.get(L.id);
        if (im) body.push(svgLayer(L, im));
      }
      if (pc) body.push('</g>');
      body.push('</g>');
      const sp = svgPrims(sd.over, pal, nextId, clipId, o.shading !== false);
      defs.push(sp.defs);
      body.push(sp.body);
      body.push('</g>');
    });
    const px = Math.round(o.width || 1000);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${px * n}" height="${px}" viewBox="0 0 ${W} ${H}">` +
      `<title>${xa(o.title || 'T-shirt mockup')}</title><defs>${defs.join('')}</defs>${body.join('')}</svg>`;
  }

  /* ===================================================================== *
   * 6. Imaging helpers
   * ===================================================================== */

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** Very large canvases silently fail on some devices — verify we can draw. */
  function canvasUsable(c) {
    try {
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(c.width - 1, c.height - 1, 1, 1);
      const ok = ctx.getImageData(c.width - 1, c.height - 1, 1, 1).data[3] === 255;
      ctx.clearRect(c.width - 1, c.height - 1, 1, 1);
      return ok;
    } catch (e) { return false; }
  }

  /** Create a canvas as close to w×h as the device allows. Returns { canvas, k } (k = scale applied). */
  function makeSafeCanvas(w, h) {
    if (w * h <= SAFE_CANVAS_AREA) return { canvas: makeCanvas(w, h), k: 1 }; // always fine everywhere
    let k = 1;
    for (let i = 0; i < 8; i++) {
      const c = makeCanvas(w * k, h * k);
      if (canvasUsable(c)) return { canvas: c, k };
      c.width = c.height = 1;
      const area = w * h * k * k;
      k *= area > SAFE_CANVAS_AREA ? Math.sqrt(SAFE_CANVAS_AREA / area) * 0.98 : 0.75;
    }
    throw new Error('Not enough memory to create the image');
  }

  function loadImage(src, crossOrigin) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = crossOrigin;
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file could not be read as an image'));
      img.src = src;
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('Could not read file'));
      r.readAsDataURL(blob);
    });
  }

  function dataURLToBytes(url) {
    const comma = url.indexOf(',');
    const head = url.slice(0, comma);
    const data = url.slice(comma + 1);
    if (/;base64/i.test(head)) {
      const bin = atob(data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(data));
  }

  function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('The image is too large to export on this device'));
      if (canvas.toBlob) {
        canvas.toBlob((b) => (b ? resolve(b) : fail()), type, quality);
      } else {
        try { resolve(new Blob([dataURLToBytes(canvas.toDataURL(type, quality))], { type })); } catch (e) { fail(); }
      }
    });
  }

  let _webpOK = null;
  function webpSupported() {
    if (_webpOK == null) {
      try { _webpOK = makeCanvas(2, 2).toDataURL('image/webp').indexOf('data:image/webp') === 0; } catch (e) { _webpOK = false; }
    }
    return _webpOK;
  }

  const svgTextToDataURL = (text) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);

  /** Make an SVG safe to rasterise: explicit pixel width/height and a viewBox. */
  function normalizeSVG(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('This SVG file could not be read');
    }
    const num = (v) => (v && !/%$/.test(v) ? parseFloat(v) : NaN);
    let w = num(svg.getAttribute('width'));
    let h = num(svg.getAttribute('height'));
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasVB = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    if (!(w > 0) || !(h > 0)) {
      if (hasVB) {
        if (w > 0) h = (w * vb[3]) / vb[2];
        else if (h > 0) w = (h * vb[2]) / vb[3];
        else { w = vb[2]; h = vb[3]; }
      } else { w = w > 0 ? w : 512; h = h > 0 ? h : 512; }
    }
    if (!hasVB) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const k = Math.max(1, 1024 / Math.max(w, h)); // give tiny icons a useful intrinsic size
    svg.setAttribute('width', String(roundTo(w * k, 3)));
    svg.setAttribute('height', String(roundTo(h * k, 3)));
    return new XMLSerializer().serializeToString(svg);
  }

  /**
   * Colour-key background removal. Pure function (it also runs inside a Web
   * Worker, so it must not reference anything outside itself).
   * o = { r, g, b, tolerance 0..100, softness 0..100, edgesOnly }
   */
  function keyOutImpl(data, w, h, o) {
    var kr = o.r, kg = o.g, kb = o.b;
    var T = (o.tolerance / 100) * 0.55;
    var S = Math.max(0.002, (o.softness / 100) * 0.3);
    var lim = T + S, n = w * h, i, p;
    // fq: 0 = keep pixel; 1..255 = background candidate, remaining opacity (fq-1)/254
    var fq = new Uint8Array(n);
    for (i = 0, p = 0; i < n; i++, p += 4) {
      if (data[p + 3] < 8) { fq[i] = 1; continue; }
      var r = data[p], g = data[p + 1], b = data[p + 2];
      var rm = (r + kr) * 0.5, dr = r - kr, dg = g - kg, db = b - kb;
      var d = Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 765;
      if (d < lim) fq[i] = d <= T ? 1 : 1 + Math.round(((d - T) / S) * 254);
    }
    var visit = null;
    if (o.edgesOnly) {
      // scanline flood fill from the image border through candidate pixels
      visit = new Uint8Array(n);
      var stack = [], x, y;
      for (x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
      for (y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
      while (stack.length) {
        var j = stack.pop();
        if (visit[j] || !fq[j]) continue;
        var yy = (j / w) | 0, row = yy * w, xl = j - row, xr = xl;
        while (xl > 0 && fq[row + xl - 1] && !visit[row + xl - 1]) xl--;
        while (xr < w - 1 && fq[row + xr + 1] && !visit[row + xr + 1]) xr++;
        var upOpen = false, dnOpen = false;
        for (var xx = xl; xx <= xr; xx++) {
          visit[row + xx] = 1;
          if (yy > 0) {
            var u = row - w + xx;
            if (fq[u] && !visit[u]) { if (!upOpen) { stack.push(u); upOpen = true; } } else upOpen = false;
          }
          if (yy < h - 1) {
            var dn = row + w + xx;
            if (fq[dn] && !visit[dn]) { if (!dnOpen) { stack.push(dn); dnOpen = true; } } else dnOpen = false;
          }
        }
      }
    }
    for (i = 0, p = 0; i < n; i++, p += 4) {
      var q = fq[i];
      if (!q || (visit && !visit[i])) continue;
      var f = (q - 1) / 254;
      if (f <= 0.004) { data[p + 3] = 0; continue; }
      if (f < 1) {
        // un-mix the key colour from semi-transparent edge pixels (no halos)
        var inv = 1 - f;
        data[p] = Math.max(0, Math.min(255, (data[p] - inv * kr) / f));
        data[p + 1] = Math.max(0, Math.min(255, (data[p + 1] - inv * kg) / f));
        data[p + 2] = Math.max(0, Math.min(255, (data[p + 2] - inv * kb) / f));
      }
      data[p + 3] = Math.round(data[p + 3] * f);
    }
    return data;
  }

  /** Look at the border of an image: is it transparent, or one solid colour? */
  function detectBackground(data, w, h) {
    const buckets = new Map();
    let total = 0, transparent = 0;
    const step = Math.max(1, Math.floor((w + h) / 300));
    const sample = (x, y) => {
      const p = (y * w + x) * 4;
      total++;
      if (data[p + 3] < 24) { transparent++; return; }
      const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += data[p]; e.g += data[p + 1]; e.b += data[p + 2];
      buckets.set(key, e);
    };
    for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
    if (!total) return null;
    if (transparent / total > 0.5) return { transparent: true, coverage: transparent / total };
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    if (!best) return null;
    return { transparent: false, color: toHex({ r: best.r / best.n, g: best.g / best.n, b: best.b / best.n }), coverage: best.n / (total - transparent) };
  }

  /** Bounding box of pixels whose alpha exceeds `thr`. */
  function alphaBounds(data, w, h, thr = 10) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      let p = y * w * 4 + 3;
      for (let x = 0; x < w; x++, p += 4) {
        if (data[p] > thr) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /* --- background removal runs in a Web Worker when allowed (CSP-safe fallback) --- */
  let _keyWorker = null;
  let _keySeq = 0;
  const _keyJobs = new Map();
  function keyWorker() {
    if (_keyWorker) return _keyWorker;
    _keyWorker = new Promise((resolve) => {
      let worker, url;
      try {
        const src = keyOutImpl.toString() +
          '\nself.onmessage=function(e){var m=e.data;try{keyOutImpl(m.data,m.w,m.h,m.o);self.postMessage({id:m.id,data:m.data},[m.data.buffer]);}catch(err){self.postMessage({id:m.id,error:String(err&&err.message||err)});}};';
        url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        worker = new Worker(url);
      } catch (e) { resolve(null); return; }
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        if (!ok) { try { worker.terminate(); } catch (e) { /* ignore */ } resolve(null); return; }
        worker.onmessage = (e) => {
          const job = _keyJobs.get(e.data.id);
          if (!job) return;
          _keyJobs.delete(e.data.id);
          if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.data);
        };
        worker.onerror = (e) => {
          if (e && e.preventDefault) e.preventDefault();
          for (const [id, job] of _keyJobs) { _keyJobs.delete(id); job.reject(new Error('worker failed')); }
        };
        resolve(worker);
      };
      const timer = setTimeout(() => done(false), 4000);
      worker.onmessage = (e) => done(!!(e.data && e.data.id === 0 && e.data.data));
      worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); done(false); };
      worker.postMessage({ id: 0, data: new Uint8ClampedArray(4), w: 1, h: 1, o: { r: 0, g: 0, b: 0, tolerance: 10, softness: 10 } });
    });
    return _keyWorker;
  }
  async function runKeyOut(data, w, h, o) {
    const worker = await keyWorker();
    if (!worker) return keyOutImpl(data, w, h, o);
    return new Promise((resolve, reject) => {
      const id = ++_keySeq;
      _keyJobs.set(id, { resolve, reject });
      worker.postMessage({ id, data, w, h, o }, [data.buffer]);
    });
  }

  /* ===================================================================== *
   * 7. File writers: PDF, ZIP, PNG/JPEG DPI tags, downloads, storage
   * ===================================================================== */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Insert a pHYs chunk so print software knows the physical size (e.g. 12×16 in @ 300 DPI). */
  async function pngWithDPI(blob, dpi) {
    try {
      const src = new Uint8Array(await blob.arrayBuffer());
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      if (sig.some((v, i) => src[i] !== v)) return blob;
      if (String.fromCharCode(src[12], src[13], src[14], src[15]) !== 'IHDR') return blob;
      const insertAt = 8 + 8 + 13 + 4; // signature + IHDR (len,type,data,crc)
      const chunk = new Uint8Array(21);
      const dv = new DataView(chunk.buffer);
      const ppm = Math.round(dpi / 0.0254);
      dv.setUint32(0, 9);
      chunk.set([112, 72, 89, 115], 4); // "pHYs"
      dv.setUint32(8, ppm);
      dv.setUint32(12, ppm);
      chunk[16] = 1; // unit: metre
      dv.setUint32(17, crc32(chunk, 4, 17));
      const out = new Uint8Array(src.length + chunk.length);
      out.set(src.subarray(0, insertAt), 0);
      out.set(chunk, insertAt);
      out.set(src.subarray(insertAt), insertAt + chunk.length);
      return new Blob([out], { type: 'image/png' });
    } catch (e) { return blob; }
  }

  /** Set the JFIF density so the JPEG opens at the right print size. */
  async function jpegWithDPI(blob, dpi) {
    try {
      const b = new Uint8Array(await blob.arrayBuffer());
      if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff || b[3] !== 0xe0) return blob;
      if (String.fromCharCode(b[6], b[7], b[8], b[9]) !== 'JFIF') return blob;
      const d = Math.min(65535, Math.round(dpi));
      b[13] = 1; b[14] = d >> 8; b[15] = d & 255; b[16] = d >> 8; b[17] = d & 255;
      return new Blob([b], { type: 'image/jpeg' });
    } catch (e) { return blob; }
  }

  /* ---------- PDF ---------- */

  const WIN_ANSI = { '\u20ac': 0x80, '\u2026': 0x85, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97 };
  function latin1(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const c = s.charCodeAt(i);
      out[i] = c < 128 || (c >= 160 && c < 256) ? c : WIN_ANSI[ch] || 63;
    }
    return out;
  }
  const pdfStr = (s) => '(' + String(s).replace(/[\\()]/g, '\\$&').replace(/[\r\n]+/g, ' ') + ')';
  const pdfNum = (v) => (+v).toFixed(2).replace(/\.?0+$/, '') || '0';
  const pdfDate = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  };

  async function deflateBytes(bytes) {
    const cs = new CompressionStream('deflate');
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Encode a canvas for the PDF: lossless Flate (+ soft mask) or JPEG. */
  async function pdfImageFromCanvas(canvas, { lossless = false, alpha = false, quality = 0.92 } = {}) {
    const w = canvas.width, h = canvas.height;
    if ((lossless || alpha) && typeof CompressionStream !== 'undefined') {
      const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      const n = w * h;
      const rgb = new Uint8Array(n * 3);
      const a = new Uint8Array(n);
      let hasAlpha = false;
      for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
        rgb[k] = d[j]; rgb[k + 1] = d[j + 1]; rgb[k + 2] = d[j + 2];
        a[i] = d[j + 3];
        if (d[j + 3] !== 255) hasAlpha = true;
      }
      return { kind: 'flate', width: w, height: h, rgb: await deflateBytes(rgb), alpha: hasAlpha ? await deflateBytes(a) : null };
    }
    let src = canvas;
    if (alpha || lossless) { // no CompressionStream: flatten on white and use JPEG
      src = makeCanvas(w, h);
      const ctx = src.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(canvas, 0, 0);
    }
    const blob = await canvasToBlob(src, 'image/jpeg', lossless ? 0.97 : quality);
    return { kind: 'jpeg', width: w, height: h, bytes: new Uint8Array(await blob.arrayBuffer()) };
  }

  /**
   * pages: [{ w, h, draw: [ {type:'image', img, x, y, w, h}
   *                        | {type:'text', x, y, size, text, bold, color:[r,g,b]}
   *                        | {type:'rect', x, y, w, h, fill, stroke, lw, dash} ] }]
   * Coordinates are PDF points with the origin at the bottom-left.
   */
  function buildPDF(pages, info = {}) {
    const objs = [];
    const add = (parts) => { objs.push(parts); return objs.length; };
    const catalogId = add(null);
    const pagesId = add(null);
    const fontReg = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    const fontBold = add(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    const kids = [];
    for (const pg of pages) {
      const xobjs = [];
      let content = '';
      for (const op of pg.draw) {
        if (op.type === 'image') {
          const im = op.img;
          let imgId;
          if (im.kind === 'jpeg') {
            imgId = add([`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream']);
          } else {
            let smask = '';
            if (im.alpha) {
              const sid = add([`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${im.alpha.length} >>\nstream\n`, im.alpha, '\nendstream']);
              smask = ` /SMask ${sid} 0 R`;
            }
            imgId = add([`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${im.rgb.length} >>\nstream\n`, im.rgb, '\nendstream']);
          }
          const name = 'Im' + (xobjs.length + 1);
          xobjs.push(`/${name} ${imgId} 0 R`);
          content += `q ${pdfNum(op.w)} 0 0 ${pdfNum(op.h)} ${pdfNum(op.x)} ${pdfNum(op.y)} cm /${name} Do Q\n`;
        } else if (op.type === 'text') {
          const c = op.color || [0.11, 0.13, 0.19];
          content += `BT /${op.bold ? 'F2' : 'F1'} ${pdfNum(op.size || 10)} Tf ${c.map(pdfNum).join(' ')} rg ${pdfNum(op.x)} ${pdfNum(op.y)} Td ${pdfStr(op.text)} Tj ET\n`;
        } else if (op.type === 'rect') {
          content += 'q ';
          if (op.fill) content += `${op.fill.map(pdfNum).join(' ')} rg `;
          if (op.stroke) content += `${op.stroke.map(pdfNum).join(' ')} RG ${pdfNum(op.lw || 1)} w `;
          if (op.dash) content += `[${op.dash.map(pdfNum).join(' ')}] 0 d `;
          content += `${pdfNum(op.x)} ${pdfNum(op.y)} ${pdfNum(op.w)} ${pdfNum(op.h)} re ${op.fill && op.stroke ? 'B' : op.fill ? 'f' : 'S'} Q\n`;
        }
      }
      const cbytes = latin1(content);
      const contentId = add([`<< /Length ${cbytes.length} >>\nstream\n`, cbytes, '\nendstream']);
      kids.push(add([`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pdfNum(pg.w)} ${pdfNum(pg.h)}] /Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> /XObject << ${xobjs.join(' ')} >> >> /Contents ${contentId} 0 R >>`]));
    }
    objs[catalogId - 1] = [`<< /Type /Catalog /Pages ${pagesId} 0 R >>`];
    objs[pagesId - 1] = [`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`];
    const infoId = add([`<< /Producer ${pdfStr('tshirt-designer ' + VERSION)} /Title ${pdfStr(info.title || 'T-shirt design')} /CreationDate ${pdfStr(pdfDate())} >>`]);

    const chunks = [];
    const offsets = [];
    let offset = 0;
    const push = (part) => { const b = typeof part === 'string' ? latin1(part) : part; chunks.push(b); offset += b.length; };
    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    objs.forEach((parts, i) => {
      offsets.push(offset);
      push(`${i + 1} 0 obj\n`);
      parts.forEach(push);
      push('\nendobj\n');
    });
    const xref = offset;
    let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) x += String(o).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  /* ---------- ZIP (stored entries — the contents are already compressed) ---------- */

  async function buildZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const data = f.bytes || new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  function downloadBlob(blob, filename, container) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    (container || document.body).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- autosave storage (IndexedDB) ---------- */

  const idb = {
    _db: null,
    open() {
      if (this._db) return this._db;
      this._db = new Promise((resolve, reject) => {
        if (!global.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
        const req = global.indexedDB.open('tshirt-designer', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('designs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB is blocked'));
      });
      this._db.catch(() => { this._db = null; });
      return this._db;
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('designs', mode);
        const req = fn(tx.objectStore('designs'));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    get(key) { return this.run('readonly', (s) => s.get(key)); },
    set(key, value) { return this.run('readwrite', (s) => s.put(value, key)); },
    del(key) { return this.run('readwrite', (s) => s.delete(key)); },
  };

  /* ===================================================================== *
   * 8. Styles (Shadow DOM). Theme with CSS custom properties on the host:
   *    tshirt-designer { --tsd-accent: #e11d48; --tsd-font: Inter, sans-serif; }
   * ===================================================================== */

  const DARK_TOKENS = `
    --tsd-accent: #8f89ff; --tsd-accent-hover: #a6a1ff; --tsd-accent-soft: rgba(143,137,255,.16); --tsd-on-accent: #0d0f14;
    --tsd-bg: #121418; --tsd-surface: #1a1d23; --tsd-surface-2: #22262e; --tsd-surface-3: #2c3139;
    --tsd-border: #2d323b; --tsd-border-strong: #3c424d; --tsd-text: #e8eaef; --tsd-muted: #9aa3b2;
    --tsd-stage: #0e1013; --tsd-danger: #f97066; --tsd-warn: #fdb022; --tsd-ok: #47cd89;
    --tsd-chk-a: #2a2e36; --tsd-chk-b: #1f2329;
    --tsd-shadow: 0 1px 2px rgba(0,0,0,.4), 0 4px 14px rgba(0,0,0,.35);
    --tsd-shadow-lg: 0 16px 40px rgba(0,0,0,.55);
    color-scheme: dark;`;

  const STYLES = `
  :host {
    --tsd-accent: #4f46e5; --tsd-accent-hover: #4338ca; --tsd-accent-soft: rgba(79,70,229,.11); --tsd-on-accent: #ffffff;
    --tsd-bg: #f5f6f8; --tsd-surface: #ffffff; --tsd-surface-2: #f3f4f7; --tsd-surface-3: #e9ebf0;
    --tsd-border: #e3e6eb; --tsd-border-strong: #cdd2da; --tsd-text: #1b2130; --tsd-muted: #667085;
    --tsd-stage: #e6e9ee; --tsd-danger: #d92d20; --tsd-warn: #b54708; --tsd-ok: #067647;
    --tsd-chk-a: #e7e9ee; --tsd-chk-b: #ffffff;
    --tsd-radius: 12px; --tsd-radius-sm: 8px;
    --tsd-shadow: 0 1px 2px rgba(16,24,40,.06), 0 4px 14px rgba(16,24,40,.09);
    --tsd-shadow-lg: 0 16px 40px rgba(16,24,40,.22);
    --tsd-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --tsd-left-w: 248px; --tsd-right-w: 300px;
    display: block; position: relative; height: 720px; min-height: 420px; min-width: 280px;
    color: var(--tsd-text); font: 13px/1.45 var(--tsd-font); text-align: left;
    -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
    border-radius: var(--tsd-radius); overflow: hidden; isolation: isolate; color-scheme: light;
  }
  :host([hidden]) { display: none; }
  :host([theme="dark"]) { ${DARK_TOKENS} }
  @media (prefers-color-scheme: dark) { :host([theme="auto"]) { ${DARK_TOKENS} } }

  *, *::before, *::after { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; color: inherit; letter-spacing: inherit; }
  button { cursor: pointer; -webkit-user-select: none; user-select: none; }
  [hidden] { display: none !important; }
  .i { display: block; flex: none; }
  .checker { background: repeating-conic-gradient(var(--tsd-chk-a) 0% 25%, var(--tsd-chk-b) 0% 50%) 50% / 14px 14px; }

  .tsd { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--tsd-bg); }

  /* ---------- toolbar ---------- */
  .toolbar { display: flex; align-items: center; gap: 4px; padding: 8px 10px; min-height: 54px; flex: none; background: var(--tsd-surface); border-bottom: 1px solid var(--tsd-border); overflow-x: auto; scrollbar-width: none; }
  .toolbar::-webkit-scrollbar { display: none; }
  .brand { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto; color: var(--tsd-accent); }
  .name-input { width: 200px; min-width: 70px; height: 34px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--tsd-radius-sm); background: transparent; color: var(--tsd-text); font-weight: 600; font-size: 14px; text-overflow: ellipsis; }
  .name-input:hover { border-color: var(--tsd-border); }
  .name-input:focus { outline: none; border-color: var(--tsd-accent); background: var(--tsd-surface); box-shadow: 0 0 0 3px var(--tsd-accent-soft); }
  .tb-sep { width: 1px; height: 22px; margin: 0 6px; background: var(--tsd-border); flex: none; }
  .tb-group { display: flex; align-items: center; gap: 2px; flex: none; }
  .spacer { flex: 1 1 auto; min-width: 8px; }

  /* ---------- buttons ---------- */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: var(--tsd-radius-sm); border: 1px solid var(--tsd-border); background: var(--tsd-surface); color: var(--tsd-text); font-weight: 550; font-size: 13px; white-space: nowrap; flex: none; transition: background .12s, border-color .12s, color .12s, box-shadow .12s; }
  .btn:hover { background: var(--tsd-surface-2); border-color: var(--tsd-border-strong); }
  .btn:active { transform: translateY(.5px); }
  .btn.primary { background: var(--tsd-accent); border-color: var(--tsd-accent); color: var(--tsd-on-accent); }
  .btn.primary:hover { background: var(--tsd-accent-hover); border-color: var(--tsd-accent-hover); }
  .btn.danger { color: var(--tsd-danger); }
  .btn.sm { height: 30px; padding: 0 10px; font-size: 12.5px; gap: 5px; }
  .btn.block { width: 100%; }
  .btn[aria-pressed="true"] { background: var(--tsd-accent-soft); border-color: color-mix(in srgb, var(--tsd-accent) 40%, transparent); color: var(--tsd-accent); }
  .ib { width: 34px; height: 34px; display: inline-grid; place-items: center; padding: 0; border-radius: var(--tsd-radius-sm); border: 1px solid transparent; background: transparent; color: var(--tsd-text); flex: none; transition: background .12s, color .12s; }
  .ib:hover { background: var(--tsd-surface-2); }
  .ib.sm { width: 28px; height: 28px; border-radius: 7px; }
  .ib.danger:hover { color: var(--tsd-danger); }
  .ib[aria-pressed="true"] { background: var(--tsd-accent-soft); color: var(--tsd-accent); }
  .btn:disabled, .ib:disabled { opacity: .4; pointer-events: none; }
  .btn:focus-visible, .ib:focus-visible, .seg button:focus-visible, .sw:focus-visible, .lib-item:focus-visible, .side-btn:focus-visible, .fmt:focus-visible, .tabs button:focus-visible, .dropzone:focus-visible, .zoom-label:focus-visible, .layer:focus-visible { outline: 2px solid var(--tsd-accent); outline-offset: 2px; }

  /* ---------- layout ---------- */
  .body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: var(--tsd-left-w) minmax(0, 1fr) var(--tsd-right-w); }
  .left, .right { min-height: 0; overflow-y: auto; background: var(--tsd-surface); scrollbar-width: thin; }
  .left { grid-column: 1; grid-row: 1; border-right: 1px solid var(--tsd-border); }
  .right { grid-column: 3; grid-row: 1; border-left: 1px solid var(--tsd-border); }
  .tabs { display: none; }

  .panel { padding: 14px 14px 18px; border-bottom: 1px solid var(--tsd-border); }
  .panel:last-child { border-bottom: 0; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 10px; min-height: 30px; }
  .panel-head h3 { margin: 0; font-size: 11.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--tsd-muted); }
  .sub { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 16px 0 8px; font-size: 12px; font-weight: 650; color: var(--tsd-text); }
  .sub small { font-weight: 500; color: var(--tsd-muted); }
  .hint { margin: 10px 0 0; color: var(--tsd-muted); font-size: 12px; }
  .stack { display: grid; gap: 10px; }

  /* ---------- library ---------- */
  .lib { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 8px; }
  .lib:empty { display: none; }
  .lib-item { position: relative; aspect-ratio: 1; border-radius: var(--tsd-radius-sm); border: 1px solid var(--tsd-border); overflow: hidden; cursor: grab; touch-action: none; -webkit-user-select: none; user-select: none; transition: border-color .12s, box-shadow .12s; }
  .lib-item:hover { border-color: var(--tsd-accent); box-shadow: 0 0 0 3px var(--tsd-accent-soft); }
  .lib-item img { width: 100%; height: 100%; object-fit: contain; padding: 7px; pointer-events: none; display: block; }
  .lib-item .uses { position: absolute; left: 5px; bottom: 5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--tsd-accent); color: var(--tsd-on-accent); font-size: 10.5px; font-weight: 700; display: grid; place-items: center; pointer-events: none; }
  .lib-del { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0; border-radius: 6px; border: 0; background: rgba(17,19,24,.72); color: #fff; display: grid; place-items: center; opacity: 0; transition: opacity .12s; }
  .lib-item:hover .lib-del, .lib-item:focus-within .lib-del { opacity: 1; }
  @media (hover: none) { .lib-del { opacity: 1; } }
  .dropzone { display: grid; justify-items: center; gap: 4px; margin-top: 10px; padding: 18px 12px; border: 1.5px dashed var(--tsd-border-strong); border-radius: var(--tsd-radius-sm); background: var(--tsd-surface-2); color: var(--tsd-muted); text-align: center; cursor: pointer; transition: border-color .12s, color .12s, background .12s; }
  .dropzone b { color: var(--tsd-text); font-weight: 600; }
  .dropzone span { font-size: 11.5px; }
  .dropzone:hover, .p-images.drop-target .dropzone { border-color: var(--tsd-accent); color: var(--tsd-accent); background: var(--tsd-accent-soft); }
  .lib:not(:empty) + .dropzone { padding: 10px; grid-auto-flow: column; justify-content: center; align-items: center; gap: 8px; }
  .lib:not(:empty) + .dropzone span { display: none; }
  .samples-btn { margin-top: 8px; width: 100%; }

  /* ---------- layers ---------- */
  .layers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .layer { display: flex; align-items: center; gap: 7px; padding: 4px 4px 4px 2px; border-radius: var(--tsd-radius-sm); border: 1px solid transparent; cursor: pointer; -webkit-user-select: none; user-select: none; }
  .layer:hover { background: var(--tsd-surface-2); }
  .layer.sel { background: var(--tsd-accent-soft); border-color: color-mix(in srgb, var(--tsd-accent) 35%, transparent); }
  .layer .grip { width: 18px; height: 28px; display: grid; place-items: center; color: var(--tsd-muted); cursor: grab; touch-action: none; flex: none; }
  .layer .lthumb { position: relative; flex: none; display: block; }
  .layer img { width: 34px; height: 34px; object-fit: contain; border-radius: 6px; border: 1px solid var(--tsd-border); padding: 2px; display: block; }
  .layer .lname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
  .layer.is-hidden .lname, .layer.is-hidden .lthumb { opacity: .4; }
  .layer .lwarn { position: absolute; right: -5px; bottom: -4px; width: 15px; height: 15px; border-radius: 50%; display: grid; place-items: center; background: var(--tsd-warn); color: #fff; font-size: 10px; font-weight: 800; line-height: 1; box-shadow: 0 0 0 2px var(--tsd-surface); cursor: help; }
  .layer .ib.sm { width: 26px; height: 26px; }
  .layer.dragging { opacity: .45; }
  .drop-line { height: 2px; margin: -2.5px 4px; border-radius: 2px; background: var(--tsd-accent); list-style: none; }
  .layers-empty { margin: 0; }

  /* ---------- stage ---------- */
  .stage-wrap { grid-column: 2; grid-row: 1; position: relative; min-width: 0; min-height: 0; background: var(--tsd-stage); overflow: hidden; }
  .stage { position: absolute; inset: 0; touch-action: none; outline: none; -webkit-user-select: none; user-select: none; overflow: hidden; }
  .stage:focus-visible { box-shadow: inset 0 0 0 2px var(--tsd-accent); }
  .stage canvas.cv { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }
  .stage.drop-target::after { content: ""; position: absolute; inset: 10px; border: 2px dashed var(--tsd-accent); border-radius: 16px; background: var(--tsd-accent-soft); pointer-events: none; }
  .stage.panning, .stage.space { cursor: grab; }
  .stage.panning:active { cursor: grabbing; }
  .tsd.picking .stage { cursor: crosshair; }
  .overlay { position: absolute; inset: 0; pointer-events: none; }
  .box { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
  .hover-box { outline: 1.5px solid color-mix(in srgb, var(--tsd-accent) 60%, transparent); }
  .sel-box { outline: 1.5px solid var(--tsd-accent); box-shadow: 0 0 0 1px rgba(255,255,255,.55), inset 0 0 0 1px rgba(255,255,255,.35); }
  .sel-box.locked { outline-style: dashed; }
  .h { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: #fff; border: 1.5px solid var(--tsd-accent); border-radius: 3px; pointer-events: auto; touch-action: none; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
  .h::before { content: ""; position: absolute; inset: -9px; }
  .h[data-h="nw"] { left: 0; top: 0; } .h[data-h="n"] { left: 50%; top: 0; } .h[data-h="ne"] { left: 100%; top: 0; }
  .h[data-h="e"] { left: 100%; top: 50%; } .h[data-h="se"] { left: 100%; top: 100%; } .h[data-h="s"] { left: 50%; top: 100%; }
  .h[data-h="sw"] { left: 0; top: 100%; } .h[data-h="w"] { left: 0; top: 50%; }
  .h.edge[data-h="n"], .h.edge[data-h="s"] { width: 20px; height: 7px; margin: -3.5px 0 0 -10px; border-radius: 4px; }
  .h.edge[data-h="e"], .h.edge[data-h="w"] { width: 7px; height: 20px; margin: -10px 0 0 -3.5px; border-radius: 4px; }
  .h.rot { left: 50%; top: -30px; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 50%; display: grid; place-items: center; color: var(--tsd-accent); cursor: grab; }
  .h.rot:active { cursor: grabbing; }
  .rot-stem { position: absolute; left: 50%; top: -18px; height: 18px; border-left: 1.5px solid var(--tsd-accent); }
  .sel-box.no-edges .h.edge, .sel-box.locked .h, .sel-box.locked .rot-stem, .tsd.readonly .sel-box .h, .tsd.readonly .rot-stem { display: none; }
  .quickbar { position: absolute; left: 0; top: 0; display: flex; gap: 2px; padding: 3px; background: var(--tsd-surface); border: 1px solid var(--tsd-border); border-radius: 11px; box-shadow: var(--tsd-shadow); pointer-events: auto; white-space: nowrap; }
  .quickbar .ib { width: 30px; height: 30px; }
  .quickbar .ib.danger { color: var(--tsd-danger); }
  .measure { position: absolute; left: 0; top: 0; padding: 3px 8px; border-radius: 6px; background: rgba(17,19,24,.86); color: #fff; font-size: 11.5px; font-weight: 600; white-space: nowrap; pointer-events: none; font-variant-numeric: tabular-nums; }
  .empty-hint { position: absolute; left: 0; top: 0; display: grid; place-content: center; justify-items: center; gap: 4px; text-align: center; padding: 10px; pointer-events: auto; cursor: pointer; font-weight: 600; font-size: 13px; border-radius: 8px; transition: background .15s; }
  .empty-hint small { font-weight: 500; font-size: 11.5px; opacity: .8; }
  .empty-hint:hover { background: rgba(127,127,127,.08); }
  .empty-hint.tiny span, .empty-hint.tiny small { display: none; }

  .sides { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 3; display: flex; gap: 3px; padding: 3px; background: var(--tsd-surface); border: 1px solid var(--tsd-border); border-radius: 14px; box-shadow: var(--tsd-shadow); }
  .side-btn { display: flex; align-items: center; gap: 8px; padding: 3px 12px 3px 3px; border: 1px solid transparent; border-radius: 11px; background: transparent; color: var(--tsd-text); }
  .side-btn:hover { background: var(--tsd-surface-2); }
  .side-btn canvas { width: 40px; height: 40px; border-radius: 8px; display: block; background: var(--tsd-surface-2); }
  .side-btn .lbl { display: flex; flex-direction: column; line-height: 1.2; text-align: left; }
  .side-btn .lbl b { font-size: 12.5px; font-weight: 650; }
  .side-btn .lbl small { font-size: 11px; color: var(--tsd-muted); white-space: nowrap; }
  .side-btn[aria-selected="true"] { background: var(--tsd-accent-soft); border-color: color-mix(in srgb, var(--tsd-accent) 35%, transparent); }
  .zoombar { position: absolute; right: 12px; bottom: 12px; z-index: 3; display: flex; align-items: center; gap: 1px; padding: 3px; background: var(--tsd-surface); border: 1px solid var(--tsd-border); border-radius: 12px; box-shadow: var(--tsd-shadow); }
  .zoom-label { min-width: 50px; height: 28px; padding: 0 4px; border: 0; border-radius: 7px; background: transparent; font-weight: 650; font-size: 12px; font-variant-numeric: tabular-nums; }
  .zoom-label:hover { background: var(--tsd-surface-2); }
  .pick-hint { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); z-index: 4; display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 12px; background: var(--tsd-surface); border: 1px solid var(--tsd-border); border-radius: 10px; box-shadow: var(--tsd-shadow); font-size: 12.5px; white-space: nowrap; }

  /* ---------- forms ---------- */
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field > span, .lbl-row { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; font-size: 11.5px; font-weight: 550; color: var(--tsd-muted); }
  .field > span em { font-style: normal; font-weight: 450; opacity: .85; }
  .field output { font-variant-numeric: tabular-nums; color: var(--tsd-text); font-weight: 600; }
  .inp { width: 100%; height: 32px; min-width: 0; padding: 0 9px; border-radius: var(--tsd-radius-sm); border: 1px solid var(--tsd-border); background: var(--tsd-surface); color: var(--tsd-text); font-size: 13px; font-variant-numeric: tabular-nums; }
  .inp:hover { border-color: var(--tsd-border-strong); }
  .inp:focus { outline: none; border-color: var(--tsd-accent); box-shadow: 0 0 0 3px var(--tsd-accent-soft); }
  select.inp { padding-right: 6px; cursor: pointer; }
  .unit-inp { position: relative; }
  .unit-inp .inp { padding-right: 26px; }
  .unit-inp .u { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-style: normal; font-size: 11.5px; color: var(--tsd-muted); pointer-events: none; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .row.wrap { flex-wrap: wrap; }
  .btn-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .btn-row.tools { gap: 2px; padding: 3px; border: 1px solid var(--tsd-border); border-radius: 10px; background: var(--tsd-surface-2); justify-content: space-between; }
  .btn-row.tools .ib { width: 30px; height: 30px; }
  .btn-row.tools .ib:hover { background: var(--tsd-surface); }
  .btn-row .btn { flex: 1 1 auto; }
  .seg { display: flex; width: 100%; padding: 3px; gap: 2px; background: var(--tsd-surface-2); border: 1px solid var(--tsd-border); border-radius: 10px; }
  .seg button { flex: 1 1 0; min-width: 0; height: 28px; padding: 0 6px; border: 0; border-radius: 7px; background: transparent; color: var(--tsd-muted); font-weight: 550; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .seg button:hover { color: var(--tsd-text); }
  .seg button[aria-pressed="true"] { background: var(--tsd-surface); color: var(--tsd-text); box-shadow: 0 1px 2px rgba(16,24,40,.14); }
  input[type="range"] { width: 100%; height: 22px; margin: 0; accent-color: var(--tsd-accent); cursor: pointer; background: transparent; }
  .range-row { display: grid; grid-template-columns: 1fr 74px; gap: 10px; align-items: center; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 26px; font-size: 12.5px; cursor: pointer; -webkit-user-select: none; user-select: none; }
  .check input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--tsd-accent); flex: none; cursor: pointer; }
  input[type="color"] { width: 34px; height: 32px; padding: 3px; border: 1px solid var(--tsd-border); border-radius: var(--tsd-radius-sm); background: var(--tsd-surface); cursor: pointer; flex: none; }
  input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
  input[type="color"]::-webkit-color-swatch { border: 0; border-radius: 5px; }
  input[type="color"]::-moz-color-swatch { border: 0; border-radius: 5px; }
  .check input[type="color"] { width: 30px; height: 26px; margin-left: auto; }
  .color-row { display: grid; grid-template-columns: 34px 1fr; gap: 8px; align-items: center; }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(26px, 1fr)); gap: 7px; }
  .sw { aspect-ratio: 1; min-width: 0; padding: 0; border-radius: 50%; border: 1px solid rgba(0,0,0,.14); background: var(--c); transition: transform .1s, box-shadow .12s; }
  .sw:hover { transform: scale(1.08); }
  .sw[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--tsd-surface), 0 0 0 4px var(--tsd-accent); }
  .callout { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; border-radius: 10px; background: var(--tsd-accent-soft); font-size: 12px; line-height: 1.4; }
  .callout .i { margin-top: 1px; color: var(--tsd-accent); }
  .callout .grow { flex: 1 1 auto; }
  .callout .chip { display: inline-block; width: 11px; height: 11px; border-radius: 3px; border: 1px solid rgba(0,0,0,.2); vertical-align: -1px; margin: 0 2px; }
  .card { padding: 10px 11px; border: 1px solid var(--tsd-border); border-radius: 10px; background: var(--tsd-surface-2); display: grid; gap: 5px; font-size: 12px; }
  .stat { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .stat span:first-child { color: var(--tsd-muted); }
  .stat b { font-weight: 650; font-variant-numeric: tabular-nums; }
  .stat .ok { color: var(--tsd-ok); } .stat .meh { color: var(--tsd-warn); } .stat .bad { color: var(--tsd-danger); }
  .warnline { display: flex; gap: 6px; align-items: flex-start; color: var(--tsd-warn); font-size: 11.5px; }
  .empty-sel { display: grid; justify-items: center; gap: 8px; padding: 14px 8px 6px; text-align: center; color: var(--tsd-muted); font-size: 12.5px; }
  .empty-sel .i { opacity: .6; }
  .bg-remove { display: grid; gap: 10px; padding: 10px; margin-top: 8px; border: 1px solid var(--tsd-border); border-radius: 10px; }

  /* ---------- toasts, busy, ghost, file drop ---------- */
  .toasts { position: absolute; left: 50%; top: 66px; transform: translateX(-50%); z-index: 40; display: flex; flex-direction: column; align-items: center; gap: 8px; width: max-content; max-width: calc(100% - 24px); pointer-events: none; }
  .toast { display: flex; align-items: center; gap: 10px; max-width: 100%; padding: 9px 12px; border-radius: 10px; background: #1d2230; color: #fff; box-shadow: var(--tsd-shadow-lg); font-size: 12.5px; pointer-events: auto; animation: tsd-in .18s ease-out; transition: opacity .2s, transform .2s; }
  .toast.error { background: #b42318; }
  .toast.ok { background: #075e3c; }
  .toast.out { opacity: 0; transform: translateY(-6px); }
  .toast button { flex: none; padding: 3px 9px; border: 0; border-radius: 6px; background: rgba(255,255,255,.16); color: #fff; font-weight: 650; font-size: 12px; }
  .toast button:hover { background: rgba(255,255,255,.26); }
  @keyframes tsd-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .busy { position: absolute; left: 50%; top: 66px; transform: translateX(-50%); z-index: 41; display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-radius: 10px; background: var(--tsd-surface); border: 1px solid var(--tsd-border); box-shadow: var(--tsd-shadow-lg); font-weight: 600; font-size: 12.5px; }
  .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--tsd-accent-soft); border-top-color: var(--tsd-accent); animation: tsd-spin .7s linear infinite; }
  @keyframes tsd-spin { to { transform: rotate(360deg); } }
  .ghost { position: absolute; left: 0; top: 0; z-index: 50; width: 76px; height: 76px; padding: 6px; margin: -38px 0 0 -38px; border-radius: 12px; background: var(--tsd-surface); box-shadow: var(--tsd-shadow-lg); pointer-events: none; opacity: .92; transition: opacity .12s; }
  .ghost img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .ghost.over { opacity: 0; }
  .p-images.drop-target { background: var(--tsd-accent-soft); }

  /* ---------- dialogs ---------- */
  dialog.dlg { width: min(540px, calc(100vw - 24px)); max-height: calc(100vh - 24px); padding: 0; border: 0; border-radius: 16px; background: var(--tsd-surface); color: var(--tsd-text); box-shadow: var(--tsd-shadow-lg); font: 13px/1.45 var(--tsd-font); overflow: hidden; }
  dialog.dlg::backdrop { background: rgba(10,12,16,.48); }
  .dlg form { display: flex; flex-direction: column; max-height: calc(100vh - 24px); margin: 0; }
  .dlg-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 18px 8px; }
  .dlg-head h2 { margin: 0; font-size: 16px; font-weight: 700; }
  .dlg-body { display: grid; gap: 14px; padding: 6px 18px 6px; overflow-y: auto; }
  .dlg-foot { display: flex; align-items: center; gap: 8px; padding: 14px 18px 18px; }
  .fmt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .fmt { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 9px 11px; border: 1px solid var(--tsd-border); border-radius: 10px; background: var(--tsd-surface); text-align: left; transition: border-color .12s, box-shadow .12s; }
  .fmt:hover { border-color: var(--tsd-border-strong); }
  .fmt b { font-size: 13px; font-weight: 700; }
  .fmt small { font-size: 11px; line-height: 1.3; color: var(--tsd-muted); }
  .fmt[aria-pressed="true"] { border-color: var(--tsd-accent); box-shadow: 0 0 0 3px var(--tsd-accent-soft); }
  .ex-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; align-items: center; }
  .ex-row > span { font-size: 12px; font-weight: 600; color: var(--tsd-muted); }
  .ex-note { margin: 0; padding: 9px 11px; border-radius: 10px; background: var(--tsd-surface-2); color: var(--tsd-muted); font-size: 12px; }
  .keys { display: grid; grid-template-columns: 1fr auto; gap: 8px 14px; margin: 0; font-size: 12.5px; }
  .keys dt { color: var(--tsd-muted); }
  .keys dd { margin: 0; text-align: right; }
  kbd { display: inline-block; min-width: 20px; padding: 1px 6px; border: 1px solid var(--tsd-border-strong); border-bottom-width: 2px; border-radius: 5px; background: var(--tsd-surface-2); font: 600 11px/1.5 var(--tsd-font); text-align: center; }

  /* ---------- optional UI parts (hide="..." attribute) and read-only ---------- */
  .tsd.hide-toolbar .toolbar, .tsd.hide-export .g-export, .tsd.hide-file .g-file, .tsd.hide-history .g-history,
  .tsd.hide-sides .sides, .tsd.hide-zoom .zoombar, .tsd.hide-name .brand, .tsd.hide-help .g-help, .tsd.hide-guides .g-view,
  .tsd.hide-library .p-images, .tsd.hide-layers .p-layers, .tsd.hide-properties .p-edit, .tsd.hide-shirt .p-shirt,
  .tsd.hide-library .tab-images, .tsd.hide-layers .tab-layers, .tsd.hide-properties .tab-edit, .tsd.hide-shirt .tab-shirt { display: none !important; }
  .tsd.no-left .body { --tsd-left-w: 0px; } .tsd.no-left .left { display: none !important; }
  .tsd.no-right .body { --tsd-right-w: 0px; } .tsd.no-right .right { display: none !important; }
  .tsd.readonly .g-history, .tsd.readonly .g-file, .tsd.readonly .quickbar, .tsd.readonly .empty-hint { display: none !important; }

  /* ---------- responsive: the layout follows the size of the component itself ----------
   * data-layout = wide (3 columns) | medium (stage + tabbed sidebar) | stacked (phone)
   * data-w      = l | m | s | xs  (width classes for the toolbar and floating controls)   */
  .tsd[data-w="m"] .body { --tsd-left-w: 216px; --tsd-right-w: 272px; }
  .tsd[data-w="m"] .name-input { width: 150px; }
  .tsd[data-layout="medium"] .left, .tsd[data-layout="medium"] .right,
  .tsd[data-layout="stacked"] .left, .tsd[data-layout="stacked"] .right { display: contents; }
  .tsd[data-layout="medium"] .body { grid-template-columns: minmax(0, 1fr) 304px; grid-template-rows: auto minmax(0, 1fr); }
  .tsd[data-layout="medium"] .stage-wrap { grid-column: 1; grid-row: 1 / span 2; }
  .tsd[data-layout="medium"] .tabs { grid-column: 2; grid-row: 1; border-left: 1px solid var(--tsd-border); }
  .tsd[data-layout="medium"] .panel { grid-column: 2; grid-row: 2; border-left: 1px solid var(--tsd-border); }
  .tsd[data-layout="stacked"] .body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(240px, 1.45fr) auto minmax(0, 1fr); }
  .tsd[data-layout="stacked"] .stage-wrap { grid-column: 1; grid-row: 1; }
  .tsd[data-layout="stacked"] .tabs { grid-column: 1; grid-row: 2; border-top: 1px solid var(--tsd-border); }
  .tsd[data-layout="stacked"] .panel { grid-column: 1; grid-row: 3; }
  .tsd[data-layout="medium"] .tabs, .tsd[data-layout="stacked"] .tabs { display: flex; gap: 2px; padding: 4px; background: var(--tsd-surface); border-bottom: 1px solid var(--tsd-border); overflow-x: auto; scrollbar-width: none; }
  .tabs button { position: relative; flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 5px; height: 36px; padding: 0 4px; border: 0; border-radius: 8px; background: transparent; color: var(--tsd-muted); font-weight: 650; font-size: 12.5px; white-space: nowrap; }
  .tabs button:hover { color: var(--tsd-text); }
  .tabs button[aria-selected="true"] { background: var(--tsd-accent-soft); color: var(--tsd-accent); }
  .tabs button .dot { flex: none; align-self: flex-start; width: 7px; height: 7px; margin: 7px 0 0 -2px; border-radius: 50%; background: var(--tsd-accent); }
  .tsd[data-layout="medium"] .panel, .tsd[data-layout="stacked"] .panel { display: none; min-height: 0; overflow-y: auto; border-bottom: 0; background: var(--tsd-surface); }
  .tsd[data-layout][data-tab="images"] .p-images, .tsd[data-layout][data-tab="layers"] .p-layers,
  .tsd[data-layout][data-tab="edit"] .p-edit, .tsd[data-layout][data-tab="shirt"] .p-shirt { display: block; }
  .tsd.no-left.no-right .body { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: minmax(0, 1fr) !important; }
  .tsd.no-left.no-right .stage-wrap { grid-column: 1 !important; grid-row: 1 !important; }
  .tsd.no-left.no-right .tabs { display: none !important; }
  .tsd[data-w="s"] .tb-label, .tsd[data-w="xs"] .tb-label { display: none; }
  .tsd[data-w="s"] .name-input { width: 120px; }
  .tsd[data-w="xs"] .toolbar { padding: 6px; gap: 1px; }
  .tsd[data-w="xs"] .brand, .tsd[data-w="xs"] .tb-sep { display: none; }
  .tsd[data-w="xs"] .toolbar .ib { width: 32px; height: 32px; }
  .tsd[data-w="xs"] .side-btn { padding: 3px 8px 3px 3px; gap: 6px; }
  .tsd[data-w="xs"] .side-btn canvas { width: 34px; height: 34px; }
  .tsd[data-w="xs"] .side-btn .lbl small { display: none; }
  .tsd[data-w="xs"] .sides { left: 10px; transform: none; bottom: 10px; }
  .tsd[data-w="xs"] .zoombar { right: 10px; bottom: 10px; }
  .tsd[data-w="xs"] .zoom-label { display: none; }
  .tsd[data-w="xs"] .tabs button .i { display: none; }
  .tsd[data-w="xs"] .fmt-grid { grid-template-columns: repeat(2, 1fr); }
  .tsd[data-w="xs"] .lib-del { width: 20px; height: 20px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `;

  /* ===================================================================== *
   * 9. Markup
   * ===================================================================== */

  const MOD = /Mac|iPhone|iPad/.test((global.navigator && (global.navigator.platform || global.navigator.userAgent)) || '') ? '⌘' : 'Ctrl';
  const unitInput = (prop, unitClass, step) =>
    `<div class="unit-inp"><input class="inp" type="number" step="${step}" data-prop="${prop}" inputmode="decimal"><i class="u ${unitClass}">in</i></div>`;

  const MARKUP = `
  <div class="tsd" part="base" data-tab="images" data-layout="wide" data-w="l">
    <header class="toolbar" part="toolbar">
      <div class="brand">${icon('shirt', 20)}<input class="name-input" type="text" value="Untitled design" aria-label="Design name" spellcheck="false" maxlength="80"></div>
      <span class="tb-sep g-history"></span>
      <div class="tb-group g-history">
        <button class="ib" type="button" data-act="undo" title="Undo (${MOD}+Z)" aria-label="Undo">${icon('undo')}</button>
        <button class="ib" type="button" data-act="redo" title="Redo (${MOD}+Shift+Z)" aria-label="Redo">${icon('redo')}</button>
      </div>
      <span class="tb-sep g-view"></span>
      <div class="tb-group g-view">
        <button class="ib" type="button" data-act="toggle-guides" aria-pressed="true" title="Show print area guide" aria-label="Show print area guide">${icon('guides')}</button>
        <button class="ib" type="button" data-act="toggle-clip" aria-pressed="false" title="Clip artwork to the print area" aria-label="Clip artwork to the print area">${icon('clip')}</button>
      </div>
      <div class="spacer"></div>
      <div class="tb-group g-file">
        <button class="ib" type="button" data-act="new" title="New design" aria-label="New design">${icon('newDoc')}</button>
        <button class="ib" type="button" data-act="open" title="Open a saved design (.json)" aria-label="Open design">${icon('open')}</button>
        <button class="ib" type="button" data-act="save" title="Save design file (.json) — ${MOD}+S" aria-label="Save design">${icon('save')}</button>
      </div>
      <button class="btn primary g-export" type="button" data-act="export" title="Export (${MOD}+E)">${icon('download', 17)}<span class="tb-label">Export</span></button>
      <button class="ib g-help" type="button" data-act="help" title="Help &amp; shortcuts" aria-label="Help and keyboard shortcuts">${icon('help')}</button>
    </header>

    <div class="body">
      <aside class="left" part="sidebar-left">
        <section class="panel p-images" data-tab="images" aria-label="Image library">
          <div class="panel-head"><h3>Images</h3><button class="btn sm" type="button" data-act="add-images">${icon('plus', 15)}Add</button></div>
          <div class="lib" role="list"></div>
          <div class="dropzone" data-act="add-images" role="button" tabindex="0" aria-label="Add images">${icon('upload', 22)}<b>Add images</b><span>PNG, JPG, SVG, WebP, GIF<br>Drop files here or paste (${MOD}+V)</span></div>
          <button class="btn sm samples-btn" type="button" data-act="load-samples" hidden>${icon('sparkle', 15)}Try sample images</button>
          <p class="hint lib-hint" hidden>Drag an image onto the shirt, or click it to place it in the print area.</p>
        </section>
        <section class="panel p-layers" data-tab="layers" aria-label="Layers">
          <div class="panel-head"><h3>Layers · <span class="side-name">Front</span></h3><span class="hint layer-count" style="margin:0"></span></div>
          <ul class="layers" role="listbox" aria-label="Images on this side"></ul>
          <p class="hint layers-empty">No images on this side yet.</p>
        </section>
      </aside>

      <main class="stage-wrap" part="stage">
        <div class="stage" tabindex="0" role="application" aria-roledescription="design canvas" aria-label="T-shirt design canvas. Arrow keys move the selected image, Delete removes it.">
          <canvas class="cv"></canvas>
          <div class="overlay">
            <div class="empty-hint" data-act="add-images" hidden>${icon('image', 26)}<span>Drag images here</span><small>or click to add</small></div>
            <div class="box hover-box" hidden></div>
            <div class="box sel-box" hidden>
              <span class="rot-stem"></span>
              <span class="h rot" data-h="rot" title="Rotate (Shift snaps to 15°)">${icon('rotR', 13)}</span>
              <span class="h corner" data-h="nw"></span><span class="h edge" data-h="n"></span><span class="h corner" data-h="ne"></span>
              <span class="h edge" data-h="e"></span><span class="h corner" data-h="se"></span><span class="h edge" data-h="s"></span>
              <span class="h corner" data-h="sw"></span><span class="h edge" data-h="w"></span>
            </div>
            <div class="quickbar" hidden role="toolbar" aria-label="Selected image">
              <button class="ib" type="button" data-act="dup" title="Duplicate (${MOD}+D)" aria-label="Duplicate">${icon('copy', 16)}</button>
              <button class="ib" type="button" data-act="forward" title="Bring forward ( ] )" aria-label="Bring forward">${icon('forward', 16)}</button>
              <button class="ib" type="button" data-act="backward" title="Send backward ( [ )" aria-label="Send backward">${icon('backward', 16)}</button>
              <button class="ib qb-side" type="button" data-act="copy-side" title="Copy to the back" aria-label="Copy to the other side">${icon('swap', 16)}</button>
              <button class="ib danger" type="button" data-act="delete" title="Delete (Del)" aria-label="Delete">${icon('trash', 16)}</button>
            </div>
            <div class="measure" hidden></div>
          </div>
        </div>
        <div class="sides" role="tablist" aria-label="Shirt side">
          <button class="side-btn" type="button" role="tab" data-act="side" data-side="front" aria-selected="true"><canvas width="88" height="88"></canvas><span class="lbl"><b>Front</b><small class="cnt">Empty</small></span></button>
          <button class="side-btn" type="button" role="tab" data-act="side" data-side="back" aria-selected="false"><canvas width="88" height="88"></canvas><span class="lbl"><b>Back</b><small class="cnt">Empty</small></span></button>
        </div>
        <div class="zoombar">
          <button class="ib sm" type="button" data-act="zoom-out" title="Zoom out (−)" aria-label="Zoom out">${icon('zoomOut', 16)}</button>
          <button class="zoom-label" type="button" data-act="zoom-fit" title="Fit to view (0)">100%</button>
          <button class="ib sm" type="button" data-act="zoom-in" title="Zoom in (+)" aria-label="Zoom in">${icon('zoomIn', 16)}</button>
        </div>
        <div class="pick-hint" hidden>${icon('eyedropper', 16)}<span>Click the background of the selected image</span><button class="btn sm" type="button" data-act="pick-cancel">Cancel</button></div>
      </main>

      <aside class="right" part="sidebar-right">
        <section class="panel p-edit" data-tab="edit" aria-label="Selected image">
          <div class="panel-head"><h3>Selected image</h3>
            <div class="row sel-head" hidden>
              <button class="ib sm" type="button" data-act="sel-vis" title="Hide" aria-label="Hide image">${icon('eye', 16)}</button>
              <button class="ib sm" type="button" data-act="sel-lock" title="Lock position" aria-label="Lock position">${icon('unlock', 16)}</button>
            </div>
          </div>
          <div class="empty-sel">${icon('sliders', 24)}<div>Select an image on the shirt to move, resize, rotate or remove its background.</div></div>
          <div class="sel-props" hidden>
            <input class="inp" type="text" data-prop="name" aria-label="Image name" maxlength="80" spellcheck="false">
            <div class="sub">Position &amp; size <small class="unit-note">inches</small></div>
            <div class="grid2">
              <label class="field"><span>X <em>from centre</em></span>${unitInput('px', 'ul', '0.05')}</label>
              <label class="field"><span>Y <em>below collar</em></span>${unitInput('py', 'ul', '0.05')}</label>
              <label class="field"><span>Width</span>${unitInput('pw', 'ul', '0.05')}</label>
              <label class="field"><span>Height</span>${unitInput('ph', 'ul', '0.05')}</label>
            </div>
            <div class="row" style="margin-top:8px">
              <button class="btn sm" type="button" data-act="lock-aspect" aria-pressed="true" title="Keep proportions when resizing">${icon('link', 15)}<span>Keep proportions</span></button>
            </div>
            <label class="field" style="margin-top:10px"><span>Rotation</span>
              <div class="range-row"><input type="range" min="-180" max="180" step="1" data-prop="rotation" aria-label="Rotation"><div class="unit-inp"><input class="inp" type="number" step="1" min="-180" max="180" data-prop="rotationNum" aria-label="Rotation in degrees"><i class="u">°</i></div></div>
            </label>
            <div class="btn-row tools" style="margin-top:10px">
              <button class="ib" type="button" data-act="center-h" title="Centre horizontally" aria-label="Centre horizontally">${icon('alignH', 17)}</button>
              <button class="ib" type="button" data-act="center-v" title="Centre in the print area" aria-label="Centre vertically in the print area">${icon('alignV', 17)}</button>
              <button class="ib" type="button" data-act="align-top" title="Align to the top of the print area" aria-label="Align to top of the print area">${icon('alignTop', 17)}</button>
              <button class="ib" type="button" data-act="fit-area" title="Fit to the print area" aria-label="Fit to the print area">${icon('fitArea', 17)}</button>
              <button class="ib" type="button" data-act="rot-l" title="Rotate 90° left" aria-label="Rotate 90 degrees left">${icon('rotL', 17)}</button>
              <button class="ib" type="button" data-act="rot-r" title="Rotate 90° right" aria-label="Rotate 90 degrees right">${icon('rotR', 17)}</button>
              <button class="ib" type="button" data-act="flip-h" title="Flip horizontally" aria-label="Flip horizontally">${icon('flipH', 17)}</button>
              <button class="ib" type="button" data-act="flip-v" title="Flip vertically" aria-label="Flip vertically">${icon('flipV', 17)}</button>
            </div>

            <div class="sub">Appearance</div>
            <div class="stack">
              <label class="field"><span>Opacity <output class="o-opacity">100%</output></span><input type="range" min="0" max="100" step="1" data-prop="opacity" aria-label="Opacity"></label>
              <label class="field"><span>Blend with shirt</span><select class="inp blend-sel" data-prop="blend" aria-label="Blend mode"></select></label>
            </div>

            <div class="sub">Image background</div>
            <div class="callout bg-callout" hidden>${icon('sparkle', 16)}<div class="grow">This image has a solid <span class="chip"></span> background.</div><button class="btn sm" type="button" data-act="bg-quick">Remove</button></div>
            <div class="seg bg-mode" role="group" aria-label="Image background" style="margin-top:8px">
              <button type="button" data-act="bg-mode" data-mode="keep" aria-pressed="true">Keep</button>
              <button type="button" data-act="bg-mode" data-mode="remove" aria-pressed="false">Remove colour</button>
            </div>
            <div class="bg-remove" hidden>
              <div class="row">
                <input type="color" data-prop="keyColor" aria-label="Colour to remove" title="Colour to remove">
                <button class="btn sm" type="button" data-act="pick-color" aria-pressed="false" title="Pick the colour from the image">${icon('eyedropper', 15)}Pick</button>
                <button class="btn sm" type="button" data-act="auto-key" title="Detect the background colour automatically">${icon('wand', 15)}Auto</button>
              </div>
              <label class="field"><span>Tolerance <output class="o-tol"></output></span><input type="range" min="0" max="100" step="1" data-prop="tolerance" aria-label="Tolerance"></label>
              <label class="field"><span>Edge softness <output class="o-soft"></output></span><input type="range" min="0" max="100" step="1" data-prop="softness" aria-label="Edge softness"></label>
              <label class="check" title="Keeps matching colours inside the artwork (e.g. white eyes on a white background)"><input type="checkbox" data-prop="edgesOnly"> Only remove areas touching the edges</label>
            </div>
            <label class="check" style="margin-top:8px"><input type="checkbox" data-prop="fillOn"> Fill the background with <input type="color" data-prop="fill" aria-label="Background fill colour"></label>
            <div class="btn-row" style="margin-top:8px">
              <button class="btn sm" type="button" data-act="trim" title="Crop away transparent margins">${icon('crop', 15)}Trim empty edges</button>
              <button class="btn sm" type="button" data-act="untrim" hidden>${icon('reset', 15)}Undo trim</button>
            </div>

            <div class="sub">Print check</div>
            <div class="card print-info"></div>

            <div class="sub">Arrange</div>
            <div class="btn-row tools">
              <button class="ib" type="button" data-act="to-back" title="Send to back (Shift+[)" aria-label="Send to back">${icon('toBack', 17)}</button>
              <button class="ib" type="button" data-act="backward" title="Send backward ( [ )" aria-label="Send backward">${icon('backward', 17)}</button>
              <button class="ib" type="button" data-act="forward" title="Bring forward ( ] )" aria-label="Bring forward">${icon('forward', 17)}</button>
              <button class="ib" type="button" data-act="to-front" title="Bring to front (Shift+])" aria-label="Bring to front">${icon('toFront', 17)}</button>
            </div>
            <div class="btn-row" style="margin-top:8px">
              <button class="btn sm" type="button" data-act="dup">${icon('copy', 15)}Duplicate</button>
              <button class="btn sm side-copy" type="button" data-act="copy-side">${icon('swap', 15)}<span>Copy to back</span></button>
              <button class="btn sm danger" type="button" data-act="delete">${icon('trash', 15)}Delete</button>
            </div>
          </div>
        </section>

        <section class="panel p-shirt" data-tab="shirt" aria-label="Shirt and background">
          <div class="panel-head"><h3>Shirt colour</h3><span class="hint shirt-name" style="margin:0"></span></div>
          <div class="swatches shirt-sw" role="group" aria-label="Shirt colours"></div>
          <div class="color-row" style="margin-top:10px">
            <input type="color" class="shirt-color" aria-label="Custom shirt colour" title="Custom colour">
            <input class="inp shirt-hex" type="text" maxlength="7" spellcheck="false" aria-label="Shirt colour (hex)">
          </div>
          <label class="check" style="margin-top:8px"><input type="checkbox" class="shirt-shading" checked> Fabric folds &amp; texture</label>

          <div class="sub">Background</div>
          <div class="seg bg-type" role="group" aria-label="Background type">
            <button type="button" data-act="bg-type" data-type="solid">Colour</button>
            <button type="button" data-act="bg-type" data-type="gradient">Gradient</button>
            <button type="button" data-act="bg-type" data-type="image">Image</button>
            <button type="button" data-act="bg-type" data-type="transparent">None</button>
          </div>
          <div class="bg-colors stack" style="margin-top:10px">
            <div class="swatches bg-sw" role="group" aria-label="Background colours"></div>
            <div class="color-row"><input type="color" class="bg-c1" aria-label="Background colour"><input class="inp bg-hex1" type="text" maxlength="7" spellcheck="false" aria-label="Background colour (hex)"></div>
            <div class="color-row bg-g2"><input type="color" class="bg-c2" aria-label="Gradient outer colour"><input class="inp bg-hex2" type="text" maxlength="7" spellcheck="false" aria-label="Gradient outer colour (hex)"></div>
          </div>
          <div class="bg-image-opts btn-row" style="margin-top:10px" hidden>
            <button class="btn sm" type="button" data-act="bg-image">${icon('image', 15)}Choose image…</button>
            <button class="btn sm" type="button" data-act="bg-image-clear">${icon('close', 15)}Remove</button>
          </div>
          <p class="hint bg-note" hidden>“None” exports a transparent background.</p>

          <div class="sub">Print area &amp; units</div>
          <div class="stack">
            <select class="inp print-size" aria-label="Print area size"></select>
            <div class="seg units" role="group" aria-label="Units">
              <button type="button" data-act="units" data-unit="in">Inches</button>
              <button type="button" data-act="units" data-unit="cm">Centimetres</button>
            </div>
          </div>
        </section>
      </aside>

      <nav class="tabs" role="tablist" aria-label="Panels">
        <button type="button" role="tab" class="tab-images" data-act="tab" data-tab="images">${icon('image', 16)}Images</button>
        <button type="button" role="tab" class="tab-layers" data-act="tab" data-tab="layers">${icon('layers', 16)}Layers</button>
        <button type="button" role="tab" class="tab-edit" data-act="tab" data-tab="edit">${icon('sliders', 16)}Edit<span class="dot" hidden></span></button>
        <button type="button" role="tab" class="tab-shirt" data-act="tab" data-tab="shirt">${icon('shirt', 16)}Shirt</button>
      </nav>
    </div>

    <div class="toasts" role="status" aria-live="polite"></div>
    <div class="busy" hidden><span class="spinner"></span><span class="busy-text">Working…</span></div>
    <div class="ghost" hidden><img alt=""></div>
    <input class="f-images" type="file" accept="image/*,.svg" multiple hidden>
    <input class="f-json" type="file" accept=".json,application/json" hidden>
    <input class="f-bg" type="file" accept="image/*" hidden>

    <dialog class="dlg dlg-export" aria-label="Export">
      <form method="dialog">
        <div class="dlg-head"><h2>Export</h2><button class="ib" value="cancel" aria-label="Close">${icon('close')}</button></div>
        <div class="dlg-body">
          <div class="fmt-grid" role="group" aria-label="File format">
            <button type="button" class="fmt" data-fmt="png"><b>PNG</b><small>Sharp image · transparency</small></button>
            <button type="button" class="fmt" data-fmt="jpeg"><b>JPEG</b><small>Smallest photo file</small></button>
            <button type="button" class="fmt" data-fmt="webp"><b>WebP</b><small>Modern web image</small></button>
            <button type="button" class="fmt" data-fmt="svg"><b>SVG</b><small>Vector mockup</small></button>
            <button type="button" class="fmt" data-fmt="pdf"><b>PDF</b><small>Mockups + print sheets</small></button>
            <button type="button" class="fmt" data-fmt="zip"><b>ZIP</b><small>Everything at once</small></button>
          </div>
          <div class="ex-row ex-content"><span>Content</span>
            <div class="seg" role="group" aria-label="Content"><button type="button" data-content="mockup">Shirt mockup</button><button type="button" data-content="print" title="Artwork only, at true print size">Print file</button></div>
          </div>
          <label class="ex-row ex-side"><span>Side</span>
            <select class="inp ex-side-sel">
              <option value="current">Current side</option><option value="front">Front</option><option value="back">Back</option>
              <option value="both">Front + back (separate files)</option><option value="combined">Front + back (side by side)</option>
            </select>
          </label>
          <label class="ex-row ex-width"><span>Size</span>
            <select class="inp ex-width-sel"><option value="1000">1000 px</option><option value="2000">2000 px</option><option value="3000">3000 px</option><option value="4000">4000 px</option></select>
          </label>
          <label class="ex-row ex-dpi"><span>Print DPI</span>
            <select class="inp ex-dpi-sel"><option value="150">150 DPI — draft</option><option value="200">200 DPI</option><option value="300">300 DPI — print quality</option></select>
          </label>
          <label class="ex-row ex-quality"><span>Quality</span><input type="range" class="ex-q" min="50" max="100" step="1"></label>
          <label class="ex-row ex-page"><span>Page size</span>
            <select class="inp ex-page-sel"><option value="letter">US Letter</option><option value="a4">A4</option></select>
          </label>
          <label class="check ex-transp"><input type="checkbox" class="ex-transp-cb"> Transparent background (no scene background)</label>
          <label class="check ex-sheets"><input type="checkbox" class="ex-sheets-cb"> Include true-size print sheets for each side</label>
          <label class="ex-row"><span>File name</span><input class="inp ex-name" type="text" spellcheck="false" maxlength="80"></label>
          <p class="ex-note"></p>
        </div>
        <div class="dlg-foot">
          <button type="button" class="btn ex-copy" data-act="export-copy">${icon('clipboard', 15)}Copy image</button>
          <span class="spacer"></span>
          <button class="btn" value="cancel">Cancel</button>
          <button type="button" class="btn primary" data-act="export-go">${icon('download', 15)}Download</button>
        </div>
      </form>
    </dialog>

    <dialog class="dlg dlg-help" aria-label="Help">
      <form method="dialog">
        <div class="dlg-head"><h2>Help &amp; shortcuts</h2><button class="ib" value="close" aria-label="Close">${icon('close')}</button></div>
        <div class="dlg-body">
          <p style="margin:0;color:var(--tsd-muted)">Add images, drag them onto the shirt, then move, resize and rotate them with the handles. Switch between <b>Front</b> and <b>Back</b> under the shirt. Export mockups or print-ready artwork with <b>Export</b>.</p>
          <dl class="keys">
            <dt>Move the selected image</dt><dd>drag · <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> (<kbd>Shift</kbd> ×10)</dd>
            <dt>Resize</dt><dd>corner handles · <kbd>Shift</kbd> free · <kbd>Alt</kbd> from centre</dd>
            <dt>Rotate</dt><dd>round handle · <kbd>Shift</kbd> snaps to 15°</dd>
            <dt>Touch</dt><dd>two fingers to scale &amp; rotate</dd>
            <dt>Turn snapping off</dt><dd>hold <kbd>Alt</kbd> while dragging</dd>
            <dt>Duplicate · delete</dt><dd><kbd>${MOD}</kbd><kbd>D</kbd> · <kbd>Del</kbd></dd>
            <dt>Copy · paste</dt><dd><kbd>${MOD}</kbd><kbd>C</kbd> · <kbd>${MOD}</kbd><kbd>V</kbd> (also pastes images)</dd>
            <dt>Undo · redo</dt><dd><kbd>${MOD}</kbd><kbd>Z</kbd> · <kbd>${MOD}</kbd><kbd>Shift</kbd><kbd>Z</kbd></dd>
            <dt>Layer order</dt><dd><kbd>[</kbd> <kbd>]</kbd> (<kbd>Shift</kbd> = back / front)</dd>
            <dt>Zoom</dt><dd><kbd>${MOD}</kbd>+scroll · <kbd>+</kbd> <kbd>−</kbd> · <kbd>0</kbd> fit</dd>
            <dt>Pan when zoomed</dt><dd>drag empty space · <kbd>Space</kbd>+drag · scroll</dd>
            <dt>Export · save</dt><dd><kbd>${MOD}</kbd><kbd>E</kbd> · <kbd>${MOD}</kbd><kbd>S</kbd></dd>
          </dl>
          <p class="hint" style="margin:0">Positions are measured from the centre line (X) and from the collar seam (Y), the way print shops specify placements. Exported print files are true size with the DPI embedded.</p>
        </div>
        <div class="dlg-foot"><span class="spacer"></span><span class="hint" style="margin:0">tshirt-designer v${VERSION}</span><button class="btn primary" value="close">Got it</button></div>
      </form>
    </dialog>

    <dialog class="dlg dlg-confirm" aria-label="Confirm">
      <form method="dialog">
        <div class="dlg-body" style="padding-top:18px"><p class="cf-msg" style="margin:0;font-size:13.5px"></p></div>
        <div class="dlg-foot"><span class="spacer"></span><button class="btn" value="cancel">Cancel</button><button class="btn primary cf-ok" value="ok">OK</button></div>
      </form>
    </dialog>
  </div>`;

  /* ===================================================================== *
   * 10. The <tshirt-designer> element
   * ===================================================================== */

  const DEFAULT_EXPORT = { format: 'png', content: 'mockup', side: 'current', width: 2000, dpi: 300, transparent: false, quality: 92, page: 'letter', sheets: true };
  const HIDE_TOKENS = ['toolbar', 'library', 'layers', 'properties', 'shirt', 'export', 'file', 'history', 'sides', 'zoom', 'name', 'help', 'guides'];
  const isImageFile = (f) => !!f && ((f.type && /^image\//.test(f.type)) || /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(f.name || ''));
  const fingerprint = (s) => {
    let h = 5381;
    const step = Math.max(1, Math.floor(s.length / 6000));
    for (let i = 0; i < s.length; i += step) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ':' + (h >>> 0).toString(36);
  };

  function defaultState() {
    return {
      name: 'Untitled design',
      shirt: { color: '#ffffff', shading: true },
      background: { type: 'solid', color: '#eef1f5', color2: '#c3ccd8', image: null },
      printSize: { w: 12, h: 16 },
      sides: { front: [], back: [] },
      library: [],
    };
  }

  /** Coerce a layer from a file / API call into a valid layer object. */
  function sanitizeLayer(raw) {
    const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const bg = raw.bg || {};
    const c = raw.crop;
    const cropOK = c && [c.x, c.y, c.w, c.h].every((v) => typeof v === 'number' && isFinite(v)) && c.w > 0 && c.h > 0;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid('l'),
      asset: String(raw.asset),
      name: String(raw.name || 'Image').slice(0, 80),
      x: n(raw.x, ART / 2),
      y: n(raw.y, 400),
      w: Math.max(MIN_SIZE, n(raw.w != null ? raw.w : raw.width, 200)),
      h: Math.max(MIN_SIZE, n(raw.h != null ? raw.h : raw.height, 200)),
      rotation: normDeg(n(raw.rotation, 0)),
      flipX: !!raw.flipX,
      flipY: !!raw.flipY,
      opacity: clamp(n(raw.opacity, 1), 0, 1),
      blend: BLEND_OP[raw.blend] ? raw.blend : 'normal',
      visible: raw.visible !== false,
      locked: !!raw.locked,
      lockAspect: raw.lockAspect !== false,
      crop: cropOK ? { x: c.x, y: c.y, w: c.w, h: c.h } : null,
      bg: {
        mode: bg.mode === 'remove' ? 'remove' : 'keep',
        color: normHex(bg.color, '#ffffff'),
        tolerance: clamp(n(bg.tolerance, 18), 0, 100),
        softness: clamp(n(bg.softness, 30), 0, 100),
        edgesOnly: bg.edgesOnly !== false,
      },
      fill: raw.fill ? normHex(raw.fill, null) : null,
    };
  }

  class TShirtDesigner extends HTMLElement {
    static get observedAttributes() {
      return ['shirt-color', 'background', 'view', 'units', 'print-area', 'hide', 'autosave', 'name', 'max-image-size', 'src', 'samples', 'readonly'];
    }
    static get version() { return VERSION; }

    constructor() {
      super();
      const sr = this.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>${STYLES}</style>${MARKUP}`;
      this._sr = sr;
      this.template = TEE;
      this.assets = new Map();
      this.state = defaultState();
      this.ui = { view: 'front', selected: null, zoom: 1, panX: 0, panY: 0, guides: true, clip: false, units: 'in', tab: 'images', eyedropper: false, readonly: false };
      this._history = { stack: [], index: -1 };
      this._runtime = new Map();
      this._pointers = new Map();
      this._drag = null;
      this._pinch = null;
      this._guides = [];
      this._hoverId = null;
      this._clipboard = null;
      this._samples = null;
      this._autosaveKey = null;
      this._maxImageSize = 4096;
      this._exportOpts = Object.assign({}, DEFAULT_EXPORT);
      this._busyCount = 0;
      this._hidden = new Set();
      this._sigLib = this._sigLayers = '';
      this._ready = new Promise((resolve) => { this._resolveReady = resolve; });
      this._emitChangeSoon = debounce((reason) => this._emit('tsd-change', { reason, summary: this._summary() }), 150);
      this._autosaveSoon = debounce(() => this._autosaveNow(), 800);
      this._thumbsSoon = debounce(() => this._renderSideThumbs(), 120);
      this._syncPropsSoon = debounce(() => this._syncProps(), 50);
      this._commitSoon = debounce((reason) => this._commit(reason), 450);
      this._onDocPaste = (e) => this._onPaste(e);
      this._grabDom();
      this._buildStaticUI();
      this._bindEvents();
    }

    /* ------------------------------------------------------------------ *
     * lifecycle & attributes
     * ------------------------------------------------------------------ */

    connectedCallback() {
      if (!this._ro) this._ro = new ResizeObserver(() => { this._updateLayout(); this._onResize(); });
      this._ro.observe(this._el.root);
      this._ro.observe(this._el.stage);
      document.addEventListener('paste', this._onDocPaste);
      for (const p of ['samples', 'view', 'shirtColor', 'background', 'design']) this._upgradeProperty(p);
      if (!this._booted) { this._booted = true; this._boot(); } else this._onResize();
    }

    disconnectedCallback() {
      if (this._ro) this._ro.disconnect();
      document.removeEventListener('paste', this._onDocPaste);
      this._autosaveSoon.cancel();
      if (this._dirty) this._autosaveNow();
    }

    attributeChangedCallback(name, oldV, newV) {
      if (!this._booted || oldV === newV) return;
      this._applyAttr(name, newV, !this._isReady); // changes before 'ready' count as configuration, not edits
    }

    _upgradeProperty(prop) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const v = this[prop];
        delete this[prop];
        this[prop] = v;
      }
    }

    async _boot() {
      for (const a of TShirtDesigner.observedAttributes) if (this.hasAttribute(a)) this._applyAttr(a, this.getAttribute(a), true);
      this._resetHistory();
      this._refreshAll();
      this._onResize();
      // Give the host a moment to finish configuring the element (frameworks often set
      // attributes/properties right after inserting it) before loading anything.
      await sleep(0);
      this._resetHistory();
      try {
        if (this._pendingDesign) {
          const d = this._pendingDesign;
          this._pendingDesign = null;
          await this.loadDesign(d, { history: false });
        } else if (this.getAttribute('src')) {
          await this._loadFromURL(this.getAttribute('src'), false);
        } else if (this._autosaveKey) {
          await this._restoreAutosave();
        }
      } catch (err) { this._error('Could not load the design', err); }
      this._isReady = true;
      this._resolveReady(this);
      this._emit('tsd-ready', { version: VERSION });
    }

    _applyAttr(name, v, initial) {
      switch (name) {
        case 'shirt-color': { const hex = normHex(v); if (hex) this._setShirtColor(hex, !initial); break; }
        case 'background': if (v) { const bg = this._normalizeBg(v); if (bg && !bg._image) this._setBackground(bg, !initial); } break;
        case 'view': if (SIDES.includes(v)) this.setView(v); break;
        case 'units': if (v === 'in' || v === 'cm') this._setUnits(v); break;
        case 'print-area': if (v) this._setPrintSizeString(v, !initial); break;
        case 'hide': this._applyHide(v || ''); break;
        case 'autosave': this._autosaveKey = v == null ? null : (String(v).trim() || 'default'); break;
        case 'name': if (v != null) this._setName(v, false); break;
        case 'max-image-size': this._maxImageSize = clamp(parseInt(v, 10) || 4096, 256, 8192); break;
        case 'src': if (this._isReady && v) this._loadFromURL(v, true).catch((err) => this._error('Could not load the design', err)); break;
        case 'samples': this._samples = v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null; this._renderLibrary(true); break;
        case 'readonly': this._setReadonly(v != null && v !== 'false'); break;
        default: break;
      }
    }

    /* ------------------------------------------------------------------ *
     * public API
     * ------------------------------------------------------------------ */

    /** Resolves (with the element) once the designer has finished initialising. */
    get ready() { return this._ready; }
    get version() { return VERSION; }
    get view() { return this.ui.view; }
    set view(v) { this.setView(v); }
    get shirtColor() { return this.state.shirt.color; }
    set shirtColor(v) { this.setShirtColor(v); }
    get background() { return clone(this.state.background); }
    set background(v) { this.setBackground(v).catch((e) => this._error('Invalid background', e)); }
    get samples() { return this._samples ? this._samples.slice() : null; }
    set samples(v) { this._samples = v == null ? null : Array.isArray(v) ? v.slice() : [v]; this._renderLibrary(true); }
    get design() { return this.getDesign(); }
    set design(v) {
      if (!this._isReady) this._pendingDesign = v;
      else this.loadDesign(v).catch((e) => this._error('Could not load the design', e));
    }
    get selectedLayer() { const L = this._sel(); return L ? this._publicLayer(L) : null; }
    get canUndo() { return this._history.index > 0; }
    get canRedo() { return this._history.index < this._history.stack.length - 1; }

    /** Show the 'front' or 'back' of the shirt. */
    setView(side) {
      if (!SIDES.includes(side)) throw new TypeError('view must be "front" or "back"');
      if (side === this.ui.view) return;
      this.ui.view = side;
      this._hoverId = null;
      this._drag = null;
      this._select(null);
      this._syncSides();
      this._renderLayers(true);
      this._syncProps();
      this._syncOverlay();
      this._requestRender();
      this._emit('tsd-view', { view: side });
    }

    setShirtColor(color) {
      const hex = normHex(color);
      if (!hex) throw new TypeError('Invalid colour: ' + color);
      this._setShirtColor(hex, true);
    }

    /**
     * 'transparent' | any CSS colour | { type: 'solid'|'gradient'|'image'|'transparent',
     *   color, color2, image: File|Blob|URL|dataURL }
     */
    async setBackground(spec) {
      const bg = this._normalizeBg(spec);
      if (!bg) throw new TypeError('Invalid background: ' + JSON.stringify(spec));
      if (bg._image) {
        const a = await this._ingest(bg._image, 'background');
        delete bg._image;
        bg.image = a.id;
      }
      this._setBackground(bg, true);
    }

    /** Print area in inches (centred on the shirt), e.g. setPrintArea(12, 16). */
    setPrintArea(width, height) { this._setPrintSize(+width, +height, true); }

    /** Add one image. source: File | Blob | URL | data URL | SVG markup | <img> | <canvas>. */
    async addImage(source, options = {}) {
      const [r] = await this.addImages([source], options);
      if (!r || r.error) throw (r && r.error) || new Error('Could not add image');
      return r;
    }

    /**
     * Add several images to the library. options:
     *   place (default true) – also put them on the shirt
     *   side ('front'|'back'), x/y (model units) or at:{x,y}, width (inches), name
     */
    async addImages(sources, options = {}) {
      const list = Array.from(sources || []);
      const side = SIDES.includes(options.side) ? options.side : this.ui.view;
      const place = options.place !== false;
      const at = options.at || (options.x != null && options.y != null ? { x: +options.x, y: +options.y } : null);
      const results = [];
      let last = null;
      if (!list.length) return results;
      this._setBusy(true, list.length > 1 ? `Adding ${list.length} images…` : 'Adding image…');
      try {
        for (let i = 0; i < list.length; i++) {
          try {
            const a = await this._ingest(list[i], list.length === 1 ? options.name : null);
            if (!this.state.library.includes(a.id)) this.state.library.push(a.id);
            let layerId = null;
            if (place) {
              last = this._placeAsset(a.id, side, at ? { x: at.x + i * 18, y: at.y + i * 18 } : null, options.width);
              layerId = last.id;
            }
            results.push({ assetId: a.id, layerId });
          } catch (err) {
            results.push({ error: err });
            const nm = list[i] && list[i].name ? `“${list[i].name}”` : 'the image';
            this._error(`Could not add ${nm}`, err);
          }
        }
      } finally { this._setBusy(false); }
      if (results.some((r) => r.assetId)) {
        if (place && side !== this.ui.view) this.setView(side);
        if (last) this._select(last.id);
        this._commit(place ? 'add-layer' : 'add-image');
        this._requestRender();
      }
      return results;
    }

    getLayers(side = this.ui.view) { return (this.state.sides[side] || []).map((L) => this._publicLayer(L)); }
    getLayer(id) { const L = this._layerById(id); return L ? this._publicLayer(L) : null; }

    selectLayer(id) {
      if (id == null) { this._select(null); return; }
      const side = this._sideOf(id);
      if (!side) return;
      if (side !== this.ui.view) this.setView(side);
      this._select(id);
    }

    /** Patch a layer. Geometry is in model units (26 units = 1 inch, artboard 1000×1000). */
    updateLayer(id, patch = {}) {
      const L = this._layerById(id);
      if (!L) throw new Error('No layer with id ' + id);
      const merged = sanitizeLayer(Object.assign({}, L, patch, {
        id: L.id, asset: L.asset,
        bg: Object.assign({}, L.bg, patch.bg || {}),
        w: patch.w != null ? patch.w : patch.width != null ? patch.width : L.w,
        h: patch.h != null ? patch.h : patch.height != null ? patch.height : L.h,
      }));
      Object.assign(L, merged);
      this._commit('update');
      this._afterEdit();
      return this._publicLayer(L);
    }

    removeLayer(id) { const L = this._layerById(id); if (L) this._deleteLayer(L); }

    undo() {
      const h = this._history;
      if (h.index <= 0) return false;
      h.index--;
      this._restoreSnapshot(h.stack[h.index]);
      this._emitChangeSoon('undo');
      this._autosaveSoon();
      return true;
    }

    redo() {
      const h = this._history;
      if (h.index >= h.stack.length - 1) return false;
      h.index++;
      this._restoreSnapshot(h.stack[h.index]);
      this._emitChangeSoon('redo');
      this._autosaveSoon();
      return true;
    }

    /** Remove all images from one side (or both). */
    clear(side) {
      for (const s of side ? [side] : SIDES) if (this.state.sides[s]) this.state.sides[s] = [];
      this._select(null);
      this._commit('clear');
      this._requestRender();
    }

    /** Start over with an empty design (undoable). */
    reset() { this._newDesign(true); }

    /** The whole design as plain JSON (images embedded as data URLs). */
    getDesign() {
      const used = new Set(this.state.library);
      for (const s of SIDES) for (const L of this.state.sides[s]) used.add(L.asset);
      if (this.state.background.image) used.add(this.state.background.image);
      const assets = {};
      for (const id of used) {
        const a = this.assets.get(id);
        if (a) assets[id] = { name: a.name, type: a.type, width: a.width, height: a.height, src: a.src };
      }
      return {
        format: FORMAT,
        version: 1,
        generator: `${TAG} ${VERSION}`,
        name: this.state.name,
        template: this.template.id,
        unitsPerInch: this.template.pxPerInch,
        shirt: clone(this.state.shirt),
        background: clone(this.state.background),
        printArea: { width: this.state.printSize.w, height: this.state.printSize.h, unit: 'in' },
        sides: { front: { layers: clone(this.state.sides.front) }, back: { layers: clone(this.state.sides.back) } },
        library: this.state.library.filter((id) => assets[id]),
        assets,
        savedAt: new Date().toISOString(),
      };
    }

    /** Load a design produced by getDesign() / the Save button (object or JSON string). */
    async loadDesign(data, opts = {}) {
      if (typeof data === 'string') data = JSON.parse(data);
      if (!data || data.format !== FORMAT || !data.sides) throw new Error('This is not a T-shirt designer file');
      this._setBusy(true, 'Opening design…');
      try {
        const idMap = new Map();
        for (const [id, a] of Object.entries(data.assets || {})) {
          try {
            const asset = await this._ingest({ src: a.src, name: a.name }, null, id);
            idMap.set(id, asset.id);
          } catch (err) { console.warn('[tshirt-designer] skipped an image that could not be read', err); }
        }
        const st = defaultState();
        st.name = String(data.name || 'Untitled design').slice(0, 80);
        st.shirt.color = normHex(data.shirt && data.shirt.color, '#ffffff');
        st.shirt.shading = !(data.shirt && data.shirt.shading === false);
        const b = data.background || {};
        st.background = {
          type: ['solid', 'gradient', 'image', 'transparent'].includes(b.type) ? b.type : 'solid',
          color: normHex(b.color, st.background.color),
          color2: normHex(b.color2, st.background.color2),
          image: b.image && idMap.get(b.image) ? idMap.get(b.image) : null,
        };
        if (st.background.type === 'image' && !st.background.image) st.background.type = 'solid';
        if (data.printArea) st.printSize = { w: clamp(+data.printArea.width || 12, 2, 18), h: clamp(+data.printArea.height || 16, 2, 22) };
        for (const s of SIDES) {
          const layers = (data.sides[s] && data.sides[s].layers) || [];
          st.sides[s] = layers.filter((L) => L && idMap.has(L.asset)).map((L) => sanitizeLayer(Object.assign({}, L, { asset: idMap.get(L.asset) })));
        }
        const lib = Array.isArray(data.library) ? data.library : Object.keys(data.assets || {});
        st.library = [...new Set(lib.map((id) => idMap.get(id)).filter(Boolean))];
        this.state = st;
        this._drag = null;
        this.ui.selected = null;
        if (opts.history === false) { this._resetHistory(); this._dirty = false; } else this._commit('load');
        this._refreshAll();
        this._emitChangeSoon('load');
      } finally { this._setBusy(false); }
    }

    /**
     * Render files without downloading them. Resolves to [{ blob, filename, side }].
     * options: format png|jpeg|webp|svg|pdf|zip|json, content mockup|print,
     *          side current|front|back|both|combined, width (px), dpi, transparent,
     *          quality (50-100), page letter|a4, sheets (PDF print sheets), filename
     */
    async export(options = {}) {
      const o = Object.assign({}, DEFAULT_EXPORT, options);
      o.format = String(o.format || 'png').toLowerCase().replace('jpg', 'jpeg');
      if (o.format === 'webp' && !webpSupported()) o.format = 'png';
      const base = slug(o.filename || this.state.name);
      this._setBusy(true, 'Preparing export…');
      try {
        await this._ensureProcessed(SIDES);
        return await this._exportFiles(o, base);
      } finally { this._setBusy(false); }
    }

    async exportImage(options = {}) { return (await this.export(Object.assign({ format: 'png' }, options)))[0].blob; }
    async exportSVG(options = {}) { return (await this.export(Object.assign({}, options, { format: 'svg' })))[0].blob; }
    async exportPDF(options = {}) { return (await this.export(Object.assign({}, options, { format: 'pdf' })))[0].blob; }
    async exportZip(options = {}) { return (await this.export(Object.assign({}, options, { format: 'zip' })))[0].blob; }

    /**
     * Export and download. Each file first fires a cancelable `tsd-export`
     * event — call event.preventDefault() to handle the Blob yourself.
     */
    async download(options = {}) {
      const files = await this.export(options);
      for (const f of files) {
        const go = this._emit('tsd-export', { blob: f.blob, filename: f.filename, side: f.side || null, format: f.format, options: clone(options) }, true);
        if (go) {
          downloadBlob(f.blob, f.filename, this._sr);
          if (files.length > 1) await sleep(400);
        }
      }
      return files;
    }

    openExportDialog(options) {
      if (options) Object.assign(this._exportOpts, options);
      this._openExportDialog();
    }

    zoomToFit() { this.ui.zoom = 1; this.ui.panX = this.ui.panY = 0; this._syncZoom(); this._requestRender(); }
    setZoom(z) { this._zoomAt(+z || 1, (this._stageW || 0) / 2, (this._stageH || 0) / 2); }

    /* ------------------------------------------------------------------ *
     * images (assets) and background processing
     * ------------------------------------------------------------------ */

    async _ingest(source, nameHint, preferredId) {
      let blob = null;
      let src = null;
      let name = nameHint || '';
      let type = '';
      if (source && typeof source === 'object' && !isBlob(source) && typeof source.src === 'string' && !(source instanceof HTMLImageElement)) {
        name = name || source.name || '';
        source = source.src;
      }
      if (isBlob(source)) {
        blob = source;
        name = name || source.name || 'image';
        type = source.type || '';
      } else if (typeof source === 'string') {
        const s = source.trim();
        if (/^<svg[\s>]/i.test(s) || /^<\?xml[\s\S]*?<svg[\s>]/i.test(s)) {
          blob = new Blob([s], { type: 'image/svg+xml' });
          type = 'image/svg+xml';
          name = name || 'graphic';
        } else if (/^data:/i.test(s)) {
          src = s;
          type = ((/^data:([^;,]+)/i.exec(s) || [])[1] || '').toLowerCase();
          name = name || 'image';
        } else {
          name = name || (() => { try { return decodeURIComponent(s.split(/[?#]/)[0].split('/').pop()) || 'image'; } catch (e) { return 'image'; } })();
          try {
            const res = await fetch(s, { mode: 'cors', credentials: 'omit' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            blob = await res.blob();
            type = blob.type || '';
          } catch (err) {
            const img = await loadImage(s, 'anonymous');
            const c = makeCanvas(img.naturalWidth, img.naturalHeight);
            c.getContext('2d').drawImage(img, 0, 0);
            try { src = c.toDataURL('image/png'); type = 'image/png'; } catch (e2) { throw new Error('the image host does not allow it to be used here (CORS)'); }
          }
        }
      } else if (source && (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement || (global.ImageBitmap && source instanceof global.ImageBitmap))) {
        const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
        const c = makeCanvas(w, h);
        c.getContext('2d').drawImage(source, 0, 0);
        src = c.toDataURL('image/png');
        type = 'image/png';
        name = name || 'image';
      } else {
        throw new TypeError('Unsupported image source');
      }

      if (blob) {
        if (!type) type = blob.type || '';
        if (!type && /\.svg$/i.test(name)) type = 'image/svg+xml';
        if (type === 'image/svg+xml' || /\.svg$/i.test(name)) {
          src = svgTextToDataURL(normalizeSVG(await blob.text()));
          type = 'image/svg+xml';
        } else {
          src = await blobToDataURL(blob);
        }
      } else if (type === 'image/svg+xml') {
        try { src = svgTextToDataURL(normalizeSVG(new TextDecoder().decode(dataURLToBytes(src)))); } catch (e) { /* keep as is */ }
      }

      const fp = fingerprint(src);
      for (const a of this.assets.values()) if (a.fp === fp) return a;

      let img = await loadImage(src);
      let width = img.naturalWidth, height = img.naturalHeight;
      if (!width || !height) throw new Error('the image has no size');
      const vector = type === 'image/svg+xml';
      if (!vector && Math.max(width, height) > this._maxImageSize) {
        const k = this._maxImageSize / Math.max(width, height);
        const c = makeCanvas(width * k, height * k);
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, c.width, c.height);
        type = this._hasAlpha(cx, c.width, c.height) ? 'image/png' : 'image/jpeg';
        src = c.toDataURL(type, 0.92);
        img = await loadImage(src);
        width = img.naturalWidth;
        height = img.naturalHeight;
      }
      const a = {
        id: preferredId && !this.assets.has(preferredId) ? String(preferredId) : uid('a'),
        name: fileBase(name),
        type: type || 'image/png',
        src, fp, width, height, vector, img,
        processed: new Map(),
        thumb: null,
        bgInfo: null,
      };
      a.thumb = this._makeThumb(a);
      this._analyzeAsset(a);
      this.assets.set(a.id, a);
      return a;
    }

    _hasAlpha(ctx, w, h) {
      try {
        const d = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
        return false;
      } catch (e) { return true; }
    }

    _makeThumb(a) {
      if (a.vector || Math.max(a.width, a.height) <= 200) return a.src;
      const k = 200 / Math.max(a.width, a.height);
      const c = makeCanvas(a.width * k, a.height * k);
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(a.img, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }

    _analyzeAsset(a) {
      try {
        const k = Math.min(1, 220 / Math.max(a.width, a.height));
        const w = Math.max(1, Math.round(a.width * k)), h = Math.max(1, Math.round(a.height * k));
        const c = makeCanvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(a.img, 0, 0, w, h);
        a.bgInfo = detectBackground(ctx.getImageData(0, 0, w, h).data, w, h);
      } catch (e) { a.bgInfo = null; }
    }

    /** Full-resolution pixels of an asset (vectors are rasterised at print size). */
    async _sourceCanvas(a) {
      if (a._canvas) return a._canvas;
      let w = a.width, h = a.height;
      if (a.vector) { const k = 3000 / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(a.img, 0, 0, w, h);
      a._canvas = c;
      return c;
    }

    _rt(id) {
      let r = this._runtime.get(id);
      if (!r) { r = { last: null, busy: false }; this._runtime.set(id, r); }
      return r;
    }

    _needsProcessing(L) { return (L.bg && L.bg.mode === 'remove') || !!L.fill; }

    _processKey(L) {
      const b = L.bg || {};
      return JSON.stringify([b.mode === 'remove' ? [b.color, b.tolerance, b.softness, !!b.edgesOnly] : 0, L.fill || 0]);
    }

    _startProcess(a, L, key, rt) {
      const e = { key, canvas: null, promise: null };
      a.processed.set(key, e);
      while (a.processed.size > 6) a.processed.delete(a.processed.keys().next().value);
      const bg = L.bg && L.bg.mode === 'remove' ? Object.assign({}, L.bg) : null;
      if (rt) rt.busy = true;
      e.promise = this._process(a, bg, L.fill).then((c) => {
        e.canvas = c;
        return c;
      }, (err) => {
        a.processed.delete(key);
        this._error('Could not process the image', err);
        throw err;
      }).finally(() => {
        if (rt) rt.busy = false;
        this._requestRender();
        this._thumbsSoon();
      });
      e.promise.catch(() => {});
      return e;
    }

    async _process(a, bg, fill) {
      const src = await this._sourceCanvas(a);
      const w = src.width, h = src.height;
      let out = src;
      if (bg) {
        const ctx = src.getContext('2d', { willReadFrequently: true });
        const o = Object.assign({}, parseColor(bg.color) || WHITE, { tolerance: bg.tolerance, softness: bg.softness, edgesOnly: !!bg.edgesOnly });
        let data;
        try {
          data = await runKeyOut(ctx.getImageData(0, 0, w, h).data, w, h, o);
        } catch (err) {
          if (err && err.name === 'SecurityError') throw new Error('this image cannot be edited (cross-origin)');
          data = keyOutImpl(ctx.getImageData(0, 0, w, h).data, w, h, o);
        }
        out = makeCanvas(w, h);
        out.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
      }
      if (fill) {
        const c = makeCanvas(w, h);
        const cx = c.getContext('2d');
        cx.fillStyle = normHex(fill, '#ffffff');
        cx.fillRect(0, 0, w, h);
        cx.drawImage(out, 0, 0);
        out = c;
      }
      return out;
    }

    /** What to draw for a layer: { image, sx, sy, sw, sh, iw, ih } (crop in image pixels). */
    _bitmap(L) {
      const a = this.assets.get(L.asset);
      if (!a || !a.img) return null;
      let image = a.img;
      let iw = a.width, ih = a.height;
      if (this._needsProcessing(L)) {
        const key = this._processKey(L);
        const rt = this._rt(L.id);
        let e = a.processed.get(key);
        if (!e && !rt.busy) e = this._startProcess(a, L, key, rt);
        if (e && e.canvas) { rt.last = e.canvas; rt.lastAsset = a.id; image = e.canvas; }
        else if (rt.last && rt.lastAsset === a.id) image = rt.last;
        if (image !== a.img) { iw = image.width; ih = image.height; }
      }
      const kx = iw / a.width, ky = ih / a.height;
      const c = L.crop || { x: 0, y: 0, w: a.width, h: a.height };
      return { image, sx: c.x * kx, sy: c.y * ky, sw: c.w * kx, sh: c.h * ky, iw, ih };
    }

    /** Wait until every layer that needs background processing is ready (before exports). */
    async _ensureProcessed(sides) {
      const jobs = [];
      for (const s of sides) {
        for (const L of this.state.sides[s]) {
          if (!L.visible || !this._needsProcessing(L)) continue;
          const a = this.assets.get(L.asset);
          if (!a) continue;
          const key = this._processKey(L);
          let e = a.processed.get(key);
          if (!e) e = this._startProcess(a, L, key, null);
          if (!e.canvas) jobs.push(e.promise.then((c) => { const rt = this._rt(L.id); rt.last = c; rt.lastAsset = a.id; }));
        }
      }
      await Promise.all(jobs);
    }

    /** Keyed (background removed, no fill) pixels of a layer — used by trim. */
    async _keyedCanvas(L) {
      const a = this.assets.get(L.asset);
      if (!(L.bg && L.bg.mode === 'remove')) return this._sourceCanvas(a);
      const probe = Object.assign({}, L, { fill: null });
      const key = this._processKey(probe);
      let e = a.processed.get(key);
      if (!e) e = this._startProcess(a, probe, key, null);
      return e.canvas || e.promise;
    }

    /* ------------------------------------------------------------------ *
     * layers
     * ------------------------------------------------------------------ */

    _newLayer(a, p) {
      const bgColor = (a.bgInfo && !a.bgInfo.transparent && a.bgInfo.color) || '#ffffff';
      return Object.assign({
        id: uid('l'), asset: a.id, name: a.name,
        x: ART / 2, y: 400, w: 200, h: 200, rotation: 0,
        flipX: false, flipY: false, opacity: 1, blend: 'normal',
        visible: true, locked: false, lockAspect: true, crop: null,
        bg: { mode: 'keep', color: bgColor, tolerance: 18, softness: 30, edgesOnly: true },
        fill: null,
      }, p);
    }

    /** Put an asset on a side. `at` = model point for the centre; widthIn = inches. */
    _placeAsset(assetId, side = this.ui.view, at = null, widthIn = null) {
      const a = this.assets.get(assetId);
      if (!a) throw new Error('Unknown image');
      const pa = this._printArea(side);
      const ar = a.width / a.height;
      let w, h;
      if (widthIn > 0) { w = widthIn * this.template.pxPerInch; h = w / ar; } else {
        w = pa.w * 0.7; h = w / ar;
        if (h > pa.h * 0.55) { h = pa.h * 0.55; w = h * ar; }
      }
      let x = pa.x + pa.w / 2;
      let y = pa.y + Math.max(h / 2, pa.h * 0.38);
      if (at) { x = at.x; y = at.y; } else {
        const layers = this.state.sides[side];
        for (let g = 0; g < 12 && layers.some((o) => Math.abs(o.x - x) < 2 && Math.abs(o.y - y) < 2); g++) { x += 18; y += 18; }
      }
      const L = this._newLayer(a, { x, y, w, h });
      this.state.sides[side].push(L);
      return L;
    }

    _placeFromLibrary(assetId, at) {
      if (this.ui.readonly || !this.assets.has(assetId)) return;
      const L = this._placeAsset(assetId, this.ui.view, at || null);
      this._select(L.id);
      this._commit('add-layer');
      this._requestRender();
    }

    _layerById(id) {
      for (const s of SIDES) { const L = this.state.sides[s].find((l) => l.id === id); if (L) return L; }
      return null;
    }
    _sideOf(id) {
      for (const s of SIDES) if (this.state.sides[s].some((l) => l.id === id)) return s;
      return null;
    }
    _sel() { return this.ui.selected ? this.state.sides[this.ui.view].find((l) => l.id === this.ui.selected) || null : null; }

    _select(id) {
      if (id === this.ui.selected) return;
      this.ui.selected = id || null;
      if (this.ui.eyedropper) this._setEyedropper(false);
      this._syncLayerSelection();
      this._syncProps();
      this._syncOverlay();
      const L = this._sel();
      this._emit('tsd-select', { layer: L ? this._publicLayer(L) : null, side: this.ui.view });
    }

    _publicLayer(L) {
      const side = this._sideOf(L.id) || this.ui.view;
      const sd = this.template.sides[side];
      const bb = this._aabb(L);
      const ppi = this.template.pxPerInch;
      return Object.assign(clone(L), {
        side,
        inches: {
          width: roundTo(L.w / ppi, 3),
          height: roundTo(L.h / ppi, 3),
          xFromCenter: roundTo((L.x - ART / 2) / ppi, 3),
          yBelowCollar: roundTo((bb.minY - sd.collarY) / ppi, 3),
        },
      });
    }

    _duplicate(L) {
      const arr = this.state.sides[this._sideOf(L.id)];
      const copy = Object.assign(clone(L), { id: uid('l'), x: L.x + 16, y: L.y + 16 });
      arr.splice(arr.indexOf(L) + 1, 0, copy);
      this._select(copy.id);
      this._commit('duplicate');
      this._requestRender();
      return copy;
    }

    _deleteLayer(L) {
      const side = this._sideOf(L.id);
      if (!side) return;
      const arr = this.state.sides[side];
      arr.splice(arr.indexOf(L), 1);
      this._runtime.delete(L.id);
      if (this.ui.selected === L.id) this._select(null);
      this._commit('delete');
      this._requestRender();
    }

    _reorder(L, op) {
      const arr = this.state.sides[this._sideOf(L.id)];
      const i = arr.indexOf(L);
      let j = i;
      if (op === 'forward') j = Math.min(arr.length - 1, i + 1);
      else if (op === 'backward') j = Math.max(0, i - 1);
      else if (op === 'front') j = arr.length - 1;
      else if (op === 'back') j = 0;
      if (j === i) return;
      arr.splice(i, 1);
      arr.splice(j, 0, L);
      this._commit('reorder');
      this._requestRender();
    }

    _copyToOtherSide(L) {
      const from = this._sideOf(L.id);
      const to = from === 'front' ? 'back' : 'front';
      const pa1 = this._printArea(from), pa2 = this._printArea(to);
      const copy = Object.assign(clone(L), { id: uid('l'), y: L.y - pa1.y + pa2.y });
      this.state.sides[to].push(copy);
      this._commit('copy-side');
      this._toast(`Copied to the ${to}`, 'ok', 3500, { label: `Show ${to}`, fn: () => { this.setView(to); this._select(copy.id); } });
    }

    _align(L, how) {
      const pa = this._printArea(this._sideOf(L.id));
      if (how === 'center-h') L.x = pa.x + pa.w / 2;
      else if (how === 'center-v') L.y = pa.y + pa.h / 2;
      else if (how === 'top') L.y += pa.y - this._aabb(L).minY;
      else if (how === 'fit') {
        const r = L.rotation * DEG, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
        const f = Math.min(pa.w / (L.w * c + L.h * s), pa.h / (L.w * s + L.h * c));
        L.w *= f; L.h *= f;
        L.x = pa.x + pa.w / 2;
        L.y = pa.y + pa.h / 2;
      }
      this._commit('align');
      this._afterEdit();
    }

    _afterEdit() { this._requestRender(); this._syncProps(); this._syncOverlay(); }

    _aabb(L) {
      const r = (L.rotation || 0) * DEG, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      const hw = (L.w * c + L.h * s) / 2, hh = (L.w * s + L.h * c) / 2;
      return { minX: L.x - hw, maxX: L.x + hw, minY: L.y - hh, maxY: L.y + hh };
    }

    _pointInLayer(L, m, slop = 0) {
      const r = -(L.rotation || 0) * DEG;
      const dx = m.x - L.x, dy = m.y - L.y;
      const lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
      return Math.abs(lx) <= L.w / 2 + slop && Math.abs(ly) <= L.h / 2 + slop;
    }

    _hitTest(m) {
      const layers = this.state.sides[this.ui.view];
      const slop = 3 / this._xf().s;
      for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        if (L.visible && !L.locked && this._pointInLayer(L, m, slop)) return L;
      }
      return null;
    }

    _printArea(side) {
      const sd = this.template.sides[side || this.ui.view];
      const ppi = this.template.pxPerInch;
      const w = this.state.printSize.w * ppi, h = this.state.printSize.h * ppi;
      return { x: ART / 2 - w / 2, y: sd.printTop, w, h };
    }

    /** Print-related warnings for a layer (resolution and print-area bounds). */
    _layerWarnings(L) {
      const out = [];
      const a = this.assets.get(L.asset);
      const dpi = this._effectiveDPI(L);
      if (a && !a.vector && dpi < 150) out.push(`Low resolution: about ${Math.round(dpi)} DPI at this size`);
      const pa = this._printArea(this._sideOf(L.id));
      const bb = this._aabb(L);
      const t = 0.5;
      if (bb.minX < pa.x - t || bb.maxX > pa.x + pa.w + t || bb.minY < pa.y - t || bb.maxY > pa.y + pa.h + t) out.push('Extends outside the print area (will be cut off in print files)');
      return out;
    }

    _effectiveDPI(L) {
      const a = this.assets.get(L.asset);
      if (!a) return 0;
      const c = L.crop || { w: a.width, h: a.height };
      const ppi = this.template.pxPerInch;
      const k = a.vector ? 3000 / Math.max(a.width, a.height) : 1; // see _sourceCanvas()
      return Math.min((c.w * k) / (L.w / ppi), (c.h * k) / (L.h / ppi));
    }

    /* ------------------------------------------------------------------ *
     * shirt, background, print area, units, name, visibility options
     * ------------------------------------------------------------------ */

    _setShirtColor(hex, record = true) {
      if (hex !== this.state.shirt.color) {
        this.state.shirt.color = hex;
        this._syncShirtPanel();
        this._requestRender();
        this._thumbsSoon();
        this._syncOverlay();
      }
      if (record) this._commit('shirt-color');
    }

    _normalizeBg(spec) {
      if (spec == null) return null;
      if (typeof spec === 'string') {
        const s = spec.trim();
        if (/^(transparent|none)$/i.test(s)) return Object.assign({}, this.state.background, { type: 'transparent' });
        const g = /^gradient\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/i.exec(s);
        if (g) { const c1 = normHex(g[1]), c2 = normHex(g[2]); return c1 && c2 ? Object.assign({}, this.state.background, { type: 'gradient', color: c1, color2: c2 }) : null; }
        const hex = normHex(s);
        return hex ? Object.assign({}, this.state.background, { type: 'solid', color: hex }) : null;
      }
      if (typeof spec !== 'object') return null;
      const cur = this.state.background;
      const type = ['solid', 'gradient', 'image', 'transparent'].includes(spec.type) ? spec.type : spec.image ? 'image' : 'solid';
      const bg = { type, color: normHex(spec.color, cur.color), color2: normHex(spec.color2, cur.color2), image: cur.image };
      if (type === 'image') {
        if (typeof spec.image === 'string' && this.assets.has(spec.image)) bg.image = spec.image;
        else if (spec.image) bg._image = spec.image;
        else if (!cur.image) return null;
      }
      return bg;
    }

    _setBackground(bg, record = true) {
      this.state.background = { type: bg.type, color: bg.color, color2: bg.color2, image: bg.image || null };
      this._syncShirtPanel();
      this._requestRender();
      this._thumbsSoon();
      if (record) this._commit('background');
    }

    _setPrintSize(w, h, record = true) {
      if (!(w > 0) || !(h > 0)) throw new TypeError('Print area must be positive numbers (inches)');
      this.state.printSize = { w: roundTo(clamp(w, 2, 18), 2), h: roundTo(clamp(h, 2, 22), 2) };
      this._syncShirtPanel();
      this._requestRender();
      this._syncOverlay();
      if (record) this._commit('print-area');
    }

    _setPrintSizeString(v, record) {
      const m = /^\s*([\d.]+)\s*[x×,]\s*([\d.]+)\s*$/i.exec(String(v));
      if (m) this._setPrintSize(+m[1], +m[2], record);
    }

    _setUnits(u) {
      this.ui.units = u === 'cm' ? 'cm' : 'in';
      this._syncShirtPanel();
      this._syncProps();
      this._requestRender();
    }

    _setName(v, record) {
      const name = String(v || '').trim().slice(0, 80) || 'Untitled design';
      this.state.name = name;
      if (this._el.nameInput.value !== name) this._el.nameInput.value = name;
      if (record) { this._dirty = true; this._autosaveSoon(); this._emitChangeSoon('name'); }
    }

    _applyHide(v) {
      const tokens = new Set(String(v).split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean).map((t) => (t === 'edit' ? 'properties' : t)));
      this._hidden = tokens;
      for (const t of HIDE_TOKENS) this._el.root.classList.toggle('hide-' + t, tokens.has(t));
      this._syncPanelsVisibility();
    }

    _setReadonly(on) {
      this.ui.readonly = !!on;
      this._el.root.classList.toggle('readonly', this.ui.readonly);
      this._el.nameInput.readOnly = this.ui.readonly;
      if (on) { this._select(null); this._setEyedropper(false); }
      this._syncPanelsVisibility();
      this._syncOverlay();
    }

    _syncPanelsVisibility() {
      const t = this._hidden, ro = this.ui.readonly;
      const noLeft = ro || (t.has('library') && t.has('layers'));
      const noRight = ro || (t.has('properties') && t.has('shirt'));
      this._el.root.classList.toggle('no-left', noLeft);
      this._el.root.classList.toggle('no-right', noRight);
      const visibleTabs = ['images', 'layers', 'edit', 'shirt'].filter((tab) => !t.has({ images: 'library', layers: 'layers', edit: 'properties', shirt: 'shirt' }[tab]));
      if (visibleTabs.length && !visibleTabs.includes(this.ui.tab)) this._setTab(visibleTabs[0]);
      this._onResize();
    }

    _setTab(tab) {
      this.ui.tab = tab;
      this._el.root.dataset.tab = tab;
      for (const b of this._sr.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }

    async _newDesign(skipConfirm) {
      if (!skipConfirm && this._hasContent() && !(await this._confirm('Start a new design? The current one will be cleared — you can still undo.', 'Start new'))) return;
      const keepName = this.state.name;
      this.state = defaultState();
      this.state.name = keepName === 'Untitled design' ? keepName : 'Untitled design';
      this.ui.selected = null;
      this._drag = null;
      this._commit('new');
      this._refreshAll();
    }

    _hasContent() { return SIDES.some((s) => this.state.sides[s].length) || this.state.library.length > 0; }

    async _loadFromURL(url, history) {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      await this.loadDesign(await res.json(), { history });
    }

    async _loadSamples() {
      const list = this._samples || [];
      if (!list.length) return;
      await this.addImages(list, { place: false });
      this._toast('Sample images added — drag one onto the shirt', 'ok', 3500);
    }

    /* ------------------------------------------------------------------ *
     * view transform & rendering
     * ------------------------------------------------------------------ */

    /** Pick wide / medium / stacked from the size the host gives the component. */
    _updateLayout() {
      const r = this._el.root;
      const w = r.clientWidth, h = r.clientHeight;
      if (!w) return;
      const layout = w >= 1000 ? 'wide' : w >= 640 && w / Math.max(1, h) >= 0.8 ? 'medium' : 'stacked';
      const size = w < 480 ? 'xs' : w < 640 ? 's' : w < 1120 ? 'm' : 'l';
      if (r.dataset.layout !== layout) r.dataset.layout = layout;
      if (r.dataset.w !== size) r.dataset.w = size;
    }

    _onResize() {
      const st = this._el.stage;
      const w = st.clientWidth, h = st.clientHeight;
      if (!w || !h) return;
      // Cap the backing store (~8 MP per canvas; the editor keeps three) on huge, high-DPI screens.
      const dpr = Math.max(1, Math.min(global.devicePixelRatio || 1, 3, Math.sqrt(8e6 / (w * h))));
      if (w !== this._stageW || h !== this._stageH || dpr !== this._dpr) {
        this._stageW = w;
        this._stageH = h;
        this._dpr = dpr;
        this._el.cv.width = Math.round(w * dpr);
        this._el.cv.height = Math.round(h * dpr);
        this._cacheKey = null;
        this._clampPan();
        this._render();
      }
      this._syncOverlay();
    }

    /** model units → stage CSS pixels: screen = model * s + t */
    _xf() {
      const W = this._stageW || 1, H = this._stageH || 1;
      const pad = Math.min(W, H) < 480 ? 12 : 26;
      const bottom = this._hidden.has('sides') ? pad : Math.max(pad, 40);
      const availW = Math.max(10, W - pad * 2), availH = Math.max(10, H - pad - bottom);
      const fit = Math.min(availW / ART, availH / ART);
      const s = fit * this.ui.zoom;
      return { s, fit, tx: (W - ART * s) / 2 + this.ui.panX, ty: pad + (availH - ART * s) / 2 + this.ui.panY };
    }

    /** client coordinates → stage CSS pixels (robust to CSS transforms on the host page) */
    _stageLocal(cx, cy) {
      const r = this._el.stage.getBoundingClientRect();
      const kx = r.width / (this._stageW || r.width || 1) || 1, ky = r.height / (this._stageH || r.height || 1) || 1;
      return { x: (cx - r.left) / kx, y: (cy - r.top) / ky };
    }
    _toModel(cx, cy) { const p = this._stageLocal(cx, cy), v = this._xf(); return { x: (p.x - v.tx) / v.s, y: (p.y - v.ty) / v.s }; }
    _isOverStage(cx, cy) { const r = this._el.stage.getBoundingClientRect(); return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; }

    _zoomAt(z, fx, fy) {
      z = clamp(z, 0.5, 8);
      const v0 = this._xf();
      const mx = (fx - v0.tx) / v0.s, my = (fy - v0.ty) / v0.s;
      this.ui.zoom = z;
      if (z <= 1.0001) { this.ui.panX = 0; this.ui.panY = 0; } else {
        const v1 = this._xf();
        this.ui.panX += fx - (mx * v1.s + v1.tx);
        this.ui.panY += fy - (my * v1.s + v1.ty);
        this._clampPan();
      }
      this._syncZoom();
      this._requestRender();
    }
    _zoomCenter(f) { this._zoomAt(this.ui.zoom * f, (this._stageW || 0) / 2, (this._stageH || 0) / 2); }

    _clampPan() {
      if (this.ui.zoom <= 1.0001) { this.ui.panX = this.ui.panY = 0; return; }
      const v = this._xf(), size = ART * v.s;
      const lim = (stage) => Math.max(0, (size - stage) / 2 + stage * 0.35);
      this.ui.panX = clamp(this.ui.panX, -lim(this._stageW || 1), lim(this._stageW || 1));
      this.ui.panY = clamp(this.ui.panY, -lim(this._stageH || 1), lim(this._stageH || 1));
    }

    _syncZoom() { this._el.zoomLabel.textContent = Math.round(this.ui.zoom * 100) + '%'; }

    _requestRender() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
    }

    _render() {
      const cv = this._el.cv, ctx = this._ctx;
      if (!this._stageW || !cv.width) return;
      const dpr = this._dpr || 1, v = this._xf(), k = dpr * v.s;
      const side = this.ui.view, sd = this.template.sides[side];
      this._ensureShirtCache(v, k);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(this._cacheUnder, 0, 0);
      ctx.setTransform(k, 0, 0, k, dpr * v.tx, dpr * v.ty);
      ctx.save();
      ctx.clip(path2d(sd.silhouette));
      if (this.ui.clip) {
        const pa = this._printArea(side);
        ctx.beginPath();
        ctx.rect(pa.x, pa.y, pa.w, pa.h);
        ctx.clip();
      }
      for (const L of this.state.sides[side]) {
        if (!L.visible) continue;
        const b = this._bitmap(L);
        if (b) drawLayerBitmap(ctx, L, b);
      }
      const dp = this._dropPreview;
      if (dp) {
        const a = this.assets.get(dp.asset);
        if (a && a.img) drawLayerBitmap(ctx, dp, { image: a.img, sx: 0, sy: 0, sw: a.width, sh: a.height }, { alpha: 0.78 });
      }
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this._cacheOver, 0, 0);
      ctx.setTransform(k, 0, 0, k, dpr * v.tx, dpr * v.ty);
      this._drawGuides(ctx, v);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._syncOverlay();
    }

    /** Background + shirt base ("under") and shading/collar ("over") are cached per view. */
    _ensureShirtCache(v, k) {
      const cv = this._el.cv, st = this.state, side = this.ui.view;
      const bg = st.background;
      const bgA = bg.type === 'image' && bg.image ? this.assets.get(bg.image) : null;
      const key = [cv.width, cv.height, k.toFixed(5), v.tx.toFixed(2), v.ty.toFixed(2), side, st.shirt.color, st.shirt.shading, bg.type, bg.color, bg.color2, bgA ? bgA.id : ''].join('|');
      if (key === this._cacheKey && this._cacheUnder) return;
      this._cacheKey = key;
      const dpr = this._dpr || 1;
      const fit = (c) => {
        c = c || document.createElement('canvas');
        if (c.width !== cv.width || c.height !== cv.height) { c.width = cv.width; c.height = cv.height; }
        return c;
      };
      this._cacheUnder = fit(this._cacheUnder);
      this._cacheOver = fit(this._cacheOver);
      const pal = shirtPalette(st.shirt.color), sd = this.template.sides[side];

      let c = this._cacheUnder.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.setTransform(k, 0, 0, k, dpr * v.tx, dpr * v.ty);
      // the artboard ("page") — exactly what gets exported
      c.save();
      c.shadowColor = 'rgba(16,24,40,0.16)';
      c.shadowBlur = 16 * dpr;
      c.shadowOffsetY = 3 * dpr;
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, ART, ART);
      c.restore();
      if (bg.type === 'transparent' || (bg.type === 'image' && !(bgA && bgA.img))) this._drawChecker(c, v);
      else drawBackground(c, bg, 0, 0, ART, ART, bgA && bgA.img);
      drawShirtBase(c, sd, pal, k);

      c = this._cacheOver.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.setTransform(k, 0, 0, k, dpr * v.tx, dpr * v.ty);
      drawShirtOver(c, sd, pal, { shading: st.shirt.shading, deviceScale: k });
      c.setTransform(1, 0, 0, 1, 0, 0);
    }

    _drawChecker(ctx, v) {
      if (!this._checker) {
        const t = makeCanvas(16, 16);
        const x = t.getContext('2d');
        x.fillStyle = '#ffffff';
        x.fillRect(0, 0, 16, 16);
        x.fillStyle = '#e3e6eb';
        x.fillRect(0, 0, 8, 8);
        x.fillRect(8, 8, 8, 8);
        this._checker = t;
      }
      const pat = ctx.createPattern(this._checker, 'repeat');
      const cell = 10 / v.s / 8; // 10 CSS-pixel squares at any zoom
      try { pat.setTransform(new DOMMatrix([cell, 0, 0, cell, 0, 0])); } catch (e) { /* ignore */ }
      ctx.save();
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, ART, ART);
      ctx.restore();
    }

    _drawGuides(ctx, v) {
      const px = 1 / v.s;
      if (this.ui.guides) {
        const pa = this._printArea(this.ui.view);
        const pal = shirtPalette(this.state.shirt.color);
        const col = pal.L > 0.4 ? 'rgba(79,70,229,0.8)' : 'rgba(196,193,255,0.9)';
        ctx.save();
        ctx.lineWidth = px;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.strokeStyle = col;
        ctx.strokeRect(pa.x, pa.y, pa.w, pa.h);
        if (pa.w * v.s > 130) {
          ctx.setLineDash([]);
          ctx.fillStyle = col;
          ctx.font = `600 ${11 * px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
          ctx.textBaseline = 'top';
          ctx.fillText(`Print area ${this._fmtLen(pa.w)} × ${this._fmtLen(pa.h)} ${this.ui.units}`, pa.x + 2 * px, pa.y + pa.h + 5 * px);
        }
        ctx.restore();
      }
      if (this._guides.length) {
        ctx.save();
        ctx.strokeStyle = '#ff2d87';
        ctx.lineWidth = px;
        ctx.beginPath();
        for (const g of this._guides) { ctx.moveTo(g.x1, g.y1); ctx.lineTo(g.x2, g.y2); }
        ctx.stroke();
        ctx.restore();
      }
    }

    /** Draw one finished side (shirt + artwork + shading) in model units. */
    _drawSide(ctx, side, deviceScale, opts = {}) {
      const sd = this.template.sides[side], pal = shirtPalette(this.state.shirt.color);
      drawShirtBase(ctx, sd, pal, deviceScale, { shadow: opts.shadow !== false });
      ctx.save();
      ctx.clip(path2d(sd.silhouette));
      if (this.ui.clip) {
        const pa = this._printArea(side);
        ctx.beginPath();
        ctx.rect(pa.x, pa.y, pa.w, pa.h);
        ctx.clip();
      }
      for (const L of this.state.sides[side]) {
        if (!L.visible) continue;
        const b = this._bitmap(L);
        if (b) drawLayerBitmap(ctx, L, b);
      }
      ctx.restore();
      drawShirtOver(ctx, sd, pal, { shading: this.state.shirt.shading, deviceScale });
    }

    _renderSideThumbs() {
      for (const btn of this._el.sideBtns) {
        const c = btn.querySelector('canvas');
        const ctx = c.getContext('2d');
        const s = c.width / 930;
        const off = c.width / 2 - 500 * s;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.setTransform(s, 0, 0, s, off, off + 8 * s);
        this._drawSide(ctx, btn.dataset.side, s, { shadow: false });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }

    _syncSides() {
      for (const btn of this._el.sideBtns) {
        const side = btn.dataset.side, n = this.state.sides[side].length;
        btn.setAttribute('aria-selected', String(side === this.ui.view));
        btn.querySelector('.cnt').textContent = n ? `${n} image${n > 1 ? 's' : ''}` : 'Empty';
      }
    }

    /* ------------------------------------------------------------------ *
     * selection overlay (DOM handles over the canvas)
     * ------------------------------------------------------------------ */

    _syncOverlay() {
      const el = this._el;
      if (!this._stageW) return;
      const v = this._xf();
      const L = this._sel();
      const showSel = !!(L && L.visible && !this.ui.eyedropper);
      el.selBox.hidden = !showSel;
      if (showSel) {
        this._placeBox(el.selBox, L, v);
        el.selBox.classList.toggle('locked', !!L.locked);
        el.selBox.classList.toggle('no-edges', L.lockAspect || L.w * v.s < 44 || L.h * v.s < 44);
        if (this._cursorRot !== Math.round(L.rotation)) this._updateHandleCursors(L.rotation);
      }
      const showQB = showSel && !L.locked && !this.ui.readonly && !this._drag && !this._pinch;
      el.quickbar.hidden = !showQB;
      if (showQB) {
        const bb = this._aabb(L);
        const qw = el.quickbar.offsetWidth || 170, qh = el.quickbar.offsetHeight || 38;
        const top = bb.minY * v.s + v.ty, bottom = bb.maxY * v.s + v.ty;
        let y = bottom + 12;
        if (y + qh > this._stageH - 64) y = top - qh - 46;
        y = clamp(y, 6, Math.max(6, this._stageH - qh - 6));
        const x = clamp(L.x * v.s + v.tx - qw / 2, 6, Math.max(6, this._stageW - qw - 6));
        el.quickbar.style.transform = `translate(${x}px, ${y}px)`;
        el.quickbar.querySelector('.qb-side').title = `Copy to the ${this.ui.view === 'front' ? 'back' : 'front'}`;
      }
      const H = this._hoverId && this._hoverId !== this.ui.selected && !this._drag ? this.state.sides[this.ui.view].find((l) => l.id === this._hoverId) : null;
      el.hoverBox.hidden = !H;
      if (H) this._placeBox(el.hoverBox, H, v);
      const empty = !this.ui.readonly && !this.state.sides[this.ui.view].length && !this._dropPreview;
      el.emptyHint.hidden = !empty;
      if (empty) {
        const pa = this._printArea(this.ui.view);
        const s = el.emptyHint.style;
        s.width = pa.w * v.s + 'px';
        s.height = pa.h * v.s + 'px';
        s.transform = `translate(${pa.x * v.s + v.tx}px, ${pa.y * v.s + v.ty}px)`;
        s.color = shirtPalette(this.state.shirt.color).L > 0.4 ? 'rgba(27,33,48,.62)' : 'rgba(255,255,255,.8)';
        el.emptyHint.classList.toggle('tiny', pa.w * v.s < 120);
      }
    }

    _placeBox(box, L, v) {
      const w = L.w * v.s, h = L.h * v.s;
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      box.style.transform = `translate(${L.x * v.s + v.tx}px, ${L.y * v.s + v.ty}px) rotate(${L.rotation}deg) translate(${-w / 2}px, ${-h / 2}px)`;
    }

    _updateHandleCursors(rot) {
      this._cursorRot = Math.round(rot);
      const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
      const names = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
      for (const h of this._el.selBox.querySelectorAll('.h[data-h]')) {
        const k = h.dataset.h;
        if (k === 'rot') continue;
        const a = (((base[k] + rot) % 180) + 180) % 180;
        h.style.cursor = names[Math.round(a / 45) % 4];
      }
    }

    _showMeasure(L, text) {
      const m = this._el.measure, v = this._xf(), bb = this._aabb(L);
      m.textContent = text;
      m.hidden = false;
      const w = m.offsetWidth || 80;
      let y = bb.minY * v.s + v.ty - 64;
      if (y < 4) y = bb.maxY * v.s + v.ty + 14;
      m.style.transform = `translate(${clamp(L.x * v.s + v.tx - w / 2, 4, Math.max(4, this._stageW - w - 4))}px, ${clamp(y, 4, Math.max(4, this._stageH - 30))}px)`;
    }
    _hideMeasure() { this._el.measure.hidden = true; }

    /* ------------------------------------------------------------------ *
     * stage interactions: select, move, resize, rotate, pinch, pan, zoom
     * ------------------------------------------------------------------ */

    _onDown(e) {
      const el = this._el;
      if (el.quickbar.contains(e.target) || el.emptyHint.contains(e.target)) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      el.stage.focus({ preventScroll: true });
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { el.stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (this._pointers.size === 2) { this._startPinch(); return; }
      if (this._pointers.size > 2 || this._drag) return;
      if (e.button === 1 || this._spaceDown) { e.preventDefault(); this._startPan(e); return; }
      if (this.ui.readonly) { if (this.ui.zoom > 1.0001) this._startPan(e); return; }
      const m = this._toModel(e.clientX, e.clientY);
      if (this.ui.eyedropper) { this._pickAt(m); return; }
      const handle = e.target.closest && e.target.closest('[data-h]');
      const sel = this._sel();
      if (handle && sel && !sel.locked) {
        e.preventDefault();
        this._drag = { type: handle.dataset.h === 'rot' ? 'rotate' : 'resize', h: handle.dataset.h, id: sel.id, start: m, orig: clone(sel) };
        this._syncOverlay();
        return;
      }
      const hit = this._hitTest(m);
      if (hit) {
        this._select(hit.id);
        this._drag = { type: 'move', id: hit.id, start: m, orig: clone(hit), moved: false, cx: e.clientX, cy: e.clientY };
      } else {
        this._select(null);
        if (this.ui.zoom > 1.0001) this._startPan(e);
      }
    }

    _onMove(e) {
      if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch) { this._updatePinch(); return; }
      const d = this._drag;
      if (!d) { if (e.pointerType === 'mouse') this._hoverAt(e); return; }
      if (d.type === 'pan') {
        const p = this._stageLocal(e.clientX, e.clientY);
        this.ui.panX = d.panX + (p.x - d.sx);
        this.ui.panY = d.panY + (p.y - d.sy);
        this._clampPan();
        this._requestRender();
        return;
      }
      const L = this._layerById(d.id);
      if (!L) { this._drag = null; return; }
      const m = this._toModel(e.clientX, e.clientY);
      if (d.type === 'move') {
        if (!d.moved) {
          if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 3) return;
          d.moved = true;
          this._setHover(null);
        }
        let x = d.orig.x + (m.x - d.start.x), y = d.orig.y + (m.y - d.start.y);
        if (!e.altKey) { const s = this._snapMove(L, x, y); x = s.x; y = s.y; this._guides = s.guides; } else this._guides = [];
        L.x = x;
        L.y = y;
        const top = this._aabb(L).minY - this.template.sides[this.ui.view].collarY;
        this._showMeasure(L, `X ${this._fmtSigned(L.x - ART / 2)}  ·  Y ${this._fmtLen(top)} ${this.ui.units}`);
      } else if (d.type === 'resize') {
        this._applyResize(L, d, m, e);
        this._showMeasure(L, `${this._fmtLen(L.w)} × ${this._fmtLen(L.h)} ${this.ui.units}`);
      } else if (d.type === 'rotate') {
        this._applyRotate(L, d, m, e);
        this._showMeasure(L, `${roundTo(L.rotation, 1)}°`);
      }
      this._requestRender();
      this._syncPropsSoon();
    }

    _onUp(e, cancelled) {
      this._pointers.delete(e.pointerId);
      try { this._el.stage.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (this._pinch) {
        if (this._pointers.size < 2) {
          const p = this._pinch;
          this._pinch = null;
          if (p.layerId) this._commit('transform');
          this._syncOverlay();
        }
        return;
      }
      const d = this._drag;
      if (!d) return;
      this._drag = null;
      this._guides = [];
      this._hideMeasure();
      this._el.stage.classList.remove('panning');
      if (d.type !== 'pan') {
        const L = this._layerById(d.id);
        if (L && cancelled) Object.assign(L, d.orig);
        else if (L && (d.type !== 'move' || d.moved)) this._commit('transform');
      }
      this._requestRender();
      this._syncProps();
      this._syncOverlay();
    }

    _hoverAt(e) {
      if (this.ui.readonly) return;
      const onUi = e.target.closest && e.target.closest('[data-h], .quickbar, .empty-hint');
      const hit = onUi ? null : this._hitTest(this._toModel(e.clientX, e.clientY));
      this._setHover(hit ? hit.id : null);
      this._el.stage.style.cursor = this.ui.eyedropper ? 'crosshair' : hit ? 'move' : this.ui.zoom > 1.0001 ? 'grab' : '';
    }

    _setHover(id) {
      if (id === this._hoverId) return;
      this._hoverId = id;
      this._syncOverlay();
    }

    _startPan(e) {
      const p = this._stageLocal(e.clientX, e.clientY);
      this._drag = { type: 'pan', sx: p.x, sy: p.y, panX: this.ui.panX, panY: this.ui.panY };
      this._el.stage.classList.add('panning');
    }

    /** Snap to the print-area centre/edges and to other images' centres. */
    _snapMove(L, x, y) {
      const v = this._xf(), thr = 7 / v.s;
      const pa = this._printArea(this.ui.view);
      const bb = this._aabb(Object.assign({}, L, { x, y }));
      const hw = (bb.maxX - bb.minX) / 2, hh = (bb.maxY - bb.minY) / 2;
      const xs = [[pa.x + pa.w / 2, 0], [pa.x, -hw], [pa.x + pa.w, hw]];
      const ys = [[pa.y + pa.h / 2, 0], [pa.y, -hh], [pa.y + pa.h, hh]];
      for (const o of this.state.sides[this.ui.view]) {
        if (o.id !== L.id && o.visible) { xs.push([o.x, 0]); ys.push([o.y, 0]); }
      }
      let bx = null, by = null;
      for (const [line, off] of xs) { const d = Math.abs(x + off - line); if (d < thr && (!bx || d < bx.d)) bx = { d, v: line - off, line }; }
      for (const [line, off] of ys) { const d = Math.abs(y + off - line); if (d < thr && (!by || d < by.d)) by = { d, v: line - off, line }; }
      const guides = [];
      if (bx) { x = bx.v; guides.push({ x1: bx.line, y1: Math.min(pa.y, bb.minY) - 24, x2: bx.line, y2: Math.max(pa.y + pa.h, bb.maxY) + 24 }); }
      if (by) { y = by.v; guides.push({ x1: Math.min(pa.x, bb.minX) - 24, y1: by.line, x2: Math.max(pa.x + pa.w, bb.maxX) + 24, y2: by.line }); }
      return { x, y, guides };
    }

    _applyResize(L, d, m, e) {
      const o = d.orig, h = d.h;
      const hx = { nw: -1, n: 0, ne: 1, e: 1, se: 1, s: 0, sw: -1, w: -1 }[h];
      const hy = { nw: -1, n: -1, ne: -1, e: 0, se: 1, s: 1, sw: 1, w: 0 }[h];
      const r = o.rotation * DEG, cos = Math.cos(r), sin = Math.sin(r);
      const dx = m.x - o.x, dy = m.y - o.y;
      const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos; // pointer in the layer's own frame
      const fromCenter = !!e.altKey;
      const ax = fromCenter ? 0 : (-hx * o.w) / 2, ay = fromCenter ? 0 : (-hy * o.h) / 2; // fixed anchor
      let w = o.w, hh = o.h;
      if (hx && hy && L.lockAspect !== !!e.shiftKey) {
        const vx = (hx * o.w) / 2 - ax, vy = (hy * o.h) / 2 - ay;
        let s = ((lx - ax) * vx + (ly - ay) * vy) / (vx * vx + vy * vy);
        s = Math.max(s, MIN_SIZE / Math.min(o.w, o.h));
        w = o.w * s;
        hh = o.h * s;
      } else {
        const k = fromCenter ? 2 : 1;
        if (hx) w = Math.max(MIN_SIZE, hx * (lx - ax) * k);
        if (hy) hh = Math.max(MIN_SIZE, hy * (ly - ay) * k);
      }
      const cxl = fromCenter || !hx ? 0 : ax + (hx * w) / 2;
      const cyl = fromCenter || !hy ? 0 : ay + (hy * hh) / 2;
      L.w = w;
      L.h = hh;
      L.x = o.x + cxl * cos - cyl * sin;
      L.y = o.y + cxl * sin + cyl * cos;
    }

    _applyRotate(L, d, m, e) {
      const o = d.orig;
      const a0 = Math.atan2(d.start.y - o.y, d.start.x - o.x), a1 = Math.atan2(m.y - o.y, m.x - o.x);
      let deg = normDeg(o.rotation + (a1 - a0) / DEG);
      if (e.shiftKey) deg = normDeg(Math.round(deg / 15) * 15);
      else {
        const near = Math.round(deg / 45) * 45;
        if (Math.abs(deg - near) < 3) deg = normDeg(near);
      }
      L.rotation = Math.round(deg * 10) / 10;
    }

    _startPinch() {
      const [p1, p2] = [...this._pointers.values()];
      const L = this._sel();
      if (this._drag && this._drag.type !== 'pan') this._guides = [];
      this._drag = null;
      this._hideMeasure();
      this._el.stage.classList.remove('panning');
      const a = this._toModel(p1.x, p1.y), b = this._toModel(p2.x, p2.y);
      const la = this._stageLocal(p1.x, p1.y), lb = this._stageLocal(p2.x, p2.y);
      const v = this._xf();
      const mid = { x: (la.x + lb.x) / 2, y: (la.y + lb.y) / 2 };
      this._pinch = {
        layerId: L && !L.locked && !this.ui.readonly ? L.id : null,
        orig: L ? clone(L) : null,
        d0: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        a0: Math.atan2(b.y - a.y, b.x - a.x),
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        sd0: Math.hypot(lb.x - la.x, lb.y - la.y) || 1,
        zoom0: this.ui.zoom,
        anchor: { x: (mid.x - v.tx) / v.s, y: (mid.y - v.ty) / v.s },
      };
      this._syncOverlay();
    }

    _updatePinch() {
      const p = this._pinch, pts = [...this._pointers.values()];
      if (pts.length < 2) return;
      if (p.layerId) {
        const L = this._layerById(p.layerId);
        if (!L) return;
        const a = this._toModel(pts[0].x, pts[0].y), b = this._toModel(pts[1].x, pts[1].y);
        const o = p.orig;
        const s = Math.max((Math.hypot(b.x - a.x, b.y - a.y) || 1) / p.d0, MIN_SIZE / Math.min(o.w, o.h));
        L.w = o.w * s;
        L.h = o.h * s;
        L.rotation = Math.round(normDeg(o.rotation + (Math.atan2(b.y - a.y, b.x - a.x) - p.a0) / DEG) * 10) / 10;
        L.x = o.x + (a.x + b.x) / 2 - p.m0.x;
        L.y = o.y + (a.y + b.y) / 2 - p.m0.y;
        this._syncPropsSoon();
      } else {
        const la = this._stageLocal(pts[0].x, pts[0].y), lb = this._stageLocal(pts[1].x, pts[1].y);
        const mid = { x: (la.x + lb.x) / 2, y: (la.y + lb.y) / 2 };
        this.ui.zoom = clamp((p.zoom0 * (Math.hypot(lb.x - la.x, lb.y - la.y) || 1)) / p.sd0, 0.5, 8);
        this.ui.panX = this.ui.panY = 0;
        if (this.ui.zoom > 1.0001) {
          const v = this._xf();
          this.ui.panX = mid.x - (p.anchor.x * v.s + v.tx);
          this.ui.panY = mid.y - (p.anchor.y * v.s + v.ty);
          this._clampPan();
        }
        this._syncZoom();
      }
      this._requestRender();
    }

    _onWheel(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const p = this._stageLocal(e.clientX, e.clientY);
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this._zoomAt(this.ui.zoom * Math.pow(1.0022, -clamp(dy, -120, 120)), p.x, p.y);
      } else if (this.ui.zoom > 1.0001) {
        e.preventDefault();
        const k = e.deltaMode === 1 ? 16 : 1;
        this.ui.panX -= e.deltaX * k;
        this.ui.panY -= e.deltaY * k;
        this._clampPan();
        this._requestRender();
      }
    }

    /* ------------------------------------------------------------------ *
     * keyboard & clipboard
     * ------------------------------------------------------------------ */

    _onKey(e) {
      if (e.defaultPrevented || e.isComposing) return;
      const t = (e.composedPath && e.composedPath()[0]) || e.target;
      const tag = (t && t.tagName) || '';
      const type = (t && t.type) || '';
      const isText = (tag === 'INPUT' && !/^(checkbox|radio|range|button|color|file|submit|reset)$/i.test(type)) || tag === 'TEXTAREA' || (t && t.isContentEditable);
      if (isText) { if (e.key === 'Escape' && t.blur) t.blur(); return; }
      if (this._sr.querySelector('dialog[open]')) return;
      const isControl = tag === 'SELECT' || (tag === 'INPUT' && /^(range|checkbox|radio|color)$/i.test(type));
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      const lower = key && key.length === 1 ? key.toLowerCase() : key;
      const L = this._sel();
      const ro = this.ui.readonly;
      if (mod) {
        if (lower === 'z') { e.preventDefault(); if (!ro) { if (e.shiftKey) this.redo(); else this.undo(); } return; }
        if (lower === 'y') { e.preventDefault(); if (!ro) this.redo(); return; }
        if (lower === 'e') { e.preventDefault(); this._openExportDialog(); return; }
        if (lower === 's') { e.preventDefault(); if (!ro) this._saveProject(); return; }
        if (lower === 'o') { e.preventDefault(); if (!ro) this._el.fJson.click(); return; }
        if (key === '0') { e.preventDefault(); this.zoomToFit(); return; }
        if (key === '=' || key === '+') { e.preventDefault(); this._zoomCenter(1.25); return; }
        if (key === '-') { e.preventDefault(); this._zoomCenter(0.8); return; }
        if (ro || !L) return;
        if (lower === 'd') { e.preventDefault(); this._duplicate(L); return; }
        if (lower === 'c') { this._clipboard = clone(L); return; }
        if (lower === 'x') { this._clipboard = clone(L); this._deleteLayer(L); return; }
        if (key === ']') { e.preventDefault(); this._reorder(L, 'front'); return; }
        if (key === '[') { e.preventDefault(); this._reorder(L, 'back'); return; }
        return;
      }
      if (isControl) return;
      if (key === 'Escape') {
        if (this.ui.eyedropper) this._setEyedropper(false);
        else if (this._drag && this._drag.orig) {
          const D = this._layerById(this._drag.id);
          if (D) Object.assign(D, this._drag.orig);
          this._drag = null;
          this._guides = [];
          this._hideMeasure();
          this._afterEdit();
        } else this._select(null);
        return;
      }
      if (key === ' ' && t === this._el.stage) { e.preventDefault(); this._setSpace(true); return; }
      if (tag !== 'BUTTON') {
        if (key === '+' || key === '=') { this._zoomCenter(1.25); return; }
        if (key === '-' || key === '_') { this._zoomCenter(0.8); return; }
        if (key === '0') { this.zoomToFit(); return; }
      }
      if (!L || ro) return;
      if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); this._deleteLayer(L); return; }
      if (key === ']' || key === '}') { this._reorder(L, e.shiftKey ? 'front' : 'forward'); return; }
      if (key === '[' || key === '{') { this._reorder(L, e.shiftKey ? 'back' : 'backward'); return; }
      if (key && key.indexOf('Arrow') === 0 && !L.locked) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        if (key === 'ArrowLeft') L.x -= step;
        else if (key === 'ArrowRight') L.x += step;
        else if (key === 'ArrowUp') L.y -= step;
        else if (key === 'ArrowDown') L.y += step;
        this._requestRender();
        this._syncOverlay();
        this._syncPropsSoon();
        this._commitSoon('nudge');
      }
    }

    _setSpace(on) {
      this._spaceDown = !!on;
      this._el.stage.classList.toggle('space', !!on);
    }

    _onPaste(e) {
      if (this.ui.readonly) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(this)) return; // focus is not inside this designer
      const t = path[0];
      if (t && ((t.tagName === 'INPUT' && !/^(checkbox|radio|range|button|color|file)$/i.test(t.type)) || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = Array.from(dt.files || []).filter(isImageFile);
      if (files.length) { e.preventDefault(); this.addImages(files, { place: true, name: files.length === 1 && /^image\.\w+$/i.test(files[0].name) ? 'Pasted image' : null }); return; }
      const text = (dt.getData('text/plain') || '').trim();
      if (/^<svg[\s>]/i.test(text) || /^<\?xml[\s\S]*?<svg[\s>]/i.test(text) || /^data:image\//i.test(text) || /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i.test(text)) {
        e.preventDefault();
        this.addImages([text], { place: true, name: /^https?:/i.test(text) ? null : 'Pasted image' });
        return;
      }
      if (this._clipboard) { e.preventDefault(); this._pasteLayer(); }
    }

    _pasteLayer() {
      const src = this._clipboard;
      if (!src || !this.assets.has(src.asset)) return;
      const copy = Object.assign(clone(src), { id: uid('l'), x: src.x + 16, y: src.y + 16 });
      this._clipboard = Object.assign(clone(src), { x: copy.x, y: copy.y });
      this.state.sides[this.ui.view].push(copy);
      this._select(copy.id);
      this._commit('paste');
      this._requestRender();
    }

    /* ------------------------------------------------------------------ *
     * drag images from the library onto the shirt (mouse, pen and touch)
     * ------------------------------------------------------------------ */

    _onLibDown(e) {
      const item = e.target.closest('.lib-item');
      if (!item || e.target.closest('.lib-del') || this.ui.readonly) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      this._libDrag = { id: item.dataset.id, pid: e.pointerId, sx: e.clientX, sy: e.clientY, item, active: false };
      try { item.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }

    _onLibMove(e) {
      const d = this._libDrag;
      if (!d || e.pointerId !== d.pid) return;
      const a = this.assets.get(d.id);
      if (!a) { this._libDrag = null; return; }
      if (!d.active) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
        d.active = true;
        this._el.ghost.querySelector('img').src = a.thumb;
        this._el.ghost.hidden = false;
      }
      const rr = this._el.root.getBoundingClientRect();
      const k = rr.width / (this._el.root.offsetWidth || rr.width || 1) || 1;
      const g = this._el.ghost;
      g.style.transform = `translate(${(e.clientX - rr.left) / k}px, ${(e.clientY - rr.top) / k}px)`;
      const over = this._isOverStage(e.clientX, e.clientY);
      g.classList.toggle('over', over);
      this._el.stage.classList.toggle('drop-target', over);
      if (over) {
        const m = this._toModel(e.clientX, e.clientY);
        const pa = this._printArea(this.ui.view);
        const ar = a.width / a.height;
        let w = pa.w * 0.7, h = w / ar;
        if (h > pa.h * 0.55) { h = pa.h * 0.55; w = h * ar; }
        let x = m.x;
        const cx = pa.x + pa.w / 2;
        if (!e.altKey && Math.abs(x - cx) < 8 / this._xf().s) { x = cx; this._guides = [{ x1: cx, y1: pa.y - 24, x2: cx, y2: pa.y + pa.h + 24 }]; } else this._guides = [];
        this._dropPreview = { asset: d.id, x, y: m.y, w, h, rotation: 0, opacity: 1 };
      } else {
        this._dropPreview = null;
        this._guides = [];
      }
      this._requestRender();
    }

    _onLibUp(e, cancelled) {
      const d = this._libDrag;
      if (!d || e.pointerId !== d.pid) return;
      this._libDrag = null;
      try { d.item.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const preview = this._dropPreview;
      this._dropPreview = null;
      this._guides = [];
      this._el.ghost.hidden = true;
      this._el.ghost.classList.remove('over');
      this._el.stage.classList.remove('drop-target');
      if (!cancelled) {
        if (!d.active) {
          this._placeFromLibrary(d.id);
          try { d.item.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
        } else if (preview && this._isOverStage(e.clientX, e.clientY)) {
          this._placeFromLibrary(d.id, { x: preview.x, y: preview.y });
          this._el.stage.focus({ preventScroll: true });
        }
      }
      this._requestRender();
    }

    /* ------------------------------------------------------------------ *
     * files dropped from the desktop / another app
     * ------------------------------------------------------------------ */

    _bindFileDrop() {
      const root = this._el.root;
      const hasFiles = (e) => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.from(t).some((x) => x === 'Files' || x === 'text/uri-list'); };
      let timer = 0;
      const clear = () => {
        this._el.stage.classList.remove('drop-target');
        this._el.imagesPanel.classList.remove('drop-target');
      };
      root.addEventListener('dragover', (e) => {
        if (this.ui.readonly || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const overStage = this._isOverStage(e.clientX, e.clientY);
        this._el.stage.classList.toggle('drop-target', overStage);
        this._el.imagesPanel.classList.toggle('drop-target', !overStage);
        clearTimeout(timer);
        timer = setTimeout(clear, 180);
      });
      root.addEventListener('drop', async (e) => {
        if (this.ui.readonly || !hasFiles(e)) return;
        e.preventDefault();
        clearTimeout(timer);
        clear();
        const overStage = this._isOverStage(e.clientX, e.clientY);
        const at = overStage ? this._toModel(e.clientX, e.clientY) : null;
        const all = Array.from(e.dataTransfer.files || []);
        const files = all.filter(isImageFile);
        if (files.length) { await this._addFiles(files, overStage, at); return; }
        if (all.length) { this._toast('Only image files can be added', 'error'); return; }
        const uri = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && l[0] !== '#');
        if (uri) await this.addImages([uri.trim()], { place: overStage, at });
      });
    }

    async _addFiles(files, place, at) {
      this._pendingPlace = false;
      const res = await this.addImages(files, { place: !!place, at: at || null });
      const n = res.filter((r) => r.assetId).length;
      if (n && !place) {
        this._toast(n > 1 ? `${n} images added — drag them onto the shirt` : 'Image added — drag it onto the shirt, or click it', 'ok', 3200);
        if (this._tabbed()) this._setTab('images');
      }
    }

    _tabbed() { return this._el.root.dataset.layout !== 'wide'; }

    /* ------------------------------------------------------------------ *
     * layers list: select, show/hide, lock, drag to reorder
     * ------------------------------------------------------------------ */

    _onLayersDown(e) {
      const li = e.target.closest('.layer');
      if (!li || e.target.closest('button')) return;
      this._select(li.dataset.id);
      if (this.ui.readonly) return;
      if (e.target.closest('.grip') || e.pointerType === 'mouse') {
        this._reorderDrag = { id: li.dataset.id, pid: e.pointerId, sy: e.clientY, li, active: false, idx: null };
        try { li.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (e.target.closest('.grip')) e.preventDefault();
      }
    }

    _onLayersMove(e) {
      const d = this._reorderDrag;
      if (!d || e.pointerId !== d.pid) return;
      if (!d.active) {
        if (Math.abs(e.clientY - d.sy) < 5) return;
        d.active = true;
        d.li.classList.add('dragging');
      }
      const list = this._el.layers;
      const items = [...list.querySelectorAll('.layer')].filter((x) => x !== d.li);
      let idx = items.length;
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) { idx = i; break; }
      }
      d.idx = idx;
      let line = list.querySelector('.drop-line');
      if (!line) { line = document.createElement('li'); line.className = 'drop-line'; line.setAttribute('aria-hidden', 'true'); }
      if (idx < items.length) list.insertBefore(line, items[idx]); else list.appendChild(line);
    }

    _onLayersUp(e, cancelled) {
      const d = this._reorderDrag;
      if (!d || e.pointerId !== d.pid) return;
      this._reorderDrag = null;
      try { d.li.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const line = this._el.layers.querySelector('.drop-line');
      if (line) line.remove();
      d.li.classList.remove('dragging');
      if (!d.active || cancelled || d.idx == null) return;
      const side = this.ui.view, arr = this.state.sides[side];
      const L = arr.find((l) => l.id === d.id);
      if (!L) return;
      const shown = arr.slice().reverse().filter((l) => l !== L);
      shown.splice(d.idx, 0, L);
      const next = shown.reverse();
      if (next.every((l, i) => l === arr[i])) return;
      this.state.sides[side] = next;
      this._commit('reorder');
      this._requestRender();
    }

    _onLayersKey(e) {
      const li = e.target.closest('.layer');
      if (!li || e.target.closest('button')) return;
      const items = [...this._el.layers.querySelectorAll('.layer')];
      const i = items.indexOf(li);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1)];
        if (n) { this._select(n.dataset.id); n.focus(); }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._select(li.dataset.id);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !this.ui.readonly) {
        e.preventDefault();
        const L = this._layerById(li.dataset.id);
        if (L) this._deleteLayer(L);
      }
    }

    /* ------------------------------------------------------------------ *
     * eyedropper & trim
     * ------------------------------------------------------------------ */

    _setEyedropper(on) {
      this.ui.eyedropper = !!on && !!this._sel();
      this._el.root.classList.toggle('picking', this.ui.eyedropper);
      this._el.pickHint.hidden = !this.ui.eyedropper;
      const b = this._el.edit.querySelector('[data-act="pick-color"]');
      if (b) b.setAttribute('aria-pressed', String(this.ui.eyedropper));
      this._el.stage.style.cursor = this.ui.eyedropper ? 'crosshair' : '';
      this._syncOverlay();
      if (this.ui.eyedropper) this._el.stage.focus({ preventScroll: true });
    }

    async _pickAt(m) {
      const L = this._sel();
      if (!L) { this._setEyedropper(false); return; }
      if (!this._pointInLayer(L, m)) { this._toast('Click inside the selected image', 'info', 2200); return; }
      const a = this.assets.get(L.asset);
      const src = await this._sourceCanvas(a);
      const r = -L.rotation * DEG, dx = m.x - L.x, dy = m.y - L.y;
      let lx = dx * Math.cos(r) - dy * Math.sin(r), ly = dx * Math.sin(r) + dy * Math.cos(r);
      if (L.flipX) lx = -lx;
      if (L.flipY) ly = -ly;
      const c = L.crop || { x: 0, y: 0, w: a.width, h: a.height };
      const kx = src.width / a.width, ky = src.height / a.height;
      const px = Math.floor((c.x + ((lx + L.w / 2) / L.w) * c.w) * kx);
      const py = Math.floor((c.y + ((ly + L.h / 2) / L.h) * c.h) * ky);
      const x0 = clamp(px - 2, 0, src.width - 1), y0 = clamp(py - 2, 0, src.height - 1);
      let d;
      try { d = src.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, Math.min(5, src.width - x0), Math.min(5, src.height - y0)).data; } catch (err) {
        this._error('Could not read colours from this image', err);
        this._setEyedropper(false);
        return;
      }
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++; }
      if (!n) { this._toast('That spot is already transparent', 'info', 2200); return; }
      L.bg.color = toHex({ r: rs / n, g: gs / n, b: bs / n });
      L.bg.mode = 'remove';
      this._setEyedropper(false);
      this._commit('bg-pick');
      this._afterEdit();
    }

    async _trim(L) {
      const a = this.assets.get(L.asset);
      if (!a) return;
      this._setBusy(true, 'Trimming…');
      try {
        const canvas = await this._keyedCanvas(L);
        const W = canvas.width, H = canvas.height;
        const b = alphaBounds(canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data, W, H, 10);
        if (!b) { this._toast('The image is completely transparent', 'info'); return; }
        const kx = a.width / W, ky = a.height / H;
        const nc = { x: b.x * kx, y: b.y * ky, w: b.w * kx, h: b.h * ky };
        const cur = L.crop || { x: 0, y: 0, w: a.width, h: a.height };
        if (Math.abs(nc.x - cur.x) < 0.5 && Math.abs(nc.y - cur.y) < 0.5 && Math.abs(nc.w - cur.w) < 0.5 && Math.abs(nc.h - cur.h) < 0.5) {
          this._toast(b.w >= W - 1 && b.h >= H - 1 ? 'No empty edges to trim — remove the background first' : 'Already trimmed', 'info', 3200);
          return;
        }
        this._applyCrop(L, nc);
        this._commit('trim');
        this._afterEdit();
      } catch (err) {
        this._error('Could not trim the image', err);
      } finally { this._setBusy(false); }
    }

    /** Change the visible source region while keeping the artwork where it is on the shirt. */
    _applyCrop(L, nc) {
      const a = this.assets.get(L.asset);
      const oc = L.crop || { x: 0, y: 0, w: a.width, h: a.height };
      const kx = L.w / oc.w, ky = L.h / oc.h;
      let dx = (nc.x + nc.w / 2 - (oc.x + oc.w / 2)) * kx;
      let dy = (nc.y + nc.h / 2 - (oc.y + oc.h / 2)) * ky;
      if (L.flipX) dx = -dx;
      if (L.flipY) dy = -dy;
      const r = L.rotation * DEG;
      L.x += dx * Math.cos(r) - dy * Math.sin(r);
      L.y += dx * Math.sin(r) + dy * Math.cos(r);
      L.w = nc.w * kx;
      L.h = nc.h * ky;
      const full = nc.x <= 0.01 && nc.y <= 0.01 && Math.abs(nc.w - a.width) < 0.01 && Math.abs(nc.h - a.height) < 0.01;
      L.crop = full ? null : nc;
    }

    /* ------------------------------------------------------------------ *
     * DOM wiring
     * ------------------------------------------------------------------ */

    _grabDom() {
      const q = (s) => this._sr.querySelector(s);
      this._el = {
        root: q('.tsd'), stage: q('.stage'), cv: q('.cv'), selBox: q('.sel-box'), hoverBox: q('.hover-box'),
        quickbar: q('.quickbar'), measure: q('.measure'), emptyHint: q('.empty-hint'),
        lib: q('.lib'), libHint: q('.lib-hint'), samplesBtn: q('.samples-btn'), imagesPanel: q('.p-images'),
        layers: q('.layers'), layersEmpty: q('.layers-empty'), layerCount: q('.layer-count'), sideName: q('.side-name'),
        sideBtns: Array.from(this._sr.querySelectorAll('.side-btn')), zoomLabel: q('.zoom-label'), pickHint: q('.pick-hint'),
        edit: q('.p-edit'), shirt: q('.p-shirt'), toasts: q('.toasts'), busy: q('.busy'), busyText: q('.busy-text'),
        ghost: q('.ghost'), fImages: q('.f-images'), fJson: q('.f-json'), fBg: q('.f-bg'), nameInput: q('.name-input'),
        dlgExport: q('.dlg-export'), dlgHelp: q('.dlg-help'), dlgConfirm: q('.dlg-confirm'),
      };
      this._ctx = this._el.cv.getContext('2d');
    }

    _buildStaticUI() {
      const q = (s) => this._sr.querySelector(s);
      q('.shirt-sw').innerHTML = SHIRT_COLORS.map(([n, c]) => `<button type="button" class="sw" data-act="shirt-color" data-color="${c}" style="--c:${c}" title="${n}" aria-label="${n}"></button>`).join('');
      q('.bg-sw').innerHTML = BG_COLORS.map((c) => `<button type="button" class="sw" data-act="bg-color" data-color="${c}" style="--c:${c}" title="${c.toUpperCase()}" aria-label="Background ${c}"></button>`).join('');
      q('.blend-sel').innerHTML = BLEND_MODES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
      q('.print-size').innerHTML = PRINT_AREAS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
      if (!webpSupported()) q('.fmt[data-fmt="webp"]').hidden = true;
      this._setTab(this.ui.tab);
    }

    _bindEvents() {
      const sr = this._sr, el = this._el;
      sr.addEventListener('click', (e) => this._onClick(e));
      sr.addEventListener('keydown', (e) => this._onKey(e));
      sr.addEventListener('keyup', (e) => { if (e.key === ' ') this._setSpace(false); });
      const st = el.stage;
      st.addEventListener('pointerdown', (e) => this._onDown(e));
      st.addEventListener('pointermove', (e) => this._onMove(e));
      st.addEventListener('pointerup', (e) => this._onUp(e, false));
      st.addEventListener('pointercancel', (e) => this._onUp(e, true));
      st.addEventListener('pointerleave', (e) => { if (!this._drag && e.pointerType === 'mouse') this._setHover(null); });
      st.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      st.addEventListener('blur', () => this._setSpace(false));
      el.lib.addEventListener('pointerdown', (e) => this._onLibDown(e));
      el.lib.addEventListener('pointermove', (e) => this._onLibMove(e));
      el.lib.addEventListener('pointerup', (e) => this._onLibUp(e, false));
      el.lib.addEventListener('pointercancel', (e) => this._onLibUp(e, true));
      el.lib.addEventListener('keydown', (e) => {
        const item = e.target.closest('.lib-item');
        if (!item || e.target !== item) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._placeFromLibrary(item.dataset.id); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this._removeFromLibrary(item.dataset.id); }
      });
      el.layers.addEventListener('pointerdown', (e) => this._onLayersDown(e));
      el.layers.addEventListener('pointermove', (e) => this._onLayersMove(e));
      el.layers.addEventListener('pointerup', (e) => this._onLayersUp(e, false));
      el.layers.addEventListener('pointercancel', (e) => this._onLayersUp(e, true));
      el.layers.addEventListener('keydown', (e) => this._onLayersKey(e));
      el.edit.addEventListener('input', (e) => this._onPropEvent(e, false));
      el.edit.addEventListener('change', (e) => this._onPropEvent(e, true));
      el.shirt.addEventListener('input', (e) => this._onShirtEvent(e, false));
      el.shirt.addEventListener('change', (e) => this._onShirtEvent(e, true));
      el.nameInput.addEventListener('change', () => this._setName(el.nameInput.value, true));
      el.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.nameInput.blur(); });
      el.fImages.addEventListener('change', () => {
        const files = Array.from(el.fImages.files || []);
        const place = !!this._pendingPlace;
        el.fImages.value = '';
        if (files.length) this._addFiles(files, place);
      });
      el.fJson.addEventListener('change', async () => {
        const f = el.fJson.files && el.fJson.files[0];
        el.fJson.value = '';
        if (!f) return;
        try { await this.loadDesign(await f.text()); this._toast('Design opened', 'ok'); } catch (err) { this._error('Could not open this file', err); }
      });
      el.fBg.addEventListener('change', () => {
        const f = el.fBg.files && el.fBg.files[0];
        el.fBg.value = '';
        if (f) this.setBackground({ type: 'image', image: f }).catch((err) => this._error('Could not use this image', err));
      });
      const dx = el.dlgExport;
      dx.addEventListener('click', (e) => {
        const f = e.target.closest('.fmt');
        if (f) { this._readExportDialog(); this._exportOpts.format = f.dataset.fmt; this._syncExportDialog(); return; }
        const c = e.target.closest('[data-content]');
        if (c) { this._readExportDialog(); this._exportOpts.content = c.dataset.content; this._syncExportDialog(); }
      });
      dx.addEventListener('change', () => { this._readExportDialog(); this._syncExportDialog(); });
      dx.querySelector('.ex-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._exportFromDialog(false); }
      });
      this._bindFileDrop();
    }

    _onClick(e) {
      const el = e.target.closest && e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      this._action(el.dataset.act, el);
    }

    _action(act, el) {
      const ro = this.ui.readonly;
      switch (act) {
        case 'undo': this.undo(); break;
        case 'redo': this.redo(); break;
        case 'toggle-guides': this.ui.guides = !this.ui.guides; this._syncToggles(); this._requestRender(); break;
        case 'toggle-clip': this.ui.clip = !this.ui.clip; this._syncToggles(); this._requestRender(); this._thumbsSoon(); break;
        case 'new': if (!ro) this._newDesign(false); break;
        case 'open': if (!ro) this._el.fJson.click(); break;
        case 'save': if (!ro) this._saveProject(); break;
        case 'export': this._openExportDialog(); break;
        case 'help': this._showDialog(this._el.dlgHelp); break;
        case 'add-images': if (!ro) { this._pendingPlace = !!el.closest('.stage'); this._el.fImages.click(); } break;
        case 'load-samples': this._loadSamples(); break;
        case 'lib-remove': this._removeFromLibrary(el.dataset.id); break;
        case 'side': this.setView(el.dataset.side); break;
        case 'zoom-in': this._zoomCenter(1.25); break;
        case 'zoom-out': this._zoomCenter(0.8); break;
        case 'zoom-fit': this.zoomToFit(); break;
        case 'tab': this._setTab(el.dataset.tab); break;
        case 'layer-vis':
        case 'layer-lock': {
          const li = el.closest('.layer');
          const T = li && this._layerById(li.dataset.id);
          if (!T || ro) break;
          if (act === 'layer-vis') T.visible = !T.visible; else T.locked = !T.locked;
          this._commit(act);
          this._requestRender();
          break;
        }
        case 'shirt-color': this._setShirtColor(el.dataset.color, true); break;
        case 'bg-color': this._setBackground(Object.assign({}, this.state.background, { type: this.state.background.type === 'gradient' ? 'gradient' : 'solid', color: el.dataset.color }), true); break;
        case 'bg-type': {
          const type = el.dataset.type;
          if (type === 'image' && !this.state.background.image) { this._el.fBg.click(); break; }
          this._setBackground(Object.assign({}, this.state.background, { type }), true);
          break;
        }
        case 'bg-image': this._el.fBg.click(); break;
        case 'bg-image-clear': this._setBackground(Object.assign({}, this.state.background, { type: 'solid', image: null }), true); break;
        case 'units': this._setUnits(el.dataset.unit); break;
        case 'pick-cancel': this._setEyedropper(false); break;
        case 'export-go': this._exportFromDialog(false); break;
        case 'export-copy': this._exportFromDialog(true); break;
        default: {
          const L = this._sel();
          if (L && !ro) this._layerAction(act, L, el);
        }
      }
    }

    _layerAction(act, L, el) {
      const done = (reason) => { this._commit(reason); this._afterEdit(); };
      switch (act) {
        case 'dup': this._duplicate(L); break;
        case 'delete': this._deleteLayer(L); break;
        case 'forward': this._reorder(L, 'forward'); break;
        case 'backward': this._reorder(L, 'backward'); break;
        case 'to-front': this._reorder(L, 'front'); break;
        case 'to-back': this._reorder(L, 'back'); break;
        case 'copy-side': this._copyToOtherSide(L); break;
        case 'center-h': this._align(L, 'center-h'); break;
        case 'center-v': this._align(L, 'center-v'); break;
        case 'align-top': this._align(L, 'top'); break;
        case 'fit-area': this._align(L, 'fit'); break;
        case 'rot-l': L.rotation = normDeg(L.rotation - 90); done('rotate'); break;
        case 'rot-r': L.rotation = normDeg(L.rotation + 90); done('rotate'); break;
        case 'flip-h': L.flipX = !L.flipX; done('flip'); break;
        case 'flip-v': L.flipY = !L.flipY; done('flip'); break;
        case 'lock-aspect': L.lockAspect = !L.lockAspect; done('lock-aspect'); break;
        case 'sel-vis': L.visible = !L.visible; done('visibility'); break;
        case 'sel-lock': L.locked = !L.locked; done('lock'); break;
        case 'bg-mode': L.bg.mode = el.dataset.mode === 'remove' ? 'remove' : 'keep'; done('bg-mode'); break;
        case 'bg-quick':
        case 'auto-key': {
          const a = this.assets.get(L.asset);
          const info = a && a.bgInfo;
          if (info && info.transparent) { this._toast('This image already has a transparent background', 'info', 3200); break; }
          if (info && info.color) L.bg.color = info.color;
          L.bg.mode = 'remove';
          done('bg-auto');
          break;
        }
        case 'pick-color': this._setEyedropper(!this.ui.eyedropper); break;
        case 'trim': this._trim(L); break;
        case 'untrim': {
          const a = this.assets.get(L.asset);
          if (a) { this._applyCrop(L, { x: 0, y: 0, w: a.width, h: a.height }); done('untrim'); }
          break;
        }
        default: break;
      }
    }

    async _removeFromLibrary(id) {
      if (this.ui.readonly || !id) return;
      const uses = this._usage().get(id) || 0;
      if (uses && !(await this._confirm(`Remove this image? It is used ${uses} time${uses > 1 ? 's' : ''} on the shirt and will be removed from there too.`, 'Remove'))) return;
      this.state.library = this.state.library.filter((x) => x !== id);
      for (const s of SIDES) this.state.sides[s] = this.state.sides[s].filter((L) => L.asset !== id);
      if (this.ui.selected && !this._sel()) this._select(null);
      this._commit('remove-image');
      this._requestRender();
    }

    /* ------------------------------------------------------------------ *
     * panels
     * ------------------------------------------------------------------ */

    _usage() {
      const m = new Map();
      for (const s of SIDES) for (const L of this.state.sides[s]) m.set(L.asset, (m.get(L.asset) || 0) + 1);
      return m;
    }

    _renderLibrary(force) {
      const el = this._el;
      const ids = this.state.library.filter((id) => this.assets.has(id));
      const use = this._usage();
      const hasSamples = !!(this._samples && this._samples.length);
      const sig = ids.map((id) => id + ':' + (use.get(id) || 0)).join(',') + '|' + hasSamples;
      if (force || sig !== this._sigLib) {
        this._sigLib = sig;
        el.lib.innerHTML = ids.map((id) => {
          const a = this.assets.get(id), n = use.get(id) || 0, nm = esc(a.name);
          return `<div class="lib-item checker" role="listitem" tabindex="0" data-id="${esc(id)}" title="${nm} · ${a.width}×${a.height}px — drag onto the shirt or click to place" aria-label="${nm} — press Enter to place it on the shirt">` +
            `<img src="${esc(a.thumb)}" alt="" draggable="false">${n ? `<span class="uses" title="Used ${n}×">${n}</span>` : ''}` +
            `<button class="lib-del" type="button" data-act="lib-remove" data-id="${esc(id)}" title="Remove from library" aria-label="Remove ${nm}">${icon('close', 13)}</button></div>`;
        }).join('');
      }
      el.samplesBtn.hidden = !hasSamples || ids.length > 0;
      el.libHint.hidden = !ids.length;
    }

    _renderLayers(force) {
      const el = this._el, side = this.ui.view, arr = this.state.sides[side];
      const rows = arr.slice().reverse().map((L) => ({ L, warn: this._layerWarnings(L) }));
      const sig = side + '|' + rows.map(({ L, warn }) => [L.id, L.asset, L.name, L.visible, L.locked, warn.length].join(':')).join(',');
      el.sideName.textContent = side === 'front' ? 'Front' : 'Back';
      el.layerCount.textContent = arr.length ? `${arr.length} image${arr.length > 1 ? 's' : ''}` : '';
      el.layersEmpty.hidden = arr.length > 0;
      if (force || sig !== this._sigLayers) {
        this._sigLayers = sig;
        el.layers.innerHTML = rows.map(({ L, warn }) => {
          const a = this.assets.get(L.asset), nm = esc(L.name);
          return `<li class="layer${L.visible ? '' : ' is-hidden'}" data-id="${esc(L.id)}" role="option" tabindex="-1" aria-selected="false">` +
            `<span class="grip" title="Drag to reorder">${icon('grip', 14)}</span>` +
            `<span class="lthumb"><img class="checker" src="${a ? esc(a.thumb) : ''}" alt="" draggable="false">` +
            (warn.length ? `<span class="lwarn" title="${esc(warn.join('\n'))}" aria-label="${esc(warn.join('. '))}">!</span>` : '') + '</span>' +
            `<span class="lname" title="${nm}">${nm}</span>` +
            `<button class="ib sm" type="button" data-act="layer-vis" title="${L.visible ? 'Hide' : 'Show'}" aria-label="${L.visible ? 'Hide' : 'Show'} ${nm}">${icon(L.visible ? 'eye' : 'eyeOff', 15)}</button>` +
            `<button class="ib sm" type="button" data-act="layer-lock" title="${L.locked ? 'Unlock' : 'Lock'}" aria-label="${L.locked ? 'Unlock' : 'Lock'} ${nm}" aria-pressed="${L.locked}">${icon(L.locked ? 'lock' : 'unlock', 15)}</button></li>`;
        }).join('');
      }
      this._syncLayerSelection();
    }

    _syncLayerSelection() {
      let any = false;
      for (const li of this._el.layers.querySelectorAll('.layer')) {
        const on = li.dataset.id === this.ui.selected;
        any = any || on;
        li.classList.toggle('sel', on);
        li.setAttribute('aria-selected', String(on));
        li.tabIndex = on ? 0 : -1;
      }
      const first = this._el.layers.querySelector('.layer');
      if (!any && first) first.tabIndex = 0;
      const dot = this._sr.querySelector('.tabs .dot');
      if (dot) dot.hidden = !this.ui.selected;
    }

    _setVal(prop, value) {
      for (const inp of this._el.edit.querySelectorAll(`[data-prop="${prop}"]`)) {
        if (this._sr.activeElement === inp && (inp.type === 'number' || inp.type === 'text')) continue;
        if (inp.type === 'checkbox') inp.checked = !!value;
        else if (String(inp.value) !== String(value)) inp.value = value;
      }
    }

    _setIcon(btn, name, size) {
      if (btn.dataset.icon === name) return;
      btn.dataset.icon = name;
      const svg = btn.querySelector('svg');
      const tmp = document.createElement('span');
      tmp.innerHTML = icon(name, size);
      if (svg) svg.replaceWith(tmp.firstChild); else btn.prepend(tmp.firstChild);
    }

    _syncProps() {
      const p = this._el.edit, L = this._sel();
      p.querySelector('.empty-sel').hidden = !!L;
      p.querySelector('.sel-props').hidden = !L;
      p.querySelector('.sel-head').hidden = !L;
      if (!L) return;
      const a = this.assets.get(L.asset);
      const side = this._sideOf(L.id) || this.ui.view;
      const sd = this.template.sides[side];
      const bb = this._aabb(L);
      const step = this.ui.units === 'cm' ? '0.1' : '0.05';
      for (const inp of p.querySelectorAll('[data-prop="px"],[data-prop="py"],[data-prop="pw"],[data-prop="ph"]')) inp.step = step;
      this._setVal('name', L.name);
      this._setVal('px', this._num(L.x - ART / 2));
      this._setVal('py', this._num(bb.minY - sd.collarY));
      this._setVal('pw', this._num(L.w));
      this._setVal('ph', this._num(L.h));
      this._setVal('rotation', Math.round(L.rotation));
      this._setVal('rotationNum', roundTo(L.rotation, 1));
      this._setVal('opacity', Math.round(L.opacity * 100));
      p.querySelector('.o-opacity').textContent = Math.round(L.opacity * 100) + '%';
      this._setVal('blend', L.blend);
      const asp = p.querySelector('[data-act="lock-aspect"]');
      asp.setAttribute('aria-pressed', String(L.lockAspect));
      this._setIcon(asp, L.lockAspect ? 'link' : 'unlink', 15);
      for (const b of p.querySelectorAll('[data-act="bg-mode"]')) b.setAttribute('aria-pressed', String(b.dataset.mode === L.bg.mode));
      p.querySelector('.bg-remove').hidden = L.bg.mode !== 'remove';
      this._setVal('keyColor', L.bg.color);
      this._setVal('tolerance', Math.round(L.bg.tolerance));
      p.querySelector('.o-tol').textContent = Math.round(L.bg.tolerance);
      this._setVal('softness', Math.round(L.bg.softness));
      p.querySelector('.o-soft').textContent = Math.round(L.bg.softness);
      this._setVal('edgesOnly', L.bg.edgesOnly);
      this._setVal('fillOn', !!L.fill);
      this._setVal('fill', L.fill || this._lastFill || '#ffffff');
      p.querySelector('[data-act="untrim"]').hidden = !L.crop;
      const info = a && a.bgInfo;
      const callout = p.querySelector('.bg-callout');
      callout.hidden = !(L.bg.mode === 'keep' && info && !info.transparent && info.coverage > 0.8);
      if (!callout.hidden) callout.querySelector('.chip').style.background = info.color;
      p.querySelector('.print-info').innerHTML = this._printInfoHTML(L, a);
      p.querySelector('.side-copy span').textContent = `Copy to ${side === 'front' ? 'back' : 'front'}`;
      const vis = p.querySelector('[data-act="sel-vis"]');
      this._setIcon(vis, L.visible ? 'eye' : 'eyeOff', 16);
      vis.title = L.visible ? 'Hide' : 'Show';
      const lock = p.querySelector('[data-act="sel-lock"]');
      this._setIcon(lock, L.locked ? 'lock' : 'unlock', 16);
      lock.title = L.locked ? 'Unlock position' : 'Lock position';
      lock.setAttribute('aria-pressed', String(L.locked));
      for (const u of p.querySelectorAll('.ul')) u.textContent = this.ui.units;
      p.querySelector('.unit-note').textContent = this.ui.units === 'cm' ? 'centimetres' : 'inches';
      for (const inp of p.querySelectorAll('[data-prop="px"],[data-prop="py"],[data-prop="pw"],[data-prop="ph"],[data-prop="rotation"],[data-prop="rotationNum"]')) inp.disabled = L.locked;
    }

    _printInfoHTML(L, a) {
      const dpi = this._effectiveDPI(L);
      const vector = a && a.vector && !this._needsProcessing(L);
      let q;
      if (vector) q = '<b class="ok">Vector — sharp at any size</b>';
      else if (dpi >= 200) q = `<b class="ok">${Math.round(dpi)} DPI · great</b>`;
      else if (dpi >= 150) q = `<b class="meh">${Math.round(dpi)} DPI · good</b>`;
      else q = `<b class="bad">${Math.round(dpi)} DPI · low</b>`;
      const warns = this._layerWarnings(L).filter((w) => !/^Low resolution/.test(w));
      if (!vector && dpi < 150) warns.unshift('Use a larger image or print it smaller for a sharp result.');
      return `<div class="stat"><span>Print size</span><b>${this._fmtLen(L.w)} × ${this._fmtLen(L.h)} ${this.ui.units}</b></div>` +
        `<div class="stat"><span>Quality</span>${q}</div>` +
        warns.map((w) => `<div class="warnline">${icon('warn', 14)}<span>${esc(w)}</span></div>`).join('');
    }

    _onPropEvent(e, commit) {
      const t = e.target, prop = t.dataset && t.dataset.prop;
      if (!prop) return;
      const L = this._sel();
      if (!L || this.ui.readonly) return;
      const typed = t.type === 'number' || (t.type === 'text' && prop !== 'name');
      if (typed && !commit) return; // numbers apply on Enter / blur
      const v = parseFloat(t.value), ok = isFinite(v);
      const sd = this.template.sides[this._sideOf(L.id) || this.ui.view];
      switch (prop) {
        case 'name':
          L.name = t.value.slice(0, 80) || 'Image';
          if (!commit) { this._renderLayers(); return; }
          break;
        case 'px': if (ok) L.x = ART / 2 + this._fromLen(v); break;
        case 'py': if (ok) L.y += sd.collarY + this._fromLen(v) - this._aabb(L).minY; break;
        case 'pw': if (ok && v > 0) { const w = Math.max(MIN_SIZE, this._fromLen(v)); if (L.lockAspect) L.h *= w / L.w; L.w = w; } break;
        case 'ph': if (ok && v > 0) { const h = Math.max(MIN_SIZE, this._fromLen(v)); if (L.lockAspect) L.w *= h / L.h; L.h = h; } break;
        case 'rotation':
        case 'rotationNum': if (ok) L.rotation = normDeg(v); break;
        case 'opacity': if (ok) L.opacity = clamp(v / 100, 0, 1); break;
        case 'blend': L.blend = BLEND_OP[t.value] ? t.value : 'normal'; break;
        case 'keyColor': L.bg.color = normHex(t.value, L.bg.color); L.bg.mode = 'remove'; break;
        case 'tolerance': if (ok) L.bg.tolerance = clamp(v, 0, 100); break;
        case 'softness': if (ok) L.bg.softness = clamp(v, 0, 100); break;
        case 'edgesOnly': L.bg.edgesOnly = t.checked; break;
        case 'fillOn': L.fill = t.checked ? this._lastFill || '#ffffff' : null; break;
        case 'fill': this._lastFill = normHex(t.value, '#ffffff'); L.fill = this._lastFill; break;
        default: return;
      }
      this._requestRender();
      this._syncOverlay();
      if (commit) { this._commit('edit'); this._syncProps(); } else this._syncPropsSoon();
    }

    _onShirtEvent(e, commit) {
      const t = e.target, cl = t.classList;
      if (cl.contains('shirt-color')) {
        const hex = normHex(t.value);
        if (hex) this._setShirtColor(hex, commit);
      } else if (cl.contains('shirt-hex')) {
        if (!commit) return;
        const hex = normHex(t.value);
        if (hex) this._setShirtColor(hex, true); else this._syncShirtPanel(true);
      } else if (cl.contains('shirt-shading')) {
        this.state.shirt.shading = t.checked;
        this._requestRender();
        this._thumbsSoon();
        this._commit('shading');
      } else if (cl.contains('bg-c1') || cl.contains('bg-hex1') || cl.contains('bg-c2') || cl.contains('bg-hex2')) {
        const isHex = cl.contains('bg-hex1') || cl.contains('bg-hex2');
        if (isHex && !commit) return;
        const hex = normHex(t.value);
        if (!hex) { this._syncShirtPanel(true); return; }
        const outer = cl.contains('bg-c2') || cl.contains('bg-hex2');
        const bg = this.state.background;
        this._setBackground(Object.assign({}, bg, outer ? { type: 'gradient', color2: hex } : { type: bg.type === 'gradient' ? 'gradient' : 'solid', color: hex }), commit);
      } else if (cl.contains('print-size')) {
        if (commit) this._setPrintSizeString(t.value, true);
      }
    }

    _syncShirtPanel(force) {
      const p = this._el.shirt, st = this.state, c = st.shirt.color;
      for (const b of p.querySelectorAll('.shirt-sw .sw')) b.setAttribute('aria-pressed', String(b.dataset.color === c));
      const named = SHIRT_COLORS.find(([, v]) => v === c);
      p.querySelector('.shirt-name').textContent = named ? named[0] : c.toUpperCase();
      this._setInput(p.querySelector('.shirt-color'), c, force);
      this._setInput(p.querySelector('.shirt-hex'), c.toUpperCase(), force);
      p.querySelector('.shirt-shading').checked = st.shirt.shading;
      const bg = st.background;
      for (const b of p.querySelectorAll('[data-act="bg-type"]')) b.setAttribute('aria-pressed', String(b.dataset.type === bg.type));
      p.querySelector('.bg-colors').hidden = !(bg.type === 'solid' || bg.type === 'gradient');
      p.querySelector('.bg-g2').hidden = bg.type !== 'gradient';
      p.querySelector('.bg-image-opts').hidden = bg.type !== 'image';
      p.querySelector('[data-act="bg-image-clear"]').hidden = !bg.image;
      p.querySelector('.bg-note').hidden = bg.type !== 'transparent';
      for (const b of p.querySelectorAll('.bg-sw .sw')) b.setAttribute('aria-pressed', String(b.dataset.color === bg.color));
      this._setInput(p.querySelector('.bg-c1'), bg.color, force);
      this._setInput(p.querySelector('.bg-hex1'), bg.color.toUpperCase(), force);
      this._setInput(p.querySelector('.bg-c2'), bg.color2, force);
      this._setInput(p.querySelector('.bg-hex2'), bg.color2.toUpperCase(), force);
      const sel = p.querySelector('.print-size');
      const ps = `${st.printSize.w}x${st.printSize.h}`;
      if (!PRINT_AREAS.some(([v]) => v === ps)) {
        let opt = sel.querySelector('.custom-opt');
        if (!opt) { opt = document.createElement('option'); opt.className = 'custom-opt'; sel.appendChild(opt); }
        opt.value = ps;
        opt.textContent = `${st.printSize.w} × ${st.printSize.h} in — custom`;
      }
      sel.value = ps;
      for (const b of p.querySelectorAll('[data-act="units"]')) b.setAttribute('aria-pressed', String(b.dataset.unit === this.ui.units));
    }

    _setInput(inp, v, force) {
      if (!inp) return;
      if (!force && this._sr.activeElement === inp && inp.type === 'text') return;
      if (inp.value !== v) inp.value = v;
    }

    _syncHistory() {
      this._sr.querySelector('[data-act="undo"]').disabled = !this.canUndo;
      this._sr.querySelector('[data-act="redo"]').disabled = !this.canRedo;
    }

    _syncToggles() {
      this._sr.querySelector('[data-act="toggle-guides"]').setAttribute('aria-pressed', String(this.ui.guides));
      this._sr.querySelector('[data-act="toggle-clip"]').setAttribute('aria-pressed', String(this.ui.clip));
    }

    _refreshPanels() {
      this._renderLibrary();
      this._renderLayers();
      this._syncSides();
      this._syncProps();
      this._syncHistory();
      this._syncOverlay();
    }

    _refreshAll() {
      this._el.nameInput.value = this.state.name;
      this._syncShirtPanel(true);
      this._renderLibrary(true);
      this._renderLayers(true);
      this._syncSides();
      this._syncProps();
      this._syncHistory();
      this._syncToggles();
      this._syncZoom();
      this._syncOverlay();
      this._requestRender();
      this._thumbsSoon();
    }

    /* ------------------------------------------------------------------ *
     * units
     * ------------------------------------------------------------------ */

    _len(mu) { const inch = mu / this.template.pxPerInch; return this.ui.units === 'cm' ? inch * 2.54 : inch; }
    _fromLen(v) { return (this.ui.units === 'cm' ? v / 2.54 : v) * this.template.pxPerInch; }
    _num(mu) { return roundTo(this._len(mu), this.ui.units === 'cm' ? 1 : 2); }
    _fmtLen(mu) { return this._len(mu).toFixed(this.ui.units === 'cm' ? 1 : 2); }
    _fmtSigned(mu) {
      const v = this._len(mu);
      const s = Math.abs(v).toFixed(this.ui.units === 'cm' ? 1 : 2);
      return (+s === 0 ? '' : v > 0 ? '+' : '−') + s;
    }

    /* ------------------------------------------------------------------ *
     * history
     * ------------------------------------------------------------------ */

    _snapshot() {
      const s = this.state;
      return JSON.stringify({ shirt: s.shirt, background: s.background, printSize: s.printSize, sides: s.sides, library: s.library });
    }

    _resetHistory() {
      this._history = { stack: [this._snapshot()], index: 0 };
      this._syncHistory();
    }

    _commit(reason = 'edit') {
      this._commitSoon.cancel();
      const snap = this._snapshot(), h = this._history;
      if (h.stack[h.index] !== snap) {
        h.stack.length = h.index + 1;
        h.stack.push(snap);
        if (h.stack.length > MAX_HISTORY) h.stack.splice(0, h.stack.length - MAX_HISTORY);
        h.index = h.stack.length - 1;
        this._dirty = true;
        this._emitChangeSoon(reason);
        this._autosaveSoon();
        this._thumbsSoon();
      }
      this._refreshPanels();
    }

    _restoreSnapshot(snap) {
      const s = JSON.parse(snap);
      Object.assign(this.state, { shirt: s.shirt, background: s.background, printSize: s.printSize, sides: s.sides, library: s.library });
      this._drag = null;
      this._dirty = true;
      if (this.ui.selected && !this._sel()) this._select(null);
      this._refreshAll();
    }

    _summary() {
      const s = this.state;
      return {
        name: s.name, shirtColor: s.shirt.color, background: s.background.type,
        printArea: { width: s.printSize.w, height: s.printSize.h },
        front: s.sides.front.length, back: s.sides.back.length,
        canUndo: this.canUndo, canRedo: this.canRedo,
      };
    }

    _emit(type, detail, cancelable = false) {
      return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
    }

    /* ------------------------------------------------------------------ *
     * export
     * ------------------------------------------------------------------ */

    _openExportDialog() {
      const d = this._el.dlgExport, o = this._exportOpts;
      d.querySelector('.ex-name').value = slug(o.filenameUser || this.state.name);
      d.querySelector('.ex-side-sel').value = o.side;
      d.querySelector('.ex-width-sel').value = String(o.width);
      d.querySelector('.ex-dpi-sel').value = String(o.dpi);
      d.querySelector('.ex-q').value = String(o.quality);
      d.querySelector('.ex-page-sel').value = o.page;
      d.querySelector('.ex-transp-cb').checked = !!o.transparent;
      d.querySelector('.ex-sheets-cb').checked = !!o.sheets;
      this._syncExportDialog();
      this._showDialog(d);
    }

    _readExportDialog() {
      const d = this._el.dlgExport, o = this._exportOpts;
      o.side = d.querySelector('.ex-side-sel').value;
      o.width = +d.querySelector('.ex-width-sel').value || 2000;
      o.dpi = +d.querySelector('.ex-dpi-sel').value || 300;
      o.quality = +d.querySelector('.ex-q').value || 92;
      o.page = d.querySelector('.ex-page-sel').value;
      o.transparent = d.querySelector('.ex-transp-cb').checked;
      o.sheets = d.querySelector('.ex-sheets-cb').checked;
      o.filename = d.querySelector('.ex-name').value || this.state.name;
      return o;
    }

    _syncExportDialog() {
      const d = this._el.dlgExport, o = this._exportOpts, f = o.format;
      for (const b of d.querySelectorAll('.fmt')) b.setAttribute('aria-pressed', String(b.dataset.fmt === f));
      for (const b of d.querySelectorAll('[data-content]')) b.setAttribute('aria-pressed', String(b.dataset.content === o.content));
      const raster = f === 'png' || f === 'jpeg' || f === 'webp';
      const print = raster && o.content === 'print';
      const show = (sel, on) => { d.querySelector(sel).hidden = !on; };
      show('.ex-content', raster);
      show('.ex-side', raster || f === 'svg');
      show('.ex-width', (raster && !print) || f === 'svg' || f === 'zip');
      show('.ex-dpi', print || (f === 'pdf' && o.sheets) || f === 'zip');
      show('.ex-quality', f === 'jpeg' || f === 'webp');
      show('.ex-page', f === 'pdf');
      show('.ex-transp', (f === 'png' || f === 'webp' || f === 'svg') && !print);
      show('.ex-sheets', f === 'pdf');
      const sideSel = d.querySelector('.ex-side-sel');
      sideSel.querySelector('option[value="combined"]').hidden = print;
      if (print && o.side === 'combined') { o.side = 'both'; sideSel.value = 'both'; }
      const canCopy = !!(global.navigator && navigator.clipboard && global.ClipboardItem);
      d.querySelector('.ex-copy').hidden = !(canCopy && raster && o.side !== 'both');
      d.querySelector('.ex-note').textContent = this._exportNote(o);
    }

    _exportNote(o) {
      const ps = this.state.printSize;
      if (o.format === 'pdf') return `One mockup page per side with exact placement measurements${o.sheets ? `, plus true-size ${ps.w} × ${ps.h} in print sheets at ${o.dpi} DPI` : ''}.`;
      if (o.format === 'zip') return `Front, back and side-by-side mockups (PNG + SVG), print-ready artwork at ${o.dpi} DPI, a PDF and the editable design file.`;
      if (o.format === 'svg') return 'Vector shirt with your images embedded — opens in Illustrator, Inkscape, Figma and any browser.';
      if (o.content === 'print') {
        return `Artwork only, true size ${ps.w} × ${ps.h} in = ${Math.round(ps.w * o.dpi)} × ${Math.round(ps.h * o.dpi)} px at ${o.dpi} DPI (embedded)${o.format === 'jpeg' ? ', on white' : ', transparent'}. Blend modes are mockup-only — use “Remove colour” for print transparency.`;
      }
      const n = o.side === 'combined' ? 2 : 1;
      const files = o.side === 'both' ? ' (2 files)' : '';
      return `Shirt mockup, ${o.width * n} × ${o.width} px${files}${o.transparent && o.format !== 'jpeg' ? ', transparent background' : ''}.`;
    }

    async _exportFromDialog(copy) {
      const o = Object.assign({}, this._readExportDialog());
      this._exportOpts.filenameUser = o.filename;
      if (copy) {
        try {
          const one = Object.assign({}, o, { format: 'png', side: o.side === 'both' ? 'current' : o.side });
          const blob = this.export(one).then((files) => files[0].blob);
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          this._toast('Image copied to the clipboard', 'ok');
        } catch (err) { this._error('Could not copy the image', err); }
        return;
      }
      this._el.dlgExport.close();
      try {
        const files = await this.download(o);
        if (files.length) this._toast(files.length > 1 ? `Exported ${files.length} files` : `Exported ${files[0].filename}`, 'ok', 3200);
      } catch (err) { this._error('Export failed', err); }
    }

    async _exportFiles(o, base) {
      const f = o.format;
      const sides = o.side === 'front' || o.side === 'back' ? [o.side] : o.side === 'both' || o.side === 'combined' ? SIDES.slice() : [this.ui.view];
      if (f === 'json') return [{ blob: new Blob([JSON.stringify(this.getDesign(), null, 2)], { type: 'application/json' }), filename: `${base}.tshirt.json`, format: f }];
      if (f === 'pdf') return [{ blob: await this._buildPDF(o), filename: `${base}.pdf`, format: f }];
      if (f === 'zip') return [{ blob: await this._buildZip(o, base), filename: `${base}.zip`, format: f }];
      if (f === 'svg') {
        if (o.side === 'combined') return [{ blob: this._svgBlob(SIDES, o), filename: `${base}-front-back.svg`, format: f }];
        return sides.map((s) => ({ blob: this._svgBlob([s], o), filename: `${base}-${s}.svg`, side: s, format: f }));
      }
      if (!/^(png|jpeg|webp)$/.test(f)) throw new Error('Unknown export format: ' + f);
      const mime = 'image/' + f, ext = f === 'jpeg' ? 'jpg' : f;
      const q = clamp(+o.quality || 92, 50, 100) / 100;
      const opaque = f === 'jpeg';
      const out = [];
      if (o.content === 'print') {
        for (const s of sides) {
          const c = this._renderPrint(s, o.dpi, opaque);
          let blob = await canvasToBlob(c, mime, q);
          if (f === 'png') blob = await pngWithDPI(blob, c._dpi);
          else if (f === 'jpeg') blob = await jpegWithDPI(blob, c._dpi);
          out.push({ blob, filename: `${base}-${s}-print.${ext}`, side: s, format: f });
        }
        return out;
      }
      const transparent = !!o.transparent && !opaque;
      if (o.side === 'combined') {
        return [{ blob: await canvasToBlob(this._renderMockup(SIDES, o.width, transparent, opaque), mime, q), filename: `${base}-front-back.${ext}`, format: f }];
      }
      for (const s of sides) out.push({ blob: await canvasToBlob(this._renderMockup([s], o.width, transparent, opaque), mime, q), filename: `${base}-${s}.${ext}`, side: s, format: f });
      return out;
    }

    _renderMockup(sides, width = 2000, transparent = false, opaque = false) {
      width = clamp(Math.round(+width || 2000), 100, 8000);
      const { canvas, k } = makeSafeCanvas(width * sides.length, width);
      if (k < 0.999) this._toast('The image was made smaller to fit this device’s limits', 'info', 3600);
      const ctx = canvas.getContext('2d'), H = canvas.height, s = H / ART;
      const bg = this.state.background;
      if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, H); }
      if (!transparent && bg.type !== 'transparent') {
        const a = bg.type === 'image' && bg.image ? this.assets.get(bg.image) : null;
        drawBackground(ctx, bg, 0, 0, canvas.width, H, a && a.img);
      }
      sides.forEach((side, i) => {
        ctx.setTransform(s, 0, 0, s, i * H, 0);
        this._drawSide(ctx, side, s);
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return canvas;
    }

    /** Artwork only, at true print size. canvas._dpi holds the real resolution. */
    _renderPrint(side, dpi = 300, opaque = false) {
      dpi = clamp(+dpi || 300, 72, 600);
      const pa = this._printArea(side), ppi = this.template.pxPerInch;
      const wantW = Math.round((pa.w / ppi) * dpi), wantH = Math.round((pa.h / ppi) * dpi);
      const { canvas, k } = makeSafeCanvas(wantW, wantH);
      if (k < 0.999) this._toast(`Print file reduced to ${Math.round(dpi * k)} DPI to fit this device’s limits`, 'info', 4200);
      const ctx = canvas.getContext('2d');
      if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      const s = canvas.width / pa.w;
      ctx.setTransform(s, 0, 0, s, -pa.x * s, -pa.y * s);
      for (const L of this.state.sides[side]) {
        if (!L.visible) continue;
        const b = this._bitmap(L);
        if (b) drawLayerBitmap(ctx, L, b, { ignoreBlend: true });
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      canvas._dpi = (dpi * canvas.width) / wantW;
      return canvas;
    }

    _svgBlob(sides, o = {}) {
      const images = new Map(), urls = new Map();
      for (const s of sides) {
        for (const L of this.state.sides[s]) {
          if (!L.visible) continue;
          const b = this._bitmap(L), a = this.assets.get(L.asset);
          if (!b || !a) continue;
          let href, iw, ih;
          if (b.image === a.img) { href = a.src; iw = a.width; ih = a.height; } else {
            href = urls.get(b.image) || b.image.toDataURL('image/png');
            urls.set(b.image, href);
            iw = b.iw; ih = b.ih;
          }
          images.set(L.id, { href, iw, ih, sx: b.sx, sy: b.sy, sw: b.sw, sh: b.sh });
        }
      }
      const bg = this.state.background;
      const bgA = bg.type === 'image' && bg.image ? this.assets.get(bg.image) : null;
      const svg = buildSVG({
        tpl: this.template, sides, shirtColor: this.state.shirt.color, shading: this.state.shirt.shading,
        background: bg, bgHref: bgA ? bgA.src : null, transparent: !!o.transparent, width: o.width || 1000,
        layers: { front: this.state.sides.front.filter((L) => L.visible), back: this.state.sides.back.filter((L) => L.visible) },
        images, printClip: this.ui.clip ? { front: this._printArea('front'), back: this._printArea('back') } : null, title: this.state.name,
      });
      return new Blob([svg], { type: 'image/svg+xml' });
    }

    _placementLines(side) {
      return this.state.sides[side].filter((L) => L.visible).slice().reverse().map((L) => {
        const p = this._publicLayer(L).inches;
        const xs = Math.abs(p.xFromCenter) < 0.01 ? 'centred' : `${Math.abs(p.xFromCenter).toFixed(2)} in ${p.xFromCenter < 0 ? 'left' : 'right'} of centre`;
        const rot = Math.abs(L.rotation) > 0.05 ? `, rotated ${roundTo(L.rotation, 1)}°` : '';
        const a = this.assets.get(L.asset);
        const q = a && a.vector && !this._needsProcessing(L) ? 'vector' : `${Math.round(this._effectiveDPI(L))} DPI`;
        const name = L.name.length > 40 ? L.name.slice(0, 39) + '…' : L.name;
        return `${name}: ${p.width.toFixed(2)} × ${p.height.toFixed(2)} in, ${xs}, top ${p.yBelowCollar.toFixed(2)} in below the collar${rot} (${q})`;
      });
    }

    async _buildPDF(o) {
      const [PW, PH] = o.page === 'a4' ? [595.28, 841.89] : [612, 792];
      const st = this.state, M = 42;
      const withArt = SIDES.filter((s) => st.sides[s].some((L) => L.visible));
      const mockSides = withArt.length ? withArt : [this.ui.view];
      const named = SHIRT_COLORS.find(([, v]) => v === st.shirt.color);
      const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      const grey = [0.4, 0.44, 0.52];
      const pages = [];
      for (const side of mockSides) {
        const canvas = this._renderMockup([side], 1600, false, false);
        const img = await pdfImageFromCanvas(canvas, { alpha: st.background.type === 'transparent', quality: 0.9 });
        const size = Math.min(PW - 2 * M, PH - 2 * M - 210);
        const top = PH - M;
        const draw = [
          { type: 'text', x: M, y: top - 16, size: 18, bold: true, text: `${st.name} — ${side === 'front' ? 'Front' : 'Back'}` },
          { type: 'text', x: M, y: top - 34, size: 9.5, color: grey, text: `Shirt colour: ${named ? named[0] + ' ' : ''}${st.shirt.color.toUpperCase()}   •   Print area: ${st.printSize.w} × ${st.printSize.h} in   •   ${date}` },
          { type: 'image', img, x: (PW - size) / 2, y: top - 48 - size, w: size, h: size },
        ];
        let y = top - 48 - size - 26;
        draw.push({ type: 'text', x: M, y, size: 11, bold: true, text: 'Placements' });
        y -= 16;
        const lines = this._placementLines(side);
        if (!lines.length) draw.push({ type: 'text', x: M, y, size: 9.5, color: grey, text: 'No artwork on this side.' });
        for (const line of lines) {
          if (y < M) break;
          draw.push({ type: 'text', x: M, y, size: 9, text: '•  ' + line });
          y -= 13.5;
        }
        pages.push({ w: PW, h: PH, draw });
      }
      if (o.sheets) {
        for (const side of withArt) {
          const c = this._renderPrint(side, o.dpi || 300);
          const img = await pdfImageFromCanvas(c, { lossless: true });
          const w = st.printSize.w * 72, h = st.printSize.h * 72;
          pages.push({ w, h, draw: [{ type: 'image', img, x: 0, y: 0, w, h }] });
        }
      }
      return buildPDF(pages, { title: st.name });
    }

    async _buildZip(o, base) {
      const files = [];
      const add = (name, blob) => files.push({ name, blob });
      const width = clamp(+o.width || 2000, 500, 4000);
      const withArt = SIDES.filter((s) => this.state.sides[s].some((L) => L.visible));
      for (const s of SIDES) add(`mockups/${base}-${s}.png`, await canvasToBlob(this._renderMockup([s], width), 'image/png'));
      add(`mockups/${base}-front-back.png`, await canvasToBlob(this._renderMockup(SIDES, Math.min(width, 2000)), 'image/png'));
      for (const s of SIDES) add(`mockups/${base}-${s}.svg`, this._svgBlob([s], { width: 1000 }));
      for (const s of withArt) {
        const c = this._renderPrint(s, o.dpi || 300);
        add(`print/${base}-${s}-print-${Math.round(c._dpi)}dpi.png`, await pngWithDPI(await canvasToBlob(c, 'image/png'), c._dpi));
      }
      add(`${base}.pdf`, await this._buildPDF(Object.assign({}, o, { sheets: false })));
      add(`${base}.tshirt.json`, new Blob([JSON.stringify(this.getDesign())], { type: 'application/json' }));
      add('README.txt', new Blob([this._readme(base)], { type: 'text/plain' }));
      return buildZip(files);
    }

    _readme(base) {
      const st = this.state;
      const out = [
        `${st.name}`,
        `Exported ${new Date().toISOString()} with tshirt-designer ${VERSION}`,
        '',
        `Shirt colour: ${st.shirt.color.toUpperCase()}`,
        `Print area:   ${st.printSize.w} x ${st.printSize.h} in (centred, measured from the collar seam)`,
        '',
      ];
      for (const s of SIDES) {
        out.push(`${s.toUpperCase()}`);
        const lines = this._placementLines(s);
        out.push(...(lines.length ? lines.map((l) => '  - ' + l) : ['  (no artwork)']), '');
      }
      out.push('Files', `  mockups/    shirt mockups (PNG, SVG)`, `  print/      artwork only, true size, transparent PNG with DPI set`, `  ${base}.pdf  mockups with placement specs`, `  ${base}.tshirt.json  re-open in the designer to keep editing`, '');
      return out.join('\r\n');
    }

    async _saveProject() {
      const blob = new Blob([JSON.stringify(this.getDesign())], { type: 'application/json' });
      const filename = slug(this.state.name) + '.tshirt.json';
      if (this._emit('tsd-export', { blob, filename, side: null, format: 'json', options: { format: 'json' } }, true)) downloadBlob(blob, filename, this._sr);
      this._toast('Design file saved', 'ok');
    }

    /* ------------------------------------------------------------------ *
     * autosave (opt-in: autosave="key")
     * ------------------------------------------------------------------ */

    async _autosaveNow() {
      if (!this._autosaveKey || !this._dirty) return;
      this._dirty = false;
      try { await idb.set(this._autosaveKey, this.getDesign()); } catch (err) {
        this._dirty = true;
        if (!this._autosaveWarned) { this._autosaveWarned = true; console.warn('[tshirt-designer] autosave failed', err); }
      }
    }

    async _restoreAutosave() {
      let data = null;
      try { data = await idb.get(this._autosaveKey); } catch (err) { return; }
      if (!data || data.format !== FORMAT) return;
      await this.loadDesign(data, { history: false });
      if (this._hasContent()) this._toast('Welcome back — your last design was restored', 'info', 4500, { label: 'Start new', fn: () => this._newDesign(true) });
    }

    /* ------------------------------------------------------------------ *
     * feedback: toasts, busy indicator, dialogs
     * ------------------------------------------------------------------ */

    _toast(msg, type = 'info', ms = 2600, action = null) {
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      const span = document.createElement('span');
      span.textContent = msg;
      t.appendChild(span);
      if (action) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = action.label;
        b.addEventListener('click', () => { t.remove(); action.fn(); });
        t.appendChild(b);
      }
      const box = this._el.toasts;
      box.appendChild(t);
      while (box.children.length > 3) box.firstChild.remove();
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
    }

    _error(msg, err) {
      if (err) console.warn('[tshirt-designer]', msg, err);
      const detail = err && err.message ? err.message : '';
      this._toast(detail ? `${msg}: ${detail}` : msg, 'error', 5200);
      this._emit('tsd-error', { message: msg, error: err || null });
    }

    _setBusy(on, text) {
      this._busyCount = Math.max(0, this._busyCount + (on ? 1 : -1));
      if (on && text) this._el.busyText.textContent = text;
      clearTimeout(this._busyTimer);
      if (this._busyCount > 0) this._busyTimer = setTimeout(() => { this._el.busy.hidden = false; }, 200);
      else this._el.busy.hidden = true;
    }

    _showDialog(d) {
      if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
    }

    _confirm(message, okLabel = 'OK') {
      const d = this._el.dlgConfirm;
      if (typeof d.showModal !== 'function') return Promise.resolve(global.confirm ? global.confirm(message) : true);
      d.querySelector('.cf-msg').textContent = message;
      d.querySelector('.cf-ok').textContent = okLabel;
      d.returnValue = '';
      return new Promise((resolve) => {
        const onClose = () => { d.removeEventListener('close', onClose); resolve(d.returnValue === 'ok'); };
        d.addEventListener('close', onClose);
        d.showModal();
      });
    }
  }

  customElements.define(TAG, TShirtDesigner);
  global.TShirtDesigner = TShirtDesigner;
})(typeof window !== 'undefined' ? window : undefined);
