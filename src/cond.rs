//! 策略条件引擎：把入场/出场买卖逻辑表达为可组合的条件。
//!
//! 契约（字段名前后端共用，勿改）见 `config::Condition`：
//! `left` 为指标名，`op` 为比较/穿越，`right` 为常数或指标，`logic` 是与上一条的连接。
//!
//! 求值语义：
//! - 逐 bar 求值，长度与 `bars` 等长；**暖机不足（指标还没值）为 `None`**；
//! - 组合先取第一条，再按「上一条的连接」严格**左结合**依次合并，
//!   任一侧为 `None` 则合并结果为 `None`；
//! - `n_high`/`n_low` 为**不含当前根**的前 N 根极值（突破语义）；
//! - `cross_above`/`cross_below` 用 `i` 与 `i-1` 两点判断，`i==0` 为 `None`；
//! - 浮点等号用 `EPS` 容差；
//! - 非法条件（未知 op/指标、right 缺失、cross 配常数、比较配指标）求值一律
//!   按 `false` 处理并 `tracing::warn`，绝不 panic。

use std::collections::HashMap;
use std::sync::Arc;

use crate::config::{Condition, ConditionRight};
use crate::data::Bar;
use crate::indicators as ind;

/// 浮点等号容差
pub const EPS: f64 = 1e-9;

/// 布林带固定参数（left 契约只给名字，不给参数）
const BOLL_PERIOD: usize = 20;
const BOLL_MULT: f64 = 2.0;

type Series = Arc<Vec<Option<f64>>>;
type Cache = HashMap<String, Series>;

/// 指标序列惰性计算并缓存（同一组条件内按名字+周期复用）
fn left_series(name: &str, period: usize, bars: &[Bar], cache: &mut Cache) -> Option<Series> {
    let period = period.max(1);
    let key = format!("{}:{}", name, period);
    if let Some(s) = cache.get(&key) {
        return Some(s.clone());
    }
    let s: Series = match name {
        "close" => Arc::new(bars.iter().map(|b| Some(b.c)).collect()),
        "ema20" => Arc::new(ind::ema(bars, 20)),
        "ema50" => Arc::new(ind::ema(bars, 50)),
        "ema200" => Arc::new(ind::ema(bars, 200)),
        "boll_up" => Arc::new(ind::boll(bars, BOLL_PERIOD, BOLL_MULT).upper),
        "boll_mid" => Arc::new(ind::boll(bars, BOLL_PERIOD, BOLL_MULT).mid),
        "boll_low" => Arc::new(ind::boll(bars, BOLL_PERIOD, BOLL_MULT).lower),
        "rsi14" => Arc::new(ind::rsi(bars, 14)),
        "atr14" => Arc::new(ind::atr(bars, 14)),
        "n_high" => Arc::new(rolling_extreme(bars, period, true)),
        "n_low" => Arc::new(rolling_extreme(bars, period, false)),
        "pct_change" => Arc::new(pct_change(bars, period)),
        "dev_ema20" => Arc::new(dev_ema(bars, 20)),
        _ => return None,
    };
    cache.insert(key, s.clone());
    Some(s)
}

/// 前 N 根极值，**不含当前根**：i 处为 bars[i-N..i] 的极值，i < N 时 None
fn rolling_extreme(bars: &[Bar], period: usize, high: bool) -> Vec<Option<f64>> {
    let n = bars.len();
    let p = period.max(1);
    let mut out = vec![None; n];
    for i in p..n {
        let win = &bars[i - p..i];
        out[i] = Some(if high {
            win.iter().map(|b| b.h).fold(f64::NEG_INFINITY, f64::max)
        } else {
            win.iter().map(|b| b.l).fold(f64::INFINITY, f64::min)
        });
    }
    out
}

/// N 根涨跌幅（%）：(close[i] / close[i-N] - 1) × 100
fn pct_change(bars: &[Bar], period: usize) -> Vec<Option<f64>> {
    let n = bars.len();
    let p = period.max(1);
    let mut out = vec![None; n];
    for i in p..n {
        let base = bars[i - p].c;
        if base != 0.0 {
            out[i] = Some((bars[i].c / base - 1.0) * 100.0);
        }
    }
    out
}

/// 收盘价偏离 EMA 的百分比
fn dev_ema(bars: &[Bar], period: usize) -> Vec<Option<f64>> {
    let line = ind::ema(bars, period);
    bars.iter()
        .zip(line.iter())
        .map(|(b, v)| match v {
            Some(x) if *x != 0.0 => Some((b.c / x - 1.0) * 100.0),
            _ => None,
        })
        .collect()
}

/// 一条条件的逐 bar 结果；非法条件返回全 `false` 并 warn 一次（不 panic）
fn item_series(cond: &Condition, bars: &[Bar], cache: &mut Cache) -> Vec<Option<bool>> {
    let n = bars.len();
    let bad = |msg: &str| -> Vec<Option<bool>> {
        tracing::warn!(
            "非法条件({}: {} {}): {}，按不成立处理",
            cond.id,
            cond.left,
            cond.op,
            msg
        );
        vec![Some(false); n]
    };

    let op = cond.op.as_str();
    let is_cross = matches!(op, "cross_above" | "cross_below");
    let is_cmp = matches!(op, "gt" | "gte" | "lt" | "lte" | "eq");
    if !is_cross && !is_cmp {
        return bad("未知操作符");
    }
    let right = match &cond.right {
        Some(r) => r,
        None => return bad("缺少 right"),
    };
    // cross 比的是两条线的相对关系，右侧必须是序列
    if is_cross && matches!(right, ConditionRight::Number { .. }) {
        return bad("cross 的 right 必须是指标");
    }
    if is_cmp && matches!(right, ConditionRight::Indicator { .. }) {
        return bad("比较类 op 的 right 必须是常数");
    }

    let left = match left_series(&cond.left, cond.period, bars, cache) {
        Some(s) => s,
        None => return bad("未知左侧指标"),
    };
    let r_series: Series = match right {
        ConditionRight::Number { value } => Arc::new(vec![Some(*value); n]),
        ConditionRight::Indicator { name } => match left_series(name, cond.period, bars, cache) {
            Some(s) => s,
            None => return bad("未知右侧指标"),
        },
    };

    let mut out = vec![None; n];
    for i in 0..n {
        let (lv, rv) = match (
            left.get(i).copied().flatten(),
            r_series.get(i).copied().flatten(),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => continue,
        };
        out[i] = match op {
            "gt" => Some(lv > rv + EPS),
            "gte" => Some(lv > rv - EPS),
            "lt" => Some(lv < rv - EPS),
            "lte" => Some(lv < rv + EPS),
            "eq" => Some((lv - rv).abs() <= EPS),
            "cross_above" | "cross_below" => {
                if i == 0 {
                    continue;
                }
                let (pl, pr) = match (
                    left.get(i - 1).copied().flatten(),
                    r_series.get(i - 1).copied().flatten(),
                ) {
                    (Some(a), Some(b)) => (a, b),
                    _ => continue,
                };
                if op == "cross_above" {
                    Some(pl <= pr + EPS && lv > rv + EPS)
                } else {
                    Some(pl >= pr - EPS && lv < rv - EPS)
                }
            }
            _ => unreachable!("操作符已在前面校验"),
        };
    }
    out
}

/// 严格左结合：以第一条为种子，之后每条按自己的 `logic` 与累计值合并。
/// 任一侧为 None 则结果为 None。（`a or b and c` = `(a or b) and c`）
pub fn fold_items(items: &[Option<bool>], conds: &[Condition]) -> Option<bool> {
    let mut acc: Option<bool> = None;
    for (j, v) in items.iter().enumerate() {
        if j == 0 {
            acc = *v;
            continue;
        }
        let is_or = conds
            .get(j)
            .map(|c| c.logic.eq_ignore_ascii_case("or"))
            .unwrap_or(false);
        acc = match (acc, *v) {
            (Some(a), Some(b)) => Some(if is_or { a || b } else { a && b }),
            _ => None,
        };
    }
    acc
}

/// 单根 bar 上逐条求值：返回 (每条结果, 左结合后的组合结果)
pub fn eval_items_at(
    bars: &[Bar],
    conds: &[Condition],
    i: usize,
) -> (Vec<Option<bool>>, Option<bool>) {
    if conds.is_empty() || bars.is_empty() || i >= bars.len() {
        return (Vec::new(), None);
    }
    let mut cache = Cache::new();
    let items: Vec<Option<bool>> = conds
        .iter()
        .map(|c| item_series(c, bars, &mut cache).get(i).copied().flatten())
        .collect();
    let combined = fold_items(&items, conds);
    (items, combined)
}

/// 指定某根 bar 的组合结果（暖机不足为 None）。
/// 契约对外入口（回测走 `eval_series` 预计算，此接口留给持仓巡检/前端逐条复核）。
#[allow(dead_code)]
pub fn eval_at(bars: &[Bar], conds: &[Condition], i: usize) -> Option<bool> {
    eval_items_at(bars, conds, i).1
}

/// 逐 bar 求值，长度与 bars 一致
pub fn eval_series(bars: &[Bar], conds: &[Condition]) -> Vec<Option<bool>> {
    let n = bars.len();
    if conds.is_empty() {
        return vec![None; n];
    }
    let mut cache = Cache::new();
    let cols: Vec<Vec<Option<bool>>> = conds
        .iter()
        .map(|c| item_series(c, bars, &mut cache))
        .collect();
    let mut out = vec![None; n];
    let mut row = vec![None; cols.len()];
    for i in 0..n {
        for (j, col) in cols.iter().enumerate() {
            row[j] = col.get(i).copied().flatten();
        }
        out[i] = fold_items(&row, conds);
    }
    out
}

/// 出场所用入口：最后一根 bar 上条件组合是否成立。
/// 契约对外入口（回测内部用 `eval_series` 整段预计算，此处供持仓巡检直接调用）。
#[allow(dead_code)]
pub fn exit_hit(bars: &[Bar], conds: &[Condition]) -> bool {
    if bars.is_empty() || conds.is_empty() {
        return false;
    }
    eval_at(bars, conds, bars.len() - 1) == Some(true)
}

/// 左侧指标的可读名
pub fn left_label(name: &str, period: usize) -> String {
    let p = period.max(1);
    match name {
        "close" => "收盘价".into(),
        "ema20" => "EMA20".into(),
        "ema50" => "EMA50".into(),
        "ema200" => "EMA200".into(),
        "boll_up" => "布林上轨".into(),
        "boll_mid" => "布林中轨".into(),
        "boll_low" => "布林下轨".into(),
        "rsi14" => "RSI14".into(),
        "atr14" => "ATR14".into(),
        "n_high" => format!("{}根最高价", p),
        "n_low" => format!("{}根最低价", p),
        "pct_change" => format!("{}根涨跌幅", p),
        "dev_ema20" => "偏离EMA20".into(),
        o => o.to_string(),
    }
}

fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{:.0}", v)
    } else {
        format!("{}", v)
    }
}

fn right_label(right: &Option<ConditionRight>, period: usize) -> String {
    match right {
        Some(ConditionRight::Number { value }) => fmt_num(*value),
        Some(ConditionRight::Indicator { name }) => left_label(name, period),
        None => "?".into(),
    }
}

/// 人可读条件描述，如「收盘价 上穿 EMA50」「RSI14 < 30」
pub fn describe(cond: &Condition) -> String {
    let mid = match cond.op.as_str() {
        "gt" => ">",
        "gte" => "≥",
        "lt" => "<",
        "lte" => "≤",
        "eq" => "=",
        "cross_above" => "上穿",
        "cross_below" => "下穿",
        o => o,
    };
    format!(
        "{} {} {}",
        left_label(&cond.left, cond.period),
        mid,
        right_label(&cond.right, cond.period)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(t: i64, h: f64, l: f64, c: f64) -> Bar {
        Bar { t, o: c, h, l, c, v: 100.0 }
    }

    fn num(v: f64) -> Option<ConditionRight> {
        Some(ConditionRight::Number { value: v })
    }

    fn ind_right(name: &str) -> Option<ConditionRight> {
        Some(ConditionRight::Indicator { name: name.into() })
    }

    fn cond(logic: &str, left: &str, op: &str, right: Option<ConditionRight>, period: usize) -> Condition {
        Condition {
            id: format!("{}-{}", left, op),
            logic: logic.into(),
            left: left.into(),
            op: op.into(),
            right,
            period,
        }
    }

    /// ① 组合为严格左结合：a(1) or b(0) and c(0) → ((1 or 0) and 0) = 0
    #[test]
    fn test_fold_is_strictly_left_associative() {
        let bars = vec![bar(1, 150.0, 149.0, 150.0)];
        let conds = vec![
            cond("and", "close", "gt", num(100.0), 20),  // true，logic 忽略
            cond("or", "close", "gt", num(200.0), 20),   // false
            cond("and", "close", "gt", num(300.0), 20),  // false
        ];
        // 若按 AND 优先则是 1 or (0 and 0) = true；左结合必须为 false
        assert_eq!(eval_at(&bars, &conds, 0), Some(false));

        // 再验一次同构：a(1) and b(0) or c(1) → ((1 and 0) or 1) = 1
        let conds2 = vec![
            cond("and", "close", "gt", num(100.0), 20),
            cond("and", "close", "gt", num(200.0), 20),
            cond("or", "close", "gt", num(140.0), 20),
        ];
        assert_eq!(eval_at(&bars, &conds2, 0), Some(true));

        // 序列求值与单点求值一致
        let s = eval_series(&bars, &conds);
        assert_eq!(s, vec![Some(false)]);
    }

    /// ② cross_above 边界：i=0 不越界（None），i=1 正常判定；暖机不足为 None
    #[test]
    fn test_cross_above_boundaries() {
        // n_high(period=1) = 前一根最高价：i=2 时为 h[1]=10
        let bars = vec![
            bar(1, 10.0, 8.0, 9.0),
            bar(2, 10.0, 8.0, 9.5),
            bar(3, 12.0, 8.0, 11.0),
        ];
        let conds = vec![cond(
            "and",
            "close",
            "cross_above",
            ind_right("n_high"),
            1,
        )];
        let s = eval_series(&bars, &conds);
        assert_eq!(s[0], None, "i=0 无 i-1，应为暖机 None");
        assert_eq!(s[1], None, "i-1 处右侧指标尚无值，仍属暖机");
        assert_eq!(s[2], Some(true), "9.5→11 上穿前根高点 10");

        // 暖机不足：EMA50 在 10 根数据上无值，全 None
        let short: Vec<Bar> = (0..10).map(|i| bar(i as i64 + 1, 1.0, 1.0, 1.0)).collect();
        let warm = vec![cond("and", "ema50", "gt", num(0.0), 20)];
        assert!(eval_series(&short, &warm).iter().all(|v| v.is_none()));

        // cross 缺 i-1 的右侧值时也不 panic
        let bars2 = vec![bar(1, 10.0, 8.0, 9.0), bar(2, 12.0, 8.0, 11.0)];
        let c2 = vec![cond("and", "close", "cross_below", ind_right("ema50"), 20)];
        assert_eq!(eval_series(&bars2, &c2), vec![None, None]);
    }

    /// ③ n_high 不含当前根：突破语义下第 i 根比的是前 N 根高点
    #[test]
    fn test_n_high_excludes_current_bar() {
        // h = 1,2,3,4,5；period=3 → i=3 前 3 根(=1,2,3)最高 3，不含本根 4
        let bars: Vec<Bar> = (0..5)
            .map(|i| bar(i as i64 + 1, (i + 1) as f64, 0.5, (i + 1) as f64))
            .collect();
        let conds = vec![cond("and", "n_high", "lt", num(3.5), 3)];
        let s = eval_series(&bars, &conds);
        assert_eq!(s[2], None, "i<period 暖机 None");
        assert_eq!(s[3], Some(true), "前 3 根高点 3 < 3.5；若含本根 4 则为 false");
        assert_eq!(s[4], Some(false), "前 3 根(2,3,4)高点 4 不小于 3.5");

        // 同源对照：n_low 取前 N 根最低
        let lows = vec![
            bar(1, 1.0, 9.0, 9.0),
            bar(2, 1.0, 8.0, 8.0),
            bar(3, 1.0, 5.0, 5.0),
        ];
        let c2 = vec![cond("and", "n_low", "gt", num(7.5), 2)];
        assert_eq!(eval_series(&lows, &c2), vec![None, None, Some(true)]);
    }

    /// ④ 非法条件按 false 处理、不 panic、不误报暖机
    #[test]
    fn test_invalid_conditions_fail_soft() {
        let bars = vec![bar(1, 10.0, 8.0, 9.0), bar(2, 12.0, 8.0, 11.0)];
        let cases = vec![
            cond("and", "close", "gt", None, 20),                     // right 缺失
            cond("and", "close", "cross_above", num(10.0), 20),       // cross 配常数
            cond("and", "close", "gt", ind_right("ema50"), 20),       // 比较配指标
            cond("and", "close", "between", num(1.0), 20),            // 未知 op
            cond("and", "ema99", "gt", num(1.0), 20),                 // 未知左侧
            cond("and", "close", "gt", ind_right("ema99"), 20),       // 未知右侧
        ];
        for c in cases {
            let s = eval_series(&bars, &vec![c.clone()]);
            assert_eq!(s, vec![Some(false), Some(false)], "非法条件 {:?} 应按 false 处理", c.op);
            assert_eq!(eval_at(&bars, &vec![c], 1), Some(false));
        }
        // 空条件：无判定
        assert_eq!(eval_series(&bars, &[]), vec![None, None]);
        assert_eq!(eval_at(&bars, &[], 0), None);
        assert!(!exit_hit(&bars, &[]));
    }

    /// 附：dev_ema20 / pct_change 语义与 describe 文案
    #[test]
    fn test_describe_and_derived_series() {
        let c = cond("and", "rsi14", "lt", num(30.0), 20);
        assert_eq!(describe(&c), "RSI14 < 30");
        let c2 = cond("or", "close", "cross_above", ind_right("ema50"), 20);
        assert_eq!(describe(&c2), "收盘价 上穿 EMA50");
        assert_eq!(describe(&cond("and", "n_high", "gte", num(20.0), 60)), "60根最高价 ≥ 20");
        assert_eq!(describe(&cond("and", "dev_ema20", "lte", num(-1.5), 20)), "偏离EMA20 ≤ -1.5");

        let bars: Vec<Bar> = (0..5).map(|i| bar(i as i64 + 1, 10.0, 1.0, 10.0 + i as f64)).collect();
        let pct = eval_series(&bars, &vec![cond("and", "pct_change", "gt", num(30.0), 2)]);
        // i=2: 12/10-1 = 20% → false；i=4: 14/12-1 = 16.7% → false
        assert_eq!(pct, vec![None, None, Some(false), Some(false), Some(false)]);
        let pct2 = eval_series(&bars, &vec![cond("and", "pct_change", "gt", num(15.0), 2)]);
        assert_eq!(pct2, vec![None, None, Some(true), Some(true), Some(true)]);
    }

    /// 契约 JSON 往返：字段名与前端约定一致，旧 settings 可兼容
    #[test]
    fn test_contract_json_roundtrip() {
        let raw = r#"{"id":"c1","logic":"or","left":"ema20","op":"cross_above","right":{"kind":"indicator","name":"ema50"},"period":20}"#;
        let c: Condition = serde_json::from_str(raw).expect("契约 JSON 必须可解析");
        assert_eq!(c.id, "c1");
        assert_eq!(c.left, "ema20");
        assert_eq!(c.op, "cross_above");
        assert!(matches!(
            c.right,
            Some(ConditionRight::Indicator { ref name }) if name == "ema50"
        ));
        let back = serde_json::to_value(&c).unwrap();
        assert_eq!(back["logic"], "or");
        assert_eq!(back["right"]["kind"], "indicator");
        assert_eq!(back["right"]["name"], "ema50");

        // 数字右值 + 缺省 logic/period/id
        let raw2 = r#"{"left":"close","op":"gt","right":{"kind":"number","value":1.23}}"#;
        let c2: Condition = serde_json::from_str(raw2).unwrap();
        assert!(matches!(
            c2.right,
            Some(ConditionRight::Number { value }) if (value - 1.23).abs() < 1e-12
        ));
        assert_eq!(c2.logic, "and", "logic 缺省 and");
        assert_eq!(c2.period, 20, "period 缺省 20");
        assert_eq!(c2.id, "");
        assert_eq!(
            serde_json::to_value(&c2).unwrap()["right"]["kind"],
            "number"
        );

        // right 缺失不解析失败（求值时按非法 false 处理）
        let c3: Condition = serde_json::from_str(r#"{"left":"close","op":"gt"}"#).unwrap();
        assert!(c3.right.is_none());
        assert_eq!(eval_at(&[bar(1, 10.0, 1.0, 9.0)], &[c3], 0), Some(false));

        // 旧 settings 的 Strategy（无 entry/exit 字段）仍可解析 → 零回归兼容
        let st: crate::config::Strategy = serde_json::from_str(
            r#"{"id":"s","name":"n","desc":"d","enabled":true,"exec_interval":"5m","dir_interval":"1h","confirm_interval":"15m","ema_period":20,"trend_ema_period":50,"rr_min":1.8,"confidence_floor":44.0,"risk_percent":0.6,"allow_long":true,"allow_short":false,"prompt":"","focus":[]}"#,
        )
        .expect("旧 settings 的策略必须仍可解析");
        assert!(st.entry_long.is_empty() && st.entry_short.is_empty() && st.exit_conditions.is_empty());
        // 新字段序列化后键名固定，前端按契约读取
        let sv = serde_json::to_value(&st).unwrap();
        assert_eq!(sv["entry_long"], serde_json::json!([]));
        assert_eq!(sv["entry_short"], serde_json::json!([]));
        assert_eq!(sv["exit_conditions"], serde_json::json!([]));
    }
}
