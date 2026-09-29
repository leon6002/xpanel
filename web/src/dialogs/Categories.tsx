/* 分类和标签管理：新建、改名 / 移动 / 合并、删除 */
import { Folder, Plus } from "lucide-react";
import { useState } from "react";
import { errText, v1 } from "../lib/api";
import { qc, useAppState } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { allCats, allTags, inCat, normCat, parentCat } from "../lib/logic";
import { useUi } from "../lib/store";
import { Button, ConfirmButton, inputCls } from "../components/ui";

export function openCatMgr(focusNew = false) {
  openDialog((close) => <CatDialog close={close} focusNew={focusNew} />);
}

function CatDialog({ close, focusNew }: { close: () => void; focusNew: boolean }) {
  const { data } = useAppState();
  const items = data?.items ?? [];
  const cats = allCats(items, data?.categories ?? []);
  const tags = allTags(items);
  const [nw, setNw] = useState("");
  const [edit, setEdit] = useState<{ kind: "cat" | "tag"; from: string; to: string } | null>(null);

  const op = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      const r = (await fn()) as { changed?: number } | undefined;
      await qc.invalidateQueries({ queryKey: ["state"] });
      useUi.getState().say(msg + (r && r.changed != null ? `，涉及 ${r.changed} 条` : ""));
    } catch (e) {
      useUi.getState().say(errText(e));
    }
  };
  const create = () => {
    const p = normCat(nw);
    if (!p) return useUi.getState().say("写个分类名");
    setNw("");
    op(() => v1("POST", "/categories", { path: p }), "已新建「" + p + "」");
  };
  const saveEdit = () => {
    if (!edit) return;
    const ui = useUi.getState();
    if (edit.kind === "cat") {
      const to = normCat(edit.to);
      setEdit(null);
      if (!to || to === edit.from) return;
      if (ui.cat && inCat(ui.cat, edit.from)) ui.setCat(to + ui.cat.slice(edit.from.length));
      op(() => v1("POST", "/categories/rename", { from: edit.from, to }), "已改成「" + to + "」");
    } else {
      const to = edit.to.replace(/^#/, "").trim();
      setEdit(null);
      if (!to || to === edit.from) return;
      if (ui.tag === edit.from) ui.setTag(to);
      op(() => v1("POST", "/tags/rename", { from: edit.from, to }), "已改成 #" + to);
    }
  };
  const row = "flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2";
  const editor = (
    <>
      <input
        autoFocus
        className={inputCls + " grow"}
        value={edit?.to || ""}
        onChange={(e) => setEdit((x) => x && { ...x, to: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveEdit()}
        onFocus={(e) => e.target.select()}
        aria-label="新名字"
      />
      <Button tone="primary" onClick={saveEdit}>
        保存
      </Button>
      <Button tone="ghost" onClick={() => setEdit(null)}>
        取消
      </Button>
    </>
  );

  return (
    <Dialog
      wide
      title="分类和标签"
      desc="分类用 / 分层（如 工作/AutoSAR），每条最多一个，笔记、待办、问题、入口都能用；标签每条可以有多个。改名时写完整路径就是移动，改成已有的名字就是合并。"
      onClose={close}
    >
      <div className="flex gap-2">
        <input
          autoFocus={focusNew}
          className={inputCls}
          value={nw}
          onChange={(e) => setNw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && create()}
          placeholder="新分类，如 工作/AutoSAR"
          list="xp-cats-mgr"
        />
        <datalist id="xp-cats-mgr">
          {cats.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Button tone="primary" onClick={create}>
          <Plus className="size-4" />
          新建分类
        </Button>
      </div>
      <div className="flex flex-col">
        {cats.map((p) =>
          edit?.kind === "cat" && edit.from === p ? (
            <div key={p} className={row}>
              {editor}
            </div>
          ) : (
            <div key={p} className={row}>
              <span className="flex min-w-0 grow items-center gap-1.5 text-[13.5px]" style={{ paddingLeft: (p.split("/").length - 1) * 18 }} title={p}>
                <Folder className="size-4 text-muted" />
                <span className="truncate">{p.split("/").pop()}</span>
              </span>
              <span className="text-xs text-muted">{items.filter((i) => inCat(i.category, p)).length} 条</span>
              <Button tone="ghost" onClick={() => setEdit({ kind: "cat", from: p, to: p })}>
                改名 / 移动
              </Button>
              <ConfirmButton
                confirm={`再点一次：里面的条目移到${parentCat(p) ? "「" + parentCat(p) + "」" : "未分类"}`}
                onConfirm={() => {
                  const ui = useUi.getState();
                  if (ui.cat && inCat(ui.cat, p)) ui.setCat(null);
                  op(() => v1("DELETE", "/categories?path=" + encodeURIComponent(p) + "&moveTo=parent"), "已删除分类「" + p + "」");
                }}
              >
                删除
              </ConfirmButton>
            </div>
          ),
        )}
        {!cats.length && <div className="py-3 text-center text-[13px] text-faint">还没有分类</div>}
      </div>
      <h3 className="text-sm font-semibold">标签</h3>
      <div className="flex flex-col">
        {tags.map(([t, n]) =>
          edit?.kind === "tag" && edit.from === t ? (
            <div key={t} className={row}>
              {editor}
            </div>
          ) : (
            <div key={t} className={row}>
              <span className="grow text-[13.5px]">#{t}</span>
              <span className="text-xs text-muted">{n} 条</span>
              <Button tone="ghost" onClick={() => setEdit({ kind: "tag", from: t, to: t })}>
                改名 / 合并
              </Button>
              <ConfirmButton
                confirm="再点一次：从所有条目上去掉"
                onConfirm={() => {
                  const ui = useUi.getState();
                  if (ui.tag === t) ui.setTag(null);
                  op(() => v1("DELETE", "/tags?tag=" + encodeURIComponent(t)), "已删除 #" + t);
                }}
              >
                删除
              </ConfirmButton>
            </div>
          ),
        )}
        {!tags.length && <div className="py-3 text-center text-[13px] text-faint">还没有标签</div>}
      </div>
    </Dialog>
  );
}
