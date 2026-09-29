//! 交给 AI 的任务模板：决定项目里 TASK.md 的「目标」、开场提示词和「继续」时的提示。
//! 内置几个，用户可以在界面里改（存在数据库里，所有设备共用）。

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Template {
    pub id: String,
    pub name: String,
    /// 写进 TASK.md「目标」一节（Markdown）
    pub goal: String,
    /// 第一次交给 AI 时的提示词
    pub prompt: String,
    /// 笔记有更新、点「继续」时追加的提示
    pub resume: String,
}

fn t(id: &str, name: &str, goal: &str, prompt: &str, resume: &str) -> Template {
    Template {
        id: id.into(),
        name: name.into(),
        goal: goal.into(),
        prompt: prompt.into(),
        resume: resume.into(),
    }
}

pub fn builtin() -> Vec<Template> {
    vec![
        t(
            "general",
            "通用",
            "按笔记里的内容完成这件事。先弄清楚要做成什么样，不确定的地方先问我，不要自己假设。",
            "请先读 .xpanel/TASK.md 和 .xpanel/note.md，说说你的理解和打算怎么做，我确认后再动手。",
            "在已有工作的基础上继续，只处理新增的内容。",
        ),
        t(
            "rebuild",
            "从截图复刻项目",
            "笔记里的截图是一个现有项目的代码和界面。按截图把它还原成能编译、能运行的工程：\n\
- 目录结构、文件名、类名、函数名尽量和截图一致\n\
- 截图里看不清或没拍到的部分，在代码里标 `TODO(xpanel)`，并汇总到根目录的 RECONSTRUCTION.md（哪个文件、缺什么、依据哪张截图），不要凭空编\n\
- 在 RECONSTRUCTION.md 里维护一张「截图 → 文件」的对照表\n\
- 笔记会不断补充截图：每次只处理新增的截图，不要推翻已经还原好的部分；新截图和已有代码冲突时，以新截图为准并记下来",
            "请读 .xpanel/TASK.md，然后按编号顺序看 .xpanel/images/ 里的截图，先列出你认出来的项目结构，再开始还原。",
            "笔记补充了新的截图或说明，请只处理新增部分，把它们还原进现有工程，并更新 RECONSTRUCTION.md 的对照表和待确认清单。",
        ),
        t(
            "chat",
            "整理聊天记录",
            "笔记里是聊天记录。整理成一份 SUMMARY.md：\n\
1. 讨论的要点和已有结论\n\
2. 需要我做的事：做什么、给谁、什么时候\n\
3. 需要我回复或确认的问题\n\
4. 还没定下来的分歧",
            "请读 .xpanel/TASK.md 和 .xpanel/note.md，整理出 SUMMARY.md。需要我做的事可以用 xpanel_create_items 直接建成待办。",
            "聊天有新内容，请把新增部分合并进 SUMMARY.md，并标出哪些是新的。",
        ),
        t(
            "debug",
            "排查问题",
            "笔记里描述的是一个问题（现象、日志、截图）。\n\
1. 先整理出复现条件和现象\n\
2. 找到根本原因，给出证据\n\
3. 给出修复方案，改动前先和我确认\n\
结论写进 FINDINGS.md。",
            "请读 .xpanel/TASK.md 和 .xpanel/note.md，先整理现象和复现条件，再开始排查。",
            "笔记补充了新的现象或日志，请结合之前的结论继续排查，更新 FINDINGS.md。",
        ),
    ]
}

/// 按 id 找模板，找不到用「通用」
pub fn pick(list: &[Template], id: &str) -> Template {
    list.iter()
        .find(|t| t.id == id)
        .cloned()
        .unwrap_or_else(|| builtin().remove(0))
}
