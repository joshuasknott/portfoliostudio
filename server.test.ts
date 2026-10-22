import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './server/app';
import { MemoryStore } from './server/store';
import { portfolioSchema } from './shared/portfolio';

const document = portfolioSchema.parse({
  version: 1, name: 'Amina portfolio', templateId: 'cobalt',
  profile: { name: 'Amina Patel', headline: 'Thoughtful digital work', bio: 'A student portfolio.' },
  theme: { background: '#f7f4ee', surface: '#ffffff', color: '#111111', muted: '#6b6964', accent: '#234DDF', border: '#ded8ce', headingFont: 'inter', bodyFont: 'inter' },
  sections: [{ id: 'hero', type: 'hero', title: 'Hello', subtitle: 'A portfolio', body: 'A short introduction.', layout: 'split', visible: true, style: { paddingTop: 80, paddingBottom: 80, textAlign: 'left', columns: 2, imagePosition: 'right', imageWidth: 50 }, items: [] }],
  seo: { title: 'Amina portfolio', description: 'Portfolio' },
});
const cookieHeader = (response: Response): string => response.headers.get('set-cookie') ?? '';
const sessionParts = (response: Response) => {
  const header = cookieHeader(response);
  const session = header.match(/ps_session=([^;]+)/)?.[1] ?? '';
  const csrf = header.match(/ps_csrf=([^;]+)/)?.[1] ?? '';
  return { cookie: 'ps_session=' + session + '; ps_csrf=' + csrf, csrf: decodeURIComponent(csrf) };
};
async function signup(app: ReturnType<typeof createApp>, email: string) {
  const response = await app.request('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ email, name: 'Amina Patel', password: 'correct horse 123' }) });
  expect(response.status).toBe(201);
  return sessionParts(response);
}
describe('Portfolio Studio API', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => { app = createApp(new MemoryStore()); });
  it('creates a session without exposing a password and logs out', async () => {
    const auth = await signup(app, 'amina@example.com');
    const session = await app.request('/api/auth/session', { headers: { Cookie: auth.cookie } });
    expect((await session.json()).user.email).toBe('amina@example.com');
    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf } });
    expect(logout.status).toBe(200);
    const after = await app.request('/api/auth/session', { headers: { Cookie: auth.cookie } });
    expect((await after.json()).user).toBeNull();
  });
  it('prevents cross-user access and stale overwrites', async () => {
    const first = await signup(app, 'first@example.com');
    const created = await app.request('/api/projects', { method: 'POST', headers: { Cookie: first.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) });
    expect(created.status).toBe(201); const project = (await created.json()).project;
    const second = await signup(app, 'second@example.com');
    const cross = await app.request('/api/projects/' + project.id, { headers: { Cookie: second.cookie } });
    expect(cross.status).toBe(404);
    const patch = await app.request('/api/projects/' + project.id, { method: 'PATCH', headers: { Cookie: first.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, document }) });
    expect(patch.status).toBe(200);
    const stale = await app.request('/api/projects/' + project.id, { method: 'PATCH', headers: { Cookie: first.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, document }) });
    expect(stale.status).toBe(409);
  });
  it('claims slugs atomically and publishes an immutable snapshot', async () => {
    const first = await signup(app, 'one@example.com'); const second = await signup(app, 'two@example.com');
    const create = async (auth: ReturnType<typeof sessionParts>, name: string) => (await app.request('/api/projects', { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, document: { ...document, name } }) })).json();
    const one = (await create(first, 'One')).project; const two = (await create(second, 'Two')).project;
    const publish = await app.request('/api/projects/' + one.id + '/publish', { method: 'POST', headers: { Cookie: first.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'same-name', expectedRevision: 1 }) });
    expect(publish.status).toBe(200);
    const collision = await app.request('/api/projects/' + two.id + '/publish', { method: 'POST', headers: { Cookie: second.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': second.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'same-name', expectedRevision: 1 }) });
    expect(collision.status).toBe(409);
    const update = await app.request('/api/projects/' + one.id, { method: 'PATCH', headers: { Cookie: first.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': first.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 2, document: { ...document, name: 'Private draft' } }) });
    expect(update.status).toBe(200);
    const publicView = await app.request('/api/public/same-name');
    expect(publicView.status).toBe(200);
    expect((await publicView.json()).document.name).toBe('One');
  });
  it('rejects mutations without same-origin and csrf headers', async () => {
    const auth = await signup(app, 'csrf@example.com');
    const response = await app.request('/api/projects', { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) });
    expect(response.status).toBe(403);
  });
  it('stores BYOK credentials encrypted and only returns capability metadata', async () => {
    const store = new MemoryStore(); app = createApp(store); const auth = await signup(app, 'key@example.com');
    const response = await app.request('/api/ai/settings', { method: 'PATCH', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'key', provider: 'openrouter', apiKey: 'sk-example-secret-12345' }) }, { BYOK_ENCRYPTION_KEY: 'test encryption key' });
    expect(response.status).toBe(200); const payload = await response.json(); expect(payload.settings).toMatchObject({ mode: 'key', provider: 'openrouter', hasApiKey: true }); expect(JSON.stringify(payload)).not.toContain('sk-example-secret-12345');
    const stored = await store.list<Record<string, unknown>>('ai:settings:'); expect(JSON.stringify(stored)).not.toContain('sk-example-secret-12345');
  });
  it('supports a one-time recovery code without email delivery', async () => {
    const created = await app.request('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ email: 'recover@example.com', name: 'Recovery User', password: 'correct horse 123' }) });
    const createdBody = await created.json(); expect(created.status).toBe(201); expect(typeof createdBody.recoveryCode).toBe('string');
    const reset = await app.request('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ email: 'recover@example.com', code: createdBody.recoveryCode, password: 'new secure 456' }) });
    expect(reset.status).toBe(200);
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ email: 'recover@example.com', password: 'new secure 456' }) }); expect(login.status).toBe(200);
    const replay = await app.request('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ email: 'recover@example.com', code: createdBody.recoveryCode, password: 'another secure 789' }) }); expect(replay.status).toBe(401);
  });
  it('returns a validated AI document and applies selected edits only', async () => {
    const auth = await signup(app, 'ai@example.com'); const generated = { ...document, sections: document.sections.map((section) => ({ ...section, title: 'Updated title' })) };
    const response = await app.request('/api/ai/generate', { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ document, prompt: 'Rewrite the heading', selection: { sectionId: 'hero', field: 'title' } }) }, { AI: { run: async () => ({ response: JSON.stringify({ document: generated, summary: 'Updated the heading.' }) }) } });
    expect(response.status).toBe(200); const payload = await response.json(); expect(payload.summary).toBe('Updated the heading.'); expect(payload.document.sections[0].title).toBe('Updated title'); expect(payload.document.profile.bio).toBe(document.profile.bio);
  });
  it('rejects disabled models and enforces the per-user society allowance', async () => {
    const auth = await signup(app, 'quota@example.com'); const ai = { run: async () => ({ response: JSON.stringify({ document, summary: 'ok' }) }) }; const request = (model?: string) => app.request('/api/ai/generate', { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ document, prompt: 'Make a small edit', ...(model ? { model } : {}) }) }, { AI: ai, SOCIETY_AI_USER_DAILY_LIMIT: '300', SOCIETY_AI_DAILY_LIMIT: '10000' });
    expect((await request('not-enabled')).status).toBe(400); expect((await request()).status).toBe(200); expect((await request()).status).toBe(429);
  });
  it('renders only the published snapshot as escaped public HTML', async () => {
    const auth = await signup(app, 'ssr@example.com'); const unsafe = { ...document, name: '<script>alert(1)</script>', profile: { ...document.profile, name: '<script>alert(1)</script>' } };
    const created = await app.request('/api/projects', { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: unsafe }) }); const project = (await created.json()).project;
    const published = await app.request(`/api/projects/${project.id}/publish`, { method: 'POST', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: 'safe-portfolio', expectedRevision: 1 }) }); expect(published.status).toBe(200);
    const updated = await app.request(`/api/projects/${project.id}`, { method: 'PATCH', headers: { Cookie: auth.cookie, Origin: 'http://localhost', 'X-Portfolio-CSRF': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 2, document: { ...unsafe, name: 'Private draft' } }) }); expect(updated.status).toBe(200);
    const html = await app.request('/p/safe-portfolio'); const body = await html.text(); expect(html.status).toBe(200); expect(body).toContain('pf-template-cobalt'); expect(body).toContain('data-template="cobalt"'); expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(body).not.toContain('<script>alert(1)</script>'); expect(body).not.toContain('Private draft'); expect(body).toContain('portfolio-fonts.css'); expect(html.headers.get('content-security-policy')).toContain("script-src 'none'");
  });
});
