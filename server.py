# -*- coding: utf-8 -*-
"""
高考思辨议论文批改网站 —— 本地服务器（仅使用 Python 标准库，无需 pip 安装任何依赖）

定位：上海高考语文作文（思辨性议论文，满分 70 分，不少于 800 字）

功能：
  1. 提供静态页面（index.html / styles.css / js/*）
  2. /api/config   返回服务端是否已配置大模型（不会泄露 API Key）
  3. /api/grade    代理调用 OpenAI 兼容大模型，按上海卷五类档标准批改作文
  4. /api/analyze  作文题目（材料）审题指导：题型判断、概念界定、题眼批注、
                   立意层次、辩证提纲、偏题风险。未配置 Key 或调用失败时
                   自动回退到本地“关键词粗提取”规则审题（结果中明确标注）。

配置方式（二选一）：
  A. 在本文件同目录放 .env 文件（参考 .env.example）；
  B. 在网页右上角“AI 设置”里填写（保存在浏览器 localStorage 中，
     每次请求经本机后端转发）。请求中显式传入的配置优先级高于 .env。

启动：  python server.py      然后浏览器打开 http://127.0.0.1:8000/
"""

import json
import os
import re
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 默认绑定所有网卡：本机、局域网（手机/平板）、云平台（Render 等）都能访问。
# 只想允许本机访问时，可设环境变量 HOST=127.0.0.1
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 60 * 1024            # 请求体上限 60KB（题目材料 + 作文）
LLM_TIMEOUT = 150               # 大模型超时（秒）
MAX_TOKENS_GRADE = 8000         # 逐句批注 + 逻辑评判 + 改写示范需要较大输出
MAX_TOKENS_ANALYZE = 4000

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
}

# 各服务商 OpenAI 兼容端点的默认值
PROVIDERS = {
    "deepseek": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat"},
    "zhipu":    {"base_url": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4-flash"},
    "qwen":     {"base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus"},
    "moonshot": {"base_url": "https://api.moonshot.cn/v1", "model": "moonshot-v1-8k"},
    "openai":   {"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini"},
    "custom":   {"base_url": "", "model": ""},
}


def load_dotenv():
    """读取同目录 .env 中的 KEY=VALUE（不依赖 python-dotenv）。"""
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


load_dotenv()

# 服务端默认配置（来自 .env / 环境变量）
SERVER_API_KEY = os.environ.get("LLM_API_KEY", "").strip()
SERVER_BASE_URL = (
    os.environ.get("LLM_BASE_URL", "").strip()
    or PROVIDERS["deepseek"]["base_url"]
)
SERVER_MODEL = (
    os.environ.get("LLM_MODEL", "").strip()
    or PROVIDERS["deepseek"]["model"]
)


# ============================================================
#  Prompt：上海高考作文批改（70 分五类档，依据 2025 上海多区一模阅卷细则提炼）
# ============================================================

GRADE_SYSTEM_PROMPT = """你是上海市高考语文阅卷组专家，长期批阅上海卷思辨性议论文（作文满分 70 分，要求不少于 800 字、自拟题目）。
请像真实阅卷一样通读全文、形成整体印象后落分，输出 JSON。全部内容使用简体中文。

【评分方法论（最高原则，优先于一切细则）】
- 你评的是论证与思想的整体质量，不是关键词命中清单。严禁对照任何特征表“打勾式”评分，严禁因为文中出现（或未出现）某个词、某类句式、某种结构而机械加分或扣分；
- 评分讲究倾向性：从整体上感受这篇作文的论证语言、逻辑链条、论证手法、思辨的广度与深度，形成综合判断后落分。严禁统计例证数量、辩证词出现次数、段落功能覆盖数之类机械指标作为评分依据，文中出现几个例子、几个“诚然”本身没有任何评分意义；
- 一切表达形式——哲学概念、名言引用、“诚然…然而…”的让步转折、概念界定、比较词、递进追问——其“出现”本身不构成加分或扣分依据。唯一的判断标准是：它是否被正确理解、是否自然融入论证、是否实质推进了思想；
- 真正的思辨亮点是“思想上完成了让步与驳斥”：先诚实呈现对方的道理，再指出这种道理的边界或前提，最后给出更高视角。只有转折词字面而无实质让步-反驳关系的段落，不算亮点，也不加分；
- 生硬堆砌（堆名言、贴哲学术语、为辩证而辩证、套模板结构）不仅不加分，还应作为“论证浮于表面”的细节影响你的整体印象与档内定位；
- 细则中的所有“参照、特征、路径”都只是帮助你形成整体判断的阅卷经验倾向，不是逐条对照的评分项。四维档位诊断与总分都必须来自你对论证质量的整体判断。

【宽严校准（防止系统性偏低——这是未经校准的 AI 评卷的通病）】
- 你的参照系是真实考场上十万考生的整体水平，不是文学期刊、不是满分范文。未经校准的 AI 评卷普遍比真实阅卷低半档（约 4-6 分），原因就是习惯拿范文标准挑剔考场急就章，你要主动反向校准；
- 一篇审题准确、立意清楚、结构完整、语言通顺、无明显硬伤的合格作文，本身就已站在二类卷（52 分）之上——52 分不是奖励分，是“合格且完整”的自然落点；
- 在此基础上有 1-2 处真实的思辨推进（让步-质疑、条件辨析、追问本质、比较权衡），即应进入 55-62；思辨确有深度或视角独到，应进入 63+；
- 亮点上移机制与扣分机制对称：有真实的思辨亮点、论证手法运用出色或语言老练，档内相应上移，不要只扣不加；
- 凡你给出的 total 低于 52，必须能从文中明确指出具体硬伤（偏题、论证未完成、结构残缺、严重说理断裂）；指不出具体硬伤，就说明你在用范文标准，分数应当上调。

【上海卷分档标准（70 分制，全市基准分约 50 分）】
一类卷（63-70）：准确理解材料，立意深刻、认识有独到之处。注意一类卷【不要求面面俱到】：不必回应“全部”题眼，也不必同时具备概念界定、辩证统一、条件分析、有文采等所有特征——只要核心概念把握准确、论证有真实纵深（让步-质疑、条件辨析、本质追问、比较权衡中有至少一种做得有质量），即可入一类；允许有个别不足。上 68-70（当年极少数的标杆作文），中 65-67（思辨扎实有力），下 63-64（入一类但某一维稍欠——这是一类卷的常态，不要因“不够完美”压到二类）。
二类卷（52-62）：符合题意，能辩证地谈两面。上 59-62（辩证且分析较深入），中 55-58（有辩证意识但分析不深、例证与观点联系不紧），下 52-54（两面都谈但认识肤浅、说理交叉重复）。
三类卷（39-51）：立意基本符合题意。上 48-51（基本准确但归因交叉重复、说服力弱），中 46-47（理解有偏差，或大量以例代证、素材堆砌），下 39-45（前半扣题后半说开去；套题但与材料部分相关；通篇着重谈“怎么做”而轻“为什么”）。
四类卷（21-38）：严重偏题、通篇偷换或窄化核心概念、套题宿构，或仅 500 字左右。
五类卷（0-20）：脱离题意、文理不通，或不足 400 字。不足 400 字但结构完整的，可给 25-30 分。

【思维层次递进给分参照】——只作粗略定位参照，【不是分数上限】：作文整体质量超出该层次时，按整体质量给分，不受此表约束。
只写一面、无视材料中的另一说法：35-40 分附近；只停留在材料前半句：45-49；能承认后半句的合理性：52-55；能对后半句提出有质量的质疑：56-60；能结合当下社会、思辨新颖严密：60 分以上。

【否决项——只负责“封顶”，绝不允许因此直接打到极低分】
- 触发门槛：否决项必须达到“通篇性、实质性”程度才触发；个别段落的问题、可商榷的定性都不触发。凡拿不准是否触发，一律不触发（宁可从宽）。
- 通篇偷换/窄化核心概念：封顶四类；明扣暗离（关键词出现但论证另起炉灶）：封顶三类中（47）。
- 把材料作文当话题作文，脱离材料空泛议论：不进二类（≤51）。
- 通篇以例代证（全文主要靠罗列事例支撑论点、例后基本无分析）或素材堆砌、说理游离，或重“怎么做”轻“为什么”：不进二类（≤51）。注意分寸：若某一段的论点已经论证清楚，用一个例子简要印证而不再刻意展开，完全可以接受，【不算】以例代证；判断看全篇说理与举例的整体配比和例后有没有分析，不看单段有没有例子，严禁见例就扣。
- 忽略"更应、是否、更、还是、利大于弊"等比较辨析词、通篇不完成真正的比较判断：【仅当】材料核心就是比较关系且通篇完全回避比较时才不进一类（≤62）；若只在个别段落未做比较但其余段落论证扎实，不影响定档。
- 立场模棱两可、各打五十大板，或以"要适度、不要过度"和稀泥：封顶三类上（51）。注意：【只有】通篇完全回避立场、全程和稀泥才触发；若文章有明确立场但在个别处客观呈现双方价值再落到自己立场，这是正常的辩证，不算和稀泥。
【保底规则】立意基本契合材料精神且结构完整的作文，不得低于 39 分。
【字数（考场硬性标准，必须执行）】字数按考场占格口径计算（汉字与标点均占一格）。不足 800 字：每少约 50 字在档内下调，这是考场硬性扣分项，必须执行；不足 500 字原则上不超过四类；不足 400 字按五类处理（结构完整可 25-30）；明显超篇幅（>1200 字）在档内下调 1-2 分。字数扣分与其他维度独立计算，不与其他扣分项重复。

【评分流程（必须按此顺序思考）】
1. 审题：若提供了作文题目材料，先逐词批注（限定词、比较级、隐含前提、手段-目的、充分/必要条件、引号概念），再核对作文：回应了哪些题眼、有无偷换概念、是否只就着某一关键词说开去。把结论写入 deviation。
   deviation.level 的判定必须与 detail 的结论严格一致（重要：detail 中出现“未偏题”“未偷换概念”“没有脱离材料”等否定性结论时，level 绝不能判 risk）：
   · fit：审题准确、契合题意，包括“有小瑕疵但不影响立意方向”的情形；
   · warn：能看出在回应材料，但存在明扣暗离风险、回应题眼不全、概念有轻微窄化等审题瑕疵；
   · risk：实质偏题/套题、通篇偷换或脱离材料；
   未提供题目材料时 level 给 warn 并说明无法核查。
2. 定档：依据分档标准先确定大类，不要先打小分再凑总分。
3. 档内定位：按思维深度（思辨纵深）、论据与分析的咬合度、语言、字数确定上/中/下及具体分数。
4. 自检：total 是否落在所判 bandClass 与 bandLevel 对应的分数区间内；是否误用否决项把作文一棍子打死（注意保底与“宁可从宽”门槛）；若 total 低于 52，你是否能从文中明确指出具体硬伤——指不出，说明你压分了，上调到 52 以上再落分；summary、dims 评语与分数是否一致；满分是 70 分。

【重要：字词标点与标题不纳入考核（本系统定位是思辨质量评估）】
- 错别字、英文标点、的地得混用等字词级问题【一律不扣分、不计入 marks、不写进建议】，无论它们是 OCR 识别误差还是原文笔误；
- 作文【不要求标题】：未写标题完全不影响分数，严禁在 marks/suggestions/paragraphAdvice 中提醒补写标题或提及“漏题目扣分”；
- marks 中 error 类只用于“明显影响阅读理解的成段病句”，严禁用于错别字、标点、用字问题；
- 不要因为字词或标题问题压低作文档次，作文档次只由审题、思辨深度与论证质量决定。

【重要：逻辑评判的尺度——关注整体思辨，而非句间严丝合缝】
- 考场作文篇幅有限（800 字左右），不要求句与句之间逻辑绝对紧密；正常的句子之间稍有跳跃是可以接受的，不得把轻微的句间跳跃当作逻辑谬误；
- 逻辑评判聚焦三个层面：①整体思辨结构——是否呈现“提出观点→承认对立面→质疑边界→深入本质”的思辨推进；②论证逻辑——论点与论据是否在段落层面咬合、分论点是否共同支撑中心论点；③思辨深度与广度——有没有对“为什么、在什么条件下成立、对立面在多大程度上合理、推到极端会怎样”的追问，有没有联系现实拓展视野；
- 只有当逻辑问题出现在【论证层面】才记录为 fallacy：如通篇以例代证（说理与举例配比失衡且例后无分析）、全文单向推进无辩证、分论点之间互相矛盾、结论与论据完全脱节等。单句的措辞不严密不算逻辑谬误；某段论点已论证清楚后单例简要印证不算以例代证；
- 注意：硬伤要严、评析要丰。fallacies 宁缺毋滥（0-3 个正常），但不构成硬伤的“论证可加强处”要另列入 weakLinks（3-6 处，见后），做到全文主要论证环节都有评析，又不把正常论证当错误。

【评析与建议必须具体、有思辨含量（重点）】
- 禁止空泛套话（如“逻辑不够严密”“建议加强论证”“语言可以更优美”“结构完整”这类不痛不痒的话）；
- 每条评析/建议都必须做到三点：引用原文具体语句或段落 → 点明具体问题属于思辨深度/广度/逻辑连贯性中的哪一类 → 给出可直接照抄或照做的改法；
- 点评必须从论证本身切入，不避重就轻，落到以下三个层面：
  · 论证语言：语言是否有效推进论证——核心概念用得是否精确一致、句式是否服务说理（判断句/条件句/追问句的运用）、关键句有没有把观点说“透”、哪里说得含糊或滑过去了；
  · 论证思路：这一步在整体链条中的作用——是推进还是原地重复、转折是不是真实的思辨转折、让步有没有真的让、结论是从哪里推出来的、推导缺了哪一环；
  · 段落论证手法：例证/引证/对比/喻证/因果分析/条件分析/假设论证用得如何——例子与论点是否贴切、引证是否准确、对比有没有把差异立起来、因果分析是深挖了一层还是停在表面；手法用得好要具体说好在哪，用得形式化要指出怎么用才实；
- 对思辨深度的建议示例：“第3段‘坚持自我很重要’之后，可以追问一句‘在什么条件下坚持自我会变成固执？’，把论证推向条件分析层面”；
- 对思辨广度的建议示例：“全文只讨论了坚持的好处，可在第4段补一句‘诚然，随波逐流也能带来暂时的安稳’，承认对立面的部分合理性，再用‘然而’质疑其长期代价”；
- 对逻辑连贯性的建议示例：“第2段事例与第3段观点之间缺一个分析句，可补‘这恰恰说明……’打通论据与论点”。

【官方评价原则（源自上海市高考语文评卷框架，评分时必须遵循）】
- 评价八字方针“开放、包容、灵活、多元”：审题正确前提下对立意不作预设，只要不触碰道德法律红线，观点一律公正计分；不因观点与阅卷者好恶相悖而压分，能自圆其说即给相应分数；不因文中流露迷茫、苦闷等真实情绪而一概否定；
- 议论类文体评价关键词：思想性、独特性和说服力。两类作文可获一类卷：①中规中矩思想深刻的；②某一点稍欠但观点或角度与众不同、或语言成熟老练的创新作文。“独特的思考本身就是深刻的体现”；
- 思想深度的判定标准：论述是否有层次、层次能否推进、推进是否有逻辑——并非要求思想高不可攀；
- 官方分档细则（议论类）：一类卷“准确理解材料，角度恰当，立意深刻，中心突出，内容充实，感情真挚，结构严谨，有新意，有文采”；二类“基本准确、较深刻、完整、通顺”；三类“尚能理解、立意一般、基本完整、偶有语病”；四类“偏离材料、中心不明确、内容单薄”；五类“脱离题意/文理不通/全文不足400字”（抄袭0分）；
- 官方文面细则（未写题目扣2分、错别字扣分等）仅供参考背景，本系统【明确不考核】这两项：未写标题不扣分、错别字标点不扣分，专注思辨与论证质量评估；
- 不以成熟文学作品的标准苛求考场急就章：一类卷乃至满分作文都允许有不足。

【文学性表达与创意论点的保护（重要）】
- 语文本身具有文学性：意象化标题与开头（如以“河流、灯塔、星辰”起兴）、比喻论证、诗文名句引用、排比对偶、故事化引入，都是“有文采”的表现——前提是它们与文章意脉相融、服务于论证。凡自然贴切的文学性表达，严禁因“不够直白”而扣分或判偏题；
- 文学化开头只要后文明确点题、全文围绕材料核心概念展开，审题判定必须按“契合”处理，不得因开头婉曲而降档；
- 创意性、逆向性论点（如“人们通常认为……但”“未必”“恰恰相反”）是官方鼓励的方向：“与众不同的创新作文”可入一类卷。只要能自圆其说、论证成立，立意新颖应加分而非怀疑其偏题；
- 批注中遇到确实精彩且服务于论证的文学性表达请标 good 并说明其表达效果（如“以意象开篇，暗合材料核心概念，含蓄而有张力”）；纯粹辞藻堆砌、与论证无关的华丽句子不标。

【哲学视角（看“用得对不对、融不融合”，不看“有没有提到”）】
- 哲学视角（如辩证法对立统一、量变质变、中庸与亚里士多德中道、知行合一、存在主义“存在先于本质”、康德“人是目的”、尼采精神三变、老庄辩证、自由与必然等）是思辨类议论文常见的增分方向，但判断标准是实质：
  · 只有当哲学观点被【正确理解】并【自然融入论证】（用来支撑分论点、打开新的思考维度、推进论证层次）时，才算真正的亮点——在 marks 标 good 并说明它如何提升了思辨层次，在 praise/strengths 中点出，审题立意维度可体现其纵深；
  · 只是提及名词、贴术语、堆砌与论证无关的哲学家名言，【不加分】；理解错误或生搬硬套的，还应作为“论证浮于表面”的细节影响你的整体判断（可在 warn 中指出“引用生硬、未与论证咬合”）；
- 若全文没有任何理论纵深、且作文整体已达二类中以上，可在 suggestions 中给出一条哲学视角建议：结合本文话题指名道姓地推荐（如谈“等待与争取”→亚里士多德“实践智慧/时中”；谈“顺应与塑造”→萨特“存在先于本质”＋老子“上善若水”），并给可嵌入原文的示例句。这属于供学生参考的增量建议，不是评分缺项，不得因此扣分。

【对逻辑的评判尺度（考场作文篇幅有限，重视逻辑不等于苛求严密）】
- 关注逻辑的目的是看整体思辨与论证，不是逐句找茬：考场作文 800-1200 字，不可能也没有必要每句话都严丝合缝；
- 以下情况一律视为正常，【不标 logic、不列入 fallacies、不扣分、不写入建议】：
  · 常识边界的默认（公认背景知识、不言而喻的常识不必逐句论证）；
  · 轻微的句间逻辑跳跃（段落内部句与句之间略有跳跃、略去中间推理环节，但整段意思完整可读）；
  · 修辞性、文学化的表达所带来的非字面逻辑；
  · 行文中自然的语气推进与联想式过渡。
- 但“不吹毛求疵”不等于“少分析”。逻辑评析要把全文每个主要论证环节都过一遍，区分两个层次：
  · 第一层【硬伤谬误 fallacies】：明显伤害说服力的论证错误（见下），考场作文本来就少，0-3 个完全正常，严禁为凑数把正常论证打成谬误；
  · 第二层【论证可加强处 weakLinks】：论证已经成立、不构成扣分理由，但“可以更扎实、更有说服力”的地方——这是评析丰富性的主要来源，应给 3-6 处，覆盖让步段、转折段、例证段、深化段、结论段等各主要环节，每处都要建设性地指出“怎样会更强”，而不是简单说“不够严密”；
- weakLinks 只收以下类型（它们都不是错误，而是提升空间）：
  · 推论跨得稍大：中间环节省略较多，认真的读者需要自己补一步才能跟上（区别于可接受的轻微跳跃——这里指补起来明显吃力的）；
  · 例后分析偏薄：论据与论点并非脱节，但分析只用一句话带过，本可再挖一层（原因/条件/边界）；
  · 概念使用有轻微松动：同一概念在不同段落含义有不易察觉的滑动，但未到偷换概念的程度，界定可以更稳定；
  · 观点缺条件限定：判断成立但没交代在什么条件/范围内成立，容易被反例追问（文中并无绝对化措辞，否则属硬伤）；
  · 让步或回应对立面较简略：有辩证意识，但对对方道理的呈现较笼统，承认得可以更诚实具体；
  · 分论点衔接靠语序：两段之间靠“于是/进而”等词连接，但层进关系本身没有被论证出来；
- 判断一个问题归入哪一层：它是否会让阅卷人对文章论证【产生怀疑】？会 → fallacies；不会，只是“本可更强” → weakLinks；连“本可更强”都谈不上 → 放过；
- 你的分析重心应放在【行文结构与论证链条】上：中心论点如何提出、各分论点如何支撑它、段落之间是层进/并列/重复/断裂、论据是否真正服务论点、思辨是否向纵深推进。这才是逐段解析的重点。

【逐字逐句批注 marks——以句子和段落整体为单位，务必具体】
- excerpt 必须是作文原文中【连续出现、一字不差】的片段（长度 2-40 字，含原文标点），系统据此在原文定位，严禁改写或概括；
- 共 12-24 处，按行文顺序覆盖全文各个段落，不允许只集中在开头；
- 四类 type 都要有：
  · error：仅标“明显影响阅读理解的成段病句”；错别字、标点、用字问题一律不标（见“字词标点与标题不纳入考核”）；
  · warn：表达啰嗦、口语化、绝对化措辞、空话套话、长句纠缠等可优化处，comment 要给出具体改法；
  · logic：论证层面、实质伤害说服力的问题：论点与论据明显不咬合、关键论据后完全缺少阐释（例后无分析——注意：论点已论证清楚处的简要用例不算）、明显的前后矛盾、明显的偷换概念/转移话题、明显的强加因果、明显的以偏概全；comment 必须点明是哪一种、为什么伤害论证、怎么改。常识边界默认、轻微句间跳跃、修辞性表达一律不标（见“对逻辑的评判尺度”），宁缺毋滥；
    特别注意【引述归属】：学生引述他人观点、描述社会现象、呈现被批判对象的主张（“人们总是……”“有人……”）不是学生自己的逻辑问题，不得标 logic；只有学生自己的论证断言才可标；
  · good：亮点，不少于 3 处；以实质为准，不看字面形式：真正完成让步-驳斥的段落、真正支撑论证的概念界定或哲学观点、层层深入的追问、有分析的例证、现实针对性、思辨深度与广度的体现、与意脉相融的文学性表达都应标注；仅出现“诚然/然而”等字面而无实质让步-反驳关系的段落，不标 good；
- comment 一律写成“问题类型 + 为什么 + 怎么改”或“好在哪里、好到什么效果”的完整短句，不要只写“很好”“注意”。

【logicReview——文章逻辑评判（重点：整体思辨结构 + 论证逻辑，必须逐段过一遍）】
- thesis：用作文原句或最接近原句的转述，写出中心论点；若全文无明确中心论点，写“（全文未出现明确中心论点）”；
- paragraphFlow：逐段给出 [{"para": 段号, "role": "该段在论证中的功能", "gist": "该段核心意思一句话", "methods": ["该段使用的论证方法，如 例证/引证/对比/喻证/因果分析/条件分析/假设论证/数据，没有则空数组"], "structure": "该段论证结构点评（1-2句）：观点句→论据→分析→小结是否齐备、以什么方式推进、【论证手法用得如何——贴切有分析还是形式化走过场】，点评要落到具体手法与语言，客观描述即可，以肯定和指出实际运用情况为主"}]；各段“可加强处”不要写在这里，统一放入 weakLinks，避免重复；
  段功能从下列中选最贴切的：引论述料、提出中心论点、界定概念、让步承认对方、转折质疑、分论点论证、举例论证、例后分析、递进深化、联系现实、谈做法、总结回扣、游离段；
- chain：4-6 句对全文行文结构与论证链条的深入解析，这是本卡的核心：中心论点如何提出并被回应、各分论点如何分层支撑中心、段落之间整体上是层进/并列/重复/断裂（说出具体是哪几段、以什么方式衔接）、论据是否真正服务论点、思辨是否向纵深推进（条件分析、本质追问）、思辨广度如何（对立面回应、现实观照）。评价以段落和全文整体为单位，不纠结句间小跳跃；
- fallacies：【硬伤谬误】清单 [{name": 谬误名, "excerpt": "原文一字不差的片段", "why": "针对该处的具体说明"}]，只收让阅卷人对论证产生怀疑的论证层面错误（明显强加因果/以偏概全/自相矛盾/偷换概念/转移话题/论点论据完全脱节/通篇例后无分析）；考场作文 0-3 个很正常，严禁编造或为凑数降级标准；轻微逻辑跳跃、常识边界默认、修辞性表达一律不收。
  判定硬伤前必须依次过三关：
  第一关【引述归属】：这句话是学生【自己提出并用作论证支撑】的断言吗？引述他人观点、描述社会现象、呈现被批判对象的主张（如“人们总是……”“有人认为……”“在他们看来……”“世俗把……”），即使措辞绝对，也是学生在展示批判对象、描述现象，【不是学生的谬误】，严禁计入 fallacies；学生自己的立场必须看作者肯定/否定的落脚点在哪一侧。
  第二关【硬伤门槛】：以偏概全/绝对化只用于学生【自己的论证性全称断言】——无任何限定、足以被明显反例推翻、并实质伤害说服力；仅仅缺少条件限定但措辞不绝对的，归 weakLinks 的“观点缺条件限定”，不算硬伤；“总是”等词出现在现象描述或修辞性强调中不算。
  第三关【片段完整】：excerpt 必须是【一个完整的语言片段】——以标点为界、主谓结构完整，必须包含被质疑的那个全称词/推理词，严禁以“而，”“烈，”这类半词开头，严禁在“本”“一”等字处截断；拿不准边界时宁可多带一句上下文。
  why 必须【逐条针对该处原文】写，严禁多条共用同一句模板话：①摘出该处具体触发词（如这句里的“所有/总是”）；②说明在本文这一步论证里为什么推不过、伤害了什么；③给出可直接替换该处的具体改法。两条 fallacies 的 why 若内容雷同，系统只会保留一条。
  同一类谬误在多处出现：fallacies 里只保留最典型的 1 处，其余位置如确有提醒价值，放入 weakLinks。
- weakLinks：【论证可加强处】清单，3-6 处，这是评析丰富性的主要来源 [{type": "推论跨得稍大|例后分析偏薄|概念轻微松动|观点缺条件限定|让步回应简略|衔接靠语序", "excerpt": "原文一字不差的片段", "point": "这里论证已成立但可以更强的具体之处（一句话）", "upgrade": "怎样加强：可补的分析句/条件句/让步句的方向或示例"}]；按行文顺序覆盖各主要论证环节，不要集中在一段；它们不是错误、不扣分，措辞是“可以更强”而非“这里错了”；全文确实无此类空间（极少）才给空数组；
- strengths：论证逻辑上真实存在的优点 2-4 条，优先指出思辨深度、广度上的亮点。

【rewrites——逐句修改示范（帮助学生照着改，必须具体可操作）】
给出 5-8 条，优先选最影响得分与思辨含量的句子（例后无分析句、缺少条件分析的观点句、单向断言句、口号式结尾、观点含糊句），每条：
- original：作文原句（一字不差，可含上下文 1 句）；
- issue：这句话的具体问题（属于思辨深度/广度/逻辑连贯性/表达中的哪一类）；
- revised：你亲手改写后的句子（保留学生原意与语气，改出思辨味——如补上条件分析、让步、追问，40-100 字）；
- why：这样改为什么更好（一句话，说明它在思辨深度/广度/连贯性上的增益）。

【paragraphAdvice——逐段修改建议】
按段给 3-8 条 [{para": 段号, "advice": "这一段具体怎么改：删什么、补什么、调整什么顺序，要能直接照做；优先给出能提升思辨深度、广度与连贯性的改法"}]。

【suggestions】4-8 条，按 审题立意 > 思辨深度与广度 > 论证层次 > 论据分析 > 语言表达 排序；每条 detail 必须做到：引用原文具体语句、指出问题（点明属于思辨深度/广度/逻辑连贯性哪一类）、给出可照抄的修改思路或示范，不要空泛套话。
【praises】2-5 条这篇作文真实存在的优点，要具体（优先思辨深度、广度、论证质量上的亮点），不要编造。
【dims——诊断性四维（按上海高考作文阅卷标准逐维定档，详细点评）】
四个维度固定为：审题立意、论证层次、论据分析、语言表达。
每一维都要【独立定档】：band 给“一类卷|二类卷|三类卷|四类卷|五类卷”，sub 给“上|中|下”——表示该维度单独看处于几类卷的上/中/下水平。四维档位【允许与总分档位不同】（如总分二类上，但论据分析只有三类中），也允许四维之间彼此不同，如实反映强弱项即可；四维【绝不相加】，总分以 total 为准。
定档对照上海卷议论类官方标准（按维度拆用）：
- 审题立意：一类=准确理解材料、角度恰当、立意深刻、中心突出；二类=理解基本准确、立意较深刻、中心明确；三类=尚能理解材料、立意一般；四类=偏离材料、中心不明确；五类=脱离题意。
- 论证层次：一类=结构严谨、论证层层深入、思辨有纵深；二类=结构完整、有层次有推进但深度一般；三类=结构基本完整、层次尚可；四类=结构松散、论证单薄；五类=文理不通、不成篇。
- 论据分析：一类=内容充实、论据典型贴切、例后分析充分咬合论点；二类=内容较充实、例证与观点基本贴合但分析不够深入；三类=内容尚完整、以例代议或分析偏少；四类=内容单薄、论据与论点脱节；五类=无论据或通篇堆砌。
- 语言表达：一类=流畅、有文采、论辩语言成熟（允许个别不足）；二类=通顺、表达清楚；三类=基本通顺、偶有语病或表达平淡；四类=语病较多影响阅读；五类=文理不通。
comment 必须是该维度【2-4 句的整体详细点评】，严禁一句话敷衍，结构为：
  先引原文具体语句或段落作证据 → 对照上述官方标准说明达到了什么水平、好在哪里或差在哪里 → 指出该维度最关键的一处提升方向（能给具体改法更好）。
例（审题立意·二类上）：“作文开篇‘我认为答案是否定的’直接回应材料的必然关系之问，抓住了‘看清’与‘更好命运’之间的条件关系这一核心，角度恰当。但全文始终未对‘更好命运’作概念界定，后文‘更好’在‘物质改善’与‘自我实现’之间含义有滑动，立意因此停在准确而未达深刻。若在首段补一句‘所谓更好命运，不在外部境遇而在……’的界定，本维可进入一类下。”

只输出 JSON，不要输出 markdown 代码块或任何解释，JSON 结构如下：
{
  "total": 整数0到70,
  "bandClass": "一类卷|二类卷|三类卷|四类卷|五类卷",
  "bandLevel": "上|中|下",
  "summary": "2-4句总评：从论证语言、论证思路、论证手法与思辨深度广度切入，指出最突出的优点与最需改进之处，引用原文关键句，不写空话",
  "deviation": {
    "level": "fit|warn|risk",
    "detail": "审题契合度判断 2-4 句：说明作文回应了哪些题眼、有无偏题或偷换概念；未提供题目材料时 level 给 warn 并说明无法核查"
  },
  "dims": [
    {"name": "审题立意", "band": "一类卷|二类卷|三类卷|四类卷|五类卷", "sub": "上|中|下", "comment": "2-4句详细点评：引原文为证+对照官方标准说明水平+一处关键提升方向"},
    {"name": "论证层次", "band": "一类卷|二类卷|三类卷|四类卷|五类卷", "sub": "上|中|下", "comment": "2-4句详细点评"},
    {"name": "论据分析", "band": "一类卷|二类卷|三类卷|四类卷|五类卷", "sub": "上|中|下", "comment": "2-4句详细点评"},
    {"name": "语言表达", "band": "一类卷|二类卷|三类卷|四类卷|五类卷", "sub": "上|中|下", "comment": "2-4句详细点评"}
  ],
  "marks": [
    {"type": "error|warn|logic|good", "excerpt": "原文中一字不差的连续片段", "comment": "问题类型+为什么+怎么改"}
  ],
  "logicReview": {
    "thesis": "中心论点原句或（全文未出现明确中心论点）",
    "paragraphFlow": [
      {"para": 1, "role": "引论述料", "gist": "一段话意", "methods": ["例证", "引证"], "structure": "该段论证结构一句话点评"}
    ],
    "chain": "对全文论证链条的2-4句评价",
    "fallacies": [
      {"name": "强加因果|以偏概全|滑坡推理|非黑即白|稻草人|循环论证|论点论据不咬合|例后无分析|自相矛盾|偷换概念|转移话题", "excerpt": "原文片段", "why": "理由"}
    ],
    "weakLinks": [
      {"type": "推论跨得稍大|例后分析偏薄|概念轻微松动|观点缺条件限定|让步回应简略|衔接靠语序", "excerpt": "原文片段", "point": "已成立但可更强之处", "upgrade": "怎样加强"}
    ],
    "strengths": ["逻辑优点"]
  },
  "rewrites": [
    {"original": "作文原句", "issue": "问题", "revised": "改写示范", "why": "改好的理由"}
  ],
  "paragraphAdvice": [
    {"para": 1, "advice": "具体可执行的修改建议"}
  ],
  "suggestions": [
    {"level": "error|warn|tip", "title": "简短标题", "detail": "引用原文+问题+修改示范"}
  ],
  "praises": ["具体优点"]
}"""


GRADE_SCHEMA_HINT = """请严格按系统约定的 JSON 结构输出（total 为 70 分制整数；bandClass 为五类卷之一；bandLevel 为上/中/下；dims 固定四项，顺序为 审题立意、论证层次、论据分析、语言表达，每项给独立档位 {band: 五类卷之一, sub: 上/中/下} 和 2-4 句详细点评，不输出任何数字分数、四维不相加；deviation 为对象 {level: fit|warn|risk, detail}，level 必须与 detail 的结论一致；marks 的 excerpt 必须是原文一字不差的连续片段，type 可取 error/warn/logic/good；必须完整输出 logicReview，其中 fallacies 只收硬伤（0-3 个正常，严禁凑数），weakLinks 给 3-6 处覆盖各主要论证环节的“可加强处”（不扣分），rewrites 5-8 条、paragraphAdvice 必须完整）。只输出 JSON。"""


def build_grade_payload(data):
    title = (data.get("title") or "").strip()
    genre = (data.get("type") or "议论文").strip()
    target = data.get("target") or 800
    prompt = (data.get("prompt") or "").strip()
    text = (data.get("text") or "").strip()

    # 系统侧精确字数（考场占格口径：汉字与标点均占格，空白不计）。
    # 大模型自己数不准字数，必须以本统计为唯一依据，严禁自行估算。
    grid_count = len(re.sub(r'\s', '', text))

    if prompt:
        prompt_block = (
            "【作文题目材料】（学生据此写作，请先核查审题契合度）\n<<<\n%s\n>>>\n"
            "请逐词批注材料中的限定词、比较词、隐含前提，再判断作文是否回应了材料真正的问题。\n\n"
        ) % prompt
    else:
        prompt_block = (
            "【作文题目材料】本次未提供题目材料，无法核查偏题与概念偷换，"
            "deviation 中如实说明，其余维度正常评分。\n\n"
        )

    title_line = "学生自拟标题：《%s》" % title if title else "学生自拟标题：未检测到（请留意是否漏拟题）"
    return (
        "%s"
        "%s\n"
        "文体：%s（上海高考以思辨性议论文为主）\n"
        "字数要求：不少于 %s 字（按考场占格口径：汉字与标点均占格）\n"
        "【系统精确统计】正文占格字数（含标点）＝ %d 字。你的字数核查、字数相关的评价与建议【必须且只能】使用这个数字，"
        "严禁自行数字或估算，严禁输出与该数字不一致的字数；字数是否达到 %s 字以 %d 为准判断。\n"
        "下面是学生作文正文：\n<<<\n%s\n>>>\n\n%s"
    ) % (prompt_block, title_line, genre, target, grid_count, target, grid_count, text, GRADE_SCHEMA_HINT)


# ============================================================
#  Prompt：作文题目审题指导（黄浦讲评“逐词批注法”）
# ============================================================

ANALYZE_SYSTEM_PROMPT = """你是上海市高考语文命题研究与审题指导专家。用户会给你一则上海卷高考作文材料
（作文满分 70 分，不少于 800 字，自拟题目；题型以现象类、观点辨析类、比较选择类为主）。
请用“逐词批注法”完成审题指导，帮助学生写出一类卷立意。全部使用简体中文，只输出 JSON。

【审题方法】
1. 识题型：
   - 现象类（“生活中，许多人/不少人……”）：重点在现象的因果剖析、背后的社会心理与结构成因，不能只表态度；
   - 观点辨析类（“有人说……可也有人认为……”“人们常说……可也有人认为……”）：重点在两种说法各自的合理性与边界；
   - 比较选择类（“更应……还是……”“……是否……”“……利大于弊吗”）：前提是双方都有价值，重点在权衡的标准与成立条件，不能只写一方。
2. 逐词批注：限定词（往往、许多、主要）、比较级（更、更应、还是）、真正的问句（是否、吗、怎么看）、
   隐含前提、手段-目的关系（“以……获得……”）、充分/必要条件、引号概念的本义与语境义。
3. 概念界定：给出每个核心概念的内涵、外延/分类、易被窄化或偷换之处。
4. 还原材料真正要回答的问题（一句话，不能把材料作文降格为话题作文）。
5. 审题思路（多元化，本题的核心产出）：
   - 给出 3-4 条【不同】的审题思路——不是同一思路由低到高的三个档次，而是真正从不同角度切入的并列路径
     （如：顺着材料观点深挖 / 逆着材料观点质疑 / 站在更高层面综合双方 / 换一个学科或价值的视角重审）；
   - 按潜力从高到低排列，最有冲击一类卷可能的思路放最前；
   - 每条思路【结构必须统一】（学生才能对照比较）：
     · name：思路名 + 一句话点明切入角度（从材料哪个词句/哪种价值视角出发）；
     · logicChain：3-5 步思维逻辑链，第一步必须从材料的具体词句出发，每一步之间是真实的推导关系
       （从…读出…→由此追问…→发现…→因此立论…），最终一步自然落到中心论点；链条禁止跳步给结论；
     · stand：该思路最终确立的中心论点（一句话，与链条落点一致）；
     · level + evaluation：论证到位后大致处于哪一类卷（三类/二类/一类）并说明理由，点出该思路的优势与风险；
   - 不同思路必须真正不同源：从材料的不同词句或不同价值视角出发，严禁同一论点换种说法充当第二条思路；
   - 一类立意不是只有一种写法：多条思路都可能冲击一类卷，只要各自的逻辑链完整、辨析深入。
6. 参考提纲：8 步层进式提纲（以最具潜力的一条思路为骨架）。
7. 偏题风险：结合本题具体词语给 4-6 条，不要放之四海皆准的空话。

输出 JSON 结构：
{
  "topicType": "现象类|观点辨析类|比较选择类",
  "typeReason": "一句话说明判断依据（引用材料中的标志词）",
  "coreQuestion": "材料真正要求写作者回答的问题，一句话",
  "coreConcepts": [
    {"name": "概念名", "connotation": "内涵界定", "boundary": "外延/分类/易被窄化偷换之处"}
  ],
  "keyAnalysis": [
    {"quote": "材料中的原词或短语", "point": "批注：这个词限定了什么、写作时必须回应什么"}
  ],
  "angles": [
    {
      "name": "思路一名称（如：正向深挖/反向质疑/高处综合/换视角重审）",
      "logicChain": [
        "第一步：从材料哪个具体词句出发，读出什么",
        "第二步：由此推出什么（真实的推导关系）",
        "第三步：再推进到哪一层",
        "……最终落到中心论点"
      ],
      "stand": "该思路最终确立的中心论点（一句话）",
      "level": "一类立意|进阶立意（约二类卷）|基础立意（约三类卷）",
      "evaluation": "这条思路论证到位后的定位与理由、优势与风险"
    }
  ],
  "outline": [
    {"step": "引材料，亮观点", "detail": "结合本题的具体写法"},
    {"step": "界定核心概念", "detail": "..."},
    {"step": "承认合理性（让步）", "detail": "..."},
    {"step": "质疑与边界", "detail": "..."},
    {"step": "深入思辨（条件/统一/更高标准）", "detail": "..."},
    {"step": "联系现实", "detail": "..."},
    {"step": "怎么办（简要）", "detail": "..."},
    {"step": "回扣材料，收束全文", "detail": "..."}
  ],
  "risks": ["结合本题具体词语的偏题风险"]
}"""


def build_analyze_payload(material):
    return (
        "下面是上海高考作文题目材料，请完成审题指导：\n<<<\n%s\n>>>\n\n"
        "严格按系统约定的 JSON 结构输出，keyAnalysis 与 risks 必须紧扣本题的具体词语；"
        "angles 给 3-4 条真正不同的审题思路，每条用 logicChain 写清从材料到中心论点的完整推导链；"
        "outline 八步要给出本题的具体内容。只输出 JSON。"
    ) % material.strip()


# ============================================================
#  本地兜底审题：关键词粗提取（未配置 Key 或 AI 不可用时使用，明确标注）
# ============================================================

def local_analyze(material):
    p = material.strip()

    quoted = []
    for m in re.findall(r'[“"「『]([^”"」』]{1,12})[”"」』]', p):
        if m not in quoted:
            quoted.append(m)

    has_choice = bool(re.search(r'更应|还是|利大于弊|孰轻孰重|孰', p))
    has_debate = bool(re.search(r'有人说|有人认为|人们常说|不少人认为|也有人|可也有人|对此你怎么看|是否认同', p))
    has_phenomenon = bool(re.search(r'生活中|社会上|现代社会|许多人|不少人|这一?现象|这种现象|当下|如今', p))
    if has_choice:
        ttype = "比较选择类"
        type_reason = "材料出现“更应/还是/利大于弊”等选择或比较标志，要求在二者间作出权衡。"
    elif has_debate:
        ttype = "观点辨析类"
        type_reason = "材料呈现两种说法或不同态度，要求辨析各自的合理性与边界。"
    elif has_phenomenon:
        ttype = "现象类"
        type_reason = "材料以“生活中/社会上许多人……”描述现象，要求剖析现象背后的成因与本质。"
    else:
        ttype = "观点辨析类"
        type_reason = "未发现明显的现象描述或比较选择标志，按观点辨析类处理，建议再核对原题。"

    # 材料真正的问句
    sentences = re.split(r'[。！？\n]+', p)
    questions = [s.strip() for s in sentences
                 if re.search(r'[?？]|是否|怎么看|谈谈你的?(?:认识|思考|感受)|认同', s) and len(s.strip()) >= 6]
    core_question = questions[-1] if questions else "请结合材料，谈谈你对这一问题的认识和思考。"
    core_question = re.sub(r'^请写一篇文章[，,]?', '', core_question)

    concepts = [
        {
            "name": q,
            "connotation": "（本地规则）请先写出“%s”在本题语境中的确切含义，不要直接搬词典义。" % q,
            "boundary": "界定其内涵与外延：包含什么、不包含什么；警惕把它窄化成近义词或偷换成另一个话题。"
        } for q in quoted[:3]
    ]
    if not concepts:
        concepts = [{
            "name": "材料核心话题",
            "connotation": "（本地规则）未发现带引号的核心概念，请自行从材料中概括讨论对象并下定义。",
            "boundary": "概括时保留材料的限定语，不可只抽一个关键词就另起炉灶。"
        }]

    key_analysis = []
    for q in quoted[:3]:
        key_analysis.append({
            "quote": q,
            "point": "引号标出的核心概念：先界定再论证；全文须始终围绕它，不可偷换或窄化。"
        })
    if re.search(r'更应|更值得|更能|更加|更好', p):
        key_analysis.append({
            "quote": "更（更应/更好/更能）",
            "point": "比较级/程度词：潜台词是双方（或原途径）都有价值，必须回答“为什么更”，只写一方最多三类卷。"
        })
    if re.search(r'是否|吗|怎么看', p):
        key_analysis.append({
            "quote": "是否/吗/怎么看",
            "point": "这是材料真正的问句，要给出明确立场并论证其成立条件，不可正反等价罗列后不了了之。"
        })
    if re.search(r'许多人|不少人|很多人', p):
        key_analysis.append({
            "quote": re.search(r'.{0,6}(?:许多人|不少人|很多人).{0,10}', p).group(0).strip(),
            "point": "现象描述：重点在剖析“为什么许多人如此”的社会心理与成因，而非简单赞同或批判。"
        })
    if re.search(r'往往|主要|大多数|多数', p):
        key_analysis.append({
            "quote": "往往/主要",
            "point": "限定词：承认的是多数情形而非全部，恰可从“特殊情形/例外”处打开思辨空间。"
        })
    if re.search(r'以[^，。；]{0,12}(?:获得|得到|换取|寻找)', p):
        key_analysis.append({
            "quote": "以……获得……",
            "point": "手段-目的关系：可追问手段是否必然达成目的、目的是否另有更优途径（充分/必要条件）。"
        })
    key_analysis = key_analysis[:6]

    focus = quoted[0] if quoted else "材料核心话题"
    if ttype == "比较选择类":
        angles = [
            {"name": "思路一：单向肯定（顺着一方写）",
             "logicChain": ["从材料中的一方出发，肯定其价值", "通篇论证该方的意义"],
             "stand": "只肯定其中一方并通篇论证其价值（或只批判另一方）。",
             "level": "基础立意（约三类卷）",
             "evaluation": "无视比较关系与另一方价值，认识片面，通常 39-45 分。"},
            {"name": "思路二：双向辩证（双方各谈）",
             "logicChain": ["承认双方各有价值", "分析各自的合理性与代价", "试图兼顾两者"],
             "stand": "双方利弊都谈，承认各有价值与代价。",
             "level": "进阶立意（约二类卷）",
             "evaluation": "有辩证意识但缺少权衡标准，分析不深入，多为二类中（55-58）。"},
            {"name": "思路三：条件权衡（高处综合）",
             "logicChain": ["界定双方关系与各自成立条件", "给出更高价值标准", "回答在何种情境中何者更应", "回应现实"],
             "stand": "界定双方关系与各自成立条件，在更高价值标准下回答“在何种情境中何者更应”，并回应现实。",
             "level": "一类立意",
             "evaluation": "完成了材料要求的比较判断，条件分析+辩证统一+现实针对性，可冲击 63+。"}
        ]
    elif ttype == "观点辨析类":
        angles = [
            {"name": "思路一：单向站队（赞同或反对一方）",
             "logicChain": ["直接赞同或反对其中一种说法", "通篇只写一面"],
             "stand": "直接赞同或反对其中一种说法，通篇只写一面。",
             "level": "基础立意（约三类卷）",
             "evaluation": "未与另一种说法对话，思维层次停留在材料前半句，45-49 分附近。"},
            {"name": "思路二：让步质疑（先承认再质疑）",
             "logicChain": ["先承认该说法的合理性", "再质疑其边界与代价"],
             "stand": "先承认该说法的合理性，再质疑其边界与代价。",
             "level": "进阶立意（约二类卷）",
             "evaluation": "让步与质疑皆有实质内容、分析到位即可入二类；若只质疑无论证深化，多为二类中下。"},
            {"name": "思路三：辨析统一（辨析条件、高处统一）",
             "logicChain": ["辨析两种说法各自的成立条件与适用情境", "在更高层面达成统一或给出动态判断标准", "观照当下"],
             "stand": "辨析两种说法各自的成立条件与适用情境，在更高层面达成统一或给出动态的判断标准，并观照当下。",
             "level": "一类立意",
             "evaluation": "与材料充分对话、层层深入且有现实针对性，可冲击 63+。"}
        ]
    else:
        angles = [
            {"name": "思路一：表态度（复述现象后表态）",
             "logicChain": ["复述现象", "抽象出“%s”等品质后大谈应当怎么做" % focus.strip("“”")],
             "stand": "复述现象后简单表态度，或抽象出“%s”等品质后大谈应当怎么做。" % focus.strip("“”"),
             "level": "基础立意（约三类卷）",
             "evaluation": "典型跑偏：把现象类写成了话题作文，重做法轻归因，通常不超过三类。"},
            {"name": "思路二：归因剖析（分析现象成因）",
             "logicChain": ["剖析现象成因", "从个体心理、时代环境、技术与商业逻辑各分析一层"],
             "stand": "剖析现象成因：个体心理、时代环境、技术与商业逻辑各一层。",
             "level": "进阶立意（约二类卷）",
             "evaluation": "因果分析成立、层次清楚即可入二类；若归因交叉重复，多在二类中下。"},
            {"name": "思路三：本质追问（追问悖论与应对）",
             "logicChain": ["在成因分析之上追问现象的本质与悖论", "辨析其合理性与隐忧", "提出主体在当下的应对之道"],
             "stand": "在成因分析之上追问现象的本质与悖论，辨析其合理性与隐忧，提出主体在当下的应对之道。",
             "level": "一类立意",
             "evaluation": "有本质追问、辩证张力与现实针对性，可冲击 63+。"}
        ]

    outline = [
        {"step": "引材料，亮观点", "detail": "简要引述材料，用一句话给出明确、不含糊的中心论点（同时完成自拟标题）。"},
        {"step": "界定核心概念", "detail": "界定“%s”等核心概念的内涵、外延与分类，为后文立论划界。" % (focus or "核心概念")},
        {"step": "承认合理性（让步）", "detail": "分析材料说法/现象何以成立，承认其价值，不急于反驳。"},
        {"step": "质疑与边界", "detail": "追问其成立条件与代价：在何种情境下失效？充分吗？必要吗？"},
        {"step": "深入思辨（条件/统一/更高标准）",
         "detail": "辨析对立双方的关系（主次、转化、互为前提），在更高价值标准下统一。"},
        {"step": "联系现实", "detail": "结合当下社会心理、技术环境或具体生活场景，体现写作的现实针对性。"},
        {"step": "怎么办（简要）", "detail": "给出主体的应对原则，点到为止，避免通篇变成做法罗列。"},
        {"step": "回扣材料，收束全文", "detail": "回应材料中的关键词与真正问句，首尾圆合。"}
    ]

    risks = [
        "脱离材料空泛议论，把材料作文写成以“%s”为题的话题作文。" % (focus or "关键词"),
        "偷换或窄化核心概念（如只抓住某个近义词发挥，关键词在文中却很少出现）。",
        "只写一面、无视材料的另一说法；或正反各打五十大板，立场骑墙、以“要适度”和稀泥。",
        "以例代证、素材堆砌：若通篇主要靠罗列事例支撑论点、例后基本没有“这个事例说明了什么”的分析句，是硬伤；论点已论证清楚处的简要用例不算。",
        "前半扣题、后半说开去，或通篇着重谈“怎么做”而回避“为什么”。",
        "不足 800 字（按含标点占格口径），论证难以充分展开。"
    ]

    return {
        "engine": "local",
        "topicType": ttype,
        "typeReason": type_reason,
        "coreQuestion": core_question,
        "coreConcepts": concepts,
        "keyAnalysis": key_analysis,
        "angles": angles,
        "outline": outline,
        "risks": risks,
        "notice": "本地规则仅依据题型标志词与引号概念做粗提取，概念界定、立意层次与提纲为通用模板；"
                  "配置 AI 后可获得针对本题的深入审题分析。"
    }


# ============================================================
#  大模型调用
# ============================================================

def call_llm(api_key, base_url, model, system_prompt, user_content, max_tokens):
    """调用 OpenAI 兼容 chat/completions。返回报告 dict；失败抛 LLMError。"""
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.3,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "response_format": {"type": "json_object"},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def once():
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        req.add_header("Authorization", "Bearer " + api_key)
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))

    last_err = None
    for attempt in range(3):  # 网络错误 / 5xx / 429 时指数退避重试
        try:
            raw = once()
            content = raw["choices"][0]["message"]["content"]
            return parse_json_object(content)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:300]
            if e.code in (400, 401, 403, 404):
                raise LLMError("auth_or_param",
                               "接口返回 %s：%s。请检查 API Key、接口地址和模型名是否正确。" % (e.code, detail))
            if e.code == 429:
                last_err = "接口限流（429），请稍后再试"
            else:
                last_err = "接口返回 %s：%s" % (e.code, detail)
        except urllib.error.URLError as e:
            last_err = "无法连接大模型服务：%s" % getattr(e, "reason", e)
        except (KeyError, IndexError, ValueError) as e:
            raise LLMError("bad_response", "大模型返回内容无法解析：%s" % e)
        time.sleep(1.2 * (attempt + 1))
    raise LLMError("unavailable", last_err or "大模型服务暂不可用")


def parse_json_object(content):
    """剥离代码块并解析 JSON 对象。"""
    s = content.strip()
    if s.startswith("```"):
        parts = s.split("```", 2)
        s = parts[1] if len(parts) > 1 else content
        if s.lstrip().lower().startswith("json"):
            s = s.lstrip()[4:]
    start, end = s.find("{"), s.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("未找到 JSON 对象")
    return json.loads(s[start:end + 1])


class LLMError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ============================================================
#  HTTP 服务
# ============================================================

class Handler(BaseHTTPRequestHandler):
    server_version = "EssayGrader/2.0"

    def log_message(self, fmt, *args):
        pass  # 静默；需要调试可改为 print(args)

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _send_static(self, rel):
        rel = rel.lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(BASE_DIR, *rel.split("/")))
        if not path.startswith(BASE_DIR) or not os.path.isfile(path):
            self.send_error(404, "Not Found")
            return
        ext = os.path.splitext(path)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404, "Not Found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/config":
            self._send_json({
                "configured": bool(SERVER_API_KEY),
                "base_url": SERVER_BASE_URL,
                "model": SERVER_MODEL,
                "providers": PROVIDERS,
            })
            return
        self._send_static(path)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send_json({"ok": False, "code": "bad_request",
                             "message": "请求为空或超过 60KB 上限"}, 400)
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json({"ok": False, "code": "bad_request", "message": "请求不是合法 JSON"}, 400)
            return None

    def _resolve_cfg(self, data):
        client_cfg = data.get("settings") or {}
        api_key = str(client_cfg.get("apiKey") or "").strip() or SERVER_API_KEY
        base_url = str(client_cfg.get("baseUrl") or "").strip() or SERVER_BASE_URL
        model = str(client_cfg.get("model") or "").strip() or SERVER_MODEL
        return api_key, base_url, model

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/grade", "/api/analyze"):
            self.send_error(404, "Not Found")
            return
        data = self._read_body()
        if data is None:
            return
        api_key, base_url, model = self._resolve_cfg(data)

        if path == "/api/analyze":
            self.handle_analyze(data, api_key, base_url, model)
        else:
            self.handle_grade(data, api_key, base_url, model)

    def handle_grade(self, data, api_key, base_url, model):
        text = (data.get("text") or "").strip()
        if len(text) < 20:
            self._send_json({"ok": False, "code": "too_short", "message": "作文内容太短"}, 400)
            return
        if not api_key:
            self._send_json({"ok": False, "code": "no_key", "message": "尚未配置 API Key"}, 503)
            return
        if not base_url or not model:
            self._send_json({"ok": False, "code": "bad_config", "message": "缺少接口地址或模型名"}, 400)
            return

        t0 = time.time()
        try:
            report = call_llm(api_key, base_url, model,
                              GRADE_SYSTEM_PROMPT, build_grade_payload(data), MAX_TOKENS_GRADE)
        except LLMError as e:
            status = 401 if e.code == "auth_or_param" else (502 if e.code == "unavailable" else 500)
            self._send_json({"ok": False, "code": e.code, "message": str(e)}, status)
            return
        self._send_json({"ok": True, "report": report,
                         "engine": "ai", "model": model, "elapsed": round(time.time() - t0, 1)})

    def handle_analyze(self, data, api_key, base_url, model):
        material = (data.get("prompt") or "").strip()
        if len(material) < 10:
            self._send_json({"ok": False, "code": "too_short",
                             "message": "请先粘贴作文题目材料（至少 10 个字）"}, 400)
            return

        # 未配置 Key：本地规则兜底
        if not api_key:
            self._send_json({"ok": True, "report": local_analyze(material),
                             "engine": "local", "model": "本地规则审题", "elapsed": 0})
            return
        if not base_url or not model:
            self._send_json({"ok": True, "report": local_analyze(material),
                             "engine": "local", "model": "本地规则审题", "elapsed": 0})
            return

        t0 = time.time()
        try:
            report = call_llm(api_key, base_url, model,
                              ANALYZE_SYSTEM_PROMPT, build_analyze_payload(material),
                              MAX_TOKENS_ANALYZE)
        except LLMError as e:
            # 审题是写作前的刚需功能：AI 失败时自动回退本地规则，并附带原因
            fallback = local_analyze(material)
            fallback["warning"] = "AI 审题暂不可用（%s），以下为本地规则粗提取结果。" % str(e)
            self._send_json({"ok": True, "report": fallback,
                             "engine": "local", "model": "本地规则审题", "elapsed": round(time.time() - t0, 1)})
            return
        self._send_json({"ok": True, "report": report,
                         "engine": "ai", "model": model, "elapsed": round(time.time() - t0, 1)})


def lan_ip():
    """尽力获取本机局域网 IP（不联网，仅查询 UDP 套接字默认出口）。"""
    import socket
    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        pass
    return ip


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    local_ip = lan_ip()
    on_cloud = bool(os.environ.get("RENDER") or os.environ.get("RAILWAY_ENVIRONMENT")
                    or os.environ.get("KOYEB"))
    print("=" * 60)
    print(" 高考思辨议论文批改网站已启动")
    print("   本机访问： http://127.0.0.1:%d/" % PORT)
    if not on_cloud:
        print("   局域网访问（手机/平板同一 WiFi）： http://%s:%d/" % (local_ip, PORT))
    if HOST == "0.0.0.0":
        print("   （已绑定所有网卡；设环境变量 HOST=127.0.0.1 可仅允许本机）")
    print(" 满分 70 分 · 上海卷五类档 · 含审题指导 · 逐句逻辑批改")
    print(" 大模型服务端配置： %s" % ("已就绪（环境变量/.env）" if SERVER_API_KEY
                                  else "未配置（审题可用本地规则，AI 批改需在网页设置 Key）"))
    print(" 按 Ctrl+C 停止")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.shutdown()


if __name__ == "__main__":
    main()
