class JiraAPI {
  async _get(path, params = {}) {
    const u = new URL(`http://localhost:3000/api/jira/rest/api/3${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') u.searchParams.set(k, String(v));
    }
    const res = await fetch(u.toString());
    if (!res.ok) {
      const text = await res.text();
      let msg;
      try { msg = JSON.parse(text).errorMessages?.join(', ') || JSON.parse(text).message || text; }
      catch { msg = text; }
      throw new Error(`Jira ${res.status}: ${String(msg).substring(0, 200)}`);
    }
    return res.json();
  }

  async getAllIssues(jql, fields, expand = [], limit = 100) {
    const issues = [];
    let startAt = 0;
    while (issues.length < limit) {
      const maxResults = Math.min(100, limit - issues.length);
      const result = await this._get('/search/jql', {
        jql,
        fields: fields.join(','),
        expand: expand.join(','),
        startAt,
        maxResults,
      });
      const batch = result.issues || [];
      if (batch.length === 0) break;
      issues.push(...batch);
      if (issues.length >= result.total) break;
      startAt += batch.length;
    }
    return issues;
  }

  async getChangelog(key) {
    const result = await this._get(`/issue/${key}/changelog`, { maxResults: 100 });
    return result.values || [];
  }

  async searchUsers(query) {
    return this._get('/user/search', { query, maxResults: 20 });
  }

  async testAuth() {
    return this._get('/myself');
  }
}
