/* 在任何页面按 Ctrl+K（Mac 上 ⌘K）搜密码库：打几个字，回车复制密码，Tab 复制用户名，不用进密码库页面。
   锁着时先在这里输主密码。搜索全在本机做（lib/vaultSearch.ts）。 */
import { Lock, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText, errText } from "../lib/api";
import { useUi } from "../lib/store";
import { kindName, openSecret, unlock, useVault, useVaultUi } from "../lib/vault";
import { bumpUsage, domainOf, recentEntries, searchVault, titleOf, type Entry } from "../lib/vaultSearch";
import { cx } from "../lib/cx";
import { KIND_ICON, MasterInput, useVaultState } from "./Vault";
import { ErrorText } from "./ui";

const say = (t: string) => useUi.getState().say(t);

export function VaultPalette({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);
  if (!open) return null;
  return <Palette close={() => setOpen(false)} />;
}

function Palette({ close }: { close: () => void }) {
  const vault = useVaultState().data;
  const vks = useVault((s) => s.vks);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => (vault && vks ? vault.secrets.map((s) => ({ s, f: openSecret(s, vks) })).filter((e) => e.f) : []), [vault, vks]);
  const results = useMemo(() => {
    if (q.trim()) return searchVault(entries, q).slice(0, 8);
    // 还没打字：置顶的和最近用过的
    const recent = recentEntries(entries, 6);
    const pinned = entries.filter((e) => e.f?.pinned && !recent.includes(e));
    return [...pinned, ...recent].slice(0, 8);
  }, [entries, q]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    useVault.getState().touch();
    if (vks) input.current?.focus();
  }, [vks]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const copy = async (e: Entry, what: "password" | "username") => {
    const f = e.f!;
    const v = what === "username" ? f.username : f.kind === "raw" ? f.raw : f.password;
    const label = what === "username" ? "用户名" : f.kind === "raw" ? "原文" : f.kind === "apikey" ? "key" : "密码";
    if (!v) return say(`「${titleOf(e)}」没有${label}`);
    if (!(await copyText(v))) return say("复制失败");
    bumpUsage(e.s.id);
    useVault.getState().touch();
    say(`已复制「${titleOf(e)}」的${label}`);
    close();
  };
  const show = (e: Entry) => {
    useVaultUi.getState().setSel(e.s.id);
    useUi.getState().setView("vault");
    close();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    const cur = results[at];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) setAt((i) => (i + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing && cur) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) show(cur);
      else copy(cur, "password");
    } else if (e.key === "Tab" && cur) {
      e.preventDefault();
      copy(cur, "username");
    }
  };
  const open = async () => {
    if (!vault || !p || busy) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(vault.keys, p);
      setP("");
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(15_18_22/0.38)] px-4 pt-[14vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="搜密码库" className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-[18px] bg-surface shadow-3" onKeyDown={(e) => e.key === "Escape" && close()}>
        {!vault ? (
          <p className="p-6 text-sm text-muted">正在打开密码库…</p>
        ) : !vault.keys.length ? (
          <p className="p-6 text-sm text-muted">还没有密码库。点左边的「密码库」设一个主密码。</p>
        ) : !vks ? (
          <div className="flex flex-col gap-3 p-5">
            <span className="flex items-center gap-2 text-sm text-fg-2">
              <Lock className="size-4" />
              密码库锁着，输入主密码后搜索
            </span>
            <MasterInput label="主密码" value={p} onChange={setP} onEnter={open} autoFocus placeholder={busy ? "正在解锁…" : "主密码，回车解锁"} />
            <ErrorText>{err}</ErrorText>
          </div>
        ) : (
          <>
            <label className="flex h-[52px] shrink-0 items-center gap-2.5 px-5 text-muted">
              <Search className="size-[18px]" />
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="搜密码库：名称、网址、用户名、标签…"
                aria-label="搜密码库"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 grow bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
              />
            </label>
            <div ref={list} role="listbox" aria-label="结果" className="scroll-quiet flex max-h-[46vh] flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {results.map((e, i) => {
                const f = e.f!;
                const Icon = KIND_ICON[f.kind];
                return (
                  <div
                    key={e.s.id}
                    role="option"
                    aria-selected={i === at}
                    onMouseMove={() => setAt(i)}
                    onClick={() => copy(e, "password")}
                    className={cx("flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2", i === at ? "bg-surface-3" : "")}
                  >
                    <Icon className={cx("size-[18px] shrink-0", f.kind === "raw" ? "text-accent" : "text-muted")} strokeWidth={1.8} />
                    <span className="flex min-w-0 grow flex-col">
                      <span className="truncate text-[14px] font-semibold">{titleOf(e)}</span>
                      <span className="truncate font-mono text-xs text-muted">{f.kind === "raw" ? (f.raw ?? "").replace(/\s+/g, " ").slice(0, 70) : [f.username, domainOf(f.url)].filter(Boolean).join(" · ") || kindName(f.kind)}</span>
                    </span>
                    {(f.tags ?? []).slice(0, 2).map((t) => (
                      <span key={t} className="shrink-0 text-xs text-faint">
                        #{t}
                      </span>
                    ))}
                  </div>
                );
              })}
              {!results.length && <p className="px-3 py-3 text-[13px] text-faint">{q.trim() ? "没有对得上的" : entries.length ? "打几个字开始搜" : "密码库还是空的"}</p>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 bg-surface-2/60 px-5 py-2 text-[11.5px] text-muted">
              <span>回车 复制密码</span>
              <span>Tab 复制用户名</span>
              <span>Ctrl+回车 打开这一条</span>
              <span>Esc 关闭</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
