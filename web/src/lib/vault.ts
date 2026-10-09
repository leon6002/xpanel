/* 密码库：加密、解密都在这里（界面里）做，主机只存密文，主密码不离开这台电脑。
   - 主密码 --scrypt--> 包装密钥，用它把随机生成的「密码库密钥」包起来存到主机（一把「钥匙」）；改主密码只是重新包一次
   - 每一条的内容（名称、种类、网址、用户名、密码、备注…）用密码库密钥加密（XChaCha20-Poly1305）。
     主机上另外存一份明文的名称和种类，只是给锁着时和 AI 的列表用的标签；解开后一律以密文里的为准，
     不然别人可以把一条的密文挂到另一个名称下面，骗用户批准
   - 改动（存、删、改主密码、批准取用）要带一个校验值：用从密码库密钥派生的校验密钥算的 HMAC。
     接口在局域网里不用登录，没有它谁都能改掉、删掉密文或者冒充用户批准
   - AI 取用：用户点了允许，才把那一条用请求方的临时公钥加密（X25519 + HKDF-SHA256）后交给主机转交，主机看不到内容
   用的是纯 JS 的 @noble 库而不是浏览器自带的 crypto.subtle：局域网里用 http://主机:8765 打开时浏览器不提供后者。 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { create } from "zustand";
import { newId, v1 } from "./api";
import { qc } from "./data";
import { platformOf } from "./platforms";

export type SecretKind = "login" | "bank" | "apikey" | "server" | "other";
/** 银行下面分两种 */
export type BankSub = "mobile" | "credit";
export const SUBS: { k: BankSub; name: string }[] = [
  { k: "mobile", name: "手机银行" },
  { k: "credit", name: "信用卡" },
];
/** raw = 待整理：快速记下的原文，还没拆成各栏 */
export type AnyKind = SecretKind | "raw";
export const KINDS: { k: SecretKind; name: string; hint: string }[] = [
  { k: "login", name: "网站账号", hint: "网址、用户名、密码" },
  { k: "bank", name: "银行", hint: "手机银行、信用卡" },
  { k: "apikey", name: "API key", hint: "各种服务的 key、token" },
  { k: "server", name: "服务器和设备", hint: "SSH、路由器、NAS、数据库" },
  { k: "other", name: "其他", hint: "恢复码、门禁、证件号…" },
];
export const kindName = (k: string) => (k === "raw" ? "待整理" : (KINDS.find((x) => x.k === k)?.name ?? k));

export interface Kdf { alg: "scrypt"; N: number; r: number; p: number }
/** 一把钥匙：主密码包着的密码库密钥 */
export interface KeyRec { kid: string; createdAt: number; updatedAt: number; kdf: Kdf; salt: string; n: string; c: string; /** 「只进不出」的公钥：锁着时用它往里存 */ pub?: string | null }
/** 主机上存的一条（密文）。有 epk 的是快速记下、还没整理的：用钥匙的公钥加密的 */
export interface SecretRec { id: string; kid: string; title: string; kind: AnyKind; createdAt: number; updatedAt: number; n: string; c: string; epk?: string | null }
export interface VaultState { keys: KeyRec[]; secrets: SecretRec[] }
export interface Extra { label: string; value: string; hidden?: boolean }
/** 一条里加密的内容。title、kind 在这里才是真的，主机上那份明文只是标签 */
export interface Fields {
  title: string;
  kind: AnyKind;
  /** 银行的：手机银行还是信用卡 */
  sub?: BankSub;
  /** 哪个平台的账号（lib/platforms.ts 里的标识；"none" = 不算任何平台）。没记的按名称和网址认 */
  platform?: string;
  /** 用途：同一个平台有好几个账号时用来区分（美区、工作、小号…） */
  label?: string;
  url?: string;
  username?: string;
  password?: string;
  /** 银行卡：卡号、有效期、安全码、交易（取款、查询）密码 */
  card?: string;
  expiry?: string;
  cvv?: string;
  pin?: string;
  notes?: string;
  extra?: Extra[];
  /** 标签和置顶也在密文里：锁着时和给 AI 的列表里看不到 */
  tags?: string[];
  pinned?: boolean;
  /** 待整理的：记下来的原文 */
  raw?: string;
}
/* ---- 每种条目有哪几栏、各叫什么。列表、详情、编辑、搜索都照这个来 ---- */
export type FieldKey = "url" | "username" | "password" | "card" | "expiry" | "cvv" | "pin";
export interface Spec {
  key: FieldKey;
  label: string;
  /** 平时遮住 */
  secret?: boolean;
  /** 列表里「账号」那一格放它（用来认这一条是哪个号） */
  id?: boolean;
  /** 列表里「密码」那一格放它，全局搜索里回车复制的也是它 */
  main?: boolean;
  /** 卡号：平时只露出后四位 */
  tail?: boolean;
  /** 可以生成随机密码 */
  gen?: boolean;
  hint?: string;
}
const SPECS: Record<string, Spec[]> = {
  login: [
    { key: "url", label: "网址", hint: "https://…" },
    { key: "username", label: "用户名", id: true },
    { key: "password", label: "密码", secret: true, main: true, gen: true },
  ],
  "bank:mobile": [
    { key: "username", label: "登录账号", id: true, hint: "手机号、身份证号或用户名" },
    { key: "password", label: "登录密码", secret: true, main: true },
    { key: "card", label: "卡号", tail: true },
    { key: "pin", label: "交易 / 取款密码", secret: true },
    { key: "url", label: "网址（可选）" },
  ],
  "bank:credit": [
    { key: "card", label: "卡号", id: true, main: true, tail: true },
    { key: "expiry", label: "有效期", hint: "月/年，如 08/29" },
    { key: "cvv", label: "安全码（CVV）", secret: true },
    { key: "pin", label: "交易 / 查询密码", secret: true },
    { key: "username", label: "网银账号（可选）" },
    { key: "password", label: "网银密码（可选）", secret: true },
  ],
  apikey: [
    { key: "url", label: "服务或网址（可选）" },
    { key: "username", label: "账号（可选）", id: true },
    { key: "password", label: "Key / Token", secret: true, main: true },
  ],
  server: [
    { key: "url", label: "地址", hint: "主机名或 IP，可以带端口" },
    { key: "username", label: "用户名", id: true },
    { key: "password", label: "密码", secret: true, main: true, gen: true },
  ],
  other: [
    { key: "url", label: "网址或地方（可选）" },
    { key: "username", label: "账号（可选）", id: true },
    { key: "password", label: "要保密的内容", secret: true, main: true },
  ],
};
export function specOf(kind: AnyKind, sub?: BankSub, idLabel?: string): Spec[] {
  const specs = SPECS[kind === "bank" ? `bank:${sub === "credit" ? "credit" : "mobile"}` : kind] ?? SPECS.other;
  // 有的平台「账号」那一栏有自己的叫法（Apple ID、QQ 号）
  return idLabel && kind !== "bank" ? specs.map((x) => (x.id ? { ...x, label: idLabel } : x)) : specs;
}
/** 这一条的各栏（带上平台对栏名的叫法） */
export const specsFor = (f: Pick<Fields, "kind" | "sub" | "title" | "url" | "platform">) => specOf(f.kind, f.sub, platformOf(f)?.idLabel);
/** 分组用的名字：银行会带上是手机银行还是信用卡 */
export const groupOf = (f: Pick<Fields, "kind" | "sub">) => (f.kind === "bank" ? `银行 · ${f.sub === "credit" ? "信用卡" : "手机银行"}` : kindName(f.kind));
/** 卡号平时的样子：只露后四位 */
export const tailOf = (v: string) => "•••• " + v.replace(/\s+/g, "").slice(-4);
/** 列表里「账号」那一格：这种条目规定的那一栏；没填就退而求其次，找一栏不用遮的 */
export function identityOf(f: Fields): { spec: Spec; value: string } | null {
  const specs = specsFor(f);
  const s = specs.find((x) => x.id && f[x.key]) ?? specs.find((x) => !x.secret && !x.main && x.key !== "url" && f[x.key]);
  return s ? { spec: s, value: f[s.key]! } : null;
}
/** 最常要复制的那一栏（密码、key；信用卡是卡号） */
export function mainOf(f: Fields): { spec: Spec; value: string } | null {
  const specs = specsFor(f);
  const s = specs.find((x) => x.main && f[x.key]) ?? specs.find((x) => x.secret && f[x.key]);
  return s ? { spec: s, value: f[s.key]! } : null;
}

/** AI 发来、等用户确认的取用请求。title 是主机上的标签（不可信），left 是还剩多少毫秒 */
export interface VaultRequest { id: string; secretId: string; title: string; actor: string; reason: string; pub: string; left: number }
/** 解开的一把钥匙：密码库密钥，和从它派生的校验密钥、「只进不出」的私钥 */
export interface Opened { vk: Uint8Array; auth: Uint8Array; box: Uint8Array }
export type OpenedKeys = Record<string, Opened>;

const KDF: Kdf = { alg: "scrypt", N: 2 ** 17, r: 8, p: 1 };
const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD_KEY = enc.encode("xpanel-vault-key-v1");
const AAD_SECRET = enc.encode("xpanel-vault-secret-v1");
const INFO_REQUEST = enc.encode("xpanel-vault-request-v1");
const INFO_AUTH = enc.encode("xpanel-vault-auth-v1");
const INFO_BOX = enc.encode("xpanel-vault-box-v1");
const INFO_DROP = enc.encode("xpanel-vault-drop-v1");

const authOf = (vk: Uint8Array) => hkdf(sha256, vk, undefined, INFO_AUTH, 32);
/** 「只进不出」的密钥对从密码库密钥派生：公钥登记在主机上，谁都能用它往里存；私钥要解锁才有 */
const opened = (vk: Uint8Array): Opened => ({ vk, auth: authOf(vk), box: hkdf(sha256, vk, undefined, INFO_BOX, 32) });
const pubOf = (k: Opened) => b64(x25519.getPublicKey(k.box));
/** 这次改动的校验值：各部分用换行连起来算 HMAC（主机那边 vault.rs 的 check_mac 按同样的顺序验） */
const mac = (k: Opened, parts: (string | number)[]) => b64(hmac(sha256, k.auth, enc.encode(parts.join("\n"))));
/** updatedAt 放进校验串里的写法：主机上的时间都是整数毫秒 */
const stamp = (t?: number) => (t == null ? "" : String(Math.trunc(t)));

export function b64(u: Uint8Array) {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** 主密码 → 包装密钥。要算一会儿（故意的，让猜密码变慢） */
/** 参数是主机给的，不能照单全收：太小等于没保护，太大会把这台电脑卡死 */
const kdfOk = (kdf?: Kdf) => !!kdf && kdf.alg === "scrypt" && kdf.N >= 2 ** 15 && kdf.N <= 2 ** 18 && Number.isInteger(Math.log2(kdf.N)) && kdf.r === 8 && kdf.p >= 1 && kdf.p <= 2;
function kek(password: string, salt: Uint8Array, kdf: Kdf) {
  if (!kdfOk(kdf)) throw new Error("这把钥匙的参数不认识");
  return scryptAsync(enc.encode(password.normalize("NFKC")), salt, { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 31 });
}

/** 用主密码把密码库密钥包起来（新建钥匙、改主密码） */
async function wrap(password: string, vk: Uint8Array) {
  const salt = randomBytes(16);
  const n = randomBytes(24);
  const k = await kek(password, salt, KDF);
  return { kdf: KDF, salt: b64(salt), n: b64(n), c: b64(xchacha20poly1305(k, n, AAD_KEY).encrypt(vk)) };
}

async function unwrap(password: string, key: KeyRec): Promise<Uint8Array | null> {
  try {
    const k = await kek(password, unb64(key.salt), key.kdf);
    const vk = xchacha20poly1305(k, unb64(key.n), AAD_KEY).decrypt(unb64(key.c));
    return vk.length === 32 ? vk : null;
  } catch {
    return null; // 主密码不对，或者这把钥匙的内容坏了
  }
}

/** 主密码能解开哪几把钥匙（一般只有一把）。skip 里已经解开的不再算 */
export async function unwrapAll(keys: KeyRec[], password: string, skip: OpenedKeys = {}) {
  const got: OpenedKeys = {};
  for (const k of keys) {
    if (skip[k.kid]) continue;
    const vk = await unwrap(password, k);
    if (vk) got[k.kid] = opened(vk);
  }
  return got;
}

export function encryptFields(vk: Uint8Array, f: Fields) {
  const n = randomBytes(24);
  return { n: b64(n), c: b64(xchacha20poly1305(vk, n, AAD_SECRET).encrypt(enc.encode(JSON.stringify(f)))) };
}
export function decryptFields(vk: Uint8Array, s: Pick<SecretRec, "n" | "c">): Fields {
  return JSON.parse(dec.decode(xchacha20poly1305(vk, unb64(s.n), AAD_SECRET).decrypt(unb64(s.c)))) as Fields;
}

/** 把内容加密给一个公钥：请求方（AI 那边的临时公钥，主机只转交），或者密码库自己的公钥（快速记录） */
export function seal(pub: string, payload: unknown, info = INFO_REQUEST) {
  const their = unb64(pub);
  const mine = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(mine);
  const shared = x25519.getSharedSecret(mine, their);
  if (shared.every((b) => b === 0)) throw new Error("请求里的公钥不对");
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(their, 32);
  const n = randomBytes(24);
  const k = hkdf(sha256, shared, salt, info, 32);
  return { epk: b64(epk), n: b64(n), c: b64(xchacha20poly1305(k, n).encrypt(enc.encode(JSON.stringify(payload)))) };
}

/** 解开快速记下的一条（seal 的反过程，用密码库的私钥） */
function unseal(k: Opened, s: { epk: string; n: string; c: string }): unknown {
  const epk = unb64(s.epk);
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(x25519.getPublicKey(k.box), 32);
  const key = hkdf(sha256, x25519.getSharedSecret(k.box, epk), salt, INFO_DROP, 32);
  return JSON.parse(dec.decode(xchacha20poly1305(key, unb64(s.n)).decrypt(unb64(s.c))));
}

/** 随机密码。symbols = false 时只有字母和数字（有些网站不让用符号） */
export function generatePassword(len = 20, symbols = true) {
  const sets = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", ...(symbols ? ["!@#$%^&*-_=+?"] : [])];
  const all = sets.join("");
  const pick = (s: string) => {
    // 丢掉会让分布不均的值
    const max = 256 - (256 % s.length);
    for (;;) {
      const b = randomBytes(1)[0];
      if (b < max) return s[b % s.length];
    }
  };
  for (;;) {
    const p = Array.from({ length: len }, () => pick(all)).join("");
    if (sets.every((s) => [...p].some((ch) => s.includes(ch)))) return p;
  }
}

/** 主密码大概有多强：0 太弱（不让用）、1 一般、2 好。
    包着的密钥在局域网里谁都读得到，主密码是唯一的防线，所以常见的写法直接不让用 */
const COMMON = /pass(word)?|qwer|asdf|zxcv|1234|4321|abcd|(.)\2{3}|iloveyou|admin|letmein|welcome|xpanel|woaini|mima/i;
export function strength(p: string) {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\da-zA-Z]/].filter((r) => r.test(p)).length;
  const n = [...p].length;
  if (n < 12 || new Set(p).size < 6 || /^\d+$/.test(p)) return 0;
  if (COMMON.test(p)) return 0;
  return n >= 20 || (n >= 14 && kinds >= 3) ? 2 : 1;
}

/* ---------------------------------------------------------------- 解锁状态（只在内存里，刷新页面就锁上） */

/** 多久不碰密码库就自动锁上 */
export const AUTO_LOCK_MS = 10 * 60 * 1000;
interface Unlocked {
  /** 解开的钥匙，按钥匙的标识；null = 锁着 */
  vks: OpenedKeys | null;
  touched: number;
  touch: () => void;
  lock: () => void;
}
export const useVault = create<Unlocked>((set, get) => ({
  vks: null,
  touched: 0,
  touch: () => get().vks && set({ touched: Date.now() }),
  lock: () => {
    const vks = get().vks;
    if (vks)
      for (const k of Object.values(vks)) {
        k.vk.fill(0);
        k.auth.fill(0);
        k.box.fill(0);
      }
    set({ vks: null });
  },
}));
/* 到点就锁。用「现在离上次用过了多久」来判断而不是定一个闹钟：电脑睡着的时候闹钟不走 */
const lockIfIdle = () => {
  const { vks, touched, lock } = useVault.getState();
  if (vks && Date.now() - touched > AUTO_LOCK_MS) lock();
};
window.setInterval(lockIfIdle, 15000);
document.addEventListener("visibilitychange", lockIfIdle);
window.addEventListener("focus", lockIfIdle);

/** 密码库页面里选中的是哪一条（全局搜索也会改它，跳过来看） */
export const useVaultUi = create<{ sel: string | null; setSel: (id: string | null) => void }>((set) => ({ sel: null, setSel: (sel) => set({ sel }) }));

export const VAULT_KEY = ["vault"] as const;
export const fetchVault = () => v1<VaultState>("GET", "/vault");
const setVault = (f: (s: VaultState) => VaultState) => qc.setQueryData<VaultState>(VAULT_KEY, (s) => (s ? f(s) : s));
const setOpened = (vks: OpenedKeys) => useVault.setState({ vks, touched: Date.now() });

/** 第一次用：设主密码，建一把钥匙 */
export async function createVault(password: string) {
  const k = opened(randomBytes(32));
  const kid = newId();
  const st = await v1<VaultState>("PUT", `/vault/keys/${kid}`, { data: { ...(await wrap(password, k.vk)), auth: b64(k.auth), pub: pubOf(k) } });
  qc.setQueryData(VAULT_KEY, st);
  setOpened({ [kid]: k });
}

/** 旧版本建的钥匙还没登记公钥：解锁后补上，之后锁着也能快速记录 */
async function ensureBox(keys: KeyRec[], got: OpenedKeys) {
  for (const key of keys) {
    const k = got[key.kid];
    if (!k || key.pub === pubOf(k)) continue;
    try {
      qc.setQueryData(VAULT_KEY, await v1<VaultState>("PUT", `/vault/keys/${key.kid}/box`, { pub: pubOf(k), mac: mac(k, ["put-box", key.kid, pubOf(k)]) }));
    } catch {
      /* 这次没登记上不影响用，下次解锁再试 */
    }
  }
}

/** 解锁：主密码能解开哪几把钥匙就解开哪几把。一把都解不开 = 主密码不对 */
export async function unlock(keys: KeyRec[], password: string) {
  const got = await unwrapAll(keys, password, useVault.getState().vks ?? {});
  if (!Object.keys(got).length) throw new Error(keys.some((k) => !kdfOk(k.kdf)) ? "这把钥匙的参数这个版本不认识，请把 xpanel 升级到最新" : "主密码不对");
  // 算密钥要一秒左右，这期间可能自动锁上了（旧的钥匙已经被抹掉）：以现在的状态为准
  setOpened({ ...(useVault.getState().vks ?? {}), ...got });
  void ensureBox(keys, got);
}

/** 快速记一条进密码库，之后再整理。不用解锁：用钥匙的公钥加密，解锁了才看得到 */
export async function dropSecret(text: string) {
  const raw = text.trim();
  if (!raw) return null;
  const st: VaultState = qc.getQueryData<VaultState>(VAULT_KEY) ?? (await fetchVault());
  if (!st.keys.length) throw new Error("还没有密码库：先点左边的「密码库」设一个主密码");
  const key = st.keys.find((k) => k.pub);
  if (!key?.pub) throw new Error("先去密码库解锁一次（升级后第一次需要），之后锁着也能直接存");
  const rec = await v1<SecretRec>("POST", "/vault/drops", { kid: key.kid, ...seal(key.pub, { raw, at: Date.now() }, INFO_DROP) });
  setVault((s) => ({ ...s, secrets: [...s.secrets.filter((x) => x.id !== rec.id), rec] }));
  return rec;
}

/** 改主密码：先用旧的验证，再用新的把每把解开的钥匙重新包一次（条目不用动，密码库密钥也不变） */
export async function changePassword(keys: KeyRec[], oldPassword: string, newPassword: string) {
  const mine = await unwrapAll(keys, oldPassword);
  if (!Object.keys(mine).length) throw new Error("原来的主密码不对");
  let st: VaultState | undefined;
  for (const k of keys) {
    const o = mine[k.kid];
    if (!o) continue;
    const data = await wrap(newPassword, o.vk);
    st = await v1<VaultState>("PUT", `/vault/keys/${k.kid}`, {
      data,
      expect: k.updatedAt,
      mac: mac(o, ["put-key", k.kid, data.salt, data.n, data.c, data.kdf.N, data.kdf.r, data.kdf.p, stamp(k.updatedAt)]),
    });
  }
  if (st) qc.setQueryData(VAULT_KEY, st);
}

/** 新建或保存一条。old 是开始编辑时的那条（没有 = 新建，这时用 id）。
    别处在这期间改过的话主机会拒绝（409），不会悄悄盖掉 */
export async function saveSecret(old: SecretRec | null, id: string, p: Omit<Fields, "title" | "kind" | "raw"> & { title: string; kind: SecretKind }) {
  const { vks } = useVault.getState();
  const kid = old?.kid ?? Object.keys(vks ?? {})[0];
  const k = vks?.[kid];
  if (!k) throw new Error("密码库锁着，先解锁");
  const title = p.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  if (old) id = old.id;
  const { n, c } = encryptFields(k.vk, { ...p, title });
  const body = { kid, title, kind: p.kind, n, c, ...(old ? { expect: old.updatedAt } : {}), mac: mac(k, ["put-secret", id, kid, title, p.kind, n, c, stamp(old?.updatedAt)]) };
  let rec: SecretRec;
  try {
    rec = await v1<SecretRec>("PUT", `/vault/secrets/${id}`, body);
  } catch (e) {
    // 新建时上一次其实存上了、只是没收到回复（再点保存会被当成重复）：主机上已经有这一条，而且解得开，就算成功
    const mine = old ? undefined : (await fetchVault().catch(() => null))?.secrets.find((x) => x.id === id);
    if (!mine || !openSecret(mine, vks)) throw e;
    rec = mine;
  }
  setVault((s) => ({ ...s, secrets: [...s.secrets.filter((x) => x.id !== id), rec].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase())) }));
  useVault.getState().touch();
  return rec;
}

export async function deleteSecret(s: SecretRec) {
  const k = useVault.getState().vks?.[s.kid];
  if (!k) throw new Error("这一条的钥匙没解开，删不了");
  await v1("DELETE", `/vault/secrets/${s.id}`, { expect: s.updatedAt, mac: mac(k, ["delete-secret", s.id, stamp(s.updatedAt)]) });
  setVault((st) => ({ ...st, secrets: st.secrets.filter((x) => x.id !== s.id) }));
}

/** 解开一条；钥匙没解开（用另一个主密码加密的）或内容坏了返回 null */
export function openSecret(s: SecretRec, vks: OpenedKeys | null): Fields | null {
  const k = vks?.[s.kid];
  if (!k) return null;
  try {
    if (s.epk) {
      const d = unseal(k, { epk: s.epk, n: s.n, c: s.c }) as { raw?: unknown };
      return typeof d?.raw === "string" ? { title: s.title, kind: "raw", raw: d.raw } : null;
    }
    const f = decryptFields(k.vk, s);
    return typeof f?.title === "string" ? f : null;
  } catch {
    return null;
  }
}

export const fetchRequests = () => v1<{ requests: VaultRequest[] }>("GET", "/vault/requests").then((r) => r.requests || []);

export const denyRequest = (r: VaultRequest) => v1("POST", `/vault/requests/${r.id}`, { approve: false });

/** 允许：把解开的那一条（f，就是弹窗里给用户看的那份）加密给请求方后交给主机 */
export async function approveRequest(r: VaultRequest, f: Fields, k: Opened) {
  const sealed = seal(r.pub, f);
  await v1("POST", `/vault/requests/${r.id}`, { approve: true, sealed, mac: mac(k, ["resolve", r.id, sealed.epk, sealed.n, sealed.c]) });
}
