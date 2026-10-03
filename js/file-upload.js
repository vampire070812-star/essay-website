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

  // 各库提供多个 CDN 源，前一个失败自动尝试下一个（兼顾国内网络）
  var LIBS = {
    mammoth: [
      'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
      'https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js'
    ],
    pdfjs: [
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      'https://unpkg.com/pdfjs-dist@3.11.174/legacy/build/pdf.min.js'
    ],
    tesseract: [
      'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js',
      'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
    ]
  };

  // 解析库需要的配套资源（worker / 核心 / 语言包）
  var PDF_WORKERS = [
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  ];
  var TESS_WORKER = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js';
  var TESS_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1';
  var TESS_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0';

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
    return loadScript(LIBS.pdfjs, 'pdfjsLib').then(function () {
      var pdfjs = window.pdfjsLib;
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKERS[0];
      }
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

  /* ---------- 图片 OCR：tesseract.js（中文简体） ---------- */
  function parseImage(file, report) {
    return loadScript(LIBS.tesseract, 'Tesseract').then(function () {
      report({ status: '正在加载中文识别模型（首次约数 MB，请稍候）', ratio: 0.02 });
      return window.Tesseract.createWorker('chi_sim', 1, {
        workerPath: TESS_WORKER,
        corePath: TESS_CORE,
        langPath: TESS_LANG,
        logger: function (m) {
          if (m.status === 'recognizing text') {
            report({ status: '正在逐行识别图片文字', ratio: Math.max(0.05, m.progress || 0) });
          }
        }
      });
    }).then(function (worker) {
      return worker.recognize(file).then(function (ret) {
        return worker.terminate().then(function () { return ret; });
      }, function (err) {
        return worker.terminate().then(function () { throw err; });
      });
    }).then(function (ret) {
      var text = ocrPostProcess(ret.data && ret.data.text ? ret.data.text : '');
      if (!text) throw new Error('图片中未识别到文字，请换更清晰的图片（光线充足、纸面平整、文字占画面大一些）。');
      report({ status: '识别完成，请在正文框中核对错别字', ratio: 1 });
      return { text: text, kind: 'image', titleGuess: guessTitle(text), ocr: true };
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

  window.EssayFile = {
    extract: extract,
    supported: '.txt,.md,.docx,.pdf,.png,.jpg,.jpeg,.webp,.bmp',
    guessTitle: guessTitle
  };
})();
