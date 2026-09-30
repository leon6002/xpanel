/* 收件箱：左边「随手记」+ 导入的微信聊天；右边像聊天软件一样的消息流，输入框在最下面。
   - 随手记：发出去的是 type=inbox 的条目（和其他条目一样同步、离线可用），之后一键归到待办 / 问题 / 笔记…
   - 微信聊天：导入「合并转发 → 导出」的 ZIP；选中消息后转成笔记 / 待办、复制 Markdown、交给 AI */
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FileText, Lightbulb, Link2, CircleAlert, PanelRight, Pencil, Plus, Search, Send, Settings2, SquareCheck, Trash2, Sparkles, NotebookPen } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { copyText, errText, v1, v1Text } from "../lib/api";
import { addItem, patchItem, qc, removeItem, restoreItem, useAppState, useChats, useDevices, useMe } from "../lib/data";
import { useDrafts } from "../lib/drafts";
import { INBOX_AUTO, assetMd, dateStr, dayLabel, dueInfo, findTarget, hm, nowLabel, parseCapture, shortTime } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Chat, Item, ItemType, Msg } from "../lib/types";
import { typeName } from "../lib/types";
import { cx } from "../lib/cx";
import { openAgent } from "../dialogs/Agent";
import { openAppendToNote, openChatSettings, wxImportFile } from "../dialogs/Wechat";
import { PendingFiles } from "./Files";
import { Md, useAssetUrl, useOpenAsset, Lightbox } from "./Markdown";
import { Button, ConfirmButton, Pri } from "./ui";

const say = (t: string, a?: { label: string; run: () => void }) => useUi.getState().say(t, a);
const inboxItems = (items: Item[]) => items.filter((i) => i.type === "inbox").sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const TRIAGE: { k: ItemType; icon: typeof SquareCheck }[] = [
  { k: "todo", icon: SquareCheck },
  { k: "issue", icon: CircleAlert },
  { k: "idea", icon: Lightbulb },
  { k: "note", icon: FileText },
  { k: "link", icon: Link2 },
];
const PALETTE = ["#3563D1", "#C98712", "#6E54D8", "#138C92", "#D9503F", "#4A5E80"];

/** 拖进来 / 选的 ZIP：导入后打开那个聊天 */
export function importWechat(file: File) {
  return wxImportFile(file, (id) => {
    useUi.getState().setView("inbox");
    useUi.getState().setIbx(id);
  });
}
export function pickWechatZip() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".zip,application/zip";
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (f && !(await importWechat(f))) say("这个 ZIP 不是微信的聊天记录导出");
  };
  inp.click();
}

/* ---------------------------------------------------------------- 左边：会话列表 */

function Conv({ id, name, time, preview, badge, color, letter }: { id: string; name: string; time: string; preview: string; badge?: number; color: string; letter: string }) {
  const ui = useUi();
  const on = ui.ibx === id;
  return (
    <button
      onClick={() => ui.setIbx(id)}
      aria-current={on || undefined}
      className={cx("grid w-full grid-cols-[38px_1fr_auto] items-center gap-x-2.5 rounded-xl px-2.5 py-2 text-left", on ? "bg-surface-3" : "hover:bg-surface-2")}
    >
      <span className="row-span-2 grid size-[38px] place-items-center rounded-[11px] text-[15px] font-bold text-white" style={{ background: color }}>
        {letter}
      </span>
      <span className="truncate text-[14px] font-semibold">{name}</span>
      <span className="text-[11px] text-faint">{time}</span>
      <span className="truncate text-xs text-muted">{preview}</span>
      {badge ? <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] text-on-accent">{badge}</span> : <span />}
    </button>
  );
}

export function InboxList() {
  const items = useAppState().data?.items ?? [];
  const chats = useChats().data ?? [];
  const mine = inboxItems(items);
  const last = mine[mine.length - 1];
  const lt = last ? new Date(last.createdAt || 0) : null;
  return (
    <section aria-label="会话" className="flex w-[300px] shrink-0 flex-col gap-1 max-[1200px]:w-[230px]">
      <Conv
        id="me"
        name="随手记"
        time={lt ? shortTime(dateStr(lt) + " " + hm(lt)) : ""}
        preview={last ? (INBOX_AUTO.test(last.title) ? "[图片]" : last.title) : "发给自己，之后再归类"}
        badge={mine.length}
        color="var(--accent)"
        letter="记"
      />
      <div className="mt-3 flex items-center px-2.5 pb-1 text-xs text-muted">
        微信聊天
        <span className="grow" />
        <button title="导入微信聊天记录（ZIP）" aria-label="导入微信聊天记录" onClick={pickWechatZip} className="grid size-6 place-items-center rounded-md hover:bg-surface hover:text-accent [&_svg]:size-3.5">
          <Plus />
        </button>
      </div>
      <div className="scroll-quiet -mr-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-2">
        {chats.map((c, i) => {
          const l = c.last || {};
          return (
            <Conv
              key={c.id}
              id={c.id}
              name={c.name}
              time={shortTime(l.time)}
              preview={l.sender ? `${l.sender}：${String(l.text || "").replace(/\s+/g, " ")}` : ""}
              badge={c.unread}
              color={PALETTE[i % PALETTE.length]}
              letter={(c.name || "?").slice(0, 1)}
            />
          );
        })}
        {!chats.length && <div className="px-2.5 py-2 text-xs leading-relaxed text-faint">微信里多选消息 → 合并转发 → 导出，把得到的 ZIP 拖到这里就能导入。</div>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- 随手记 */

function MeMsg({ it, sel, selecting, toggle }: { it: Item; sel: boolean; selecting: boolean; toggle: () => void }) {
  const ui = useUi();
  const d = new Date(it.createdAt || 0);
  const showTitle = !(INBOX_AUTO.test(it.title || "") && it.body);
  const di = dueInfo(it);
  const tool = "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-fg-2 hover:bg-surface-3 hover:text-fg [&_svg]:size-3.5";
  async function triage(type: ItemType) {
    if (type === "link" && !findTarget((it.body || "") + "\n" + (it.title || ""))) {
      await patchItem(it, { type: "link" });
      ui.openPeek(it.id, "edit");
      return say("入口需要网址或路径，写在正文里");
    }
    const ch: Partial<Item> = { type };
    if (INBOX_AUTO.test(it.title || "") && type === "todo") ch.title = "看截图 " + it.title.slice(3);
    await patchItem(it, ch).catch(() => {});
    say(`已归到「${typeName(type)}」`, {
      label: "撤销",
      run: () => {
        const cur = qc.getQueryData<{ items: Item[] }>(["state"])?.items.find((x) => x.id === it.id);
        if (cur) patchItem(cur, { type: "inbox", title: it.title }).catch(() => {});
      },
    });
  }
  return (
    <div className={cx("group relative flex items-end justify-end gap-2 pt-7", ui.peek?.id === it.id && "[&_.bub]:ring-2 [&_.bub]:ring-ink/40")} data-iid={it.id}>
      <div className="absolute top-0 right-0 z-10 hidden items-center gap-0.5 rounded-lg bg-surface p-0.5 shadow-3 group-hover:flex">
        {TRIAGE.map(({ k, icon: Icon }) => (
          <button key={k} className={tool} title={`归到「${typeName(k)}」`} onClick={() => triage(k)}>
            <Icon style={{ color: `var(--${k})` }} />
            {typeName(k)}
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-line" />
        <button className={tool} title="改内容，或设置分类、标签、优先级后再归类" onClick={() => ui.openPeek(it.id, "edit")}>
          <Pencil />
          归类…
        </button>
        <button className={tool} title="追加到某篇笔记的末尾" onClick={() => openAppendToNote(it)}>
          <NotebookPen />
          追加到笔记
        </button>
        <button className={tool} title="在右侧打开" aria-label="在右侧打开" onClick={() => ui.openPeek(it.id)}>
          <PanelRight />
        </button>
        <button className={tool} title="复制文字" aria-label="复制文字" onClick={async () => say((await copyText([it.title, it.body].filter(Boolean).join("\n"))) ? "已复制" : "复制失败")}>
          <Copy />
        </button>
        <button
          className={tool + " hover:text-danger"}
          title="删除"
          aria-label="删除"
          onClick={async () => {
            await removeItem(it.id).catch(() => {});
            say("已删除", { label: "撤销", run: () => restoreItem(it) });
          }}
        >
          <Trash2 />
        </button>
      </div>
      <button
        aria-label={sel ? "取消选中" : "选中"}
        onClick={toggle}
        className={cx(
          "mb-5 grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] [&_svg]:size-3",
          sel ? "border-ink bg-ink text-on-ink" : "border-line text-transparent",
          !sel && !selecting && "opacity-0 group-hover:opacity-100",
        )}
      >
        <Check strokeWidth={3} />
      </button>
      <div className="flex max-w-[78%] min-w-0 flex-col items-end gap-1">
        <div
          className={cx("bub rounded-[16px] rounded-br-[6px] px-3.5 py-2.5 text-[14px] break-words", sel ? "bg-ink text-on-ink [&_.prose-x]:text-on-ink" : "bg-accent-soft text-fg")}
          onClick={(e) => selecting && !(e.target as HTMLElement).closest("a,img") && toggle()}
        >
          {showTitle && <div className="whitespace-pre-wrap">{it.title}</div>}
          {it.body && <Md src={it.body} className="!text-[14px] [&_img]:max-h-[280px]" />}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11.5px] text-faint">
          {it.priority && <Pri p={it.priority} />}
          {di && <span className={di.tone === "late" ? "text-danger" : di.tone === "soon" ? "text-warn" : ""}>{di.text}</span>}
          {(it.tags || []).map((t) => (
            <span key={t}>#{t}</span>
          ))}
          {it.device && <span>@{it.device}</span>}
          {it.category && <span>{it.category}</span>}
          <span>{hm(d)}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 微信消息 */

function WxImg({ asset, name }: { asset: string; name: string }) {
  const url = useAssetUrl(asset);
  const [big, setBig] = useState(false);
  if (!url) return <span className="text-xs text-faint">[图片] {name}</span>;
  return (
    <>
      <img src={url} alt={name} className="my-1 max-h-[260px] max-w-full cursor-zoom-in rounded-lg" onClick={(e) => (e.stopPropagation(), setBig(true))} />
      {big && <Lightbox src={url} onClose={() => setBig(false)} />}
    </>
  );
}

function WxLine({ line, atts }: { line: string; atts: Msg["attachments"] }) {
  const openAsset = useOpenAsset();
  const m = line.trim().match(/^\[([^\]]+)\]\s*(.+)$/);
  const a = m && (atts || []).find((x) => x.name === m[2].trim());
  if (!a) return <>{line}</>;
  if (a.missing)
    return (
      <span className="text-faint line-through" title="导出时没带上这个文件">
        📎 {a.name}
      </span>
    );
  if (a.kind === "image" && a.asset) return <WxImg asset={a.asset} name={a.name} />;
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (a.asset) openAsset(a.asset);
      }}
      className="text-accent underline-offset-2 hover:underline"
    >
      {a.kind === "video" ? "🎬" : "📎"} {a.name}
    </a>
  );
}

function WxMsg({ m, mine, sel, selecting, onClick }: { m: Msg; mine: boolean; sel: boolean; selecting: boolean; onClick: (e: React.MouseEvent) => void }) {
  const [, t] = String(m.time).split(" ");
  return (
    <div className={cx("group flex items-end gap-2", mine ? "justify-end" : "justify-start")} data-mid={m.id} onClick={(e) => !(e.target as HTMLElement).closest("a,img") && onClick(e)}>
      {mine && (
        <span className={cx("mb-1 grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] [&_svg]:size-3", sel ? "border-ink bg-ink text-on-ink" : "border-line text-transparent", !sel && !selecting && "opacity-0 group-hover:opacity-100")}>
          <Check strokeWidth={3} />
        </span>
      )}
      <div className={cx("flex max-w-[78%] min-w-0 flex-col gap-1", mine ? "items-end" : "items-start")}>
        <div className="text-[11.5px] text-faint">
          {m.sender} · {t}
        </div>
        <div
          className={cx(
            "cursor-pointer rounded-[16px] px-3.5 py-2.5 text-[14px] leading-relaxed break-words whitespace-pre-wrap",
            mine ? "rounded-br-[6px]" : "rounded-bl-[6px]",
            sel ? "bg-ink text-on-ink" : mine ? "bg-accent-soft" : "bg-surface-2",
          )}
        >
          {String(m.text || "")
            .split("\n")
            .map((l, i, all) => (
              <span key={i}>
                <WxLine line={l} atts={m.attachments} />
                {i < all.length - 1 && "\n"}
              </span>
            ))}
        </div>
      </div>
      {!mine && (
        <span className={cx("mb-1 grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] [&_svg]:size-3", sel ? "border-ink bg-ink text-on-ink" : "border-line text-transparent", !sel && !selecting && "opacity-0 group-hover:opacity-100")}>
          <Check strokeWidth={3} />
        </span>
      )}
    </div>
  );
}

const chatKey = (c?: Chat) => (c ? `${c.count}|${c.last?.time}|${c.readUpTo || ""}` : "");

/* ---------------------------------------------------------------- 右边：消息流 */

export function InboxMain() {
  const ui = useUi();
  const items = useAppState().data?.items ?? [];
  const devices = useDevices();
  const chatsQ = useChats();
  const chats = chatsQ.data ?? [];
  const me = useMe().data ?? [];
  const c = ui.ibx === "me" ? undefined : chats.find((x) => x.id === ui.ibx);
  // 聊天被删 / 合并了：回到随手记
  useEffect(() => {
    if (ui.ibx !== "me" && chatsQ.isSuccess && !c) ui.setIbx("me");
  }, [ui, c, chatsQ.isSuccess]);

  const [limit, setLimit] = useState(300);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const stream = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const want = useRef<"bottom" | "unread" | null>("bottom");
  useEffect(() => {
    setLimit(300);
    setQ("");
    setSel(new Set());
    anchor.current = null;
    want.current = ui.ibx === "me" ? "bottom" : "unread";
  }, [ui.ibx]);

  const msgsQ = useQuery({
    queryKey: ["msgs", c?.id, limit, chatKey(c)],
    queryFn: () => v1<{ messages: Msg[]; total: number }>("GET", `/inbox/messages?chat=${encodeURIComponent(c!.id)}&limit=${limit}`),
    enabled: !!c,
    placeholderData: (prev) => prev,
  });
  const msgs = c && msgsQ.data ? msgsQ.data.messages || [] : [];
  const lq = q.toLowerCase();
  const mine = useMemo(() => inboxItems(items).filter((i) => !lq || ((i.title || "") + "\n" + (i.body || "")).toLowerCase().includes(lq)), [items, lq]);
  const visible = useMemo(() => msgs.filter((m) => !lq || (m.sender + "\n" + m.text).toLowerCase().includes(lq)), [msgs, lq]);
  const unread = c ? msgs.filter((m) => !c.readUpTo || m.time > c.readUpTo) : [];

  // 滚动：打开会话时到最底部（聊天到「没处理过的」），在底部时有新消息跟着到底
  useLayoutEffect(() => {
    const st = stream.current;
    if (!st) return;
    if (want.current === "unread" && c && msgsQ.data) {
      const nw = st.querySelector("#ibx-new") as HTMLElement | null;
      st.scrollTop = nw ? nw.offsetTop - 40 : st.scrollHeight;
      want.current = null;
    } else if (want.current === "bottom" || stick.current) {
      st.scrollTop = st.scrollHeight;
      if (want.current === "bottom" && (!c || msgsQ.data)) want.current = null;
    }
  });
  // 图片加载完高度变了：在底部时继续贴底
  useEffect(() => {
    const st = stream.current;
    if (!st) return;
    const on = () => stick.current && (st.scrollTop = st.scrollHeight);
    st.addEventListener("load", on, true);
    return () => st.removeEventListener("load", on, true);
  }, []);

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const clickMsg = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const ids = visible.map((m) => m.id);
      let i = ids.indexOf(anchor.current),
        j = ids.indexOf(id);
      if (i >= 0 && j >= 0) {
        if (i > j) [i, j] = [j, i];
        setSel((s) => new Set([...s, ...ids.slice(i, j + 1)]));
        document.getSelection()?.removeAllRanges();
      }
    } else toggle(id);
    anchor.current = id;
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sel.size && !document.querySelector('[role="dialog"]')) setSel(new Set());
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [sel.size]);

  /* ---- 随手记的批量操作 ---- */
  async function bulk(k: ItemType | "merge" | "del") {
    const list = inboxItems(items).filter((i) => sel.has(i.id));
    if (!list.length) return;
    setSel(new Set());
    if (k === "del") {
      for (const it of list) await removeItem(it.id).catch(() => {});
      return say(`已删除 ${list.length} 条`);
    }
    if (k === "merge") {
      const first = list[0];
      const parts = list
        .map((it, i) => {
          const t = INBOX_AUTO.test(it.title || "") && it.body ? "" : it.title;
          return i === 0 ? it.body || "" : [t, it.body].filter(Boolean).join("\n");
        })
        .filter(Boolean);
      await patchItem(first, {
        type: "note",
        title: INBOX_AUTO.test(first.title || "") ? "整理的记录 " + nowLabel() : first.title,
        body: parts.join("\n\n"),
        tags: [...new Set(list.flatMap((i) => i.tags || []))],
      }).catch(() => {});
      for (const it of list.slice(1)) await removeItem(it.id).catch(() => {});
      return say(`${list.length} 条合成了一篇笔记`);
    }
    for (const it of list) await patchItem(it, { type: k }).catch(() => {});
    say(`${list.length} 条归到「${typeName(k)}」`);
  }

  /* ---- 微信消息操作 ---- */
  const selIds = () => msgs.filter((m) => sel.has(m.id)).map((m) => m.id);
  const mdOf = (ids: string[]) => v1Text("/inbox/markdown?ids=" + encodeURIComponent(ids.join(",")));
  async function markRead(time: string) {
    await v1("PATCH", "/inbox/chats/" + encodeURIComponent(c!.id), { readUpTo: time });
    await qc.invalidateQueries({ queryKey: ["chats"] });
  }
  async function wx(k: string) {
    if (!c) return;
    const ids = selIds();
    try {
      if (k === "selunread") return setSel(new Set(unread.map((m) => m.id)));
      if (k === "readall") {
        const l = msgs[msgs.length - 1];
        if (l) await markRead(l.time);
        return say("都标为已处理了");
      }
      if (!ids.length) return;
      if (k === "note" || k === "todo") {
        const it = await v1<Item>("POST", "/inbox/messages/to-item", { ids, type: k, markRead: true });
        setSel(new Set());
        await qc.invalidateQueries();
        if (k === "note") {
          ui.openPeek(it.id);
          say(`已存成笔记「${it.title}」，在右侧打开了`, { label: "撤销", run: () => (ui.closePeek(), removeItem(it.id).catch(() => {})) });
        } else say(`已转成待办「${it.title}」`, { label: "撤销", run: () => removeItem(it.id).catch(() => {}) });
        return;
      }
      if (k === "copy") return say((await copyText(await mdOf(ids))) ? `已复制 ${ids.length} 条消息（Markdown）` : "复制失败");
      if (k === "ai") {
        const md = (await mdOf(ids)).replace(/!?\[([^\]]*)\]\(asset:[^)]+\)/g, "[附件：$1]");
        const prompt = `下面是微信聊天「${c.name}」里的 ${ids.length} 条消息。请帮我整理：\n1. 讨论的要点和结论\n2. 需要我做的事（做什么、给谁、什么时候）\n3. 需要我回复或确认的问题\n\n${md}`;
        return openAgent({ id: "", type: "note", title: c.name, body: "", createdAt: 0, updatedAt: 0 }, prompt);
      }
      if (k === "readhere") {
        const lastT = msgs.filter((m) => sel.has(m.id)).map((m) => m.time).sort().pop()!;
        await markRead(lastT);
        setSel(new Set());
        return say("已标为处理到 " + shortTime(lastT));
      }
      if (k === "del") {
        await v1("POST", "/inbox/messages/delete", { ids });
        setSel(new Set());
        await qc.invalidateQueries({ queryKey: ["chats"] });
        await qc.invalidateQueries({ queryKey: ["msgs"] });
        return say(`已删除 ${ids.length} 条（再导入也不会回来）`);
      }
    } catch (e) {
      say(errText(e));
    }
  }

  /* ---- 流 ---- */
  let day = "";
  let divided = false;
  const rows: React.ReactNode[] = [];
  const dayRow = (d: string) => (
    <div key={"d" + d} className="my-2 self-center rounded-full bg-surface-2 px-3 py-0.5 text-xs text-muted">
      {dayLabel(d)}
    </div>
  );
  if (!c) {
    for (const it of mine) {
      const d = dateStr(new Date(it.createdAt || 0));
      if (d !== day) rows.push(dayRow((day = d)));
      rows.push(<MeMsg key={it.id} it={it} sel={sel.has(it.id)} selecting={sel.size > 0} toggle={() => toggle(it.id)} />);
    }
  } else {
    if (msgsQ.data && msgsQ.data.total > msgs.length && !q)
      rows.push(
        <Button key="more" tone="ghost" className="self-center" onClick={() => ((stick.current = false), setLimit(msgs.length + 300))}>
          显示更早的消息（还有 {msgsQ.data.total - msgs.length} 条）
        </Button>,
      );
    for (const m of visible) {
      const d = String(m.time).split(" ")[0];
      if (c.readUpTo && !divided && m.time > c.readUpTo) {
        divided = true;
        rows.push(
          <div key="new" id="ibx-new" className="my-2 flex justify-center">
            <span className="rounded-full bg-accent-soft px-3 py-0.5 text-xs text-accent-strong">以下是没处理过的消息</span>
          </div>,
        );
      }
      if (d !== day) rows.push(dayRow((day = d)));
      rows.push(<WxMsg key={m.id} m={m} mine={me.includes(m.sender)} sel={sel.has(m.id)} selecting={sel.size > 0} onClick={(e) => clickMsg(m.id, e)} />);
    }
  }
  const empty = c
    ? msgsQ.isLoading
      ? "正在读取…"
      : !visible.length
        ? q
          ? `没有找到「${q}」`
          : "这个聊天没有消息"
        : null
    : q && !mine.length
      ? `没有找到「${q}」`
      : null;

  const sub = c
    ? [`${c.count} 条`, c.unread ? `未处理 ${c.unread} 条` : "都处理过了", c.readUpTo ? `已处理到 ${shortTime(c.readUpTo)}` : ""].filter(Boolean).join(" · ")
    : mine.length
      ? `${inboxItems(items).length} 条待归类 · 鼠标移到消息上可以归类`
      : "发给自己的东西先放这里";

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-surface">
      <header className="flex items-center gap-2.5 px-5 pt-3.5 pb-2">
        <h1 className="truncate text-[16px] font-bold" title={c?.name}>
          {c ? c.name : "随手记"}
        </h1>
        <span className="truncate text-xs text-muted">{sub}</span>
        <span className="grow" />
        <label className="flex h-8 w-44 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 text-muted">
          <Search className="size-3.5" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="在这里找" aria-label="在这个会话里搜索" className="min-w-0 grow bg-transparent text-[13px] text-fg outline-none" />
        </label>
        {c && (
          <>
            <Button onClick={pickWechatZip} title="导入这个聊天新的导出">
              <Plus className="size-4" />
              导入
            </Button>
            <button
              aria-label="聊天设置"
              title="聊天设置"
              onClick={() => openChatSettings(c, [...new Set(msgs.map((m) => m.sender))], (id) => ui.setIbx(id || "me"))}
              className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg [&_svg]:size-4"
            >
              <Settings2 />
            </button>
          </>
        )}
      </header>
      <div
        ref={stream}
        onScroll={(e) => {
          const st = e.currentTarget;
          stick.current = st.scrollHeight - st.scrollTop - st.clientHeight < 60;
        }}
        className="scroll-quiet flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 py-4"
      >
        {rows}
        {empty && <div className="m-auto text-[13px] text-faint">{empty}</div>}
        {!c && !mine.length && !q && (
          <div className="m-auto flex flex-col items-center gap-1 text-center text-[13px] text-muted">
            <b className="text-[15px] text-fg">收件箱是空的</b>
            想到什么、截了什么图，直接在下面发进来。
            <br />
            之后再慢慢归到待办、问题、笔记里。
          </div>
        )}
      </div>
      <footer className="px-5 pt-2 pb-4">
        {sel.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            已选 <b>{sel.size}</b> 条<span className="grow" />
            {c ? (
              <>
                <Button tone="primary" onClick={() => wx("note")}>
                  <FileText className="size-4" />
                  存成笔记
                </Button>
                <Button onClick={() => wx("todo")}>
                  <SquareCheck className="size-4" />
                  转成待办
                </Button>
                <Button onClick={() => wx("copy")}>
                  <Copy className="size-4" />
                  复制 Markdown
                </Button>
                <Button onClick={() => wx("ai")}>
                  <Sparkles className="size-4" />
                  交给 AI
                </Button>
                <Button onClick={() => wx("readhere")} title="下次只看这之后的">
                  标为已处理
                </Button>
                <ConfirmButton confirm={`再点一次删除 ${sel.size} 条`} onConfirm={() => wx("del")}>
                  删除
                </ConfirmButton>
              </>
            ) : (
              <>
                {(["todo", "issue", "idea", "note"] as ItemType[]).map((k) => (
                  <Button key={k} onClick={() => bulk(k)}>
                    都归到{typeName(k)}
                  </Button>
                ))}
                <Button onClick={() => bulk("merge")} title="按时间顺序合成一篇笔记">
                  <FileText className="size-4" />
                  合成一篇笔记
                </Button>
                <ConfirmButton confirm={`再点一次删除 ${sel.size} 条`} onConfirm={() => bulk("del")}>
                  删除
                </ConfirmButton>
              </>
            )}
            <Button tone="ghost" onClick={() => setSel(new Set())}>
              取消
            </Button>
          </div>
        ) : c ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            点消息选中，按住 <kbd className="rounded border border-line px-1 text-xs">Shift</kbd> 连选；选好后可以转成笔记、待办，或交给 AI
            <span className="grow" />
            {unread.length > 0 && (
              <>
                <Button onClick={() => wx("selunread")}>选中未处理的 {unread.length} 条</Button>
                <Button tone="ghost" onClick={() => wx("readall")}>
                  全部标为已处理
                </Button>
              </>
            )}
          </div>
        ) : (
          <Composer devices={devices} onSent={() => (want.current = "bottom")} />
        )}
      </footer>
    </main>
  );
}

function Composer({ devices, onSent }: { devices: ReturnType<typeof useDevices>; onSent: () => void }) {
  const draft = useDrafts((s) => s.inbox);
  const d = useDrafts();
  const ui = useUi();
  const ta = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };
  useLayoutEffect(grow, [draft.text]);
  useEffect(() => {
    if (ui.view === "inbox") ta.current?.focus();
  }, [ui.capFocus, ui.view]);

  async function send() {
    const raw = draft.text.trim();
    if (draft.files.some((f) => f.uploading)) return say("截图还在保存，稍等一下");
    const files = draft.files.filter((f) => f.name);
    if (!raw && !files.length) return;
    const p = raw ? parseCapture(raw, "note", devices) : { title: "", body: "", tags: [] as string[], device: "", priority: "" as const, due: "" };
    if (!p.title) p.title = (files.some((f) => f.isImg) ? "截图 " : "附件 ") + nowLabel();
    else if (p.title.length > 60) {
      p.body = [p.title, p.body].filter(Boolean).join("\n");
      p.title = p.title.slice(0, 40) + "…";
    }
    const att = files.map((f) => assetMd(f.isImg, f.label, f.name!)).join("\n\n");
    if (att) p.body = [p.body, att].filter(Boolean).join("\n\n");
    const keep = { ...draft };
    d.clear("inbox");
    onSent();
    try {
      await addItem({ type: "inbox", title: p.title, body: p.body, tags: p.tags, device: p.device, ...(p.priority ? { priority: p.priority } : {}), ...(p.due ? { due: p.due } : {}) });
    } catch {
      d.restore("inbox", keep);
    }
    ta.current?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <PendingFiles box="inbox" />
      <div className="flex items-end gap-2 rounded-[14px] bg-surface-2/80 py-1.5 pr-1.5 pl-3.5 transition-shadow focus-within:bg-surface focus-within:shadow-2">
        <textarea
          ref={ta}
          id="xp-inbox-input"
          rows={1}
          value={draft.text}
          onChange={(e) => d.setText("inbox", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="想到什么、截个图，直接发进来，之后再归类…"
          aria-label="发到收件箱"
          className="scroll-quiet min-w-0 grow resize-none self-center bg-transparent py-1.5 text-[14.5px] leading-6 outline-none placeholder:text-faint"
        />
        <Button tone="primary" onClick={send} aria-label="发送">
          <Send className="size-4" />
          发送
        </Button>
      </div>
      <span className="text-xs text-faint">
        回车发送 · Shift+回车换行 · 截图直接 Ctrl+V · 也可以写 #标签 @设备 !1 ~明天
      </span>
    </div>
  );
}
