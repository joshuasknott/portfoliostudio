import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { portfolioSchema, type AiMode, type PortfolioDocument, type Project, type ProjectVersion, newId } from '../shared/portfolio';
import { MemoryStore, type Store } from './store';
import { DomainError, DomainService, type DomainConfig } from './domains';
import { publicSecurityHeaders, renderPublicPortfolio } from './ssr';
import { base64url, cookie, csrfToken, decryptSecret, encryptSecret, hashPassword, hashToken, jsonSize, normalizeEmail, originAllowed, parseCookies, randomBytes, safeSlug, text, timingSafeEqual, validEmail, validPassword, verifyPassword } from './security';

type UserRecord = { id: string; email: string; name: string; passwordHash: string; isAdmin: boolean; createdAt: string; sessionVersion?: number };
type SessionRecord = { userId: string; csrf: string; createdAt: string; expiresAt: string; sessionVersion?: number };
type ProjectRecord = Project & { ownerId: string; publishedDocument: PortfolioDocument | null; publishedHtml?: string | null };
type VersionRecord = ProjectVersion & { ownerId: string; projectId: string; document: PortfolioDocument };
type Bindings = { DATA?: Store; ADMIN_USER_IDS?: string; ALLOW_INSECURE_LOCAL?: string; PUBLIC_APP_URL?: string; APP_ORIGIN?: string; BYOK_ENCRYPTION_KEY?: string; SOCIETY_AI_PROVIDERS?: string; SOCIETY_AI_DAILY_LIMIT?: string; SOCIETY_AI_USER_DAILY_LIMIT?: string; SOCIETY_AI_MAX_TOKENS?: string; AI?: unknown; PAGES_ACCOUNT_ID?: string; PAGES_PROJECT_NAME?: string; PAGES_PROJECT_SUBDOMAIN?: string; PAGES_API_TOKEN?: string };
type Variables = { user: UserRecord | null; session: SessionRecord | null };

const SESSION_COOKIE = 'ps_session';
const CSRF_COOKIE = 'ps_csrf';
const maxBodyBytes = 1_000_000;
const projectLimit = 20;
const versionLimit = 10;
const sessionDays = 14;
const emailKey = (email: string) => `auth:email:${normalizeEmail(email)}`;
const userKey = (id: string) => `auth:user:${id}`;
const sessionKey = (tokenHash: string) => `auth:session:${tokenHash}`;
const projectKey = (id: string) => `project:${id}`;
const ownerProjectKey = (ownerId: string, id: string) => `owner:${ownerId}:project:${id}`;
const versionKey = (projectId: string, id: string) => `version:${projectId}:${id}`;
const projectVersionsPrefix = (projectId: string) => `version:${projectId}:`;
const slugKey = (slug: string) => `slug:${slug}`;
const aiSettingsKey = (userId: string) => `ai:settings:${userId}`;
const adminAiConfigKey = 'admin:ai:config';
const recoveryKey = (userId: string) => `auth:recovery:${userId}`;
const now = () => new Date().toISOString();
type AiSettings = { mode: AiMode; provider: string | null; encryptedApiKey: string | null; updatedAt: string };
type SocietyAiProvider = { id: string; name: string; enabled: boolean; models: string[]; encryptedApiKey?: string | null; reasoning?: boolean; maxRequestTokens?: number; dailyLimit?: number; userDailyLimit?: number };
type AdminAiConfig = { providers: SocietyAiProvider[]; updatedAt: string };
type RecoveryRecord = { hash: string };
type AiUsage = { bucket: string; tokens: number };

export class ApiError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503, message: string, readonly code = 'request_invalid') { super(message); }
}
function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  console.error(error);
  return Response.json({ error: 'Something went wrong. Please try again.', code: 'internal_error' }, { status: 500 });
}
function publicUser(user: UserRecord) { return { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin }; }
function publicProject(project: ProjectRecord): Project {
  const { ownerId: _ownerId, publishedDocument: _publishedDocument, publishedHtml: _publishedHtml, ...publicRecord } = project;
  return publicRecord;
}
function publicVersion(version: VersionRecord): ProjectVersion { return { id: version.id, label: version.label, createdAt: version.createdAt }; }
function parseProjectInput(value: unknown): PortfolioDocument {
  const result = portfolioSchema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'That portfolio contains an invalid value. Check the highlighted fields.', 'portfolio_invalid');
  if (JSON.stringify(result.data).length > maxBodyBytes) throw new ApiError(413, 'That portfolio is too large.', 'payload_too_large');
  return result.data;
}
function requiredRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ApiError(400, 'Refresh this portfolio before saving it.', 'revision_required');
  return value;
}
function requireUser(user: UserRecord | null): UserRecord {
  if (!user) throw new ApiError(401, 'Sign in to continue.', 'not_authenticated');
  return user;
}
function requireAdmin(user: UserRecord | null, adminUserIds: string | undefined): UserRecord {
  const current = requireUser(user);
  const ids = (adminUserIds ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!current.isAdmin && !ids.includes(current.id)) throw new ApiError(403, 'Administrator access is required.', 'admin_required');
  return current;
}
function publicAiSettings(settings: AiSettings | null): { mode: AiMode; provider: string | null; hasApiKey: boolean; updatedAt: string | null } {
  return { mode: settings?.mode ?? 'society', provider: settings?.provider ?? null, hasApiKey: Boolean(settings?.encryptedApiKey), updatedAt: settings?.updatedAt ?? null };
}
function defaultSocietyProviders(): SocietyAiProvider[] {
  return [
    { id: 'workers-ai', name: 'Surrey AI Society AI', enabled: true, models: ['@cf/meta/llama-3.1-8b-instruct'] },
  ];
}
function configuredSocietyProviders(raw: string | undefined): SocietyAiProvider[] {
  if (!raw) return defaultSocietyProviders();
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return defaultSocietyProviders();
    return value.filter((provider): provider is SocietyAiProvider => Boolean(provider && typeof provider === 'object' && typeof (provider as SocietyAiProvider).id === 'string' && typeof (provider as SocietyAiProvider).name === 'string' && Array.isArray((provider as SocietyAiProvider).models))).slice(0, 20);
  } catch { return defaultSocietyProviders(); }
}
async function newRecoveryCode(store: Store, userId: string): Promise<string> {
  const code = base64url(randomBytes(24));
  await store.put(recoveryKey(userId), { hash: await hashToken(code) } satisfies RecoveryRecord);
  return code;
}
function adminIds(raw: string | undefined): string[] { return (raw ?? '').split(',').map((value) => value.trim()).filter(Boolean); }
function dailyBucket(): string { return new Date().toISOString().slice(0, 10); }
function configuredNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw); return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}
function providerPublic(provider: SocietyAiProvider) { return { id: provider.id, name: provider.name, enabled: provider.enabled, models: provider.models, reasoning: Boolean(provider.reasoning), maxRequestTokens: provider.maxRequestTokens, dailyLimit: provider.dailyLimit, userDailyLimit: provider.userDailyLimit, hasApiKey: Boolean(provider.encryptedApiKey) }; }
function domainService(c: { env: Bindings }): DomainService { const config: DomainConfig = { accountId: c.env.PAGES_ACCOUNT_ID, projectName: c.env.PAGES_PROJECT_NAME, projectSubdomain: c.env.PAGES_PROJECT_SUBDOMAIN, apiToken: c.env.PAGES_API_TOKEN }; return new DomainService(c.env.DATA!, config); }
function domainError(error: unknown): never { if (error instanceof DomainError) throw new ApiError(error.status === 422 ? 400 : error.status, error.message, error.code); throw error; }
async function reserveUsage(store: Store, userId: string, tokens: number, limits: { global: number; user: number }): Promise<void> {
  const bucket = dailyBucket(); const globalKey = `ai:usage:global:${bucket}`; const userKey = `ai:usage:user:${userId}:${bucket}`;
  const reserve = async (key: string, limit: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await store.get<AiUsage>(key); const next = { bucket, tokens: (current?.bucket === bucket ? current.tokens : 0) + tokens };
      if (next.tokens > limit) return false;
      if (!current ? await store.putIfAbsent(key, next) : await store.compareAndSwap(key, current, next)) return true;
    }
    return false;
  };
  if (!(await reserve(userKey, limits.user))) throw new ApiError(429, 'Your daily AI allowance has been reached.', 'ai_user_limit');
  if (!(await reserve(globalKey, limits.global))) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await store.get<AiUsage>(userKey); if (!current || current.bucket !== bucket || current.tokens < tokens) break;
      if (await store.compareAndSwap(userKey, current, { bucket, tokens: current.tokens - tokens })) break;
    }
    throw new ApiError(429, 'Today\'s society AI allowance has been reached.', 'ai_global_limit');
  }
}
const aiResultSchema = z.object({ document: portfolioSchema, summary: z.string().min(1).max(600) });
const fixedProviderEndpoints: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com',
};
function aiProviderId(value: string | null | undefined): string { return (value ?? '').trim().toLowerCase(); }
function extractModelText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const result = value as Record<string, unknown>;
  if (typeof result.response === 'string') return result.response;
  const choices = Array.isArray(result.choices) ? result.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === 'string') return message.content;
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as Record<string, unknown> | undefined;
  if (typeof first?.text === 'string') return first.text;
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const parts = ((candidates[0] as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)?.parts;
  if (Array.isArray(parts)) return parts.map((part) => (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text : '')).join('');
  return '';
}
function parseAiResult(raw: unknown): z.infer<typeof aiResultSchema> | null {
  const textValue = extractModelText(raw).trim(); if (!textValue) return null;
  const candidates = [textValue]; const fenced = textValue.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]; if (fenced) candidates.unshift(fenced.trim());
  const start = textValue.indexOf('{'); const end = textValue.lastIndexOf('}'); if (start >= 0 && end > start) candidates.push(textValue.slice(start, end + 1));
  for (const candidate of candidates) { try { const parsed = aiResultSchema.safeParse(JSON.parse(candidate)); if (parsed.success) return parsed.data; } catch { /* retry with the next bounded extraction */ } }
  return null;
}
function applySelection(original: PortfolioDocument, generated: PortfolioDocument, selection: unknown): PortfolioDocument {
  if (selection === undefined || selection === null) return generated;
  if (!selection || typeof selection !== 'object') throw new ApiError(400, 'That selection is invalid.', 'selection_invalid');
  const value = selection as Record<string, unknown>; const sectionId = text(value.sectionId); const field = text(value.field); const sectionIndex = original.sections.findIndex((section) => section.id === sectionId);
  if (sectionIndex < 0 || !['section', 'title', 'subtitle', 'body', 'image', 'item'].includes(field)) throw new ApiError(400, 'That selection is invalid.', 'selection_invalid');
  const section = original.sections[sectionIndex]; const generatedSection = generated.sections.find((candidate) => candidate.id === sectionId); if (!generatedSection) throw new ApiError(502, 'The AI could not update that selection.', 'ai_result_invalid');
  const sections = original.sections.slice();
  if (field === 'section') sections[sectionIndex] = generatedSection;
  else if (field === 'title' || field === 'subtitle' || field === 'body' || field === 'image') sections[sectionIndex] = { ...section, [field]: generatedSection[field] };
  else {
    const itemId = text(value.itemId); const itemField = text(value.itemField); const itemIndex = section.items.findIndex((item) => item.id === itemId); const generatedItem = generatedSection.items.find((item) => item.id === itemId);
    if (itemIndex < 0 || !generatedItem || !['title', 'subtitle', 'description', 'image'].includes(itemField)) throw new ApiError(400, 'That selection is invalid.', 'selection_invalid');
    const itemFieldKey = itemField as 'title' | 'subtitle' | 'description' | 'image'; const items = section.items.slice(); items[itemIndex] = { ...items[itemIndex], [itemFieldKey]: generatedItem[itemFieldKey] }; sections[sectionIndex] = { ...section, items };
  }
  return { ...original, sections };
}
function aiPrompt(document: PortfolioDocument, prompt: string, selection: unknown, cv: string): string {
  return [
    'You edit a student portfolio document for Portfolio Studio.',
    'Return ONLY a JSON object matching {"document": PortfolioDocument, "summary": string}. Do not return markdown, HTML, JavaScript, CSS, URLs you invented, or any additional keys.',
    'Keep the document version and schema valid. Preserve all existing content unless the requested change requires it.',
    selection ? `Only change the selected element: ${JSON.stringify(selection)}.` : 'There is no selection; apply the requested change to the document.',
    `Request: ${prompt}`,
    cv ? `Optional CV context (use only as factual source): ${cv}` : '',
    `Current document: ${JSON.stringify(document)}`,
  ].filter(Boolean).join('\n');
}
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}
async function callExternalProvider(provider: string, apiKey: string, model: string, messages: Array<{ role: string; content: string }>, maxTokens = 2048): Promise<unknown> {
  const endpoint = fixedProviderEndpoints[provider]; if (!endpoint) throw new ApiError(400, 'That AI provider is not supported.', 'provider_invalid');
  let request: RequestInit; let url = endpoint;
  if (provider === 'anthropic') request = { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: Math.min(2048, maxTokens), messages: messages.filter((message) => message.role !== 'system'), system: messages.find((message) => message.role === 'system')?.content }) };
  else if (provider === 'gemini') { url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`; request = { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: messages.map((message) => `${message.role}: ${message.content}`).join('\n') }] }] }) }; }
  else request = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: Math.min(2048, maxTokens) }) };
  const response = await fetchWithTimeout(url, request); if (!response.ok) throw new ApiError(503, 'The connected AI provider is temporarily unavailable.', 'ai_provider_unavailable');
  return response.json();
}
function assertSameOrigin(request: Request): void {
  if (!originAllowed(request)) throw new ApiError(403, 'This request was blocked. Refresh the page and try again.', 'csrf_failed');
}
function jsonBodySize(request: Request): void {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > maxBodyBytes) throw new ApiError(413, 'That request is too large.', 'payload_too_large');
}
async function readJson(c: { req: { json: <T>() => Promise<T> } }): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json<Record<string, unknown>>();
    if (jsonSize(value) > maxBodyBytes) throw new ApiError(413, 'That request is too large.', 'payload_too_large');
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'Use a valid JSON request.', 'json_invalid');
  }
}
function expiresFrom(days: number): string { return new Date(Date.now() + days * 86_400_000).toISOString(); }
function sessionCookieOptions(c: { req: { url: string } }) { return { maxAge: sessionDays * 86_400, secure: new URL(c.req.url).protocol === 'https:' }; }
async function setSession(c: any, user: UserRecord): Promise<void> {
  const token = base64url(randomBytes(32)); const csrf = csrfToken();
  const record: SessionRecord = { userId: user.id, csrf, createdAt: now(), expiresAt: expiresFrom(sessionDays), sessionVersion: user.sessionVersion ?? 0 };
  await c.env.DATA.put(sessionKey(await hashToken(token)), record);
  c.header('Set-Cookie', cookie(SESSION_COOKIE, token, sessionCookieOptions(c)), { append: true });
  c.header('Set-Cookie', cookie(CSRF_COOKIE, csrf, { ...sessionCookieOptions(c), httpOnly: false }), { append: true });
}
async function loadAuth(store: Store, request: Request, configuredAdminIds = ''): Promise<{ user: UserRecord | null; session: SessionRecord | null; tokenHash: string | null }> {
  const token = parseCookies(request.headers.get('Cookie') ?? undefined)[SESSION_COOKIE];
  if (!token) return { user: null, session: null, tokenHash: null };
  const tokenHash = await hashToken(token);
  const session = await store.get<SessionRecord>(sessionKey(tokenHash));
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) await store.delete(sessionKey(tokenHash));
    return { user: null, session: null, tokenHash };
  }
  const user = await store.get<UserRecord>(userKey(session.userId));
  if (user && (session.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)) { await store.delete(sessionKey(tokenHash)); return { user: null, session: null, tokenHash }; }
  if (user) user.isAdmin = adminIds(configuredAdminIds).includes(user.id);
  return user ? { user, session, tokenHash } : { user: null, session: null, tokenHash };
}
async function getProject(store: Store, userId: string, id: string): Promise<ProjectRecord> {
  const project = await store.get<ProjectRecord>(projectKey(id));
  if (!project || project.ownerId !== userId || project.archived) throw new ApiError(404, 'Portfolio not found.', 'project_not_found');
  return project;
}
async function saveProject(store: Store, project: ProjectRecord, expectedRevision: number | undefined): Promise<ProjectRecord> {
  const current = await store.get<ProjectRecord>(projectKey(project.id));
  if (!current || current.ownerId !== project.ownerId) throw new ApiError(404, 'Portfolio not found.', 'project_not_found');
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new ApiError(409, 'This portfolio changed in another tab. Reload to review the newer version.', 'revision_conflict');
  const saved = { ...project, revision: current.revision + 1, updatedAt: now() };
  const didSave = await store.compareAndSwap(projectKey(project.id), current, saved);
  if (!didSave) throw new ApiError(409, 'This portfolio changed in another tab. Reload to review the newer version.', 'revision_conflict');
  await store.put(ownerProjectKey(project.ownerId, project.id), { id: project.id });
  return saved;
}
function setPrivateCookies(c: any, clear = false): void {
  if (clear) {
    const secure = new URL(c.req.url).protocol === 'https:';
    c.header('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure }), { append: true });
    c.header('Set-Cookie', cookie(CSRF_COOKIE, '', { maxAge: 0, secure, httpOnly: false }), { append: true });
  }
}

/**
 * Keep login and signup abuse bounded without depending on process-local state.
 * The store-backed counter works with D1 and the in-memory test adapter. A
 * failed CAS simply retries against the newer counter value.
 */
async function enforceRateLimit(store: Store, key: string, limit: number, message: string, code: string): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await store.get<{ bucket: number; count: number }>(key);
    if (!current || current.bucket !== bucket) {
      const replacement = { bucket, count: 1 };
      if (!current ? await store.putIfAbsent(key, replacement) : await store.compareAndSwap(key, current, replacement)) return;
      continue;
    }
    if (current.count >= limit) throw new ApiError(429, message, code);
    if (await store.compareAndSwap(key, current, { bucket, count: current.count + 1 })) return;
  }
  throw new ApiError(429, message, code);
}
async function enforceAuthRateLimit(store: Store, request: Request): Promise<void> {
  const forwarded = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
  await enforceRateLimit(store, `rate:auth:ip:${await hashToken(forwarded)}`, 120, 'Too many requests from this network. Try again in a minute.', 'rate_limited');
}
async function enforceAuthEmailRateLimit(store: Store, email: string): Promise<void> {
  await enforceRateLimit(store, `rate:auth:email:${await hashToken(normalizeEmail(email))}`, 15, 'Too many attempts for this email. Try again in a minute.', 'rate_limited');
}

export function createApp(store: Store = new MemoryStore()): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('*', async (c, next) => {
    // Hono's Node test adapter omits the bindings object when `request()` is
    // called without an env argument. Install the injected store in that case
    // while preserving Cloudflare's supplied bindings in production.
    const bindings = c.env ?? ({} as Bindings);
    bindings.DATA ??= store;
    c.env = bindings;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') { jsonBodySize(c.req.raw); }
    await next();
  });
  app.use('/api/*', cors({
    origin: (origin, c) => {
      if (!origin) return undefined;
      const requestOrigin = new URL(c.req.url).origin;
      let configuredOrigin = requestOrigin;
      try { if (c.env.PUBLIC_APP_URL ?? c.env.APP_ORIGIN) configuredOrigin = new URL(c.env.PUBLIC_APP_URL ?? c.env.APP_ORIGIN!).origin; } catch { /* invalid optional config cannot widen CORS */ }
      return origin === requestOrigin || origin === configuredOrigin ? origin : undefined;
    },
    allowHeaders: ['Content-Type', 'X-Portfolio-CSRF'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], credentials: true, maxAge: 86400,
  }));
  app.use('/api/*', async (c, next) => {
    const auth = await loadAuth(c.env.DATA!, c.req.raw, c.env.ADMIN_USER_IDS);
    c.set('user', auth.user); c.set('session', auth.session);
    const isAuthEntry = c.req.path === '/api/auth/signup' || c.req.path === '/api/auth/login' || c.req.path === '/api/auth/reset-password';
    if (isAuthEntry && c.req.method !== 'OPTIONS') {
      assertSameOrigin(c.req.raw);
      await enforceAuthRateLimit(c.env.DATA!, c.req.raw);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !isAuthEntry && auth.session && c.req.header('X-Portfolio-CSRF') !== auth.session.csrf) {
      throw new ApiError(403, 'This request was blocked. Refresh the page and try again.', 'csrf_failed');
    }
    await next();
  });
  app.onError((error) => errorResponse(error));

  app.get('/api/config', async (c) => {
    const configured = await c.env.DATA!.get<AdminAiConfig>(adminAiConfigKey);
    const providers = (configured?.providers ?? configuredSocietyProviders(c.env.SOCIETY_AI_PROVIDERS)).filter((provider) => provider.enabled).map(({ id, name, models }) => ({ id, name, models }));
    return c.json({ ok: true, capabilities: { societyAI: Boolean(c.env.AI), accountConnections: [], apiKeys: Boolean(c.env.BYOK_ENCRYPTION_KEY), customDomains: domainService(c).capabilities(), hosting: 'studio-managed', maxProjects: projectLimit, societyProviders: providers } });
  });
  app.get('/api/auth/session', (c) => c.json({ user: c.get('user') ? publicUser(c.get('user')!) : null }));
  app.get('/api/ai/settings', async (c) => {
    const user = requireUser(c.get('user')); const settings = await c.env.DATA!.get<AiSettings>(aiSettingsKey(user.id));
    return c.json({ settings: publicAiSettings(settings) });
  });
  app.patch('/api/ai/settings', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const body = await readJson(c);
    const mode = body.mode === 'account' || body.mode === 'key' || body.mode === 'society' ? body.mode : null;
    if (!mode) throw new ApiError(400, 'Choose a supported AI access option.', 'ai_mode_invalid');
    const provider = text(body.provider) || null; if (provider && provider.length > 80) throw new ApiError(400, 'Choose a supported AI provider.', 'ai_provider_invalid');
    const current = await c.env.DATA!.get<AiSettings>(aiSettingsKey(user.id));
    let encryptedApiKey = current?.encryptedApiKey ?? null;
    if (body.clearApiKey === true) encryptedApiKey = null;
    if (mode === 'key' && body.apiKey !== undefined) {
      const apiKey = text(body.apiKey);
      if (apiKey.length < 10 || apiKey.length > 500) throw new ApiError(400, 'Enter a valid API key.', 'api_key_invalid');
      if (!c.env.BYOK_ENCRYPTION_KEY) throw new ApiError(503, 'Personal API keys are not configured yet.', 'byok_unavailable');
      try { encryptedApiKey = await encryptSecret(apiKey, c.env.BYOK_ENCRYPTION_KEY); } catch { throw new ApiError(503, 'Personal API keys are not configured yet.', 'byok_unavailable'); }
    }
    if (mode !== 'key' && body.clearApiKey !== false) encryptedApiKey = null;
    const settings: AiSettings = { mode, provider, encryptedApiKey, updatedAt: now() };
    await c.env.DATA!.put(aiSettingsKey(user.id), settings);
    return c.json({ settings: publicAiSettings(settings) });
  });
  app.get('/api/ai/providers', async (c) => {
    const configured = await c.env.DATA!.get<AdminAiConfig>(adminAiConfigKey);
    return c.json({ providers: (configured?.providers ?? configuredSocietyProviders(c.env.SOCIETY_AI_PROVIDERS)).filter((provider) => provider.enabled).map(providerPublic) });
  });
  app.post('/api/ai/generate', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const body = await readJson(c); const prompt = text(body.prompt); const document = parseProjectInput(body.document);
    const cv = text(body.cv); if (!prompt || prompt.length > 4000 || cv.length > 12000) throw new ApiError(400, 'Describe the change in 4,000 characters or fewer.', 'prompt_invalid');
    const settings = await c.env.DATA!.get<AiSettings>(aiSettingsKey(user.id)); const mode = body.mode === 'account' || body.mode === 'key' || body.mode === 'society' ? body.mode : (settings?.mode ?? 'society');
    const configured = await c.env.DATA!.get<AdminAiConfig>(adminAiConfigKey); const providers = configured?.providers ?? configuredSocietyProviders(c.env.SOCIETY_AI_PROVIDERS);
    let providerId = aiProviderId(text(body.provider) || settings?.provider); let model = text(body.model); let maxRequestTokens = configuredNumber(c.env.SOCIETY_AI_MAX_TOKENS, 2000, 256, 8000); let dailyLimit = configuredNumber(c.env.SOCIETY_AI_DAILY_LIMIT, 8000, 256, 2_000_000); let userDailyLimit = configuredNumber(c.env.SOCIETY_AI_USER_DAILY_LIMIT, 2000, 256, 500000); let rawResult: unknown;
    const messages = [{ role: 'system', content: 'You edit Portfolio Studio documents. Return ONLY JSON matching {"document": PortfolioDocument, "summary": string}. Never return HTML, CSS, JavaScript, markdown, executable code, or extra keys.' }, { role: 'user', content: aiPrompt(document, prompt, body.selection, cv) }];
    if (mode === 'society') {
      const available = providers.filter((entry) => entry.enabled && entry.models.length); const selected = available.find((entry) => (providerId && entry.id === providerId) || (model && entry.models.includes(model))) ?? available[0];
      if (!selected) throw new ApiError(503, 'No society AI model is enabled yet.', 'society_ai_unavailable');
      providerId = selected.id; model = model || selected.models[0]; if (!selected.models.includes(model)) throw new ApiError(400, 'That society AI model is not enabled.', 'model_not_allowed');
      maxRequestTokens = selected.maxRequestTokens ?? maxRequestTokens; dailyLimit = selected.dailyLimit ?? dailyLimit; userDailyLimit = selected.userDailyLimit ?? userDailyLimit;
      const estimatedTokens = Math.ceil((jsonSize(document) + prompt.length + cv.length) / 4); if (estimatedTokens > maxRequestTokens) throw new ApiError(413, 'That AI request is too large.', 'ai_request_too_large'); await reserveUsage(c.env.DATA!, user.id, estimatedTokens, { global: dailyLimit, user: userDailyLimit });
      if (selected.encryptedApiKey) {
        if (!c.env.BYOK_ENCRYPTION_KEY || !fixedProviderEndpoints[selected.id]) throw new ApiError(503, 'The configured society provider is unavailable.', 'society_ai_unavailable');
        let providerKey: string; try { providerKey = await decryptSecret(selected.encryptedApiKey, c.env.BYOK_ENCRYPTION_KEY); } catch { throw new ApiError(503, 'The configured society provider is unavailable.', 'society_ai_unavailable'); }
      for (let attempt = 0; attempt < 2; attempt += 1) { rawResult = await callExternalProvider(selected.id, providerKey, model, attempt ? [...messages, { role: 'user', content: 'Retry: output valid JSON only and include the complete document.' }] : messages, maxRequestTokens); if (parseAiResult(rawResult)) break; }
      } else {
        if (!c.env.AI || typeof (c.env.AI as { run?: unknown }).run !== 'function') throw new ApiError(503, 'Society AI is temporarily unavailable.', 'society_ai_unavailable');
        const ai = c.env.AI as { run(modelName: string, input: unknown): Promise<unknown> };
        for (let attempt = 0; attempt < 2; attempt += 1) { rawResult = await ai.run(model, { messages: attempt ? [...messages, { role: 'user', content: 'Retry: output valid JSON only and include the complete document.' }] : messages, max_tokens: Math.min(2048, maxRequestTokens) }); if (parseAiResult(rawResult)) break; }
      }
    } else if (mode === 'key') {
      const keyProvider = providerId || aiProviderId(settings?.provider); const encrypted = settings?.encryptedApiKey; if (!encrypted || !c.env.BYOK_ENCRYPTION_KEY) throw new ApiError(400, 'Add your provider API key in AI settings first.', 'api_key_required');
      if (!fixedProviderEndpoints[keyProvider]) throw new ApiError(400, 'Choose a supported AI provider.', 'provider_invalid');
      const defaults: Record<string, string> = { openai: 'gpt-4o-mini', anthropic: 'claude-3-5-haiku-latest', gemini: 'gemini-2.0-flash', openrouter: 'openai/gpt-4o-mini', deepseek: 'deepseek-chat' }; model = model || defaults[keyProvider]; if (!model || model.length > 120) throw new ApiError(400, 'Choose a valid model.', 'model_invalid');
      let apiKey: string; try { apiKey = await decryptSecret(encrypted, c.env.BYOK_ENCRYPTION_KEY); } catch { throw new ApiError(503, 'That API key could not be opened.', 'api_key_unavailable'); }
      const estimatedTokens = Math.ceil((jsonSize(document) + prompt.length + cv.length) / 4); if (estimatedTokens > maxRequestTokens) throw new ApiError(413, 'That AI request is too large.', 'ai_request_too_large');
      for (let attempt = 0; attempt < 2; attempt += 1) { rawResult = await callExternalProvider(keyProvider, apiKey, model, attempt ? [...messages, { role: 'user', content: 'Retry: output valid JSON only and include the complete document.' }] : messages, maxRequestTokens); if (parseAiResult(rawResult)) break; }
    } else throw new ApiError(503, 'Sign in with a supported AI provider is not connected yet.', 'account_connection_unavailable');
    const parsed = parseAiResult(rawResult); if (!parsed) throw new ApiError(502, 'The AI returned an invalid portfolio. Try a simpler request.', 'ai_result_invalid');
    const result = parseProjectInput(applySelection(document, parsed.document, body.selection)); return c.json({ document: result, summary: parsed.summary });
  });
  app.get('/api/admin/ai/config', async (c) => {
    requireAdmin(c.get('user'), c.env.ADMIN_USER_IDS);
    const configured = await c.env.DATA!.get<AdminAiConfig>(adminAiConfigKey);
    return c.json({ config: configured ? { ...configured, providers: configured.providers.map(providerPublic) } : { providers: configuredSocietyProviders(c.env.SOCIETY_AI_PROVIDERS).map(providerPublic), updatedAt: null } });
  });
  app.patch('/api/admin/ai/config', async (c) => {
    assertSameOrigin(c.req.raw); requireAdmin(c.get('user'), c.env.ADMIN_USER_IDS); const body = await readJson(c);
    if (!Array.isArray(body.providers) || body.providers.length > 20) throw new ApiError(400, 'Add up to 20 AI providers.', 'providers_invalid');
    const currentConfig = await c.env.DATA!.get<AdminAiConfig>(adminAiConfigKey);
    const providers: SocietyAiProvider[] = [];
    for (const candidate of body.providers) {
      if (!candidate || typeof candidate !== 'object') throw new ApiError(400, 'Check the AI provider settings.', 'providers_invalid');
      const value = candidate as Record<string, unknown>; const id = text(value.id).toLowerCase(); const name = text(value.name); const models = Array.isArray(value.models) ? value.models.filter((model): model is string => typeof model === 'string').map((model) => model.trim()).filter(Boolean).slice(0, 30) : [];
      const maxRequestTokens = configuredNumber(typeof value.maxRequestTokens === 'number' ? String(value.maxRequestTokens) : undefined, 2000, 256, 8000);
      const dailyLimit = configuredNumber(typeof value.dailyLimit === 'number' ? String(value.dailyLimit) : undefined, 8000, 256, 2_000_000);
      const userDailyLimit = configuredNumber(typeof value.userDailyLimit === 'number' ? String(value.userDailyLimit) : undefined, 2000, 256, 500000);
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id) || !name || name.length > 100 || !models.length || models.some((model) => model.length > 160)) throw new ApiError(400, 'Check the AI provider settings.', 'providers_invalid');
      const previous = currentConfig?.providers.find((provider) => provider.id === id); let encryptedApiKey = previous?.encryptedApiKey ?? null;
      if (value.clearApiKey === true) encryptedApiKey = null;
      if (value.apiKey !== undefined) {
        const apiKey = text(value.apiKey); if (apiKey.length < 10 || apiKey.length > 500) throw new ApiError(400, 'Enter a valid provider API key.', 'api_key_invalid');
        if (!c.env.BYOK_ENCRYPTION_KEY) throw new ApiError(503, 'Provider API-key storage is not configured.', 'byok_unavailable');
        try { encryptedApiKey = await encryptSecret(apiKey, c.env.BYOK_ENCRYPTION_KEY); } catch { throw new ApiError(503, 'Provider API-key storage is not configured.', 'byok_unavailable'); }
      }
      providers.push({ id, name, enabled: value.enabled !== false, models, encryptedApiKey, reasoning: value.reasoning === true, maxRequestTokens, dailyLimit, userDailyLimit });
    }
    const config: AdminAiConfig = { providers, updatedAt: now() }; await c.env.DATA!.put(adminAiConfigKey, config); return c.json({ config });
  });
  app.post('/api/auth/signup', async (c) => {
    const body = await readJson(c); const email = normalizeEmail(text(body.email)); const name = text(body.name); const password = text(body.password);
    if (!validEmail(email) || name.length < 2 || name.length > 120 || !validPassword(password)) throw new ApiError(400, 'Use your name, a valid email and a passphrase of at least 12 characters.', 'signup_invalid');
    await enforceAuthEmailRateLimit(c.env.DATA!, email);
    const data = c.env.DATA!; const id = newId('user'); const record: UserRecord = { id, email, name, passwordHash: await hashPassword(password), isAdmin: false, createdAt: now() };
    const claimed = await data.putIfAbsent(emailKey(email), { id });
    if (!claimed) throw new ApiError(409, 'An account already exists for that email.', 'email_in_use');
    const adminIds = (c.env.ADMIN_USER_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    record.isAdmin = adminIds.includes(id);
    await data.put(userKey(id), record); const recoveryCode = await newRecoveryCode(data, id); await setSession(c, record);
    return c.json({ user: publicUser(record), recoveryCode }, 201);
  });
  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c); const email = normalizeEmail(text(body.email)); const password = text(body.password);
    if (!validEmail(email) || !password) throw new ApiError(400, 'Enter your email and password.', 'login_invalid');
    await enforceAuthEmailRateLimit(c.env.DATA!, email);
    const idRecord = await c.env.DATA!.get<{ id: string }>(emailKey(email)); const user = idRecord ? await c.env.DATA!.get<UserRecord>(userKey(idRecord.id)) : null;
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new ApiError(401, 'Email or password is incorrect.', 'login_failed');
    await setSession(c, user); return c.json({ user: publicUser(user) });
  });
  app.post('/api/auth/recovery-code', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const recoveryCode = await newRecoveryCode(c.env.DATA!, user.id);
    return c.json({ recoveryCode, expiresInDays: 30 });
  });
  app.post('/api/auth/reset-password', async (c) => {
    assertSameOrigin(c.req.raw); const body = await readJson(c); const email = normalizeEmail(text(body.email)); const code = text(body.code); const password = text(body.password);
    if (!validEmail(email) || code.length < 20 || !validPassword(password)) throw new ApiError(400, 'Enter your email, recovery code and a passphrase of at least 12 characters.', 'reset_invalid');
    await enforceAuthEmailRateLimit(c.env.DATA!, email);
    const idRecord = await c.env.DATA!.get<{ id: string }>(emailKey(email)); const user = idRecord ? await c.env.DATA!.get<UserRecord>(userKey(idRecord.id)) : null; const recovery = user ? await c.env.DATA!.get<RecoveryRecord>(recoveryKey(user.id)) : null;
    if (!user || !recovery || !recovery.hash || !timingSafeEqual(await hashToken(code), recovery.hash)) throw new ApiError(401, 'That recovery code is invalid.', 'reset_failed');
    const consumed = await c.env.DATA!.compareAndSwap(recoveryKey(user.id), recovery, { hash: '' });
    if (!consumed) throw new ApiError(401, 'That recovery code is invalid.', 'reset_failed');
    await c.env.DATA!.put(userKey(user.id), { ...user, passwordHash: await hashPassword(password), sessionVersion: (user.sessionVersion ?? 0) + 1 }); await c.env.DATA!.delete(recoveryKey(user.id));
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', async (c) => {
    assertSameOrigin(c.req.raw); const token = parseCookies(c.req.header('Cookie'))[SESSION_COOKIE]; if (token) await c.env.DATA!.delete(sessionKey(await hashToken(token))); setPrivateCookies(c, true); return c.json({ ok: true });
  });

  app.get('/api/projects', async (c) => {
    const user = requireUser(c.get('user')); const rows = await c.env.DATA!.list<{ id: string }>(`owner:${user.id}:project:`);
    const projects: Project[] = [];
    for (const row of rows) { const project = await c.env.DATA!.get<ProjectRecord>(projectKey(row.value.id)); if (project && !project.archived) projects.push(publicProject(project)); }
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return c.json({ projects });
  });
  app.post('/api/projects', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const body = await readJson(c);
    const existing = await c.env.DATA!.list<{ id: string }>(`owner:${user.id}:project:`); let activeCount = 0; for (const row of existing) { const existingProject = await c.env.DATA!.get<ProjectRecord>(projectKey(row.value.id)); if (existingProject && !existingProject.archived) activeCount += 1; } if (activeCount >= projectLimit) throw new ApiError(409, 'You have reached the portfolio limit. Archive one to create another.', 'project_limit');
    const document = parseProjectInput(body.document); const id = newId('project'); const createdAt = now();
    const project: ProjectRecord = { id, ownerId: user.id, name: text(body.name) || document.name, document: { ...document, name: text(body.name) || document.name }, updatedAt: createdAt, createdAt, publishedAt: null, slug: null, revision: 1, aiMode: (body.aiMode === 'account' || body.aiMode === 'key' ? body.aiMode : 'society') as AiMode, archived: false, publishedDocument: null };
    const versionId = newId('version'); await c.env.DATA!.put(projectKey(id), project); await c.env.DATA!.put(ownerProjectKey(user.id, id), { id }); await c.env.DATA!.put(versionKey(id, versionId), { id: versionId, projectId: id, ownerId: user.id, label: 'Created', createdAt, document });
    return c.json({ project: publicProject(project) }, 201);
  });
  app.get('/api/projects/:id', async (c) => { const project = await getProject(c.env.DATA!, requireUser(c.get('user')).id, c.req.param('id')); return c.json({ project: publicProject(project) }); });
  app.patch('/api/projects/:id', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const body = await readJson(c); const current = await getProject(c.env.DATA!, user.id, c.req.param('id'));
    const expectedRevision = requiredRevision(body.expectedRevision); const document = body.document === undefined ? current.document : parseProjectInput(body.document); const name = body.name === undefined ? current.name : text(body.name);
    if (!name || name.length > 120) throw new ApiError(400, 'Add a portfolio name.', 'name_invalid');
    const aiMode = body.aiMode === 'account' || body.aiMode === 'key' || body.aiMode === 'society' ? body.aiMode : current.aiMode;
    const saved = await saveProject(c.env.DATA!, { ...current, name, aiMode, document: { ...document, name } }, expectedRevision);
    const versionId = newId('version'); await c.env.DATA!.put(versionKey(saved.id, versionId), { id: versionId, projectId: saved.id, ownerId: user.id, label: text(body.versionLabel) || 'Saved version', createdAt: saved.updatedAt, document: saved.document });
    const versions = await c.env.DATA!.list<VersionRecord>(projectVersionsPrefix(saved.id)); const own = versions.map((entry) => ({ ...entry, value: entry.value })).sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt)); for (const old of own.slice(versionLimit)) await c.env.DATA!.delete(old.key);
    return c.json({ project: publicProject(saved) });
  });
  app.delete('/api/projects/:id', async (c) => { assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const current = await getProject(c.env.DATA!, user.id, c.req.param('id')); await saveProject(c.env.DATA!, { ...current, archived: true }, undefined); await c.env.DATA!.delete(ownerProjectKey(user.id, current.id)); if (current.slug) await c.env.DATA!.delete(slugKey(current.slug)); return c.json({ ok: true }); });
  app.get('/api/projects/:id/domain', async (c) => { const user = requireUser(c.get('user')); await getProject(c.env.DATA!, user.id, c.req.param('id')); try { return c.json({ domain: await domainService(c).get(user.id, c.req.param('id')) }); } catch (error) { return domainError(error); } });
  app.post('/api/projects/:id/domain', async (c) => { assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); await getProject(c.env.DATA!, user.id, c.req.param('id')); const body = await readJson(c); try { return c.json(await domainService(c).begin(user.id, c.req.param('id'), text(body.domain))); } catch (error) { return domainError(error); } });
  app.post('/api/projects/:id/domain/verify', async (c) => { assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); await getProject(c.env.DATA!, user.id, c.req.param('id')); try { return c.json(await domainService(c).verify(user.id, c.req.param('id'))); } catch (error) { return domainError(error); } });
  app.delete('/api/projects/:id/domain', async (c) => { assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); await getProject(c.env.DATA!, user.id, c.req.param('id')); try { await domainService(c).remove(user.id, c.req.param('id')); return c.json({ ok: true }); } catch (error) { return domainError(error); } });
  app.get('/api/projects/:id/versions', async (c) => { const user = requireUser(c.get('user')); await getProject(c.env.DATA!, user.id, c.req.param('id')); const versions = await c.env.DATA!.list<VersionRecord>(projectVersionsPrefix(c.req.param('id'))); return c.json({ versions: versions.map((row) => row.value).filter((version) => version.ownerId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicVersion) }); });
  app.post('/api/projects/:id/versions/:versionId/restore', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const body = await readJson(c); const expectedRevision = requiredRevision(body.expectedRevision); const project = await getProject(c.env.DATA!, user.id, c.req.param('id')); const version = await c.env.DATA!.get<VersionRecord>(versionKey(project.id, c.req.param('versionId')));
    if (!version || version.ownerId !== user.id || version.projectId !== project.id) throw new ApiError(404, 'Version not found.', 'version_not_found');
    const saved = await saveProject(c.env.DATA!, { ...project, document: version.document, name: version.document.name }, expectedRevision);
    const restoredVersionId = newId('version');
    await c.env.DATA!.put(versionKey(saved.id, restoredVersionId), { id: restoredVersionId, projectId: saved.id, ownerId: user.id, label: `Restored ${version.label}`, createdAt: saved.updatedAt, document: saved.document });
    const versions = await c.env.DATA!.list<VersionRecord>(projectVersionsPrefix(saved.id));
    const own = versions.sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));
    for (const old of own.slice(versionLimit)) await c.env.DATA!.delete(old.key);
    return c.json({ project: publicProject(saved) });
  });
  app.post('/api/projects/:id/publish', async (c) => {
    assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const project = await getProject(c.env.DATA!, user.id, c.req.param('id')); const body = await readJson(c); const expectedRevision = requiredRevision(body.expectedRevision); const slug = safeSlug(text(body.slug) || project.slug || project.name);
    if (slug.length < 3 || ['api', 'app', 'admin', 'www', 'login', 'signup'].includes(slug)) throw new ApiError(400, 'Choose a different public address.', 'slug_invalid');
    const existing = await c.env.DATA!.get<{ projectId: string }>(slugKey(slug)); if (existing && existing.projectId !== project.id) throw new ApiError(409, 'That public address is already taken.', 'slug_taken');
    const targetClaimed = existing?.projectId === project.id ? true : await c.env.DATA!.putIfAbsent(slugKey(slug), { projectId: project.id });
    if (!targetClaimed) throw new ApiError(409, 'That public address is already taken.', 'slug_taken');
    const base = (c.env.PUBLIC_APP_URL ?? c.env.APP_ORIGIN ?? new URL(c.req.url).origin).replace(/\/$/, '');
    let saved: ProjectRecord;
    try { saved = await saveProject(c.env.DATA!, { ...project, slug, publishedAt: now(), publishedDocument: project.document, publishedHtml: renderPublicPortfolio(project.document, `${base}/p/${slug}`) }, expectedRevision); }
    catch (error) { if (project.slug !== slug && targetClaimed) await c.env.DATA!.delete(slugKey(slug)); throw error; }
    if (project.slug && project.slug !== slug) await c.env.DATA!.delete(slugKey(project.slug));
    return c.json({ project: publicProject(saved), publicUrl: `${base}/p/${slug}` });
  });
  app.post('/api/projects/:id/unpublish', async (c) => { assertSameOrigin(c.req.raw); const user = requireUser(c.get('user')); const body = await readJson(c); const expectedRevision = requiredRevision(body.expectedRevision); const project = await getProject(c.env.DATA!, user.id, c.req.param('id')); const saved = await saveProject(c.env.DATA!, { ...project, slug: null, publishedAt: null, publishedDocument: null, publishedHtml: null }, expectedRevision); if (project.slug) await c.env.DATA!.delete(slugKey(project.slug)); return c.json({ project: publicProject(saved) }); });
  app.get('/api/public-host', async (c) => {
    const hostname = new URL(c.req.url).hostname; let resolved: { domain: string; projectId: string } | null = null;
    try { resolved = await domainService(c).resolveVerified(hostname); } catch { resolved = null; }
    if (!resolved) throw new ApiError(404, 'Portfolio not found.', 'public_not_found');
    const project = await c.env.DATA!.get<ProjectRecord>(projectKey(resolved.projectId)); if (!project?.publishedDocument || !project.publishedAt) throw new ApiError(404, 'Portfolio not found.', 'public_not_found');
    return c.json({ name: project.name, document: project.publishedDocument });
  });
  app.get('/p/:slug', async (c) => {
    const slug = safeSlug(c.req.param('slug')); const ref = await c.env.DATA!.get<{ projectId: string }>(slugKey(slug)); if (!ref) throw new ApiError(404, 'Portfolio not found.', 'public_not_found');
    const project = await c.env.DATA!.get<ProjectRecord>(projectKey(ref.projectId)); if (!project?.publishedDocument || project.slug !== slug || !project.publishedAt) throw new ApiError(404, 'Portfolio not found.', 'public_not_found');
    const canonical = `${(c.env.PUBLIC_APP_URL ?? c.env.APP_ORIGIN ?? new URL(c.req.url).origin).replace(/\/$/, '')}/p/${slug}`;
    const html = project.publishedHtml || renderPublicPortfolio(project.publishedDocument, canonical); return new Response(html, { headers: { ...publicSecurityHeaders, 'Cache-Control': 'public, max-age=60, s-maxage=300' } });
  });
  app.get('/api/public/:slug', async (c) => {
    const slug = safeSlug(c.req.param('slug')); const ref = await c.env.DATA!.get<{ projectId: string }>(slugKey(slug)); if (!ref) throw new ApiError(404, 'Portfolio not found.', 'public_not_found');
    const project = await c.env.DATA!.get<ProjectRecord>(projectKey(ref.projectId)); if (!project?.publishedDocument || project.slug !== slug || !project.publishedAt) throw new ApiError(404, 'Portfolio not found.', 'public_not_found');
    return c.json({ name: project.name, document: project.publishedDocument });
  });
  return app;
}

export const app = createApp();
export default app;
