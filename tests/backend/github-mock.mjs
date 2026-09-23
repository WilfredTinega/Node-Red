// A stateful fake of the parts of GitHub's REST API the dashboard uses.
import { mockServer } from './helpers.mjs';

export const GOOD_TOKEN = 'ghp_goodtoken123';

export async function githubMock() {
  const state = {
    repos: {
      'octo/private-empty': { private: true, push: true, empty: true, head: null },
      'octo/private-full': { private: true, push: true, empty: false, head: 'c-existing' },
      'octo/public': { private: false, push: true, empty: false, head: 'x' },
      'octo/readonly': { private: true, push: false, empty: false, head: 'x' },
      'octo/dash': { private: false, push: true, empty: false, head: 'x' },
    },
    runs: [],
    seq: 0,
    refs: [],
  };
  const repoOf = (p) => {
    const m = p.match(/^\/repos\/([^/]+\/[^/]+)/);
    return m && state.repos[m[1].toLowerCase()] ? [m[1].toLowerCase(), state.repos[m[1].toLowerCase()]] : [null, null];
  };
  const srv = await mockServer((r) => {
    if (r.headers.authorization !== `Bearer ${GOOD_TOKEN}`) return { status: 401, json: { message: 'Bad credentials' } };
    if (r.method === 'GET' && r.path === '/user') {
      return { json: { login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars/octo', html_url: 'https://github.com/octo' } };
    }
    if (r.method === 'GET' && r.path === '/user/repos') {
      return {
        json: Object.entries(state.repos).map(([full, x]) => ({ full_name: full, private: x.private, permissions: { push: x.push, pull: true }, default_branch: 'main', extra: 1 })),
      };
    }
    const [name, repo] = repoOf(r.path);
    if (!repo) return undefined;
    const rest = r.path.slice(`/repos/${name}`.length);
    if (r.method === 'GET' && rest === '') {
      return { json: { full_name: name, private: repo.private, permissions: { push: repo.push }, default_branch: 'main', html_url: `https://github.com/${name}` } };
    }
    if (r.method === 'GET' && rest === '/git/ref/heads/main') {
      if (repo.empty) return { status: 409, json: { message: 'Git Repository is empty.' } };
      return { json: { ref: 'refs/heads/main', object: { sha: repo.head, type: 'commit' } } };
    }
    if (r.method === 'PUT' && rest === '/contents/README.md') {
      repo.empty = false;
      repo.head = `c-readme-${++state.seq}`;
      return { status: 201, json: { commit: { sha: repo.head } } };
    }
    let m;
    if (r.method === 'GET' && (m = rest.match(/^\/git\/commits\/(.+)$/))) {
      return { json: { sha: m[1], tree: { sha: `tree-of-${m[1]}` } } };
    }
    if (r.method === 'POST' && rest === '/git/trees') return { status: 201, json: { sha: `tree-${++state.seq}` } };
    if (r.method === 'POST' && rest === '/git/commits') return { status: 201, json: { sha: `commit-${++state.seq}` } };
    if (r.method === 'POST' && rest === '/git/refs') {
      if (state.refs.includes(r.body.ref)) return { status: 422, json: { message: 'Reference already exists' } };
      state.refs.push(r.body.ref);
      return { status: 201, json: { ref: r.body.ref, object: { sha: r.body.sha } } };
    }
    if (r.method === 'GET' && rest.startsWith('/actions/workflows/')) {
      return { json: { total_count: state.runs.length, workflow_runs: state.runs } };
    }
  });
  return Object.assign(srv, { state });
}
