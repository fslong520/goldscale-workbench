//! AI 分析引擎：让模型自己读行情做判断，代码只负责风控兜底。
//!
//! 分工：
//! - **AI 主导判断**：多周期推理、形态识别、方向与价位，全由模型给
//! - **代码硬约束**：盈亏比、手数上限、点差、日内单数、时段——纯数字校验，模型说了不算
//!
//! AI 给的数字一律要过 `risk::gate_check`，过不了就标红拒绝，但保留它的分析供人参考。
//! 未配置密钥时整段返回 None，前端退回纯规则视图。

use serde::{Deserialize, Serialize};

use crate::config::Settings;
use crate::risk::{self, Gate, Plan};
use crate::strategy::Signal;

/// AI 给出的判断
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Verdict {
    /// long / short / none
    pub direction: String,
    pub entry: f64,
    /// 0 表示 AI 没给止损位
    pub sl: f64,
    pub tp: f64,
    /// 对入场信号 direction 的把握 0-100（风控与置信度下限比较用；无信号给低值）
    pub confidence: f64,
    /// 逐条理由
    #[serde(default)]
    pub reasons: Vec<String>,
    /// 模型自己说的风险
    #[serde(default)]
    pub warnings: Vec<String>,
    /// 多空倾向刻度 0-100：0=极度看空，50=中性，100=极度看多（越高越看多）。
    /// 缺省 -1 表示旧数据无此字段，前端按 bias/gauge 兜底推导
    #[serde(default = "neg_one")]
    pub sentiment: f64,
    /// 旧版市场方向倾向（已由 sentiment 取代，仅兼容历史日志）
    #[serde(default)]
    pub bias: String,
    /// 旧版有符号情绪 -100~+100（已废，仅兼容历史日志），新数据不再读它
    #[serde(default)]
    pub gauge: f64,
    /// 策略风格短语，如「激进剥头皮」「稳健波段」
    #[serde(default)]
    pub style_tag: String,
    /// 综合结论一句话
    #[serde(default)]
    pub summary: String,
    /// 四模块分析：走势环境 / 区间识别 / 裸K短线 / 波段分析
    #[serde(default)]
    pub modules: Vec<Module>,
    /// 多空两套方案
    #[serde(default)]
    pub plans: Vec<AiPlan>,
}

/// 单个分析模块；模型无法判定时 status/detail 写「未明确」
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub detail: String,
}

/// 一套方向方案（做多或做空），带依据与分批目标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiPlan {
    /// long / short
    #[serde(default)]
    pub side: String,
    /// 如「逢低做多」「区间下沿反弹」
    #[serde(default)]
    pub style: String,
    /// 触发条件：价位区域 + K线形态 + 指标确认
    #[serde(default)]
    pub trigger: String,
    /// 入场区间文字，如 "4172.0-4176.5"
    #[serde(default)]
    pub entry: String,
    /// 入场中值（风控与展示用）
    #[serde(default)]
    pub entry_mid: f64,
    #[serde(default)]
    pub sl: f64,
    /// 止损依据，如「结构外侧，约 0.7 倍 ATR」
    #[serde(default)]
    pub sl_note: String,
    #[serde(default)]
    pub tp1: f64,
    #[serde(default)]
    pub tp1_note: String,
    #[serde(default)]
    pub tp2: f64,
    #[serde(default)]
    pub tp2_note: String,
    /// 第一/第二目标盈亏比
    #[serde(default)]
    pub rr1: f64,
    #[serde(default)]
    pub rr2: f64,
    /// 持仓性质，如「短线回踩多，TP1 减半推保护」
    #[serde(default)]
    pub hold: String,
}

/// 代码风控对 AI 判断的裁决
#[derive(Debug, Clone, Serialize)]
pub struct RiskVerdict {
    pub allowed: bool,
    pub blocks: Vec<String>,
    pub warns: Vec<String>,
    /// 代码按权益风险算出的手数，AI 说了不算
    pub lot: f64,
    pub risk_money: f64,
    /// 实际盈亏比
    pub rr: f64,
    pub sl_points: f64,
    pub tp_points: f64,
    pub plan: Option<Plan>,
}

/// 完整结果：AI 判断 + 代码裁决 + 规则引擎的独立判定（三者并排给人看）
#[derive(Debug, Clone, Serialize)]
pub struct Analysis {
    pub signal: Signal,
    /// None = 没配密钥或调用失败
    pub verdict: Option<Verdict>,
    /// 对 AI 判断的风控裁决
    pub risk: Option<RiskVerdict>,
    pub model: String,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub reasoning_tokens: usize,
    pub ai_error: Option<String>,
    /// 思考过程原文（与回答分开展示，关闭思考时为 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_text: Option<String>,
    /// 本轮研判引用的历史记忆（读到的「上次研判」，不含本轮归档）；字段名锁死 memory_refs
    pub memory_refs: Vec<MemRef>,
}

/// 研判引用的记忆条目（前端按 id/title 展示「接上次」的依据）
#[derive(Debug, Clone, Serialize)]
pub struct MemRef {
    pub id: String,
    pub title: String,
}

fn neg_one() -> f64 {
    -1.0
}

/// 行为纪律：研判（enhance）与对话（ai）两处 system prompt 共用同一段文本，防口径漂移
pub const DISCIPLINE_BLOCK: &str = "\
【行为纪律】\n\
1. 先讲风险与失效条件，再谈机会；数据不利就明确说条件不成立，不迎合用户情绪。\n\
2. 连赢不吹捧、不鼓励加仓，只提示维持既定风险；亏损后不催单，不建议「马上赚回来」。\n\
3. 给数字依据（胜率/点位/风险金额），不喊口号，不用两头讨好的模糊表述。\n\
4. 用户若要求马上开仓或加大手数，先复述当前风控事实（预算/单数/止损），再执行其指令。\n";

/// 系统提示词：把策略口径和硬约束讲清楚，要模型输出 JSON
pub fn system_prompt(
    strategy: &crate::config::Strategy,
    personal: &str,
    max_daily: u32,
) -> String {
    let focus = if strategy.focus.is_empty() {
        String::new()
    } else {
        format!(
            "\n本策略重点关注：\n{}\n",
            strategy
                .focus
                .iter()
                .map(|f| format!("  - {}", f))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };

    format!(
        "你是贵金属交易分析师。基于给定行情做独立判断，代码只负责风控兜底。\n\
直接给结论，不要输出思考过程。\n\
\n\
【当前策略】{name}——{desc}\n\
周期配置：{exec} 执行，{dir} 定方向，{conf} 确认形态。\n\
硬性要求：最低盈亏比 {rr}，置信度下限 {floor}，单笔风险 {risk}%。\n\
允许方向：做多 {long}，做空 {short}。日内最多 {daily} 单。\n\
{focus}\n\
【策略分析要求】{prompt}\n\
\n\
【用户自述口径】\n{personal}\n\
注意：口径用来补充策略没说清的地方。\n\
若口径与当前策略「{name}」的类型明显冲突（比如策略是均值回归双向，\n\
口径却写「只做多顺势」），以**当前策略**为准，并在 warnings 里说明这个冲突。\n\
若两者不冲突，口径用于细化进场的具体条件。\n\
\n\
【输出格式】严格输出如下 JSON，不要代码块标记，不要额外文字：\n\
{{\n\
  \"direction\": \"long 或 short 或 none，必须遵守允许方向（入场信号）\",\n\
  \"sentiment\": 数字 0-100，多空倾向刻度：0=极度看空，50=中性，100=极度看多（越高越看多）；依据多周期趋势结构给——空头趋势给 0-40、震荡给 40-60、多头趋势给 60-100；即使 direction=none 也必须给，它回答市场往哪边走，与有无入场机会无关,\n\
  \"entry\": 数字，主方向方案入场中值（=该侧 entry_mid），风控用，没有就填 0,\n\
  \"sl\": 数字，主方向方案止损（=该侧 plans 同 side 的 sl），没有就填 0,\n\
  \"tp\": 数字，主方向方案第一目标（=该侧 tp1），没有就填 0,\n\
  \"confidence\": 数字 0 到 100，对 direction 入场信号的把握（无入场信号给 0-20），\n\
    风控会拿它与置信度下限比较——注意它是信号把握，与 sentiment 多空刻度是两回事,\n\
  \"style_tag\": \"策略风格短语，如 激进剥头皮 / 稳健波段\",\n\
  \"summary\": \"综合结论一句话，含方向倾向与关键价位\",\n\
  \"reasons\": [\"依据1\", \"依据2\"],\n\
  \"warnings\": [\"风险提示\"],\n\
  \"modules\": [\n\
    {{\"name\":\"走势环境\",\"status\":\"趋势运行 / 区间震荡 / 方向不明\",\"detail\":\"均线·趋势线·RSI 观察，一句话\"}},\n\
    {{\"name\":\"区间识别\",\"status\":\"已识别 / 未明确\",\"detail\":\"关键上下沿价位；判不出就写 AI 本次未明确区间判定\"}},\n\
    {{\"name\":\"裸K短线\",\"status\":\"...\",\"detail\":\"M5/M15/H1 通道、支撑压力、K线形态与卡点\"}},\n\
    {{\"name\":\"波段分析\",\"status\":\"...\",\"detail\":\"H4/D1 结构、RSI/MACD 状态与分批思路\"}}\n\
  ],\n\
  \"plans\": [\n\
    {{\n\
      \"side\": \"long\",\n\
      \"style\": \"如 逢低做多\",\n\
      \"trigger\": \"触发放置：价位区域 + K线形态（注明影线/实体比例与收盘位置）+ 指标确认（RSI/MACD 状态）\",\n\
      \"entry\": \"如 4172.0-4176.5 区间分批\",\n\
      \"entry_mid\": 数字，入场中值,\n\
      \"sl\": 数字, \"sl_note\": \"依据：结构外侧，约 0.7 倍 ATR\",\n\
      \"tp1\": 数字, \"tp1_note\": \"依据：前高 4186.41 附近\",\n\
      \"tp2\": 数字, \"tp2_note\": \"依据：通道上轨延伸\",\n\
      \"rr1\": 数字, \"rr2\": 数字,\n\
      \"hold\": \"如 短线回踩多，TP1 减半推保护剩仓看 TP2\"\n\
    }},\n\
    {{ \"side\": \"short\", \"style\": \"如 反弹做空\", 其余字段与 long 同构 }}\n\
  ]\n\
}}\n\
\n\
模块与方案硬要求：\n\
- modules 四个按顺序必给；某模块依据不足就把该模块 status 写「未明确」，不得编造\n\
- plans 必须同时给做多、做空两套完整点位；即使策略禁止某方向也给出供参考\n\
- 每套的 sl/tp1/tp2 必须是给定行情中的真实价位，note 注明依据（前高前低/均线/通道/整数关）\n\
- rr1 = |tp1-entry_mid| / |entry_mid-sl|，rr2 同理，保留一位小数\n\
- **侧重点必须体现本策略的人格**：modules 的观察角度、trigger 的触发措辞、style_tag 的风格短语，\n\
  一律按本策略的类型与入场逻辑组织——趋势回踩看回踩位与趋势延续、区间突破看箱体边界与假突破陷阱、\n\
  均值回归看超买超卖与回归目标、M5 剥头皮看短周期动能与点差滑点成本、宏观顺势只看大周期结构与回调位；\n\
  同一行情下不同策略允许给出不同的 sentiment、模块结论与触发条件，严禁输出放之四海皆同的雷同分析；\n\
  trigger 必须用本策略自己的入场条件措辞（回踩+吞没 / 突破+量能 / 超卖回归 等），不套通用模板\n\
\n\
{discipline}\n\
【纪律】\n\
- 必须逐条核对所列周期是否同向，不一致就明确说\"周期背离\"并给 none\n\
- 方向与用户口径冲突时以用户口径为准；口径没写方向就用策略配置\n\
- 价格必须来自给定行情，不得编造\n\
- 条件不足就给 none，不要为了给方向而硬凑\n\
- 不承诺收益，不出现\"必涨\"\"稳赚\"",
        name = strategy.name,
        desc = strategy.desc,
        exec = strategy.exec_interval,
        dir = strategy.dir_interval,
        conf = strategy.confirm_interval,
        rr = strategy.rr_min,
        floor = strategy.confidence_floor,
        risk = strategy.risk_percent,
        long = if strategy.allow_long { "允许" } else { "禁止" },
        short = if strategy.allow_short { "允许" } else { "禁止" },
        daily = max_daily,
        focus = focus,
        prompt = strategy.prompt,
        personal = personal,
        discipline = DISCIPLINE_BLOCK,
    )
}

/// 从模型返回里抠出 JSON（容忍代码块包裹与前后废话）
pub fn extract_json(text: &str) -> Option<Verdict> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Verdict>(t) {
        return Some(v);
    }
    let stripped = t
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(v) = serde_json::from_str::<Verdict>(stripped) {
        return Some(v);
    }
    let a = stripped.find('{')?;
    // 截断的输出根本没有收尾的 }，所以这里不能提前返回
    if let Some(b) = stripped.rfind('}') {
        if b > a {
            if let Ok(v) = serde_json::from_str::<Verdict>(&stripped[a..=b]) {
                return Some(v);
            }
        }
    }
    // 输出被 max_tokens 截断：补齐未闭合的括号再试。
    // JSON 截断通常只是少了收尾的 } 或 ]。
    if let Some(fixed) = close_brackets(&stripped[a..]) {
        if let Ok(v) = serde_json::from_str::<Verdict>(&fixed) {
            return Some(v);
        }
    }
    serde_json::from_str::<Verdict>(&stripped[a..]).ok()
}

/// 按栈顺序补齐未闭合的括号：{"a":[1,2 → {"a":[1,2]}
fn close_brackets(s: &str) -> Option<String> {
    let mut stack: Vec<char> = Vec::new();
    let mut in_str = false;
    let mut prev_escape = false;

    for c in s.chars() {
        if in_str {
            if c == '"' && !prev_escape {
                in_str = false;
            }
            prev_escape = c == '\\' && !prev_escape;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                prev_escape = false;
            }
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                stack.pop();
            }
            _ => {}
        }
    }

    if stack.is_empty() {
        return None;
    }
    // 截断常发生在字符串中间，补引号让它闭合
    let mut out = String::with_capacity(s.len() + stack.len() + 2);
    out.push_str(s);
    if in_str {
        out.push('"');
    }
    // 逆序补：栈顶是最外层
    for c in stack.iter().rev() {
        out.push(*c);
    }
    Some(out)
}


/// 代码风控裁决 AI 的判断
pub fn judge(v: &Verdict, s: &Settings, daily_count: u32, daily_pnl: f64) -> RiskVerdict {
    // AI 明确观望，直接放行但不算入场
    if v.direction == "none" {
        return RiskVerdict {
            allowed: false,
            blocks: vec!["AI 判定为观望，不构成入场".into()],
            warns: Vec::new(),
            lot: 0.0,
            risk_money: 0.0,
            rr: 0.0,
            sl_points: 0.0,
            tp_points: 0.0,
            plan: None,
        };
    }

    if v.sl <= 0.0 || v.tp <= 0.0 || v.entry <= 0.0 {
        return RiskVerdict {
            allowed: false,
            blocks: vec!["AI 未给出完整的入场/止损/目标价".into()],
            warns: Vec::new(),
            lot: 0.0,
            risk_money: 0.0,
            rr: 0.0,
            sl_points: 0.0,
            tp_points: 0.0,
            plan: None,
        };
    }

    // 手数由代码按权益风险算（AI 不给手数）。
    // 注意：不能直接用 risk::plan 的 tp —— 它会按 rr_min 反推目标价，
    // 把 AI 给的真实目标覆盖掉。这里只借它算手数。
    let plan_for_lot = risk::plan(&v.direction, v.entry, v.sl, s);

    // 盈亏比用 AI 自己给的入场/止损/目标算
    let sl_points = (v.entry - v.sl).abs() / s.point_value;
    let tp_points = (v.tp - v.entry).abs() / s.point_value;
    let rr = if sl_points > 0.0 { tp_points / sl_points } else { 0.0 };

    let gate: Gate = risk::gate_check(
        risk::GateInput {
            direction: &v.direction,
            sl_points,
            tp_points,
            lot: plan_for_lot.lot,
            daily_count,
            daily_pnl,
            near_event: false,
        },
        s,
    );

    // 置信度由代码把关，模型说了不算
    let mut blocks = gate.blocks;
    let warns = gate.warns;
    if v.confidence < s.strategy.confidence_floor {
        blocks.push(format!(
            "AI 置信度 {:.0} 低于下限 {:.0}",
            v.confidence, s.strategy.confidence_floor
        ));
    }

    // 回填 AI 的真实目标，别用反推值
    let plan = Plan {
        tp_price: v.tp,
        tp_points,
        sl_points,
        rr,
        ..plan_for_lot
    };

    RiskVerdict {
        allowed: blocks.is_empty(),
        blocks,
        warns,
        lot: plan.lot,
        risk_money: plan.risk_money,
        rr,
        sl_points: plan.sl_points,
        tp_points: plan.tp_points,
        plan: Some(plan),
    }
}