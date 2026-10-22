const encoder = new TextEncoder();
const decoder = new TextDecoder();
const iterations = 600_000;

export function randomBytes(size = 32): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function fromBase64url(value: string): Uint8Array {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export async function hashPassword(
  password: string,
  salt = base64url(randomBytes(16)),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2-sha256$${iterations}$${salt}$${base64url(new Uint8Array(bits))}`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algorithm, count, salt, digest] = stored.split("$");
  if (
    algorithm !== "pbkdf2-sha256" ||
    count !== String(iterations) ||
    !salt ||
    !digest
  )
    return false;
  const candidate = await hashPassword(password, salt);
  return timingSafeEqual(candidate, stored);
}
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let result = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    result |=
      (left[i % Math.max(left.length, 1)] ?? 0) ^
      (right[i % Math.max(right.length, 1)] ?? 0);
  return result === 0;
}
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return base64url(new Uint8Array(digest));
}
async function encryptionKey(material: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(material),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encryptSecret(
  value: string,
  material: string,
): Promise<string> {
  if (!material) throw new Error("BYOK_ENCRYPTION_KEY is not configured");
  const iv = randomBytes(12);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    await encryptionKey(material),
    encoder.encode(value) as unknown as BufferSource,
  );
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function decryptSecret(
  value: string,
  material: string,
): Promise<string> {
  const [version, iv, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !encrypted || !material)
    throw new Error("Invalid encrypted secret");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) as unknown as BufferSource },
    await encryptionKey(material),
    fromBase64url(encrypted) as unknown as BufferSource,
  );
  return decoder.decode(plain);
}
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
export function validPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 200;
}
export function cookie(
  name: string,
  value: string,
  options: Record<string, string | number | boolean> = {},
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure !== false) parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires}`);
  return parts.join("; ");
}
export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => {
        const [key, ...rest] = part.trim().split("=");
        try {
          return [key, decodeURIComponent(rest.join("="))];
        } catch {
          return [key, ""];
        }
      })
      .filter(([key]) => key),
  );
}
export function csrfToken(): string {
  return base64url(randomBytes(24));
}
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
export function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin || origin === "null") return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
export function jsonSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}
export { decoder };
