//! 风控引擎：权益风险反推手数 + 多层闸门

use serde::Serialize;

use crate::config::Settings;

#[derive(Debug, Clone, Serialize)]
pub struct Gate {
    pub ok: bool,
    pub blocks: Vec<String>,
    pub warns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub direction: String,
    pub entry: f64,
    pub sl_price: f64,
    pub tp_price: f64,
    pub sl_points: f64,
    pub tp_points: f64,
    pub rr: f64,
    pub lot: f64,
    pub risk_money: f64,
    pub tp1_price: f64,
    pub tp2_price: f64,
    pub tp1_lot: f64,
    pub tp2_lot: f64,
    pub trail_sl: f64,
}

/// 价格差 → 点数
pub fn price_to_points(diff: f64, point_value: f64) -> f64 {
    if point_value <= 0.0 {
        return 0.0;
    }
    diff.abs() / point_value
}

/// 1 点的美元价值（每手）
pub fn point_money(point_value: f64, contract_size: f64) -> f64 {
    point_value * contract_size
}

/// 按止损点数反推手数
pub fn calc_lot(equity: f64, risk_pct: f64, sl_points: f64, s: &Settings) -> f64 {
    if sl_points <= 0.0 {
        return 0.0;
    }
    let r = &s.risk;
    let money_at_risk = equity * risk_pct / 100.0;
    let loss_per_lot = sl_points * point_money(s.point_value, s.contract_size);
    if loss_per_lot <= 0.0 {
        return 0.0;
    }
    let mut lot = money_at_risk / loss_per_lot;
    lot = round_step(lot, r.lot_step);
    lot = lot.clamp(r.min_lot, r.max_lot);
    if lot < r.min_lot {
        0.0
    } else {
        (lot * 100.0).round() / 100.0
    }
}

pub fn round_step(v: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return v;
    }
    (v / step).round() * step
}

/// 生成完整交易计划
pub fn plan(direction: &str, entry: f64, sl_price: f64, s: &Settings) -> Plan {
    let is_long = direction == "long";
    let sl_points = price_to_points(entry - sl_price, s.point_value);

    // 主目标：达到最低盈亏比。止损距离恒为正，方向决定加减号。
    let risk_dist = (entry - sl_price).abs();
    let tp_price = if is_long {
        entry + s.strategy.rr_min * risk_dist
    } else {
        entry - s.strategy.rr_min * risk_dist
    };
    let tp_points = price_to_points(tp_price - entry, s.point_value);

    let lot = calc_lot(s.equity, s.strategy.risk_percent, sl_points, s);
    let risk_money = lot * sl_points * point_money(s.point_value, s.contract_size);

    // TP1 / TP2 按盈亏比 1 : 1.8 分配，其余留给移动止损
    let tp1_rr = 1.0;
    let tp2_rr = s.strategy.rr_min * 0.8;
    let (tp1_price, tp2_price) = if is_long {
        (entry + tp1_rr * risk_dist, entry + tp2_rr * risk_dist)
    } else {
        (entry - tp1_rr * risk_dist, entry - tp2_rr * risk_dist)
    };

    // 移动止损起点：TP2 之后用 ATR 跟随，此处给初始值
    let trail_sl = if is_long { entry } else { entry };

    let tp1_lot = round_step(lot * s.exit.tp1_close_pct / 100.0, s.risk.lot_step);
    let tp2_lot = round_step(lot * s.exit.tp2_close_pct / 100.0, s.risk.lot_step);

    Plan {
        direction: direction.into(),
        entry,
        sl_price,
        tp_price,
        sl_points,
        tp_points,
        rr: if sl_points > 0.0 { tp_points / sl_points } else { 0.0 },
        lot,
        risk_money,
        tp1_price,
        tp2_price,
        tp1_lot,
        tp2_lot,
        trail_sl,
    }
}

/// 全闸门校验
pub struct GateInput<'a> {
    pub direction: &'a str,
    pub sl_points: f64,
    pub tp_points: f64,
    pub lot: f64,
    pub daily_count: u32,
    /// 当日已实现盈亏（账本 daily_pnl），负数为亏损
    pub daily_pnl: f64,
    pub near_event: bool,
}

/// 点差 + 时段 + 单数 + 盈亏比 + 止损区间 + 当日亏损预算
pub fn gate_check(inp: GateInput, s: &Settings) -> Gate {
    let mut blocks = Vec::new();
    let mut warns = Vec::new();

    if !inp.direction.is_empty() && inp.sl_points > 0.0 && inp.tp_points > 0.0 {
        let rr = inp.tp_points / inp.sl_points;
        // 加一点容差：用户按 1.8 填目标价时，浮点算出来可能是 1.7999999，
        // 不该被判成「低于下限」。取下限的 0.1% 作为可接受误差。
        let eps = s.strategy.rr_min.abs() * 0.001;
        if rr < s.strategy.rr_min - eps {
            blocks.push(format!(
                "盈亏比 {:.2} 低于下限 {:.2}",
                rr, s.strategy.rr_min
            ));
        }
    }

    if s.spread_points > s.risk.max_spread_points {
        blocks.push(format!(
            "点差 {:.0} 超过上限 {:.0}",
            s.spread_points, s.risk.max_spread_points
        ));
    }

    if inp.daily_count >= s.risk.max_daily_trades {
        blocks.push(format!(
            "日内已达 {} 单，上限 {}",
            inp.daily_count, s.risk.max_daily_trades
        ));
    }

    // 今日可亏额度：与日单数闸并列，独立生效；0 或负 = 关闭
    let budget = s.equity * s.risk.daily_loss_budget_pct / 100.0;
    let loss = if inp.daily_pnl < 0.0 { -inp.daily_pnl } else { 0.0 };
    if budget > 0.0 && loss >= budget {
        // 百分比太小时不留一位小数，免得显示成「0.0%」
        let pct_txt = if s.risk.daily_loss_budget_pct >= 0.1 {
            format!("{:.1}", s.risk.daily_loss_budget_pct)
        } else {
            format!("{}", s.risk.daily_loss_budget_pct)
        };
        blocks.push(format!(
            "今日亏损已达预算 ${:.2}（本金的 {}%），明日再战",
            budget, pct_txt
        ));
    }

    if !in_session(&s.risk.session_start, &s.risk.session_end) {
        blocks.push(format!(
            "不在交易时段 {}-{}",
            s.risk.session_start, s.risk.session_end
        ));
    }

    if inp.sl_points > 0.0
        && (inp.sl_points < s.risk.min_sl_points || inp.sl_points > s.risk.max_sl_points)
    {
        blocks.push(format!(
            "止损 {:.0} 点超出 {:.0}-{:.0}",
            inp.sl_points, s.risk.min_sl_points, s.risk.max_sl_points
        ));
    }

    if s.risk.event_block && inp.near_event {
        blocks.push(format!("重大事件 {} 分钟封锁期内", s.risk.event_block_minutes));
    }

    if s.spread_points > s.risk.max_spread_points * 0.75 {
        warns.push(format!(
            "点差接近上限（{:.0}/{:.0}）",
            s.spread_points, s.risk.max_spread_points
        ));
    }
    if inp.lot >= s.risk.max_lot * 0.8 {
        warns.push("手数接近上限".to_string());
    }
    if s.equity < 1000.0 {
        warns.push("权益偏低，注意爆仓风险".to_string());
    }

    Gate { ok: blocks.is_empty(), blocks, warns }
}

pub fn in_session(start: &str, end: &str) -> bool {
    let now = chrono::Local::now().format("%H:%M").to_string();
    if start <= end {
        now.as_str() >= start && now.as_str() <= end
    } else {
        now.as_str() >= start || now.as_str() <= end
    }
}

/// 平仓盈亏（美元）。账本内部有自己的实现，这里供外部计算与测试使用。
#[allow(dead_code)]
pub fn pnl(direction: &str, entry: f64, exit: f64, lot: f64, s: &Settings) -> f64 {
    let diff = if direction == "long" { exit - entry } else { entry - exit };
    diff * lot * s.contract_size
}