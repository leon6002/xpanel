/* 入口的编辑：固定的几栏，不和笔记共用自由正文。
   名称、地址（点一下打开的那个）、其他地址（比如仓库网址之外的本地文件夹）、分组、备注。
   存的时候拼回正文：开头一行一个地址，空一行后面是备注（见 lib/logic.ts 的 parseEntry / entryBody），
   所以命令行、MCP、旧界面看到的还是一条普通的入口。离开输入框就保存。 */
import { ArrowUp, Copy, ExternalLink, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText, errText, openTarget } from "../lib/api";
import { cx } from "../lib/cx";
import { patchItem, qc, useAppState } from "../lib/data";
import { autoTitle, entryBody, isTarget, normCat, parseEntry, scanTargets } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Item, State } from "../lib/types";
import { Field, inputCls, textareaCls } from "./ui";

const mini = "grid size-9 shrink-0 place-items-center rounded-[10px] text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-40 [&_svg]:size-4";
const go = (t: string) =>
  openTarget(t)
    .then((r) => r === "copied" && useUi.getState().say("网页版不能直接打开本地路径，已复制：" + t))
    .catch((e) => useUi.getState().say(errText(e)));

export function LinkForm({ it }: { it: Item }) {
  const items = useAppState().data?.items ?? [];
  const say = useUi((s) => s.say);
  const parsed = useMemo(() => parseEntry(it), [it.title, it.body]);
  const [title, setTitle] = useState(it.title);
  const [addrs, setAddrs] = useState<string[]>(parsed.targets.length ? parsed.targets : [""]);
  const [notes, setNotes] = useState(parsed.notes);
  const [cat, setCat] = useState(it.category || "");
  const [saved, setSaved] = useState("");
  const dirty = useRef(false);
  // 这边没在改的时候，别处改了（另一台电脑、AI、拖到别的分组）就跟上
  useEffect(() => {
    if (dirty.current) return;
    setTitle(it.title);
    setAddrs(parsed.targets.length ? parsed.targets : [""]);
    setNotes(parsed.notes);
    setCat(it.category || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it.id, it.title, it.body, it.category]);

  const cats = useMemo(() => [...new Set(items.filter((i) => i.type === "link" && i.category).map((i) => i.category!))].sort((a, b) => a.localeCompare(b, "zh")), [items]);
  const bad = addrs.map((a) => !!a.trim() && !isTarget(a));
  // 备注里顺口提到的别的地址：可以提成正式的地址
  const mentioned = useMemo(() => scanTargets(notes).filter((t) => !addrs.some((a) => a.trim() === t)), [notes, addrs]);
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    dirty.current = true;
    setSaved("");
    set(v);
  };

  const state = useRef({ title, addrs, notes, cat });
  state.current = { title, addrs, notes, cat };
  const save = (next: Partial<typeof state.current> = {}) => {
    if (!dirty.current) return;
    const cur = qc.getQueryData<State>(["state"])?.items.find((x) => x.id === it.id);
    if (!cur) return;
    const s = { ...state.current, ...next };
    const list = [...new Set(s.addrs.map((a) => a.trim()).filter(Boolean))];
    // 认不出来的地址先不存，免得存进去变成备注；框下面有提示
    if (list.some((a) => !isTarget(a))) return setSaved("有一个地址认不出来，改好了才会保存");
    const ch: Partial<Item> = {};
    const t = s.title.trim() || (list[0] ? autoTitle(list[0]) : "");
    if (t && t !== cur.title) ch.title = t;
    const body = entryBody(list, s.notes);
    if (body !== (cur.body || "").trim()) ch.body = body;
    const c = normCat(s.cat);
    if (c !== (cur.category || "")) ch.category = c || undefined;
    dirty.current = false;
    if (!Object.keys(ch).length) return;
    patchItem(cur, ch)
      .then(() => setSaved("已保存"))
      .catch(() => {
        dirty.current = true;
      });
  };
  // 关掉面板、换到别的条目时，没来得及保存的也存上
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => saveRef.current(), [it.id]);

  const setAddr = (i: number, v: string) => touch(setAddrs)(addrs.map((a, k) => (k === i ? v : a)));
  /** 动了地址的个数或先后：马上存 */
  const reshape = (next: string[]) => {
    touch(setAddrs)(next.length ? next : [""]);
    save({ addrs: next });
  };

  return (
    <form
      aria-label="入口"
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save();
      }}
      onKeyDown={(e) => {
        // 在输入框里按 Esc：先把写的存上，面板不跟着关（再按一次才关）
        if (e.key !== "Escape" || !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) return;
        e.stopPropagation();
        e.target.blur();
      }}
    >
      <Field label="名称">
        <input className={cx(inputCls, "h-10 text-[15px] font-semibold")} value={title} onChange={(e) => touch(setTitle)(e.target.value)} placeholder="不填就用地址当名称" autoComplete="off" />
      </Field>
      <div className="flex min-w-0 flex-col gap-1.5 text-[12.5px] text-muted">
        <span>地址</span>
        {addrs.map((a, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <input
                aria-label={i === 0 ? "地址" : "其他地址 " + i}
                className={cx(inputCls, "font-mono text-[13px]")}
                value={a}
                onChange={(e) => setAddr(i, e.target.value)}
                autoFocus={i === 0 && !a}
                placeholder={i === 0 ? "网址、共享文件夹或本地路径：https://…、\\\\主机\\共享、D:\\文件夹" : "再写一个地址，比如本地的文件夹"}
                spellCheck={false}
                autoComplete="off"
              />
              {i > 0 && (
                <button type="button" className={mini} aria-label={"设为主地址 " + i} title="设为主地址（点一下入口打开的就是它）" onClick={() => reshape([a, ...addrs.filter((_, k) => k !== i)])}>
                  <ArrowUp />
                </button>
              )}
              <button type="button" className={mini} aria-label={"打开 " + a} title="打开" disabled={!a.trim() || bad[i]} onClick={() => go(a.trim())}>
                <ExternalLink />
              </button>
              <button type="button" className={mini} aria-label={"复制 " + a} title="复制" disabled={!a.trim()} onClick={async () => say((await copyText(a.trim())) ? "已复制：" + a.trim() : "复制失败")}>
                <Copy />
              </button>
              {addrs.length > 1 && (
                <button type="button" className={mini} aria-label={"去掉地址 " + (i + 1)} title="去掉这个地址" onClick={() => reshape(addrs.filter((_, k) => k !== i))}>
                  <X />
                </button>
              )}
            </div>
            {i === 0 && addrs.length > 1 && <span className="text-xs text-faint">第一个是主地址，点一下入口打开的就是它；其他的在入口那一行后面各有一个小按钮。</span>}
            {bad[i] && <span className="text-xs text-danger">认不出是网址还是路径。网址要带 http:// 或 https://，路径像 D:\文件夹 或 \\主机\共享。</span>}
          </div>
        ))}
        <button
          type="button"
          className="flex h-8 items-center gap-1 self-start rounded-lg px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg [&_svg]:size-3.5"
          onClick={() => setAddrs([...addrs, ""])}
          disabled={addrs.some((a) => !a.trim())}
        >
          <Plus /> 再加一个地址
        </button>
      </div>
      <Field label="分组" hint="入口页按它分组；不填就按所在的机器自动分。">
        <input className={inputCls} value={cat} onChange={(e) => touch(setCat)(e.target.value)} list="link-groups" placeholder="比如 学习视频" autoComplete="off" />
        <datalist id="link-groups">
          {cats.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </Field>
      {mentioned.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
          <span>备注里还提到了别的地址，入口那一行也能直接打开它。要把它当正式的地址：</span>
          {mentioned.map((t) => (
            <span key={t} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="min-w-0 font-mono break-all text-fg-2">{t}</span>
              <button type="button" className="rounded-md bg-surface px-2 py-0.5 text-fg-2 hover:bg-surface-3" onClick={() => reshape([t, ...addrs.filter((a) => a.trim())])}>
                设为主地址
              </button>
              <button type="button" className="rounded-md bg-surface px-2 py-0.5 text-fg-2 hover:bg-surface-3" onClick={() => reshape([...addrs.filter((a) => a.trim()), t])}>
                加到地址里
              </button>
            </span>
          ))}
        </div>
      )}
      <Field label="备注">
        <textarea className={cx(textareaCls, "min-h-24 resize-y")} rows={Math.min(14, Math.max(4, notes.split("\n").length + 1))} value={notes} onChange={(e) => touch(setNotes)(e.target.value)} placeholder="账号在哪、干什么用的、注意事项…" />
      </Field>
      <span className={cx("h-4 text-xs", saved.startsWith("已") ? "text-faint" : "text-danger")}>{saved}</span>
    </form>
  );
}
