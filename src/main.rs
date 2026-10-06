//! 金秤 · 贵金属交易工作台 —— HTTP 服务
//!
//! 只做产品业务（行情/策略/回测/账本/记忆插件）。本地 Agent 已拆出为独立常驻服务
//! `goldscale-agentd`（`127.0.0.1:8788`，见 src/bin/agentd.rs）——本进程**不再拉起 pi
//! 子进程**，故金秤重启杀不着 agent 会话；反过来 agentd 还负责把金秤拉起来。

mod agent;
mod ai;
mod backtest;
mod cond;
mod config;
mod data;
mod enhance;
mod indicators;
mod portfolio;
mod risk;
mod rsbridge;
mod strategy;

#[cfg(test)]
mod tests;

use indicators as ind;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use config::Settings;
use data::Hub;
use portfolio::Ledger;

struct AppState {
    hub: Arc<Hub>,
    ledger: std::sync::Mutex<Ledger>,
}

type St = Arc<AppState>;

/// 统一响应包
#[derive(Serialize)]
struct Api<T> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl<T> Api<T> {
    fn good(d: T) -> Self {
        Api { ok: true, data: Some(d), error: None }
    }
    fn bad<E: std::fmt::Display>(e: E) -> Self {
        Api { ok: false, data: None, error: Some(e.to_string()) }
    }
}

/// 数据源异常时统一回 502
type Err502 = (StatusCode, Json<Api<()>>);

fn fail502<T: std::fmt::Display>(msg: T) -> Err502 {
    (StatusCode::BAD_GATEWAY, Json(Api::bad(msg)))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "goldscale=info,tower_http=warn".into()),
        )
        .init();

    let settings = Settings::load();
    let ledger = Ledger::load(&settings);
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);

    let state = Arc::new(AppState {
        hub: Arc::new(Hub::new()),
        ledger: std::sync::Mutex::new(ledger),
    });

    // 静态资源查找：可执行同级 → 上两级（target/debug → 项目根） → 当前目录
    let static_dir = {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        let cands = [
            exe_dir.clone(),
            exe_dir.join("../.."),
            exe_dir.join(".."),
            std::path::PathBuf::from("."),
        ];
        let found = cands.iter().find(|d| d.join("index.html").exists()).cloned();
        match found {
            Some(d) => {
                tracing::info!("静态资源目录: {}", d.display());
                d
            }
            None => {
                tracing::warn!("未找到 index.html，回退到 exe 同级目录");
                exe_dir
            }
        }
    };

    tracing::info!("金秤 {} 启动", env!("CARGO_PKG_VERSION"));

    // 绑定地址：默认仅本机回环——Agent 带命令执行能力，绝不能默认暴露局域网；
    // 需要局域网访问时显式 GOLDSCALE_BIND=0.0.0.0 启动
    let bind = std::env::var("GOLDSCALE_BIND").unwrap_or_else(|_| "127.0.0.1".into());
    tracing::info!("监听 http://{}:{}（浏览器打开该地址）", bind, port);

    // 启动预热：并行拉齐五个周期与现价（磁盘缓存命中的直接秒回），
    // 之后页面请求全走内存缓存，不再各自打上游
    {
        let bg = Arc::clone(&state);
        tokio::spawn(async move {
            let s = Settings::load();
            bg.hub.prewarm(&s).await;
        });
    }

    // 后台盯盘：按设置的间隔轮询行情，触发持仓的止盈止损
    {
        let bg = Arc::clone(&state);
        tokio::spawn(async move {
            loop {
                let s = Settings::load();
                if let Ok(sp) = bg.hub.spot(&s).await {
                    let events = {
                        let mut l = bg.ledger.lock().unwrap();
                        l.tick(sp.price, &s)
                    };
                    for e in events {
                        tracing::info!("持仓事件: {}", e);
                    }
                    let _ = sp;
                }
                // 后台续期 K 线：用 series_refresh 强制真回源（series 的"过期返旧"
                // 捷径只给前台读），页面请求因此永远命中新鲜缓存
                let (a, b, c, d, e) = tokio::join!(
                    bg.hub.series_refresh("5m", &s),
                    bg.hub.series_refresh("15m", &s),
                    bg.hub.series_refresh("1h", &s),
                    bg.hub.series_refresh("4h", &s),
                    bg.hub.series_refresh("1d", &s),
                );
                if [a, b, c, d, e].iter().any(|r| r.is_err()) {
                    tracing::warn!("部分周期续期失败，页面将回落旧缓存或明确报错");
                }
                tokio::time::sleep(std::time::Duration::from_secs(s.exit.cycle_sec)).await;
            }
        });
    }

    // 不设 CORS：本地同源使用即可。放行跨域会允许任意网页读走 API 密钥与账本。
    // （能执行命令的 /api/agent 已随 pihost 迁到 agentd:8788，那边用 Origin 白名单守门）
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(get_settings).post(save_settings))
        .route("/api/series", get(get_series))
        .route("/api/spot", get(get_spot))
        .route("/api/indicators", get(get_indicators))
        .route("/api/signal", get(get_signal))
        .route("/api/signal/enhanced", get(get_signal_enhanced))
        .route("/api/positions", get(get_positions).post(open_position))
        .route("/api/positions/close", post(close_position))
        .route("/api/positions/partial", post(close_partial))
        .route("/api/positions/sl", post(set_sl))
        .route("/api/stats", get(get_stats))
        .route("/api/portfolio/reset-daily", post(reset_daily))
        .route("/api/ai", post(ai_chat))
        .route("/api/ai/presets", get(ai_presets))
        .route("/api/ai/log", get(get_ai_log))
        .route("/api/backtest", post(backtest))
        .route("/api/backtest/optimize", post(backtest_optimize))
        .route("/api/memory", get(list_memory).post(save_memory))
        .route("/api/memory/plugin", get(memory_plugin))
        .route("/api/memory/plugin/enable", post(memory_plugin_enable))
        .route("/api/memory/plugin/disable", post(memory_plugin_disable))
        .route("/api/memory/:id", axum::routing::delete(delete_memory))
        .route("/api/ai/check", post(ai_check))
        .layer(TraceLayer::new_for_http())
        .fallback_service(
            ServeDir::new(&static_dir).append_index_html_on_directories(true),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("{}:{}", bind, port)).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

// ---------- 基础 ----------

async fn health() -> Json<Api<serde_json::Value>> {
    Json(Api::good(serde_json::json!({
        "name": "金秤",
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

async fn get_settings() -> Json<Api<Settings>> {
    Json(Api::good(Settings::load()))
}

async fn save_settings(Json(s): Json<Settings>) -> Json<Api<String>> {
    match s.save() {
        Ok(_) => Json(Api::good("设置已保存".into())),
        Err(e) => Json(Api::bad(format!("保存失败: {}", e))),
    }
}

// ---------- 行情 ----------

#[derive(Deserialize)]
struct IvQuery {
    #[serde(default = "def_iv")]
    interval: String,
    #[serde(default)]
    force: String,
}

/// 宽松布尔解析：true/false/1/0/yes/on 都认，
/// 避免调用方传 1 时 axum 直接 400
fn flag(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}
fn def_iv() -> String {
    "5m".into()
}

async fn get_series(
    State(st): State<St>,
    Query(q): Query<IvQuery>,
) -> Result<Json<Api<data::Series>>, Err502> {
    let s = Settings::load();
    st.hub
        .series(&q.interval, &s, flag(&q.force))
        .await
        .map(|v| Json(Api::good(v)))
        .map_err(|e| fail502(format!("行情获取失败: {}", e)))
}

async fn get_spot(State(st): State<St>) -> Json<Api<data::Spot>> {
    let s = Settings::load();
    match st.hub.spot(&s).await {
        Ok(v) => Json(Api::good(v)),
        Err(e) => Json(Api::bad(format!("现价获取失败: {}", e))),
    }
}

#[derive(Serialize)]
struct Indicators {
    interval: String,
    stale: bool,
    simulated: bool,
    times: Vec<i64>,
    ema20: Vec<Option<f64>>,
    ema50: Vec<Option<f64>>,
    rsi14: Vec<Option<f64>>,
    atr14: Vec<Option<f64>>,
    macd_dif: Vec<Option<f64>>,
    macd_dea: Vec<Option<f64>>,
    macd_hist: Vec<Option<f64>>,
    boll_mid: Vec<Option<f64>>,
    boll_up: Vec<Option<f64>>,
    boll_dn: Vec<Option<f64>>,
}

async fn get_indicators(
    State(st): State<St>,
    Query(q): Query<IvQuery>,
) -> Result<Json<Api<Indicators>>, Err502> {
    let s = Settings::load();
    let ser = st
        .hub
        .series(&q.interval, &s, flag(&q.force))
        .await
        .map_err(|e| fail502(format!("行情获取失败: {}", e)))?;

    let b = &ser.bars;
    let (dif, dea, hist) = ind::macd(b, 12, 26, 9);
    let bb = ind::boll(b, 20, 2.0);

    Ok(Json(Api::good(Indicators {
        interval: q.interval,
        stale: ser.stale,
        simulated: ser.simulated,
        times: b.iter().map(|x| x.t).collect(),
        ema20: ind::ema(b, 20),
        ema50: ind::ema(b, 50),
        rsi14: ind::rsi(b, 14),
        atr14: ind::atr(b, 14),
        macd_dif: dif,
        macd_dea: dea,
        macd_hist: hist,
        boll_mid: bb.mid,
        boll_up: bb.upper,
        boll_dn: bb.lower,
    })))
}

// ---------- 信号 ----------

#[derive(Deserialize)]
struct SignalQuery {
    #[serde(default)]
    exec: String,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    confirm: String,
    /// 指定策略 id；留空用当前生效策略
    #[serde(default)]
    strategy: String,
    /// true 时对所有启用的策略并行评估
    #[serde(default)]
    all: String,
}

/// 取指定周期 K 线，失败时用执行周期顶替
async fn series_or_fallback(
    st: &St,
    s: &Settings,
    iv: &str,
    fallback: &data::Series,
    label: &str,
) -> data::Series {
    match st.hub.series_refresh(iv, s).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("{} 行情失败，用执行周期代替: {}", label, e);
            data::Series {
                bars: fallback.bars.clone(),
                stale: true,
                simulated: false,
                source: format!("降级：{}（{} 不可用）", label, iv),
                fetched_at: 0,
                interval: iv.to_string(),
                points: 0,
                error: Some(format!("{} 周期不可用: {}", iv, e)),
            }
        }
    }
}

async fn get_signal(
    State(st): State<St>,
    Query(q): Query<SignalQuery>,
) -> Result<Json<Api<serde_json::Value>>, Err502> {
    let s = Settings::load();

    // 先取执行周期，作为其他周期的降级底座
    let exec_iv = if q.exec.is_empty() { s.active().exec_interval } else { q.exec.clone() };
    let exec = st
        .hub
        .series(&exec_iv, &s, false)
        .await
        .map_err(|e| fail502(format!("执行周期({})行情失败: {}", exec_iv, e)))?;

    // 多策略并行评估
    if flag(&q.all) {
        let enabled: Vec<_> = s
            .strategies
            .iter()
            .filter(|x| x.enabled)
            .cloned()
            .collect();
        let pool = if enabled.is_empty() { vec![s.active()] } else { enabled };

        let mut results = Vec::with_capacity(pool.len());
        for stg in pool {
            let (d, c) = tokio::join!(
                st.hub.series(&stg.dir_interval, &s, false),
                st.hub.series(&stg.confirm_interval, &s, false),
            );
            let dir = series_or_fallback(&st, &s, &stg.dir_interval, &exec, "定方向").await;
            let conf = series_or_fallback(&st, &s, &stg.confirm_interval, &exec, "确认").await;
            let _ = (d, c);

            let e2 = if stg.exec_interval == exec_iv {
                exec.clone()
            } else {
                match st.hub.series(&stg.exec_interval, &s, false).await {
                    Ok(v) => v,
                    Err(_) => exec.clone(),
                }
            };

            results.push(strategy::evaluate(
                strategy::Input {
                    dir_bars: &dir.bars,
                    exec_bars: &e2.bars,
                    conf_bars: &conf.bars,
                    strategy: Some(stg),
                },
                &s,
            ));
        }
        return Ok(Json(Api::good(serde_json::to_value(results).unwrap_or_default())));
    }

    // 单策略评估
    let dir_iv = if q.dir.is_empty() { s.active().dir_interval } else { q.dir.clone() };
    let conf_iv = if q.confirm.is_empty() {
        s.active().confirm_interval
    } else {
        q.confirm.clone()
    };

    let dir = series_or_fallback(&st, &s, &dir_iv, &exec, "定方向").await;
    let conf = series_or_fallback(&st, &s, &conf_iv, &exec, "确认").await;

    let target = if q.strategy.is_empty() {
        None
    } else {
        s.strategies.iter().find(|x| x.id == q.strategy).cloned()
    };

    let sig = strategy::evaluate(
        strategy::Input {
            dir_bars: &dir.bars,
            exec_bars: &exec.bars,
            conf_bars: &conf.bars,
            strategy: target,
        },
        &s,
    );
    Ok(Json(Api::good(
        serde_json::to_value(sig).unwrap_or_default(),
    )))
}

/// 规则判定 + AI 诊断。
/// AI 只做分析，硬条件仍由规则把关；未配密钥时 enhancement 为 null，前端退回纯规则。
async fn get_signal_enhanced(
    State(st): State<St>,
    Query(q): Query<SignalQuery>,
) -> Result<Json<Api<enhance::Analysis>>, Err502> {
    let s = Settings::load();

    let active = if q.strategy.is_empty() {
        s.active()
    } else {
        s.strategies
            .iter()
            .find(|x| x.id == q.strategy)
            .cloned()
            .unwrap_or_else(|| s.active())
    };

    let exec_iv = active.exec_interval.clone();
    let exec = st
        .hub
        .series(&exec_iv, &s, false)
        .await
        .map_err(|e| fail502(format!("执行周期({})行情失败: {}", exec_iv, e)))?;

    let dir = series_or_fallback(&st, &s, &active.dir_interval, &exec, "定方向").await;
    let conf = series_or_fallback(&st, &s, &active.confirm_interval, &exec, "确认").await;

    let sig = strategy::evaluate(
        strategy::Input {
            dir_bars: &dir.bars,
            exec_bars: &exec.bars,
            conf_bars: &conf.bars,
            strategy: Some(active.clone()),
        },
        &s,
    );

    // 起手必接上次：研判前先取同策略最近一条「研判结论」注入 prompt（网关不可达/未开记忆都静默）
    let prior = prior_research(&active.name).await;
    if let Some(p) = &prior {
        tracing::info!("研判接上次：{}（{}）", p.title, p.id);
    }
    let (verdict, err, pt, ct, rt, reason) =
        analyze(&st, &s, &active, &sig, &exec, &dir, &conf, prior.as_ref()).await;
    // 风控裁决：AI 说了不算，代码按数字判
    let (daily_count, daily_pnl) = {
        let l = st.ledger.lock().unwrap();
        (l.daily_count, l.daily_pnl)
    };
    let risk_v = verdict
        .as_ref()
        .map(|v| enhance::judge(v, &s, daily_count, daily_pnl));

    // 结论回写记忆（三标结论、importance 70、经网关判重）：fire-and-forget + 最长 5s 短等，
    // 失败只 warn——归档是加分项，绝不许拖累或污染研判响应。
    let refs: Vec<enhance::MemRef> = prior
        .as_ref()
        .map(|p| vec![enhance::MemRef { id: p.id.clone(), title: p.title.clone() }])
        .unwrap_or_default();
    if s.memory_enabled {
        if let Some(v) = verdict.as_ref() {
            spawn_archive(&active.id, &active.name, &sig.summary, v, prior.as_ref()).await;
        }
    }

    let out = enhance::Analysis {
        signal: sig,
        verdict,
        risk: risk_v,
        model: s.ai.model.clone(),
        prompt_tokens: pt,
        completion_tokens: ct,
        reasoning_tokens: rt,
        ai_error: err,
        reasoning_text: if reason.is_empty() { None } else { Some(reason) },
        memory_refs: refs,
    };
    // 每次研判落盘一行，供历史回看（含完整结果与思考）
    append_ai_log(&active.id, &active.name, &out);
    Ok(Json(Api::good(out)))
}

// ---------- AI 分析日志 ----------

fn ai_log_path() -> std::path::PathBuf {
    Settings::data_dir().join("ai_log.jsonl")
}

/// 追加一条 AI 研判日志；超 600 行裁到 400 防无限膨胀
fn append_ai_log(sid: &str, sname: &str, a: &enhance::Analysis) {
    use std::io::Write;
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let entry = serde_json::json!({
        "t": t,
        "sid": sid,
        "sname": sname,
        "direction": a.verdict.as_ref().map(|v| v.direction.as_str()),
        "confidence": a.verdict.as_ref().map(|v| v.confidence),
        "summary": a.verdict.as_ref().map(|v| v.summary.as_str()),
        "style": a.verdict.as_ref().map(|v| v.style_tag.as_str()),
        "ai_error": a.ai_error,
        "tokens": { "in": a.prompt_tokens, "out": a.completion_tokens, "think": a.reasoning_tokens },
        "analysis": serde_json::to_value(a).unwrap_or_default(),
    });
    let Ok(line) = serde_json::to_string(&entry) else { return };
    let path = ai_log_path();
    let res = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{}", line));
    if let Err(e) = res {
        tracing::warn!("AI 日志写入失败: {}", e);
        return;
    }
    if let Ok(txt) = std::fs::read_to_string(&path) {
        let lines: Vec<&str> = txt.lines().collect();
        if lines.len() > 600 {
            let keep = &lines[lines.len() - 400..];
            let _ = std::fs::write(&path, format!("{}\n", keep.join("\n")));
        }
    }
}

#[derive(Deserialize)]
struct AiLogQuery {
    #[serde(default = "def_log_limit")]
    limit: usize,
    /// 按策略 id 过滤，空为全部
    #[serde(default)]
    sid: String,
}
fn def_log_limit() -> usize {
    30
}

async fn get_ai_log(Query(q): Query<AiLogQuery>) -> Json<Api<Vec<serde_json::Value>>> {
    let mut items: Vec<serde_json::Value> = match std::fs::read_to_string(ai_log_path()) {
        Ok(txt) => txt
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter(|v| {
                q.sid.is_empty()
                    || v.get("sid").and_then(|s| s.as_str()) == Some(q.sid.as_str())
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    let limit = q.limit.clamp(1, 200);
    if items.len() > limit {
        items = items.split_off(items.len() - limit);
    }
    items.reverse(); // 最新在前
    Json(Api::good(items))
}

/// 调模型做分析，返回 (判断, 错误, 输入token, 输出token, 思考token)
async fn analyze(
    st: &St,
    s: &Settings,
    active: &config::Strategy,
    sig: &strategy::Signal,
    exec: &data::Series,
    dir: &data::Series,
    conf: &data::Series,
    prior: Option<&PriorMem>,
) -> (Option<enhance::Verdict>, Option<String>, usize, usize, usize, String) {
    if s.ai.api_key.trim().is_empty() {
        return (None, Some("未配置 API 密钥".into()), 0, 0, 0, String::new());
    }

    let i = exec.bars.len().saturating_sub(1);
    let (dif, _, _) = ind::macd(&exec.bars, 12, 26, 9);
    let summary = format!(
        "执行周期 {} 最新收盘 {:.2}\nEMA20 {}\nEMA50 {}\nRSI14 {}\nATR14 {}\nMACD DIF {}",
        active.exec_interval,
        exec.bars[i].c,
        opt(&ind::ema(&exec.bars, 20)[i]),
        opt(&ind::ema(&exec.bars, 50)[i]),
        opt(&ind::rsi(&exec.bars, 14)[i]),
        opt(&ind::atr(&exec.bars, 14)[i]),
        opt(&dif[i])
    );
    let ctx = ai::build_context(
        &exec.bars,
        &active.exec_interval,
        Some((dir.bars.as_slice(), active.dir_interval.as_str())),
        Some((conf.bars.as_slice(), active.confirm_interval.as_str())),
        st.hub.cached_spot().map(|x| x.price),
        &summary,
        ai::budget_tokens(s.ai.context_budget),
    )
    .0;

    let system = enhance::system_prompt(active, &s.personal_strategy.text, s.risk.max_daily_trades);
    let user = format!(
        "{}{}\n\n【规则引擎的独立判定】（供参考，可以不同意，但要说出理由）\n{}\n置信度 {:.0}，否决 {} 项\n\n请给出你的判断。",
        prior_block(prior),
        ctx,
        sig.summary,
        sig.confidence,
        sig.blockers
    );

    match ai::chat(s, &system, &user).await {
        Ok(out) => {
            // 思考与回答分开：思考截 6000 字供前端折叠展示
            let reason: String = out.reasoning.chars().take(6000).collect();
            let v = enhance::extract_json(&out.text);
            if v.is_none() {
                return (
                    None,
                    Some(format!(
                        "模型未按 JSON 返回，无法结构化。原文前 200 字：{}",
                        out.text.chars().take(200).collect::<String>()
                    )),
                    out.prompt_tokens,
                    out.completion_tokens,
                    out.reasoning_tokens,
                    reason,
                );
            }
            (v, None, out.prompt_tokens, out.completion_tokens, out.reasoning_tokens, reason)
        }
        Err(e) => (None, Some(format!("AI 调用失败: {}", e)), 0, 0, 0, String::new()),
    }
}

// ---------- AI 研判记忆闭环（接上次 → 验证 → 归档，全经网关） ----------

/// 上次研判记忆（注入 prompt 与回传 memory_refs 用）
#[derive(Debug, Clone)]
struct PriorMem {
    id: String,
    title: String,
    body: String,
    /// unix 秒；取不到为 0
    updated: i64,
}

/// 取最近一条同策略的「研判结论」（容错静默：未开记忆/网关不可达/无历史都返回 None）
async fn prior_research(strategy: &str) -> Option<PriorMem> {
    if !Settings::load().memory_enabled {
        return None;
    }
    let q = format!("研判结论 {}", strategy);
    let url = format!("{}/api/memory?q={}", agentd_base(), url_encode(&q));
    let data = mem_gateway(agentd_http().get(url)).await.ok()?;
    pick_prior(
        data.get("items").and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[]),
        strategy,
    )
}

/// 从召回列表里挑出「同策略」的契约条目：title 必须以「研判结论」开头且含本策略名。
/// 语义召回会把近似条目捞回来（别的策略的研判结论、同题笔记…），拿它冒充「上次研判」
/// 就是编造历史，还会串策略——宁可说无历史（返回 None），也绝不注入不相干的一条。
fn pick_prior(items: &[serde_json::Value], strategy: &str) -> Option<PriorMem> {
    let name = strategy.trim();
    if name.is_empty() {
        return None;
    }
    let hit = items.iter().find(|it| {
        it.get("title")
            .and_then(|x| x.as_str())
            .map(|t| {
                let t = t.trim();
                t.starts_with("研判结论") && t.contains(name)
            })
            .unwrap_or(false)
    })?;
    let id = hit.get("id").and_then(|x| x.as_str())?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(PriorMem {
        id,
        title: hit.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        body: hit.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        updated: hit.get("updated").and_then(|x| x.as_i64()).unwrap_or(0),
    })
}

/// 上次研判注入块（无历史则空串——绝不假装有积累）
fn prior_block(prior: Option<&PriorMem>) -> String {
    match prior {
        Some(p) => format!(
            "【上次研判（{}）】{}：{}\n请先验证其判断——成立/推翻都要明说，再给新结论。\n\n",
            date_of(p.updated),
            if p.title.trim().is_empty() { "（无标题）" } else { p.title.trim() },
            clip_text(&p.body, 800)
        ),
        None => String::new(),
    }
}

/// 归档本轮研判（三标、title 契约、importance 70 由网关落库）：fire-and-forget + 最长 5s 短等。
/// 失败只 warn——归档是加分项，绝不影响研判响应。
async fn spawn_archive(
    sid: &str,
    name: &str,
    sig_summary: &str,
    v: &enhance::Verdict,
    prior: Option<&PriorMem>,
) {
    let dir_cn = match v.direction.trim() {
        "long" => "做多",
        "short" => "做空",
        _ => return, // 无方向（none）不产生「研判结论」条目
    };
    if !(v.confidence > 0.0) {
        return;
    }
    let payload = serde_json::json!({
        "title": format!("研判结论 {} {} {}", name, dir_cn, date_of(unix_now())),
        "body": research_body(sid, name, sig_summary, v, prior, dir_cn),
        "tags": ["研判结论", name],
    });
    let task = tokio::spawn(async move {
        let req = agentd_http().post(format!("{}/api/memory", agentd_base())).json(&payload);
        match mem_gateway(req).await {
            Ok(d) => tracing::info!(
                "研判已归档：action={} id={}",
                d.get("action").and_then(|x| x.as_str()).unwrap_or("?"),
                d.get("id").and_then(|x| x.as_str()).unwrap_or("?")
            ),
            Err(e) => tracing::warn!("研判归档失败（不影响研判）：{}", e),
        }
    });
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

/// 三标正文：【前因】接上次…【行为】方向/信心/点位/理由【后果】失效条件 + 下轮验证点
fn research_body(
    sid: &str,
    name: &str,
    sig_summary: &str,
    v: &enhance::Verdict,
    prior: Option<&PriorMem>,
    dir_cn: &str,
) -> String {
    let cause = match prior {
        Some(p) => format!(
            "接上次研判（{}，{}）：{}",
            date_of(p.updated),
            p.title.trim(),
            clip_text(&p.body, 200)
        ),
        None => "无上次研判可接——本轮为该主题首条结论".to_string(),
    };
    let mut act = format!(
        "策略「{}」(id={}) 方向{}，信心 {:.0}，入场 {:.2}，止损 {:.2}，目标 {:.2}",
        name, sid, dir_cn, v.confidence, v.entry, v.sl, v.tp
    );
    if !v.reasons.is_empty() {
        let rs: Vec<String> = v.reasons.iter().take(3).cloned().collect();
        act.push_str(&format!("；理由：{}", rs.join("；")));
    }
    let invalid = v
        .warnings
        .iter()
        .find(|w| !w.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
            if v.sl > 0.0 {
                format!("价格触及止损 {:.2}", v.sl)
            } else {
                "方向反转且信心跌破 40".to_string()
            }
        });
    let verify = if v.sl > 0.0 && v.tp > 0.0 {
        format!("下轮先看 {:.2} 是否守住、{:.2} 是否先到", v.sl, v.tp)
    } else {
        "下轮复核方向是否仍成立".to_string()
    };
    format!(
        "【前因】{}。规则引擎本轮独立判定：{}\n【行为】{}\n【后果】失效条件：{}；{}",
        cause, sig_summary, act, invalid, verify
    )
}

/// unix 秒 → 本地日期（YYYY-MM-DD）；取不到给「时间未知」
fn date_of(ts: i64) -> String {
    if ts <= 0 {
        return "时间未知".to_string();
    }
    chrono::DateTime::<chrono::Utc>::from_timestamp(ts, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "时间未知".to_string())
}

/// 截断（不补省略号——正文进 prompt，省 token 优先）
fn clip_text(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        t.chars().take(n).collect()
    }
}

// ---------- 持仓 ----------

async fn get_positions(State(st): State<St>) -> Json<Api<Vec<portfolio::Position>>> {
    let l = st.ledger.lock().unwrap();
    Json(Api::good(l.positions.clone()))
}

#[derive(Deserialize)]
struct OpenReq {
    direction: String,
    lot: f64,
    entry: f64,
    sl: f64,
    tp1: f64,
    tp2: f64,
    #[serde(default)]
    tp1_lot: Option<f64>,
    #[serde(default)]
    tp2_lot: Option<f64>,
    #[serde(default)]
    note: Option<String>,
    /// 归属策略 id；缺省或未知则记当前生效策略
    #[serde(default)]
    strategy_id: Option<String>,
}

async fn open_position(State(st): State<St>, Json(r): Json<OpenReq>) -> Json<Api<portfolio::Position>> {
    let s = Settings::load();

    if r.direction != "long" && r.direction != "short" {
        return Json(Api::bad("方向参数非法"));
    }
    if r.lot < s.risk.min_lot {
        return Json(Api::bad(format!("手数 {} 低于下限 {}", r.lot, s.risk.min_lot)));
    }
    if r.lot > s.risk.max_lot {
        return Json(Api::bad(format!("手数 {} 超过上限 {}", r.lot, s.risk.max_lot)));
    }
    if r.sl <= 0.0 || r.tp1 <= 0.0 || r.tp2 <= 0.0 {
        return Json(Api::bad("止损与目标价必须大于 0"));
    }

    let is_long = r.direction == "long";
    if (is_long && r.sl >= r.entry) || (!is_long && r.sl <= r.entry) {
        return Json(Api::bad("止损方向错误：多头止损应低于开仓价"));
    }
    // 目标价须在盈利方向
    if (is_long && r.tp1 <= r.entry) || (!is_long && r.tp1 >= r.entry) {
        return Json(Api::bad("目标价方向错误"));
    }
    // 风控闸门
    let sl_points = risk::price_to_points(r.entry - r.sl, s.point_value);
    let tp_points = risk::price_to_points(r.tp1 - r.entry, s.point_value);
    let (count, daily_pnl) = {
        let l = st.ledger.lock().unwrap();
        (l.daily_count, l.daily_pnl)
    };
    let gate = risk::gate_check(
        risk::GateInput {
            direction: &r.direction,
            sl_points,
            tp_points,
            lot: r.lot,
            daily_count: count,
            daily_pnl,
            near_event: false,
        },
        &s,
    );
    if !gate.ok {
        return Json(Api::bad(format!("风控拦截：{}", gate.blocks.join("；"))));
    }

    let (strategy_id, strategy_name) =
        portfolio::resolve_strategy(&s, r.strategy_id.as_deref().unwrap_or(""));

    let p = portfolio::Position {
        id: portfolio::uid(),
        symbol: s.symbol.clone(),
        direction: r.direction.clone(),
        lot: r.lot,
        entry: r.entry,
        sl: r.sl,
        tp1: r.tp1,
        tp2: r.tp2,
        current: r.entry,
        tp1_done: false,
        tp2_done: false,
        be_done: false,
        trail_sl: r.sl,
        opened_at: portfolio::now_ts(),
        closed_at: None,
        status: "open".into(),
        close_price: None,
        pnl: 0.0,
        note: r.note.unwrap_or_default(),
        tp1_lot: r.tp1_lot.unwrap_or(r.lot * s.exit.tp1_close_pct / 100.0),
        tp2_lot: r.tp2_lot.unwrap_or(r.lot * s.exit.tp2_close_pct / 100.0),
        trail_active: false,
        strategy_id,
        strategy_name,
        opened_lot: r.lot,
    };

    let mut l = st.ledger.lock().unwrap();
    l.open(p.clone());
    Json(Api::good(p))
}

#[derive(Deserialize)]
struct CloseReq {
    id: String,
    #[serde(default)]
    price: Option<f64>,
}

async fn close_position(State(st): State<St>, Json(r): Json<CloseReq>) -> Json<Api<String>> {
    let s = Settings::load();
    let price = resolve_price(&st, &s, r.price).await;
    let mut l = st.ledger.lock().unwrap();
    match l.close(&r.id, price, &s) {
        Ok(msg) => Json(Api::good(msg)),
        Err(e) => Json(Api::bad(e)),
    }
}

#[derive(Deserialize)]
struct PartialReq {
    id: String,
    pct: f64,
    #[serde(default)]
    price: Option<f64>,
}

async fn close_partial(State(st): State<St>, Json(r): Json<PartialReq>) -> Json<Api<String>> {
    let s = Settings::load();
    let price = resolve_price(&st, &s, r.price).await;
    let mut l = st.ledger.lock().unwrap();
    match l.close_partial(&r.id, r.pct, price, &s) {
        Ok(msg) => Json(Api::good(msg)),
        Err(e) => Json(Api::bad(e)),
    }
}

#[derive(Deserialize)]
struct SlReq {
    id: String,
    sl: f64,
}

async fn set_sl(State(st): State<St>, Json(r): Json<SlReq>) -> Json<Api<String>> {
    let mut l = st.ledger.lock().unwrap();
    match l.set_sl(&r.id, r.sl) {
        Ok(msg) => Json(Api::good(msg)),
        Err(e) => Json(Api::bad(e)),
    }
}

/// 未指定价格时取最新现价；取不到就用持仓自己的记录价
async fn resolve_price(st: &St, s: &Settings, given: Option<f64>) -> f64 {
    if let Some(p) = given {
        return p;
    }
    if let Ok(v) = st.hub.spot(s).await {
        return v.price;
    }
    let l = st.ledger.lock().unwrap();
    l.open_positions()
        .first()
        .map(|p| p.current)
        .unwrap_or(0.0)
}

async fn get_stats(State(st): State<St>) -> Json<Api<portfolio::Stats>> {
    let l = st.ledger.lock().unwrap();
    Json(Api::good(l.stats()))
}

/// 重置日内单数与盈亏。调参测试时一天内反复开仓用得上。
async fn reset_daily(State(st): State<St>) -> Json<Api<String>> {
    let mut l = st.ledger.lock().unwrap();
    let was = l.daily_count;
    l.reset_daily();
    let _ = l.save();
    Json(Api::good(format!(
        "已重置今日计数（{} → 0）",
        was
    )))
}

// ---------- AI ----------

#[derive(Deserialize)]
struct AiReq {
    #[serde(default)]
    prompt: String,
    #[serde(default = "def_iv")]
    interval: String,
    /// 指定策略 id；留空用当前生效策略
    #[serde(default)]
    strategy: String,
    /// 多轮对话历史（最近几轮），role: user / assistant
    #[serde(default)]
    history: Vec<Turn>,
}

#[derive(Deserialize)]
struct Turn {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: String,
}


// ---------- 策略回测 ----------

#[derive(Deserialize)]
struct BacktestReq {
    /// 策略 id；空或缺省用当前生效策略，找不到同样回落生效策略
    #[serde(default)]
    strategy_id: String,
    #[serde(default)]
    interval: String,
    /// 回测 bar 数，默认 500，范围 100..2000
    #[serde(default)]
    bars: Option<usize>,
    /// 初始资金，默认 10000
    #[serde(default)]
    initial_equity: Option<f64>,
    /// 单边佣金费率（%），缺省 0.02
    #[serde(default)]
    commission_rate: Option<f64>,
    /// 滑点（美元/盎司），开平各一次，缺省 0.1
    #[serde(default)]
    slippage: Option<f64>,
}

/// 在真实历史 K 线上回放所选策略，返回绩效指标、权益曲线与逐笔成交。
/// 零笔交易不是错误：正常返回空 trades 与全 0 指标，前端提示「该区间无信号触发」。
async fn backtest(
    State(st): State<St>,
    Json(r): Json<BacktestReq>,
) -> Json<Api<backtest::Report>> {
    let s = Settings::load();
    let iv = r.interval.trim().to_lowercase();
    if !matches!(iv.as_str(), "5m" | "15m" | "1h" | "4h" | "1d") {
        return Json(Api::bad("interval 仅支持 5m/15m/1h/4h/1d"));
    }
    let bars = r.bars.unwrap_or(500).clamp(100, 2000);
    let initial = r.initial_equity.unwrap_or(10_000.0);
    if !initial.is_finite() || initial <= 0.0 {
        return Json(Api::bad("initial_equity 必须为正数"));
    }
    // 成本参数缺省：佣金 0.02%/单边，滑点 0.1 美元/盎司
    let commission_rate = r.commission_rate.unwrap_or(0.02);
    if !commission_rate.is_finite() || commission_rate < 0.0 {
        return Json(Api::bad("commission_rate 必须为非负数"));
    }
    let slippage = r.slippage.unwrap_or(0.1);
    if !slippage.is_finite() || slippage < 0.0 {
        return Json(Api::bad("slippage 必须为非负数"));
    }
    let stg = if r.strategy_id.is_empty() {
        s.active()
    } else {
        s.strategies
            .iter()
            .find(|x| x.id == r.strategy_id)
            .cloned()
            .unwrap_or_else(|| s.active())
    };

    // 执行周期：强制真回源，拿不到真实 K 线就报错，绝不编造
    let exec = match st.hub.series_refresh(&iv, &s).await {
        Ok(v) => v,
        Err(e) => {
            return Json(Api::bad(format!(
                "K 线数据不足，无法回测（{} 行情失败: {}）",
                iv, e
            )))
        }
    };
    if let Err(e) = backtest::check_data(exec.bars.len(), bars) {
        return Json(Api::bad(e));
    }
    // 只取最近的 bars 根：bars_used 与请求一致，且从最新行情往回推
    let exec_bars = &exec.bars[exec.bars.len() - bars..];

    // 定方向 / 确认周期：与执行周期相同则复用，否则各自真回源
    let dir_bars: Vec<data::Bar> = if stg.dir_interval == iv {
        exec_bars.to_vec()
    } else {
        match st.hub.series_refresh(&stg.dir_interval, &s).await {
            Ok(v) => v.bars,
            Err(e) => {
                return Json(Api::bad(format!(
                    "K 线数据不足，无法回测（定方向周期 {} 行情失败: {}）",
                    stg.dir_interval, e
                )))
            }
        }
    };
    let conf_bars: Vec<data::Bar> = if stg.confirm_interval == iv {
        exec_bars.to_vec()
    } else if stg.confirm_interval == stg.dir_interval {
        dir_bars.clone()
    } else {
        match st.hub.series_refresh(&stg.confirm_interval, &s).await {
            Ok(v) => v.bars,
            Err(e) => {
                return Json(Api::bad(format!(
                    "K 线数据不足，无法回测（确认周期 {} 行情失败: {}）",
                    stg.confirm_interval, e
                )))
            }
        }
    };

    let ctx = backtest::Ctx {
        exec: exec_bars,
        dir: &dir_bars,
        conf: &conf_bars,
        settings: &s,
        strategy: stg,
        interval: iv,
        initial_equity: initial,
        commission_rate,
        slippage,
    };
    Json(Api::good(backtest::run(&ctx)))
}

/// 网格寻优请求：K 线只回源一次，遍历参数组合跑现有回测核心。
#[derive(Deserialize)]
struct OptimizeReq {
    #[serde(default)]
    strategy_id: String,
    #[serde(default)]
    interval: String,
    #[serde(default)]
    bars: Option<usize>,
    #[serde(default)]
    initial_equity: Option<f64>,
    #[serde(default)]
    commission_rate: Option<f64>,
    #[serde(default)]
    slippage: Option<f64>,
    /// 只认 confidence_floor / rr_min / ema_period / trend_ema_period
    #[serde(default)]
    grid: std::collections::BTreeMap<String, Vec<f64>>,
}

async fn backtest_optimize(
    State(st): State<St>,
    Json(r): Json<OptimizeReq>,
) -> Json<Api<backtest::OptimizeOut>> {
    let s = Settings::load();
    let iv = r.interval.trim().to_lowercase();
    let iv = if iv.is_empty() { "5m".to_string() } else { iv };
    if !matches!(iv.as_str(), "5m" | "15m" | "1h" | "4h" | "1d") {
        return Json(Api::bad("interval 仅支持 5m/15m/1h/4h/1d"));
    }
    let bars = r.bars.unwrap_or(300).clamp(100, 2000);
    let initial = r.initial_equity.unwrap_or(10_000.0);
    if !initial.is_finite() || initial <= 0.0 {
        return Json(Api::bad("initial_equity 必须为正数"));
    }
    let commission_rate = r.commission_rate.unwrap_or(0.02);
    if !commission_rate.is_finite() || commission_rate < 0.0 {
        return Json(Api::bad("commission_rate 必须为非负数"));
    }
    let slippage = r.slippage.unwrap_or(0.1);
    if !slippage.is_finite() || slippage < 0.0 {
        return Json(Api::bad("slippage 必须为非负数"));
    }
    let stg = if r.strategy_id.is_empty() {
        s.active()
    } else {
        s.strategies
            .iter()
            .find(|x| x.id == r.strategy_id)
            .cloned()
            .unwrap_or_else(|| s.active())
    };

    // 网格先校验：非法键/超限在回源之前就报错
    let grid: Vec<(String, Vec<f64>)> = r.grid.into_iter().collect();
    if let Err(e) = backtest::grid_combos(&grid) {
        return Json(Api::bad(e));
    }

    // 三条 K 线各回源一次
    let exec = match st.hub.series_refresh(&iv, &s).await {
        Ok(v) => v,
        Err(e) => {
            return Json(Api::bad(format!(
                "K 线数据不足，无法寻优（{} 行情失败: {}）",
                iv, e
            )))
        }
    };
    if let Err(e) = backtest::check_data(exec.bars.len(), bars) {
        return Json(Api::bad(e));
    }
    let exec_bars = &exec.bars[exec.bars.len() - bars..];

    let dir_bars: Vec<data::Bar> = if stg.dir_interval == iv {
        exec_bars.to_vec()
    } else {
        match st.hub.series_refresh(&stg.dir_interval, &s).await {
            Ok(v) => v.bars,
            Err(e) => {
                return Json(Api::bad(format!(
                    "K 线数据不足，无法寻优（定方向周期 {} 行情失败: {}）",
                    stg.dir_interval, e
                )))
            }
        }
    };
    let conf_bars: Vec<data::Bar> = if stg.confirm_interval == iv {
        exec_bars.to_vec()
    } else if stg.confirm_interval == stg.dir_interval {
        dir_bars.clone()
    } else {
        match st.hub.series_refresh(&stg.confirm_interval, &s).await {
            Ok(v) => v.bars,
            Err(e) => {
                return Json(Api::bad(format!(
                    "K 线数据不足，无法寻优（确认周期 {} 行情失败: {}）",
                    stg.confirm_interval, e
                )))
            }
        }
    };

    match backtest::optimize(
        exec_bars,
        &dir_bars,
        &conf_bars,
        &s,
        &stg,
        &iv,
        initial,
        commission_rate,
        slippage,
        &grid,
    ) {
        Ok(out) => Json(Api::good(out)),
        Err(e) => Json(Api::bad(e)),
    }
}

/// —— 记忆插件（respire/rsrs）——
///
/// 金秤只持开关与转发：记忆本体、加密、判重、云同步全归本机 rsrs，
/// 与 agent 共用同一套库。开启前一律拒绝（前端据 plugin 状态渲染两态）。

/// 把阻塞的 rsrs CLI 调用挪到 blocking 线程池，并加超时（CLI 要加载模型，几秒起）
async fn mem_blocking<T: Send + 'static>(
    secs: u64,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    match tokio::time::timeout(Duration::from_secs(secs), tokio::task::spawn_blocking(f)).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("rsrs 调用失败: {e}")),
        Err(_) => Err(format!("rsrs 调用超时（{secs}s）")),
    }
}

#[derive(Deserialize)]
struct MemoryQ {
    #[serde(default)]
    q: String,
}

#[derive(Deserialize)]
struct MemorySaveReq {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    tags: Vec<String>,
}

/// 插件未开启时的统一拒绝语
fn mem_off<T>() -> Json<Api<T>> {
    Json(Api::bad("记忆插件未开启"))
}

/// 插件状态：装了没、runtime 活没、开关开着没
async fn memory_plugin() -> Json<Api<rsbridge::PluginStatus>> {
    let enabled = Settings::load().memory_enabled;
    match mem_blocking(120, move || rsbridge::plugin_status(enabled)).await {
        Ok(st) => Json(Api::good(st)),
        Err(e) => Json(Api::bad(e)),
    }
}

/// 开启：装 CLI（若缺）→ 复检 runtime → 迁移旧内置记忆 → 落盘开关。
/// 只有 installed && runtime_ok 才置 enabled=true，否则 enabled=false 且 error 说明原因。
async fn memory_plugin_enable() -> Json<Api<rsbridge::PluginStatus>> {
    match mem_blocking(900, enable_flow).await {
        Ok(st) => Json(Api::good(st)),
        Err(e) => Json(Api::bad(e)),
    }
}

/// 开启流程（阻塞，跑在 blocking 线程）
fn enable_flow() -> rsbridge::PluginStatus {
    let mut st = rsbridge::plugin_status(false);
    if !st.installed {
        if let Err(e) = rsbridge::install_cli() {
            st.error = Some(e);
            return st;
        }
        st = rsbridge::plugin_status(false);
        if !st.installed {
            st.error = Some(format!(
                "安装完成但未找到 rsrs 可执行文件。手动安装：{}",
                rsbridge::manual_install_hint()
            ));
            return st;
        }
    }
    if !st.runtime_ok {
        st.error = Some(
            "rsrs runtime 未就绪：请先在本机启动并登录 rsrs（金秤不启停 runtime 服务）".to_string(),
        );
        return st;
    }
    // 旧自研记忆一次性导入 rsrs（幂等：同标题跳过）；失败只警告，不挡开启
    let warn = match rsbridge::migrate_legacy() {
        Ok(Some(bak)) => {
            tracing::info!("旧内置记忆已导入 rsrs，原文件备份: {}", bak);
            String::new()
        }
        Ok(None) => String::new(),
        Err(e) => {
            tracing::warn!("旧内置记忆迁移失败: {}", e);
            format!("（旧内置记忆未迁移：{e}）")
        }
    };
    let mut s = Settings::load();
    s.memory_enabled = true;
    st.enabled = true;
    st.error = match (s.save().err().map(|e| e.to_string()), warn.is_empty()) {
        (Some(e), _) => {
            st.enabled = false;
            Some(format!("开关落盘失败: {e}"))
        }
        (None, false) => Some(warn),
        (None, true) => None,
    };
    st
}

/// 关闭：只关开关与注入入口，不卸载 CLI、不动 rsrs 里的数据
async fn memory_plugin_disable() -> Json<Api<rsbridge::PluginStatus>> {
    let mut s = Settings::load();
    s.memory_enabled = false;
    if let Err(e) = s.save() {
        return Json(Api::bad(format!("关闭失败（设置未落盘）: {e}")));
    }
    match mem_blocking(120, || rsbridge::plugin_status(false)).await {
        Ok(st) => Json(Api::good(st)),
        Err(e) => Json(Api::bad(e)),
    }
}

/// —— 记忆读写：一律代理给 agentd 网关（8788）——
///
/// 记忆的判重/裁决/写入全在 agentd 侧收口（src/bin/agentd.rs「记忆网关」一节），
/// 金秤只保留路由与开关：请求/响应形状不变（前端零改动），agentd 不可达时明确回错——
/// **绝不退化成主服务直连 rsrs**，否则「智能判重」这一层就漏了。

/// agentd（记忆网关 / agent 宿主）端口：GOLDSCALE_AGENTD_PORT 可覆盖
fn agentd_base() -> String {
    let port = std::env::var("GOLDSCALE_AGENTD_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8788);
    format!("http://127.0.0.1:{}", port)
}

/// 网关回环客户端：短超时（代理不许拖死前端）、绝不过代理
fn agentd_http() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .unwrap_or_default()
    })
}

/// 调网关一次，取它的 `data`；不可达或网关报错都给中文结构化错误
async fn mem_gateway(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let res = req
        .send()
        .await
        .map_err(|e| format!("记忆服务不可达（{}）：{}", agentd_base(), e))?;
    let status = res.status();
    let v: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("记忆服务响应异常（HTTP {}）：{}", status.as_u16(), e))?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("记忆服务返回错误").to_string())
    }
}

/// 最小 URL 编码（query 与路径段都可能是中文/特殊字符）
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// 读：网关回 `{items:[…]}`；本路由维持旧形状（`data` 直接是数组）
async fn list_memory(Query(q): Query<MemoryQ>) -> Json<Api<serde_json::Value>> {
    if !Settings::load().memory_enabled {
        return mem_off();
    }
    let url = format!("{}/api/memory?q={}", agentd_base(), url_encode(&q.q));
    match mem_gateway(agentd_http().get(url)).await {
        Ok(data) => Json(Api::good(mem_items_view(&data))),
        Err(e) => Json(Api::bad(e)),
    }
}

/// 网关 `{items:[…]}` → 旧形状数组（缺 items 就给空数组——宁缺勿假，绝不塞占位条目）
fn mem_items_view(data: &serde_json::Value) -> serde_json::Value {
    data.get("items")
        .filter(|x| x.is_array())
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]))
}

/// 写：网关回 `{id, action, item}`；本路由维持旧形状（`data` = 条目本体）
async fn save_memory(Json(r): Json<MemorySaveReq>) -> Json<Api<serde_json::Value>> {
    if !Settings::load().memory_enabled {
        return mem_off();
    }
    let body = serde_json::json!({ "id": r.id, "title": r.title, "body": r.body, "tags": r.tags });
    let req = agentd_http().post(format!("{}/api/memory", agentd_base())).json(&body);
    match mem_gateway(req).await {
        Ok(data) => Json(Api::good(mem_item_view(&data, &r))),
        Err(e) => Json(Api::bad(e)),
    }
}

/// 网关条目视图 → 旧形状条目：给了 item 就用它；缺字段用请求内容补齐（宁缺勿假）
fn mem_item_view(data: &serde_json::Value, r: &MemorySaveReq) -> serde_json::Value {
    match data.get("item") {
        Some(it) if it.get("id").and_then(|x| x.as_str()).is_some() => it.clone(),
        _ => serde_json::json!({
            "id": data.get("id").and_then(|x| x.as_str()).unwrap_or(""),
            "title": r.title,
            "body": r.body,
            "tags": r.tags,
            "updated": unix_now(),
        }),
    }
}

/// 删：网关回 `{id, deleted}`；本路由维持旧形状（`data` = bool）
async fn delete_memory(Path(id): Path<String>) -> Json<Api<bool>> {
    if !Settings::load().memory_enabled {
        return mem_off();
    }
    let url = format!("{}/api/memory/{}", agentd_base(), url_encode(&id));
    match mem_gateway(agentd_http().delete(url)).await {
        Ok(data) => Json(Api::good(data.get("deleted").and_then(|d| d.as_bool()).unwrap_or(true))),
        Err(e) => Json(Api::bad(e)),
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn ai_chat(State(st): State<St>, Json(r): Json<AiReq>) -> Json<Api<AiOut>> {
    let s = Settings::load();
    if s.ai.api_key.trim().is_empty() {
        return Json(Api::bad("未配置 API 密钥，请到设置页填写"));
    }

    let active = if r.strategy.is_empty() {
        s.active()
    } else {
        s.strategies
            .iter()
            .find(|x| x.id == r.strategy)
            .cloned()
            .unwrap_or_else(|| s.active())
    };

    let interval = if r.interval.is_empty() { active.exec_interval.clone() } else { r.interval.clone() };

    let ser = match st.hub.series(&interval, &s, false).await {
        Ok(v) => v,
        Err(e) => return Json(Api::bad(format!("行情获取失败: {}", e))),
    };

    // 定方向与确认周期一并取，供 AI 交叉判断
    let dir_iv = if active.dir_interval == interval {
        interval.clone()
    } else {
        active.dir_interval.clone()
    };
    let conf_iv = if active.confirm_interval == interval {
        interval.clone()
    } else {
        active.confirm_interval.clone()
    };
    let (dir_ser, conf_ser) = tokio::join!(
        st.hub.series(&dir_iv, &s, false),
        st.hub.series(&conf_iv, &s, false),
    );

    let i = ser.bars.len().saturating_sub(1);
    let (dif, dea, hist) = ind::macd(&ser.bars, 12, 26, 9);
    let rsi = ind::rsi(&ser.bars, 14);
    let atr = ind::atr(&ser.bars, 14);
    let ema20 = ind::ema(&ser.bars, 20);
    let ema50 = ind::ema(&ser.bars, 50);
    let boll = ind::boll(&ser.bars, 20, 2.0);
    let trend = ind::trend(&ser.bars, &ema50, i);

    // 近期高低，供模型判断关键价位
    let recent = &ser.bars[ser.bars.len().saturating_sub(50)..];
    let hi = recent.iter().map(|b| b.h).fold(f64::MIN, f64::max);
    let lo = recent.iter().map(|b| b.l).fold(f64::MAX, f64::min);

    let dir_text = match trend.dir {
        1 => "偏多（价格在 EMA50 上方且均线上行）",
        -1 => "偏空（价格在 EMA50 下方且均线下行）",
        _ => "不明（均线走平或价格反复穿越）",
    };

    // 多周期趋势一致性
    let cross = if let Ok(ds) = &dir_ser {
        let di = ds.bars.len().saturating_sub(1);
        let d_ema = ind::ema(&ds.bars, 50);
        let dt = ind::trend(&ds.bars, &d_ema, di);
        format!(
            "{}({}) {}",
            dir_iv,
            iv_label(&dir_iv),
            match dt.dir {
                1 => "向上",
                -1 => "向下",
                _ => "不明",
            }
        )
    } else {
        format!("{} 不可用", dir_iv)
    };

    let summary = format!(
        "最新收盘 {:.2}\nEMA20 {}\nEMA50 {}\nBOLL 上轨 {}\nBOLL 下轨 {}\nRSI14 {}\nATR14 {}\nMACD DIF {}\nDEA {}\n柱 {}\n执行周期趋势 {}\n多周期一致性: {}\n近 50 根区间 高 {:.2} / 低 {:.2}",
        ser.bars[i].c,
        opt(&ema20[i]), opt(&ema50[i]),
        opt(&boll.upper[i]), opt(&boll.lower[i]),
        opt(&rsi[i]), opt(&atr[i]),
        opt(&dif[i]), opt(&dea[i]), opt(&hist[i]),
        dir_text, cross, hi, lo
    );

    let prompt = if r.prompt.trim().is_empty() {
        format!(
            "按「{}」这套策略判断当前行情：现在该不该进场？\n\
如果该进，请给出方向、参考入场价、止损价、第一目标价。\n\
如果不该进，说明是哪一条硬条件没满足。",
            active.name
        )
    } else {
        r.prompt.clone()
    };

    let budget = ai::budget_tokens(s.ai.context_budget);
    let dir_ref = dir_ser.ok().map(|d| (d.bars, dir_iv.clone()));
    let conf_ref = conf_ser.ok().map(|c| (c.bars, conf_iv.clone()));
    let (ctx, ctx_tokens) = ai::build_context(
        &ser.bars,
        &interval,
        dir_ref.as_ref().map(|(b, iv)| (b.as_slice(), iv.as_str())),
        conf_ref.as_ref().map(|(b, iv)| (b.as_slice(), iv.as_str())),
        st.hub.cached_spot().map(|x| x.price),
        &summary,
        budget,
    );

    tracing::info!(
        "AI 请求：策略 {} 预算 {} token，实装上下文约 {} token",
        active.name, budget, ctx_tokens
    );

    let sys = ai::system_prompt(&active, &s.personal_strategy.text, active.rr_min, s.risk.max_daily_trades);

    // 多轮对话：带最近 6 轮历史（每轮截 500 字），模型知道上文才能连续对话
    let hist = if r.history.is_empty() {
        String::new()
    } else {
        let turns: Vec<String> = r
            .history
            .iter()
            .rev()
            .take(6)
            .rev()
            .map(|t| {
                let who = if t.role == "assistant" { "AI" } else { "我" };
                let c: String = t.content.chars().take(500).collect();
                format!("{}：{}", who, c)
            })
            .collect();
        format!("【对话历史】\n{}\n\n", turns.join("\n"))
    };

    match ai::chat(&s, &sys, &format!("{}{}\n\n【我的问题】{}", hist, ctx, prompt)).await {
        Ok(v) => Json(Api::good(AiOut {
            text: v.text,
            model: s.ai.model.clone(),
            budget_tokens: budget,
            context_tokens: ctx_tokens,
            prompt_tokens: v.prompt_tokens,
            completion_tokens: v.completion_tokens,
            reasoning_tokens: v.reasoning_tokens,
        })),
        Err(e) => Json(Api::bad(format!("AI 调用失败: {}", e))),
    }
}

/// 周期 v 名转可读标签
fn iv_label(v: &str) -> &str {
    match v {
        "5m" => "M5",
        "15m" => "M15",
        "1h" => "H1",
        "4h" => "H4",
        "1d" => "D1",
        o => o,
    }
}

#[derive(Serialize)]
struct AiOut {
    text: String,
    model: String,
    budget_tokens: usize,
    context_tokens: usize,
    prompt_tokens: usize,
    completion_tokens: usize,
    reasoning_tokens: usize,
}

/// 服务商预设列表
async fn ai_presets() -> Json<Api<Vec<Preset>>> {
    Json(Api::good(
        ai::presets()
            .into_iter()
            .map(|(name, url, model)| Preset { name: name.into(), url: url.into(), model: model.into() })
            .collect(),
    ))
}

#[derive(Serialize)]
struct Preset {
    name: String,
    url: String,
    model: String,
}

/// 校验并规范化 AI 配置，不实际发请求
async fn ai_check(Json(s): Json<Settings>) -> Json<Api<String>> {
    if s.ai.api_key.trim().is_empty() {
        return Json(Api::bad("未配置 API 密钥"));
    }
    Json(Api::good(ai::normalize_url(&s.ai.base_url)))
}

fn opt(v: &Option<f64>) -> String {
    match v {
        Some(x) => format!("{:.4}", x),
        None => "--".into(),
    }
}