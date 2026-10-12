/* ============================================================
 * 交互流程：题目审题 → 写作文 → 等待批改 → 分档报告与建议
 * 批改方式：AI 大模型（经本机后端），整体评判
 * 上海高考思辨议论文 · 满分 70 分 · 五类档
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var promptEl = $('essay-prompt'),
    examSel = $('exam-prompt-select'),
    titleEl = $('essay-title'),
    typeEl = $('essay-type'),
    targetEl = $('essay-target'),
    textEl = $('essay-text'),
    countEl = $('char-count'),
    tipEl = $('form-tip'),
    analyzeBox = $('analyze-result'),
    analyzeHint = $('analyze-hint'),
    analyzeBtn = $('btn-analyze');

  /* ---------------- 内置真题下拉 ---------------- */
  EssayAI.EXAM_PROMPTS.forEach(function (item) {
    var opt = document.createElement('option');
    opt.value = item.text;
    opt.textContent = item.district;
    examSel.appendChild(opt);
  });
  examSel.addEventListener('change', function () {
    if (examSel.value) {
      promptEl.value = examSel.value;
      analyzeBox.hidden = true;
      analyzeHint.textContent = '已载入题目，点击“审题指导”查看题型、立意层次与提纲。';
      analyzeHint.className = 'analyze-hint';
    }
  });
  promptEl.addEventListener('input', function () {
    analyzeBox.hidden = true;
    analyzeHint.textContent = '';
    analyzeHint.className = 'analyze-hint';
    if (examSel.value && examSel.value !== promptEl.value) examSel.value = '';
  });

  /* ---------------- 示例作文 ---------------- */

  // 正面样本：2025 金山一模《常识不应成为常态》（60 分考场作文）
  var SAMPLE_1 = {
    promptIdx: 13, // 金山
    title: '常识不应成为常态',
    type: '议论文',
    target: 800,
    text:
      '在日常生活中，运用常识已成为一种普遍现象。人们常常依赖它来认识世界，并据此作出决策。但是，常识真的总是那么可靠吗？\n' +
      '确实，常识在判断事物时具有其合理性。常识是大众普遍认同并总结下来的智慧精华，是经过时间的检验和历史的沉淀而广为人知的规律。运用常识来辨别事物，顺应了事物固有的发展常态，有助于我们高效、省时省力地做出决策。作为社会性动物的人类，通过常识的判断，我们能够获得更多的共鸣，在社会的赞许中，我们的自我认同感得到提升，从而获得精神上的愉悦。\n' +
      '“往往”一词通常指代大多数情况，并非意味着在所有情况下都应依据常理进行判断。我们同样认识到事物具有其特殊性。因此，我们对“往往”这一表述表示深深的赞同。\n' +
      '然而，事实真的如此吗？“往往”反映的是一种情感倾向，人们在不知不觉中、不受控制地、不约而同地按照常规解决问题，并自认为已经掌握了时机。这是一种极其危险的状况。想象一下，如果每个人都高估了自己的能力，构建了一个虚幻的梦想，那么我们所处的社会将会是多么空洞。\n' +
      '本质上，常识的特性限定了它的应用范围。常识基于普遍规律，但这些规律并不总是适用于我们遇到的特殊情况，容易导致以偏概全。我们往往难以区分哪些情况是特殊，哪些是普遍，这进一步加深了常识对我们的影响。这一点值得我们警惕。常识还受限于特定的时空背景和教育环境。当时代背景发生重大变化时，我们不能盲目依赖常识来判断事物。“从来如此，便对吗？”鲁迅在中华民族深陷黑暗、徘徊不前的时代，反常识地选择了弃医从文，唤醒了时代精神。在欧洲，曾经以“人类是宇宙中心”的观念为常识，地心说盛行，但哥白尼提出日心说，挑战了教会的权威，从而开启了自然科学从神学束缚中解放的新纪元。\n' +
      '如果我们习惯于依赖常识性的理解，盲目跟随大众的认知，长此以往，我们就会失去独立思考的能力和对真理的探索，这正是羊群效应和从众心理的体现。当个人受到常识的束缚，社会也会陷入僵局，每个人都困于自己的信息茧房之中，社会将失去活力。\n' +
      '观察当下，网络上人们不经思考地顺从他人观点，这暗示了他们受到媒介影响、被资本无形地束缚，无法正确理性地看待事物，作出独立判断。常识不应成为常态，若长期如此，后果将难以预料。\n' +
      '因此，我们应当坚守内心的信念，不受传统观念的束缚，独立思考，从心出发，在常识的浪潮中保留属于自己的判断。'
  };

  var AI_STEPS = [
    '逐词批注题目材料，核查审题',
    '通读全文，把握中心论点与分档',
    '检查论证层次、论据分析与硬伤',
    '按上海五类档赋分（70 分制）',
    '撰写逐句批注与修改建议'
  ];

  var lastSubmit = null;
  var gradingTimer = null;
  var serverCfg = null;

  /* ---------- 本地状态持久化（刷新页面不丢：登录态 / 输入草稿 / 批改报告） ---------- */
  var LS_DRAFT = 'eg_draft_v1',  // localStorage：写作表单草稿（免登录用户也生效）
    LS_USER = 'eg_user_v1',      // localStorage：最近一次登录的公开信息（即时显示，服务端核对）
    SS_VIEW = 'eg_view_v1',      // sessionStorage：刷新前所在面板
    SS_REPORT = 'eg_report_v1';  // sessionStorage：最近一份批改报告（刷新后原地恢复）
  function storeGet(key, sess) {
    try {
      var raw = (sess ? sessionStorage : localStorage).getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function storeSet(key, val, sess) {
    try { (sess ? sessionStorage : localStorage).setItem(key, JSON.stringify(val)); }
    catch (e) { /* 隐私模式 / 配额满：静默降级 */ }
  }
  function storeDel(key, sess) {
    try { (sess ? sessionStorage : localStorage).removeItem(key); } catch (e) {}
  }

  /* ---------- 字数统计（考场占格口径：汉字与标点均占一格） ---------- */
  function updateCount() { countEl.textContent = EssayEngine.gridLen(textEl.value); }
  textEl.addEventListener('input', function () {
    updateCount();
    tipEl.textContent = '';
    tipEl.classList.remove('show');
    renderTextHighlights();
  });

  function loadSample(s) {
    var p = EssayAI.EXAM_PROMPTS[s.promptIdx];
    examSel.value = p.text;
    promptEl.value = p.text;
    titleEl.value = s.title;
    typeEl.value = s.type;
    targetEl.value = s.target;
    textEl.value = s.text;
    analyzeBox.hidden = true;
    analyzeHint.textContent = '已载入对应作文题目，建议先点“审题指导”，再看这篇作文的批改结果。';
    analyzeHint.className = 'analyze-hint';
    updateCount();
  }
  $('load-sample-1').addEventListener('click', function () { loadSample(SAMPLE_1); resetProof(); });
  $('btn-clear').addEventListener('click', function () {
    textEl.value = '';
    titleEl.value = '';
    resetProof();
    updateCount();
    textEl.focus();
  });

  /* ---------- 文件上传识别（Word/PDF/TXT/图片 OCR） ---------- */
  var upZone = $('upload-zone'),
    upInput = $('essay-file'),
    upBox = $('upload-progress'),
    upName = $('up-name'),
    upBar = $('up-bar'),
    upStatus = $('up-status'),
    upCancel = $('up-cancel');
  var uploadSeq = 0; // 用于取消后丢弃迟到的解析结果

  /* ---------- 识别校对（疑似 OCR 错字标红 + 一键替换） ---------- */
  var proofCard = $('proof-card'),
    pcLoading = $('pc-loading'),
    pcRows = $('pc-rows'),
    pcCount = $('pc-count'),
    pcClose = $('pc-close'),
    pcTip = $('pc-tip');
  var proofSeq = 0, proofItems = [], proofDone = {};

  /* ---------- 正文框内标红/标蓝覆盖层 ----------
   * 原生 textarea 不支持富文本：在 textarea 背后垫一个同字体/同边距的
   * 覆盖层，文字透明、只画高亮底色；textarea 背景透明让底色透出来。 */
  var hlEl = $('text-highlights');

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 把 textarea 的计算样式同步到覆盖层，保证逐像素对齐
  function syncHlStyle() {
    if (!hlEl) return;
    var cs = window.getComputedStyle(textEl);
    ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
     'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
     'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
     'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
     'whiteSpace', 'overflowWrap'].forEach(function (p) { hlEl.style[p] = cs[p]; });
  }

  // textarea 出现纵向滚动条时内容区变窄，覆盖层需补上同等右内边距，否则换行错位
  function syncHlMetrics() {
    syncHlStyle();
    if (!hlEl) return;
    var bl = parseFloat(hlEl.style.borderLeftWidth) || 0;
    var br = parseFloat(hlEl.style.borderRightWidth) || 0;
    var sb = (textEl.offsetWidth - textEl.clientWidth) - bl - br;
    if (!(sb > 0)) sb = 0;
    var padR = parseFloat(hlEl.style.paddingRight) || 0;
    hlEl.style.paddingRight = (padR + sb) + 'px';
  }

  function itemRange(it) {
    var val = textEl.value;
    var qi = val.indexOf(it.quote);
    if (qi < 0) return null;
    var wi = it.quote.indexOf(it.original);
    if (wi < 0) return null;
    var s = qi + wi;
    return { s: s, e: s + it.original.length, low: it.level === 'low' };
  }

  function renderTextHighlights() {
    if (!hlEl) return;
    syncHlMetrics();
    var val = textEl.value;
    var reds = [], blues = [];
    proofItems.forEach(function (it, idx) {
      if (proofDone[idx]) return; // 已替换/已失效：不再高亮
      var r = itemRange(it);
      if (!r) return;
      (r.low ? blues : reds).push(r);
    });
    function sweep(list) {
      list.sort(function (a, b) { return a.s - b.s; });
      var out = [], last = -1;
      list.forEach(function (r) {
        if (r.s >= last) { out.push(r); last = r.e; }
      });
      return out;
    }
    reds = sweep(reds);
    // 蓝色让位于红色：与任何红色区间重叠的蓝色丢弃，剩余蓝条内部再去重叠
    blues = sweep(blues.filter(function (b) {
      return !reds.some(function (r) { return b.s < r.e && r.s < b.e; });
    }));
    var all = reds.concat(blues).sort(function (a, b) { return a.s - b.s; });
    var html = '', pos = 0, i, r;
    for (i = 0; i < all.length; i++) {
      r = all[i];
      if (r.s > pos) html += escHtml(val.slice(pos, r.s));
      html += '<mark class="' + (r.low ? 'hl-blue' : '') + '">' + escHtml(val.slice(r.s, r.e)) + '</mark>';
      pos = r.e;
    }
    html += escHtml(val.slice(pos));
    hlEl.innerHTML = html;
    hlEl.scrollTop = textEl.scrollTop;
  }

  textEl.addEventListener('scroll', function () { if (hlEl) hlEl.scrollTop = textEl.scrollTop; });
  window.addEventListener('resize', renderTextHighlights);
  window.addEventListener('load', function () { syncHlMetrics(); renderTextHighlights(); });

  function resetProof() {
    proofSeq++;
    proofItems = [];
    proofDone = {};
    proofCard.hidden = true;
    pcRows.innerHTML = '';
    pcLoading.hidden = false;
    pcLoading.textContent = '正在校对识别文字（识别服务较慢时约需 1 分钟）…';
    renderTextHighlights();
  }

  function spliceOne(s, find, repl) {
    var i = s.indexOf(find);
    return i < 0 ? s : s.slice(0, i) + repl + s.slice(i + find.length);
  }

  // 在正文框当前内容中定位 quote 并把其中 original 替换为 suggest
  function applyProof(item, undo) {
    var val = textEl.value;
    var findQ, findW, replW;
    if (!undo) {
      findQ = item.quote; findW = item.original; replW = item.suggest;
    } else {
      findQ = spliceOne(item.quote, item.original, item.suggest); // 替换后的新片段
      findW = item.suggest; replW = item.original;
    }
    var qi = val.indexOf(findQ);
    if (qi < 0) return false;
    var wi = findQ.indexOf(findW);
    if (wi < 0) return false;
    var start = qi + wi;
    textEl.value = val.slice(0, start) + replW + val.slice(start + findW.length);
    updateCount();
    return true;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderProofRows() {
    pcLoading.hidden = true;
    pcRows.innerHTML = '';
    var remainR = 0, remainB = 0;
    proofItems.forEach(function (it, idx) {
      var low = it.level === 'low';
      var row = el('div', 'pc-row' + (low ? ' low' : '') + (proofDone[idx] === 'stale' ? ' stale' : ''));
      if (proofDone[idx] === 'done') {
        row.appendChild(el('span', 'pc-done-text', '已将「' + it.original + '」改为「' + it.suggest + '」'));
        var undoBtn = el('button', 'pc-undo', '撤销');
        undoBtn.type = 'button';
        undoBtn.dataset.action = 'undo';
        undoBtn.dataset.idx = idx;
        row.appendChild(undoBtn);
      } else {
        if (proofDone[idx] !== 'stale') { if (low) remainB++; else remainR++; }
        var oi = it.quote.indexOf(it.original);
        var quoteBtn = el('button', 'pc-quote');
        quoteBtn.type = 'button';
        if (proofDone[idx] === 'stale') quoteBtn.disabled = true;
        var before = oi >= 0 ? it.quote.slice(0, oi) : it.quote;
        var after = oi >= 0 ? it.quote.slice(oi + it.original.length) : '';
        if (before) quoteBtn.appendChild(el('span', 'pc-q-side', before));
        quoteBtn.appendChild(el('mark', '', it.original));
        if (after) quoteBtn.appendChild(el('span', 'pc-q-side', after));
        quoteBtn.dataset.action = 'accept';
        quoteBtn.dataset.idx = idx;
        row.appendChild(quoteBtn);
        var fixBtn = el('button', 'pc-fix-btn', '改为「' + it.suggest + '」' + (low ? '？' : ''));
        fixBtn.type = 'button';
        if (proofDone[idx] === 'stale') { fixBtn.disabled = true; fixBtn.textContent = '该处已被修改'; }
        fixBtn.dataset.action = 'accept';
        fixBtn.dataset.idx = idx;
        row.appendChild(fixBtn);
      }
      pcRows.appendChild(row);
    });
    var parts = [];
    if (remainR) parts.push(remainR + ' 处疑似识别错字');
    if (remainB) parts.push(remainB + ' 处可疑词');
    pcCount.textContent = parts.length
      ? '发现 ' + parts.join('、')
      : (proofItems.length ? '已全部处理' : '');
    renderTextHighlights();
  }

  pcRows.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var idx = +btn.dataset.idx, item = proofItems[idx];
    if (!item) return;
    if (btn.dataset.action === 'accept') {
      if (applyProof(item, false)) {
        proofDone[idx] = 'done';
        renderProofRows();
        toast('已将「' + item.original + '」改为「' + item.suggest + '」', 'ok');
      } else {
        proofDone[idx] = 'stale';
        renderProofRows();
        toast('该处正文已被修改，无法自动替换，请手动核对');
      }
    } else if (btn.dataset.action === 'undo') {
      if (applyProof(item, true)) {
        delete proofDone[idx];
        renderProofRows();
        toast('已撤销替换', 'ok');
      } else {
        toast('正文后续又被修改，无法自动撤销，请手动改回');
      }
    }
  });

  pcClose.addEventListener('click', resetProof);

  // 校对失败或无发现时显示一行状态（不再静默隐藏，让用户知道校对是否运行过）
  function proofStatus(msg) {
    pcLoading.hidden = true;
    pcRows.innerHTML = '';
    if (pcTip) pcTip.hidden = true;
    pcCount.textContent = msg;
    proofCard.hidden = false;
  }

  function runProofread(text) {
    resetProof();
    if (!(serverCfg && serverCfg.proofread && serverCfg.proofread.enabled)) return;
    if (!text || text.trim().length < 30) return;
    var seq = proofSeq;
    if (pcTip) pcTip.hidden = false;
    proofCard.hidden = false;
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e2) {}
    // 免费的校对模型高峰期响应可达 70s+，超时放宽到 95s（服务端上限 120s）
    var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e3) {} }, 95000);
    fetch('/api/proofread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text: text.slice(0, 6000) }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return null; });
    }, function () { return null; }).then(function (res) {
      clearTimeout(timer);
      if (seq !== proofSeq) return; // 已被新的识别/清空取代
      if (!res || !res.ok || !res.j || !res.j.ok || !Array.isArray(res.j.items)) {
        proofStatus('校对未完成（识别服务响应较慢），不影响批改，请人工核对正文'); // 未登录/超时/失败
        return;
      }
      if (!res.j.items.length) {
        proofStatus('校对完成：未发现明显的识别错字');
        return;
      }
      proofItems = res.j.items;
      proofDone = {};
      renderProofRows();
    }).catch(function () {
      clearTimeout(timer);
      if (seq === proofSeq) proofStatus('校对未完成（识别服务响应较慢），不影响批改，请人工核对正文');
    });
  }

  function pickFile() {
    if (!upZone.classList.contains('busy')) upInput.click();
  }
  upZone.addEventListener('click', pickFile);
  upZone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    upZone.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      upZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    upZone.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      upZone.classList.remove('dragover');
    });
  });
  upZone.addEventListener('drop', function (e) {
    var fs = e.dataTransfer && e.dataTransfer.files;
    if (fs && fs.length) handleFiles(fs);
  });
  upInput.addEventListener('change', function () {
    if (upInput.files && upInput.files.length) handleFiles(upInput.files);
    upInput.value = ''; // 允许重复选择同一个文件
  });
  upCancel.addEventListener('click', function () { resetUploadUI(); });

  function resetUploadUI() {
    uploadSeq++;
    if (window.EssayFile && EssayFile.cancelOcr) EssayFile.cancelOcr();
    upBox.hidden = true;
    upBox.classList.remove('ok', 'error');
    upZone.classList.remove('busy');
    upBar.style.width = '0%';
    upStatus.className = 'up-status';
  }

  function setUploadProgress(name, statusText, ratio) {
    upName.textContent = name;
    upStatus.textContent = statusText;
    upBar.style.width = Math.round((ratio || 0) * 100) + '%';
  }

  function handleFiles(files) {
    if (!window.EssayFile) {
      tipEl.textContent = '文件识别组件未加载（file-upload.js 缺失），请刷新页面。';
      tipEl.classList.add('show');
      return;
    }
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var dispName = list.length === 1 ? list[0].name : list.length + ' 张照片（按页序识别）';
    var seq = ++uploadSeq;
    upZone.classList.add('busy');
    upBox.hidden = false;
    upBox.classList.remove('ok', 'error');
    upStatus.className = 'up-status';
    setUploadProgress(dispName, '准备识别……', 0.05);

    EssayFile.extractMany(list, function (p) {
      if (seq !== uploadSeq) return;
      setUploadProgress(dispName, p.status || '识别中……', p.ratio || 0);
    }).then(function (res) {
      if (seq !== uploadSeq) return; // 已被取消

      // 自动拆分：文件中若同时包含「作文题目」与「作文（标题+正文）」，
      // 只把题目拆到第一步；标题保留在正文首行，不单独填写。
      var bodyText = res.text;
      var splitMsg = '';
      try {
        var split = EssayFile.splitDocument(res.text);
        if (split.detected) {
          if (!promptEl.value.trim()) {
            promptEl.value = split.prompt;
            bodyText = split.essay;
            splitMsg = '已自动识别出作文题目并填入上方第一步（标题保留在正文首行，无需单独填写）';
            if (examSel.value) examSel.value = '';
          } else {
            splitMsg = '题目框已有内容，文件全文已作为作文正文（如需改用文件中的题目，请先清空上方题目框再重新上传）';
          }
        } else {
          splitMsg = '未检测到独立的作文题目，全部内容已作为作文正文；如需审题可在第一步单独粘贴题目';
        }
      } catch (e) { splitMsg = ''; }

      textEl.value = bodyText;
      updateCount();
      var n = EssayEngine.gridLen(bodyText);
      var msg = '✓ 识别成功，共 ' + n + ' 字（含标点占格，与输入框计数一致）。' + splitMsg;
      if (res.dropped) {
        msg += '。已自动剔除识别模型添加的 ' + res.dropped + ' 处无关说明（未计入正文）';
      }
      if (res.kind === 'image') {
        msg += '。图片 OCR 可能有少量错字，请对照原文核对修改后再批改';
      }
      if (!/。$/.test(msg)) msg += '。';
      upStatus.textContent = msg;
      upStatus.className = 'up-status ok';
      upBox.classList.add('ok');
      upBar.style.width = '100%';
      upZone.classList.remove('busy');
      tipEl.textContent = '';
      tipEl.classList.remove('show');
      textEl.focus();
      runProofread(bodyText);
    }).catch(function (err) {
      if (seq !== uploadSeq) return;
      resetProof();
      upStatus.textContent = '✗ ' + (err && err.message ? err.message : '识别失败，请重试或直接粘贴文字。');
      upStatus.className = 'up-status error';
      upBox.classList.add('error');
      upZone.classList.remove('busy');
    });
  }

  /* ---------- 步骤切换（带浏览器历史，返回键不退出网站） ---------- */
  function showStep(n, push) {
    document.querySelectorAll('.stepper .step').forEach(function (el) {
      var sn = +el.dataset.step;
      el.classList.toggle('active', sn === n);
      el.classList.toggle('done', sn < n);
    });
    ['input', 'grading', 'report'].forEach(function (name, i) {
      $('panel-' + name).classList.toggle('active', i + 1 === n);
    });
    // 记住当前面板：刷新页面时据此留在原页面（批改中 step2 刷新则安全回到写作页）
    storeSet(SS_VIEW, { step: n }, true);
    if (push === true && (!history.state || history.state.step !== n)) {
      history.pushState({ step: n }, '');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // 浏览器前进 / 后退：在站内三个面板间切换，而不是退出整个网站
  window.addEventListener('popstate', function (e) {
    var n = e.state && e.state.step ? e.state.step : 1;
    showStep(n, false);
  });
  // 启动时决定落点：批改报告页且有缓存报告 → 留在报告页（末尾初始化时渲染）；
  // 其余情况（含批改中途刷新）回到写作输入页
  var bootReport = storeGet(SS_REPORT, true);
  var bootView = storeGet(SS_VIEW, true);
  var bootStep = (bootView && bootView.step === 3 && bootReport && bootReport.report) ? 3 : 1;
  if (bootStep !== 3) storeSet(SS_VIEW, { step: 1 }, true);
  history.replaceState({ step: bootStep }, '');

  /* ---------- 批改方式（仅一种，页面不再展示切换） ---------- */

  /* ---------- 审题 ---------- */
  function runAnalyze() {
    var p = promptEl.value.trim();
    if (EssayEngine.cjkLen(p) < 10) {
      analyzeHint.textContent = '请先粘贴作文题目材料（至少 10 个字），或从上方下拉选择一道一模真题。';
      analyzeHint.className = 'analyze-hint error';
      promptEl.focus();
      return;
    }
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '审题中…';
    analyzeHint.textContent = '正在识题型、批注题眼、推演立意层次与提纲……';
    analyzeHint.className = 'analyze-hint';
    EssayAI.analyze(p, null).then(function (data) {
      renderAnalyze(data.report, data.engine, data.model);
      analyzeHint.textContent = '审题完成：请重点参考“一类立意”与“偏题风险”，再动笔写作。';
      analyzeHint.className = 'analyze-hint ok';
    }).catch(function (err) {
      if (err && err.code === 'login_required') {
        analyzeHint.textContent = '审题指导需要登录后使用。';
        analyzeHint.className = 'analyze-hint error';
        openAuth('login', err.message || '审题指导需要先登录。');
        return;
      }
      analyzeHint.textContent = '审题请求失败：' + (err.message || '未知错误') + '（若长时间未访问，免费服务器可能正在休眠唤醒，请等约 1 分钟后重试一次）';
      analyzeHint.className = 'analyze-hint error';
    }).then(function () {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '🔍 审题指导';
    });
  }
  analyzeBtn.addEventListener('click', runAnalyze);

  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v, max) { return escapeHtml(String(v == null ? '' : v)).slice(0, max || 600); }

  function renderAnalyze(r, engine, model) {
    var isLocal = engine === 'local' || r.engine === 'local';
    var concepts = arr(r.coreConcepts).map(function (c) {
      return '<div class="ar-concept"><b>《' + str(c.name, 40) + '》</b><br>' +
        '<span>内涵：' + str(c.connotation, 300) + '</span><br>' +
        '<span style="color:var(--ink-3)">边界：' + str(c.boundary, 300) + '</span></div>';
    }).join('');

    var keys = arr(r.keyAnalysis).map(function (k) {
      return '<li><b>“' + str(k.quote, 30) + '”</b>：' + str(k.point, 300) + '</li>';
    }).join('');

    var angles = arr(r.angles).map(function (a, i) {
      var best = /一类|一类立意/.test(String(a.level)) || i === arr(r.angles).length - 1;
      var chain = '';
      if (Array.isArray(a.logicChain) && a.logicChain.length) {
        chain = '<div class="al-label">思维逻辑链（怎么一步步推出来的）</div>' +
          '<ol class="al-chain">' + a.logicChain.map(function (s) {
            return '<li>' + str(s, 200) + '</li>';
          }).join('') + '</ol>';
      }
      return '<div class="ar-angle' + (best ? ' best' : '') + '">' +
        '<div class="al-head"><span class="al-name">' + str(a.name, 40) + '</span>' +
        '<span class="al-level">' + str(a.level, 30) + '</span></div>' +
        '<div class="al-label">中心论点</div>' +
        '<span class="al-stand">' + str(a.stand, 260) + '</span>' +
        chain +
        '<div class="al-label">定位与点评</div>' +
        '<span class="al-eval">' + str(a.evaluation, 300) + '</span></div>';
    }).join('');

    var outline = arr(r.outline).map(function (o) {
      return '<li><b>' + str(o.step, 40) + '</b>：' + str(o.detail, 260) + '</li>';
    }).join('');

    var risks = arr(r.risks).map(function (x) {
      return '<li>' + str(x, 240) + '</li>';
    }).join('');

    // 思辨路径分析
    var dgHtml = '';
    var dg = r.dialecticGuide && typeof r.dialecticGuide === 'object' ? r.dialecticGuide : null;
    if (dg) {
      var lp = arr(dg.ladderPath).map(function (p) {
        return '<div class="dg-step">' +
          '<div class="dg-step-head"><span class="dg-num">' + str(p.step, 2) + '</span>' +
          '<b>' + str(p.name, 8) + '</b></div>' +
          (p.question ? '<p><span class="dg-k">追问</span>' + str(p.question, 200) + '</p>' : '') +
          (p.move ? '<p><span class="dg-k">怎么想</span>' + str(p.move, 300) + '</p>' : '') +
          (p.fake ? '<p class="dg-fake"><span class="dg-k">伪推进</span>' + str(p.fake, 300) + '</p>' : '') +
          (p.keySentence ? '<p class="dg-ks"><span class="dg-k">可写句</span>' + str(p.keySentence, 200) + '</p>' : '') +
          '</div>';
      }).join('');
      var brk = dg.breakthrough && typeof dg.breakthrough === 'object' ? dg.breakthrough : {};
      dgHtml =
        '<div class="ar-section ar-dialectic">' +
          '<h4>🧭 思辨路径分析</h4>' +
          (dg.tension ? '<div class="dg-tension"><span class="dg-k">本题张力</span>' +
            str(dg.tension, 420) + '</div>' : '') +
          (lp ? '<div class="dg-ladder">' + lp + '</div>' : '') +
          (dg.stickingPoint ? '<p class="dg-stick"><span class="dg-k">多数人的卡点</span>' +
            str(dg.stickingPoint, 300) + '</p>' : '') +
          ((brk.question || brk.sample) ? '<div class="dg-break">' +
            (brk.question ? '<p><span class="dg-k">关键一跃 · 追问</span>' + str(brk.question, 200) + '</p>' : '') +
            (brk.tool ? '<p><span class="dg-k">思辨动作</span>' + str(brk.tool, 20) + '</p>' : '') +
            (brk.sample ? '<p class="dg-sample"><span class="dg-k">示例句</span>' + str(brk.sample, 300) + '</p>' : '') +
            '</div>' : '') +
        '</div>';
    }

    var html =
      '<div class="ar-head">' +
        '<h3>审题指导</h3>' +
        '<span class="ar-tag' + (isLocal ? ' local' : '') + '">' + str(r.topicType, 12) + '</span>' +
        '<button type="button" class="btn btn-ghost btn-print-analyze no-print" id="btn-print-analyze" title="把审题指导单独生成一份排版整齐的 PDF">📄 生成 PDF</button>' +
      '</div>' +
      (r.warning ? '<div class="ar-warning">' + str(r.warning, 300) + '</div>' : '') +
      (r.notice ? '<div class="ar-warning">ℹ ' + str(r.notice, 300) + '</div>' : '') +
      (r.typeReason ? '<p style="margin-bottom:12px;color:var(--ink-3)">判断依据：' + str(r.typeReason, 200) + '</p>' : '') +
      '<div class="ar-section"><h4>材料真正要回答的问题</h4><div class="ar-question">' + str(r.coreQuestion, 300) + '</div></div>' +
      (concepts ? '<div class="ar-section"><h4>核心概念界定</h4><div class="ar-concepts">' + concepts + '</div></div>' : '') +
      (keys ? '<div class="ar-section"><h4>题眼逐词批注</h4><ul class="ar-keys">' + keys + '</ul></div>' : '') +
      dgHtml +
      (angles ? '<div class="ar-section"><h4>审题思路（多角度并列，按潜力排序）</h4><div class="ar-angles">' + angles + '</div></div>' : '') +
      (outline ? '<div class="ar-section"><h4>层进式参考提纲</h4><ol class="ar-outline">' + outline + '</ol></div>' : '') +
      (risks ? '<div class="ar-section"><h4>偏题风险清单</h4><ul class="ar-risks">' + risks + '</ul></div>' : '');

    analyzeBox.innerHTML = html;
    analyzeBox.classList.toggle('is-local', !!isLocal);
    analyzeBox.hidden = false;
    analyzeBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------- 提交批改 ---------- */
  $('btn-submit').addEventListener('click', function () {
    var text = textEl.value.trim();
    var n = EssayEngine.cjkLen(text);
    if (n < 20) {
      tipEl.textContent = n === 0 ? '请先输入或粘贴作文正文。' :
        '作文正文只有 ' + n + ' 字，至少输入 20 个汉字才能批改。';
      tipEl.classList.add('show');
      textEl.focus();
      return;
    }
    lastSubmit = {
      text: text,
      opts: {
        title: titleEl.value.trim(),
        type: typeEl.value,
        target: +targetEl.value,
        prompt: promptEl.value.trim()
      }
    };
    // 服务端未配置好批改服务时提示
    if (!(serverCfg && serverCfg.configured)) {
      tipEl.textContent = '系统维护中，暂时无法批改，请稍后再试或联系管理员。';
      tipEl.classList.add('show');
      return;
    }
    // 提前拦截未登录用户（服务端也会强制校验）
    if (serverCfg.auth && serverCfg.auth.loginRequired && !EssayAuth.user()) {
      openAuth('login', '批改需要先登录账号，登录后批改历史与作文草稿会自动云端保存。');
      return;
    }
    runAI();
  });

  function runAI() {
    showStep(2);
    hideGradeError();
    resetCloudNote();
    startGrading(AI_STEPS, function (done) {
      EssayAI.grade(lastSubmit.text, lastSubmit.opts, null)
        .then(function (data) {
          var report = EssayAI.adapt(data.report, lastSubmit.text, lastSubmit.opts);
          report.model = data.model;
          done(function () { renderReport(report, lastSubmit.text); showStep(3, true); });
          saveReportToCloud(report, data);
        })
        .catch(function (err) {
          done(null, err);
        });
    }, function (finish, err) {
      if (!err) { finish(); return; }
      if (err.code === 'login_required') {
        // 会话过期或未登录：回到写作页并弹出登录框
        showStep(1);
        openAuth('login', err.message || '请先登录后再使用。');
      } else {
        showGradeError(err);
      }
    });
  }

  /* ---------- 等待动画 ---------- */
  function startGrading(stepTexts, worker, onFinish) {
    var bar = $('progress-bar'),
      items = $('grade-steps'),
      statusEl = $('grading-status');

    items.innerHTML = stepTexts.map(function (t) {
      return '<li><i class="gs-icon">◌</i>' + t + '</li>';
    }).join('');
    bar.style.transition = 'none';
    bar.style.width = '0%';

    var idx = 0, done = false, result = null, failErr = null;
    var MIN_MS = 3600, STEP_MS = 720, startTs = Date.now();

    function finish(render, err) {
      if (done) return;
      for (var i = 0; i < items.children.length; i++) {
        items.children[i].classList.remove('active');
        items.children[i].classList.add('done');
        items.children[i].querySelector('.gs-icon').textContent = '✓';
      }
      bar.style.transition = 'width .4s ease';
      bar.style.width = '100%';
      setTimeout(function () {
        done = true;
        if (err) onFinish(null, err);
        else { onFinish(function () { render && render(); showStep(3); }); }
      }, 420);
    }

    function tick() {
      var children = items.children;
      if (idx < children.length) {
        children[idx].classList.add('active');
        children[idx].querySelector('.gs-icon').textContent = '◌';
        statusEl.textContent = stepTexts[idx];
        bar.style.transition = 'width .55s ease';
        bar.style.width = ((idx + 1) / stepTexts.length * 100) + '%';
        if (idx > 0) {
          children[idx - 1].classList.remove('active');
          children[idx - 1].classList.add('done');
          children[idx - 1].querySelector('.gs-icon').textContent = '✓';
        }
        idx++;
        gradingTimer = setTimeout(tick, STEP_MS);
      }
    }

    worker(function (render, err) {
      result = render; failErr = err;
      var wait = Math.max(0, MIN_MS - (Date.now() - startTs));
      setTimeout(function () { finish(result, failErr); }, wait);
    });
    setTimeout(tick, 250);
  }

  /* ---------- AI 失败提示 ---------- */
  function showGradeError(err) {
    $('grade-error').hidden = false;
    $('ge-title').textContent = friendlyTitle(err.code);
    $('ge-detail').textContent = err.message || '未知错误，请检查网络与模型配置。';
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }
  function hideGradeError() { $('grade-error').hidden = true; }

  function friendlyTitle(code) {
    return ({
      no_key: '服务暂未配置',
      auth_or_param: '服务配置有误',
      bad_config: '服务配置不完整',
      unavailable: '服务暂时不可用',
      bad_response: '批改结果返回异常',
      timeout: '批改超时',
      too_short: '作文太短',
      login_required: '需要先登录',
      quota_exceeded: '今日次数已达上限'
    })[code] || '批改失败';
  }

  $('ge-back').addEventListener('click', function () { hideGradeError(); showStep(1); });
  $('ge-retry-ai').addEventListener('click', function () { hideGradeError(); runAI(); });

  /* ---------- 渲染报告（70 分制） ---------- */
  function renderReport(r, rawText) {
    var C = 2 * Math.PI * 58;
    var ring = $('ring-fg');
    ring.style.stroke = r.band.color;
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C;
    $('total-score').textContent = '0';

    var badge = $('grade-badge');
    badge.textContent = r.band.label + ' · ' + r.band.sub;
    badge.style.background = r.band.color + '1f';
    badge.style.color = r.band.color;

    $('report-title').textContent = r.title ? '《' + r.title + '》批改报告' : '作文批改报告';
    $('report-summary').textContent = r.summary;

    // 机械指标条（字数/段落/例证数等）已取消：评分从整体论证质量感受出发

    // 审题契合度
    var dev = r.deviation || { status: 'none', label: '未核查', detail: '' };
    var ds = $('dev-status');
    ds.textContent = dev.label || '—';
    ds.className = 'dev-status ' + (dev.status || 'none');
    $('dev-detail').textContent = dev.detail || '';

    // 诊断四维（逐维独立档位 + 详细点评，不加分）
    $('dim-list').innerHTML = r.dims.map(function (d) {
      var color = d.color || r.band.color;
      return '<div class="dim-item">' +
        '<div class="dim-top"><span class="dim-name">' + d.name + '</span>' +
        '<span class="dim-band" style="color:' + color + ';border-color:' + color + '">' +
        d.band + ' · ' + d.sub + '水平</span></div>' +
        '<div class="dim-comment">' + escapeHtml(d.tip) + '</div>' +
        '</div>';
    }).join('');

    $('essay-view').innerHTML = EssayEngine.renderAnnotated(rawText, r.marks);

    // 文章逻辑评判
    renderLogic(r.logicReview || {});
    // 思辨水平评析
    renderDialectic(r.dialecticReview || {});
    // 逐句修改示范
    renderRewrites(r.rewrites || []);
    // 逐段修改建议
    var pa = r.paragraphAdvice || [];
    $('para-advice-list').innerHTML = pa.length
      ? pa.map(function (p) {
        return '<li>' + (p.para ? '<b>第 ' + p.para + ' 段</b>　' : '') + escapeHtml(p.advice) + '</li>';
      }).join('')
      : '<li class="praise-item">段落安排没有明显结构性问题，修改重点可放在句内表达与论据分析上。</li>';

    var tagText = { error: '需修改', warn: '建议', tip: '技巧' };
    $('sug-list').innerHTML = r.suggestions.length
      ? r.suggestions.map(function (s) {
        return '<li class="sug-item ' + s.level + '">' +
          '<div class="sug-head"><span class="sug-tag">' + tagText[s.level] + '</span>' +
          '<span class="sug-title">' + escapeHtml(s.title) + '</span></div>' +
          '<div class="sug-detail">' + escapeHtml(s.detail) + '</div></li>';
      }).join('')
      : '<li class="praise-item">本次没有需要优先修改的硬伤，继续保持。</li>';

    $('praise-list').innerHTML = r.praises.length
      ? r.praises.map(function (p) { return '<li class="praise-item">' + escapeHtml(p) + '</li>'; }).join('')
      : '<li class="praise-item">写完后多读多改，会越来越好。</li>';

    setTimeout(function () {
      ring.style.strokeDashoffset = C * (1 - r.total / 70);
      animateNumber($('total-score'), r.total, 1000);
    }, 120);

    // 缓存当前报告：刷新批改页时可原地恢复，不退回写作输入页
    storeSet(SS_REPORT, {
      report: r,
      text: rawText || '',
      opts: lastSubmit ? lastSubmit.opts : null,
      ts: Date.now()
    }, true);
  }

  function animateNumber(el, target, ms) {
    var start = Date.now();
    function frame() {
      var p = Math.min(1, (Date.now() - start) / ms);
      var ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * ease);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------- 逻辑评判渲染 ---------- */
  function renderLogic(lr) {
    $('logic-thesis').textContent = lr.thesis || '（未能识别中心论点）';

    var flow = Array.isArray(lr.paragraphFlow) ? lr.paragraphFlow : [];
    $('logic-flow').innerHTML = flow.length ? flow.map(function (p) {
      var methods = Array.isArray(p.methods) && p.methods.length ? p.methods.join('·') : '';
      return '<div class="lf-item">' +
        '<div class="lf-head"><span class="lf-para">' + p.para + '</span>' +
        '<span class="lf-role">' + str(p.role, 10) + '</span>' +
        (methods ? '<span class="lf-methods">' + str(methods, 30) + '</span>' : '') + '</div>' +
        '<div class="lf-gist">' + str(p.gist, 48) + '</div>' +
        (p.structure ? '<div class="lf-struct">' + str(p.structure, 100) + '</div>' : '') +
        '</div>';
    }).join('') : '<div class="logic-empty">本次未生成逐段结构分析，请重新批改。</div>';

    $('logic-chain').textContent = lr.chain || '本次未生成论证链条评价，请重新批改。';

    var falls = Array.isArray(lr.fallacies) ? lr.fallacies : [];
    $('logic-fallacies').innerHTML = falls.length
      ? falls.map(function (f) {
        return '<li class="fal-item"><span class="fal-name">' + str(f.name, 18) + '</span>' +
          (f.excerpt ? '<span class="fal-excerpt">“' + str(f.excerpt, 60) + '”</span>' : '') +
          (f.why ? '<span class="fal-why">' + str(f.why, 160) + '</span>' : '') + '</li>';
      }).join('')
      : '<li class="logic-empty">未发现明显逻辑谬误，论证前提与推理基本站得住。</li>';

    var sts = Array.isArray(lr.strengths) ? lr.strengths : [];
    $('logic-strengths').innerHTML = sts.length
      ? sts.map(function (s) { return '<li>' + str(s, 120) + '</li>'; }).join('')
      : '<li class="logic-empty">逻辑亮点暂不明显，先从“让步—转折”补起。</li>';

    var wls = Array.isArray(lr.weakLinks) ? lr.weakLinks : [];
    // 删除方向 type（行文减法）——用暖色与补充类（蓝色）区分
    var WL_DEL = { '论述累赘': 1, '同义重复': 1, '无意义铺陈': 1, '口号空转': 1, '例子功能重复': 1 };
    $('logic-weaklinks').innerHTML = wls.length
      ? wls.map(function (w) {
        var wtype = str(w.type, 12);
        var isDel = !!WL_DEL[wtype];
        return '<li class="wl-item' + (isDel ? ' wl-del' : '') + '">' +
          '<span class="wl-type">' + (isDel ? '删减·' : '补充·') + wtype + '</span>' +
          (w.excerpt ? '<span class="wl-excerpt">“' + str(w.excerpt, 60) + '”</span>' : '') +
          (w.point ? '<span class="wl-point">' + str(w.point, 160) + '</span>' : '') +
          (w.upgrade ? '<span class="wl-upgrade">' + (isDel ? '✂ ' : '↳ ') + str(w.upgrade, 200) + '</span>' : '') +
          '</li>';
      }).join('')
      : '<li class="logic-empty">本篇各主要论证环节都比较扎实，暂无明显需要调整之处。</li>';
  }

  /* ---------- 思辨水平评析渲染 ---------- */
  function renderDialectic(dr) {
    var ladder = Array.isArray(dr.ladder) ? dr.ladder : [];
    $('dc-ladder').innerHTML = ladder.length ? ladder.map(function (s) {
      var st = s.status === '达到' ? 'reached' : (s.status === '形式化' ? 'formal' : 'none');
      return '<div class="dc-step ' + st + '">' +
        '<div class="dc-step-head"><span class="dc-step-num">' + s.step + '</span>' +
        '<span class="dc-step-name">' + str(s.name, 8) + '</span>' +
        '<span class="dc-step-status">' + str(s.status, 4) + '</span></div>' +
        (s.evidence ? '<div class="dc-step-ev">“' + str(s.evidence, 48) + '”</div>' : '') +
        (s.analysis ? '<div class="dc-step-an"><span class="dc-mini-label">细评</span>' +
          str(s.analysis, 320) + '</div>' : '') +
        (s.suggestion ? '<div class="dc-step-sg"><span class="dc-mini-label">建议</span>' +
          str(s.suggestion, 240) + '</div>' : '') +
        '</div>';
    }).join('') : '<p class="logic-empty">本次未生成思辨层次定位，请重新批改。</p>';

    $('dc-highest').textContent = dr.highest || '本次未生成当前层次';
    $('dc-hc').textContent = dr.highestComment || '';

    var nm = dr.nextMove || {};
    $('dc-question').textContent = nm.question || '（未生成下一步追问）';
    $('dc-tool-chip').textContent = nm.tool ? '思辨动作 · ' + nm.tool : '';

    $('dc-why').textContent = nm.why || '';
    $('nm-why-row').style.display = nm.why ? '' : 'none';

    var thinkSteps = Array.isArray(nm.think) ? nm.think : [];
    $('dc-think').innerHTML = thinkSteps.map(function (q, i) {
      return '<li><span class="nm-think-num">' + (i + 1) + '</span>' +
        '<span class="nm-think-q">' + str(q, 140) + '</span></li>';
    }).join('');
    $('nm-think-wrap').style.display = thinkSteps.length ? '' : 'none';

    $('dc-pitfall').textContent = nm.pitfall || '';
    $('nm-pit-wrap').style.display = nm.pitfall ? '' : 'none';

    $('dc-anchor').innerHTML = nm.anchor
      ? '<span class="nm-anchor-ic">◈</span><b>落点　</b>' + escapeHtml(nm.anchor) : '';

    $('dc-sample').textContent = nm.sample || '';
    $('nm-sample-wrap').style.display = nm.sample ? '' : 'none';

    var bd = dr.breadth || {};
    var cov = Array.isArray(bd.covered) ? bd.covered : [];
    $('dc-covered').innerHTML = cov.length
      ? cov.map(function (c) { return '<span class="dc-chip">' + str(c, 14) + '</span>'; }).join('')
      : '<span class="dc-chip-empty">未明确标注</span>';
    $('dc-missing').textContent = bd.missing || '无明显缺角';
    $('dc-bcomment').textContent = bd.comment || '';

    $('dc-overall').textContent = dr.overall || '';
  }

  /* ---------- 逐句改写示范渲染 ---------- */
  function renderRewrites(list) {
    $('rewrite-list').innerHTML = list.length
      ? list.map(function (rw, i) {
        return '<div class="rw-item">' +
          '<div class="rw-row rw-original"><span class="rw-tag">原句 ' + (i + 1) + '</span>' +
            '<span class="rw-text">' + str(rw.original, 200) + '</span></div>' +
          (rw.issue ? '<div class="rw-row rw-issue"><span class="rw-tag">问题</span>' +
            '<span class="rw-text">' + str(rw.issue, 200) + '</span></div>' : '') +
          '<div class="rw-row rw-revised"><span class="rw-tag">改写</span>' +
            '<span class="rw-text">' + str(rw.revised, 300) + '</span></div>' +
          (rw.why ? '<div class="rw-row rw-why"><span class="rw-tag">理由</span>' +
            '<span class="rw-text">' + str(rw.why, 200) + '</span></div>' : '') +
          '</div>';
      }).join('')
      : '<p class="logic-empty">本篇没有生成逐句改写示范。</p>';
  }

  $('btn-again').addEventListener('click', function () { showStep(1, true); textEl.focus(); });

  /* ---------- 生成 PDF：统一组合到 #print-host 再打印 ---------- */
  var printHost = $('print-host');

  function analyzePrintHtml() {
    var material = promptEl.value.trim();
    return '<section class="print-part">' +
      '<h2 class="print-doc-title">作文审题指导</h2>' +
      (material ? '<div class="ar-print-material"><b>【题目材料】</b>' + str(material, 800) + '</div>' : '') +
      analyzeBox.innerHTML +
      '</section>';
  }

  function reportPrintHtml() {
    return '<section class="print-part">' + $('panel-report').innerHTML + '</section>';
  }

  function doPrint(parts, docTitle) {
    var origTitle = document.title;
    printHost.innerHTML = parts.join('<div class="print-page-break"></div>');
    document.title = docTitle;
    // 打印 CSS 已强制展开滚动区，这里无需改原页面样式
    setTimeout(function () {
      window.print();
      document.title = origTitle;
      printHost.innerHTML = '';
    }, 100);
  }

  function printAnalyzeOnly() {
    if (analyzeBox.hidden || !analyzeBox.innerHTML.trim()) return;
    doPrint([analyzePrintHtml()], '作文审题指导');
  }

  // 审题指导结果区的「生成 PDF」按钮（结果每次重渲染，用事件委托）
  analyzeBox.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'btn-print-analyze') printAnalyzeOnly();
  });

  // 批改报告 PDF：已填题目材料时，询问是否连同审题指导一起生成
  var printChoiceModal = $('print-choice-modal');
  function closePrintChoice() { printChoiceModal.hidden = true; }
  $('print-choice-close').addEventListener('click', closePrintChoice);
  printChoiceModal.addEventListener('click', function (e) { if (e.target === printChoiceModal) closePrintChoice(); });

  $('print-report-only').addEventListener('click', function () {
    closePrintChoice();
    printReport(false);
  });
  $('print-with-analyze').addEventListener('click', function () {
    var hasAnalyze = !analyzeBox.hidden && !!analyzeBox.innerHTML.trim();
    closePrintChoice();
    if (hasAnalyze) { printReport(true); return; }
    // 尚未审题：先跑审题，成功后连同批改报告一起生成
    var btn = this;
    btn.disabled = true;
    EssayAI.analyze(promptEl.value.trim(), null).then(function (data) {
      renderAnalyze(data.report, data.engine, data.model);
      printReport(true);
    }).catch(function (err) {
      analyzeHint.textContent = '审题请求失败：' + ((err && err.message) || '未知错误') + '，已改为只生成批改报告。';
      analyzeHint.className = 'analyze-hint error';
      printReport(false);
    }).then(function () { btn.disabled = false; });
  });

  function printReport(withAnalyze) {
    var title = $('report-title').textContent.trim();
    var base = title.replace(/[《》]/g, '').replace(/批改报告/g, '').trim();
    var docTitle = (base && base !== '作文批改报告') ? base + '批改报告' : '作文批改报告';
    var parts = withAnalyze ? [analyzePrintHtml(), reportPrintHtml()] : [reportPrintHtml()];
    doPrint(parts, docTitle);
  }

  $('btn-print').addEventListener('click', function () {
    var hasMaterial = EssayEngine.cjkLen(promptEl.value.trim()) >= 10;
    if (!hasMaterial) { printReport(false); return; }
    var hasAnalyze = !analyzeBox.hidden && !!analyzeBox.innerHTML.trim();
    $('print-choice-msg').textContent = hasAnalyze
      ? '检测到你已生成过本题的审题指导。需要把审题指导排在批改报告之前，一起生成一份完整 PDF 吗？'
      : '你已填写题目材料，但还没有生成本题的审题指导。要先审题，再把审题指导排在批改报告之前一起生成 PDF 吗？';
    $('print-with-analyze').textContent = hasAnalyze
      ? '✅ 审题指导 + 批改报告，一起生成'
      : '🔍 先审题，再连同批改报告一起生成';
    printChoiceModal.hidden = false;
  });

  /* ---------- AI 设置已由网站统一配置（服务端 .env），不再提供浏览器端入口 ---------- */

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ============================================================
   * 账号：登录/注册、用户菜单、云端草稿、批改历史
   * ============================================================ */

  var userArea = $('user-area');
  var authModal = $('auth-modal');
  var historyModal = $('history-modal');
  var authLoginEl = $('auth-login'),
    authPwEl = $('auth-pw'),
    authMsgEl = $('auth-msg'),
    authSubmitEl = $('auth-submit');
  var historyListEl = $('history-list');
  var cloudNoteEl = $('cloud-save-note');

  /* ---------- 轻提示 ---------- */
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    $('toast-wrap').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 2400);
  }

  /* ---------- 头部用户区 ---------- */
  function quotaText() {
    var q = EssayAuth.quota();
    if (!q) return '';
    var g = q.grades, a = q.analyzes;
    var gt = g.limit ? '批改 ' + Math.max(0, g.limit - g.used) + ' 次' : '批改不限次';
    var at = a.limit ? '、审题 ' + Math.max(0, a.limit - a.used) + ' 次' : '';
    return '今日剩余：' + gt + at;
  }

  function renderUserArea() {
    var u = EssayAuth.user();
    $('btn-history').hidden = !u;
    if (!u) {
      userArea.innerHTML = '<button type="button" class="btn-login" id="btn-login">👤 登录</button>';
      $('btn-login').addEventListener('click', function () { openAuth('login'); });
      return;
    }
    userArea.innerHTML =
      '<button type="button" class="user-chip" id="user-chip">' +
        '<span>🙂</span><span class="uc-name"></span><span class="uc-caret">▾</span></button>' +
      '<div class="user-menu" id="user-menu" hidden>' +
        '<div class="um-head"><div class="um-name"></div>' +
        '<div class="um-login">账号：<span class="um-login-val"></span></div></div>' +
        '<div class="um-quota" id="um-quota"></div>' +
        '<button type="button" class="um-item" id="um-history">📂 我的批改历史</button>' +
        '<button type="button" class="um-item danger" id="um-logout">退出登录</button>' +
      '</div>';
    userArea.querySelector('.uc-name').textContent = u.displayName || u.login;
    userArea.querySelector('.um-name').textContent = u.displayName || u.login;
    userArea.querySelector('.um-login-val').textContent = u.login;
    userArea.querySelector('#um-quota').textContent = quotaText() || '已登录';
    var menu = $('user-menu');
    $('user-chip').addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    menu.addEventListener('click', function (e) { e.stopPropagation(); });
    $('um-history').addEventListener('click', function () {
      menu.hidden = true;
      openHistory();
    });
    $('um-logout').addEventListener('click', function () {
      menu.hidden = true;
      EssayAuth.logout().then(function () {
        resetCloudNote();
        toast('已退出登录');
      });
    });
  }
  document.addEventListener('click', function () {
    var menu = $('user-menu');
    if (menu) menu.hidden = true;
  });

  /* ---------- 登录弹窗 ---------- */
  function showAuthMsg(msg, ok) {
    authMsgEl.textContent = msg || '';
    authMsgEl.className = 'modal-tip' + (ok ? ' ok' : '');
  }
  function openAuth(mode, msg) {
    showAuthMsg(msg || '', false);
    authModal.hidden = false;
    setTimeout(function () { authLoginEl.focus(); }, 30);
  }
  function closeAuth() {
    authModal.hidden = true;
    showAuthMsg('');
  }
  $('auth-close').addEventListener('click', closeAuth);
  authModal.addEventListener('click', function (e) { if (e.target === authModal) closeAuth(); });
  [authLoginEl, authPwEl].forEach(function (el) {
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(); });
  });
  authSubmitEl.addEventListener('click', submitAuth);

  function submitAuth() {
    var loginName = authLoginEl.value.trim();
    var pw = authPwEl.value;
    if (!loginName || loginName.length < 3 || loginName.length > 20) {
      showAuthMsg('请输入发放的账号。');
      return;
    }
    if (!pw) {
      showAuthMsg('请输入密码。');
      return;
    }
    authSubmitEl.disabled = true;
    authSubmitEl.textContent = '登录中…';
    EssayAuth.login(loginName, pw).then(function () {
      closeAuth();
      authPwEl.value = '';
      toast('登录成功', 'ok');
      restoreCloudDraft(true);
    }).catch(function (err) {
      showAuthMsg(err.message || '登录失败，请稍后重试。');
    }).then(function () {
      authSubmitEl.disabled = false;
      authSubmitEl.textContent = '登录';
    });
  }

  /* ---------- 云端草稿（输入停顿 2.5 秒自动保存） ---------- */
  var draftTimer = null;
  function collectDraft() {
    return {
      prompt: promptEl.value,
      title: titleEl.value,
      type: typeEl.value,
      target: String(targetEl.value),
      text: textEl.value
    };
  }
  function applyDraft(d) {
    promptEl.value = d.prompt || '';
    titleEl.value = d.title || '';
    if (d.type) typeEl.value = d.type;
    if (d.target) targetEl.value = d.target;
    textEl.value = d.text || '';
    if (examSel.value && examSel.value !== promptEl.value) examSel.value = '';
    updateCount();
  }
  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      var d = collectDraft();
      // 本地草稿：免登录用户也能在刷新后恢复输入
      storeSet(LS_DRAFT, d);
      // 云端草稿：登录用户额外跨设备同步
      if (EssayAuth.user()) EssayAuth.saveDraft(d).catch(function () { /* 静默 */ });
    }, 1000);
  }
  [promptEl, titleEl, typeEl, targetEl, textEl].forEach(function (el) {
    el.addEventListener('input', scheduleDraftSave);
    el.addEventListener('change', scheduleDraftSave);
  });
  function draftsEquivalent(a, b) {
    return String(a && a.text || '') === String(b && b.text || '') &&
      String(a && a.prompt || '') === String(b && b.prompt || '');
  }
  function restoreCloudDraft(notify) {
    EssayAuth.loadDraft().then(function (d) {
      if (!d || (!String(d.text || '').trim() && !String(d.prompt || '').trim())) return;
      var localHas = promptEl.value.trim() || titleEl.value.trim() || textEl.value.trim();
      if (!localHas) {
        applyDraft(d);
        if (notify) toast('已恢复你上次未完成的云端草稿', 'ok');
      } else if (draftsEquivalent(d, collectDraft())) {
        // 本地草稿与云端一致（刚刷新过页面），不打扰用户
      } else if (window.confirm('云端存有你上次未写完的作文，是否用云端草稿替换当前页面内容？\n（点“取消”保留当前内容）')) {
        applyDraft(d);
        storeSet(LS_DRAFT, collectDraft());
        toast('已恢复云端草稿', 'ok');
      }
    }).catch(function () { /* 静默 */ });
  }

  /* ---------- 批改报告自动上云 ---------- */
  function resetCloudNote() {
    cloudNoteEl.hidden = true;
    cloudNoteEl.className = 'cloud-save-note';
    cloudNoteEl.innerHTML = '';
  }
  function saveReportToCloud(report, data) {
    resetCloudNote();
    if (!EssayAuth.user()) {
      cloudNoteEl.hidden = false;
      cloudNoteEl.className = 'cloud-save-note';
      cloudNoteEl.innerHTML = '🔒 登录后可把报告保存到云端，换手机/电脑也能查看 ' +
        '<button type="button" class="link-btn" id="cs-login">去登录</button>';
      $('cs-login').addEventListener('click', function () {
        openAuth('login', '登录后报告将自动保存到云端，还能跨设备查看历史。');
      });
      return;
    }
    var payload = {
      title: lastSubmit.opts.title || report.title || '',
      prompt: lastSubmit.opts.prompt || '',
      text: lastSubmit.text,
      score: report.total,
      bandLabel: report.band ? report.band.label : '',
      bandSub: report.band ? report.band.sub : '',
      summary: report.summary || '',
      report: report,
      model: report.model || (data && data.model) || ''
    };
    cloudNoteEl.hidden = false;
    cloudNoteEl.className = 'cloud-save-note';
    cloudNoteEl.textContent = '正在保存到云端历史……';
    EssayAuth.saveEssay(payload).then(function () {
      cloudNoteEl.className = 'cloud-save-note ok';
      cloudNoteEl.textContent = '✓ 已保存到云端，可在右上角“📂 历史记录”随时查看';
      EssayAuth.refreshMe(); // 刷新配额显示
    }).catch(function () {
      cloudNoteEl.className = 'cloud-save-note err';
      cloudNoteEl.innerHTML = '⚠ 报告未能保存到云端 ' +
        '<button type="button" class="link-btn" id="cs-retry">点此重试</button>';
      $('cs-retry').addEventListener('click', function () { saveReportToCloud(report, data); });
    });
  }

  /* ---------- 历史记录 ---------- */
  $('btn-history').addEventListener('click', openHistory);
  $('history-close').addEventListener('click', function () { historyModal.hidden = true; });
  historyModal.addEventListener('click', function (e) {
    if (e.target === historyModal) historyModal.hidden = true;
  });

  function openHistory() {
    if (!EssayAuth.user()) { openAuth('login'); return; }
    historyModal.hidden = false;
    historyListEl.innerHTML = '<p class="history-loading">正在加载历史报告……</p>';
    EssayAuth.listEssays().then(renderHistory).catch(function (err) {
      historyListEl.innerHTML = '<p class="history-empty">加载失败：' +
        escapeHtml(err.message || '网络异常') + '</p>';
    });
  }
  function fmtTime(ts) {
    var d = new Date(ts * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function renderHistory(items) {
    if (!items.length) {
      historyListEl.innerHTML =
        '<p class="history-empty">还没有批改历史。<br>完成的每次批改都会自动保存在这里。</p>';
      return;
    }
    historyListEl.innerHTML = items.map(function (it) {
      var b = EssayAI.bandFromScore(it.score || 0);
      var title = escapeHtml(it.title || '未命名作文');
      var band = escapeHtml(it.band_label || b.label) +
        (it.band_sub ? ' · ' + escapeHtml(it.band_sub) : '');
      return '<div class="h-item" data-id="' + it.id + '">' +
        '<div class="h-score" style="color:' + b.color + ';border-color:' + b.color + '">' +
          (it.score == null ? '—' : it.score) + '</div>' +
        '<div class="h-main">' +
          '<div class="h-title-line">' + title +
            '<span class="h-band" style="color:' + b.color + '">' + band + '</span></div>' +
          (it.summary ? '<p class="h-summary">' + escapeHtml(it.summary) + '</p>' : '') +
        '</div>' +
        '<div class="h-side"><span class="h-date">' + fmtTime(it.created_at) + '</span>' +
          '<button type="button" class="h-del" data-del="' + it.id + '">删除</button></div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(historyListEl.querySelectorAll('.h-del'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-del');
        if (!window.confirm('确定删除这条批改记录吗？删除后无法恢复。')) return;
        EssayAuth.deleteEssay(id).then(function () {
          toast('已删除');
          return EssayAuth.listEssays();
        }).then(renderHistory).catch(function (err) {
          toast('删除失败：' + (err.message || ''), 'err');
        });
      });
    });
    Array.prototype.forEach.call(historyListEl.querySelectorAll('.h-item'), function (row) {
      row.addEventListener('click', function () { openEssay(row.getAttribute('data-id')); });
    });
  }
  function openEssay(id) {
    historyListEl.innerHTML = '<p class="history-loading">正在打开报告……</p>';
    EssayAuth.getEssay(id).then(function (it) {
      var d = it.report || {};
      // 同步写作输入区：保证“修改后重新批改”基于这篇作文
      promptEl.value = it.prompt || '';
      titleEl.value = it.title || '';
      typeEl.value = d.type || '议论文';
      targetEl.value = '800';
      textEl.value = it.essay_text || '';
      if (examSel.value && examSel.value !== promptEl.value) examSel.value = '';
      updateCount();
      lastSubmit = {
        text: it.essay_text || '',
        opts: { title: it.title || '', type: typeEl.value, target: 800, prompt: it.prompt || '' }
      };
      d.model = it.model || d.model;
      renderReport(d, it.essay_text || '');
      resetCloudNote();
      cloudNoteEl.hidden = false;
      cloudNoteEl.className = 'cloud-save-note';
      cloudNoteEl.textContent = '📂 正在查看云端历史报告（' + fmtTime(it.created_at) + '）';
      historyModal.hidden = true;
      showStep(3, true);
    }).catch(function (err) {
      historyListEl.innerHTML = '<p class="history-empty">打开失败：' +
        escapeHtml(err.message || '记录不存在') + '</p>';
    });
  }

  /* ---------- 初始化 ---------- */
  EssayAuth.onChange(function () {
    renderUserArea();
    // 同步登录态缓存，供下次刷新时先即时显示
    var u = EssayAuth.user();
    if (u) storeSet(LS_USER, { user: u, quota: EssayAuth.quota() });
    else storeDel(LS_USER);
  });
  // 刷新后先用本地缓存即时显示已登录；refreshMe 再与服务端核对，会话过期则改回未登录
  var cachedUser = storeGet(LS_USER);
  if (cachedUser && cachedUser.user) EssayAuth.hydrate(cachedUser);
  renderUserArea();
  updateCount();
  // 恢复本地表单草稿（免登录用户同样生效；云端草稿之后再做一致性核对）
  var localDraft = storeGet(LS_DRAFT);
  if (localDraft && (String(localDraft.text || '').trim() || String(localDraft.prompt || '').trim())) {
    applyDraft(localDraft);
  }
  // 刷新前停在批改报告页：原地渲染缓存的报告，绝不退回“作文还没输入”的页面
  if (bootStep === 3 && bootReport && bootReport.report) {
    try {
      lastSubmit = { text: bootReport.text || '', opts: bootReport.opts || {} };
      renderReport(bootReport.report, bootReport.text || '');
      showStep(3, false);
      resetCloudNote();
      cloudNoteEl.hidden = false;
      cloudNoteEl.className = 'cloud-save-note';
      cloudNoteEl.textContent = '↻ 已恢复刷新前的批改报告';
    } catch (e) {
      showStep(1, false);
    }
  }
  EssayAI.fetchConfig().then(function (cfg) {
    serverCfg = cfg;
  });
  EssayAuth.refreshMe().then(function (res) {
    if (res.user) restoreCloudDraft(false); // 已登录：云端草稿与本地一致则静默，不同才询问
  });
})();
