import fs from 'node:fs';
import path from 'node:path';

export function sanitizeBranchName(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.length > 80) return '';
  if (!/^[A-Za-z0-9/_\-.]+$/.test(trimmed)) return '';
  return trimmed;
}

function readHeadFile(gitDir: string): string {
  try {
    const headPath = path.join(gitDir, 'HEAD');
    const raw = fs.readFileSync(headPath, 'utf8').trim();
    if (!raw) return '';
    if (raw.startsWith('ref:')) {
      const ref = raw.slice(4).trim();
      const prefix = 'refs/heads/';
      const branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      return sanitizeBranchName(branch);
    }
    if (/^[0-9a-f]{7,40}$/i.test(raw)) {
      return raw.slice(0, 7);
    }
    return '';
  } catch {
    return '';
  }
}

export function resolveGitBranch(startDir: string): string {
  const clean = String(startDir || '').trim();
  if (!clean) return '';
  let current = path.resolve(clean);

  for (let depth = 0; depth < 16; depth++) {
    const dotGit = path.join(current, '.git');
    try {
      const st = fs.statSync(dotGit, { throwIfNoEntry: false });
      if (st) {
        if (st.isDirectory()) {
          return readHeadFile(dotGit);
        }
        if (st.isFile()) {
          const content = fs.readFileSync(dotGit, 'utf8').trim();
          const m = content.match(/^gitdir:\s*(.+)$/im);
          if (m && m[1]) {
            const gitDir = path.isAbsolute(m[1].trim())
              ? m[1].trim()
              : path.resolve(current, m[1].trim());
            return readHeadFile(gitDir);
          }
        }
      }
    } catch {
      // ignore permission / IO errors while walking up
    }
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
}
