//! 配置定义与默认值。设置存 data/settings.json，可从界面改。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 数据目录：存放 settings.json 与 portfolio.json
///
/// 优先级：环境变量 GOLDSCALE_DATA → 可执行同级 → 上两级（target/debug → 项目根） → 当前目录。
/// 取第一个能定位到 index.html 的位置，保证开发期与发行期行为一致。
fn find_root() -> PathBuf {
    if let Ok(v) = std::env::var("GOLDSCALE_DATA") {
        let p = PathBuf::from(v);
        fs::create_dir_all(&p).ok();
        return p;
    }

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();

    let cands = [
        exe_dir.clone(),
        exe_dir.join("../.."),
        exe_dir.join(".."),
        PathBuf::from("."),
    ];
    for c in cands {
        if c.join("index.html").exists() {
            let d = c.join("data");
            fs::create_dir_all(&d).ok();
            return d;
        }
    }

    // 都找不到就退到当前目录下的 data
    let d = PathBuf::from("data");
    fs::create_dir_all(&d).ok();
    d
}

fn data_dir() -> PathBuf {
    find_root()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskCfg {
    pub equity_risk_pct: f64,
    pub min_lot: f64,
    pub max_lot: f64,
    pub lot_step: f64,
    pub min_sl_points: f64,
    pub max_sl_points: f64,
    pub max_daily_trades: u32,
    pub max_spread_points: f64,
    pub session_start: String,
    pub session_end: String,
    pub event_block: bool,
    pub event_block_minutes: u32,
    /// 今日可亏额度：当日已实现亏损达权益的该百分比即停止开新仓。0 或负 = 关闭。
    #[serde(default = "default_daily_loss_budget_pct")]
    pub daily_loss_budget_pct: f64,
}

fn default_daily_loss_budget_pct() -> f64 {
    2.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitCfg {
    pub tp1_close_pct: f64,
    pub tp2_close_pct: f64,
    pub trail_atr_mult: f64,
    pub be_trigger_points: f64,
    pub be_lock_points: f64,
    pub flip_exit: bool,
    pub cycle_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyCfg {
    pub enabled: bool,
    pub ema_period: usize,
    pub trend_ema_period: usize,
    pub rr_min: f64,
    pub confidence_floor: f64,
    pub risk_percent: f64,
    pub allow_long: bool,
    pub allow_short: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiCfg {
    pub base_url: String,
    pub model: String,
    pub temperature: f64,
    /// 留空则不启用 AI 功能
    pub api_key: String,
    /// 上下文预算档位：0 省 / 1 标准 / 2 深度 / 3 极限
    #[serde(default = "default_budget")]
    pub context_budget: u8,
    /// 思考模式（deepseek 思考模型）：off 关闭 / low 低强度 / high 高强度
    #[serde(default = "default_thinking")]
    pub thinking: String,
}

fn default_budget() -> u8 {
    1
}

fn default_thinking() -> String {
    "low".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalStrategy {
    pub text: String,
    pub interval: String,
    pub confidence_floor: f64,
    pub rr_min: f64,
}

/// 条件右值：常数或另一个指标序列
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConditionRight {
    /// 常数比较：{"kind":"number","value":1.23}
    Number { value: f64 },
    /// 指标比较：{"kind":"indicator","name":"ema50"}
    Indicator { name: String },
}

fn default_logic() -> String {
    "and".into()
}

fn default_period() -> usize {
    20
}

/// 策略条件：一条可组合的买卖判定，字段名是前后端契约，勿改。
///
/// - `logic`：与**上一条**的连接方式（and/or），第一条忽略；
/// - `left`：左侧序列名；`n_high`/`n_low`/`pct_change` 用 `period`（缺省 20）；
/// - `op`：gt/gte/lt/lte/eq/cross_above/cross_below；cross 的 right 必须是指标，
///   比较类的 right 必须是常数。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_logic")]
    pub logic: String,
    #[serde(default)]
    pub left: String,
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub right: Option<ConditionRight>,
    #[serde(default = "default_period")]
    pub period: usize,
}

/// 一条交易策略：规则参数 + 面向 AI 的提示词
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Strategy {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub enabled: bool,
    /// 规则侧参数
    pub exec_interval: String,
    pub dir_interval: String,
    pub confirm_interval: String,
    pub ema_period: usize,
    pub trend_ema_period: usize,
    pub rr_min: f64,
    pub confidence_floor: f64,
    pub risk_percent: f64,
    pub allow_long: bool,
    pub allow_short: bool,
    /// AI 侧提示词
    pub prompt: String,
    /// AI 关注点，作为提示词的补充约束
    pub focus: Vec<String>,
    /// 条件入场（多）：非空即走条件路径，取代五步判定
    #[serde(default)]
    pub entry_long: Vec<Condition>,
    /// 条件入场（空）
    #[serde(default)]
    pub entry_short: Vec<Condition>,
    /// 条件出场：持仓中任一成立即平仓
    #[serde(default)]
    pub exit_conditions: Vec<Condition>,
}

impl Strategy {
    pub fn new(id: &str, name: &str, desc: &str) -> Self {
        Strategy {
            id: id.into(),
            name: name.into(),
            desc: desc.into(),
            enabled: false,
            exec_interval: "5m".into(),
            dir_interval: "1h".into(),
            confirm_interval: "15m".into(),
            ema_period: 20,
            trend_ema_period: 50,
            rr_min: 1.8,
            confidence_floor: 44.0,
            risk_percent: 0.6,
            allow_long: true,
            allow_short: false,
            prompt: String::new(),
            focus: Vec::new(),
            entry_long: Vec::new(),
            entry_short: Vec::new(),
            exit_conditions: Vec::new(),
        }
    }
}

/// 内置策略库：覆盖五种典型打法
pub fn builtin_strategies() -> Vec<Strategy> {
    let mut v = Vec::new();

    let mut s = Strategy::new(
        "trend_pullback",
        "趋势回踩",
        "顺大周期趋势，等执行周期回踩均线且确认周期出现吞没形态再进场。最稳，信号少。",
    );
    s.prompt = "重点判断当前是否处于趋势中，以及回踩是否到位。若价格远离均线，说明不是回踩，不应进场。".into();
    s.focus = vec!["趋势方向是否明确".into(), "回踩幅度是否合理".into(), "吞没形态是否有效".into()];
    v.push(s);

    let mut s = Strategy::new(
        "breakout",
        "区间突破",
        "价格突破近期高低点后顺势跟进。止损放在突破位另一侧，盈亏比要求更高。",
    );
    s.exec_interval = "5m".into();
    s.dir_interval = "1h".into();
    s.confirm_interval = "15m".into();
    s.ema_period = 20;
    s.rr_min = 2.0;
    s.confidence_floor = 50.0;
    s.prompt = "重点判断当前价格相对近期高低点的位置，是否形成有效突破。假突破是这类策略的主要风险。".into();
    s.focus = vec!["是否突破关键位".into(), "突破是否有量能配合".into(), "假突破风险".into()];
    v.push(s);

    let mut s = Strategy::new(
        "mean_revert",
        "均值回归",
        "价格偏离均线过远时反向进场，博回到均线。止损设在极值外侧，盈亏比通常较低。",
    );
    s.exec_interval = "5m".into();
    s.dir_interval = "1h".into();
    s.ema_period = 20;
    s.rr_min = 1.2;
    s.confidence_floor = 40.0;
    s.risk_percent = 0.4;
    s.allow_long = true;
    s.allow_short = true;
    s.prompt = "重点判断当前价格偏离均线的程度，以及回归的概率。趋势行情中均值回归策略会连续亏损，需要提示这一点。".into();
    s.focus = vec!["偏离均线的幅度".into(), "是否存在单边趋势".into(), "回归空间的测算".into()];
    v.push(s);

    let mut s = Strategy::new(
        "scalp_m5",
        "M5 剥头皮",
        "5 分钟级别高频小止盈，严格限制日内单数与点差。靠交易次数取胜，单笔容错低。",
    );
    s.exec_interval = "5m".into();
    s.dir_interval = "15m".into();
    s.confirm_interval = "5m".into();
    s.ema_period = 20;
    s.rr_min = 1.5;
    s.confidence_floor = 46.0;
    s.risk_percent = 0.5;
    s.prompt = "重点判断当前点差与波动率环境。剥头皮策略在点差放大或波动过窄时不应交易。".into();
    s.focus = vec!["当前点差".into(), "ATR 波动率".into(), "日内已开单数".into()];
    v.push(s);

    let mut s = Strategy::new(
        "macro_trend",
        "宏观顺势",
        "以大周期为主，只做主趋势方向，日内几乎不动手。适合行情结构明确时。",
    );
    s.exec_interval = "15m".into();
    s.dir_interval = "4h".into();
    s.confirm_interval = "1h".into();
    s.trend_ema_period = 100;
    s.rr_min = 2.5;
    s.confidence_floor = 55.0;
    s.risk_percent = 1.0;
    s.prompt = "重点判断 4 小时级别的主趋势方向是否明确。若主趋势不明，应明确建议观望而非勉强给方向。".into();
    s.focus = vec!["主趋势是否明确".into(), "当前处于趋势的哪一段".into(), "是否有明显的结构破坏".into()];
    v.push(s);

    v
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub symbol: String,

    pub exec_interval: String,
    pub dir_interval: String,
    pub confirm_interval: String,

    pub equity: f64,
    pub contract_size: f64,
    pub point_value: f64,
    pub spread_points: f64,

    pub risk: RiskCfg,
    pub exit: ExitCfg,
    pub strategy: StrategyCfg,
    pub ai: AiCfg,
    pub personal_strategy: PersonalStrategy,

    /// 策略库：可多选，每条独立参数与提示词
    #[serde(default)]
    pub strategies: Vec<Strategy>,
    /// 已被用户删除的策略 id（含内置）：加载合并时跳过，防复活
    #[serde(default)]
    pub removed_strategies: Vec<String>,
    /// 当前生效的策略 id
    #[serde(default = "default_active")]
    pub active_strategy: String,

    pub auto_trade: bool,
    pub chart_height: u32,

    /// 记忆插件（respire/rsrs）开关：true 时 /api/memory 走本机 rsrs CLI，
    /// agent 对话注入 rsrs 召回；false 时记忆接口一律拒绝（插件未开启）
    #[serde(default)]
    pub memory_enabled: bool,
}

fn default_active() -> String {
    "trend_pullback".into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            symbol: "XAU".into(),
            exec_interval: "5m".into(),
            dir_interval: "1h".into(),
            confirm_interval: "15m".into(),
            equity: 10000.0,
            contract_size: 100.0,
            point_value: 0.01,
            spread_points: 28.0,
            risk: RiskCfg {
                equity_risk_pct: 1.0,
                min_lot: 0.01,
                max_lot: 5.0,
                lot_step: 0.01,
                min_sl_points: 50.0,
                max_sl_points: 800.0,
                max_daily_trades: 6,
                max_spread_points: 35.0,
                session_start: "00:00".into(),
                session_end: "23:59".into(),
                event_block: true,
                event_block_minutes: 30,
                daily_loss_budget_pct: default_daily_loss_budget_pct(),
            },
            exit: ExitCfg {
                tp1_close_pct: 50.0,
                tp2_close_pct: 40.0,
                trail_atr_mult: 1.5,
                be_trigger_points: 30.0,
                be_lock_points: 10.0,
                flip_exit: true,
                cycle_sec: 15,
            },
            strategy: StrategyCfg {
                enabled: true,
                ema_period: 20,
                trend_ema_period: 50,
                rr_min: 1.8,
                confidence_floor: 44.0,
                risk_percent: 0.6,
                allow_long: true,
                allow_short: false,
            },
            ai: AiCfg {
                base_url: "https://api.deepseek.com".into(),
                model: "deepseek-flash".into(),
                temperature: 0.3,
                api_key: String::new(),
                context_budget: 1,
                thinking: "low".into(),
            },
            personal_strategy: PersonalStrategy {
                text: "顺 H4 趋势做多，回踩 EMA20 且 M15 出现看涨吞没收盘确认时入场，止损放影线外，盈亏比不低于 1.5。"
                    .into(),
                interval: "15m".into(),
                confidence_floor: 44.0,
                rr_min: 1.8,
            },
            strategies: builtin_strategies(),
            removed_strategies: Vec::new(),
            active_strategy: default_active(),
            auto_trade: false,
            chart_height: 460,
            memory_enabled: false,
        }
    }
}

impl Settings {
    pub fn range_for(&self, iv: &str) -> &'static str {
        // 2026-10-04 加大历史跨度：K 线要能往回拖看更长周期
        match iv {
            "5m" => "5d",
            "15m" => "1mo",
            "1h" => "3mo",
            "4h" => "1y",
            "1d" => "1y",
            _ => "5d",
        }
    }

    pub fn load() -> Self {
        let p = data_dir().join("settings.json");
        if let Ok(txt) = fs::read_to_string(p) {
            match serde_json::from_str::<Settings>(&txt) {
                Ok(mut s) => {
                    // 老配置可能没有策略库，补齐内置策略并保留用户已有项
                    s.merge_builtin_strategies();
                    return s;
                }
                Err(e) => tracing::warn!("配置解析失败，用默认值: {}", e),
            }
        }
        Settings::default()
    }

    /// 合并内置策略：保留用户改过的，补入新增的；已删除的（墓碑）跳过
    pub fn merge_builtin_strategies(&mut self) {
        let builtin = builtin_strategies();
        for b in builtin {
            if self.removed_strategies.contains(&b.id) {
                continue;
            }
            match self.strategies.iter_mut().find(|s| s.id == b.id) {
                Some(existing) => {
                    // 补齐新增字段，保留用户已改的参数
                    if existing.prompt.is_empty() {
                        existing.prompt = b.prompt;
                    }
                    if existing.focus.is_empty() {
                        existing.focus = b.focus;
                    }
                }
                None => self.strategies.push(b),
            }
        }
        if !self.strategies.iter().any(|s| s.id == self.active_strategy) {
            self.active_strategy = self.strategies.first().map(|s| s.id.clone()).unwrap_or_default();
        }
    }

    /// 取当前生效策略；找不到则退回趋势回踩
    pub fn active(&self) -> Strategy {
        self.strategies
            .iter()
            .find(|s| s.id == self.active_strategy)
            .cloned()
            .unwrap_or_else(|| builtin_strategies().remove(0))
    }

    pub fn save(&self) -> std::io::Result<()> {
        let dir = data_dir();
        fs::create_dir_all(&dir)?;
        let txt = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(dir.join("settings.json"), txt)
    }

    pub fn data_dir() -> PathBuf {
        data_dir()
    }
}