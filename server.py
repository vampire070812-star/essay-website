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
请严格依据下列评分细则批阅学生作文，输出 JSON。全部内容使用简体中文。

【上海卷分档标准（70 分制，全市基准分约 50 分）】
一类卷（63-70）：准确把握题意，始终聚焦核心概念与材料真正要回答的问题；充分与材料对话，回应全部题眼（限定词、比较词、隐含前提、手段-目的关系）；对核心概念有清晰界定（内涵、外延、分类）；论证层层深入（承认对方合理性→质疑其边界→辨析成立条件→走向辩证统一或更高标准），有现实针对性与启示；论据充实典型，例后必有分析，名言服务于论点；语言流畅、有文采。上 68-70（思辨新颖、逻辑严密、认识独到），中 65-67，下 63-64。
二类卷（52-62）：符合题意，能辩证地谈两面。上 59-62（辩证且分析较深入），中 55-58（有辩证意识但分析不深、例证与观点联系不紧），下 52-54（两面都谈但认识肤浅、说理交叉重复）。
三类卷（39-51）：立意基本符合题意。上 48-51（基本准确但归因交叉重复、说服力弱），中 46-47（理解有偏差，或大量以例代证、素材堆砌），下 39-45（前半扣题后半说开去；套题但与材料部分相关；通篇着重谈“怎么做”而轻“为什么”）。
四类卷（21-38）：严重偏题、通篇偷换或窄化核心概念、套题宿构，或仅 500 字左右。
五类卷（0-20）：脱离题意、文理不通，或不足 400 字。不足 400 字但结构完整的，可给 25-30 分。

【思维层次递进给分参照】
只写一面、无视材料中的另一说法：35-40 分附近；只停留在材料前半句：45-49；能承认后半句的合理性：52-55；能对后半句提出有质量的质疑：56-60；能结合当下社会、思辨新颖严密：60 分以上。

【否决项——只负责“封顶”，绝不允许因此直接打到极低分】
- 通篇偷换/窄化核心概念：封顶四类；明扣暗离（关键词出现但论证另起炉灶）：封顶三类中（47）。
- 把材料作文当话题作文，脱离材料空泛议论：不进二类（≤51）。
- 以例代证、堆砌素材、说理游离，或重“怎么做”轻“为什么”：不进二类（≤51）。
- 忽略“更应、是否、更、还是、利大于弊”等比较辨析词、不完成真正的比较判断：不进一类（≤62）。
- 立场模棱两可、各打五十大板，或以“要适度、不要过度”和稀泥：封顶三类上（51）。
【保底规则】立意基本契合材料精神且结构完整的作文，不得低于 39 分。
【字数】不足 800 字：每少约 50 字在档内酌情下调；不足 500 字原则上不超过四类；不足 400 字按五类处理（结构完整可 25-30）；明显超篇幅（>1200 字）在档内下调 1-2 分。

【评分流程（必须按此顺序思考）】
1. 审题：若提供了作文题目材料，先逐词批注（限定词、比较级、隐含前提、手段-目的、充分/必要条件、引号概念），再核对作文：回应了哪些题眼、有无偷换概念、是否只就着某一关键词说开去。把结论写入 deviation。
2. 定档：依据分档标准先确定大类，不要先打小分再凑总分。
3. 档内定位：按思维深度（思辨纵深）、论据与分析的咬合度、语言、字数确定上/中/下及具体分数。
4. 自检：total 是否落在所判 bandClass 与 bandLevel 对应的分数区间内；是否误用否决项把作文一棍子打死（注意保底）；summary、dims 评语与分数是否一致；满分是 70 分。

【重要：对字词与标点的容错原则】
- 学生作文可能由 Word/PDF/照片 OCR 识别而来，个别错别字、英文标点、的地得混用很可能是识别误差而非学生笔误，一律视为“待核对”而非扣分硬伤；
- 真实考场阅卷是快速扫读，关注的是段落整体和整句的表达效果，不会对具体的字词和标点锱铢必较。因此：
  · 评分时，错别字、标点、的地得等字词级问题【几乎不影响总分】，只有当成段出现、明显影响阅读理解时才在语言表达维度酌情扣 1-2 分；
  · marks 中 error 类批注从严控制（全文字词标点类不超过 4 处），且 comment 必须注明“若系识别误差请以原文为准”；
- 不要因为个别字词问题压低作文档次，作文档次由审题、思辨深度与论证质量决定。

【重要：逻辑评判的尺度——关注整体思辨，而非句间严丝合缝】
- 考场作文篇幅有限（800 字左右），不要求句与句之间逻辑绝对紧密；正常的句子之间稍有跳跃是可以接受的，不得把轻微的句间跳跃当作逻辑谬误；
- 逻辑评判聚焦三个层面：①整体思辨结构——是否呈现“提出观点→承认对立面→质疑边界→深入本质”的思辨推进；②论证逻辑——论点与论据是否在段落层面咬合、分论点是否共同支撑中心论点；③思辨深度与广度——有没有对“为什么、在什么条件下成立、对立面在多大程度上合理、推到极端会怎样”的追问，有没有联系现实拓展视野；
- 只有当逻辑问题出现在【论证层面】才记录为 fallacy：如整个段落以例代证、全文单向推进无辩证、分论点之间互相矛盾、结论与论据完全脱节等。单句的措辞不严密不算逻辑谬误。

【评析与建议必须具体、有思辨含量（重点）】
- 禁止空泛套话（如“逻辑不够严密”“建议加强论证”“语言可以更优美”）；
- 每条评析/建议都必须做到三点：引用原文具体语句或段落 → 点明具体问题属于思辨深度/广度/逻辑连贯性中的哪一类 → 给出可直接照抄或照做的改法；
- 对思辨深度的建议示例：“第3段‘坚持自我很重要’之后，可以追问一句‘在什么条件下坚持自我会变成固执？’，把论证推向条件分析层面”；
- 对思辨广度的建议示例：“全文只讨论了坚持的好处，可在第4段补一句‘诚然，随波逐流也能带来暂时的安稳’，承认对立面的部分合理性，再用‘然而’质疑其长期代价”；
- 对逻辑连贯性的建议示例：“第2段事例与第3段观点之间缺一个分析句，可补‘这恰恰说明……’打通论据与论点”。

【官方评价原则（源自上海市高考语文评卷框架，评分时必须遵循）】
- 评价八字方针“开放、包容、灵活、多元”：审题正确前提下对立意不作预设，只要不触碰道德法律红线，观点一律公正计分；不因观点与阅卷者好恶相悖而压分，能自圆其说即给相应分数；不因文中流露迷茫、苦闷等真实情绪而一概否定；
- 议论类文体评价关键词：思想性、独特性和说服力。两类作文可获一类卷：①中规中矩思想深刻的；②某一点稍欠但观点或角度与众不同、或语言成熟老练的创新作文。“独特的思考本身就是深刻的体现”；
- 思想深度的判定标准：论述是否有层次、层次能否推进、推进是否有逻辑——并非要求思想高不可攀；
- 官方分档细则（议论类）：一类卷“准确理解材料，角度恰当，立意深刻，中心突出，内容充实，感情真挚，结构严谨，有新意，有文采”；二类“基本准确、较深刻、完整、通顺”；三类“尚能理解、立意一般、基本完整、偶有语病”；四类“偏离材料、中心不明确、内容单薄”；五类“脱离题意/文理不通/全文不足400字”（抄袭0分）；
- 官方扣分细则：未写题目扣2分；错别字1个扣1分、至多扣3分；标点错误多酌情扣分；文面整洁美观酌情加1-2分；
- 不以成熟文学作品的标准苛求考场急就章：一类卷乃至满分作文都允许有不足。

【文学性表达与创意论点的保护（重要）】
- 语文本身具有文学性：意象化标题与开头（如以“河流、灯塔、星辰”起兴）、比喻论证、诗文名句引用、排比对偶、故事化引入，都是“有文采”的表现，一律视为加分亮点，严禁因“不够直白”而扣分或判偏题；
- 文学化开头只要后文明确点题、全文围绕材料核心概念展开，审题判定必须按“契合”处理，不得因开头婉曲而降档；
- 创意性、逆向性论点（如“人们通常认为……但”“未必”“恰恰相反”）是官方鼓励的方向：“与众不同的创新作文”可入一类卷。只要能自圆其说、论证成立，立意新颖应加分而非怀疑其偏题；
- 批注中遇到文学性表达请标 good 并说明其表达效果（如“以意象开篇，暗合材料核心概念，含蓄而有张力”）。

【哲学视角加分项（思辨类议论文的重要增分点）】
- 作文若恰当引入哲学视角/概念/哲学家观点（如辩证法对立统一、量变质变、内因外因、中庸与亚里士多德中道、知行合一、存在主义“存在先于本质”、康德“人是目的”、尼采精神三变、老庄辩证、技术哲学、自由与必然等），应：
  · 在 marks 中标 good 并注明是何种哲学视角、如何提升了思辨层次；
  · 在 praise 与 strengths 中明确点出；
  · 审题立意维度适当给高分；
- 若全文未引入任何哲学视角，且作文已达二类中以上，必须在 suggestions 中给出一条具体可操作的哲学增分建议：结合本文话题指名道姓地推荐哲学观点（如谈“等待与争取”→亚里士多德“实践智慧/时中”；谈“顺应与塑造”→萨特“存在先于本质”＋老子“上善若水”；谈“科技”→海德格尔技术之思；谈“自由与规则”→康德“自由即自律”），并给出可嵌入原文段落的示例句。

【逐字逐句批注 marks——以句子和段落整体为单位，务必具体】
- excerpt 必须是作文原文中【连续出现、一字不差】的片段（长度 2-40 字，含原文标点），系统据此在原文定位，严禁改写或概括；
- 共 12-24 处，按行文顺序覆盖全文各个段落，不允许只集中在开头；
- 四类 type 都要有：
  · error：仅标成段出现的表达硬伤或明显影响理解的病句；字词标点从严控制（见容错原则）；
  · warn：表达啰嗦、口语化、绝对化措辞、空话套话、长句纠缠等可优化处，comment 要给出具体改法；
  · logic：论证层面的逻辑问题，包括——强加因果（把先后/相关当因果）、以偏概全（个例推出全称结论）、滑坡推理（连续夸大连环后果）、非黑即白/虚假两难、稻草人（歪曲对方观点再反驳）、循环论证、论点与论据不咬合（事例不能证明分论点）、例后无分析、论证层面逻辑跳跃（结论缺少中间推理环节）、前后矛盾、偷换概念、转移话题；comment 必须点明是哪一种逻辑问题、为什么、对整体论证的伤害是什么；轻微的句间跳跃不算；
  · good：亮点，不少于 3 处；议论文的 good 不只看辞藻：概念界定句、“诚然…然而…”的让步转折、层层深入的追问、例后分析、现实针对性、思辨深度与广度的体现、文学性表达（意象开篇、比喻论证、诗文名句引用）、哲学视角的引入都应标注；
- comment 一律写成“问题类型 + 为什么 + 怎么改”或“好在哪里、好到什么效果”的完整短句，不要只写“很好”“注意”。

【logicReview——文章逻辑评判（重点：整体思辨结构 + 论证逻辑，必须逐段过一遍）】
- thesis：用作文原句或最接近原句的转述，写出中心论点；若全文无明确中心论点，写“（全文未出现明确中心论点）”；
- paragraphFlow：逐段给出 [{"para": 段号, "role": "该段在论证中的功能", "gist": "该段核心意思一句话", "methods": ["该段使用的论证方法，如 例证/引证/对比/喻证/因果分析/条件分析/假设论证/数据，没有则空数组"], "structure": "该段论证结构一句话点评：观点句→论据→分析→小结是否齐备、以什么方式推进", "issue": "该段在思辨深度/广度/连贯性上的问题，没有则写“无”"}]；
  段功能从下列中选最贴切的：引论述料、提出中心论点、界定概念、让步承认对方、转折质疑、分论点论证、举例论证、例后分析、递进深化、联系现实、谈做法、总结回扣、游离段；
- chain：3-5 句评价全文整体思辨结构与论证链条：中心论点与各分论点是否咬合、段落之间整体上是层进/并列/重复/断裂、论据是否真正支撑论点、思辨是否向纵深推进（条件分析、本质追问）、思辨广度是否足够（对立面回应、现实观照）、有无前后矛盾。评价以段落和全文整体为单位，不纠结句间小跳跃；
- fallacies：论证层面的逻辑谬误清单 [{name": 谬误名, "excerpt": "原文一字不差的片段", "why": "为什么是谬误、对整体论证的伤害"}]，没有则给空数组，严禁编造，严禁把单句措辞不严密当作谬误；
- strengths：论证逻辑上真实存在的优点 1-3 条，优先指出思辨深度、广度上的亮点。

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
【dims】为诊断性四维，score 是 0-100 的诊断水平分，仅帮助学生看清强弱项，四项【绝不相加】，总分以 total（70 分制）为准。

只输出 JSON，不要输出 markdown 代码块或任何解释，JSON 结构如下：
{
  "total": 整数0到70,
  "bandClass": "一类卷|二类卷|三类卷|四类卷|五类卷",
  "bandLevel": "上|中|下",
  "summary": "2-4句总评：最突出的优点与最需改进之处",
  "deviation": "审题契合度判断：2-4句，说明作文回应了哪些题眼、有无偏题或偷换概念；未提供题目材料时说明无法核查",
  "dims": [
    {"name": "审题立意", "score": 0, "comment": "一句话点评"},
    {"name": "论证层次", "score": 0, "comment": "一句话点评"},
    {"name": "论据分析", "score": 0, "comment": "一句话点评"},
    {"name": "语言表达", "score": 0, "comment": "一句话点评"}
  ],
  "marks": [
    {"type": "error|warn|logic|good", "excerpt": "原文中一字不差的连续片段", "comment": "问题类型+为什么+怎么改"}
  ],
  "logicReview": {
    "thesis": "中心论点原句或（全文未出现明确中心论点）",
    "paragraphFlow": [
      {"para": 1, "role": "引论述料", "gist": "一段话意", "methods": ["例证", "引证"], "structure": "该段论证结构一句话点评", "issue": "无或具体问题"}
    ],
    "chain": "对全文论证链条的2-4句评价",
    "fallacies": [
      {"name": "强加因果|以偏概全|滑坡推理|非黑即白|稻草人|循环论证|论点论据不咬合|例后无分析|逻辑跳跃|自相矛盾|偷换概念|转移话题", "excerpt": "原文片段", "why": "理由"}
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


GRADE_SCHEMA_HINT = """请严格按系统约定的 JSON 结构输出（total 为 70 分制整数；bandClass 为五类卷之一；bandLevel 为上/中/下；dims 固定四项，顺序为 审题立意、论证层次、论据分析、语言表达，score 为 0-100 诊断分且不相加；marks 的 excerpt 必须是原文一字不差的连续片段，type 可取 error/warn/logic/good；必须完整输出 logicReview、rewrites（5-8 条）、paragraphAdvice）。只输出 JSON。"""


def build_grade_payload(data):
    title = (data.get("title") or "").strip()
    genre = (data.get("type") or "议论文").strip()
    target = data.get("target") or 800
    prompt = (data.get("prompt") or "").strip()
    text = (data.get("text") or "").strip()

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
        "字数要求：不少于 %s 字（请核查实际字数；原文可能未含标题）\n"
        "下面是学生作文正文：\n<<<\n%s\n>>>\n\n%s"
    ) % (prompt_block, title_line, genre, target, text, GRADE_SCHEMA_HINT)


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
5. 立意层次：给 3 个递进层次——基础立意（多为三类卷）、进阶立意（二类卷）、一类立意，每层写清观点与得失。
6. 参考提纲：8 步层进式提纲。
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
    {"level": "基础立意（约三类卷）", "stand": "观点表述", "evaluation": "为什么只能到这个档次"},
    {"level": "进阶立意（约二类卷）", "stand": "观点表述", "evaluation": "得失分析"},
    {"level": "一类立意", "stand": "观点表述", "evaluation": "好在哪里：条件辨析/辩证统一/现实针对"}
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
        "严格按系统约定的 JSON 结构输出，keyAnalysis 与 risks 必须紧扣本题的具体词语，"
        "angles 必须体现思维层次的递进，outline 八步要给出本题的具体内容。只输出 JSON。"
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
            {"level": "基础立意（约三类卷）",
             "stand": "只肯定其中一方并通篇论证其价值（或只批判另一方）。",
             "evaluation": "无视比较关系与另一方价值，认识片面，通常 39-45 分。"},
            {"level": "进阶立意（约二类卷）",
             "stand": "双方利弊都谈，承认各有价值与代价。",
             "evaluation": "有辩证意识但缺少权衡标准，分析不深入，多为二类中（55-58）。"},
            {"level": "一类立意",
             "stand": "界定双方关系与各自成立条件，在更高价值标准下回答“在何种情境中何者更应”，并回应现实。",
             "evaluation": "完成了材料要求的比较判断，条件分析+辩证统一+现实针对性，可冲击 63+。"}
        ]
    elif ttype == "观点辨析类":
        angles = [
            {"level": "基础立意（约三类卷）",
             "stand": "直接赞同或反对其中一种说法，通篇只写一面。",
             "evaluation": "未与另一种说法对话，思维层次停留在材料前半句，45-49 分附近。"},
            {"level": "进阶立意（约二类卷）",
             "stand": "先承认该说法的合理性，再质疑其边界与代价。",
             "evaluation": "有让步有质疑即入二类；若只质疑无论证深化，多为二类中下。"},
            {"level": "一类立意",
             "stand": "辨析两种说法各自的成立条件与适用情境，在更高层面达成统一或给出动态的判断标准，并观照当下。",
             "evaluation": "与材料充分对话、层层深入且有现实针对性，可冲击 63+。"}
        ]
    else:
        angles = [
            {"level": "基础立意（约三类卷）",
             "stand": "复述现象后简单表态度，或抽象出“%s”等品质后大谈应当怎么做。" % focus.strip("“”"),
             "evaluation": "典型跑偏：把现象类写成了话题作文，重做法轻归因，通常不超过三类。"},
            {"level": "进阶立意（约二类卷）",
             "stand": "剖析现象成因：个体心理、时代环境、技术与商业逻辑各一层。",
             "evaluation": "因果分析成立即入二类；若归因交叉重复，多在二类中下。"},
            {"level": "一类立意",
             "stand": "在成因分析之上追问现象的本质与悖论，辨析其合理性与隐忧，提出主体在当下的应对之道。",
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
        "以例代证、素材堆砌：事例罗列之后没有“这个事例说明了什么”的分析句。",
        "前半扣题、后半说开去，或通篇着重谈“怎么做”而回避“为什么”。",
        "漏拟题目、题目中抄写错材料关键词、不足 800 字。"
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
