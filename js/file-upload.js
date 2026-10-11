/* ============================================================
 * 作文文件识别（纯浏览器端解析，无需后端依赖）
 * 支持：.txt / .md（自动识别 UTF-8 与 GBK）
 *       .docx（mammoth.js，保留段落换行）
 *       .pdf（pdf.js，按坐标还原段落）
 *       .png/.jpg/.jpeg/.webp（tesseract.js 中文 OCR）
 * 第三方库仅在真正上传对应格式时才从 CDN 按需加载
 * ============================================================ */
(function () {
  'use strict';

  // 国内优先的 npm 镜像（阿里 npmmirror）+ jsDelivr 国内镜像 + 官方源，逐个兜底
  var NPM = 'https://registry.npmmirror.com';

  // 各库提供多个 CDN 源，前一个失败自动尝试下一个（兼顾国内网络）
  var LIBS = {
    mammoth: [
      NPM + '/mammoth/1.6.0/files/mammoth.browser.min.js',
      'https://cdn.jsdmirror.com/npm/mammoth@1.6.0/mammoth.browser.min.js',
      'https://fastly.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
      'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
      'https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js'
    ],
    pdfjs: [
      NPM + '/pdfjs-dist/3.11.174/files/legacy/build/pdf.min.js',
      'https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
      'https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    ],
    tesseract: [
      NPM + '/tesseract.js/5.1.1/files/dist/tesseract.min.js',
      'https://cdn.jsdmirror.com/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      'https://fastly.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js',
      'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
    ]
  };

  // PDF worker 多源（与主库同源优先）
  var PDF_WORKERS = [
    NPM + '/pdfjs-dist/3.11.174/files/legacy/build/pdf.worker.min.js',
    'https://cdn.jsdmirror.com/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js',
    'https://fastly.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js',
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  ];

  // OCR 三类资源候选源：使用时先做小流量竞速探测，选最快可达的一条
  // 语言包优先用 best_int 轻量模型（约 1.7MB，打印体识别质量足够），
  // 官方 20MB 标准版仅作最后兜底
  var TESS_WORKERS = [
    NPM + '/tesseract.js/5.1.1/files/dist/worker.min.js',
    'https://cdn.jsdmirror.com/npm/tesseract.js@5.1.1/dist/worker.min.js',
    'https://fastly.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js'
  ];
  // corePath 给目录，tesseract 会自动拼 tesseract-core-simd.wasm.js
  var TESS_CORES = [
    NPM + '/tesseract.js-core/5.1.1/files',
    'https://cdn.jsdmirror.com/npm/tesseract.js-core@5.1.1',
    'https://fastly.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    'https://unpkg.com/tesseract.js-core@5.1.1'
  ];
  var TESS_LANGS = [
    'https://cdn.jsdmirror.com/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int',
    'https://fastly.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int',
    'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int',
    'https://ghproxy.net/https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best_int',
    'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_best_int',
    'https://tessdata.projectnaptha.com/4.0.0'
  ];

  var MAX_DOC_MB = 20;   // 文档类（docx/pdf/txt）
  var MAX_IMG_MB = 15;   // 图片 OCR

  var loading = {};

  /* ---------- 动态加载脚本（带备用源） ---------- */
  function loadScript(urls, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (loading[globalName || urls[0]]) return loading[globalName || urls[0]];

    var done = urls.reduce(function (chain, url) {
      return chain.catch(function () {
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = url;
          s.async = true;
          s.onload = function () { resolve(); };
          s.onerror = function () {
            if (s.parentNode) s.parentNode.removeChild(s);
            reject(new Error('CDN 加载失败：' + url));
          };
          document.head.appendChild(s);
        });
      });
    }, Promise.reject());

    loading[globalName || urls[0]] = done.catch(function () {
      delete loading[globalName || urls[0]];
      throw new Error('识别组件加载失败，请检查网络后重试（可换网络或稍后再试）。');
    });
    return loading[globalName || urls[0]];
  }

  /* ---------- 通用工具 ---------- */
  function getExt(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  // 连续 3 个以上换行压成空行分段；去除行首行尾多余空白，保留段落结构
  function normalizeText(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function isCJK(ch) {
    return /[一-鿿]/.test(ch);
  }

  /* ---------- TXT / MD：UTF-8 优先，乱码则回退 GBK ---------- */
  function readTextFile(buf) {
    var text = new TextDecoder('utf-8').decode(buf);
    // UTF-8 解码出现大量替换符，说明很可能是 GBK/ANSI 编码
    var bad = (text.match(/�/g) || []).length;
    if (bad >= 2 && bad > text.length * 0.01) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (e) {}
    }
    return normalizeText(text);
  }

  /* ---------- DOCX：mammoth 提取纯文本（保留段落） ---------- */
  function parseDocx(file, report) {
    return loadScript(LIBS.mammoth, 'mammoth').then(function () {
      return file.arrayBuffer();
    }).then(function (buf) {
      return window.mammoth.extractRawText({ arrayBuffer: buf });
    }).then(function (res) {
      var text = normalizeText(res.value);
      if (!text) throw new Error('未从 Word 文档中识别到文字（文档可能是扫描图片版，请改用图片上传走 OCR）。');
      report({ status: '识别到 ' + text.replace(/[^\n]/g, '').length + ' 个段落', ratio: 1 });
      return { text: text, kind: 'docx', titleGuess: guessTitle(text) };
    });
  }

  /* ---------- PDF：pdf.js 按页提取，按纵坐标还原换行/分段 ---------- */
  function parsePdf(file, report) {
    var workerSrc = '';
    return loadScript(LIBS.pdfjs, 'pdfjsLib').then(function () {
      var pdfjs = window.pdfjsLib;
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        return pickFastest(PDF_WORKERS, '').then(function (src) {
          workerSrc = src || PDF_WORKERS[0];
          pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
        });
      }
    }).then(function () {
      return file.arrayBuffer();
    }).then(function (buf) {
      var task = window.pdfjsLib.getDocument({ data: buf });
      return task.promise.then(function (pdf) {
        var pageCount = pdf.numPages;
        var pages = [];
        function next(i) {
          if (i > pageCount) return Promise.all(pages).then(function (arr) {
            return arr.join('\n\n');
          });
          var p = pdf.getPage(i).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var line = assembleLines(tc.items);
              report({ status: '正在识别 PDF 第 ' + i + ' / ' + pageCount + ' 页', ratio: i / pageCount });
              return line;
            });
          });
          pages.push(p);
          return p.then(function () { return next(i + 1); });
        }
        return next(1);
      });
    }).then(function (text) {
      text = normalizeText(text);
      if (!text) throw new Error('未从 PDF 中识别到文字（该 PDF 可能是扫描件/图片版，请截图后用图片上传走 OCR）。');
      return { text: text, kind: 'pdf', titleGuess: guessTitle(text) };
    });
  }

  // 依据 y 坐标分行；中文相邻片段不加空格，英文/数字间补空格
  function assembleLines(items) {
    var lines = [];
    var curY = null, cur = '';
    var TOL = 3;
    items.forEach(function (it) {
      if (!it.str) return;
      var y = it.transform ? it.transform[5] : 0;
      if (curY === null || Math.abs(y - curY) > TOL) {
        if (cur.trim()) lines.push(cur);
        cur = it.str;
        curY = y;
      } else {
        var prev = cur.slice(-1), next = it.str.charAt(0);
        if (isCJK(prev) && isCJK(next)) {
          // 中文相邻直接拼接
          cur += it.str;
        } else if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) {
          // 英文/数字相邻补空格
          cur += ' ' + it.str;
        } else if (isCJK(prev) || isCJK(next) || /[\s，。！？；：、""''（）《》—…]/.test(prev + next)) {
          cur += it.str;
        } else {
          cur += ' ' + it.str;
        }
      }
    });
    if (cur.trim()) lines.push(cur);

    // 合成段落：行首缩进（2 空格/全角空格）视为新段落，否则与上行拼接
    var paras = [], buf = '';
    lines.forEach(function (ln) {
      var t = ln.replace(/\s+$/, '');
      if (/^[ \u3000]{2,}/.test(ln) || /^\d+[.、)]/.test(ln) || /^[一二三四五六七八九十]+[、.]/.test(ln)) {
        if (buf) paras.push(buf);
        buf = t.replace(/^[ \u3000]+/, '');
      } else if (buf) {
        var prevCh = buf.slice(-1);
        buf += /[，、；：（“《—…\s]/.test(prevCh) || isCJK(t.charAt(0)) ? t.replace(/^[ \u3000]+/, '') : t;
      } else {
        buf = t.replace(/^[ \u3000]+/, '');
      }
    });
    if (buf) paras.push(buf);
    return paras.join('\n\n');
  }

  /* ---------- CDN 竞速：小流量探测，返回最快可达的基址 ---------- */
  function reachable(fileUrl) {
    return new Promise(function (resolve) {
      var ctrl = null, finished = false;
      try { ctrl = new AbortController(); } catch (e) {}
      var timer = setTimeout(function () {
        finished = true;
        try { ctrl && ctrl.abort(); } catch (e) {}
        resolve(false);
      }, 9000);
      fetch(fileUrl, {
        method: 'GET',
        headers: { Range: 'bytes=0-2047' },
        signal: ctrl ? ctrl.signal : undefined,
        mode: 'cors',
        cache: 'no-store'
      }).then(function (r) {
        if (finished) return;
        clearTimeout(timer); finished = true;
        resolve(r.status === 200 || r.status === 206);
      }).catch(function () {
        if (finished) return;
        clearTimeout(timer); finished = true;
        resolve(false);
      });
    });
  }

  // bases：候选基址数组；fileRel：需探测的文件名（base 本身就是完整文件时传 ''）
  function pickFastest(bases, fileRel) {
    return new Promise(function (resolve) {
      var done = false, remaining = bases.length;
      bases.forEach(function (base) {
        var url = fileRel ? base.replace(/\/$/, '') + '/' + fileRel : base;
        reachable(url).then(function (ok) {
          if (done) return;
          if (ok) { done = true; resolve(base); }
          else {
            remaining--;
            if (remaining === 0) resolve(null);
          }
        });
      });
    });
  }

  // OCR 任务句柄（供取消时 terminate）；tesseract worker 跨页复用，避免每张重复建
  var activeWorker = null;
  var tessWorker = null, tessWorkerPromise = null;
  function cancelOcr() {
    if (activeWorker) {
      try { activeWorker.terminate(); } catch (e) {}
      activeWorker = null;
    }
    tessWorker = null;
    tessWorkerPromise = null;
  }

  // OCR 各阶段 → 进度映射，让用户看到真实进展而不是卡死
  function ocrProgress(m, report) {
    var s = String(m && m.status || '');
    var p = +(m && m.progress) || 0;
    if (s.indexOf('loading tesseract core') >= 0) {
      report({ status: '正在加载识别核心组件…', ratio: 0.06 });
    } else if (s.indexOf('initializing tesseract') >= 0) {
      report({ status: '正在初始化识别引擎…', ratio: 0.10 });
    } else if (s.indexOf('loading language traineddata') >= 0) {
      report({
        status: '正在下载中文识别模型（约 1.7MB，仅首次）' + (p > 0 ? '　' + Math.round(p * 100) + '%' : ''),
        ratio: 0.12 + 0.55 * p
      });
    } else if (s.indexOf('loaded language traineddata') >= 0) {
      report({ status: '中文模型就绪', ratio: 0.70 });
    } else if (s.indexOf('initializing api') >= 0) {
      report({ status: '正在装载识别词典…', ratio: 0.74 });
    } else if (s.indexOf('recognizing text') >= 0) {
      report({ status: '正在逐行识别图片文字　' + Math.round(p * 100) + '%', ratio: 0.80 + 0.19 * p });
    }
  }

  /* ---------- 图片预处理：EXIF 旋转修正 + 缩放（两条识别通道共用） ---------- */
  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        resolve({
          src: img, w: img.naturalWidth, h: img.naturalHeight,
          close: function () { URL.revokeObjectURL(url); }
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('图片无法解码，请换一张试试（支持 jpg/png/webp）。'));
      };
      img.src = url;
    });
  }

  // 优先 createImageBitmap（按 EXIF 方向自动转正，iOS≥16/安卓均支持），失败降级 <img>
  function loadDrawable(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
        return {
          src: bmp, w: bmp.width, h: bmp.height,
          close: function () { try { bmp.close(); } catch (e) {} }
        };
      }, function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  // opts.longEdge：长边压缩上限；opts.enhance：灰度化 + 对比度拉伸（提升本地 OCR 适应性）
  function preprocessImage(file, opts) {
    var longEdge = (opts && opts.longEdge) || 1800;
    var enhance = !!(opts && opts.enhance);
    return loadDrawable(file).then(function (d) {
      if (!d.w || !d.h) { d.close(); throw new Error('图片无法解码，请换一张试试。'); }
      var scale = Math.min(1, longEdge / Math.max(d.w, d.h));
      var w = Math.max(1, Math.round(d.w * scale));
      var h = Math.max(1, Math.round(d.h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // 透明底填白，避免黑底
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(d.src, 0, 0, w, h);
      d.close();
      if (enhance) {
        var im = ctx.getImageData(0, 0, w, h);
        var px = im.data, n = px.length;
        var gray = new Uint8Array(n / 4);
        for (var i = 0, j = 0; i < n; i += 4, j++) {
          gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
        }
        // 按 0.5% / 99.5% 分位做对比度拉伸，抵消光照不均与纸张发灰。
        // 注意：稀疏文字图的暗像素占比极低（细笔画+抗锯齿可能不到 1%），
        // 分位过大或 lo/hi 退化时必须跳过拉伸，否则会把整图压成全黑。
        var hist = new Uint32Array(256);
        for (var k = 0; k < gray.length; k++) hist[gray[k]]++;
        var cut = Math.max(8, Math.floor(gray.length * 0.005)), acc = 0, lo = 0, hi = 255;
        for (var a = 0; a < 256; a++) { acc += hist[a]; if (acc >= cut) { lo = a; break; } }
        acc = 0;
        for (var b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= cut) { hi = b; break; } }
        var doStretch = hi - lo >= 40;
        var range = doStretch ? hi - lo : 1;
        for (var i2 = 0, j2 = 0; i2 < n; i2 += 4, j2++) {
          var g = doStretch ? Math.round((gray[j2] - lo) * 255 / range) : gray[j2];
          if (g < 0) g = 0; else if (g > 255) g = 255;
          px[i2] = px[i2 + 1] = px[i2 + 2] = g;
        }
        ctx.putImageData(im, 0, 0);
      }
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('图片处理失败，请换一张试试。')); return; }
          resolve({ blob: blob, dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h });
        }, 'image/jpeg', 0.85);
      });
    });
  }

  /* ---------- 服务端配置（懒加载，判断视觉识别通道是否可用） ---------- */
  var serverCfgPromise = null;
  function getServerCfg() {
    if (!serverCfgPromise) {
      serverCfgPromise = fetch('/api/config', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .catch(function () { return {}; });
    }
    return serverCfgPromise;
  }

  // 服务端视觉模型识别手写文字：成功返回文本；失败抛出带 code 的错误
  function serverOcr(dataUrl, report) {
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) {}
    var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) {} }, 90000);
    return fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ image: dataUrl }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.json().then(function (j) {
        clearTimeout(timer);
        if (!r.ok || !j || !j.ok) {
          var err = new Error((j && j.message) || '服务端识别失败（HTTP ' + r.status + '）');
          err.code = j && j.code;
          err.status = r.status;
          throw err;
        }
        return String(j.text || '');
      });
    }, function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('识别请求超时，请重试。');
      throw e;
    });
  }

  /* ---------- 整页切条并行识别（提高手写识别准确率的关键） ----------
   * 手机拍的整页作文有 15~25 行，整页一次送视觉模型时单字有效分辨率不足，
   * 容易漏行、串行。把图按高度切成 2~3 条并行送给视觉模型，每个字的有效
   * 分辨率成倍提高；并行执行不增加总耗时。
   * 切缝优先落在文字行之间的空白带（按行内暗像素数检测），保证不切断文
   * 字、也不会产生重复；找不到空白带的边界退回重叠切法，由
   * joinStripTexts 去重兜底。 */
  function findBlankRow(canvas, yCenter, win) {
    var w = canvas.width, h = canvas.height;
    var y0 = Math.max(0, yCenter - win);
    var hh = Math.min(h, yCenter + win + 1) - y0;
    if (hh <= 0) return { y: yCenter, t: yCenter, dark: 1e9 };
    var ctx = canvas.getContext('2d');
    var px = ctx.getImageData(0, y0, w, hh).data;
    var bestR = 0, bestC = 1e9;
    var step = Math.max(1, Math.floor(w / 600)); // 大图横向抽样省时
    for (var r = 0; r < hh; r++) {
      var c = 0;
      for (var x = 0; x < w; x += step) {
        var i = (r * w + x) * 4;
        var g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
        if (g < 150) c++; // 深色笔画；淡红格线灰度约 210 不计入
      }
      if (c < bestC) { bestC = c; bestR = r; }
    }
    return { y: y0 + bestR, t: yCenter, dark: bestC };
  }

  function splitStrips(dataUrl, n) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          if (n <= 1) { resolve([dataUrl]); return; }
          var w = img.naturalWidth, h = img.naturalHeight;
          var base = document.createElement('canvas');
          base.width = w; base.height = h;
          var bctx = base.getContext('2d');
          bctx.fillStyle = '#fff';
          bctx.fillRect(0, 0, w, h);
          bctx.drawImage(img, 0, 0);

          var ov = Math.max(40, Math.round(h / n * 0.15)); // 兜底重叠高度
          var pad = 14;                                    // 上下留白防贴边漏字
          var win = Math.max(24, Math.round(h / n * 0.08)); // 空白带搜索半径
          var cleanMax = Math.max(6, Math.round(w * 0.004)); // 视为空白带的暗像素上限

          var cuts = [];
          for (var c = 1; c < n; c++) cuts.push(findBlankRow(base, Math.round(h * c / n), win));

          var strips = [];
          for (var i = 0; i < n; i++) {
            var y0, y1;
            if (i === 0) y0 = 0;
            else y0 = cuts[i - 1].dark <= cleanMax ? cuts[i - 1].y : Math.max(0, cuts[i - 1].t - (ov >> 1));
            if (i === n - 1) y1 = h;
            else y1 = cuts[i].dark <= cleanMax ? cuts[i].y : Math.min(h, cuts[i].t + (ov >> 1));
            var ch = y1 - y0;
            if (ch < 40) continue;
            var cc = document.createElement('canvas');
            cc.width = w; cc.height = ch + pad * 2;
            var ctx = cc.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, cc.width, cc.height);
            ctx.drawImage(base, 0, y0, w, ch, 0, pad, w, ch);
            strips.push(cc.toDataURL('image/jpeg', 0.9));
          }
          resolve(strips.length ? strips : [dataUrl]);
        } catch (e) { resolve([dataUrl]); }
      };
      img.onerror = function () { resolve([dataUrl]); }; // 解码失败就整页单条识别
      img.src = dataUrl;
    });
  }

  // 条数：竖版长图切更多条（作文照片典型比例 3:4 ~ 9:16）
  function stripCountFor(w, h) {
    var r = h / Math.max(1, w);
    if (r >= 1.9) return 3;
    if (r >= 1.2) return 2;
    return 1;
  }

  // 拼接各条转写结果：相邻条重叠区会重复转写，按行文本去重（去空白后比对）
  function joinStripTexts(parts) {
    var norm = function (s) { return String(s).replace(/[\s\u3000]+/g, ''); };
    var all = null;
    parts.forEach(function (p) {
      var lines = String(p || '').replace(/\r/g, '').split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (!lines.length) return;
      if (all && all.length) {
        // 1) 尾部锚定：重叠区通常正好落在上一条结尾
        var maxK = Math.min(6, all.length, lines.length), k = 0;
        for (var cand = maxK; cand >= 1; cand--) {
          var tail = norm(all.slice(-cand).join(''));
          if (tail && tail === norm(lines.slice(0, cand).join(''))) { k = cand; break; }
        }
        // 2) 全文包含：上一条已完整覆盖本条开头的重复行（不止结尾的情形）
        if (!k) {
          var joinedN = norm(all.join(''));
          for (var cand2 = Math.min(6, lines.length); cand2 >= 2; cand2--) {
            var head = norm(lines.slice(0, cand2).join(''));
            if (head && joinedN.indexOf(head) >= 0) { k = cand2; break; }
          }
        }
        // 3) 字符级后缀-前缀：容忍模型把两行并作一行/漏行的情形，
        //    在归一化字符流上找 A 尾部与 B 头部的最长公共块（≥10 字）
        if (!k) {
          var aN = norm(all.join(''));
          var bNLines = lines.map(norm);
          var bCum = [0];
          bNLines.forEach(function (t, bi) { bCum.push(bCum[bi] + t.length); });
          var bN = bNLines.join('');
          var maxL = Math.min(aN.length, bN.length, 240);
          var best = 0;
          for (var L = maxL; L >= 10; L--) {
            if (aN.slice(aN.length - L) === bN.slice(0, L)) { best = L; break; }
          }
          if (best) {
            // 找到跨界所在行：前面整行删掉，边界行截去已匹配的前缀
            for (var m = 0; m < lines.length; m++) {
              if (bCum[m + 1] >= best) {
                var cutLine = cutLinePrefix(lines[m], best - bCum[m]);
                lines = lines.slice(m + 1);
                if (cutLine.trim()) lines.unshift(cutLine);
                k = -1;
                break;
              }
            }
          }
        }
        if (k > 0) lines = lines.slice(k);
      }
      all = (all || []).concat(lines);
    });
    return (all || []).join('\n');
  }

  // 从行首截去已在前一条中出现的前缀（cnt 为去空白后的字符数），返回剩余部分
  function cutLinePrefix(line, cnt) {
    var out = '', seen = 0, started = false;
    var s = String(line || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var isWs = /[\s\u3000]/.test(ch);
      if (!started) {
        if (isWs) continue; // 跳过行首缩进
        started = true;
      }
      if (seen < cnt) {
        if (!isWs) seen++;
        continue;
      }
      out += ch;
    }
    return out;
  }

  /* ---------- 本地 tesseract 通道（worker 复用 + 增强预处理） ---------- */
  function getTessWorker(report) {
    if (tessWorkerPromise) return tessWorkerPromise;
    var lastBeat = Date.now();
    var createPromise = loadScript(LIBS.tesseract, 'Tesseract').then(function () {
      report({ status: '正在检测最快的识别模型下载线路…', ratio: 0.03 });
      return Promise.all([
        pickFastest(TESS_WORKERS, ''),
        pickFastest(TESS_CORES, 'tesseract-core-simd.wasm.js'),
        pickFastest(TESS_LANGS, 'chi_sim.traineddata.gz')
      ]);
    }).then(function (picked) {
      var workerPath = picked[0], corePath = picked[1], langPath = picked[2];
      if (!workerPath || !corePath || !langPath) {
        throw new Error('所有识别模型下载线路都无法连通。请切换网络（WiFi 与 4G 互换）后重试；或改用 Word/PDF 文件、直接粘贴文字。');
      }
      var isLite = /best_int|gh-pages/.test(langPath);
      report({
        status: '正在下载中文识别模型（' + (isLite ? '约 1.7MB 轻量版' : '约 20MB 标准版') + '，仅首次，之后自动缓存）',
        ratio: 0.05
      });
      return window.Tesseract.createWorker('chi_sim', 1, {
        workerPath: workerPath,
        corePath: corePath,
        langPath: langPath,
        gzip: true,
        logger: function (m) { lastBeat = Date.now(); ocrProgress(m, report); }
      });
    }).then(function (worker) {
      return worker.setParameters({
        tessedit_pageseg_mode: '6',   // 单块均匀文本，适合作文整页照片
        preserve_interword_spaces: '1'
      }).then(function () {
        tessWorker = worker;
        activeWorker = worker;
        return worker;
      });
    });

    // 看门狗：90 秒没有任何阶段进展即判定网络卡死
    var guard = new Promise(function (_, reject) {
      var watchTimer = setInterval(function () {
        if (Date.now() - lastBeat > 90000) {
          clearInterval(watchTimer);
          reject(new Error('识别模型下载长时间没有进展（当前网络过慢或受限）。建议：① 切换 WiFi/4G 后点重试；② 轻量模型仍失败时改用 Word/PDF 或直接粘贴文字。'));
        }
      }, 5000);
      createPromise.then(function () { clearInterval(watchTimer); }, function () { clearInterval(watchTimer); });
    });

    tessWorkerPromise = Promise.race([createPromise, guard]);
    tessWorkerPromise.catch(function () { tessWorkerPromise = null; });
    return tessWorkerPromise;
  }

  // 本地通道：灰度对比度增强 + PSM 6 整页识别
  function tessParseImage(file, report) {
    var prep = null;
    return preprocessImage(file, { longEdge: 2400, enhance: true }).then(function (p) {
      prep = p;
      return getTessWorker(report);
    }).then(function (worker) {
      return worker.recognize(prep.blob);
    }).then(function (ret) {
      var text = ocrPostProcess(ret.data && ret.data.text ? ret.data.text : '');
      if (!text) throw new Error('图片中未识别到文字，请换更清晰的图片（光线充足、纸面平整、文字占画面大一些）。');
      report({ status: '识别完成，请在正文框中核对错别字', ratio: 1 });
      return { text: text, kind: 'image', titleGuess: guessTitle(text), ocr: true };
    });
  }

  /* ---------- 图片识别主流程 ----------
   * 服务端视觉模型优先（切条并行，准确率高）；仅当服务端未配置识别
   * 功能时才回退浏览器本地识别。服务端已配置但识别失败时给出明确
   * 提示并终止——绝不静默回退到本地识别输出大片乱码误导用户。 */
  function parseImage(file, report) {
    return getServerCfg().then(function (cfg) {
      if (!cfg || !cfg.ocr || !cfg.ocr.enabled) return null; // 未配置 → 本地兜底
      report({ status: '正在压缩照片…', ratio: 0.08 });
      return preprocessImage(file, { longEdge: 2600 }).then(function (prep) {
        var n = stripCountFor(prep.width, prep.height);
        report({ status: '正在识别手写文字…', ratio: 0.25 });
        return splitStrips(prep.dataUrl, n).then(function (strips) {
          var done = 0;
          function mark() {
            done++;
            report({
              status: '正在识别手写文字（' + done + ' / ' + strips.length + ' 段）…',
              ratio: 0.25 + 0.6 * done / strips.length
            });
          }
          // 350ms 间隔错峰启动，避免瞬时并发触发限流
          var jobs = strips.map(function (s, i) {
            return new Promise(function (resolve) {
              setTimeout(function () {
                serverOcr(s, report).then(function (t) { mark(); resolve(t); },
                                         function (e) { mark(); resolve({ __err: e }); });
              }, i * 350);
            });
          });
          return Promise.all(jobs).then(function (outs) {
            var firstErr = null;
            var parts = outs.map(function (o) {
              if (o && o.__err) { if (!firstErr) firstErr = o.__err; return ''; }
              return o;
            });
            if (firstErr) throw firstErr;
            var merged = normalizeText(joinStripTexts(parts));
            if (!merged) {
              var e2 = new Error('未从照片中识别到文字：请确认照片清晰、光线充足、文字占画面足够大后重试。');
              e2.handled = true;
              throw e2;
            }
            return merged;
          });
        });
      }).then(function (text) {
        report({ status: '识别完成，请在正文框中核对', ratio: 1 });
        return { text: text, kind: 'image', titleGuess: guessTitle(text), ocr: true, engine: 'vision' };
      }, function (e) {
        if (e && (e.code === 'login_required' || e.status === 401)) {
          throw new Error('拍照识别需要先登录：请点右上角「登录」后再上传照片。');
        }
        if (e && (e.code === 'quota_exceeded' || e.code === 'ocr_disabled' || e.handled)) throw e;
        throw new Error((e && e.message ? e.message : '照片识别失败') +
          '。可重试一次；也可直接把文字粘贴到正文框。');
      });
    }).then(function (visionRes) {
      if (visionRes) return visionRes;
      return tessParseImage(file, report);
    });
  }

  // OCR 结果后处理：合并被硬换行拆开的同一段，空行分段
  function ocrPostProcess(raw) {
    var lines = String(raw).replace(/\r/g, '').split('\n');
    var paras = [], buf = '';
    lines.forEach(function (ln) {
      var t = ln.replace(/[ \t]+$/g, '').replace(/^[ \t]+/, '');
      if (!t) {
        if (buf) { paras.push(buf); buf = ''; }
        return;
      }
      if (/^[ \u3000]{2,}/.test(ln)) {
        if (buf) paras.push(buf);
        buf = t.replace(/^[ \u3000]+/, '');
      } else if (!buf) {
        buf = t;
      } else {
        var end = buf.slice(-1);
        if (/[。！？…：；]/.test(end)) { paras.push(buf); buf = t; }
        else if (/[，、（“《—]/.test(end) || isCJK(t.charAt(0))) { buf += t; }
        else { paras.push(buf); buf = t; }
      }
    });
    if (buf) paras.push(buf);
    return normalizeText(paras.join('\n\n'));
  }

  /* ---------- 标题猜测：首行短且无句末标点 ---------- */
  function guessTitle(text) {
    var firstLine = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)[0] || '';
    var cjk = (firstLine.match(/[一-鿿]/g) || []).length;
    if (firstLine && cjk >= 2 && firstLine.length <= 30 &&
      !/[。！？，；：、]/.test(firstLine) && text.split('\n').length > 1) {
      return firstLine;
    }
    return '';
  }

  /* ---------- 自动拆分「作文题目」与「作文（标题+正文）」 ----------
   * 依据真实试卷/范文文件的结构特征做评分制切分：
   *   [题目材料若干段] → [作文标题（独立短行）/ 范文标记] → [作者行(可删)] → [正文长段…]
   * 标题不单独拆出，清理后保留在正文首行；"XX中学高三X班 姓名（63分）"等
   * 教师文件里的作者信息行从正文中剔除。
   * 返回 { detected, prompt, essay, by }
   */

  // —— 题目侧特征 ——
  // 题目标记：括号内含"作文题/作文材料/写作题"等（兼容【奉贤一模作文题】【2025虹口一模】等）
  var RE_PROMPT_TAG_BRACKET = /[【\[][^】\]]*(?:作文题目|作文题|作文材料|材料作文|写作题目|写作题|语文试题|考试作文)[^】\]]*[】\]]/;
  var RE_PROMPT_TAG_BRACKET_EXAM = /[【\[][^】\]]*(?:一模|二模|三模|模考|高考|期末|联考|月考)[^】\]]*[】\]]/;
  var RE_PROMPT_TAG_ANY = /(?:一模|二模|三模|模考|高考|期末|联考|月考|质量抽测|调研).{0,10}(?:作文题|作文材料|写作题|作文)/;
  var RE_PROMPT_LABEL_INLINE = /^[【\[]?\s*(?:作文题目|作文材料|写作题目|写作题|作文题|材料|题目)\s*[】\]]?\s*[:：、.．]/;
  // 高考写作任务句（上海卷典型问法）
  var RE_TASK = /请?写(?:一篇|作).{0,30}文章|写一篇不少于|谈谈你?的?(?:认识|思考|看法|感悟|理解|体验|见解)|你(?:有)?(?:怎样|怎样的|怎样的一种)?(?:思考|认识|看法)|对此.*(?:思考|看法|认识)/;
  var RE_REQ_STRONG = /不少?于\s*\d{3,4}\s*字|\d{3,4}\s*字(?:以上|左右)|题目自拟|自拟(?:题目|标题)|明确文体|不要套作|不得抄袭|不要脱离材料内容|选(?:准|好|取|一个)?角度/;
  var RE_REQ_LINE = /^\s*[（(]?\s*\d?\s*[）)]?\s*要求\s*[:：]/;
  // 双观点/现象类材料的典型句式
  var RE_DUAL_VIEW = /有人(?:认为|说|觉得)[\s\S]{0,120}(?:也有人|而有人|另一些人)|不少人[\s\S]{0,60}(?:却|但).{0,20}(?:很多人|许多人)|有的人[\s\S]{0,80}有的人/;
  // 材料引导语（段首）
  var RE_LEAD = /^(?:阅读下面(?:的)?(?:材料|文字)|根据(?:以下|下面|上述|所给)?(?:材料|要求)|阅读下列材料|生活中[，,]|社会上[，,]|在日常生活中|当下[，,]|如今[，,]|现代社会|人们常说|有人说|我们常说)/;

  // —— 作文侧特征 ——
  var RE_ESSAY_TAG = /^[【\[]?\s*(?:参考(?:例文|作文|范文)|优秀(?:作文|范文)|考场作文|学生(?:作文|习作|范文)|满分作文|范文示例|作文示例|范文|例文|学生作文|优秀作文|习作)\s*[】\]]?\s*[:：、.．]?\s*$/;
  var RE_AUTHOR = /(?:中学|高中|附中|学校|高三|高二|高复|[一二三四五六]?\d\s*班|（\s*\d{2}\s*分\s*）|\(\s*\d{2}\s*分\s*\))/;
  var RE_SCORE_TAIL = /[（(]\s*(?:[一二三四五]类(?:卷)?(?:上|中|下)?|\d{2}\s*分(?:卷)?(?:[，,][^）)]*)?)\s*[）)]\s*$/;
  var RE_BAND_TAIL = /[（(]\s*(?:一类|二类|三类|四类|五类)[^）)]*[）)]\s*$/;
  var RE_ARG_MARK = /诚然|固然|然而|但是|但|因此|所以|首先|其次|再者|再次|最后|反观当下|在当下|当下|依我之见|在我看来|笔者认为|本质上|进一步(?:分析|说|看)|究其根本|由此可见|换言之|不仅|更|而非/;

  function hasEndPunct(s) {
    return /[。！？…!?]/.test(s);
  }

  // 教师分析文件里的栏目短行，不是作文标题
  var RE_META_TITLE = /^(?:【?\s*(?:文题解析|题目解析|试题分析|作文解析|审题篇?|审题指导|审题立意|立意篇?|立意指导|写作指导|写作反馈|写作思路|提纲|前言|导语|原题(?:呈现|回顾)?|题目分析|题意分析|关键概念|深度解析|构思详解|评分(?:说明|标准|细则)?|阅卷(?:反馈|情况|总结|分析)?|参考答案?|典型(?:问题|错误|卷例)|考点分析|优秀例文|参考例文|范文赏析|例文赏析)\s*】?)|(?:第\s*\d+\s*题)/;

  // 独立短行、无句末标点、不含指令性词语 → 像作文标题
  // 标题允许含逗号（如"曲水流觞，以行塑形"），但不含句号/问号/感叹号/分号/顿号
  function looksLikeTitleLine(p) {
    var t = String(p || '').trim();
    if (!t || t.length < 2 || t.length > 20) return false;
    if (/^[【〔\[]/.test(t)) return false; // 【范文】〔论据材料〕类栏目标记
    if (/^[—–\-－]{1,2}/.test(t)) return false; // ——伍尔夫 类名言署名行
    if (/[。！？；：、…!?]/.test(t)) return false;
    if (/要求|请写一篇|自拟|不少于|\d{3,4}\s*字|阅读下面|根据.*材料|作文题|作文材料|写作题|参考例文|^\d+[.、]/.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    if (RE_META_TITLE.test(t)) return false;
    // 标题除（60分）/（一类卷）这类教师评分尾巴外，不含其他括号说明
    if (/[（(]/.test(t) && !(RE_SCORE_TAIL.test(t) || RE_BAND_TAIL.test(t))) return false;
    // 汉字占比要够（排除英文/网址行）
    var cjk = (t.match(/[一-鿿]/g) || []).length;
    return cjk >= 2 && cjk / t.replace(/\s/g, '').length >= 0.6;
  }

  // 事例卡条目：《玩偶之家》：娜拉……（论据目录，不是作文正文）
  var RE_EXAMPLE_CARD = /^《[^》]{2,12}》\s*[：:]|^[①②③④⑤⑥⑦⑧⑨⑩]/;

  // 短行、像"XX中学高三（3）班  姓名（63分）"的作者/署名信息
  function looksLikeAuthorLine(p) {
    var t = String(p || '').trim();
    if (!t || t.length > 42 || hasEndPunct(t)) return false;
    if (RE_AUTHOR.test(t)) {
      // 必须是典型署名结构：学校/年级/班级/分数 至少命中两个信号更稳
      var n = 0;
      if (/中学|高中|附中|学校/.test(t)) n++;
      if (/高三|高二|高复|高[一二三]/.test(t)) n++;
      if (/\d\s*班|[一二三四五六]班/.test(t)) n++;
      if (/\d{2}\s*分/.test(t)) n++;
      return n >= 2 || /\d{2}\s*分/.test(t);
    }
    return false;
  }

  // 题目侧评分：合并文本越像"材料+写作任务"，分越高
  function scorePrompt(text, firstPara, hasTag) {
    var s = 0;
    if (hasTag) s += 4;
    if (RE_TASK.test(text)) s += 4;
    if (RE_REQ_STRONG.test(text)) s += 3;
    if (RE_DUAL_VIEW.test(text)) s += 3;
    if (RE_LEAD.test(firstPara)) s += 2;
    if (RE_REQ_LINE.test(text)) s += 1;
    // 材料中出现引号核心概念（如"断舍离"）是材料题强信号
    var q = text.match(/[“"「『]([^”"」』]{2,8})[”"」』]/g);
    if (q && RE_TASK.test(text)) s += 1;
    return s;
  }

  // 作文侧评分：标题行 + 作者行 + 议论性长段
  function scoreEssay(parasFrom) {
    var rest = parasFrom;
    var s = 0, idx = 0, head = rest[0] || '';
    var byTag = false, byTitle = false;

    if (RE_ESSAY_TAG.test(head)) {
      byTag = true; s += 4; idx = 1;
      // 标记之后一段若为标题行
      if (rest[idx] && looksLikeTitleLine(rest[idx])) { s += 2; idx++; }
    } else if (looksLikeTitleLine(head)) {
      byTitle = true; s += 3; idx = 1;
    } else {
      return { score: 0 };
    }

    // 标题/标记后 1-2 行内的作者署名行
    var authorRemoved = 0;
    for (var k = idx; k < Math.min(idx + 2, rest.length); k++) {
      if (looksLikeAuthorLine(rest[k])) { s += 3; authorRemoved++; }
    }

    // 正文段统计（跳过作者行）
    var body = rest.slice(idx).filter(function (p) { return !looksLikeAuthorLine(p); });
    var bodyText = body.join('');
    var longParas = body.filter(function (p) { return cjkCount(p) >= 80; }).length;
    var argParas = body.filter(function (p) { return RE_ARG_MARK.test(p); }).length;
    if (longParas >= 2) s += 2; else if (longParas >= 1) s += 1;
    if (argParas >= 2) s += 3; else if (argParas >= 1) s += 1;
    if (body.length >= 3) s += 1;
    if (cjkCount(bodyText) >= 200) s += 1;

    return {
      score: s,
      byTag: byTag,
      byTitle: byTitle,
      essayStart: 0,
      tagConsumed: byTag ? 1 : 0,
      titleIdx: byTag ? (looksLikeTitleLine(rest[1]) ? 1 : -1) : 0,
      authorRemoved: authorRemoved,
      bodyParas: body
    };
  }

  // 清理作文标题行上的分数/档位尾巴：常识不应成为常态（60分） → 常识不应成为常态
  function cleanTitleLine(t) {
    return String(t || '').replace(RE_SCORE_TAIL, '').replace(RE_BAND_TAIL, '').trim();
  }

  function stripPromptTag(line) {
    var t = String(line || '').trim();
    var stripped = t.replace(RE_PROMPT_TAG_BRACKET, '').replace(RE_PROMPT_TAG_BRACKET_EXAM, '').trim();
    if (stripped.length < 4) return '';
    t = stripped;
    t = t.replace(RE_PROMPT_LABEL_INLINE, '').trim();
    return t;
  }

  function splitDocument(raw) {
    var full = normalizeText(raw);
    var paras = full.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var none = { detected: false, prompt: '', essay: full, by: '' };
    if (paras.length < 3) return none;

    // 标记可能在的题目标记位置（前 10 段），用于题目侧加分
    var tagIdx = -1;
    for (var t = 0; t < Math.min(paras.length, 10); t++) {
      if (RE_PROMPT_TAG_BRACKET.test(paras[t]) || RE_PROMPT_TAG_BRACKET_EXAM.test(paras[t]) ||
          RE_PROMPT_TAG_ANY.test(paras[t]) || RE_PROMPT_LABEL_INLINE.test(paras[t])) { tagIdx = t; break; }
    }

  // 审题分析提纲的痕迹（作文开头几段不应出现）
  var RE_OUTLINE_MARK = /^\s*[①②③④⑤⑥⑦⑧⑨⑩]|[【\[](?:原因剖析|结果剖析|写作思路|审题|立意|提纲)/;
  // 题干强污染：教师分析文档的元话语，任何情况下都不该出现在题干里
  var RE_PROMPT_POLLUTION_STRONG =
    /文题解析|审题指导|审题立意|写作反馈|阅卷(?:反馈|情况|总结|分析|组)?|评分(?:说明|标准|细则)?|参考答案?|题意分析|立意分析|典型(?:问题|错误|卷例)|考点分析|关键概念|构思详解|试题分析|深度解析|【=|批注|旁批/;
  // 题干弱污染：论证连接词。材料本身的叙述完全可能包含（如"有人因此怀疑……"
  // "但也有人认为……"），只有大量出现（≥3 类）才说明切点落进了作文正文
  var RE_PROMPT_POLLUTION_MILD =
    /诚然|固然|然而|但是|因此|所以说|首先|其次|再者|反观当下|依我之见|在我看来|笔者认为|本质上|进一步分析|究其根本|由此可见|毋庸讳言|究其原因|换言之/g;
  // 材料正文的强信号（用于定位材料起始、剥离试卷抬头）
  function looksLikeMaterialLine(p) {
    return RE_TASK.test(p) || RE_REQ_STRONG.test(p) || RE_LEAD.test(p) || RE_DUAL_VIEW.test(p);
  }

  // 枚举作文起点 i：题目 = [tag起点 .. i)，作文 = [i ..]
  var tagStart = tagIdx >= 0 ? tagIdx : 0;
    var best = null;
    var maxI = Math.min(paras.length - 1, Math.max(3, Math.floor(paras.length * 0.8)));
    for (var i = Math.max(1, tagStart); i <= maxI && !best; i++) {
      // 作文起点必须是"标题行"或"范文/例文标记"
      if (!looksLikeTitleLine(paras[i]) && !RE_ESSAY_TAG.test(paras[i])) continue;

      var promptParas = paras.slice(tagStart, i);
      var hasTag = tagIdx >= 0 && tagIdx < i;
      // 题目标记单独成行时不计入正文内容
      var cleanPromptParas = promptParas.map(function (p, pi) {
        if (hasTag && pi === (tagIdx - tagStart)) return stripPromptTag(p);
        return p;
      }).filter(Boolean);
      // 夹着长篇审题分析时只留到最后的写作要求段
      if (cjkCount(cleanPromptParas.join('')) > 1200) {
        var ct2 = -1;
        for (var pi3 = 0; pi3 < Math.min(cleanPromptParas.length, 16); pi3++) {
          if (RE_REQ_STRONG.test(cleanPromptParas[pi3]) || (RE_TASK.test(cleanPromptParas[pi3]) && pi3 >= 1)) ct2 = pi3;
        }
        if (ct2 >= 1 && ct2 < cleanPromptParas.length - 1) cleanPromptParas = cleanPromptParas.slice(0, ct2 + 1);
      }
      // 无标记时剥离"2025届XX区高三语文一模"之类的试卷抬头行
      if (!hasTag && cleanPromptParas.length > 1) {
        for (var hp = 0; hp < Math.min(4, cleanPromptParas.length - 1); hp++) {
          if (looksLikeMaterialLine(cleanPromptParas[hp])) break;
        }
        if (hp > 0) cleanPromptParas = cleanPromptParas.slice(hp);
      }
      var promptText = cleanPromptParas.join('');
      var promptFirst = cleanPromptParas[0] || '';
      var pScore = scorePrompt(promptText, promptFirst, hasTag);
      if (pScore < 4) continue;
      // 题干纯度：教师元话语（强污染）一票否决；论证连接词（弱污染）按密度判断——
      // 材料叙述天然可能含少量连接词，≥3 类才说明切点落进了作文正文
      if (RE_PROMPT_POLLUTION_STRONG.test(promptText)) continue;
      var mildArr = promptText.match(RE_PROMPT_POLLUTION_MILD) || [];
      var mildSet = {};
      mildArr.forEach(function (w) { mildSet[w] = 1; });
      if (Object.keys(mildSet).length >= 3) continue;

      var info = scoreEssay(paras.slice(i));
      if (info.score < 6) continue;

      var essayBodyText = info.bodyParas.join('');
      // 合理性：正文必须比题目长且达到基本篇幅
      if (cjkCount(essayBodyText) < 120) continue;
      if (cjkCount(essayBodyText) <= cjkCount(promptText)) continue;

      // 防误切 a：作文前 5 段出现"①②/【原因剖析】/《玩偶之家》：事例卡"等提纲痕迹 → 这还是分析区
      var headWindow = paras.slice(i, i + 6);
      if (headWindow.some(function (p) { return RE_OUTLINE_MARK.test(p) || RE_EXAMPLE_CARD.test(p); })) continue;
      // 防误切 b：作文区后面（第 4 段起）还存在"参考例文/范文"标记 → 真正的作文在更后面
      var laterTag = paras.slice(i + 3, i + 60).some(function (p) { return RE_ESSAY_TAG.test(p); });
      if (laterTag) continue;

      // 取最早达标的切点（首个作文标题/标记优先，避免多范文时偏向最末一篇）
      best = { cut: i, total: pScore + info.score, pScore: pScore, info: info, promptParasClean: cleanPromptParas };
    }

    if (!best) return none;

    // —— 组装题目（已在评分时完成标记剥离与分析裁剪） ——
    var prompt = normalizeText(best.promptParasClean.join('\n\n'));

    // —— 组装作文：标题（清理分数尾巴）+ 正文，剔除作者信息行 ——
    var ep = paras.slice(best.cut);
    var out = [];
    var headConsumed = best.info.tagConsumed; // 跳过"参考例文"标记行
    for (var j2 = headConsumed; j2 < ep.length; j2++) {
      var isTitle = j2 === best.info.titleIdx || (headConsumed === 0 && j2 === 0);
      if (isTitle) {
        var ct = cleanTitleLine(ep[j2]);
        if (ct) out.push(ct);
      } else if (looksLikeAuthorLine(ep[j2]) && j2 <= 2) {
        // 仅剔除标题后紧跟的前两条作者行，正文深处不动
        continue;
      } else {
        out.push(ep[j2]);
      }
    }
    var essay = normalizeText(out.join('\n\n'));

    var pLen = cjkCount(prompt), eLen = cjkCount(essay);
    if (pLen < 12 || pLen > 1500 || eLen < 100) return none;
    if (/选准角度[\s\S]{0,40}不要脱离材料内容/.test(essay)) return none;

    return {
      detected: true,
      prompt: prompt,
      essay: essay,
      by: best.info.byTag ? 'title-tag' : 'title-line'
    };
  }

  function cjkCount(s) {
    return (String(s || '').match(/[一-鿿]/g) || []).length;
  }

  /* ---------- 主入口 ----------
   * extract(file, onProgress) -> Promise<{text, kind, titleGuess, ocr?}>
   * onProgress({status, ratio})
   */
  function extract(file, onProgress) {
    var report = onProgress || function () {};
    var ext = getExt(file.name);
    var isImg = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].indexOf(ext) >= 0;
    var limit = isImg ? MAX_IMG_MB : MAX_DOC_MB;

    if (file.size > limit * 1024 * 1024) {
      return Promise.reject(new Error('文件过大（' + (file.size / 1024 / 1024).toFixed(1) +
        'MB），' + (isImg ? '图片' : '文档') + '请控制在 ' + limit + 'MB 以内。'));
    }

    if (ext === 'txt' || ext === 'md') {
      report({ status: '正在读取文本文件', ratio: 0.3 });
      return file.arrayBuffer().then(function (buf) {
        var text = readTextFile(buf);
        if (!text) throw new Error('文本文件内容为空。');
        return { text: text, kind: 'txt', titleGuess: guessTitle(text) };
      });
    }
    if (ext === 'docx') return parseDocx(file, report);
    if (ext === 'pdf') return parsePdf(file, report);
    if (isImg) return parseImage(file, report);
    if (ext === 'doc') {
      return Promise.reject(new Error('暂不支持旧版 .doc 格式：请用 Word 打开后“另存为 .docx”，或直接复制正文粘贴。'));
    }
    return Promise.reject(new Error('暂不支持 .' + ext + ' 格式。支持：Word(.docx)、PDF、TXT、图片（自动 OCR）。'));
  }

  /* ---------- 多图入口：作文多页照片按顺序识别并拼接 ----------
   * extractMany(FileList|File[], onProgress) -> Promise<{text, kind, titleGuess, ocr}>
   * 仅接受全部为图片；单文件请直接用 extract。逐张识别（本地通道共享同一 worker）。
   */
  function extractMany(files, onProgress) {
    var report = onProgress || function () {};
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.reject(new Error('未选择文件。'));
    if (list.length === 1) return extract(list[0], report);
    var allImg = list.every(function (f) {
      return ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].indexOf(getExt(f.name)) >= 0;
    });
    if (!allImg) {
      return Promise.reject(new Error('一次选择多个文件时仅支持图片（作文多页照片）；Word/PDF/TXT 请单独上传。'));
    }
    if (list.length > 6) return Promise.reject(new Error('一次最多上传 6 张照片。'));

    var texts = [];
    var idx = 0;
    function step() {
      if (idx >= list.length) {
        var text = normalizeText(texts.join('\n\n'));
        return { text: text, kind: 'image', titleGuess: guessTitle(text), ocr: true };
      }
      var cur = idx;
      var sub = function (p) {
        report({
          status: '第 ' + (cur + 1) + ' / ' + list.length + ' 张：' + (p.status || ''),
          ratio: (cur + (p.ratio || 0)) / list.length
        });
      };
      return parseImage(list[idx], sub).then(function (res) {
        texts.push(res.text);
        idx++;
        return step();
      });
    }
    return step();
  }

  window.EssayFile = {
    extract: extract,
    extractMany: extractMany,
    splitDocument: splitDocument,
    cancelOcr: cancelOcr,
    supported: '.txt,.md,.docx,.pdf,.png,.jpg,.jpeg,.webp,.bmp',
    guessTitle: guessTitle
  };
})();
