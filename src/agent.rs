//! Agent 家目录：~/.goldscale（配置 + 自有技能库）。
//!
//! Agent 运行时本体是 pi（项目内 agent/pi，`pi --mode rpc`），本模块只管它依赖的家目录：
//! - config.json：pi/MCP 配置落点
//! - skills/：金秤自有技能库（并链入 pi 扫描的 ~/.agents/skills/）
//! - ~/AGENT.md：用户全局指令；项目根建 AGENTS.md 软链指向它，pi 启动即读

use std::path::PathBuf;

use crate::config::Settings;

/// ~/.goldscale/：Agent 专属家目录
pub fn agent_home() -> PathBuf {
    if let Some(h) = std::env::var_os("HOME") {
        PathBuf::from(h).join(".goldscale")
    } else {
        Settings::data_dir().join(".agent_home")
    }
}

/// 用户全局 Agent 说明：~/AGENT.md
#[allow(dead_code)] // 本 crate（金秤）不再自拉 pi，仅供 agentd bin 使用
pub fn agent_md_path() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h).join("AGENT.md"),
        None => PathBuf::from("/nonexistent/AGENT.md"),
    }
}

/// 首次使用时初始化家目录与链接（均已存在则跳过）
#[allow(dead_code)] // 家目录初始化由 agentd 负责（金秤只需 agent_home 定位记忆文件）
pub fn ensure_home() {
    let home = agent_home();
    let skills = home.join("skills");
    if std::fs::create_dir_all(&skills).is_err() {
        return;
    }
    let readme = skills.join("README.md");
    if !readme.exists() {
        let _ = std::fs::write(
            &readme,
            "# 金秤 Agent 技能库\n\n\
             每个技能一个子目录，内含 SKILL.md（Agent Skills 规范：frontmatter + 指令正文）。\n\
             本目录已链入 ~/.agents/skills/，pi 启动时自动发现；\n\
             同时聚合本机 opencode 与 dimcode 技能库。\n",
        );
    }
    let cfg = home.join("config.json");
    if !cfg.exists() {
        let _ = std::fs::write(&cfg, "{\n  \"mcp_servers\": []\n}\n");
    }

    // 自有技能库接入 pi 的 Agent Skills 扫描位置
    if let Some(h) = std::env::var_os("HOME") {
        let agents = PathBuf::from(h).join(".agents/skills");
        if std::fs::create_dir_all(&agents).is_ok() {
            let link = agents.join("goldscale");
            if !link.exists() {
                let _ = std::os::unix::fs::symlink(&skills, &link);
            }
        }
    }

    // 项目根 AGENTS.md → ~/AGENT.md 软链：pi 以项目根为 cwd，读到即得全局指令
    if let Ok(cwd) = std::env::current_dir() {
        let link = cwd.join("AGENTS.md");
        if !link.exists() {
            let _ = std::os::unix::fs::symlink(agent_md_path(), &link);
        }
    }
}
