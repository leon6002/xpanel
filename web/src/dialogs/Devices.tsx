/* 设备：每台电脑一条记录，名字、描述、各局域网地址和项目自己维护；装了新版的电脑每分钟上报在线状态和 IP */
import { Monitor, Plus, X } from "lucide-react";
import { useState } from "react";
import { desk, errText, isApp, v1 } from "../lib/api";
import { qc, setConfig, useAppState, useConfig, useThisDevice } from "../lib/data";
import { Dialog, openDialog } from "../lib/dialog";
import { KINDS, devOnline, kindName, seenText } from "../lib/logic";
import { useUi } from "../lib/store";
import type { Device } from "../lib/types";
import { cx } from "../lib/cx";
import { Button, ConfirmButton, ErrorText, Field, inputCls, textareaCls } from "../components/ui";

export function openDevices(focus?: string) {
  openDialog((close) => <DevicesDialog close={close} focus={focus} />);
}

type Net = { name: string; ip: string; note: string };
type Proj = { name: string; path: string; agent: string; note: string };

function DeviceForm({ d, onDone }: { d: Device | null; onDone: () => void }) {
  const agents = useConfig().data?.config.agents ?? [];
  const [name, setName] = useState(d?.name || "");
  const [kind, setKind] = useState(d?.kind || "desktop");
  const [desc, setDesc] = useState(d?.description || "");
  const [alias, setAlias] = useState((d?.aliases || []).join(" "));
  const [nets, setNets] = useState<Net[]>(() => (d?.networks || []).map((n) => ({ name: n.name || "", ip: n.ip || "", note: n.note || "" })));
  const [projs, setProjs] = useState<Proj[]>(() => (d?.projects || []).map((p) => ({ name: p.name || "", path: p.path || "", agent: p.agent || "", note: p.note || "" })));
  const [err, setErr] = useState("");
  const upd = <T,>(set: React.Dispatch<React.SetStateAction<T[]>>, i: number, ch: Partial<T>) => set((l) => l.map((x, j) => (j === i ? { ...x, ...ch } : x)));
  const del = <T,>(set: React.Dispatch<React.SetStateAction<T[]>>, i: number) => set((l) => l.filter((_, j) => j !== i));
  const filled = (o: object) => Object.values(o).some(Boolean);
  async function save() {
    if (!name.trim()) return setErr("名称不能为空");
    const body = {
      name: name.trim(),
      kind,
      description: desc.trim(),
      aliases: alias.split(/[\s,，]+/).filter(Boolean),
      networks: nets.map((n) => ({ name: n.name.trim(), ip: n.ip.trim(), note: n.note.trim() })).filter(filled),
      projects: projs.map((p) => ({ name: p.name.trim(), path: p.path.trim(), agent: p.agent, note: p.note.trim() })).filter(filled),
    };
    try {
      if (d) await v1("PATCH", "/devices/" + encodeURIComponent(d.id), body);
      else await v1("POST", "/devices", body);
      await qc.invalidateQueries({ queryKey: ["state"] });
      useUi.getState().say("已保存");
      onDone();
    } catch (e) {
      setErr(errText(e));
    }
  }
  const rowCls = "grid items-center gap-2";
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border-2 border-accent p-4">
      <div className="grid grid-cols-[1fr_160px] gap-3">
        <Field label="名称（条目里 @名称 就会关联到这台）">
          <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如 台式机、BASE" />
        </Field>
        <Field label="类型">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="描述">
        <textarea className={textareaCls} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="用途、配置、放在哪里、注意事项…" />
      </Field>
      <Field label="别名（空格分隔；也用于 @提及 和按主机名匹配入口）">
        <input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="如 base 台式 8tb" />
      </Field>
      <div className="flex flex-col gap-1.5 text-[12.5px] text-muted">
        各局域网里的地址（上报的新地址和某条同网段时会自动更新）
        {nets.map((n, i) => (
          <div key={i} className={cx(rowCls, "grid-cols-[1fr_1fr_1fr_32px]")}>
            <input className={inputCls} value={n.name} onChange={(e) => upd(setNets, i, { name: e.target.value })} placeholder="局域网，如 家里" />
            <input className={inputCls + " font-mono"} value={n.ip} onChange={(e) => upd(setNets, i, { ip: e.target.value })} placeholder="IP，如 192.168.1.20" />
            <input className={inputCls} value={n.note} onChange={(e) => upd(setNets, i, { note: e.target.value })} placeholder="备注" />
            <button aria-label="删除" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger" onClick={() => del(setNets, i)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
        <div>
          <Button onClick={() => setNets((l) => [...l, { name: "", ip: "", note: "" }])}>
            <Plus className="size-4" />
            添加局域网
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-[12.5px] text-muted">
        项目（消息分发的目标：发到这台电脑的哪个文件夹、交给哪个 AI）
        {projs.map((p, i) => (
          <div key={i} className={cx(rowCls, "grid-cols-[1fr_1.6fr_1fr_1fr_32px]")}>
            <input className={inputCls} value={p.name} onChange={(e) => upd(setProjs, i, { name: e.target.value })} placeholder="项目名" />
            <input className={inputCls + " font-mono"} value={p.path} onChange={(e) => upd(setProjs, i, { path: e.target.value })} placeholder="本机路径，如 D:\codes\xpanel" />
            <select className={inputCls} value={p.agent} onChange={(e) => upd(setProjs, i, { agent: e.target.value })}>
              <option value="">默认 AI</option>
              {[...new Set([...agents.map((a) => a.name), ...(p.agent ? [p.agent] : [])])].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <input className={inputCls} value={p.note} onChange={(e) => upd(setProjs, i, { note: e.target.value })} placeholder="备注" />
            <button aria-label="删除" className="grid size-8 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger" onClick={() => del(setProjs, i)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
        <div>
          <Button onClick={() => setProjs((l) => [...l, { name: "", path: "", agent: "", note: "" }])}>
            <Plus className="size-4" />
            添加项目
          </Button>
        </div>
      </div>
      <ErrorText>{err}</ErrorText>
      <div className="flex gap-2">
        <Button tone="primary" onClick={save}>
          保存
        </Button>
        <Button tone="ghost" onClick={onDone}>
          取消
        </Button>
        <span className="grow" />
        {d && (
          <ConfirmButton
            confirm="再点一次确认删除（条目里的设备名会保留）"
            onConfirm={async () => {
              try {
                await v1("DELETE", "/devices/" + encodeURIComponent(d.id));
                await qc.invalidateQueries({ queryKey: ["state"] });
                useUi.getState().say("已删除");
                onDone();
              } catch (e) {
                setErr(errText(e));
              }
            }}
          >
            删除
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}

function DeviceCard({ d, me, onEdit }: { d: Device; me: boolean; onEdit: () => void }) {
  const items = useAppState().data?.items ?? [];
  const kv: [string, React.ReactNode][] = [];
  const sys = [d.hostname, d.os, d.agentVersion ? "v" + d.agentVersion : ""].filter(Boolean).join(" · ");
  if (sys) kv.push(["系统", sys]);
  kv.push(["状态", seenText(d)]);
  if ((d.reportedIps || []).length)
    kv.push([
      "当前 IP",
      (d.reportedIps || []).map((x) => (
        <div key={x.ip}>
          <code>{x.ip}</code> {x.iface && <span className="text-faint">{x.iface}</span>}
        </div>
      )),
    ]);
  if ((d.networks || []).length)
    kv.push([
      "局域网",
      (d.networks || []).map((n, i) => (
        <div key={i}>
          {n.name}：<code>{n.ip || "—"}</code> {n.note && <span className="text-faint">{n.note}</span>}
        </div>
      )),
    ]);
  if ((d.projects || []).length)
    kv.push([
      "项目",
      (d.projects || []).map((p, i) => (
        <div key={i}>
          {p.name}：<code>{p.path}</code>
          {p.agent ? ` → ${p.agent}` : ""}
        </div>
      )),
    ]);
  if ((d.aiTools || []).length) kv.push(["AI 命令行", (d.aiTools || []).join("、")]);
  if ((d.aliases || []).length) kv.push(["别名", (d.aliases || []).join("、")]);
  const open = items.filter((i) => i.device === d.name && !i.done).length;
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-line p-4" data-dev-id={d.id}>
      <div className="flex items-center gap-2">
        <span className={cx("size-2 rounded-full", devOnline(d) ? "bg-ok" : "bg-line")} />
        <b>{d.name}</b>
        <span className="rounded bg-surface-3 px-1.5 text-xs text-muted">{kindName(d.kind)}</span>
        {me && <span className="rounded bg-accent-soft px-1.5 text-xs text-accent-strong">本机</span>}
        {d.isHost && <span className="rounded bg-surface-3 px-1.5 text-xs text-muted">主机</span>}
        <span className="grow" />
        <span className="text-xs text-faint">{open} 条未完成</span>
        <Button onClick={onEdit}>编辑</Button>
      </div>
      {d.description && <div className="text-[13px] whitespace-pre-wrap text-fg-2">{d.description}</div>}
      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 text-[13px]">
        {kv.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 桌面版还没选「这台电脑是哪台设备」 */
function Claim() {
  const devices = useAppState().data?.devices ?? [];
  const me = useThisDevice();
  const hn = me.hostname;
  const guess = devices.find((d) => d.hostname && d.hostname.toLowerCase() === hn.toLowerCase());
  const [pick, setPick] = useState(guess?.id || "");
  if (!isApp || me.id) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[14px] bg-accent-soft px-4 py-3 text-[13px] text-accent-strong">
      <Monitor className="size-4" />
      <span className="grow">
        这台电脑{hn && <code>（{hn}）</code>}是哪台设备？选好后会自动上报在线状态和当前 IP。
      </span>
      <select className={inputCls + " w-auto"} value={pick} onChange={(e) => setPick(e.target.value)}>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}（{kindName(d.kind)}）
          </option>
        ))}
        <option value="">新建：{hn || "这台电脑"}</option>
      </select>
      <Button
        tone="primary"
        onClick={async () => {
          try {
            let id = pick;
            if (!id) {
              const name = (hn || "这台电脑").replace(/[\s@#]/g, "").slice(0, 36) || "这台电脑";
              const d = await v1<Device>("POST", "/devices", { name: devices.some((x) => x.name === name) ? name + "-" + Math.random().toString(36).slice(2, 5) : name });
              id = d.id;
            }
            const r = await desk.setThisDevice(id);
            setConfig({ config: r.config });
            await qc.invalidateQueries({ queryKey: ["state"] });
            useUi.getState().say("已设为这台电脑");
          } catch (e) {
            useUi.getState().say(errText(e));
          }
        }}
      >
        设为这台电脑
      </Button>
    </div>
  );
}

function DevicesDialog({ close, focus }: { close: () => void; focus?: string }) {
  const devices = useAppState().data?.devices ?? [];
  const me = useThisDevice();
  const [edit, setEdit] = useState<string | null>(null);
  const list = focus ? [...devices.filter((d) => d.id === focus), ...devices.filter((d) => d.id !== focus)] : devices;
  return (
    <Dialog
      wide
      title="设备"
      desc="每台电脑一条记录，名字、描述、各局域网地址和项目自己维护；装了新版桌面程序的电脑每分钟上报一次在线状态和当前 IP。"
      onClose={close}
      footer={
        !edit && (
          <Button onClick={() => setEdit("new")}>
            <Plus className="size-4" />
            新建设备
          </Button>
        )
      }
    >
      <Claim />
      {edit === "new" && <DeviceForm d={null} onDone={() => setEdit(null)} />}
      {list.map((d) => (edit === d.id ? <DeviceForm key={d.id} d={d} onDone={() => setEdit(null)} /> : <DeviceCard key={d.id} d={d} me={d.id === me.id} onEdit={() => setEdit(d.id)} />))}
      {!devices.length && edit !== "new" && <div className="py-4 text-center text-[13px] text-faint">还没有设备</div>}
    </Dialog>
  );
}
