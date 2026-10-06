//! 策略回测引擎：在真实历史 K 线上逐根重放策略判定，产出绩效指标与权益曲线。
//!
//! 反未来函数的三条硬规矩：
//! 1. 第 i 根 bar 只喂 exec[..=i]；dir/conf 周期只用时间戳 ≤ exec[i].t 的前缀切片；
//! 2. 第 i 根出现的信号，成交在第 i+1 根开盘价（含点差成本）；
//! 3. 持仓自建仓的次根起逐根检查止损/止盈，同一根内双触保守按止损算。
//!
//! 成本模型并入每笔净盈亏、权益曲线走净值：点差（开仓一次性）、佣金（双边）、
//! 滑点（开平各一次、方向不利）；基准曲线不扣费用。
//!
//! 数据一律来自上游真实 K 线，不足即报错，绝不编造。

use serde::Serialize;
use std::collections::BTreeMap;

use crate::cond;
use crate::config::{Settings, Strategy};
use crate::data::Bar;
use crate::risk;
use crate::strategy;

/// 每年交易日数（贵金属现货近 24 小时连续交易，周末休市）
const TRADING_DAYS_PER_YEAR: f64 = 252.0;

/// 每交易日的 bar 数 → 年 bar 数。5m = 24h/5min = 288 根/日，其余类推。
pub fn bars_per_year(interval: &str) -> f64 {
    let per_day = match interval {
        "5m" => 288.0,
        "15m" => 96.0,
        "1h" => 24.0,
        "4h" => 6.0,
        "1d" => 1.0,
        _ => 96.0,
    };
    TRADING_DAYS_PER_YEAR * per_day
}

/// 回测最少需要的 bar 数（暖机 + 至少一次「评估→成交」）
pub const MIN_BARS: usize = 60;

/// 返回值校验：请求的 bars 与实到 K 线长度是否够跑回测
pub fn check_data(available: usize, requested: usize) -> Result<(), String> {
    if available < requested || available < MIN_BARS || available < 2 {
        return Err("K 线数据不足，无法回测".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Point {
    pub t: i64,
    pub v: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Trade {
    pub t_open: i64,
    pub t_close: i64,
    /// "long" / "short"
    pub direction: String,
    pub entry: f64,
    pub exit: f64,
    /// 已扣点差/佣金/滑点后的净盈亏（美元，1 手）
    pub pnl: f64,
    pub bars: usize,
    pub open_reason: String,
    pub close_reason: String,
    /// 净盈亏 / 初始风险金额（|entry-sl| 对应金额）；风险额为 0 时给 0
    pub r_multiple: f64,
    /// "止损" | "止盈" | "期末平仓"
    pub exit_reason: String,
    /// 该笔佣金（美元，双边各一次）
    pub commission: f64,
    /// 该笔滑点成本（美元，开平各一次）
    pub slippage: f64,
}

/// 一个月度收益：ym 形如 "2026-09"，ret_pct 为该月结算收益百分比
#[derive(Debug, Clone, Serialize)]
pub struct Monthly {
    pub ym: String,
    pub ret_pct: f64,
}

/// 逐 exec bar 的水下回撤：pct = (equity/历史峰 - 1) × 100，恒 ≤ 0
#[derive(Debug, Clone, Serialize)]
pub struct DrawdownPoint {
    pub t: i64,
    pub pct: f64,
}

/// 区间三项总费用（美元）
#[derive(Debug, Clone, Serialize, Default)]
pub struct Costs {
    pub commission: f64,
    pub slippage: f64,
    pub spread: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Metrics {
    pub total_return_pct: f64,
    pub annual_return_pct: f64,
    pub sharpe: f64,
    /// 索提诺：分母为下行偏差（目标收益 0），为 0 时给 0
    pub sortino: f64,
    /// 卡玛：年化收益% / 最大回撤%；回撤为 0 时给 0
    pub calmar: f64,
    pub max_drawdown_pct: f64,
    pub win_rate_pct: f64,
    /// 总盈利/总亏损；无亏损笔时无法定义（JSON null）
    pub profit_factor: Option<f64>,
    pub trades: usize,
    pub expectancy_r: f64,
    pub avg_hold_bars: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub strategy_id: String,
    pub strategy_name: String,
    pub interval: String,
    pub bars_used: usize,
    pub from: i64,
    pub to: i64,
    pub initial_equity: f64,
    pub metrics: Metrics,
    pub equity: Vec<Point>,
    pub benchmark: Vec<Point>,
    pub trades: Vec<Trade>,
    pub monthly: Vec<Monthly>,
    pub drawdown: Vec<DrawdownPoint>,
    pub costs: Costs,
}

/// 回测输入：三条真实 K 线序列 + 策略与资金设定
pub struct Ctx<'a> {
    /// 执行周期序列（逐根推进用）
    pub exec: &'a [Bar],
    /// 定方向周期（时间升序，含 exec 起点之前的历史）
    pub dir: &'a [Bar],
    /// 确认周期
    pub conf: &'a [Bar],
    pub settings: &'a Settings,
    pub strategy: Strategy,
    pub interval: String,
    pub initial_equity: f64,
    /// 单边佣金费率（%），双边各收一次
    pub commission_rate: f64,
    /// 滑点（美元/盎司），开平各一次、方向不利
    pub slippage: f64,
}

struct Pos {
    dir: i32,
    entry: f64,
    sl: f64,
    tp: f64,
    t_open: i64,
    open_i: usize,
    /// 该笔的初始风险金额（美元，1 手）：sl_points * point_value * contract_size
    risk_money: f64,
    /// 开仓时预扣的总成本（美元，1 手）：点差 + 佣金（按开仓价估）+ 滑点
    cost: f64,
    reason: String,
}

fn dir_str(d: i32) -> &'static str {
    if d == 1 {
        "long"
    } else {
        "short"
    }
}

/// 平仓理由收敛为对外取值；非止损/止盈/条件平仓一律视为期末平仓
fn exit_reason_of(close_reason: &str) -> &'static str {
    match close_reason {
        "止损" => "止损",
        "止盈" => "止盈",
        "条件平仓" => "条件平仓",
        _ => "期末平仓",
    }
}

pub fn run(c: &Ctx) -> Report {
    let s = c.settings;
    // 点差成本：点数 → 价格差 → 每手美元（开仓时一次性扣除）
    let spread_cost = s.spread_points * s.point_value * s.contract_size;
    // 回测固定 1 手：佣金双边各一次；滑点开平各一次且方向不利
    let lot = 1.0f64;
    let commission_of = |entry: f64, exit: f64| -> f64 {
        (entry + exit) * s.contract_size * lot * c.commission_rate / 100.0
    };
    let slip_cost = c.slippage * s.contract_size * lot * 2.0;
    let n = c.exec.len();

    // 暖机位：两根均线各要 2 倍周期，且至少 60 根
    let warm = (c.strategy.ema_period * 2)
        .max(c.strategy.trend_ema_period * 2)
        .max(MIN_BARS);
    // 最后一个可评估的 bar 是 n-2（n-1 只作为成交/平仓价）
    let start = if n > warm + 1 { warm } else { n };

    let mut cash = c.initial_equity;
    let mut pos: Option<Pos> = None;
    // 出场条件整段预计算一次（只看历史，逐根查表等价于逐根重算前缀）
    let exit_series: Option<Vec<Option<bool>>> = if c.strategy.exit_conditions.is_empty() {
        None
    } else {
        Some(cond::eval_series(c.exec, &c.strategy.exit_conditions))
    };
    let mut pending: Option<(i32, f64, f64, f64, String)> = None;
    let mut trades: Vec<Trade> = Vec::new();
    let mut r_multiples: Vec<f64> = Vec::new();
    let mut costs = Costs::default();
    // 暖机段无仓位，权益恒为初始资金；每根 bar 一个点
    let mut eq: Vec<f64> = vec![c.initial_equity; n];
    // dir/conf 的移动下标：只吸收时间戳 ≤ 当前 bar 的 K 线
    let mut di = 0usize;
    let mut ci = 0usize;

    for i in 0..n {
        let bar = &c.exec[i];

        // ---- A. 持仓：检查本根是否触发止损/止盈（建仓次根起）----
        if pos.as_ref().map(|p| i > p.open_i).unwrap_or(false) {
            let p = pos.as_ref().unwrap();
            let (hit_sl, hit_tp) = if p.dir == 1 {
                (bar.l <= p.sl, bar.h >= p.tp)
            } else {
                (bar.h >= p.sl, bar.l <= p.tp)
            };
            // 出场条件：持仓中任一条件组合成立即按本根收盘平仓。
            // 止损已触发时不必再算（优先级最高）。
            let hit_exit_cond = !hit_sl
                && exit_series
                    .as_ref()
                    .map(|s| s.get(i).copied().flatten() == Some(true))
                    .unwrap_or(false);
            if hit_sl || hit_tp || hit_exit_cond {
                // 同根优先级：止损 > exit_conditions（按本根收盘平） > 止盈（保守）
                let (exit, reason) = if hit_sl {
                    (p.sl, "止损")
                } else if hit_exit_cond {
                    (bar.c, "条件平仓")
                } else {
                    (p.tp, "止盈")
                };
                let p = pos.take().unwrap();
                let raw = risk::pnl(dir_str(p.dir), p.entry, exit, lot, s);
                let comm = commission_of(p.entry, exit);
                // 开仓时按开仓价预扣过一份佣金，平仓价落定后补扣尾差
                let adj = comm - commission_of(p.entry, p.entry);
                let pnl = raw - p.cost - adj;
                cash += raw - adj;
                costs.commission += comm;
                costs.slippage += slip_cost;
                costs.spread += spread_cost;
                let r_multiple = if p.risk_money > 0.0 {
                    r_multiples.push(pnl / p.risk_money);
                    pnl / p.risk_money
                } else {
                    0.0
                };
                trades.push(Trade {
                    t_open: p.t_open,
                    t_close: bar.t,
                    direction: dir_str(p.dir).into(),
                    entry: p.entry,
                    exit,
                    pnl,
                    bars: i - p.open_i,
                    open_reason: p.reason,
                    close_reason: reason.into(),
                    r_multiple,
                    exit_reason: exit_reason_of(reason).into(),
                    commission: round2(comm),
                    slippage: round2(slip_cost),
                });
            }
        }

        // ---- B. 空仓且无挂单：用截至本根的数据评估信号 ----
        if pos.is_none() && pending.is_none() && i >= start && i + 1 < n {
            while di < c.dir.len() && c.dir[di].t <= bar.t {
                di += 1;
            }
            while ci < c.conf.len() && c.conf[ci].t <= bar.t {
                ci += 1;
            }
            let sig = strategy::evaluate(
                strategy::Input {
                    dir_bars: &c.dir[..di],
                    exec_bars: &c.exec[..=i],
                    conf_bars: &c.conf[..ci],
                    strategy: Some(c.strategy.clone()),
                },
                s,
            );
            if sig.ok && sig.dir != 0 {
                if let Some(plan) = &sig.plan {
                    let risk_money = plan.sl_points * s.point_value * s.contract_size;
                    pending = Some((
                        sig.dir,
                        plan.sl_price,
                        plan.tp_price,
                        risk_money,
                        sig.summary.clone(),
                    ));
                }
            }
        }

        // ---- C. 挂单在下一根开盘成交（开仓即扣全部成本）----
        if pos.is_none() {
            if let Some((dir, sl, tp, risk_money, reason)) = pending.take() {
                if i + 1 < n {
                    let nb = &c.exec[i + 1];
                    // 开仓即预扣全部成本：点差 + 佣金（按开仓价估）+ 滑点，权益曲线走净值
                    let open_cost = spread_cost + commission_of(nb.o, nb.o) + slip_cost;
                    cash -= open_cost;
                    pos = Some(Pos {
                        dir,
                        entry: nb.o,
                        sl,
                        tp,
                        t_open: nb.t,
                        open_i: i + 1,
                        risk_money,
                        cost: open_cost,
                        reason,
                    });
                }
            }
        }

        // ---- D. 按本根收盘做 mark-to-market ----
        let mut e = cash;
        if let Some(p) = &pos {
            e += risk::pnl(dir_str(p.dir), p.entry, bar.c, lot, s);
        }
        eq[i] = e;
    }

    // ---- 回测结束仍持仓：按末根收盘平仓，避免悬空仓位 ----
    if n > 0 {
        if let Some(p) = pos.take() {
            let exit = c.exec[n - 1].c;
            let raw = risk::pnl(dir_str(p.dir), p.entry, exit, lot, s);
            let comm = commission_of(p.entry, exit);
            let adj = comm - commission_of(p.entry, p.entry);
            let pnl = raw - p.cost - adj;
            cash += raw - adj;
            costs.commission += comm;
            costs.slippage += slip_cost;
            costs.spread += spread_cost;
            let r_multiple = if p.risk_money > 0.0 {
                r_multiples.push(pnl / p.risk_money);
                pnl / p.risk_money
            } else {
                0.0
            };
            trades.push(Trade {
                t_open: p.t_open,
                t_close: c.exec[n - 1].t,
                direction: dir_str(p.dir).into(),
                entry: p.entry,
                exit,
                pnl,
                bars: (n - 1).saturating_sub(p.open_i),
                open_reason: p.reason,
                close_reason: "回测结束平仓".into(),
                r_multiple,
                exit_reason: "期末平仓".into(),
                commission: round2(comm),
                slippage: round2(slip_cost),
            });
        }
        eq[n - 1] = cash;
    }

    let equity: Vec<Point> = c
        .exec
        .iter()
        .zip(eq.iter())
        .map(|(b, v)| Point { t: b.t, v: round2(*v) })
        .collect();

    // 基准：同区间买入持有，首根收盘建仓、末根收盘平仓
    let first_close = c.exec.first().map(|b| b.c).unwrap_or(0.0);
    let benchmark: Vec<Point> = c
        .exec
        .iter()
        .map(|b| Point {
            t: b.t,
            v: round2(if first_close > 0.0 {
                c.initial_equity * b.c / first_close
            } else {
                c.initial_equity
            }),
        })
        .collect();

    let metrics = compute_metrics(
        &eq,
        &trades,
        &r_multiples,
        c.initial_equity,
        &c.interval,
    );
    let monthly = monthly_returns(c.exec, &eq, c.initial_equity);
    let drawdown = drawdown_series(c.exec, &eq);
    let costs = Costs {
        commission: round2(costs.commission),
        slippage: round2(costs.slippage),
        spread: round2(costs.spread),
    };

    Report {
        strategy_id: c.strategy.id.clone(),
        strategy_name: c.strategy.name.clone(),
        interval: c.interval.clone(),
        bars_used: n,
        from: c.exec.first().map(|b| b.t).unwrap_or(0),
        to: c.exec.last().map(|b| b.t).unwrap_or(0),
        initial_equity: c.initial_equity,
        metrics,
        equity,
        benchmark,
        trades,
        monthly,
        drawdown,
        costs,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

// ---------- 网格寻优 ----------

/// 可调参数白名单（grid 的键）
pub const GRID_KEYS: [&str; 4] = ["confidence_floor", "rr_min", "ema_period", "trend_ema_period"];
/// 每个键最多取值数
pub const GRID_MAX_VALUES: usize = 8;
/// 组合总数上限
pub const GRID_MAX_COMBOS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct Combo {
    pub params: BTreeMap<String, serde_json::Value>,
    pub total_return_pct: f64,
    pub sharpe: f64,
    pub max_drawdown_pct: f64,
    pub win_rate_pct: f64,
    pub trades: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct OptimizeOut {
    pub combos: Vec<Combo>,
    pub tried: usize,
}

fn json_num(v: f64) -> serde_json::Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        serde_json::Value::from(v as i64)
    } else {
        serde_json::Value::from(v)
    }
}

/// 校验并展开网格：键必须在白名单、每键 1..=8 个值、组合总数 ≤200。
/// 展开顺序按传入键序做笛卡尔积（最后一个键变化最快）。
pub fn grid_combos(grid: &[(String, Vec<f64>)]) -> Result<Vec<Vec<(String, f64)>>, String> {
    if grid.is_empty() {
        return Err("grid 不能为空".into());
    }
    let mut total = 1usize;
    for (k, vals) in grid {
        if !GRID_KEYS.contains(&k.as_str()) {
            return Err(format!(
                "grid 不支持的参数: {}（可用: {}）",
                k,
                GRID_KEYS.join("/")
            ));
        }
        if vals.is_empty() || vals.len() > GRID_MAX_VALUES {
            return Err(format!("{} 的取值数须在 1..={} 之间", k, GRID_MAX_VALUES));
        }
        if vals.iter().any(|v| !v.is_finite()) {
            return Err(format!("{} 存在非有限数值", k));
        }
        if matches!(k.as_str(), "ema_period" | "trend_ema_period")
            && vals.iter().any(|v| *v < 1.0 || v.fract() != 0.0)
        {
            return Err(format!("{} 必须为正整数", k));
        }
        total = total.saturating_mul(vals.len());
        if total > GRID_MAX_COMBOS {
            return Err(format!("组合总数超过 {}", GRID_MAX_COMBOS));
        }
    }

    let mut out: Vec<Vec<(String, f64)>> = vec![Vec::new()];
    for (k, vals) in grid {
        let mut next = Vec::with_capacity(out.len() * vals.len());
        for base in &out {
            for v in vals {
                let mut c = base.clone();
                c.push((k.clone(), *v));
                next.push(c);
            }
        }
        out = next;
    }
    Ok(out)
}

/// 遍历参数网格跑回测，按总收益降序返回。K 线三条序列由调用方只回源一次。
/// 零交易组合照常返回（trades: 0）。
#[allow(clippy::too_many_arguments)]
pub fn optimize(
    exec: &[Bar],
    dir: &[Bar],
    conf: &[Bar],
    settings: &Settings,
    base: &Strategy,
    interval: &str,
    initial_equity: f64,
    commission_rate: f64,
    slippage: f64,
    grid: &[(String, Vec<f64>)],
) -> Result<OptimizeOut, String> {
    let combos = grid_combos(grid)?;
    let mut out: Vec<Combo> = Vec::with_capacity(combos.len());
    for combo in &combos {
        let mut st = base.clone();
        let mut params: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        for (k, v) in combo {
            match k.as_str() {
                "confidence_floor" => st.confidence_floor = *v,
                "rr_min" => st.rr_min = *v,
                "ema_period" => st.ema_period = *v as usize,
                "trend_ema_period" => st.trend_ema_period = *v as usize,
                other => return Err(format!("grid 不支持的参数: {}", other)),
            }
            params.insert(k.clone(), json_num(*v));
        }
        let ctx = Ctx {
            exec,
            dir,
            conf,
            settings,
            strategy: st,
            interval: interval.to_string(),
            initial_equity,
            commission_rate,
            slippage,
        };
        let r = run(&ctx);
        out.push(Combo {
            params,
            total_return_pct: round4(r.metrics.total_return_pct),
            sharpe: round4(r.metrics.sharpe),
            max_drawdown_pct: round4(r.metrics.max_drawdown_pct),
            win_rate_pct: round4(r.metrics.win_rate_pct),
            trades: r.metrics.trades,
        });
    }
    out.sort_by(|a, b| b.total_return_pct.total_cmp(&a.total_return_pct));
    let tried = out.len();
    Ok(OptimizeOut { combos: out, tried })
}

/// bar 时间戳（秒）→ 本地自然月，形如 "2026-09"
fn ym_of(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%Y-%m")
                .to_string()
        })
        .unwrap_or_default()
}

/// 按权益曲线结算的自然月收益：月内末点 / 上月末点 - 1（首月起点为初始资金）。
/// 最后一段是未走完的当月，取当月至今的末点。
fn monthly_returns(exec: &[Bar], eq: &[f64], initial_equity: f64) -> Vec<Monthly> {
    let n = exec.len().min(eq.len());
    let mut out: Vec<Monthly> = Vec::new();
    if n == 0 {
        return out;
    }
    let mut base = initial_equity;
    let mut cur = ym_of(exec[0].t);
    let mut last = eq[0];
    for i in 1..n {
        let ym = ym_of(exec[i].t);
        if ym != cur {
            out.push(Monthly {
                ym: cur.clone(),
                ret_pct: month_ret(last, base),
            });
            base = last;
            cur = ym;
        }
        last = eq[i];
    }
    out.push(Monthly {
        ym: cur,
        ret_pct: month_ret(last, base),
    });
    out
}

fn month_ret(last: f64, base: f64) -> f64 {
    if base > 0.0 && last.is_finite() {
        round4((last / base - 1.0) * 100.0)
    } else {
        0.0
    }
}

/// 逐 exec bar 的水下回撤序列，pct ≤ 0
fn drawdown_series(exec: &[Bar], eq: &[f64]) -> Vec<DrawdownPoint> {
    let mut peak = f64::NEG_INFINITY;
    exec.iter()
        .zip(eq.iter())
        .map(|(b, v)| {
            if *v > peak {
                peak = *v;
            }
            let raw = if peak > 0.0 && v.is_finite() {
                (v / peak - 1.0) * 100.0
            } else {
                0.0
            };
            // 浮点误差可能算出 +1e-16；顺带把 -0.0 归一成 0.0
            let pct = if raw >= 0.0 { 0.0 } else { round4(raw) };
            DrawdownPoint { t: b.t, pct }
        })
        .collect()
}

fn compute_metrics(
    eq: &[f64],
    trades: &[Trade],
    r_multiples: &[f64],
    initial_equity: f64,
    interval: &str,
) -> Metrics {
    let n = eq.len();
    let final_eq = eq.last().copied().unwrap_or(initial_equity);

    let total_return_pct = if initial_equity > 0.0 {
        (final_eq / initial_equity - 1.0) * 100.0
    } else {
        0.0
    };

    let bpy = bars_per_year(interval);
    let annual_return_pct = if initial_equity > 0.0 && final_eq > 0.0 && n > 0 {
        ((final_eq / initial_equity).powf(bpy / n as f64) - 1.0) * 100.0
    } else if n > 0 {
        -100.0
    } else {
        0.0
    };

    // 夏普：逐 bar 权益收益率 → 年化
    let rets: Vec<f64> = (1..n)
        .filter(|i| eq[i - 1] > 0.0)
        .map(|i| eq[i] / eq[i - 1] - 1.0)
        .collect();
    let sharpe = if rets.len() > 1 {
        let m: f64 = rets.iter().sum::<f64>() / rets.len() as f64;
        let var: f64 =
            rets.iter().map(|r| (r - m) * (r - m)).sum::<f64>() / (rets.len() - 1) as f64;
        let sd = var.sqrt();
        if sd > 0.0 {
            m / sd * bpy.sqrt()
        } else {
            0.0
        }
    } else {
        0.0
    };

    // 索提诺：分子同夏普（逐 bar 收益均值），分母为下行偏差（目标收益 0），年化同夏普
    let sortino = if rets.len() > 1 {
        let m: f64 = rets.iter().sum::<f64>() / rets.len() as f64;
        let down: f64 = (rets
            .iter()
            .map(|r| {
                let neg = r.min(0.0);
                neg * neg
            })
            .sum::<f64>()
            / rets.len() as f64)
            .sqrt();
        if down > 0.0 {
            let v = m / down * bpy.sqrt();
            if v.is_finite() {
                v
            } else {
                0.0
            }
        } else {
            0.0
        }
    } else {
        0.0
    };

    // 最大回撤
    let mut peak = f64::NEG_INFINITY;
    let mut mdd = 0.0f64;
    for v in eq {
        if *v > peak {
            peak = *v;
        }
        if peak > 0.0 {
            let dd = (peak - v) / peak * 100.0;
            if dd > mdd {
                mdd = dd;
            }
        }
    }

    // 卡玛：年化收益 / 最大回撤；回撤为 0 时不定义
    let calmar = if mdd > 0.0 && annual_return_pct.is_finite() {
        annual_return_pct / mdd
    } else {
        0.0
    };

    let wins = trades.iter().filter(|t| t.pnl > 0.0).count();
    let win_rate_pct = if trades.is_empty() {
        0.0
    } else {
        wins as f64 / trades.len() as f64 * 100.0
    };

    let gross_win: f64 = trades.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).sum();
    let gross_loss: f64 = trades.iter().filter(|t| t.pnl < 0.0).map(|t| -t.pnl).sum();
    // 赔率数学上非负；abs 顺带压掉 -0.0 这种刺眼的序列化结果
    let profit_factor = if gross_loss > 0.0 {
        Some((gross_win / gross_loss).abs())
    } else {
        None
    };

    let expectancy_r = if r_multiples.is_empty() {
        0.0
    } else {
        r_multiples.iter().sum::<f64>() / r_multiples.len() as f64
    };

    let avg_hold_bars = if trades.is_empty() {
        0.0
    } else {
        trades.iter().map(|t| t.bars as f64).sum::<f64>() / trades.len() as f64
    };

    Metrics {
        total_return_pct,
        annual_return_pct,
        sharpe,
        sortino,
        calmar,
        max_drawdown_pct: mdd,
        win_rate_pct,
        profit_factor,
        trades: trades.len(),
        expectancy_r,
        avg_hold_bars,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;

    const TS: i64 = 1_700_000_000;

    /// 回测上下文装配：默认 1 万本金，成本参数显式传入
    fn ctx_of<'a>(
        bars: &'a [Bar],
        s: &'a Settings,
        st: Strategy,
        iv: &str,
        rate: f64,
        slip: f64,
    ) -> Ctx<'a> {
        Ctx {
            exec: bars,
            dir: bars,
            conf: bars,
            settings: s,
            strategy: st,
            interval: iv.into(),
            initial_equity: 10_000.0,
            commission_rate: rate,
            slippage: slip,
        }
    }

    /// 合成 5m K 线：缓慢上行 + 正弦回踩，open 取前收，
    /// 于是「前阴 + 本阳包住」的吞没形态会自然出现。
    fn wave_bars(n: usize, base: f64) -> Vec<Bar> {
        wave_bars_step(n, base, 300)
    }

    /// 同上，但可指定每根 bar 的秒数（造跨月序列用）
    fn wave_bars_step(n: usize, base: f64, step: i64) -> Vec<Bar> {
        let mut out = Vec::with_capacity(n);
        let mut prev = base;
        for i in 0..n {
            let c = base + i as f64 * 0.5 + 3.0 * ((i as f64) * 0.7).sin();
            let o = if i == 0 { c } else { prev };
            out.push(Bar {
                t: TS + i as i64 * step,
                o,
                h: o.max(c) + 0.35,
                l: o.min(c) - 0.35,
                c,
                v: 100.0,
            });
            prev = c;
        }
        out
    }

    /// 在一段上行序列后接一根急挫 + 缓升尾：逼出止损笔（大趋势未转空，多单仍会开）
    fn dip_after(prefix: &[Bar]) -> Vec<Bar> {
        let mut bars = prefix.to_vec();
        let last = bars.last().unwrap().c;
        let t0 = bars.last().unwrap().t;
        bars.push(Bar {
            t: t0 + 300,
            o: last,
            h: last + 0.5,
            l: last - 30.0,
            c: last - 20.0,
            v: 100.0,
        });
        let mut prev = last - 20.0;
        for k in 2..=40 {
            let c = prev + 1.0;
            bars.push(Bar {
                t: t0 + 300 * k,
                o: prev,
                h: prev.max(c) + 0.3,
                l: prev.min(c) - 0.3,
                c,
                v: 100.0,
            });
            prev = c;
        }
        bars
    }

    /// 放宽风控与置信度门槛的回测设置，专注验证回测流程本身
    fn loose_settings() -> Settings {
        let mut s = Settings::default();
        s.equity = 10_000.0;
        s.spread_points = 10.0;
        s.risk.min_sl_points = 1.0;
        s.risk.max_sl_points = 100_000.0;
        s
    }

    fn loose_strategy() -> Strategy {
        let mut st = Strategy::new("test_loose", "测试宽松策略", "回测单元测试用");
        st.exec_interval = "5m".into();
        st.dir_interval = "5m".into();
        st.confirm_interval = "5m".into();
        st.ema_period = 5;
        st.trend_ema_period = 10;
        st.rr_min = 0.5;
        st.confidence_floor = 0.0;
        st.allow_long = true;
        st.allow_short = false;
        st
    }

    /// ① 合成上升趋势上能产生交易，且权益曲线与单笔盈亏自洽
    #[test]
    fn test_backtest_produces_trades_on_uptrend() {
        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let ctx = ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1);
        let r = run(&ctx);

        assert_eq!(r.bars_used, 400);
        assert!(!r.trades.is_empty(), "上升趋势上应至少触发一笔交易");
        assert_eq!(r.trades.len(), r.metrics.trades);

        // 每笔盈亏 = 平仓净盈亏（已扣点差），权益曲线末点 = 初始 + 累计盈亏
        let sum: f64 = r.trades.iter().map(|t| t.pnl).sum();
        let last = r.equity.last().unwrap().v;
        assert!(
            (last - (10_000.0 + sum)).abs() < 0.02,
            "末点权益 {} 应等于初始资金 + 累计盈亏 {}",
            last,
            10_000.0 + sum
        );
        assert!(last.is_finite() && last > 0.0);
        // 多头策略在上升趋势里应当不是灾难性亏损
        assert!(last > 10_000.0 * 0.5, "权益不应腰斩以下: {}", last);
        // 每笔都有开平时间与理由
        for t in &r.trades {
            assert!(t.t_close > t.t_open);
            assert!(t.direction == "long" || t.direction == "short");
            assert!(!t.close_reason.is_empty() && !t.open_reason.is_empty());
        }
    }

    /// ② 数据不足必须报错，不得拿半截数据硬跑
    #[test]
    fn test_backtest_rejects_insufficient_data() {
        let e = check_data(120, 500).unwrap_err();
        assert!(e.contains("数据不足"), "错误信息应提示数据不足: {}", e);
        assert!(check_data(59, 59).is_err(), "不足 60 根也要拒绝");
        assert!(check_data(500, 500).is_ok());

        // 即便强行喂短序列，run 也不能产生交易或崩溃
        let s = loose_settings();
        let bars = wave_bars(50, 2000.0);
        let ctx = ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1);
        let r = run(&ctx);
        assert!(r.trades.is_empty(), "暖机都走不完的序列不该有交易");
        assert_eq!(r.equity.len(), 50);
    }

    /// ③ 指标 sanity：回撤非负、胜率在 0..100、曲线长度与 bar 数一致
    #[test]
    fn test_backtest_metrics_sanity() {
        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let ctx = ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1);
        let r = run(&ctx);
        let m = &r.metrics;

        assert_eq!(r.equity.len(), r.bars_used);
        assert_eq!(r.benchmark.len(), r.bars_used);
        assert_eq!(r.equity.len(), bars.len());
        assert!(m.max_drawdown_pct >= 0.0);
        assert!((0.0..=100.0).contains(&m.win_rate_pct));
        assert!(m.sharpe.is_finite());
        assert!(m.total_return_pct.is_finite());
        assert!(m.annual_return_pct.is_finite());
        assert!(m.avg_hold_bars >= 0.0);
        assert!(m.expectancy_r.is_finite());
        if let Some(pf) = m.profit_factor {
            assert!(pf.is_finite() && pf >= 0.0);
        }
        // 基准曲线首点 = 初始资金，且跟随价格
        assert!((r.benchmark.first().unwrap().v - 10_000.0).abs() < 0.02);
        assert!(r.benchmark.last().unwrap().v > 10_000.0);
        // 时间戳升序
        assert!(r.equity.windows(2).all(|w| w[0].t < w[1].t));
        assert!(r.from == bars.first().unwrap().t && r.to == bars.last().unwrap().t);

        // 年 bar 换算常量核对
        assert!((bars_per_year("5m") - 252.0 * 288.0).abs() < 1e-9);
        assert!((bars_per_year("1d") - 252.0).abs() < 1e-9);

        // 只有亏损笔时赔率是 0.0（不许出现 -0.0）
        let losing = vec![Trade {
            t_open: TS,
            t_close: TS + 300,
            direction: "long".into(),
            entry: 2000.0,
            exit: 1990.0,
            pnl: -10.0,
            bars: 1,
            open_reason: "t".into(),
            close_reason: "止损".into(),
            r_multiple: -1.0,
            exit_reason: "止损".into(),
            commission: 0.0,
            slippage: 0.0,
        }];
        let m2 = compute_metrics(&[100.0, 90.0], &losing, &[-1.0], 100.0, "5m");
        let pf = m2.profit_factor.expect("有亏损就该有赔率");
        assert_eq!(pf, 0.0);
        assert!(pf.is_sign_positive(), "赔率不该是 -0.0");
        assert!(m2.max_drawdown_pct > 0.0 && m2.win_rate_pct == 0.0);
        assert!(m2.sortino.is_finite() && m2.calmar.is_finite());
    }

    /// ④ 成本模型：有成本的总收益 < 无成本，且 costs 三项与逐笔手算对得上
    #[test]
    fn test_costs_reduce_return_and_match_hand_calc() {
        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let free = run(&ctx_of(&bars, &s, loose_strategy(), "5m", 0.0, 0.0));
        let costed = run(&ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1));

        assert!(!free.trades.is_empty(), "无成本组应有交易");
        assert_eq!(free.trades.len(), costed.trades.len(), "成本不该改变成交序列");
        assert!(
            costed.metrics.total_return_pct < free.metrics.total_return_pct,
            "有成本总收益 {} 应低于无成本 {}",
            costed.metrics.total_return_pct,
            free.metrics.total_return_pct
        );
        assert!(free.metrics.total_return_pct < 0.0 || costed.metrics.total_return_pct.is_finite());

        // 无成本组：佣金与滑点恒 0，点差照旧
        assert_eq!(free.costs.commission, 0.0);
        assert_eq!(free.costs.slippage, 0.0);
        assert!(free.costs.spread > 0.0);

        // 有成本组：逐笔手算 (entry+exit)*contract_size*lot*rate/100 与 slip*contract*2
        let expect_slip = 0.1 * s.contract_size * 2.0;
        let mut sum_c = 0.0;
        let mut sum_s = 0.0;
        for t in &costed.trades {
            let expect_comm = (t.entry + t.exit) * s.contract_size * 0.02 / 100.0;
            assert!(
                (t.commission - expect_comm).abs() < 0.01,
                "佣金 {} 应约等于手算 {}",
                t.commission,
                expect_comm
            );
            assert!((t.slippage - expect_slip).abs() < 0.01);
            sum_c += t.commission;
            sum_s += t.slippage;
        }
        assert!((costed.costs.commission - sum_c).abs() < 0.05);
        assert!((costed.costs.slippage - sum_s).abs() < 0.05);
        let expect_spread =
            s.spread_points * s.point_value * s.contract_size * costed.trades.len() as f64;
        assert!((costed.costs.spread - expect_spread).abs() < 0.05);

        // 每笔净盈亏已含全部成本：手算 raw - 点差 - 佣金 - 滑点
        for t in &costed.trades {
            let raw = if t.direction == "long" {
                (t.exit - t.entry) * s.contract_size
            } else {
                (t.entry - t.exit) * s.contract_size
            };
            let expect_pnl = raw - s.spread_points * s.point_value * s.contract_size
                - t.commission
                - t.slippage;
            assert!(
                (t.pnl - expect_pnl).abs() < 0.05,
                "净盈亏 {} 应约等于手算 {}",
                t.pnl,
                expect_pnl
            );
        }

        // 权益曲线用净值：末点 ≈ 初始 + Σ净盈亏
        let sum_pnl: f64 = costed.trades.iter().map(|t| t.pnl).sum();
        let last = costed.equity.last().unwrap().v;
        assert!((last - (10_000.0 + sum_pnl)).abs() < 0.05);
    }

    /// ⑤ drawdown 序列长度对齐 bar 数、恒 ≤ 0，且与 max_drawdown_pct 同源
    #[test]
    fn test_drawdown_series_aligned_and_underwater() {
        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let r = run(&ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1));

        assert_eq!(r.drawdown.len(), r.bars_used);
        assert_eq!(r.drawdown.len(), r.equity.len());
        assert_eq!(r.drawdown.len(), bars.len());
        assert!(
            r.drawdown.iter().all(|d| d.pct <= 0.0 && d.pct.is_finite()),
            "水下回撤必须恒 ≤ 0"
        );
        assert!(
            r.drawdown.iter().zip(r.equity.iter()).all(|(d, p)| d.t == p.t),
            "drawdown 的 t 应与 exec bar 时间戳逐一对齐"
        );
        assert!(r.drawdown.iter().any(|d| d.pct < 0.0), "有交易就有水下段");
        // 首根是历史峰，回撤为 0
        assert_eq!(r.drawdown[0].pct, 0.0);

        let worst = r.drawdown.iter().map(|d| -d.pct).fold(0.0f64, f64::max);
        assert!(
            (worst - r.metrics.max_drawdown_pct).abs() < 0.01,
            "drawdown 最深 {} 应与 max_drawdown_pct {} 一致",
            worst,
            r.metrics.max_drawdown_pct
        );
    }

    /// ⑥ 月度收益：非空、按自然月升序，相邻月连乘 ≈ 总收益
    #[test]
    fn test_monthly_returns_chain_to_total() {
        let s = loose_settings();
        // 日线步长 400 根 ≈ 13 个自然月，跨月分段才有意义
        let bars = wave_bars_step(400, 2000.0, 86_400);
        let r = run(&ctx_of(&bars, &s, loose_strategy(), "1d", 0.02, 0.1));

        assert!(!r.monthly.is_empty(), "月度收益不该为空");
        assert!(
            r.monthly.iter().all(|m| m.ret_pct.is_finite()),
            "月收益必须有限"
        );
        assert!(
            r.monthly.windows(2).all(|w| w[0].ym < w[1].ym),
            "月份应严格升序不重复: {:?}",
            r.monthly.iter().map(|m| &m.ym).collect::<Vec<_>>()
        );
        // 每个 ym 形如 YYYY-MM
        for m in &r.monthly {
            assert_eq!(m.ym.len(), 7, "月份格式应为 YYYY-MM: {}", m.ym);
            assert_eq!(m.ym.as_bytes()[4], b'-');
        }

        let chain: f64 = r.monthly.iter().map(|m| 1.0 + m.ret_pct / 100.0).product();
        let total = 1.0 + r.metrics.total_return_pct / 100.0;
        assert!(
            (chain - total).abs() < 0.005,
            "相邻月连乘 {} 应约等于总收益比 {}",
            chain,
            total
        );

        // 单月序列：该月收益即总收益
        let one = wave_bars(400, 2000.0);
        let r1 = run(&ctx_of(&one, &s, loose_strategy(), "5m", 0.02, 0.1));
        assert_eq!(r1.monthly.len(), 1);
        assert!(
            (r1.monthly[0].ret_pct - r1.metrics.total_return_pct).abs() < 0.01,
            "单月收益 {} 应等于总收益 {}",
            r1.monthly[0].ret_pct,
            r1.metrics.total_return_pct
        );
    }

    /// ⑦ exit_reason 三值收敛 + r_multiple 自洽（构造不出三类就验字段默认值）
    #[test]
    fn test_exit_reason_and_r_multiple() {
        // 映射：只有止损/止盈保留语义，其余一律期末平仓
        assert_eq!(exit_reason_of("止损"), "止损");
        assert_eq!(exit_reason_of("止盈"), "止盈");
        assert_eq!(exit_reason_of("回测结束平仓"), "期末平仓");
        assert_eq!(exit_reason_of("别的理由"), "期末平仓");

        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let r = run(&ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1));
        assert!(!r.trades.is_empty());
        for t in &r.trades {
            assert!(
                matches!(t.exit_reason.as_str(), "止损" | "止盈" | "期末平仓"),
                "exit_reason 越界: {}",
                t.exit_reason
            );
            assert!(t.commission >= 0.0 && t.slippage >= 0.0);
            if t.exit_reason == "止损" {
                // 止损出场时 |entry-exit| 即风险距离 → r_multiple 可手算
                let risk = (t.entry - t.exit).abs() * s.point_value * s.contract_size;
                assert!(risk > 0.0);
                assert!(
                    (t.r_multiple - t.pnl / risk).abs() < 0.01,
                    "r_multiple {} 应等于 pnl/风险额 {}",
                    t.r_multiple,
                    t.pnl / risk
                );
            }
        }
        // 至少出现止损或止盈之一（引擎常规出场路径）
        assert!(r
            .trades
            .iter()
            .any(|t| t.exit_reason == "止损" || t.exit_reason == "止盈"));

        // 期末平仓：截到首笔开仓那一根，强制留仓到回测结束
        let t_open = r.trades[0].t_open;
        let idx = bars.iter().position(|b| b.t == t_open).expect("开仓时间应在 bars 内");
        let cut = &bars[..=idx];
        let r2 = run(&ctx_of(cut, &s, loose_strategy(), "5m", 0.02, 0.1));
        assert!(
            r2.trades.iter().any(|t| t.exit_reason == "期末平仓"),
            "截断序列末根仍有持仓，应产出期末平仓"
        );
        let last = r2.trades.last().unwrap();
        assert_eq!(last.exit_reason, "期末平仓");
        assert_eq!(last.close_reason, "回测结束平仓");

        // 止损：首笔开仓那根之后立刻急挫，三值齐备
        let crash = dip_after(&bars[..=idx]);
        let rc = run(&ctx_of(&crash, &s, loose_strategy(), "5m", 0.02, 0.1));
        assert!(
            rc.trades.iter().any(|t| t.exit_reason == "止损"),
            "急挫应扫掉在场多单: {:?}",
            rc.trades.iter().map(|t| &t.exit_reason).collect::<Vec<_>>()
        );
        let mut seen: Vec<&str> = r
            .trades
            .iter()
            .chain(rc.trades.iter())
            .chain(r2.trades.iter())
            .map(|t| t.exit_reason.as_str())
            .collect();
        seen.sort_unstable();
        seen.dedup();
        let mut expect = vec!["止盈", "止损", "期末平仓"];
        expect.sort_unstable();
        assert_eq!(seen, expect, "三类出场应各出现至少一次");
    }

    /// ⑧ 条件出场：恒成立条件按本根收盘平仓，且优先于止盈
    #[test]
    fn test_exit_conditions_close_position() {
        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let mut st = loose_strategy();
        st.exit_conditions = vec![crate::config::Condition {
            id: "e1".into(),
            logic: "and".into(),
            left: "close".into(),
            op: "gt".into(),
            right: Some(crate::config::ConditionRight::Number { value: 0.0 }),
            period: 20,
        }];
        let r = run(&ctx_of(&bars, &s, st, "5m", 0.02, 0.1));
        assert!(!r.trades.is_empty(), "恒成立的出场条件应能完成开平");
        assert!(
            r.trades.iter().any(|t| t.exit_reason == "条件平仓"),
            "应产出条件平仓: {:?}",
            r.trades.iter().map(|t| &t.exit_reason).collect::<Vec<_>>()
        );
        assert!(
            r.trades.iter().all(|t| t.exit_reason != "止盈"),
            "条件平仓应优先于止盈"
        );
        for t in &r.trades {
            assert!(matches!(
                t.exit_reason.as_str(),
                "止损" | "条件平仓" | "期末平仓"
            ));
        }
        // 无出场条件时行为不变，绝不出现「条件平仓」
        let plain = run(&ctx_of(&bars, &s, loose_strategy(), "5m", 0.02, 0.1));
        assert!(plain.trades.iter().all(|t| t.exit_reason != "条件平仓"));
    }

    /// ⑦ optimize：2×2 小网格返回 4 组、按总收益降序；非法键/超限报错
    #[test]
    fn test_optimize_grid_sorted_and_validated() {
        let s = loose_settings();
        let bars = wave_bars(400, 2000.0);
        let st = loose_strategy();
        let grid = vec![
            ("confidence_floor".to_string(), vec![0.0, 50.0]),
            ("rr_min".to_string(), vec![0.5, 3.0]),
        ];
        let out = optimize(&bars, &bars, &bars, &s, &st, "5m", 10_000.0, 0.02, 0.1, &grid)
            .expect("合法网格应能寻优");
        assert_eq!(out.tried, 4);
        assert_eq!(out.combos.len(), 4);
        assert!(
            out.combos
                .windows(2)
                .all(|w| w[0].total_return_pct >= w[1].total_return_pct),
            "结果必须按 total_return_pct 降序"
        );
        for c in &out.combos {
            assert_eq!(c.params.len(), 2);
            assert!(c.params.contains_key("confidence_floor") && c.params.contains_key("rr_min"));
            assert!(c.total_return_pct.is_finite() && c.sharpe.is_finite());
            assert!(c.max_drawdown_pct >= 0.0);
            assert!((0.0..=100.0).contains(&c.win_rate_pct));
        }
        // 参数确实生效：两组 confidence_floor 各出现两次
        let cf: Vec<i64> = out
            .combos
            .iter()
            .map(|c| c.params["confidence_floor"].as_i64().unwrap())
            .collect();
        assert_eq!(cf.iter().filter(|v| **v == 0).count(), 2);
        assert_eq!(cf.iter().filter(|v| **v == 50).count(), 2);

        // 非法键
        let bad = vec![("sharpe_min".to_string(), vec![1.0])];
        let e = optimize(&bars, &bars, &bars, &s, &st, "5m", 10_000.0, 0.02, 0.1, &bad).unwrap_err();
        assert!(e.contains("不支持"), "非法键应明确报错: {}", e);
        // 空网格
        assert!(grid_combos(&[]).is_err());
        // 单键取值数 8 上限
        let too_many = vec![(
            "rr_min".to_string(),
            vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0],
        )];
        assert!(grid_combos(&too_many).is_err());
        // 组合总数上限 200
        let big = vec![
            ("confidence_floor".to_string(), vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]),
            ("rr_min".to_string(), vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]),
            ("ema_period".to_string(), vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]),
        ];
        assert!(grid_combos(&big).is_err());
        // 周期键必须是正整数
        assert!(grid_combos(&[("ema_period".to_string(), vec![0.0])]).is_err());
        assert!(grid_combos(&[("trend_ema_period".to_string(), vec![20.5])]).is_err());
        assert!(grid_combos(&[("ema_period".to_string(), vec![20.0])]).is_ok());
    }
}
