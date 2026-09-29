/* 连接与设置：这台电脑存数据（主机）还是连接到主机、AI 命令、导入导出 */
import { Download, FolderOpen, Plus, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { desk, errText, isApp } from "../lib/api";
import { importItems, qc, setConfig, useAppState, useConfig } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { useUi } from "../lib/store";
import type { Agent, Config, Item, State } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, ErrorText, Field, Toggle, inputCls } from "../components/ui";

const say = (t: string) => useUi.getState().say(t);

export function openSettings() {
  openDialog((close) => (isApp ? <AppSettings close={close} /> : <WebSettings close={close} />));
}

export function exportJson() {
  const items = qc.getQueryData<State>(["state"])?.items ?? [];
  const blob = new Blob([JSON.stringify({ version: 1, items }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `工作台备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

async function importFile(file: File) {
  try {
    const j = JSON.parse(await file.text());
    const items: Item[] = (Array.isArray(j) ? j : j.items || []).filter((x: Item) => x && typeof x.id === "string" && x.title);
    if (!items.length) return say("文件里没有可导入的条目");
    await importItems(items);
    say(`已导入 ${items.length} 条（相同条目保留较新的）`);
  } catch (e) {
    say("导入失败：" + errText(e));
  }
}

function ImportExport() {
  const f = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button onClick={exportJson}>
        <Download className="size-4" />
        导出 JSON
      </Button>
      <Button onClick={() => f.current?.click()}>
        <Upload className="size-4" />
        导入 JSON
      </Button>
      <input
        ref={f}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const x = e.target.files?.[0];
          if (x) importFile(x);
          e.target.value = "";
        }}
      />
    </>
  );
}

function WebSettings({ close }: { close: () => void }) {
  const st = useAppState().data;
  return (
    <Dialog title="网页版" desc="数据在主机上。网址可以直接打开，本地路径点「打开」会复制到剪贴板。" onClose={close} footer={<ImportExport />}>
      <p className="text-[13px] text-muted">
        共 {st?.items.length ?? 0} 条。给外部 AI 和脚本的接口文档：<code>{location.origin}/api/v1/openapi.json</code>
      </p>
    </Dialog>
  );
}

/** 桌面版的设置；first = 第一次打开，必须先选好角色 */
export function SettingsForm({ first, onDone }: { first?: boolean; onDone?: () => void }) {
  const app = useConfig().data;
  const c: Config = app?.config ?? { mode: "", dataDir: "", serverUrl: "", port: 8765, lanEnabled: true, agents: [], agentCwd: "", deviceId: "" };
  const [mode, setMode] = useState<"host" | "client">(c.mode === "client" ? "client" : "host");
  const [dataDir, setDataDir] = useState(c.dataDir);
  const [cold, setCold] = useState(c.coldBackupDir || "");
  const [lan, setLan] = useState(c.lanEnabled);
  const [port, setPort] = useState(String(c.port || 8765));
  const [url, setUrl] = useState(c.serverUrl);
  const [agents, setAgents] = useState<Agent[]>(() => (c.agents || []).map((a) => ({ ...a, ask: a.ask || "" })));
  const [cwd, setCwd] = useState(c.agentCwd || "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const cfg = {
      mode,
      dataDir: dataDir.trim(),
      serverUrl: url.trim(),
      port: parseInt(port, 10) || 8765,
      lanEnabled: lan,
      agents: first ? c.agents : agents.map((a) => ({ name: a.name.trim(), cmd: a.cmd.trim(), ask: (a.ask || "").trim() })).filter((a) => a.name && a.cmd),
      agentCwd: first ? c.agentCwd : cwd.trim(),
      coldBackupDir: cold.trim(),
    };
    if (mode === "host" && !cfg.dataDir) return setErr("请填写数据文件夹");
    if (mode === "client" && !cfg.serverUrl) return setErr("请填写主机地址");
    setBusy(true);
    setErr("");
    try {
      const r = await desk.saveConfig(cfg);
      setConfig({ config: r.config, lan: r.lan });
      say(r.lanError || "已保存");
      await qc.invalidateQueries({ queryKey: ["state"] });
      onDone?.();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  const choice = (k: "host" | "client", title: string, desc: string, body: React.ReactNode) => (
    <div
      role="radio"
      aria-checked={mode === k}
      tabIndex={0}
      onClick={() => setMode(k)}
      onKeyDown={(e) => e.key === " " && setMode(k)}
      className={cx("flex cursor-pointer flex-col gap-2.5 rounded-[14px] border-2 p-4", mode === k ? "border-accent bg-accent-soft/40" : "border-line hover:border-faint")}
    >
      <h3 className="text-[14.5px] font-semibold">{title}</h3>
      <p className="text-xs text-muted">{desc}</p>
      {mode === k && body}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="这台电脑的角色" className="grid gap-3 sm:grid-cols-2">
        {choice(
          "host",
          "这台电脑存数据（主机）",
          "数据写在下面的文件夹里，每天自动备份一份到 backups。",
          <>
            <Field label="数据文件夹">
              <input className={inputCls + " font-mono"} value={dataDir} onChange={(e) => setDataDir(e.target.value)} placeholder="例如 D:\xpanel" />
            </Field>
            <Field label="冷备份文件夹（可选，比如 8TB 盘）" hint="每天复制一份备份和新附件过去；留空 = 不做冷备份">
              <input className={inputCls + " font-mono"} value={cold} onChange={(e) => setCold(e.target.value)} />
            </Field>
            <Toggle checked={lan} onChange={setLan}>
              在局域网开放（其他电脑和浏览器访问要用）
            </Toggle>
            <Field label="端口">
              <input className={inputCls + " w-28"} value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </Field>
          </>,
        )}
        {choice(
          "client",
          "连接到主机",
          "这台电脑不存数据。连不上时照常能看、能记，恢复后自动上传。",
          <Field label="主机地址">
            <input className={inputCls + " font-mono"} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://主机名或IP:8765" />
          </Field>,
        )}
      </div>
      {!first && (
        <>
          <div className="flex flex-col gap-2 text-[12.5px] text-muted">
            <span>
              可以交给的 AI（命令里的 <code>{"{prompt}"}</code> 会换成提示词；以 http 开头的会在浏览器打开）。问答命令用于划词问 AI，留空时 claude / codex 自动用 <code>claude -p</code> / <code>codex exec -</code>
            </span>
            {agents.map((a, i) => (
              <div key={i} className="grid grid-cols-[120px_1fr_1fr_32px] gap-2">
                <input className={inputCls} value={a.name} onChange={(e) => setAgents((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="名称" aria-label="名称" />
                <input className={inputCls + " font-mono"} value={a.cmd} onChange={(e) => setAgents((l) => l.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)))} placeholder="命令，如 claude {prompt}" aria-label="命令" />
                <input className={inputCls + " font-mono"} value={a.ask || ""} onChange={(e) => setAgents((l) => l.map((x, j) => (j === i ? { ...x, ask: e.target.value } : x)))} placeholder="问答命令（可空）" aria-label="问答命令" />
                <button aria-label="删除" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger" onClick={() => setAgents((l) => l.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <div>
              <Button onClick={() => setAgents((l) => [...l, { name: "", cmd: "", ask: "" }])}>
                <Plus className="size-4" />
                添加
              </Button>
            </div>
          </div>
          <Field label="AI 默认工作目录">
            <input className={inputCls + " font-mono"} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="留空 = 用户目录" />
          </Field>
          {app?.lan?.running && (
            <p className="text-[13px] text-muted">
              局域网访问地址：
              {app.lan.urls.map((u) => (
                <code key={u} className="mr-2">
                  {u}
                </code>
              ))}
              <br />
              给外部 AI 的接口文档：<code>{app.lan.urls[0]}/api/v1/openapi.json</code>
            </p>
          )}
        </>
      )}
      <ErrorText>{err}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="primary" disabled={busy} onClick={save}>
          {busy ? (mode === "client" ? "正在连接主机…" : "保存中…") : "保存"}
        </Button>
        {!first && (
          <>
            <span className="grow" />
            {c.mode === "host" && (
              <Button onClick={() => desk.openDataDir().catch((e) => say(errText(e)))}>
                <FolderOpen className="size-4" />
                打开数据文件夹
              </Button>
            )}
            <Button onClick={() => desk.createShortcut().then((p) => say("已放到桌面：" + p), (e) => say(errText(e)))}>桌面快捷方式</Button>
            <ImportExport />
          </>
        )}
      </div>
    </div>
  );
}

function AppSettings({ close }: { close: () => void }) {
  return (
    <Dialog wide title="连接与设置" desc="数据只存在主机上；其他电脑和浏览器都连主机。" onClose={close}>
      <SettingsForm onDone={close} />
    </Dialog>
  );
}
