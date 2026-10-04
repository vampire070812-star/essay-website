/* ============================================================
 * AI 大模型客户端（上海高考思辨议论文 · 70 分五类档）
 *  - /api/grade   调用 OpenAI 兼容大模型批改作文
 *  - /api/analyze 调用大模型做作文题目审题指导（无 Key 时后端自动本地兜底）
 *  - 模型返回的“原文片段批注”定位为字符坐标，复用报告渲染
 *  - 设置保存在 localStorage；批改失败时由 app.js 回退本地规则引擎
 * ============================================================ */
(function (global) {
  'use strict';

  var SETTINGS_KEY = 'essay_ai_settings_v1';
  var MODE_KEY = 'essay_grade_mode_v1';
  var REQUEST_TIMEOUT = 160000; // 160s，略大于后端的 150s

  // 与 server.py 中一致的服务商预设
  var PROVIDERS = {
    deepseek: { label: 'DeepSeek 深度求索', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' },
    zhipu: { label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    qwen: { label: '通义千问（阿里）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    moonshot: { label: 'Moonshot Kimi', base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    openai: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { label: '自定义（OpenAI 兼容）', base_url: '', model: '' }
  };

  // 2025 上海高三一模真题（可作为审题练习题）
  var EXAM_PROMPTS = [
    { district: '2025 黄浦一模', text: '生活中，许多人选择“断舍离”，以更好地认清自己内心的真实所求。请写一篇文章，谈谈你对“断舍离”的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 松江一模', text: '有人说，分歧比共识更有意义。对此，你是否认同？请写一篇文章，谈谈你的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 奉贤一模', text: '社会上，不少人对附庸风雅嗤之以鼻，却也有很多人在行附庸风雅之事。请写一篇文章，谈谈你对“附庸风雅”的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 徐汇一模', text: '我们更应突破自身的局限性，还是接受自身的局限性？请写一篇文章，谈谈你对此的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 杨浦一模', text: '在现代社会，高清纪录片可呈现热带雨林的繁茂、极地冰川的壮丽，虚拟现实设备能模拟漫步山间、泛舟湖海的惬意，打开手机就能欣赏美景直播……然而，仍有许多人执着于亲身奔赴自然。请写一篇文章，谈谈你对这种现象的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 长宁一模', text: '激情对于行动，是利大于弊吗？请联系生活实际，写一篇文章，谈谈你的认识与思考。' },
    { district: '2025 静安一模', text: '低头划手机干扰了现场感知及人际关系，但有人认为，低头划手机主要是在寻找让自己有归属感的地方。请自拟题目，写一篇不少于 800 字的文章，谈谈你对这个问题的认识和思考。' },
    { district: '2025 普陀一模', text: '生活中，许多人乐于追求一种由他人设计的“沉浸式”体验，以获得真实的愉悦和满足。比如沉浸式阅读、沉浸式观展、沉浸式用餐、沉浸式旅行等。请写一篇文章，谈谈你对这种现象的认识和思考。' },
    { district: '2025 闵行一模', text: '大明感叹道：“我听过许多道理，但还是过不好自己的生活。”请你写一篇文章，对大明说说你的感受与认识。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 浦东一模', text: '一个人履行责任是否意味着放弃自由？请写一篇文章，谈谈你对这个问题的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 虹口一模', text: '人们常说细节决定成败，可也有人认为，不受细节影响的钝感才是生活中最宝贵的才能。对此你怎么看？请写一篇文章，谈谈你的思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 宝山一模', text: '身处信息化时代，人们可以轻而易举获取大量信息。那么，获取更多的信息是否使人变得更聪明？请写一篇文章，谈谈你对这个问题的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 嘉定一模', text: '生活中，人们往往用“有用”作为判别事物并做出选择的重要标准。请写一篇文章，谈谈你对此的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 金山一模', text: '生活中，人们往往用常识去看待事物，做出判断。对此，你怎么看？请写一篇文章，谈谈你对这个问题的认识与思考。要求：（1）自拟题目；（2）不少于 800 字。' },
    { district: '2025 青浦一模', text: '生活中有很多我们无法控制的事，这是否意味着我们只需要关心自己能控制的事？请写一篇文章，谈谈你的认识和思考。要求：（1）题目自拟；（2）不少于 800 字。' },
    { district: '2025 崇明一模', text: '有人认为，我们应当保障他人的知情权，让真相被看见；也有人认为，有些时候保持善意的沉默、尊重他人的“不知情权”，同样是一种关怀。请写一篇文章，谈谈你对“知情权与不知情权”的认识和思考。要求：（1）自拟题目；（2）不少于 800 字。' }
  ];

  // 诊断维度（0-100 水平分，仅展示，不相加）
  var DIM_META = [
    { key: 'content', name: '审题立意', max: 100, tip: '题意把握、概念界定与思辨深度' },
    { key: 'struct', name: '论证层次', max: 100, tip: '层进结构、让步转折与详略安排' },
    { key: 'evidence', name: '论据分析', max: 100, tip: '论据典型性与例后分析的咬合度' },
    { key: 'lang', name: '语言表达', max: 100, tip: '通顺规范、论辩气势与文采' }
  ];

  var BANDS = [
    { name: '一类卷', lo: 63, hi: 70, color: '#059669' },
    { name: '二类卷', lo: 52, hi: 62, color: '#2563eb' },
    { name: '三类卷', lo: 39, hi: 51, color: '#d97706' },
    { name: '四类卷', lo: 21, hi: 38, color: '#ea580c' },
    { name: '五类卷', lo: 0, hi: 20, color: '#dc2626' }
  ];

  function bandFromScore(score) {
    for (var i = 0; i < BANDS.length; i++) {
      if (score >= BANDS[i].lo) {
        var b = BANDS[i], span = b.hi - b.lo + 1, p = score - b.lo;
        var sub = p >= span * 2 / 3 ? '上' : (p >= span / 3 ? '中' : '下');
        return { label: b.name, sub: sub, color: b.color };
      }
    }
    return { label: '五类卷', sub: '下', color: BANDS[4].color };
  }

  function levelOf(pct) {
    if (pct >= 85) return '强';
    if (pct >= 70) return '较强';
    if (pct >= 55) return '中';
    if (pct >= 40) return '较弱';
    return '弱';
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
  function getMode() { return localStorage.getItem(MODE_KEY) === 'local' ? 'local' : 'ai'; }
  function setMode(m) { localStorage.setItem(MODE_KEY, m); }

  /* ---------- 服务端配置探测 ---------- */
  var configCache = null;
  function fetchConfig() {
    if (configCache) return Promise.resolve(configCache);
    return fetch('/api/config', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (cfg) {
        if (cfg && cfg.providers) configCache = cfg;
        return configCache;
      })
      .catch(function () {
        configCache = { configured: false, providers: PROVIDERS,
          base_url: PROVIDERS.deepseek.base_url, model: PROVIDERS.deepseek.model };
        return configCache;
      });
  }

  function settingsBody(settings) {
    return {
      apiKey: (settings && settings.apiKey) || '',
      baseUrl: (settings && settings.baseUrl) || '',
      model: (settings && settings.model) || ''
    };
  }

  function postJSON(url, body, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (resp) {
      return resp.json().catch(function () { return null; }).then(function (data) {
        clearTimeout(timer);
        if (resp.ok && data && data.ok) return data;
        var err = new Error((data && data.message) || '服务异常（HTTP ' + resp.status + '）');
        err.code = (data && data.code) || ('http_' + resp.status);
        throw err;
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        e = new Error('请求超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒），可能是网络较慢或当前模型繁忙');
        e.code = 'timeout';
      }
      throw e;
    });
  }

  /* ---------- AI 批改 ---------- */
  function grade(text, opts, settings) {
    var body = {
      title: opts.title || '',
      type: opts.type || '议论文',
      target: opts.target || 800,
      prompt: opts.prompt || '',
      text: text,
      settings: settingsBody(settings)
    };
    return postJSON('/api/grade', body, REQUEST_TIMEOUT);
  }

  /* ---------- AI 审题 ---------- */
  function analyze(prompt, settings) {
    var body = { prompt: prompt, settings: settingsBody(settings) };
    return postJSON('/api/analyze', body, REQUEST_TIMEOUT);
  }

  /* ---------- 原文片段定位 ---------- */
  function resolveMarks(text, aiMarks) {
    var typePrio = { error: 0, logic: 1, warn: 2, good: 3 };
    var list = (aiMarks || []).filter(function (m) {
      return m && typeof m.excerpt === 'string' && m.excerpt.length >= 2 &&
        ['error', 'warn', 'logic', 'good'].indexOf(m.type) >= 0;
    }).map(function (m) {
      return {
        type: m.type,
        excerpt: m.excerpt.replace(/\s+/g, ''),
        comment: String(m.comment || '').slice(0, 80),
        prio: typePrio[m.type]
      };
    }).filter(function (m) { return m.excerpt.length <= 40; });

    list.sort(function (a, b) { return a.prio - b.prio || b.excerpt.length - a.excerpt.length; });

    var taken = [];
    function overlaps(s, e) {
      return taken.some(function (r) { return s < r.e && e > r.s; });
    }
    var out = [];
    list.forEach(function (m) {
      var idx = text.indexOf(m.excerpt);
      while (idx >= 0) {
        if (!overlaps(idx, idx + m.excerpt.length)) {
          taken.push({ s: idx, e: idx + m.excerpt.length });
          out.push({ s: idx, e: idx + m.excerpt.length, cls: 'mk-' + m.type, label: m.comment, prio: m.prio });
          return;
        }
        idx = text.indexOf(m.excerpt, idx + 1);
      }
    });

    out.sort(function (a, b) { return a.s - b.s || a.prio - b.prio; });
    var finalMarks = [], cursor = -1;
    out.forEach(function (mk) {
      if (mk.s < cursor) return;
      finalMarks.push(mk);
      cursor = mk.e;
    });
    return finalMarks;
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  // 校验/修复 AI 给出的引文：必须能在原文中定位；
  // 若整体匹配失败（多为边界多带/少带了字），尝试在两端各裁掉 1-4 字找回最长真实片段
  function locateExcerpt(excerpt, raw) {
    var ex = String(excerpt || '').trim();
    if (!ex || !raw) return '';
    if (raw.indexOf(ex) >= 0) return ex;
    var best = '';
    for (var l = 0; l <= 4; l++) {
      for (var t = 0; t <= 4; t++) {
        if (l + t === 0) continue;
        var core = ex.slice(l, ex.length - t);
        if (core.length >= 8 && raw.indexOf(core) >= 0 && core.length > best.length) best = core;
      }
    }
    return best;
  }

  // 清单去重：按 keyFn 判重（解释文字模板化复用时只保留引文更长的一条）
  function dedupe(list, keyFn) {
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var key = keyFn(item).replace(/\s/g, '');
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(item);
    });
    return out;
  }

  /* ---------- 归一化为本地报告结构（70 分制） ---------- */
  function adapt(ai, rawText, opts) {
    // 统计数据复用本地引擎
    var local = EssayEngine.grade(rawText, opts);
    var stats = local.stats;

    // 总分：以 AI 直出的 70 分制总分为准（上海整体赋分，四维不加总）
    var total = Math.round(num(ai.total, -1));
    if (total < 0) {
      // 模型未给总分时用档位反推
      var byName = {};
      BANDS.forEach(function (b) { byName[b.name] = b; });
      var fb = byName[String(ai.bandClass || '').replace('卷', '') + '卷'];
      total = fb ? Math.round((fb.lo + fb.hi) / 2) : 49;
    }
    total = Math.max(3, Math.min(70, total));

    var band;
    var className = String(ai.bandClass || '');
    if (/^[一二三四五]类卷?$/.test(className)) {
      var name = className.length === 3 ? className : className + '卷';
      var hit = null;
      BANDS.forEach(function (b) { if (b.name === name) hit = b; });
      if (hit) {
        var sub = ['上', '中', '下'].indexOf(ai.bandLevel) >= 0 ? ai.bandLevel : bandFromScore(total).sub;
        band = { label: hit.name, sub: sub, color: hit.color };
      }
    }
    if (!band) band = bandFromScore(total);
    // 分数与档位冲突时以分数区间为准（防止模型自相矛盾）
    var scoreBand = bandFromScore(total);
    if (scoreBand.label !== band.label) band = scoreBand;

    // 诊断四维：逐维独立档位（几类卷·上/中/下）+ 详细点评
    var aiDims = Array.isArray(ai.dims) ? ai.dims : [];
    var dims = DIM_META.map(function (meta, i) {
      var hitDim = aiDims[i];
      for (var j = 0; j < aiDims.length; j++) {
        var nm = String(aiDims[j].name || '');
        if ((meta.key === 'content' && /审题|立意/.test(nm)) ||
            (meta.key === 'struct' && /论证|结构|层次|条理/.test(nm)) ||
            (meta.key === 'evidence' && /论据|素材|分析/.test(nm)) ||
            (meta.key === 'lang' && /语言|表达|语句|文采/.test(nm))) { hitDim = aiDims[j]; break; }
      }
      // 档位：优先用 AI 给的 band/sub；兼容旧版数字 score（换算成档位）；都没有则跟随总分档位
      var bandInfo = null;
      if (hitDim && hitDim.band) {
        var bName = String(hitDim.band).replace(/\s/g, '');
        var found = null;
        for (var k = 0; k < BANDS.length; k++) {
          // 兼容“一类卷”全称与“一类”简写
          if (bName.indexOf(BANDS[k].name) >= 0 || bName.indexOf(BANDS[k].name.slice(0, 2)) === 0) { found = BANDS[k]; break; }
        }
        if (found) {
          var sub = /^(上|中|下)$/.test(String(hitDim.sub || '')) ? hitDim.sub : '中';
          bandInfo = { label: found.name, sub: sub, color: found.color };
        }
      }
      if (!bandInfo && hitDim && typeof hitDim.score !== 'undefined' && hitDim.score !== null && hitDim.score !== '') {
        // 旧格式兼容：0-100 诊断分按 70 分制比例换算成档位
        var scaled = Math.round(num(hitDim.score, 60) / 100 * 70);
        var b0 = bandFromScore(Math.max(0, Math.min(70, scaled)));
        bandInfo = { label: b0.label, sub: b0.sub, color: b0.color };
      }
      if (!bandInfo) bandInfo = { label: band.label, sub: band.sub, color: band.color };
      var comment = hitDim && hitDim.comment ? String(hitDim.comment) : meta.tip;
      return { key: meta.key, name: meta.name, band: bandInfo.label, sub: bandInfo.sub, color: bandInfo.color, tip: comment };
    });

    var sugs = (Array.isArray(ai.suggestions) ? ai.suggestions : []).slice(0, 10)
      .filter(function (s) { return s && s.title; })
      .map(function (s) {
        var level = ['error', 'warn', 'tip'].indexOf(s.level) >= 0 ? s.level : 'tip';
        return { level: level, title: String(s.title).slice(0, 40),
          detail: String(s.detail || '').slice(0, 400) };
      });

    var praises = (Array.isArray(ai.praises) ? ai.praises : []).slice(0, 6)
      .map(function (p) { return String(p).slice(0, 140); })
      .filter(Boolean);

    var marks = resolveMarks(rawText, ai.marks);

    // —— 文章逻辑评判（AI 为主，缺字段时用本地补齐）——
    var lr = ai.logicReview && typeof ai.logicReview === 'object' ? ai.logicReview : {};
    var aiFlow = Array.isArray(lr.paragraphFlow) ? lr.paragraphFlow : [];
    var logicReview = {
      thesis: String(lr.thesis || local.logicReview.thesis).slice(0, 200),
      paragraphFlow: aiFlow.length ? aiFlow.slice(0, 12).map(function (p, i) {
        return {
          para: parseInt(p.para, 10) || (i + 1),
          role: String(p.role || '分论点论证').slice(0, 12),
          gist: String(p.gist || '').slice(0, 80),
          methods: Array.isArray(p.methods) ? p.methods.map(function (m) { return String(m).slice(0, 10); }).slice(0, 4) : [],
          structure: String(p.structure || '').slice(0, 160)
        };
      }) : local.logicReview.paragraphFlow,
      chain: String(lr.chain || local.logicReview.chain).slice(0, 600),
      fallacies: (function () {
        var raw = (Array.isArray(lr.fallacies) ? lr.fallacies : []).map(function (f) {
          var ex = locateExcerpt(f.excerpt, rawText);
          return {
            name: String(f.name || '逻辑问题').slice(0, 20),
            excerpt: ex,
            why: String(f.why || '').trim().slice(0, 280)
          };
        }).filter(function (f) { return f.why && f.excerpt; });
        // why 雷同（模板复用）只保留一条；同名且引文互相包含只保留更长的一条
        var byWhy = dedupe(raw, function (f) { return f.why; });
        var out = [];
        byWhy.forEach(function (f) {
          var dup = out.some(function (o) {
            return o.name === f.name && (o.excerpt.indexOf(f.excerpt) >= 0 || f.excerpt.indexOf(o.excerpt) >= 0);
          });
          if (!dup) out.push(f);
        });
        return out.slice(0, 3); // 硬伤 0-3 个
      })(),
      weakLinks: (function () {
        var raw2 = (Array.isArray(lr.weakLinks) ? lr.weakLinks : []).map(function (w) {
          return {
            type: String(w.type || '可加强处').slice(0, 14),
            excerpt: locateExcerpt(w.excerpt, rawText),
            point: String(w.point || '').trim().slice(0, 220),
            upgrade: String(w.upgrade || '').trim().slice(0, 280)
          };
        }).filter(function (w) { return (w.point || w.upgrade) && w.excerpt; });
        return dedupe(raw2, function (w) { return w.point + w.upgrade; }).slice(0, 6);
      })(),
      strengths: (Array.isArray(lr.strengths) && lr.strengths.length ? lr.strengths : local.logicReview.strengths)
        .map(function (s) { return String(s).slice(0, 160); }).filter(Boolean).slice(0, 4)
    };
    // AI 明确给出 fallacies（即使为空数组）就以 AI 为准；只有字段缺失才用本地兜底
    if (!Array.isArray(lr.fallacies) && !logicReview.fallacies.length) logicReview.fallacies = local.logicReview.fallacies;

    // —— 逐句改写示范 ——
    var rewrites = (Array.isArray(ai.rewrites) ? ai.rewrites : []).slice(0, 8).map(function (r) {
      return {
        original: String(r.original || '').slice(0, 200),
        issue: String(r.issue || '').slice(0, 200),
        revised: String(r.revised || '').slice(0, 300),
        why: String(r.why || '').slice(0, 200)
      };
    }).filter(function (r) { return r.original && r.revised; });
    if (!rewrites.length) rewrites = local.rewrites;

    // —— 逐段修改建议 ——
    var paragraphAdvice = (Array.isArray(ai.paragraphAdvice) ? ai.paragraphAdvice : []).slice(0, 8)
      .map(function (p) {
        return { para: parseInt(p.para, 10) || 0, advice: String(p.advice || '').slice(0, 300) };
      }).filter(function (p) { return p.advice; });
    if (!paragraphAdvice.length) paragraphAdvice = local.paragraphAdvice;

    // 审题契合度：AI 优先返回结构化 {level, detail}，兼容旧版字符串
    var deviation;
    var devRaw = ai.deviation;
    var devObj = devRaw && typeof devRaw === 'object' ? devRaw : null;
    var dTxt = String((devObj && devObj.detail) || (typeof devRaw === 'string' ? devRaw : '') || '').trim().slice(0, 500);

    if (dTxt || (devObj && devObj.level)) {
      var dStatus;
      if (devObj && /^(fit|warn|risk)$/.test(String(devObj.level))) {
        // 结构化判定直接采用
        dStatus = devObj.level === 'fit' ? 'ok' : (devObj.level === 'risk' ? 'bad' : 'warn');
      } else {
        // 兼容字符串：先抹掉否定语境（未/没有/无/并非/不构成/未发现 + 风险词），避免“未偷换概念”被误判
        var negated = dTxt
          .replace(/(?:未|没有|并无|无|并非|并不|不构成|不存在|未发现|未见|算不上|谈不上|不属(?:于)?|并非是)[^，。；,;]{0,8}(?:偏题|跑题|偷换|套题|脱离|窄化|游离|另起炉灶)/g, '');
        dStatus = /偏题|跑题|偷换|套题|脱离/.test(negated) ? 'bad'
          : (/明扣暗离|瑕疵|片面|未回应|忽略|没有回应/.test(negated) ? 'warn' : 'ok');
      }
      var dLabel = dStatus === 'bad' ? 'AI 判断：有偏题风险' : dStatus === 'warn' ? 'AI 判断：审题有瑕疵' : 'AI 判断：审题契合';
      deviation = { status: dStatus, label: dLabel, detail: dTxt };
    } else {
      deviation = local.deviation;
    }

    return {
      total: total,
      band: band,
      summary: String(ai.summary || '本次批改由 AI 大模型按上海卷五类档标准完成，请结合批注与建议修改作文。').slice(0, 500),
      deviation: deviation,
      dims: dims, stats: stats, marks: marks,
      logicReview: logicReview,
      rewrites: rewrites,
      paragraphAdvice: paragraphAdvice,
      suggestions: sugs, praises: praises,
      title: opts.title || local.title || '', type: opts.type,
      engine: 'ai'
    };
  }

  global.EssayAI = {
    grade: grade,
    analyze: analyze,
    adapt: adapt,
    fetchConfig: fetchConfig,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getMode: getMode,
    setMode: setMode,
    bandFromScore: bandFromScore,
    levelOf: levelOf,
    DIM_META: DIM_META,
    EXAM_PROMPTS: EXAM_PROMPTS,
    PROVIDERS: PROVIDERS
  };
})(window);
