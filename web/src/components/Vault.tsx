/* 密码库：一整屏的列表，按类别分组，每一行直接看得到账号、点一下复制密码；点名称展开看全部。
   编辑不常驻，要改时弹出来。加解密在 lib/vault.ts，主机只有密文。
   三种状态：还没设主密码 → 设置；锁着 → 输主密码；解开 → 列表。十分钟不碰自动锁上，刷新页面也会锁上。 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Copy, Dices, Eye, EyeOff, Globe, KeyRound, KeySquare, Landmark, Lock, NotebookPen, Pencil, Pin, Plus, Search, Server, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText, errText, newId } from "../lib/api";
import { qc } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { ago } from "../lib/logic";
import { PLATFORMS, composeTitle, detectPlatform, platformById, platformOf, shortTitle, type Platform } from "../lib/platforms";
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
  SUBS,
  generatePassword,
  groupOf,
  identityOf,
  kindName,
  mainOf,
  specOf,
  specsFor,
  tailOf,
  openSecret,
  saveSecret,
  strength,
  unlock,
  unwrapAll,
  useVault,
  useVaultUi,
  type AnyKind,
  type BankSub,
  type Extra,
  type Fields,
  type KeyRec,
  type OpenedKeys,
  type SecretKind,
  type SecretRec,
  type VaultRequest,
} from "../lib/vault";
import { parseSecret } from "../lib/vaultParse";
import { bumpUsage, domainOf, searchVault, titleOf, type Entry } from "../lib/vaultSearch";
import { cx } from "../lib/cx";
import { LetterMark, PlatformLogo } from "./PlatformLogo";
import { Button, Chip, ErrorText, Field, IconButton, Segmented, Toggle, inputCls, textareaCls } from "./ui";

const say = (t: string) => useUi.getState().say(t);
export const KIND_ICON: Record<AnyKind, typeof Globe> = { login: Globe, bank: Landmark, apikey: KeySquare, server: Server, other: StickyNote, raw: NotebookPen };

/** 一条前面的图标：认得出平台的用平台 logo，认不出的网站账号用名称的第一个字，其余按种类 */
export function EntryIcon({ e, size = 18 }: { e: Entry; size?: number }) {
  const f = e.f;
  const p = platformOf(f);
  if (p) return <PlatformLogo p={p} size={size} />;
  if (f?.kind === "login") return <LetterMark title={f.title} size={size} />;
  const Icon = KIND_ICON[f?.kind ?? e.s.kind] ?? Globe;
  return <Icon className={cx("shrink-0", f?.kind === "raw" ? "text-accent" : "text-muted")} style={{ width: size - 1, height: size - 1 }} strokeWidth={1.8} />;
}
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

/* ---------------------------------------------------------------- 一栏一栏地看（展开一条时） */

const used = (id: string) => (bumpUsage(id), useVault.getState().touch());
async function copy(value: string, label: string, id: string) {
  const ok = await copyText(value);
  say(ok ? `已复制${label}` : "复制失败");
  if (ok) used(id);
}

/** 展开后的一栏：点一下复制；悬停时右边浮出显示 / 隐藏 */
function Row({ id, label, value, secret, tail, mono = true }: { id: string; label: string; value?: string; secret?: boolean; tail?: boolean; mono?: boolean }) {
  const [show, setShow] = useState(false);
  if (!value) return null;
  const masked = (secret || tail) && !show;
  return (
    <div title={`点一下复制${label}`} onClick={() => copy(value, label, id)} className="group/row relative flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2 hover:bg-surface-3/60">
      <span className="text-xs text-muted">{label}</span>
      <span className={cx("min-h-5 pr-16 text-[13.5px] break-all whitespace-pre-wrap text-fg", mono && "font-mono", masked && secret && "tracking-[0.2em] select-none")}>{masked ? (tail ? tailOf(value) : "••••••••••") : value}</span>
      <span onClick={(e) => e.stopPropagation()} className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
        {(secret || tail) && (
          <IconButton label={show ? "隐藏" : "显示"} className="size-7" onClick={() => setShow(!show)}>
            {show ? <EyeOff /> : <Eye />}
          </IconButton>
        )}
        <IconButton label={"复制" + label} className="size-7" onClick={() => copy(value, label, id)}>
          <Copy />
        </IconButton>
      </span>
    </div>
  );
}

/** 展开一条：所有的栏、备注，和少用的操作（编辑、置顶、删除）。平时不占地方 */
function Expanded({ e, keys, hasKey }: { e: Entry; keys: KeyRec[]; hasKey: boolean }) {
  const { s, f } = e;
  const [sure, setSure] = useState(false);
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const del = async () => {
    if (!sure) return setSure(true);
    try {
      await deleteSecret(s);
      say(`已删除「${titleOf(e)}」`);
    } catch (x) {
      say("删除失败：" + errText(x));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
    }
  };
  const other = async () => {
    setBusy(true);
    setErr("");
    try {
      await unlock(keys, p);
      setP("");
    } catch (x) {
      setErr(errText(x));
    }
    setBusy(false);
  };
  const pin = async () => {
    if (!f || f.kind === "raw") return;
    const { title, kind, raw: _r, ...rest } = f;
    void _r;
    try {
      await saveSecret(s, s.id, { ...rest, title, kind, pinned: !f.pinned || undefined });
    } catch (x) {
      say("没存上：" + errText(x));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
    }
  };
  if (!f)
    return (
      <div className="mx-3 mb-2 flex flex-col gap-3 rounded-xl bg-surface-2 p-4">
        {hasKey ? (
          <p className="text-[13px] leading-relaxed text-danger">这一条解不开：内容坏了，或者被人改过。名称是主机上登记的，不一定是真的。可以从备份里找回（见密码库说明的「出问题时」）。</p>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-fg-2">这一条现在的主密码解不开：它是用另一个主密码加密的（两台电脑各自设过主密码，后来合并到了一起）。输入当时那个主密码就能解开。</p>
            <div className="flex max-w-[520px] gap-2">
              <MasterInput label="另一个主密码" value={p} onChange={setP} onEnter={other} placeholder="另一个主密码" />
              <Button tone="primary" className="h-10" disabled={!p || busy} onClick={other}>
                {busy ? "正在解开…" : "解开"}
              </Button>
            </div>
            <ErrorText>{err}</ErrorText>
          </>
        )}
      </div>
    );
  const raw = f.kind === "raw";
  const specs = raw ? [] : specsFor(f);
  return (
    <div className="mx-3 mb-2 flex flex-col gap-2 rounded-xl bg-surface-2 p-2">
      {!raw && (f.title !== s.title || f.kind !== s.kind) && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] leading-relaxed text-warn-fg">
          主机上给这一条登记的名称是「{s.title}」，和加密保存的不一样；这里显示的是加密保存的。合并时另存的旧版本会这样。不是那种情况的话，说明有人改过主机上的数据，留意一下。
        </p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-2">
        {raw && <Row id={s.id} label="记下来的原文" value={f.raw} />}
        <Row id={s.id} label="用途" value={f.label} mono={false} />
        {specs.map((x) => (
          <Row key={x.key} id={s.id} label={x.label} value={f[x.key]} secret={x.secret} tail={x.tail} />
        ))}
        {(f.extra ?? []).map((x, i) => (
          <Row key={i} id={s.id} label={x.label || "其他"} value={x.value} secret={x.hidden} />
        ))}
      </div>
      <Row id={s.id} label="备注" value={f.notes} mono={false} />
      <div className="flex flex-wrap items-center gap-2 px-1 pb-1">
        <Button tone={raw ? "primary" : "soft"} className="bg-surface hover:bg-surface-3" onClick={() => openEditor(e)}>
          <Pencil className="size-4" />
          {raw ? "整理" : "编辑"}
        </Button>
        {!raw && (
          <Button className="bg-surface hover:bg-surface-3" onClick={pin}>
            <Pin className="size-4" />
            {f.pinned ? "取消置顶" : "置顶"}
          </Button>
        )}
        <Button tone="danger" onClick={del} onBlur={() => setSure(false)}>
          <Trash2 className="size-4" />
          {sure ? "再点一次删除" : "删除"}
        </Button>
        <span className="grow" />
        <span className="text-xs text-faint">
          {raw ? "随手记下的，还没分成各栏。点「整理」会先帮你拆好。" : `${[platformOf(f)?.name, groupOf(f), ...(f.tags ?? []).map((t) => "#" + t)].filter(Boolean).join(" · ")} · ${ago(s.updatedAt)}改的`}
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 新建、编辑、整理（弹出来，不常驻） */

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

const NAME_HINT: Record<SecretKind, string> = { login: "比如 GitHub", bank: "比如 招商银行", apikey: "比如 OpenAI API key", server: "比如 家里的 Linux 主机", other: "比如 家里的 Wi-Fi" };

/** 打开编辑窗口。e 没有 = 新建；e 是待整理的 = 先从原文里拆出各栏预填 */
export function openEditor(e?: Entry) {
  const f = e?.f;
  if (e && !f) return;
  const raw = f?.kind === "raw" ? (f.raw ?? "") : undefined;
  const init = raw != null ? parseSecret(raw) : (f ?? null);
  openDialog((close) => <Editor old={e?.s ?? null} init={init} raw={raw} close={close} />);
}

/** old 是开始编辑时的那一版（新建时没有）。别处在这期间改了或删了，保存时主机会拿 old 来比、拒绝，
    这里提前说出来，不会悄悄盖掉别处的修改 */
function Editor({ old, init, raw, close }: { old: SecretRec | null; init: Fields | null; raw?: string; close: () => void }) {
  const vault = useVaultState().data;
  const vks = useVault((s) => s.vks);
  const [id] = useState(newId);
  const latest = old ? vault?.secrets.find((x) => x.id === old.id) : undefined;
  const moved = !!old && latest?.updatedAt !== old.updatedAt;
  const [kind, setKind] = useState<SecretKind>(init && init.kind !== "raw" ? init.kind : "login");
  const [bsub, setBsub] = useState<BankSub>(init?.sub ?? "mobile");
  // 平台：undefined = 没选，按名称和网址认；null = 明说不是任何平台
  const [plat, setPlat] = useState<string | null | undefined>(init?.platform === "none" ? null : init?.platform);
  const [label, setLabel] = useState(init?.label ?? "");
  const [more, setMore] = useState(false);
  const [title, setTitle] = useState(init?.title ?? "");
  const [f, setF] = useState<Partial<Fields>>(init ?? {});
  const [tags, setTags] = useState((init?.tags ?? []).join(" "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 锁上了：解开的内容不留着，窗口关掉
  useEffect(() => {
    if (!vks) close();
  }, [vks, close]);
  const allTags = useMemo(() => [...new Set((vault?.secrets ?? []).flatMap((s) => openSecret(s, vks)?.tags ?? []))].sort((a, b) => a.localeCompare(b)), [vault, vks]);
  const set = (ch: Partial<Fields>) => setF((x) => ({ ...x, ...ch }));
  const bank = kind === "bank";
  const picked = platformById(plat);
  const guessed = plat === undefined ? detectPlatform({ title, url: f.url }, bank) : undefined;
  const P = picked && !!picked.bank === bank ? picked : guessed;
  const specs = specOf(kind, bsub, P?.idLabel);
  const choices = PLATFORMS.filter((p) => !!p.bank === bank);
  const pick = (p: Platform) => {
    if (P?.id === p.id) return setPlat(null);
    setPlat(p.id);
    // 名称、网址还空着（或者是上一个平台带出来的）就带出这个平台的
    const auto = PLATFORMS.flatMap((x) => [x.name, x.name + "信用卡"]);
    if (!title.trim() || auto.includes(title.trim())) setTitle(p.name + (bank && bsub === "credit" ? "信用卡" : ""));
    if (kind === "login" && p.url && (!f.url?.trim() || PLATFORMS.some((x) => x.url === f.url))) set({ url: p.url });
  };
  const name = title.trim();
  const extra = f.extra ?? [];
  const setExtra = (i: number, ch: Partial<Extra>) => set({ extra: extra.map((x, j) => (j === i ? { ...x, ...ch } : x)) });
  const tagList = [...new Set(tags.split(/[\s,，#]+/).filter(Boolean))];
  const save = async () => {
    if (!name) return setErr("先填名称");
    setBusy(true);
    setErr("");
    // 只留这种条目有的栏：换过种类的话，别的种类填的不带着
    const vals = Object.fromEntries(specs.map((x) => [x.key, (x.secret ? f[x.key] : f[x.key]?.trim()) || undefined]));
    // 主机上登记的名称带上用途（「Apple · 美区」），锁着时和给 AI 的列表里分得清是哪个号
    const use = P ? label.trim() : "";
    const base = init?.label && name.endsWith(` · ${init.label}`) ? name.slice(0, -` · ${init.label}`.length) : name;
    const clean = {
      ...vals,
      title: composeTitle(base, use),
      kind,
      sub: kind === "bank" ? bsub : undefined,
      platform: plat === null ? (detectPlatform({ title: base, url: f.url }, bank) ? "none" : undefined) : P?.id,
      label: use || undefined,
      notes: f.notes?.trim() || undefined,
      extra: extra.some((x) => x.value) ? extra.filter((x) => x.value).map((x) => ({ label: x.label.trim(), value: x.value, ...(x.hidden ? { hidden: true } : {}) })) : undefined,
      tags: tagList.length ? tagList : undefined,
      pinned: f.pinned || undefined,
    };
    try {
      const rec = await saveSecret(old, id, clean);
      say(raw != null ? `整理好了：「${name}」` : old ? "已保存" : `已存进密码库：「${name}」`);
      useVaultUi.getState().setSel(rec.id);
      close();
    } catch (e) {
      setErr(errText(e));
      qc.invalidateQueries({ queryKey: VAULT_KEY });
      setBusy(false);
    }
  };
  const unused = allTags.filter((t) => !tagList.includes(t)).slice(0, 12);
  return (
    <Dialog
      wide
      title={raw != null ? "整理" : old ? "编辑" : "新建"}
      onClose={close}
      footer={
        <>
          <Button tone="primary" disabled={busy || moved} onClick={save}>
            {busy ? "保存中…" : "保存"}
          </Button>
          <Button onClick={close}>取消</Button>
        </>
      }
    >
      {raw != null && (
        <div className="flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3">
          <span className="text-xs text-muted">记下来的原文（下面是自动拆出来的，不对的地方改一下）</span>
          <span className="font-mono text-[13.5px] break-all whitespace-pre-wrap text-fg">{raw}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Segmented
          label="种类"
          value={kind}
          onChange={(k) => {
            // 银行和别的种类各有各的平台：换过去时不带着
            if ((k === "bank") !== bank) setPlat(undefined);
            setKind(k);
          }}
          options={KINDS.map((k) => [k.k, k.name] as [SecretKind, string])} />
        {kind === "bank" && <Segmented label="银行的哪一种" value={bsub} onChange={setBsub} options={SUBS.map((k) => [k.k, k.name] as [BankSub, string])} />}
      </div>
      {(kind === "login" || kind === "bank" || kind === "apikey") && (
        <div role="group" aria-label={bank ? "哪家银行" : "平台"} className="flex flex-wrap items-center gap-1.5">
          {(more || (P && choices.indexOf(P) >= 14) ? choices : choices.slice(0, 14)).map((p) => (
            <button key={p.id} aria-pressed={P?.id === p.id} onClick={() => pick(p)} className={cx("flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] transition-colors", P?.id === p.id ? "bg-ink font-semibold text-on-ink" : "bg-surface-2 text-fg-2 hover:bg-surface-3")}>
              <PlatformLogo p={p} size={15} className={P?.id === p.id ? "text-on-ink" : undefined} />
              {p.name}
            </button>
          ))}
          <button onClick={() => setMore(!more)} className="rounded-lg px-2 py-1 text-[12.5px] text-muted hover:bg-surface-2">
            {more ? "收起" : `更多（共 ${choices.length} 个）`}
          </button>
        </div>
      )}
      <div className={cx("grid gap-x-3 gap-y-4", P && "sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]")}>
        <Field label="名称" hint="名称不加密：锁着的时候和给 AI 的列表里都看得到，别把密码写在这里">
          <span className={cx(inputCls, "flex items-center gap-2")}>
            {P && <PlatformLogo p={P} size={17} />}
            <input className="min-w-0 grow bg-transparent outline-none" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder={NAME_HINT[kind]} aria-label="名称" />
          </span>
        </Field>
        {P && (
          <Field label="用途（可选）" hint={`${P.name}有好几个账号时用来区分`}>
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="比如 美区、工作、小号" aria-label="用途" autoComplete="off" />
          </Field>
        )}
      </div>
      <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
        {specs.map((x) => (
          <Field key={x.key} label={x.label}>
            {x.secret ? (
              <SecretInput label={x.label} value={f[x.key] ?? ""} onChange={(v) => set({ [x.key]: v })} gen={x.gen} />
            ) : (
              <input className={inputCls + " font-mono"} value={f[x.key] ?? ""} onChange={(e) => set({ [x.key]: e.target.value })} placeholder={x.hint} aria-label={x.label} autoComplete="off" data-1p-ignore data-lpignore="true" />
            )}
          </Field>
        ))}
      </div>
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
          加一栏（比如端口、数据库名、私钥、恢复码、账单日）
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
        <textarea className={textareaCls} rows={3} value={f.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <ErrorText>{moved ? "这一条在别处刚改过（或者被删了）。这里的修改存不进去：先把要留的内容复制出来，点取消，再重新编辑。" : err}</ErrorText>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 整页：一屏看全，点一下就复制 */

type Filter = "all" | "raw" | SecretKind;
/** 一行的几格怎么分，看这一行自己有多宽（分成两三栏时每行就窄）：
    窄：名称（账号写在名称下面）· 密码 · 操作；中：名称 · 账号 · 密码 · 操作；宽：再加一格放其他栏和标签 */
const GRID =
  "grid items-center gap-1.5 grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] @[430px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto] @[800px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto]";

/** 一格：显示内容，点一下复制。要遮的平时遮着，悬停时旁边有个眼睛 */
function Cell({ id, spec, value, className }: { id: string; spec: { label: string; secret?: boolean; tail?: boolean }; value: string; className?: string }) {
  const [show, setShow] = useState(false);
  const hide = !!(spec.secret || spec.tail);
  const text = hide && !show ? (spec.tail ? tailOf(value) : "••••••••") : value;
  return (
    <span className={cx("group/cell min-w-0 items-center", className ?? "flex")}>
      <button title={`点一下复制${spec.label}`} onClick={() => copy(value, spec.label, id)} className="min-w-0 truncate rounded-lg px-2 py-1 text-left font-mono text-[13px] text-fg-2 hover:bg-surface-3 hover:text-fg">
        {text}
      </button>
      {hide && (
        <button aria-label={show ? "隐藏" : "显示"} title={show ? "隐藏" : "显示"} onClick={() => setShow(!show)} className="grid size-6 shrink-0 place-items-center rounded-md text-faint opacity-0 group-hover/cell:opacity-100 hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 [&_svg]:size-3.5">
          {show ? <EyeOff /> : <Eye />}
        </button>
      )}
    </span>
  );
}

/** 小的一格：其他栏，「名字 内容」，点一下复制 */
function Mini({ id, label, value, hide, tail }: { id: string; label: string; value: string; hide?: boolean; tail?: boolean }) {
  return (
    <button title={`点一下复制${label}`} onClick={() => copy(value, label, id)} className="flex min-w-0 shrink-0 items-baseline gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-surface-3">
      <span className="text-faint">{label.replace(/（.*）$/, "")}</span>
      <span className="max-w-[160px] truncate font-mono text-fg-2">{tail ? tailOf(value) : hide ? "•••" : value}</span>
    </button>
  );
}

/** group：这一行排在某个平台的小组里。组里几行都是同一个平台，名称那一格改放用途（美区、工作），用来分清是哪个号 */
function ListRow({ e, open, keys, hasKey, onToggle, group }: { e: Entry; open: boolean; keys: KeyRec[]; hasKey: boolean; onToggle: () => void; group?: Platform }) {
  const { s, f } = e;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const raw = f?.kind === "raw";
  const name = (group && f && (f.label || shortTitle(f.title, group))) || titleOf(e);
  const idf = f && !raw ? identityOf(f) : null;
  const main = f && !raw ? mainOf(f) : null;
  const specs = f && !raw ? specsFor(f) : [];
  // 信用卡的「账号」和「最常复制的」是同一栏（卡号）：第二格改放下一栏（有效期）
  const same = !!main && main.spec.key === idf?.spec.key;
  const next = same ? specs.find((x) => x.key !== main!.spec.key && x.key !== "url" && f![x.key]) : undefined;
  const shownKeys = new Set([idf?.spec.key, main?.spec.key, next?.key, "url"]);
  const rest = specs.filter((x) => !shownKeys.has(x.key) && f![x.key]);
  const domain = domainOf(f?.url);
  return (
    <div ref={ref} className={cx("@container flex break-inside-avoid flex-col rounded-xl", open && "bg-surface-2/50")}>
      <div className={cx(GRID, "group/line min-h-[38px] rounded-xl pr-1 pl-3", !open && "hover:bg-surface-2")}>
        <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 items-center gap-2.5 py-1.5 text-left" title="点开看全部内容">
          <EntryIcon e={e} />
          {f?.pinned && <Pin className="size-3.5 shrink-0 text-accent" />}
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="max-w-full shrink-0 truncate text-[14px] font-semibold text-fg">{name}</span>
              {domain && !group && !platformOf(f) && domain !== titleOf(e).toLowerCase() && <span className="hidden min-w-0 shrink-[99] truncate text-xs text-faint @[430px]:inline">{domain}</span>}
            </span>
            {idf && !same && <span className="truncate font-mono text-[11.5px] text-muted @[430px]:hidden">{idf.value}</span>}
          </span>
        </button>
        {raw ? (
          <button title="点一下复制原文" onClick={() => copy(f.raw ?? "", "原文", s.id)} className="min-w-0 truncate rounded-lg px-2 py-1 text-left font-mono text-[13px] text-fg-2 hover:bg-surface-3 hover:text-fg @[430px]:col-span-2">
            {(f.raw ?? "").replace(/\s+/g, " ")}
          </button>
        ) : !f ? (
          <span className="truncate px-2 text-[13px] text-faint @[430px]:col-span-2">{hasKey ? "解不开" : "用另一个主密码加密的，点开输入"}</span>
        ) : (
          <>
            {idf ? <Cell id={s.id} spec={idf.spec} value={idf.value} className="hidden @[430px]:flex" /> : <span className="hidden @[430px]:block" />}
            {main && !same ? (
              <Cell id={s.id} spec={main.spec} value={main.value} />
            ) : same ? (
              <span className="flex min-w-0 items-center">
                <Cell id={s.id} spec={main!.spec} value={main!.value} className="flex @[430px]:hidden" />
                {next && (
                  <span className="hidden min-w-0 @[430px]:flex">
                    <Mini id={s.id} label={next.label} value={f[next.key]!} hide={next.secret} tail={next.tail} />
                  </span>
                )}
              </span>
            ) : (
              <span />
            )}
          </>
        )}
        <span className="hidden min-w-0 items-center gap-1 overflow-hidden @[800px]:flex">
          {rest.map((x) => (
            <Mini key={x.key} id={s.id} label={x.label} value={f![x.key]!} hide={x.secret} tail={x.tail} />
          ))}
          {(f?.extra ?? [])
            .filter((x) => x.label !== "原文")
            .slice(0, 3)
            .map((x, i) => (
              <Mini key={i} id={s.id} label={x.label || "其他"} value={x.value} hide={x.hidden} />
            ))}
          {(f?.tags ?? []).map((t) => (
            <span key={t} className="shrink-0 px-1 text-xs text-faint">
              #{t}
            </span>
          ))}
        </span>
        <span className="flex shrink-0 items-center">
          {raw ? (
            <Button tone="primary" className="h-7 px-2.5 text-xs" onClick={() => openEditor(e)}>
              整理
            </Button>
          ) : (
            f && (
              <IconButton label="编辑" className="hidden size-7 opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100 @[430px]:grid" onClick={() => openEditor(e)}>
                <Pencil />
              </IconButton>
            )
          )}
          <IconButton label={open ? "收起" : "展开"} className="size-7" onClick={onToggle}>
            <ChevronDown className={cx("transition-transform", open && "rotate-180")} />
          </IconButton>
        </span>
      </div>
      {open && <Expanded e={e} keys={keys} hasKey={hasKey} />}
    </div>
  );
}

/** 把各组分到几栏里，让每栏差不多长。一组太长就拆到下一栏接着排（标「续」）。
    只按条数分，不看哪一条展开着：展开、收起时别的条目不会在栏之间跳来跳去 */
function intoColumns(groups: [string, Entry[]][], n: number): [string, Entry[]][][] {
  if (n <= 1) return [groups];
  const total = groups.reduce((a, g) => a + g[1].length + 1, 0);
  const target = Math.ceil(total / n);
  const cols: [string, Entry[]][][] = [[]];
  let used = 0;
  for (const [name, all] of groups) {
    let list = all;
    let cont = false;
    while (list.length) {
      const last = cols.length === n;
      const room = target - used - 1;
      if (!last && used > 0 && room < 2) {
        cols.push([]);
        used = 0;
        continue;
      }
      let take = last ? list.length : Math.min(list.length, Math.max(room, 2));
      // 不留一两条孤零零地甩到下一栏
      if (list.length - take <= 2) take = list.length;
      cols[cols.length - 1].push([cont ? `${name}（续）` : name, list.slice(0, take)]);
      used += take + 1;
      list = list.slice(take);
      cont = true;
    }
  }
  return cols;
}

/** 列表区有多宽就分几栏：每栏至少 470 像素，最多三栏 */
function useColumns() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [n, setN] = useState(1);
  useEffect(() => {
    if (!el) return;
    const fit = () => setN(Math.max(1, Math.min(3, Math.floor(el.clientWidth / 470))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, n] as const;
}

export function Vault() {
  const { data, error, isLoading } = useVaultState();
  const vks = useVault((s) => s.vks);
  const lock = useVault((s) => s.lock);
  const touch = useVault((s) => s.touch);
  const [listRef, fit] = useColumns();
  const sel = useVaultUi((s) => s.sel);
  const setSel = useVaultUi((s) => s.setSel);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const [plat, setPlat] = useState<string | null>(null);

  const secrets = data?.secrets ?? [];
  // 解开的内容只留在内存里，锁上就没了
  const entries = useMemo<Entry[]>(() => secrets.map((s) => ({ s, f: openSecret(s, vks) })), [secrets, vks]);
  const kindOf = (e: Entry) => e.f?.kind ?? e.s.kind;
  const rawCount = entries.filter((e) => kindOf(e) === "raw").length;
  const allTags = useMemo(() => [...new Set(entries.flatMap((e) => e.f?.tags ?? []))].sort((a, b) => a.localeCompare(b)), [entries]);
  // 同一个平台有两个以上账号的：筛选里多一个它；其中网站账号单独排成一组（Google 5、Apple 4）
  const [platCount, loginCount] = useMemo(() => {
    const all = new Map<string, number>();
    const login = new Map<string, number>();
    for (const e of entries) {
      const p = platformOf(e.f);
      if (!p) continue;
      all.set(p.id, (all.get(p.id) ?? 0) + 1);
      if (e.f?.kind === "login") login.set(p.id, (login.get(p.id) ?? 0) + 1);
    }
    return [all, login];
  }, [entries]);
  const platChips = [...platCount].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const groupPlat = (e: Entry) => {
    const p = e.f?.kind === "login" ? platformOf(e.f) : undefined;
    return p && (loginCount.get(p.id) ?? 0) >= 2 ? p : undefined;
  };
  const pool = entries.filter((e) => (filter === "all" || kindOf(e) === filter) && (!tag || e.f?.tags?.includes(tag)) && (!plat || platformOf(e.f)?.id === plat));
  const searching = !!q.trim();
  const shown = searchVault(pool, q);
  // 搜索时按相关程度排成一列；平时按类别分组：待整理、置顶，然后一类一组（银行分手机银行和信用卡）
  const groups = ((): [string, Entry[]][] => {
    if (searching) return [[`找到 ${shown.length} 条`, shown]];
    const order = ["待整理", "置顶", ...[...loginCount].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([id]) => platformById(id)!.name), "网站账号", "银行 · 手机银行", "银行 · 信用卡", "API key", "服务器和设备", "其他"];
    const by = new Map<string, Entry[]>();
    for (const e of shown) {
      const g = kindOf(e) === "raw" ? "待整理" : e.f?.pinned ? "置顶" : (groupPlat(e)?.name ?? (e.f ? groupOf(e.f) : kindName(e.s.kind)));
      by.set(g, [...(by.get(g) ?? []), e]);
    }
    return [...by.entries()].sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - ((order.indexOf(b[0]) + 99) % 99));
  })();

  // 搜索结果是按相关程度排的，排成一列从上往下看；平时条目多了才分栏
  const units = groups.reduce((a, g) => a + g[1].length + 1, 0);
  const cols = intoColumns(groups, searching ? 1 : Math.min(fit, Math.ceil(units / 12)));
  const counts = new Map(groups.map(([name, list]) => [name, list.length]));
  /** 这一组是不是某个平台的小组 */
  const platGroup = (name: string) => PLATFORMS.find((p) => !p.bank && p.name === name.replace("（续）", "") && (loginCount.get(p.id) ?? 0) >= 2);

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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" onPointerDown={touch} onKeyDown={touch}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
        <h1 className="text-[19px] font-bold">密码库</h1>
        <span className="text-xs text-muted">{secrets.length || ""}</span>
        <label className="flex h-[38px] min-w-[220px] grow basis-[320px] items-center gap-2 rounded-xl bg-surface-2 px-3.5 text-muted max-w-[560px]">
          <Search className="size-4" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜名称、网址、用户名、卡号后四位、标签…" aria-label="搜索密码库" className="min-w-0 grow bg-transparent text-fg outline-none placeholder:text-faint" />
          <kbd className="shrink-0 rounded-md bg-surface-3 px-1.5 text-[11px] text-muted" title="在任何页面按 Ctrl+K 都能搜密码库">
            Ctrl K
          </kbd>
        </label>
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
        <Button tone="primary" onClick={() => openEditor()}>
          <Plus className="size-4" />
          新建
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 px-1">
        <button aria-pressed={filter === "all" && !tag && !plat} onClick={() => (setFilter("all"), setTag(null), setPlat(null))} className={chip(filter === "all" && !tag && !plat)}>
          全部
        </button>
        {rawCount > 0 && (
          <button aria-pressed={filter === "raw"} onClick={() => setFilter(filter === "raw" ? "all" : "raw")} className={chip(filter === "raw")}>
            待整理 <span className="text-accent-strong">{rawCount}</span>
          </button>
        )}
        {KINDS.filter((k) => entries.some((e) => kindOf(e) === k.k)).map((k) => (
          <button key={k.k} aria-pressed={filter === k.k} onClick={() => setFilter(filter === k.k ? "all" : k.k)} className={chip(filter === k.k)}>
            {k.name} <span className="text-faint">{entries.filter((e) => kindOf(e) === k.k).length}</span>
          </button>
        ))}
        {platChips.map(([id, n]) => {
          const p = platformById(id)!;
          return (
            <button key={"p:" + id} aria-pressed={plat === id} onClick={() => setPlat(plat === id ? null : id)} className={cx(chip(plat === id), "flex items-center gap-1.5")}>
              <PlatformLogo p={p} size={14} />
              {p.name} <span className="text-faint">{n}</span>
            </button>
          );
        })}
        {allTags.map((t) => (
          <button key={"#" + t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)} className={chip(tag === t)}>
            #{t}
          </button>
        ))}
      </div>
      <main ref={listRef} aria-label="密码库里的条目" className="scroll-quiet flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[18px] bg-surface p-3">
        <div className="grid items-start gap-x-4" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
          {cols.map((col, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-2.5">
              {col.map(([name, list]) => (
                <section key={name} className="flex flex-col">
                  <h2 className="flex items-center gap-2 px-3 pt-1 pb-1 text-xs font-semibold text-muted">
                    {platGroup(name) && <PlatformLogo p={platGroup(name)!} size={14} />}
                    {name}
                    {!searching && !name.endsWith("（续）") && <span className="font-normal text-faint">{counts.get(name)}</span>}
                  </h2>
                  {list.map((e) => (
                    <ListRow key={e.s.id} e={e} open={sel === e.s.id} keys={data.keys} hasKey={!!vks[e.s.kid]} onToggle={() => setSel(sel === e.s.id ? null : e.s.id)} group={platGroup(name)} />
                  ))}
                </section>
              ))}
            </div>
          ))}
        </div>
        {!shown.length && (
          <div className="grid flex-1 place-items-center p-6 text-center text-sm text-faint">
            <div className="flex flex-col items-center gap-3">
              <KeyRound className="size-8 text-line" />
              {secrets.length ? "没有对得上的" : "还是空的。点「新建」，或者在快速记录里选「密码」随手记一条，之后再整理。"}
            </div>
          </div>
        )}
        {!!shown.length && <p className="px-3 pt-1 text-xs text-faint">点账号、密码那一格直接复制；点名称展开看全部。</p>}
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
