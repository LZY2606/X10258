export const api = {
  async state() { return (await fetch('/api/state')).json(); },
  async version(id: string) { return (await fetch(`/api/versions/${id}`)).json(); },
  async sample() { return (await fetch('/api/sample', { method: 'POST' })).json(); },
  async reset() { return (await fetch('/api/reset', { method: 'POST' })).json(); },
  async apply(kind: string, payload: unknown, actor = 'web-user', branch?: string) {
    return (await fetch('/api/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload, actor, branch }),
    })).json();
  },
  async exportAll() { return (await fetch('/api/export')).json(); },
  async importAll(exp: string) {
    return (await fetch('/api/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ export: exp }),
    })).json();
  },
  async resolveConflict(conflictId: string, chosenEventId: string) {
    return (await fetch('/api/resolve-conflict', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conflictId, chosenEventId }),
    })).json();
  },
};
