/* 导入微信聊天记录（多选消息 → 合并转发 → 导出的 ZIP）、聊天设置、追加到笔记 */
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errText, fileB64, v1 } from "../lib/api";
import { patchItem, qc, removeItem, useAppState, useChats, useMe } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { INBOX_AUTO, ago, byRecent, dayLabel, noteTitle, shortTime } from "../lib/logic";
import { ls, useUi } from "../lib/store";
import type { Bundle, Chat, Item, WxPreview } from "../lib/types";
import { Button, ConfirmButton, ErrorText, Field, inputCls } from "../components/ui";

const say = (t: string) => useUi.getState().say(t);
const NOT_WECHAT = "不是能认出来的微信聊天记录";

/** 返回 false 表示这不是微信导出（调用方按普通附件处理） */
export async function wxImportFile(file: File, onDone: (chatId: string) => void): Promise<boolean> {
  if (file.size > 500 * 1024 * 1024) {
    say("文件超过 500MB，请在微信里分几次导出");
    return true;
  }
  say("正在读取 " + file.name + "…");
  let data: string, pv: WxPreview;
  try {
    data = await fileB64(file);
    pv = await v1<WxPreview>("POST", "/inbox/wechat/preview", { data, name: file.name });
  } catch (e) {
    if (errText(e).includes(NOT_WECHAT)) return false;
    say(errText(e));
    return true;
  }
  useUi.setState({ toast: null });
  openDialog((close) => <ImportDialog name={file.name} data={data} pv={pv} close={close} onDone={onDone} />);
  return true;
}

async function saveMe(boxes: { name: string; on: boolean }[], me: string[]) {
  const next = [...new Set([...me.filter((n) => !boxes.some((b) => b.name === n && !b.on)), ...boxes.filter((b) => b.on).map((b) => b.name)])];
  if (next.join("\n") === me.join("\n")) return;
  const r = await v1<{ me: string[] }>("PUT", "/inbox/me", { me: next });
  qc.setQueryData(["me"], r.me || next);
}

function Senders({ list, value, onChange }: { list: { name: string; count?: number }[]; value: Record<string, boolean>; onChange: (v: Record<string, boolean>) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {list.map((s) => (
        <label key={s.name} className="inline-flex items-center gap-1.5 text-[13px] text-fg-2">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!value[s.name]} onChange={(e) => onChange({ ...value, [s.name]: e.target.checked })} />
          {s.name}
          {s.count != null && <span className="text-xs text-faint">{s.count}</span>}
        </label>
      ))}
    </div>
  );
}

function ImportDialog({ name, data, pv, close, onDone }: { name: string; data: string; pv: WxPreview; close: () => void; onDone: (id: string) => void }) {
  const chats = useChats().data ?? [];
  const me = useMe().data ?? [];
  const [chat, setChat] = useState(pv.suggestedChat || "");
  const [who, setWho] = useState<Record<string, boolean>>(() => Object.fromEntries((pv.senders || []).map((s) => [s.name, me.includes(s.name)])));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const d0 = String(pv.start).split(" ")[0],
    d1 = String(pv.end).split(" ")[0];
  async function go() {
    if (!chat.trim()) return setErr("起个聊天名");
    setBusy(true);
    setErr("");
    try {
      await saveMe(
        (pv.senders || []).map((s) => ({ name: s.name, on: !!who[s.name] })),
        me,
      );
      const r = await v1<{ chat: Chat; added: number; duplicates: number }>("POST", "/inbox/wechat/import", { data, name, chat: chat.trim() });
      close();
      await qc.invalidateQueries({ queryKey: ["chats"] });
      onDone(r.chat.id);
      say(r.added ? `已导入 ${r.added} 条新消息${r.duplicates ? `（${r.duplicates} 条以前导入过，已跳过）` : ""}` : "这些消息以前都导入过了");
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="导入微信聊天记录"
      desc={name}
      onClose={close}
      footer={
        <Button tone="primary" disabled={busy} onClick={go}>
          {busy ? "正在导入…" : "导入"}
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          [pv.count, "条消息"],
          [dayLabel(d0) + (d0 === d1 ? "" : " – " + dayLabel(d1)), "时间"],
          [pv.files, "个附件"],
        ].map(([v, l]) => (
          <div key={String(l)} className="rounded-xl bg-surface-2 px-2 py-2.5">
            <div className="text-[15px] font-bold">{v}</div>
            <div className="text-xs text-muted">{l}</div>
          </div>
        ))}
      </div>
      {pv.missing > 0 && <p className="text-xs text-muted">有 {pv.missing} 个附件导出时没带上（比如没下载的原图、视频），只会显示文件名。</p>}
      <Field
        label="存到哪个聊天"
        hint={
          pv.matchedChat
            ? `看起来是「${pv.matchedChat.name}」的后续${pv.matchedChat.duplicates ? `，其中 ${pv.matchedChat.duplicates} 条已经导入过，会自动跳过` : ""}。`
            : "微信导出里没有群名，起个名字方便以后找；和已有的聊天同名就会合并进去，重复的消息自动跳过。"
        }
      >
        <input
          autoFocus
          className={inputCls}
          value={chat}
          onChange={(e) => setChat(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && go()}
          list="xp-chats"
          placeholder="比如：项目群、张三"
        />
      </Field>
      <datalist id="xp-chats">
        {chats.map((c) => (
          <option key={c.id} value={c.name} />
        ))}
      </datalist>
      <div className="flex flex-col gap-2 text-[12.5px] text-muted">
        哪些是我（显示在右边，以后自动记住）
        <Senders list={pv.senders || []} value={who} onChange={setWho} />
      </div>
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}

/* ---- 聊天设置：改名 / 合并、谁是我、导入记录、删除 ---- */
export function openChatSettings(c: Chat, senders: string[], onChange: (id: string | null) => void) {
  openDialog((close) => <ChatSettings c={c} senders={senders} close={close} onChange={onChange} />);
}

function ChatSettings({ c, senders, close, onChange }: { c: Chat; senders: string[]; close: () => void; onChange: (id: string | null) => void }) {
  const chats = useChats().data ?? [];
  const me = useMe().data ?? [];
  const [name, setName] = useState(c.name);
  const [who, setWho] = useState<Record<string, boolean>>(() => Object.fromEntries(senders.map((s) => [s, me.includes(s)])));
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    v1<{ bundles: Bundle[] }>("GET", `/inbox/chats/${encodeURIComponent(c.id)}/bundles`).then(
      (r) => setBundles(r.bundles || []),
      () => setBundles([]),
    );
  }, [c.id]);
  async function save() {
    try {
      await saveMe(
        senders.map((s) => ({ name: s, on: !!who[s] })),
        me,
      );
      let id = c.id;
      if (name.trim() && name.trim() !== c.name) {
        const r = await v1<{ id: string; name: string }>("PATCH", "/inbox/chats/" + encodeURIComponent(c.id), { name: name.trim() });
        id = r.id;
        if (id !== c.id) say(`已并入「${r.name}」`);
      }
      close();
      await qc.invalidateQueries({ queryKey: ["chats"] });
      await qc.invalidateQueries({ queryKey: ["msgs"] });
      onChange(id);
    } catch (e) {
      setErr(errText(e));
    }
  }
  return (
    <Dialog
      title="聊天设置"
      onClose={close}
      footer={
        <>
          <Button tone="primary" onClick={save}>
            保存
          </Button>
          <span className="grow" />
          <ConfirmButton
            confirm={`再点一次删除（${c.count} 条消息）`}
            onConfirm={async () => {
              try {
                await v1("DELETE", "/inbox/chats/" + encodeURIComponent(c.id));
                close();
                await qc.invalidateQueries({ queryKey: ["chats"] });
                onChange(null);
                say("已删除");
              } catch (e) {
                setErr(errText(e));
              }
            }}
          >
            删除这个聊天
          </ConfirmButton>
        </>
      }
    >
      <Field label="聊天名（改成已有的名字就会合并过去）">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} list="xp-chats-set" />
      </Field>
      <datalist id="xp-chats-set">
        {chats
          .filter((x) => x.id !== c.id)
          .map((x) => (
            <option key={x.id} value={x.name} />
          ))}
      </datalist>
      {senders.length > 0 && (
        <div className="flex flex-col gap-2 text-[12.5px] text-muted">
          哪些是我（显示在右边）
          <Senders list={senders.map((name) => ({ name }))} value={who} onChange={setWho} />
        </div>
      )}
      <div className="flex flex-col gap-1 text-[12.5px] text-muted">
        导入记录
        {bundles === null ? (
          <span className="text-faint">读取中…</span>
        ) : bundles.length ? (
          bundles.map((b, i) => (
            <span key={i} className="text-xs text-faint">
              {new Date(b.importedAt).toLocaleString()} · {b.fileName || ""} · {shortTime(b.start)} – {shortTime(b.end)} · {b.total} 条，新增 {b.added} 条
              {(b.files || []).length ? ` · 另有 ${b.files!.length} 个文件` : ""}
            </span>
          ))
        ) : (
          <span className="text-faint">无</span>
        )}
      </div>
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}

/* ---- 收件箱：追加到笔记 ---- */
export function openAppendToNote(it: Item) {
  openDialog((close) => <AppendDialog it={it} close={close} />);
}

function AppendDialog({ it, close }: { it: Item; close: () => void }) {
  const items = useAppState().data?.items ?? [];
  const [q, setQ] = useState("");
  const recent: string[] = (() => {
    try {
      return JSON.parse(ls.get("wb-appendto") || "[]");
    } catch {
      return [];
    }
  })();
  const notes = items
    .filter((i) => i.type === "note" && (!q || (noteTitle(i) + "\n" + (i.body || "")).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => {
      const ia = recent.indexOf(a.id),
        ib = recent.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || byRecent(a, b);
    })
    .slice(0, 30);
  async function pick(n: Item) {
    const title = INBOX_AUTO.test(it.title || "") && it.body ? "" : it.title;
    const add = [title, it.body].filter(Boolean).join("\n\n");
    close();
    try {
      await patchItem(n, { body: [(n.body || "").trimEnd(), add].filter(Boolean).join("\n\n") });
      await removeItem(it.id);
      ls.set("wb-appendto", JSON.stringify([n.id, ...recent.filter((x) => x !== n.id)].slice(0, 8)));
      say(`已追加到「${noteTitle(n)}」`);
    } catch {
      /* 数据层已提示 */
    }
  }
  return (
    <Dialog title="追加到笔记" desc="这条内容（文字和截图）会接在所选笔记的末尾，然后从收件箱移走。" onClose={close}>
      <label className="flex h-9 items-center gap-2 rounded-[10px] bg-surface-2/70 px-3 text-muted">
        <Search className="size-4" />
        <input autoFocus className="min-w-0 grow bg-transparent text-fg outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder="找笔记" aria-label="找笔记" />
      </label>
      <div className="flex flex-col">
        {notes.map((n) => (
          <button key={n.id} onClick={() => pick(n)} className="flex flex-col rounded-lg px-3 py-2 text-left hover:bg-surface-2">
            <b className="text-[13.5px]">{noteTitle(n)}</b>
            <span className="text-xs text-muted">
              {recent.includes(n.id) ? "最近用过 · " : ""}
              {n.category || ""} {ago(n.updatedAt)}
            </span>
          </button>
        ))}
        {!notes.length && <div className="py-4 text-center text-[13px] text-faint">没有找到笔记</div>}
      </div>
    </Dialog>
  );
}
