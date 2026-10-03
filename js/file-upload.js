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

  // OCR 任务句柄（供取消时 terminate）
  var activeWorker = null;
  function cancelOcr() {
    if (activeWorker) {
      try { activeWorker.terminate(); } catch (e) {}
      activeWorker = null;
    }
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

  /* ---------- 图片 OCR：tesseract.js（中文简体，多源 + 看门狗） ---------- */
  function parseImage(file, report) {
    var lastBeat = Date.now();
    var watchTimer = null;

    return loadScript(LIBS.tesseract, 'Tesseract').then(function () {
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

      var createPromise = window.Tesseract.createWorker('chi_sim', 1, {
        workerPath: workerPath,
        corePath: corePath,
        langPath: langPath,
        gzip: true,
        logger: function (m) { lastBeat = Date.now(); ocrProgress(m, report); }
      }).then(function (worker) { activeWorker = worker; return worker; });

      // 看门狗：90 秒没有任何阶段进展即判定网络卡死
      var guard = new Promise(function (_, reject) {
        watchTimer = setInterval(function () {
          if (Date.now() - lastBeat > 90000) {
            clearInterval(watchTimer);
            reject(new Error('识别模型下载长时间没有进展（当前网络过慢或受限）。建议：① 切换 WiFi/4G 后点重试；② 轻量模型仍失败时改用 Word/PDF 或直接粘贴文字。'));
          }
        }, 5000);
        createPromise.then(function () { clearInterval(watchTimer); }, function () { clearInterval(watchTimer); });
      });

      return Promise.race([createPromise, guard]);
    }).then(function (worker) {
      return worker.recognize(file).then(function (ret) {
        return worker.terminate().then(function () { activeWorker = null; return ret; });
      }, function (err) {
        return worker.terminate().then(function () { activeWorker = null; throw err; });
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

  /* ---------- 自动拆分「作文题目」与「作文正文（含标题）」 ----------
   * 只负责把题目材料分出来；标题不拆分，保留在正文首行。
   * 返回 { detected, prompt, essay, by }
   * by: 'label'（有明确栏目标记）/ 'rule'（靠写作要求句式推断）
   */
  // 强题目标记：作文题目 / 作文材料 / 写作题 / 题目： 等（行首，后接括号/冒号/空格）
  var PROMPT_LABEL = /^[【\[]?\s*(?:作文题目|作文材料|写作题目|写作题|作文题|材料作文|题目|材料)\s*(?:[】\]]|[:：、.．]|\s)\s*/;
  var PROMPT_LABEL_ALONE = /^[【\[]?\s*(?:作文题目|作文材料|写作题目|写作题|作文题|材料作文|题目|材料)\s*[】\]]?\s*[:：、.．]?\s*$/;
  // 正文/作文开始标记
  var ESSAY_LABEL = /^[【\[]?\s*(?:学生作文|考场作文|优秀作文|满分作文|范文|例文|作文示例|学生习作|作文|正文|文章)\s*(?:[】\]]|[:：、.．]|\s)\s*/;
  var ESSAY_LABEL_ALONE = /^[【\[]?\s*(?:学生作文|考场作文|优秀作文|满分作文|范文|例文|作文示例|学生习作|作文|正文|文章)\s*[】\]]?\s*[:：、.．]?\s*$/;
  // 题目开头用语
  var PROMPT_START = /^(?:阅读下面(?:的)?(?:材料|文字)|根据(?:以下|下面|上述|所给)?(?:材料|要求)|阅读下列材料|阅读材料)/;
  // 写作要求（题目结尾的典型句式）
  var REQ_TAIL = /写(?:一篇|作)|不少?于\s*\d{3,4}\s*字|\d{3,4}\s*字(?:左右|以上)|题目自拟|自拟(?:题目|标题)|选(?:准|好|取|一个)?角度|明确文体|不要脱离材料|综合材料内容及含意|结合材料/;
  var REQ_LINE = /^\s*要求\s*[:：]/;
  // 强写作指令（作文正文里几乎不可能出现）：800字/自拟标题/明确文体/不要套作 等
  var REQ_STRONG =
    /不少?于\s*\d{3,4}\s*字|\d{3,4}\s*字(?:以上|左右)|题目自拟|自拟(?:题目|标题)|明确文体|不要套作|不得抄袭|不要脱离材料内容/;

  function stripLabel(s, re, aloneRe) {
    var t = String(s || '').trim();
    if (aloneRe.test(t)) return '';
    return t.replace(re, '').trim();
  }

  function splitDocument(raw) {
    var full = normalizeText(raw);
    var paras = full.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var none = { detected: false, prompt: '', essay: full, by: '' };
    if (paras.length < 3) return none;

    var promptIdx = -1, essayIdx = -1, i, j;

    // 1) 找题目标记（前 12 段内）；单独成行的标记、或行首"题目：……"均可
    for (i = 0; i < Math.min(paras.length, 12); i++) {
      if (PROMPT_LABEL_ALONE.test(paras[i]) || (i <= 6 && PROMPT_LABEL.test(paras[i]))) {
        promptIdx = i; break;
      }
    }
    // 2) 找正文标记（必须在题目标记之后，或文件前半部分）
    var searchFrom = promptIdx >= 0 ? promptIdx + 1 : 0;
    for (j = searchFrom; j < paras.length - 1; j++) {
      if (ESSAY_LABEL_ALONE.test(paras[j]) || ESSAY_LABEL.test(paras[j])) { essayIdx = j; break; }
    }

    var promptParts = [], essayParts = [], by = '';

    if (promptIdx >= 0 && essayIdx > promptIdx) {
      // 两个标记都在
      promptParts = paras.slice(promptIdx, essayIdx);
      promptParts[0] = stripLabel(promptParts[0], PROMPT_LABEL, PROMPT_LABEL_ALONE);
      essayParts = paras.slice(essayIdx + 1);
      var headInline = stripLabel(paras[essayIdx], ESSAY_LABEL, ESSAY_LABEL_ALONE);
      if (headInline) essayParts.unshift(headInline);
      by = 'label';
    } else if (essayIdx >= 0 && promptIdx < 0) {
      // 只有正文标记：前面整体当作题目——但前文必须有题目特征（引导语/写作要求），
      // 否则可能是正文中偶然出现的"作文/正文"字样，交给规则分支再判
      var beforeText = paras.slice(0, essayIdx).join('');
      if (REQ_TAIL.test(beforeText) || PROMPT_START.test(paras[0])) {
        promptParts = paras.slice(0, essayIdx);
        essayParts = paras.slice(essayIdx + 1);
        var headInline2 = stripLabel(paras[essayIdx], ESSAY_LABEL, ESSAY_LABEL_ALONE);
        if (headInline2) essayParts.unshift(headInline2);
        by = 'label';
      } else {
        essayIdx = -1; // 该标记不可信，回落规则推断
      }
    }
    if (!by) {
      // 3) 无明确标记：靠"写作要求"句式找题目结尾
      var startIdx = 0;
      if (promptIdx >= 0) {
        startIdx = promptIdx;
        paras[promptIdx] = stripLabel(paras[promptIdx], PROMPT_LABEL, PROMPT_LABEL_ALONE);
      }
      var headLikePrompt = PROMPT_START.test(paras[0]) || promptIdx === 0;
      var limit = Math.max(2, Math.floor(paras.length * 0.45));
      var tailIdx = -1;
      for (i = Math.max(1, startIdx); i <= Math.min(limit, paras.length - 2); i++) {
        var p = paras[i];
        // 必须含"不少于800字/自拟标题/明确文体"等强指令，普通作文正文不会出现这些词
        if (REQ_STRONG.test(p) && (headLikePrompt || promptIdx === 0 || REQ_LINE.test(p) || i <= 4)) {
          tailIdx = i; // 取最后一个匹配段（要求可能跨两句）
        }
      }
      if (tailIdx < 0) return none;

      // 无引导语、无题目标记时，拆出的作文首段必须像"标题行"（短且无句末标点）
      if (!headLikePrompt && promptIdx < 0) {
        var firstEssayPara = paras[tailIdx + 1] || '';
        var looksLikeTitle = firstEssayPara.length >= 2 && firstEssayPara.length <= 22 &&
          !/[。！？，；：、…!?]/.test(firstEssayPara);
        if (!looksLikeTitle) return none;
      }

      promptParts = paras.slice(0, tailIdx + 1);
      essayParts = paras.slice(tailIdx + 1);
      by = 'rule';
    }

    var prompt = normalizeText(promptParts.filter(Boolean).join('\n\n'));
    var essay = normalizeText(essayParts.filter(Boolean).join('\n\n'));

    // 合理性校验：题目长度 15-900；正文要比题目长且不少于 80 字，否则判为误拆
    var pLen = cjkCount(prompt), eLen = cjkCount(essay);
    if (pLen < 12 || pLen > 900 || eLen < 80 || eLen <= pLen) return none;
    // 正文里不应再出现大段"写作要求"指令（误拆特征）
    if (/选准角度.*不要脱离材料内容/.test(essay)) return none;

    return { detected: true, prompt: prompt, essay: essay, by: by };
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

  window.EssayFile = {
    extract: extract,
    splitDocument: splitDocument,
    cancelOcr: cancelOcr,
    supported: '.txt,.md,.docx,.pdf,.png,.jpg,.jpeg,.webp,.bmp',
    guessTitle: guessTitle
  };
})();
