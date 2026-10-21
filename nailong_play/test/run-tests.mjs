/**
 * nailong_play 自动化验收脚本（Node 24 + Chrome DevTools Protocol）
 *
 * 用途：在无头 Chrome 中打开 http://127.0.0.1:8080，跑完整功能检查并截图。
 * 依赖：本机 Chrome、已在 8080 端口启动的静态服务器。
 *
 * 运行：node test/run-tests.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const BASE = 'http://127.0.0.1:8080';
const PORT = 9333;
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('找不到 Chrome/Edge 可执行文件');
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 页面内脚本（在浏览器里执行，不能引用本文件作用域）                    */
/* ------------------------------------------------------------------ */

async function pageDemoPhase() {
  const NF = window.__nailong_play;
  const out = { errors: [] };
  const ok = (name, cond, extra) => {
    out[name] = { pass: !!cond, extra: extra === undefined ? '' : String(extra) };
  };

  window.addEventListener('error', (e) => out.errors.push('window.error: ' + e.message));

  await NF.ready;
  const s = NF.state;
  ok('title', document.title.indexOf('nailong_play') === 0, document.title);
  ok('manifest link', !!document.querySelector('link[rel=manifest]'));
  ok('theme color', !!document.querySelector('meta[name=theme-color]'));
  ok('og share tags', !!document.querySelector('meta[property="og:title"]') &&
    !!document.querySelector('meta[property="og:image"]'));
  const mf = await fetch(document.querySelector('link[rel=manifest]').href)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  ok('manifest valid', !!(mf && mf.name && mf.start_url && mf.icons && mf.icons.length >= 2),
    mf ? mf.name + ' / ' + mf.icons.length + ' icons' : 'null');
  const iconStatus = mf ? await Promise.all(mf.icons.map((i) => fetch(i.src).then((r) => r.ok).catch(() => false))) : [];
  ok('icons reachable', iconStatus.length > 0 && iconStatus.every(Boolean), iconStatus.join(','));
  ok('demo source', s.source && s.source.kind === 'demo', s.source && s.source.kind);

  // 等辅助线稳定 + 自动应用换脸
  const t0 = performance.now();
  while (performance.now() - t0 < 6000 && !s.effect) await new Promise((r) => setTimeout(r, 100));

  ok('face detected', s.face === true);
  ok('quad created', !!s.quad);
  ok('effect applied', s.effect === true, 'after ' + Math.round(performance.now() - t0) + 'ms');

  if (s.quad) {
    const cx = s.quad.reduce((a, p) => a + p.x, 0) / 4;
    const cy = s.quad.reduce((a, p) => a + p.y, 0) / 4;
    out.quadCenter = { cx: +cx.toFixed(3), cy: +cy.toFixed(3) };
    ok('quad near center', Math.abs(cx - 0.5) < 0.18 && Math.abs(cy - 0.5) < 0.22,
      'cx=' + cx.toFixed(3) + ' cy=' + cy.toFixed(3));

    const ang = Math.atan2(s.quad[1].y - s.quad[0].y, s.quad[1].x - s.quad[0].x);
    out.quadAngle = +ang.toFixed(3);
    ok('quad not over-rotated', Math.abs(ang) < 0.22, 'angle=' + ang.toFixed(3));

    const w = Math.hypot(s.quad[1].x - s.quad[0].x, s.quad[1].y - s.quad[0].y);
    const hh = Math.hypot(s.quad[3].x - s.quad[0].x, s.quad[3].y - s.quad[0].y);
    out.quadWidth = +w.toFixed(3);
    out.quadHeight = +hh.toFixed(3);
    ok('quad width plausible', w > 0.1 && w < 0.5, w.toFixed(3));
    ok('quad height plausible', hh > 0.15 && hh < 0.65, hh.toFixed(3));
  }

  // 合成画布上应出现奶龙黄色像素
  const c = NF.composite;
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  let yellow = 0, dark = 0;
  let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (let i = 0; i < img.length; i += 4 * 7) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    if (r > 190 && g - b > 60 && g > 150 && b < 170) {
      yellow++;
      const px = (i / 4) % c.width;
      const py = Math.floor((i / 4) / c.width);
      if (px < bx0) bx0 = px;
      if (px > bx1) bx1 = px;
      if (py < by0) by0 = py;
      if (py > by1) by1 = py;
    }
    if (r < 60 && g < 60 && b < 60) dark++;
  }
  out.stickerPixels = yellow;
  out.stickerBox = { x0: bx0, x1: bx1, y0: by0, y1: by1 };
  ok('sticker rendered on composite', yellow > 200, 'yellow=' + yellow + ' dark=' + dark);

  // 画面尺寸
  const st = document.getElementById('stage').getBoundingClientRect();
  ok('stage 50% height', Math.abs(st.height / innerHeight - 0.5) < 0.02,
    (st.height / innerHeight).toFixed(3));

  return out;
}

async function pageDeepPhase() {
  const NF = window.__nailong_play;
  const s = NF.state;
  const out = { errors: [] };
  const ok = (name, cond, extra) => {
    out[name] = { pass: !!cond, extra: extra === undefined ? '' : String(extra) };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.addEventListener('error', (e) => out.errors.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => out.errors.push('reject: ' + e.reason));

  /* --- 1. 人脸定位单元测试（合成人像） --- */
  // 使用独立实例，避免与应用自身的追踪状态互相干扰
  const _tracker = NF.createFaceTracker();
  const cv = document.createElement('canvas');
  cv.width = 400;
  cv.height = 300;
  const g = cv.getContext('2d');
  g.fillStyle = '#2e7d32';
  g.fillRect(0, 0, 400, 300);
  g.fillStyle = '#e8b48f';
  g.beginPath();
  g.ellipse(200, 150, 55, 70, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#241a12';
  g.beginPath();
  g.ellipse(186, 138, 6, 4.5, 0, 0, Math.PI * 2);
  g.ellipse(214, 138, 6, 4.5, 0, 0, Math.PI * 2);
  g.fill();

  const det = _tracker.detect(cv, false);
  out.trackerDebug = _tracker.debug;
  ok('tracker returns box', !!det);
  if (det) {
    out.detect = det;
    const cx = det.x + det.w / 2;
    const cy = det.y + det.h / 2;
    ok('tracker centered', Math.abs(cx - 0.5) < 0.1 && Math.abs(cy - 0.5) < 0.12,
      'cx=' + cx.toFixed(3) + ' cy=' + cy.toFixed(3) + ' w=' + det.w.toFixed(3));
    ok('tracker width sane', det.w > 0.12 && det.w < 0.55, det.w.toFixed(3));
    ok('tracker angle level', Math.abs(det.angle) < 0.12, 'angle=' + det.angle.toFixed(3));
  }

  /* --- 1.5 拖拽四角 & 恢复自动对位 --- */
  const view = document.getElementById('view');
  const vr = view.getBoundingClientRect();
  const mm = s.map;
  const p0 = { x: vr.left + mm.x + s.quad[0].x * mm.w, y: vr.top + mm.y + s.quad[0].y * mm.h };
  const before0 = { ...s.quad[0] };
  const fire = (type, x, y) =>
    view.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, pointerType: 'mouse' })
    );
  fire('pointerdown', p0.x, p0.y);
  fire('pointermove', p0.x + 45, p0.y + 25);
  fire('pointerup', p0.x + 45, p0.y + 25);
  await wait(150);
  ok('drag switches to manual', s.manual === true);
  ok('drag moves corner', Math.abs(s.quad[0].x - before0.x) > 0.01,
    'dx=' + (s.quad[0].x - before0.x).toFixed(3));
  ok('auto-align button shown', !document.getElementById('btn-auto').classList.contains('hidden'));
  document.getElementById('btn-auto').click();
  await wait(500);
  ok('auto-align restored', s.manual === false &&
    document.getElementById('btn-auto').classList.contains('hidden'));

  /* --- 1.6 移除强度 0% → 贴纸消失 --- */
  const countYellow = () => {
    const c = NF.composite;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 5) {
      if (d[i] > 190 && d[i + 1] - d[i + 2] > 60 && d[i + 1] > 150 && d[i + 2] < 170) n++;
    }
    return n;
  };
  const rmEl = document.getElementById('r-remove');
  rmEl.value = '0';
  rmEl.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
  const zero = countYellow();
  rmEl.value = '100';
  rmEl.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);
  const full = countYellow();
  ok('removal 0% hides sticker', zero < full * 0.15, 'zero=' + zero + ' full=' + full);
  ok('removal 100% shows sticker', full > 300, 'full=' + full);

  /* --- 2. 录制 --- */
  const beforeCount = (await NF.Store.all()).length;
  NF.api.startRecording();
  await wait(300);
  ok('recording state', s.recording === true);
  ok('record button text', document.getElementById('btn-record').textContent === '停止录制',
    document.getElementById('btn-record').textContent);
  ok('rec badge visible', !document.getElementById('rec-badge').classList.contains('hidden'));
  await wait(1400);
  NF.api.stopRecording();
  await wait(1600);

  const works = await NF.Store.all();
  ok('work saved', works.length === beforeCount + 1, works.length + ' works');
  const w = works[0];
  if (w) {
    out.work = { mime: w.mime, size: w.size, duration: +w.duration.toFixed(2), w: w.width, h: w.height };
    ok('blob has data', w.blob && w.blob.size > 2000, w.blob && w.blob.size);
    ok('mime recorded', /webm|mp4/.test(w.mime), w.mime);
    ok('duration plausible', w.duration > 1 && w.duration < 12, w.duration.toFixed(2));
    ok('thumbnail captured', typeof w.thumb === 'string' && w.thumb.startsWith('data:image/jpeg'),
      (w.thumb || '').slice(0, 24));
  }

  /* --- 2.5 解码录制的视频，确认画面里真的有奶龙 --- */
  if (w && w.blob) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(w.blob);
    await new Promise((res) => {
      v.onloadeddata = res;
      v.onerror = res;
      setTimeout(res, 4000);
    });
    try { await v.play(); } catch (e) { /* 忽略 */ }
    await wait(200);
    const c2 = document.createElement('canvas');
    c2.width = v.videoWidth || 320;
    c2.height = v.videoHeight || 240;
    const g2 = c2.getContext('2d');
    g2.drawImage(v, 0, 0, c2.width, c2.height);
    const d2 = g2.getImageData(0, 0, c2.width, c2.height).data;
    let yellow = 0;
    for (let i = 0; i < d2.length; i += 4 * 5) {
      if (d2[i] > 190 && d2[i + 1] - d2[i + 2] > 60 && d2[i + 1] > 150 && d2[i + 2] < 170) yellow++;
    }
    out.decoded = { size: v.videoWidth + 'x' + v.videoHeight, yellow, ready: v.readyState };
    ok('recorded video decodable', v.videoWidth > 0, v.videoWidth + 'x' + v.videoHeight);
    ok('recorded video has sticker', yellow > 20, 'yellow=' + yellow);
    v.pause();
    URL.revokeObjectURL(v.src);
  }

  /* --- 3. 作品库 --- */
  document.getElementById('btn-works').click();
  await wait(400);
  ok('gallery open', !document.getElementById('gallery').classList.contains('hidden'));
  const cards = document.querySelectorAll('#gallery-grid .work-card');
  ok('gallery card rendered', cards.length === works.length, cards.length + '/' + works.length);
  ok('empty state hidden', document.getElementById('gallery-empty').classList.contains('hidden'));

  /* --- 4. 导出（不校验真实落盘，只校验流程与提示） --- */
  document.getElementById('gallery-close').click();
  await wait(200);
  await NF.api.exportLatest();
  await wait(200);
  ok('export button restored', document.getElementById('btn-export').textContent === '导出',
    document.getElementById('btn-export').textContent);
  ok('export toast shown', !!document.querySelector('#toasts .toast'), '');

  /* --- 5. 样式核对 --- */
  const cs = (id) => getComputedStyle(document.getElementById(id));
  ok('active button yellow', cs('btn-works').backgroundColor === 'rgb(255, 215, 0)',
    cs('btn-works').backgroundColor);
  ok('inactive button gray', cs('btn-switch').backgroundColor === 'rgb(74, 74, 74)',
    cs('btn-switch').backgroundColor);
  ok('panel background', getComputedStyle(document.getElementById('panel')).backgroundColor === 'rgb(45, 45, 45)',
    getComputedStyle(document.getElementById('panel')).backgroundColor);
  ok('button radius 4px', cs('btn-record').borderRadius === '4px', cs('btn-record').borderRadius);
  ok('removal shows 100%', document.getElementById('v-remove').textContent === '100%');
  ok('smooth shows 5', document.getElementById('v-smooth').textContent === '5');
  ok('fps shows 25 FPS', document.getElementById('v-fps').textContent === '25 FPS');
  ok('align shows 23', document.getElementById('v-align').textContent === '23');

  /* --- 6. 参数联动 --- */
  const stub = document.createElement('canvas');
  stub.width = stub.height = 64;
  const rm = document.getElementById('r-remove');
  rm.value = '40';
  rm.dispatchEvent(new Event('input', { bubbles: true }));
  ok('removal param applied', s.params.removal === 40 && document.getElementById('v-remove').textContent === '40%',
    s.params.removal + ' / ' + document.getElementById('v-remove').textContent);
  const smooth = document.getElementById('r-smooth');
  smooth.value = '9';
  smooth.dispatchEvent(new Event('input', { bubbles: true }));
  ok('smooth param applied', s.params.smooth === 9);

  // 复原默认值，避免影响截图/录制
  rm.value = '100';
  rm.dispatchEvent(new Event('input', { bubbles: true }));
  smooth.value = '5';
  smooth.dispatchEvent(new Event('input', { bubbles: true }));

  /* --- 6.6 导入自定义照片 --- */
  const cv2 = document.createElement('canvas');
  cv2.width = 480;
  cv2.height = 480;
  const g3 = cv2.getContext('2d');
  g3.fillStyle = '#ffffff';
  g3.fillRect(0, 0, 480, 480);
  g3.fillStyle = '#f0c419';
  g3.beginPath();
  g3.ellipse(240, 250, 150, 180, 0, 0, Math.PI * 2);
  g3.fill();
  g3.fillStyle = '#222222';
  g3.beginPath();
  g3.ellipse(190, 220, 18, 26, 0, 0, Math.PI * 2);
  g3.ellipse(290, 220, 18, 26, 0, 0, Math.PI * 2);
  g3.fill();

  // 背景杂乱时应走椭圆遮罩兜底
  const cv3 = document.createElement('canvas');
  cv3.width = 400;
  cv3.height = 300;
  const g4 = cv3.getContext('2d');
  g4.fillStyle = '#1d3a55'; g4.fillRect(0, 0, 200, 150);
  g4.fillStyle = '#7a4a1d'; g4.fillRect(200, 0, 200, 150);
  g4.fillStyle = '#2f5a2a'; g4.fillRect(0, 150, 200, 150);
  g4.fillStyle = '#5a2a4a'; g4.fillRect(200, 150, 200, 150);
  g4.fillStyle = '#e8b48f';
  g4.beginPath(); g4.arc(200, 150, 95, 0, Math.PI * 2); g4.fill();
  const noisy = NF.api.buildCustomSticker(cv3);
  ok('busy background fallback', !!(noisy && noisy.width >= 280 && noisy.width <= 560),
    noisy ? noisy.width + 'x' + noisy.height : 'null');

  const processed = NF.api.buildCustomSticker(cv2);
  ok('custom sticker built', !!(processed && processed.dataUrl && processed.aspect > 0),
    processed ? processed.width + 'x' + processed.height + ' eye=' + processed.eyeFrac.toFixed(2) : 'null');
  ok('custom bg keyed out', processed.width > 220 && processed.width < 340, processed.width);

  await NF.api.applyCustomSticker(processed);
  await wait(350);
  out.customDebug = {
    effect: s.effect, quad: !!s.quad, tid: s.templateId,
    imgW: s.custom && s.custom.img ? s.custom.img.naturalWidth : 0,
    stickerW: NF.getSticker().width,
    aspect: s.custom ? +s.custom.aspect.toFixed(3) : 0,
    headRatio: s.custom ? +s.custom.headRatio.toFixed(3) : 0,
    stickerCenter: (() => { const c = NF.getSticker(); const d = c.getContext('2d').getImageData(384, 384, 1, 1).data; return [d[0], d[1], d[2], d[3]]; })(),
    stickerOpaque: (() => {
      const c = NF.getSticker();
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 31) if (d[i] > 20) n++;
      return n;
    })(),
    compositeCenter: (() => { const c = NF.composite; const d = c.getContext('2d').getImageData(Math.round(c.width/2), Math.round(c.height/2), 1, 1).data; return [d[0], d[1], d[2], d[3]]; })(),
  };
  ok('custom template active', s.templateId === 'custom' && !!s.custom);
  ok('custom sticker on composite', countYellow() > 200, 'yellow=' + countYellow());

  await NF.api.clearCustomSticker();
  await wait(200);
  ok('custom template cleared', s.templateId === 'nailong' && !s.custom);

  // 再导入一次并保留，用于验证刷新后仍能恢复
  await NF.api.applyCustomSticker(processed);
  await wait(300);
  ok('custom reapplied', s.templateId === 'custom');

  /* --- 7. 切换换脸面板 --- */
  document.getElementById('btn-switch').click();
  await wait(300);
  ok('template sheet open', !document.getElementById('templates').classList.contains('hidden'));
  ok('template tiles', document.querySelectorAll('#tpl-grid .tpl-item').length === 3,
    document.querySelectorAll('#tpl-grid .tpl-item').length);
  ok('template selected', !!document.querySelector('#tpl-grid .tpl-item.is-selected'));
  ok('import tile present', !!document.querySelector('#tpl-grid .tpl-item.tpl-import'));
  ok('custom tile present', document.querySelectorAll('#tpl-grid .tpl-item').length === 3 &&
    !!document.querySelector('#tpl-grid .tpl-del'));

  return out;
}

async function pageCloseTemplates() {
  document.getElementById('tpl-done').click();
  await new Promise((r) => setTimeout(r, 250));
  return {
    closed: document.getElementById('templates').classList.contains('hidden'),
    navBack: document.getElementById('btn-works').classList.contains('is-active'),
  };
}

async function pageCameraPhase() {
  const out = {};
  const NF = window.__nailong_play;
  await NF.ready;
  await new Promise((r) => setTimeout(r, 1800));
  const s = NF.state;
  out.kind = s.source && s.source.kind;
  out.hasStream = !!(s.camera && s.camera.getVideoTracks().length);
  out.overlayHidden = document.getElementById('stage-overlay').classList.contains('hidden');
  out.videoSize = s.source ? s.source.el.videoWidth + 'x' + s.source.el.videoHeight : 'n/a';
  out.faceBadge = document.getElementById('face-badge').textContent;
  out.composite = NF.composite.width + 'x' + NF.composite.height;
  out.customRestored = !!(s.custom && s.templateId === 'custom');
  out.customSize = s.custom ? s.custom.width + 'x' + s.custom.height : 'n/a';
  return out;
}

async function pageLayoutCheck() {
  const v = document.getElementById('viewport').getBoundingClientRect();
  const st = document.getElementById('stage').getBoundingClientRect();
  const p = document.getElementById('panel').getBoundingClientRect();
  return {
    win: [innerWidth, innerHeight],
    vw: Math.round(v.width),
    vh: Math.round(v.height),
    ratio: +(v.width / v.height).toFixed(3),
    stageH: Math.round(st.height),
    panelH: Math.round(p.height),
    overflowX: document.documentElement.scrollWidth - innerWidth,
    panelBottom: Math.round(p.bottom),
  };
}

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function waitForTargets(port = PORT, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('等待 Chrome DevTools 超时');
}

/** 启动一个无头 Chrome 实例并连上它的页面 target */
async function launch(port, extraArgs, url, size) {
  const profile = mkdtempSync(path.join(tmpdir(), 'nailong-play-'));
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${size.w},${size.h}`,
      ...extraArgs,
      url,
    ],
    { stdio: 'ignore', detached: false }
  );
  const target = await waitForTargets(port);
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.w,
    height: size.h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { proc, cdp };
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      '页面脚本异常: ' + (d.exception && d.exception.description ? d.exception.description : d.text)
    );
  }
  return r.result.value;
}

async function screenshot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(SHOTS, name + '.png');
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

function report(obj, prefix = '') {
  let pass = 0;
  let fail = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object' || !('pass' in v)) continue;
    const line = `${v.pass ? 'PASS' : 'FAIL'}  ${k}${v.extra ? '  [' + v.extra + ']' : ''}`;
    console.log(prefix + line);
    v.pass ? pass++ : fail++;
  }
  return { pass, fail };
}

async function pageDeniedPhase() {
  const NF = window.__nailong_play;
  const out = {};
  await NF.ready;
  await new Promise((r) => setTimeout(r, 900));
  const ov = document.getElementById('stage-overlay');

  out.sourceKind = NF.state.source ? NF.state.source.kind : null;
  out.overlayVisible = !ov.classList.contains('hidden');
  out.title = document.getElementById('ov-title').textContent;
  out.desc = document.getElementById('ov-desc').textContent;

  // 走「使用演示画面」兜底
  document.getElementById('ov-demo').click();
  await new Promise((r) => setTimeout(r, 900));

  out.demoKind = NF.state.source ? NF.state.source.kind : null;
  out.overlayHidden = ov.classList.contains('hidden');

  const c = NF.composite;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4 * 37) if (d[i] + d[i + 1] + d[i + 2] > 40) lit++;
  out.lit = lit;
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
let exitCode = 0;
const processes = [];
let cdp = null;

try {
  const main = await launch(
    9333,
    [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
    `${BASE}/index.html?demo=1`,
    { w: 1440, h: 900 }
  );
  cdp = main.cdp;
  processes.push(main.proc);

  // 等页面脚本就绪
  await sleep(1200);

  console.log('\n=== 阶段 1：演示画面 / 换脸效果 ===');
  const a = await evaluate(cdp, `(${pageDemoPhase.toString()})()`);
  const ra = report(a);
  if (a.quadCenter) console.log('     辅助线中心:', JSON.stringify(a.quadCenter), ' 黄色像素:', a.stickerPixels);
  if (a.stickerBox) console.log('     贴纸外框(合成像素):', JSON.stringify(a.stickerBox), ' 四角尺寸:', a.quadWidth, 'x', a.quadHeight);
  if (a.errors && a.errors.length) console.log('     页面错误:', a.errors.join(' | '));
  console.log('     截图:', await screenshot(cdp, '01-live-demo'));

  // 单独导出贴纸，便于检查美工细节
  try {
    const dataUrl = await evaluate(cdp, `window.__nailong_play.getSticker().toDataURL('image/png')`);
    writeFileSync(path.join(SHOTS, '00-sticker.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('     贴纸: test/shots/00-sticker.png');
  } catch (e) {
    console.log('     贴纸导出失败:', e.message);
  }

  console.log('\n=== 阶段 2：定位 / 录制 / 作品库 / 导出 / 样式 ===');
  const b = await evaluate(cdp, `(${pageDeepPhase.toString()})()`);
  const rb = report(b);
  if (b.detect) console.log('     定位结果:', JSON.stringify(b.detect));
  if (b.customDebug) console.log('     自定义贴纸调试:', JSON.stringify(b.customDebug));
  if (b.work) console.log('     作品信息:', JSON.stringify(b.work));
  if (b.errors && b.errors.length) console.log('     页面错误:', b.errors.join(' | '));
  console.log('     截图:', await screenshot(cdp, '02-template-sheet'));

  const c = await evaluate(cdp, `(${pageCloseTemplates.toString()})()`);
  const rc = report({
    'template closed': { pass: c.closed },
    'nav restored': { pass: c.navBack },
  });
  await sleep(300);
  console.log('     截图:', await screenshot(cdp, '03-after-close'));

  // 打开作品库截图
  await evaluate(cdp, `document.getElementById('btn-works').click(); true`);
  await sleep(500);
  console.log('     截图:', await screenshot(cdp, '04-gallery'));
  await evaluate(cdp, `document.getElementById('gallery-close').click(); true`);

  console.log('\n=== 阶段 3：真实摄像头路径（Chrome 假摄像头） ===');
  await cdp.send('Page.navigate', { url: `${BASE}/index.html` });
  await sleep(2500);
  const d = await evaluate(cdp, `(${pageCameraPhase.toString()})()`);
  const rd = report({
    'camera source': { pass: d.kind === 'camera', extra: d.kind },
    'camera stream': { pass: d.hasStream, extra: String(d.hasStream) },
    'no error overlay': { pass: d.overlayHidden, extra: String(d.overlayHidden) },
    'video has size': { pass: /^[1-9]\d*x[1-9]\d*$/.test(d.videoSize), extra: d.videoSize },
    'composite sized': { pass: /^[1-9]\d*x[1-9]\d*$/.test(d.composite), extra: d.composite },
    'imported sticker restored': { pass: d.customRestored === true, extra: d.customSize },
  });
  console.log('     人脸状态:', d.faceBadge);
  console.log('     截图:', await screenshot(cdp, '05-camera'));

  console.log('\n=== 阶段 4：响应式布局 ===');
  const sizes = [
    { w: 1024, h: 700, name: '06-1024x700' },
    { w: 820, h: 640, name: '07-820x640' },
    { w: 390, h: 844, name: '08-390x844', mobile: true },
  ];
  const rl = { pass: 0, fail: 0 };
  for (const sz of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: sz.w,
      height: sz.h,
      deviceScaleFactor: 1,
      mobile: !!sz.mobile,
    });
    await sleep(450);
    const lay = await evaluate(cdp, `(${pageLayoutCheck.toString()})()`);
    const checks = {
      [`${sz.name} 无横向溢出`]: { pass: lay.overflowX <= 1, extra: 'overflowX=' + lay.overflowX },
      [`${sz.name} 面板不超出窗口`]: {
        pass: lay.panelBottom <= sz.h + 1,
        extra: 'bottom=' + lay.panelBottom + '/' + sz.h,
      },
      [`${sz.name} 预览为 16:9 或受宽度限制`]: {
        pass: sz.w > 900 ? Math.abs(lay.ratio - 16 / 9) < 0.03 : lay.ratio > 0.9,
        extra: 'ratio=' + lay.ratio,
      },
    };
    const res = report(checks);
    rl.pass += res.pass;
    rl.fail += res.fail;
    console.log('     截图:', await screenshot(cdp, sz.name));
  }

  console.log('\n=== 阶段 5：摄像头权限被拒绝 ===');
  const denied = await launch(
    9334,
    ['--use-fake-device-for-media-stream', '--deny-permission-prompts'],
    `${BASE}/index.html`,
    { w: 1280, h: 800 }
  );
  processes.push(denied.proc);
  await sleep(2400);
  const e = await evaluate(denied.cdp, `(${pageDeniedPhase.toString()})()`);
  const re = report({
    'denied: overlay shown': { pass: e.overlayVisible === true, extra: String(e.overlayVisible) },
    'denied: friendly title': { pass: /权限|摄像头/.test(e.title), extra: e.title },
    'denied: helpful desc': { pass: e.desc.length > 8, extra: e.desc.slice(0, 40) + '…' },
    'fallback: demo source': { pass: e.demoKind === 'demo', extra: String(e.demoKind) },
    'fallback: overlay closed': { pass: e.overlayHidden === true, extra: String(e.overlayHidden) },
    'fallback: canvas has picture': { pass: e.lit > 20, extra: 'lit=' + e.lit },
  });
  console.log('     截图:', await screenshot(denied.cdp, '09-permission-denied'));

  const total = {
    pass: ra.pass + rb.pass + rc.pass + rd.pass + rl.pass + re.pass,
    fail: ra.fail + rb.fail + rc.fail + rd.fail + rl.fail + re.fail,
  };
  console.log(`\n=== 汇总：${total.pass} 通过 / ${total.fail} 失败 ===`);
  if (total.fail) exitCode = 1;

  cdp.close();
  denied.cdp.close();
} catch (err) {
  console.error('测试执行失败:', err.message);
  exitCode = 2;
} finally {
  for (const p of processes) {
    try { p.kill(); } catch { /* ignore */ }
  }
}

process.exit(exitCode);
