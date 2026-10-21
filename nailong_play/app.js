/*!
 * nailong_play · 奶龙换脸
 * ------------------------------------------------------------------
 * 纯前端实现（无框架、无 CDN、无网络依赖）：
 *   · WebRTC getUserMedia 取摄像头
 *   · Canvas 逐帧合成：摄像头画面 + 奶龙贴纸 + 黄色四角辅助线
 *   · 离线人脸定位（肤色分割 → 连通域 → 头部轮廓 → 眼部精修 → 时序平滑）
 *   · MediaRecorder 录制画布流（+ 摄像头音频），导出下载
 *   · IndexedDB 保存「我的换脸作品」
 * ------------------------------------------------------------------
 */

(function () {
  'use strict';

  /* ============================================================
   * 1. 常量
   * ============================================================ */
  const TAU = Math.PI * 2;

  const STICKER_RES = 768;        // 贴纸缓存分辨率（≈素材原生尺寸，避免二次缩放糊掉）
  const DETECT_INTERVAL = 60;     // 人脸定位间隔（毫秒），越小越跟手
  const APPLY_DELAY = 900;        // 辅助线静止多久后自动应用换脸
  const TRACK_LERP = 0.62;        // 自动跟踪平滑系数，越大跟随越快
  // 存储键保持原名：改名不丢用户已保存的参数 / 作品 / 导入的贴纸
  const LS_KEY = 'niufaces.params.v1';

  const LIMITS = {
    smooth: [1, 10],
    fps: [15, 30],
    align: [10, 50],
    removal: [0, 100],
  };

  const DEFAULT_PARAMS = { smooth: 5, fps: 25, align: 23, removal: 100 };

  /** 录制容器候选，优先真实 MP4，其次 WebM */
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  /* ============================================================
   * 2. 小工具
   * ============================================================ */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const $ = (id) => document.getElementById(id);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 20250607_142233 */
  function stamp(ts) {
    const d = new Date(ts || Date.now());
    return (
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      '_' +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds())
    );
  }

  /** 00:12 */
  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function humanSize(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function roundRectPath(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function shortestAngle(from, to) {
    let d = (to - from) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  /* ============================================================
   * 3. 全局状态
   * ============================================================ */
  const state = {
    params: { ...DEFAULT_PARAMS },

    source: null,          // { el, kind: 'camera' | 'demo' }
    camera: null,          // MediaStream
    demo: null,            // DemoSource

    /** 四角：归一化坐标（相对画面 0~1），顺序 左上、右上、右下、左下 */
    quad: null,
    face: false,           // 当前是否检测到人脸
    effect: false,         // 换脸效果是否已应用
    manual: false,         // 用户是否手动接管辅助线
    quadSettledAt: 0,      // 辅助线稳定时间戳
    lastInteraction: 0,
    lastSeenAt: 0,         // 最近一次检测到人脸的时间

    handControl: false,    // 手势控制开关
    hands: [],             // 当前检测到的指尖（归一化）
    handTracker: null,
    faceQuad: null,        // 最近一次人脸框（手势模式下用于把手部检测里的脸抹掉）
    faceTick: 0,
    handSeenAt: 0,

    recording: false,
    recorder: null,
    chunks: [],
    recordMime: '',
    recStart: 0,
    recTimer: 0,
    thumbAtStart: '',

    lastWorkId: null,
    exporting: false,
    templateId: 'nailong',  // 'nailong' | 'custom'
    custom: null,           // 用户导入的贴纸 { img, aspect, eyeFrac, headRatio, dataUrl, thumb }
    customVersion: 0,       // 每导入一次 +1，用于重建贴纸缓存
    guideAlpha: 0,
    map: null,             // 最近一帧的 cover 映射（CSS px）
    started: false,
  };

  const el = {};

  /* ============================================================
   * 4. 豆土画布：合成画面（录制源）
   * ============================================================ */
  const composite = document.createElement('canvas');
  composite.width = 1280;
  composite.height = 720;
  const cctx = composite.getContext('2d', { alpha: false });
  // 放进 DOM 但不可见：确保 captureStream 在各浏览器上都稳定工作
  composite.className = 'offscreen-canvas';
  composite.style.cssText =
    'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';

  /* ============================================================
   * 5. 奶龙贴纸
   * ============================================================ */
  const stickerScratch = document.createElement('canvas');
  const stickerMask = document.createElement('canvas');
  let stickerCache = { key: '', canvas: null };

  /**
   * 贴纸素材（内置奶龙 + 用户导入）
   * ------------------------------------------------------------------
   * 内置素材 assets/nailong-face.png：560×679 的透明底奶龙大头，
   * 宽高比 0.825，眼睛位于高度 46% 处。
   * 素材加载失败时退回矢量绘制版本，保证程序仍可用。
   */
  const FACE_IMG = new Image();
  FACE_IMG.decoding = 'async';
  let faceImgReady = false;

  const FACE_ASPECT = 560 / 679;   // 素材宽 / 高
  const FACE_EYE_FRAC = 0.46;      // 眼睛在素材高度上的位置
  const FACE_HEAD_RATIO = 0.76;    // 素材宽度占贴纸画布宽度的比例
  const FACE_STRETCH_Y = 1.0;      // 纵向拉伸（内置素材比例已接近人脸，不需要拉伸）
  const FALLBACK_HEAD_RATIO = 0.6; // 矢量兜底版本的头部直径占比

  const BUILTIN_STICKER = {
    id: 'nailong',
    name: '奶龙',
    img: FACE_IMG,
    aspect: FACE_ASPECT,
    eyeFrac: FACE_EYE_FRAC,
    headRatio: FACE_HEAD_RATIO,
    stretch: FACE_STRETCH_Y,
  };

  FACE_IMG.addEventListener('load', () => {
    faceImgReady = FACE_IMG.naturalWidth > 0;
    // 素材到位后重建贴纸缓存
    stickerCache = { key: '', canvas: null };
  });
  FACE_IMG.addEventListener('error', () => {
    faceImgReady = false;
  });
  FACE_IMG.src = 'assets/nailong-face.png';

  /** 当前生效的贴纸素材（用户导入优先，其次内置奶龙，最后矢量兜底） */
  function activeSticker() {
    if (
      state.templateId === 'custom' &&
      state.custom &&
      state.custom.img &&
      state.custom.img.naturalWidth > 0
    ) {
      return state.custom;
    }
    return faceImgReady ? BUILTIN_STICKER : null;
  }

  /** 贴纸中「头部宽度占画布宽度」的比例 */
  function stickerHeadRatio() {
    const st = activeSticker();
    return st ? st.headRatio : FALLBACK_HEAD_RATIO;
  }

  /**
   * 根据素材比例与眼睛位置，算出素材宽度最多能占画布多少，
   * 保证整张图（以眼睛为轴心）不会超出画布。
   */
  function computeHeadRatio(aspect, eyeFrac) {
    const hMax = 0.5 / Math.max(eyeFrac, 1 - eyeFrac);
    return Math.min(0.94, hMax * aspect);
  }

  /**
   * 绘制贴纸（默认画当前模板）
   * 画布中心 (S/2, S/2) 对齐素材的眼睛连线，便于旋转与对位。
   */
  function drawStickerArt(g, S, sticker) {
    const st = sticker === undefined ? activeSticker() : sticker;
    if (st) {
      const w = S * st.headRatio;
      const h = (w / st.aspect) * st.stretch;
      const x = (S - w) / 2;
      const y = S / 2 - h * st.eyeFrac;
      g.save();
      g.clearRect(0, 0, S, S);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(st.img, x, y, w, h);
      g.restore();
      return;
    }

    // ---- 兜底：矢量绘制的大头圆脸 ----
    const cx = S / 2;
    const cy = S / 2;
    const r = S * 0.3;

    g.save();
    g.clearRect(0, 0, S, S);

    const silhouette = (k) => {
      const rr = (v) => v * k;
      g.beginPath();
      // 两只圆耳朵
      g.ellipse(cx - rr(0.78 * r), cy - rr(0.66 * r), rr(0.2 * r), rr(0.2 * r), 0, 0, TAU);
      g.ellipse(cx + rr(0.78 * r), cy - rr(0.66 * r), rr(0.2 * r), rr(0.2 * r), 0, 0, TAU);
      // 脸（略扁的圆）
      g.ellipse(cx, cy, rr(1.07 * r), rr(1.02 * r), 0, 0, TAU);
      g.fill();
    };

    // 轮廓：先画放大 3% 的深黄色底，形成干净的描边
    g.shadowColor = 'rgba(0, 0, 0, 0.32)';
    g.shadowBlur = S * 0.028;
    g.shadowOffsetY = S * 0.014;
    g.fillStyle = '#cf9000';
    silhouette(1.03);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;

    // 脸：径向渐变
    const grad = g.createRadialGradient(
      cx - 0.34 * r, cy - 0.46 * r, r * 0.12,
      cx, cy, r * 1.24
    );
    grad.addColorStop(0, '#ffe680');
    grad.addColorStop(0.45, '#ffd83d');
    grad.addColorStop(0.86, '#ffc400');
    grad.addColorStop(1, '#f0b000');
    g.fillStyle = grad;
    silhouette(1);

    // 耳朵内侧的暗部
    g.save();
    g.globalAlpha = 0.45;
    g.fillStyle = '#e7a000';
    g.beginPath();
    g.ellipse(cx - 0.78 * r, cy - 0.64 * r, 0.1 * r, 0.1 * r, 0, 0, TAU);
    g.ellipse(cx + 0.78 * r, cy - 0.64 * r, 0.1 * r, 0.1 * r, 0, 0, TAU);
    g.fill();
    g.restore();

    // 额头高光
    if ('filter' in g) g.filter = 'blur(' + (r * 0.16).toFixed(1) + 'px)';
    g.save();
    g.globalAlpha = 0.4;
    g.fillStyle = '#fffbe0';
    g.beginPath();
    g.ellipse(cx - 0.34 * r, cy - 0.52 * r, 0.3 * r, 0.15 * r, -0.28, 0, TAU);
    g.fill();
    g.restore();
    if ('filter' in g) g.filter = 'none';

    // 腮红
    if ('filter' in g) g.filter = 'blur(' + (r * 0.12).toFixed(1) + 'px)';
    g.save();
    g.globalAlpha = 0.6;
    g.fillStyle = '#ff8a8a';
    g.beginPath();
    g.ellipse(cx - 0.64 * r, cy + 0.34 * r, 0.16 * r, 0.1 * r, 0, 0, TAU);
    g.ellipse(cx + 0.64 * r, cy + 0.34 * r, 0.16 * r, 0.1 * r, 0, 0, TAU);
    g.fill();
    g.restore();
    if ('filter' in g) g.filter = 'none';

    // 眼睛
    const eyeY = cy - 0.02 * r;
    const ex = 0.4 * r;
    const eyeRx = 0.19 * r;
    const eyeRy = 0.25 * r;

    g.fillStyle = '#2b2118';
    g.beginPath();
    g.ellipse(cx - ex, eyeY, eyeRx, eyeRy, 0, 0, TAU);
    g.ellipse(cx + ex, eyeY, eyeRx, eyeRy, 0, 0, TAU);
    g.fill();

    // 眼睛高光
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(cx - ex - 0.055 * r, eyeY - 0.075 * r, 0.062 * r, 0.075 * r, -0.2, 0, TAU);
    g.ellipse(cx + ex - 0.055 * r, eyeY - 0.075 * r, 0.062 * r, 0.075 * r, -0.2, 0, TAU);
    g.fill();
    g.globalAlpha = 0.85;
    g.beginPath();
    g.ellipse(cx - ex + 0.07 * r, eyeY + 0.09 * r, 0.03 * r, 0.03 * r, 0, 0, TAU);
    g.ellipse(cx + ex + 0.07 * r, eyeY + 0.09 * r, 0.03 * r, 0.03 * r, 0, 0, TAU);
    g.fill();
    g.globalAlpha = 1;

    // 嘴巴
    g.strokeStyle = '#7a4b00';
    g.lineWidth = r * 0.045;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - 0.15 * r, cy + 0.4 * r);
    g.quadraticCurveTo(cx, cy + 0.56 * r, cx + 0.15 * r, cy + 0.4 * r);
    g.stroke();

    g.restore();
  }

  /** 生成带羽化边缘的贴纸（按模板 + 平滑度缓存） */
  function getSticker() {
    const key = state.templateId + '|' + state.params.smooth + '|' + state.customVersion;
    if (stickerCache.key === key && stickerCache.canvas) return stickerCache.canvas;

    const S = STICKER_RES;
    if (stickerScratch.width !== S) {
      stickerScratch.width = stickerScratch.height = S;
      stickerMask.width = stickerMask.height = S;
    }
    const a = stickerScratch.getContext('2d');
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.clearRect(0, 0, S, S);
    a.globalCompositeOperation = 'source-over';
    drawStickerArt(a, S);

    // 用模糊后的 alpha 通道做遮罩 → 边缘柔和过渡（羽化）
    const m = stickerMask.getContext('2d');
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, S, S);
    // 照片素材本身边缘就干净，羽化半径比矢量版本小一些
    const feather = activeSticker() ? 1.2 + state.params.smooth * 0.9 : 2 + state.params.smooth * 1.8;
    const canFilter = 'filter' in m;
    if (canFilter) m.filter = 'blur(' + feather.toFixed(1) + 'px)';
    m.drawImage(stickerScratch, 0, 0);
    if (canFilter) m.filter = 'none';

    a.globalCompositeOperation = 'destination-in';
    a.drawImage(stickerMask, 0, 0);
    a.globalCompositeOperation = 'source-over';

    const out = document.createElement('canvas');
    out.width = out.height = S;
    out.getContext('2d').drawImage(stickerScratch, 0, 0);

    stickerCache = { key, canvas: out };
    return out;
  }

  /* ============================================================
   * 5.5 导入自己的照片做贴纸
   * ============================================================ */
  const CUSTOM_MAX_SIDE = 1400;   // 原图先缩到这个边长内再处理，避免大图卡顿
  const CUSTOM_WIDTH = 560;       // 最终素材宽度（与内置素材保持一致）
  const CUSTOM_ASSET_KEY = 'customSticker';

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const okType = /^image\//.test(file.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '');
      if (!file || !okType) {
        reject(new Error('请选择图片文件'));
        return;
      }
      const url = URL.createObjectURL(file);
      loadImageFromUrl(url).then(
        (img) => { URL.revokeObjectURL(url); resolve(img); },
        (err) => { URL.revokeObjectURL(url); reject(err); }
      );
    });
  }

  /** 非透明内容的外接框 */
  function alphaBounds(g, w, h) {
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (d[(row + x) * 4 + 3] > 16) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  /** 背景不纯时的兜底：椭圆遮罩，把中间的人像抠成贴纸 */
  function ovalMask(g, w, h) {
    g.save();
    g.globalCompositeOperation = 'destination-in';
    g.translate(w / 2, h / 2);
    g.scale(w / 2, h / 2);
    const grad = g.createRadialGradient(0, 0, 0.84, 0, 0, 1);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 1, 0, TAU);
    g.fill();
    g.restore();
  }

  /** 去背景：透明底直接返回；纯色底按色差抠图；背景杂乱则用椭圆遮罩 */
  function removeBackground(g, w, h) {
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;

    // 判断是否已经是透明底
    let transparent = 0;
    let sampled = 0;
    for (let i = 3; i < d.length; i += 4 * 9) {
      sampled++;
      if (d[i] < 250) transparent++;
    }
    if (transparent > sampled * 0.08) return;

    // 四角取色，判断背景是否纯色
    const at = (x, y) => {
      const i = (y * w + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    const corners = [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)];
    const avg = [0, 0, 0];
    for (let i = 0; i < corners.length; i++) {
      avg[0] += corners[i][0];
      avg[1] += corners[i][1];
      avg[2] += corners[i][2];
    }
    avg[0] /= 4; avg[1] /= 4; avg[2] /= 4;

    let dev = 0;
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i];
      dev = Math.max(dev, Math.hypot(c[0] - avg[0], c[1] - avg[1], c[2] - avg[2]));
    }
    if (dev > 30) {
      // 背景太花，抠不干净 → 用椭圆裁成大头贴
      ovalMask(g, w, h);
      return;
    }

    const t0 = 20;
    const t1 = 68;
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.hypot(d[i] - avg[0], d[i + 1] - avg[1], d[i + 2] - avg[2]);
      let a = (dist - t0) / (t1 - t0);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      d[i + 3] = Math.round(d[i + 3] * a);
    }
    g.putImageData(img, 0, 0);
  }

  /** 把用户图片处理成贴纸素材（去背景 → 裁剪 → 底部渐隐 → 缩放） */
  function buildCustomSticker(img) {
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    if (!sw || !sh) throw new Error('图片尺寸无效');
    const scale = Math.min(1, CUSTOM_MAX_SIDE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    const sg = src.getContext('2d', { willReadFrequently: true });
    sg.drawImage(img, 0, 0, w, h);

    removeBackground(sg, w, h);

    const box = alphaBounds(sg, w, h);
    if (!box) throw new Error('图片里没有找到可用内容');

    const cw = box.x1 - box.x0 + 1;
    const ch = box.y1 - box.y0 + 1;
    const outW = Math.min(CUSTOM_WIDTH, cw);
    const outH = Math.max(1, Math.round((ch * outW) / cw));

    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const og = out.getContext('2d');
    og.imageSmoothingEnabled = true;
    og.imageSmoothingQuality = 'high';
    og.drawImage(src, box.x0, box.y0, cw, ch, 0, 0, outW, outH);

    // 底部渐隐，贴到脸上时下巴不会出现硬边
    // 注意：必须用 destination-out（只擦除填充区域），
    // 用 destination-in 会连同填充区以外的像素一起清空。
    const fade = Math.max(2, Math.round(outH * 0.06));
    const grad = og.createLinearGradient(0, outH - fade, 0, outH);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    og.globalCompositeOperation = 'destination-out';
    og.fillStyle = grad;
    og.fillRect(0, outH - fade, outW, fade);
    og.globalCompositeOperation = 'source-over';

    // 用一次临时的人脸定位估计眼睛高度；失败就用默认值
    let eyeFrac = 0.44;
    try {
      const t = createFaceTracker();
      const det = t.detect(out, false);
      if (det && det.conf >= 0.6) eyeFrac = clamp(det.y + det.h * 0.42, 0.22, 0.68);
    } catch (e) {
      /* 忽略，用默认值 */
    }

    const aspect = outW / outH;
    const headRatio = computeHeadRatio(aspect, eyeFrac);

    // 80×80 缩略图（用于模板面板）
    const tw = 160;
    const th = Math.max(1, Math.round((outH / outW) * tw));
    const thumb = document.createElement('canvas');
    thumb.width = tw;
    thumb.height = th;
    thumb.getContext('2d').drawImage(out, 0, 0, tw, th);

    return {
      id: 'custom',
      name: '我的照片',
      dataUrl: out.toDataURL('image/png'),
      thumbUrl: thumb.toDataURL('image/png'),
      width: outW,
      height: outH,
      aspect,
      eyeFrac,
      headRatio,
      stretch: 1,
      createdAt: Date.now(),
    };
  }

  /** 应用一份处理好的贴纸，切换过去并持久化 */
  async function applyCustomSticker(processed) {
    const img = await loadImageFromUrl(processed.dataUrl);
    state.custom = Object.assign({}, processed, { img });
    state.customVersion++;
    state.templateId = 'custom';
    stickerCache = { key: '', canvas: null };
    state.tracker.reset();
    try {
      await Store.putAsset(CUSTOM_ASSET_KEY, processed);
    } catch (e) {
      /* 存储不可用时本次会话仍可用 */
    }
  }

  async function importPhotoFile(file) {
    try {
      toast('正在处理照片…');
      const img = await loadImageFromFile(file);
      const processed = buildCustomSticker(img);
      await applyCustomSticker(processed);
      if (!el.templates.classList.contains('hidden')) renderTemplates();
      toast('已导入照片，可拖动四角微调位置', 'ok');
    } catch (err) {
      toast('导入失败：' + (err && err.message ? err.message : '未知错误'), 'err');
    }
  }

  async function clearCustomSticker() {
    state.custom = null;
    state.customVersion++;
    state.templateId = 'nailong';
    stickerCache = { key: '', canvas: null };
    try {
      await Store.delAsset(CUSTOM_ASSET_KEY);
    } catch (e) {
      /* 忽略 */
    }
    renderTemplates();
    toast('已恢复为内置奶龙');
  }

  /* ============================================================
   * 6. 离线人脸定位
   * ============================================================ */
  /* ============================================================
   * 6.0 肤色分割公用工具（人脸 / 手部定位共用）
   * ============================================================ */

  /** 肤色判定（RGB + YCbCr + 亮度三重条件，兼顾浅/深肤色，排除头发/眉毛） */
  function isSkin(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 42 || max - min < 13) return false;
    // 亮度下限：黑发、深色眉毛同样能通过色度条件，必须靠亮度排除
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 52) return false;
    if (!(r > g && g > b * 0.8)) return false;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cb >= 76 && cb <= 133 && cr >= 132 && cr <= 182;
  }

  /** 四连通域标记，返回面积/外接框/一二阶矩 */
  function components(mask, W, H) {
    const seen = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    const out = [];

    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || seen[i]) continue;
      let sp = 0;
      stack[sp++] = i;
      seen[i] = 1;

      let area = 0;
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;

      while (sp > 0) {
        const p = stack[--sp];
        const x = p % W;
        const y = (p - x) / W;

        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;

        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
        if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
      }

      out.push({ area, x0, x1, y0, y1, sx, sy, sxx, syy, sxy });
    }
    return out;
  }

  /**
   * 人脸定位器工厂：每次调用得到一个相互独立的追踪实例
   * （互不干扰的 prev 状态，便于同时存在预览与单元测试）
   */
  const createFaceTracker = (function () {
    const MAX_SIDE = 208;

    // isSkin / components 见文件上部「6.0 肤色分割公用工具」

    /** 给连通域打分，挑最像“人脸”的一块 */
    function pickFace(comps, W, H, prev) {
      const total = W * H;
      let best = null;
      let bestScore = -1;

      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        const bw = c.x1 - c.x0 + 1;
        const bh = c.y1 - c.y0 + 1;
        if (bw < W * 0.08 || bh < H * 0.08) continue;

        const areaFrac = c.area / total;
        if (areaFrac > 0.62) continue;

        const solidity = c.area / (bw * bh);
        if (solidity < 0.3) continue;

        const aspect = bw / bh;
        if (aspect < 0.34 || aspect > 2.0) continue;

        const cx = c.sx / c.area / W;
        const cy = c.sy / c.area / H;
        if (cy > 0.92) continue;

        const centerScore = 1 - Math.min(1, Math.hypot(cx - 0.5, (cy - 0.45) * 0.85) / 0.6);
        const aspectScore = 1 - Math.min(1, Math.abs(Math.log(aspect / 0.88)) / 0.85);
        const sizeScore = 1 - Math.min(1, Math.abs(Math.log(Math.max(areaFrac, 1e-6) / 0.11)) / 1.5);
        let score = 0.38 * centerScore + 0.28 * aspectScore + 0.19 * sizeScore + 0.15 * Math.min(1, solidity);

        // 时序先验：靠近上一帧位置加分，避免跳到手上
        if (prev) {
          const pcx = prev.x + prev.w / 2;
          const pcy = prev.y + prev.h / 2;
          const d = Math.hypot(cx - pcx, cy - pcy);
          score *= d < 0.2 ? 1.18 : d < 0.45 ? 0.92 : 0.6;
        }

        if (score > bestScore) { bestScore = score; best = c; }
      }

      return bestScore >= 0.3 ? best : null;
    }

    /**
     * 从肤色连通域估算头部方框：
     * 取连通域上部最宽的一行作为脸颊宽度，再按人脸比例推算高度。
     */
    function estimateFace(c, mask, W) {
      const bh = c.y1 - c.y0 + 1;
      if (bh < 8) return null;

      const rowX0 = new Int32Array(bh).fill(-1);
      const rowX1 = new Int32Array(bh).fill(-1);
      const rowW = new Int32Array(bh);

      for (let y = c.y0; y <= c.y1; y++) {
        let cnt = 0, x0 = -1, x1 = -1;
        const off = y * W;
        for (let x = c.x0; x <= c.x1; x++) {
          if (mask[off + x]) {
            cnt++;
            if (x0 < 0) x0 = x;
            x1 = x;
          }
        }
        const i = y - c.y0;
        rowW[i] = cnt; rowX0[i] = x0; rowX1[i] = x1;
      }

      const from = Math.floor(bh * 0.1);
      const to = Math.max(from + 1, Math.floor(bh * 0.55));
      let headW = 0, bestRow = -1;
      for (let i = from; i < to && i < bh; i++) {
        if (rowW[i] > headW) { headW = rowW[i]; bestRow = i; }
      }
      if (headW < 6 || bestRow < 0) return null;

      const headCx = (rowX0[bestRow] + rowX1[bestRow]) / 2;
      return {
        x: headCx - headW / 2,
        y: c.y0,
        w: headW,
        h: headW * 1.24,
      };
    }

    /** 在脸部区域内找一对对称的暗色块（眼睛），用于修正位置与头部倾斜角 */
    function findEyes(data, W, H, face) {
      const x0 = clamp(Math.floor(face.x + face.w * 0.14), 0, W - 1);
      const x1 = clamp(Math.ceil(face.x + face.w * 0.86), 0, W - 1);
      const y0 = clamp(Math.floor(face.y + face.h * 0.1), 0, H - 1);
      const y1 = clamp(Math.ceil(face.y + face.h * 0.72), 0, H - 1);
      const rw = x1 - x0 + 1;
      const rh = y1 - y0 + 1;
      if (rw < 10 || rh < 10) return null;

      // 只在「内接椭圆」内取亮度：脸框四角常是背景/头发/衣领，会把眼睛配对带偏
      const fcx = face.x + face.w / 2;
      const fcy = face.y + face.h / 2;
      const rxN = face.w * 0.42;
      const ryN = face.h * 0.42;

      const lum = new Float32Array(rw * rh).fill(255);
      let sum = 0;
      let cnt = 0;
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const px = x + x0;
          const py = y + y0;
          const nx = (px - fcx) / rxN;
          const ny = (py - fcy) / ryN;
          if (nx * nx + ny * ny > 1) continue;
          const i = (py * W + px) * 4;
          const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          lum[y * rw + x] = l;
          sum += l;
          cnt++;
        }
      }
      if (!cnt) return null;
      const mean = sum / cnt;
      if (!mean) return null;

      const thr = mean * 0.62;
      const dark = new Uint8Array(rw * rh);
      for (let i = 0; i < dark.length; i++) if (lum[i] < thr) dark[i] = 1;

      const comps = components(dark, rw, rh);
      const cands = [];
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        const bw = c.x1 - c.x0 + 1;
        const bh = c.y1 - c.y0 + 1;
        if (c.area < 5) continue;
        const relW = bw / rw;
        const relH = bh / rh;
        if (relW < 0.05 || relW > 0.3) continue;
        if (relH < 0.05 || relH > 0.34) continue;
        const ratio = bw / bh;
        if (ratio < 0.45 || ratio > 2.2) continue;
        const cyp = (c.y0 + c.y1) / 2 / rh;
        if (cyp < 0.08 || cyp > 0.62) continue;
        // 贴着搜索区边缘的暗块多半是头发/阴影，排除
        if (c.x0 <= 1 || c.x1 >= rw - 2 || c.y0 <= 1 || c.y1 >= rh - 2) continue;
        // 实心度：眼睛近似实心椭圆
        if (c.area / (bw * bh) < 0.5) continue;
        cands.push(c);
      }
      if (cands.length < 2) return null;

      cands.sort((a, b) => b.area - a.area);
      const pool = cands.slice(0, 6);
      let best = null;
      let bestScore = -1;

      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const A = pool[i];
          const B = pool[j];
          const ax = (A.x0 + A.x1) / 2;
          const ay = (A.y0 + A.y1) / 2;
          const bx = (B.x0 + B.x1) / 2;
          const by = (B.y0 + B.y1) / 2;
          const dx = Math.abs(ax - bx);
          const dy = Math.abs(ay - by);
          if (dx < rw * 0.16 || dx > rw * 0.7) continue;
          if (dy > rh * 0.16) continue;               // 双眼应在同一水平线上
          const aw = A.x1 - A.x0 + 1;
          const bw2 = B.x1 - B.x0 + 1;
          const szRatio = Math.min(aw, bw2) / Math.max(aw, bw2);
          if (szRatio < 0.5) continue;                // 双眼大小应接近
          const offCenter = Math.abs((ax + bx) / 2 / rw - 0.5);
          if (offCenter > 0.2) continue;              // 双眼中点应靠近脸部中线
          const score = Math.min(A.area, B.area) * szRatio * (1 - dy / rh) * (1 - offCenter);
          if (score > bestScore) {
            bestScore = score;
            best = { ax, ay, bx, by, aw, bw: bw2 };
          }
        }
      }
      if (!best) return null;

      // 两点顺序不固定，取直线倾角并归一到 (-90°, 90°]
      let eyeAngle = Math.atan2(best.by - best.ay, best.bx - best.ax);
      if (eyeAngle > Math.PI / 2) eyeAngle -= Math.PI;
      if (eyeAngle < -Math.PI / 2) eyeAngle += Math.PI;

      return {
        dist: Math.abs(best.ax - best.bx),
        midX: x0 + (best.ax + best.bx) / 2,
        midY: y0 + (best.ay + best.by) / 2,
        angle: eyeAngle,
        size: Math.min(best.aw, best.bw),
      };
    }

    /** 创建一个独立的追踪器实例 */
    function create() {
      const work = document.createElement('canvas');
      const wctx = work.getContext('2d', { willReadFrequently: true });
      let prev = null;
      let lastDebug = null;

      /**
       * @param {HTMLVideoElement|HTMLCanvasElement} source
       * @param {boolean} mirror 是否按镜像坐标分析（与预览一致）
       * @returns {{x:number,y:number,w:number,h:number,angle:number,conf:number}|null}
       */
      function detect(source, mirror) {
      const sw = source.videoWidth || source.width;
      const sh = source.videoHeight || source.height;
      if (!sw || !sh) return null;

      const k = MAX_SIDE / Math.max(sw, sh);
      const W = Math.max(48, Math.round(sw * k));
      const H = Math.max(36, Math.round(sh * k));
      if (work.width !== W || work.height !== H) { work.width = W; work.height = H; }

      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.clearRect(0, 0, W, H);
      if (mirror) wctx.setTransform(-1, 0, 0, 1, W, 0);
      wctx.drawImage(source, 0, 0, W, H);
      wctx.setTransform(1, 0, 0, 1, 0, 0);

      let img;
      try {
        img = wctx.getImageData(0, 0, W, H);
      } catch (e) {
        return null; // 跨域画面不允许读取像素
      }
      const data = img.data;

      const mask = new Uint8Array(W * H);
      let skinCount = 0;
      for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        if (isSkin(data[i], data[i + 1], data[i + 2])) { mask[p] = 1; skinCount++; }
      }
      if (skinCount < W * H * 0.006) return null;

      const comps = components(mask, W, H);
      const best = pickFace(comps, W, H, prev);
      if (!best) return null;

      let face = estimateFace(best, mask, W);
      if (!face) return null;

      const eyes = findEyes(data, W, H, face);
      let angle = 0;
      let conf = 0.55;
      lastDebug = { face: { ...face }, eyes, W, H };

      // 双眼间距应在合理范围内，否则视为误检，退回肤色轮廓结果
      const eyeOk = eyes && eyes.dist / face.w > 0.26 && eyes.dist / face.w < 0.62;

      if (eyeOk) {
        const wByEyes = clamp(eyes.dist / 0.46, face.w * 0.8, face.w * 1.28);
        const top = eyes.midY - wByEyes * 0.4;
        const faceH = face.h * (wByEyes / face.w);
        // 与肤色轮廓结果做加权融合，避免眼部误检带偏
        face = {
          x: lerp(face.x, eyes.midX - wByEyes / 2, 0.7),
          y: lerp(face.y, top, 0.55),
          w: lerp(face.w, wByEyes, 0.6),
          h: lerp(face.h, faceH, 0.6),
        };
        angle = clamp(eyes.angle, -0.38, 0.38);
        conf = 0.9;
      }

      // 归一化 + 时序平滑
      const nx = face.x / W;
      const ny = face.y / H;
      const nw = face.w / W;
      const nh = face.h / H;

      let out = {
        x: clamp(nx, -0.2, 1.2),
        y: clamp(ny, -0.2, 1.2),
        w: clamp(nw, 0.05, 1.4),
        h: clamp(nh, 0.05, 1.4),
        angle,
        conf,
      };

      if (prev) {
        const moved = Math.hypot(
          out.x + out.w / 2 - (prev.x + prev.w / 2),
          out.y + out.h / 2 - (prev.y + prev.h / 2)
        );
        const t = moved > 0.22 ? 1 : TRACK_LERP;
        out = {
          x: lerp(prev.x, out.x, t),
          y: lerp(prev.y, out.y, t),
          w: lerp(prev.w, out.w, t),
          h: lerp(prev.h, out.h, t),
          angle: prev.angle + shortestAngle(prev.angle, out.angle) * t,
          conf: out.conf,
        };
      }

      prev = out;
      return out;
    }

      function reset() {
        prev = null;
      }

      return { detect, reset, canvas: work, get debug() { return lastDebug; } };
    }

    return create;
  })();

  state.tracker = createFaceTracker();

  /* ============================================================
   * 6.5 手部定位（肤色分割 + 距离变换，用双手控制换脸自选框）
   * ============================================================ */
  const createHandTracker = (function () {
    const MAX_SIDE = 160;

    /** 倒角距离变换：每个前景像素到最近背景的距离（单位≈像素） */
    function distanceTransform(mask, W, H) {
      const INF = 1e6;
      const d = new Float32Array(W * H);
      for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
      const S = 1.4142;

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!d[i]) continue;
          let m = d[i];
          if (x > 0 && d[i - 1] + 1 < m) m = d[i - 1] + 1;
          if (y > 0) {
            if (d[i - W] + 1 < m) m = d[i - W] + 1;
            if (x > 0 && d[i - W - 1] + S < m) m = d[i - W - 1] + S;
            if (x < W - 1 && d[i - W + 1] + S < m) m = d[i - W + 1] + S;
          }
          d[i] = m;
        }
      }
      for (let y = H - 1; y >= 0; y--) {
        for (let x = W - 1; x >= 0; x--) {
          const i = y * W + x;
          if (!d[i]) continue;
          let m = d[i];
          if (x < W - 1 && d[i + 1] + 1 < m) m = d[i + 1] + 1;
          if (y < H - 1) {
            if (d[i + W] + 1 < m) m = d[i + W] + 1;
            if (x < W - 1 && d[i + W + 1] + S < m) m = d[i + W + 1] + S;
            if (x > 0 && d[i + W - 1] + S < m) m = d[i + W - 1] + S;
          }
          d[i] = m;
        }
      }
      return d;
    }

    function create() {
      const work = document.createElement('canvas');
      const wctx = work.getContext('2d', { willReadFrequently: true });
      let prev = null; // 上一帧的指尖位置，用于平滑

      /**
       * @param source 视频或画布
       * @param faceQuad 归一化人脸四角，用于把脸从肤色掩码里抹掉（可为 null）
       * @param mirror 是否镜像分析
       * @returns {{hands: Array, dual: null|{cx:number,cy:number,span:number,angle:number}}}
       */
      function analyze(source, faceQuad, mirror) {
        const empty = { hands: [], dual: null };
        const sw = source.videoWidth || source.width;
        const sh = source.videoHeight || source.height;
        if (!sw || !sh) return empty;

        const k = MAX_SIDE / Math.max(sw, sh);
        const W = Math.max(48, Math.round(sw * k));
        const H = Math.max(36, Math.round(sh * k));
        if (work.width !== W || work.height !== H) { work.width = W; work.height = H; }

        wctx.setTransform(1, 0, 0, 1, 0, 0);
        wctx.clearRect(0, 0, W, H);
        if (mirror) wctx.setTransform(-1, 0, 0, 1, W, 0);
        wctx.drawImage(source, 0, 0, W, H);
        wctx.setTransform(1, 0, 0, 1, 0, 0);

        let data;
        try {
          data = wctx.getImageData(0, 0, W, H).data;
        } catch (e) {
          return empty;
        }

        const mask = new Uint8Array(W * H);
        for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
          if (isSkin(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
        }

        // 抹掉人脸区域（外扩 12%），否则脸会被当成“手”
        if (faceQuad) {
          const xs = faceQuad.map((q) => q.x * W);
          const ys = faceQuad.map((q) => q.y * H);
          const fx0 = Math.min.apply(null, xs);
          const fx1 = Math.max.apply(null, xs);
          const fy0 = Math.min.apply(null, ys);
          const fy1 = Math.max.apply(null, ys);
          const ax0 = Math.max(0, Math.floor(fx0 - (fx1 - fx0) * 0.12));
          const ax1 = Math.min(W - 1, Math.ceil(fx1 + (fx1 - fx0) * 0.12));
          const ay0 = Math.max(0, Math.floor(fy0 - (fy1 - fy0) * 0.12));
          const ay1 = Math.min(H - 1, Math.ceil(fy1 + (fy1 - fy0) * 0.12));
          for (let y = ay0; y <= ay1; y++) {
            for (let x = ax0; x <= ax1; x++) mask[y * W + x] = 0;
          }
        }

        const comps = components(mask, W, H);
        const cands = [];
        for (let i = 0; i < comps.length; i++) {
          const c = comps[i];
          const bw = c.x1 - c.x0 + 1;
          const bh = c.y1 - c.y0 + 1;
          if (c.area < W * H * 0.004 || c.area > W * H * 0.3) continue;
          const solidity = c.area / (bw * bh);
          if (solidity < 0.28) continue;
          const aspect = bw / bh;
          if (aspect < 0.22 || aspect > 4.5) continue;
          cands.push(c);
        }
        if (!cands.length) {
          prev = null;
          return empty;
        }

        const dt = distanceTransform(mask, W, H);
        const hands = [];

        for (let ci = 0; ci < cands.length; ci++) {
          const c = cands[ci];
          let palmI = -1;
          let palmD = 0;
          for (let y = c.y0; y <= c.y1; y++) {
            for (let x = c.x0; x <= c.x1; x++) {
              const i = y * W + x;
              if (dt[i] > palmD) { palmD = dt[i]; palmI = i; }
            }
          }
          if (palmI < 0 || palmD < 3) continue;

          const px = palmI % W;
          const py = (palmI - (palmI % W)) / W;
          const cap = palmD * 2.4; // 只在这一圈里找指尖，避免把手臂末端当成指尖
          let tipD = 0;
          let tipI = -1;
          for (let y = c.y0; y <= c.y1; y++) {
            for (let x = c.x0; x <= c.x1; x++) {
              const i = y * W + x;
              if (!mask[i]) continue;
              const dx = x - px;
              const dy = y - py;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist <= cap && dist > tipD) { tipD = dist; tipI = i; }
            }
          }
          if (tipI < 0) continue;

          const ext = tipD / palmD;
          if (ext < 1.2) continue; // 没有“伸出的手指”，多半是手臂或其它肤色块

          const tx = tipI % W;
          const ty = (tipI - (tipI % W)) / W;
          hands.push({
            x: tx / W,
            y: ty / H,
            palmX: px / W,
            palmY: py / H,
            r: palmD / W,
            ext,
            score: (c.area / (W * H)) * Math.min(2, ext),
          });
        }

        if (!hands.length) {
          prev = null;
          return empty;
        }

        // 优先取“水平分开最远”的两只（脖子/前臂等误检通常靠得很近）
        hands.sort((a, b) => b.score - a.score);
        const pool = hands.slice(0, 4);
        let picked;
        let bestSep = 0;
        let bestPair = null;
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const sep = Math.abs(pool[i].x - pool[j].x);
            if (sep > bestSep) { bestSep = sep; bestPair = [pool[i], pool[j]]; }
          }
        }
        if (bestPair && bestSep > 0.12) picked = bestPair;
        else picked = [pool[0]];

        // 平滑（按 x 排序后再插值，避免两只手互换顺序时跳变）
        picked.sort((a, b) => a.x - b.x);
        if (prev && prev.length === picked.length) {
          for (let i = 0; i < picked.length; i++) {
            const d = Math.hypot(picked[i].x - prev[i].x, picked[i].y - prev[i].y);
            const t = d > 0.25 ? 1 : 0.55;
            picked[i].x = prev[i].x + (picked[i].x - prev[i].x) * t;
            picked[i].y = prev[i].y + (picked[i].y - prev[i].y) * t;
          }
        }
        prev = picked.map((h) => ({ x: h.x, y: h.y }));

        let dual = null;
        if (picked.length === 2) {
          const a = picked[0];
          const b = picked[1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          dual = {
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            span: Math.hypot(dx, dy),
            angle: Math.atan2(dy, dx),
          };
        }

        return { hands: picked, dual };
      }

      function reset() {
        prev = null;
      }

      return { analyze, reset, canvas: work };
    }

    return create;
  })();

  state.handTracker = createHandTracker();

  /** 由双手指尖推出自选框四角：中点=位置，间距=大小，连线角度=旋转 */
  function quadFromHands(dual, aspect) {
    const w = clamp(dual.span * 0.75, 0.1, 0.95);
    const h = clamp(w * (aspect || 1.22), 0.12, 0.98);
    const cx = clamp(dual.cx, 0.05, 0.95);
    const cy = clamp(dual.cy, 0.05, 0.95);
    const ang = clamp(dual.angle, -0.6, 0.6);
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const hw = w / 2;
    const hh = h / 2;
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([dx, dy]) => ({
      x: clamp(cx + dx * cos - dy * sin, 0, 1),
      y: clamp(cy + dx * sin + dy * cos, 0, 1),
    }));
  }

  /* ============================================================
   * 7. 演示画面（没有摄像头时也能预览/试用）
   * ============================================================ */
  class DemoSource {
    constructor() {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 960;
      this.canvas.height = 540;
      this.g = this.canvas.getContext('2d');
    }

    draw(t) {
      const g = this.g;
      const W = this.canvas.width;   // 960（16:9）
      const H = this.canvas.height;  // 540
      const VW = 800;                // 虚拟绘制坐标系
      const VH = 640;
      const s = t / 1000;
      const sway = Math.sin(s * 0.55) * 22;
      const bob = Math.sin(s * 0.9) * 7;
      const tilt = Math.sin(s * 0.7) * 0.055;

      // 背景
      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#43536e');
      bg.addColorStop(0.6, '#2b3547');
      bg.addColorStop(1, '#1b2230');
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);

      // 台灯光晕
      const glow = g.createRadialGradient(W * 0.72, H * 0.18, 20, W * 0.72, H * 0.18, H * 0.8);
      glow.addColorStop(0, 'rgba(255, 226, 170, 0.32)');
      glow.addColorStop(1, 'rgba(255, 226, 170, 0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);

      g.save();
      const k = H / VH;
      g.translate((W - VW * k) / 2, 0);
      g.scale(k, k);

      // 身体（深色衣服）
      g.save();
      g.translate(VW / 2 + sway * 0.45, VH * 0.98);
      g.fillStyle = '#2f3d55';
      roundRectPath(g, -260, -150, 520, 220, 120);
      g.fill();
      g.restore();

      // 头
      g.save();
      g.translate(VW / 2 + sway, VH * 0.43 + bob);
      g.rotate(tilt);

      // 脖子
      g.fillStyle = '#d79f74';
      roundRectPath(g, -46, 62, 92, 120, 22);
      g.fill();

      // 头发（先画，后面用脸盖住下半部分）
      g.fillStyle = '#2a2118';
      g.beginPath();
      g.ellipse(0, -46, 116, 104, 0, 0, TAU);
      g.fill();

      // 耳朵
      g.fillStyle = '#dfa87e';
      g.beginPath();
      g.ellipse(-108, 6, 17, 26, 0, 0, TAU);
      g.ellipse(108, 6, 17, 26, 0, 0, TAU);
      g.fill();

      // 脸
      const skin = g.createRadialGradient(-30, -40, 20, 0, 10, 150);
      skin.addColorStop(0, '#f0c6a3');
      skin.addColorStop(0.65, '#e3b08c');
      skin.addColorStop(1, '#cd9268');
      g.fillStyle = skin;
      g.beginPath();
      g.ellipse(0, 0, 106, 128, 0, 0, TAU);
      g.fill();

      // 刘海
      g.fillStyle = '#2a2118';
      g.beginPath();
      g.moveTo(-108, -22);
      g.quadraticCurveTo(-70, -96, 0, -98);
      g.quadraticCurveTo(72, -96, 110, -20);
      g.quadraticCurveTo(56, -52, 0, -50);
      g.quadraticCurveTo(-58, -50, -108, -22);
      g.fill();

      // 眉毛
      g.strokeStyle = '#3b2c20';
      g.lineWidth = 7;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-58, -22); g.quadraticCurveTo(-40, -31, -20, -25);
      g.moveTo(20, -25); g.quadraticCurveTo(40, -31, 58, -22);
      g.stroke();

      // 眼睛
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(-38, 2, 20, 12, 0, 0, TAU);
      g.ellipse(38, 2, 20, 12, 0, 0, TAU);
      g.fill();
      g.fillStyle = '#2c2119';
      g.beginPath();
      g.ellipse(-36, 2, 9.5, 9.5, 0, 0, TAU);
      g.ellipse(40, 2, 9.5, 9.5, 0, 0, TAU);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(-39, -1, 3, 3, 0, 0, TAU);
      g.ellipse(37, -1, 3, 3, 0, 0, TAU);
      g.fill();

      // 鼻子阴影 + 嘴
      g.fillStyle = 'rgba(160, 105, 70, 0.35)';
      g.beginPath();
      g.ellipse(0, 44, 9, 14, 0, 0, TAU);
      g.fill();
      g.strokeStyle = '#a3614f';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(-22, 78); g.quadraticCurveTo(0, 92, 22, 78);
      g.stroke();

      // 腮红
      g.fillStyle = 'rgba(224, 120, 110, 0.22)';
      g.beginPath();
      g.ellipse(-74, 44, 24, 15, 0, 0, TAU);
      g.ellipse(74, 44, 24, 15, 0, 0, TAU);
      g.fill();

      g.restore();
      g.restore();

      // 手势控制开启时，画两只手，方便没摄像头时演示
      if (state.handControl) {
        const open = 0.5 + 0.5 * Math.sin(s * 0.6);
        const lift = Math.sin(s * 1.1) * 12;
        const tiltHand = Math.sin(s * 0.6) * 0.18;
        const hx = VW * (0.16 + 0.07 * open);
        const hy = VH * 0.68 + lift;
        this.drawHand(hx, hy, tiltHand, false);
        this.drawHand(VW - hx, hy + Math.cos(s * 0.9) * 8, -tiltHand, true);
      }
    }

    /** 一只手：手掌 + 食指 + 拇指（肤色，够手部定位识别出指尖） */
    drawHand(x, y, angle, flip) {
      const g = this.g;
      g.save();
      g.translate(x, y);
      g.rotate(angle);
      g.fillStyle = '#e8b48f';
      // 手掌
      roundRectPath(g, -32, -20, 64, 96, 28);
      g.fill();
      // 食指（朝上）
      roundRectPath(g, -11, -104, 26, 96, 13);
      g.fill();
      // 拇指
      g.save();
      g.translate(flip ? -28 : 28, 12);
      g.rotate(flip ? 0.55 : -0.55);
      roundRectPath(g, -11, -30, 22, 62, 11);
      g.fill();
      g.restore();
      g.restore();
    }
  }

  /* ============================================================
   * 8. 视图映射 & 辅助线绘制
   * ============================================================ */

  /** 等比覆盖（cover）映射：把合成画布映射到视图 */
  function coverMap(vw, vh, iw, ih) {
    const s = Math.max(vw / iw, vh / ih);
    const w = iw * s;
    const h = ih * s;
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h, s };
  }

  function quadToView(quad, m) {
    return quad.map((p) => ({ x: m.x + p.x * m.w, y: m.y + p.y * m.h }));
  }

  function drawGuides(g, pts, alpha, ts, hint) {
    if (!pts || alpha <= 0.01) return;
    g.save();
    g.globalAlpha = alpha;

    // 边线：亮黄色 2px
    g.strokeStyle = '#ffff00';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(255, 214, 0, 0.75)';
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
    g.stroke();
    g.shadowBlur = 0;

    // 四角锚点：8px 直径实心圆
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const hot = drag && drag.kind === 'corner' && drag.index === i;
      g.beginPath();
      g.arc(p.x, p.y, hot ? 5 : 4, 0, TAU);
      g.fillStyle = '#ffff00';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      g.stroke();
      if (hot) {
        g.beginPath();
        g.arc(p.x, p.y, 11, 0, TAU);
        g.strokeStyle = 'rgba(255, 255, 0, 0.55)';
        g.lineWidth = 1.5;
        g.stroke();
      }
    }

    // 首次出现时的操作提示
    if (hint) {
      const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
      const topY = Math.min(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
      const text = '拖动四角可微调换脸位置';
      g.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      const tw = g.measureText(text).width;
      const bw = tw + 20;
      const bh = 24;
      let bx = clamp(cx - bw / 2, 8, el.view.clientWidth - bw - 8);
      let by = topY - bh - 12;
      if (by < 8) by = topY + 12;
      g.globalAlpha = alpha * 0.92;
      g.fillStyle = 'rgba(0, 0, 0, 0.62)';
      roundRectPath(g, bx, by, bw, bh, 12);
      g.fill();
      g.fillStyle = '#ffe36b';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, bx + bw / 2, by + bh / 2 + 0.5);
    }

    g.restore();
  }

  /** 手势控制的指尖标记：两个圆点 + 连线 + 状态提示 */
  function drawHandPoints(g, m, ts) {
    const hands = state.hands || [];
    const pts = hands.map((h) => ({ x: m.x + h.x * m.w, y: m.y + h.y * m.h }));
    const pulse = (Math.sin(ts / 220) + 1) / 2;

    g.save();

    if (pts.length === 2) {
      g.setLineDash([6, 6]);
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(124, 255, 155, 0.85)';
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      g.lineTo(pts[1].x, pts[1].y);
      g.stroke();
      g.setLineDash([]);
    }

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      g.beginPath();
      g.arc(p.x, p.y, 9 + pulse * 3, 0, TAU);
      g.strokeStyle = 'rgba(124, 255, 155, 0.9)';
      g.lineWidth = 2;
      g.stroke();
      g.beginPath();
      g.arc(p.x, p.y, 3.5, 0, TAU);
      g.fillStyle = '#7cff9b';
      g.fill();
    }

    const txt = hands.length === 2 ? '双手控制中' : hands.length === 1 ? '再举起另一只手' : '举起双手手指';
    g.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const tw = g.measureText(txt).width;
    const bw = tw + 24;
    const bx = clamp(m.x + m.w / 2 - bw / 2, 8, m.x + m.w - bw - 8);
    const by = m.y + 16;
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    roundRectPath(g, bx, by, bw, 26, 13);
    g.fill();
    g.fillStyle = '#c9ffd6';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, bx + bw / 2, by + 13.5);

    g.restore();
  }

  /* ============================================================
   * 9. 合成 & 渲染循环
   * ============================================================ */
  let rafId = 0;
  let lastFrame = 0;
  let lastDetect = 0;

  function ensureCompositeSize(w, h) {
    if (composite.width !== w || composite.height !== h) {
      composite.width = w;
      composite.height = h;
    }
  }

  /** 把奶龙贴纸画到合成画布上（按四角计算位置/缩放/旋转） */
  function drawStickerToComposite() {
    const q = state.quad;
    if (!q || !state.effect) return;

    const W = composite.width;
    const H = composite.height;
    const p = q.map((pt) => ({ x: pt.x * W, y: pt.y * H }));

    const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4;
    const cy = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
    const w = (dist(p[0], p[1]) + dist(p[3], p[2])) / 2;
    const h = (dist(p[0], p[3]) + dist(p[1], p[2])) / 2;
    if (w < 4 || h < 4) return;

    const angle = Math.atan2(
      p[1].y - p[0].y + (p[2].y - p[3].y),
      p[1].x - p[0].x + (p[2].x - p[3].x)
    );

    // 「对齐」：奶龙头部相对人脸框的贴合度（0.88 ~ 1.24）
    const alignGain = 0.88 + ((state.params.align - 10) / 40) * 0.36;
    // 头部高度 ≈ 1.12 倍脸框高（覆盖额头到下巴），宽度由素材自身比例决定
    const st = activeSticker();
    const aspect = st ? st.aspect : 1;
    const stretch = st ? st.stretch : 1;
    const head = h * 1.12 * (aspect / stretch) * alignGain;
    const size = head / stickerHeadRatio();

    const alpha = state.params.removal / 100;
    if (alpha <= 0.002) return;

    cctx.save();
    cctx.globalAlpha = alpha;
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.translate(cx, cy - h * 0.06);
    cctx.rotate(angle);
    cctx.drawImage(getSticker(), -size / 2, -size / 2, size, size);
    cctx.restore();
  }

  function drawView(ts) {
    const viewEl = el.view;
    const vw = viewEl.clientWidth || 1;
    const vh = viewEl.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(vw * dpr);
    const H = Math.round(vh * dpr);

    if (viewEl.width !== W || viewEl.height !== H) {
      viewEl.width = W;
      viewEl.height = H;
    }

    const g = viewEl.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, vw, vh);
    g.fillStyle = '#000';
    g.fillRect(0, 0, vw, vh);

    if (!state.source) return;

    const m = coverMap(vw, vh, composite.width, composite.height);
    state.map = m;

    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(composite, m.x, m.y, m.w, m.h);

    // 辅助线淡入
    const target = state.quad ? 1 : 0;
    state.guideAlpha = lerp(state.guideAlpha, target, 0.18);
    if (state.quad) {
      const pts = quadToView(state.quad, m);
      const hint = !state.manual && !state.effect && !state.handControl;
      drawGuides(g, pts, state.guideAlpha, ts, hint);
    }

    // 手势控制：画出指尖与连线
    if (state.handControl) drawHandPoints(g, m, ts);

    // 长时间没检测到人脸时给个提示
    if (!state.face && !state.handControl && state.source && ts - (state.lastSeenAt || 0) > 2200) {
      g.save();
      g.globalAlpha = 0.85;
      g.fillStyle = 'rgba(0, 0, 0, 0.45)';
      g.font = '14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      const txt = '请把脸放进画面中央';
      const tw = g.measureText(txt).width;
      roundRectPath(g, vw / 2 - tw / 2 - 14, 54, tw + 28, 34, 17);
      g.fill();
      g.fillStyle = '#e8e8e8';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(txt, vw / 2, 71);
      g.restore();
    }
  }

  /** 用检测结果更新四角 */
  /** 手势模式：双手指尖 → 自选框（位置 / 大小 / 旋转） */
  function updateHandTracking(ts) {
    const src = state.source;
    if (!src) return;

    // 人脸框仍然低频更新，只用于把手部检测里的脸抹掉
    if (ts - state.faceTick > 250) {
      state.faceTick = ts;
      const det = state.tracker.detect(src.el, true);
      if (det) state.faceQuad = rectToQuad(det);
    }

    const res = state.handTracker.analyze(src.el, state.faceQuad, true);
    state.hands = res.hands;

    if (res.dual) {
      const aspect = currentQuadAspect();
      const next = quadFromHands(res.dual, aspect);
      state.quad = state.quad ? lerpQuad(state.quad, next, 0.6) : next;
      state.handSeenAt = ts;
      if (!state.quadSettledAt) state.quadSettledAt = ts;
    }
  }

  /** 当前框的高宽比（拿不到就用默认的脸型比例） */
  function currentQuadAspect() {
    const q = state.quad;
    if (!q) return 1.22;
    const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    if (w < 0.01 || h < 0.01) return 1.22;
    return clamp(h / w, 0.8, 2);
  }

  function updateTracking(ts) {
    const src = state.source;
    if (!src) return;

    if (state.handControl) {
      updateHandTracking(ts);
    } else {
      const det = state.tracker.detect(src.el, true);
      state.lastSeenAt = state.lastSeenAt || 0;

      if (det) {
        state.face = true;
        state.lastSeenAt = ts;
        state.faceQuad = rectToQuad(det);

        if (!state.manual) {
          const next = state.faceQuad;
          if (!state.quad) {
            state.quad = next;
            state.quadSettledAt = ts;
          } else {
            // 大幅位移（换人 / 快速移动）时直接吸附，避免慢慢飘过去
            const px = (state.quad[0].x + state.quad[2].x) / 2;
            const py = (state.quad[0].y + state.quad[2].y) / 2;
            const nx = (next[0].x + next[2].x) / 2;
            const ny = (next[0].y + next[2].y) / 2;
            const jump = Math.hypot(nx - px, ny - py);
            state.quad = lerpQuad(state.quad, next, jump > 0.12 ? 1 : 0.72);
          }
        }
      } else {
        state.face = false;
        // 丢失超过 1 秒就丢掉历史位置，重新出现时能立刻锁到新位置
        if (ts - state.lastSeenAt > 1000) state.tracker.reset();
      }
    }

    // 辅助线静止约 1 秒后自动应用换脸效果
    if (state.quad && !state.effect) {
      const idle = ts - Math.max(state.quadSettledAt, state.lastInteraction);
      const ready = state.handControl ? state.hands.length === 2 : state.face;
      if (idle > APPLY_DELAY && ready) {
        state.effect = true;
        toastOnce('effect', '换脸效果已应用，可以开始录制啦', 'ok');
      }
    }

    updateFaceBadge();
  }

  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const interval = 1000 / clamp(state.params.fps, 15, 30);
    if (ts - lastFrame < interval - 1) return;
    lastFrame = ts;

    if (!state.source) {
      drawView(ts);
      return;
    }

    // 演示模式逐帧现画
    if (state.source.kind === 'demo') state.demo.draw(ts);

    const sw = state.source.el.videoWidth || state.source.el.width;
    const sh = state.source.el.videoHeight || state.source.el.height;
    if (sw && sh) ensureCompositeSize(sw, sh);

    // 1) 摄像头画面（镜像，符合自拍直觉）
    const W = composite.width;
    const H = composite.height;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.fillStyle = '#000';
    cctx.fillRect(0, 0, W, H);
    cctx.save();
    cctx.translate(W, 0);
    cctx.scale(-1, 1);
    cctx.drawImage(state.source.el, 0, 0, W, H);
    cctx.restore();

    // 2) 奶龙贴纸
    drawStickerToComposite();

    // 3) 视图（画面 + 辅助线）
    drawView(ts);

    // 4) 人脸定位（低频）
    if (ts - lastDetect > DETECT_INTERVAL) {
      lastDetect = ts;
      updateTracking(ts);
    }
  }

  /* ============================================================
   * 10. 四角几何
   * ============================================================ */
  function rectToQuad(r) {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const cos = Math.cos(r.angle || 0);
    const sin = Math.sin(r.angle || 0);
    const hw = r.w / 2;
    const hh = r.h / 2;
    const corners = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    return corners.map(([dx, dy]) => ({
      x: clamp(cx + dx * cos - dy * sin, 0, 1),
      y: clamp(cy + dx * sin + dy * cos, 0, 1),
    }));
  }

  function lerpQuad(a, b, t) {
    return a.map((p, i) => ({ x: lerp(p.x, b[i].x, t), y: lerp(p.y, b[i].y, t) }));
  }

  function pointInQuad(p, pts) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /* ============================================================
   * 11. 四角拖拽交互
   * ============================================================ */
  let drag = null;

  function localPoint(e) {
    const r = el.view.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function viewToNorm(p) {
    const m = state.map;
    if (!m) return null;
    return {
      x: clamp((p.x - m.x) / m.w, 0, 1),
      y: clamp((p.y - m.y) / m.h, 0, 1),
    };
  }

  function onPointerDown(e) {
    // 手势控制时由手部接管，四角不可拖
    if (state.handControl) return;
    if (!state.quad || !state.source || e.button !== 0) return;
    const p = localPoint(e);
    const pts = quadToView(state.quad, state.map);

    let hit = -1;
    for (let i = 0; i < 4; i++) {
      if (dist(p, pts[i]) <= 16) { hit = i; break; }
    }

    if (hit >= 0) {
      drag = { kind: 'corner', index: hit };
    } else if (pointInQuad(p, pts)) {
      drag = { kind: 'move', start: p, origin: state.quad.map((q) => ({ ...q })) };
    } else {
      return;
    }

    state.manual = true;
    el.btnAuto.classList.remove('hidden');
    try {
      el.view.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 合成事件没有真实指针 id 时会抛错，忽略即可 */
    }
    el.view.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function onPointerMove(e) {
    const p = localPoint(e);

    if (!drag) {
      if (!state.quad || !state.map) return;
      const pts = quadToView(state.quad, state.map);
      const near = pts.some((q) => dist(p, q) <= 16);
      el.view.style.cursor = near ? 'grab' : 'crosshair';
      return;
    }

    const n = viewToNorm(p);
    if (!n) return;

    if (drag.kind === 'corner') {
      state.quad = state.quad.map((q, i) => (i === drag.index ? { x: n.x, y: n.y } : q));
    } else {
      const startN = viewToNorm(drag.start);
      if (startN) {
        const dx = n.x - startN.x;
        const dy = n.y - startN.y;
        state.quad = drag.origin.map((q) => ({
          x: clamp(q.x + dx, 0, 1),
          y: clamp(q.y + dy, 0, 1),
        }));
      }
    }

    state.quadSettledAt = performance.now();
    state.lastInteraction = performance.now();
  }

  function onPointerUp(e) {
    if (!drag) return;
    drag = null;
    el.view.style.cursor = 'crosshair';
    state.lastInteraction = performance.now();
    state.quadSettledAt = performance.now();
    try {
      el.view.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ============================================================
   * 12. 摄像头
   * ============================================================ */
  async function getCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('NOT_SUPPORTED');
    }
    const base = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
    };
    try {
      return await navigator.mediaDevices.getUserMedia({ video: base, audio: true });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') throw err;
      // 有麦克风被占用等情况时退化为纯视频
      return await navigator.mediaDevices.getUserMedia({ video: base });
    }
  }

  async function startCamera() {
    stopSource();
    showOverlay(
      '⏳',
      '正在启动摄像头…',
      '若浏览器弹出授权提示，请点击「允许」。',
      false
    );

    try {
      const stream = await getCameraStream();
      state.camera = stream;

      const v = el.cam;
      v.srcObject = stream;
      v.muted = true;
      await v.play().catch(() => {});

      await new Promise((resolve) => {
        if (v.videoWidth) return resolve();
        const done = () => {
          v.removeEventListener('loadedmetadata', done);
          resolve();
        };
        v.addEventListener('loadedmetadata', done);
        setTimeout(done, 2500);
      });

      if (!v.videoWidth) throw new Error('NO_FRAME');

      state.source = { el: v, kind: 'camera' };
      hideOverlay();
      state.tracker.reset();
      resetQuad();
      toast('摄像头已就绪', 'ok');
    } catch (err) {
      state.source = null;
      showCameraError(err);
    }
  }

  function showCameraError(err) {
    const name = err && err.name ? err.name : '';
    const msg = err && err.message ? err.message : '';

    if (msg === 'NOT_SUPPORTED') {
      showOverlay(
        '🚫',
        '当前浏览器不支持摄像头',
        '请使用 Chrome / Edge 等现代浏览器，并通过 http://127.0.0.1:8080 打开（localhost 才允许调用摄像头）。'
      );
      return;
    }

    if (name === 'NotAllowedError' || name === 'SecurityError') {
      showOverlay(
        '🔒',
        '摄像头权限被拒绝',
        '点击地址栏左侧的摄像头图标选择「允许」，然后点重试；仍不行时可以先用演示画面体验换脸。'
      );
      return;
    }

    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      showOverlay(
        '📷',
        '没有找到可用的摄像头',
        '请连接摄像头后重试，或使用演示画面继续体验。'
      );
      return;
    }

    if (name === 'NotReadableError') {
      showOverlay(
        '⚠️',
        '摄像头被占用',
        '可能被其他程序（视频会议、直播软件）占用，关闭后点击重试。'
      );
      return;
    }

    showOverlay(
      '⚠️',
      '摄像头启动失败',
      (msg && msg !== 'NO_FRAME' ? msg : '没有拿到画面帧，请检查设备后重试。')
    );
  }

  function startDemo() {
    stopSource();
    if (!state.demo) state.demo = new DemoSource();
    state.source = { el: state.demo.canvas, kind: 'demo' };
    state.tracker.reset();
    resetQuad();
    hideOverlay();
    toast('演示画面已开启（不是真实摄像头）', 'ok');
  }

  function stopSource() {
    if (state.camera) {
      state.camera.getTracks().forEach((t) => t.stop());
      state.camera = null;
    }
    state.source = null;
    state.face = false;
    state.effect = false;
  }

  function resetQuad() {
    state.quad = null;
    state.effect = false;
    state.manual = false;
    state.guideAlpha = 0;
    state.quadSettledAt = performance.now();
    state.lastSeenAt = 0;
    el.btnAuto.classList.add('hidden');
  }

  /* ============================================================
   * 13. 录制
   * ============================================================ */
  function pickMimeType() {
    if (!window.MediaRecorder) return '';
    for (let i = 0; i < MIME_CANDIDATES.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
      } catch (e) {
        /* 忽略 */
      }
    }
    return '';
  }

  function snapshotThumb() {
    if (!composite.width) return '';
    const c = document.createElement('canvas');
    const w = 320;
    c.width = w;
    c.height = Math.max(1, Math.round((w * composite.height) / composite.width));
    const g = c.getContext('2d');
    g.drawImage(composite, 0, 0, c.width, c.height);
    try {
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) {
      return '';
    }
  }

  function startRecording() {
    if (state.finalizing) {
      toast('上一段视频正在保存，请稍候');
      return;
    }
    if (!state.source) {
      toast('摄像头还没准备好，无法录制', 'err');
      return;
    }
    if (!composite.captureStream) {
      toast('当前浏览器不支持画布录制，请使用 Chrome / Edge', 'err');
      return;
    }
    if (!state.effect) {
      toast('还没有应用换脸效果，录制的内容可能没有奶龙', '');
    }

    const fps = clamp(state.params.fps, 15, 30);
    let stream;
    try {
      stream = composite.captureStream(fps);
    } catch (e) {
      toast('创建录制流失败：' + e.message, 'err');
      return;
    }

    // 录制内容 = 画布画面 + 摄像头音频
    const audioTracks = state.camera ? state.camera.getAudioTracks() : [];
    if (audioTracks.length) {
      try {
        stream.addTrack(audioTracks[0]);
      } catch (e) {
        /* 忽略 */
      }
    }
    const canvasTracks = stream.getVideoTracks();

    const mimeType = pickMimeType();
    let rec = null;
    try {
      rec = new MediaRecorder(
        stream,
        mimeType
          ? { mimeType, videoBitsPerSecond: 5000000, audioBitsPerSecond: 128000 }
          : undefined
      );
    } catch (e) {
      try {
        rec = new MediaRecorder(stream);
      } catch (e2) {
        toast('录制初始化失败：' + e2.message, 'err');
        return;
      }
    }

    state.chunks = [];
    state.recordMime = rec.mimeType || mimeType || 'video/webm';
    state.thumbAtStart = snapshotThumb();
    state.recStart = performance.now();
    state.recStream = stream;
    state.canvasTracks = canvasTracks;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) state.chunks.push(e.data);
    };
    rec.onerror = (e) => {
      const m = e && e.error && e.error.message ? e.error.message : '未知错误';
      toast('录制出错：' + m, 'err');
      stopRecording();
    };
    rec.onstop = () => {
      finalizeRecording().catch((err) => {
        toast('保存作品失败：' + err.message, 'err');
      });
    };

    try {
      rec.start(500);
    } catch (e) {
      toast('启动录制失败：' + e.message, 'err');
      return;
    }

    state.recorder = rec;
    state.recording = true;
    updateRecordUI();
    el.recBadge.classList.remove('hidden');
    state.recTimer = window.setInterval(() => {
      el.recTime.textContent = clock(performance.now() - state.recStart);
    }, 250);
    el.recTime.textContent = '00:00';
    toast('开始录制' + (state.recordMime.indexOf('mp4') >= 0 ? '（MP4）' : '（WebM）'), 'ok');
  }

  function stopRecording() {
    if (!state.recorder) return;
    try {
      if (state.recorder.state !== 'inactive') state.recorder.stop();
    } catch (e) {
      /* 忽略 */
    }
    window.clearInterval(state.recTimer);
    state.recTimer = 0;
    state.recording = false;
    updateRecordUI();
    el.recBadge.classList.add('hidden');
  }

  async function finalizeRecording() {
    const rec = state.recorder;
    state.recorder = null;
    if (!rec) return;
    state.finalizing = true;

    try {
      const duration = (performance.now() - state.recStart) / 1000;
      const mime = state.recordMime || 'video/webm';
      const blob = new Blob(state.chunks, { type: mime });
      state.chunks = [];

      // 释放画布流（音频轨属于摄像头，不能停）
      if (state.canvasTracks) {
        state.canvasTracks.forEach((t) => {
          try { t.stop(); } catch (e) { /* 忽略 */ }
        });
        state.canvasTracks = null;
      }
      state.recStream = null;

      if (!blob.size) {
        toast('没有录到画面，请重试', 'err');
        return;
      }

      const work = {
        id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        createdAt: Date.now(),
        duration: Math.max(0.1, duration),
        mime,
        size: blob.size,
        width: composite.width,
        height: composite.height,
        fps: state.params.fps,
        thumb: state.thumbAtStart,
        blob,
      };

      await Store.put(work);
      state.lastWorkId = work.id;
      toast('录制完成，已存入「我的换脸作品」', 'ok');
      if (!el.gallery.classList.contains('hidden')) renderGallery();
    } catch (e) {
      toast('作品保存失败：' + e.message, 'err');
    } finally {
      state.finalizing = false;
    }
  }

  function updateRecordUI() {
    const b = el.btnRecord;
    if (state.recording) {
      b.textContent = '停止录制';
      b.classList.add('is-recording');
      b.classList.remove('is-active');
    } else {
      b.textContent = '开始录制';
      b.classList.remove('is-recording');
    }
  }

  /* ============================================================
   * 14. 存储（IndexedDB，失败时退化为内存）
   * ============================================================ */
  const Store = (function () {
    // 数据库名保持原名，避免升级后丢失已有作品
    const DB_NAME = 'niufaces';
    const DB_VER = 2;
    const STORE = 'works';
    const STORE_ASSETS = 'assets';
    const mem = [];
    const memAssets = {};
    let dbp = null;
    let broken = false;

    function open() {
      if (broken) return Promise.reject(new Error('IndexedDB 不可用'));
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        let req;
        try {
          req = indexedDB.open(DB_NAME, DB_VER);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const os = db.createObjectStore(STORE, { keyPath: 'id' });
            os.createIndex('createdAt', 'createdAt');
          }
          if (!db.objectStoreNames.contains(STORE_ASSETS)) {
            db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
        req.onblocked = () => reject(new Error('IndexedDB 被其他页面占用'));
      });
      dbp.catch(() => { broken = true; });
      return dbp;
    }

    function tx(mode, fn, storeName) {
      const name = storeName || STORE;
      return open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(name, mode);
            const store = t.objectStore(name);
            let req;
            try {
              req = fn(store);
            } catch (e) {
              reject(e);
              return;
            }
            t.oncomplete = () => resolve(req ? req.result : undefined);
            t.onerror = () => reject(t.error || new Error('事务失败'));
            t.onabort = () => reject(t.error || new Error('事务中止'));
          })
      );
    }

    return {
      async put(work) {
        try {
          await tx('readwrite', (s) => s.put(work));
        } catch (e) {
          broken = true;
          mem.unshift(work);
          toast('浏览器本地存储不可用，作品仅保留在本次会话', '');
        }
      },
      async all() {
        try {
          const list = await tx('readonly', (s) => s.getAll());
          return (list || []).sort((a, b) => b.createdAt - a.createdAt);
        } catch (e) {
          return mem.slice().sort((a, b) => b.createdAt - a.createdAt);
        }
      },
      async remove(id) {
        const i = mem.findIndex((w) => w.id === id);
        if (i >= 0) mem.splice(i, 1);
        try {
          await tx('readwrite', (s) => s.delete(id));
        } catch (e) {
          /* 内存里已删 */
        }
      },
      async latest() {
        const list = await this.all();
        if (state.lastWorkId) {
          const hit = list.find((w) => w.id === state.lastWorkId);
          if (hit) return hit;
        }
        return list[0] || null;
      },

      /* ---- 贴纸素材（用户导入的照片） ---- */
      async getAsset(id) {
        try {
          return await tx('readonly', (s) => s.get(id), STORE_ASSETS);
        } catch (e) {
          return memAssets[id] || null;
        }
      },
      async putAsset(id, data) {
        memAssets[id] = data;
        try {
          await tx('readwrite', (s) => s.put({ ...data, id }), STORE_ASSETS);
        } catch (e) {
          /* 退回内存，本次会话内仍可用 */
        }
      },
      async delAsset(id) {
        delete memAssets[id];
        try {
          await tx('readwrite', (s) => s.delete(id), STORE_ASSETS);
        } catch (e) {
          /* 忽略 */
        }
      },
    };
  })();

  /* ============================================================
   * 15. 作品库 UI
   * ============================================================ */
  function workName(work) {
    const ext = /mp4/i.test(work.mime) ? 'mp4' : 'webm';
    return 'nailong_play_换脸视频_' + stamp(work.createdAt) + '.' + ext;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  async function renderGallery() {
    let works = [];
    try {
      works = await Store.all();
    } catch (e) {
      works = [];
    }

    el.galleryCount.textContent = works.length ? works.length + ' 个作品' : '';
    el.galleryEmpty.classList.toggle('hidden', works.length > 0);
    el.galleryGrid.innerHTML = '';

    for (const w of works) {
      const card = document.createElement('div');
      card.className = 'work-card';

      const thumb = document.createElement('div');
      thumb.className = 'work-thumb';
      if (w.thumb) thumb.style.backgroundImage = 'url("' + w.thumb + '")';
      const dur = document.createElement('span');
      dur.className = 'work-duration';
      dur.textContent = clock(w.duration * 1000);
      thumb.appendChild(dur);

      const meta = document.createElement('div');
      meta.className = 'work-meta';
      const t = document.createElement('span');
      t.className = 'work-time';
      const d = new Date(w.createdAt);
      t.textContent =
        d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      const sz = document.createElement('span');
      sz.className = 'work-size';
      sz.textContent = humanSize(w.size) + ' · ' + (w.width || '?') + '×' + (w.height || '?');
      meta.appendChild(t);
      meta.appendChild(sz);

      const actions = document.createElement('div');
      actions.className = 'work-actions';
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'btn is-active';
      dl.textContent = '下载';
      dl.addEventListener('click', () => {
        downloadBlob(w.blob, workName(w));
        toast('已开始下载 ' + workName(w), 'ok');
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-ghost btn-danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        if (!window.confirm('确定删除这个换脸作品吗？')) return;
        await Store.remove(w.id);
        if (state.lastWorkId === w.id) state.lastWorkId = null;
        toast('已删除', 'ok');
        renderGallery();
      });
      actions.appendChild(dl);
      actions.appendChild(del);

      card.appendChild(thumb);
      card.appendChild(meta);
      card.appendChild(actions);
      el.galleryGrid.appendChild(card);
    }
  }

  /* ============================================================
   * 16. 导出
   * ============================================================ */
  async function exportLatest() {
    if (state.exporting) return;
    state.exporting = true;
    const b = el.btnExport;
    const label = b.textContent;
    b.textContent = '导出中…';
    b.classList.add('is-busy');

    try {
      const work = await Store.latest();
      if (!work) {
        toast('还没有录制的视频，先点「开始录制」吧', 'err');
        return;
      }
      await sleep(220); // 让加载状态可见
      const name = workName(work);
      downloadBlob(work.blob, name);
      const isMp4 = /mp4/i.test(work.mime);
      toast(
        isMp4
          ? '已开始下载 ' + name
          : '已开始下载 ' + name + '（当前浏览器录制为 WebM，可转成 MP4）',
        'ok'
      );
    } catch (e) {
      toast('导出失败：' + (e && e.message ? e.message : '未知错误') + '，请重试', 'err');
    } finally {
      state.exporting = false;
      b.textContent = label;
      b.classList.remove('is-busy');
    }
  }

  /* ============================================================
   * 17. 弹层：作品库 / 模板
   * ============================================================ */
  function openSheet(node) {
    node.classList.remove('hidden');
  }

  function closeSheet(node) {
    node.classList.add('hidden');
  }

  function setActiveNav(which) {
    el.btnWorks.classList.toggle('is-active', which === 'works');
    el.btnSwitch.classList.toggle('is-active', which === 'switch');
  }

  function openGallery() {
    setActiveNav('works');
    openSheet(el.gallery);
    renderGallery();
  }

  function closeGallery() {
    closeSheet(el.gallery);
    setActiveNav('works');
  }

  function renderTemplates() {
    el.tplGrid.innerHTML = '';

    /** 生成一个模板卡片 */
    function addTile(opts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tpl-item' + (opts.selected ? ' is-selected' : '') +
        (opts.importTile ? ' tpl-import' : '');
      btn.title = opts.title || opts.name;

      const thumb = document.createElement('div');
      thumb.className = 'tpl-thumb';
      if (opts.canvasThumb) {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 160;
        drawStickerArt(c.getContext('2d'), 160, opts.canvasThumb);
        thumb.appendChild(c);
      } else if (opts.imgUrl) {
        const im = document.createElement('img');
        im.src = opts.imgUrl;
        im.alt = opts.name;
        thumb.appendChild(im);
      } else {
        thumb.textContent = '＋';
      }

      const label = document.createElement('span');
      label.textContent = opts.name;

      btn.appendChild(thumb);
      btn.appendChild(label);
      btn.addEventListener('click', opts.onClick);

      if (opts.onDelete) {
        const del = document.createElement('span');
        del.className = 'tpl-del';
        del.textContent = '✕';
        del.title = '删除这张照片';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          opts.onDelete();
        });
        btn.appendChild(del);
      }
      el.tplGrid.appendChild(btn);
    }

    // 内置奶龙
    addTile({
      name: '奶龙',
      canvasThumb: BUILTIN_STICKER,
      selected: state.templateId === 'nailong',
      onClick: () => {
        state.templateId = 'nailong';
        stickerCache = { key: '', canvas: null };
        renderTemplates();
        toast('已切换到「奶龙」模板', 'ok');
      },
    });

    // 用户导入的照片
    if (state.custom) {
      addTile({
        name: '我的照片',
        imgUrl: state.custom.thumbUrl,
        selected: state.templateId === 'custom',
        onClick: () => {
          state.templateId = 'custom';
          stickerCache = { key: '', canvas: null };
          renderTemplates();
          toast('已切换到「我的照片」', 'ok');
        },
        onDelete: () => {
          if (window.confirm('删除导入的照片，恢复内置奶龙？')) clearCustomSticker();
        },
      });
    }

    // 导入入口
    addTile({
      name: '导入照片',
      importTile: true,
      title: '选择本地图片作为贴纸',
      onClick: () => {
        el.photoInput.click();
      },
    });
  }

  function openTemplates() {
    setActiveNav('switch');
    renderTemplates();
    openSheet(el.templates);
  }

  function closeTemplates() {
    closeSheet(el.templates);
    setActiveNav('works');
  }

  /* ============================================================
   * 18. 提示 & 状态
   * ============================================================ */
  const toastShown = new Set();

  function toast(msg, type, ms) {
    const node = document.createElement('div');
    node.className = 'toast' + (type === 'ok' ? ' is-ok' : type === 'err' ? ' is-err' : '');
    node.textContent = msg;
    el.toasts.appendChild(node);
    const life = ms || (type === 'err' ? 3600 : 2600);
    setTimeout(() => {
      node.classList.add('is-leave');
      setTimeout(() => node.remove(), 260);
    }, life);
  }

  function toastOnce(key, msg, type) {
    if (toastShown.has(key)) return;
    toastShown.add(key);
    toast(msg, type);
  }

  /** 手势控制开关：双手手指控制自选框 */
  function toggleHandControl() {
    state.handControl = !state.handControl;
    el.btnHand.classList.toggle('is-on', state.handControl);
    el.btnHand.textContent = state.handControl ? '✋ 手势控制中' : '✋ 手势控制';
    state.hands = [];
    state.handTracker.reset();
    state.faceQuad = state.quad ? state.quad.map((p) => ({ ...p })) : null;

    if (state.handControl) {
      state.manual = false;
      state.faceTick = 0;
      el.btnAuto.classList.add('hidden');
      toast('举起双手并伸出食指：两手间距控制大小、两手位置控制位置、手的倾斜控制旋转', 'ok', 4200);
    } else {
      state.tracker.reset();
      toast('已切回自动人脸对位');
    }
    updateFaceBadge();
  }

  function updateFaceBadge() {
    const b = el.faceBadge;
    let text;
    let cls = '';

    if (state.handControl) {
      const two = state.hands.length === 2;
      text = two ? '手势控制 · 双手' : '手势控制 · 找手中';
      cls = two ? 'is-ok' : 'is-warn';
    } else if (!state.source) {
      text = '等待摄像头…';
    } else if (state.source.kind === 'demo') {
      text = state.face ? '演示画面 · 已定位' : '演示画面';
      cls = 'is-ok';
    } else if (state.face) {
      text = '已检测到人脸';
      cls = 'is-ok';
    } else if (state.effect) {
      text = '跟踪中…';
      cls = 'is-warn';
    } else {
      text = '未检测到人脸';
      cls = 'is-warn';
    }

    if (b.textContent !== text) b.textContent = text;
    b.classList.toggle('is-ok', cls === 'is-ok');
    b.classList.toggle('is-warn', cls === 'is-warn');
  }

  function showOverlay(icon, title, desc, showActions) {
    el.ovIcon.textContent = icon;
    el.ovTitle.textContent = title;
    el.ovDesc.textContent = desc;
    el.ovActions.classList.toggle('hidden', showActions === false);
    el.overlay.classList.remove('hidden');
  }

  function hideOverlay() {
    el.overlay.classList.add('hidden');
  }

  /* ============================================================
   * 19. 参数绑定
   * ============================================================ */
  function paintRange(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const val = Number(input.value);
    const pct = ((val - min) / (max - min)) * 100;
    input.style.setProperty('--fill', pct + '%');
  }

  function loadParams() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        for (const k of Object.keys(DEFAULT_PARAMS)) {
          if (saved && typeof saved[k] === 'number' && isFinite(saved[k])) {
            const [a, b] = LIMITS[k];
            state.params[k] = clamp(Math.round(saved[k]), a, b);
          }
        }
      }
    } catch (e) {
      /* 忽略 */
    }
  }

  function saveParams() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.params));
    } catch (e) {
      /* 忽略 */
    }
  }

  function bindParams() {
    const map = [
      { key: 'smooth', input: el.rSmooth, out: el.vSmooth, fmt: (v) => String(v) },
      { key: 'fps', input: el.rFps, out: el.vFps, fmt: (v) => v + ' FPS' },
      { key: 'align', input: el.rAlign, out: el.vAlign, fmt: (v) => String(v) },
      { key: 'removal', input: el.rRemove, out: el.vRemove, fmt: (v) => v + '%' },
    ];

    for (const item of map) {
      const apply = () => {
        const [a, b] = LIMITS[item.key];
        const v = clamp(Math.round(Number(item.input.value)), a, b);
        const changed = state.params[item.key] !== v;
        state.params[item.key] = v;
        item.out.textContent = item.fmt(v);
        paintRange(item.input);
        if (item.key === 'fps' && changed && state.recording) {
          toast('帧数将在下次录制时生效');
        }
        saveParams();
      };
      item.input.addEventListener('input', apply);
      item.input.value = state.params[item.key];
      item.out.textContent = item.fmt(state.params[item.key]);
      paintRange(item.input);
    }
  }

  /* ============================================================
   * 20. 初始化
   * ============================================================ */
  function cacheDom() {
    el.view = $('view');
    el.cam = $('cam');
    el.stage = $('stage');

    el.btnWorks = $('btn-works');
    el.btnSwitch = $('btn-switch');
    el.btnRecord = $('btn-record');
    el.btnExport = $('btn-export');

    el.rSmooth = $('r-smooth');
    el.rFps = $('r-fps');
    el.rAlign = $('r-align');
    el.rRemove = $('r-remove');
    el.vSmooth = $('v-smooth');
    el.vFps = $('v-fps');
    el.vAlign = $('v-align');
    el.vRemove = $('v-remove');

    el.faceBadge = $('face-badge');
    el.recBadge = $('rec-badge');
    el.recTime = $('rec-time');
    el.btnAuto = $('btn-auto');
    el.btnHand = $('btn-hand');
    el.toasts = $('toasts');

    el.overlay = $('stage-overlay');
    el.ovIcon = $('ov-icon');
    el.ovTitle = $('ov-title');
    el.ovDesc = $('ov-desc');
    el.ovActions = el.overlay.querySelector('.overlay-actions');

    el.gallery = $('gallery');
    el.galleryGrid = $('gallery-grid');
    el.galleryEmpty = $('gallery-empty');
    el.galleryCount = $('gallery-count');

    el.templates = $('templates');
    el.tplGrid = $('tpl-grid');
    el.photoInput = $('photo-input');

    document.body.appendChild(composite);
  }

  function bindUi() {
    el.view.addEventListener('pointerdown', onPointerDown);
    el.view.addEventListener('pointermove', onPointerMove);
    el.view.addEventListener('pointerup', onPointerUp);
    el.view.addEventListener('pointercancel', onPointerUp);

    el.btnWorks.addEventListener('click', () => {
      if (el.gallery.classList.contains('hidden')) openGallery();
      else closeGallery();
    });
    el.btnSwitch.addEventListener('click', () => {
      if (el.templates.classList.contains('hidden')) openTemplates();
      else closeTemplates();
    });
    el.btnRecord.addEventListener('click', () => {
      if (state.recording) stopRecording();
      else startRecording();
    });
    el.btnExport.addEventListener('click', exportLatest);

    el.btnAuto.addEventListener('click', () => {
      state.manual = false;
      state.tracker.reset();
      state.effect = false;
      el.btnAuto.classList.add('hidden');
      toast('已恢复自动对位');
    });

    el.btnHand.addEventListener('click', toggleHandControl);

    $('gallery-close').addEventListener('click', closeGallery);
    $('gallery-go-record').addEventListener('click', () => {
      closeGallery();
      if (!state.recording) startRecording();
    });
    $('tpl-close').addEventListener('click', closeTemplates);
    $('tpl-done').addEventListener('click', closeTemplates);

    // 导入本地照片
    el.photoInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importPhotoFile(file);
    });

    el.gallery.addEventListener('click', (e) => {
      if (e.target === el.gallery) closeGallery();
    });
    el.templates.addEventListener('click', (e) => {
      if (e.target === el.templates) closeTemplates();
    });

    $('ov-retry').addEventListener('click', () => startCamera());
    $('ov-demo').addEventListener('click', () => startDemo());

    document.addEventListener('keydown', (e) => {
      const sheetOpen =
        !el.gallery.classList.contains('hidden') || !el.templates.classList.contains('hidden');
      const typing = e.target && e.target.closest && e.target.closest('input, textarea');

      if (e.key === 'Escape') {
        if (!el.gallery.classList.contains('hidden')) closeGallery();
        else if (!el.templates.classList.contains('hidden')) closeTemplates();
        return;
      }

      if (sheetOpen || typing || e.metaKey || e.ctrlKey || e.altKey) return;

      // R：开始 / 停止录制
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (state.recording) stopRecording();
        else startRecording();
      }
      // E：导出
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        exportLatest();
      }
    });

    window.addEventListener('resize', () => {
      // 画面尺寸变化时，辅助线归一化坐标不受影响，下一帧自动重绘
    });

    // 页面隐藏时暂停录制计时器显示，避免后台时间跳跃
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.recording) {
        el.recTime.textContent = clock(performance.now() - state.recStart);
      }
    });
  }

  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  async function boot() {
    cacheDom();
    loadParams();
    bindParams();
    bindUi();

    requestAnimationFrame(frame);

    // 恢复上次导入的贴纸
    try {
      const saved = await Store.getAsset(CUSTOM_ASSET_KEY);
      if (saved && saved.dataUrl) {
        const img = await loadImageFromUrl(saved.dataUrl);
        state.custom = Object.assign({}, saved, { img });
        state.customVersion++;
        state.templateId = 'custom';
      }
    } catch (e) {
      /* 没有导入过或存储不可用，忽略 */
    }

    const isDemo = new URLSearchParams(location.search).get('demo') === '1';
    if (isDemo) {
      // 等一帧再启动，确保画布尺寸有效
      await sleep(60);
      startDemo();
    } else {
      await startCamera();
    }

    updateRecordUI();
    updateFaceBadge();
    state.started = true;
    readyResolve();

    // 首次进入的引导
    setTimeout(() => {
      if (state.effect) return;
      toast('正对摄像头，等黄色辅助线稳定后会自动戴上奶龙脸', '', 3400);
    }, 1200);
  }

  /* 调试 / 自动化测试接口 */
  window.__nailong_play = {
    state,
    ready: readyPromise,
    api: {
      startCamera,
      startDemo,
      startRecording,
      stopRecording,
      exportLatest,
      resetQuad,
      importPhotoFile,
      buildCustomSticker,
      applyCustomSticker,
      clearCustomSticker,
      loadImageFromFile,
    },
    createFaceTracker,
    createHandTracker,
    quadFromHands,
    composite,
    getSticker,
    rectToQuad,
    Store,
    workName,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
