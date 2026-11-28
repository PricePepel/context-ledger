// Card P2b (ADR-7b): artifacts a version 3 graph can cite beside messages. Each is a
// commit, a pull request or a file in a repository, registered per project by a person
// (CLI or HTTP), never found automatically. The ID is SHA-256 of the project, kind,
// repository and ref, so registering the same artifact again returns the same row.
// Errors are fixed sentences that never echo a value.
import { createHash, randomBytes } from 'node:crypto';
import { InputError } from './errors.mjs';

export const artifactKinds = ['commit', 'pr', 'file'];
const projectPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// A repository path such as orbit-labs/adapter, or a GitLab group path. No . or .. part.
const repoPattern = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
const refPatterns = {
  commit: /^[0-9a-f]{7,64}$/u,
  pr: /^[1-9][0-9]{0,9}$/u,
};
// A file path relative to the repository root: parts of visible characters (no control,
// format or separator characters and no backslash), none of them . or ..
const filePart = /^[^\p{C}\p{Zl}\p{Zp}\\]+$/u;

export const repoRule = 'repo must be a repository path such as owner/name: letters, digits, . _ and -, at most 200 characters.';
export const refRules = {
  commit: 'ref must be a commit hash of 7 to 64 lowercase hex characters.',
  pr: 'ref must be a pull request number.',
  file: 'ref must be a file path relative to the repository root, at most 512 characters, with no . or .. part.',
};

const dotted = part => part === '.' || part === '..';

/** The checked { project, kind, repo, ref } of a registration, or an InputError. */
export function checkArtifact(input, defaultProject) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new InputError('An artifact must be a JSON object.');
  for (const key of Object.keys(input)) {
    if (!['project', 'kind', 'repo', 'ref'].includes(key)) throw new InputError('An artifact has only project, kind, repo and ref.');
  }
  const project = input.project ?? defaultProject;
  if (typeof project !== 'string' || project.length > 64 || !projectPattern.test(project)) {
    throw new InputError('project must be a slug of at most 64 lowercase letters, digits and single hyphens.');
  }
  const { kind, repo, ref } = input;
  if (!artifactKinds.includes(kind)) throw new InputError('kind must be commit, pr or file.');
  if (typeof repo !== 'string' || repo.length > 200 || !repoPattern.test(repo) || repo.split('/').some(dotted)) throw new InputError(repoRule);
  if (typeof ref !== 'string') throw new InputError(refRules[kind]);
  if (kind === 'file') {
    const parts = ref.split('/');
    if (ref.length > 512 || parts.some(part => !filePart.test(part) || dotted(part))) throw new InputError(refRules.file);
  } else if (!refPatterns[kind].test(ref)) {
    throw new InputError(refRules[kind]);
  }
  return { project, kind, repo, ref };
}

export const artifactId = ({ project, kind, repo, ref }) =>
  createHash('sha256').update(['artifact', project, kind, repo, ref].join('\0')).digest('hex');

/** The artifacts table (schema version 4) as store functions. Statements are prepared on first use. */
export function mountArtifacts(database, defaultProject) {
  const prepared = new Map();
  const statement = sql => {
    if (!prepared.has(sql)) prepared.set(sql, database.prepare(sql));
    return prepared.get(sql);
  };
  const columns = `a.id, p.slug AS project, a.kind, a.repo, a.ref, a.created_at AS createdAt`;
  const byId = id => statement(`SELECT ${columns} FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE a.id = ?`).get(id);
  const plain = row => (row ? { ...row } : undefined);
  // The project and the artifact, inside the caller's transaction.
  const insertChecked = checked => {
    statement(`INSERT INTO projects (id, slug, name, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (slug) DO NOTHING`).run(randomBytes(16).toString('hex'), checked.project, checked.project);
    statement(`INSERT INTO artifacts (id, project_id, kind, repo, ref, created_at)
      VALUES (?, (SELECT id FROM projects WHERE slug = ?), ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (id) DO NOTHING`).run(artifactId(checked), checked.project, checked.kind, checked.repo, checked.ref);
  };

  return {
    /** Card R1: registers a parcel's artifact inside the transaction that receives the parcel. */
    insertArtifact(input) {
      insertChecked(checkArtifact(input, defaultProject));
    },

    /** Registers an artifact (and its project, on first use); the stored row either way. */
    registerArtifact(input) {
      const checked = checkArtifact(input, defaultProject);
      const id = artifactId(checked);
      database.exec('BEGIN IMMEDIATE');
      try {
        insertChecked(checked);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return plain(byId(id));
    },

    /** One artifact, or undefined. */
    getArtifact: id => plain(byId(id)),

    /** True when this artifact is registered in this project (slug). */
    artifactInProject: (id, project) => project !== null && byId(id)?.project === project,

    /** Artifacts newest first, optionally of one project; next is the last ID shown when more match. */
    listArtifacts({ project = null, limit, after }) {
      let before = null;
      if (after !== undefined && after !== null) {
        const row = statement('SELECT rowid FROM artifacts WHERE id = ?').get(after);
        if (!row) throw new InputError('Unknown cursor.');
        before = row.rowid;
      }
      const rows = statement(`SELECT ${columns} FROM artifacts a JOIN projects p ON p.id = a.project_id
        WHERE ($project IS NULL OR p.slug = $project) AND ($before IS NULL OR a.rowid < $before)
        ORDER BY a.rowid DESC LIMIT $n`).all({ $project: project, $before: before, $n: limit + 1 }).map(plain);
      return { artifacts: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
    },
  };
}
