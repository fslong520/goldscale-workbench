//! 极简内置记忆：纯 JSON 明文，单文件、单进程、无加密、无向量库。
//!
//! ⚠️ 已退役（2026-10-06）：金秤记忆读写改由 `src/rsbridge.rs` 走本机 rsrs（respire），
//! 与 agent 共用同一套记忆库（树形判重、云同步）。本文件已移出模块树（`mod memory;` 删除），
//! 不参与编译，仅留备查；旧数据 `~/.goldscale/memory.json` 在插件开启时一次性导入 rsrs 并改名备份。
//!
//! 以下为原自研实现说明——
//!
//! 借鉴 respire / rsrs 的「存—查—回忆」语义，但砍到骨头：
//! - 存储：`~/.goldscale/memory.json`，结构 `{"items":[...]}`；原子写（tmp + rename）。
//! - 检索：`list` 子串过滤；`recall` 2-gram 关键词打分（给 AI prompt 注入用，粗糙但够用）。
//! - 并发：进程内 `share()` 全局单例（`Mutex<Memory>`），锁内改、改完落盘。
//!
//! 数据文件损坏时不 panic：备份成 `memory.json.bad-<ts>` 后空表起步，并 `tracing::warn`。
//!
//! 用法（路由侧）：
//! ```ignore
//! let mut mem = memory::share().lock().unwrap();
//! let it = mem.upsert(title, body, tags, id)?;      // id 为 None 则新建
//! let all = mem.list("");                            // 全部，按 updated 倒序
//! let hits = mem.recall("黄金 回踩", 5);             // 关键词召回

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::agent::agent_home;

/// 记忆文件名，落在 `~/.goldscale/` 下
const FILE: &str = "memory.json";

/// 一条记忆
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemItem {
    /// 短 id：秒级时间戳 + 3 位随机 hex
    pub id: String,
    /// 标题，必填（trim 后为空则 upsert 报错）
    pub title: String,
    /// 正文，可空
    #[serde(default)]
    pub body: String,
    /// 标签，可空
    #[serde(default)]
    pub tags: Vec<String>,
    /// 创建时间，unix 秒
    pub created: i64,
    /// 更新时间，unix 秒
    pub updated: i64,
}

/// 磁盘结构：`{"items":[...]}`
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Db {
    #[serde(default)]
    items: Vec<MemItem>,
}

/// 记忆库：进程内存常驻 + 每次变更落盘
pub struct Memory {
    path: PathBuf,
    items: Vec<MemItem>,
}

impl Memory {
    /// 打开默认记忆库（`~/.goldscale/memory.json`）
    pub fn load() -> Memory {
        Memory::load_at(agent_home().join(FILE))
    }

    /// 打开指定路径的记忆库（测试/多实例用）；不存在 → 空表，损坏 → 备份后空表
    pub fn load_at(path: impl Into<PathBuf>) -> Memory {
        let path = path.into();
        let mut items = Vec::new();
        match std::fs::read_to_string(&path) {
            Ok(txt) => match serde_json::from_str::<Db>(&txt) {
                Ok(db) => items = db.items,
                Err(e) => {
                    let bak = path.with_extension(format!("json.bad-{}", now_secs()));
                    match std::fs::rename(&path, &bak) {
                        Ok(_) => tracing::warn!(
                            "记忆文件解析失败，已备份为 {}，空表启动: {}",
                            bak.display(),
                            e
                        ),
                        Err(re) => tracing::warn!("记忆文件解析失败({e})且备份失败({re})，空表启动"),
                    }
                }
            },
            // 文件不存在（首次使用）或读不了：都从空表起步
            Err(_) => {}
        }
        Memory { path, items }
    }

    /// 落盘：临时文件 + rename，避免写一半被读到
    fn persist(&self) {
        let Ok(txt) = serde_json::to_string_pretty(&Db { items: self.items.clone() }) else {
            tracing::error!("记忆序列化失败，未落盘");
            return;
        };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        match std::fs::write(&tmp, txt) {
            Ok(_) => {
                if let Err(e) = std::fs::rename(&tmp, &self.path) {
                    tracing::error!("记忆落盘 rename 失败: {}", e);
                }
            }
            Err(e) => tracing::error!("记忆落盘写入失败: {}", e),
        }
    }

    /// 查：q 为空 → 全部（updated 倒序）；非空 → title/body/tags 子串匹配（大小写不敏感），同样 updated 倒序
    pub fn list(&self, q: &str) -> Vec<MemItem> {
        let key = q.trim().to_lowercase();
        let mut out: Vec<MemItem> = self
            .items
            .iter()
            .filter(|it| {
                if key.is_empty() {
                    return true;
                }
                let hay = format!("{} {} {}", it.title, it.body, it.tags.join(" ")).to_lowercase();
                hay.contains(&key)
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| b.updated.cmp(&a.updated).then(b.created.cmp(&a.created)));
        out
    }

    /// 取单条
    #[allow(dead_code)] // 备用 API：前端按 id 查单条时启用
    pub fn get(&self, id: &str) -> Option<MemItem> {
        self.items.iter().find(|it| it.id == id).cloned()
    }

    /// 条数
    #[allow(dead_code)] // 备用 API
    pub fn count(&self) -> usize {
        self.items.len()
    }

    /// 存/改：
    /// - id 为 None（或 trim 后为空）→ 新建，id = 时间戳 + 3 位随机 hex
    /// - id 存在 → 只更新 title/body/tags/updated，保留 created
    /// - id 不存在 → 按该 id 新建
    ///
    /// title trim 后为空 → `Err("标题不能为空")`；body 允许空。
    pub fn upsert(
        &mut self,
        title: impl Into<String>,
        body: impl Into<String>,
        tags: Vec<String>,
        id: Option<String>,
    ) -> Result<MemItem, String> {
        let title = title.into();
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("标题不能为空".to_string());
        }
        let body = body.into();
        let tags: Vec<String> = tags
            .into_iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        let want = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let now = now_secs();

        let item = match want {
            Some(id) => match self.items.iter_mut().find(|it| it.id == id) {
                Some(old) => {
                    old.title = title;
                    old.body = body;
                    old.tags = tags;
                    old.updated = now;
                    old.clone()
                }
                None => {
                    let it = MemItem { id, title, body, tags, created: now, updated: now };
                    self.items.push(it.clone());
                    it
                }
            },
            None => {
                let it = MemItem { id: gen_id(), title, body, tags, created: now, updated: now };
                self.items.push(it.clone());
                it
            }
        };
        self.persist();
        Ok(item)
    }

    /// 删：删掉了返回 true
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|it| it.id != id);
        let hit = self.items.len() != before;
        if hit {
            self.persist();
        }
        hit
    }

    /// 回忆（带分版）：给 AI prompt 注入相关记忆用
    ///
    /// 打分：把 `text` 按字切 2-gram 去重成集合 Q，对每条 item 分别取
    /// title / body / tags 的 2-gram 集合 T、B、S，
    /// `score = (2·|Q∩T| + |Q∩B| + |Q∩S|) / |Q|`。
    /// 标题命中权重高；只保留 score > 0，按 score 降序（同分按 updated 倒序）截前 n。
    pub fn recall_scored(&self, text: &str, n: usize) -> Vec<(f64, MemItem)> {
        let q = gram_set(text);
        if q.is_empty() || n == 0 {
            return Vec::new();
        }
        let total = q.len() as f64;
        let mut out: Vec<(f64, MemItem)> = Vec::new();
        for it in &self.items {
            let ot = q.intersection(&gram_set(&it.title)).count() as f64;
            let ob = q.intersection(&gram_set(&it.body)).count() as f64;
            let os = q.intersection(&gram_set(&it.tags.join(" "))).count() as f64;
            let score = (2.0 * ot + ob + os) / total;
            if score > 0.0 {
                out.push((score, it.clone()));
            }
        }
        out.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.1.updated.cmp(&a.1.updated))
        });
        out.truncate(n);
        out
    }

    /// 回忆：只取条目，不要分数
    pub fn recall(&self, text: &str, n: usize) -> Vec<MemItem> {
        self.recall_scored(text, n).into_iter().map(|(_, it)| it).collect()
    }
}

/// 全局单例：`share().lock().unwrap().list("")`
pub fn share() -> &'static Mutex<Memory> {
    static MEM: OnceLock<Mutex<Memory>> = OnceLock::new();
    MEM.get_or_init(|| Mutex::new(Memory::load()))
}

/// 便捷取锁：中毒（panic 过）也能继续用，免得记忆库拖垮整个服务
pub fn with_memory<T>(f: impl FnOnce(&mut Memory) -> T) -> T {
    let mut guard = match share().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    f(&mut guard)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 短 id：秒级时间戳(hex) + 3 位随机 hex；不引 rand，用 nanos/pid/自增计数混哈希
fn gen_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut h = std::collections::hash_map::DefaultHasher::new();
    nanos.hash(&mut h);
    std::process::id().hash(&mut h);
    SEQ.fetch_add(1, Ordering::Relaxed).hash(&mut h);

    format!("{:x}{:03x}", nanos / 1_000_000_000, (h.finish() & 0xfff) as u32)
}

/// 2-gram 集合：小写化、只留字母数字与汉字（丢掉空白和标点），不足 2 字时按单字
fn gram_set(s: &str) -> HashSet<String> {
    let chars: Vec<char> = s
        .chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_alphanumeric())
        .collect();
    if chars.len() < 2 {
        return chars.iter().map(|c| c.to_string()).collect();
    }
    chars.windows(2).map(|w| w.iter().collect::<String>()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 临时文件路径：不碰真实 ~/.goldscale/memory.json
    fn tmp_file(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("goldscale-mem-{}-{}-{}.json", tag, std::process::id(), n))
    }

    /// 清掉测试产生的 .json / .json.tmp / .json.bad-*
    fn cleanup(p: &Path) {
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_file(p.with_extension("json.tmp"));
        let (Some(dir), Some(name)) = (p.parent(), p.file_name().map(|s| s.to_string_lossy().to_string()))
        else {
            return;
        };
        let prefix = format!("{name}.bad-");
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }

    #[test]
    fn upsert_new_update_and_errors() {
        let p = tmp_file("upsert");
        let mut m = Memory::load_at(&p);
        assert_eq!(m.count(), 0);
        assert!(m.list("").is_empty());

        // 新建：标题 trim，created == updated
        let a = m.upsert("  黄金  ", "趋势向上", vec![" gold ".into()], None).unwrap();
        assert_eq!(a.title, "黄金");
        assert_eq!(a.tags, vec!["gold".to_string()]);
        assert!(!a.id.is_empty());
        assert_eq!(a.created, a.updated);
        assert_eq!(m.count(), 1);

        // 按 id 更新：保留 created，只换 title/body/tags
        let upd = m.upsert("黄金回踩", "改过的正文", vec![], Some(a.id.clone())).unwrap();
        assert_eq!(upd.id, a.id);
        assert_eq!(upd.created, a.created);
        assert_eq!(upd.title, "黄金回踩");
        assert_eq!(upd.body, "改过的正文");
        assert!(upd.tags.is_empty());
        assert_eq!(m.count(), 1);

        // 指定不存在的 id → 按该 id 新建
        let made = m.upsert("新条目", "", vec![], Some("manual-id".into())).unwrap();
        assert_eq!(made.id, "manual-id");
        assert_eq!(m.count(), 2);

        // 空标题 / 纯空白标题 → Err
        assert_eq!(m.upsert("   ", "x", vec![], None).unwrap_err(), "标题不能为空");
        assert!(m.upsert("", "x", vec![], None).is_err());
        assert_eq!(m.count(), 2);

        // 空 id 字符串 → 当新建
        let auto = m.upsert("auto", "", vec![], Some("  ".into())).unwrap();
        assert!(!auto.id.is_empty());
        assert_ne!(auto.id, "  ");
        assert_eq!(m.count(), 3);

        cleanup(&p);
    }

    #[test]
    fn list_filter_and_sort() {
        let p = tmp_file("list");
        let raw = r#"{"items":[
          {"id":"a","title":"黄金趋势","body":"H4 多头","tags":["gold"],"created":100,"updated":100},
          {"id":"b","title":"GOLD 风控","body":"单笔不超过 1%","tags":[],"created":200,"updated":300},
          {"id":"c","title":"白银区间","body":"高抛低吸","tags":["silver"],"created":150,"updated":200}
        ]}"#;
        std::fs::write(&p, raw).unwrap();
        let m = Memory::load_at(&p);
        assert_eq!(m.count(), 3);

        // 空查询：全部，updated 倒序
        let all = m.list("");
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, "b");
        assert_eq!(all[1].id, "c");
        assert_eq!(all[2].id, "a");
        assert_eq!(m.list("   ").len(), 3);

        // 子串匹配：命中 tags 与大小写不敏感
        assert_eq!(m.list("gold").len(), 2);
        assert_eq!(m.list("GOLD")[0].id, "b");
        // 命中文案
        assert_eq!(m.list("白银").len(), 1);
        assert_eq!(m.list("白银")[0].id, "c");
        assert_eq!(m.list("高抛")[0].id, "c");
        assert!(m.list("不存在的词").is_empty());

        // get
        assert_eq!(m.get("a").unwrap().title, "黄金趋势");
        assert!(m.get("zzz").is_none());

        cleanup(&p);
    }

    #[test]
    fn recall_ranks_relevant_first() {
        let p = tmp_file("recall");
        let mut m = Memory::load_at(&p);
        m.upsert("黄金趋势回踩", "H4 多头，回踩 EMA20 入场", vec!["黄金".into()], None).unwrap();
        m.upsert("白银区间", "高抛低吸，不追单", vec![], None).unwrap();
        m.upsert("交易纪律", "每天最多六单", vec![], None).unwrap();

        // 相关命中，且最相关（标题+正文都中）排第一
        let hits = m.recall("黄金回踩入场", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "黄金趋势回踩");

        // 无关查询 → 空
        assert!(m.recall("紫色独角兽", 5).is_empty());
        // 空文本 / n=0 → 空
        assert!(m.recall("", 5).is_empty());
        assert!(m.recall("   ", 5).is_empty());
        assert!(m.recall("黄金", 0).is_empty());

        // 多命中：按分数降序，且都 > 0
        let scored = m.recall_scored("黄金 回踩 纪律 入场", 5);
        assert_eq!(scored.len(), 2);
        assert_eq!(scored[0].1.title, "黄金趋势回踩");
        assert_eq!(scored[1].1.title, "交易纪律");
        assert!(scored.iter().all(|(s, _)| *s > 0.0));
        assert!(scored.windows(2).all(|w| w[0].0 >= w[1].0));

        // n 截断
        assert_eq!(m.recall_scored("黄金 回踩 纪律 入场", 1).len(), 1);
        assert_eq!(m.recall("黄金 回踩 纪律 入场", 1).len(), 1);

        cleanup(&p);
    }

    #[test]
    fn remove_works_and_persists() {
        let p = tmp_file("remove");
        let mut m = Memory::load_at(&p);
        let a = m.upsert("临时", "x", vec![], None).unwrap();
        assert!(m.remove(&a.id));
        assert!(m.list("").is_empty());
        assert!(!m.remove(&a.id));
        assert!(!m.remove("nope"));

        // 删除已落盘
        let reloaded = Memory::load_at(&p);
        assert_eq!(reloaded.count(), 0);

        cleanup(&p);
    }

    #[test]
    fn persist_roundtrip_and_corrupt_recovery() {
        let p = tmp_file("io");
        let mut m = Memory::load_at(&p);
        let a = m.upsert("持久化", "写盘", vec!["io".into()], None).unwrap();
        assert!(p.exists());
        // 二次加载：内容一致
        let m2 = Memory::load_at(&p);
        assert_eq!(m2.count(), 1);
        assert_eq!(m2.list("")[0].id, a.id);
        assert_eq!(m2.list("写盘")[0].body, "写盘");

        // 损坏文件 → 备份 + 空表，不 panic
        std::fs::write(&p, "{ 这不是 json").unwrap();
        let m3 = Memory::load_at(&p);
        assert_eq!(m3.count(), 0);
        let dir = p.parent().unwrap();
        let prefix = format!("{}.bad-", p.file_name().unwrap().to_string_lossy());
        let has_bak = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().starts_with(&prefix));
        assert!(has_bak, "损坏文件应被备份");

        // 空表还能继续写
        let mut m4 = Memory::load_at(&p);
        assert!(m4.upsert("恢复后", "", vec![], None).is_ok());
        assert_eq!(Memory::load_at(&p).count(), 1);

        cleanup(&p);
    }

    /// 只做类型检查，不调用（避免碰真实家目录文件）
    #[test]
    fn share_signature_is_stable() {
        fn sig(_f: fn() -> &'static Mutex<Memory>) {}
        fn sig_with<T>(_f: fn(f: fn(&mut Memory) -> T) -> T) {}
        sig(share);
        sig_with::<usize>(with_memory);
    }
}
