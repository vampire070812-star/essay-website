/* ============================================================
 * 高考作文批改 —— 极简本地兜底模块（上海卷 70 分制）
 *
 * 定位：AI 批改的安全网，不做任何评判。
 *   所有评语、批注、档位、维度诊断一律以 AI 通读全文的结果为准；
 *   本模块【只】保留两类“分数规则”：
 *     1. 字数硬封顶——考场硬性规定（不足字数按档封顶，含标点占格口径）；
 *     2. 成篇保底分——AI 未返回总分时，按“完整成篇≈三类中”兜底。
 *   已删除：错别字/标点/词表/成语/哲学词典/逻辑谬误正则/
 *          段落功能关键词归类/四维加减分等一切机械评分规则。
 * ============================================================ */
(function (global) {
  'use strict';

  function cjkLen(s) { return (String(s || '').match(/[一-龥]/g) || []).length; }
  // 考场占格字数：汉字与标点均占一格，空白不计（高考阅卷口径）
  function gridLen(s) { return String(s || '').replace(/\s/g, '').length; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var BANDS = [
    { name: '一类卷', color: '#059669', lo: 63, hi: 70 },
    { name: '二类卷', color: '#2563eb', lo: 52, hi: 62 },
    { name: '三类卷', color: '#d97706', lo: 39, hi: 51 },
    { name: '四类卷', color: '#ea580c', lo: 21, hi: 38 },
    { name: '五类卷', color: '#dc2626', lo: 0, hi: 20 }
  ];

  function bandOf(score) {
    var b = BANDS[4];
    for (var i = 0; i < BANDS.length; i++) if (score >= BANDS[i].lo) { b = BANDS[i]; break; }
    var span = b.hi - b.lo + 1;
    var p = score - b.lo;
    var sub = p >= span * 2 / 3 ? '上' : (p >= span / 3 ? '中' : '下');
    return { label: b.name, sub: sub, color: b.color };
  }

  // 考场字数硬性封顶（占格字数，含标点）：
  //   不足 400 字按五类卷处理；不足 500 不超四类；不足 600 不超 45；
  //   不足 680 不超三类；680-799 字由 AI 在档内按官方“每少约50字酌情下调”处理。
  function wordCap(chars) {
    if (chars < 400) return 20;
    if (chars < 500) return 38;
    if (chars < 600) return 45;
    if (chars < 680) return 51;
    return 70;
  }

  // 对 AI 总分强制执行考场字数硬封顶（AI 已被要求自行执行，这里是双保险）
  function applyWordCap(total, text) {
    return Math.max(3, Math.min(70, Math.round(total), wordCap(gridLen(text))));
  }

  /* ---------- 保底批改：仅在 AI 结果整体缺失时使用 ---------- */

  function grade(rawText, opts) {
    opts = opts || {};
    var text = String(rawText || '').replace(/\r/g, '');
    var chars = gridLen(text);
    var paragraphs = text.split(/\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
    var pn = paragraphs.length;

    // 保底总分：完整成篇≈三类中（49），只受字数封顶与成篇保底夹取
    var cap = wordCap(chars);
    var floor = 6;
    if (pn >= 3 && chars >= 600) floor = 39;          // 成篇保底：不低于三类下沿
    if (pn >= 4 && chars >= 700) floor = Math.max(floor, 44);
    var score = clamp(49, floor, cap);
    var band = bandOf(score);

    // 标题展示：正文首行像标题的短行（纯展示启发式，与评分无关）
    var titleLine = false;
    if (pn >= 2) {
      var first = paragraphs[0], cl = cjkLen(first);
      if (cl >= 2 && cl <= 16 && !/[。！？，；…!?]/.test(first)) titleLine = true;
    }
    var title = (opts.title || '').trim() || (titleLine ? paragraphs[0] : '');

    var summary = 'AI 本次未返回完整的批改结果，当前分数是系统按【考场字数规定与成篇保底规则】给出的临时分数（' +
      band.label + band.sub + '），不含任何评语与诊断。请重新点击批改获取完整 AI 报告。';

    return {
      total: score,
      band: band,
      summary: summary,
      // AI 未返回审题结论时不做机械判定
      deviation: {
        status: 'none',
        label: '审题未核查',
        detail: 'AI 本次未返回审题核查结果，请重新批改。'
      },
      dims: [],
      stats: { chars: chars, target: opts.target || 800, paragraphs: pn },
      marks: [],
      logicReview: { thesis: '', paragraphFlow: [], chain: '', fallacies: [], weakLinks: [], strengths: [] },
      rewrites: [],
      paragraphAdvice: [],
      suggestions: [],
      praises: [],
      title: title,
      type: opts.type || '议论文'
    };
  }

  /* ---------------- 批注渲染（AI marks 专用） ---------------- */

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderAnnotated(text, marks) {
    var html = '', pos = 0;
    var parts = text.split(/(\n+)/);
    parts.forEach(function (part) {
      if (/^\n+$/.test(part)) {
        html += '<span class="p-break"></span>';
        pos += part.length;
        return;
      }
      var local = [];
      marks.forEach(function (mk) {
        if (mk.s >= pos && mk.e <= pos + part.length) {
          local.push({ s: mk.s - pos, e: mk.e - pos, cls: mk.cls, label: mk.label });
        }
      });
      var c = 0;
      local.forEach(function (mk) {
        html += escapeHtml(part.slice(c, mk.s));
        html += '<span class="mk ' + mk.cls + '" title="' + escapeHtml(mk.label) + '">' +
          escapeHtml(part.slice(mk.s, mk.e)) + '</span>';
        c = mk.e;
      });
      html += escapeHtml(part.slice(c));
      pos += part.length;
    });
    return html;
  }

  global.EssayEngine = {
    grade: grade,
    renderAnnotated: renderAnnotated,
    applyWordCap: applyWordCap,
    wordCap: wordCap,
    gridLen: gridLen,
    cjkLen: cjkLen
  };
})(window);
