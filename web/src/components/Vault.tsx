/* 密码库：左边是条目列表，右边看和改一条。加解密在 lib/vault.ts，主机只有密文。
   三种状态：还没设主密码 → 设置；锁着 → 输主密码；解开 → 列表。十分钟不碰自动锁上，刷新页面也会锁上。 */
import { useQuery } from "@tanstack/react-query";
import { Copy, Dices, Eye, EyeOff, Globe, KeyRound, KeySquare, Lock, NotebookPen, Pencil, Pin, Plus, Search, Server, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText, errText, newId } from "../lib/api";
import { qc } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { ago } from "../lib/logic";
import { useUi } from "../lib/store";
import {
  KINDS,
  VAULT_KEY,
  approveRequest,
  changePassword,
  createVault,
  deleteSecret,
  denyRequest,
  fetchRequests,
  fetchVault,
  generatePassword,
  kindName,
  openSecret,
  saveSecret,
  strength,
  unlock,
  unwrapAll,
  useVault,
  useVaultUi,
  type AnyKind,
  type Extra,
  type Fields,
  type KeyRec,
  type OpenedKeys,
  type SecretKind,
  type SecretRec,
  type VaultRequest,
} from "../lib/vault";
import { parseSecret } from "../lib/vaultParse";
import { bumpUsage, domainOf, recentEntries, searchVault, titleOf, type Entry } from "../lib/vaultSearch";
import { cx } from "../lib/cx";
import { Button, Chip, ErrorText, Field, IconButton, Segmented, Toggle, inputCls, textareaCls } from "./ui";

const say = (t: string) => useUi.getState().say(t);
export const KIND_ICON: Record<AnyKind, typeof Globe> = { login: Globe, apikey: KeySquare, server: Server, other: StickyNote, raw: NotebookPen };
/** 每种条目里各个栏叫什么；没列的栏这种条目不用 */
const LABELS: Record<SecretKind, { url: string; username: string; password: string; urlHint: string }> = {
  login: { url: "网址", username: "用户名", password: "密码", urlHint: "https://…" },
  apikey: { url: "服务或网址（可选）", username: "账号（可选）", password: "Key / Token", urlHint: "" },
  server: { url: "地址", username: "用户名", password: "密码", urlHint: "主机名或 IP，可以带端口" },
  other: { url: "网址或地方（可选）", username: "账号（可选）", password: "要保密的内容", urlHint: "" },
};

export const useVaultState = (enabled = true) => useQuery({ queryKey: VAULT_KEY, queryFn: fetchVault, enabled });

/** 主密码输入框：不让浏览器记住它 */
export function MasterInput({ value, onChange, placeholder, autoFocus, onEnter, label }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; onEnter?: () => void; label: string }) {
  return (
    <input
      type="password"
      autoComplete="off"
      data-1p-ignore
      data-lpignore="true"
      aria-label={label}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
      placeholder={placeholder}
      className={inputCls + " h-10"}
    />
  );
}

function Card({ icon, title, desc, children }: { icon: ReactNode; title: string; desc: ReactNode; children: ReactNode }) {
  return (
    <main className="grid min-w-0 flex-1 place-items-center overflow-y-auto rounded-[18px] bg-surface p-6">
      <div className="flex w-full max-w-[420px] flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-2 [&_svg]:size-6">{icon}</span>
          <h1 className="text-[18px] font-bold">{title}</h1>
          <p className="text-[13px] leading-relaxed text-muted">{desc}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

function Strength({ p }: { p: string }) {
  if (!p) return null;
  const s = strength(p);
  return (
    <span className={cx("text-xs", s === 0 ? "text-danger" : s === 1 ? "text-warn-fg" : "text-muted")}>
      {s === 0 ? "太短或太好猜：至少 12 个字符，不要纯数字，不要 password、1234、qwer 这类常见写法" : s === 1 ? "可以用。再长一些（比如一句 20 个字符以上的话）会更难猜" : "够强"}
    </span>
  );
}

/** 第一次用：设主密码 */
function Setup() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = strength(a) > 0 && a === b && sure;
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    try {
      await createVault(a);
    } catch (e) {
      setErr(errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
      setBusy(false);
    }
  };
  return (
    <Card
      icon={<KeyRound />}
      title="设置密码库"
      desc={
        <>
          网站账号、API key、服务器登录信息都用一个主密码加密后再保存。
          <br />
          主机上、备份里、外置硬盘上只有密文。
        </>
      }
    >
      <Field label="主密码" hint={<Strength p={a} />}>
        <MasterInput label="主密码" value={a} onChange={setA} autoFocus />
      </Field>
      <Field label="再输一遍" hint={b && a !== b ? <span className="text-danger">两次输的不一样</span> : undefined}>
        <MasterInput label="再输一遍主密码" value={b} onChange={setB} onEnter={go} />
      </Field>
      <Toggle checked={sure} onChange={setSure}>
        我知道：主密码不保存在任何地方，忘了就打不开，没有找回的办法
      </Toggle>
      <ErrorText>{err}</ErrorText>
      <Button tone="primary" className="h-10 justify-center" disabled={!ok || busy} onClick={go}>
        {busy ? "正在生成密钥…" : "创建密码库"}
      </Button>
    </Card>
  );
}

/** 锁着：输主密码 */
function Locked({ keys, count }: { keys: KeyRec[]; count: number }) {
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    if (!p || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(keys, p);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Card icon={<Lock />} title="密码库锁着" desc={count ? `里面有 ${count} 条。输入主密码解锁，十分钟不用会自动锁上。` : "输入主密码解锁。"}>
      <MasterInput label="主密码" value={p} onChange={setP} onEnter={go} autoFocus placeholder="主密码" />
      <ErrorText>{err}</ErrorText>
      <Button tone="primary" className="h-10 justify-center" disabled={!p || busy} onClick={go}>
        {busy ? "正在解锁…" : "解锁"}
      </Button>
    </Card>
  );
}

function openChangePassword(keys: KeyRec[]) {
  openDialog((close) => <ChangePassword keys={keys} close={close} />);
}
function ChangePassword({ keys, close }: { keys: KeyRec[]; close: () => void }) {
  const [old, setOld] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = !!old && strength(a) > 0 && a === b;
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr("");
    try {
      await changePassword(keys, old, a);
      say("主密码已经改了");
      close();
    } catch (e) {
      setErr(errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="改主密码"
      desc="条目不用重新加密，马上生效。别的电脑合并或同步到这次修改之后，也要用新的主密码。以前的备份还是用当时的主密码。"
      onClose={close}
      footer={
        <>
          <Button tone="primary" disabled={!ok || busy} onClick={go}>
            {busy ? "正在修改…" : "修改"}
          </Button>
          <Button onClick={close}>取消</Button>
        </>
      }
    >
      <Field label="现在的主密码">
        <MasterInput label="现在的主密码" value={old} onChange={setOld} autoFocus />
      </Field>
      <Field label="新的主密码" hint={<Strength p={a} />}>
        <MasterInput label="新的主密码" value={a} onChange={setA} />
      </Field>
      <Field label="再输一遍" hint={b && a !== b ? <span className="text-danger">两次输的不一样</span> : undefined}>
        <MasterInput label="再输一遍新的主密码" value={b} onChange={setB} onEnter={go} />
      </Field>
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 看一条 */

/** 一栏：悬停时右边浮出复制（和显示 / 隐藏） */
function Row({ label, value, secret, mono = true, onCopied }: { label: string; value?: string; secret?: boolean; mono?: boolean; onCopied?: () => void }) {
  const [show, setShow] = useState(false);
  if (!value) return null;
  const masked = secret && !show;
  return (
    <div className="group relative flex flex-col gap-0.5 rounded-xl px-3.5 py-2.5 hover:bg-surface-2">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx("min-h-5 pr-16 text-[14px] break-all whitespace-pre-wrap text-fg", mono && "font-mono", masked && "tracking-[0.2em] select-none")}>{masked ? "••••••••••••" : value}</span>
      <span className="absolute top-2 right-2 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {secret && (
          <IconButton label={show ? "隐藏" : "显示"} onClick={() => setShow(!show)}>
            {show ? <EyeOff /> : <Eye />}
          </IconButton>
        )}
        <IconButton
          label={"复制" + label}
          onClick={async () => {
            const ok = await copyText(value);
            say(ok ? `已复制${label}` : "复制失败");
            if (ok) onCopied?.();
          }}
        >
          <Copy />
        </IconButton>
      </span>
    </div>
  );
}

function Detail({ s, f, hasKey, keys, onEdit, onDeleted }: { s: SecretRec; f: Fields | null; hasKey: boolean; keys: KeyRec[]; onEdit: () => void; onDeleted: () => void }) {
  const kind = f?.kind ?? s.kind;
  const raw = kind === "raw";
  const L = LABELS[kind === "raw" ? "other" : kind] ?? LABELS.login;
  const [sure, setSure] = useState(false);
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const Icon = KIND_ICON[kind] ?? Globe;
  const used = () => bumpUsage(s.id);
  const del = async () => {
    if (!sure) return setSure(true);
    try {
      await deleteSecret(s);
      say(`已删除「${f?.title ?? s.title}」`);
      onDeleted();
    } catch (e) {
      say("删除失败：" + errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
    }
  };
  const other = async () => {
    setBusy(true);
    setErr("");
    try {
      await unlock(keys, p);
      setP("");
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };
  const pin = async () => {
    if (!f || raw) return;
    const { title, kind: k, raw: _r, ...rest } = f;
    void _r;
    try {
      await saveSecret(s, s.id, { ...rest, title, kind: k as SecretKind, pinned: !f.pinned || undefined });
    } catch (e) {
      say("没存上：" + errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
    }
  };
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-7">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <div className="flex items-start gap-3 px-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg-2 [&_svg]:size-5">
            <Icon />
          </span>
          <div className="flex min-w-0 grow flex-col">
            <h1 className="text-[20px] leading-tight font-bold break-words">{f?.title ?? s.title}</h1>
            <span className="text-xs text-muted">
              {kindName(kind)} · {ago(s.updatedAt)}
              {raw ? "记的" : "改的"}
            </span>
          </div>
          {f && !raw && (
            <IconButton label={f.pinned ? "取消置顶" : "置顶"} className={f.pinned ? "text-accent" : ""} onClick={pin}>
              <Pin />
            </IconButton>
          )}
          {f && (
            <>
              <Button tone={raw ? "primary" : "soft"} onClick={onEdit}>
                <Pencil className="size-4" />
                {raw ? "整理" : "编辑"}
              </Button>
              <Button tone="danger" onClick={del} onBlur={() => setSure(false)}>
                <Trash2 className="size-4" />
                {sure ? "再点一次删除" : "删除"}
              </Button>
            </>
          )}
        </div>
        {f && !raw && (f.title !== s.title || f.kind !== s.kind) && (
          <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-warn-fg">
            主机上给这一条登记的名称是「{s.title}」，和加密保存的不一样；上面显示的是加密保存的。合并时另存的旧版本会这样。不是那种情况的话，说明有人改过主机上的数据，留意一下。
          </p>
        )}
        {f && raw ? (
          <div className="flex flex-col gap-2">
            <Row label="记下来的原文" value={f.raw} onCopied={used} />
            <p className="px-3.5 text-[13px] leading-relaxed text-muted">这是随手记下的，还没分成账号、密码各栏。点「整理」会先帮你拆好，看一眼没问题就保存；原文会留在一个平时隐藏的栏里。不整理也能在搜索里找到它。</p>
          </div>
        ) : f ? (
          <div className="flex flex-col gap-0.5">
            {!!f.tags?.length && (
              <div className="flex flex-wrap gap-1.5 px-3.5 pb-1.5">
                {f.tags.map((t) => (
                  <Chip key={t}>#{t}</Chip>
                ))}
              </div>
            )}
            <Row label={L.url} value={f.url} onCopied={used} />
            <Row label={L.username} value={f.username} onCopied={used} />
            <Row label={L.password} value={f.password} secret onCopied={used} />
            {(f.extra ?? []).map((x, i) => (
              <Row key={i} label={x.label || "其他"} value={x.value} secret={x.hidden} onCopied={used} />
            ))}
            <Row label="备注" value={f.notes} mono={false} />
            {!f.url && !f.username && !f.password && !f.notes && !(f.extra ?? []).length && <p className="px-3.5 text-[13px] text-faint">这一条还没填内容</p>}
          </div>
        ) : hasKey ? (
          <p className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-danger">这一条解不开：内容坏了，或者被人改过。上面的名称是主机上登记的，不一定是真的。可以从备份里找回（见密码库说明的「出问题时」）。</p>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-4">
            <p className="text-[13px] leading-relaxed text-fg-2">这一条现在的主密码解不开：它是用另一个主密码加密的（两台电脑各自设过主密码，后来合并到了一起）。输入当时那个主密码就能解开。</p>
            <div className="flex gap-2">
              <MasterInput label="另一个主密码" value={p} onChange={setP} onEnter={other} placeholder="另一个主密码" />
              <Button tone="primary" className="h-10" disabled={!p || busy} onClick={other}>
                {busy ? "正在解开…" : "解开"}
              </Button>
            </div>
            <ErrorText>{err}</ErrorText>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 新建、编辑、整理 */

function SecretInput({ value, onChange, label, placeholder, gen }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string; gen?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <span className={cx(inputCls, "flex items-center gap-1 pr-1")}>
      <input
        type={show ? "text" : "password"}
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 grow bg-transparent font-mono outline-none"
      />
      {gen && (
        <IconButton
          label="生成一个随机密码（20 位）"
          className="size-7"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
        >
          <Dices />
        </IconButton>
      )}
      <IconButton label={show ? "隐藏" : "显示"} className="size-7" onClick={() => setShow(!show)}>
        {show ? <EyeOff /> : <Eye />}
      </IconButton>
    </span>
  );
}

const NAME_HINT: Record<SecretKind, string> = { login: "比如 GitHub", apikey: "比如 OpenAI API key", server: "比如 家里的 Linux 主机", other: "比如 微信支付恢复码" };

/** old 是开始编辑时的那一版（新建时没有），latest 是它现在在主机上的样子。
    别处在这期间改了或删了，保存时主机会拿 old 来比、拒绝，这里提前说出来，不会悄悄盖掉别处的修改。
    raw 有值 = 在整理一条随手记下的：init 是从原文里拆出来的，原文放在上面对照 */
function Editor({ old, latest, init, raw, allTags, onDone, onCancel }: { old: SecretRec | null; latest: SecretRec | null; init: Fields | null; raw?: string; allTags: string[]; onDone: (s: SecretRec) => void; onCancel: () => void }) {
  const [id] = useState(newId);
  const moved = !!old && latest?.updatedAt !== old.updatedAt;
  const [kind, setKind] = useState<SecretKind>(init && init.kind !== "raw" ? init.kind : "login");
  const [title, setTitle] = useState(init?.title ?? "");
  const [f, setF] = useState<Partial<Fields>>(init ?? {});
  const [tags, setTags] = useState((init?.tags ?? []).join(" "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const L = LABELS[kind];
  const set = (ch: Partial<Fields>) => setF((x) => ({ ...x, ...ch }));
  const name = title.trim();
  const extra = f.extra ?? [];
  const setExtra = (i: number, ch: Partial<Extra>) => set({ extra: extra.map((x, j) => (j === i ? { ...x, ...ch } : x)) });
  const tagList = [...new Set(tags.split(/[\s,，#]+/).filter(Boolean))];
  const save = async () => {
    if (!title.trim()) return setErr("先填名称");
    setBusy(true);
    setErr("");
    const clean = {
      title: name,
      kind,
      url: f.url?.trim() || undefined,
      username: f.username?.trim() || undefined,
      password: f.password || undefined,
      notes: f.notes?.trim() || undefined,
      extra: extra.some((x) => x.value) ? extra.filter((x) => x.value).map((x) => ({ label: x.label.trim(), value: x.value, ...(x.hidden ? { hidden: true } : {}) })) : undefined,
      tags: tagList.length ? tagList : undefined,
      pinned: f.pinned || undefined,
    };
    try {
      onDone(await saveSecret(old, id, clean));
      say(raw != null ? `整理好了：「${name}」` : old ? "已保存" : `已存进密码库：「${name}」`);
    } catch (e) {
      setErr(errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
      setBusy(false);
    }
  };
  const unused = allTags.filter((t) => !tagList.includes(t)).slice(0, 12);
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col overflow-y-auto p-7">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        <h1 className="text-[18px] font-bold">{raw != null ? "整理" : old ? "编辑" : "新建"}</h1>
        {raw != null && (
          <div className="flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3">
            <span className="text-xs text-muted">记下来的原文（下面是自动拆出来的，不对的地方改一下）</span>
            <span className="font-mono text-[13.5px] break-all whitespace-pre-wrap text-fg">{raw}</span>
          </div>
        )}
        {(!old || raw != null) && <Segmented label="种类" value={kind} onChange={setKind} options={KINDS.map((k) => [k.k, k.name] as [SecretKind, string])} />}
        <Field label="名称" hint="名称不加密：锁着的时候和给 AI 的列表里都看得到，别把密码写在这里">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder={NAME_HINT[kind]} />
        </Field>
        <Field label={L.url}>
          <input className={inputCls + " font-mono"} value={f.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder={L.urlHint} autoComplete="off" />
        </Field>
        <Field label={L.username}>
          <input className={inputCls + " font-mono"} value={f.username ?? ""} onChange={(e) => set({ username: e.target.value })} autoComplete="off" data-1p-ignore data-lpignore="true" />
        </Field>
        <Field label={L.password}>
          <SecretInput label={L.password} value={f.password ?? ""} onChange={(v) => set({ password: v })} gen={kind === "login" || kind === "server"} />
        </Field>
        {extra.map((x, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-[150px] shrink-0">
              <input className={inputCls} value={x.label} onChange={(e) => setExtra(i, { label: e.target.value })} placeholder="叫什么" aria-label="字段名" />
            </span>
            {x.hidden ? (
              <SecretInput label={x.label || "内容"} value={x.value} onChange={(v) => setExtra(i, { value: v })} placeholder="内容" />
            ) : (
              <input className={inputCls + " font-mono"} value={x.value} onChange={(e) => setExtra(i, { value: e.target.value })} placeholder="内容" aria-label={x.label || "内容"} autoComplete="off" />
            )}
            <IconButton label={x.hidden ? "改成平时显示" : "改成平时隐藏"} onClick={() => setExtra(i, { hidden: !x.hidden })}>
              {x.hidden ? <EyeOff /> : <Eye />}
            </IconButton>
            <IconButton label="去掉这一栏" onClick={() => set({ extra: extra.filter((_, j) => j !== i) })}>
              <X />
            </IconButton>
          </div>
        ))}
        <div>
          <Button tone="ghost" onClick={() => set({ extra: [...extra, { label: "", value: "", hidden: true }] })}>
            <Plus className="size-4" />
            加一栏（比如端口、数据库名、私钥、恢复码）
          </Button>
        </div>
        <Field
          label="标签（空格分开）"
          hint={
            unused.length ? (
              <span className="flex flex-wrap gap-1.5">
                {unused.map((t) => (
                  <Chip key={t} onClick={() => setTags((v) => (v.trim() ? v.trim() + " " : "") + t)}>
                    #{t}
                  </Chip>
                ))}
              </span>
            ) : undefined
          }
        >
          <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="比如 工作 服务器" aria-label="标签" autoComplete="off" />
        </Field>
        <Field label="备注">
          <textarea className={textareaCls} rows={4} value={f.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <ErrorText>{moved ? "这一条在别处刚改过（或者被删了）。这里的修改存不进去：先把要留的内容复制出来，点取消，再重新编辑。" : err}</ErrorText>
        <div className="flex gap-2">
          <Button tone="primary" disabled={busy || moved} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </Button>
          <Button onClick={onCancel}>取消</Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 整页 */

type Filter = "all" | "raw" | SecretKind;

function ListRow({ e, on, locked, onPick }: { e: Entry; on: boolean; locked: string; onPick: () => void }) {
  const { s, f } = e;
  const Icon = KIND_ICON[f?.kind ?? s.kind] ?? Globe;
  const sub = !f ? locked : f.kind === "raw" ? (f.raw ?? "").replace(/\s+/g, " ").slice(0, 60) : f.username || domainOf(f.url) || kindName(f.kind);
  return (
    <button aria-current={on ? "true" : undefined} onClick={onPick} className={cx("flex shrink-0 items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors", on ? "bg-surface-3" : "hover:bg-surface-2")}>
      <Icon className={cx("size-[18px] shrink-0", f?.kind === "raw" ? "text-accent" : "text-muted")} strokeWidth={1.8} />
      <span className="flex min-w-0 grow flex-col">
        <span className="truncate text-[14px] font-semibold">
          {f?.pinned && <Pin className="mr-1 inline size-3.5 text-accent" />}
          {titleOf(e)}
        </span>
        <span className="truncate font-mono text-xs text-muted">{sub}</span>
      </span>
    </button>
  );
}

export function Vault() {
  const { data, error, isLoading } = useVaultState();
  const vks = useVault((s) => s.vks);
  const lock = useVault((s) => s.lock);
  const touch = useVault((s) => s.touch);
  const sel = useVaultUi((s) => s.sel);
  const setSel = useVaultUi((s) => s.setSel);
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tag, setTag] = useState<string | null>(null);

  const secrets = data?.secrets ?? [];
  // 解开的内容只留在内存里，锁上就没了
  const entries = useMemo<Entry[]>(() => secrets.map((s) => ({ s, f: openSecret(s, vks) })), [secrets, vks]);
  const opened = useMemo(() => new Map(entries.map((e) => [e.s.id, e.f])), [entries]);
  const kindOf = (e: Entry) => e.f?.kind ?? e.s.kind;
  const rawCount = entries.filter((e) => kindOf(e) === "raw").length;
  const allTags = useMemo(() => [...new Set(entries.flatMap((e) => e.f?.tags ?? []))].sort((a, b) => a.localeCompare(b)), [entries]);
  const pool = entries.filter((e) => (filter === "all" || kindOf(e) === filter) && (!tag || e.f?.tags?.includes(tag)));
  const searching = !!q.trim();
  const shown = searchVault(pool, q);
  // 不搜索、不筛选时分几段：待整理、置顶、最近用过，然后是全部
  const sections = ((): [string, Entry[]][] => {
    if (searching || filter !== "all" || tag) return [["", shown]];
    const raws = shown.filter((e) => kindOf(e) === "raw");
    const pinned = shown.filter((e) => e.f?.pinned);
    const recent = recentEntries(shown.filter((e) => kindOf(e) !== "raw" && !e.f?.pinned));
    const rest = shown.filter((e) => kindOf(e) !== "raw" && !e.f?.pinned && !recent.includes(e));
    const top: [string, Entry[]][] = [
      ["待整理", raws],
      ["置顶", pinned],
      ["最近用过", recent],
    ];
    return [...top, [top.some((x) => x[1].length) ? "其他" : "", rest] as [string, Entry[]]].filter((x) => x[1].length);
  })();
  const cur = secrets.find((s) => s.id === sel) ?? null;
  // 正在编辑的那一条：进编辑时记下来，之后列表刷新、甚至这一条在别处被删了，编辑器都不动（由它自己提示）
  const [editing, setEditing] = useState<{ s: SecretRec; f: Fields; raw?: string } | null>(null);
  const stopEdit = () => {
    setEditing(null);
    setMode("view");
  };
  // 锁上时把正在编辑的内容也丢掉：解开的东西不留在内存里，解锁后也不会拿着旧内容接着存
  useEffect(() => {
    if (!vks) stopEdit();
  }, [vks]);
  // 从别处（全局搜索）跳过来看某一条：退出编辑
  useEffect(() => {
    if (sel) setMode((m) => (m === "new" ? "view" : m));
  }, [sel]);

  if (isLoading && !data) return <main className="grid min-w-0 flex-1 place-items-center rounded-[18px] bg-surface text-sm text-muted">加载中…</main>;
  if (error || !data)
    return (
      <main className="grid min-w-0 flex-1 place-items-center rounded-[18px] bg-surface p-6 text-center text-sm text-muted">
        <div className="flex flex-col items-center gap-3">
          打不开密码库：{errText(error)}
          <br />
          密码库存在主机上，连不上主机时用不了。
          <Button onClick={() => qc.invalidateQueries({ queryKey: VAULT_KEY })}>重试</Button>
        </div>
      </main>
    );
  if (!data.keys.length) return <Setup />;
  if (!vks) return <Locked keys={data.keys} count={secrets.length} />;

  const chip = (on: boolean) => cx("rounded-lg px-2.5 py-1 text-[12.5px] transition-colors", on ? "bg-surface-3 font-medium text-fg" : "text-muted hover:bg-surface-2");
  const startEdit = (s: SecretRec) => {
    const f = opened.get(s.id);
    if (!f) return;
    // 待整理的：先从原文里拆出各栏，原文放进备注留底
    setEditing(f.kind === "raw" ? { s, f: parseSecret(f.raw ?? ""), raw: f.raw ?? "" } : { s, f });
    setMode("edit");
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-5" onPointerDown={touch} onKeyDown={touch}>
      <section aria-label="密码库" className="flex w-[340px] shrink-0 flex-col gap-3.5 max-[1200px]:w-[290px]">
        <label className="flex h-[42px] shrink-0 items-center gap-2 rounded-xl bg-surface-2 px-3.5 text-muted">
          <Search className="size-4" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜名称、网址、用户名、标签…" aria-label="搜索密码库" className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint" />
          <kbd className="shrink-0 rounded-md bg-surface-3 px-1.5 text-[11px] text-muted" title="在任何页面按 Ctrl+K 都能搜密码库">
            Ctrl K
          </kbd>
        </label>
        <div className="flex items-center gap-1.5 px-1">
          <h1 className="truncate text-[19px] font-bold">密码库</h1>
          <span className="text-xs text-muted">{secrets.length || ""}</span>
          <span className="grow" />
          <IconButton label="改主密码" onClick={() => openChangePassword(data.keys)}>
            <KeyRound />
          </IconButton>
          <IconButton
            label="锁上"
            onClick={() => {
              lock();
              say("密码库锁上了");
            }}
          >
            <Lock />
          </IconButton>
          <Button
            tone="primary"
            onClick={() => {
              setSel(null);
              setMode("new");
            }}
          >
            <Plus className="size-4" />
            新建
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-1">
          <button aria-pressed={filter === "all" && !tag} onClick={() => (setFilter("all"), setTag(null))} className={chip(filter === "all" && !tag)}>
            全部
          </button>
          {rawCount > 0 && (
            <button aria-pressed={filter === "raw"} onClick={() => setFilter(filter === "raw" ? "all" : "raw")} className={chip(filter === "raw")}>
              待整理 <span className="text-accent-strong">{rawCount}</span>
            </button>
          )}
          {KINDS.filter((k) => entries.some((e) => kindOf(e) === k.k)).map((k) => (
            <button key={k.k} aria-pressed={filter === k.k} onClick={() => setFilter(filter === k.k ? "all" : k.k)} className={chip(filter === k.k)}>
              {k.name}
            </button>
          ))}
          {allTags.map((t) => (
            <button key={"#" + t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)} className={chip(tag === t)}>
              #{t}
            </button>
          ))}
        </div>
        <div className="scroll-quiet -mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {sections.map(([name, list]) => (
            <div key={name} className="flex shrink-0 flex-col gap-0.5">
              {name && <h2 className="px-3.5 pt-2.5 pb-1 text-xs font-semibold text-muted">{name}</h2>}
              {list.map((e) => (
                <ListRow
                  key={name + e.s.id}
                  e={e}
                  on={sel === e.s.id && mode !== "new"}
                  locked={vks[e.s.kid] ? "解不开" : "用另一个主密码加密的"}
                  onPick={() => {
                    setSel(e.s.id);
                    setMode("view");
                  }}
                />
              ))}
            </div>
          ))}
          {!shown.length && <div className="px-3.5 py-2 text-xs leading-relaxed text-faint">{secrets.length ? "没有对得上的" : "还是空的。点「新建」，或者在快速记录里选「密码」随手记一条。"}</div>}
        </div>
      </section>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-surface">
        {mode === "new" ? (
          <Editor
            key="new"
            old={null}
            latest={null}
            init={null}
            allTags={allTags}
            onCancel={() => setMode("view")}
            onDone={(s) => {
              setSel(s.id);
              setMode("view");
            }}
          />
        ) : mode === "edit" && editing ? (
          <Editor key={editing.s.id} old={editing.s} latest={secrets.find((x) => x.id === editing.s.id) ?? null} init={editing.f} raw={editing.raw} allTags={allTags} onCancel={stopEdit} onDone={stopEdit} />
        ) : cur ? (
          <Detail key={cur.id + cur.updatedAt} s={cur} f={opened.get(cur.id) ?? null} hasKey={!!vks[cur.kid]} keys={data.keys} onEdit={() => startEdit(cur)} onDeleted={() => setSel(null)} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center text-sm text-faint">
            <div className="flex flex-col items-center gap-3">
              <KeyRound className="size-8 text-line" />
              {secrets.length ? "从左边选一条" : "网站账号、API key、服务器和设备的登录信息都可以存在这里"}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- AI 要用某一条：让用户确认 */

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 px-4 py-2.5 text-[13.5px]">
      <span className="w-14 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 grow break-words text-fg">{children}</span>
    </div>
  );
}

function RequestDialog({ r, more, secret, keys, onDone }: { r: VaultRequest; more: number; secret?: SecretRec; keys: KeyRec[]; onDone: () => void }) {
  const global = useVault((s) => s.vks);
  // 密码库锁着时在这里输主密码：只为这一次解开，不顺手把整个密码库打开
  const [local, setLocal] = useState<OpenedKeys>({});
  const localRef = useRef(local);
  localRef.current = local;
  // 弹窗关掉就把这一次解开的钥匙抹掉
  useEffect(
    () => () => {
      for (const k of Object.values(localRef.current)) {
        k.vk.fill(0);
        k.auth.fill(0);
      }
    },
    [],
  );
  const [p, setP] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [end] = useState(() => Date.now() + r.left);
  const [left, setLeft] = useState(Math.round(r.left / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [end]);
  useEffect(() => {
    if (left === 0) onDone();
  }, [left, onDone]);

  const vks = useMemo(() => ({ ...local, ...(global ?? {}) }), [local, global]);
  // 给用户看的、和真正交出去的，是同一份解开的内容
  const f = useMemo(() => (secret ? openSecret(secret, vks) : null), [secret, vks]);
  // 刚显示出来（或刚解开）的一小会儿不让点允许：免得正在别处敲回车、点鼠标时顺手就批准了
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    if (!f) return;
    const t = window.setTimeout(() => setArmed(true), 1200);
    return () => window.clearTimeout(t);
  }, [f]);

  const run = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    }
    setBusy("");
  };
  const open = () =>
    run("open", async () => {
      const got = await unwrapAll(keys, p, vks);
      if (!secret || !got[secret.kid]) throw new Error("这个主密码解不开这一条");
      setLocal((l) => ({ ...l, ...got }));
      setP("");
    });
  const allow = () =>
    run("allow", async () => {
      const k = secret && vks[secret.kid];
      if (!f || !k) return;
      await approveRequest(r, f, k);
      useVault.getState().touch();
      say(`已把「${f.title}」交给 ${r.actor}`);
      onDone();
    });
  const deny = () =>
    run("deny", async () => {
      await denyRequest(r);
      say(`已拒绝 ${r.actor}`);
      onDone();
    });
  return (
    <Dialog
      title="有 AI 想用密码库里的一条"
      desc="允许后，这一条的全部内容（网址、用户名、密码、备注和你加的其他栏）会交给它，只这一次。"
      onClose={onDone}
      dismissable={false}
      footer={
        <>
          {f && (
            <Button tone="primary" disabled={!!busy || !armed} onClick={allow}>
              {busy === "allow" ? "正在交给它…" : "允许这一次"}
            </Button>
          )}
          <Button disabled={!!busy} onClick={deny}>
            拒绝
          </Button>
          <span className="grow" />
          <span className="text-xs text-faint">
            {more > 0 ? `后面还有 ${more} 个请求 · ` : ""}
            {left} 秒后自动作废
          </span>
        </>
      }
    >
      <div className="flex flex-col rounded-xl bg-surface-2 py-1">
        <Line label="谁">
          <b className="font-semibold">{r.actor}</b>
          <span className="text-muted">（它用的 API key 的名字）</span>
        </Line>
        <Line label="哪一条">
          {f ? (
            <>
              <b className="font-semibold">{f.title}</b>
              <span className="text-muted">（{kindName(f.kind)}）</span>
            </>
          ) : secret ? (
            <span className="text-muted">解开后才能确认。主机上登记的名称是「{r.title}」</span>
          ) : (
            <span className="text-danger">这一条已经不在密码库里了</span>
          )}
        </Line>
        <Line label="它说">{r.reason || <span className="text-muted">（没有说用来做什么）</span>}</Line>
      </div>
      <p className="text-xs leading-relaxed text-faint">「它说」是对方自己写的，不一定可信。不是你刚让它做的事，就点拒绝。</p>
      {secret && !f && (
        <Field label="输入主密码解开这一条（只用于这一次，不会顺便打开整个密码库）">
          <span className="flex gap-2">
            <MasterInput label="主密码" value={p} onChange={setP} onEnter={open} />
            <Button className="h-10" disabled={!p || !!busy} onClick={open}>
              {busy === "open" ? "正在解开…" : "解开"}
            </Button>
          </span>
        </Field>
      )}
      <ErrorText>{err}</ErrorText>
    </Dialog>
  );
}

/** 挂在整个界面上：有 AI 发来取用请求就弹窗（设过主密码才会去问） */
export function VaultRequests({ enabled }: { enabled: boolean }) {
  const vault = useVaultState(enabled).data;
  const has = !!vault?.keys.length;
  const reqs = useQuery({ queryKey: ["vault-requests"], queryFn: fetchRequests, enabled: enabled && has, refetchInterval: 4000 }).data ?? [];
  // 答复过的（或者作废的）不再弹；主机那边下一次轮询也就没有它了
  const [hidden, setHidden] = useState<string[]>([]);
  const waiting = reqs.filter((x) => !hidden.includes(x.id));
  const r = waiting[0];
  if (!r || !vault) return null;
  return (
    <RequestDialog
      key={r.id}
      r={r}
      more={waiting.length - 1}
      secret={vault.secrets.find((s) => s.id === r.secretId)}
      keys={vault.keys}
      onDone={() => {
        setHidden((h) => [...h, r.id]);
        qc.invalidateQueries({ queryKey: ["vault-requests"] });
      }}
    />
  );
}
