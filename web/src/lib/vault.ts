/* 密码库：加密、解密都在这里（界面里）做，主机只存密文，主密码不离开这台电脑。
   - 主密码 --scrypt--> 包装密钥，用它把随机生成的「密码库密钥」包起来存到主机（一把「钥匙」）；改主密码只是重新包一次
   - 每一条的内容（网址、用户名、密码、备注…）用密码库密钥加密（XChaCha20-Poly1305）；名称和种类是明文
   - AI 取用：用户点了允许，才把那一条用请求方的临时公钥加密（X25519 + HKDF-SHA256）后交给主机转交，主机看不到内容
   用的是纯 JS 的 @noble 库而不是浏览器自带的 crypto.subtle：局域网里用 http://主机:8765 打开时浏览器不提供后者。 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { create } from "zustand";
import { newId, v1 } from "./api";
import { qc } from "./data";

export type SecretKind = "login" | "apikey" | "server";
export const KINDS: { k: SecretKind; name: string; hint: string }[] = [
  { k: "login", name: "网站账号", hint: "网址、用户名、密码" },
  { k: "apikey", name: "API key", hint: "各种服务的 key、token" },
  { k: "server", name: "服务器和设备", hint: "SSH、路由器、NAS、数据库" },
];
export const kindName = (k: string) => KINDS.find((x) => x.k === k)?.name ?? k;

export interface Kdf { alg: "scrypt"; N: number; r: number; p: number }
/** 一把钥匙：主密码包着的密码库密钥 */
export interface KeyRec { kid: string; createdAt: number; updatedAt: number; kdf: Kdf; salt: string; n: string; c: string }
/** 主机上存的一条（密文） */
export interface SecretRec { id: string; kid: string; title: string; kind: SecretKind; createdAt: number; updatedAt: number; n: string; c: string }
export interface VaultState { keys: KeyRec[]; secrets: SecretRec[] }
export interface Extra { label: string; value: string; hidden?: boolean }
/** 一条里加密的内容 */
export interface Fields { url?: string; username?: string; password?: string; notes?: string; extra?: Extra[] }
/** AI 发来、等用户确认的取用请求 */
export interface VaultRequest { id: string; secretId: string; title: string; actor: string; reason: string; pub: string; at: number; expiresAt: number }

const KDF: Kdf = { alg: "scrypt", N: 2 ** 17, r: 8, p: 1 };
const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD_KEY = enc.encode("xpanel-vault-key-v1");
const AAD_SECRET = enc.encode("xpanel-vault-secret-v1");
const INFO_REQUEST = enc.encode("xpanel-vault-request-v1");

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
function kek(password: string, salt: Uint8Array, kdf: Kdf) {
  if (kdf.alg !== "scrypt" || !(kdf.N >= 2 ** 14 && kdf.N <= 2 ** 20) || !(kdf.r >= 1 && kdf.r <= 16) || !(kdf.p >= 1 && kdf.p <= 4)) throw new Error("这把钥匙的参数不认识，请升级 xpanel");
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
  const k = await kek(password, unb64(key.salt), key.kdf);
  try {
    const vk = xchacha20poly1305(k, unb64(key.n), AAD_KEY).decrypt(unb64(key.c));
    return vk.length === 32 ? vk : null;
  } catch {
    return null; // 主密码不对
  }
}

export function encryptFields(vk: Uint8Array, f: Fields) {
  const n = randomBytes(24);
  return { n: b64(n), c: b64(xchacha20poly1305(vk, n, AAD_SECRET).encrypt(enc.encode(JSON.stringify(f)))) };
}
export function decryptFields(vk: Uint8Array, s: Pick<SecretRec, "n" | "c">): Fields {
  return JSON.parse(dec.decode(xchacha20poly1305(vk, unb64(s.n), AAD_SECRET).decrypt(unb64(s.c)))) as Fields;
}

/** 把内容加密给请求方（AI 那边的临时公钥），主机只转交 */
export function seal(pub: string, payload: unknown) {
  const their = unb64(pub);
  const mine = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(mine);
  const shared = x25519.getSharedSecret(mine, their);
  if (shared.every((b) => b === 0)) throw new Error("请求里的公钥不对");
  const salt = new Uint8Array(64);
  salt.set(epk, 0);
  salt.set(their, 32);
  const n = randomBytes(24);
  const k = hkdf(sha256, shared, salt, INFO_REQUEST, 32);
  return { epk: b64(epk), n: b64(n), c: b64(xchacha20poly1305(k, n).encrypt(enc.encode(JSON.stringify(payload)))) };
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

/** 主密码大概有多强：0 太弱（不让用）、1 一般、2 好 */
export function strength(p: string) {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\da-zA-Z]/].filter((r) => r.test(p)).length;
  const n = [...p].length;
  if (n < 10 || new Set(p).size < 5) return 0;
  return n >= 16 || (n >= 12 && kinds >= 3) ? 2 : 1;
}

/* ---------------------------------------------------------------- 解锁状态（只在内存里，刷新页面就锁上） */

/** 多久不碰密码库就自动锁上 */
export const AUTO_LOCK_MS = 10 * 60 * 1000;
interface Unlocked {
  /** 解开的密码库密钥，按钥匙的标识；null = 锁着 */
  vks: Record<string, Uint8Array> | null;
  touched: number;
  touch: () => void;
  lock: () => void;
}
let lockTimer: number | undefined;
export const useVault = create<Unlocked>((set, get) => ({
  vks: null,
  touched: 0,
  touch: () => {
    if (!get().vks) return;
    window.clearTimeout(lockTimer);
    lockTimer = window.setTimeout(() => get().lock(), AUTO_LOCK_MS);
    set({ touched: Date.now() });
  },
  lock: () => {
    window.clearTimeout(lockTimer);
    const vks = get().vks;
    if (vks) for (const k of Object.values(vks)) k.fill(0);
    set({ vks: null });
  },
}));

export const VAULT_KEY = ["vault"] as const;
export const fetchVault = () => v1<VaultState>("GET", "/vault");
const setVault = (f: (s: VaultState) => VaultState) => qc.setQueryData<VaultState>(VAULT_KEY, (s) => (s ? f(s) : s));

/** 第一次用：设主密码，建一把钥匙 */
export async function createVault(password: string) {
  const vk = randomBytes(32);
  const kid = newId();
  const st = await v1<VaultState>("PUT", `/vault/keys/${kid}`, { data: await wrap(password, vk) });
  qc.setQueryData(VAULT_KEY, st);
  useVault.setState({ vks: { [kid]: vk } });
  useVault.getState().touch();
}

/** 解锁：主密码能解开哪几把钥匙就解开哪几把（一般只有一把）。一把都解不开 = 主密码不对 */
export async function unlock(keys: KeyRec[], password: string) {
  const vks: Record<string, Uint8Array> = { ...(useVault.getState().vks ?? {}) };
  let got = 0;
  for (const k of keys) {
    if (vks[k.kid]) continue;
    const vk = await unwrap(password, k);
    if (vk) {
      vks[k.kid] = vk;
      got++;
    }
  }
  if (!got) throw new Error("主密码不对");
  useVault.setState({ vks });
  useVault.getState().touch();
}

/** 改主密码：先用旧的验证，再用新的把每把解开的钥匙重新包一次（条目不用动） */
export async function changePassword(keys: KeyRec[], oldPassword: string, newPassword: string) {
  const mine: [KeyRec, Uint8Array][] = [];
  for (const k of keys) {
    const vk = await unwrap(oldPassword, k);
    if (vk) mine.push([k, vk]);
  }
  if (!mine.length) throw new Error("原来的主密码不对");
  let st: VaultState | undefined;
  for (const [k, vk] of mine) st = await v1<VaultState>("PUT", `/vault/keys/${k.kid}`, { data: await wrap(newPassword, vk), expect: k.updatedAt });
  if (st) qc.setQueryData(VAULT_KEY, st);
}

/** 新建或保存一条。old 是修改前的那条（没有 = 新建） */
export async function saveSecret(old: SecretRec | null, p: { title: string; kind: SecretKind; fields: Fields }) {
  const { vks } = useVault.getState();
  const kid = old?.kid ?? Object.keys(vks ?? {})[0];
  const vk = vks?.[kid];
  if (!vk) throw new Error("密码库锁着，先解锁");
  const id = old?.id ?? newId();
  const rec = await v1<SecretRec>("PUT", `/vault/secrets/${id}`, { kid, title: p.title.trim(), kind: p.kind, ...encryptFields(vk, p.fields), ...(old ? { expect: old.updatedAt } : {}) });
  setVault((s) => ({ ...s, secrets: [...s.secrets.filter((x) => x.id !== id), rec].sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase())) }));
  useVault.getState().touch();
  return rec;
}

export async function deleteSecret(id: string) {
  await v1("DELETE", `/vault/secrets/${id}`);
  setVault((s) => ({ ...s, secrets: s.secrets.filter((x) => x.id !== id) }));
}

/** 解开一条；钥匙没解开（用另一个主密码加密的）或内容坏了返回 null */
export function openSecret(s: SecretRec, vks: Record<string, Uint8Array> | null): Fields | null {
  const vk = vks?.[s.kid];
  if (!vk) return null;
  try {
    return decryptFields(vk, s);
  } catch {
    return null;
  }
}

export const fetchRequests = () => v1<{ requests: VaultRequest[] }>("GET", "/vault/requests").then((r) => r.requests || []);

/** 用户的决定：允许就把那一条解密、加密给请求方后交给主机；拒绝只说一声 */
export async function answerRequest(r: VaultRequest, secret: SecretRec | undefined, approve: boolean) {
  if (!approve) return v1("POST", `/vault/requests/${r.id}`, { approve: false });
  const f = secret && openSecret(secret, useVault.getState().vks);
  if (!secret || !f) throw new Error("这一条解不开，先解锁密码库");
  await v1("POST", `/vault/requests/${r.id}`, { approve: true, sealed: seal(r.pub, { title: secret.title, kind: secret.kind, ...f }) });
  useVault.getState().touch();
}
