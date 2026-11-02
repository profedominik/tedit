/*
 * End-to-end smoke tests for <tshirt-designer>.
 *
 *   npm install          (installs Playwright)
 *   npx playwright install chromium
 *   npm test
 *
 * Runs the real component in headless Chromium from file:// — no server needed.
 */
'use strict';
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const url = (p, q = '') => 'file://' + path.join(ROOT, p) + q;
const results = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n    ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

/** Inspect a PNG: dimensions and pHYs DPI. */
function pngInfo(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const info = {};
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'IHDR') { info.width = buf.readUInt32BE(i + 8); info.height = buf.readUInt32BE(i + 12); }
    if (type === 'pHYs') info.dpi = Math.round(buf.readUInt32BE(i + 8) * 0.0254);
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return info;
}

async function openDesigner(browser, query = '?autosave=0', viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url('index.html', query));
  await page.evaluate(() => document.querySelector('tshirt-designer').ready);
  return { page, errors, host: page.locator('tshirt-designer') };
}

/** Export through the public API and bring the bytes back to Node. */
async function exportFiles(page, options) {
  const files = await page.evaluate(async (opts) => {
    const d = document.querySelector('tshirt-designer');
    const out = [];
    for (const f of await d.export(opts)) {
      const bytes = new Uint8Array(await f.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      out.push({ filename: f.filename, type: f.blob.type, b64: btoa(s) });
    }
    return out;
  }, options);
  return files.map((f) => Object.assign(f, { buf: Buffer.from(f.b64, 'base64') }));
}

(async () => {
  const browser = await chromium.launch();
  console.log('tshirt-designer e2e');

  await test('boots with no errors and exposes the API', async () => {
    const { page, errors } = await openDesigner(browser);
    const info = await page.evaluate(() => {
      const d = document.querySelector('tshirt-designer');
      return { version: d.version, view: d.view, color: d.shirtColor, layers: d.getLayers().length, layout: d.shadowRoot.querySelector('.tsd').dataset.layout };
    });
    assert.equal(info.view, 'front');
    assert.equal(info.color, '#ffffff');
    assert.equal(info.layers, 0);
    assert.equal(info.layout, 'wide');
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('drag from the library onto the shirt, then move / resize / rotate with handles', async () => {
    const { page, errors, host } = await openDesigner(browser);
    await host.locator('.samples-btn').click();
    await page.waitForFunction(() => document.querySelector('tshirt-designer').shadowRoot.querySelectorAll('.lib-item').length === 4);
    const ib = await host.locator('.lib-item').first().boundingBox();
    const st = await host.locator('.stage').boundingBox();
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
    await page.mouse.down();
    await page.mouse.move(st.x + st.width / 2 + 40, st.y + st.height * 0.45, { steps: 12 });
    await page.mouse.up();
    let [L] = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.ok(L, 'a layer was created by the drop');
    // move
    let box = await host.locator('.sel-box').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 + 50, { steps: 6 });
    await page.mouse.up();
    let [M] = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.ok(M.y > L.y + 20, 'moved down');
    // resize (proportional corner)
    const se = await host.locator('.h[data-h="se"]').boundingBox();
    await page.mouse.move(se.x + 6, se.y + 6);
    await page.mouse.down();
    await page.mouse.move(se.x + 46, se.y + 46, { steps: 6 });
    await page.mouse.up();
    let [R] = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.ok(R.w > M.w * 1.1, 'wider');
    assert.ok(Math.abs(R.w / R.h - M.w / M.h) < 0.01, 'aspect ratio kept');
    // rotate with Shift → snaps to 15°
    const rh = await host.locator('.h.rot').boundingBox();
    await page.keyboard.down('Shift');
    await page.mouse.move(rh.x + rh.width / 2, rh.y + rh.height / 2);
    await page.mouse.down();
    await page.mouse.move(rh.x + 90, rh.y + 30, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    let [T] = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.notEqual(T.rotation, 0, 'rotated');
    assert.equal(T.rotation % 15, 0, 'snapped to 15°');
    // undo the rotation
    await page.keyboard.press('Control+z');
    [T] = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.equal(T.rotation, 0, 'undo restored rotation');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('keyboard: nudge, duplicate, delete, undo/redo', async () => {
    const { page, errors, host } = await openDesigner(browser);
    await page.evaluate(() => document.querySelector('tshirt-designer').addImage(window.TSD_SAMPLES[0]));
    await host.locator('.stage').focus();
    const x0 = (await page.evaluate(() => document.querySelector('tshirt-designer').selectedLayer)).x;
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Control+d');
    let ls = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.equal(ls.length, 2);
    assert.equal(Math.round(x0 - ls[0].x), 10);
    await page.keyboard.press('Delete');
    ls = await page.evaluate(() => document.querySelector('tshirt-designer').getLayers());
    assert.equal(ls.length, 1);
    await page.keyboard.press('Control+z');
    assert.equal((await page.evaluate(() => document.querySelector('tshirt-designer').getLayers())).length, 2);
    await page.keyboard.press('Control+Shift+z');
    assert.equal((await page.evaluate(() => document.querySelector('tshirt-designer').getLayers())).length, 1);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('background removal makes the backdrop transparent but keeps inner whites', async () => {
    const { page, errors } = await openDesigner(browser);
    await page.evaluate(async () => {
      const d = document.querySelector('tshirt-designer');
      const { layerId } = await d.addImage(window.TSD_SAMPLES[1]); // stamp on a white square
      d.updateLayer(layerId, { x: 500, y: 214 + 208, w: 312, h: 312, bg: { mode: 'remove' } });
    });
    const [print] = await exportFiles(page, { format: 'png', content: 'print', side: 'front', dpi: 100 });
    const alphaAt = await page.evaluate(async ({ b64, pts }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return pts.map(([fx, fy]) => { const p = ctx.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data; return [p[0], p[1], p[2], p[3]]; });
    }, { b64: print.b64, pts: [[0.5, 0.02], [0.5, 0.155], [0.5, 0.5]] });
    // the image spans 312 of 416 units vertically, starting at 0; corner = old white backdrop
    assert.equal(alphaAt[0][3], 0, 'outside the image is transparent');
    assert.equal(alphaAt[1][3], 0, 'white backdrop removed');
    assert.equal(alphaAt[2][3], 255, 'artwork kept');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('exports: PNG, print PNG with DPI, JPEG, WebP, SVG, PDF, ZIP, JSON round-trip', async () => {
    const { page, errors } = await openDesigner(browser);
    await page.evaluate(async () => {
      const d = document.querySelector('tshirt-designer');
      d.setShirtColor('#1f2a44');
      await d.addImage(window.TSD_SAMPLES[0], { side: 'front' });
      await d.addImage(window.TSD_SAMPLES[3], { side: 'back', width: 6 });
    });
    const [png] = await exportFiles(page, { format: 'png', side: 'front', width: 1200 });
    assert.deepEqual([pngInfo(png.buf).width, pngInfo(png.buf).height], [1200, 1200]);
    const combined = await exportFiles(page, { format: 'png', side: 'combined', width: 600 });
    assert.equal(pngInfo(combined[0].buf).width, 1200);
    const prints = await exportFiles(page, { format: 'png', content: 'print', side: 'both', dpi: 300 });
    assert.equal(prints.length, 2);
    assert.deepEqual(pngInfo(prints[0].buf), { width: 3600, height: 4800, dpi: 300 });
    const [jpg] = await exportFiles(page, { format: 'jpeg', side: 'back', width: 800 });
    assert.equal(jpg.buf.subarray(0, 2).toString('hex'), 'ffd8');
    const [webp] = await exportFiles(page, { format: 'webp', width: 600 });
    assert.equal(webp.buf.toString('latin1', 8, 12), 'WEBP');
    const [svg] = await exportFiles(page, { format: 'svg', side: 'front', width: 1000 });
    const svgOK = await page.evaluate(async (b64) => {
      const text = atob(b64);
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      if (doc.getElementsByTagName('parsererror').length) return 'parse error';
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
      await img.decode();
      return img.naturalWidth;
    }, svg.b64);
    assert.equal(svgOK, 1000, 'SVG parses and renders');
    const [pdf] = await exportFiles(page, { format: 'pdf', sheets: true, dpi: 150 });
    const pdfText = pdf.buf.toString('latin1');
    assert.ok(pdfText.startsWith('%PDF-1.4'));
    assert.equal((pdfText.match(/\/Type \/Page /g) || []).length, 4, '2 mockup pages + 2 print sheets');
    const startxref = +/startxref\n(\d+)/.exec(pdfText)[1];
    assert.equal(pdfText.slice(startxref, startxref + 4), 'xref', 'xref offset is correct');
    const [zip] = await exportFiles(page, { format: 'zip', dpi: 100, width: 800 });
    assert.equal(zip.buf.readUInt32LE(0), 0x04034b50, 'zip signature');
    const entries = zip.buf.readUInt16LE(zip.buf.length - 22 + 10);
    assert.ok(entries >= 9, 'zip has all files (' + entries + ')');
    const [json] = await exportFiles(page, { format: 'json' });
    const design = JSON.parse(json.buf.toString('utf8'));
    assert.equal(design.format, 'tshirt-designer');
    const roundTrip = await page.evaluate(async (data) => {
      const d = document.querySelector('tshirt-designer');
      d.reset();
      await d.loadDesign(data);
      return { front: d.getLayers('front').length, back: d.getLayers('back').length, color: d.shirtColor };
    }, design);
    assert.deepEqual(roundTrip, { front: 1, back: 1, color: '#1f2a44' });
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('download() fires a cancelable tsd-export event', async () => {
    const { page, errors } = await openDesigner(browser);
    const r = await page.evaluate(async () => {
      const d = document.querySelector('tshirt-designer');
      await d.addImage(window.TSD_SAMPLES[2]);
      let seen = null;
      d.addEventListener('tsd-export', (e) => { seen = { filename: e.detail.filename, size: e.detail.blob.size }; e.preventDefault(); }, { once: true });
      await d.download({ format: 'png', width: 400 });
      return seen;
    });
    assert.equal(r.filename, 'untitled-design-front.png');
    assert.ok(r.size > 1000);
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('autosave restores the last design after a reload', async () => {
    const { page, errors } = await openDesigner(browser, '?autosave=e2e-' + Date.now());
    await page.evaluate(async () => {
      const d = document.querySelector('tshirt-designer');
      await d.addImage(window.TSD_SAMPLES[0]);
      d.setShirtColor('#c8102e');
    });
    await page.waitForTimeout(1300);
    await page.reload();
    const r = await page.evaluate(async () => {
      const d = document.querySelector('tshirt-designer');
      await d.ready;
      return { layers: d.getLayers().length, color: d.shirtColor };
    });
    assert.deepEqual(r, { layers: 1, color: '#c8102e' });
    assert.deepEqual(errors, []);
    await page.close();
  });

  await test('layout adapts: wide → medium → stacked', async () => {
    const sizes = [[1400, 900, 'wide'], [900, 700, 'medium'], [820, 1100, 'stacked'], [390, 800, 'stacked']];
    for (const [width, height, expected] of sizes) {
      const { page, errors } = await openDesigner(browser, '?autosave=0', { width, height });
      const layout = await page.evaluate(() => document.querySelector('tshirt-designer').shadowRoot.querySelector('.tsd').dataset.layout);
      assert.equal(layout, expected, `${width}×${height}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });

  await test('embedding example and iframe bridge work', async () => {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url('examples/iframe.html'));
    await page.waitForFunction(() => document.getElementById('log').textContent.includes('tsd-ready'));
    await page.click('text=Navy shirt');
    await page.click('#png');
    await page.waitForFunction(() => document.getElementById('log').textContent.includes('received front PNG'));
    const color = await page.frames()[1].evaluate(() => document.querySelector('tshirt-designer').shirtColor);
    assert.equal(color, '#1f2a44');
    await page.goto(url('examples/dashboard.html'));
    await page.evaluate(() => document.getElementById('designer').ready);
    await page.click('[data-color="#1c1c1e"]');
    assert.equal(await page.evaluate(() => document.getElementById('designer').shirtColor), '#1c1c1e');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await browser.close();
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
