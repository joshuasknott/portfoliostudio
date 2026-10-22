import type { AiMode, PortfolioDocument, Project, ProjectVersion, User } from '../../shared/portfolio';

export class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('ps_csrf='))?.split('=').slice(1).join('=');
  const response = await fetch(`/api${path}`, { ...init, credentials: 'same-origin', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-Portfolio-CSRF': decodeURIComponent(csrf) } : {}), ...init.headers } });
  const data = await response.json().catch(() => ({ error: 'The server could not complete this request. Please try again.' }));
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : data.error?.message || 'Something went wrong. Please try again.', response.status);
  return data as T;
}
export const authApi = {
  session: () => api<{ user: User | null }>('/auth/session'),
  signup: (name: string, email: string, password: string) => api<{ user: User; recoveryCode: string }>('/auth/signup', { method: 'POST', body: JSON.stringify({ name, email, password }) }),
  login: (email: string, password: string) => api<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => api('/auth/logout', { method: 'POST' }),
};
export const projectsApi = {
  list: () => api<{ projects: Project[] }>('/projects'),
  get: (id: string) => api<{ project: Project }>(`/projects/${id}`),
  create: (document: PortfolioDocument, aiMode: AiMode = 'society') => api<{ project: Project }>('/projects', { method: 'POST', body: JSON.stringify({ name: document.name, document, aiMode }) }),
  update: (project: Project) => api<{ project: Project }>(`/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name: project.document.name, document: project.document, aiMode: project.aiMode, archived: project.archived, expectedRevision: project.revision }) }),
  remove: (id: string) => api(`/projects/${id}`, { method: 'DELETE' }),
  versions: (id: string) => api<{ versions: ProjectVersion[] }>(`/projects/${id}/versions`),
  restore: (id: string, versionId: string, expectedRevision: number) => api<{ project: Project }>(`/projects/${id}/versions/${versionId}/restore`, { method: 'POST', body: JSON.stringify({ expectedRevision }) }),
  publish: (id: string, slug: string, expectedRevision: number) => api<{ project: Project; publicUrl: string }>(`/projects/${id}/publish`, { method: 'POST', body: JSON.stringify({ slug, expectedRevision }) }),
  unpublish: (id: string) => api<{ project: Project }>(`/projects/${id}/unpublish`, { method: 'POST' }),
};

const STORAGE_KEY = 'portfolio-studio:drafts:v1';
export function getDrafts(): Project[] {
  try { const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(data) ? data : []; } catch { return []; }
}
export function saveDraft(project: Project): void {
  const drafts = getDrafts(); const index = drafts.findIndex(p => p.id === project.id);
  if (index < 0) drafts.unshift(project); else drafts[index] = project;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
}
export function removeDraft(id: string): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(getDrafts().filter(p => p.id !== id))); }
export function createDraft(document: PortfolioDocument, aiMode: AiMode = 'society'): Project {
  const now = new Date().toISOString();
  const project: Project = { id: `local_${crypto.randomUUID()}`, name: document.name, document, createdAt: now, updatedAt: now, publishedAt: null, slug: null, revision: 0, aiMode, archived: false };
  saveDraft(project); return project;
}
export async function loadProject(id: string): Promise<Project> {
  if (id.startsWith('local_')) { const p = getDrafts().find(p => p.id === id); if (!p) throw new Error('This draft is no longer on this device.'); return p; }
  return (await projectsApi.get(id)).project;
}
export function message(error: unknown): string { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
