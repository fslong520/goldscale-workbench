//! AI 分析：代理转发到兼容 OpenAI ChatCompletions 的接口
//!
//! 密钥只存本地 settings.json，请求由本机后端发出，不经过浏览器。
//! 支持 DeepSeek、Moonshot、通义、Kimi、智谱、OpenAI 等任意兼容服务商。

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::config::Settings;
use crate::data::Bar;

// ---------- 上下文预算 ----------

/// DeepSeek flash / v4-pro 官方标称 1M 上下文，留 10% 余量。
pub const CONTEXT_LIMIT: usize = 900_000;

/// 粗略 token 估算：中文按 1 字 1 token，ASCII 按 4 字符 1 token。
/// 用于在发送前自我保护，避免超限被服务端拒绝。
pub fn estimate_tokens(s: &str) -> usize {
    let mut cn = 0usize;
    let mut other = 0usize;
    for c in s.chars() {
        if c.is_ascii() {
            other += 1;
        } else {
            cn += 1;
        }
    }
    cn + other / 4
}

/// 预算档位。返回目标 token 数。
pub fn budget_tokens(level: u8) -> usize {
    match level {
        0 => 20_000,          // 省：够看 200 根 15 分钟线
        1 => 100_000,         // 标准：多周期 + 半年日线
        2 => 400_000,         // 深度：全周期长历史
        _ => CONTEXT_LIMIT,   // 极限：9 成上限
    }
}

/// 按预算从旧到新保留数据，优先保近期。
/// 返回 (保留部分, 是否截断)
fn take_within_budget<'a>(parts: Vec<&'a str>, budget: usize) -> (Vec<&'a str>, bool) {
    let mut used = 0usize;
    let mut kept: Vec<&'a str> = Vec::with_capacity(parts.len());
    let mut truncated = false;

    // 从最新一段开始加，旧的先跳过
    for p in parts.iter().rev() {
        let t = estimate_tokens(p);
        if used + t > budget {
            truncated = true;
            continue;
        }
        used += t;
        kept.push(p);
    }
    kept.reverse();
    (kept, truncated)
}

#[derive(Serialize)]
struct ChatReq {
    model: String,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    /// 完全关闭思考（deepseek 兼容端点实测：reasoning=None）
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<ThinkingOff>,
    /// 思考强度（deepseek 实测此字段才生效：low/high）
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'static str>,
}

#[derive(Serialize)]
struct ThinkingOff {
    #[serde(rename = "type")]
    kind: &'static str,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResp {
    #[serde(default)]
    choices: Vec<Choice>,
    /// 部分服务商会在错误时返回这个
    #[serde(default)]
    error: Option<ApiErr>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    prompt_tokens: usize,
    #[serde(default)]
    completion_tokens: usize,
    #[serde(default, rename = "completion_tokens_details")]
    details: Option<Details>,
}

#[derive(Deserialize)]
struct Details {
    #[serde(default)]
    reasoning_tokens: usize,
}

#[derive(Deserialize)]
struct ApiErr {
    #[serde(default)]
    message: String,
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
struct Choice {
    message: MsgOut,
}

#[derive(Deserialize)]
struct MsgOut {
    #[serde(default)]
    content: String,
    /// 思考模型会把内容放在这里
    #[serde(rename = "reasoning_content", default)]
    reasoning: Option<String>,
}

/// 组装行情上下文：按 token 预算装填多周期历史
///
/// 策略：先放最关键的一小段近期数据，再按预算补充更长的历史与更多周期。
/// 这样即使预算很小，也保证模型看到的是最新行情而非旧数据。
pub fn build_context(
    exec: &[Bar],
    exec_iv: &str,
    dir: Option<(&[Bar], &str)>,
    conf: Option<(&[Bar], &str)>,
    spot: Option<f64>,
    ind_summary: &str,
    budget: usize,
) -> (String, usize) {
    // 预算极小时也要保住最小可用集：现价 + 指标 + 最近 20 根 K 线
    let min_core = 1_200usize;
    let budget = budget.max(min_core);

    // ---- 数据新鲜度自检：末根 K 线收盘与现价偏差过大时主动声明 ----
    let last_close = exec.last().map(|b| b.c);
    let last_ts = exec.last().map(|b| b.t);
    let gap_desc = match (spot, last_close) {
        (Some(p), Some(c)) => {
            let diff = (p - c).abs();
            if diff / c.max(0.01) > 0.002 {
                Some(format!(
                    "【重要】现价 {:.2} 与 {} 最后一根 K 线收盘 {:.2} 相差 {:.2} 美元（{:.2}%）。\
K 线数据可能已陈旧（末根时间 {}），请以现价为准判断当下位置，\
不要把 K 线末值当作当前价格。",
                    p,
                    exec_iv,
                    c,
                    diff,
                    diff / c.max(0.01) * 100.0,
                    last_ts
                        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
                        .map(|d| d.format("%m-%d %H:%M").to_string())
                        .unwrap_or_default()
                ))
            } else {
                None
            }
        }
        _ => None,
    };
    let warnings: Vec<String> = gap_desc.into_iter().collect();

    // ---- 核心区块：最高优先级，永不丢弃 ----
    let core = format!(
        "【品种】黄金 XAU/USD（美元/盎司）　【执行周期】{}\n【现价】{}",
        exec_iv,
        spot.map(|p| format!("{:.2}", p)).unwrap_or("--".into())
    );
    let core_ind = format!("【技术指标】\n{}", ind_summary);
    let core_bars = section_bars(exec, exec_iv, 20, "执行周期近期K线");

    let mut out: Vec<String> = Vec::new();
    out.extend(warnings);
    out.push(core);
    out.push(core_ind);
    out.push(core_bars);

    // ---- 剩余预算给扩充数据 ----
    let used: usize = out.iter().map(|b| estimate_tokens(b)).sum();
    let left = budget.saturating_sub(used);

    let mut extra: Vec<String> = Vec::new();
    extra.push(section_bars(exec, exec_iv, 300, "执行周期更长历史"));
    if let Some((b, iv)) = dir {
        extra.push(section_bars(b, iv, 200, "定方向周期K线"));
    }
    if let Some((b, iv)) = conf {
        extra.push(section_bars(b, iv, 80, "确认周期K线"));
    }
    // 更长的历史放在最后，预算不够时最先被砍
    extra.push(section_bars(exec, exec_iv, 900, "执行周期长历史"));
    if let Some((b, iv)) = dir {
        extra.push(section_bars(b, iv, 700, "定方向周期长历史"));
    }

    let parts: Vec<&str> = extra.iter().map(|s| s.as_str()).collect();
    // 从后往前取，优先保留靠前的区块（更新的数据）
    let (kept, truncated) = take_within_budget(parts, left);
    for k in kept {
        out.push(k.to_string());
    }
    if truncated {
        out.push("（受 token 预算限制，部分历史数据未包含）".to_string());
    }

    let text = out.join("\n\n");
    let tokens = estimate_tokens(&text);
    (text, tokens)
}

/// 生成一个周期的 K 线区块
fn section_bars(bars: &[Bar], iv: &str, want: usize, title: &str) -> String {
    if bars.is_empty() {
        return format!("【{}】{}：无数据", title, iv);
    }
    let start = bars.len().saturating_sub(want);
    let mut s = format!("【{}】{}（{} 根）", title, iv, bars.len() - start);
    for b in &bars[start..] {
        let ts = chrono::DateTime::from_timestamp(b.t, 0)
            .map(|d| d.format("%m-%d %H:%M").to_string())
            .unwrap_or_default();
        s.push_str(&format!(
            "\n{} O{:.2} H{:.2} L{:.2} C{:.2} V{:.0}",
            ts, b.o, b.h, b.l, b.c, b.v
        ));
    }
    s
}

/// 系统提示词：注入当前策略、用户口径与硬性约束
pub fn system_prompt(
    strategy: &crate::config::Strategy,
    personal_text: &str,
    rr_min: f64,
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
        "你是一名谨慎的贵金属交易分析师，服务于一个本地模拟交易工具。\n\
直接给出结论，不要输出思考过程。\n\
\n\
【当前启用策略】{name}（{desc}）\n\
规则参数：执行周期 {exec}，定方向 {dir}，确认周期 {conf}；\
最低盈亏比 {rr}，置信度下限 {floor}，单笔风险 {risk}%，\
做多 {long}，做空 {short}，日内最多 {daily} 单。\n\
{focus}\n\
【策略分析要求】\n{prompt}\n\
\n\
【用户自述口径】（补充策略未说清的细节；若与「{name}」的类型明显冲突，以当前策略为准并指出冲突）\n{personal}\n\
\n\
【输出格式】中文，不写客套话：\n\
1. 【结论】看多 / 看空 / 观望，一句话\n\
2. 【依据】分条列出，引用具体价位与指标数值\n\
3. 【关键价位】支撑与阻力，标明具体价格\n\
4. 【操作建议】若满足条件给出参考入场价、止损价、第一目标价\n\
5. 【风险提示】当前配置下最可能出错的地方\n\
\n\
{discipline}\n\
【硬性要求】\n\
- 必须逐条核对上述策略参数，不满足就明说哪条不满足\n\
- 不确定就写\"不确定\"，严禁编造价位\n\
- 不承诺收益，不出现\"必涨\"\"稳赚\"\"无风险\"\n\
- 结论不得违背用户口径里写明的方向偏好\n\
- 全文 600 字以内",
        name = strategy.name,
        desc = strategy.desc,
        exec = strategy.exec_interval,
        dir = strategy.dir_interval,
        conf = strategy.confirm_interval,
        rr = rr_min,
        floor = strategy.confidence_floor,
        risk = strategy.risk_percent,
        long = if strategy.allow_long { "允许" } else { "禁止" },
        short = if strategy.allow_short { "允许" } else { "禁止" },
        daily = max_daily,
        focus = focus,
        prompt = strategy.prompt,
        personal = personal_text,
        discipline = crate::enhance::DISCIPLINE_BLOCK,
    )
}

/// 发起对话
pub struct ChatOut {
    pub text: String,
    /// 思考过程原文（与回答分开；关闭思考时为空）
    pub reasoning: String,
    pub prompt_tokens: usize,
    pub completion_tokens: usize,
    pub reasoning_tokens: usize,
}

pub async fn chat(
    s: &Settings,
    system: &str,
    user_content: &str,
) -> Result<ChatOut> {
    if s.ai.api_key.trim().is_empty() {
        return Err(anyhow!("未配置 API 密钥，请到设置页填写"));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()?;

    // 思考三档（2026-10-04 探针实测：effort 字段无效，reasoning_effort 才生效，
    // thinking=disabled 完全关）。max_tokens 按档给足——思考与回答共用此预算：
    // 关=只够回答；低=思考约5k+回答；高=思考可能上万，给 32k 防截断。
    let ds = s.ai.base_url.contains("deepseek");
    let (thinking, reffort, max_tok) = if ds {
        match s.ai.thinking.trim() {
            "off" => (Some(ThinkingOff { kind: "disabled" }), None, 4000),
            "high" => (None, Some("high"), 32000),
            _ => (None, Some("low"), 12000),
        }
    } else {
        (None, None, 8000)
    };

    let body = ChatReq {
        model: s.ai.model.trim().to_string(),
        temperature: Some(s.ai.temperature as f32),
        // 给足：thinking 模式的思维链也占预算，
        // 而结构化 JSON 一旦被截断就成了废数据，解析不出来。
        // 2026-10-04：结构化研判（模块+双方案）后 4000 不够，思考吃光预算
        // 致 content 为空，升 8000。
        max_tokens: Some(max_tok),
        // 仅 deepseek 附带 effort：默认 high 在 36k 输入下 reasoning 吃满
        // 8000 致 content 空（实测 reasoning_tokens=8000=completion），压到 low
        thinking,
        reasoning_effort: reffort,
        messages: vec![
            Message { role: "system".into(), content: system.into() },
            Message { role: "user".into(), content: user_content.into() },
        ],
    };

    // 兼容两种 base_url 写法：带 /v1 或不带
    let url = normalize_url(&s.ai.base_url);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", s.ai.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("请求失败: {}", e))?;

    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        // 尝试解析错误体，给出可读原因
        if let Ok(parsed) = serde_json::from_str::<ChatResp>(&text) {
            if let Some(err) = parsed.error {
                return Err(anyhow!(
                    "接口返回 {}：{}{}",
                    status,
                    if err.kind.is_empty() { String::new() } else { format!("[{}] ", err.kind) },
                    err.message
                ));
            }
        }
        // 401/404 多半是密钥或模型名不对
        let hint = match status.as_u16() {
            401 => "（密钥无效或已过期）",
            404 => "（地址或模型名不存在，请对照服务商文档）",
            429 => "（触发限流或余额不足，稍后再试）",
            _ => "",
        };
        return Err(anyhow!("接口返回 {}: {}{}", status, truncate(&text, 160), hint));
    }

    let parsed: ChatResp = serde_json::from_str(&text)
        .map_err(|e| anyhow!("响应解析失败: {} {}", e, truncate(&text, 160)))?;

    if let Some(err) = parsed.error {
        return Err(anyhow!("接口报错: {}", err.message));
    }

    let (prompt_tokens, completion_tokens, reasoning_tokens) = match &parsed.usage {
        Some(u) => (
            u.prompt_tokens,
            u.completion_tokens,
            u.details.as_ref().map(|d| d.reasoning_tokens).unwrap_or(0),
        ),
        None => (0, 0, 0),
    };

    let choice = parsed
        .choices
        .first()
        .ok_or_else(|| anyhow!("响应无内容，可能被安全策略拦截"))?;

    // 思考与回答分开：reasoning 单独回传，绝不混进正式回答
    let reasoning = choice
        .message
        .reasoning
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let content = choice.message.content.trim().to_string();
    if content.is_empty() {
        return Err(anyhow!(
            "模型思考了 {} token 但未产出正式回答（被 max_tokens 截断）：\
             请到设置页把思考模式调低或关闭后重试",
            reasoning_tokens
        ));
    }
    Ok(ChatOut { text: content, reasoning, prompt_tokens, completion_tokens, reasoning_tokens })
}

/// 把用户填的地址补成完整的 chat/completions
pub fn normalize_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        return "https://api.deepseek.com/chat/completions".into();
    }
    if b.ends_with("/chat/completions") {
        return b.into();
    }
    if b.ends_with("/v1") {
        return format!("{}/chat/completions", b);
    }
    format!("{}/chat/completions", b)
}

/// 内置服务商预设，供设置页一键填入
///
/// DeepSeek 在 2026-07-24 下线了 deepseek-chat 与 deepseek-reasoner，
/// 当前可用的是 deepseek-flash（默认思考模式）与 deepseek-v4-pro。
pub fn presets() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("DeepSeek 快速", "https://api.deepseek.com", "deepseek-flash"),
        ("DeepSeek 深度", "https://api.deepseek.com", "deepseek-v4-pro"),
        ("Moonshot Kimi", "https://api.moonshot.cn/v1", "moonshot-v1-8k"),
        ("通义千问", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
        ("智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", "glm-4-flash"),
        ("OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"),
    ]
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}