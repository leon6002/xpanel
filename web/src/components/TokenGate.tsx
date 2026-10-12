/* 局域网访问要令牌：浏览器还没登录时整页换成这里，输入主机设置里生成的令牌。
   对了主机种一个 cookie（HttpOnly，页面里的脚本读不到），之后图片、推送都自动带上；桌面版走自己的设置，不经过这里。
   还有主机这边的「局域网访问」设置（LanAccess）：开关、生成和删除令牌，只有主机本机能改。 */
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { access, auth, copyText, errText, NEED_TOKEN, type AccessInfo } from "../lib/api";
import { useUi } from "../lib/store";
import { Button, ConfirmButton, ErrorText, inputCls, Logo, Toggle } from "./ui";

export const useNeedToken = create<boolean>(() => false);
window.addEventListener(NEED_TOKEN, () => useNeedToken.setState(true, true));

export function TokenGate() {
  const [t, setT] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!t.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await auth.login(t);
      location.reload();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] bg-surface p-7 shadow-3">
        <div className="flex items-center gap-3">
          <Logo size={34} />
          <div>
            <h1 className="text-[18px] font-bold">输入令牌</h1>
            <p className="text-[13px] text-muted">这台主机打开了「局域网访问要令牌」。</p>
          </div>
        </div>
        <input
          autoFocus
          type="password"
          aria-label="令牌"
          value={t}
          onChange={(e) => setT(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="xp_…"
          className={inputCls + " font-mono"}
        />
        <ErrorText>{err}</ErrorText>
        <Button tone="primary" disabled={busy || !t.trim()} onClick={go}>
          <KeyRound className="size-4" />
          {busy ? "正在验证…" : "进入"}
        </Button>
        <p className="text-xs leading-relaxed text-faint">令牌在主机的桌面版里生成：设置 → 局域网访问 → 生成令牌。这个浏览器记住一年，换浏览器要重新输入。</p>
      </div>
    </div>
  );
}

const fmt = (t?: number | null) => (t ? new Date(t).toLocaleDateString() : "没用过");

/** 主机的设置里：局域网访问要不要令牌、能不能叫本机的 AI、令牌列表 */
export function LanAccess() {
  const say = useUi((s) => s.say);
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const load = () => access.get().then(setInfo, (e) => setErr(errText(e)));
  useEffect(() => {
    load();
  }, []);
  if (!info) return err ? <ErrorText>{err}</ErrorText> : null;
  const a = info.access;
  const set = async (next: typeof a) => {
    setErr("");
    try {
      const r = await access.set(next);
      setInfo({ ...info, access: r.access });
    } catch (e) {
      setErr(errText(e));
    }
  };
  const create = async () => {
    const n = name.trim() || `令牌 ${info.tokens.length + 1}`;
    setErr("");
    try {
      setFresh(await access.create(n));
      setName("");
      await load();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const remove = async (n: string) => {
    try {
      await access.remove(n);
      if (fresh?.name === n) setFresh(null);
      await load();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <section aria-label="局域网访问" className="flex flex-col gap-3 rounded-[14px] bg-surface-2/60 p-4">
      <h3 className="text-[14.5px] font-semibold">局域网访问</h3>
      <Toggle checked={a.requireToken} onChange={(v) => set({ requireToken: v, remoteAi: v && a.remoteAi })}>
        <span>要令牌才能访问</span>
        <span className="text-xs text-muted">别的电脑、手机和浏览器要输入令牌；这台电脑自己不用。连接模式的电脑在它的设置里填令牌。</span>
      </Toggle>
      <Toggle checked={a.remoteAi} onChange={(v) => (a.requireToken ? set({ ...a, remoteAi: v }) : setErr("先打开「要令牌才能访问」"))}>
        <span>允许局域网叫这台电脑上的 AI</span>
        <span className="text-xs text-muted">带令牌的浏览器可以在评论里 @AI、交给 AI 讨论和开工，用的是这台电脑上设置的 Claude Code 等；要确认的事在发起的那个浏览器里点。</span>
      </Toggle>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-muted">令牌（一台电脑或一个人一把，方便单独删掉）</span>
        {info.tokens.map((k) => (
          <div key={k.name} className="flex items-center gap-3 rounded-[10px] bg-surface px-3 py-1.5 text-[13px]">
            <span className="min-w-0 grow truncate font-medium">{k.name}</span>
            <span className="text-xs whitespace-nowrap text-faint">最后使用：{fmt(k.lastUsed)}</span>
            <ConfirmButton tone="ghost" confirm="确定删除" onConfirm={() => remove(k.name)} className="h-7 px-2 text-xs">
              <Trash2 className="size-3.5" />
            </ConfirmButton>
          </div>
        ))}
        {fresh && (
          <div className="flex flex-col gap-1.5 rounded-[10px] bg-accent-soft px-3 py-2.5 text-[13px]">
            <span>「{fresh.name}」的令牌，只显示这一次，复制下来填到要用的地方：</span>
            <span className="flex items-center gap-2">
              <code className="min-w-0 grow truncate font-mono text-[12.5px]" aria-label="新令牌">
                {fresh.token}
              </code>
              <Button className="h-7 px-2.5 text-xs" onClick={async () => say((await copyText(fresh.token)) ? "已复制" : "复制失败")}>
                <Copy className="size-3.5" />
                复制
              </Button>
            </span>
          </div>
        )}
        <div className="flex gap-2">
          <input aria-label="令牌名称" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="给谁用的，比如 笔记本、手机" className={inputCls + " max-w-64"} />
          <Button onClick={create}>
            <Plus className="size-4" />
            生成令牌
          </Button>
        </div>
      </div>
      <ErrorText>{err}</ErrorText>
    </section>
  );
}
