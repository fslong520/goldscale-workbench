//! 持仓与成交账本：存 data/portfolio.json
//!
//! 全部为本地模拟持仓，不连任何券商，不产生真实委托。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::config::Settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: String,
    pub symbol: String,
    pub direction: String,   // long / short
    pub lot: f64,
    pub entry: f64,
    pub sl: f64,
    pub tp1: f64,
    pub tp2: f64,
    pub current: f64,
    pub tp1_done: bool,
    pub tp2_done: bool,
    pub be_done: bool,
    pub trail_sl: f64,
    pub opened_at: i64,
    pub closed_at: Option<i64>,
    pub status: String,      // open / closed
    pub close_price: Option<f64>,
    pub pnl: f64,
    pub note: String,
    pub tp1_lot: f64,
    pub tp2_lot: f64,
    pub trail_active: bool,
    /// 归属策略 id（旧账本无此字段，缺省空串）
    #[serde(default)]
    pub strategy_id: String,
    /// 归属策略名称快照（策略改名/删除后日志仍可读）
    #[serde(default)]
    pub strategy_name: String,
    /// 开仓手数快照：平仓后 lot 归零，日志按此显示手数
    #[serde(default)]
    pub opened_lot: f64,
}

/// 解析开仓归属策略：给了且策略库里有，就用它；否则落到当前生效策略。
/// 返回 (id, name)；策略库为空时返回空串（不编造）。
pub fn resolve_strategy(s: &Settings, given: &str) -> (String, String) {
    let g = given.trim();
    if !g.is_empty() {
        if let Some(st) = s.strategies.iter().find(|x| x.id == g) {
            return (st.id.clone(), st.name.clone());
        }
    }
    if s.strategies.is_empty() {
        return (String::new(), String::new());
    }
    let a = s.active();
    (a.id, a.name)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ledger {
    pub positions: Vec<Position>,
    pub equity: f64,
    pub balance: f64,
    pub day: String,
    pub daily_count: u32,
    pub daily_pnl: f64,
}

impl Ledger {
    pub fn new() -> Self {
        Ledger {
            positions: Vec::new(),
            equity: 10000.0,
            balance: 10000.0,
            day: String::new(),
            daily_count: 0,
            daily_pnl: 0.0,
        }
    }

    pub fn load(s: &Settings) -> Self {
        let p: PathBuf = Settings::data_dir().join("portfolio.json");
        if let Ok(txt) = fs::read_to_string(p) {
            if let Ok(mut l) = serde_json::from_str::<Ledger>(&txt) {
                l.roll_day();
                l.equity = l.balance + l.floating();
                return l;
            }
        }
        let mut l = Ledger::new();
        l.equity = s.equity;
        l.balance = s.equity;
        l
    }

    pub fn save(&self) -> std::io::Result<()> {
        let dir = Settings::data_dir();
        fs::create_dir_all(&dir)?;
        let txt = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(dir.join("portfolio.json"), txt)
    }

    /// 跨日则清零日内计数
    pub fn roll_day(&mut self) {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        if self.day != today {
            self.day = today;
            self.daily_count = 0;
            self.daily_pnl = 0.0;
        }
    }

    /// 手动重置日内计数与盈亏。
    /// 跨日会自动归零，但调参测试时经常一天内反复开仓，需要手动清。
    pub fn reset_daily(&mut self) {
        self.day = chrono::Local::now().format("%Y-%m-%d").to_string();
        self.daily_count = 0;
        self.daily_pnl = 0.0;
    }

    /// 浮动盈亏合计
    pub fn floating(&self) -> f64 {
        self.positions
            .iter()
            .filter(|p| p.status == "open")
            .map(|p| self.pnl_of(p, p.current))
            .sum()
    }

    pub fn pnl_of(&self, p: &Position, price: f64) -> f64 {
        let diff = if p.direction == "long" {
            price - p.entry
        } else {
            p.entry - price
        };
        diff * p.lot * self.contract_size()
    }

    pub fn contract_size(&self) -> f64 {
        // 与配置一致；账本独立运行时用默认值
        100.0
    }

    pub fn open_positions(&self) -> Vec<&Position> {
        self.positions.iter().filter(|p| p.status == "open").collect()
    }

    pub fn closed_positions(&self) -> Vec<&Position> {
        self.positions.iter().filter(|p| p.status == "closed").collect()
    }

    /// 开仓
    pub fn open(&mut self, p: Position) {
        self.daily_count += 1;
        self.positions.push(p);
        self.equity = self.balance + self.floating();
        let _ = self.save();
    }

    /// 更新持仓行情价并检查 TP / 止损
    pub fn tick(&mut self, price: f64, s: &Settings) -> Vec<String> {
        self.roll_day();
        let mut events = Vec::new();
        let contract = s.contract_size;
        let point_value = s.point_value;

        let atr_est = self.atr_est(s);
        let cs = contract;
        let pv = point_value;

        let mut closed_pnl = 0.0f64;

        for i in 0..self.positions.len() {
            if self.positions[i].status != "open" {
                continue;
            }
            self.positions[i].current = price;

            let p = self.positions[i].clone();
            let is_long = p.direction == "long";
            let hit_tp1 = if is_long { price >= p.tp1 } else { price <= p.tp1 };
            let hit_tp2 = if is_long { price >= p.tp2 } else { price <= p.tp2 };
            let hit_sl = if is_long { price <= p.trail_sl } else { price >= p.trail_sl };

            // TP1 部分止盈
            if hit_tp1 && !p.tp1_done {
                let lot = p.tp1_lot.min(p.lot);
                let pnl = (if is_long { p.tp1 - p.entry } else { p.entry - p.tp1 }) * lot * cs;
                closed_pnl += pnl;
                self.positions[i].lot = (p.lot - lot).max(0.0);
                self.positions[i].tp1_done = true;
                events.push(format!("TP1 触发 {:.2} 平 {:.2} 手，盈亏 {:+.2}", p.tp1, lot, pnl));
                // 止损上移到位（保本 + 锁定）
                let lock = p.entry + if is_long { s.exit.be_lock_points * pv } else { -s.exit.be_lock_points * pv };
                let new_sl = if is_long { lock.max(p.sl) } else { lock.min(p.sl) };
                self.positions[i].trail_sl = new_sl;
                self.positions[i].be_done = true;
                self.positions[i].tp1_lot = 0.0;
            }

            // TP2 部分止盈 + 启动 ATR 移动止损
            if hit_tp2 && !self.positions[i].tp2_done && !self.positions[i].tp1_done {
                let lot = self.positions[i].tp2_lot.min(self.positions[i].lot);
                let pnl = (if is_long { p.tp2 - p.entry } else { p.entry - p.tp2 }) * lot * cs;
                closed_pnl += pnl;
                self.positions[i].lot = (self.positions[i].lot - lot).max(0.0);
                self.positions[i].tp2_done = true;
                self.positions[i].tp2_lot = 0.0;
                self.positions[i].trail_active = true;
                events.push(format!("TP2 触发 {:.2} 平 {:.2} 手，盈亏 {:+.2}", p.tp2, lot, pnl));
            }

            // ATR 移动止损
            if self.positions[i].trail_active && atr_est > 0.0 {
                let dist = atr_est * s.exit.trail_atr_mult;
                let trail = if is_long { price - dist } else { price + dist };
                let cur_sl = self.positions[i].trail_sl;
                let better = if is_long { trail > cur_sl } else { trail < cur_sl };
                if better {
                    self.positions[i].trail_sl = trail;
                }
            }

            // 止损平仓
            if hit_sl {
                let lot = self.positions[i].lot;
                let pnl = (if is_long { p.trail_sl - p.entry } else { p.entry - p.trail_sl }) * lot * cs;
                closed_pnl += pnl;
                self.positions[i].lot = 0.0;
                self.positions[i].status = "closed".into();
                self.positions[i].closed_at = Some(now_ts());
                self.positions[i].close_price = Some(p.trail_sl);
                self.positions[i].pnl = closed_pnl;
                events.push(format!("止损 {:.2} 平仓，累计 {:+.2}", p.trail_sl, pnl));
            }
        }

        if closed_pnl != 0.0 {
            self.balance += closed_pnl;
            self.daily_pnl += closed_pnl;
        }
        self.equity = self.balance + self.floating();
        let _ = self.save();
        events
    }

    /// 用当前行情估算 ATR（简化：用最近持仓价格波动近似）
    fn atr_est(&self, _s: &Settings) -> f64 {
        // 无 K 线时用固定基准，避免移动止损抖动
        2.0
    }

    pub fn close(&mut self, id: &str, price: f64, s: &Settings) -> Result<String, String> {
        let i = self.positions.iter().position(|p| p.id == id && p.status == "open");
        let i = match i {
            Some(v) => v,
            None => return Err("持仓不存在或已平仓".into()),
        };
        let p = self.positions[i].clone();
        let pnl = (if p.direction == "long" { price - p.entry } else { p.entry - price })
            * p.lot
            * s.contract_size;
        self.positions[i].lot = 0.0;
        self.positions[i].status = "closed".into();
        self.positions[i].closed_at = Some(now_ts());
        self.positions[i].close_price = Some(price);
        self.positions[i].pnl = pnl;
        self.balance += pnl;
        self.daily_pnl += pnl;
        self.equity = self.balance + self.floating();
        let _ = self.save();
        Ok(format!("手动平仓 {:.2}，盈亏 {:+.2}", price, pnl))
    }

    /// 平掉指定比例（TP 手动触发用）
    pub fn close_partial(&mut self, id: &str, pct: f64, price: f64, s: &Settings) -> Result<String, String> {
        let i = self.positions.iter().position(|p| p.id == id && p.status == "open");
        let i = match i {
            Some(v) => v,
            None => return Err("持仓不存在或已平仓".into()),
        };
        let p = self.positions[i].clone();
        let lot = crate::risk::round_step(p.lot * pct / 100.0, s.risk.lot_step);
        if lot <= 0.0 {
            return Err("计算手数为 0".into());
        }
        let pnl = (if p.direction == "long" { price - p.entry } else { p.entry - price })
            * lot
            * s.contract_size;
        self.positions[i].lot = (p.lot - lot).max(0.0);
        self.balance += pnl;
        self.daily_pnl += pnl;
        if self.positions[i].lot <= 0.001 {
            self.positions[i].status = "closed".into();
            self.positions[i].closed_at = Some(now_ts());
            self.positions[i].close_price = Some(price);
        }
        self.equity = self.balance + self.floating();
        let _ = self.save();
        Ok(format!("减仓 {:.0}%（{:.2} 手）于 {:.2}，盈亏 {:+.2}", pct, lot, price, pnl))
    }

    /// 调整止损
    pub fn set_sl(&mut self, id: &str, sl: f64) -> Result<String, String> {
        let i = self.positions.iter().position(|p| p.id == id && p.status == "open");
        match i {
            Some(v) => {
                self.positions[v].trail_sl = sl;
                let _ = self.save();
                Ok(format!("止损改为 {:.2}", sl))
            }
            None => Err("持仓不存在".into()),
        }
    }

    /// 统计
    pub fn stats(&self) -> Stats {
        let closed: Vec<&Position> = self.closed_positions().into_iter().filter(|p| p.pnl != 0.0).collect();
        let wins = closed.iter().filter(|p| p.pnl > 0.0).count();
        let losses = closed.iter().filter(|p| p.pnl < 0.0).count();
        let total = closed.len();
        let gross_win: f64 = closed.iter().filter(|p| p.pnl > 0.0).map(|p| p.pnl).sum();
        let gross_loss: f64 = closed.iter().filter(|p| p.pnl < 0.0).map(|p| p.pnl).sum();
        let net: f64 = closed.iter().map(|p| p.pnl).sum();
        let avg_win = if wins > 0 { gross_win / wins as f64 } else { 0.0 };
        let avg_loss = if losses > 0 { gross_loss / losses as f64 } else { 0.0 };
        // 盈亏因子：无亏损笔时比值在数学上不成立。旧实现退回总盈利额，单笔纯赚也显示 1.0，
        // 与复盘直觉打架；改 Option——无亏损笔 → None（JSON null，前端显示 ∞），
        // 有亏损无盈利 → Some(0.0)，正常 → 比值（abs 顺带压掉 -0.0）。
        let pf = if gross_loss < 0.0 {
            Some((gross_win / -gross_loss).abs())
        } else {
            None
        };

        Stats {
            total_closed: total,
            wins: wins as u32,
            losses: losses as u32,
            win_rate: if total > 0 { wins as f64 / total as f64 * 100.0 } else { 0.0 },
            net_pnl: net,
            gross_profit: gross_win,
            gross_loss,
            avg_win,
            avg_loss,
            profit_factor: pf,
            open_count: self.open_positions().len() as u32,
            floating: self.floating(),
            equity: self.equity,
            balance: self.balance,
            daily_pnl: self.daily_pnl,
            daily_count: self.daily_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total_closed: usize,
    pub wins: u32,
    pub losses: u32,
    pub win_rate: f64,
    pub net_pnl: f64,
    pub gross_profit: f64,
    pub gross_loss: f64,
    pub avg_win: f64,
    pub avg_loss: f64,
    /// 盈亏因子：无亏损笔时为 null（前端显示 ∞）；有亏损无盈利为 0.0
    pub profit_factor: Option<f64>,
    pub open_count: u32,
    pub floating: f64,
    pub equity: f64,
    pub balance: f64,
    pub daily_pnl: f64,
    pub daily_count: u32,
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn uid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一条开仓记录：归属参数由外部给定，便于验证落位
    fn mk_pos(strategy_id: &str, strategy_name: &str) -> Position {
        Position {
            id: uid(),
            symbol: "XAU".into(),
            direction: "long".into(),
            lot: 0.05,
            entry: 2400.0,
            sl: 2390.0,
            tp1: 2420.0,
            tp2: 2440.0,
            current: 2400.0,
            tp1_done: false,
            tp2_done: false,
            be_done: false,
            trail_sl: 2390.0,
            opened_at: now_ts(),
            closed_at: None,
            status: "open".into(),
            close_price: None,
            pnl: 0.0,
            note: String::new(),
            tp1_lot: 0.025,
            tp2_lot: 0.02,
            trail_active: false,
            strategy_id: strategy_id.into(),
            strategy_name: strategy_name.into(),
            opened_lot: 0.05,
        }
    }

    /// ① 开仓带 strategy_id：按 id 从策略库取名称并落位（序列化后仍在）
    #[test]
    fn test_open_carries_given_strategy() {
        let s = Settings::default();
        let (sid, sname) = resolve_strategy(&s, "breakout");
        assert_eq!(sid, "breakout");
        assert_eq!(sname, "区间突破");

        let p = mk_pos(&sid, &sname);
        let txt = serde_json::to_string(&p).unwrap();
        let back: Position = serde_json::from_str(&txt).unwrap();
        assert_eq!(back.strategy_id, "breakout");
        assert_eq!(back.strategy_name, "区间突破");
        assert_eq!(back.opened_lot, 0.05);
    }

    /// ② 不给 strategy_id（或给未知 id）时落到当前生效策略
    #[test]
    fn test_open_falls_back_to_active_strategy() {
        let mut s = Settings::default();
        s.active_strategy = "breakout".into();

        let (sid, sname) = resolve_strategy(&s, "");
        assert_eq!((sid.as_str(), sname.as_str()), ("breakout", "区间突破"));

        let (sid2, _) = resolve_strategy(&s, "   ");
        assert_eq!(sid2, "breakout");

        // 未知 id 不编造，退回生效策略
        let (sid3, sname3) = resolve_strategy(&s, "no_such_strategy");
        assert_eq!(sid3, "breakout");
        assert_eq!(sname3, "区间突破");
    }

    /// ③ 旧 portfolio.json（无策略字段）可读，缺省空串/零值
    #[test]
    fn test_legacy_position_json_loads() {
        let txt = r#"{
            "id": "abc", "symbol": "XAU", "direction": "short", "lot": 0.0,
            "entry": 2400.0, "sl": 2410.0, "tp1": 2380.0, "tp2": 2360.0,
            "current": 2390.0, "tp1_done": true, "tp2_done": false, "be_done": true,
            "trail_sl": 2395.0, "opened_at": 1700000000, "closed_at": 1700003600,
            "status": "closed", "close_price": 2390.0, "pnl": 5.0, "note": "",
            "tp1_lot": 0.0, "tp2_lot": 0.0, "trail_active": false
        }"#;
        let p: Position = serde_json::from_str(txt).unwrap();
        assert_eq!(p.status, "closed");
        assert_eq!(p.strategy_id, "");
        assert_eq!(p.strategy_name, "");
        assert_eq!(p.opened_lot, 0.0);
    }

    /// ④ 盈亏因子口径：无亏损笔 → None / JSON null；有亏损无盈利 → 0.0；正常 → 比值
    #[test]
    fn test_profit_factor_none_without_losing_trades() {
        let mut l = Ledger::new();
        let closed = |pnl: f64| Position {
            status: "closed".into(),
            close_price: Some(2400.0),
            closed_at: Some(now_ts()),
            pnl,
            ..mk_pos("trend_pullback", "回调趋势")
        };

        // 单笔纯赚：旧实现给 1.0，现在必须是 null（无亏损笔，比值不成立）
        l.positions = vec![closed(30.0)];
        let st = l.stats();
        assert_eq!(st.wins, 1);
        assert_eq!(st.losses, 0);
        assert!(st.profit_factor.is_none());
        // 序列化后就是 JSON null，前端据此显示 ∞
        let j = serde_json::to_value(&st).unwrap();
        assert!(j["profit_factor"].is_null());

        // 有亏损无盈利：0.0（不是 -0.0）
        l.positions = vec![closed(-20.0)];
        let st = l.stats();
        assert_eq!(st.losses, 1);
        assert_eq!(st.profit_factor, Some(0.0));
        assert!(st.profit_factor.unwrap().is_sign_positive(), "赔率不该是 -0.0");

        // 盈亏并存：正常比值 30 / 20 = 1.5
        l.positions = vec![closed(30.0), closed(-20.0)];
        assert_eq!(l.stats().profit_factor, Some(1.5));

        // 无成交（pnl 为 0 的记录不计入）：同样是 null，前端按「无成交」展示
        l.positions = vec![closed(0.0)];
        assert!(l.stats().profit_factor.is_none());
    }
}