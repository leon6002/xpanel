/* 密码库：左边是条目列表，右边看和改一条。加解密在 lib/vault.ts，主机只有密文。
   三种状态：还没设主密码 → 设置；锁着 → 输主密码；解开 → 列表。十分钟不碰自动锁上，刷新页面也会锁上。 */
import { useQuery } from "@tanstack/react-query";
import { Copy, Dices, Eye, EyeOff, Globe, KeyRound, KeySquare, Lock, Pencil, Plus, Search, Server, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { copyText, errText } from "../lib/api";
import { qc } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { ago } from "../lib/logic";
import { useUi } from "../lib/store";
import {
  KINDS,
  VAULT_KEY,
  answerRequest,
  changePassword,
  createVault,
  deleteSecret,
  fetchRequests,
  fetchVault,
  generatePassword,
  kindName,
  openSecret,
  saveSecret,
  strength,
  unlock,
  useVault,
  type Extra,
  type Fields,
  type KeyRec,
  type SecretKind,
  type SecretRec,
  type VaultRequest,
} from "../lib/vault";
import { cx } from "../lib/cx";
import { Button, ErrorText, Field, IconButton, Segmented, Toggle, inputCls, textareaCls } from "./ui";

const say = (t: string) => useUi.getState().say(t);
const KIND_ICON: Record<SecretKind, typeof Globe> = { login: Globe, apikey: KeySquare, server: Server };
/** 每种条目里各个栏叫什么；没列的栏这种条目不用 */
const LABELS: Record<SecretKind, { url: string; username: string; password: string; urlHint: string }> = {
  login: { url: "网址", username: "用户名", password: "密码", urlHint: "https://…" },
  apikey: { url: "服务或网址（可选）", username: "账号（可选）", password: "Key / Token", urlHint: "" },
  server: { url: "地址", username: "用户名", password: "密码", urlHint: "主机名或 IP，可以带端口" },
};

export const useVaultState = (enabled = true) => useQuery({ queryKey: VAULT_KEY, queryFn: fetchVault, enabled });

/** 主密码输入框：不让浏览器记住它 */
function MasterInput({ value, onChange, placeholder, autoFocus, onEnter, label }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; onEnter?: () => void; label: string }) {
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
  return <span className={cx("text-xs", s === 0 ? "text-danger" : s === 1 ? "text-warn-fg" : "text-muted")}>{s === 0 ? "太短或太简单：至少 10 个字符，别用重复的字" : s === 1 ? "可以用。再长一些、混着大小写数字符号会更难猜" : "够强"}</span>;
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
function Row({ label, value, secret, mono = true }: { label: string; value?: string; secret?: boolean; mono?: boolean }) {
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
        <IconButton label={"复制" + label} onClick={async () => say((await copyText(value)) ? `已复制${label}` : "复制失败")}>
          <Copy />
        </IconButton>
      </span>
    </div>
  );
}

function Detail({ s, f, keys, onEdit, onDeleted }: { s: SecretRec; f: Fields | null; keys: KeyRec[]; onEdit: () => void; onDeleted: () => void }) {
  const L = LABELS[s.kind] ?? LABELS.login;
  const [sure, setSure] = useState(false);
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const Icon = KIND_ICON[s.kind] ?? Globe;
  const del = async () => {
    if (!sure) return setSure(true);
    try {
      await deleteSecret(s.id);
      say(`已删除「${s.title}」`);
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
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-7">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <div className="flex items-start gap-3 px-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg-2 [&_svg]:size-5">
            <Icon />
          </span>
          <div className="flex min-w-0 grow flex-col">
            <h1 className="text-[20px] leading-tight font-bold break-words">{s.title}</h1>
            <span className="text-xs text-muted">
              {kindName(s.kind)} · {ago(s.updatedAt)}改的
            </span>
          </div>
          {f && (
            <Button onClick={onEdit}>
              <Pencil className="size-4" />
              编辑
            </Button>
          )}
          <Button tone="danger" onClick={del} onBlur={() => setSure(false)}>
            <Trash2 className="size-4" />
            {sure ? "再点一次删除" : "删除"}
          </Button>
        </div>
        {f ? (
          <div className="flex flex-col gap-0.5">
            <Row label={L.url} value={f.url} />
            <Row label={L.username} value={f.username} />
            <Row label={L.password} value={f.password} secret />
            {(f.extra ?? []).map((x, i) => (
              <Row key={i} label={x.label || "其他"} value={x.value} secret={x.hidden} />
            ))}
            <Row label="备注" value={f.notes} mono={false} />
            {!f.url && !f.username && !f.password && !f.notes && !(f.extra ?? []).length && <p className="px-3.5 text-[13px] text-faint">这一条还没填内容</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-4">
            <p className="text-[13px] leading-relaxed text-fg-2">这一条是用另一个主密码加密的（两台电脑各自设过主密码，后来合并到了一起）。输入当时那个主密码就能解开；之后可以用「改主密码」把它改成和现在一样的。</p>
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

/* ---------------------------------------------------------------- 新建和编辑 */

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

function Editor({ old, init, onDone, onCancel }: { old: SecretRec | null; init: Fields; onDone: (s: SecretRec) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<SecretKind>(old?.kind ?? "login");
  const [title, setTitle] = useState(old?.title ?? "");
  const [f, setF] = useState<Fields>(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const L = LABELS[kind];
  const set = (ch: Partial<Fields>) => setF((x) => ({ ...x, ...ch }));
  const extra = f.extra ?? [];
  const setExtra = (i: number, ch: Partial<Extra>) => set({ extra: extra.map((x, j) => (j === i ? { ...x, ...ch } : x)) });
  const save = async () => {
    if (!title.trim()) return setErr("先填名称");
    setBusy(true);
    setErr("");
    const clean: Fields = {
      url: f.url?.trim() || undefined,
      username: f.username?.trim() || undefined,
      password: f.password || undefined,
      notes: f.notes?.trim() || undefined,
      extra: extra.filter((x) => x.value).map((x) => ({ label: x.label.trim(), value: x.value, ...(x.hidden ? { hidden: true } : {}) })),
    };
    if (!clean.extra?.length) delete clean.extra;
    try {
      onDone(await saveSecret(old, { title, kind, fields: clean }));
      say(old ? "已保存" : `已存进密码库：「${title.trim()}」`);
    } catch (e) {
      setErr(errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
      setBusy(false);
    }
  };
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col overflow-y-auto p-7">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        <h1 className="text-[18px] font-bold">{old ? "编辑" : "新建"}</h1>
        {!old && <Segmented label="种类" value={kind} onChange={setKind} options={KINDS.map((k) => [k.k, k.name] as [SecretKind, string])} />}
        <Field label="名称" hint="名称不加密：锁着的时候和给 AI 的列表里都看得到，别把密码写在这里">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder={kind === "login" ? "比如 GitHub" : kind === "apikey" ? "比如 OpenAI API key" : "比如 家里的 Linux 主机"} />
        </Field>
        <Field label={L.url}>
          <input className={inputCls + " font-mono"} value={f.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder={L.urlHint} autoComplete="off" />
        </Field>
        <Field label={L.username}>
          <input className={inputCls + " font-mono"} value={f.username ?? ""} onChange={(e) => set({ username: e.target.value })} autoComplete="off" data-1p-ignore data-lpignore="true" />
        </Field>
        <Field label={L.password}>
          <SecretInput label={L.password} value={f.password ?? ""} onChange={(v) => set({ password: v })} gen={kind !== "apikey"} />
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
        <Field label="备注">
          <textarea className={textareaCls} rows={4} value={f.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <ErrorText>{err}</ErrorText>
        <div className="flex gap-2">
          <Button tone="primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </Button>
          <Button onClick={onCancel}>取消</Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 整页 */

export function Vault() {
  const { data, error, isLoading } = useVaultState();
  const vks = useVault((s) => s.vks);
  const lock = useVault((s) => s.lock);
  const touch = useVault((s) => s.touch);
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<SecretKind | "all">("all");

  const secrets = data?.secrets ?? [];
  // 解开的内容只留在内存里，锁上就没了
  const opened = useMemo(() => new Map(secrets.map((s) => [s.id, openSecret(s, vks)])), [secrets, vks]);
  const lq = q.trim().toLowerCase();
  const shown = secrets.filter((s) => {
    if (kind !== "all" && s.kind !== kind) return false;
    if (!lq) return true;
    const f = opened.get(s.id);
    return [s.title, f?.url, f?.username, f?.notes, ...(f?.extra ?? []).map((x) => x.label)].some((t) => (t || "").toLowerCase().includes(lq));
  });
  const cur = secrets.find((s) => s.id === sel) ?? null;
  useEffect(() => {
    if (mode === "edit" && !cur) setMode("view");
  }, [mode, cur]);

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-5" onPointerDown={touch} onKeyDown={touch}>
      <section aria-label="密码库" className="flex w-[340px] shrink-0 flex-col gap-3.5 max-[1200px]:w-[290px]">
        <label className="flex h-[42px] shrink-0 items-center gap-2 rounded-xl bg-surface-2 px-3.5 text-muted">
          <Search className="size-4" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜名称、网址、用户名" aria-label="搜索密码库" className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint" />
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
          {([["all", "全部"], ...KINDS.map((k) => [k.k, k.name])] as [SecretKind | "all", string][]).map(([k, name]) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)} className={cx("rounded-lg px-2.5 py-1 text-[12.5px] transition-colors", kind === k ? "bg-surface-3 font-medium text-fg" : "text-muted hover:bg-surface-2")}>
              {name}
            </button>
          ))}
        </div>
        <div className="scroll-quiet -mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {shown.map((s) => {
            const Icon = KIND_ICON[s.kind] ?? Globe;
            const f = opened.get(s.id);
            return (
              <button
                key={s.id}
                aria-current={sel === s.id && mode !== "new" ? "true" : undefined}
                onClick={() => {
                  setSel(s.id);
                  setMode("view");
                }}
                className={cx("flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors", sel === s.id && mode !== "new" ? "bg-surface-3" : "hover:bg-surface-2")}
              >
                <Icon className="size-[18px] shrink-0 text-muted" strokeWidth={1.8} />
                <span className="flex min-w-0 grow flex-col">
                  <span className="truncate text-[14px] font-semibold">{s.title}</span>
                  <span className="truncate font-mono text-xs text-muted">{f ? f.username || f.url || kindName(s.kind) : "用另一个主密码加密的"}</span>
                </span>
              </button>
            );
          })}
          {!shown.length && <div className="px-3.5 py-2 text-xs leading-relaxed text-faint">{secrets.length ? "没有匹配的" : "还是空的。点「新建」存第一条。"}</div>}
        </div>
      </section>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] bg-surface">
        {mode === "new" ? (
          <Editor
            key="new"
            old={null}
            init={{}}
            onCancel={() => setMode("view")}
            onDone={(s) => {
              setSel(s.id);
              setMode("view");
            }}
          />
        ) : cur && mode === "edit" && opened.get(cur.id) ? (
          <Editor key={cur.id} old={cur} init={opened.get(cur.id) ?? {}} onCancel={() => setMode("view")} onDone={() => setMode("view")} />
        ) : cur ? (
          <Detail key={cur.id + cur.updatedAt} s={cur} f={opened.get(cur.id) ?? null} keys={data.keys} onEdit={() => setMode("edit")} onDeleted={() => setSel(null)} />
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

function RequestDialog({ r, secret, keys, onDone }: { r: VaultRequest; secret?: SecretRec; keys: KeyRec[]; onDone: () => void }) {
  const vks = useVault((s) => s.vks);
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [left, setLeft] = useState(Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000)));
  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [r.expiresAt]);
  useEffect(() => {
    if (left === 0) onDone();
  }, [left, onDone]);
  const usable = !!secret && !!openSecret(secret, vks);
  const answer = async (approve: boolean) => {
    setBusy(true);
    setErr("");
    try {
      if (approve && !usable) await unlock(keys, p);
      await answerRequest(r, secret, approve);
      say(approve ? `已把「${r.title}」交给 ${r.actor}` : `已拒绝 ${r.actor}`);
      onDone();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${r.actor} 想用密码库里的「${r.title}」`}
      desc="允许后，这一条的全部内容（网址、用户名、密码、备注和你加的其他栏）会交给它，只这一次。"
      onClose={onDone}
      footer={
        <>
          <Button tone="primary" disabled={busy || !secret || (!usable && !p)} onClick={() => answer(true)}>
            {busy ? "正在处理…" : "允许这一次"}
          </Button>
          <Button disabled={busy} onClick={() => answer(false)}>
            拒绝
          </Button>
          <span className="grow" />
          <span className="text-xs text-faint">{left} 秒后自动作废</span>
        </>
      }
    >
      <div className="flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3 text-[13px]">
        <span className="text-xs text-muted">它说的理由</span>
        <span className="break-words whitespace-pre-wrap text-fg">{r.reason || "（没有说）"}</span>
      </div>
      <p className="text-xs leading-relaxed text-faint">理由是对方自己写的，不一定可信。不是你刚让它做的事，就点拒绝。</p>
      {!secret && <ErrorText>这一条已经不在密码库里了</ErrorText>}
      {secret && !usable && (
        <Field label="密码库锁着，先输主密码">
          <MasterInput label="主密码" value={p} onChange={setP} onEnter={() => answer(true)} autoFocus />
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
  // 关掉弹窗只是先不看，不算拒绝；过期前不再弹这一个
  const [hidden, setHidden] = useState<string[]>([]);
  const r = reqs.find((x) => !hidden.includes(x.id));
  if (!r || !vault) return null;
  return (
    <RequestDialog
      key={r.id}
      r={r}
      secret={vault.secrets.find((s) => s.id === r.secretId)}
      keys={vault.keys}
      onDone={() => {
        setHidden((h) => [...h, r.id]);
        qc.invalidateQueries({ queryKey: ["vault-requests"] });
      }}
    />
  );
}
