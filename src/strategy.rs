//! 策略引擎：还原 TITAN 五步判定
//!
//! 1 定方向周期趋势    2 回踩 EMA20    3 确认周期吞没形态
//! 4 影线外止损        5 盈亏比过滤
//!
//! 输出 0-100 置信度与逐条理由，前端直接展示。

use serde::Serialize;

use crate::cond;
use crate::config::Settings;
use crate::data::Bar;
use crate::indicators as ind;
use crate::risk::{self, Plan};

#[derive(Debug, Clone, Serialize)]
pub struct Reason {
    pub ok: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Signal {
    pub ok: bool,
    pub dir: i32,
    pub direction: String,
    pub confidence: f64,
    pub blockers: u32,
    pub pattern: Option<String>,
    pub entry: f64,
    pub rsi: Option<f64>,
    pub atr: Option<f64>,
    pub plan: Option<Plan>,
    pub reasons: Vec<Reason>,
    pub summary: String,
    /// 生效策略的 id 与名称
    pub strategy_id: String,
    pub strategy_name: String,
}

pub struct Input<'a> {
    pub dir_bars: &'a [Bar],
    pub exec_bars: &'a [Bar],
    pub conf_bars: &'a [Bar],
    /// 指定用哪条策略；None 则用当前生效策略
    pub strategy: Option<crate::config::Strategy>,
}

/// 把策略参数套到 Settings 上，让下游逻辑统一读 s.strategy
pub fn apply(s: &Settings, st: &crate::config::Strategy) -> Settings {
    let mut c = s.clone();
    c.exec_interval = st.exec_interval.clone();
    c.dir_interval = st.dir_interval.clone();
    c.confirm_interval = st.confirm_interval.clone();
    c.strategy.ema_period = st.ema_period;
    c.strategy.trend_ema_period = st.trend_ema_period;
    c.strategy.rr_min = st.rr_min;
    c.strategy.confidence_floor = st.confidence_floor;
    c.strategy.risk_percent = st.risk_percent;
    c.strategy.allow_long = st.allow_long;
    c.strategy.allow_short = st.allow_short;
    c
}

pub fn evaluate(inp: Input, s: &Settings) -> Signal {
    let active = inp.strategy.clone().unwrap_or_else(|| s.active());
    let s = &apply(s, &active);
    let (dir_bars, exec_bars, conf_bars) = (inp.dir_bars, inp.exec_bars, inp.conf_bars);
    let mut reasons: Vec<Reason> = Vec::new();
    let mut conf = 0.0f64;
    let mut dir = 0i32;
    let mut blockers = 0u32;

    if dir_bars.len() < 60 || exec_bars.len() < 30 {
        return Signal {
            ok: false,
            dir: 0,
            direction: String::new(),
            confidence: 0.0,
            blockers: 1,
            pattern: None,
            entry: 0.0,
            rsi: None,
            atr: None,
            plan: None,
            reasons: vec![Reason { ok: false, text: "K 线数据不足，无法判定".into() }],
            summary: "数据不足".into(),
            strategy_id: active.id.clone(),
            strategy_name: active.name.clone(),
        };
    }

    // ---- 条件模式 ----
    // 策略定义了入场条件（多或空）时，条件判定取代五步；
    // 两组都为空才走下面的五步路径 —— 零回归保障。
    if !active.entry_long.is_empty() || !active.entry_short.is_empty() {
        return evaluate_conditions(&active, s, exec_bars);
    }

    let st = &s.strategy;
    let i_dir = dir_bars.len() - 1;
    let i_exec = exec_bars.len() - 1;
    fn dir_label(v: &str) -> &str {
        match v {
            "5m" => "M5",
            "15m" => "M15",
            "1h" => "H1",
            "4h" => "H4",
            "1d" => "D1",
            o => o,
        }
    }

    // ---- 1 趋势定方向 ----
    let trend_ema = ind::ema(dir_bars, st.trend_ema_period);
    let tr = ind::trend(dir_bars, &trend_ema, i_dir);
    if tr.dir == 0 {
        reasons.push(Reason {
            ok: false,
            text: format!(
                "定方向周期({})趋势不明，均线走平或价格穿越均线",
                dir_label(&s.dir_interval)
            ),
        });
        blockers += 1;
    } else if (tr.dir == 1 && !st.allow_long) || (tr.dir == -1 && !st.allow_short) {
        reasons.push(Reason {
            ok: false,
            text: format!(
                "趋势为{}，但该方向已在设置中禁用",
                if tr.dir == 1 { "多" } else { "空" }
            ),
        });
        blockers += 1;
    } else {
        dir = tr.dir;
        conf += (tr.strength * 0.3).min(30.0);
        reasons.push(Reason {
            ok: true,
            text: format!(
                "趋势：{} {}，EMA{} 斜率 {:+.3}%",
                dir_label(&s.dir_interval),
                if dir == 1 { "向上" } else { "向下" },
                st.trend_ema_period,
                tr.slope_pct
            ),
        });
    }

    // ---- 2 回踩 EMA ----
    let exec_ema = ind::ema(exec_bars, st.ema_period);
    let pb = ind::pullback_to(exec_bars, i_exec, &exec_ema, 12, 0.15);
    if pb.hit {
        conf += 25.0;
        reasons.push(Reason {
            ok: true,
            text: format!(
                "回踩：{} 价格回踩 EMA{} 后收回，现价偏离 {:+.2}%",
                dir_label(&s.exec_interval),
                st.ema_period,
                pb.dist_pct.unwrap_or(0.0)
            ),
        });
    } else {
        reasons.push(Reason {
            ok: false,
            text: format!(
                "未回踩 EMA{}（现价偏离 {}）",
                st.ema_period,
                pb.dist_pct
                    .map(|d| format!("{:+.2}%", d))
                    .unwrap_or_else(|| "--".into())
            ),
        });
        blockers += 1;
    }

    // ---- 3 形态确认 ----
    let mut pattern: Option<String> = None;
    if conf_bars.len() >= 3 {
        let i_c = conf_bars.len() - 1;
        if dir >= 0 && ind::bullish_engulf(conf_bars, i_c) {
            pattern = Some("看涨吞没".into());
            conf += 25.0;
            reasons.push(Reason {
                ok: true,
                text: format!(
                    "形态：{} 出现看涨吞没，实体包住前根",
                    dir_label(&s.confirm_interval)
                ),
            });
        } else if dir < 0 && ind::bearish_engulf(conf_bars, i_c) {
            pattern = Some("看跌吞没".into());
            conf += 25.0;
            reasons.push(Reason {
                ok: true,
                text: format!(
                    "形态：{} 出现看跌吞没，实体包住前根",
                    dir_label(&s.confirm_interval)
                ),
            });
        } else {
            reasons.push(Reason {
                ok: false,
                text: format!("{} 无确认形态", dir_label(&s.confirm_interval)),
            });
            blockers += 1;
        }
    }

    // ---- RSI 辅助 ----
    let rsi_series = ind::rsi(exec_bars, 14);
    let atr_series = ind::atr(exec_bars, 14);
    let rsi_now = rsi_series.get(i_exec).and_then(|v| *v);
    let atr_now = atr_series.get(i_exec).and_then(|v| *v);

    if let Some(r) = rsi_now {
        if dir == 1 && r > 45.0 && r < 72.0 {
            conf += 8.0;
            reasons.push(Reason { ok: true, text: format!("RSI {:.1}，多头未超买", r) });
        } else if dir == 1 && r >= 72.0 {
            reasons.push(Reason { ok: false, text: format!("RSI {:.1} 超买，追高风险大", r) });
        } else if dir == 1 && r <= 45.0 {
            reasons.push(Reason { ok: false, text: format!("RSI {:.1} 偏弱，动能不足", r) });
            blockers += 1;
        } else if dir == -1 && r < 55.0 && r > 28.0 {
            conf += 8.0;
            reasons.push(Reason { ok: true, text: format!("RSI {:.1}，空头未超卖", r) });
        }
    }

    // ---- 4 影线外止损 ----
    let entry = exec_bars[i_exec].c;
    let mut plan: Option<Plan> = None;
    let a = atr_now.unwrap_or(0.0);
    let sl_price = if dir == 1 {
        ind::swing_low(exec_bars, i_exec, 5) - a * 0.15
    } else if dir == -1 {
        ind::swing_high(exec_bars, i_exec, 5) + a * 0.15
    } else {
        0.0
    };

    if dir != 0 && sl_price > 0.0 {
        let p = risk::plan(
            if dir == 1 { "long" } else { "short" },
            entry,
            sl_price,
            s,
        );
        if p.sl_points >= s.risk.min_sl_points && p.sl_points <= s.risk.max_sl_points {
            conf += 12.0;
            reasons.push(Reason {
                ok: true,
                text: format!(
                    "止损：影线外 {:.2}，{:.0} 点，在允许区间内",
                    p.sl_price, p.sl_points
                ),
            });
            plan = Some(p);
        } else {
            reasons.push(Reason {
                ok: false,
                text: format!(
                    "止损 {:.0} 点超出 {:.0}-{:.0}，结构不稳",
                    p.sl_points, s.risk.min_sl_points, s.risk.max_sl_points
                ),
            });
            blockers += 1;
        }
    }

    if let Some(p) = &plan {
        if p.rr >= st.rr_min {
            reasons.push(Reason {
                ok: true,
                text: format!("盈亏比 {:.2} ≥ 下限 {:.2}，可接受", p.rr, st.rr_min),
            });
        }
    }

    // ---- 5 波动率 ----
    if let Some(at) = atr_now {
        let pts = at / s.point_value;
        if pts > 0.0 && pts < s.risk.min_sl_points * 0.5 {
            reasons.push(Reason {
                ok: false,
                text: format!("ATR 仅 {:.0} 点，行情过窄无操作空间", pts),
            });
            blockers += 1;
        }
    }

    conf = conf.clamp(0.0, 100.0);
    let conf = (conf * 10.0).round() / 10.0;
    let pass_conf = conf >= st.confidence_floor;
    let pass_block = blockers == 0;

    if !pass_block {
        reasons.push(Reason {
            ok: false,
            text: format!("硬性条件未满足（{} 项），不产生信号", blockers),
        });
    }
    if pass_block && !pass_conf {
        reasons.push(Reason {
            ok: false,
            text: format!("置信度 {:.0} 低于下限 {:.0}", conf, st.confidence_floor),
        });
    }

    let ok = pass_block && pass_conf;
    let direction = match dir {
        1 => "long",
        -1 => "short",
        _ => "",
    };
    let summary = if !ok {
        "当前无入场信号".to_string()
    } else {
        format!(
            "{} · 置信度 {:.0}{}",
            if dir == 1 { "做多" } else { "做空" },
            conf,
            pattern.as_ref().map(|p| format!(" · {}", p)).unwrap_or_default()
        )
    };

    Signal {
        ok,
        dir,
        direction: direction.to_string(),
        confidence: conf,
        blockers,
        pattern,
        entry,
        rsi: rsi_now,
        atr: atr_now,
        plan,
        reasons,
        summary,
        strategy_id: active.id.clone(),
        strategy_name: active.name.clone(),
    }
}

/// 条件路径：在「最后一根 exec bar」上求值入场条件组。
///
/// - 显式方向：`entry_long` 全组成立且 `allow_long` → 做多；`entry_short` 同理做空；
///   **两组同时成立时取做多**（写明以免歧义）；
/// - `reasons` 逐条列出条件（`✓`/`✗`），`confidence` = 命中条数占比（保留 0.1），
///   `blockers` = 展示组中未命中的条数；
/// - 止损仍走影线外逻辑，方向由信号方向定；止损超出允许区间时 `plan` 为空
///   （回测因此不会建仓），但不计入 blockers。
fn evaluate_conditions(active: &crate::config::Strategy, s: &Settings, exec_bars: &[Bar]) -> Signal {
    let i = exec_bars.len() - 1;
    let (long_items, long_comb) = cond::eval_items_at(exec_bars, &active.entry_long, i);
    let (short_items, short_comb) = cond::eval_items_at(exec_bars, &active.entry_short, i);
    let long_ok = active.allow_long && long_comb == Some(true);
    let short_ok = active.allow_short && short_comb == Some(true);

    // 同时成立取做多；都不成立时优先展示多头组的条件（前端逐条对照用）
    let (dir, group, items): (i32, &[crate::config::Condition], &[Option<bool>]) = if long_ok {
        (1, &active.entry_long, &long_items)
    } else if short_ok {
        (-1, &active.entry_short, &short_items)
    } else if !active.entry_long.is_empty() {
        (0, &active.entry_long, &long_items)
    } else {
        (0, &active.entry_short, &short_items)
    };

    let total = items.len();
    let hits = items.iter().filter(|v| **v == Some(true)).count();
    let mut reasons: Vec<Reason> = Vec::with_capacity(total + 1);
    for (c, v) in group.iter().zip(items.iter()) {
        let ok = *v == Some(true);
        reasons.push(Reason {
            ok,
            text: format!("{}{}", cond::describe(c), if ok { " ✓" } else { " ✗" }),
        });
    }
    let confidence = if total > 0 {
        ((hits as f64 / total as f64) * 1000.0).round() / 10.0
    } else {
        0.0
    };
    let blockers = (total - hits) as u32;

    // 止损：与五步同源的影线外逻辑（此处刻意重复几行，免得动到五步路径）
    let entry = exec_bars[i].c;
    let atr_now = ind::atr(exec_bars, 14).get(i).and_then(|v| *v);
    let rsi_now = ind::rsi(exec_bars, 14).get(i).and_then(|v| *v);
    let mut plan: Option<Plan> = None;
    if dir != 0 {
        let a = atr_now.unwrap_or(0.0);
        let sl_price = if dir == 1 {
            ind::swing_low(exec_bars, i, 5) - a * 0.15
        } else {
            ind::swing_high(exec_bars, i, 5) + a * 0.15
        };
        if sl_price > 0.0 {
            let p = risk::plan(if dir == 1 { "long" } else { "short" }, entry, sl_price, s);
            if p.sl_points >= s.risk.min_sl_points && p.sl_points <= s.risk.max_sl_points {
                reasons.push(Reason {
                    ok: true,
                    text: format!(
                        "止损：影线外 {:.2}，{:.0} 点，在允许区间内",
                        p.sl_price, p.sl_points
                    ),
                });
                plan = Some(p);
            } else {
                reasons.push(Reason {
                    ok: false,
                    text: format!(
                        "止损 {:.0} 点超出 {:.0}-{:.0}，结构不稳",
                        p.sl_points, s.risk.min_sl_points, s.risk.max_sl_points
                    ),
                });
            }
        }
    }

    let ok = dir != 0;
    let summary = if ok {
        format!(
            "{} · 置信度 {:.0} · 条件模式",
            if dir == 1 { "做多" } else { "做空" },
            confidence
        )
    } else {
        "当前无入场信号（条件未全部满足）".to_string()
    };

    Signal {
        ok,
        dir,
        direction: match dir {
            1 => "long",
            -1 => "short",
            _ => "",
        }
        .to_string(),
        confidence,
        blockers,
        pattern: None,
        entry,
        rsi: rsi_now,
        atr: atr_now,
        plan,
        reasons,
        summary,
        strategy_id: active.id.clone(),
        strategy_name: active.name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Condition, ConditionRight, Strategy};

    fn wave_bars(n: usize, base: f64) -> Vec<Bar> {
        let mut out = Vec::with_capacity(n);
        let mut prev = base;
        for i in 0..n {
            let c = base + i as f64 * 0.5 + 3.0 * ((i as f64) * 0.7).sin();
            let o = if i == 0 { c } else { prev };
            out.push(Bar {
                t: 1_700_000_000 + i as i64 * 300,
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

    fn loose() -> Settings {
        let mut s = Settings::default();
        s.spread_points = 10.0;
        s.risk.min_sl_points = 1.0;
        s.risk.max_sl_points = 100_000.0;
        s
    }

    fn base_strategy() -> Strategy {
        let mut st = Strategy::new("t_snap", "快照策略", "五步对拍用");
        st.exec_interval = "5m".into();
        st.dir_interval = "5m".into();
        st.confirm_interval = "5m".into();
        st.ema_period = 20;
        st.trend_ema_period = 50;
        st.confidence_floor = 0.0;
        st
    }

    fn num(v: f64) -> Option<ConditionRight> {
        Some(ConditionRight::Number { value: v })
    }

    fn cond(logic: &str, left: &str, op: &str, right: Option<ConditionRight>) -> Condition {
        Condition {
            id: "c".into(),
            logic: logic.into(),
            left: left.into(),
            op: op.into(),
            right,
            period: 20,
        }
    }

    /// ⑥ 入场条件两组为空 → 五步原样（对拍改造前快照，文案一字不许变）
    #[test]
    fn test_legacy_five_step_snapshot_unchanged() {
        let s = loose();
        let st = base_strategy();
        let bars = wave_bars(140, 2000.0);
        let sig = evaluate(
            Input {
                dir_bars: &bars,
                exec_bars: &bars,
                conf_bars: &bars,
                strategy: Some(st),
            },
            &s,
        );

        assert!(!sig.ok && sig.dir == 1, "快照应为「方向成立但确认形态缺失」");
        assert_eq!(sig.confidence, 58.5);
        assert_eq!(sig.blockers, 1);
        assert_eq!(sig.summary, "当前无入场信号");

        let expect: Vec<(bool, &str)> = vec![
            (true, "趋势：M5 向上，EMA50 斜率 +0.025%"),
            (true, "回踩：M5 价格回踩 EMA20 后收回，现价偏离 +0.43%"),
            (false, "M5 无确认形态"),
            (true, "RSI 68.4，多头未超买"),
            (true, "止损：影线外 2065.04，472 点，在允许区间内"),
            (false, "硬性条件未满足（1 项），不产生信号"),
        ];
        assert_eq!(sig.reasons.len(), expect.len(), "五步理由条数变化");
        for (r, (ok, text)) in sig.reasons.iter().zip(expect) {
            assert_eq!(r.ok, ok, "理由 ok 变化: {}", r.text);
            assert_eq!(r.text, text, "五步理由文案必须一字不变");
        }
    }

    /// ⑤ 条件路径：逐条 reasons、方向、置信度与条件模式 summary
    #[test]
    fn test_condition_mode_reasons_and_dir() {
        let s = loose();
        let bars = wave_bars(140, 2000.0);

        let mut st = base_strategy();
        st.allow_long = true;
        st.entry_long = vec![
            cond("and", "close", "gt", num(0.0)),
            cond("and", "rsi14", "lt", num(100.0)),
        ];
        let sig = evaluate(
            Input {
                dir_bars: &bars,
                exec_bars: &bars,
                conf_bars: &bars,
                strategy: Some(st),
            },
            &s,
        );
        assert!(sig.ok && sig.dir == 1 && sig.direction == "long");
        assert!(sig.summary.ends_with("· 条件模式"), "summary={}", sig.summary);
        assert!(sig.summary.starts_with("做多 · 置信度 100"), "summary={}", sig.summary);
        assert_eq!(sig.confidence, 100.0);
        assert_eq!(sig.blockers, 0);
        assert!(sig.plan.is_some(), "条件模式仍须给出影线外止损方案");
        // 逐条 reasons：两条条件 + 一条止损
        assert_eq!(sig.reasons.len(), 3);

        let texts: Vec<&str> = sig.reasons.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts[0], "收盘价 > 0 ✓");
        assert_eq!(texts[1], "RSI14 < 100 ✓");
        assert!(texts[2].starts_with("止损：影线外"));
        assert!(sig.reasons[..2].iter().all(|r| r.ok));

        // 条件不成立：无信号、blockers 计数、summary 固定文案，✗ 逐条可见
        let mut st2 = base_strategy();
        st2.entry_long = vec![
            cond("and", "rsi14", "lt", num(100.0)),
            cond("and", "close", "gt", num(1.0e9)),
        ];
        let sig2 = evaluate(
            Input {
                dir_bars: &bars,
                exec_bars: &bars,
                conf_bars: &bars,
                strategy: Some(st2),
            },
            &s,
        );
        assert!(!sig2.ok && sig2.dir == 0);
        assert_eq!(sig2.blockers, 1);
        assert_eq!(sig2.confidence, 50.0);
        assert_eq!(sig2.summary, "当前无入场信号（条件未全部满足）");
        assert_eq!(sig2.reasons[0].text, "RSI14 < 100 ✓");
        assert_eq!(sig2.reasons[1].text, "收盘价 > 1000000000 ✗");
        assert!(sig2.reasons[0].ok && !sig2.reasons[1].ok);
        assert!(sig2.plan.is_none(), "无信号不给计划");
    }

    /// 5b 空头条件与「同时成立取做多」、方向被禁用时不产生信号
    #[test]
    fn test_condition_mode_short_and_long_priority() {
        let s = loose();
        let bars = wave_bars(140, 2000.0);

        let mut st = base_strategy();
        st.allow_long = false;
        st.allow_short = true;
        st.entry_short = vec![cond("and", "close", "gt", num(0.0))];
        let sig = evaluate(
            Input {
                dir_bars: &bars,
                exec_bars: &bars,
                conf_bars: &bars,
                strategy: Some(st),
            },
            &s,
        );
        assert!(sig.ok && sig.dir == -1 && sig.direction == "short");
        assert!(sig.summary.starts_with("做空 · 置信度 100"));
        // 空头止损取影线外上方，价格应高于入场价
        let p = sig.plan.as_ref().expect("空头也须有止损方案");
        assert!(p.sl_price > sig.entry);

        // 两组同时成立 → 取做多
        let mut both = base_strategy();
        both.allow_long = true;
        both.allow_short = true;
        both.entry_long = vec![cond("and", "close", "gt", num(0.0))];
        both.entry_short = vec![cond("and", "close", "gt", num(0.0))];
        let sig2 = evaluate(
            Input {
                dir_bars: &bars,
                exec_bars: &bars,
                conf_bars: &bars,
                strategy: Some(both),
            },
            &s,
        );
        assert_eq!(sig2.dir, 1, "两组同时成立必须取做多");

        // 条件成立但方向被禁用 → 不产生信号
        let mut banned = base_strategy();
        banned.allow_long = false;
        banned.entry_long = vec![cond("and", "close", "gt", num(0.0))];
        let sig3 = evaluate(
            Input {
                dir_bars: &bars,
                exec_bars: &bars,
                conf_bars: &bars,
                strategy: Some(banned),
            },
            &s,
        );
        assert!(!sig3.ok && sig3.dir == 0);
        assert_eq!(sig3.summary, "当前无入场信号（条件未全部满足）");
    }

    /// 出场条件入口：最后一根成立即平仓
    #[test]
    fn test_exit_hit_entry() {
        let bars = wave_bars(60, 2000.0);
        let hit = cond::exit_hit(&bars, &[cond("and", "close", "gt", num(0.0))]);
        assert!(hit);
        let miss = cond::exit_hit(&bars, &[cond("and", "close", "gt", num(1.0e9))]);
        assert!(!miss);
        assert!(!cond::exit_hit(&bars, &[]), "无出场条件不应平仓");
    }
}
