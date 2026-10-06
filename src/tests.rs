//! 核心算法单元测试：指标、策略、风控
//! 运行：cargo test

use crate::data::Bar;
use crate::indicators as ind;
use crate::risk;

/// 造一段可控的 K 线
fn mk(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let o = if i == 0 { *c } else { closes[i - 1] };
            Bar {
                t: 1700000000 + (i as i64) * 300,
                o,
                h: o.max(*c) + 1.0,
                l: o.min(*c) - 1.0,
                c: *c,
                v: 100.0,
            }
        })
        .collect()
}

#[test]
fn test_sma_and_ema() {
    let bars = mk(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    let s = ind::sma(&bars, 3);
    assert_eq!(s[0], None);
    assert_eq!(s[1], None);
    assert!((s[2].unwrap() - 2.0).abs() < 1e-9);
    assert!((s[5].unwrap() - 5.0).abs() < 1e-9);

    let e = ind::ema(&bars, 3);
    assert_eq!(e[1], None);
    // 首值是前3根均值
    assert!((e[2].unwrap() - 2.0).abs() < 1e-9);
    // 单调上涨，EMA 收敛但低于最新价
    assert!(e[5].unwrap() < bars[5].c);
    // 递推校验：k=0.5。种子 = (1+2+3)/3 = 2
    //   i=3: 4*0.5 + 2*0.5 = 3
    //   i=4: 5*0.5 + 3*0.5 = 4
    //   i=5: 6*0.5 + 4*0.5 = 5
    assert!((e[5].unwrap() - 5.0).abs() < 1e-9, "EMA 递推值应为 5.0，实际 {}", e[5].unwrap());
}

#[test]
fn test_rsi_bounds() {
    let mut closes: Vec<f64> = (0..60).map(|i| 100.0 + i as f64 * 0.5).collect();
    let bars = mk(&closes);
    let r = ind::rsi(&bars, 14);
    // 单调上涨，RSI 应接近 100
    assert!(r[59].unwrap() > 95.0);

    // 单调下跌，RSI 应接近 0
    closes = (0..60).map(|i| 200.0 - i as f64 * 0.5).collect();
    let bars2 = mk(&closes);
    let r2 = ind::rsi(&bars2, 14);
    assert!(r2[59].unwrap() < 5.0);
}

#[test]
fn test_atr_positive() {
    let bars = mk(&[100.0, 102.0, 101.0, 103.0, 104.0, 102.0, 105.0, 106.0,
                    104.0, 107.0, 108.0, 106.0, 109.0, 110.0, 108.0, 111.0]);
    let a = ind::atr(&bars, 14);
    assert_eq!(a[13], None);
    assert!(a[15].unwrap() > 0.0);
}

#[test]
fn test_engulf_patterns() {
    // 阴线后阳线包住
    let bars = vec![
        Bar { t: 1, o: 100.0, h: 100.5, l: 99.0, c: 99.5, v: 0.0 }, // 阴
        Bar { t: 2, o: 99.0,  h: 101.5, l: 98.8, c: 101.0, v: 0.0 }, // 阳，包住前阴
    ];
    assert!(ind::bullish_engulf(&bars, 1));
    assert!(!ind::bearish_engulf(&bars, 1));

    // 反向：阳线后阴线，实体完整包住前阳
    let bars2 = vec![
        Bar { t: 1, o: 99.0,  h: 101.0, l: 99.0, c: 100.0, v: 0.0 }, // 阳 body=[99,100]
        Bar { t: 2, o: 100.2, h: 100.5, l: 97.5, c: 98.0,  v: 0.0 }, // 阴 body=[98,100.2] 包住
    ];
    assert!(ind::bearish_engulf(&bars2, 1));
    assert!(!ind::bullish_engulf(&bars2, 1));

    // 不构成包住
    let bars3 = vec![
        Bar { t: 1, o: 100.0, h: 100.5, l: 99.0, c: 99.5, v: 0.0 },
        Bar { t: 2, o: 99.6,  h: 99.9, l: 99.4, c: 99.7, v: 0.0 }, // 实体未包住
    ];
    assert!(!ind::bullish_engulf(&bars3, 1));
}

#[test]
fn test_trend_direction() {
    // 上行
    let up = mk(&(0..80).map(|i| 100.0 + i as f64).collect::<Vec<_>>());
    let ema = ind::ema(&up, 20);
    let t = ind::trend(&up, &ema, up.len() - 1);
    assert_eq!(t.dir, 1, "上行趋势应判为多头");

    // 下行
    let down = mk(&(0..80).map(|i| 200.0 - i as f64).collect::<Vec<_>>());
    let ema2 = ind::ema(&down, 20);
    let t2 = ind::trend(&down, &ema2, down.len() - 1);
    assert_eq!(t2.dir, -1, "下行趋势应判为空头");
}

#[test]
fn test_swing_extremes() {
    let bars = mk(&[10.0, 20.0, 15.0, 30.0, 25.0]);
    // 最近3根(索引2..4)的最低价 = min(14, 29, 24) = 14
    assert!((ind::swing_low(&bars, 4, 3) - 14.0).abs() < 1e-9);
    // 最近3根的最高价 = max(31, 26, ...) 需要按 high 算
    assert!(ind::swing_high(&bars, 4, 3) >= 24.0);
}

#[test]
fn test_risk_lot_calculation() {
    let mut s = crate::config::Settings::default();
    s.equity = 10000.0;
    s.point_value = 0.01;
    s.contract_size = 100.0;
    s.risk.min_lot = 0.01;
    s.risk.max_lot = 5.0;
    s.risk.lot_step = 0.01;

    // 风险预算 = 10000 * 1% = 100 美元
    // 止损 100 点 = 1 美元/盎司 × 100 盎司 = 100 美元/手
    // 手数应为 1.0
    let lot = risk::calc_lot(10000.0, 1.0, 100.0, &s);
    assert!((lot - 1.0).abs() < 0.02, "止损100点应给1手，实际 {}", lot);

    // 止损 50 点 → 2 手
    let lot2 = risk::calc_lot(10000.0, 1.0, 50.0, &s);
    assert!((lot2 - 2.0).abs() < 0.02, "止损50点应给2手，实际 {}", lot2);

    // 止损 500 点 → 0.2 手
    let lot3 = risk::calc_lot(10000.0, 1.0, 500.0, &s);
    assert!((lot3 - 0.2).abs() < 0.02, "止损500点应给0.2手，实际 {}", lot3);

    // 极窄止损应被 max_lot 截断
    let lot4 = risk::calc_lot(10000.0, 1.0, 1.0, &s);
    assert!(lot4 <= s.risk.max_lot, "手数不应超过上限");
}

#[test]
fn test_risk_gates() {
    let mut s = crate::config::Settings::default();
    s.risk.max_spread_points = 35.0;
    s.risk.max_daily_trades = 6;
    s.risk.min_sl_points = 50.0;
    s.risk.max_sl_points = 800.0;
    s.risk.session_start = "00:00".into();
    s.risk.session_end = "23:59".into();
    s.risk.event_block = true;
    s.strategy.rr_min = 1.8;
    s.spread_points = 20.0;

    // 全部通过
    let g = risk::gate_check(
        risk::GateInput {
            direction: "long", sl_points: 100.0, tp_points: 200.0,
            lot: 0.1, daily_count: 0, daily_pnl: 0.0, near_event: false,
        },
        &s,
    );
    assert!(g.ok, "正常条件应通过：{:?}", g.blocks);

    // 盈亏比不足
    let g2 = risk::gate_check(
        risk::GateInput {
            direction: "long", sl_points: 100.0, tp_points: 100.0,
            lot: 0.1, daily_count: 0, daily_pnl: 0.0, near_event: false,
        },
        &s,
    );
    assert!(!g2.ok, "盈亏比1.0应被拦截");

    // 日内超限
    let g3 = risk::gate_check(
        risk::GateInput {
            direction: "long", sl_points: 100.0, tp_points: 200.0,
            lot: 0.1, daily_count: 6, daily_pnl: 0.0, near_event: false,
        },
        &s,
    );
    assert!(!g3.ok, "日内第7单应被拦截");

    // 事件封锁
    let g4 = risk::gate_check(
        risk::GateInput {
            direction: "long", sl_points: 100.0, tp_points: 200.0,
            lot: 0.1, daily_count: 0, daily_pnl: 0.0, near_event: true,
        },
        &s,
    );
    assert!(!g4.ok, "事件封锁期应被拦截");

    // 止损过窄
    let g5 = risk::gate_check(
        risk::GateInput {
            direction: "long", sl_points: 20.0, tp_points: 100.0,
            lot: 0.1, daily_count: 0, daily_pnl: 0.0, near_event: false,
        },
        &s,
    );
    assert!(!g5.ok, "止损20点低于下限应被拦截");
}

#[test]
fn test_spread_gate() {
    let mut s = crate::config::Settings::default();
    s.risk.max_spread_points = 35.0;
    s.spread_points = 50.0;
    s.risk.session_start = "00:00".into();
    s.risk.session_end = "23:59".into();

    let g = risk::gate_check(
        risk::GateInput {
            direction: "long", sl_points: 100.0, tp_points: 200.0,
            lot: 0.1, daily_count: 0, daily_pnl: 0.0, near_event: false,
        },
        &s,
    );
    assert!(!g.ok, "点差超限应被拦截");
    assert!(g.blocks.iter().any(|b| b.contains("点差")));
}

#[test]
fn test_daily_loss_budget_gate() {
    let run = |pct: f64, pnl: f64| {
        let mut s = crate::config::Settings::default();
        s.equity = 10_000.0;
        s.spread_points = 20.0;
        s.risk.session_start = "00:00".into();
        s.risk.session_end = "23:59".into();
        s.risk.event_block = false;
        s.risk.daily_loss_budget_pct = pct;
        risk::gate_check(
            risk::GateInput {
                direction: "long", sl_points: 100.0, tp_points: 200.0,
                lot: 0.1, daily_count: 0, daily_pnl: pnl, near_event: false,
            },
            &s,
        )
    };

    // ① 亏损达预算（10000 × 2% = 200）即拒绝
    let hit = run(2.0, -200.0);
    assert!(!hit.ok, "亏损达预算应被拦截");
    assert!(
        hit.blocks.iter().any(|b| b.contains("今日亏损已达预算")),
        "拦截文案应说明预算：{:?}",
        hit.blocks
    );

    // ② 未达预算放行
    let safe = run(2.0, -199.9);
    assert!(safe.ok, "未达预算不该被拦：{:?}", safe.blocks);

    // ③ 0 = 关闭，亏多少都不拦
    let off = run(0.0, -9_999.0);
    assert!(off.ok, "预算为 0 时该闸应完全跳过：{:?}", off.blocks);

    // ④ 旧 settings.json 无该字段时，serde 默认补 2.0
    let mut v = serde_json::to_value(crate::config::Settings::default()).unwrap();
    v["risk"]
        .as_object_mut()
        .unwrap()
        .remove("daily_loss_budget_pct");
    let old: crate::config::Settings = serde_json::from_value(v).unwrap();
    assert_eq!(old.risk.daily_loss_budget_pct, 2.0);
}

#[test]
fn test_plan_structure() {
    let mut s = crate::config::Settings::default();
    s.equity = 10000.0;
    s.strategy.rr_min = 1.8;
    s.strategy.risk_percent = 1.0;

    let p = risk::plan("long", 4140.0, 4139.0, &s);
    assert_eq!(p.direction, "long");
    assert!((p.sl_points - 100.0).abs() < 1e-6, "止损应为100点，实际 {}", p.sl_points);
    assert!(p.tp_points >= p.sl_points * 1.8, "目标应达到最低盈亏比");
    assert!(p.lot > 0.0);
    assert!(p.risk_money > 0.0);

    // 空头方向对称
    let ps = risk::plan("short", 4140.0, 4141.0, &s);
    assert!(ps.tp_price < 4140.0, "空头目标应低于入场价");
    assert!((ps.sl_points - 100.0).abs() < 1e-6);
}

#[test]
fn test_strategy_no_signal_on_weak_conditions() {
    let mut s = crate::config::Settings::default();
    s.strategy.enabled = true;
    s.strategy.allow_long = true;
    s.strategy.allow_short = false;
    s.exec_interval = "5m".into();
    s.dir_interval = "1h".into();
    s.confirm_interval = "15m".into();

    // 构造明确的下行趋势，且不给做空 → 应无信号
    let down = mk(&(0..80).map(|i| 200.0 - i as f64).collect::<Vec<_>>());
    let sig = crate::strategy::evaluate(
        crate::strategy::Input {
            dir_bars: &down,
            exec_bars: &down,
            conf_bars: &down,
            strategy: None,
        },
        &s,
    );
    assert!(!sig.ok, "下行趋势 + 禁用做空，不应产生信号");
    assert!(sig.blockers > 0);
}

#[test]
fn test_strategy_insufficient_data() {
    let s = crate::config::Settings::default();
    let tiny = mk(&[100.0, 101.0]);
    let sig = crate::strategy::evaluate(
        crate::strategy::Input {
            dir_bars: &tiny,
            exec_bars: &tiny,
            conf_bars: &tiny,
            strategy: None,
        },
        &s,
    );
    assert!(!sig.ok);
    assert!(sig.reasons.iter().any(|r| r.text.contains("数据不足")));
}

#[test]
fn test_pnl_formula() {
    let s = crate::config::Settings::default();
    // 多头 0.1 手，涨 1 美元/盎司，合约 100 盎司 → +10 美元
    let p = risk::pnl("long", 4140.0, 4141.0, 0.1, &s);
    assert!((p - 10.0).abs() < 1e-6, "多头盈利应为10美元，实际 {}", p);

    // 空头反向
    let p2 = risk::pnl("short", 4140.0, 4141.0, 0.1, &s);
    assert!((p2 + 10.0).abs() < 1e-6, "空头应亏10美元，实际 {}", p2);

    // 平价
    assert!(risk::pnl("long", 4140.0, 4140.0, 0.5, &s).abs() < 1e-9);
}

#[test]
fn test_round_step() {
    assert!((risk::round_step(0.1234, 0.01) - 0.12).abs() < 1e-9);
    assert!((risk::round_step(0.126, 0.01) - 0.13).abs() < 1e-9);
    assert!((risk::round_step(1.7, 0.5) - 1.5).abs() < 1e-9);
}

#[test]
fn test_rr_gate_tolerates_float_error() {
    let mut s = crate::config::Settings::default();
    s.strategy.rr_min = 1.8;
    s.risk.max_spread_points = 35.0;
    s.risk.session_start = "00:00".into();
    s.risk.session_end = "23:59".into();
    s.risk.event_block = false;

    // 复现真实场景：入场 4141.80、止损 4140.30、目标 4144.50。
    // 关键在于 4144.50 - 4141.80 在 f64 下是 2.6999999999999818，
    // 除以 150 点得 1.7999999999998788，严格小于 1.8，会被误判为不达标。
    let sl_points = ((4141.80f64 - 4140.30f64) / s.point_value).abs();
    let tp_points = ((4144.50f64 - 4141.80f64) / s.point_value).abs();
    let rr = tp_points / sl_points;
    assert!(
        rr < 1.8,
        "前提不成立：{}/{} = {} 不应小于 1.8",
        tp_points,
        sl_points,
        rr
    );

    let g = crate::risk::gate_check(
        crate::risk::GateInput {
            direction: "long",
            sl_points,
            tp_points,
            lot: 0.05,
            daily_count: 0,
            daily_pnl: 0.0,
            near_event: false,
        },
        &s,
    );
    assert!(
        g.ok,
        "按 1.8 填的目标价不该被浮点误差拦下：{:?}",
        g.blocks
    );

    // 真正低于下限时仍要拦
    let g2 = crate::risk::gate_check(
        crate::risk::GateInput {
            direction: "long",
            sl_points: 150.0,
            tp_points: 260.0, // 1.733，确实不够
            lot: 0.05,
            daily_count: 0,
            daily_pnl: 0.0,
            near_event: false,
        },
        &s,
    );
    assert!(!g2.ok, "盈亏比 1.73 必须被拦截");
}

// ---------- AI 分析引擎 ----------

fn mk_verdict(dir: &str, entry: f64, sl: f64, tp: f64, conf: f64) -> crate::enhance::Verdict {
    crate::enhance::Verdict {
        direction: dir.into(),
        entry, sl, tp,
        confidence: conf,
        reasons: vec!["测试".into()],
        warnings: vec![],
        sentiment: 50.0,
        bias: "neutral".into(),
        gauge: 0.0,
        style_tag: String::new(),
        summary: String::new(),
        modules: vec![],
        plans: vec![],
    }
}

#[test]
fn test_behavior_discipline_in_prompts() {
    let st = crate::config::Strategy::new("t", "趋势回踩", "示例策略");
    let judge_p = crate::enhance::system_prompt(&st, "顺 H4 做多", 6);
    let chat_p = crate::ai::system_prompt(&st, "顺 H4 做多", 1.8, 6);
    for (name, p) in [("enhance", &judge_p), ("ai", &chat_p)] {
        assert!(p.contains("【行为纪律】"), "{} prompt 缺行为纪律段", name);
        assert!(p.contains("不迎合用户情绪"), "{} prompt 缺风险优先条款", name);
        assert!(p.contains("先复述当前风控事实"), "{} prompt 缺冲动拦截条款", name);
    }
}

#[test]
fn test_extract_json_variants() {
    // 直接 JSON
    let a = r#"{"direction":"long","entry":4140.0,"sl":4139.0,"tp":4143.0,"confidence":70,"reasons":["a"],"warnings":[]}"#;
    assert!(crate::enhance::extract_json(a).is_some(), "直接 JSON 应可解析");

    // 新增结构化字段（仪表盘/四模块/多空方案）完整解析
    let full = r#"{"direction":"long","entry":4174.2,"sl":4166.5,"tp":4184.5,"confidence":62,
      "bias":"long","sentiment":26,"style_tag":"激进剥头皮","summary":"偏多，回踩 4172-4176 分批",
      "reasons":["a"],"warnings":["w"],
      "modules":[{"name":"走势环境","status":"趋势运行","detail":"均线多头"}],
      "plans":[{"side":"long","style":"逢低做多","trigger":"回踩吞没","entry":"4172.0-4176.5",
        "entry_mid":4174.2,"sl":4166.5,"sl_note":"结构外侧","tp1":4184.5,"tp1_note":"前高",
        "tp2":4195.0,"tp2_note":"上轨","rr1":2.0,"rr2":3.7,"hold":"短线"}]}"#;
    let v = crate::enhance::extract_json(full).expect("新结构应可解析");
    assert_eq!(v.bias, "long");
    assert_eq!(v.sentiment, 26.0);
    assert_eq!(v.gauge, 0.0);
    assert_eq!(v.modules.len(), 1);
    assert_eq!(v.plans.len(), 1);
    assert_eq!(v.plans[0].entry_mid, 4174.2);
    assert_eq!(v.plans[0].rr2, 3.7);

    // 旧格式（无新字段）仍须解析——serde default 兜底
    let v2 = crate::enhance::extract_json(a).expect("旧格式应兼容");
    assert!(v2.modules.is_empty() && v2.plans.is_empty() && v2.gauge == 0.0);

    // 代码块包裹
    let b = format!("```json\n{}\n```", a);
    assert!(crate::enhance::extract_json(&b).is_some(), "代码块包裹应可解析");

    // 前后有废话
    let c = format!("好的，我的判断如下：\n{}\n以上。", a);
    assert!(crate::enhance::extract_json(&c).is_some(), "带废话应能抠出 JSON");

    // 纯文本，没有 JSON
    assert!(crate::enhance::extract_json("我觉得应该观望。").is_none(),
            "无 JSON 时应返回 None 而不是硬解析");

    // 缺字段（reasons/warnings 可省）
    let d = r#"{"direction":"none","entry":0,"sl":0,"tp":0,"confidence":10}"#;
    assert!(crate::enhance::extract_json(d).is_some(), "可选字段缺失应容忍");

    // 输出被 max_tokens 截断：少了收尾括号，应能救回
    let truncated = r#"{"direction":"none","entry":0,"sl":0,"tp":0,"confidence":25,"reasons":["a","b"],"warnings":["c"]"#;
    let r = crate::enhance::extract_json(truncated);
    assert!(r.is_some(), "截断的 JSON 应能补齐后解析");
    if let Some(v) = r {
        assert_eq!(v.direction, "none");
        assert_eq!(v.reasons.len(), 2);
        assert_eq!(v.warnings.len(), 1);
    }

    // 截断在数组中间
    let cut = r#"{"direction":"long","entry":4140.0,"sl":4139.0,"tp":4142.0,"confidence":70,"reasons":["a","b"],"warn"#;
    assert!(crate::enhance::extract_json(cut).is_none(),
            "字段名都断了，救不回来是合理的");
}

#[test]
fn test_extract_json_ignores_braces_in_strings() {
    // 理由里带大括号，不能被当成 JSON 结构
    let s = r#"{"direction":"none","entry":0,"sl":0,"tp":0,"confidence":5,"reasons":["价格 {x} 已破位"],"warnings":[]}"#;
    let v = crate::enhance::extract_json(s).expect("字符串里的花括号不应干扰解析");
    assert_eq!(v.reasons[0], "价格 {x} 已破位");
}

#[test]
fn test_judge_allows_good_verdict() {
    let mut s = crate::config::Settings::default();
    s.equity = 10000.0;
    s.risk.max_daily_trades = 6;
    s.risk.max_spread_points = 35.0;
    s.risk.event_block = false;
    s.strategy.confidence_floor = 44.0;
    s.strategy.rr_min = 1.8;
    s.spread_points = 20.0;

    // 止损 1 美元（100 点），目标 1.8 美元（180 点），盈亏比达标
    let v = mk_verdict("long", 4140.0, 4139.0, 4141.8, 70.0);
    let r = crate::enhance::judge(&v, &s, 0, 0.0);
    assert!(r.allowed, "条件齐备应放行：{:?}", r.blocks);
    assert!(r.lot > 0.0, "应算出手数");
    assert!(r.rr >= 1.79, "盈亏比应达标，实际 {}", r.rr);
}

#[test]
fn test_judge_blocks_low_rr() {
    let mut s = crate::config::Settings::default();
    s.risk.max_daily_trades = 6;
    s.risk.max_spread_points = 35.0;
    s.risk.event_block = false;
    s.strategy.rr_min = 1.8;
    s.spread_points = 20.0;

    // AI 给的目标太近，盈亏比不够 —— 哪怕置信度 100 也得拦
    let v = mk_verdict("long", 4140.0, 4139.0, 4140.5, 100.0);
    let r = crate::enhance::judge(&v, &s, 0, 0.0);
    assert!(!r.allowed, "盈亏比不足必须拦截（AI 置信度再高也不行）");
    assert!(r.blocks.iter().any(|b| b.contains("盈亏比")), "原因: {:?}", r.blocks);
}

#[test]
fn test_judge_blocks_low_confidence() {
    let mut s = crate::config::Settings::default();
    s.risk.max_daily_trades = 6;
    s.risk.max_spread_points = 35.0;
    s.risk.event_block = false;
    s.strategy.rr_min = 1.0;      // 放宽盈亏比，专门测置信度
    s.strategy.confidence_floor = 60.0;
    s.spread_points = 20.0;

    let v = mk_verdict("long", 4140.0, 4139.0, 4142.0, 40.0);
    let r = crate::enhance::judge(&v, &s, 0, 0.0);
    assert!(!r.allowed, "置信度低于下限必须拦截");
    assert!(r.blocks.iter().any(|b| b.contains("置信度")), "原因: {:?}", r.blocks);
}

#[test]
fn test_judge_blocks_daily_limit() {
    let mut s = crate::config::Settings::default();
    s.risk.max_daily_trades = 6;
    s.risk.max_spread_points = 35.0;
    s.risk.event_block = false;
    s.strategy.confidence_floor = 44.0;
    s.spread_points = 20.0;

    let v = mk_verdict("long", 4140.0, 4139.0, 4142.0, 70.0);
    let r = crate::enhance::judge(&v, &s, 6, 0.0);
    assert!(!r.allowed, "日内单数已满必须拦截");
    assert!(r.blocks.iter().any(|b| b.contains("日内")), "原因: {:?}", r.blocks);
}

#[test]
fn test_judge_blocks_spread() {
    let mut s = crate::config::Settings::default();
    s.risk.max_daily_trades = 6;
    s.risk.max_spread_points = 35.0;
    s.risk.event_block = false;
    s.strategy.confidence_floor = 44.0;
    s.spread_points = 60.0;      // 点差超限

    let v = mk_verdict("long", 4140.0, 4139.0, 4142.0, 70.0);
    let r = crate::enhance::judge(&v, &s, 0, 0.0);
    assert!(!r.allowed, "点差超限必须拦截");
}

#[test]
fn test_judge_handles_none_and_missing_prices() {
    let s = crate::config::Settings::default();

    // AI 说观望
    let r1 = crate::enhance::judge(&mk_verdict("none", 0.0, 0.0, 0.0, 20.0), &s, 0, 0.0);
    assert!(!r1.allowed);
    assert!(r1.blocks[0].contains("观望"));

    // 给了方向但缺止损
    let r2 = crate::enhance::judge(&mk_verdict("long", 4140.0, 0.0, 4142.0, 70.0), &s, 0, 0.0);
    assert!(!r2.allowed);
    assert!(r2.blocks[0].contains("完整"));

    // 给了方向但缺目标
    let r3 = crate::enhance::judge(&mk_verdict("long", 4140.0, 4139.0, 0.0, 70.0), &s, 0, 0.0);
    assert!(!r3.allowed);
}

#[test]
fn test_judge_never_trusts_ai_lot() {
    // AI 只给方向与价位，JSON 里没有手数字段 —— 手数必须由代码算
    let mut s = crate::config::Settings::default();
    s.equity = 10000.0;
    s.strategy.risk_percent = 1.0;
    s.risk.max_daily_trades = 6;
    s.risk.max_spread_points = 35.0;
    s.risk.event_block = false;
    s.strategy.confidence_floor = 44.0;
    s.spread_points = 20.0;

    let v = mk_verdict("long", 4140.0, 4139.0, 4142.0, 80.0);
    let r = crate::enhance::judge(&v, &s, 0, 0.0);
    // 止损 100 点，权益 1%，应约为 1 手
    assert!((r.lot - 1.0).abs() < 0.05, "手数应由代码按权益算，实际 {}", r.lot);
    // 风险金额应约等于 100 美元
    assert!((r.risk_money - 100.0).abs() < 10.0,
            "风险金额应约 100 美元，实际 {}", r.risk_money);
}

#[test]
fn test_builtin_strategies_complete() {
    let list = crate::config::builtin_strategies();
    assert!(list.len() >= 5, "内置策略应至少有 5 条，实际 {}", list.len());

    for s in &list {
        assert!(!s.id.is_empty(), "策略缺少 id");
        assert!(!s.name.is_empty(), "策略 {} 缺少名称", s.id);
        assert!(!s.prompt.is_empty(), "策略 {} 缺少 AI 提示词", s.id);
        assert!(!s.focus.is_empty(), "策略 {} 缺少关注点", s.id);
        assert!(s.rr_min > 0.0, "策略 {} 的盈亏比必须为正", s.id);
        assert!(s.ema_period >= 2, "策略 {} 的 EMA 周期过短", s.id);
        assert!(
            s.allow_long || s.allow_short,
            "策略 {} 两个方向都禁用了，永远不会出信号",
            s.id
        );
    }

    let mut ids: Vec<_> = list.iter().map(|s| s.id.clone()).collect();
    ids.sort();
    let before = ids.len();
    ids.dedup();
    assert_eq!(before, ids.len(), "策略 id 重复");
}

#[test]
fn test_merge_builtin_strategies() {
    let mut s = crate::config::Settings::default();
    s.strategies.clear();
    s.active_strategy = "not_exist".into();
    s.merge_builtin_strategies();

    assert!(!s.strategies.is_empty(), "应补齐内置策略");
    assert_ne!(s.active_strategy, "not_exist", "失效的 active 应被修正");
    assert!(s.strategies.iter().any(|x| x.id == s.active_strategy));

    // 用户改过的提示词不能被覆盖
    let mut s2 = crate::config::Settings::default();
    s2.strategies.retain(|x| x.id == "trend_pullback");
    s2.strategies[0].prompt = "我自己写的提示词".into();
    s2.merge_builtin_strategies();
    let tp = s2.strategies.iter().find(|x| x.id == "trend_pullback").unwrap();
    assert_eq!(tp.prompt, "我自己写的提示词", "用户改过的提示词不应被覆盖");
}

#[test]
fn test_apply_strategy_overrides() {
    let s = crate::config::Settings::default();
    let mut st = crate::config::Strategy::new("t", "测试", "描述");
    st.exec_interval = "15m".into();
    st.dir_interval = "4h".into();
    st.confirm_interval = "1h".into();
    st.rr_min = 2.5;
    st.ema_period = 30;
    st.allow_short = true;

    let c = crate::strategy::apply(&s, &st);
    assert_eq!(c.exec_interval, "15m");
    assert_eq!(c.dir_interval, "4h");
    assert_eq!(c.confirm_interval, "1h");
    assert_eq!(c.strategy.rr_min, 2.5);
    assert_eq!(c.strategy.ema_period, 30);
    assert!(c.strategy.allow_short);
}

#[test]
fn test_strategy_selected_by_id() {
    let s = crate::config::Settings::default();
    let down = mk(&(0..80).map(|i| 200.0 - i as f64).collect::<Vec<_>>());

    let mut st = crate::config::Strategy::new("shorty", "测试空头", "");
    st.allow_short = true;
    st.allow_long = false;

    let sig = crate::strategy::evaluate(
        crate::strategy::Input {
            dir_bars: &down,
            exec_bars: &down,
            conf_bars: &down,
            strategy: Some(st),
        },
        &s,
    );
    assert_eq!(sig.strategy_id, "shorty", "应使用指定策略");
    assert_eq!(sig.strategy_name, "测试空头");
    assert_eq!(sig.dir, -1, "允许做空时应判出空头方向");
}

#[test]
fn test_normalize_url() {
    assert_eq!(
        crate::ai::normalize_url("https://api.deepseek.com"),
        "https://api.deepseek.com/chat/completions"
    );
    assert_eq!(
        crate::ai::normalize_url("https://api.moonshot.cn/v1"),
        "https://api.moonshot.cn/v1/chat/completions"
    );
    assert_eq!(
        crate::ai::normalize_url("https://api.moonshot.cn/v1/"),
        "https://api.moonshot.cn/v1/chat/completions"
    );
    let full = "https://api.deepseek.com/chat/completions";
    assert_eq!(crate::ai::normalize_url(full), full);
    assert_eq!(
        crate::ai::normalize_url(""),
        "https://api.deepseek.com/chat/completions"
    );
}

#[test]
fn test_system_prompt_contains_strategy() {
    let mut st = crate::config::Strategy::new("trend_pullback", "趋势回踩", "顺趋势等回踩");
    st.focus = vec!["趋势方向".into(), "回踩幅度".into()];
    st.prompt = "重点看均线偏离".into();

    let sys = crate::ai::system_prompt(&st, "我的口径：只做多", 1.8, 6);

    assert!(sys.contains("趋势回踩"), "应含策略名");
    assert!(sys.contains("顺趋势等回踩"), "应含策略说明");
    assert!(sys.contains("重点看均线偏离"), "应含策略提示词");
    assert!(sys.contains("趋势方向"), "应含关注点");
    assert!(sys.contains("我的口径：只做多"), "应含用户口径");
    assert!(sys.contains("1.8"), "应含盈亏比参数");
    assert!(sys.contains("禁止"), "应标出未允许的方向");
}

#[test]
fn test_ai_presets_valid() {
    let p = crate::ai::presets();
    assert!(p.len() >= 4, "预设应至少有 4 个");
    for (name, url, model) in &p {
        assert!(url.starts_with("https://"), "{} 的地址应以 https 开头", name);
        assert!(!model.is_empty(), "{} 缺少模型名", name);
        assert!(
            !model.contains("deepseek-chat") && !model.contains("deepseek-reasoner"),
            "{} 不该用 2026-07-24 已下线的模型名",
            name
        );
    }
}

#[test]
fn test_estimate_tokens() {
    // 纯中文：约 1 字 1 token
    assert_eq!(crate::ai::estimate_tokens("黄金行情"), 4);
    // 纯 ASCII：约 4 字符 1 token
    assert_eq!(crate::ai::estimate_tokens("abcdefgh"), 2);
    // 混合
    let t = crate::ai::estimate_tokens("黄金abc");
    assert_eq!(t, 2 + 0, "中文 2 字 + 3 ASCII ≈ 2 token");
}

#[test]
fn test_budget_levels() {
    // 档位递增，且极限档等于 9 成上限
    let l0 = crate::ai::budget_tokens(0);
    let l1 = crate::ai::budget_tokens(1);
    let l2 = crate::ai::budget_tokens(2);
    let l3 = crate::ai::budget_tokens(3);
    assert!(l0 < l1 && l1 < l2 && l2 < l3, "预算档位应递增：{} {} {} {}", l0, l1, l2, l3);
    assert_eq!(l3, crate::ai::CONTEXT_LIMIT, "极限档应为 90 万");
    assert_eq!(crate::ai::CONTEXT_LIMIT, 900_000, "上限应为 1M 的 9 成");
}

#[test]
fn test_context_respects_budget() {
    let bars = mk(&(0..300).map(|i| 4000.0 + i as f64 * 0.5).collect::<Vec<_>>());
    let dir = mk(&(0..200).map(|i| 4000.0 + i as f64 * 0.3).collect::<Vec<_>>());
    let conf = mk(&(0..100).map(|i| 4000.0 - i as f64 * 0.2).collect::<Vec<_>>());

    // 小预算
    let (small, tok_small) = crate::ai::build_context(
        &bars, "5m", Some((&dir, "1h")), Some((&conf, "15m")),
        Some(4141.8), "RSI 55.0", 2_000,
    );
    assert!(tok_small <= 2_000, "小预算下不应超限，实际 {}", tok_small);
    assert!(small.contains("4141.80"), "应包含现价");
    assert!(small.contains("RSI 55.0"), "应包含指标摘要");
    assert!(small.contains("执行周期近期K线"), "应包含 K 线区块");

    // 大预算：应装入更多数据
    let (big, tok_big) = crate::ai::build_context(
        &bars, "5m", Some((&dir, "1h")), Some((&conf, "15m")),
        Some(4141.8), "RSI 55.0", 100_000,
    );
    assert!(tok_big > tok_small, "大预算应装入更多内容：{} vs {}", tok_big, tok_small);
    assert!(tok_big <= 100_000, "不应超预算");
    assert!(big.contains("定方向周期K线"), "应包含定方向周期");

// 极小预算也不崩，且保留最小可用集（现价 + 指标 + 近期 K 线）
let (tiny, tok_tiny) = crate::ai::build_context(
    &bars, "5m", None, None, Some(4141.8), "RSI 55.0", 10,
);
assert!(tiny.contains("4141.80"), "极小预算也应保住现价");
assert!(tiny.contains("执行周期近期K线"), "极小预算也应保住近期K线");
assert!(
    tok_tiny > 10,
    "预算低于最小集时应超限（下限 {} token），实际 {}",
    1_200,
    tok_tiny
);
assert!(tok_tiny < 5_000, "最小集不应膨胀，实际 {}", tok_tiny);
}

#[test]
fn test_json_repair() {
    // 完整 JSON 直接能过
    let good = r#"{"symbol":"xau","points":[{"t":1,"o":1.0,"h":2.0,"l":0.5,"c":1.5,"v":0}],"data_state":{"status":"fresh"}}"#;
    let v: serde_json::Value = serde_json::from_str(good).unwrap();
    assert_eq!(v["points"].as_array().unwrap().len(), 1);

    // 缺右括号：repair_json 的第一条路径应直接补齐
    let missing = r#"{"symbol":"xau","points":[{"t":1,"o":1.0,"h":2.0,"l":0.5,"c":1.5,"v":0}]"#;
    let fixed = crate::data::repair_json(missing).expect("缺右括号应能修补");
    let v2: serde_json::Value = serde_json::from_str(&fixed).expect("修补后应合法");
    assert_eq!(v2["points"].as_array().unwrap().len(), 1);

    // 数组中途截断：应砍到最后一个完整对象
    let cut = r#"{"symbol":"xau","points":[{"t":1,"o":1.0,"h":2.0,"l":0.5,"c":1.5,"v":0},{"t":2,"o":1.5,"h":2.5,"l":1.0,"c":2.0,"#;
    let fixed2 = crate::data::repair_json(cut).expect("截断的数组应能修补");
    let v3: serde_json::Value = serde_json::from_str(&fixed2).expect("修补后应合法");
    assert_eq!(v3["points"].as_array().unwrap().len(), 1, "应保留 1 个完整点");

    // 只有一个元素且被截断在元素内部：修不了，应返回 None
    let hopeless = r#"{"symbol":"xau","points":[{"t":1,"o":1.0,"h":2.0,"l"#;
    assert!(crate::data::repair_json(hopeless).is_none(), "无法修补时应返回 None");
}

// ---------- 记忆网关代理与研判闭环（件 3 / 件 4） ----------

/// 代理形状兼容：网关 `{items:[…]}` → 旧形状数组（前端零改动）
#[test]
fn gateway_items_view_keeps_old_shape() {
    let data = serde_json::json!({
        "items": [{"id": "a", "title": "t", "body": "b", "tags": ["x"], "updated": 1}]
    });
    let v = crate::mem_items_view(&data);
    assert!(v.is_array(), "旧形状：data 直接是数组");
    assert_eq!(v[0]["id"], "a");
    assert_eq!(v[0]["title"], "t");
    // 网关异常形状一律给空数组，绝不塞占位条目
    assert_eq!(crate::mem_items_view(&serde_json::json!({})), serde_json::json!([]));
    assert_eq!(crate::mem_items_view(&serde_json::json!({"items": "坏"})), serde_json::json!([]));
}

/// 代理形状兼容：网关 `{id, action, item}` → 旧形状条目本体
#[test]
fn gateway_save_view_maps_to_item() {
    let req = crate::MemorySaveReq {
        id: None,
        title: "用户标题".into(),
        body: "用户正文".into(),
        tags: vec!["x".into()],
    };
    let data = serde_json::json!({
        "id": "a", "action": "agent:改",
        "item": {"id": "a", "title": "改写标题", "body": "改写正文", "tags": ["g"], "updated": 9}
    });
    let v = crate::mem_item_view(&data, &req);
    assert_eq!(v["title"], "改写标题", "给了权威条目就用它");
    assert_eq!(v["updated"], 9);

    // 网关只回了 id（异常路径）：用请求内容补齐，不编造字段
    let v = crate::mem_item_view(&serde_json::json!({"id": "a", "action": "created"}), &req);
    assert_eq!(v["id"], "a");
    assert_eq!(v["title"], "用户标题");
    assert_eq!(v["body"], "用户正文");
    assert_eq!(v["tags"], serde_json::json!(["x"]));
}

/// URL 编码：中文与空格必须转义（query 里带策略名「趋势回踩」是常态）
#[test]
fn url_encode_escapes_non_ascii() {
    assert_eq!(crate::url_encode("abc-1_.~"), "abc-1_.~");
    assert_eq!(
        crate::url_encode("研判结论 趋势"),
        "%E7%A0%94%E5%88%A4%E7%BB%93%E8%AE%BA%20%E8%B6%8B%E5%8A%BF"
    );
    assert_eq!(crate::url_encode("a/b?c=d"), "a%2Fb%3Fc%3Dd");
}

/// 注入块：有历史必须带上「上次研判（日期）」与「成立/推翻都要明说」；无历史必须为空串（不许假装有积累）
#[test]
fn prior_block_injects_last_verdict() {
    let p = crate::PriorMem {
        id: "a".into(),
        title: "研判结论 趋势回踩 做多 2026-10-05".into(),
        body: "【前因】…\n【行为】方向做多\n【后果】失效条件…".into(),
        updated: 1791260465,
    };
    let b = crate::prior_block(Some(&p));
    assert!(b.contains("【上次研判（2026-10-06）】"), "{b}");
    assert!(b.contains("研判结论 趋势回踩 做多 2026-10-05"), "{b}");
    assert!(b.contains("成立/推翻都要明说"), "{b}");
    assert!(b.contains("【后果】"), "上轮结论的正文要进 prompt：{b}");
    assert_eq!(crate::prior_block(None), "", "无历史不许编");
    // 正文超长截断（800 字）——别把 prompt 撑爆
    let long = crate::PriorMem {
        id: "b".into(),
        title: "t".into(),
        body: "字".repeat(2000),
        updated: 0,
    };
    let b = crate::prior_block(Some(&long));
    assert!(b.chars().count() < 1200, "未截断：{}", b.chars().count());
    assert!(b.contains("时间未知"), "时间戳缺失要如实说");
}

/// 「上次研判」只认契约条目（title 以「研判结论」开头）：语义召回捞回来的近似条目不算历史
#[test]
fn pick_prior_requires_contract_title() {
    let items = vec![
        serde_json::json!({"id": "x", "title": "金秤策略差异化与sentiment单轴：双策略结论各不同", "body": "无关条目", "updated": 1}),
        serde_json::json!({"id": "z", "title": "研判结论 均值回归 做多 2026-10-06", "body": "别的策略的结论", "updated": 3}),
        serde_json::json!({"id": "y", "title": "研判结论 趋势回踩 做多 2026-10-05", "body": "上一轮三标", "updated": 1791260465}),
    ];
    let p = crate::pick_prior(&items, "趋势回踩").expect("应跳过无关条目与别策略条目，取本策略契约条目");
    assert_eq!(p.id, "y", "串策略的结论不算「上次研判」");
    assert_eq!(crate::date_of(p.updated), "2026-10-06");

    // 库里只有别策略的结论：本策略仍是「无历史」，不许将就
    assert!(crate::pick_prior(&[items[1].clone()], "趋势回踩").is_none());
    // 全是无关条目 → None（宁可说无历史，绝不编）
    assert!(crate::pick_prior(&[items[0].clone()], "趋势回踩").is_none());
    // 空表 / 空策略名 / id 缺失 → None
    assert!(crate::pick_prior(&[], "趋势回踩").is_none());
    assert!(crate::pick_prior(&items, "  ").is_none());
    assert!(crate::pick_prior(&[serde_json::json!({"title": "研判结论 趋势回踩 x"})], "趋势回踩").is_none());
}

/// 归档正文三标契约 + memory_refs 元素形状
#[test]
fn research_body_and_refs_contract() {
    let v = crate::enhance::Verdict {
        direction: "long".into(),
        entry: 4139.0,
        sl: 4132.0,
        tp: 4155.0,
        confidence: 72.0,
        reasons: vec!["回踩不破 EMA20".into(), "区间下沿承接".into()],
        warnings: vec![],
        sentiment: 60.0,
        bias: String::new(),
        gauge: 0.0,
        style_tag: "稳健波段".into(),
        summary: "回踩到位可试多".into(),
        modules: vec![],
        plans: vec![],
    };
    let p = crate::PriorMem {
        id: "a".into(),
        title: "研判结论 趋势回踩 做多 2026-10-05".into(),
        body: "上一轮：看多到 4160".into(),
        updated: 1791260465,
    };
    let b = crate::research_body("trend_pullback", "趋势回踩", "回踩不破则多", &v, Some(&p), "做多");
    assert!(b.starts_with("【前因】接上次研判"), "{b}");
    assert!(b.contains("【行为】策略「趋势回踩」(id=trend_pullback) 方向做多"));
    assert!(b.contains("信心 72"), "{b}");
    assert!(b.contains("入场 4139.00"));
    assert!(b.contains("理由：回踩不破 EMA20"));
    assert!(b.contains("【后果】失效条件：价格触及止损 4132.00"), "{b}");
    assert!(b.contains("下轮先看 4132.00 是否守住、4155.00 是否先到"), "{b}");

    // 模型给了风险提示就用它当失效条件
    let mut v2 = v.clone();
    v2.warnings = vec!["数据源断更".into()];
    let b2 = crate::research_body("s", "趋势回踩", "x", &v2, None, "做多");
    assert!(b2.contains("失效条件：数据源断更"));
    assert!(b2.contains("无上次研判可接"), "首条结论要如实说无历史");
    assert!(b2.contains('\n'), "三标要分行，便于机器读");

    // memory_refs 元素形状锁死：{id, title}
    let r = serde_json::to_value(crate::enhance::MemRef {
        id: "a".into(),
        title: "研判结论 趋势回踩 做多 2026-10-05".into(),
    })
    .unwrap();
    assert_eq!(r["id"], "a");
    assert!(r["title"].as_str().unwrap().starts_with("研判结论"));
    assert_eq!(r.as_object().unwrap().len(), 2, "refs 只许 id/title 两个字段");
}

/// 日期口径：本地时区日期（title 里的 YYYY-MM-DD 与 refs 展示都要一致）
#[test]
fn date_of_uses_local_day() {
    assert_eq!(crate::date_of(1791260465), "2026-10-06");
    assert_eq!(crate::date_of(0), "时间未知");
    assert_eq!(crate::date_of(-5), "时间未知");
}