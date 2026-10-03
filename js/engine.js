/* ============================================================
 * 高考思辨议论文本地批改引擎（纯本地规则，无需联网）
 * 定位：上海高考语文作文 —— 满分 70 分，五类卷整体赋分，不少于 800 字
 *
 * 评分思想（依据 2025 上海多区一模阅卷细则提炼）：
 *   先定档再定位；否决项只“封顶”不“打死”；立意基本契合且结构完整保底三类下沿
 * 四个输出维度为【诊断分（0-100）】，仅展示强弱项，不参与总分加总
 * ============================================================ */
(function (global) {
  'use strict';

  function cjkLen(s) { return (s.match(/[一-龥]/g) || []).length; }
  function uniq(a) {
    var seen = {}, out = [];
    for (var i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]); }
    return out;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function countRe(text, re) { var n = 0; while (re.exec(text)) n++; return n; }

  /* ---------------- 词库 ---------------- */

  var IDIOM_LIST = (
    "一心一意 一诺千金 一鸣惊人 一往无前 一言为定 一丝不苟 五彩缤纷 五颜六色 五光十色 五花八门 " +
    "六神无主 七上八下 七嘴八舌 八仙过海 四面八方 四面楚歌 三心二意 三长两短 千方百计 千军万马 " +
    "千言万语 千变万化 万紫千红 万众一心 万象更新 锦上添花 画龙点睛 画蛇添足 守株待兔 亡羊补牢 " +
    "掩耳盗铃 拔苗助长 刻舟求剑 买椟还珠 滥竽充数 井底之蛙 狐假虎威 对牛弹琴 愚公移山 精卫填海 " +
    "夸父追日 卧薪尝胆 破釜沉舟 草木皆兵 风声鹤唳 完璧归赵 负荆请罪 纸上谈兵 指鹿为马 背水一战 " +
    "望梅止渴 闻鸡起舞 凿壁偷光 悬梁刺股 囊萤映雪 程门立雪 手不释卷 孜孜不倦 锲而不舍 坚持不懈 " +
    "持之以恒 水滴石穿 绳锯木断 聚沙成塔 积少成多 厚积薄发 循序渐进 废寝忘食 夜以继日 通宵达旦 " +
    "精益求精 尽心尽力 竭尽全力 全力以赴 不遗余力 迎难而上 勇往直前 披荆斩棘 乘风破浪 春暖花开 " +
    "鸟语花香 草长莺飞 春意盎然 春色满园 百花齐放 百花争艳 郁郁葱葱 绿树成荫 骄阳似火 烈日炎炎 " +
    "秋高气爽 一叶知秋 金风送爽 天高云淡 冰天雪地 天寒地冻 银装素裹 鹅毛大雪 山清水秀 青山绿水 " +
    "湖光山色 重峦叠嶂 崇山峻岭 水平如镜 波涛汹涌 波澜壮阔 惊涛骇浪 风平浪静 风和日丽 风雨同舟 " +
    "和风细雨 暴风骤雨 倾盆大雨 情不自禁 迫不及待 不约而同 不假思索 不由自主 小心翼翼 忐忑不安 " +
    "心惊肉跳 胆战心惊 惊心动魄 惊慌失措 镇定自若 若无其事 从容不迫 欣喜若狂 喜出望外 喜上眉梢 " +
    "眉开眼笑 笑逐颜开 捧腹大笑 闷闷不乐 愁眉苦脸 垂头丧气 灰心丧气 心灰意冷 聚精会神 全神贯注 " +
    "专心致志 目不转睛 恍然大悟 豁然开朗 茅塞顿开 理直气壮 振振有词 滔滔不绝 口若悬河 妙语连珠 " +
    "出口成章 对答如流 娓娓道来 侃侃而谈 默默无闻 无私奉献 任劳任怨 含辛茹苦 无微不至 体贴入微 " +
    "嘘寒问暖 兴高采烈 兴致勃勃 津津有味 意犹未尽 回味无穷 人山人海 摩肩接踵 门庭若市 水泄不通 " +
    "车水马龙 络绎不绝 川流不息 人头攒动 井然有序 有条不紊 井井有条 举手之劳 力所能及 微不足道 " +
    "举世闻名 闻名遐迩 名扬中外 赫赫有名 大名鼎鼎 家喻户晓 妇孺皆知 名副其实 当之无愧 实至名归 " +
    "日新月异 瞬息万变 变化多端 惊天动地 地动山摇 排山倒海 雷霆万钧 鸦雀无声 悄无声息 万籁俱寂 " +
    "欢声笑语 载歌载舞 琳琅满目 美不胜收 应有尽有 各种各样 形形色色 心旷神怡 赏心悦目 神清气爽 " +
    "念念不忘 依依不舍 恋恋不舍 流连忘返 刻骨铭心 历历在目 记忆犹新 受益匪浅 满载而归 迎刃而解 " +
    "水到渠成 顺理成章 自然而然 以身作则 言传身教 身体力行 因材施教 谆谆教诲 诲人不倦 情真意切 " +
    "感人肺腑 动人心弦 催人泪下 发人深省 耐人寻味 意味深长 深入浅出 言之有物 旁征博引 引经据典 " +
    "融会贯通 开门见山 妙笔生花 文采飞扬 行云流水 一气呵成 跌宕起伏 引人入胜 扣人心弦 首尾呼应 " +
    "承上启下 层层递进 环环相扣 条理清晰 层次分明 逻辑严密 论证有力 以理服人 寸草春晖 舐犊之情 " +
    "血浓于水 同甘共苦 同舟共济 朝夕相处 形影不离 亲密无间 情同手足 言而有信 诚实守信 知错就改 " +
    "迷途知返 日积月累 勤能补拙 笨鸟先飞 奋发图强 志存高远 胸怀大志 雄心壮志 壮志凌云 任重道远 " +
    "责无旁贷 义不容辞 舍己为人 大公无私 光明磊落 光明正大 堂堂正正 刚正不阿 铁面无私 宽宏大量 " +
    "严于律己 宽以待人 谦虚谨慎 不耻下问 戒骄戒躁 表里如一 言行一致 艰苦朴素 勤俭节约 省吃俭用 " +
    "克勤克俭 吃苦耐劳 朝气蓬勃 风华正茂 意气风发 斗志昂扬 生龙活虎 生机勃勃 生机盎然 万物复苏 " +
    "月明星稀 皓月当空 霞光万道 光芒万丈 光彩夺目 绚丽多彩 五彩斑斓 金碧辉煌 富丽堂皇 雕梁画栋 " +
    "古色古香 小巧玲珑 玲珑剔透 精雕细琢 巧夺天工 鬼斧神工 浑然一体 浑然天成 天衣无缝 十全十美 " +
    "尽善尽美 无懈可击 栩栩如生 惟妙惟肖 活灵活现 跃然纸上 入木三分 力透纸背 龙飞凤舞 笔走龙蛇 " +
    "各有千秋 别具一格 独树一帜 独具匠心 匠心独运 别出心裁 标新立异 与众不同 司空见惯 屡见不鲜 " +
    "习以为常 一目了然 一清二楚 举不胜举 数不胜数 不计其数 寥寥无几 屈指可数 凤毛麟角 大同小异 " +
    "一模一样 截然不同 天壤之别 大相径庭 举足轻重 至关重要 不可或缺 必不可少 立竿见影 行之有效 " +
    "卓有成效 事半功倍 事倍功半 一举两得 一箭双雕 两全其美 面面俱到 一应俱全 顾此失彼 捉襟见肘 " +
    "进退两难 左右为难 骑虎难下 一筹莫展 束手无策 无计可施 无可奈何 得心应手 轻车熟路 游刃有余 " +
    "驾轻就熟 易如反掌 唾手可得 信手拈来 披星戴月 跋山涉水 风餐露宿 栉风沐雨 风尘仆仆 走马观花 " +
    "浅尝辄止 囫囵吞枣 不求甚解 浮光掠影 字斟句酌 咬文嚼字 滚瓜烂熟 倒背如流 通俗易懂 雅俗共赏 " +
    "喜闻乐见 脍炙人口 短小精悍 震耳欲聋 响彻云霄 如雷贯耳 余音绕梁 娓娓动听 珠圆玉润 字正腔圆 " +
    "翩翩起舞 轻歌曼舞 婀娜多姿 眼疾手快 健步如飞 大步流星 东张西望 左顾右盼 瞻前顾后 脱口而出 " +
    "信口开河 胡言乱语 理屈词穷 张口结舌 哑口无言 手忙脚乱 七手八脚 手足无措 杂乱无章 乱七八糟 " +
    "饮水思源 知恩图报 感恩戴德 感激涕零 感激不尽 羞愧难当 面红耳赤 自告奋勇 挺身而出 见义勇为 " +
    "怨天尤人 自暴自弃 好高骛远 眼高手低 半途而废 虎头蛇尾 有始无终 敷衍了事 漫不经心 心不在焉 " +
    "粗心大意 粗枝大叶 丢三落四 脚踏实地 兢兢业业 勤勤恳恳 言不由衷 口是心非 阳奉阴违 虚情假意 " +
    "患难与共 相濡以沫 守望相助 众志成城 齐心协力 同心协力 和衷共济 慷慨解囊 乐善好施 助人为乐 " +
    "拾金不昧 尊老爱幼 扶老携幼 尊师重道 教学相长 春风化雨 润物无声 循循善诱 金玉良言 良药苦口 " +
    "忠言逆耳 至理名言 振聋发聩 一针见血 一语中的 切中要害 对症下药 因地制宜 因势利导 随机应变 " +
    "审时度势 举一反三 触类旁通 温故知新 学以致用 知行合一 未雨绸缪 防患未然 防微杜渐 有备无患 " +
    "居安思危 光阴似箭 日月如梭 白驹过隙 岁月如流 时光荏苒 斗转星移 沧海桑田 物是人非 触景生情 " +
    "睹物思人 纷至沓来 接踵而至 千姿百态 五湖四海 天南海北 天涯海角 一望无际 一马平川 无边无际 " +
    "漫无边际 地大物博 物华天宝 人杰地灵 钟灵毓秀 世外桃源 星罗棋布 鳞次栉比 美轮美奂 别有洞天 " +
    "举世无双 独一无二 绝无仅有 前所未有 史无前例 微乎其微 不足挂齿 " +
    // 议论文高频成语
    "以偏概全 一叶障目 因噎废食 削足适履 本末倒置 舍本逐末 喧宾夺主 随波逐流 人云亦云 亦步亦趋 " +
    "墨守成规 固步自封 抱残守缺 刻舟求剑 削足适履 盲目从众 鹦鹉学舌 东施效颦 邯郸学步 井底之蛙 " +
    "坐井观天 管窥蠡测 盲人摸象 兼听则明 偏信则暗 博采众长 集思广益 海纳百川 有容乃大 厚德载物 " +
    "格物致知 笃行不怠 守正创新 推陈出新 革故鼎新 吐故纳新 相得益彰 相反相成 物极必反 否极泰来 " +
    "祸福相依 塞翁失马 焉知非福 过犹不及 适可而止 张弛有度 劳逸结合 高瞻远瞩 洞若观火 明察秋毫 " +
    "见微知著 一叶知秋 饮水思源 慎终如始 居安思危 未雨绸缪 实事求是 求真务实 脚踏实地 厚积薄发"
  ).split(/\s+/);
  var IDIOMS = uniq(IDIOM_LIST);

  var LITERARY = (
    "静谧 安谧 璀璨 绚烂 斑斓 皎洁 缥缈 朦胧 旖旎 逶迤 磅礴 巍峨 潺潺 涓涓 苍茫 苍穹 阡陌 " +
    "徜徉 徘徊 彷徨 伫立 驻足 凝望 凝视 眺望 遥望 俯瞰 聆听 谛听 倾诉 呢喃 沉吟 慨叹 怅惘 " +
    "惆怅 落寞 寂寥 孤寂 焦灼 忐忑 踌躇 蓦地 蓦然 倏地 须臾 韶华 芳华 荏苒 峥嵘 沧桑 沉淀 " +
    "积淀 镌刻 铭刻 浸润 滋养 孕育 萌生 萌发 绽放 摇曳 婆娑 婀娜 亭亭 盎然 陡然 骤然 戛然 " +
    "澄澈 清澈 清冽 芬芳 馥郁 馨香 炽热 炽烈 炙热 灼热 凛冽 料峭 萧瑟 簌簌 萧萧 斑驳 熹微 " +
    "氤氲 缱绻 葱茏 肃穆 庄严 恢宏 恢弘 壮阔 辽远 寥廓 空灵 憧憬 景仰 虔诚 崇敬 " +
    "桎梏 藩篱 窠臼 圭臬 异化 祛魅 消解 裹挟 僭越 阙如 肇始 滥觞 赓续 重塑 形塑 观照 审视"
  ).split(/\s+/);
  LITERARY = uniq(LITERARY);

  var TRANSITIONS = ["首先", "其次", "再次", "然后", "接着", "最后", "一方面", "另一方面",
    "不仅如此", "此外", "另外", "因此", "所以", "总之", "综上所述", "由此可见", "然而", "但是",
    "不过", "可是", "于是", "与此同时", "而且", "并且", "诚然", "固然", "反观", "进一步说"];

  var COMMON_BIGRAMS = {};
  ("我们 我的 他们 什么 怎么 这样 那样 自己 一个 一些 不是 没有 可以 知道 因为 所以 但是 " +
    "然后 就是 还是 觉得 时候 地方 东西 现在 的话 这种 那种 的人 都是 还有 很多 一样 如果 " +
    "虽然 应该 着的 了的 地的 一种 这个 那个 不能 一种")
    .split(/\s+/).forEach(function (w) { COMMON_BIGRAMS[w] = 1; });

  function bigrams(s) {
    var out = [], m = s.match(/[一-龥]{2,}/g) || [];
    m.forEach(function (seg) {
      for (var i = 0; i < seg.length - 1; i++) out.push(seg.substr(i, 2));
    });
    return uniq(out);
  }

  /* ---------------- 议论文特征词库 ---------------- */

  var THESIS_WORDS = ["我认为", "在我看来", "笔者", "愚以为", "由此可见", "可见", "综上所述",
    "总之", "所以说", "诚以为", "我想说", "我的观点"];
  var DEFINE_WORDS = ["所谓", "是指", "指的是", "顾名思义", "定义为", "内涵", "本质上是",
    "在本文中", "这里所说的", "何谓"];
  var CONCEDE_WORDS = ["诚然", "固然", "的确", "不可否认", "毋庸置疑", "应当承认", "必须承认",
    "当然", "无可厚非", "情有可原", "确实"];
  var TURN_WORDS = ["然而", "但是", "可是", "不过", "反观", "事实上", "实际上", "问题在于",
    "果真如此", "真的如此", "细究之下", "倘若如此", "如若"];
  var DEPTH_WORDS = ["进一步", "更深层", "更深层地", "本质上", "根本上", "说到底", "换言之",
    "不仅如此", "进而言之", "进一步说", "推而广之", "追本溯源", "究其根本", "从根本上说"];
  var REALITY_WORDS = ["当下", "如今", "现今", "现实", "当今", "时代", "我们这个", "放眼当下",
    "社会中", "生活中", "反观当下", "时下", "当代社会", "现代社会"];
  var MEASURE_WORDS = ["应当", "应该", "需要", "必须", "要学会", "让我们", "我们要", "理应",
    "不妨", "唯有"];
  var HEDGE_WORDS = ["适度", "过犹不及", "恰到好处", "中庸", "折中", "适可而止", "一分为二",
    "凡事有度", "把握分寸"];
  var COMPARE_RESP_WORDS = ["更", "相比", "相较于", "与其", "宁可", "权衡", "反而", "优先",
    "比……更", "较之", "重于", "胜于"];
  var CAUSE_WORDS = ["为什么", "源于", "根源", "背后", "折射", "导致", "何以", "成因", "因为",
    "究其原因", "本质上", "反映了", "映射出", "植根于"];
  var ANALYSIS_WORDS = ["这说明", "这意味着", "可见", "正是", "之所以", "正因如此", "由此",
    "这正是", "告诉我们", "彰显", "折射", "根源在于", "背后是", "启示我们", "蕴含着", "印证了",
    "诠释了", "足见", "足以说明"];
  var EXAMPLE_WORDS = ["例如", "比如", "譬如", "古有", "君不见", "还记得", "试想", "且看",
    "司马迁", "苏轼", "苏东坡", "陶渊明", "爱迪生", "贝多芬", "海伦", "袁隆平", "钱学森",
    "鲁迅", "史铁生", "林觉民", "苏武", "娜拉", "居里夫人", "霍金", "李白", "杜甫", "庄子",
    "孔子", "孟子", "屈原", "韩信", "范仲淹", "文天祥", "王阳明", "张桂梅", "樊锦诗", "哥白尼",
    "布鲁诺", "苏格拉底", "柏拉图", "亚里士多德", "梭罗", "海明威"];

  function hasAny(text, words) {
    for (var i = 0; i < words.length; i++) if (text.indexOf(words[i]) >= 0) return true;
    return false;
  }
  function hitCount(text, words) {
    var n = 0;
    words.forEach(function (w) { if (text.indexOf(w) >= 0) n++; });
    return n;
  }
  function firstHit(text, words) {
    for (var i = 0; i < words.length; i++) {
      var at = text.indexOf(words[i]);
      if (at >= 0) return { word: words[i], at: at };
    }
    return null;
  }

  /* ---------------- 分档 ---------------- */

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
    var sub;
    var span = b.hi - b.lo + 1;
    var p = score - b.lo;
    if (p >= span * 2 / 3) sub = '上';
    else if (p >= span / 3) sub = '中';
    else sub = '下';
    return { label: b.name, sub: sub, color: b.color };
  }

  function levelOf(pct) {
    if (pct >= 85) return '强';
    if (pct >= 70) return '较强';
    if (pct >= 55) return '中';
    if (pct >= 40) return '较弱';
    return '弱';
  }

  /* ---------------- 主函数 ---------------- */

  function grade(rawText, opts) {
    opts = opts || {};
    var text = String(rawText || '').replace(/\r/g, '');
    var title = (opts.title || '').trim();
    var type = opts.type || '议论文';
    var target = opts.target || 800;
    var prompt = (opts.prompt || '').trim();

    var marks = [];
    var sugs = {};
    function addSug(key, level, t, d) { if (!sugs[key]) sugs[key] = { level: level, title: t, detail: d }; }
    function addMark(s, e, cls, label, prio) { marks.push({ s: s, e: e, cls: cls, label: label, prio: prio }); }

    /* 段落与句子 */
    var paragraphs = text.split(/\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
    var paraRanges = [], _from = 0;
    paragraphs.forEach(function (p) {
      var i = text.indexOf(p, _from);
      paraRanges.push({ text: p, s: i, e: i + p.length });
      _from = i + p.length;
    });

    var sentences = [];
    var sRe = /[^。！？；…!?\n]+[。！？；…!?]?/g, sm;
    while ((sm = sRe.exec(text))) {
      if (cjkLen(sm[0]) >= 3) sentences.push({ text: sm[0], s: sm.index, e: sm.index + sm[0].length });
    }

    var chars = cjkLen(text);
    var uniqueSet = {};
    (text.match(/[一-龥]/g) || []).forEach(function (c) { uniqueSet[c] = 1; });
    var uniqueRatio = chars ? Object.keys(uniqueSet).length / chars : 0;

    /* ============ 一、语言硬伤检测 ============ */

    // 的/地/得
    var deWords = ["慢慢", "缓缓", "悄悄", "轻轻", "认真", "仔细", "细心", "耐心", "专心", "用心",
      "高兴", "开心", "快乐", "愉快", "兴奋", "激动", "大声", "高声", "齐声", "奋力", "努力",
      "积极", "主动", "顺利", "早早", "默默", "深深", "使劲", "不停", "不断", "渐渐", "逐渐",
      "飞快", "迅速", "赶紧", "连忙", "急忙", "匆忙", "毅然", "坦然", "从容", "亲切", "热情",
      "虚心", "骄傲", "自豪", "大方", "勇敢", "顽强", "坚强", "苦苦", "拼命", "冷静",
      "果断", "坚定", "温和", "温柔", "气愤", "生气", "愤怒", "难过", "伤心", "呼呼", "哈哈",
      "静静", "死死", "异口同声", "兴高采烈", "迫不及待", "不由自主", "情不自禁", "毫不犹豫",
      "理直气壮", "不约而同", "小心翼翼", "滔滔不绝", "结结巴巴", "慢慢悠悠"];
    var deRe = new RegExp("(?:" + uniq(deWords).join("|") + ")的(?=[一-龥])", "g");
    var deCount = 0, dm;
    while ((dm = deRe.exec(text))) {
      deCount++;
      addMark(dm.index + dm[0].length - 1, dm.index + dm[0].length, 'mk-error', '这里应该用“地”：修饰动词用“地”', 0);
    }
    if (deCount > 0) {
      addSug('dede', 'error', '区分“的、地、得”',
        '检测到 ' + deCount + ' 处动词前的修饰语后误用“的”，应改为“地”。口诀：名词前用“的”，动词前用“地”，动词后补语前用“得”。');
    }

    // 错别字
    var wordTypos = [
      [/迫不急待/g, '迫不及待'], [/再接再励/g, '再接再厉'], [/穿流不息/g, '川流不息'],
      [/走头无路/g, '走投无路'], [/名符其实/g, '名副其实'], [/谈笑风声/g, '谈笑风生'],
      [/按装/g, '安装'], [/做为/g, '作为'], [/鼎立相助/g, '鼎力相助'], [/一诺千斤/g, '一诺千金'],
      [/黄梁美梦/g, '黄粱美梦'], [/烂竽充数/g, '滥竽充数'], [/甘败下风/g, '甘拜下风'],
      [/自抱自弃/g, '自暴自弃'], [/一愁莫展/g, '一筹莫展'], [/不能自己(?=[，。！？、 ])/g, '不能自已'],
      [/(?<![现])在(?=见|次|三|也|度)/g, '再'],
      [/再(?=家里|学校|教室|这里|那里|外面|屋里|公司|房间|院子)/g, '在'],
      [/带(?=帽子|眼镜|红领巾|手套|校徽|首饰|手表)/g, '戴'],
      [/幅(?=对联|象棋|手套|碗筷|嗓子)/g, '副'],
      [/顿感/g, '注意：材料若是“钝感”，不要写成“顿感”'],
      [/纯感/g, '注意：材料若是“钝感”，不要写成“纯感”']
    ];
    var typoWords = [];
    wordTypos.forEach(function (pair) {
      var m;
      while ((m = pair[0].exec(text))) {
        addMark(m.index, m.index + m[0].length, 'mk-error', '应为“' + pair[1] + '”', 0);
        typoWords.push('“' + m[0] + '”→“' + pair[1] + '”');
      }
    });
    var dupRe = /(的的|了了|是是|就就|和和|都都|也也|很很|会会|不不不)/g, dpm;
    while ((dpm = dupRe.exec(text))) {
      addMark(dpm.index, dpm.index + dpm[0].length, 'mk-error', '疑似重复输入', 0);
      if (typoWords.indexOf('“' + dpm[0] + '”重复') < 0) typoWords.push('“' + dpm[0] + '”重复');
    }
    var repRe = /(然后|就是|因为|所以|那个|这个|于是|而且|并且){2,}/g, rpm;
    while ((rpm = repRe.exec(text))) {
      addMark(rpm.index, rpm.index + rpm[0].length, 'mk-error', '词语重复，删去一个', 0);
      if (typoWords.indexOf('“' + rpm[0].slice(0, 2) + '”重复') < 0) typoWords.push('“' + rpm[0].slice(0, 2) + '”重复');
    }
    if (typoWords.length) {
      addSug('typo', 'error', '疑似错别字 ' + typoWords.length + ' 处',
        '文中发现：' + uniq(typoWords).slice(0, 8).join('、') + '。考场作文错别字每处都可能扣分，材料中的关键词尤其要抄对，提交前逐字再读一遍。');
    }

    // 英文标点
    var epRe = /[A-Za-z一-龥][,.!?;:]|[,.!?;:][A-Za-z一-龥]/g, epm, epCount = 0;
    while ((epm = epRe.exec(text))) {
      var pi = /[,.!?;:]/.test(epm[0][0]) ? epm.index : epm.index + 1;
      epCount++;
      if (epCount <= 6) addMark(pi, pi + 1, 'mk-error', '应使用中文全角标点', 0);
    }
    if (epCount) {
      addSug('enpunct', 'error', '使用了英文标点',
        '检测到 ' + epCount + ' 处英文半角标点，高考作文应统一使用全角标点（，。！？；：）。');
    }

    // 标点连用
    var ppRe = /[，。！？、；：,]{2,}/g, ppm, ppCount = 0;
    while ((ppm = ppRe.exec(text))) {
      ppCount++;
      addMark(ppm.index, ppm.index + ppm[0].length, 'mk-warn', '标点重复，删去多余的', 1);
    }

    // 长句
    var runRe = /[一-龥]{55,}/g, runm, runCount = 0;
    while ((runm = runRe.exec(text))) {
      runCount++;
      var cut = runm.index + Math.floor(runm[0].length * 0.45);
      addMark(cut, cut + 6, 'mk-warn', '句子过长，建议在此处加逗号或断句', 1);
    }
    if (runCount >= 2) {
      addSug('runon', 'warn', runCount + ' 个句子过长',
        '有 ' + runCount + ' 处连续 55 字以上没有停顿，议论文长句太多会淹没逻辑，建议在语意分层处断句。');
    }

    // 网络用语 / 口语
    var netRe = /绝绝子|yyds|666|栓Q|神马(?:都是浮云)?|有木有|辣鸡|我勒个去|老铁|没毛病|扎心了|我也是醉了|醉了|卧槽|尼玛|牛批|牛逼/gi;
    var netWords = [], nwm;
    while ((nwm = netRe.exec(text))) {
      netWords.push(nwm[0]);
      addMark(nwm.index, nwm.index + nwm[0].length, 'mk-error', '网络用语不宜出现在高考作文中', 0);
    }
    if (netWords.length) {
      addSug('netslang', 'error', '网络用语 ' + netWords.length + ' 处',
        '“' + uniq(netWords).slice(0, 5).join('、') + '”属于网络口语，高考议论文要求规范书面表达，请换成规范词语。');
    }
    var talkRe = /超级(?:好吃|棒|好|开心|爽|可爱|帅)|咋(?:整|样|办|了)|干啥|啥玩意|哥们儿|姐们儿|贼(?:好吃|棒|好)|特别特别/g;
    var talkWords = [], twm;
    while ((twm = talkRe.exec(text))) {
      talkWords.push(twm[0]);
      addMark(twm.index, twm.index + twm[0].length, 'mk-warn', '口语化表达，建议改为书面语', 1);
    }

    // “然后”泛滥
    var ranhou = countRe(text, /然后/g);
    if (ranhou >= 4) {
      addSug('ranhou', 'warn', '“然后”使用过多（' + ranhou + ' 次）',
        '议论文靠逻辑推进而非时间顺序。可删去多余的“然后”，换成“进而、于是、由此、正因如此”等因果衔接。');
      var rhRe = /然后/g, rhm, rhI = 0;
      while ((rhm = rhRe.exec(text)) && rhI < 3) { addMark(rhm.index, rhm.index + 2, 'mk-warn', '可删去或替换为因果衔接', 1); rhI++; }
    }

    // “我觉得”
    var wojuede = countRe(text, /我觉得/g);
    if (wojuede >= 2) {
      addSug('wojuede', 'warn', '“我觉得”削弱论证（' + wojuede + ' 次）',
        '议论文要观点鲜明、语气肯定。“我觉得”是个人感受的表达，显得底气不足，可改为“我认为、在我看来、由此可见”。');
    }

    // 感叹号
    var excl = (text.match(/[!！]/g) || []).length;
    if (sentences.length >= 8 && excl / sentences.length > 0.2 && excl >= 4) {
      addSug('excl', 'tip', '感叹号偏多',
        '全文 ' + excl + ' 个感叹号，占句子两成以上。议论文以理服人，感叹号贵在克制。');
    }

    /* ============ 二、结构检测 ============ */

    var pn = paragraphs.length;
    if (pn === 1 && chars > 60) {
      addSug('para1', 'error', '全文只有一个自然段',
        '议论文应按“引论—本论—结论”分层。建议拆成 5-8 段：引材料亮观点、概念界定、让步、质疑、深入、现实、收束。');
    } else if (pn === 2) {
      addSug('para2', 'warn', '段落偏少（仅 2 段）',
        '两段式结构看不清论证层次，建议把本论部分按“让步—质疑—深入”拆成若干段。');
    } else if (pn > 12 && chars / pn < 60) {
      addSug('paraMany', 'tip', '段落过碎（' + pn + ' 段）',
        '自然段太多、每段过短，论证会显得零散。围绕同一分论点的小段可以合并。');
    }

    var longPara = 0;
    paraRanges.forEach(function (pr) {
      if (cjkLen(pr.text) > 280) {
        longPara++;
        addMark(pr.s + 40, pr.s + 46, 'mk-warn', '该段超过 280 字，建议按论证层次分段', 1);
      }
    });

    var openingLen = pn ? cjkLen(paragraphs[0]) : 0;
    if (pn && openingLen > 150) {
      addSug('opening', 'tip', '开头入题偏慢',
        '开头段 ' + openingLen + ' 字还未亮明观点。上海一类文开头多为“简引材料+一句话亮观点”，建议压缩铺垫。');
    }

    // 标题检测：标题输入框 或 正文首行像标题
    var titleLine = false;
    if (pn >= 2) {
      var first = paragraphs[0];
      if (cjkLen(first) >= 2 && cjkLen(first) <= 16 && !/[。！？，；…!?]/.test(first)) titleLine = true;
    }
    var hasTitle = !!(title || titleLine);
    if (type === '议论文' && chars >= 600 && !hasTitle) {
      addSug('notitle', 'error', '疑似漏拟题目',
        '上海高考要求“自拟题目”，漏拟题目会被扣分。好标题可以直接亮出核心观点，如“常识不应成为常态”。');
    }

    // 首尾呼应
    var echoShared = [];
    if (pn >= 2) {
      var bg1 = bigrams(paragraphs[0]), bg2 = bigrams(paragraphs[pn - 1]);
      var bg2set = {};
      bg2.forEach(function (g) { bg2set[g] = 1; });
      echoShared = bg1.filter(function (g) { return bg2set[g] && !COMMON_BIGRAMS[g]; });
    }

    var transUsed = TRANSITIONS.filter(function (w) { return text.indexOf(w) >= 0; });

    /* ============ 三、议论文思辨特征检测 ============ */

    var isArg = type === '议论文';
    var thesisN = hitCount(text, THESIS_WORDS);
    var defineN = hitCount(text, DEFINE_WORDS);
    var concedeN = hitCount(text, CONCEDE_WORDS);
    var turnN = hitCount(text, TURN_WORDS);
    var depthN = hitCount(text, DEPTH_WORDS);
    var realityN = hitCount(text, REALITY_WORDS);
    var measureN = hitCount(text, MEASURE_WORDS);
    var hedgeN = hitCount(text, HEDGE_WORDS);

    var hasConcede = concedeN > 0, hasTurn = turnN > 0;
    var dialectic = hasConcede && hasTurn;

    // 亮点批注（每类取前 2 处）
    var defMark = firstHit(text, DEFINE_WORDS);
    if (defMark) addMark(defMark.at, Math.min(text.length, defMark.at + defMark.word.length + 8),
      'mk-good', '概念界定：先划清内涵边界，是一类文的起手式', 2);
    var conHit = firstHit(text, CONCEDE_WORDS);
    if (conHit) addMark(conHit.at, conHit.at + conHit.word.length,
      'mk-good', '让步：先承认对方合理性，思辨由此展开', 2);
    var turnHit = firstHit(text, TURN_WORDS);
    if (turnHit) addMark(turnHit.at, turnHit.at + turnHit.word.length,
      'mk-good', '转折质疑：在让步后划出对方的边界', 2);
    var depthHit = firstHit(text, DEPTH_WORDS);
    if (depthHit) addMark(depthHit.at, depthHit.at + depthHit.word.length,
      'mk-good', '层进追问：把论证推向更深一层', 2);
    var realHit = firstHit(text, REALITY_WORDS);
    if (realHit) addMark(realHit.at, realHit.at + realHit.word.length,
      'mk-good', '现实针对性：在当下语境中检验观点', 2);

    // 句级：举例 / 分析
    var exSents = [], anSents = [];
    sentences.forEach(function (sn) {
      if (EXAMPLE_WORDS.some(function (w) { return sn.text.indexOf(w) >= 0; })) exSents.push(sn);
      if (ANALYSIS_WORDS.some(function (w) { return sn.text.indexOf(w) >= 0; })) anSents.push(sn);
    });
    var exCount = exSents.length, anCount = anSents.length;
    var exampleStack = isArg && exCount >= 3 && anCount < Math.ceil(exCount * 0.7);
    var exampleGood = isArg && exCount >= 1 && anCount >= exCount * 0.8;
    if (exampleStack) {
      var es0 = exSents[0];
      addMark(es0.s, Math.min(es0.e, es0.s + 26), 'mk-warn', '以例代证风险：事例后须跟分析句', 1);
      addSug('exstack', 'error', '以例代证、素材堆砌（检测到 ' + exCount + ' 处举例、' + anCount + ' 处分析）',
        '上海阅卷把“以例代证”列为不进二类的硬伤：事例不能自己证明观点。请在每个事例后补一句分析，' +
          '用“这说明……/之所以如此，是因为……/这正印证了……”把例子与论点咬合，例不在多而在精。');
    }

    // 名言后无论证（引用与分析缺失）
    var quoteRe = /[“「]([^”」]{4,40})[”」]/g, qm, quoteCount = 0, quoteMarkCap = 0;
    while ((qm = quoteRe.exec(text))) {
      var before = text.slice(Math.max(0, qm.index - 4), qm.index);
      var dialogue = /[说问道喊叫答劝嚷吼]|回答|告诉/.test(before);
      if (!dialogue) {
        quoteCount++;
        if (quoteMarkCap < 2) {
          addMark(qm.index, qm.index + qm[0].length, 'mk-good', '引用：注意引用后要有自己的分析，忌名言空转', 2);
          quoteMarkCap++;
        }
      }
    }
    if (quoteCount >= 2 && anCount < 2) {
      addSug('quotestack', 'warn', '名言引用与论点脱节',
        '检测到 ' + quoteCount + ' 处引用但分析句不足。名言是为论点服务的，引用后要回答“这句名言在本题语境中说明了什么”，避免掉书袋。');
    }

    // “怎么做”占比：后半篇
    var tailStart = Math.floor(text.length * 0.55);
    var tailSents = sentences.filter(function (sn) { return sn.s >= tailStart; });
    var tailMeasure = tailSents.filter(function (sn) {
      return MEASURE_WORDS.some(function (w) { return sn.text.indexOf(w) >= 0; });
    });
    var measureHeavy = isArg && tailSents.length >= 3 &&
      tailMeasure.length / tailSents.length > 0.4 && depthN === 0;
    if (measureHeavy) {
      addSug('measure', 'warn', '后半篇沦为“怎么做”清单',
        '上海阅卷明确：通篇着重谈“怎么做”、回避“为什么”的作文不进二类。建议压缩做法罗列，把篇幅让给成因分析与条件辨析，做法在结尾点到即可。');
      var mh = tailMeasure[0];
      addMark(mh.s, Math.min(mh.e, mh.s + 16), 'mk-warn', '连续谈做法：先回答“为什么”再谈“怎么做”', 1);
    }

    // 立场骑墙
    var hedge = isArg && hedgeN >= 2 && thesisN < 2;
    if (hedge) {
      addSug('hedge', 'warn', '以“适度/中庸”和稀泥，立场不鲜明',
        '“凡事要适度”“过犹不及”若不加条件分析，等于没有观点——上海卷把“各打五十大板”封在三类上。' +
          '正确写法是给出判断成立的情境与标准：“在何种条件下、对谁、为什么应当如此”，再谈分寸。');
    }

    // 只写一面
    var oneSided = isArg && chars >= 500 && !hasConcede && !hasTurn;
    if (oneSided) {
      addSug('oneside', 'warn', '只写一面，缺少辩证',
        '全文未见“诚然/固然……然而……”式的让步转折。上海思辨题几乎都包含两种说法或两面，' +
          '只论证一面通常只能到三类（39-45 分）。先用一段话承认对立面的合理性，再质疑其边界，论证立刻厚一层。');
    }

    // 文采亮点
    var idiomHits = [], idiomMarkCap = 0;
    IDIOMS.forEach(function (word) {
      var at = text.indexOf(word);
      while (at >= 0) {
        idiomHits.push({ w: word, s: at, e: at + word.length });
        if (idiomMarkCap < 18) { addMark(at, at + word.length, 'mk-good', '成语：' + word, 3); idiomMarkCap++; }
        at = text.indexOf(word, at + word.length);
      }
    });
    var litHits = [], litMarkCap = 0;
    LITERARY.forEach(function (word) {
      var at = text.indexOf(word);
      while (at >= 0) {
        litHits.push(word);
        if (litMarkCap < 8) { addMark(at, at + word.length, 'mk-good', '书面用词：' + word, 3); litMarkCap++; }
        at = text.indexOf(word, at + word.length);
      }
    });
    var simileRe = /(?:好像|如同|仿佛|宛如|犹如|好似|像)[^，。！？、；：”」]{1,14}/g;
    var simCount = 0, simm;
    while ((simm = simileRe.exec(text)) && simCount < 4) {
      var prev = simm.index > 0 ? text[simm.index - 1] : '';
      if (prev === '图' || prev === '雕' || prev === '塑') continue;
      addMark(simm.index, simm.index + simm[0].length, 'mk-good', '比喻：让抽象说理更形象', 2);
      simCount++;
    }
    var rqRe = /难道[^，。！？；]{2,18}[?？]?|岂能[^，。！？；]{0,12}|怎能[^，。！？；]{0,14}|何尝[^，。！？；]{0,12}|不正是[^，。！？；]{2,14}/g;
    var rqCount = 0, rqm;
    while ((rqm = rqRe.exec(text)) && rqCount < 3) {
      addMark(rqm.index, rqm.index + rqm[0].length, 'mk-good', '反问：加强论证语气', 2);
      rqCount++;
    }
    var paiCount = 0;
    sentences.forEach(function (sn) {
      if (paiCount >= 2) return;
      var clauses = sn.text.split(/[，、；,]/).filter(function (c) { return c.length >= 2; });
      for (var i = 0; i + 2 < clauses.length; i++) {
        if (clauses[i][0] === clauses[i + 1][0] && clauses[i][0] === clauses[i + 2][0]) {
          addMark(sn.s, sn.e, 'mk-good', '排比：增强说理气势', 2);
          paiCount++;
          return;
        }
      }
    });
    var rhetoricCount = simCount + rqCount + paiCount;

    /* ============ 四、审题契合度（题目材料 vs 作文） ============ */

    var deviation;
    var promptConcepts = [];
    var qRe = /[“"「『]([^””」』]{1,12})[”"」』]/g, qx;
    while ((qx = qRe.exec(prompt))) {
      if (promptConcepts.indexOf(qx[1]) < 0) promptConcepts.push(qx[1]);
    }
    var comparePrompt = /更应|还是|利大于弊|孰|更值得|更能|更加|是否/.test(prompt);
    var compareAnswered = hasAny(text, COMPARE_RESP_WORDS);

    if (!prompt) {
      deviation = {
        status: 'none',
        label: '未提供题目材料',
        detail: '本次未提供作文题目材料，无法核查审题契合度。建议先使用“审题指导”读懂题目，再把材料粘贴到题目区后重新批改，以判断是否偏题、有无偷换概念。'
      };
    } else {
      var hit = promptConcepts.filter(function (c) { return text.indexOf(c) >= 0; });
      var cov = promptConcepts.length ? hit.length / promptConcepts.length : null;
      var extra = [];
      if (comparePrompt && !compareAnswered) {
        extra.push('题目含“更应/是否/还是”等比较辨析词，但作文中未见“更、相比、与其、权衡”等比较回应，未完成材料要求的比较判断（不进一类）。');
      }
      if (cov === null) {
        deviation = {
          status: 'ok',
          label: '无法自动核对',
          detail: '题目材料中没有带引号的核心概念，本地规则无法自动比对关键词。请人工确认：作文是否回应了材料真正的问句，有无只抓一个词就说开去。' +
            (extra.length ? ' ' + extra.join(' ') : '')
        };
      } else if (cov === 1 || (promptConcepts.length === 1 && hit.length === 1)) {
        deviation = {
          status: 'ok',
          label: '审题契合',
          detail: '作文覆盖了材料的核心概念（' + hit.join('、') + '），未见明显跑题。' +
            (extra.length ? '但需注意：' + extra.join(' ') : '仍要确认论证是否始终围绕概念展开，而非“明扣暗离”。')
        };
      } else if (cov >= 0.5) {
        deviation = {
          status: 'warn',
          label: '基本契合，有明扣暗离风险',
          detail: '材料核心概念命中 ' + hit.length + '/' + promptConcepts.length + '（已出现：' + (hit.join('、') || '无') +
            '；缺失：' + promptConcepts.filter(function (c) { return hit.indexOf(c) < 0; }).join('、') + '）。' +
            '若论证只扣住部分概念、其余另起炉灶，属“明扣暗离”，通常在三类中下。' + (extra.length ? ' ' + extra.join(' ') : '')
        };
      } else if (hit.length > 0) {
        deviation = {
          status: 'warn',
          label: '疑似半套题',
          detail: '材料核心概念仅少量命中（' + hit.join('、') + '），大部分题眼未在文中回应，疑似套题或只就一个词发挥。' +
            '上海阅卷中此类作文多在三类下至四类。' + (extra.length ? ' ' + extra.join(' ') : '')
        };
      } else {
        deviation = {
          status: 'bad',
          label: '疑似偏题/套题',
          detail: '材料中的核心概念（' + promptConcepts.slice(0, 3).join('、') + '）在作文中均未出现，' +
            '疑似脱离材料另起炉灶或套用宿构，按上海阅卷通常封顶四类。请回到材料重新审题立意。'
        };
      }
    }

    /* ============ 四-B、文章逻辑评判（本地规则：段落功能 + 逻辑谬误 + 改写示范） ============ */

    var logicFallacies = [];
    var rewrites = [];
    var paraAdvice = [];

    function addFallacy(name, s, e, why, mark) {
      var excerpt = text.slice(s, Math.min(e, s + 40));
      logicFallacies.push({ name: name, excerpt: excerpt, why: why });
      if (mark) addMark(s, e, 'mk-logic', '【' + name + '】' + why, 1);
    }

    // —— 1. 绝对化表述 / 以偏概全 ——
    var absRe = /[^。！？；!?]{0,12}(?:任何|所有|一切|凡是|从来都?|总是|永远|绝对(?:不|能)?|百分之百|毫无例外|不可能(?:有|存在))[^。！？；!?]{0,28}[。！？；!?]?/g;
    var absm, absShown = 0;
    while ((absm = absRe.exec(text)) && absShown < 4) {
      if (cjkLen(absm[0]) < 8) continue;
      addFallacy('以偏概全/绝对化', absm.index, Math.min(absm.index + absm[0].length, absm.index + 30),
        '全称判断需要充分论据支撑；用“往往、多数情况下、在……情境中”作限定，论证更严谨。', true);
      absShown++;
    }
    if (absShown > 0 && rewrites.length < 6) {
      var absSentence = sentences.filter(function (sn) { return /任何|所有|一切|凡是|从来|总是|永远|绝对/.test(sn.text); })[0];
      if (absSentence) {
        rewrites.push({
          original: absSentence.text.slice(0, 90),
          issue: '绝对化全称判断，论据只够支撑“多数情况”，话说满了反而被一个反例驳倒',
          revised: absSentence.text
            .replace(/任何|所有|一切|凡是/g, '大多数').replace(/从来都?|总是|永远|绝对/g, '往往')
            .replace(/不可能(?:有|存在)/g, '很少有').slice(0, 100),
          why: '加上“往往、大多数、在……条件下”等限定语，结论更难被反驳，也显得思辨更成熟'
        });
      }
    }

    // —— 2. 滑坡推理 ——
    var slipRe = /[^。！？；!?]{0,10}(?:长此以往|久而久之|这样下去|倘若(?:一直)?|如果(?:一直|每个人都)?|一旦)[^。！？；!?]{0,40}(?:必将|必然|终将|最终|就会|导致|整个社会|后果不堪设想|不可收拾)[^。！？；!?]{0,24}[。！？；!?]?/g;
    var slipm, slipShown = 0;
    while ((slipm = slipRe.exec(text)) && slipShown < 2) {
      if (cjkLen(slipm[0]) < 12) continue;
      addFallacy('滑坡推理', slipm.index, Math.min(slipm.index + slipm[0].length, slipm.index + 34),
        '从起点到极端后果之间缺少环环相扣的论证，连锁恶果不会自动发生。', true);
      slipShown++;
    }

    // —— 3. 非黑即白 ——
    var bnwRe = /[^。！？；!?]{0,8}(?:不是[^，。！？；!?]{2,20}就是|要么[^，。！？；!?]{2,16}要么|不能[^，。！？；!?]{2,18}只能|与其[^，。！？；!?]{2,16}不如)[^。！？；!?]{0,20}/g;
    var bnwm;
    while ((bnwm = bnwRe.exec(text))) {
      addFallacy('非黑即白', bnwm.index, Math.min(bnwm.index + bnwm[0].length, bnwm.index + 34),
        '把选择压缩成两个极端，忽略了中间状态与第三种可能。', true);
    }

    // —— 4. 强加因果：个人事例直接推出普遍结论 ——
    var forceRe = /[^。！？；!?]{0,6}(?:我有一次|我上次|我同桌|我有个同学|有一次)[^。！？；!?]{0,60}(?:所以说|因此|可见|这告诉我们|我们要|我们应该)[^。！？；!?]{0,30}/g;
    var fm;
    while ((fm = forceRe.exec(text))) {
      addFallacy('强加因果', fm.index, Math.min(fm.index + fm[0].length, fm.index + 36),
        '单个事例只能说明“存在这种情况”，不能直接推出普遍性结论；需补因果机制分析。', true);
    }

    // —— 5. 例后无分析（在以例代证的句子上打逻辑批注，最多 3 处）——
    if (exampleStack) {
      exSents.slice(0, 3).forEach(function (es) {
        addFallacy('例后无分析', es.s, Math.min(es.e, es.s + 26),
          '事例只“摆”在这里，没有说明它如何证明分论点，论证链条在此断裂。', true);
      });
      var ex0 = exSents[0];
      rewrites.push({
        original: ex0.text.slice(0, 90),
        issue: '只有事例没有分析（以例代证）：读者看完例子不知道它要证明什么',
        revised: ex0.text.replace(/[。！？；!?]$/, '') +
          '。这一事例之所以成立，并非偶然——恰恰说明在当时的条件下，' +
          '唯有跳出常识的惯性，才能看清被普遍共识遮蔽的真相。',
        why: '用“之所以……恰恰说明……”补出例后分析，事例与论点之间才建立起证明关系'
      });
    }

    // —— 6. “我觉得”改写示范 ——
    var wjdSentence = sentences.filter(function (sn) { return /我觉得/.test(sn.text); })[0];
    if (wjdSentence && rewrites.length < 6) {
      rewrites.push({
        original: wjdSentence.text.slice(0, 90),
        issue: '“我觉得”是个人感受语气，削弱了议论文应有的确定立场',
        revised: wjdSentence.text.replace(/我觉得/g, '在我看来').slice(0, 100),
        why: '“在我看来”既保留立论主体，又是理性判断而非情绪感受，语气更符合议论文文体'
      });
    }

    // —— 7. 口号式结尾改写示范 ——
    var lastSents = sentences.slice(-3);
    var slogan = lastSents.filter(function (sn) {
      return /让我们一起|坚持下去就一定|一定会有|加油|！{2,}|！!?/.test(sn.text) ||
        (/要|应该|必须/.test(sn.text) && /[！!]/.test(sn.text) && !ANALYSIS_WORDS.some(function (w) { return sn.text.indexOf(w) >= 0; }));
    })[0];
    if (slogan && rewrites.length < 6) {
      rewrites.push({
        original: slogan.text.slice(0, 90),
        issue: '结尾只有口号与号召，没有回扣材料与中心论点，收束无力',
        revised: '因此，真正需要坚持的不是某个口号，而是在常识的洪流中保持独立判断的清醒——' +
          '这正是材料留给每个写作者的考题。',
        why: '结尾回扣材料关键词并升华中心论点，比空喊“坚持/加油”更有阅卷得分点'
      });
    }

    // —— 8. 长句改写示范（拆分） ——
    var runSentence = sentences.filter(function (sn) { return cjkLen(sn.text) >= 55; })[0];
    if (runSentence && rewrites.length < 6) {
      var clauses = runSentence.text.split('，');
      if (clauses.length >= 3) {
        var cutAt = Math.ceil(clauses.length / 2);
        var s1 = clauses.slice(0, cutAt).join('，').replace(/[。！？；!?]$/, '') + '。';
        var s2 = clauses.slice(cutAt).join('，');
        if (s2 && !/[。！？；!?]$/.test(s2)) s2 += '。';
        rewrites.push({
          original: runSentence.text.slice(0, 90),
          issue: '长句套连，多个语意挤在一句里，逻辑层次被淹没',
          revised: s1 + s2,
          why: '按“因果/转折”关系拆成两句，前句铺陈、后句落点，论证节奏更清楚'
        });
      }
    }

    // —— 中心论点定位 ——
    var thesisSentence = null;
    for (var i = 0; i < Math.min(sentences.length, 12); i++) {
      if (THESIS_WORDS.some(function (w) { return sentences[i].text.indexOf(w) >= 0; }) &&
          cjkLen(sentences[i].text) >= 10) { thesisSentence = sentences[i]; break; }
    }
    if (!thesisSentence) thesisSentence = sentences.filter(function (sn) {
      return /[是应当]|不应|要的是|在于/.test(sn.text) && cjkLen(sn.text) >= 12 && cjkLen(sn.text) <= 60;
    })[0] || null;
    var logicThesis = thesisSentence ? thesisSentence.text.replace(/^[，。、；：\s]+/, '').slice(0, 80)
      : '（全文未出现明确中心论点）';

    // —— 逐段功能识别 ——
    var paraFlow = paraRanges.map(function (pr, idx) {
      var t = pr.text, role, issue = '无';
      var hasEx = EXAMPLE_WORDS.some(function (w) { return t.indexOf(w) >= 0; });
      var hasAn = ANALYSIS_WORDS.some(function (w) { return t.indexOf(w) >= 0; });
      var head = t.slice(0, 2);
      if (idx === 0) {
        role = thesisN > 0 && t.indexOf(firstHitWords(t, THESIS_WORDS) || '___') >= 0 ? '提出中心论点'
          : (hasAn || /[?？]$/.test(t) ? '引论述料' : '引论述料');
      } else if (idx === pn - 1 && pn > 2) {
        role = /因此|总之|综上|所以说|让我们|回扣|这正是/.test(t) ? '总结回扣'
          : (MEASURE_WORDS.some(function (w) { return t.indexOf(w) >= 0; }) ? '谈做法' : '分论点论证');
      } else if (DEFINE_WORDS.some(function (w) { return t.indexOf(w) >= 0; })) {
        role = '界定概念';
      } else if (CONCEDE_WORDS.some(function (w) { return head.indexOf(w.slice(0, 2)) >= 0 || t.indexOf(w) >= 0; }) &&
                 !TURN_WORDS.some(function (w) { return head.indexOf(w) >= 0; })) {
        role = '让步承认对方';
      } else if (TURN_WORDS.some(function (w) { return head.indexOf(w.slice(0, 2)) >= 0; })) {
        role = '转折质疑';
      } else if (DEPTH_WORDS.some(function (w) { return t.indexOf(w) >= 0; })) {
        role = '递进深化';
      } else if (REALITY_WORDS.some(function (w) { return t.indexOf(w) >= 0; })) {
        role = '联系现实';
      } else if (MEASURE_WORDS.some(function (w) { return t.indexOf(w) >= 0; }) && !hasAn && cjkLen(t) > 60) {
        role = '谈做法';
      } else if (hasEx && !hasAn) {
        role = '举例论证';
      } else if (hasEx && hasAn) {
        role = '例后分析';
      } else {
        role = '分论点论证';
      }

      if (cjkLen(t) < 30 && pn > 3) issue = '段落过短（不足 30 字），论证未展开';
      else if (role === '举例论证' && !hasAn) issue = '只有事例没有例后分析，存在以例代证';
      else if (role === '谈做法' && idx > pn * 0.6 && depthN === 0) issue = '后半篇停留在“怎么做”，缺少“为什么”的深化';
      else if (role === '分论点论证' && cjkLen(t) > 280) issue = '一段承载多个论证层次，建议分段';

      var gist = t.replace(/\s+/g, '').slice(0, 26);
      return { para: idx + 1, role: role, gist: gist + (cjkLen(t) > 26 ? '…' : ''), issue: issue };
    });

    function firstHitWords(t, words) {
      for (var k = 0; k < words.length; k++) if (t.indexOf(words[k]) >= 0) return words[k];
      return null;
    }

    // —— 论证链条评价 ——
    var chainParts = [];
    if (logicThesis === '（全文未出现明确中心论点）') {
      chainParts.push('全文没有可识别的中心论点句，各段缺少共同的论证靶子，论证链条从起点处就是松散的。');
    } else {
      chainParts.push('中心论点在文中可识别（“' + logicThesis.slice(0, 36) + (logicThesis.length > 36 ? '…' : '') + '”）。');
    }
    if (hasConcede && hasTurn) chainParts.push('论证呈现“让步—转折”的辩证推进，段落之间有层次；');
    else if (oneSided) chainParts.push('全文单向推进，缺少让步与转折段，论证链只有一面之词；');
    if (depthN > 0) chainParts.push('并出现向本质/条件层面的递进；');
    else chainParts.push('但未见向“本质、条件、更高标准”的递进段，深度不足；');
    if (exampleStack) chainParts.push('论据段与论点之间缺少分析句咬合，链条在举例处断裂。');
    else if (exampleGood) chainParts.push('事例之后配有分析，论据与论点咬合较好。');
    if (measureHeavy) chainParts.push('后半篇由说理滑向做法罗列，论证方向发生偏移。');
    var logicChain = chainParts.join('');

    var logicStrengths = [];
    if (defineN > 0) logicStrengths.push('对核心概念有界定意识，为论证划定了讨论边界');
    if (hasConcede && hasTurn) logicStrengths.push('“先让步、再质疑”的段落安排使论证具有思辨张力');
    if (depthN > 0) logicStrengths.push('能用“进一步/本质上”把论证推向更深层次');
    if (exampleGood) logicStrengths.push('事例后有分析句跟进，论据与论点联系紧密');
    if (realityN > 0) logicStrengths.push('设置了联系当下的段落，文章有现实针对性');
    if (!logicStrengths.length && chars >= 500) logicStrengths.push('能够围绕一个话题完整成篇，结构基本闭合');

    var logicReview = {
      thesis: logicThesis,
      paragraphFlow: paraFlow,
      chain: logicChain,
      fallacies: logicFallacies.slice(0, 10),
      strengths: logicStrengths.slice(0, 3)
    };

    // —— 逐段修改建议 ——
    paraFlow.forEach(function (pf) {
      if (pf.issue === '无' || paraAdvice.length >= 6) return;
      var advice;
      if (/过短/.test(pf.issue)) advice = '第 ' + pf.para + ' 段只有寥寥数语：补一个道理论据或具体分析句把它展开到 100 字以上。';
      else if (/以例代证/.test(pf.issue)) advice = '第 ' + pf.para + ' 段事例后补 1-2 句分析：用“这说明……/之所以……是因为……”回答例子与分论点的关系。';
      else if (/怎么做/.test(pf.issue)) advice = '第 ' + pf.para + ' 段压缩做法罗列，改为分析“为什么会这样、在什么条件下成立”，做法留到结尾一段点到。';
      else if (/多个论证层次/.test(pf.issue)) advice = '第 ' + pf.para + ' 段过长：按“分论点—论据—分析”拆成两段，层次会立刻清晰。';
      else advice = '第 ' + pf.para + ' 段：' + pf.issue;
      paraAdvice.push({ para: pf.para, advice: advice });
    });
    if (!thesisSentence && isArg && chars >= 400 && paraAdvice.length < 6) {
      paraAdvice.unshift({ para: 1, advice: '在开头段末尾补一个明确的中心论点句（“在我看来，……”），让全文所有段落都有可回扣的论证核心。' });
    }

    /* ============ 五、统计 ============ */

    var sentLens = sentences.map(function (s) { return cjkLen(s.text); });
    var avgLen = sentLens.length ? Math.round(sentLens.reduce(function (a, b) { return a + b; }, 0) / sentLens.length) : 0;
    var stats = {
      chars: chars, target: target, paragraphs: pn, sentences: sentences.length,
      idioms: idiomHits.length, literary: uniq(litHits).length, rhetoric: rhetoricCount,
      quotes: quoteCount, avgLen: avgLen,
      dialectic: (hasConcede ? 1 : 0) + (hasTurn ? 1 : 0),
      examples: exCount, analysis: anCount
    };

    /* ============ 六、70 分整体赋分（先定档、再封顶/保底） ============ */

    var ratio = target ? chars / target : 1;
    var score = 49;     // 基准分：完整成篇、立意基本契合 ≈ 三类中
    var cap = 70, floor = 6;

    // 字数（区间触发，不做单点硬切）
    if (chars < 400) {
      cap = Math.min(cap, pn >= 4 ? 30 : 20);
      score -= 18;
    } else if (chars < 500) {
      cap = Math.min(cap, 38); score -= 12;
    } else if (chars < 600) {
      cap = Math.min(cap, 45); score -= 8;
    } else if (chars < 680) {
      cap = Math.min(cap, 51); score -= 4;
    } else if (chars >= 800 && chars <= 1200) {
      score += 2;
    } else if (chars > 1300) {
      score -= 1;
    }

    // 结构
    if (pn >= 5 && pn <= 8) score += 3;
    else if (pn === 4) score += 1;
    else if (pn === 3) score -= 2;
    else if (pn === 2) score -= 6;
    else if (pn === 1) score -= 10;
    if (pn > 8 && pn <= 12) score += 1;
    score -= Math.min(4, longPara);
    if (transUsed.length >= 4) score += 1;
    if (echoShared.length) score += 1;
    if (openingLen > 150) score -= 1;

    // 思维深度（上海卷赋分核心）
    if (thesisN > 0) score += 1;
    if (defineN > 0) score += 3;
    if (dialectic) score += 5;
    else if (hasTurn) score += 2;
    else if (isArg && chars >= 500) score -= 3;
    if (depthN > 0) score += 3;
    if (realityN > 0) score += 2;
    if (exampleGood) score += 2;
    if (quoteCount > 0) score += Math.min(1, quoteCount);
    if (!hasTitle && chars >= 600) score -= 1;

    // 语言
    score -= Math.min(7, Math.round(typoWords.length * 1.5));
    score -= Math.min(2, Math.floor(epCount / 2));
    score -= Math.min(5, netWords.length * 2);
    score -= Math.min(4, Math.floor(runCount / 2));
    if (avgLen && avgLen < 8) score -= 1;
    else if (avgLen > 45) score -= 2;
    if (ranhou >= 4) score -= 1;
    if (deCount) score -= Math.min(2, deCount);
    if (rhetoricCount >= 3) score += 2; else if (rhetoricCount >= 1) score += 1;
    if (idiomHits.length >= 6) score += 1;

    // —— 否决项封顶（只封顶，不打死）——
    if (isArg && chars >= 500) {
      if (oneSided) cap = Math.min(cap, 51);
      if (exampleStack) cap = Math.min(cap, 51);
      if (measureHeavy) cap = Math.min(cap, 51);
      if (hedge) cap = Math.min(cap, 51);
      if (comparePrompt && !compareAnswered) cap = Math.min(cap, 62);
    }
    if (deviation.status === 'bad') cap = Math.min(cap, 38);
    else if (deviation.status === 'warn' && deviation.label === '基本契合，有明扣暗离风险') cap = Math.min(cap, 47);
    else if (deviation.status === 'warn' && deviation.label === '疑似半套题') cap = Math.min(cap, 40);

    // —— 保底：立意基本契合 + 结构完整，不低于三类下沿 ——
    if (deviation.status !== 'bad' && pn >= 3 && chars >= 600) floor = 39;
    if (deviation.status === 'ok' && pn >= 4 && chars >= 700) floor = Math.max(floor, 44);

    score = clamp(Math.round(score), floor, cap);
    score = clamp(score, 5, 70);
    var band = bandOf(score);

    /* ============ 七、诊断四维（0-100，仅展示不加总） ============ */

    // 审题立意
    var pContent = 58;
    if (deviation.status === 'ok') {
      pContent += deviation.label === '审题契合' ? 12 : 5;
      if (dialectic) pContent += 8;
    } else if (deviation.status === 'warn') {
      pContent -= 10;
    } else if (deviation.status === 'bad') {
      pContent -= 30;
    }
    if (thesisN > 0) pContent += 4;
    if (defineN > 0) pContent += 10;
    if (dialectic) pContent += 8; else if (hasTurn) pContent += 3; else if (isArg && chars >= 500) pContent -= 8;
    if (depthN > 0) pContent += 8;
    if (realityN > 0) pContent += 5;
    if (hedge) pContent -= 10;
    if (comparePrompt && !compareAnswered) pContent -= 8;
    if (measureHeavy) pContent -= 6;
    pContent = clamp(Math.round(pContent), 8, 98);

    // 论证层次
    var pStruct = 60;
    if (pn >= 5 && pn <= 8) pStruct += 14; else if (pn === 4) pStruct += 7;
    else if (pn === 3) pStruct -= 2; else if (pn === 2) pStruct -= 14; else if (pn === 1) pStruct -= 24;
    if (transUsed.length >= 4) pStruct += 5; else if (transUsed.length >= 2) pStruct += 2;
    if (echoShared.length) pStruct += 4;
    pStruct -= Math.min(12, longPara * 4);
    if (dialectic) pStruct += 7;
    if (depthN > 0) pStruct += 6;
    if (measureHeavy) pStruct -= 8;
    if (openingLen > 150) pStruct -= 3;
    pStruct = clamp(Math.round(pStruct), 8, 98);

    // 论据分析
    var pEvidence = 55;
    if (exampleGood) pEvidence += 14;
    if (exCount === 0) pEvidence -= 4;
    if (exampleStack) pEvidence -= 22;
    if (quoteCount > 0) pEvidence += Math.min(10, quoteCount * 5);
    if (anCount >= 3) pEvidence += 8; else if (anCount >= 1) pEvidence += 3; else pEvidence -= 8;
    if (realityN > 0) pEvidence += 5;
    if (quoteCount >= 2 && anCount < 2) pEvidence -= 6;
    pEvidence = clamp(Math.round(pEvidence), 8, 98);

    // 语言表达
    var pLang = 72;
    pLang -= Math.min(12, typoWords.length * 3);
    pLang -= Math.min(3, Math.floor(epCount / 2));
    pLang -= Math.min(8, netWords.length * 3);
    pLang -= Math.min(6, runCount * 2);
    if (ranhou >= 4) pLang -= 2;
    if (wojuede >= 2) pLang -= 3;
    if (deCount) pLang -= Math.min(3, deCount);
    if (avgLen && avgLen < 8) pLang -= 3;
    else if (avgLen > 45) pLang -= 4;
    if (rhetoricCount >= 3) pLang += 6; else if (rhetoricCount >= 1) pLang += 3;
    if (idiomHits.length >= 6) pLang += 3;
    if (uniqueRatio >= 0.6) pLang += 3;
    if (typoWords.length === 0 && epCount === 0 && deCount === 0 && chars > 200) pLang += 3;
    pLang = clamp(Math.round(pLang), 8, 98);

    function dimComment(key, pct) {
      var map = {
        content: [
          [85, '审题准确，概念清晰，思辨层层深入'],
          [70, '能扣住题意并有一定思辨'],
          [55, '立意基本符合，思辨深度不足'],
          [40, '审题有偏差或论证单面'],
          [0, '偏题、套题或偷换概念']
        ],
        struct: [
          [85, '层进式结构完整，论证环环相扣'],
          [70, '结构清晰，有让步转折'],
          [55, '结构基本完整，层次不够分明'],
          [40, '段落失衡或论证平铺'],
          [0, '结构混乱，不成篇章']
        ],
        evidence: [
          [85, '论据典型，例后分析与论点咬合紧密'],
          [70, '有论据且能分析'],
          [55, '论据或分析偏弱'],
          [40, '以例代证、素材堆砌'],
          [0, '缺乏论据，空泛说理']
        ],
        lang: [
          [85, '语言准确流畅，有论辩气势与文采'],
          [70, '语言通顺，偶有亮点'],
          [55, '基本通顺，表达偏平淡'],
          [40, '病句、口语或硬伤较多'],
          [0, '语言表达问题明显']
        ]
      };
      var arr = map[key];
      for (var i = 0; i < arr.length; i++) if (pct >= arr[i][0]) return arr[i][1];
      return arr[arr.length - 1][1];
    }

    var dims = [
      { key: 'content', name: '审题立意', score: pContent, max: 100, level: levelOf(pContent), tip: dimComment('content', pContent) },
      { key: 'struct', name: '论证层次', score: pStruct, max: 100, level: levelOf(pStruct), tip: dimComment('struct', pStruct) },
      { key: 'evidence', name: '论据分析', score: pEvidence, max: 100, level: levelOf(pEvidence), tip: dimComment('evidence', pEvidence) },
      { key: 'lang', name: '语言表达', score: pLang, max: 100, level: levelOf(pLang), tip: dimComment('lang', pLang) }
    ];

    /* ============ 八、字数建议 ============ */

    if (chars < 400) {
      addSug('wc', 'error', '字数严重不足（' + chars + ' / ' + target + '）',
        '不足 400 字按五类卷处理（结构完整至多 25-30 分）。先按八步提纲搭框架：引材料、界定概念、让步、质疑、深入、现实、做法、收束，每层写一段。');
    } else if (chars < 600) {
      addSug('wc', 'error', '字数不足（' + chars + ' / ' + target + '）',
        '不足 600 字原则上不超过四类。思辨文的篇幅主要花在“为什么”：补一段让步分析、一段对对立面边界的质疑、一段现实观照。');
    } else if (chars < 760) {
      addSug('wc', 'warn', '字数未达 800（' + chars + ' / ' + target + '）',
        '距 800 字还差约 ' + (target - chars) + ' 字，在档内会被酌情下调。最经济的扩充方式不是再加例子，而是给已有论据补分析、给观点补成立条件。');
    } else if (chars > 1300) {
      addSug('wc', 'tip', '篇幅明显超出（' + chars + ' 字）',
        '考场时间和答题纸有限，超 1200 字易出现后半程松散。建议删去重复论证，保留最有力的一例一析。');
    }

    /* ============ 九、优点 ============ */

    var praises = [];
    if (deviation.status === 'ok' && deviation.label === '审题契合') praises.push('紧扣材料核心概念写作，未见偏题');
    if (chars >= 800 && chars <= 1200) praises.push('字数 ' + chars + '，符合“不少于 800 字”要求');
    if (dialectic) praises.push('运用“让步—转折”展开辩证分析，具备二类以上作文的思维品质');
    if (defineN > 0) praises.push('对核心概念作了界定，立论有边界意识');
    if (depthN > 0) praises.push('能用“进一步/本质上”等把论证推向深入，层次分明');
    if (realityN > 0) praises.push('联系当下现实，文章有现实针对性');
    if (exampleGood) praises.push('事例之后有分析句，论据与论点咬合较紧');
    if (pn >= 5 && pn <= 8) praises.push('分成 ' + pn + ' 段，引论、本论、结论眉目清楚');
    if (quoteCount >= 1) praises.push('恰当引用 ' + quoteCount + ' 处，增强了说理的文化底蕴');
    if (rhetoricCount >= 2) praises.push('综合运用比喻、反问、排比等修辞，语言有气势');
    if (idiomHits.length >= 5) praises.push('使用成语 ' + idiomHits.length + ' 个，书面语汇较丰富');
    if (typoWords.length === 0 && epCount === 0 && deCount === 0 && chars > 300) praises.push('用字、标点规范，未见明显硬伤');
    if (thesisN > 0) praises.push('立场明确，中心论点在文中清晰可见');
    if (!praises.length && chars >= 400) praises.push('能够围绕一个话题写完整篇文章，结构基本完整');

    /* ============ 十、总评与兜底建议 ============ */

    var sugArr = Object.keys(sugs).map(function (k) {
      return { key: k, level: sugs[k].level, title: sugs[k].title, detail: sugs[k].detail };
    });
    var order = { error: 0, warn: 1, tip: 2 };
    sugArr.sort(function (a, b) { return order[a.level] - order[b.level]; });

    if (sugArr.length < 2) {
      var weakest = dims.slice().sort(function (a, b) { return a.score - b.score; })[0];
      var fb = {
        content: '审题立意还可加深：试着给材料中的核心概念下定义，并用“诚然……然而……”写出对立面的合理性与边界。',
        struct: '论证层次可以更分明：按“引材料—概念界定—让步—质疑—深入—现实—收束”重排段落，每层一段。',
        evidence: '论据要为论点服务：保留一个最贴切的事例，用“这说明……/之所以……是因为……”写出 2-3 句例后分析。',
        lang: '语言再打磨：出声朗读一遍，删去多余的“然后、的、了”，把长句拆短，用词再肯定一些。'
      };
      sugArr.push({ level: 'tip', title: '提升建议', detail: fb[weakest.key] });
      if (sugArr.length < 2) {
        sugArr.push({ level: 'tip', title: '冲击更高档', detail: '从三类到二类的关键是“辩证”，从二类到一类的关键是“条件分析与现实针对性”：观点在什么情境下成立、对当下的我们有何启示。' });
      }
    }

    var summary;
    var bandName = band.label;
    var devTxt = deviation.status === 'bad' ? '存在明显偏题风险，' :
      deviation.status === 'warn' ? '审题上有瑕疵，' : '';
    if (score >= 63) {
      summary = '这篇议论文 ' + chars + ' 字，属' + bandName + band.sub + '。' + devTxt +
        '文章能与材料充分对话，思辨层层深入，是冲击高分的苗子；建议在论据的新颖度与语言的锤炼上再进一步。';
    } else if (score >= 52) {
      summary = '这篇议论文 ' + chars + ' 字，属' + bandName + band.sub + '。' + devTxt +
        '文章有辩证意识、结构基本完整，主要短板在分析深度：请把“是什么”的陈述改成“为什么、在什么条件下”的追问，例后务必跟分析。';
    } else if (score >= 39) {
      summary = '这篇议论文 ' + chars + ' 字，属' + bandName + band.sub + '。' + devTxt +
        '立意基本成立但说服力不足，常见问题是只写一面、以例代证或重做法轻说理。先补出“让步—质疑”一段，再给每个事例补上分析句，可进入二类。';
    } else if (score >= 21) {
      summary = '这篇作文 ' + chars + ' 字，属' + bandName + band.sub + '。' + devTxt +
        '问题集中在审题与成篇：请回到题目材料，圈出核心概念和真正的问句，按八步提纲重写，并补足字数。';
    } else {
      summary = '这篇作文仅 ' + chars + ' 字，属' + bandName + band.sub + '。字数严重不足或脱离题意，建议先完成审题、列好提纲，写满 800 字再追求深度。';
    }

    /* 批注去重 */
    marks.sort(function (a, b) { return a.s - b.s || a.prio - b.prio; });
    var finalMarks = [], cursor = -1;
    marks.forEach(function (mk) {
      if (mk.s < cursor) return;
      finalMarks.push(mk);
      cursor = mk.e;
    });

    return {
      total: score,
      band: band,
      summary: summary,
      deviation: deviation,
      dims: dims,
      stats: stats,
      marks: finalMarks,
      logicReview: logicReview,
      rewrites: rewrites.slice(0, 8),
      paragraphAdvice: paraAdvice.slice(0, 8),
      suggestions: sugArr.slice(0, 10),
      praises: praises.slice(0, 6),
      title: title, type: type
    };
  }

  /* ---------------- 批注渲染 ---------------- */

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

  global.EssayEngine = { grade: grade, renderAnnotated: renderAnnotated, cjkLen: cjkLen };
})(window);
